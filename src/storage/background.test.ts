/**
 * Tests for BackgroundStorage
 */

import {describe, it, expect, beforeEach} from 'bun:test'
import {createInMemoryStorage, type Storage} from './index'

describe('BackgroundStorage', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  describe('fileReport', () => {
    it('creates a report with generated ID', async () => {
      const id = await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {entriesCreated: 2, entriesUpdated: 1},
      })

      expect(id).toMatch(/^rpt_/)
    })

    it('stores report content as JSON', async () => {
      await storage.background.fileReport({
        subsystem: 'distillation',
        report: {tokensBefore: 10000, tokensAfter: 5000},
      })

      const reports = await storage.background.getUnsurfaced()
      expect(reports).toHaveLength(1)
      expect(reports[0].report).toEqual({
        tokensBefore: 10000,
        tokensAfter: 5000,
      })
    })
  })

  describe('getUnsurfaced', () => {
    it('returns empty array when no reports', async () => {
      const reports = await storage.background.getUnsurfaced()
      expect(reports).toEqual([])
    })

    it('returns unsurfaced reports in order', async () => {
      await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {first: true},
      })
      await storage.background.fileReport({
        subsystem: 'distillation',
        report: {second: true},
      })

      const reports = await storage.background.getUnsurfaced()
      expect(reports).toHaveLength(2)
      expect(reports[0].report).toEqual({first: true})
      expect(reports[1].report).toEqual({second: true})
    })

    it('excludes surfaced reports', async () => {
      const id = await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {test: true},
      })
      await storage.background.markSurfaced(id)

      const reports = await storage.background.getUnsurfaced()
      expect(reports).toEqual([])
    })
  })

  describe('markSurfaced', () => {
    it('marks a single report as surfaced', async () => {
      const id = await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {test: true},
      })

      await storage.background.markSurfaced(id)

      const reports = await storage.background.getUnsurfaced()
      expect(reports).toEqual([])
    })
  })

  describe('markManySurfaced', () => {
    it('marks multiple reports as surfaced', async () => {
      const id1 = await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {first: true},
      })
      const id2 = await storage.background.fileReport({
        subsystem: 'distillation',
        report: {second: true},
      })
      await storage.background.fileReport({
        subsystem: 'ltm_curator',
        report: {third: true},
      })

      await storage.background.markManySurfaced([id1, id2])

      const reports = await storage.background.getUnsurfaced()
      expect(reports).toHaveLength(1)
      expect(reports[0].report).toEqual({third: true})
    })

    it('handles empty array', async () => {
      await storage.background.markManySurfaced([])
      // Should not throw
    })
  })
})
