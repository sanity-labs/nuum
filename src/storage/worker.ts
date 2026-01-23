/**
 * Worker Storage implementation
 *
 * Tracks background worker jobs for compaction, consolidation, etc.
 */

import { eq } from "drizzle-orm"
import type { DrizzleDB } from "./db"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

import { workers, type Worker, type WorkerInsert } from "./schema"

export type WorkerType = "temporal-compact" | "ltm-consolidate" | "ltm-reflect"
export type WorkerStatus = "pending" | "running" | "completed" | "failed"

export interface WorkerStorage {
  create(worker: WorkerInsert): Promise<void>
  get(id: string): Promise<Worker | null>
  update(
    id: string,
    updates: Partial<Pick<Worker, "status" | "startedAt" | "completedAt" | "error">>,
  ): Promise<void>
  getByType(type: WorkerType): Promise<Worker[]>
  getRunning(): Promise<Worker[]>
  getAll(): Promise<Worker[]>
  complete(id: string): Promise<void>
  fail(id: string, error: string): Promise<void>
}

export function createWorkerStorage(db: DrizzleDB | AnyDrizzleDB): WorkerStorage {
  return {
    async create(worker: WorkerInsert): Promise<void> {
      await db.insert(workers).values(worker)
    },

    async get(id: string): Promise<Worker | null> {
      const result = await db
        .select()
        .from(workers)
        .where(eq(workers.id, id))
        .limit(1)

      return result[0] ?? null
    },

    async update(
      id: string,
      updates: Partial<Pick<Worker, "status" | "startedAt" | "completedAt" | "error">>,
    ): Promise<void> {
      await db.update(workers).set(updates).where(eq(workers.id, id))
    },

    async getByType(type: WorkerType): Promise<Worker[]> {
      return db
        .select()
        .from(workers)
        .where(eq(workers.type, type))
        .orderBy(workers.id)
    },

    async getRunning(): Promise<Worker[]> {
      return db
        .select()
        .from(workers)
        .where(eq(workers.status, "running"))
        .orderBy(workers.id)
    },

    async getAll(): Promise<Worker[]> {
      return db
        .select()
        .from(workers)
        .orderBy(workers.id)
    },

    async complete(id: string): Promise<void> {
      await db.update(workers).set({
        status: "completed",
        completedAt: new Date().toISOString(),
      }).where(eq(workers.id, id))
    },

    async fail(id: string, error: string): Promise<void> {
      await db.update(workers).set({
        status: "failed",
        completedAt: new Date().toISOString(),
        error,
      }).where(eq(workers.id, id))
    },
  }
}
