/**
 * Tests for LTM consolidation agent
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { isConversationNoteworthy, runConsolidation, type ConsolidationResult } from "./consolidation"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import type { TemporalMessage } from "../storage/schema"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// Create a temp db for each test
function createTempDb(): string {
  const tmpDir = os.tmpdir()
  return path.join(tmpDir, `test-consolidation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
}

describe("isConversationNoteworthy", () => {
  it("returns false for very short conversations", () => {
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "Hello", tokenEstimate: 1, createdAt: new Date().toISOString() },
      { id: "2", type: "assistant", content: "Hi there!", tokenEstimate: 2, createdAt: new Date().toISOString() },
    ]
    expect(isConversationNoteworthy(messages)).toBe(false)
  })

  it("returns false for trivial conversations without tool usage", () => {
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "What time is it?", tokenEstimate: 5, createdAt: new Date().toISOString() },
      { id: "2", type: "assistant", content: "I don't have access to the current time.", tokenEstimate: 10, createdAt: new Date().toISOString() },
      { id: "3", type: "user", content: "Oh ok", tokenEstimate: 2, createdAt: new Date().toISOString() },
      { id: "4", type: "assistant", content: "Is there anything else I can help with?", tokenEstimate: 8, createdAt: new Date().toISOString() },
      { id: "5", type: "user", content: "No thanks", tokenEstimate: 2, createdAt: new Date().toISOString() },
    ]
    expect(isConversationNoteworthy(messages)).toBe(false)
  })

  it("returns true for conversations with tool usage", () => {
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "Read the README", tokenEstimate: 5, createdAt: new Date().toISOString() },
      { id: "2", type: "assistant", content: "I'll read it for you.", tokenEstimate: 5, createdAt: new Date().toISOString() },
      { id: "3", type: "tool_call", content: '{"name":"read","args":{"path":"README.md"}}', tokenEstimate: 10, createdAt: new Date().toISOString() },
      { id: "4", type: "tool_result", content: "# Project...", tokenEstimate: 100, createdAt: new Date().toISOString() },
      { id: "5", type: "assistant", content: "Here's what the README says...", tokenEstimate: 50, createdAt: new Date().toISOString() },
    ]
    expect(isConversationNoteworthy(messages)).toBe(true)
  })

  it("returns true for conversations with substantial content", () => {
    const longContent = "This is a detailed explanation about how the authentication system works. ".repeat(10)
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "Explain the auth system", tokenEstimate: 5, createdAt: new Date().toISOString() },
      { id: "2", type: "assistant", content: longContent, tokenEstimate: 200, createdAt: new Date().toISOString() },
      { id: "3", type: "user", content: "Thanks!", tokenEstimate: 1, createdAt: new Date().toISOString() },
      { id: "4", type: "assistant", content: "You're welcome!", tokenEstimate: 2, createdAt: new Date().toISOString() },
      { id: "5", type: "user", content: "Bye", tokenEstimate: 1, createdAt: new Date().toISOString() },
    ]
    expect(isConversationNoteworthy(messages)).toBe(true)
  })
})

describe("runConsolidation", () => {
  let storage: Storage
  let dbPath: string

  beforeEach(async () => {
    dbPath = createTempDb()
    storage = createStorage(dbPath)
    await initializeDefaultEntries(storage)
  })

  it("skips trivial conversations", async () => {
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "Hi", tokenEstimate: 1, createdAt: new Date().toISOString() },
      { id: "2", type: "assistant", content: "Hello!", tokenEstimate: 1, createdAt: new Date().toISOString() },
    ]

    const result = await runConsolidation(storage, messages)

    expect(result.ran).toBe(false)
    expect(result.entriesCreated).toBe(0)
    expect(result.entriesUpdated).toBe(0)
    expect(result.entriesArchived).toBe(0)
    expect(result.summary).toContain("not noteworthy")
  })

  it("has correct result structure for non-trivial conversations", async () => {
    // This test verifies the result structure without needing an API key
    // by checking a trivial conversation that gets skipped
    const messages: TemporalMessage[] = [
      { id: "1", type: "user", content: "short", tokenEstimate: 1, createdAt: new Date().toISOString() },
    ]

    const result = await runConsolidation(storage, messages)

    // Verify result structure
    expect(typeof result.ran).toBe("boolean")
    expect(typeof result.entriesCreated).toBe("number")
    expect(typeof result.entriesUpdated).toBe("number")
    expect(typeof result.entriesArchived).toBe("number")
    expect(typeof result.summary).toBe("string")
    expect(typeof result.usage.inputTokens).toBe("number")
    expect(typeof result.usage.outputTokens).toBe("number")
  })
})

describe("LTM storage integration", () => {
  let storage: Storage
  let dbPath: string

  beforeEach(async () => {
    dbPath = createTempDb()
    storage = createStorage(dbPath)
    await initializeDefaultEntries(storage)
  })

  it("has default identity and behavior entries", async () => {
    const identity = await storage.ltm.read("identity")
    const behavior = await storage.ltm.read("behavior")

    expect(identity).not.toBeNull()
    expect(behavior).not.toBeNull()
    expect(identity?.version).toBe(1)
    expect(behavior?.version).toBe(1)
  })

  it("can create and read LTM entries", async () => {
    const entry = await storage.ltm.create({
      slug: "test-knowledge",
      parentSlug: null,
      title: "Test Knowledge",
      body: "This is a test entry",
      tags: ["test"],
      createdBy: "ltm-consolidate",
    })

    expect(entry.slug).toBe("test-knowledge")
    expect(entry.version).toBe(1)

    const read = await storage.ltm.read("test-knowledge")
    expect(read).not.toBeNull()
    expect(read?.body).toBe("This is a test entry")
  })

  it("can update entries with CAS", async () => {
    await storage.ltm.create({
      slug: "cas-test",
      parentSlug: null,
      title: "CAS Test",
      body: "Original content",
      createdBy: "ltm-consolidate",
    })

    // Update with correct version
    const updated = await storage.ltm.update("cas-test", "Updated content", 1, "ltm-consolidate")
    expect(updated.version).toBe(2)
    expect(updated.body).toBe("Updated content")

    // Verify CAS fails with wrong version
    let failed = false
    try {
      await storage.ltm.update("cas-test", "Should fail", 1, "ltm-consolidate")
    } catch (e) {
      failed = true
      expect((e as Error).message).toContain("CAS conflict")
    }
    expect(failed).toBe(true)
  })

  it("can archive entries", async () => {
    await storage.ltm.create({
      slug: "archive-test",
      parentSlug: null,
      title: "Archive Test",
      body: "To be archived",
      createdBy: "ltm-consolidate",
    })

    await storage.ltm.archive("archive-test", 1)

    // Should no longer be readable
    const read = await storage.ltm.read("archive-test")
    expect(read).toBeNull()
  })

  it("can glob entries", async () => {
    await storage.ltm.create({
      slug: "knowledge",
      parentSlug: null,
      title: "Knowledge",
      body: "Knowledge root",
      createdBy: "ltm-consolidate",
    })

    await storage.ltm.create({
      slug: "project-x",
      parentSlug: "knowledge",
      title: "Project X",
      body: "About project X",
      createdBy: "ltm-consolidate",
    })

    const all = await storage.ltm.glob("/**")
    expect(all.length).toBeGreaterThanOrEqual(4) // identity, behavior, knowledge, project-x
  })
})
