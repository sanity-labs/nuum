/**
 * Tests for coverage detection functions.
 *
 * ULID range semantics (from arch spec):
 * - startId and endId are INCLUSIVE
 * - A message is covered if: message.id >= summary.startId AND message.id <= summary.endId
 * - Adjacent summaries should not overlap
 */

import { describe, it, expect } from "bun:test"
import {
  isCoveredBySummary,
  isSubsumedByHigherOrder,
  getUncoveredMessages,
  getEffectiveSummaries,
  findCoverageGaps,
} from "./coverage"
import type { TemporalSummary, TemporalMessage } from "../storage/schema"

// Helper to create minimal summary objects for testing
function makeSummary(
  id: string,
  order: number,
  startId: string,
  endId: string,
): Pick<TemporalSummary, "id" | "orderNum" | "startId" | "endId"> {
  return { id, orderNum: order, startId, endId }
}

// Helper to create minimal message objects for testing
function makeMessage(id: string): TemporalMessage {
  return {
    id,
    type: "user",
    content: "test",
    tokenEstimate: 10,
    createdAt: new Date().toISOString(),
  }
}

describe("isCoveredBySummary", () => {
  it("returns false when no summaries exist", () => {
    expect(isCoveredBySummary("msg_001", [])).toBe(false)
  })

  it("returns true for message within summary range (inclusive start)", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    expect(isCoveredBySummary("msg_001", summaries)).toBe(true)
  })

  it("returns true for message within summary range (inclusive end)", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    expect(isCoveredBySummary("msg_010", summaries)).toBe(true)
  })

  it("returns true for message in middle of summary range", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    expect(isCoveredBySummary("msg_005", summaries)).toBe(true)
  })

  it("returns false for message before summary range", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_010", "msg_020")]
    expect(isCoveredBySummary("msg_005", summaries)).toBe(false)
  })

  it("returns false for message after summary range", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    expect(isCoveredBySummary("msg_015", summaries)).toBe(false)
  })

  it("returns true when message covered by any of multiple summaries", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_020", "msg_030"),
    ]
    expect(isCoveredBySummary("msg_025", summaries)).toBe(true)
  })

  it("returns false for message in gap between summaries", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_020", "msg_030"),
    ]
    expect(isCoveredBySummary("msg_015", summaries)).toBe(false)
  })

  it("handles edge case at boundary correctly", () => {
    // msg_010 is the end of first summary, msg_011 should NOT be covered
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    expect(isCoveredBySummary("msg_010", summaries)).toBe(true)
    expect(isCoveredBySummary("msg_011", summaries)).toBe(false)
  })
})

describe("isSubsumedByHigherOrder", () => {
  it("returns false for highest-order summaries (no higher order exists)", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]
    expect(isSubsumedByHigherOrder(summaries[0], summaries)).toBe(false)
  })

  it("returns true when order-2 covers order-1 range exactly", () => {
    const order1 = makeSummary("sum_001", 1, "msg_001", "msg_020")
    const order2 = makeSummary("sum_002", 2, "msg_001", "msg_020")
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(true)
    expect(isSubsumedByHigherOrder(order2, summaries)).toBe(false)
  })

  it("returns true when higher-order summary fully contains range", () => {
    const order1 = makeSummary("sum_001", 1, "msg_005", "msg_015")
    const order2 = makeSummary("sum_002", 2, "msg_001", "msg_020")
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(true)
  })

  it("returns false when higher-order summary only partially overlaps", () => {
    const order1 = makeSummary("sum_001", 1, "msg_001", "msg_020")
    const order2 = makeSummary("sum_002", 2, "msg_010", "msg_030") // Only covers part
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(false)
  })

  it("returns false for same-order summaries with overlapping ranges", () => {
    const sum1 = makeSummary("sum_001", 1, "msg_001", "msg_015")
    const sum2 = makeSummary("sum_002", 1, "msg_010", "msg_025")
    const summaries = [sum1, sum2]

    // Same order = not subsumed
    expect(isSubsumedByHigherOrder(sum1, summaries)).toBe(false)
    expect(isSubsumedByHigherOrder(sum2, summaries)).toBe(false)
  })

  it("handles order-3 subsuming order-2 which subsumed order-1", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010")
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020")
    const order2 = makeSummary("sum_003", 2, "msg_001", "msg_020")
    const order3 = makeSummary("sum_004", 3, "msg_001", "msg_020")
    const summaries = [order1a, order1b, order2, order3]

    expect(isSubsumedByHigherOrder(order1a, summaries)).toBe(true) // By order2 or order3
    expect(isSubsumedByHigherOrder(order1b, summaries)).toBe(true) // By order2 or order3
    expect(isSubsumedByHigherOrder(order2, summaries)).toBe(true) // By order3
    expect(isSubsumedByHigherOrder(order3, summaries)).toBe(false) // Highest
  })

  it("does not consider a summary to subsume itself", () => {
    const summary = makeSummary("sum_001", 2, "msg_001", "msg_020")
    const summaries = [summary]

    expect(isSubsumedByHigherOrder(summary, summaries)).toBe(false)
  })
})

describe("getUncoveredMessages", () => {
  it("returns all messages when no summaries exist", () => {
    const messages = [makeMessage("msg_001"), makeMessage("msg_002")]
    const result = getUncoveredMessages(messages, [])
    expect(result).toHaveLength(2)
  })

  it("returns empty array when all messages are covered", () => {
    const messages = [makeMessage("msg_001"), makeMessage("msg_005")]
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    const result = getUncoveredMessages(messages, summaries)
    expect(result).toHaveLength(0)
  })

  it("returns only messages outside summary ranges", () => {
    const messages = [
      makeMessage("msg_001"),
      makeMessage("msg_015"), // In gap
      makeMessage("msg_025"),
    ]
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_020", "msg_030"),
    ]
    const result = getUncoveredMessages(messages, summaries)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("msg_015")
  })

  it("handles messages at boundaries correctly", () => {
    const messages = [
      makeMessage("msg_010"), // End of summary 1 (covered)
      makeMessage("msg_011"), // After summary 1 (uncovered)
      makeMessage("msg_020"), // Start of summary 2 (covered)
    ]
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_020", "msg_030"),
    ]
    const result = getUncoveredMessages(messages, summaries)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("msg_011")
  })
})

describe("getEffectiveSummaries", () => {
  it("returns all summaries when none are subsumed", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]
    const result = getEffectiveSummaries(summaries)
    expect(result).toHaveLength(2)
  })

  it("excludes order-1 summaries subsumed by order-2", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010")
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020")
    const order2 = makeSummary("sum_003", 2, "msg_001", "msg_020")
    const summaries = [order1a, order1b, order2]

    const result = getEffectiveSummaries(summaries)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("sum_003")
  })

  it("includes order-2 but excludes its order-1 children", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010")
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020")
    const order1c = makeSummary("sum_003", 1, "msg_021", "msg_030") // Not subsumed
    const order2 = makeSummary("sum_004", 2, "msg_001", "msg_020")
    const summaries = [order1a, order1b, order1c, order2]

    const result = getEffectiveSummaries(summaries)
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.id).sort()).toEqual(["sum_003", "sum_004"])
  })

  it("handles multiple levels of recursion", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010")
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020")
    const order2 = makeSummary("sum_003", 2, "msg_001", "msg_020")
    const order3 = makeSummary("sum_004", 3, "msg_001", "msg_020")
    const summaries = [order1a, order1b, order2, order3]

    const result = getEffectiveSummaries(summaries)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("sum_004")
  })
})

describe("findCoverageGaps", () => {
  it("returns empty array when no summaries and no message range", () => {
    const result = findCoverageGaps([])
    expect(result).toHaveLength(0)
  })

  it("returns single gap spanning everything when no summaries but messages exist", () => {
    const result = findCoverageGaps([], { firstId: "msg_001", lastId: "msg_100" })
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ afterId: null, beforeId: null })
  })

  it("finds gap before first summary", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_010", "msg_020")]
    const result = findCoverageGaps(summaries, {
      firstId: "msg_001",
      lastId: "msg_020",
    })

    expect(result.some((g) => g.afterId === null && g.beforeId === "msg_010")).toBe(
      true,
    )
  })

  it("finds gap after last summary", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010")]
    const result = findCoverageGaps(summaries, {
      firstId: "msg_001",
      lastId: "msg_020",
    })

    expect(result.some((g) => g.afterId === "msg_010" && g.beforeId === null)).toBe(
      true,
    )
  })

  it("finds gap between summaries", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_020", "msg_030"),
    ]
    const result = findCoverageGaps(summaries)

    expect(
      result.some((g) => g.afterId === "msg_010" && g.beforeId === "msg_020"),
    ).toBe(true)
  })

  it("does not report gap when summaries are adjacent", () => {
    // In this case, summaries directly follow each other with no gap
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_010", "msg_020"), // Overlapping at msg_010
    ]
    const result = findCoverageGaps(summaries)

    // Should not find a gap between them since they share msg_010
    expect(result.filter((g) => g.afterId === "msg_010")).toHaveLength(0)
  })

  it("handles multiple gaps correctly", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_010", "msg_020"),
      makeSummary("sum_002", 1, "msg_040", "msg_050"),
    ]
    const result = findCoverageGaps(summaries, {
      firstId: "msg_001",
      lastId: "msg_060",
    })

    // Gap before first, between summaries, after last
    expect(result.length).toBeGreaterThanOrEqual(3)
  })
})
