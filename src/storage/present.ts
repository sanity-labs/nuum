/**
 * Present Storage implementation
 *
 * Manages the agent's current situational awareness.
 * Single-row table for mission, status, and tasks.
 */

import {eq} from 'drizzle-orm'
import type {DrizzleDB} from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

import {presentState} from './schema'

export interface Task {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked'
  blockedReason?: string
}

export interface PresentState {
  mission: string | null
  status: string | null
  tasks: Task[]
}

export interface PresentStorage {
  get(): Promise<PresentState>
  set(state: PresentState): Promise<void>
  setMission(mission: string | null): Promise<void>
  setStatus(status: string | null): Promise<void>
  setTasks(tasks: Task[]): Promise<void>
}

export function createPresentStorage(
  db: DrizzleDB | AnyDrizzleDB,
): PresentStorage {
  // Ensure the single row exists
  async function ensureRow(): Promise<void> {
    const existing = await db
      .select()
      .from(presentState)
      .where(eq(presentState.id, 1))
      .limit(1)

    if (existing.length === 0) {
      await db.insert(presentState).values({
        id: 1,
        mission: null,
        status: null,
        tasks: '[]',
      })
    }
  }

  return {
    async get(): Promise<PresentState> {
      await ensureRow()

      const result = await db
        .select()
        .from(presentState)
        .where(eq(presentState.id, 1))
        .limit(1)

      const row = result[0]
      if (!row) {
        // Should never happen after ensureRow
        return {mission: null, status: null, tasks: []}
      }

      return {
        mission: row.mission,
        status: row.status,
        tasks: JSON.parse(row.tasks) as Task[],
      }
    },

    async set(state: PresentState): Promise<void> {
      await ensureRow()

      await db
        .update(presentState)
        .set({
          mission: state.mission,
          status: state.status,
          tasks: JSON.stringify(state.tasks),
        })
        .where(eq(presentState.id, 1))
    },

    async setMission(mission: string | null): Promise<void> {
      await ensureRow()

      await db.update(presentState).set({mission}).where(eq(presentState.id, 1))
    },

    async setStatus(status: string | null): Promise<void> {
      await ensureRow()

      await db.update(presentState).set({status}).where(eq(presentState.id, 1))
    },

    async setTasks(tasks: Task[]): Promise<void> {
      await ensureRow()

      await db
        .update(presentState)
        .set({tasks: JSON.stringify(tasks)})
        .where(eq(presentState.id, 1))
    },
  }
}
