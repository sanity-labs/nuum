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

import type {CoreMessage, LanguageModel} from 'ai'
import type {Storage} from '../storage'
import type {TemporalMessage, TemporalSummary} from '../storage/schema'
import {Provider} from '../provider'
import {Log} from '../util/log'
import {Config} from '../config'
import {buildAgentContext, buildConversationHistory} from '../context'
import {runAgentLoop, stopOnTool} from '../agent/loop'
import {getEffectiveViewTokens} from './compaction'
import {Identifier} from '../id'
import {
  buildDistillationTools,
  type DistillationToolResult,
} from '../tool/distillation'
import {activity} from '../util/activity-log'

const log = Log.create({service: 'compaction-agent'})

const MAX_COMPACTION_TURNS = 10

/**
 * Result of a compaction run.
 */
export interface CompactionResult {
  /** Number of distillations created */
  distillationsCreated: number
  /** Total tokens before compaction */
  tokensBefore: number
  /** Total tokens after compaction */
  tokensAfter: number
  /** Number of agent turns taken */
  turnsUsed: number
  /** Contextual summary from the agent (for background reports) */
  summary?: string
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
  /** Force compaction even if under target (for cleanup) */
  force?: boolean
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
  const underTarget = currentTokens <= targetTokens

  return `## Working Memory Optimization Task

Your working memory (conversation history) needs to be optimized for effective action.

**Current size:** ~${currentTokens.toLocaleString()} tokens
**Target size:** ~${targetTokens.toLocaleString()} tokens
${
  underTarget
    ? '**Status:** Already at/under target. You may clean up noise if you see any, or call finish_distillation.'
    : `**To distill:** ~${(currentTokens - targetTokens).toLocaleString()} tokens`
}
**Recency buffer:** ${recencyBuffer} most recent messages are protected

The conversation above contains timestamps and IDs you can reference:
- Messages have \`[YYYY-MM-DD HH:MM id:xxx]\` prefixes (timestamp + ID)
- Distillations show \`[distilled from:xxx to:yyy]\` ranges
- The most recent ${recencyBuffer} messages cannot be distilled (preserve immediate context)

Note: These prefixes are for YOUR reference when creating distillations. Do not echo them in responses.

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
- Casual chatter, greetings, acknowledgments
- Questions that were immediately answered (keep only the answer)
- Exploratory tangents that didn't lead anywhere

**TIME AWARENESS:**
- Recent content: Keep more detail (might need to reference or backtrack)
- Older content: Distill more aggressively to conclusions
- Ancient content: Should be heavily compressed - just outcomes and key facts

**ELIMINATION DISTILLATIONS:**
Sometimes the best distillation is minimal or empty. If a range contains only noise
(greetings, false starts, debugging that led nowhere), it's valid to create a
distillation with just "Eliminated noise" and no retained facts. The goal is
optimizing working memory, not preserving everything.

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

### Writing Your Summary

When you call \`finish_distillation\`, write a brief note to your future self explaining what you compressed and what you retained. This is a dialog between your subconscious (the compactor) and your conscious self (the main agent).

**Good summaries** explain the WHAT and WHY:
- "Combined the three debugging sessions into one distillation - retained the key insight about the race condition and the fix in src/agent/loop.ts."
- "Distilled the API refactoring work, keeping all the endpoint paths and the decision to use REST over GraphQL."
- "Compressed the deployment troubleshooting - kept the final working config and the gotcha about environment variables."

**Avoid mechanical summaries**:
- ✗ "Reached target"
- ✗ "Created 3 distillations"

**Remember:** You're optimizing your own working memory. Keep what helps you act with precision.
`
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
): {validIds: Set<string>; recencyCutoffId: string | null} {
  const ids = new Set<string>()

  // Sort messages chronologically
  const sortedMessages = [...messages].sort((a, b) => a.id.localeCompare(b.id))

  // Determine the cutoff point - messages before this can be summarized
  const cutoffIndex = Math.max(0, sortedMessages.length - recencyBuffer)
  const recencyCutoffId =
    cutoffIndex > 0 ? (sortedMessages[cutoffIndex - 1]?.id ?? null) : null

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

  return {validIds: ids, recencyCutoffId}
}

/**
 * Run the compaction agent.
 */
export async function runCompaction(
  storage: Storage,
  config: CompactionConfig,
): Promise<CompactionResult> {
  const result: CompactionResult = {
    distillationsCreated: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    turnsUsed: 0,
    usage: {inputTokens: 0, outputTokens: 0},
  }

  // Get initial token count (effective view = what actually goes to agent)
  result.tokensBefore = await getEffectiveViewTokens(storage.temporal)

  if (result.tokensBefore <= config.compactionTarget && !config.force) {
    log.info('skipping compaction - already under target', {
      current: result.tokensBefore,
      target: config.compactionTarget,
    })
    result.tokensAfter = result.tokensBefore
    return result
  }

  log.info('starting distillation', {
    tokensBefore: result.tokensBefore,
    target: config.compactionTarget,
  })

  // Build agent context (shared with all workloads)
  // Note: we only use systemPrompt here; history is rebuilt each turn
  const ctx = await buildAgentContext(storage)

  // Get models - prefer reasoning tier (Opus) but fall back to workhorse (Sonnet)
  // if the prompt is too long for Opus's 200K context limit
  let model: LanguageModel = Provider.getModelForTier('reasoning')
  let usingFallbackModel = false

  // Outer loop: agent controls when to stop via finish_distillation
  // We just enforce max turns as a safety limit
  for (let turn = 0; turn < MAX_COMPACTION_TURNS; turn++) {
    result.turnsUsed++

    // Get current effective view size for the prompt
    const currentTokens = await getEffectiveViewTokens(storage.temporal)

    // Rebuild conversation history (it now includes IDs in messages/summaries)
    // This must be refreshed each turn since summaries may have been created
    const refreshedHistoryTurns = await buildConversationHistory(storage)

    // Get all messages and summaries to know which IDs are valid
    const allMessages = await storage.temporal.getMessages()
    const allSummaries = await storage.temporal.getSummaries()

    // Get recency buffer from config - these messages are protected from summarization
    const appConfig = Config.get()
    const recencyBuffer = appConfig.tokenBudgets.recencyBufferMessages
    const {validIds, recencyCutoffId} = collectValidIds(
      allMessages,
      allSummaries,
      recencyBuffer,
    )

    log.debug('compaction valid IDs', {
      totalMessages: allMessages.length,
      validIds: validIds.size,
      recencyBuffer,
      recencyCutoffId,
    })

    // Build tools with execute callbacks (must rebuild each turn as validIds changes)
    const {tools, getLastResult} = buildDistillationTools({
      storage,
      validIds,
      targetTokens: config.compactionTarget,
    })

    // Build task prompt (IDs are already visible in the conversation)
    const taskPrompt = buildCompactionTaskPrompt(
      currentTokens,
      config.compactionTarget,
      recencyBuffer,
    )

    // Agent messages: refreshed history + compaction task
    const initialMessages: CoreMessage[] = [
      ...refreshedHistoryTurns,
      {role: 'user', content: `[SYSTEM: ${taskPrompt}]`},
    ]

    // Run the inner agent loop using the generic loop abstraction
    // If the prompt is too long for Opus, fall back to Sonnet (which has 1M context)
    let loopResult
    try {
      loopResult = await runAgentLoop({
        model,
        systemPrompt: ctx.systemPrompt,
        initialMessages,
        tools,
        // maxTokens: omitted — auto-detected from model
        temperature: 0,
        maxTurns: 5,
        isDone: stopOnTool('finish_distillation'),
        onToolResult: (toolCallId, toolName) => {
          // Track distillations created using our result tracking map
          const toolResult = getLastResult(toolCallId)
          if (toolResult?.distillationCreated) {
            result.distillationsCreated++
          }
          // Capture summary from finish_distillation
          if (toolResult?.summary) {
            result.summary = toolResult.summary
          }
        },
      })
    } catch (error) {
      // Check if this is a "prompt is too long" error and we haven't already fallen back
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      if (errorMessage.includes('prompt is too long') && !usingFallbackModel) {
        activity.distillation.warn(
          'Prompt too long for Opus, falling back to Sonnet (1M context)',
        )
        log.info('falling back to workhorse model due to prompt size', {
          error: errorMessage,
        })
        model = Provider.getModelForTier('workhorse')
        usingFallbackModel = true
        // Retry this turn with the new model
        turn--
        result.turnsUsed-- // Don't count this failed attempt
        continue
      }
      // Re-throw other errors
      throw error
    }

    result.usage.inputTokens += loopResult.usage.inputTokens
    result.usage.outputTokens += loopResult.usage.outputTokens

    // Check if agent called finish_distillation (inner loop ended via isDone)
    if (loopResult.stopReason === 'done') {
      break
    }

    // Check if no tool calls were made (agent confused)
    if (
      loopResult.turnsUsed === 1 &&
      loopResult.messages.length === initialMessages.length + 1
    ) {
      log.warn('distillation agent made no tool calls', {
        text: loopResult.finalText?.slice(0, 200),
      })
      break // Don't keep looping if agent is confused
    }
  }

  // Get final effective view size
  result.tokensAfter = await getEffectiveViewTokens(storage.temporal)

  log.info('distillation complete', {
    distillationsCreated: result.distillationsCreated,
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
  const workerId = Identifier.ascending('worker')
  await storage.workers.create({
    id: workerId,
    type: 'temporal-compact',
    status: 'running',
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
