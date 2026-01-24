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
} from "ai"
import { z } from "zod"
import { Provider } from "../provider"
import { Config } from "../config"
import type { Storage, Task } from "../storage"
import { Identifier } from "../id"
import {
  Tool,
  BashTool,
  ReadTool,
  EditTool,
  WriteTool,
  GlobTool,
  GrepTool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  type LTMToolContext,
} from "../tool"
import {
  buildTemporalView,
  reconstructHistoryAsTurns,
  shouldTriggerCompaction,
  runCompactionWorker,
  getMessagesToCompact,
  type CompactionResult,
} from "../temporal"
import { runConsolidationWorker, type ConsolidationResult } from "../ltm"
import { runAgentLoop, AgentLoopCancelledError } from "./loop"
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
 * Build the system prompt (identity, behavior, instructions only).
 * Temporal history is now reconstructed as proper conversation turns.
 * Exported so background agents (consolidation, etc.) can reuse it for prompt caching.
 */
export async function buildSystemPrompt(storage: Storage): Promise<{ prompt: string; tokens: number }> {
  // Get identity and behavior from LTM
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")

  // Get present state
  const present = await storage.present.get()

  // Build system prompt (no temporal history - that goes in conversation turns)
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
 * Build the conversation history as proper CoreMessage[] turns.
 * This replaces the old approach of stuffing history into the system prompt.
 */
export async function buildConversationHistory(storage: Storage): Promise<CoreMessage[]> {
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

  // Reconstruct as proper conversation turns
  return reconstructHistoryAsTurns(temporalView)
}

/**
 * Context factory for creating tool execution contexts.
 * Centralizes context creation and LTM injection.
 */
interface ToolContextFactory {
  createContext(callId: string): Tool.Context
  createLTMContext(callId: string): Tool.Context & { extra: LTMToolContext }
}

function createToolContextFactory(
  storage: Storage,
  sessionId: string,
  messageId: string,
  abortSignal?: AbortSignal,
): ToolContextFactory {
  const baseContext = {
    sessionID: sessionId,
    messageID: messageId,
    abort: abortSignal ?? new AbortController().signal,
  }

  return {
    createContext(callId: string): Tool.Context {
      return Tool.createContext({
        ...baseContext,
        callID: callId,
      })
    },
    createLTMContext(callId: string): Tool.Context & { extra: LTMToolContext } {
      const ctx = Tool.createContext({
        ...baseContext,
        callID: callId,
      }) as Tool.Context & { extra: LTMToolContext }
      ctx.extra = {
        ltm: storage.ltm,
        agentType: "main",
      }
      return ctx
    },
  }
}

/**
 * Convert our Tool definitions to AI SDK CoreTool format with execute callbacks.
 * This eliminates the need for a separate executeTool() switch statement.
 */
function buildTools(
  storage: Storage,
  sessionId: string,
  messageId: string,
  abortSignal?: AbortSignal,
): Record<string, CoreTool> {
  const factory = createToolContextFactory(storage, sessionId, messageId, abortSignal)
  const tools: Record<string, CoreTool> = {}

  // File operation tools - wire execute directly
  tools.bash = tool({
    description: BashTool.definition.description,
    parameters: BashTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await BashTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await ReadTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  tools.write = tool({
    description: WriteTool.definition.description,
    parameters: WriteTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await WriteTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  tools.edit = tool({
    description: EditTool.definition.description,
    parameters: EditTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await EditTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await GlobTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await GrepTool.definition.execute(args, factory.createContext(toolCallId))
      return result.output
    },
  })

  // Present state tools - inline execution
  tools.present_set_mission = tool({
    description: "Set the current mission (high-level objective)",
    parameters: z.object({
      mission: z.string().nullable().describe("The mission to set, or null to clear"),
    }),
    execute: async ({ mission }) => {
      await storage.present.setMission(mission)
      return `Mission ${mission ? "set to: " + mission : "cleared"}`
    },
  })

  tools.present_set_status = tool({
    description: "Set the current status (what you're working on now)",
    parameters: z.object({
      status: z.string().nullable().describe("The status to set, or null to clear"),
    }),
    execute: async ({ status }) => {
      await storage.present.setStatus(status)
      return `Status ${status ? "set to: " + status : "cleared"}`
    },
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
    execute: async ({ tasks }) => {
      await storage.present.setTasks(tasks)
      return `Tasks updated (${tasks.length} tasks)`
    },
  })

  // LTM retrieval tools - use shared definitions with LTM context
  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await LTMGlobTool.definition.execute(args, factory.createLTMContext(toolCallId))
      return result.output
    },
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await LTMSearchTool.definition.execute(args, factory.createLTMContext(toolCallId))
      return result.output
    },
  })

  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const result = await LTMReadTool.definition.execute(args, factory.createLTMContext(toolCallId))
      return result.output
    },
  })

  return tools
}



/**
 * Re-export the cancellation error from the generic loop.
 */
export { AgentLoopCancelledError as AgentCancelledError } from "./loop"

/**
 * Run the main agent loop.
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { storage, onEvent, abortSignal } = options
  const sessionId = Identifier.ascending("session")

  // Get the model
  const model = Provider.getModelForTier("reasoning")

  // Build system prompt (identity, behavior, instructions - cacheable)
  const { prompt: systemPrompt } = await buildSystemPrompt(storage)

  // Build conversation history as proper turns
  const historyTurns = await buildConversationHistory(storage)

  // Log user message to temporal
  const userMessageId = Identifier.ascending("message")
  await storage.temporal.appendMessage({
    id: userMessageId,
    type: "user",
    content: prompt,
    tokenEstimate: estimateTokens(prompt),
    createdAt: new Date().toISOString(),
  })

  // Build tools with execute callbacks wired up
  const tools = buildTools(storage, sessionId, userMessageId, abortSignal)

  // Initialize messages with history + current user prompt
  const initialMessages: CoreMessage[] = [
    ...historyTurns,
    { role: "user", content: prompt },
  ]

  onEvent?.({ type: "user", content: prompt })

  // Track whether we've logged the assistant text (to avoid double-logging)
  let lastLoggedText = ""

  // Run the generic agent loop with callbacks for temporal logging and events
  const result = await runAgentLoop({
    model,
    systemPrompt,
    initialMessages,
    tools,
    maxTokens: 8192,
    maxTurns: MAX_TURNS,
    abortSignal,

    // Log assistant text to temporal and emit event
    onText: async (text) => {
      // Only log if this is new text (avoid double-logging on final turn)
      if (text !== lastLoggedText) {
        lastLoggedText = text
        const assistantMessageId = Identifier.ascending("message")
        await storage.temporal.appendMessage({
          id: assistantMessageId,
          type: "assistant",
          content: text,
          tokenEstimate: estimateTokens(text),
          createdAt: new Date().toISOString(),
        })
        onEvent?.({ type: "assistant", content: text })
      }
    },

    // Log tool calls to temporal and emit event
    onToolCall: async (toolCallId, toolName, args) => {
      const toolCallMsgId = Identifier.ascending("message")
      await storage.temporal.appendMessage({
        id: toolCallMsgId,
        type: "tool_call",
        content: JSON.stringify({ name: toolName, args }),
        tokenEstimate: estimateTokens(JSON.stringify(args)),
        createdAt: new Date().toISOString(),
      })
      onEvent?.({
        type: "tool_call",
        content: `${toolName}(${JSON.stringify(args).slice(0, 100)}...)`,
        toolName,
        toolCallId,
      })
    },

    // Log tool results to temporal and emit event
    onToolResult: async (toolCallId, toolName, toolResult) => {
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
        toolCallId,
      })
    },
  })

  onEvent?.({ type: "done", content: result.finalText })

  // Check if compaction is needed after the agent turn
  await maybeRunCompaction(storage, onEvent)

  return {
    response: result.finalText,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
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

  // Phase 2: Run compaction (agentic summarization)
  try {
    const result = await runCompactionWorker(
      storage,
      {
        compactionThreshold: config.tokenBudgets.compactionThreshold,
        compactionTarget: config.tokenBudgets.compactionTarget,
      },
    )

    const tokensCompressed = result.tokensBefore - result.tokensAfter
    log.info("compaction complete", {
      summariesCreated: result.summariesCreated,
      tokensCompressed,
      turnsUsed: result.turnsUsed,
    })

    onEvent?.({
      type: "compaction",
      content: `Compacted ${tokensCompressed} tokens (${result.summariesCreated} summaries created in ${result.turnsUsed} turns)`,
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
