/**
 * Core agent implementation for miriad-code
 *
 * Main agent loop that:
 * 1. Builds the prompt from memory (temporal, present, LTM)
 * 2. Calls the AI model with tools
 * 3. Executes tool calls
 * 4. Logs everything to temporal memory
 * 5. Updates present state
 */

import { tool } from "ai"
import type {
  CoreMessage,
  CoreTool,
  CoreAssistantMessage,
  CoreToolMessage,
  ToolCallPart,
  ToolResultPart,
  TextPart,
} from "ai"
import { z } from "zod"
import { Provider } from "../provider"
import { Config } from "../config"
import type { Storage, Task } from "../storage"
import { Identifier } from "../id"
import { Tool, BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from "../tool"
import {
  buildTemporalView,
  renderTemporalView,
  shouldTriggerCompaction,
  runCompactionWorker,
  createSummarizationLLM,
  getMessagesToCompact,
  type CompactionResult,
} from "../temporal"
import { runConsolidationWorker, type ConsolidationResult } from "../ltm"
import { Log } from "../util/log"

const log = Log.create({ service: "agent" })

const MAX_TURNS = 50

export interface AgentOptions {
  storage: Storage
  verbose?: boolean
  onEvent?: (event: AgentEvent) => void
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal
}

export interface AgentEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error" | "done" | "consolidation" | "compaction"
  content: string
  toolName?: string
  toolCallId?: string
  consolidationResult?: ConsolidationResult
  compactionResult?: CompactionResult
}

export interface AgentResult {
  response: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build the system prompt including memory state.
 * Uses temporal view with summaries for efficient context usage.
 */
async function buildSystemPrompt(storage: Storage): Promise<{ prompt: string; tokens: number }> {
  // Get identity and behavior from LTM
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")

  // Get present state
  const present = await storage.present.get()

  // Get temporal history using the temporal view (with summaries)
  const config = Config.get()
  const temporalBudget = config.tokenBudgets.temporalBudget

  // Fetch messages and summaries for temporal view
  const allMessages = await storage.temporal.getMessages()
  const allSummaries = await storage.temporal.getSummaries()

  // Build temporal view that fits within budget
  const temporalView = buildTemporalView({
    budget: temporalBudget,
    messages: allMessages,
    summaries: allSummaries,
  })

  // Build system prompt
  let prompt = `You are a coding assistant with persistent memory.

Your memory spans across conversations, allowing you to remember past decisions, track ongoing projects, and learn user preferences.

`

  // Add identity
  if (identity) {
    prompt += `<identity>
${identity.body}
</identity>

`
  }

  // Add behavior
  if (behavior) {
    prompt += `<behavior>
${behavior.body}
</behavior>

`
  }

  // Add temporal history using rendered view (includes summaries + recent messages)
  if (temporalView.summaries.length > 0 || temporalView.messages.length > 0) {
    prompt += `<conversation_history>
The following is your memory of previous interactions with this user:

${renderTemporalView(temporalView)}
</conversation_history>

`
  }

  // Add present state
  prompt += `<present_state>
<mission>${present.mission ?? "(none)"}</mission>
<status>${present.status ?? "(none)"}</status>
<tasks>
`
  for (const task of present.tasks) {
    prompt += `  <task status="${task.status}">${task.content}</task>\n`
  }
  prompt += `</tasks>
</present_state>

`

  // Add available tools description
  prompt += `You have access to tools for file operations (read, write, edit, bash, glob, grep).
Use tools to accomplish tasks. Always explain what you're doing.

When you're done with a task, update the present state if appropriate.

## Long-Term Memory

You have a knowledge base managed by a background process. It extracts important information from conversations and maintains organized knowledge.

To recall information:
- ltm_glob(pattern) - browse the knowledge tree structure
- ltm_search(query) - find relevant entries
- ltm_read(slug) - read a specific entry

Knowledge entries may contain [[slug]] cross-references to related entries. Follow these links to explore connected knowledge.

You do NOT manage this memory directly. Focus on your work - memory happens automatically.
Your /identity and /behavior entries are always visible to guide you.
`

  return { prompt, tokens: estimateTokens(prompt) }
}

/**
 * Convert our Tool definitions to AI SDK CoreTool format.
 */
function buildTools(): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {}

  // Bash tool
  tools.bash = tool({
    description: BashTool.definition.description,
    parameters: BashTool.definition.parameters,
  })

  // Read tool
  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
  })

  // Write tool
  tools.write = tool({
    description: WriteTool.definition.description,
    parameters: WriteTool.definition.parameters,
  })

  // Edit tool
  tools.edit = tool({
    description: EditTool.definition.description,
    parameters: EditTool.definition.parameters,
  })

  // Glob tool
  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
  })

  // Grep tool
  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
  })

  // Present state tools
  tools.present_set_mission = tool({
    description: "Set the current mission (high-level objective)",
    parameters: z.object({
      mission: z.string().nullable().describe("The mission to set, or null to clear"),
    }),
  })

  tools.present_set_status = tool({
    description: "Set the current status (what you're working on now)",
    parameters: z.object({
      status: z.string().nullable().describe("The status to set, or null to clear"),
    }),
  })

  tools.present_update_tasks = tool({
    description: "Update the task list",
    parameters: z.object({
      tasks: z.array(
        z.object({
          id: z.string().describe("Unique task ID"),
          content: z.string().describe("Task description (imperative form)"),
          status: z.enum(["pending", "in_progress", "completed", "blocked"]),
          blockedReason: z.string().optional().describe("Why the task is blocked"),
        }),
      ),
    }),
  })

  // LTM retrieval tools (read-only access to knowledge base)
  tools.ltm_glob = tool({
    description: `Browse the knowledge base tree structure. Use to:
- See what knowledge is available
- Understand the organization
- Find related topics to explore

Pattern examples:
- "/**" - all entries
- "/knowledge/**" - everything under knowledge
- "/*" - root level only (with maxDepth: 1)

Returns: Array of {slug, title, path, hasChildren}`,
    parameters: z.object({
      pattern: z.string().describe("Glob pattern (e.g., '/**', '/knowledge/*')"),
      maxDepth: z.number().optional().describe("Maximum tree depth to return"),
    }),
  })

  tools.ltm_search = tool({
    description: `Search your knowledge base. Use when you need to recall:
- Information from past work
- User preferences or project details
- Technical knowledge you've stored

You don't manage this knowledge - a background process curates it.
Knowledge entries may contain [[slug]] cross-references.

Returns: Array of {slug, title, path, snippet} ranked by relevance`,
    parameters: z.object({
      query: z.string().describe("Search keywords"),
      path: z.string().optional().describe("Limit search to subtree (e.g., '/knowledge')"),
      limit: z.number().optional().describe("Max results (default: 10)"),
    }),
  })

  tools.ltm_read = tool({
    description: `Read a specific knowledge entry by slug. Use after ltm_search finds relevant results, or when you know the exact slug.

Knowledge entries may contain [[slug]] cross-references to related entries - follow these links to explore connected knowledge.

Returns: {slug, title, body, path} or 'Entry not found'`,
    parameters: z.object({
      slug: z.string().describe("The entry slug to read (e.g., 'identity', 'react-hooks')"),
    }),
  })

  return tools
}

/**
 * Execute a tool call and return the result.
 */
async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  sessionId: string,
  messageId: string,
  callId: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const ctx = Tool.createContext({
    sessionID: sessionId,
    messageID: messageId,
    callID: callId,
    abort: abortSignal,
  })

  switch (toolName) {
    case "bash": {
      const result = await BashTool.definition.execute(args as z.infer<typeof BashTool.definition.parameters>, ctx)
      return result.output
    }
    case "read": {
      const result = await ReadTool.definition.execute(args as z.infer<typeof ReadTool.definition.parameters>, ctx)
      return result.output
    }
    case "write": {
      const result = await WriteTool.definition.execute(args as z.infer<typeof WriteTool.definition.parameters>, ctx)
      return result.output
    }
    case "edit": {
      const result = await EditTool.definition.execute(args as z.infer<typeof EditTool.definition.parameters>, ctx)
      return result.output
    }
    case "glob": {
      const result = await GlobTool.definition.execute(args as z.infer<typeof GlobTool.definition.parameters>, ctx)
      return result.output
    }
    case "grep": {
      const result = await GrepTool.definition.execute(args as z.infer<typeof GrepTool.definition.parameters>, ctx)
      return result.output
    }
    case "present_set_mission": {
      const { mission } = args as { mission: string | null }
      await storage.present.setMission(mission)
      return `Mission ${mission ? "set to: " + mission : "cleared"}`
    }
    case "present_set_status": {
      const { status } = args as { status: string | null }
      await storage.present.setStatus(status)
      return `Status ${status ? "set to: " + status : "cleared"}`
    }
    case "present_update_tasks": {
      const { tasks } = args as { tasks: Task[] }
      await storage.present.setTasks(tasks)
      return `Tasks updated (${tasks.length} tasks)`
    }
    // LTM retrieval tools
    case "ltm_glob": {
      const { pattern, maxDepth } = args as { pattern: string; maxDepth?: number }
      const entries = await storage.ltm.glob(pattern, maxDepth)
      const formatted = await Promise.all(entries.map(async e => {
        const children = await storage.ltm.getChildren(e.slug)
        return {
          slug: e.slug,
          title: e.title,
          path: e.path,
          hasChildren: children.length > 0,
        }
      }))
      return JSON.stringify(formatted, null, 2)
    }
    case "ltm_search": {
      const { query, path, limit } = args as { query: string; path?: string; limit?: number }
      const results = await storage.ltm.search(query, path)
      const limited = results.slice(0, limit ?? 10)
      const formatted = limited.map(r => ({
        slug: r.entry.slug,
        title: r.entry.title,
        path: r.entry.path,
        snippet: r.entry.body.slice(0, 150) + (r.entry.body.length > 150 ? "..." : ""),
      }))
      if (formatted.length === 0) {
        return `No entries found matching "${query}"`
      }
      return JSON.stringify(formatted, null, 2)
    }
    case "ltm_read": {
      const { slug } = args as { slug: string }
      const entry = await storage.ltm.read(slug)
      if (!entry) {
        return `Entry not found: ${slug}`
      }
      return JSON.stringify({
        slug: entry.slug,
        title: entry.title,
        body: entry.body,
        path: entry.path,
      }, null, 2)
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

/**
 * Run the main agent loop.
 */
/**
 * Error thrown when the agent is cancelled via AbortSignal.
 */
export class AgentCancelledError extends Error {
  constructor() {
    super("Agent execution cancelled")
    this.name = "AgentCancelledError"
  }
}

/**
 * Run the main agent loop.
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { storage, onEvent, abortSignal } = options
  const sessionId = Identifier.ascending("session")

  // Check if already cancelled
  if (abortSignal?.aborted) {
    throw new AgentCancelledError()
  }

  // Get the model
  const model = Provider.getModelForTier("reasoning")

  // Build system prompt
  const { prompt: systemPrompt } = await buildSystemPrompt(storage)

  // Build tools
  const tools = buildTools()

  // Initialize messages with user prompt
  const messages: CoreMessage[] = [
    { role: "user", content: prompt },
  ]

  // Log user message to temporal
  const userMessageId = Identifier.ascending("message")
  await storage.temporal.appendMessage({
    id: userMessageId,
    type: "user",
    content: prompt,
    tokenEstimate: estimateTokens(prompt),
    createdAt: new Date().toISOString(),
  })

  onEvent?.({ type: "user", content: prompt })

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let finalResponse = ""

  // Agent loop
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Check for cancellation
    if (abortSignal?.aborted) {
      throw new AgentCancelledError()
    }

    const result = await Provider.generate({
      model,
      system: systemPrompt,
      messages,
      tools,
      maxTokens: 8192,
    })

    totalInputTokens += result.usage.promptTokens
    totalOutputTokens += result.usage.completionTokens

    // Handle text response
    if (result.text) {
      finalResponse = result.text

      // Log to temporal
      const assistantMessageId = Identifier.ascending("message")
      await storage.temporal.appendMessage({
        id: assistantMessageId,
        type: "assistant",
        content: result.text,
        tokenEstimate: estimateTokens(result.text),
        createdAt: new Date().toISOString(),
      })

      onEvent?.({ type: "assistant", content: result.text })
    }

    // Handle tool calls
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Build assistant message with tool calls
      const assistantParts: (TextPart | ToolCallPart)[] = []

      if (result.text) {
        assistantParts.push({ type: "text", text: result.text })
      }

      const toolResultParts: ToolResultPart[] = []

      for (const toolCall of result.toolCalls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        })

        // Log tool call to temporal
        const toolCallMsgId = Identifier.ascending("message")
        await storage.temporal.appendMessage({
          id: toolCallMsgId,
          type: "tool_call",
          content: JSON.stringify({ name: toolCall.toolName, args: toolCall.args }),
          tokenEstimate: estimateTokens(JSON.stringify(toolCall.args)),
          createdAt: new Date().toISOString(),
        })

        onEvent?.({
          type: "tool_call",
          content: `${toolCall.toolName}(${JSON.stringify(toolCall.args).slice(0, 100)}...)`,
          toolName: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
        })

        // Execute tool
        let toolResult: string
        try {
          toolResult = await executeTool(
            toolCall.toolName,
            toolCall.args as Record<string, unknown>,
            storage,
            sessionId,
            userMessageId,
            toolCall.toolCallId,
            abortSignal,
          )
        } catch (error) {
          // Check if this was a cancellation
          if (abortSignal?.aborted) {
            throw new AgentCancelledError()
          }
          toolResult = `Error: ${error instanceof Error ? error.message : String(error)}`
          onEvent?.({ type: "error", content: toolResult })
        }

        // Log tool result to temporal
        const toolResultMsgId = Identifier.ascending("message")
        await storage.temporal.appendMessage({
          id: toolResultMsgId,
          type: "tool_result",
          content: toolResult,
          tokenEstimate: estimateTokens(toolResult),
          createdAt: new Date().toISOString(),
        })

        onEvent?.({
          type: "tool_result",
          content: toolResult.slice(0, 200) + (toolResult.length > 200 ? "..." : ""),
          toolCallId: toolCall.toolCallId,
        })

        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: toolResult,
        })
      }

      // Add assistant message with tool calls
      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: assistantParts,
      }
      messages.push(assistantMsg)

      // Add tool results
      const toolMsg: CoreToolMessage = {
        role: "tool",
        content: toolResultParts,
      }
      messages.push(toolMsg)

      // Continue the loop for more turns
      continue
    }

    // No tool calls - we're done
    if (result.text) {
      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: result.text,
      }
      messages.push(assistantMsg)
    }
    break
  }

  onEvent?.({ type: "done", content: finalResponse })

  // Check if compaction is needed after the agent turn
  await maybeRunCompaction(storage, onEvent)

  return {
    response: finalResponse,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  }
}

/**
 * Check if compaction should be triggered and run it if needed.
 * Runs LTM consolidation BEFORE compaction to extract durable knowledge
 * while raw messages are still available.
 */
async function maybeRunCompaction(
  storage: Storage,
  onEvent?: (event: AgentEvent) => void,
): Promise<CompactionResult | null> {
  const config = Config.get()

  const shouldCompact = await shouldTriggerCompaction(
    storage.temporal,
    storage.workers,
    {
      compactionThreshold: config.tokenBudgets.compactionThreshold,
      compactionTarget: config.tokenBudgets.compactionTarget,
    },
  )

  if (!shouldCompact) {
    return null
  }

  log.info("compaction triggered", {
    threshold: config.tokenBudgets.compactionThreshold,
    target: config.tokenBudgets.compactionTarget,
  })

  // Phase 1: Run LTM consolidation BEFORE compaction
  // Extract durable knowledge from raw messages while they're still available
  try {
    const { messages } = await getMessagesToCompact(storage.temporal)
    if (messages.length > 0) {
      log.info("running LTM consolidation before compaction", { messageCount: messages.length })

      const consolidationResult = await runConsolidationWorker(storage, messages)

      if (consolidationResult.ran) {
        log.info("consolidation complete", {
          entriesCreated: consolidationResult.entriesCreated,
          entriesUpdated: consolidationResult.entriesUpdated,
          entriesArchived: consolidationResult.entriesArchived,
        })

        onEvent?.({
          type: "consolidation",
          content: consolidationResult.summary || "LTM consolidation complete",
          consolidationResult,
        })
      } else {
        log.info("consolidation skipped", { reason: consolidationResult.summary })
      }
    }
  } catch (error) {
    // Consolidation failure is non-fatal - continue with compaction
    log.error("consolidation failed, continuing with compaction", { error })
    onEvent?.({
      type: "error",
      content: `Consolidation failed: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // Phase 2: Run compaction (lossy summarization)
  try {
    const llm = createSummarizationLLM()
    const result = await runCompactionWorker(
      storage,
      llm,
      {
        compactionThreshold: config.tokenBudgets.compactionThreshold,
        compactionTarget: config.tokenBudgets.compactionTarget,
      },
    )

    log.info("compaction complete", {
      order1Created: result.order1Created,
      higherOrderCreated: result.higherOrderCreated,
      tokensCompressed: result.tokensCompressed,
    })

    onEvent?.({
      type: "compaction",
      content: `Compacted ${result.tokensCompressed} tokens (${result.order1Created} order-1, ${result.higherOrderCreated} higher-order summaries)`,
      compactionResult: result,
    })

    return result
  } catch (error) {
    log.error("compaction failed", { error })
    onEvent?.({
      type: "error",
      content: `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
}
