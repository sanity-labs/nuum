/**
 * Database connection for miriad-code storage
 *
 * SQLite with WAL mode for concurrent read/write access.
 * Background workers can run while the main agent operates.
 *
 * Auto-detects runtime and uses appropriate driver:
 * - Bun: bun:sqlite (native)
 * - Node.js: better-sqlite3
 */

import * as schema from "./schema"

// Type for unified database interface
export interface RawDatabase {
  exec(sql: string): void
  pragma(name: string): unknown
  close(): void
}

export interface DrizzleDB {
  _rawDb: RawDatabase
  // Drizzle query methods are accessed dynamically
  [key: string]: unknown
}

// Detect runtime
const isBun = typeof globalThis.Bun !== "undefined"

// Schema initialization SQL
const INIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS temporal_messages (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    token_estimate INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_temporal_messages_created
  ON temporal_messages(id);

  CREATE TABLE IF NOT EXISTS temporal_summaries (
    id TEXT PRIMARY KEY,
    order_num INTEGER NOT NULL,
    start_id TEXT NOT NULL,
    end_id TEXT NOT NULL,
    narrative TEXT NOT NULL,
    key_observations TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    token_estimate INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_temporal_summaries_order
  ON temporal_summaries(order_num, id);

  CREATE INDEX IF NOT EXISTS idx_temporal_summaries_range
  ON temporal_summaries(start_id, end_id);

  CREATE TABLE IF NOT EXISTS present_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    mission TEXT,
    status TEXT,
    tasks TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS ltm_entries (
    slug TEXT PRIMARY KEY,
    parent_slug TEXT,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    links TEXT NOT NULL DEFAULT '[]',
    version INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ltm_entries_path
  ON ltm_entries(path);

  CREATE INDEX IF NOT EXISTS idx_ltm_entries_parent
  ON ltm_entries(parent_slug);

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    error TEXT
  );
`

/**
 * Create a SQLite database connection with WAL mode enabled.
 * Auto-detects Bun vs Node.js runtime.
 */
export function createDb(dbPath: string): DrizzleDB {
  if (isBun) {
    return createBunDb(dbPath)
  }
  return createNodeDb(dbPath)
}

/**
 * Create an in-memory database for testing.
 */
export function createInMemoryDb(): DrizzleDB {
  if (isBun) {
    return createBunDb(":memory:")
  }
  return createNodeDb(":memory:")
}

/**
 * Create database using bun:sqlite
 */
function createBunDb(dbPath: string): DrizzleDB {
  // Dynamic import for bun:sqlite
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BunDatabase = require("bun:sqlite").default
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/bun-sqlite")

  const sqlite = new BunDatabase(dbPath)

  if (dbPath !== ":memory:") {
    // Enable WAL mode for concurrent access
    sqlite.exec("PRAGMA journal_mode=WAL")
    // Wait up to 5s for locks
    sqlite.exec("PRAGMA busy_timeout=5000")
  }
  // Enable foreign key enforcement
  sqlite.exec("PRAGMA foreign_keys=ON")

  const db = drizzle(sqlite, { schema })
  db._rawDb = sqlite
  return db as DrizzleDB
}

/**
 * Create database using better-sqlite3 (Node.js)
 */
function createNodeDb(dbPath: string): DrizzleDB {
  // Dynamic import for better-sqlite3
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/better-sqlite3")

  const sqlite = new Database(dbPath)

  if (dbPath !== ":memory:") {
    // Enable WAL mode for concurrent access
    sqlite.exec("PRAGMA journal_mode=WAL")
    // Wait up to 5s for locks
    sqlite.exec("PRAGMA busy_timeout=5000")
  }
  // Enable foreign key enforcement
  sqlite.exec("PRAGMA foreign_keys=ON")

  const db = drizzle(sqlite, { schema })
  db._rawDb = sqlite
  return db as DrizzleDB
}

/**
 * Initialize the database schema.
 * Creates all tables if they don't exist.
 */
export function initializeSchema(db: DrizzleDB): void {
  db._rawDb.exec(INIT_SCHEMA)
}

/**
 * Get the raw SQLite connection for advanced operations.
 */
export function getRawConnection(db: DrizzleDB): RawDatabase {
  return db._rawDb
}
