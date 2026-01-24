/**
 * Temporal Storage implementation
 *
 * Manages the chronological log of all agent experience.
 * Messages are append-only. Summaries are immutable once created.
 */

import { eq, and, gte, lte, desc, asc, sql } from "drizzle-orm"
import type { DrizzleDB } from "./db"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

import {
  temporalMessages,
  temporalSummaries,
  type TemporalMessage,
  type TemporalMessageInsert,
  type TemporalSummary,
  type TemporalSummaryInsert,
} from "./schema"
import { Log } from "../util/log"

const log = Log.create({ service: "temporal-storage" })

export interface TemporalSearchParams {
  query?: string
  fromId?: string
  toId?: string
  type?: TemporalMessage["type"][]
  tags?: string[]
  tagMode?: "all" | "any"
}

export interface TemporalSearchResult {
  matches: (TemporalMessage | TemporalSummary)[]
  expandable: string[] // Summary IDs that can be expanded
}

/**
 * Result from FTS search with snippet extraction.
 */
export interface FTSSearchResult {
  id: string
  type: string
  snippet: string  // Highlighted snippet around match
  rank: number     // FTS5 relevance rank (lower is better)
}

/**
 * Parameters for getting a message with context.
 */
export interface MessageWithContextParams {
  id: string
  contextBefore?: number  // Number of messages before
  contextAfter?: number   // Number of messages after
}

export interface TemporalStorage {
  appendMessage(msg: TemporalMessageInsert): Promise<void>
  createSummary(summary: TemporalSummaryInsert): Promise<void>
  getMessages(from?: string, to?: string): Promise<TemporalMessage[]>
  getMessage(id: string): Promise<TemporalMessage | null>
  getMessageWithContext(params: MessageWithContextParams): Promise<TemporalMessage[]>
  getSummaries(order?: number): Promise<TemporalSummary[]>
  getHighestOrderSummaries(): Promise<TemporalSummary[]>
  search(params: TemporalSearchParams): Promise<TemporalSearchResult>
  /** Full-text search using FTS5 with snippet extraction */
  searchFTS(query: string, limit?: number): Promise<FTSSearchResult[]>
  estimateUncompactedTokens(): Promise<number>
  getLastSummaryEndId(): Promise<string | null>
}

export function createTemporalStorage(db: DrizzleDB | AnyDrizzleDB): TemporalStorage {
  return {
    async appendMessage(msg: TemporalMessageInsert): Promise<void> {
      await db.insert(temporalMessages).values(msg)
    },

    async createSummary(summary: TemporalSummaryInsert): Promise<void> {
      await db.insert(temporalSummaries).values(summary)
    },

    async getMessages(from?: string, to?: string): Promise<TemporalMessage[]> {
      let query = db.select().from(temporalMessages)

      if (from && to) {
        query = query.where(
          and(gte(temporalMessages.id, from), lte(temporalMessages.id, to)),
        ) as typeof query
      } else if (from) {
        query = query.where(gte(temporalMessages.id, from)) as typeof query
      } else if (to) {
        query = query.where(lte(temporalMessages.id, to)) as typeof query
      }

      return query.orderBy(asc(temporalMessages.id))
    },

    async getMessage(id: string): Promise<TemporalMessage | null> {
      const result = await db
        .select()
        .from(temporalMessages)
        .where(eq(temporalMessages.id, id))
        .limit(1)
      return result[0] ?? null
    },

    async getMessageWithContext(params: MessageWithContextParams): Promise<TemporalMessage[]> {
      const { id, contextBefore = 0, contextAfter = 0 } = params
      
      // Get the target message first to verify it exists
      const target = await this.getMessage(id)
      if (!target) return []

      const results: TemporalMessage[] = []

      // Get messages before (if requested)
      if (contextBefore > 0) {
        const before = await db
          .select()
          .from(temporalMessages)
          .where(sql`${temporalMessages.id} < ${id}`)
          .orderBy(desc(temporalMessages.id))
          .limit(contextBefore)
        results.push(...before.reverse())
      }

      // Add the target message
      results.push(target)

      // Get messages after (if requested)
      if (contextAfter > 0) {
        const after = await db
          .select()
          .from(temporalMessages)
          .where(sql`${temporalMessages.id} > ${id}`)
          .orderBy(asc(temporalMessages.id))
          .limit(contextAfter)
        results.push(...after)
      }

      return results
    },

    async getSummaries(order?: number): Promise<TemporalSummary[]> {
      if (order !== undefined) {
        return db
          .select()
          .from(temporalSummaries)
          .where(eq(temporalSummaries.orderNum, order))
          .orderBy(asc(temporalSummaries.id))
      }
      return db
        .select()
        .from(temporalSummaries)
        .orderBy(asc(temporalSummaries.orderNum), asc(temporalSummaries.id))
    },

    async getHighestOrderSummaries(): Promise<TemporalSummary[]> {
      // Get all summaries, then filter to only include those not subsumed
      // A summary is subsumed if its range is entirely within another summary's range
      const allSummaries = await db
        .select()
        .from(temporalSummaries)
        .orderBy(desc(temporalSummaries.orderNum), asc(temporalSummaries.id))

      if (allSummaries.length === 0) return []

      // Track which ULID ranges are covered by higher-order summaries
      const coveredRanges: Array<{ startId: string; endId: string }> = []
      const result: TemporalSummary[] = []

      for (const summary of allSummaries) {
        // Check if this summary's range is subsumed by a higher-order summary
        const isSubsumed = coveredRanges.some(
          (range) =>
            summary.startId >= range.startId && summary.endId <= range.endId,
        )

        if (!isSubsumed) {
          result.push(summary)
          coveredRanges.push({ startId: summary.startId, endId: summary.endId })
        }
      }

      // Return sorted by startId for chronological order
      return result.sort((a, b) => a.startId.localeCompare(b.startId))
    },

    async search(params: TemporalSearchParams): Promise<TemporalSearchResult> {
      // Basic keyword search implementation
      // Phase 1: Simple keyword matching on content/narrative
      // Phase 2+: FTS tables for better search

      const matches: (TemporalMessage | TemporalSummary)[] = []
      const expandable: string[] = []

      // Search messages
      let messagesQuery = db.select().from(temporalMessages)

      if (params.fromId) {
        messagesQuery = messagesQuery.where(
          gte(temporalMessages.id, params.fromId),
        ) as typeof messagesQuery
      }
      if (params.toId) {
        messagesQuery = messagesQuery.where(
          lte(temporalMessages.id, params.toId),
        ) as typeof messagesQuery
      }
      if (params.type && params.type.length > 0) {
        // Filter by message type in memory for now
        // (SQLite doesn't have good IN clause support in drizzle-orm)
      }

      const messages = await messagesQuery.orderBy(asc(temporalMessages.id))

      for (const msg of messages) {
        // Type filter
        if (
          params.type &&
          params.type.length > 0 &&
          !params.type.includes(msg.type as TemporalMessage["type"])
        ) {
          continue
        }

        // Query filter
        if (
          params.query &&
          !msg.content.toLowerCase().includes(params.query.toLowerCase())
        ) {
          continue
        }

        matches.push(msg)
      }

      // Search summaries
      const summaries = await this.getHighestOrderSummaries()

      for (const summary of summaries) {
        // Range filter
        if (params.fromId && summary.endId < params.fromId) continue
        if (params.toId && summary.startId > params.toId) continue

        // Query filter - check narrative and key observations
        if (params.query) {
          const queryLower = params.query.toLowerCase()
          const matchesNarrative = summary.narrative
            .toLowerCase()
            .includes(queryLower)
          const observations = JSON.parse(summary.keyObservations) as string[]
          const matchesObservations = observations.some((obs) =>
            obs.toLowerCase().includes(queryLower),
          )

          if (!matchesNarrative && !matchesObservations) continue
        }

        // Tag filter
        if (params.tags && params.tags.length > 0) {
          const summaryTags = JSON.parse(summary.tags) as string[]
          const tagMode = params.tagMode ?? "any"

          if (tagMode === "all") {
            if (!params.tags.every((tag) => summaryTags.includes(tag))) {
              continue
            }
          } else {
            if (!params.tags.some((tag) => summaryTags.includes(tag))) {
              continue
            }
          }
        }

        matches.push(summary)
        expandable.push(summary.id)
      }

      return { matches, expandable }
    },

    async searchFTS(query: string, limit: number = 20): Promise<FTSSearchResult[]> {
      // Use FTS5 MATCH with snippet() for highlighted excerpts
      // 
      // Quote the entire query to prevent FTS5 from interpreting words
      // as column names or operators (e.g., "agent" being parsed as column:value)
      const escapedQuery = `"${query.replace(/"/g, '""')}"`
      
      const results = await db._rawDb.prepare(`
        SELECT 
          id,
          type,
          snippet(temporal_messages_fts, 2, '>>>', '<<<', '...', 32) as snippet,
          rank
        FROM temporal_messages_fts
        WHERE temporal_messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(escapedQuery, limit) as Array<{ id: string; type: string; snippet: string; rank: number }>

      return results.map(r => ({
        id: r.id,
        type: r.type,
        snippet: r.snippet,
        rank: r.rank,
      }))
    },

    async estimateUncompactedTokens(): Promise<number> {
      // Get the end ID of the last summary
      const lastEndId = await this.getLastSummaryEndId()

      // Sum token estimates for all messages after that
      if (lastEndId) {
        const result = await db
          .select({
            total: sql<number>`COALESCE(SUM(${temporalMessages.tokenEstimate}), 0)`,
          })
          .from(temporalMessages)
          .where(sql`${temporalMessages.id} > ${lastEndId}`)

        return result[0]?.total ?? 0
      }

      // No summaries yet - all messages are uncompacted
      const result = await db
        .select({
          total: sql<number>`COALESCE(SUM(${temporalMessages.tokenEstimate}), 0)`,
        })
        .from(temporalMessages)

      return result[0]?.total ?? 0
    },

    async getLastSummaryEndId(): Promise<string | null> {
      // Find the summary with the highest endId
      // (This is the most recent content that has been summarized)
      const result = await db
        .select({ endId: temporalSummaries.endId })
        .from(temporalSummaries)
        .orderBy(desc(temporalSummaries.endId))
        .limit(1)

      return result[0]?.endId ?? null
    },
  }
}
