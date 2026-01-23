/**
 * Mock LLM for deterministic testing of the compaction agent.
 *
 * This mock produces predictable summaries without making API calls,
 * allowing tests to verify ULID bookkeeping and compression logic.
 */

import type { TemporalMessage, TemporalSummary } from "../storage/schema"
import { COMPRESSION_TARGETS } from "./compaction"

export interface MockSummaryOutput {
  narrative: string
  keyObservations: string[]
  tags: string[]
}

export interface MockLLMConfig {
  /** Fixed token count for summaries (for predictable testing) */
  fixedTokenCount?: number
  /** Whether to include message IDs in the narrative (for debugging) */
  includeRangeInNarrative?: boolean
  /** Simulate failure on specific calls */
  failOnCall?: number
}

/**
 * Create a mock LLM that generates deterministic summaries.
 *
 * The mock:
 * - Generates predictable narratives based on input range
 * - Extracts "key observations" from message content
 * - Creates tags based on message types
 * - Respects token budget constraints
 */
export function createMockLLM(config: MockLLMConfig = {}) {
  let callCount = 0

  return {
    /**
     * Generate a summary for a set of messages (order-1).
     */
    async summarizeMessages(
      messages: TemporalMessage[],
    ): Promise<MockSummaryOutput> {
      callCount++
      if (config.failOnCall === callCount) {
        throw new Error(`Mock LLM failure on call ${callCount}`)
      }

      if (messages.length === 0) {
        throw new Error("Cannot summarize empty messages")
      }

      const startId = messages[0].id
      const endId = messages[messages.length - 1].id

      // Generate deterministic narrative
      const narrative = config.includeRangeInNarrative
        ? `Summary of ${messages.length} messages from ${startId} to ${endId}. User interactions covered various topics.`
        : `Summary of ${messages.length} messages. User interactions covered various topics.`

      // Extract observations from message content
      const keyObservations = extractObservations(messages)

      // Generate tags from message types
      const tags = extractTags(messages)

      return { narrative, keyObservations, tags }
    },

    /**
     * Generate a higher-order summary from lower-order summaries.
     */
    async summarizeSummaries(
      summaries: TemporalSummary[],
      targetOrder: number,
    ): Promise<MockSummaryOutput> {
      callCount++
      if (config.failOnCall === callCount) {
        throw new Error(`Mock LLM failure on call ${callCount}`)
      }

      if (summaries.length === 0) {
        throw new Error("Cannot summarize empty summaries")
      }

      const startId = summaries[0].startId
      const endId = summaries[summaries.length - 1].endId

      // Generate deterministic narrative
      const narrative = config.includeRangeInNarrative
        ? `Order-${targetOrder} summary covering ${summaries.length} summaries from ${startId} to ${endId}.`
        : `Order-${targetOrder} summary covering ${summaries.length} lower-order summaries.`

      // Combine observations from input summaries
      const keyObservations = combineSummaryObservations(summaries)

      // Combine tags from input summaries
      const tags = combineSummaryTags(summaries)

      return { narrative, keyObservations, tags }
    },

    /**
     * Estimate tokens for a mock summary output.
     */
    estimateTokens(output: MockSummaryOutput): number {
      if (config.fixedTokenCount !== undefined) {
        return config.fixedTokenCount
      }

      // Rough estimation similar to production
      const narrativeTokens = Math.ceil(output.narrative.length / 4)
      const observationTokens = output.keyObservations.reduce(
        (sum, obs) => sum + Math.ceil(obs.length / 4),
        0,
      )
      const tagTokens = output.tags.length * 2

      return narrativeTokens + observationTokens + tagTokens
    },

    /**
     * Get the number of calls made to this mock.
     */
    getCallCount(): number {
      return callCount
    },

    /**
     * Reset the call counter.
     */
    reset(): void {
      callCount = 0
    },
  }
}

/**
 * Extract key observations from messages.
 *
 * In the real implementation, the LLM would identify important facts.
 * For testing, we extract based on simple heuristics.
 */
function extractObservations(messages: TemporalMessage[]): string[] {
  const observations: string[] = []

  // Look for specific patterns that would be "key observations"
  for (const msg of messages) {
    if (msg.type === "user" && msg.content.length > 50) {
      // Long user messages might contain important context
      observations.push(`User input at ${msg.id}`)
    }
    if (msg.type === "tool_result") {
      // Tool results often contain important outcomes
      observations.push(`Tool execution at ${msg.id}`)
    }
  }

  // Limit observations
  return observations.slice(0, 5)
}

/**
 * Extract tags from messages based on content and types.
 */
function extractTags(messages: TemporalMessage[]): string[] {
  const tags = new Set<string>()

  for (const msg of messages) {
    // Tag based on message type
    if (msg.type === "tool_call" || msg.type === "tool_result") {
      tags.add("tools")
    }
    if (msg.type === "user") {
      tags.add("conversation")
    }
  }

  // Could add content-based tagging here
  return Array.from(tags)
}

/**
 * Combine observations from multiple summaries, deduplicating and condensing.
 */
function combineSummaryObservations(summaries: TemporalSummary[]): string[] {
  const allObservations: string[] = []

  for (const summary of summaries) {
    const obs = JSON.parse(summary.keyObservations) as string[]
    allObservations.push(...obs)
  }

  // Deduplicate and limit
  const unique = [...new Set(allObservations)]
  return unique.slice(0, 3) // Higher orders have fewer observations
}

/**
 * Combine tags from multiple summaries.
 */
function combineSummaryTags(summaries: TemporalSummary[]): string[] {
  const allTags = new Set<string>()

  for (const summary of summaries) {
    const tags = JSON.parse(summary.tags) as string[]
    tags.forEach((tag) => allTags.add(tag))
  }

  return Array.from(allTags)
}

/**
 * Type for the mock LLM instance.
 */
export type MockLLM = ReturnType<typeof createMockLLM>
