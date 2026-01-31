/**
 * Database migration system for nuum.
 *
 * Runs SQL migrations on startup to evolve the schema over time.
 * Migrations are idempotent - safe to run multiple times.
 *
 * Migration files are in src/storage/migrations/ with format:
 *   NNNN_description.sql (e.g., 0001_initial_schema.sql)
 *
 * The _migrations table tracks which migrations have been applied.
 */

import {readdirSync, readFileSync} from 'fs'
import {join, dirname} from 'path'
import type {RawDatabase} from './db'
import {Log} from '../util/log'

const log = Log.create({service: 'migrate'})

/**
 * Get the migrations directory path.
 * Works both in development (src/) and production (dist/).
 */
function getMigrationsDir(): string {
  const currentDir = dirname(new URL(import.meta.url).pathname)

  // In bundled mode, we need to find the package root and look in src/storage/migrations
  // The bundle runs from dist/index.js, but migrations are in src/storage/migrations/

  // Try to find package root by looking for node_modules/@sanity-labs/nuum
  if (currentDir.includes('node_modules/@sanity-labs/nuum')) {
    const packageRoot =
      currentDir.split('node_modules/@sanity-labs/nuum')[0] +
      'node_modules/@sanity-labs/nuum'
    return join(packageRoot, 'src/storage/migrations')
  }

  // Development: if we're in dist/, go to src/
  if (currentDir.includes('/dist')) {
    // Go up from dist/storage to project root, then into src/storage/migrations
    const projectRoot = currentDir.replace(/\/dist.*$/, '')
    return join(projectRoot, 'src/storage/migrations')
  }

  // Development: already in src/storage
  return join(currentDir, 'migrations')
}

/**
 * Ensure the _migrations table exists.
 */
function ensureMigrationsTable(db: RawDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)
}

/**
 * Get list of applied migrations.
 */
function getAppliedMigrations(db: RawDatabase): Set<string> {
  const stmt =
    (db as any).prepare?.('SELECT id FROM _migrations') ??
    (db as any).query?.('SELECT id FROM _migrations')

  const rows = stmt?.all?.() ?? []
  return new Set(rows.map((r: any) => r.id))
}

/**
 * Record a migration as applied.
 */
function recordMigration(db: RawDatabase, id: string): void {
  const now = new Date().toISOString()
  db.exec(`INSERT INTO _migrations (id, applied_at) VALUES ('${id}', '${now}')`)
}

/**
 * Get list of migration files sorted by name.
 */
function getMigrationFiles(): string[] {
  const migrationsDir = getMigrationsDir()

  try {
    return readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
  } catch {
    log.debug('migrations directory not found', {dir: migrationsDir})
    return []
  }
}

/**
 * Run a single migration file.
 */
function runMigration(db: RawDatabase, filename: string): void {
  const migrationsDir = getMigrationsDir()
  const filepath = join(migrationsDir, filename)
  const sql = readFileSync(filepath, 'utf-8')
  db.exec(sql)
}

/**
 * Run all pending migrations.
 *
 * Call this on startup to ensure the database schema is up to date.
 * Safe to call multiple times - already-applied migrations are skipped.
 */
export function runMigrations(db: RawDatabase): {
  applied: string[]
  skipped: string[]
} {
  const result = {applied: [] as string[], skipped: [] as string[]}

  ensureMigrationsTable(db)

  const migrationFiles = getMigrationFiles()
  const appliedMigrations = getAppliedMigrations(db)

  if (migrationFiles.length === 0) {
    return result
  }

  for (const filename of migrationFiles) {
    if (appliedMigrations.has(filename)) {
      result.skipped.push(filename)
      continue
    }

    log.info('applying migration', {migration: filename})

    try {
      runMigration(db, filename)
      recordMigration(db, filename)
      result.applied.push(filename)
    } catch (error) {
      log.error('migration failed', {
        migration: filename,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new Error(`Migration ${filename} failed: ${error}`)
    }
  }

  if (result.applied.length > 0) {
    log.info('migrations complete', {applied: result.applied.length})
  }

  // Always rebuild FTS indexes to ensure they're in sync
  // This is fast and ensures search works correctly even if
  // the content tables were modified outside of triggers
  rebuildFTSIndexes(db)

  return result
}

/**
 * Rebuild FTS indexes to ensure they're in sync with content tables.
 *
 * FTS5 content tables can get out of sync if:
 * - Triggers didn't fire (e.g., bulk inserts before triggers existed)
 * - Database was restored from backup
 * - Manual modifications to content tables
 *
 * The rebuild command repopulates the FTS index from the content table.
 */
function rebuildFTSIndexes(db: RawDatabase): void {
  try {
    // Check if FTS tables exist before trying to rebuild
    const tables =
      (db as any)
        .prepare?.(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'",
        )
        ?.all?.() ??
      (db as any)
        .query?.(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'",
        )
        ?.all?.() ??
      []

    for (const table of tables) {
      const tableName = table.name
      try {
        db.exec(`INSERT INTO ${tableName}(${tableName}) VALUES('rebuild')`)
        log.debug('rebuilt FTS index', {table: tableName})
      } catch (error) {
        // Ignore errors for individual tables - they might not be content tables
        log.debug('skipped FTS rebuild', {
          table: tableName,
          reason: String(error),
        })
      }
    }
  } catch (error) {
    // FTS tables might not exist yet - that's fine
    log.debug('FTS rebuild skipped', {reason: String(error)})
  }
}
