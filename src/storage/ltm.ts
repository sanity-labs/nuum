/**
 * Long-Term Memory Storage implementation
 *
 * Hierarchical knowledge base with tree structure.
 * All modifications use Compare-and-Swap (CAS) for concurrency safety.
 */

import {eq, and, isNull, like} from 'drizzle-orm'
import type {DrizzleDB} from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDrizzleDB = any

import {ltmEntries, type LTMEntry, type LTMEntryInsert} from './schema'

export class ConflictError extends Error {
  constructor(
    public slug: string,
    public expectedVersion: number,
    public actualVersion: number,
  ) {
    super(
      `CAS conflict: ${slug} expected version ${expectedVersion}, got ${actualVersion}`,
    )
    this.name = 'ConflictError'
  }
}

export type AgentType = 'main' | 'ltm-consolidate' | 'ltm-reflect' | 'research'

export interface LTMCreateInput {
  slug: string
  parentSlug: string | null
  title: string
  body: string
  links?: string[]
  createdBy: AgentType
}

export interface LTMSearchResult {
  entry: LTMEntry
  score?: number
}

/**
 * Result from FTS search with snippet extraction.
 */
export interface LTMFTSSearchResult {
  slug: string
  title: string
  snippet: string // Highlighted snippet around match
  rank: number // FTS5 relevance rank (lower is better)
}

export interface LTMStorage {
  create(input: LTMCreateInput): Promise<LTMEntry>
  read(slug: string): Promise<LTMEntry | null>
  update(
    slug: string,
    body: string,
    expectedVersion: number,
    updatedBy: AgentType,
  ): Promise<LTMEntry>
  /** Surgical find-replace within an entry's body. Requires exact match. */
  edit(
    slug: string,
    oldText: string,
    newText: string,
    expectedVersion: number,
    updatedBy: AgentType,
  ): Promise<LTMEntry>
  /** Move an entry to a new parent. Updates path for entry and all descendants. */
  reparent(
    slug: string,
    newParentSlug: string | null,
    expectedVersion: number,
    updatedBy: AgentType,
  ): Promise<LTMEntry>
  /** Rename an entry's slug. Updates path for entry and all descendants. */
  rename(
    slug: string,
    newSlug: string,
    expectedVersion: number,
    updatedBy: AgentType,
  ): Promise<LTMEntry>
  archive(slug: string, expectedVersion: number): Promise<void>
  glob(pattern: string, maxDepth?: number): Promise<LTMEntry[]>
  search(query: string, pathPrefix?: string): Promise<LTMSearchResult[]>
  /** Full-text search using FTS5 with snippet extraction */
  searchFTS(query: string, limit?: number): Promise<LTMFTSSearchResult[]>
  getChildren(parentSlug: string | null): Promise<LTMEntry[]>
}

/**
 * Build the materialized path from the slug and parent path.
 */
function buildPath(slug: string, parentPath: string | null): string {
  if (parentPath === null) {
    return `/${slug}`
  }
  return `${parentPath}/${slug}`
}

/**
 * Convert a glob pattern to SQL LIKE pattern.
 * Supports: * (single level), ** (any depth)
 */
function globToLike(pattern: string): string {
  // Normalize pattern
  let normalized = pattern
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized
  }

  // Convert glob to LIKE
  // ** matches any depth (including /)
  // * matches single level (no /)
  // For simplicity in Phase 1, treat both as % (any characters)
  // A more sophisticated implementation would use recursive CTE
  return normalized.replace(/\*\*/g, '%').replace(/\*/g, '%')
}

export function createLTMStorage(db: DrizzleDB | AnyDrizzleDB): LTMStorage {
  return {
    async create(input: LTMCreateInput): Promise<LTMEntry> {
      // Check if slug already exists
      const existing = await db
        .select()
        .from(ltmEntries)
        .where(eq(ltmEntries.slug, input.slug))
        .limit(1)

      if (existing.length > 0) {
        throw new Error(`LTM entry already exists: ${input.slug}`)
      }

      // Get parent path if there's a parent
      let parentPath: string | null = null
      if (input.parentSlug) {
        const parent = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, input.parentSlug))
          .limit(1)

        if (parent.length === 0) {
          throw new Error(`Parent entry not found: ${input.parentSlug}`)
        }
        parentPath = parent[0].path
      }

      const now = new Date().toISOString()
      const path = buildPath(input.slug, parentPath)

      const entry: LTMEntryInsert = {
        slug: input.slug,
        parentSlug: input.parentSlug,
        path,
        title: input.title,
        body: input.body,
        links: JSON.stringify(input.links ?? []),
        version: 1,
        createdBy: input.createdBy,
        updatedBy: input.createdBy,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }

      await db.insert(ltmEntries).values(entry)

      // Return the created entry
      const created = await this.read(input.slug)
      if (!created) {
        throw new Error(`Failed to create LTM entry: ${input.slug}`)
      }
      return created
    },

    async read(slug: string): Promise<LTMEntry | null> {
      const result = await db
        .select()
        .from(ltmEntries)
        .where(and(eq(ltmEntries.slug, slug), isNull(ltmEntries.archivedAt)))
        .limit(1)

      return result[0] ?? null
    },

    async update(
      slug: string,
      body: string,
      expectedVersion: number,
      updatedBy: AgentType,
    ): Promise<LTMEntry> {
      // CAS: Update only if version matches
      const now = new Date().toISOString()

      const result = await db
        .update(ltmEntries)
        .set({
          body,
          version: expectedVersion + 1,
          updatedBy,
          updatedAt: now,
        })
        .where(
          and(
            eq(ltmEntries.slug, slug),
            eq(ltmEntries.version, expectedVersion),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .returning()

      if (result.length === 0) {
        // Check why update failed
        const current = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, slug))
          .limit(1)

        if (current.length === 0) {
          throw new Error(`LTM entry not found: ${slug}`)
        }

        if (current[0].archivedAt) {
          throw new Error(`LTM entry is archived: ${slug}`)
        }

        throw new ConflictError(slug, expectedVersion, current[0].version)
      }

      return result[0]
    },

    async edit(
      slug: string,
      oldText: string,
      newText: string,
      expectedVersion: number,
      updatedBy: AgentType,
    ): Promise<LTMEntry> {
      // First, read the current entry to find and replace
      const current = await db
        .select()
        .from(ltmEntries)
        .where(eq(ltmEntries.slug, slug))
        .limit(1)

      if (current.length === 0) {
        throw new Error(`LTM entry not found: ${slug}`)
      }

      if (current[0].archivedAt) {
        throw new Error(`LTM entry is archived: ${slug}`)
      }

      if (current[0].version !== expectedVersion) {
        throw new ConflictError(slug, expectedVersion, current[0].version)
      }

      // Check if oldText exists exactly once
      const occurrences = current[0].body.split(oldText).length - 1
      if (occurrences === 0) {
        throw new Error(
          `Text not found in entry "${slug}": "${oldText.slice(0, 50)}${oldText.length > 50 ? '...' : ''}"`,
        )
      }
      if (occurrences > 1) {
        throw new Error(
          `Text appears ${occurrences} times in entry "${slug}". Use ltm_update for ambiguous edits.`,
        )
      }

      // Perform the replacement
      const newBody = current[0].body.replace(oldText, newText)
      const now = new Date().toISOString()

      const result = await db
        .update(ltmEntries)
        .set({
          body: newBody,
          version: expectedVersion + 1,
          updatedBy,
          updatedAt: now,
        })
        .where(
          and(
            eq(ltmEntries.slug, slug),
            eq(ltmEntries.version, expectedVersion),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .returning()

      if (result.length === 0) {
        // Re-check in case of race condition
        const updated = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, slug))
          .limit(1)
        throw new ConflictError(slug, expectedVersion, updated[0]?.version ?? 0)
      }

      return result[0]
    },

    async reparent(
      slug: string,
      newParentSlug: string | null,
      expectedVersion: number,
      updatedBy: AgentType,
    ): Promise<LTMEntry> {
      // Get current entry
      const current = await db
        .select()
        .from(ltmEntries)
        .where(eq(ltmEntries.slug, slug))
        .limit(1)

      if (current.length === 0) {
        throw new Error(`LTM entry not found: ${slug}`)
      }

      if (current[0].archivedAt) {
        throw new Error(`LTM entry is archived: ${slug}`)
      }

      if (current[0].version !== expectedVersion) {
        throw new ConflictError(slug, expectedVersion, current[0].version)
      }

      // Get new parent's path (or null for root)
      let newParentPath: string | null = null
      if (newParentSlug !== null) {
        const parent = await db
          .select()
          .from(ltmEntries)
          .where(
            and(
              eq(ltmEntries.slug, newParentSlug),
              isNull(ltmEntries.archivedAt),
            ),
          )
          .limit(1)

        if (parent.length === 0) {
          throw new Error(`New parent entry not found: ${newParentSlug}`)
        }

        // Prevent circular reparenting (can't move a parent under its own child)
        if (parent[0].path.startsWith(current[0].path + '/')) {
          throw new Error(
            `Cannot reparent "${slug}" under its own descendant "${newParentSlug}"`,
          )
        }

        newParentPath = parent[0].path
      }

      const oldPath = current[0].path
      const newPath = buildPath(slug, newParentPath)
      const now = new Date().toISOString()

      // Update the entry itself
      const result = await db
        .update(ltmEntries)
        .set({
          parentSlug: newParentSlug,
          path: newPath,
          version: expectedVersion + 1,
          updatedBy,
          updatedAt: now,
        })
        .where(
          and(
            eq(ltmEntries.slug, slug),
            eq(ltmEntries.version, expectedVersion),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .returning()

      if (result.length === 0) {
        const updated = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, slug))
          .limit(1)
        throw new ConflictError(slug, expectedVersion, updated[0]?.version ?? 0)
      }

      // Update all descendants' paths
      // Find all entries whose path starts with oldPath + "/"
      const descendants = await db
        .select()
        .from(ltmEntries)
        .where(like(ltmEntries.path, `${oldPath}/%`))

      for (const descendant of descendants) {
        const updatedDescPath = newPath + descendant.path.slice(oldPath.length)
        await db
          .update(ltmEntries)
          .set({path: updatedDescPath, updatedAt: now})
          .where(eq(ltmEntries.slug, descendant.slug))
      }

      return result[0]
    },

    async rename(
      slug: string,
      newSlug: string,
      expectedVersion: number,
      updatedBy: AgentType,
    ): Promise<LTMEntry> {
      // Check new slug doesn't already exist
      const existingNew = await db
        .select()
        .from(ltmEntries)
        .where(eq(ltmEntries.slug, newSlug))
        .limit(1)

      if (existingNew.length > 0) {
        throw new Error(`LTM entry already exists with slug: ${newSlug}`)
      }

      // Get current entry
      const current = await db
        .select()
        .from(ltmEntries)
        .where(eq(ltmEntries.slug, slug))
        .limit(1)

      if (current.length === 0) {
        throw new Error(`LTM entry not found: ${slug}`)
      }

      if (current[0].archivedAt) {
        throw new Error(`LTM entry is archived: ${slug}`)
      }

      if (current[0].version !== expectedVersion) {
        throw new ConflictError(slug, expectedVersion, current[0].version)
      }

      const oldPath = current[0].path
      // New path: replace the slug portion at the end
      const pathParts = oldPath.split('/')
      pathParts[pathParts.length - 1] = newSlug
      const newPath = pathParts.join('/')
      const now = new Date().toISOString()

      // Update the entry
      const result = await db
        .update(ltmEntries)
        .set({
          slug: newSlug,
          path: newPath,
          version: expectedVersion + 1,
          updatedBy,
          updatedAt: now,
        })
        .where(
          and(
            eq(ltmEntries.slug, slug),
            eq(ltmEntries.version, expectedVersion),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .returning()

      if (result.length === 0) {
        const updated = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, slug))
          .limit(1)
        throw new ConflictError(slug, expectedVersion, updated[0]?.version ?? 0)
      }

      // Update children's parentSlug and all descendants' paths
      // First, update direct children's parentSlug
      await db
        .update(ltmEntries)
        .set({parentSlug: newSlug, updatedAt: now})
        .where(eq(ltmEntries.parentSlug, slug))

      // Then update all descendants' paths
      const descendants = await db
        .select()
        .from(ltmEntries)
        .where(like(ltmEntries.path, `${oldPath}/%`))

      for (const descendant of descendants) {
        const updatedDescPath = newPath + descendant.path.slice(oldPath.length)
        await db
          .update(ltmEntries)
          .set({path: updatedDescPath, updatedAt: now})
          .where(eq(ltmEntries.slug, descendant.slug))
      }

      return result[0]
    },

    async archive(slug: string, expectedVersion: number): Promise<void> {
      const now = new Date().toISOString()

      const result = await db
        .update(ltmEntries)
        .set({
          archivedAt: now,
          version: expectedVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(ltmEntries.slug, slug),
            eq(ltmEntries.version, expectedVersion),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .returning()

      if (result.length === 0) {
        const current = await db
          .select()
          .from(ltmEntries)
          .where(eq(ltmEntries.slug, slug))
          .limit(1)

        if (current.length === 0) {
          throw new Error(`LTM entry not found: ${slug}`)
        }

        if (current[0].archivedAt) {
          throw new Error(`LTM entry is already archived: ${slug}`)
        }

        throw new ConflictError(slug, expectedVersion, current[0].version)
      }
    },

    async glob(pattern: string, maxDepth?: number): Promise<LTMEntry[]> {
      const likePattern = globToLike(pattern)

      let query = db
        .select()
        .from(ltmEntries)
        .where(
          and(
            like(ltmEntries.path, likePattern),
            isNull(ltmEntries.archivedAt),
          ),
        )

      const results = await query.orderBy(ltmEntries.path)

      // Apply maxDepth filter if specified
      if (maxDepth !== undefined) {
        return results.filter((entry: LTMEntry) => {
          const depth = entry.path.split('/').length - 1 // -1 because path starts with /
          return depth <= maxDepth
        })
      }

      return results
    },

    async search(
      query: string,
      pathPrefix?: string,
    ): Promise<LTMSearchResult[]> {
      // Phase 1: Simple keyword search in title and body
      // Phase 2+: FTS or semantic search

      const queryLower = query.toLowerCase()

      let baseQuery = db
        .select()
        .from(ltmEntries)
        .where(isNull(ltmEntries.archivedAt))

      const results = await baseQuery

      const matches: LTMSearchResult[] = []

      for (const entry of results) {
        // Path prefix filter
        if (pathPrefix && !entry.path.startsWith(pathPrefix)) {
          continue
        }

        // Keyword matching
        const titleMatch = entry.title.toLowerCase().includes(queryLower)
        const bodyMatch = entry.body.toLowerCase().includes(queryLower)

        if (titleMatch || bodyMatch) {
          // Simple scoring: title matches are worth more
          const score = (titleMatch ? 2 : 0) + (bodyMatch ? 1 : 0)
          matches.push({entry, score})
        }
      }

      // Sort by score descending
      return matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    },

    async searchFTS(
      query: string,
      limit: number = 20,
    ): Promise<LTMFTSSearchResult[]> {
      // Use FTS5 MATCH with snippet() for highlighted excerpts
      //
      // Split query into words and join with OR for flexible matching
      // This finds entries containing ANY of the search terms, ranked by relevance
      // FTS5's BM25 ranking will prioritize entries with more matching terms
      const words = query
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => `"${w.replace(/"/g, '""')}"`) // Quote each word to escape special chars
        .join(' OR ')

      if (!words) {
        return []
      }

      const results = (await db._rawDb
        .prepare(
          `
        SELECT 
          slug,
          title,
          snippet(ltm_entries_fts, 2, '>>>', '<<<', '...', 32) as snippet,
          rank
        FROM ltm_entries_fts
        WHERE ltm_entries_fts MATCH ?
          AND slug IN (SELECT slug FROM ltm_entries WHERE archived_at IS NULL)
        ORDER BY rank
        LIMIT ?
      `,
        )
        .all(words, limit)) as Array<{
        slug: string
        title: string
        snippet: string
        rank: number
      }>

      return results.map((r) => ({
        slug: r.slug,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank,
      }))
    },

    async getChildren(parentSlug: string | null): Promise<LTMEntry[]> {
      if (parentSlug === null) {
        // Root level entries
        return db
          .select()
          .from(ltmEntries)
          .where(
            and(isNull(ltmEntries.parentSlug), isNull(ltmEntries.archivedAt)),
          )
          .orderBy(ltmEntries.slug)
      }

      return db
        .select()
        .from(ltmEntries)
        .where(
          and(
            eq(ltmEntries.parentSlug, parentSlug),
            isNull(ltmEntries.archivedAt),
          ),
        )
        .orderBy(ltmEntries.slug)
    },
  }
}
