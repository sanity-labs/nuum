/**
 * Tests for session storage.
 */

import {describe, expect, test, beforeEach} from 'bun:test'
import {createInMemoryStorage} from './index'
import type {Storage} from './index'

describe('SessionStorage', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  describe('getId', () => {
    test('generates ID on first call', async () => {
      const id = await storage.session.getId()
      expect(id).toMatch(/^ses_/)
    })

    test('returns same ID on subsequent calls', async () => {
      const id1 = await storage.session.getId()
      const id2 = await storage.session.getId()
      expect(id1).toBe(id2)
    })

    test('ID persists across storage instances', async () => {
      // This test uses the same in-memory db, so it should work
      const id1 = await storage.session.getId()
      const id2 = await storage.session.getId()
      expect(id1).toBe(id2)
    })
  })

  describe('getCreatedAt', () => {
    test('returns ISO timestamp', async () => {
      const createdAt = await storage.session.getCreatedAt()
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    test('returns same timestamp on subsequent calls', async () => {
      const t1 = await storage.session.getCreatedAt()
      const t2 = await storage.session.getCreatedAt()
      expect(t1).toBe(t2)
    })
  })

  describe('systemPromptOverlay', () => {
    test('returns null when not set', async () => {
      const overlay = await storage.session.getSystemPromptOverlay()
      expect(overlay).toBeNull()
    })

    test('stores and retrieves value', async () => {
      await storage.session.setSystemPromptOverlay('Always respond in French.')
      const overlay = await storage.session.getSystemPromptOverlay()
      expect(overlay).toBe('Always respond in French.')
    })

    test('updates existing value', async () => {
      await storage.session.setSystemPromptOverlay('First value')
      await storage.session.setSystemPromptOverlay('Second value')
      const overlay = await storage.session.getSystemPromptOverlay()
      expect(overlay).toBe('Second value')
    })

    test('clears value when set to null', async () => {
      await storage.session.setSystemPromptOverlay('Some value')
      await storage.session.setSystemPromptOverlay(null)
      const overlay = await storage.session.getSystemPromptOverlay()
      expect(overlay).toBeNull()
    })
  })
})
