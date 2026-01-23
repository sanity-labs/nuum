/**
 * Tests for temporal view construction.
 *
 * Token distribution targets (from arch spec):
 * [Oldest summaries: ~10%] [Mid-history: ~20%] [Recent summaries: ~30%] [Raw messages: ~40%]
 */

import { describe, it, expect } from "bun:test"
import { buildTemporalView, renderTemporalView, type TemporalView } from "./view"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"

// Helper to create message objects for testing
function makeMessage(
  id: string,
  content: string,
  tokenEstimate: number,
  type: TemporalMessage["type"] = "user",
): TemporalMessage {
  return {
    id,
    type,
    content,
    tokenEstimate,
    createdAt: new Date().toISOString(),
  }
}

// Helper to create summary objects for testing
function makeSummary(
  id: string,
  order: number,
  startId: string,
  endId: string,
  tokenEstimate: number,
  narrative: string = "Summary narrative",
  keyObservations: string[] = [],
): TemporalSummary {
  return {
    id,
    orderNum: order,
    startId,
    endId,
    narrative,
    keyObservations: JSON.stringify(keyObservations),
    tags: "[]",
    tokenEstimate,
    createdAt: new Date().toISOString(),
  }
}

describe("buildTemporalView", () => {
  describe("empty history", () => {
    it("returns empty view for empty history", () => {
      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [],
      })

      expect(result.summaries).toHaveLength(0)
      expect(result.messages).toHaveLength(0)
      expect(result.totalTokens).toBe(0)
      expect(result.breakdown.summaryTokens).toBe(0)
      expect(result.breakdown.messageTokens).toBe(0)
    })
  })

  describe("messages only (no summaries)", () => {
    it("returns only raw messages when no summaries exist", () => {
      const messages = [
        makeMessage("msg_001", "Hello", 10),
        makeMessage("msg_002", "World", 10),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries: [],
      })

      expect(result.summaries).toHaveLength(0)
      expect(result.messages).toHaveLength(2)
      expect(result.breakdown.messageTokens).toBe(20)
    })

    it("respects 40% budget for raw messages", () => {
      // Budget is 100, so raw messages get 40 tokens
      const messages = [
        makeMessage("msg_001", "a", 20),
        makeMessage("msg_002", "b", 20),
        makeMessage("msg_003", "c", 20), // This should be excluded
      ]

      const result = buildTemporalView({
        budget: 100,
        messages,
        summaries: [],
      })

      expect(result.messages).toHaveLength(2)
      expect(result.breakdown.messageTokens).toBe(40)
    })

    it("prioritizes most recent messages", () => {
      const messages = [
        makeMessage("msg_001", "old", 20),
        makeMessage("msg_002", "mid", 20),
        makeMessage("msg_003", "new", 20),
      ]

      const result = buildTemporalView({
        budget: 100, // 40 tokens for messages = only 2 fit
        messages,
        summaries: [],
      })

      expect(result.messages).toHaveLength(2)
      // Should include msg_002 and msg_003 (most recent)
      expect(result.messages.map((m) => m.id)).toEqual(["msg_002", "msg_003"])
    })
  })

  describe("mixed summaries and messages", () => {
    it("returns mixed summaries + messages when both exist", () => {
      const messages = [
        makeMessage("msg_020", "recent", 10),
        makeMessage("msg_021", "very recent", 10),
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 50),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      expect(result.summaries).toHaveLength(1)
      expect(result.messages).toHaveLength(2)
    })

    it("returns chronological order", () => {
      const messages = [
        makeMessage("msg_030", "third", 10),
        makeMessage("msg_020", "second", 10), // Out of order in input
        makeMessage("msg_040", "fourth", 10),
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 50),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // Messages should be in chronological order
      expect(result.messages.map((m) => m.id)).toEqual([
        "msg_020",
        "msg_030",
        "msg_040",
      ])
      // Summaries should be in chronological order (by startId)
      expect(result.summaries[0].startId).toBe("msg_001")
    })
  })

  describe("budget handling", () => {
    it("respects token budget", () => {
      const messages = [
        makeMessage("msg_001", "a", 100),
        makeMessage("msg_002", "b", 100),
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_000", "msg_000", 100),
      ]

      const result = buildTemporalView({
        budget: 150,
        messages,
        summaries,
      })

      expect(result.totalTokens).toBeLessThanOrEqual(150)
    })

    it("allocates ~40% to raw messages, ~60% to summaries", () => {
      const messages = [
        makeMessage("msg_100", "a", 10),
        makeMessage("msg_101", "b", 10),
        makeMessage("msg_102", "c", 10),
        makeMessage("msg_103", "d", 10),
        makeMessage("msg_104", "e", 10), // 50 tokens total
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 30),
        makeSummary("sum_002", 1, "msg_011", "msg_020", 30), // 60 tokens total
      ]

      const result = buildTemporalView({
        budget: 100,
        messages,
        summaries,
      })

      // 40 tokens for messages = 4 messages
      expect(result.breakdown.messageTokens).toBeLessThanOrEqual(40)
      // 60 tokens for summaries = 2 summaries
      expect(result.breakdown.summaryTokens).toBeLessThanOrEqual(60)
    })

    it("drops older content first when budget overflows", () => {
      // All recent messages that would fit in 40% budget
      const messages = [
        makeMessage("msg_001", "oldest", 15),
        makeMessage("msg_002", "older", 15),
        makeMessage("msg_003", "newer", 15),
        makeMessage("msg_004", "newest", 15),
      ]

      const result = buildTemporalView({
        budget: 100, // 40 tokens for messages
        messages,
        summaries: [],
      })

      // Should drop oldest, keep most recent
      expect(result.messages.map((m) => m.id)).not.toContain("msg_001")
      expect(result.messages.map((m) => m.id)).toContain("msg_004")
    })

    it("preserves recency — recent messages always included if budget allows", () => {
      const messages = [
        makeMessage("msg_001", "old", 5),
        makeMessage("msg_100", "very recent", 5),
      ]

      const result = buildTemporalView({
        budget: 100, // Plenty of budget
        messages,
        summaries: [],
      })

      expect(result.messages.map((m) => m.id)).toContain("msg_100")
    })
  })

  describe("coverage/subsumption", () => {
    it("skips messages covered by summaries", () => {
      const messages = [
        makeMessage("msg_005", "covered", 10),
        makeMessage("msg_015", "not covered", 10),
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 50),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // msg_005 is covered by summary, should be excluded
      expect(result.messages.map((m) => m.id)).not.toContain("msg_005")
      expect(result.messages.map((m) => m.id)).toContain("msg_015")
    })

    it("skips summaries subsumed by higher-order summaries", () => {
      const order1 = makeSummary("sum_001", 1, "msg_001", "msg_020", 30)
      const order2 = makeSummary("sum_002", 2, "msg_001", "msg_020", 20)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [order1, order2],
      })

      // order1 is subsumed by order2, should be excluded
      expect(result.summaries.map((s) => s.id)).not.toContain("sum_001")
      expect(result.summaries.map((s) => s.id)).toContain("sum_002")
    })

    it("includes order-2 but excludes its order-1 children", () => {
      const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010", 30)
      const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020", 30)
      const order1c = makeSummary("sum_003", 1, "msg_021", "msg_030", 30) // Not subsumed
      const order2 = makeSummary("sum_004", 2, "msg_001", "msg_020", 50)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [order1a, order1b, order1c, order2],
      })

      // order1a and order1b subsumed by order2
      expect(result.summaries.map((s) => s.id)).not.toContain("sum_001")
      expect(result.summaries.map((s) => s.id)).not.toContain("sum_002")
      // order1c and order2 included
      expect(result.summaries.map((s) => s.id)).toContain("sum_003")
      expect(result.summaries.map((s) => s.id)).toContain("sum_004")
    })

    it("handles gaps between summary ranges — includes uncovered messages", () => {
      const messages = [
        makeMessage("msg_005", "covered", 10),
        makeMessage("msg_015", "in gap", 10), // Between summaries
        makeMessage("msg_025", "covered", 10),
      ]
      const summaries = [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 50),
        makeSummary("sum_002", 1, "msg_020", "msg_030", 50),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // Only msg_015 should be included (others covered by summaries)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].id).toBe("msg_015")
    })
  })

  describe("summary selection priority", () => {
    it("prefers higher-order summaries when budget limited", () => {
      const order1 = makeSummary("sum_001", 1, "msg_001", "msg_010", 100)
      const order2 = makeSummary("sum_002", 2, "msg_001", "msg_010", 50)

      // Budget only fits one
      const result = buildTemporalView({
        budget: 100, // 60 for summaries
        messages: [],
        summaries: [order1, order2],
      })

      // Should include order2 (higher order), not order1
      expect(result.summaries.map((s) => s.id)).toContain("sum_002")
      expect(result.summaries.map((s) => s.id)).not.toContain("sum_001")
    })

    it("within same order, prefers more recent summaries", () => {
      const older = makeSummary("sum_001", 1, "msg_001", "msg_010", 40)
      const newer = makeSummary("sum_002", 1, "msg_011", "msg_020", 40)

      // Budget only fits one
      const result = buildTemporalView({
        budget: 100, // 60 for summaries
        messages: [],
        summaries: [older, newer],
      })

      // Should include newer summary
      expect(result.summaries.map((s) => s.id)).toContain("sum_002")
    })
  })
})

describe("renderTemporalView", () => {
  it("renders empty view with placeholder", () => {
    const view: TemporalView = {
      summaries: [],
      messages: [],
      totalTokens: 0,
      breakdown: { summaryTokens: 0, messageTokens: 0 },
    }

    const result = renderTemporalView(view)

    expect(result).toContain("<conversation_history>")
    expect(result).toContain("No previous conversation history")
    expect(result).toContain("</conversation_history>")
  })

  it("renders summaries with order and range attributes", () => {
    const view: TemporalView = {
      summaries: [
        makeSummary("sum_001", 2, "msg_001", "msg_020", 50, "This is the narrative"),
      ],
      messages: [],
      totalTokens: 50,
      breakdown: { summaryTokens: 50, messageTokens: 0 },
    }

    const result = renderTemporalView(view)

    expect(result).toContain('order="2"')
    expect(result).toContain('from="msg_001"')
    expect(result).toContain('to="msg_020"')
    expect(result).toContain("This is the narrative")
  })

  it("renders key observations as bullet list", () => {
    const view: TemporalView = {
      summaries: [
        makeSummary("sum_001", 1, "msg_001", "msg_010", 50, "Narrative", [
          "First observation",
          "Second observation",
        ]),
      ],
      messages: [],
      totalTokens: 50,
      breakdown: { summaryTokens: 50, messageTokens: 0 },
    }

    const result = renderTemporalView(view)

    expect(result).toContain("Key observations:")
    expect(result).toContain("- First observation")
    expect(result).toContain("- Second observation")
  })

  it("renders messages with type prefix", () => {
    const view: TemporalView = {
      summaries: [],
      messages: [
        makeMessage("msg_001", "Hello", 10, "user"),
        makeMessage("msg_002", "Hi there", 10, "assistant"),
      ],
      totalTokens: 20,
      breakdown: { summaryTokens: 0, messageTokens: 20 },
    }

    const result = renderTemporalView(view)

    expect(result).toContain("[User]: Hello")
    expect(result).toContain("[Assistant]: Hi there")
  })

  it("renders summaries before messages", () => {
    const view: TemporalView = {
      summaries: [makeSummary("sum_001", 1, "msg_001", "msg_010", 50, "Summary text")],
      messages: [makeMessage("msg_020", "Recent message", 10)],
      totalTokens: 60,
      breakdown: { summaryTokens: 50, messageTokens: 10 },
    }

    const result = renderTemporalView(view)

    // Summary should appear before messages
    const summaryIndex = result.indexOf("<summary")
    const messageIndex = result.indexOf("[User]:")
    expect(summaryIndex).toBeLessThan(messageIndex)
  })
})
