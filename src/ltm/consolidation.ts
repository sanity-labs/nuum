/**
 * LTM Consolidation Agent
 *
 * Extracts durable knowledge from raw conversation messages into long-term memory.
 * Runs BEFORE compaction, while full details are still available in temporal memory.
 *
 * This is a mini-agent (the "LTM Manager") with tools for knowledge curation:
 *
 * Navigation & Search:
 * - ltm_read: Read a specific entry
 * - ltm_glob: Browse tree structure
 * - ltm_search: Find related entries
 *
 * Creation & Modification:
 * - ltm_create: Create new knowledge entries
 * - ltm_update: Full rewrite of entry body (CAS)
 * - ltm_edit: Surgical find-replace (CAS)
 *
 * Organization:
 * - ltm_reparent: Move entry to new parent
 * - ltm_rename: Change entry slug
 * - ltm_archive: Soft-delete outdated entries
 *
 * Workflow:
 * - finish_consolidation: Signal completion
 */

import { tool } from "ai"
import type { CoreMessage, CoreTool, ToolCallPart, ToolResultPart, CoreAssistantMessage, CoreToolMessage } from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import type { TemporalMessage, LTMEntry } from "../storage/schema"
import type { AgentType } from "../storage/ltm"
import { Provider } from "../provider"
import { Identifier } from "../id"
import { Log } from "../util/log"
import {
  Tool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  LTMCreateTool,
  LTMUpdateTool,
  LTMEditTool,
  LTMReparentTool,
  LTMRenameTool,
  LTMArchiveTool,
  renderCompactTree,
  type LTMToolContext,
} from "../tool"
import { buildSystemPrompt } from "../agent"

const log = Log.create({ service: "consolidation-agent" })

const MAX_CONSOLIDATION_TURNS = 10
const AGENT_TYPE: AgentType = "ltm-consolidate"

/**
 * Result of a consolidation run.
 */
export interface ConsolidationResult {
  /** Whether consolidation ran (false if skipped as trivial) */
  ran: boolean
  /** Number of LTM entries created */
  entriesCreated: number
  /** Number of LTM entries updated */
  entriesUpdated: number
  /** Number of LTM entries archived */
  entriesArchived: number
  /** Summary from the agent */
  summary: string
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Check if a conversation is noteworthy enough to warrant LTM consolidation.
 *
 * Trivial conversations (greetings, simple questions) don't need LTM updates.
 */
export function isConversationNoteworthy(messages: TemporalMessage[]): boolean {
  // Too few messages - probably trivial
  if (messages.length < 5) {
    return false
  }

  // Check for indicators of noteworthy content
  let hasToolUsage = false
  let hasSubstantialContent = false

  for (const msg of messages) {
    // Tool calls indicate real work was done
    if (msg.type === "tool_call" || msg.type === "tool_result") {
      hasToolUsage = true
    }

    // Check content length - substantial conversations have longer messages
    if (msg.content.length > 200) {
      hasSubstantialContent = true
    }
  }

  // Noteworthy if tools were used or conversation was substantial
  return hasToolUsage || hasSubstantialContent
}

/**
 * Build tools for the consolidation agent.
 * Uses shared tool definitions from src/tool/ltm.ts.
 */
function buildConsolidationTools(): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {}

  // LTM read-only tools (shared definitions)
  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
  })

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
  })

  // LTM write tools (shared definitions)
  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
  })

  tools.ltm_update = tool({
    description: LTMUpdateTool.definition.description,
    parameters: LTMUpdateTool.definition.parameters,
  })

  tools.ltm_edit = tool({
    description: LTMEditTool.definition.description,
    parameters: LTMEditTool.definition.parameters,
  })

  tools.ltm_reparent = tool({
    description: LTMReparentTool.definition.description,
    parameters: LTMReparentTool.definition.parameters,
  })

  tools.ltm_rename = tool({
    description: LTMRenameTool.definition.description,
    parameters: LTMRenameTool.definition.parameters,
  })

  tools.ltm_archive = tool({
    description: LTMArchiveTool.definition.description,
    parameters: LTMArchiveTool.definition.parameters,
  })

  // finish_consolidation - Signal completion (consolidation-specific)
  tools.finish_consolidation = tool({
    description: "Call this when you have finished reviewing the conversation and updating LTM. Always call this to complete consolidation.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what was extracted/updated (or 'No updates needed' if nothing changed)"),
    }),
  })

  return tools
}

/**
 * Create an LTM tool context for consolidation.
 */
function createLTMContext(storage: Storage): Tool.Context & { extra: LTMToolContext } {
  const ctx = Tool.createContext({
    sessionID: "consolidation",
    messageID: "consolidation",
  })
  ;(ctx as Tool.Context & { extra: LTMToolContext }).extra = {
    ltm: storage.ltm,
    agentType: AGENT_TYPE,
  }
  return ctx as Tool.Context & { extra: LTMToolContext }
}

/**
 * Execute a consolidation tool call using shared tool implementations.
 */
async function executeConsolidationTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  result: ConsolidationResult,
): Promise<{ output: string; done: boolean }> {
  const ctx = createLTMContext(storage)

  switch (toolName) {
    // Read-only tools - delegate to shared implementations
    case "ltm_read": {
      const toolResult = await LTMReadTool.definition.execute(
        args as z.infer<typeof LTMReadTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    case "ltm_glob": {
      const toolResult = await LTMGlobTool.definition.execute(
        args as z.infer<typeof LTMGlobTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    case "ltm_search": {
      const toolResult = await LTMSearchTool.definition.execute(
        args as z.infer<typeof LTMSearchTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    // Write tools - delegate to shared implementations and track results
    case "ltm_create": {
      const toolResult = await LTMCreateTool.definition.execute(
        args as z.infer<typeof LTMCreateTool.definition.parameters>,
        ctx,
      )
      // Track success (shared tool returns "Created entry:" on success)
      if (toolResult.output.startsWith("Created entry:")) {
        result.entriesCreated++
        log.info("created LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_update": {
      const toolResult = await LTMUpdateTool.definition.execute(
        args as z.infer<typeof LTMUpdateTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Updated entry:")) {
        result.entriesUpdated++
        log.info("updated LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_edit": {
      const toolResult = await LTMEditTool.definition.execute(
        args as z.infer<typeof LTMEditTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Edited entry:")) {
        result.entriesUpdated++
        log.info("edited LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_reparent": {
      const toolResult = await LTMReparentTool.definition.execute(
        args as z.infer<typeof LTMReparentTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Moved entry:")) {
        result.entriesUpdated++
        log.info("reparented LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_rename": {
      const toolResult = await LTMRenameTool.definition.execute(
        args as z.infer<typeof LTMRenameTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Renamed entry:")) {
        result.entriesUpdated++
        log.info("renamed LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_archive": {
      const toolResult = await LTMArchiveTool.definition.execute(
        args as z.infer<typeof LTMArchiveTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Archived entry:")) {
        result.entriesArchived++
        log.info("archived LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    // Consolidation-specific tool
    case "finish_consolidation": {
      const { summary } = args as { summary: string }
      result.summary = summary
      return { output: "Consolidation complete", done: true }
    }

    default:
      return { output: `Unknown tool: ${toolName}`, done: false }
  }
}

/**
 * Build the LTM review turn content.
 * This is added as a user message to continue the main agent's conversation.
 */
async function buildLTMReviewTurn(
  storage: Storage,
  recentlyUpdatedEntries: LTMEntry[],
): Promise<string> {
  // Get the full LTM tree (3 levels deep)
  const allEntries = await storage.ltm.glob("/**")
  const treeView = renderCompactTree(allEntries, 3)

  let content = `## Long-Term Memory Review

It's time to review your long-term memory. Take a moment to consider whether there are insights, observations, or facts from the recent conversation that should be captured.

### Current Memory Inventory

${treeView || "(empty)"}
`

  // Add recently updated entries if any
  if (recentlyUpdatedEntries.length > 0) {
    content += `
### Recently Updated Memories

The following entries were recently modified:
`
    for (const entry of recentlyUpdatedEntries) {
      content += `- **${entry.slug}**: ${entry.title}\n`
    }
  }

  content += `
### Memory Guidelines

A good memory entry is:
- **Compact**: Optimized for recall, not explanation. You are the only audience.
- **Factual**: Captures specific facts, decisions, patterns, or preferences.
- **Actionable**: Information you need to perform tasks better over time.

Your long-term memory is YOUR resource - a knowledge base you build to learn and improve precision over time.

### What to Capture
- User preferences and working patterns
- Project-specific conventions and decisions
- Technical facts about the codebase
- Corrections to your existing knowledge

### What NOT to Capture
- Transient task details (these stay in conversation history)
- Obvious or trivial information
- Speculative or uncertain information

### Tools Available
- **ltm_glob(pattern)** - Browse the tree structure
- **ltm_search(query)** - Find related entries (always search before creating!)
- **ltm_read(slug)** - Read an entry's full content
- **ltm_create(...)** - Create a new entry
- **ltm_update(...)** - Replace an entry's content
- **ltm_edit(...)** - Surgical find-replace
- **ltm_reparent(...)** - Move entry to new parent
- **ltm_rename(...)** - Change entry slug
- **ltm_archive(...)** - Remove outdated entries

Use [[slug]] syntax in entry bodies to cross-link related knowledge.

When you're done reviewing (even if no changes needed), call **finish_consolidation** with a brief summary.
`

  return content
}

/**
 * Run the consolidation agent.
 *
 * Extracts durable knowledge from raw messages before compaction runs.
 */
export async function runConsolidation(
  storage: Storage,
  messages: TemporalMessage[],
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    ran: false,
    entriesCreated: 0,
    entriesUpdated: 0,
    entriesArchived: 0,
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  }

  // Check if conversation is noteworthy
  if (!isConversationNoteworthy(messages)) {
    log.info("skipping consolidation - conversation not noteworthy", {
      messageCount: messages.length,
    })
    result.summary = "Skipped - conversation not noteworthy"
    return result
  }

  result.ran = true
  log.info("starting consolidation", { messageCount: messages.length })

  // Use the main agent's system prompt for prompt caching benefits
  const { prompt: systemPrompt } = await buildSystemPrompt(storage)

  // Find recently updated entries (updated in the last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const allEntries = await storage.ltm.glob("/**")
  const recentlyUpdated = allEntries.filter(
    (e) => e.updatedAt > oneHourAgo && e.slug !== "identity" && e.slug !== "behavior",
  )

  // Build the LTM review turn content
  const reviewTurnContent = await buildLTMReviewTurn(storage, recentlyUpdated)

  // Get model (use workhorse tier for consolidation - Haiku is unreliable with tool schemas)
  const model = Provider.getModelForTier("workhorse")

  // Build tools
  const tools = buildConsolidationTools()

  // Agent loop - starts with the LTM review turn as if continuing the main conversation
  const agentMessages: CoreMessage[] = [
    { role: "user", content: reviewTurnContent },
  ]

  for (let turn = 0; turn < MAX_CONSOLIDATION_TURNS; turn++) {
    const response = await Provider.generate({
      model,
      system: systemPrompt,
      messages: agentMessages,
      tools,
      maxTokens: 2048,
      temperature: 0,
    })

    result.usage.inputTokens += response.usage.promptTokens
    result.usage.outputTokens += response.usage.completionTokens

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const assistantParts: (import("ai").TextPart | ToolCallPart)[] = []
      const toolResultParts: ToolResultPart[] = []

      if (response.text) {
        assistantParts.push({ type: "text", text: response.text })
      }

      let done = false

      for (const toolCall of response.toolCalls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        })

        const { output, done: toolDone } = await executeConsolidationTool(
          toolCall.toolName,
          toolCall.args as Record<string, unknown>,
          storage,
          result,
        )

        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: output,
        })

        if (toolDone) {
          done = true
        }
      }

      agentMessages.push({ role: "assistant", content: assistantParts })
      agentMessages.push({ role: "tool", content: toolResultParts })

      if (done) {
        break
      }
    } else {
      // No tool calls - agent might be done
      if (response.text) {
        agentMessages.push({ role: "assistant", content: response.text })
      }
      // Give the agent one more chance to call finish_consolidation
      if (turn === MAX_CONSOLIDATION_TURNS - 1) {
        result.summary = "Consolidation ended without explicit finish"
      }
      break
    }
  }

  log.info("consolidation complete", {
    entriesCreated: result.entriesCreated,
    entriesUpdated: result.entriesUpdated,
    entriesArchived: result.entriesArchived,
    summary: result.summary,
  })

  return result
}

/**
 * Run consolidation as a worker with tracking.
 */
export async function runConsolidationWorker(
  storage: Storage,
  messages: TemporalMessage[],
): Promise<ConsolidationResult> {
  // Create worker record
  const workerId = Identifier.ascending("worker")
  await storage.workers.create({
    id: workerId,
    type: "ltm-consolidate",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  })

  try {
    const result = await runConsolidation(storage, messages)
    await storage.workers.complete(workerId)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await storage.workers.fail(workerId, error)
    throw e
  }
}
