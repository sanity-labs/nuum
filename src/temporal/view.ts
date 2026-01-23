/**
 * Temporal view construction.
 *
 * Builds the temporal context that goes into the agent's system prompt.
 * The view must fit within token budget while prioritizing recent content.
 *
 * Token distribution (from arch spec):
 * [Oldest summaries: ~10%] [Mid-history: ~20%] [Recent summaries: ~30%] [Raw messages: ~40%]
 */

import type { TemporalMessage, TemporalSummary } from "../storage/schema"
import { isCoveredBySummary, isSubsumedByHigherOrder } from "./coverage"

export interface TemporalView {
  /** Summaries included in the view, sorted chronologically */
  summaries: TemporalSummary[]
  /** Raw messages included in the view, sorted chronologically */
  messages: TemporalMessage[]
  /** Total tokens used by this view */
  totalTokens: number
  /** Token breakdown for debugging */
  breakdown: {
    summaryTokens: number
    messageTokens: number
  }
}

export interface BuildTemporalViewOptions {
  /** Maximum token budget for the entire view */
  budget: number
  /** All messages in the temporal store */
  messages: TemporalMessage[]
  /** All summaries in the temporal store */
  summaries: TemporalSummary[]
}

/**
 * Build a temporal view that fits within the token budget.
 *
 * Algorithm:
 * 1. Add recent raw messages until ~40% of budget
 * 2. Fill remaining budget with summaries (highest order first, recent first)
 * 3. Skip messages covered by summaries
 * 4. Skip summaries subsumed by higher-order summaries
 */
export function buildTemporalView(options: BuildTemporalViewOptions): TemporalView {
  const { budget, messages, summaries } = options

  // Handle empty history
  if (messages.length === 0 && summaries.length === 0) {
    return {
      summaries: [],
      messages: [],
      totalTokens: 0,
      breakdown: { summaryTokens: 0, messageTokens: 0 },
    }
  }

  // Budget allocation
  const rawMessageBudget = Math.floor(budget * 0.4)
  const summaryBudget = budget - rawMessageBudget

  let messageTokens = 0
  let summaryTokens = 0
  const includedMessages: TemporalMessage[] = []
  const includedSummaries: TemporalSummary[] = []

  // 1. Add recent raw messages (most recent first, up to ~40% of budget)
  // Sort messages by ID descending (most recent first)
  const sortedMessages = [...messages].sort((a, b) => b.id.localeCompare(a.id))

  for (const msg of sortedMessages) {
    // Skip if covered by any summary
    if (isCoveredBySummary(msg.id, summaries)) {
      continue
    }

    // Check if adding this message would exceed budget
    if (messageTokens + msg.tokenEstimate > rawMessageBudget) {
      break
    }

    // Add to beginning to maintain chronological order
    includedMessages.unshift(msg)
    messageTokens += msg.tokenEstimate
  }

  // 2. Fill remaining budget with summaries
  // Sort summaries by: order DESC (highest first), then id DESC (most recent first)
  const sortedSummaries = [...summaries].sort((a, b) => {
    if (a.orderNum !== b.orderNum) {
      return b.orderNum - a.orderNum // Higher order first
    }
    return b.id.localeCompare(a.id) // More recent first
  })

  for (const summary of sortedSummaries) {
    // Skip if subsumed by a higher-order summary
    if (isSubsumedByHigherOrder(summary, summaries)) {
      continue
    }

    // Check if adding this summary would exceed budget
    if (summaryTokens + summary.tokenEstimate > summaryBudget) {
      continue // Try next summary, it might be smaller
    }

    includedSummaries.push(summary)
    summaryTokens += summary.tokenEstimate
  }

  // Sort summaries chronologically for output (by startId)
  includedSummaries.sort((a, b) => a.startId.localeCompare(b.startId))

  return {
    summaries: includedSummaries,
    messages: includedMessages,
    totalTokens: messageTokens + summaryTokens,
    breakdown: {
      summaryTokens,
      messageTokens,
    },
  }
}

/**
 * Render the temporal view as XML for the system prompt.
 */
export function renderTemporalView(view: TemporalView): string {
  if (view.summaries.length === 0 && view.messages.length === 0) {
    return "<conversation_history>\nNo previous conversation history.\n</conversation_history>"
  }

  const parts: string[] = ["<conversation_history>"]

  // Render summaries (oldest first)
  for (const summary of view.summaries) {
    const observations = JSON.parse(summary.keyObservations) as string[]
    parts.push(
      `<summary order="${summary.orderNum}" from="${summary.startId}" to="${summary.endId}">`,
    )
    parts.push(summary.narrative)
    if (observations.length > 0) {
      parts.push("Key observations:")
      for (const obs of observations) {
        parts.push(`- ${obs}`)
      }
    }
    parts.push("</summary>")
    parts.push("")
  }

  // Render recent messages
  for (const msg of view.messages) {
    const prefix = getMessagePrefix(msg.type)
    parts.push(`${prefix}: ${msg.content}`)
  }

  parts.push("</conversation_history>")

  return parts.join("\n")
}

function getMessagePrefix(type: string): string {
  switch (type) {
    case "user":
      return "[User]"
    case "assistant":
      return "[Assistant]"
    case "tool_call":
      return "[Tool Call]"
    case "tool_result":
      return "[Tool Result]"
    case "system":
      return "[System]"
    default:
      return "[Unknown]"
  }
}
