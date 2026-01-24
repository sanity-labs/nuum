/**
 * Integration tests for temporal memory system.
 *
 * Tests the temporal storage, view construction, and summary handling.
 * The actual compaction agent tests require a real LLM and are in a
 * separate file that checks for ANTHROPIC_API_KEY.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createInMemoryStorage, type Storage } from "../storage"
import { Identifier } from "../id"
import { buildTemporalView, reconstructHistoryAsTurns } from "./index"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"

const TEMPORAL_BUDGET = 8000

describe("Temporal View Construction", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  /**
   * Helper to add messages to storage.
   */
  async function addMessages(count: number, tokensPerMessage: number = 50): Promise<TemporalMessage[]> {
    const messages: TemporalMessage[] = []
    for (let i = 0; i < count; i++) {
      const msg: TemporalMessage = {
        id: Identifier.ascending("message"),
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"x".repeat(tokensPerMessage * 4)}`,
        tokenEstimate: tokensPerMessage,
        createdAt: new Date().toISOString(),
      }
      await storage.temporal.appendMessage(msg)
      messages.push(msg)
    }
    return messages
  }

  /**
   * Helper to create a summary.
   */
  async function createSummary(
    startId: string,
    endId: string,
    orderNum: number = 1,
    tokenEstimate: number = 100,
  ): Promise<TemporalSummary> {
    const summary: TemporalSummary = {
      id: Identifier.ascending("summary"),
      orderNum,
      startId,
      endId,
      narrative: `Summary covering ${startId} to ${endId}`,
      keyObservations: JSON.stringify(["Observation 1", "Observation 2"]),
      tags: JSON.stringify(["tag1"]),
      tokenEstimate,
      createdAt: new Date().toISOString(),
    }
    await storage.temporal.createSummary(summary)
    return summary
  }

  it("builds view with only messages", async () => {
    const messages = await addMessages(10, 50)

    const view = buildTemporalView({
      budget: TEMPORAL_BUDGET,
      messages,
      summaries: [],
    })

    expect(view.messages.length).toBe(10)
    expect(view.summaries.length).toBe(0)
    expect(view.totalTokens).toBe(500) // 10 * 50
  })

  it("builds view with messages and summaries", async () => {
    const messages = await addMessages(20, 50)
    const summaries = await storage.temporal.getSummaries()

    // Create a summary covering first 10 messages
    const summary = await createSummary(messages[0].id, messages[9].id)

    const view = buildTemporalView({
      budget: TEMPORAL_BUDGET,
      messages,
      summaries: [summary],
    })

    // Should include summary and all messages not covered by summary
    expect(view.summaries.length).toBe(1)
    expect(view.messages.length).toBe(10) // Messages 10-19 (not covered by summary)
  })

  it("includes all messages regardless of budget (budget is informational)", async () => {
    const messages = await addMessages(100, 100) // 10,000 tokens total

    const view = buildTemporalView({
      budget: 2000, // Much smaller than total - doesn't matter
      messages,
      summaries: [],
    })

    // All messages included - full history always represented
    expect(view.messages.length).toBe(100)
    expect(view.totalTokens).toBe(10000)
  })

  it("returns messages in chronological order", async () => {
    const messages = await addMessages(50, 50)

    const view = buildTemporalView({
      budget: 500,
      messages,
      summaries: [],
    })

    // All messages included in chronological order
    expect(view.messages.length).toBe(50)

    // Verify chronological order (IDs are ULIDs, so string comparison works)
    for (let i = 1; i < view.messages.length; i++) {
      expect(view.messages[i].id > view.messages[i - 1].id).toBe(true)
    }
  })

  it("skips messages covered by summaries", async () => {
    const messages = await addMessages(20, 50)

    // Create summary covering first 10 messages
    const summary = await createSummary(messages[0].id, messages[9].id)

    const view = buildTemporalView({
      budget: TEMPORAL_BUDGET,
      messages,
      summaries: [summary],
    })

    // Messages 0-9 should not be in view.messages (they're summarized)
    const viewMessageIds = new Set(view.messages.map(m => m.id))
    for (let i = 0; i < 10; i++) {
      expect(viewMessageIds.has(messages[i].id)).toBe(false)
    }
  })

  it("handles higher-order summaries correctly", async () => {
    const messages = await addMessages(30, 30)

    // Create order-1 summaries
    const sum1 = await createSummary(messages[0].id, messages[9].id, 1, 50)
    const sum2 = await createSummary(messages[10].id, messages[19].id, 1, 50)

    // Create order-2 summary that subsumes both
    const sum3 = await createSummary(messages[0].id, messages[19].id, 2, 75)

    const view = buildTemporalView({
      budget: TEMPORAL_BUDGET,
      messages,
      summaries: [sum1, sum2, sum3],
    })

    // Should include the order-2 summary, not the order-1s
    expect(view.summaries.some(s => s.orderNum === 2)).toBe(true)
    // The order-1 summaries should be excluded as they're subsumed
    const nonSubsumed = view.summaries.filter(s => s.orderNum === 1)
    expect(nonSubsumed.length).toBe(0)
  })
})

describe("Temporal View Turn Reconstruction", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("reconstructs simple user/assistant turns with IDs", async () => {
    const userId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: userId,
      type: "user",
      content: "Hello there",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const assistantId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: assistantId,
      type: "assistant",
      content: "Hi! How can I help?",
      tokenEstimate: 15,
      createdAt: new Date().toISOString(),
    })

    const messages = await storage.temporal.getMessages()
    const view = buildTemporalView({
      budget: 1000,
      messages,
      summaries: [],
    })

    const turns = reconstructHistoryAsTurns(view)

    expect(turns.length).toBe(2)
    expect(turns[0].role).toBe("user")
    expect(turns[0].content).toContain(`[id:${userId}]`)
    expect(turns[0].content).toContain("Hello there")
    expect(turns[1].role).toBe("assistant")
    expect(turns[1].content).toContain(`[id:${assistantId}]`)
    expect(turns[1].content).toContain("Hi! How can I help?")
  })

  it("reconstructs summaries with from/to IDs", async () => {
    // Add messages
    const msg1Id = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: msg1Id,
      type: "user",
      content: "First message",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const msg2Id = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: msg2Id,
      type: "assistant",
      content: "First response",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    // Add summary
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msg1Id,
      endId: msg2Id,
      narrative: "Earlier discussion about setup",
      keyObservations: JSON.stringify(["Key fact 1"]),
      tags: JSON.stringify([]),
      tokenEstimate: 30,
      createdAt: new Date().toISOString(),
    })

    // Add more recent messages
    const msg3Id = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: msg3Id,
      type: "user",
      content: "Later message",
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

    const turns = reconstructHistoryAsTurns(view)

    // Should have: summary (assistant), then recent message
    const summaryTurn = turns.find(t =>
      t.role === "assistant" &&
      typeof t.content === "string" &&
      t.content.includes("[distilled from:")
    )
    expect(summaryTurn).toBeDefined()
    expect(summaryTurn!.content).toContain(`from:${msg1Id}`)
    expect(summaryTurn!.content).toContain(`to:${msg2Id}`)
  })

  it("handles tool call sequences", async () => {
    const assistantId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: assistantId,
      type: "assistant",
      content: "Let me check that file",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const toolCallId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: toolCallId,
      type: "tool_call",
      content: JSON.stringify({ name: "read_file", args: { path: "test.ts" }, toolCallId: "call_1" }),
      tokenEstimate: 20,
      createdAt: new Date().toISOString(),
    })

    const toolResultId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: toolResultId,
      type: "tool_result",
      content: "// File contents here",
      tokenEstimate: 30,
      createdAt: new Date().toISOString(),
    })

    const messages = await storage.temporal.getMessages()
    const view = buildTemporalView({
      budget: 1000,
      messages,
      summaries: [],
    })

    const turns = reconstructHistoryAsTurns(view)

    // Should have assistant turn with tool call, then tool result turn
    expect(turns.length).toBe(2)
    expect(turns[0].role).toBe("assistant")
    expect(turns[1].role).toBe("tool")
  })
})

describe("Summary Storage Operations", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("creates and retrieves summaries", async () => {
    const summaryId = Identifier.ascending("summary")
    await storage.temporal.createSummary({
      id: summaryId,
      orderNum: 1,
      startId: "msg_start",
      endId: "msg_end",
      narrative: "Test narrative",
      keyObservations: JSON.stringify(["obs1", "obs2"]),
      tags: JSON.stringify(["tag1"]),
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const summaries = await storage.temporal.getSummaries()
    expect(summaries.length).toBe(1)
    expect(summaries[0].id).toBe(summaryId)
    expect(summaries[0].narrative).toBe("Test narrative")
  })

  it("gets summaries by order", async () => {
    // Create order-1 summaries
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: "a",
      endId: "b",
      narrative: "First order 1",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: "c",
      endId: "d",
      narrative: "Second order 1",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    // Create order-2 summary
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 2,
      startId: "a",
      endId: "d",
      narrative: "Order 2",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 75,
      createdAt: new Date().toISOString(),
    })

    const order1 = await storage.temporal.getSummaries(1)
    const order2 = await storage.temporal.getSummaries(2)

    expect(order1.length).toBe(2)
    expect(order2.length).toBe(1)
  })

  it("gets highest order summaries (non-subsumed)", async () => {
    // Create structure where order-2 subsumes two order-1s
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: "a",
      endId: "b",
      narrative: "First",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: "c",
      endId: "d",
      narrative: "Second",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 2,
      startId: "a",
      endId: "d",
      narrative: "Combined",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 75,
      createdAt: new Date().toISOString(),
    })

    const highest = await storage.temporal.getHighestOrderSummaries()

    // Should only return the order-2 summary
    expect(highest.length).toBe(1)
    expect(highest[0].orderNum).toBe(2)
  })
})
