/**
 * Tests for recursive summarization logic.
 *
 * These tests verify the system can create summaries of summaries
 * (order-2, order-3, etc.) while maintaining the compression invariant.
 */

import { describe, it, expect } from "bun:test"
import {
  getUnsubsumedSummariesAtOrder,
  getNextOrderToSummarize,
  calculateHigherOrderRange,
  checkCompressionInvariant,
  getExpectedTokenBudget,
  estimateRequiredOrders,
  calculateCompressionRatio,
  validateRecursiveSummary,
} from "./recursive"
import { COMPRESSION_TARGETS } from "./compaction"
import type { TemporalSummary } from "../storage/schema"

// Helper to create summary objects for testing
function makeSummary(
  id: string,
  order: number,
  startId: string,
  endId: string,
  tokenEstimate: number = 100,
): TemporalSummary {
  return {
    id,
    orderNum: order,
    startId,
    endId,
    narrative: "Test narrative",
    keyObservations: "[]",
    tags: "[]",
    tokenEstimate,
    createdAt: new Date().toISOString(),
  }
}

describe("getUnsubsumedSummariesAtOrder", () => {
  it("returns all summaries when none are subsumed", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]

    const result = getUnsubsumedSummariesAtOrder(summaries, 1)
    expect(result).toHaveLength(2)
  })

  it("excludes summaries subsumed by higher order", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010")
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020")
    const order2 = makeSummary("sum_003", 2, "msg_001", "msg_020")

    const summaries = [order1a, order1b, order2]
    const result = getUnsubsumedSummariesAtOrder(summaries, 1)

    // Both order-1 summaries are subsumed by order-2
    expect(result).toHaveLength(0)
  })

  it("returns only summaries at specified order", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 2, "msg_001", "msg_010"),
      makeSummary("sum_003", 1, "msg_011", "msg_020"),
    ]

    const order1 = getUnsubsumedSummariesAtOrder(summaries, 1)
    const order2 = getUnsubsumedSummariesAtOrder(summaries, 2)

    // sum_001 is subsumed by sum_002, only sum_003 remains at order 1
    expect(order1).toHaveLength(1)
    expect(order1[0].id).toBe("sum_003")
    expect(order2).toHaveLength(1)
    expect(order2[0].id).toBe("sum_002")
  })
})

describe("getNextOrderToSummarize", () => {
  it("returns null when no summaries", () => {
    const result = getNextOrderToSummarize([])
    expect(result).toBeNull()
  })

  it("returns null when not enough summaries at any order", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
      // Only 2 order-1 summaries, need 4+
    ]

    const result = getNextOrderToSummarize(summaries)
    expect(result).toBeNull()
  })

  it("returns order 2 when 4+ order-1 summaries exist", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
      makeSummary("sum_003", 1, "msg_021", "msg_030"),
      makeSummary("sum_004", 1, "msg_031", "msg_040"),
    ]

    const result = getNextOrderToSummarize(summaries)
    expect(result).not.toBeNull()
    expect(result!.order).toBe(2)
    expect(result!.summariesToProcess).toHaveLength(4)
  })

  it("returns order 3 when 4+ order-2 summaries exist", () => {
    const summaries = [
      makeSummary("sum_001", 2, "msg_001", "msg_040"),
      makeSummary("sum_002", 2, "msg_041", "msg_080"),
      makeSummary("sum_003", 2, "msg_081", "msg_120"),
      makeSummary("sum_004", 2, "msg_121", "msg_160"),
    ]

    const result = getNextOrderToSummarize(summaries)
    expect(result).not.toBeNull()
    expect(result!.order).toBe(3)
  })

  it("handles mixed orders correctly", () => {
    // Some order-1 subsumed, some not
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
      makeSummary("sum_003", 2, "msg_001", "msg_020"), // Subsumes sum_001, sum_002
      makeSummary("sum_004", 1, "msg_021", "msg_030"),
      makeSummary("sum_005", 1, "msg_031", "msg_040"),
      makeSummary("sum_006", 1, "msg_041", "msg_050"),
      makeSummary("sum_007", 1, "msg_051", "msg_060"),
    ]

    const result = getNextOrderToSummarize(summaries)
    // sum_004, sum_005, sum_006, sum_007 are unsubsumed order-1 (4 total)
    expect(result).not.toBeNull()
    expect(result!.order).toBe(2)
    expect(result!.summariesToProcess).toHaveLength(4)
  })
})

describe("calculateHigherOrderRange", () => {
  it("throws for empty summaries", () => {
    expect(() => calculateHigherOrderRange([])).toThrow()
  })

  it("returns correct range for single summary", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_010", "msg_020")]
    const range = calculateHigherOrderRange(summaries)

    expect(range.startId).toBe("msg_010")
    expect(range.endId).toBe("msg_020")
  })

  it("returns correct range spanning multiple summaries", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_010", "msg_020"),
      makeSummary("sum_002", 1, "msg_021", "msg_030"),
      makeSummary("sum_003", 1, "msg_001", "msg_009"), // Earliest
    ]

    const range = calculateHigherOrderRange(summaries)
    expect(range.startId).toBe("msg_001")
    expect(range.endId).toBe("msg_030")
  })

  it("handles unsorted summaries correctly", () => {
    const summaries = [
      makeSummary("sum_002", 1, "msg_021", "msg_030"),
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_003", 1, "msg_011", "msg_020"),
    ]

    const range = calculateHigherOrderRange(summaries)
    expect(range.startId).toBe("msg_001")
    expect(range.endId).toBe("msg_030")
  })
})

describe("checkCompressionInvariant", () => {
  it("passes when under budget", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010", 1000)]
    const result = checkCompressionInvariant(summaries, 500, 10000)

    expect(result.passes).toBe(true)
    expect(result.currentTokens).toBe(1000)
    expect(result.projectedTokens).toBe(1500)
  })

  it("fails when over budget", () => {
    const summaries = [makeSummary("sum_001", 1, "msg_001", "msg_010", 9000)]
    const result = checkCompressionInvariant(summaries, 2000, 10000)

    expect(result.passes).toBe(false)
    expect(result.projectedTokens).toBe(11000)
  })

  it("only counts unsubsumed summaries in current tokens", () => {
    const order1a = makeSummary("sum_001", 1, "msg_001", "msg_010", 1000)
    const order1b = makeSummary("sum_002", 1, "msg_011", "msg_020", 1000)
    const order2 = makeSummary("sum_003", 2, "msg_001", "msg_020", 500)
    const summaries = [order1a, order1b, order2]

    const result = checkCompressionInvariant(summaries, 300, 10000)

    // Only order2 counts (order1a and order1b are subsumed)
    expect(result.currentTokens).toBe(500)
  })
})

describe("getExpectedTokenBudget", () => {
  it("returns order-1 budget for order 1", () => {
    const budget = getExpectedTokenBudget(1)
    expect(budget.min).toBe(COMPRESSION_TARGETS.order1OutputTokens.min)
    expect(budget.max).toBe(COMPRESSION_TARGETS.order1OutputTokens.max)
  })

  it("returns order-2 budget for order 2", () => {
    const budget = getExpectedTokenBudget(2)
    expect(budget.min).toBe(COMPRESSION_TARGETS.order2OutputTokens.min)
    expect(budget.max).toBe(COMPRESSION_TARGETS.order2OutputTokens.max)
  })

  it("returns order-3+ budget for higher orders", () => {
    const budget3 = getExpectedTokenBudget(3)
    const budget4 = getExpectedTokenBudget(4)
    const budget5 = getExpectedTokenBudget(5)

    expect(budget3.min).toBe(COMPRESSION_TARGETS.order3PlusOutputTokens.min)
    expect(budget4.min).toBe(COMPRESSION_TARGETS.order3PlusOutputTokens.min)
    expect(budget5.min).toBe(COMPRESSION_TARGETS.order3PlusOutputTokens.min)
  })
})

describe("estimateRequiredOrders", () => {
  it("returns 0 for 0 messages", () => {
    expect(estimateRequiredOrders(0)).toBe(0)
  })

  it("returns 1 for small message count", () => {
    // Up to 25 messages = 1 summary = 1 order
    expect(estimateRequiredOrders(10)).toBe(1)
    expect(estimateRequiredOrders(25)).toBe(1)
  })

  it("returns 2 for medium message count", () => {
    // 125 messages / 25 = 5 summaries = need order-2 to compress (5 >= 5)
    expect(estimateRequiredOrders(125)).toBe(2)
    // 100 messages / 25 = 4 summaries = only 1 order (4 < 5)
    expect(estimateRequiredOrders(100)).toBe(1)
  })

  it("returns 3 for large message count", () => {
    // 625 messages / 25 = 25 order-1, 25 / 5 = 5 order-2 = need order-3
    expect(estimateRequiredOrders(625)).toBe(3)
    // 500 messages / 25 = 20 order-1, 20 / 5 = 4 order-2 (4 < 5) = only 2 orders
    expect(estimateRequiredOrders(500)).toBe(2)
  })

  it("scales logarithmically", () => {
    // Should not grow too fast
    const orders1000 = estimateRequiredOrders(1000)
    const orders10000 = estimateRequiredOrders(10000)

    expect(orders10000).toBeLessThanOrEqual(orders1000 + 2)
  })
})

describe("calculateCompressionRatio", () => {
  it("returns 1 for 0 input tokens", () => {
    expect(calculateCompressionRatio(0, 100)).toBe(1)
  })

  it("calculates correct ratio", () => {
    expect(calculateCompressionRatio(1000, 100)).toBe(10)
    expect(calculateCompressionRatio(500, 100)).toBe(5)
    expect(calculateCompressionRatio(200, 100)).toBe(2)
  })
})

describe("validateRecursiveSummary", () => {
  it("validates correct order-2 summary", () => {
    const inputs = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
      makeSummary("sum_003", 1, "msg_021", "msg_030"),
      makeSummary("sum_004", 1, "msg_031", "msg_040"),
    ]

    const output = {
      orderNum: 2,
      startId: "msg_001",
      endId: "msg_040",
      tokenEstimate: 400,
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it("rejects wrong order level", () => {
    const inputs = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]

    const output = {
      orderNum: 1, // Should be 2
      startId: "msg_001",
      endId: "msg_020",
      tokenEstimate: 300,
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("order"))).toBe(true)
  })

  it("rejects incorrect range", () => {
    const inputs = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]

    const output = {
      orderNum: 2,
      startId: "msg_005", // Wrong start
      endId: "msg_020",
      tokenEstimate: 300,
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("startId"))).toBe(true)
  })

  it("rejects invalid ULID ordering", () => {
    const inputs = [makeSummary("sum_001", 1, "msg_001", "msg_010")]

    const output = {
      orderNum: 2,
      startId: "msg_020", // Greater than endId
      endId: "msg_010",
      tokenEstimate: 300,
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("Invalid range"))).toBe(true)
  })

  it("warns on extremely low token count", () => {
    const inputs = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]

    const output = {
      orderNum: 2,
      startId: "msg_001",
      endId: "msg_020",
      tokenEstimate: 10, // Way too low
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("too low"))).toBe(true)
  })

  it("warns on extremely high token count", () => {
    const inputs = [
      makeSummary("sum_001", 1, "msg_001", "msg_010"),
      makeSummary("sum_002", 1, "msg_011", "msg_020"),
    ]

    const output = {
      orderNum: 2,
      startId: "msg_001",
      endId: "msg_020",
      tokenEstimate: 5000, // Way too high
    }

    const result = validateRecursiveSummary(inputs, output)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("too high"))).toBe(true)
  })
})

describe("recursive summarization (integration)", () => {
  it("order-2 created when 5+ order-1 summaries exist", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_020"),
      makeSummary("sum_002", 1, "msg_021", "msg_040"),
      makeSummary("sum_003", 1, "msg_041", "msg_060"),
      makeSummary("sum_004", 1, "msg_061", "msg_080"),
      makeSummary("sum_005", 1, "msg_081", "msg_100"),
    ]

    const next = getNextOrderToSummarize(summaries)
    expect(next).not.toBeNull()
    expect(next!.order).toBe(2)
    expect(next!.summariesToProcess).toHaveLength(5)
  })

  it("order-3 created when 5+ order-2 summaries exist", () => {
    const summaries = [
      makeSummary("sum_001", 2, "msg_001", "msg_100"),
      makeSummary("sum_002", 2, "msg_101", "msg_200"),
      makeSummary("sum_003", 2, "msg_201", "msg_300"),
      makeSummary("sum_004", 2, "msg_301", "msg_400"),
      makeSummary("sum_005", 2, "msg_401", "msg_500"),
    ]

    const next = getNextOrderToSummarize(summaries)
    expect(next).not.toBeNull()
    expect(next!.order).toBe(3)
  })

  it("handles mixed orders correctly", () => {
    // Complex scenario with multiple levels
    const summaries = [
      // Subsumed order-1 summaries
      makeSummary("sum_001", 1, "msg_001", "msg_020"),
      makeSummary("sum_002", 1, "msg_021", "msg_040"),
      makeSummary("sum_003", 1, "msg_041", "msg_060"),
      makeSummary("sum_004", 1, "msg_061", "msg_080"),
      // Order-2 that subsumes the above
      makeSummary("sum_005", 2, "msg_001", "msg_080"),
      // Unsubsumed order-1 summaries
      makeSummary("sum_006", 1, "msg_081", "msg_100"),
      makeSummary("sum_007", 1, "msg_101", "msg_120"),
      makeSummary("sum_008", 1, "msg_121", "msg_140"),
      makeSummary("sum_009", 1, "msg_141", "msg_160"),
    ]

    const next = getNextOrderToSummarize(summaries)
    // Should find the 4 unsubsumed order-1 summaries
    expect(next).not.toBeNull()
    expect(next!.order).toBe(2)
    expect(next!.summariesToProcess.map((s) => s.id)).toEqual([
      "sum_006",
      "sum_007",
      "sum_008",
      "sum_009",
    ])
  })

  it("maintains ULID ordering invariant", () => {
    const summaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_020"),
      makeSummary("sum_002", 1, "msg_021", "msg_040"),
      makeSummary("sum_003", 1, "msg_041", "msg_060"),
      makeSummary("sum_004", 1, "msg_061", "msg_080"),
    ]

    const range = calculateHigherOrderRange(summaries)

    // Range should be lexicographically ordered
    expect(range.startId < range.endId).toBe(true)
    // Range should cover all input
    expect(range.startId).toBe("msg_001")
    expect(range.endId).toBe("msg_080")
  })

  it("achieves target compression ratio", () => {
    // 4 order-1 summaries at ~600 tokens each = 2400 input tokens
    // Order-2 output should be 300-500 tokens
    const inputTokens = 4 * 600
    const expectedOutputMax = COMPRESSION_TARGETS.order2OutputTokens.max

    const ratio = calculateCompressionRatio(inputTokens, expectedOutputMax)
    // Should achieve at least 4x compression
    expect(ratio).toBeGreaterThanOrEqual(4)
  })

  it("maintains compression invariant: total tokens < budget after compaction", () => {
    const budget = 10000

    // Current state: 4 order-1 summaries at 600 tokens each
    const currentSummaries = [
      makeSummary("sum_001", 1, "msg_001", "msg_020", 600),
      makeSummary("sum_002", 1, "msg_021", "msg_040", 600),
      makeSummary("sum_003", 1, "msg_041", "msg_060", 600),
      makeSummary("sum_004", 1, "msg_061", "msg_080", 600),
    ]

    // New order-2 would be ~400 tokens
    const newSummaryTokens = 400

    const invariant = checkCompressionInvariant(
      currentSummaries,
      newSummaryTokens,
      budget,
    )

    // Before: 2400 tokens from order-1
    // After: order-2 (400) + subsumed order-1 still counted in projection
    // But in practice, subsumed summaries don't count
    expect(invariant.passes).toBe(true)
    expect(invariant.projectedTokens).toBeLessThan(budget)
  })
})
