/**
 * Background Tasks Storage
 *
 * Manages conscious async tasks (research, reflect) and alarms.
 * These are tasks the agent explicitly started and expects results from.
 */

import { eq, and, lt, isNull } from "drizzle-orm"
import type { DrizzleDB } from "./db"
import { backgroundTasks, backgroundTaskQueue, alarms } from "./schema"
import { Identifier } from "../id"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

/**
 * A background task.
 */
export interface BackgroundTask {
  id: string
  type: "research" | "reflect"
  description: string
  status: "running" | "completed" | "failed" | "killed"
  createdAt: string
  completedAt: string | null
  result: unknown | null
  error: string | null
}

/**
 * A queued task result waiting to be delivered.
 */
export interface QueuedTaskResult {
  id: string
  taskId: string
  createdAt: string
  content: string
}

/**
 * An alarm (scheduled note to self).
 */
export interface Alarm {
  id: string
  firesAt: string
  note: string
  fired: boolean
}

/**
 * Input for creating a background task.
 */
export interface CreateTaskInput {
  type: "research" | "reflect"
  description: string
}

/**
 * Input for creating an alarm.
 */
export interface CreateAlarmInput {
  firesAt: string // ISO timestamp
  note: string
}

/**
 * Background tasks storage interface.
 */
export interface TasksStorage {
  // Task management
  createTask(input: CreateTaskInput): Promise<string>
  getTask(id: string): Promise<BackgroundTask | null>
  listTasks(options?: { status?: string; limit?: number }): Promise<BackgroundTask[]>
  completeTask(id: string, result: unknown): Promise<void>
  failTask(id: string, error: string): Promise<void>
  
  // Startup recovery
  recoverKilledTasks(): Promise<BackgroundTask[]>
  
  // Result queue
  queueResult(taskId: string, content: string): Promise<void>
  drainQueue(): Promise<QueuedTaskResult[]>
  hasQueuedResults(): Promise<boolean>
  
  // Alarms
  createAlarm(input: CreateAlarmInput): Promise<string>
  getDueAlarms(): Promise<Alarm[]>
  markAlarmFired(id: string): Promise<void>
  listAlarms(options?: { includeFired?: boolean }): Promise<Alarm[]>
}

/**
 * Create a TasksStorage instance.
 */
export function createTasksStorage(db: DrizzleDB | AnyDrizzleDB): TasksStorage {
  return {
    // ─────────────────────────────────────────────────────────────
    // Task management
    // ─────────────────────────────────────────────────────────────

    async createTask(input: CreateTaskInput): Promise<string> {
      const id = Identifier.ascending("bgtask")
      const now = new Date().toISOString()

      await db.insert(backgroundTasks).values({
        id,
        type: input.type,
        description: input.description,
        status: "running",
        createdAt: now,
      })

      return id
    },

    async getTask(id: string): Promise<BackgroundTask | null> {
      const rows = await db
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.id, id))
        .limit(1)

      if (rows.length === 0) return null

      const row = rows[0]
      return {
        id: row.id,
        type: row.type as "research" | "reflect",
        description: row.description,
        status: row.status as BackgroundTask["status"],
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        result: row.result ? JSON.parse(row.result) : null,
        error: row.error,
      }
    },

    async listTasks(options?: { status?: string; limit?: number }): Promise<BackgroundTask[]> {
      const limit = options?.limit ?? 50

      let query = db.select().from(backgroundTasks)

      if (options?.status) {
        query = query.where(eq(backgroundTasks.status, options.status))
      }

      const rows = await query.orderBy(backgroundTasks.createdAt).limit(limit)

      return rows.map((row: typeof backgroundTasks.$inferSelect) => ({
        id: row.id,
        type: row.type as "research" | "reflect",
        description: row.description,
        status: row.status as BackgroundTask["status"],
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        result: row.result ? JSON.parse(row.result) : null,
        error: row.error,
      }))
    },

    async completeTask(id: string, result: unknown): Promise<void> {
      const now = new Date().toISOString()

      await db
        .update(backgroundTasks)
        .set({
          status: "completed",
          completedAt: now,
          result: JSON.stringify(result),
        })
        .where(eq(backgroundTasks.id, id))
    },

    async failTask(id: string, error: string): Promise<void> {
      const now = new Date().toISOString()

      await db
        .update(backgroundTasks)
        .set({
          status: "failed",
          completedAt: now,
          error,
        })
        .where(eq(backgroundTasks.id, id))
    },

    // ─────────────────────────────────────────────────────────────
    // Startup recovery
    // ─────────────────────────────────────────────────────────────

    async recoverKilledTasks(): Promise<BackgroundTask[]> {
      // Find all tasks that were running (now killed due to restart)
      const runningTasks = await db
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.status, "running"))

      // Mark them as killed
      if (runningTasks.length > 0) {
        const now = new Date().toISOString()
        await db
          .update(backgroundTasks)
          .set({
            status: "killed",
            completedAt: now,
          })
          .where(eq(backgroundTasks.status, "running"))
      }

      return runningTasks.map((row: typeof backgroundTasks.$inferSelect) => ({
        id: row.id,
        type: row.type as "research" | "reflect",
        description: row.description,
        status: "killed" as const,
        createdAt: row.createdAt,
        completedAt: row.completedAt,
        result: null,
        error: null,
      }))
    },

    // ─────────────────────────────────────────────────────────────
    // Result queue
    // ─────────────────────────────────────────────────────────────

    async queueResult(taskId: string, content: string): Promise<void> {
      const id = Identifier.ascending("bgtask")
      const now = new Date().toISOString()

      await db.insert(backgroundTaskQueue).values({
        id,
        taskId,
        createdAt: now,
        content,
      })
    },

    async drainQueue(): Promise<QueuedTaskResult[]> {
      // Get all queued results
      const rows = await db
        .select()
        .from(backgroundTaskQueue)
        .orderBy(backgroundTaskQueue.createdAt)

      if (rows.length === 0) return []

      // Delete them
      const ids = rows.map((r: typeof backgroundTaskQueue.$inferSelect) => r.id)
      for (const id of ids) {
        await db.delete(backgroundTaskQueue).where(eq(backgroundTaskQueue.id, id))
      }

      return rows.map((row: typeof backgroundTaskQueue.$inferSelect) => ({
        id: row.id,
        taskId: row.taskId,
        createdAt: row.createdAt,
        content: row.content,
      }))
    },

    async hasQueuedResults(): Promise<boolean> {
      const rows = await db
        .select({ id: backgroundTaskQueue.id })
        .from(backgroundTaskQueue)
        .limit(1)

      return rows.length > 0
    },

    // ─────────────────────────────────────────────────────────────
    // Alarms
    // ─────────────────────────────────────────────────────────────

    async createAlarm(input: CreateAlarmInput): Promise<string> {
      const id = Identifier.ascending("bgtask")

      await db.insert(alarms).values({
        id,
        firesAt: input.firesAt,
        note: input.note,
        fired: 0,
      })

      return id
    },

    async getDueAlarms(): Promise<Alarm[]> {
      const now = new Date().toISOString()

      const rows = await db
        .select()
        .from(alarms)
        .where(and(eq(alarms.fired, 0), lt(alarms.firesAt, now)))
        .orderBy(alarms.firesAt)

      return rows.map((row: typeof alarms.$inferSelect) => ({
        id: row.id,
        firesAt: row.firesAt,
        note: row.note,
        fired: row.fired === 1,
      }))
    },

    async markAlarmFired(id: string): Promise<void> {
      await db
        .update(alarms)
        .set({ fired: 1 })
        .where(eq(alarms.id, id))
    },

    async listAlarms(options?: { includeFired?: boolean }): Promise<Alarm[]> {
      let query = db.select().from(alarms)

      if (!options?.includeFired) {
        query = query.where(eq(alarms.fired, 0))
      }

      const rows = await query.orderBy(alarms.firesAt)

      return rows.map((row: typeof alarms.$inferSelect) => ({
        id: row.id,
        firesAt: row.firesAt,
        note: row.note,
        fired: row.fired === 1,
      }))
    },
  }
}
