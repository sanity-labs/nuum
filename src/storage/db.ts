/**
 * Database connection for Nuum storage
 *
 * SQLite with WAL mode for concurrent read/write access.
 * Background workers can run while the main agent operates.
 *
 * Uses Bun's native bun:sqlite driver. Nuum requires Bun runtime.
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

// Verify Bun runtime
const isBun = typeof globalThis.Bun !== "undefined"
if (!isBun) {
  throw new Error("Nuum requires Bun runtime. Install Bun: https://bun.sh")
}

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

  CREATE TABLE IF NOT EXISTS session_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS background_reports (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    subsystem TEXT NOT NULL,
    report TEXT NOT NULL,
    surfaced_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_background_reports_unsurfaced
  ON background_reports(surfaced_at) WHERE surfaced_at IS NULL;

  -- FTS5 virtual table for full-text search on temporal messages
  CREATE VIRTUAL TABLE IF NOT EXISTS temporal_messages_fts USING fts5(
    id UNINDEXED,
    type UNINDEXED,
    content,
    content=temporal_messages,
    content_rowid=rowid
  );

  -- Triggers to keep FTS index in sync with temporal_messages
  CREATE TRIGGER IF NOT EXISTS temporal_messages_ai AFTER INSERT ON temporal_messages BEGIN
    INSERT INTO temporal_messages_fts(rowid, id, type, content)
    VALUES (NEW.rowid, NEW.id, NEW.type, NEW.content);
  END;

  CREATE TRIGGER IF NOT EXISTS temporal_messages_ad AFTER DELETE ON temporal_messages BEGIN
    INSERT INTO temporal_messages_fts(temporal_messages_fts, rowid, id, type, content)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.type, OLD.content);
  END;

  -- FTS5 virtual table for full-text search on LTM entries
  CREATE VIRTUAL TABLE IF NOT EXISTS ltm_entries_fts USING fts5(
    slug UNINDEXED,
    title,
    body,
    content=ltm_entries,
    content_rowid=rowid
  );

  -- Triggers to keep FTS index in sync with ltm_entries
  CREATE TRIGGER IF NOT EXISTS ltm_entries_ai AFTER INSERT ON ltm_entries BEGIN
    INSERT INTO ltm_entries_fts(rowid, slug, title, body)
    VALUES (NEW.rowid, NEW.slug, NEW.title, NEW.body);
  END;

  CREATE TRIGGER IF NOT EXISTS ltm_entries_au AFTER UPDATE ON ltm_entries BEGIN
    INSERT INTO ltm_entries_fts(ltm_entries_fts, rowid, slug, title, body)
    VALUES ('delete', OLD.rowid, OLD.slug, OLD.title, OLD.body);
    INSERT INTO ltm_entries_fts(rowid, slug, title, body)
    VALUES (NEW.rowid, NEW.slug, NEW.title, NEW.body);
  END;

  CREATE TRIGGER IF NOT EXISTS ltm_entries_ad AFTER DELETE ON ltm_entries BEGIN
    INSERT INTO ltm_entries_fts(ltm_entries_fts, rowid, slug, title, body)
    VALUES ('delete', OLD.rowid, OLD.slug, OLD.title, OLD.body);
  END;
`

/**
 * Create a SQLite database connection with WAL mode enabled.
 */
export function createDb(dbPath: string): DrizzleDB {
  return createBunDb(dbPath)
}

/**
 * Create an in-memory database for testing.
 */
export function createInMemoryDb(): DrizzleDB {
  return createBunDb(":memory:")
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
