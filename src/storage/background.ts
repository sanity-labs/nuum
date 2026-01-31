/**
 * Background Reports Storage
 *
 * Allows background workers (LTM curator, distillation, etc.) to file reports
 * that get surfaced to the main agent at the start of the next turn.
 */

import {eq, isNull} from 'drizzle-orm'
import type {DrizzleDB} from './db'
import {backgroundReports} from './schema'
import {Identifier} from '../id'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

/**
 * A background report filed by a worker.
 */
export interface BackgroundReport {
  id: string
  createdAt: string
  subsystem: string
  report: Record<string, unknown>
  surfacedAt: string | null
}

/**
 * Input for creating a background report.
 */
export interface BackgroundReportInput {
  subsystem: string
  report: Record<string, unknown>
}

/**
 * Background storage interface.
 */
export interface BackgroundStorage {
  /**
   * File a new background report.
   */
  fileReport(input: BackgroundReportInput): Promise<string>

  /**
   * Get all unsurfaced reports (not yet shown to main agent).
   */
  getUnsurfaced(): Promise<BackgroundReport[]>

  /**
   * Mark a report as surfaced.
   */
  markSurfaced(id: string): Promise<void>

  /**
   * Mark multiple reports as surfaced.
   */
  markManySurfaced(ids: string[]): Promise<void>
}

/**
 * Create a BackgroundStorage instance.
 */
export function createBackgroundStorage(
  db: DrizzleDB | AnyDrizzleDB,
): BackgroundStorage {
  return {
    async fileReport(input: BackgroundReportInput): Promise<string> {
      const id = Identifier.ascending('report')
      const now = new Date().toISOString()

      await db.insert(backgroundReports).values({
        id,
        createdAt: now,
        subsystem: input.subsystem,
        report: JSON.stringify(input.report),
      })

      return id
    },

    async getUnsurfaced(): Promise<BackgroundReport[]> {
      const rows = await db
        .select()
        .from(backgroundReports)
        .where(isNull(backgroundReports.surfacedAt))
        .orderBy(backgroundReports.createdAt)

      return rows.map(
        (row: {
          id: string
          createdAt: string
          subsystem: string
          report: string
          surfacedAt: string | null
        }) => ({
          id: row.id,
          createdAt: row.createdAt,
          subsystem: row.subsystem,
          report: JSON.parse(row.report),
          surfacedAt: row.surfacedAt,
        }),
      )
    },

    async markSurfaced(id: string): Promise<void> {
      const now = new Date().toISOString()
      await db
        .update(backgroundReports)
        .set({surfacedAt: now})
        .where(eq(backgroundReports.id, id))
    },

    async markManySurfaced(ids: string[]): Promise<void> {
      if (ids.length === 0) return

      const now = new Date().toISOString()
      for (const id of ids) {
        await db
          .update(backgroundReports)
          .set({surfacedAt: now})
          .where(eq(backgroundReports.id, id))
      }
    },
  }
}
