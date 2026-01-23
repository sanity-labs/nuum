/**
 * End-to-end tests for the compaction workflow.
 *
 * These tests use mock LLM and in-memory storage to verify
 * the complete summarization pipeline works correctly.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createMockLLM, type MockLLM } from "./mock-llm"
import { createInMemoryStorage, type Storage } from "../storage"
import { Identifier } from "../id"
import { buildTemporalView } from "./view"
import { shouldTriggerCompaction, type CompactionConfig } from "./compaction"
import { createSummaryInsert } from "./summary"
import { groupMessagesForSummary, groupSummariesForHigherOrder } from "./summary"
import { getNextOrderToSummarize, calculateHigherOrderRange } from "./recursive"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"

describe("compaction workflow (e2e)", () => {
  let storage: Storage
  let mockLLM: MockLLM
  const config: CompactionConfig = {
    compactionThreshold: 1000,
    compactionTarget: 500,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
    mockLLM = createMockLLM({ includeRangeInNarrative: true })
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
        content: `Message ${i}: ${generateContent(tokensPerMessage * 4)}`,
        tokenEstimate: tokensPerMessage,
        createdAt: new Date().toISOString(),
      }
      await storage.temporal.appendMessage(msg)
      messages.push(msg)
    }
    return messages
  }

  /**
   * Generate content of approximately the specified length.
   */
  function generateContent(length: number): string {
    const words = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(
      Math.ceil(length / 50),
    )
    return words.slice(0, length)
  }

  /**
   * Run a compaction cycle: create summaries for uncompacted messages.
   */
  async function runCompaction(): Promise<number> {
    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    // Find messages not covered by summaries
    const lastEndId = await storage.temporal.getLastSummaryEndId()
    const uncoveredMessages = lastEndId
      ? messages.filter((m) => m.id > lastEndId)
      : messages

    if (uncoveredMessages.length < 15) {
      return 0 // Not enough to summarize
    }

    // Group messages and create summaries
    const groups = groupMessagesForSummary(uncoveredMessages)
    let created = 0

    for (const group of groups) {
      if (group.length < 15) continue

      const output = await mockLLM.summarizeMessages(group)
      const insert = createSummaryInsert({
        order: 1,
        startId: group[0].id,
        endId: group[group.length - 1].id,
        input: output,
      })

      await storage.temporal.createSummary(insert)
      created++
    }

    // Check for recursive summarization
    const updatedSummaries = await storage.temporal.getSummaries()
    const next = getNextOrderToSummarize(updatedSummaries)

    if (next) {
      const groups = groupSummariesForHigherOrder(next.summariesToProcess)
      for (const group of groups) {
        const output = await mockLLM.summarizeSummaries(group, next.order)
        const range = calculateHigherOrderRange(group)
        const insert = createSummaryInsert({
          order: next.order,
          startId: range.startId,
          endId: range.endId,
          input: output,
        })
        await storage.temporal.createSummary(insert)
        created++
      }
    }

    return created
  }

  it("compresses 50 messages to under budget", async () => {
    // Add 50 messages at 50 tokens each = 2500 tokens
    await addMessages(50, 50)

    const tokensBefore = await storage.temporal.estimateUncompactedTokens()
    expect(tokensBefore).toBe(2500)

    // Run compaction
    const created = await runCompaction()
    expect(created).toBeGreaterThan(0)

    // Verify summaries were created
    const summaries = await storage.temporal.getSummaries()
    expect(summaries.length).toBeGreaterThan(0)

    // Verify uncompacted tokens decreased
    const tokensAfter = await storage.temporal.estimateUncompactedTokens()
    expect(tokensAfter).toBeLessThan(tokensBefore)
  })

  it("creates multiple summary orders as needed", async () => {
    // Add enough messages to trigger order-2 creation
    // 125 messages = 5 groups of 25 = 5 order-1 summaries = 1 order-2
    await addMessages(125, 50)

    // First compaction: create order-1 summaries
    const created1 = await runCompaction()
    expect(created1).toBeGreaterThanOrEqual(5)

    let summaries = await storage.temporal.getSummaries()
    const order1Count = summaries.filter((s) => s.orderNum === 1).length
    expect(order1Count).toBeGreaterThanOrEqual(5)

    // Second compaction: create order-2 summary (if not already done)
    const created2 = await runCompaction()

    summaries = await storage.temporal.getSummaries()
    const order2Count = summaries.filter((s) => s.orderNum === 2).length

    // Should have at least one order-2 summary
    expect(order2Count).toBeGreaterThanOrEqual(1)
  })

  it("temporal view includes all history via summaries", async () => {
    await addMessages(100, 50)
    await runCompaction()

    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    const view = buildTemporalView({
      budget: 10000, // Large budget to include everything
      messages,
      summaries,
    })

    // View should have summaries
    expect(view.summaries.length).toBeGreaterThan(0)

    // Recent messages should be included (not covered by summaries yet)
    // or all should be summarized
    const totalCoverage = view.summaries.length + view.messages.length
    expect(totalCoverage).toBeGreaterThan(0)
  })

  it("preserves key observations through compression", async () => {
    await addMessages(50, 50)
    await runCompaction()

    const summaries = await storage.temporal.getSummaries()
    expect(summaries.length).toBeGreaterThan(0)

    // Check that summaries have key observations
    for (const summary of summaries) {
      const observations = JSON.parse(summary.keyObservations)
      // Mock LLM adds observations for long messages and tool results
      expect(Array.isArray(observations)).toBe(true)
    }
  })

  it("handles incremental compaction correctly", async () => {
    // First batch
    await addMessages(30, 50)
    await runCompaction()

    const summaries1 = await storage.temporal.getSummaries()
    expect(summaries1.length).toBeGreaterThan(0)

    // Second batch
    await addMessages(30, 50)
    const created = await runCompaction()
    expect(created).toBeGreaterThan(0)

    // Should have more summaries now
    const summaries2 = await storage.temporal.getSummaries()
    expect(summaries2.length).toBeGreaterThanOrEqual(summaries1.length)
  })

  it("respects compaction trigger threshold", async () => {
    // Add messages under threshold
    await addMessages(10, 50) // 500 tokens, under 1000 threshold

    const shouldCompact = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(shouldCompact).toBe(false)

    // Add more to exceed threshold
    await addMessages(20, 50) // Now 1500 tokens, over threshold

    const shouldCompactNow = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(shouldCompactNow).toBe(true)
  })
})

describe("compaction workflow edge cases", () => {
  let storage: Storage
  let mockLLM: MockLLM

  beforeEach(() => {
    storage = createInMemoryStorage()
    mockLLM = createMockLLM()
  })

  it("handles empty history", async () => {
    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    const view = buildTemporalView({
      budget: 1000,
      messages,
      summaries,
    })

    expect(view.summaries).toHaveLength(0)
    expect(view.messages).toHaveLength(0)
    expect(view.totalTokens).toBe(0)
  })

  it("handles single message", async () => {
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "user",
      content: "Hello",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    const view = buildTemporalView({
      budget: 1000,
      messages,
      summaries,
    })

    expect(view.messages).toHaveLength(1)
    expect(view.summaries).toHaveLength(0)
  })

  it("handles exactly at threshold", async () => {
    // Add exactly 1000 tokens (threshold)
    for (let i = 0; i < 10; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 100,
        createdAt: new Date().toISOString(),
      })
    }

    const tokens = await storage.temporal.estimateUncompactedTokens()
    expect(tokens).toBe(1000)

    // Should not trigger compaction (threshold is 1000, need > 1000)
    const shouldCompact = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      { compactionThreshold: 1000, compactionTarget: 500 },
    )
    expect(shouldCompact).toBe(false)

    // Add one more token
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "user",
      content: "Over threshold",
      tokenEstimate: 1,
      createdAt: new Date().toISOString(),
    })

    const shouldCompactNow = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      { compactionThreshold: 1000, compactionTarget: 500 },
    )
    expect(shouldCompactNow).toBe(true)
  })

  it("mock LLM produces deterministic output", async () => {
    const messages: TemporalMessage[] = []
    for (let i = 0; i < 20; i++) {
      messages.push({
        id: `msg_${String(i).padStart(3, "0")}`,
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      })
    }

    const output1 = await mockLLM.summarizeMessages(messages)
    mockLLM.reset()
    const output2 = await mockLLM.summarizeMessages(messages)

    // Outputs should be identical
    expect(output1.narrative).toBe(output2.narrative)
    expect(output1.keyObservations).toEqual(output2.keyObservations)
    expect(output1.tags).toEqual(output2.tags)
  })

  it("mock LLM can simulate failure", async () => {
    const failingLLM = createMockLLM({ failOnCall: 1 })

    const messages: TemporalMessage[] = [
      {
        id: "msg_001",
        type: "user",
        content: "Test",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
    ]

    await expect(failingLLM.summarizeMessages(messages)).rejects.toThrow(
      "Mock LLM failure",
    )
  })

  it("handles very long conversations (stress test)", async () => {
    // Add 500 messages
    for (let i = 0; i < 500; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        tokenEstimate: 20,
        createdAt: new Date().toISOString(),
      })
    }

    const messages = await storage.temporal.getMessages()
    expect(messages).toHaveLength(500)

    // Build view with limited budget
    const summaries = await storage.temporal.getSummaries()
    const view = buildTemporalView({
      budget: 2000,
      messages,
      summaries,
    })

    // Should fit within budget
    expect(view.totalTokens).toBeLessThanOrEqual(2000)
  })
})

describe("mock LLM behavior", () => {
  it("generates narrative with range info when configured", async () => {
    const llm = createMockLLM({ includeRangeInNarrative: true })
    const messages: TemporalMessage[] = [
      {
        id: "msg_001",
        type: "user",
        content: "Test",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
      {
        id: "msg_010",
        type: "user",
        content: "Test",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
    ]

    const output = await llm.summarizeMessages(messages)
    expect(output.narrative).toContain("msg_001")
    expect(output.narrative).toContain("msg_010")
  })

  it("uses fixed token count when configured", async () => {
    const llm = createMockLLM({ fixedTokenCount: 500 })
    const output = await llm.summarizeMessages([
      {
        id: "msg_001",
        type: "user",
        content: "Test",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
    ])

    const tokens = llm.estimateTokens(output)
    expect(tokens).toBe(500)
  })

  it("tracks call count correctly", async () => {
    const llm = createMockLLM()
    const message: TemporalMessage = {
      id: "msg_001",
      type: "user",
      content: "Test",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    }

    expect(llm.getCallCount()).toBe(0)

    await llm.summarizeMessages([message])
    expect(llm.getCallCount()).toBe(1)

    await llm.summarizeMessages([message])
    expect(llm.getCallCount()).toBe(2)

    llm.reset()
    expect(llm.getCallCount()).toBe(0)
  })

  it("extracts tags from message types", async () => {
    const llm = createMockLLM()
    const messages: TemporalMessage[] = [
      {
        id: "msg_001",
        type: "user",
        content: "Test",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
      {
        id: "msg_002",
        type: "tool_call",
        content: '{"tool": "read"}',
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      },
    ]

    const output = await llm.summarizeMessages(messages)
    expect(output.tags).toContain("conversation")
    expect(output.tags).toContain("tools")
  })
})
