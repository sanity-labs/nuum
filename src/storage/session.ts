/**
 * Session storage - singleton identity and configuration.
 *
 * The session is the persistent identity of this agent instance.
 * One database = one session = one agent, forever.
 *
 * Modeled as key-value pairs to enforce singleton semantics -
 * there's no way to create multiple sessions.
 */

import {eq} from 'drizzle-orm'
import type {BunSQLiteDatabase} from 'drizzle-orm/bun-sqlite'
import {sessionConfig} from './schema'
import {Identifier} from '../id'

type DrizzleDB = BunSQLiteDatabase<Record<string, never>>
type AnyDrizzleDB = BunSQLiteDatabase<any>

/**
 * Session storage interface.
 * All methods are idempotent - getId() creates on first call, returns same forever.
 */
export interface SessionStorage {
  /** Get the session ID (creates on first call, returns same forever) */
  getId(): Promise<string>

  /** Get when the session was created */
  getCreatedAt(): Promise<string>

  /** Get the CAST-provided system prompt overlay (null if not set) */
  getSystemPromptOverlay(): Promise<string | null>

  /** Set the CAST-provided system prompt overlay */
  setSystemPromptOverlay(value: string | null): Promise<void>
}

/**
 * Create session storage backed by SQLite.
 */
export function createSessionStorage(
  db: DrizzleDB | AnyDrizzleDB,
): SessionStorage {
  // Cache the session ID in memory after first read
  let cachedId: string | null = null

  return {
    async getId(): Promise<string> {
      // Return cached value if available
      if (cachedId) {
        return cachedId
      }

      // Check if session already exists
      const existing = await db
        .select()
        .from(sessionConfig)
        .where(eq(sessionConfig.key, 'id'))
        .get()

      if (existing?.value) {
        cachedId = existing.value
        return cachedId
      }

      // First call ever - create the session
      const id = Identifier.ascending('session')
      const now = new Date().toISOString()

      await db.insert(sessionConfig).values([
        {key: 'id', value: id},
        {key: 'created_at', value: now},
      ])

      cachedId = id
      return id
    },

    async getCreatedAt(): Promise<string> {
      // Ensure session exists
      await this.getId()

      const row = await db
        .select()
        .from(sessionConfig)
        .where(eq(sessionConfig.key, 'created_at'))
        .get()

      return row?.value ?? new Date().toISOString()
    },

    async getSystemPromptOverlay(): Promise<string | null> {
      const row = await db
        .select()
        .from(sessionConfig)
        .where(eq(sessionConfig.key, 'system_prompt_overlay'))
        .get()

      return row?.value ?? null
    },

    async setSystemPromptOverlay(value: string | null): Promise<void> {
      if (value === null) {
        // Delete the key
        await db
          .delete(sessionConfig)
          .where(eq(sessionConfig.key, 'system_prompt_overlay'))
      } else {
        // Upsert the value
        await db
          .insert(sessionConfig)
          .values({key: 'system_prompt_overlay', value})
          .onConflictDoUpdate({
            target: sessionConfig.key,
            set: {value},
          })
      }
    },
  }
}
