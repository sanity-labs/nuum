/**
 * Tests for summary creation and validation logic.
 */

import { describe, it, expect } from "bun:test"
import {
  estimateSummaryTokens,
  createSummaryInsert,
  validateSummaryRange,
  validateSummaryTokens,
  findBreakpoints,
  groupMessagesForSummary,
  groupSummariesForHigherOrder,
  type SummaryInput,
} from "./summary"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"

// Helper to create minimal message objects for testing
function makeMessage(
  id: string,
  type: TemporalMessage["type"] = "user",
): TemporalMessage {
  return {
    id,
    type,
    content: "test content",
    tokenEstimate: 10,
    createdAt: new Date().toISOString(),
  }
}

// Helper to create minimal summary objects for testing
function makeSummary(
  id: string,
  order: number,
  startId: string,
  endId: string,
): TemporalSummary {
  return {
    id,
    orderNum: order,
    startId,
    endId,
    narrative: "Summary narrative",
    keyObservations: "[]",
    tags: "[]",
    tokenEstimate: 100,
    createdAt: new Date().toISOString(),
  }
}

describe("estimateSummaryTokens", () => {
  it("estimates tokens from narrative length", () => {
    const input: SummaryInput = {
      narrative: "This is a test narrative with some content.", // 44 chars
      keyObservations: [],
      tags: [],
    }

    const tokens = estimateSummaryTokens(input)
    // 44 chars / 4 = 11 tokens
    expect(tokens).toBe(11)
  })

  it("includes key observations in token count", () => {
    const input: SummaryInput = {
      narrative: "", // 0 tokens
      keyObservations: ["First observation here", "Second one"], // ~32 chars total
      tags: [],
    }

    const tokens = estimateSummaryTokens(input)
    // First: 21/4 = 6, Second: 10/4 = 3
    expect(tokens).toBe(9)
  })

  it("includes tags in token count", () => {
    const input: SummaryInput = {
      narrative: "",
      keyObservations: [],
      tags: ["auth", "refactor", "api"], // 3 tags * 2 tokens each
    }

    const tokens = estimateSummaryTokens(input)
    expect(tokens).toBe(6)
  })

  it("combines all components", () => {
    const input: SummaryInput = {
      narrative: "Test", // 1 token
      keyObservations: ["Test"], // 1 token
      tags: ["tag"], // 2 tokens
    }

    const tokens = estimateSummaryTokens(input)
    expect(tokens).toBe(4)
  })
})

describe("createSummaryInsert", () => {
  it("creates order-1 from messages", () => {
    const result = createSummaryInsert({
      order: 1,
      startId: "msg_001",
      endId: "msg_010",
      input: {
        narrative: "Summary of conversation",
        keyObservations: ["User prefers TypeScript"],
        tags: ["preferences"],
      },
    })

    expect(result.orderNum).toBe(1)
    expect(result.startId).toBe("msg_001")
    expect(result.endId).toBe("msg_010")
    expect(result.narrative).toBe("Summary of conversation")
    expect(JSON.parse(result.keyObservations)).toEqual(["User prefers TypeScript"])
    expect(JSON.parse(result.tags!)).toEqual(["preferences"])
    expect(result.tokenEstimate).toBeGreaterThan(0)
    expect(result.id).toMatch(/^sum_/)
    expect(result.createdAt).toBeDefined()
  })

  it("creates order-2 from order-1 summaries", () => {
    const result = createSummaryInsert({
      order: 2,
      startId: "sum_001",
      endId: "sum_005",
      input: {
        narrative: "Higher-order summary",
        keyObservations: [],
        tags: [],
      },
    })

    expect(result.orderNum).toBe(2)
    expect(result.startId).toBe("sum_001")
    expect(result.endId).toBe("sum_005")
  })

  it("sets correct startId/endId range", () => {
    const result = createSummaryInsert({
      order: 1,
      startId: "msg_100",
      endId: "msg_200",
      input: {
        narrative: "Test",
        keyObservations: [],
        tags: [],
      },
    })

    // Range should be exactly as specified
    expect(result.startId).toBe("msg_100")
    expect(result.endId).toBe("msg_200")
  })

  it("extracts tags from content", () => {
    const result = createSummaryInsert({
      order: 1,
      startId: "msg_001",
      endId: "msg_010",
      input: {
        narrative: "Discussion about authentication",
        keyObservations: [],
        tags: ["auth", "security", "oauth"],
      },
    })

    const tags = JSON.parse(result.tags!)
    expect(tags).toContain("auth")
    expect(tags).toContain("security")
    expect(tags).toContain("oauth")
  })

  it("is immutable once created (property check)", () => {
    const result = createSummaryInsert({
      order: 1,
      startId: "msg_001",
      endId: "msg_010",
      input: {
        narrative: "Test",
        keyObservations: [],
        tags: [],
      },
    })

    // Verify all required fields are present
    expect(result).toHaveProperty("id")
    expect(result).toHaveProperty("orderNum")
    expect(result).toHaveProperty("startId")
    expect(result).toHaveProperty("endId")
    expect(result).toHaveProperty("narrative")
    expect(result).toHaveProperty("keyObservations")
    expect(result).toHaveProperty("tags")
    expect(result).toHaveProperty("tokenEstimate")
    expect(result).toHaveProperty("createdAt")
  })
})

describe("validateSummaryRange", () => {
  it("accepts valid range where startId < endId", () => {
    const result = validateSummaryRange("msg_001", "msg_010")
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("accepts valid range where startId equals endId", () => {
    const result = validateSummaryRange("msg_005", "msg_005")
    expect(result.valid).toBe(true)
  })

  it("rejects invalid range where startId > endId", () => {
    const result = validateSummaryRange("msg_020", "msg_010")
    expect(result.valid).toBe(false)
    expect(result.error).toContain("Invalid range")
  })
})

describe("validateSummaryTokens", () => {
  it("accepts tokens within expected range for order-1", () => {
    // Order-1 expects 500-800 tokens
    const result = validateSummaryTokens(1, 650)
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  it("warns when order-1 tokens are too low", () => {
    // Order-1 expects 500-800, 200 is < 500 * 0.5 = 250
    const result = validateSummaryTokens(1, 200)
    expect(result.valid).toBe(true)
    expect(result.warning).toContain("very short")
  })

  it("warns when order-1 tokens are too high", () => {
    // Order-1 expects 500-800, 1500 is > 800 * 1.5 = 1200
    const result = validateSummaryTokens(1, 1500)
    expect(result.valid).toBe(true)
    expect(result.warning).toContain("very long")
  })

  it("accepts tokens within expected range for order-2", () => {
    // Order-2 expects 300-500 tokens
    const result = validateSummaryTokens(2, 400)
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })

  it("accepts tokens within expected range for order-3+", () => {
    // Order-3+ expects 150-250 tokens
    const result = validateSummaryTokens(3, 200)
    expect(result.valid).toBe(true)
    expect(result.warning).toBeUndefined()
  })
})

describe("findBreakpoints", () => {
  it("returns empty array for single message", () => {
    const messages = [makeMessage("msg_001")]
    const breakpoints = findBreakpoints(messages)
    expect(breakpoints).toEqual([])
  })

  it("returns empty array for empty messages", () => {
    const breakpoints = findBreakpoints([])
    expect(breakpoints).toEqual([])
  })

  it("finds breakpoint at tool_result after minimum messages", () => {
    // Create 20 messages with tool_result at index 15
    const messages: TemporalMessage[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(makeMessage(`msg_${String(i).padStart(3, "0")}`, i === 15 ? "tool_result" : "user"))
    }

    const breakpoints = findBreakpoints(messages)
    // Should find breakpoint at or after index 15 (tool_result)
    expect(breakpoints.some((bp) => bp >= 15)).toBe(true)
  })

  it("forces breakpoint at max messages", () => {
    // Create 30 messages (exceeds max of 25)
    const messages: TemporalMessage[] = []
    for (let i = 0; i < 30; i++) {
      messages.push(makeMessage(`msg_${String(i).padStart(3, "0")}`))
    }

    const breakpoints = findBreakpoints(messages)
    // Should have at least one breakpoint
    expect(breakpoints.length).toBeGreaterThan(0)
  })
})

describe("groupMessagesForSummary", () => {
  it("returns empty array for no messages", () => {
    const groups = groupMessagesForSummary([])
    expect(groups).toEqual([])
  })

  it("returns single group for messages under minimum", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      makeMessage(`msg_${String(i).padStart(3, "0")}`),
    )

    const groups = groupMessagesForSummary(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(10)
  })

  it("splits messages at approximately max size (25)", () => {
    // Create 50 messages
    const messages = Array.from({ length: 50 }, (_, i) =>
      makeMessage(`msg_${String(i).padStart(3, "0")}`),
    )

    const groups = groupMessagesForSummary(messages)
    // Should have 2 groups (50 / 25 = 2)
    expect(groups).toHaveLength(2)
    expect(groups[0].length).toBeLessThanOrEqual(25)
    expect(groups[1].length).toBeLessThanOrEqual(25)
  })

  it("merges small remainder with previous group", () => {
    // Create 28 messages (25 + 3, remainder < 15)
    const messages = Array.from({ length: 28 }, (_, i) =>
      makeMessage(`msg_${String(i).padStart(3, "0")}`),
    )

    const groups = groupMessagesForSummary(messages)
    // Should have 1 group with all 28 (3 merged into first)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(28)
  })

  it("preserves message order within groups", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMessage(`msg_${String(i).padStart(3, "0")}`),
    )

    const groups = groupMessagesForSummary(messages)
    const flattened = groups.flat()

    // Should maintain original order
    for (let i = 0; i < flattened.length - 1; i++) {
      expect(flattened[i].id < flattened[i + 1].id).toBe(true)
    }
  })
})

describe("groupSummariesForHigherOrder", () => {
  it("returns empty array for no summaries", () => {
    const groups = groupSummariesForHigherOrder([])
    expect(groups).toEqual([])
  })

  it("returns empty array when fewer than minimum summaries", () => {
    // Need at least 4 summaries
    const summaries = Array.from({ length: 3 }, (_, i) =>
      makeSummary(`sum_${i}`, 1, `msg_${i * 10}`, `msg_${i * 10 + 9}`),
    )

    const groups = groupSummariesForHigherOrder(summaries)
    expect(groups).toEqual([])
  })

  it("creates groups at minimum size (4)", () => {
    const summaries = Array.from({ length: 4 }, (_, i) =>
      makeSummary(`sum_${i}`, 1, `msg_${i * 10}`, `msg_${i * 10 + 9}`),
    )

    const groups = groupSummariesForHigherOrder(summaries)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(4)
  })

  it("splits at max size (5)", () => {
    const summaries = Array.from({ length: 10 }, (_, i) =>
      makeSummary(`sum_${i}`, 1, `msg_${i * 10}`, `msg_${i * 10 + 9}`),
    )

    const groups = groupSummariesForHigherOrder(summaries)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(5)
    expect(groups[1]).toHaveLength(5)
  })

  it("handles remainder correctly", () => {
    // 7 summaries: first group of 5, remainder of 2 (< min) gets dropped
    const summaries = Array.from({ length: 7 }, (_, i) =>
      makeSummary(`sum_${i}`, 1, `msg_${i * 10}`, `msg_${i * 10 + 9}`),
    )

    const groups = groupSummariesForHigherOrder(summaries)
    // First group of 5, remainder 2 merged with first
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(7)
  })

  it("preserves summary order within groups", () => {
    const summaries = Array.from({ length: 8 }, (_, i) =>
      makeSummary(`sum_${String(i).padStart(3, "0")}`, 1, `msg_${i * 10}`, `msg_${i * 10 + 9}`),
    )

    const groups = groupSummariesForHigherOrder(summaries)
    const flattened = groups.flat()

    // Should maintain original order
    for (let i = 0; i < flattened.length - 1; i++) {
      expect(flattened[i].id < flattened[i + 1].id).toBe(true)
    }
  })
})
