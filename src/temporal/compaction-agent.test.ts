/**
 * Tests for the compaction agent.
 *
 * Uses mock LLM to verify the compaction workflow without API calls.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { runCompaction, runCompactionWorker, type SummarizationLLM } from "./compaction-agent"
import { createMockLLM } from "./mock-llm"
import { createInMemoryStorage, type Storage } from "../storage"
import { Identifier } from "../id"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"
import type { CompactionConfig } from "./compaction"

// Adapter to make mock LLM compatible with SummarizationLLM interface
function createMockSummarizationLLM(): SummarizationLLM {
  const mock = createMockLLM({ includeRangeInNarrative: true })
  return {
    summarizeMessages: mock.summarizeMessages.bind(mock),
    summarizeSummaries: mock.summarizeSummaries.bind(mock),
  }
}

describe("runCompaction", () => {
  let storage: Storage
  let llm: SummarizationLLM
  const config: CompactionConfig = {
    compactionThreshold: 1000,
    compactionTarget: 500,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
    llm = createMockSummarizationLLM()
  })

  /**
   * Helper to add test messages to storage.
   */
  async function addMessages(count: number, tokensPerMessage: number = 50): Promise<TemporalMessage[]> {
    const messages: TemporalMessage[] = []
    for (let i = 0; i < count; i++) {
      const msg: TemporalMessage = {
        id: Identifier.ascending("message"),
        type: i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool_result",
        content: `Message ${i}: ${"x".repeat(tokensPerMessage * 4)}`,
        tokenEstimate: tokensPerMessage,
        createdAt: new Date().toISOString(),
      }
      await storage.temporal.appendMessage(msg)
      messages.push(msg)
    }
    return messages
  }

  it("creates order-1 summaries from messages", async () => {
    // Add 30 messages (enough for at least 1 summary)
    await addMessages(30, 50)

    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBeGreaterThan(0)
    expect(result.warnings).toHaveLength(0)

    // Verify summaries were created in storage
    const summaries = await storage.temporal.getSummaries()
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.every((s) => s.orderNum === 1)).toBe(true)
  })

  it("does not create summaries for small message counts", async () => {
    // Add only 10 messages (below minimum of 15)
    await addMessages(10, 50)

    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBe(0)
    expect(result.higherOrderCreated).toBe(0)

    const summaries = await storage.temporal.getSummaries()
    expect(summaries).toHaveLength(0)
  })

  it("creates multiple order-1 summaries for large message counts", async () => {
    // Add 75 messages (should create 3 summaries of ~25 each)
    await addMessages(75, 50)

    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBe(3)

    const summaries = await storage.temporal.getSummaries()
    expect(summaries).toHaveLength(3)
  })

  it("creates higher-order summaries when enough order-1 exist", async () => {
    // Add 125 messages (5 groups of 25 = 5 order-1 summaries = 1 order-2)
    await addMessages(125, 50)

    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBe(5)
    expect(result.higherOrderCreated).toBeGreaterThanOrEqual(1)

    const summaries = await storage.temporal.getSummaries()
    const order1 = summaries.filter((s) => s.orderNum === 1)
    const order2 = summaries.filter((s) => s.orderNum === 2)

    expect(order1.length).toBe(5)
    expect(order2.length).toBeGreaterThanOrEqual(1)
  })

  it("reports correct token compression", async () => {
    await addMessages(50, 50)

    const tokensBefore = await storage.temporal.estimateUncompactedTokens()
    expect(tokensBefore).toBe(2500) // 50 * 50

    const result = await runCompaction(storage, llm, config)

    expect(result.tokensCompressed).toBeGreaterThan(0)
    expect(result.tokensAfter).toBeLessThan(tokensBefore)
    expect(result.tokensCompressed + result.tokensAfter).toBe(tokensBefore)
  })

  it("handles empty message history", async () => {
    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBe(0)
    expect(result.higherOrderCreated).toBe(0)
    expect(result.tokensCompressed).toBe(0)
    expect(result.tokensAfter).toBe(0)
  })

  it("handles incremental compaction", async () => {
    // First batch
    await addMessages(30, 50)
    await runCompaction(storage, llm, config)

    const summaries1 = await storage.temporal.getSummaries()
    expect(summaries1.length).toBeGreaterThan(0)

    // Second batch
    await addMessages(30, 50)
    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBeGreaterThan(0)

    const summaries2 = await storage.temporal.getSummaries()
    expect(summaries2.length).toBeGreaterThan(summaries1.length)
  })

  it("preserves summary ULID ordering", async () => {
    await addMessages(75, 50)
    await runCompaction(storage, llm, config)

    const summaries = await storage.temporal.getSummaries()

    // All summaries should have valid ranges
    for (const summary of summaries) {
      expect(summary.startId <= summary.endId).toBe(true)
    }

    // Adjacent order-1 summaries should not overlap
    const order1 = summaries
      .filter((s) => s.orderNum === 1)
      .sort((a, b) => a.startId.localeCompare(b.startId))

    for (let i = 1; i < order1.length; i++) {
      expect(order1[i].startId > order1[i - 1].endId).toBe(true)
    }
  })
})

describe("runCompactionWorker", () => {
  let storage: Storage
  let llm: SummarizationLLM
  const config: CompactionConfig = {
    compactionThreshold: 1000,
    compactionTarget: 500,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
    llm = createMockSummarizationLLM()
  })

  async function addMessages(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 50,
        createdAt: new Date().toISOString(),
      })
    }
  }

  it("creates and completes worker record", async () => {
    await addMessages(30)

    await runCompactionWorker(storage, llm, config)

    const workers = await storage.workers.getAll()
    const compactionWorkers = workers.filter((w) => w.type === "temporal-compact")

    expect(compactionWorkers).toHaveLength(1)
    expect(compactionWorkers[0].status).toBe("completed")
    expect(compactionWorkers[0].completedAt).not.toBeNull()
  })

  it("records warnings for LLM failures but completes", async () => {
    await addMessages(30)

    // Create a failing LLM
    const failingLLM: SummarizationLLM = {
      summarizeMessages: async () => {
        throw new Error("LLM failure")
      },
      summarizeSummaries: async () => {
        throw new Error("LLM failure")
      },
    }

    // Compaction completes but with warnings
    const result = await runCompactionWorker(storage, failingLLM, config)

    expect(result.order1Created).toBe(0) // Failed to create any
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain("LLM failure")

    const workers = await storage.workers.getAll()
    const compactionWorkers = workers.filter((w) => w.type === "temporal-compact")

    expect(compactionWorkers).toHaveLength(1)
    expect(compactionWorkers[0].status).toBe("completed") // Still completes
  })

  it("creates unique worker for each compaction run", async () => {
    await addMessages(30)

    // Run first compaction
    await runCompactionWorker(storage, llm, config)

    // Add more messages
    await addMessages(30)

    // Run second compaction
    await runCompactionWorker(storage, llm, config)

    // Should have two worker records
    const workers = await storage.workers.getAll()
    const compactionWorkers = workers.filter((w) => w.type === "temporal-compact")

    expect(compactionWorkers).toHaveLength(2)
    expect(compactionWorkers[0].id).not.toBe(compactionWorkers[1].id)
    expect(compactionWorkers.every((w) => w.status === "completed")).toBe(true)
  })
})

describe("compaction with complex scenarios", () => {
  let storage: Storage
  let llm: SummarizationLLM
  const config: CompactionConfig = {
    compactionThreshold: 500,
    compactionTarget: 250,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
    llm = createMockSummarizationLLM()
  })

  it("handles mixed message types correctly", async () => {
    // Add messages with different types
    const types: TemporalMessage["type"][] = ["user", "assistant", "tool_call", "tool_result", "system"]
    for (let i = 0; i < 25; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: types[i % types.length],
        content: `Message ${i}`,
        tokenEstimate: 50,
        createdAt: new Date().toISOString(),
      })
    }

    const result = await runCompaction(storage, llm, config)

    expect(result.order1Created).toBeGreaterThan(0)

    // Summary should have tags indicating different types
    const summaries = await storage.temporal.getSummaries()
    expect(summaries.length).toBeGreaterThan(0)
  })

  it("handles very large conversation", async () => {
    // Add 300 messages
    for (let i = 0; i < 300; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        tokenEstimate: 20,
        createdAt: new Date().toISOString(),
      })
    }

    const result = await runCompaction(storage, llm, config)

    // Should create multiple levels of summarization
    expect(result.order1Created).toBeGreaterThan(5)

    const summaries = await storage.temporal.getSummaries()
    const maxOrder = Math.max(...summaries.map((s) => s.orderNum))

    // With 300 messages, we should get at least order-2
    expect(maxOrder).toBeGreaterThanOrEqual(2)
  })

  it("respects compression targets", async () => {
    // Add 50 messages at 50 tokens each = 2500 tokens
    for (let i = 0; i < 50; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 50,
        createdAt: new Date().toISOString(),
      })
    }

    await runCompaction(storage, llm, config)

    const summaries = await storage.temporal.getSummaries()
    const order1 = summaries.filter((s) => s.orderNum === 1)

    // Each order-1 summary should cover 15-25 messages
    // With 50 messages, we should have 2 summaries
    expect(order1.length).toBe(2)
  })
})
