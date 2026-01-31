/**
 * Tests for coverage detection functions.
 *
 * ULID range semantics (from arch spec):
 * - startId and endId are INCLUSIVE
 * - A message is covered if: message.id >= summary.startId AND message.id <= summary.endId
 */

import {describe, it, expect} from 'bun:test'
import {isCoveredBySummary, isSubsumedByHigherOrder} from './coverage'
import type {TemporalSummary} from '../storage/schema'

// Helper to create minimal summary objects for testing
function makeSummary(
  id: string,
  order: number,
  startId: string,
  endId: string,
): Pick<TemporalSummary, 'id' | 'orderNum' | 'startId' | 'endId'> {
  return {id, orderNum: order, startId, endId}
}

describe('isCoveredBySummary', () => {
  it('returns false when no summaries exist', () => {
    expect(isCoveredBySummary('msg_001', [])).toBe(false)
  })

  it('returns true for message within summary range (inclusive start)', () => {
    const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010')]
    expect(isCoveredBySummary('msg_001', summaries)).toBe(true)
  })

  it('returns true for message within summary range (inclusive end)', () => {
    const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010')]
    expect(isCoveredBySummary('msg_010', summaries)).toBe(true)
  })

  it('returns true for message in middle of summary range', () => {
    const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010')]
    expect(isCoveredBySummary('msg_005', summaries)).toBe(true)
  })

  it('returns false for message before summary range', () => {
    const summaries = [makeSummary('sum_001', 1, 'msg_010', 'msg_020')]
    expect(isCoveredBySummary('msg_005', summaries)).toBe(false)
  })

  it('returns false for message after summary range', () => {
    const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010')]
    expect(isCoveredBySummary('msg_015', summaries)).toBe(false)
  })

  it('returns true when message covered by any of multiple summaries', () => {
    const summaries = [
      makeSummary('sum_001', 1, 'msg_001', 'msg_010'),
      makeSummary('sum_002', 1, 'msg_020', 'msg_030'),
    ]
    expect(isCoveredBySummary('msg_025', summaries)).toBe(true)
  })

  it('returns false for message in gap between summaries', () => {
    const summaries = [
      makeSummary('sum_001', 1, 'msg_001', 'msg_010'),
      makeSummary('sum_002', 1, 'msg_020', 'msg_030'),
    ]
    expect(isCoveredBySummary('msg_015', summaries)).toBe(false)
  })

  it('handles edge case at boundary correctly', () => {
    // msg_010 is the end of first summary, msg_011 should NOT be covered
    const summaries = [makeSummary('sum_001', 1, 'msg_001', 'msg_010')]
    expect(isCoveredBySummary('msg_010', summaries)).toBe(true)
    expect(isCoveredBySummary('msg_011', summaries)).toBe(false)
  })
})

describe('isSubsumedByHigherOrder', () => {
  it('returns false for highest-order summaries (no higher order exists)', () => {
    const summaries = [
      makeSummary('sum_001', 1, 'msg_001', 'msg_010'),
      makeSummary('sum_002', 1, 'msg_011', 'msg_020'),
    ]
    expect(isSubsumedByHigherOrder(summaries[0], summaries)).toBe(false)
  })

  it('returns true when order-2 covers order-1 range exactly', () => {
    const order1 = makeSummary('sum_001', 1, 'msg_001', 'msg_020')
    const order2 = makeSummary('sum_002', 2, 'msg_001', 'msg_020')
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(true)
    expect(isSubsumedByHigherOrder(order2, summaries)).toBe(false)
  })

  it('returns true when higher-order summary fully contains range', () => {
    const order1 = makeSummary('sum_001', 1, 'msg_005', 'msg_015')
    const order2 = makeSummary('sum_002', 2, 'msg_001', 'msg_020')
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(true)
  })

  it('returns false when higher-order summary only partially overlaps', () => {
    const order1 = makeSummary('sum_001', 1, 'msg_001', 'msg_020')
    const order2 = makeSummary('sum_002', 2, 'msg_010', 'msg_030') // Only covers part
    const summaries = [order1, order2]

    expect(isSubsumedByHigherOrder(order1, summaries)).toBe(false)
  })

  it('returns false for same-order summaries with overlapping ranges', () => {
    const sum1 = makeSummary('sum_001', 1, 'msg_001', 'msg_015')
    const sum2 = makeSummary('sum_002', 1, 'msg_010', 'msg_025')
    const summaries = [sum1, sum2]

    // Same order = not subsumed
    expect(isSubsumedByHigherOrder(sum1, summaries)).toBe(false)
    expect(isSubsumedByHigherOrder(sum2, summaries)).toBe(false)
  })

  it('handles order-3 subsuming order-2 which subsumed order-1', () => {
    const order1a = makeSummary('sum_001', 1, 'msg_001', 'msg_010')
    const order1b = makeSummary('sum_002', 1, 'msg_011', 'msg_020')
    const order2 = makeSummary('sum_003', 2, 'msg_001', 'msg_020')
    const order3 = makeSummary('sum_004', 3, 'msg_001', 'msg_020')
    const summaries = [order1a, order1b, order2, order3]

    expect(isSubsumedByHigherOrder(order1a, summaries)).toBe(true) // By order2 or order3
    expect(isSubsumedByHigherOrder(order1b, summaries)).toBe(true) // By order2 or order3
    expect(isSubsumedByHigherOrder(order2, summaries)).toBe(true) // By order3
    expect(isSubsumedByHigherOrder(order3, summaries)).toBe(false) // Highest
  })

  it('does not consider a summary to subsume itself', () => {
    const summary = makeSummary('sum_001', 2, 'msg_001', 'msg_020')
    const summaries = [summary]

    expect(isSubsumedByHigherOrder(summary, summaries)).toBe(false)
  })
})
