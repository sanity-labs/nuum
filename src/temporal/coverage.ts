/**
 * Coverage detection functions for temporal summarization.
 *
 * These functions determine which messages are covered by summaries
 * and which summaries are subsumed by higher-order summaries.
 *
 * ULID range semantics:
 * - startId and endId are INCLUSIVE
 * - A message is covered if: message.id >= summary.startId AND message.id <= summary.endId
 */

import type {TemporalSummary} from '../storage/schema'

/**
 * Check if a message is covered by any summary.
 *
 * @param messageId - The ULID of the message to check
 * @param summaries - Array of summaries to check against
 * @returns true if the message falls within any summary's range
 */
export function isCoveredBySummary(
  messageId: string,
  summaries: Pick<TemporalSummary, 'startId' | 'endId'>[],
): boolean {
  return summaries.some(
    (summary) => messageId >= summary.startId && messageId <= summary.endId,
  )
}

/**
 * Check if a summary is subsumed by a higher-order summary.
 *
 * A summary is subsumed if there exists another summary with:
 * 1. Higher order number
 * 2. Range that fully contains this summary's range
 *
 * @param summary - The summary to check
 * @param allSummaries - All summaries to check against
 * @returns true if a higher-order summary covers this summary's range
 */
export function isSubsumedByHigherOrder(
  summary: Pick<TemporalSummary, 'id' | 'orderNum' | 'startId' | 'endId'>,
  allSummaries: Pick<
    TemporalSummary,
    'id' | 'orderNum' | 'startId' | 'endId'
  >[],
): boolean {
  return allSummaries.some(
    (other) =>
      other.id !== summary.id &&
      other.orderNum > summary.orderNum &&
      other.startId <= summary.startId &&
      other.endId >= summary.endId,
  )
}
