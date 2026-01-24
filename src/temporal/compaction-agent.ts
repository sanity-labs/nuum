/**
 * Agentic distillation for temporal memory optimization.
 *
 * This agent optimizes the working memory (conversation history) by distilling
 * older content into more focused, actionable form. The goal is NOT summarization
 * (narrative compression) but DISTILLATION (retaining what matters for effective action).
 *
 * Key principles:
 * - Working memory should be optimized for "what do I need to act effectively now?"
 * - Recent events: keep detail (we might need to backtrack or reference)
 * - Older events: distill to conclusions, decisions, and actionable facts
 * - Preserve: file paths, decisions + rationale, user preferences, current state
 * - Excise: back-and-forth debugging, missteps, verbose tool outputs, narrative filler
 *
 * The agent:
 * 1. Receives the same prompt as the main agent (for cache efficiency)
 * 2. Sees the temporal view with ULIDs exposed
 * 3. Calls create_distillation() to subsume ranges of messages/summaries
 * 4. Loops until the token budget target is met
 */

import { tool } from "ai"
import type {
  CoreMessage,
  CoreTool,
} from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import type { TemporalMessage, TemporalSummary, TemporalSummaryInsert } from "../storage/schema"
import { Provider } from "../provider"
import { Identifier } from "../id"
import { Log } from "../util/log"
import { Config } from "../config"
import { buildAgentContext, buildConversationHistory } from "../context"
import { runAgentLoop, stopOnTool } from "../agent/loop"
import { estimateSummaryTokens, type SummaryInput } from "./summary"

const log = Log.create({ service: "compaction-agent" })

const MAX_COMPACTION_TURNS = 10

/**
 * Result of a compaction run.
 */
export interface CompactionResult {
  /** Number of summaries created */
  summariesCreated: number
  /** Total tokens before compaction */
  tokensBefore: number
  /** Total tokens after compaction */
  tokensAfter: number
  /** Number of agent turns taken */
  turnsUsed: number
  /** Token usage for the agent */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Configuration for compaction.
 */
export interface CompactionConfig {
  /** Trigger compaction when uncompacted tokens exceed this threshold */
  compactionThreshold: number
  /** Target token count after compaction completes */
  compactionTarget: number
}

/**
 * Build the distillation task prompt.
 *
 * The conversation history already contains IDs in messages ([id:xxx]) and
 * distillations ([distilled from:xxx to:yyy]), so we just need to explain the task.
 */
function buildCompactionTaskPrompt(
  currentTokens: number,
  targetTokens: number,
  recencyBuffer: number,
): string {
  return `## Working Memory Optimization Task

Your working memory (conversation history) has grown large and needs to be optimized for effective action.

**Current size:** ~${currentTokens.toLocaleString()} tokens
**Target size:** ~${targetTokens.toLocaleString()} tokens  
**To distill:** ~${(currentTokens - targetTokens).toLocaleString()} tokens
**Recency buffer:** ${recencyBuffer} most recent messages are protected

The conversation above contains IDs you can reference:
- Messages have \`[id:xxx]\` prefixes
- Distillations show \`[distilled from:xxx to:yyy]\` ranges
- The most recent ${recencyBuffer} messages cannot be distilled (preserve immediate context)

## Your Task: Distill, Don't Summarize

The goal is NOT narrative summarization ("we discussed X and decided Y").
The goal IS operational distillation - retaining what you need to act effectively.

**RETAIN (actionable intelligence):**
- File paths and what they contain/do
- Decisions made and WHY (rationale matters for future decisions)
- User preferences and corrections discovered
- Current state of work and next steps
- Specific values: URLs, config paths, command examples
- Errors encountered and how they were resolved

**EXCISE (noise):**
- Back-and-forth debugging that led nowhere
- Missteps and corrections (keep only the final correct approach)
- Verbose tool outputs (keep only the relevant findings)
- Narrative filler ("I'll help you with that", "Let me check")
- Redundant information already captured elsewhere

**TIME AWARENESS:**
- Recent content: Keep more detail (might need to reference or backtrack)
- Older content: Distill more aggressively to conclusions
- Ancient content: Should be heavily compressed - just outcomes and key facts

## Instructions

For each distillation, call **create_distillation** with:

1. **startId** and **endId**: The range to distill (use visible IDs)

2. **operationalContext**: A focused paragraph capturing:
   - What was accomplished or decided
   - Key facts needed for future action
   - Write as working notes, not narrative prose

3. **retainedFacts**: Array of specific, actionable items:
   - "Protocol server is at src/jsonrpc/index.ts"
   - "User prefers simplicity over backwards compatibility"
   - "Session ID is generated once at startup, not per-message"
   - Keep these concrete and referenceable

Call **finish_distillation** when you've optimized enough or no more distillation is beneficial.

**Remember:** You're optimizing your own working memory. Keep what helps you act with precision.
`
}

/**
 * Result of a distillation tool execution.
 */
interface DistillationToolResult {
  output: string
  done: boolean
  distillationCreated: boolean
}

/**
 * Build the distillation tools with execute callbacks.
 * Returns both the tools and a results map to track execution outcomes.
 */
function buildCompactionTools(
  storage: Storage,
  validIds: Set<string>,
): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => DistillationToolResult | undefined
} {
  // Track results by toolCallId for the agent loop to access
  const results = new Map<string, DistillationToolResult>()

  const tools: Record<string, CoreTool> = {
    create_distillation: tool({
      description: "Distill a range of conversation into optimized working memory. Focuses on retaining actionable intelligence while excising noise.",
      parameters: z.object({
        startId: z.string().describe("ULID of the first item to include (inclusive). Must be a visible ID."),
        endId: z.string().describe("ULID of the last item to include (inclusive). Must be a visible ID."),
        operationalContext: z.string().describe("Focused paragraph of what was accomplished, decided, or learned. Write as working notes - concrete and actionable, not narrative prose. Include file paths, specific values, and rationale for decisions."),
        retainedFacts: z.array(z.string()).describe("Array of specific, referenceable facts. Each should be concrete and actionable, e.g., 'Protocol server is at src/jsonrpc/index.ts' or 'User prefers simplicity over backwards compatibility'."),
      }),
      execute: async ({ startId, endId, operationalContext, retainedFacts }, { toolCallId }) => {
        // Validate IDs
        if (!validIds.has(startId)) {
          const result: DistillationToolResult = {
            output: `Error: startId "${startId}" is not a visible ID. Use only IDs shown in the conversation history.`,
            done: false,
            distillationCreated: false,
          }
          results.set(toolCallId, result)
          return result.output
        }
        if (!validIds.has(endId)) {
          const result: DistillationToolResult = {
            output: `Error: endId "${endId}" is not a visible ID. Use only IDs shown in the conversation history.`,
            done: false,
            distillationCreated: false,
          }
          results.set(toolCallId, result)
          return result.output
        }
        if (startId > endId) {
          const result: DistillationToolResult = {
            output: `Error: startId must be <= endId (got ${startId} > ${endId})`,
            done: false,
            distillationCreated: false,
          }
          results.set(toolCallId, result)
          return result.output
        }

        // Determine the order of the new distillation
        // If it subsumes any existing distillations, it's one order higher than the max subsumed
        const summaries = await storage.temporal.getSummaries()
        const subsumedSummaries = summaries.filter(
          s => s.startId >= startId && s.endId <= endId
        )
        const maxSubsumedOrder = subsumedSummaries.length > 0
          ? Math.max(...subsumedSummaries.map(s => s.orderNum))
          : 0
        const newOrder = maxSubsumedOrder + 1

        // Create the distillation (stored as summary for compatibility)
        const input: SummaryInput = {
          narrative: operationalContext,
          keyObservations: retainedFacts,
          tags: [], // Could extract tags from content in future
        }

        const summaryInsert: TemporalSummaryInsert = {
          id: Identifier.ascending("summary"),
          orderNum: newOrder,
          startId,
          endId,
          narrative: input.narrative,
          keyObservations: JSON.stringify(input.keyObservations),
          tags: JSON.stringify(input.tags),
          tokenEstimate: estimateSummaryTokens(input),
          createdAt: new Date().toISOString(),
        }

        await storage.temporal.createSummary(summaryInsert)

        log.info("created distillation", {
          id: summaryInsert.id,
          order: newOrder,
          startId,
          endId,
          tokens: summaryInsert.tokenEstimate,
          factsRetained: retainedFacts.length,
          subsumed: subsumedSummaries.length,
        })

        const result: DistillationToolResult = {
          output: `Created order-${newOrder} distillation covering ${startId} → ${endId} (~${summaryInsert.tokenEstimate} tokens, ${retainedFacts.length} facts retained). ${subsumedSummaries.length > 0 ? `Subsumed ${subsumedSummaries.length} existing distillations.` : ""}`,
          done: false,
          distillationCreated: true,
        }
        results.set(toolCallId, result)
        return result.output
      },
    }),

    finish_distillation: tool({
      description: "Signal that working memory optimization is complete. Call when you've distilled enough or no more optimization is beneficial.",
      parameters: z.object({
        reason: z.string().describe("Brief explanation (e.g., 'reached target', 'recent content needs detail for ongoing work')"),
      }),
      execute: async ({ reason }, { toolCallId }) => {
        log.info("distillation finished", { reason })
        const result: DistillationToolResult = {
          output: `Distillation complete: ${reason}`,
          done: true,
          distillationCreated: false,
        }
        results.set(toolCallId, result)
        return result.output
      },
    }),
  }

  return {
    tools,
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}

/**
 * Collect valid IDs that the agent can reference for summarization.
 * Excludes the most recent N messages (recency buffer) to preserve immediate context.
 *
 * @param messages All messages in temporal storage
 * @param summaries All summaries in temporal storage
 * @param recencyBuffer Number of recent messages to exclude from summarization
 * @returns Set of IDs that can be used as summary boundaries, plus the cutoff ID
 */
function collectValidIds(
  messages: TemporalMessage[],
  summaries: TemporalSummary[],
  recencyBuffer: number,
): { validIds: Set<string>; recencyCutoffId: string | null } {
  const ids = new Set<string>()

  // Sort messages chronologically
  const sortedMessages = [...messages].sort((a, b) => a.id.localeCompare(b.id))

  // Determine the cutoff point - messages before this can be summarized
  const cutoffIndex = Math.max(0, sortedMessages.length - recencyBuffer)
  const recencyCutoffId = cutoffIndex > 0 ? sortedMessages[cutoffIndex - 1]?.id ?? null : null

  // Add summary boundary IDs (only if they're before the cutoff)
  for (const summary of summaries) {
    if (!recencyCutoffId || summary.endId <= recencyCutoffId) {
      ids.add(summary.startId)
      ids.add(summary.endId)
    }
  }

  // Add message IDs (only those before the cutoff)
  for (let i = 0; i < cutoffIndex; i++) {
    ids.add(sortedMessages[i].id)
  }

  return { validIds: ids, recencyCutoffId }
}

/**
 * Run the compaction agent.
 */
export async function runCompaction(
  storage: Storage,
  config: CompactionConfig,
): Promise<CompactionResult> {
  const result: CompactionResult = {
    summariesCreated: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    turnsUsed: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  }

  // Get initial token count
  result.tokensBefore = await storage.temporal.estimateUncompactedTokens()

  if (result.tokensBefore <= config.compactionTarget) {
    log.info("skipping compaction - already under target", {
      current: result.tokensBefore,
      target: config.compactionTarget,
    })
    result.tokensAfter = result.tokensBefore
    return result
  }

  log.info("starting distillation", {
    tokensBefore: result.tokensBefore,
    target: config.compactionTarget,
  })

  // Build agent context (shared with all workloads)
  // Note: we only use systemPrompt here; history is rebuilt each turn
  const ctx = await buildAgentContext(storage)

  // Get model (use workhorse tier - good balance of capability and cost)
  const model = Provider.getModelForTier("workhorse")

  // Outer loop: keep compacting until under budget or max turns
  for (let turn = 0; turn < MAX_COMPACTION_TURNS; turn++) {
    result.turnsUsed++

    // Check current token count
    const currentTokens = await storage.temporal.estimateUncompactedTokens()

    if (currentTokens <= config.compactionTarget) {
      log.info("compaction target reached", {
        current: currentTokens,
        target: config.compactionTarget
      })
      break
    }

    // Rebuild conversation history (it now includes IDs in messages/summaries)
    // This must be refreshed each turn since summaries may have been created
    const refreshedHistoryTurns = await buildConversationHistory(storage)

    // Get all messages and summaries to know which IDs are valid
    const allMessages = await storage.temporal.getMessages()
    const allSummaries = await storage.temporal.getSummaries()

    // Get recency buffer from config - these messages are protected from summarization
    const appConfig = Config.get()
    const recencyBuffer = appConfig.tokenBudgets.recencyBufferMessages
    const { validIds, recencyCutoffId } = collectValidIds(allMessages, allSummaries, recencyBuffer)

    log.debug("compaction valid IDs", {
      totalMessages: allMessages.length,
      validIds: validIds.size,
      recencyBuffer,
      recencyCutoffId,
    })

    // Build tools with execute callbacks (must rebuild each turn as validIds changes)
    const { tools, getLastResult } = buildCompactionTools(storage, validIds)

    // Build task prompt (IDs are already visible in the conversation)
    const taskPrompt = buildCompactionTaskPrompt(
      currentTokens,
      config.compactionTarget,
      recencyBuffer,
    )

    // Agent messages: refreshed history + compaction task
    const initialMessages: CoreMessage[] = [
      ...refreshedHistoryTurns,
      { role: "user", content: `[SYSTEM: ${taskPrompt}]` },
    ]

    // Run the inner agent loop using the generic loop abstraction
    const loopResult = await runAgentLoop({
      model,
      systemPrompt: ctx.systemPrompt,
      initialMessages,
      tools,
      maxTokens: 4096,
      temperature: 0,
      maxTurns: 5,
      isDone: stopOnTool("finish_distillation"),
      onToolResult: (toolCallId, toolName) => {
        // Track distillations created using our result tracking map
        const toolResult = getLastResult(toolCallId)
        if (toolResult?.distillationCreated) {
          result.summariesCreated++
        }
      },
    })

    result.usage.inputTokens += loopResult.usage.inputTokens
    result.usage.outputTokens += loopResult.usage.outputTokens

    // Check if no tool calls were made (agent confused)
    if (loopResult.turnsUsed === 1 && loopResult.messages.length === initialMessages.length + 1) {
      log.warn("distillation agent made no tool calls", {
        text: loopResult.finalText?.slice(0, 200)
      })
    }
  }

  // Get final token count
  result.tokensAfter = await storage.temporal.estimateUncompactedTokens()

  log.info("distillation complete", {
    distillationsCreated: result.summariesCreated,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    turnsUsed: result.turnsUsed,
  })

  return result
}

/**
 * Run compaction as a background worker with tracking.
 */
export async function runCompactionWorker(
  storage: Storage,
  config: CompactionConfig,
): Promise<CompactionResult> {
  // Create worker record
  const workerId = Identifier.ascending("worker")
  await storage.workers.create({
    id: workerId,
    type: "temporal-compact",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  })

  try {
    const result = await runCompaction(storage, config)
    await storage.workers.complete(workerId)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await storage.workers.fail(workerId, error)
    throw e
  }
}

// Legacy exports for backwards compatibility during transition
// TODO: Remove these after updating callers

/** @deprecated Use runCompaction instead */
export interface SummarizationLLM {
  summarizeMessages(messages: TemporalMessage[]): Promise<SummaryInput>
  summarizeSummaries(summaries: TemporalSummary[], targetOrder: number): Promise<SummaryInput>
}

/** @deprecated No longer needed - agent handles summarization */
export function createSummarizationLLM(): SummarizationLLM {
  throw new Error("createSummarizationLLM is deprecated - use runCompaction instead")
}
