/**
 * Tests for compaction trigger and scheduling logic.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import {
  shouldTriggerCompaction,
  getCompactionState,
  calculateCompactionTarget,
  getMessagesToCompact,
  shouldCreateOrder2Summary,
  shouldCreateHigherOrderSummary,
  COMPRESSION_TARGETS,
  FIXED_OVERHEAD_TOKENS,
  type CompactionConfig,
} from "./compaction"
import { createInMemoryStorage, type Storage } from "../storage"
import { Identifier } from "../id"

describe("shouldTriggerCompaction", () => {
  let storage: Storage
  // Thresholds account for FIXED_OVERHEAD_TOKENS added by getEffectiveViewTokens
  const config: CompactionConfig = {
    compactionThreshold: FIXED_OVERHEAD_TOKENS + 1000,
    compactionTarget: FIXED_OVERHEAD_TOKENS + 500,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("returns false when under threshold", async () => {
    // Add some messages under the threshold
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "user",
      content: "Hello",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const result = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(result).toBe(false)
  })

  it("returns true when over threshold", async () => {
    // Add messages to exceed threshold
    for (let i = 0; i < 20; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 100, // 20 * 100 = 2000 > 1000 threshold
        createdAt: new Date().toISOString(),
      })
    }

    const result = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(result).toBe(true)
  })

  it("returns false when compaction already running — no double-trigger", async () => {
    // Add messages to exceed threshold
    for (let i = 0; i < 20; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 100,
        createdAt: new Date().toISOString(),
      })
    }

    // Mark compaction as running
    await storage.workers.create({
      id: Identifier.ascending("worker"),
      type: "temporal-compact",
      status: "running",
      startedAt: new Date().toISOString(),
    })

    const result = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(result).toBe(false)
  })

  it("returns true after previous compaction completes", async () => {
    // Add messages to exceed threshold
    for (let i = 0; i < 20; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 100,
        createdAt: new Date().toISOString(),
      })
    }

    // Mark previous compaction as completed
    const workerId = Identifier.ascending("worker")
    await storage.workers.create({
      id: workerId,
      type: "temporal-compact",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })

    const result = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      config,
    )
    expect(result).toBe(true)
  })
})

describe("getCompactionState", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("returns isRunning false when no workers", async () => {
    const state = await getCompactionState(storage.workers)
    expect(state.isRunning).toBe(false)
    expect(state.workerId).toBeUndefined()
  })

  it("returns isRunning true with workerId when compaction running", async () => {
    const workerId = Identifier.ascending("worker")
    await storage.workers.create({
      id: workerId,
      type: "temporal-compact",
      status: "running",
      startedAt: new Date().toISOString(),
    })

    const state = await getCompactionState(storage.workers)
    expect(state.isRunning).toBe(true)
    expect(state.workerId).toBe(workerId)
  })

  it("returns isRunning false for completed workers", async () => {
    await storage.workers.create({
      id: Identifier.ascending("worker"),
      type: "temporal-compact",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    })

    const state = await getCompactionState(storage.workers)
    expect(state.isRunning).toBe(false)
  })
})

describe("calculateCompactionTarget", () => {
  let storage: Storage
  // Thresholds account for FIXED_OVERHEAD_TOKENS added by getEffectiveViewTokens
  const config: CompactionConfig = {
    compactionThreshold: FIXED_OVERHEAD_TOKENS + 1000,
    compactionTarget: FIXED_OVERHEAD_TOKENS + 500,
  }

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("returns 0 when uncompacted tokens are under target", async () => {
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "user",
      content: "Hello",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    const target = await calculateCompactionTarget(storage.temporal, config)
    expect(target).toBe(0)
  })

  it("returns difference when over target", async () => {
    // Add 800 tokens worth of messages
    for (let i = 0; i < 8; i++) {
      await storage.temporal.appendMessage({
        id: Identifier.ascending("message"),
        type: "user",
        content: `Message ${i}`,
        tokenEstimate: 100,
        createdAt: new Date().toISOString(),
      })
    }

    const target = await calculateCompactionTarget(storage.temporal, config)
    // 800 - 500 = 300 tokens need to be compressed
    expect(target).toBe(300)
  })
})

describe("getMessagesToCompact", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("returns all messages when no summaries exist", async () => {
    const msg1 = Identifier.ascending("message")
    const msg2 = Identifier.ascending("message")

    await storage.temporal.appendMessage({
      id: msg1,
      type: "user",
      content: "Hello",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })
    await storage.temporal.appendMessage({
      id: msg2,
      type: "assistant",
      content: "Hi",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const { messages, fromId } = await getMessagesToCompact(storage.temporal)
    expect(messages).toHaveLength(2)
    expect(fromId).toBeNull()
  })

  it("returns only messages after last summary", async () => {
    // Create messages
    const msg1 = Identifier.ascending("message")
    const msg2 = Identifier.ascending("message")
    const msg3 = Identifier.ascending("message")

    await storage.temporal.appendMessage({
      id: msg1,
      type: "user",
      content: "First",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })
    await storage.temporal.appendMessage({
      id: msg2,
      type: "assistant",
      content: "Second",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    // Create a summary covering first two messages
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msg1,
      endId: msg2,
      narrative: "Summary of first two messages",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    // Add another message
    await storage.temporal.appendMessage({
      id: msg3,
      type: "user",
      content: "Third",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const { messages, fromId } = await getMessagesToCompact(storage.temporal)
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(msg3)
    expect(fromId).toBe(msg2)
  })

  it("excludes the boundary message that was already summarized", async () => {
    const msg1 = Identifier.ascending("message")
    const msg2 = Identifier.ascending("message")

    await storage.temporal.appendMessage({
      id: msg1,
      type: "user",
      content: "First",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msg1,
      endId: msg1,
      narrative: "Summary",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.appendMessage({
      id: msg2,
      type: "user",
      content: "Second",
      tokenEstimate: 10,
      createdAt: new Date().toISOString(),
    })

    const { messages } = await getMessagesToCompact(storage.temporal)
    // Should only include msg2, not msg1 (which is the boundary)
    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe(msg2)
  })
})

describe("shouldCreateOrder2Summary", () => {
  it("returns false when fewer than 4 order-1 summaries", () => {
    const summaries = [
      { id: "sum_001", orderNum: 1 },
      { id: "sum_002", orderNum: 1 },
      { id: "sum_003", orderNum: 1 },
    ]
    expect(shouldCreateOrder2Summary(summaries)).toBe(false)
  })

  it("returns true when 4 or more order-1 summaries", () => {
    const summaries = [
      { id: "sum_001", orderNum: 1 },
      { id: "sum_002", orderNum: 1 },
      { id: "sum_003", orderNum: 1 },
      { id: "sum_004", orderNum: 1 },
    ]
    expect(shouldCreateOrder2Summary(summaries)).toBe(true)
  })

  it("returns true when exactly at minimum (4)", () => {
    const summaries = Array.from({ length: 4 }, (_, i) => ({
      id: `sum_00${i}`,
      orderNum: 1,
    }))
    expect(shouldCreateOrder2Summary(summaries)).toBe(true)
  })
})

describe("shouldCreateHigherOrderSummary", () => {
  it("returns false when fewer than min summaries at that order", () => {
    const summaries = [
      { id: "sum_001", orderNum: 2 },
      { id: "sum_002", orderNum: 2 },
    ]
    expect(shouldCreateHigherOrderSummary(summaries)).toBe(false)
  })

  it("returns true when min or more summaries at that order", () => {
    const summaries = Array.from(
      { length: COMPRESSION_TARGETS.summariesPerHigherOrder.min },
      (_, i) => ({
        id: `sum_00${i}`,
        orderNum: 2,
      }),
    )
    expect(shouldCreateHigherOrderSummary(summaries)).toBe(true)
  })
})

describe("estimateUncompactedTokens (integration)", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  it("returns 0 for empty history", async () => {
    const tokens = await storage.temporal.estimateUncompactedTokens()
    expect(tokens).toBe(0)
  })

  it("returns total tokens when no summaries", async () => {
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "user",
      content: "Hello",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "assistant",
      content: "Hi",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    const tokens = await storage.temporal.estimateUncompactedTokens()
    expect(tokens).toBe(150)
  })

  it("excludes tokens covered by summaries", async () => {
    const msg1 = Identifier.ascending("message")
    const msg2 = Identifier.ascending("message")
    const msg3 = Identifier.ascending("message")

    await storage.temporal.appendMessage({
      id: msg1,
      type: "user",
      content: "First",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })
    await storage.temporal.appendMessage({
      id: msg2,
      type: "assistant",
      content: "Second",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    // Summary covers msg1 and msg2
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msg1,
      endId: msg2,
      narrative: "Summary",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 50,
      createdAt: new Date().toISOString(),
    })

    // New message after summary
    await storage.temporal.appendMessage({
      id: msg3,
      type: "user",
      content: "Third",
      tokenEstimate: 75,
      createdAt: new Date().toISOString(),
    })

    const tokens = await storage.temporal.estimateUncompactedTokens()
    // Only msg3 is uncompacted
    expect(tokens).toBe(75)
  })

  it("handles gaps — counts uncovered messages between summaries", async () => {
    const msg1 = Identifier.ascending("message")
    const msg2 = Identifier.ascending("message")
    const msg3 = Identifier.ascending("message")

    await storage.temporal.appendMessage({
      id: msg1,
      type: "user",
      content: "First",
      tokenEstimate: 100,
      createdAt: new Date().toISOString(),
    })

    // Summary covering only msg1
    await storage.temporal.createSummary({
      id: Identifier.ascending("summary"),
      orderNum: 1,
      startId: msg1,
      endId: msg1,
      narrative: "Summary 1",
      keyObservations: "[]",
      tags: "[]",
      tokenEstimate: 30,
      createdAt: new Date().toISOString(),
    })

    await storage.temporal.appendMessage({
      id: msg2,
      type: "assistant",
      content: "Second (in gap)",
      tokenEstimate: 80,
      createdAt: new Date().toISOString(),
    })
    await storage.temporal.appendMessage({
      id: msg3,
      type: "user",
      content: "Third",
      tokenEstimate: 60,
      createdAt: new Date().toISOString(),
    })

    const tokens = await storage.temporal.estimateUncompactedTokens()
    // msg2 and msg3 are after the last summary endId, so both are uncompacted
    expect(tokens).toBe(140)
  })
})
