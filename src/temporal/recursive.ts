/**
 * Recursive summarization logic.
 *
 * Handles the creation of order-2+ summaries from lower-order summaries.
 * The system maintains a compression invariant: the entire history
 * always fits within the configured temporal budget.
 */

import type { TemporalSummary } from "../storage/schema"
import { COMPRESSION_TARGETS } from "./compaction"
import { isSubsumedByHigherOrder } from "./coverage"

/**
 * Get all summaries at a specific order level that haven't been subsumed.
 */
export function getUnsubsumedSummariesAtOrder(
  allSummaries: TemporalSummary[],
  order: number,
): TemporalSummary[] {
  const atOrder = allSummaries.filter((s) => s.orderNum === order)
  return atOrder.filter((s) => !isSubsumedByHigherOrder(s, allSummaries))
}

/**
 * Determine the next order level that needs summarization.
 *
 * Returns null if no summarization is needed at any level.
 */
export function getNextOrderToSummarize(
  allSummaries: TemporalSummary[],
): { order: number; summariesToProcess: TemporalSummary[] } | null {
  // Start from order 1 and work up
  const maxOrder = Math.max(0, ...allSummaries.map((s) => s.orderNum))

  for (let order = 1; order <= maxOrder; order++) {
    const unsubsumed = getUnsubsumedSummariesAtOrder(allSummaries, order)
    if (unsubsumed.length >= COMPRESSION_TARGETS.summariesPerHigherOrder.min) {
      return {
        order: order + 1, // The order we're creating
        summariesToProcess: unsubsumed,
      }
    }
  }

  return null
}

/**
 * Calculate the range for a new higher-order summary.
 *
 * The range should cover all the summaries being combined.
 */
export function calculateHigherOrderRange(
  summaries: TemporalSummary[],
): { startId: string; endId: string } {
  if (summaries.length === 0) {
    throw new Error("Cannot calculate range from empty summaries")
  }

  // Sort by startId to find the range
  const sorted = [...summaries].sort((a, b) => a.startId.localeCompare(b.startId))

  return {
    startId: sorted[0].startId,
    endId: sorted[sorted.length - 1].endId,
  }
}

/**
 * Check if creating a higher-order summary would maintain the compression invariant.
 *
 * The invariant is: total summary tokens < temporal budget
 */
export function checkCompressionInvariant(
  allSummaries: TemporalSummary[],
  newSummaryTokens: number,
  budget: number,
): { passes: boolean; currentTokens: number; projectedTokens: number } {
  // Calculate current effective tokens (only unsubsumed summaries)
  const effectiveSummaries = allSummaries.filter(
    (s) => !isSubsumedByHigherOrder(s, allSummaries),
  )
  const currentTokens = effectiveSummaries.reduce(
    (sum, s) => sum + s.tokenEstimate,
    0,
  )

  // The new summary replaces multiple lower-order summaries
  // So projected = current (those being replaced will be subsumed)
  // We need to calculate what will remain after subsumption
  const projectedTokens = currentTokens + newSummaryTokens

  return {
    passes: projectedTokens < budget,
    currentTokens,
    projectedTokens,
  }
}

/**
 * Get the expected token budget for a summary at a given order.
 */
export function getExpectedTokenBudget(order: number): { min: number; max: number } {
  if (order === 1) {
    return COMPRESSION_TARGETS.order1OutputTokens
  } else if (order === 2) {
    return COMPRESSION_TARGETS.order2OutputTokens
  } else {
    return COMPRESSION_TARGETS.order3PlusOutputTokens
  }
}

/**
 * Determine how many orders of recursion are needed for a given message count.
 *
 * This is useful for planning and debugging.
 */
export function estimateRequiredOrders(messageCount: number): number {
  if (messageCount === 0) return 0

  const { max: messagesPerSummary } = COMPRESSION_TARGETS.messagesPerOrder1
  const { max: summariesPerHigherOrder } = COMPRESSION_TARGETS.summariesPerHigherOrder

  // Order 1: messages → summaries
  let summaryCount = Math.ceil(messageCount / messagesPerSummary)
  let orders = 1

  // Higher orders: summaries → fewer summaries
  while (summaryCount >= summariesPerHigherOrder) {
    summaryCount = Math.ceil(summaryCount / summariesPerHigherOrder)
    orders++
  }

  return orders
}

/**
 * Calculate the compression ratio achieved by summarization.
 */
export function calculateCompressionRatio(
  inputTokens: number,
  outputTokens: number,
): number {
  if (inputTokens === 0) return 1
  return inputTokens / outputTokens
}

/**
 * Validate that a recursive summarization result is correct.
 *
 * Checks:
 * - ULID ordering invariant maintained
 * - Range correctly covers input summaries
 * - Token count within expected bounds
 */
export function validateRecursiveSummary(
  inputSummaries: TemporalSummary[],
  outputSummary: Pick<TemporalSummary, "orderNum" | "startId" | "endId" | "tokenEstimate">,
): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check order level
  const maxInputOrder = Math.max(...inputSummaries.map((s) => s.orderNum))
  if (outputSummary.orderNum !== maxInputOrder + 1) {
    errors.push(
      `Output order ${outputSummary.orderNum} should be ${maxInputOrder + 1}`,
    )
  }

  // Check range coverage
  const expectedRange = calculateHigherOrderRange(inputSummaries)
  if (outputSummary.startId !== expectedRange.startId) {
    errors.push(
      `startId ${outputSummary.startId} should be ${expectedRange.startId}`,
    )
  }
  if (outputSummary.endId !== expectedRange.endId) {
    errors.push(`endId ${outputSummary.endId} should be ${expectedRange.endId}`)
  }

  // Check ULID ordering
  if (outputSummary.startId > outputSummary.endId) {
    errors.push(`Invalid range: startId > endId`)
  }

  // Check token bounds (with generous margins)
  const expectedTokens = getExpectedTokenBudget(outputSummary.orderNum)
  if (outputSummary.tokenEstimate < expectedTokens.min * 0.3) {
    errors.push(`Token count ${outputSummary.tokenEstimate} too low (min: ${expectedTokens.min})`)
  }
  if (outputSummary.tokenEstimate > expectedTokens.max * 3) {
    errors.push(`Token count ${outputSummary.tokenEstimate} too high (max: ${expectedTokens.max})`)
  }

  return { valid: errors.length === 0, errors }
}
