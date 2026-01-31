import {describe, test, expect, beforeEach} from 'bun:test'
import {createInMemoryStorage, type Storage} from './index'

describe('Full-Text Search', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  describe('Temporal Messages FTS', () => {
    test('searchFTS finds messages by keyword', async () => {
      // Add some messages
      await storage.temporal.appendMessage({
        id: 'msg_001',
        type: 'user',
        content: 'Can you help me refactor the authentication module?',
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      })
      await storage.temporal.appendMessage({
        id: 'msg_002',
        type: 'assistant',
        content: "I'll help you refactor the authentication code.",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      })
      await storage.temporal.appendMessage({
        id: 'msg_003',
        type: 'user',
        content: "Now let's work on the database layer.",
        tokenEstimate: 10,
        createdAt: new Date().toISOString(),
      })

      // Search for authentication
      const results = await storage.temporal.searchFTS('authentication')

      expect(results.length).toBe(2)
      expect(results.some((r) => r.id === 'msg_001')).toBe(true)
      expect(results.some((r) => r.id === 'msg_002')).toBe(true)
    })

    test('searchFTS returns snippets with match markers', async () => {
      await storage.temporal.appendMessage({
        id: 'msg_001',
        type: 'user',
        content:
          'The protocol implementation needs to handle JSON-RPC messages correctly.',
        tokenEstimate: 15,
        createdAt: new Date().toISOString(),
      })

      const results = await storage.temporal.searchFTS('protocol')

      expect(results.length).toBe(1)
      expect(results[0].snippet).toContain('>>>')
      expect(results[0].snippet).toContain('<<<')
    })

    test('searchFTS respects limit parameter', async () => {
      // Add many messages
      for (let i = 0; i < 10; i++) {
        await storage.temporal.appendMessage({
          id: `msg_${i.toString().padStart(3, '0')}`,
          type: 'user',
          content: `Message about testing number ${i}`,
          tokenEstimate: 5,
          createdAt: new Date().toISOString(),
        })
      }

      const results = await storage.temporal.searchFTS('testing', 3)
      expect(results.length).toBe(3)
    })

    test('searchFTS returns empty array for no matches', async () => {
      await storage.temporal.appendMessage({
        id: 'msg_001',
        type: 'user',
        content: 'Hello world',
        tokenEstimate: 5,
        createdAt: new Date().toISOString(),
      })

      const results = await storage.temporal.searchFTS('nonexistent')
      expect(results.length).toBe(0)
    })
  })

  describe('getMessage with context', () => {
    beforeEach(async () => {
      // Add a sequence of messages
      for (let i = 1; i <= 10; i++) {
        await storage.temporal.appendMessage({
          id: `msg_${i.toString().padStart(3, '0')}`,
          type: i % 2 === 1 ? 'user' : 'assistant',
          content: `Message number ${i}`,
          tokenEstimate: 5,
          createdAt: new Date().toISOString(),
        })
      }
    })

    test('getMessage returns single message', async () => {
      const msg = await storage.temporal.getMessage('msg_005')
      expect(msg).not.toBeNull()
      expect(msg!.content).toBe('Message number 5')
    })

    test('getMessage returns null for non-existent ID', async () => {
      const msg = await storage.temporal.getMessage('msg_999')
      expect(msg).toBeNull()
    })

    test('getMessageWithContext returns message with context before', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_005',
        contextBefore: 2,
      })

      expect(messages.length).toBe(3)
      expect(messages[0].id).toBe('msg_003')
      expect(messages[1].id).toBe('msg_004')
      expect(messages[2].id).toBe('msg_005')
    })

    test('getMessageWithContext returns message with context after', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_005',
        contextAfter: 2,
      })

      expect(messages.length).toBe(3)
      expect(messages[0].id).toBe('msg_005')
      expect(messages[1].id).toBe('msg_006')
      expect(messages[2].id).toBe('msg_007')
    })

    test('getMessageWithContext returns message with context both sides', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_005',
        contextBefore: 2,
        contextAfter: 2,
      })

      expect(messages.length).toBe(5)
      expect(messages[0].id).toBe('msg_003')
      expect(messages[2].id).toBe('msg_005')
      expect(messages[4].id).toBe('msg_007')
    })

    test('getMessageWithContext handles edge cases at start', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_002',
        contextBefore: 5, // Only 1 message before
      })

      expect(messages.length).toBe(2)
      expect(messages[0].id).toBe('msg_001')
      expect(messages[1].id).toBe('msg_002')
    })

    test('getMessageWithContext handles edge cases at end', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_009',
        contextAfter: 5, // Only 1 message after
      })

      expect(messages.length).toBe(2)
      expect(messages[0].id).toBe('msg_009')
      expect(messages[1].id).toBe('msg_010')
    })

    test('getMessageWithContext returns empty for non-existent ID', async () => {
      const messages = await storage.temporal.getMessageWithContext({
        id: 'msg_999',
        contextBefore: 2,
        contextAfter: 2,
      })

      expect(messages.length).toBe(0)
    })
  })

  describe('LTM FTS', () => {
    test('searchFTS finds entries by keyword', async () => {
      await storage.ltm.create({
        slug: 'protocol',
        parentSlug: null,
        title: 'Protocol Implementation',
        body: 'The JSON-RPC protocol handles message passing between client and server.',
        createdBy: 'main',
      })
      await storage.ltm.create({
        slug: 'tools',
        parentSlug: null,
        title: 'Tool System',
        body: 'Tools are defined using Zod schemas for parameter validation.',
        createdBy: 'main',
      })

      const results = await storage.ltm.searchFTS('protocol')

      expect(results.length).toBe(1)
      expect(results[0].slug).toBe('protocol')
    })

    test('searchFTS searches both title and body', async () => {
      await storage.ltm.create({
        slug: 'entry1',
        parentSlug: null,
        title: 'Authentication Module',
        body: 'Handles user login and session management.',
        createdBy: 'main',
      })
      await storage.ltm.create({
        slug: 'entry2',
        parentSlug: null,
        title: 'Database Layer',
        body: 'The authentication tokens are stored here.',
        createdBy: 'main',
      })

      const results = await storage.ltm.searchFTS('authentication')

      expect(results.length).toBe(2)
    })

    test('searchFTS excludes archived entries', async () => {
      const entry = await storage.ltm.create({
        slug: 'archived-entry',
        parentSlug: null,
        title: 'Old Protocol',
        body: 'This protocol is deprecated.',
        createdBy: 'main',
      })

      await storage.ltm.archive('archived-entry', entry.version)

      const results = await storage.ltm.searchFTS('protocol')
      expect(results.length).toBe(0)
    })

    test('searchFTS returns snippets with match markers', async () => {
      await storage.ltm.create({
        slug: 'test-entry',
        parentSlug: null,
        title: 'Test Entry',
        body: 'This is a test entry about the reflection system and how it works.',
        createdBy: 'main',
      })

      const results = await storage.ltm.searchFTS('reflection')

      expect(results.length).toBe(1)
      expect(results[0].snippet).toContain('>>>')
      expect(results[0].snippet).toContain('<<<')
    })
  })
})
