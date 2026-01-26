/**
 * Storage module for miriad-code
 *
 * All database access goes through this interface.
 * No raw SQL leaks out of this module.
 */

import { createDb, createInMemoryDb, initializeSchema, getRawConnection, type DrizzleDB } from "./db"
import { runMigrations } from "./migrate"
import {
  createTemporalStorage,
  type TemporalStorage,
  type TemporalSearchParams,
  type TemporalSearchResult,
  type FTSSearchResult,
  type MessageWithContextParams,
} from "./temporal"
import {
  createPresentStorage,
  type PresentStorage,
  type PresentState,
  type Task,
} from "./present"
import {
  createLTMStorage,
  type LTMStorage,
  type LTMCreateInput,
  type LTMSearchResult,
  type LTMFTSSearchResult,
  type AgentType,
  ConflictError,
} from "./ltm"
import { createWorkerStorage, type WorkerStorage, type WorkerType, type WorkerStatus } from "./worker"
import { createSessionStorage, type SessionStorage } from "./session"
import { createBackgroundStorage, type BackgroundStorage, type BackgroundReport, type BackgroundReportInput } from "./background"

// Re-export types
export type {
  TemporalStorage,
  TemporalSearchParams,
  TemporalSearchResult,
  FTSSearchResult,
  MessageWithContextParams,
  PresentStorage,
  PresentState,
  Task,
  LTMStorage,
  LTMCreateInput,
  LTMSearchResult,
  LTMFTSSearchResult,
  AgentType,
  WorkerStorage,
  WorkerType,
  WorkerStatus,
  SessionStorage,
  BackgroundStorage,
  BackgroundReport,
  BackgroundReportInput,
}

export { ConflictError }

// Re-export schema types
export type {
  TemporalMessage,
  TemporalMessageInsert,
  TemporalSummary,
  TemporalSummaryInsert,
  LTMEntry,
  LTMEntryInsert,
  Worker,
  WorkerInsert,
} from "./schema"

/**
 * The Storage interface - all access through here
 */
export interface Storage {
  temporal: TemporalStorage
  present: PresentStorage
  ltm: LTMStorage
  workers: WorkerStorage
  session: SessionStorage
  background: BackgroundStorage
}

/**
 * Extended storage with database access for testing/verification.
 */
export interface StorageWithDb extends Storage {
  _db: DrizzleDB
}

/**
 * Create a Storage instance backed by SQLite.
 *
 * @param dbPath - Path to the SQLite database file
 * @param options - Optional configuration
 */
export function createStorage(
  dbPath: string,
  options?: { initialize?: boolean },
): StorageWithDb {
  // Ensure parent directory exists
  const { mkdirSync } = require("fs")
  const { dirname } = require("path")
  mkdirSync(dirname(dbPath), { recursive: true })
  
  const db = createDb(dbPath)

  if (options?.initialize !== false) {
    // Run migrations to ensure schema is up to date
    runMigrations(db._rawDb)
  }

  return createStorageFromDb(db)
}

/**
 * Create an in-memory Storage instance for testing.
 */
export function createInMemoryStorage(): StorageWithDb {
  const db = createInMemoryDb()
  initializeSchema(db)
  return createStorageFromDb(db)
}

function createStorageFromDb(db: DrizzleDB): StorageWithDb {
  return {
    temporal: createTemporalStorage(db),
    present: createPresentStorage(db),
    ltm: createLTMStorage(db),
    workers: createWorkerStorage(db),
    session: createSessionStorage(db as any),
    background: createBackgroundStorage(db),
    _db: db,
  }
}

export { getRawConnection }

/**
 * Clean up stale workers from a previous crashed session.
 * 
 * If the process was killed while workers were running, their status
 * will be stuck as "running" in the database. This prevents new
 * compaction/consolidation from triggering.
 * 
 * Call this on startup before running any agents.
 */
export async function cleanupStaleWorkers(storage: Storage): Promise<number> {
  const cleaned = await storage.workers.failAllRunning("Process terminated unexpectedly")
  return cleaned
}

/**
 * Initialize default LTM entries (/identity and /behavior).
 *
 * These special entries are always included in the system prompt.
 * Called on first run or when the entries don't exist.
 */
export async function initializeDefaultEntries(storage: Storage): Promise<void> {
  // Check if /identity exists
  const identity = await storage.ltm.read("identity")
  if (!identity) {
    await storage.ltm.create({
      slug: "identity",
      parentSlug: null,
      title: "Identity",
      body: `# Identity

I am a coding assistant with persistent memory.

My memory spans across conversations, allowing me to:
- Remember past decisions and their rationale
- Track ongoing projects and their state
- Learn your preferences and coding style
- Maintain context about the codebase we're working on

Update this entry to customize who I am.`,
      createdBy: "main",
    })
  }

  // Check if /behavior exists
  const behavior = await storage.ltm.read("behavior")
  if (!behavior) {
    await storage.ltm.create({
      slug: "behavior",
      parentSlug: null,
      title: "Behavior",
      body: `# Behavior

Guidelines for how I should operate:

- Always check for existing tests before modifying code
- Prefer editing existing files over creating new ones
- Ask clarifying questions when requirements are ambiguous
- Explain significant changes before making them
- Keep commits atomic and well-described

Update this entry to customize how I behave.`,
      createdBy: "main",
    })
  }
}
