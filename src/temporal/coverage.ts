/**
 * Coverage detection functions for temporal summarization.
 *
 * These functions determine which messages are covered by summaries
 * and which summaries are subsumed by higher-order summaries.
 *
 * ULID range semantics:
 * - startId and endId are INCLUSIVE
 * - A message is covered if: message.id >= summary.startId AND message.id <= summary.endId
 * - Adjacent summaries should not overlap (summary A ends at X, summary B starts at X+1)
 */

import type { TemporalSummary, TemporalMessage } from "../storage/schema"

/**
 * Check if a message is covered by any summary.
 *
 * @param messageId - The ULID of the message to check
 * @param summaries - Array of summaries to check against
 * @returns true if the message falls within any summary's range
 */
export function isCoveredBySummary(
  messageId: string,
  summaries: Pick<TemporalSummary, "startId" | "endId">[],
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
  summary: Pick<TemporalSummary, "id" | "orderNum" | "startId" | "endId">,
  allSummaries: Pick<TemporalSummary, "id" | "orderNum" | "startId" | "endId">[],
): boolean {
  return allSummaries.some(
    (other) =>
      other.id !== summary.id &&
      other.orderNum > summary.orderNum &&
      other.startId <= summary.startId &&
      other.endId >= summary.endId,
  )
}

/**
 * Get all messages that are not covered by any summary.
 *
 * @param messages - Array of messages
 * @param summaries - Array of summaries
 * @returns Messages that fall outside all summary ranges
 */
export function getUncoveredMessages(
  messages: TemporalMessage[],
  summaries: Pick<TemporalSummary, "startId" | "endId">[],
): TemporalMessage[] {
  return messages.filter((msg) => !isCoveredBySummary(msg.id, summaries))
}

/**
 * Get all summaries that are not subsumed by higher-order summaries.
 *
 * These are the "effective" summaries that should be included in the temporal view.
 *
 * @param summaries - All summaries
 * @returns Summaries that are not covered by higher-order summaries
 */
export function getEffectiveSummaries(
  summaries: Pick<TemporalSummary, "id" | "orderNum" | "startId" | "endId">[],
): Pick<TemporalSummary, "id" | "orderNum" | "startId" | "endId">[] {
  return summaries.filter((s) => !isSubsumedByHigherOrder(s, summaries))
}

/**
 * Find gaps in summary coverage.
 *
 * A gap is a range of message IDs that:
 * 1. Comes after a summary's endId
 * 2. Comes before the next summary's startId (or is after all summaries)
 *
 * @param summaries - Array of summaries (must be sorted by startId)
 * @param messageRange - Optional range of all messages { firstId, lastId }
 * @returns Array of gaps as { afterId, beforeId } tuples
 */
export function findCoverageGaps(
  summaries: Pick<TemporalSummary, "startId" | "endId">[],
  messageRange?: { firstId: string; lastId: string },
): Array<{ afterId: string | null; beforeId: string | null }> {
  if (summaries.length === 0) {
    if (messageRange) {
      return [{ afterId: null, beforeId: null }] // Everything is a gap
    }
    return []
  }

  const sorted = [...summaries].sort((a, b) => a.startId.localeCompare(b.startId))
  const gaps: Array<{ afterId: string | null; beforeId: string | null }> = []

  // Check gap before first summary
  if (messageRange && messageRange.firstId < sorted[0].startId) {
    gaps.push({ afterId: null, beforeId: sorted[0].startId })
  }

  // Check gaps between summaries
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]
    const next = sorted[i + 1]

    // If there's a gap between current.endId and next.startId
    if (current.endId < next.startId) {
      // Check if they're actually adjacent (no gap)
      // This is a simplified check - in practice we'd need to check if any messages exist in the gap
      gaps.push({ afterId: current.endId, beforeId: next.startId })
    }
  }

  // Check gap after last summary
  const lastSummary = sorted[sorted.length - 1]
  if (messageRange && messageRange.lastId > lastSummary.endId) {
    gaps.push({ afterId: lastSummary.endId, beforeId: null })
  }

  return gaps
}
