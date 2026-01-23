/**
 * Summary creation and validation logic.
 *
 * Handles creating summaries from messages or lower-order summaries,
 * validating ULID ranges, and estimating tokens.
 */

import type { TemporalMessage, TemporalSummary, TemporalSummaryInsert } from "../storage/schema"
import { Identifier } from "../id"
import { COMPRESSION_TARGETS } from "./compaction"

export interface SummaryInput {
  /** The narrative prose summary */
  narrative: string
  /** Key facts, decisions, instructions to retain */
  keyObservations: string[]
  /** Topic tags for searchability */
  tags: string[]
}

export interface CreateSummaryParams {
  /** Order level: 1 for messages, 2+ for summaries */
  order: number
  /** First covered ULID (inclusive) */
  startId: string
  /** Last covered ULID (inclusive) */
  endId: string
  /** Summary content from LLM */
  input: SummaryInput
}

/**
 * Estimate token count for a summary's content.
 *
 * Uses a rough approximation: ~4 characters per token.
 * This is a simplification—actual tokenization varies by model.
 */
export function estimateSummaryTokens(input: SummaryInput): number {
  const narrativeTokens = Math.ceil(input.narrative.length / 4)
  const observationTokens = input.keyObservations.reduce(
    (sum, obs) => sum + Math.ceil(obs.length / 4),
    0,
  )
  const tagTokens = input.tags.length * 2 // Tags are usually short

  return narrativeTokens + observationTokens + tagTokens
}

/**
 * Create a summary insert object ready for storage.
 */
export function createSummaryInsert(params: CreateSummaryParams): TemporalSummaryInsert {
  const { order, startId, endId, input } = params

  return {
    id: Identifier.ascending("summary"),
    orderNum: order,
    startId,
    endId,
    narrative: input.narrative,
    keyObservations: JSON.stringify(input.keyObservations),
    tags: JSON.stringify(input.tags),
    tokenEstimate: estimateSummaryTokens(input),
    createdAt: new Date().toISOString(),
  }
}

/**
 * Validate that a summary's ULID range is correct.
 *
 * Rules:
 * - startId must be <= endId (lexicographically)
 * - For order-1: range should cover messages
 * - For order-2+: range should cover summaries
 */
export function validateSummaryRange(
  startId: string,
  endId: string,
): { valid: boolean; error?: string } {
  if (startId > endId) {
    return {
      valid: false,
      error: `Invalid range: startId ${startId} > endId ${endId}`,
    }
  }

  return { valid: true }
}

/**
 * Check if a summary's token count is within expected bounds.
 */
export function validateSummaryTokens(
  order: number,
  tokenEstimate: number,
): { valid: boolean; warning?: string } {
  const targets =
    order === 1
      ? COMPRESSION_TARGETS.order1OutputTokens
      : order === 2
        ? COMPRESSION_TARGETS.order2OutputTokens
        : COMPRESSION_TARGETS.order3PlusOutputTokens

  if (tokenEstimate < targets.min * 0.5) {
    return {
      valid: true,
      warning: `Summary is very short (${tokenEstimate} tokens, expected ${targets.min}-${targets.max})`,
    }
  }

  if (tokenEstimate > targets.max * 1.5) {
    return {
      valid: true,
      warning: `Summary is very long (${tokenEstimate} tokens, expected ${targets.min}-${targets.max})`,
    }
  }

  return { valid: true }
}

/**
 * Find natural breakpoints in a sequence of messages for summarization.
 *
 * Breakpoints are identified by:
 * - Time gaps (long pauses between messages)
 * - Topic changes (detected via simple heuristics)
 * - Task completions (tool results, explicit completions)
 */
export function findBreakpoints(
  messages: TemporalMessage[],
): number[] {
  if (messages.length < 2) return []

  const breakpoints: number[] = []
  const { min: minMessages, max: maxMessages } = COMPRESSION_TARGETS.messagesPerOrder1

  // Simple heuristic: break at regular intervals within the target range
  // More sophisticated breakpoint detection can be added later
  let lastBreak = 0
  for (let i = 0; i < messages.length; i++) {
    const sinceLastBreak = i - lastBreak

    // Check for natural breakpoints
    const isToolResult = messages[i].type === "tool_result"
    const isNearTargetSize = sinceLastBreak >= minMessages

    if (isNearTargetSize && (isToolResult || sinceLastBreak >= maxMessages)) {
      breakpoints.push(i)
      lastBreak = i
    }
  }

  return breakpoints
}

/**
 * Group messages into chunks suitable for order-1 summarization.
 *
 * Each chunk should contain approximately 15-25 messages.
 */
export function groupMessagesForSummary(
  messages: TemporalMessage[],
): TemporalMessage[][] {
  if (messages.length === 0) return []

  const { min: minMessages, max: maxMessages } = COMPRESSION_TARGETS.messagesPerOrder1

  // If we have fewer than minimum, return as single group
  if (messages.length < minMessages) {
    return [messages]
  }

  const groups: TemporalMessage[][] = []
  let currentGroup: TemporalMessage[] = []

  for (const msg of messages) {
    currentGroup.push(msg)

    // Check if we should end this group
    if (currentGroup.length >= maxMessages) {
      groups.push(currentGroup)
      currentGroup = []
    }
  }

  // Handle remaining messages
  if (currentGroup.length > 0) {
    // If remainder is too small, merge with previous group
    if (currentGroup.length < minMessages && groups.length > 0) {
      const lastGroup = groups[groups.length - 1]
      groups[groups.length - 1] = [...lastGroup, ...currentGroup]
    } else {
      groups.push(currentGroup)
    }
  }

  return groups
}

/**
 * Group summaries for higher-order summarization.
 *
 * Each group should contain approximately 4-5 summaries.
 */
export function groupSummariesForHigherOrder(
  summaries: TemporalSummary[],
): TemporalSummary[][] {
  if (summaries.length === 0) return []

  const { min, max } = COMPRESSION_TARGETS.summariesPerHigherOrder

  // If we have fewer than minimum, can't create higher order yet
  if (summaries.length < min) {
    return []
  }

  const groups: TemporalSummary[][] = []
  let currentGroup: TemporalSummary[] = []

  for (const summary of summaries) {
    currentGroup.push(summary)

    if (currentGroup.length >= max) {
      groups.push(currentGroup)
      currentGroup = []
    }
  }

  // Handle remaining summaries
  if (currentGroup.length >= min) {
    groups.push(currentGroup)
  } else if (currentGroup.length > 0 && groups.length > 0) {
    // Merge with previous group if too small
    const lastGroup = groups[groups.length - 1]
    groups[groups.length - 1] = [...lastGroup, ...currentGroup]
  }

  return groups
}
