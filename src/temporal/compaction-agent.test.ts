/**
 * Tests for the agentic compaction system.
 *
 * Note: The compaction agent requires a real LLM, so these tests are
 * primarily structural tests and integration tests that mock at a higher level.
 *
 * For full integration testing, use the integration.test.ts file with
 * ANTHROPIC_API_KEY set.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createInMemoryStorage, type Storage } from "../storage"
import { Identifier } from "../id"
import type { TemporalMessage } from "../storage/schema"
import type { CompactionConfig, CompactionResult } from "./compaction-agent"

describe("CompactionResult interface", () => {
  it("has the expected shape", () => {
    const result: CompactionResult = {
      summariesCreated: 5,
      tokensBefore: 10000,
      tokensAfter: 5000,
      turnsUsed: 2,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
      },
    }

    expect(result.summariesCreated).toBe(5)
    expect(result.tokensBefore).toBe(10000)
    expect(result.tokensAfter).toBe(5000)
    expect(result.turnsUsed).toBe(2)
    expect(result.usage.inputTokens).toBe(1000)
    expect(result.usage.outputTokens).toBe(500)
  })
})

describe("CompactionConfig interface", () => {
  it("has the expected shape", () => {
    const config: CompactionConfig = {
      compactionThreshold: 16000,
      compactionTarget: 8000,
    }

    expect(config.compactionThreshold).toBe(16000)
    expect(config.compactionTarget).toBe(8000)
  })
})

describe("temporal storage for compaction", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
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

  it("estimates uncompacted tokens correctly", async () => {
    await addMessages(20, 50)

    const tokens = await storage.temporal.estimateUncompactedTokens()
    expect(tokens).toBe(1000) // 20 * 50
  })

  it("tracks summaries correctly", async () => {
    const msgs = await addMessages(10, 50)

    // Create a summary
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msgs[0].id,
      endId: msgs[4].id,
      narrative: "Test summary",
      keyObservations: JSON.stringify(["Observation 1"]),
      tags: JSON.stringify(["test"]),
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const summaries = await storage.temporal.getSummaries()
    expect(summaries).toHaveLength(1)
    expect(summaries[0].orderNum).toBe(1)
    expect(summaries[0].startId).toBe(msgs[0].id)
    expect(summaries[0].endId).toBe(msgs[4].id)
  })

  it("calculates highest order summaries correctly", async () => {
    const msgs = await addMessages(20, 50)

    // Create two order-1 summaries
    const summary1Id = Identifier.ascending("summary")
    await storage.temporal.createSummary({
      id: summary1Id,
      orderNum: 1,
      startId: msgs[0].id,
      endId: msgs[4].id,
      narrative: "Summary 1",
      keyObservations: JSON.stringify([]),
      tags: JSON.stringify([]),
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const summary2Id = Identifier.ascending("summary")
    await storage.temporal.createSummary({
      id: summary2Id,
      orderNum: 1,
      startId: msgs[5].id,
      endId: msgs[9].id,
      narrative: "Summary 2",
      keyObservations: JSON.stringify([]),
      tags: JSON.stringify([]),
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    // Create order-2 summary that subsumes both
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 2,
      startId: msgs[0].id,
      endId: msgs[9].id,
      narrative: "Higher order summary",
      keyObservations: JSON.stringify([]),
      tags: JSON.stringify([]),
      tokenEstimate: 150,
      createdAt: new Date().toISOString(),
    })

    const highest = await storage.temporal.getHighestOrderSummaries()
    // Should only return the order-2 summary since it subsumes the order-1s
    expect(highest).toHaveLength(1)
    expect(highest[0].orderNum).toBe(2)
  })

  it("gets last summary end id correctly", async () => {
    const msgs = await addMessages(10, 50)

    // Initially no summaries
    const noEndId = await storage.temporal.getLastSummaryEndId()
    expect(noEndId).toBeNull()

    // Add a summary
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msgs[0].id,
      endId: msgs[4].id,
      narrative: "Test",
      keyObservations: JSON.stringify([]),
      tags: JSON.stringify([]),
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const endId = await storage.temporal.getLastSummaryEndId()
    expect(endId).toBe(msgs[4].id)
  })
})

describe("view reconstruction with IDs", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("includes message IDs in reconstructed turns", async () => {
    // Add a message
    const msgId = Identifier.ascending("message")
    await storage.temporal.appendMessage({
      id: msgId,
      type: "user",
      content: "Hello world",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    // Import the view functions
    const { buildTemporalView, reconstructHistoryAsTurns } = await import("./view")
    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    const view = buildTemporalView({
      budget: 10000,
      messages,
      summaries,
    })

    const turns = reconstructHistoryAsTurns(view)

    // Should have one user turn with the ID prefix
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe("user")
    expect(turns[0].content).toContain(`[id:${msgId}]`)
    expect(turns[0].content).toContain("Hello world")
  })

  it("includes summary ranges in reconstructed turns", async () => {
    // Add messages
    const msgs: TemporalMessage[] = []
    for (let i = 0; i < 5; i++) {
      const msg: TemporalMessage = {
        id: Identifier.ascending("message"),
        type: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      }
      await storage.temporal.appendMessage(msg)
      msgs.push(msg)
    }

    // Add a summary
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msgs[0].id,
      endId: msgs[2].id,
      narrative: "Earlier conversation happened",
      keyObservations: JSON.stringify(["Key point"]),
      tags: JSON.stringify([]),
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    const { buildTemporalView, reconstructHistoryAsTurns } = await import("./view")
    const messages = await storage.temporal.getMessages()
    const summaries = await storage.temporal.getSummaries()

    const view = buildTemporalView({
      budget: 10000,
      messages,
      summaries,
    })

    const turns = reconstructHistoryAsTurns(view)

    // Should have summary turn with from/to IDs (summaries are assistant messages)
    const summaryTurn = turns.find(t =>
      t.role === "assistant" &&
      typeof t.content === "string" &&
      t.content.includes("[distilled from:")
    )
    expect(summaryTurn).toBeDefined()
    expect(summaryTurn!.content).toContain(`from:${msgs[0].id}`)
    expect(summaryTurn!.content).toContain(`to:${msgs[2].id}`)
  })
})
