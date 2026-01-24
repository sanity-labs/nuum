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
import type { CoreMessage, CoreTool } from "ai"
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
import { buildSystemPrompt, buildConversationHistory } from "../agent"
import { runAgentLoop, stopOnTool } from "../agent/loop"

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
 * Result of a consolidation tool execution.
 */
interface ConsolidationToolResult {
  output: string
  done: boolean
  entryCreated?: boolean
  entryUpdated?: boolean
  entryArchived?: boolean
  summary?: string
}

/**
 * Build tools for the consolidation agent with execute callbacks.
 * Uses shared tool definitions from src/tool/ltm.ts.
 */
function buildConsolidationTools(
  storage: Storage,
): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => ConsolidationToolResult | undefined
} {
  // Track results by toolCallId for the agent loop to access
  const results = new Map<string, ConsolidationToolResult>()

  // Create LTM context for tool execution
  const createLTMContext = (toolCallId: string): Tool.Context & { extra: LTMToolContext } => {
    const ctx = Tool.createContext({
      sessionID: "consolidation",
      messageID: "consolidation",
      callID: toolCallId,
    })
    ;(ctx as Tool.Context & { extra: LTMToolContext }).extra = {
      ltm: storage.ltm,
      agentType: AGENT_TYPE,
    }
    return ctx as Tool.Context & { extra: LTMToolContext }
  }

  const tools: Record<string, CoreTool> = {}

  // LTM read-only tools (shared definitions)
  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMReadTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMGlobTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMSearchTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // LTM write tools (shared definitions)
  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMCreateTool.definition.execute(args, createLTMContext(toolCallId))
      const entryCreated = toolResult.output.startsWith("Created entry:")
      if (entryCreated) {
        log.info("created LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryCreated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_update = tool({
    description: LTMUpdateTool.definition.description,
    parameters: LTMUpdateTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMUpdateTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Updated entry:")
      if (entryUpdated) {
        log.info("updated LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_edit = tool({
    description: LTMEditTool.definition.description,
    parameters: LTMEditTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMEditTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Edited entry:")
      if (entryUpdated) {
        log.info("edited LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_reparent = tool({
    description: LTMReparentTool.definition.description,
    parameters: LTMReparentTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMReparentTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Moved entry:")
      if (entryUpdated) {
        log.info("reparented LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_rename = tool({
    description: LTMRenameTool.definition.description,
    parameters: LTMRenameTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMRenameTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Renamed entry:")
      if (entryUpdated) {
        log.info("renamed LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_archive = tool({
    description: LTMArchiveTool.definition.description,
    parameters: LTMArchiveTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMArchiveTool.definition.execute(args, createLTMContext(toolCallId))
      const entryArchived = toolResult.output.startsWith("Archived entry:")
      if (entryArchived) {
        log.info("archived LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryArchived }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // finish_consolidation - Signal completion (consolidation-specific)
  tools.finish_consolidation = tool({
    description: "Call this when you have finished reviewing the conversation and updating LTM. Always call this to complete consolidation.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what was extracted/updated (or 'No updates needed' if nothing changed)"),
    }),
    execute: async ({ summary }, { toolCallId }) => {
      const result: ConsolidationToolResult = { output: "Consolidation complete", done: true, summary }
      results.set(toolCallId, result)
      return result.output
    },
  })

  return {
    tools,
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}

/**
 * Build the LTM review turn content.
 * This is added as a system message to continue the main agent's conversation.
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

  // Get conversation history as proper turns (same as main agent sees)
  const historyTurns = await buildConversationHistory(storage)

  // Find recently updated entries (updated in the last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const allEntries = await storage.ltm.glob("/**")
  const recentlyUpdated = allEntries.filter(
    (e) => e.updatedAt > oneHourAgo && e.slug !== "identity" && e.slug !== "behavior",
  )

  // Build the LTM review turn content (added as system message)
  const reviewTurnContent = await buildLTMReviewTurn(storage, recentlyUpdated)

  // Get model (use workhorse tier for consolidation - Haiku is unreliable with tool schemas)
  const model = Provider.getModelForTier("workhorse")

  // Build tools with execute callbacks
  const { tools, getLastResult } = buildConsolidationTools(storage)

  // Initial messages: conversation history + LTM review task as user message
  // (only the top-level system prompt can use system role)
  const initialMessages: CoreMessage[] = [
    ...historyTurns,
    { role: "user", content: `[SYSTEM TASK]\n\n${reviewTurnContent}` },
  ]

  // Run the agent loop using the generic loop abstraction
  const loopResult = await runAgentLoop({
    model,
    systemPrompt,
    initialMessages,
    tools,
    maxTokens: 2048,
    temperature: 0,
    maxTurns: MAX_CONSOLIDATION_TURNS,
    isDone: stopOnTool("finish_consolidation"),
    onToolResult: (toolCallId) => {
      // Track results using our result tracking map
      const toolResult = getLastResult(toolCallId)
      if (toolResult?.entryCreated) {
        result.entriesCreated++
      }
      if (toolResult?.entryUpdated) {
        result.entriesUpdated++
      }
      if (toolResult?.entryArchived) {
        result.entriesArchived++
      }
      if (toolResult?.summary) {
        result.summary = toolResult.summary
      }
    },
  })

  result.usage.inputTokens += loopResult.usage.inputTokens
  result.usage.outputTokens += loopResult.usage.outputTokens

  // If no summary was set, the agent ended without calling finish_consolidation
  if (!result.summary) {
    result.summary = "Consolidation ended without explicit finish"
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
