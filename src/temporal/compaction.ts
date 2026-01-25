/**
 * Compaction trigger and scheduling logic.
 *
 * Determines when compaction should run and manages the compaction workflow.
 * Compaction is triggered based on the effective view size - the actual tokens
 * that would be sent to the agent (summaries + uncovered messages).
 */

import type { TemporalStorage } from "../storage"
import type { WorkerStorage } from "../storage"
import { buildTemporalView } from "./view"

export interface CompactionConfig {
  /** Trigger compaction when effective view exceeds this threshold */
  compactionThreshold: number
  /** Target token count after compaction completes */
  compactionTarget: number
}

export interface CompactionState {
  /** Whether compaction is currently running */
  isRunning: boolean
  /** Worker ID if running */
  workerId?: string
}

/**
 * Check if compaction should be triggered.
 *
 * @returns true if effective view tokens exceed threshold and no compaction is running
 */
export async function shouldTriggerCompaction(
  temporal: TemporalStorage,
  workers: WorkerStorage,
  config: CompactionConfig,
): Promise<boolean> {
  // Check if compaction is already running
  const runningWorkers = await workers.getRunning()
  const compactionRunning = runningWorkers.some((w) => w.type === "temporal-compact")
  if (compactionRunning) {
    return false // Don't double-trigger
  }

  // Check if effective view exceeds threshold
  const viewTokens = await getEffectiveViewTokens(temporal)
  return viewTokens > config.compactionThreshold
}

/**
 * Fixed token overhead for context that isn't tracked in temporal storage.
 * This accounts for:
 * - System prompt (~1-2k tokens)
 * - Tool definitions (~3-5k tokens for 10+ tools)
 * - Message structure overhead (JSON, role markers, IDs)
 * - Safety margin for provider-specific formatting
 *
 * Without this, the estimate undercounts actual API tokens by ~40-50%,
 * causing compaction to trigger too late (e.g., estimate 103k = actual 160k).
 */
export const FIXED_OVERHEAD_TOKENS = 40_000

/**
 * Get the token count of the effective view (what actually goes to the agent).
 * Includes fixed overhead for system prompt, tools, and formatting.
 */
export async function getEffectiveViewTokens(temporal: TemporalStorage): Promise<number> {
  const messages = await temporal.getMessages()
  const summaries = await temporal.getSummaries()
  const view = buildTemporalView({ budget: 0, messages, summaries })
  return view.totalTokens + FIXED_OVERHEAD_TOKENS
}

/**
 * Get current compaction state.
 */
export async function getCompactionState(
  workers: WorkerStorage,
): Promise<CompactionState> {
  const runningWorkers = await workers.getRunning()
  const compactionWorker = runningWorkers.find((w) => w.type === "temporal-compact")
  if (compactionWorker) {
    return { isRunning: true, workerId: compactionWorker.id }
  }
  return { isRunning: false }
}

/**
 * Calculate how many tokens need to be compacted.
 *
 * @returns The number of tokens above the target that need compression
 */
export async function calculateCompactionTarget(
  temporal: TemporalStorage,
  config: CompactionConfig,
): Promise<number> {
  const viewTokens = await getEffectiveViewTokens(temporal)
  const tokensToCompress = viewTokens - config.compactionTarget
  return Math.max(0, tokensToCompress)
}

/**
 * Determine which messages should be included in the next compaction run.
 *
 * Returns messages after the last summary that haven't been compacted yet.
 */
export async function getMessagesToCompact(
  temporal: TemporalStorage,
): Promise<{ messages: Awaited<ReturnType<TemporalStorage["getMessages"]>>; fromId: string | null }> {
  const lastEndId = await temporal.getLastSummaryEndId()

  if (lastEndId) {
    // Get all messages after the last summary
    const messages = await temporal.getMessages(lastEndId)
    // Filter out the boundary message (it's already summarized)
    const filtered = messages.filter((m) => m.id > lastEndId)
    return { messages: filtered, fromId: lastEndId }
  }

  // No summaries yet - all messages need compaction
  const messages = await temporal.getMessages()
  return { messages, fromId: null }
}

/**
 * Compression ratio targets for different summary orders.
 *
 * From arch spec:
 * - Order 1: ~15-25 messages → ~500-800 tokens
 * - Order 2: ~4-5 order-1 summaries → ~300-500 tokens
 * - Order 3+: ~4-5 lower-order summaries → ~150-250 tokens
 */
export const COMPRESSION_TARGETS = {
  /** Target number of messages per order-1 summary */
  messagesPerOrder1: { min: 15, max: 25 },
  /** Target tokens for order-1 summary output */
  order1OutputTokens: { min: 500, max: 800 },
  /** Target number of lower-order summaries per higher-order summary */
  summariesPerHigherOrder: { min: 4, max: 5 },
  /** Target tokens for order-2 summary output */
  order2OutputTokens: { min: 300, max: 500 },
  /** Target tokens for order-3+ summary output */
  order3PlusOutputTokens: { min: 150, max: 250 },
} as const

/**
 * Determine if enough order-1 summaries exist to create an order-2 summary.
 */
export function shouldCreateOrder2Summary(
  order1Summaries: Array<{ id: string; orderNum: number }>,
): boolean {
  return order1Summaries.length >= COMPRESSION_TARGETS.summariesPerHigherOrder.min
}

/**
 * Determine if enough order-N summaries exist to create an order-(N+1) summary.
 */
export function shouldCreateHigherOrderSummary(
  summariesAtOrder: Array<{ id: string; orderNum: number }>,
): boolean {
  return summariesAtOrder.length >= COMPRESSION_TARGETS.summariesPerHigherOrder.min
}
