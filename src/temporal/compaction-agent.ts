/**
 * Compaction agent for temporal summarization.
 *
 * This agent orchestrates the compression of temporal history:
 * 1. Identifies messages needing compaction
 * 2. Groups them appropriately
 * 3. Calls the LLM to generate summaries
 * 4. Creates order-1 summaries from messages
 * 5. Creates higher-order summaries recursively as needed
 */

import type { Storage } from "../storage"
import type { TemporalMessage, TemporalSummary, TemporalSummaryInsert } from "../storage/schema"
import { Provider } from "../provider"
import { Config } from "../config"
import { Log } from "../util/log"
import { groupMessagesForSummary, groupSummariesForHigherOrder, createSummaryInsert, type SummaryInput } from "./summary"
import { getNextOrderToSummarize, calculateHigherOrderRange } from "./recursive"
import { getMessagesToCompact, type CompactionConfig } from "./compaction"

const log = Log.create({ service: "compaction-agent" })

/**
 * Result of a compaction run.
 */
export interface CompactionResult {
  /** Number of order-1 summaries created */
  order1Created: number
  /** Number of higher-order summaries created */
  higherOrderCreated: number
  /** Total tokens compressed */
  tokensCompressed: number
  /** New token estimate after compaction */
  tokensAfter: number
  /** Any errors encountered (non-fatal) */
  warnings: string[]
}

/**
 * Interface for the summarization LLM.
 * Can be a real LLM or a mock for testing.
 */
export interface SummarizationLLM {
  summarizeMessages(messages: TemporalMessage[]): Promise<SummaryInput>
  summarizeSummaries(summaries: TemporalSummary[], targetOrder: number): Promise<SummaryInput>
}

/**
 * Create a real LLM summarizer using the provider.
 */
export function createSummarizationLLM(): SummarizationLLM {
  return {
    async summarizeMessages(messages: TemporalMessage[]): Promise<SummaryInput> {
      const model = Provider.getModelForTier("fast") // Use Haiku for compaction

      // Build prompt for message summarization
      const messagesText = messages
        .map((m) => `[${m.type}] ${m.content}`)
        .join("\n\n")

      const result = await Provider.generate({
        model,
        system: `You are a summarization assistant. Create a concise summary of the conversation below.
Output your response as JSON with this exact structure:
{
  "narrative": "A prose summary of events (2-4 sentences)",
  "keyObservations": ["Array of key facts, decisions, or instructions to retain"],
  "tags": ["topic", "tags", "for", "searchability"]
}

Focus on:
- What was discussed or accomplished
- Key decisions made
- Important context for future reference
- Any unresolved questions or tasks`,
        messages: [
          {
            role: "user",
            content: `Summarize these ${messages.length} messages:\n\n${messagesText}`,
          },
        ],
        maxTokens: 1024,
        temperature: 0,
      })

      return parseJsonResponse(result.text)
    },

    async summarizeSummaries(summaries: TemporalSummary[], targetOrder: number): Promise<SummaryInput> {
      const model = Provider.getModelForTier("fast")

      // Build prompt for summary consolidation
      const summariesText = summaries
        .map((s, i) => {
          const obs = JSON.parse(s.keyObservations) as string[]
          return `Summary ${i + 1}:\n${s.narrative}\nKey observations: ${obs.join(", ")}`
        })
        .join("\n\n---\n\n")

      const result = await Provider.generate({
        model,
        system: `You are a summarization assistant. Create a higher-level summary from these ${summaries.length} summaries.
This is an order-${targetOrder} summary, consolidating order-${targetOrder - 1} summaries.
Output your response as JSON with this exact structure:
{
  "narrative": "A prose summary of the consolidated period (1-3 sentences)",
  "keyObservations": ["Only the most important facts that should persist"],
  "tags": ["consolidated", "topic", "tags"]
}

Be more selective - this is a higher-level summary. Keep only the most important information.`,
        messages: [
          {
            role: "user",
            content: `Consolidate these summaries:\n\n${summariesText}`,
          },
        ],
        maxTokens: 512,
        temperature: 0,
      })

      return parseJsonResponse(result.text)
    },
  }
}

/**
 * Parse JSON response from LLM, handling potential formatting issues.
 */
function parseJsonResponse(text: string): SummaryInput {
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    log.warn("Failed to extract JSON from LLM response, using fallback", { text })
    return {
      narrative: text.slice(0, 500),
      keyObservations: [],
      tags: [],
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      narrative: String(parsed.narrative || ""),
      keyObservations: Array.isArray(parsed.keyObservations)
        ? parsed.keyObservations.map(String)
        : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    }
  } catch (e) {
    log.warn("Failed to parse JSON response, using fallback", { text, error: e })
    return {
      narrative: text.slice(0, 500),
      keyObservations: [],
      tags: [],
    }
  }
}

/**
 * Run a compaction cycle.
 *
 * This function:
 * 1. Gets messages needing compaction
 * 2. Groups them and creates order-1 summaries
 * 3. Recursively creates higher-order summaries as needed
 * 4. Continues until under the compaction target or no more work
 */
export async function runCompaction(
  storage: Storage,
  llm: SummarizationLLM,
  config: CompactionConfig,
): Promise<CompactionResult> {
  const result: CompactionResult = {
    order1Created: 0,
    higherOrderCreated: 0,
    tokensCompressed: 0,
    tokensAfter: 0,
    warnings: [],
  }

  const tokensBefore = await storage.temporal.estimateUncompactedTokens()
  log.info("starting compaction", { tokensBefore, target: config.compactionTarget })

  // Phase 1: Create order-1 summaries from messages
  const order1Count = await createOrder1Summaries(storage, llm, result)
  log.info("order-1 summaries created", { count: order1Count })

  // Phase 2: Create higher-order summaries recursively
  let higherOrderCreated = 0
  let safety = 10 // Prevent infinite loops
  while (safety-- > 0) {
    const created = await createHigherOrderSummaries(storage, llm, result)
    if (created === 0) break
    higherOrderCreated += created
  }
  log.info("higher-order summaries created", { count: higherOrderCreated })

  // Calculate final state
  result.tokensAfter = await storage.temporal.estimateUncompactedTokens()
  result.tokensCompressed = tokensBefore - result.tokensAfter

  log.info("compaction complete", {
    order1Created: result.order1Created,
    higherOrderCreated: result.higherOrderCreated,
    tokensCompressed: result.tokensCompressed,
    tokensAfter: result.tokensAfter,
  })

  return result
}

/**
 * Create order-1 summaries from uncompacted messages.
 */
async function createOrder1Summaries(
  storage: Storage,
  llm: SummarizationLLM,
  result: CompactionResult,
): Promise<number> {
  const { messages } = await getMessagesToCompact(storage.temporal)

  if (messages.length < 15) {
    log.debug("not enough messages to compact", { count: messages.length })
    return 0
  }

  const groups = groupMessagesForSummary(messages)
  let created = 0

  for (const group of groups) {
    if (group.length < 15) {
      log.debug("skipping small group", { size: group.length })
      continue
    }

    try {
      const output = await llm.summarizeMessages(group)
      const insert = createSummaryInsert({
        order: 1,
        startId: group[0].id,
        endId: group[group.length - 1].id,
        input: output,
      })

      await storage.temporal.createSummary(insert)
      created++
      result.order1Created++
      log.debug("created order-1 summary", {
        startId: insert.startId,
        endId: insert.endId,
        tokens: insert.tokenEstimate,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.warnings.push(`Failed to create order-1 summary: ${msg}`)
      log.error("failed to create order-1 summary", { error: e })
    }
  }

  return created
}

/**
 * Create higher-order summaries from existing summaries.
 */
async function createHigherOrderSummaries(
  storage: Storage,
  llm: SummarizationLLM,
  result: CompactionResult,
): Promise<number> {
  const summaries = await storage.temporal.getSummaries()
  const next = getNextOrderToSummarize(summaries)

  if (!next) {
    log.debug("no higher-order summarization needed")
    return 0
  }

  const groups = groupSummariesForHigherOrder(next.summariesToProcess)
  let created = 0

  for (const group of groups) {
    try {
      const output = await llm.summarizeSummaries(group, next.order)
      const range = calculateHigherOrderRange(group)
      const insert = createSummaryInsert({
        order: next.order,
        startId: range.startId,
        endId: range.endId,
        input: output,
      })

      await storage.temporal.createSummary(insert)
      created++
      result.higherOrderCreated++
      log.debug("created higher-order summary", {
        order: next.order,
        startId: insert.startId,
        endId: insert.endId,
        tokens: insert.tokenEstimate,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      result.warnings.push(`Failed to create order-${next.order} summary: ${msg}`)
      log.error("failed to create higher-order summary", { error: e, order: next.order })
    }
  }

  return created
}

/**
 * Run compaction as a background worker.
 *
 * Creates a worker record, runs compaction, and updates the worker status.
 */
export async function runCompactionWorker(
  storage: Storage,
  llm: SummarizationLLM,
  config: CompactionConfig,
): Promise<CompactionResult> {
  const { Identifier } = await import("../id")

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
    const result = await runCompaction(storage, llm, config)

    // Mark complete
    await storage.workers.complete(workerId)
    return result
  } catch (e) {
    // Mark failed
    const error = e instanceof Error ? e.message : String(e)
    await storage.workers.fail(workerId, error)
    throw e
  }
}
