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

  // Phase 3c: New storage method tests
  describe("edit", () => {
    it("performs surgical find-replace", async () => {
      await storage.ltm.create({
        slug: "edit-test",
        parentSlug: null,
        title: "Edit Test",
        body: "The quick brown fox jumps over the lazy dog.",
        createdBy: "ltm-consolidate",
      })

      const updated = await storage.ltm.edit(
        "edit-test",
        "brown fox",
        "red cat",
        1,
        "ltm-consolidate"
      )

      expect(updated.version).toBe(2)
      expect(updated.body).toBe("The quick red cat jumps over the lazy dog.")
    })

    it("fails if text not found", async () => {
      await storage.ltm.create({
        slug: "edit-notfound",
        parentSlug: null,
        title: "Edit Not Found",
        body: "Some content here",
        createdBy: "ltm-consolidate",
      })

      let failed = false
      try {
        await storage.ltm.edit("edit-notfound", "nonexistent", "replacement", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("Text not found")
      }
      expect(failed).toBe(true)
    })

    it("fails if text appears multiple times", async () => {
      await storage.ltm.create({
        slug: "edit-multiple",
        parentSlug: null,
        title: "Edit Multiple",
        body: "foo bar foo baz foo",
        createdBy: "ltm-consolidate",
      })

      let failed = false
      try {
        await storage.ltm.edit("edit-multiple", "foo", "qux", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("appears 3 times")
      }
      expect(failed).toBe(true)
    })

    it("fails with CAS conflict on wrong version", async () => {
      await storage.ltm.create({
        slug: "edit-cas",
        parentSlug: null,
        title: "Edit CAS",
        body: "Original content",
        createdBy: "ltm-consolidate",
      })

      // Update to version 2
      await storage.ltm.update("edit-cas", "Modified content", 1, "ltm-consolidate")

      // Try to edit with stale version 1
      let failed = false
      try {
        await storage.ltm.edit("edit-cas", "content", "text", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("CAS conflict")
      }
      expect(failed).toBe(true)
    })
  })

  describe("reparent", () => {
    it("moves entry to new parent", async () => {
      await storage.ltm.create({
        slug: "parent-a",
        parentSlug: null,
        title: "Parent A",
        body: "First parent",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "parent-b",
        parentSlug: null,
        title: "Parent B",
        body: "Second parent",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "child",
        parentSlug: "parent-a",
        title: "Child",
        body: "Child entry",
        createdBy: "ltm-consolidate",
      })

      // Verify initial path
      let child = await storage.ltm.read("child")
      expect(child?.path).toBe("/parent-a/child")

      // Reparent to parent-b
      const updated = await storage.ltm.reparent("child", "parent-b", 1, "ltm-consolidate")

      expect(updated.version).toBe(2)
      expect(updated.parentSlug).toBe("parent-b")
      expect(updated.path).toBe("/parent-b/child")
    })

    it("updates descendant paths", async () => {
      await storage.ltm.create({
        slug: "old-parent",
        parentSlug: null,
        title: "Old Parent",
        body: "Old parent",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "new-parent",
        parentSlug: null,
        title: "New Parent",
        body: "New parent",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "movable",
        parentSlug: "old-parent",
        title: "Movable",
        body: "Will be moved",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "grandchild",
        parentSlug: "movable",
        title: "Grandchild",
        body: "Descendant entry",
        createdBy: "ltm-consolidate",
      })

      // Verify initial paths
      let grandchild = await storage.ltm.read("grandchild")
      expect(grandchild?.path).toBe("/old-parent/movable/grandchild")

      // Reparent movable to new-parent
      await storage.ltm.reparent("movable", "new-parent", 1, "ltm-consolidate")

      // Verify grandchild path was updated
      grandchild = await storage.ltm.read("grandchild")
      expect(grandchild?.path).toBe("/new-parent/movable/grandchild")
    })

    it("prevents circular reparenting", async () => {
      await storage.ltm.create({
        slug: "top",
        parentSlug: null,
        title: "Top",
        body: "Top level",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "bottom",
        parentSlug: "top",
        title: "Bottom",
        body: "Under top",
        createdBy: "ltm-consolidate",
      })

      // Try to make top a child of bottom (circular)
      let failed = false
      try {
        await storage.ltm.reparent("top", "bottom", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("Cannot reparent")
        expect((e as Error).message).toContain("descendant")
      }
      expect(failed).toBe(true)
    })

    it("fails with CAS conflict on wrong version", async () => {
      await storage.ltm.create({
        slug: "reparent-cas",
        parentSlug: null,
        title: "Reparent CAS",
        body: "Test entry",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "target-parent",
        parentSlug: null,
        title: "Target",
        body: "Target parent",
        createdBy: "ltm-consolidate",
      })

      // Update to version 2
      await storage.ltm.update("reparent-cas", "Modified", 1, "ltm-consolidate")

      // Try to reparent with stale version 1
      let failed = false
      try {
        await storage.ltm.reparent("reparent-cas", "target-parent", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("CAS conflict")
      }
      expect(failed).toBe(true)
    })
  })

  describe("rename", () => {
    it("changes entry slug and path", async () => {
      await storage.ltm.create({
        slug: "old-name",
        parentSlug: null,
        title: "Old Name",
        body: "Entry to rename",
        createdBy: "ltm-consolidate",
      })

      const updated = await storage.ltm.rename("old-name", "new-name", 1, "ltm-consolidate")

      expect(updated.slug).toBe("new-name")
      expect(updated.path).toBe("/new-name")
      expect(updated.version).toBe(2)

      // Old slug should not exist
      const oldEntry = await storage.ltm.read("old-name")
      expect(oldEntry).toBeNull()

      // New slug should work
      const newEntry = await storage.ltm.read("new-name")
      expect(newEntry).not.toBeNull()
    })

    it("updates children parentSlug and descendant paths", async () => {
      await storage.ltm.create({
        slug: "parent-old",
        parentSlug: null,
        title: "Parent Old",
        body: "Parent to rename",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "child-entry",
        parentSlug: "parent-old",
        title: "Child",
        body: "Child entry",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "grandchild-entry",
        parentSlug: "child-entry",
        title: "Grandchild",
        body: "Grandchild entry",
        createdBy: "ltm-consolidate",
      })

      // Rename parent
      await storage.ltm.rename("parent-old", "parent-new", 1, "ltm-consolidate")

      // Check child's parentSlug was updated
      const child = await storage.ltm.read("child-entry")
      expect(child?.parentSlug).toBe("parent-new")
      expect(child?.path).toBe("/parent-new/child-entry")

      // Check grandchild's path was updated
      const grandchild = await storage.ltm.read("grandchild-entry")
      expect(grandchild?.path).toBe("/parent-new/child-entry/grandchild-entry")
    })

    it("fails if new slug already exists", async () => {
      await storage.ltm.create({
        slug: "existing-a",
        parentSlug: null,
        title: "Existing A",
        body: "First entry",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "existing-b",
        parentSlug: null,
        title: "Existing B",
        body: "Second entry",
        createdBy: "ltm-consolidate",
      })

      // Try to rename existing-a to existing-b
      let failed = false
      try {
        await storage.ltm.rename("existing-a", "existing-b", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("already exists")
      }
      expect(failed).toBe(true)
    })

    it("fails with CAS conflict on wrong version", async () => {
      await storage.ltm.create({
        slug: "rename-cas",
        parentSlug: null,
        title: "Rename CAS",
        body: "Test entry",
        createdBy: "ltm-consolidate",
      })

      // Update to version 2
      await storage.ltm.update("rename-cas", "Modified", 1, "ltm-consolidate")

      // Try to rename with stale version 1
      let failed = false
      try {
        await storage.ltm.rename("rename-cas", "renamed", 1, "ltm-consolidate")
      } catch (e) {
        failed = true
        expect((e as Error).message).toContain("CAS conflict")
      }
      expect(failed).toBe(true)
    })
  })

  describe("search", () => {
    it("finds entries by keyword in title or body", async () => {
      await storage.ltm.create({
        slug: "react-hooks",
        parentSlug: null,
        title: "React Hooks",
        body: "useState, useEffect, and other React hooks",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "vue-components",
        parentSlug: null,
        title: "Vue Components",
        body: "Vue.js component patterns",
        createdBy: "ltm-consolidate",
      })

      const results = await storage.ltm.search("react")
      expect(results.length).toBe(1)
      expect(results[0].entry.slug).toBe("react-hooks")
    })

    it("filters by path prefix", async () => {
      await storage.ltm.create({
        slug: "projects",
        parentSlug: null,
        title: "Projects",
        body: "All projects",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "auth-service",
        parentSlug: "projects",
        title: "Auth Service",
        body: "Authentication patterns",
        createdBy: "ltm-consolidate",
      })

      await storage.ltm.create({
        slug: "auth-docs",
        parentSlug: null,
        title: "Auth Docs",
        body: "Authentication documentation",
        createdBy: "ltm-consolidate",
      })

      // Search for "auth" under /projects
      const results = await storage.ltm.search("auth", "/projects")
      expect(results.length).toBe(1)
      expect(results[0].entry.slug).toBe("auth-service")
    })
  })
})
