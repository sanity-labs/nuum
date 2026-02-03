/**
 * Tests for temporal view construction.
 *
 * Key invariant: The ENTIRE history is always represented in the view.
 * Old content is recursively summarized, recent content is raw messages.
 * The budget is informational only - if exceeded, compaction triggers,
 * but content is NEVER dropped from the view.
 */

import {describe, it, expect} from 'bun:test'
import {buildTemporalView, type TemporalView} from './view'
import type {TemporalMessage, TemporalSummary} from '../storage/schema'

// Helper to create message objects for testing
function makeMessage(
  id: string,
  content: string,
  tokenEstimate: number,
  type: TemporalMessage['type'] = 'user',
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
  narrative: string = 'Summary narrative',
  keyObservations: string[] = [],
): TemporalSummary {
  return {
    id,
    orderNum: order,
    startId,
    endId,
    narrative,
    keyObservations: JSON.stringify(keyObservations),
    tags: '[]',
    tokenEstimate,
    createdAt: new Date().toISOString(),
  }
}

describe('buildTemporalView', () => {
  describe('empty history', () => {
    it('returns empty view for empty history', () => {
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

  describe('messages only (no summaries)', () => {
    it('returns only raw messages when no summaries exist', () => {
      const messages = [
        makeMessage('msg_001', 'Hello', 10),
        makeMessage('msg_002', 'World', 10),
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

    it('includes ALL messages regardless of budget', () => {
      // Budget is informational only - never drops content
      const messages = [
        makeMessage('msg_001', 'a', 20),
        makeMessage('msg_002', 'b', 20),
        makeMessage('msg_003', 'c', 20),
      ]

      const result = buildTemporalView({
        budget: 100, // Would be exceeded, but we don't drop
        messages,
        summaries: [],
      })

      expect(result.messages).toHaveLength(3)
      expect(result.breakdown.messageTokens).toBe(60)
      // totalTokens may exceed budget - that's expected
      expect(result.totalTokens).toBe(60)
    })

    it('returns messages in chronological order', () => {
      const messages = [
        makeMessage('msg_003', 'new', 20),
        makeMessage('msg_001', 'old', 20), // Out of order in input
        makeMessage('msg_002', 'mid', 20),
      ]

      const result = buildTemporalView({
        budget: 100,
        messages,
        summaries: [],
      })

      expect(result.messages).toHaveLength(3)
      expect(result.messages.map((m) => m.id)).toEqual([
        'msg_001',
        'msg_002',
        'msg_003',
      ])
    })
  })

  describe('mixed summaries and messages', () => {
    it('returns mixed summaries + messages when both exist', () => {
      const messages = [
        makeMessage('msg_020', 'recent', 10),
        makeMessage('msg_021', 'very recent', 10),
      ]
      const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010', 50)]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      expect(result.summaries).toHaveLength(1)
      expect(result.messages).toHaveLength(2)
    })

    it('returns chronological order', () => {
      const messages = [
        makeMessage('msg_030', 'third', 10),
        makeMessage('msg_020', 'second', 10), // Out of order in input
        makeMessage('msg_040', 'fourth', 10),
      ]
      const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010', 50)]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // Messages should be in chronological order
      expect(result.messages.map((m) => m.id)).toEqual([
        'msg_020',
        'msg_030',
        'msg_040',
      ])
      // Summaries should be in chronological order (by startId)
      expect(result.summaries[0].startId).toBe('msg_001')
    })
  })

  describe('budget is informational only', () => {
    it('may exceed budget - signals compaction needed', () => {
      const messages = [
        makeMessage('msg_001', 'a', 100),
        makeMessage('msg_002', 'b', 100),
      ]
      const summaries = [makeSummary('sum_001', 1, 'msg_000', 'msg_000', 100)]

      const result = buildTemporalView({
        budget: 150, // Would be exceeded
        messages,
        summaries,
      })

      // All content included even though it exceeds budget
      expect(result.summaries).toHaveLength(1)
      expect(result.messages).toHaveLength(2)
      expect(result.totalTokens).toBe(300) // 100 + 100 + 100
    })

    it('includes all summaries and messages regardless of budget', () => {
      const messages = [
        makeMessage('msg_100', 'a', 10),
        makeMessage('msg_101', 'b', 10),
        makeMessage('msg_102', 'c', 10),
        makeMessage('msg_103', 'd', 10),
        makeMessage('msg_104', 'e', 10), // 50 tokens total
      ]
      const summaries = [
        makeSummary('sum_001', 1, 'msg_001', 'msg_010', 30),
        makeSummary('sum_002', 1, 'msg_011', 'msg_020', 30), // 60 tokens total
      ]

      const result = buildTemporalView({
        budget: 50, // Tiny budget - doesn't matter
        messages,
        summaries,
      })

      // All content included
      expect(result.messages).toHaveLength(5)
      expect(result.summaries).toHaveLength(2)
      expect(result.breakdown.messageTokens).toBe(50)
      expect(result.breakdown.summaryTokens).toBe(60)
      expect(result.totalTokens).toBe(110)
    })

    it('never drops messages - full history always represented', () => {
      const messages = [
        makeMessage('msg_001', 'oldest', 15),
        makeMessage('msg_002', 'older', 15),
        makeMessage('msg_003', 'newer', 15),
        makeMessage('msg_004', 'newest', 15),
      ]

      const result = buildTemporalView({
        budget: 10, // Very small budget - still includes everything
        messages,
        summaries: [],
      })

      // All messages included in chronological order
      expect(result.messages).toHaveLength(4)
      expect(result.messages.map((m) => m.id)).toEqual([
        'msg_001',
        'msg_002',
        'msg_003',
        'msg_004',
      ])
    })

    it('includes all messages regardless of age', () => {
      const messages = [
        makeMessage('msg_001', 'old', 5),
        makeMessage('msg_100', 'very recent', 5),
      ]

      const result = buildTemporalView({
        budget: 1, // Tiny budget
        messages,
        summaries: [],
      })

      // Both messages included
      expect(result.messages).toHaveLength(2)
      expect(result.messages.map((m) => m.id)).toContain('msg_001')
      expect(result.messages.map((m) => m.id)).toContain('msg_100')
    })
  })

  describe('coverage/subsumption', () => {
    it('skips messages covered by summaries', () => {
      const messages = [
        makeMessage('msg_005', 'covered', 10),
        makeMessage('msg_015', 'not covered', 10),
      ]
      const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010', 50)]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // msg_005 is covered by summary, should be excluded
      expect(result.messages.map((m) => m.id)).not.toContain('msg_005')
      expect(result.messages.map((m) => m.id)).toContain('msg_015')
    })

    it('skips summaries subsumed by higher-order summaries', () => {
      const order1 = makeSummary('sum_001', 1, 'msg_001', 'msg_020', 30)
      const order2 = makeSummary('sum_002', 2, 'msg_001', 'msg_020', 20)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [order1, order2],
      })

      // order1 is subsumed by order2, should be excluded
      expect(result.summaries.map((s) => s.id)).not.toContain('sum_001')
      expect(result.summaries.map((s) => s.id)).toContain('sum_002')
    })

    it('includes order-2 but excludes its order-1 children', () => {
      const order1a = makeSummary('sum_001', 1, 'msg_001', 'msg_010', 30)
      const order1b = makeSummary('sum_002', 1, 'msg_011', 'msg_020', 30)
      const order1c = makeSummary('sum_003', 1, 'msg_021', 'msg_030', 30) // Not subsumed
      const order2 = makeSummary('sum_004', 2, 'msg_001', 'msg_020', 50)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [order1a, order1b, order1c, order2],
      })

      // order1a and order1b subsumed by order2
      expect(result.summaries.map((s) => s.id)).not.toContain('sum_001')
      expect(result.summaries.map((s) => s.id)).not.toContain('sum_002')
      // order1c and order2 included
      expect(result.summaries.map((s) => s.id)).toContain('sum_003')
      expect(result.summaries.map((s) => s.id)).toContain('sum_004')
    })

    it('handles gaps between summary ranges — includes uncovered messages', () => {
      const messages = [
        makeMessage('msg_005', 'covered', 10),
        makeMessage('msg_015', 'in gap', 10), // Between summaries
        makeMessage('msg_025', 'covered', 10),
      ]
      const summaries = [
        makeSummary('sum_001', 1, 'msg_001', 'msg_010', 50),
        makeSummary('sum_002', 1, 'msg_020', 'msg_030', 50),
      ]

      const result = buildTemporalView({
        budget: 1000,
        messages,
        summaries,
      })

      // Only msg_015 should be included (others covered by summaries)
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].id).toBe('msg_015')
    })
  })

  describe('summary subsumption', () => {
    it('excludes lower-order summaries when subsumed by higher-order', () => {
      const order1 = makeSummary('sum_001', 1, 'msg_001', 'msg_010', 100)
      const order2 = makeSummary('sum_002', 2, 'msg_001', 'msg_010', 50)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [order1, order2],
      })

      // order1 is subsumed by order2 (same range, higher order)
      expect(result.summaries.map((s) => s.id)).toContain('sum_002')
      expect(result.summaries.map((s) => s.id)).not.toContain('sum_001')
    })

    it('includes both summaries when not subsumed (non-overlapping)', () => {
      const older = makeSummary('sum_001', 1, 'msg_001', 'msg_010', 40)
      const newer = makeSummary('sum_002', 1, 'msg_011', 'msg_020', 40)

      const result = buildTemporalView({
        budget: 1000,
        messages: [],
        summaries: [older, newer],
      })

      // Neither is subsumed - both included
      expect(result.summaries).toHaveLength(2)
      expect(result.summaries.map((s) => s.id)).toContain('sum_001')
      expect(result.summaries.map((s) => s.id)).toContain('sum_002')
    })
  })
})
