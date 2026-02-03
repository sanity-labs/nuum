/**
 * LTM (Long-Term Memory) Tools
 *
 * Tools for interacting with the hierarchical knowledge base.
 * All tools use the Tool.define() pattern for consistency.
 *
 * Read-only tools (for main agent):
 * - LTMGlobTool: Browse tree structure
 * - LTMSearchTool: Keyword search
 * - LTMReadTool: Read specific entry
 *
 * Write tools (for consolidation agent):
 * - LTMCreateTool: Create new entry
 * - LTMUpdateTool: Full body replacement (CAS)
 * - LTMEditTool: Surgical find-replace (CAS)
 * - LTMReparentTool: Move entry in tree (CAS)
 * - LTMRenameTool: Change entry slug (CAS)
 * - LTMArchiveTool: Soft-delete entry (CAS)
 */

import {z} from 'zod'
import {Tool} from './tool'
import type {LTMStorage, AgentType} from '../storage/ltm'
import type {LTMEntry} from '../storage/schema'

// ============================================================================
// Shared Types
// ============================================================================

export interface LTMToolContext {
  ltm: LTMStorage
  agentType: AgentType
}

// Extend Tool.Metadata for LTM operations
export interface LTMMetadata extends Tool.Metadata {
  entrySlug?: string
  operation?: string
}

// ============================================================================
// Rendering Utilities
// ============================================================================

/**
 * Render entries as a compact indented tree.
 * Entries beyond displayDepth are collapsed with "(N items)" count.
 *
 * Example output for displayDepth=1:
 * project-preferences (18 items)
 * relevant-algorithms (12 items)
 *
 * Example output for displayDepth=2:
 * project-preferences
 *   auth-patterns (3 items)
 *   code-style
 *   testing-conventions (5 items)
 */
export function renderCompactTree(
  entries: LTMEntry[],
  displayDepth: number,
): string {
  if (entries.length === 0) {
    return '(empty)'
  }

  // Sort by path for consistent tree structure
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))

  // Build a map of path -> entry and path -> descendant count
  const descendantCount = new Map<string, number>()

  // Count descendants for each entry
  for (const entry of sorted) {
    // Walk up the path and increment ancestor counts
    const parts = entry.path.split('/').filter(Boolean)
    for (let i = 0; i < parts.length - 1; i++) {
      const ancestorPath = '/' + parts.slice(0, i + 1).join('/')
      descendantCount.set(
        ancestorPath,
        (descendantCount.get(ancestorPath) ?? 0) + 1,
      )
    }
  }

  // Render the tree
  const lines: string[] = []
  const rendered = new Set<string>()

  for (const entry of sorted) {
    const depth = entry.path.split('/').filter(Boolean).length

    // Skip if beyond display depth
    if (depth > displayDepth) {
      continue
    }

    // Skip if already rendered (shouldn't happen with sorted entries)
    if (rendered.has(entry.path)) {
      continue
    }
    rendered.add(entry.path)

    // Calculate indent (2 spaces per level, but root level has no indent)
    const indent = '  '.repeat(depth - 1)
    const slug = entry.slug

    // Check if this entry has children beyond display depth
    const childCount = descendantCount.get(entry.path) ?? 0

    if (childCount > 0 && depth === displayDepth) {
      // At display depth with hidden children - show count
      lines.push(`${indent}${slug} (${childCount} items)`)
    } else {
      // Either has children that will be shown, or is a leaf node
      lines.push(`${indent}${slug}`)
    }
  }

  return lines.join('\n')
}

/**
 * Parse a glob pattern to determine the display depth.
 * /* = show 1 level with counts
 * /** = show all levels
 * /foo/* = show 1 level under /foo
 */
export function parseGlobDisplayDepth(pattern: string): number {
  const hasDoublestar = pattern.includes('**')
  if (hasDoublestar) {
    return Infinity
  }
  // Count non-wildcard path segments
  const patternDepth = pattern
    .split('/')
    .filter((s) => s && s !== '**' && s !== '*').length
  return patternDepth + 1
}

// ============================================================================
// Read-Only Tools
// ============================================================================

export const LTMGlobTool = Tool.define<
  z.ZodObject<{
    pattern: z.ZodString
    maxDepth: z.ZodOptional<z.ZodNumber>
  }>,
  LTMMetadata
>('ltm_glob', {
  description: `Browse the knowledge base tree structure as a compact indented tree.

Use /* to see one level with collapsed counts:
  project-prefs (18 items)
  algorithms (12 items)

Use /** to expand everything:
  project-prefs
    auth-patterns
    code-style
  algorithms
    sorting
    searching

Example: ltm_glob({ pattern: "/*" })
Example: ltm_glob({ pattern: "/knowledge/**" })`,

  parameters: z.object({
    pattern: z
      .string()
      .describe(
        "Glob pattern: '/*' (root + counts), '/**' (expand all), '/foo/*' (under foo)",
      ),
    maxDepth: z
      .number()
      .optional()
      .describe('Override display depth calculation'),
  }),

  async execute(args, ctx) {
    const {ltm} = ctx.extra as unknown as LTMToolContext
    const {pattern, maxDepth} = args

    const displayDepth = maxDepth ?? parseGlobDisplayDepth(pattern)
    const entries = await ltm.glob(pattern)
    const output = renderCompactTree(entries, displayDepth)

    ctx.metadata({title: `ltm_glob(${pattern})`, metadata: {operation: 'glob'}})

    return {
      title: `ltm_glob(${pattern})`,
      metadata: {operation: 'glob'},
      output,
    }
  },
})

export const LTMSearchTool = Tool.define<
  z.ZodObject<{
    query: z.ZodString
    path: z.ZodOptional<z.ZodString>
    limit: z.ZodOptional<z.ZodNumber>
  }>,
  LTMMetadata
>('ltm_search', {
  description: `Search the knowledge base by keyword. Use BEFORE creating new entries to:
- Find related entries (avoid duplicates!)
- Find entries to update or merge
- Discover existing knowledge on a topic

Example: ltm_search({ query: "authentication" })
Example: ltm_search({ query: "hooks", path: "/knowledge/react", limit: 5 })
Returns: [{ slug, title, path, snippet }, ...] ranked by relevance`,

  parameters: z.object({
    query: z.string().describe('Search keywords'),
    path: z
      .string()
      .optional()
      .describe("Limit search to subtree (e.g., '/knowledge')"),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),

  async execute(args, ctx) {
    const {ltm} = ctx.extra as unknown as LTMToolContext
    const {query, path, limit} = args

    const results = await ltm.search(query, path)
    const limited = results.slice(0, limit ?? 10)

    ctx.metadata({
      title: `ltm_search("${query}")`,
      metadata: {operation: 'search'},
    })

    if (limited.length === 0) {
      return {
        title: `ltm_search("${query}")`,
        metadata: {operation: 'search'},
        output: `No entries found matching "${query}"`,
      }
    }

    const formatted = limited.map((r) => ({
      slug: r.entry.slug,
      title: r.entry.title,
      path: r.entry.path,
      snippet:
        r.entry.body.slice(0, 150) + (r.entry.body.length > 150 ? '...' : ''),
    }))

    return {
      title: `ltm_search("${query}")`,
      metadata: {operation: 'search'},
      output: JSON.stringify(formatted, null, 2),
    }
  },
})

export const LTMReadTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
  }>,
  LTMMetadata
>('ltm_read', {
  description: `Read an LTM entry by slug. Returns entry content, version, and path.

Use AFTER ltm_search finds relevant results, or when you know the exact slug.
The version is needed for CAS operations (edit, update, reparent, rename).

Example: ltm_read({ slug: "react-hooks" })
Returns: { slug, title, body, path, version } or "Entry not found"

Knowledge entries may contain [[slug]] cross-references - follow these to explore connected knowledge.`,

  parameters: z.object({
    slug: z
      .string()
      .describe("The entry slug to read (e.g., 'identity', 'react-hooks')"),
  }),

  async execute(args, ctx) {
    const {ltm} = ctx.extra as unknown as LTMToolContext
    const {slug} = args

    const entry = await ltm.read(slug)

    ctx.metadata({
      title: `ltm_read("${slug}")`,
      metadata: {entrySlug: slug, operation: 'read'},
    })

    if (!entry) {
      return {
        title: `ltm_read("${slug}")`,
        metadata: {entrySlug: slug, operation: 'read'},
        output: `Entry not found: ${slug}`,
      }
    }

    return {
      title: `ltm_read("${slug}")`,
      metadata: {entrySlug: slug, operation: 'read'},
      output: JSON.stringify(
        {
          slug: entry.slug,
          title: entry.title,
          body: entry.body,
          path: entry.path,
          version: entry.version,
        },
        null,
        2,
      ),
    }
  },
})

// ============================================================================
// Write Tools (for consolidation agent)
// ============================================================================

export const LTMCreateTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    parentSlug: z.ZodNullable<z.ZodString>
    title: z.ZodString
    body: z.ZodString
    links: z.ZodOptional<z.ZodArray<z.ZodString>>
  }>,
  LTMMetadata
>('ltm_create', {
  description: `Create a new LTM entry. Use for new knowledge that should be retained long-term.

IMPORTANT: Always use ltm_search first to check for existing related entries.
Consider updating existing entries instead of creating duplicates.

Example: ltm_create({
  slug: "project-auth-patterns",
  parentSlug: "knowledge",
  title: "Authentication Patterns",
  body: "OAuth2 flow used in this project. See also [[oauth-config]]."
})`,

  parameters: z.object({
    slug: z
      .string()
      .describe(
        "Unique identifier for the entry (e.g., 'project-auth-patterns')",
      ),
    parentSlug: z
      .string()
      .nullable()
      .describe(
        "Parent slug for hierarchy (null for root, 'knowledge' for general)",
      ),
    title: z.string().describe('Human-readable title'),
    body: z
      .string()
      .describe('Content with [[slug]] cross-links to related entries'),
    links: z
      .array(z.string())
      .optional()
      .describe('Explicit links to other entries'),
  }),

  async execute(args, ctx) {
    const {ltm, agentType} = ctx.extra as unknown as LTMToolContext
    const {slug, parentSlug, title, body, links} = args

    ctx.metadata({
      title: `ltm_create("${slug}")`,
      metadata: {entrySlug: slug, operation: 'create'},
    })

    try {
      await ltm.create({
        slug,
        parentSlug,
        title,
        body,
        links,
        createdBy: agentType,
      })

      return {
        title: `ltm_create("${slug}")`,
        metadata: {entrySlug: slug, operation: 'create'},
        output: `Created entry: ${slug}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        title: `ltm_create("${slug}")`,
        metadata: {entrySlug: slug, operation: 'create'},
        output: `Failed to create entry: ${msg}`,
      }
    }
  },
})

export const LTMUpdateTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    newBody: z.ZodString
    expectedVersion: z.ZodNumber
  }>,
  LTMMetadata
>('ltm_update', {
  description: `Replace an entry's entire body. Use for major rewrites.
For small changes, use ltm_edit instead (surgical find-replace).

Example: ltm_update({
  slug: "react-hooks",
  newBody: "Updated content with new information...",
  expectedVersion: 3
})

On version conflict: Error shows current version. Re-read and retry.`,

  parameters: z.object({
    slug: z.string().describe('The entry slug to update'),
    newBody: z
      .string()
      .describe('The new content to replace the existing body'),
    expectedVersion: z
      .number()
      .describe('Expected current version (from ltm_read)'),
  }),

  async execute(args, ctx) {
    const {ltm, agentType} = ctx.extra as unknown as LTMToolContext
    const {slug, newBody, expectedVersion} = args

    ctx.metadata({
      title: `ltm_update("${slug}")`,
      metadata: {entrySlug: slug, operation: 'update'},
    })

    try {
      await ltm.update(slug, newBody, expectedVersion, agentType)

      return {
        title: `ltm_update("${slug}")`,
        metadata: {entrySlug: slug, operation: 'update'},
        output: `Updated entry: ${slug} (now version ${expectedVersion + 1})`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Provide helpful CAS error message
      if (msg.includes('CAS conflict')) {
        const match = msg.match(/got (\d+)/)
        const currentVersion = match ? match[1] : 'unknown'
        return {
          title: `ltm_update("${slug}")`,
          metadata: {entrySlug: slug, operation: 'update'},
          output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
        }
      }
      return {
        title: `ltm_update("${slug}")`,
        metadata: {entrySlug: slug, operation: 'update'},
        output: `Failed to update entry: ${msg}`,
      }
    }
  },
})

export const LTMEditTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    oldString: z.ZodString
    newString: z.ZodString
    expectedVersion: z.ZodNumber
  }>,
  LTMMetadata
>('ltm_edit', {
  description: `Surgical find-replace within an entry. Use for precise edits.

Requires EXACT match of oldString (must appear exactly once).
For full rewrites, use ltm_update instead.

Example: ltm_edit({
  slug: "react-hooks",
  oldString: "useState hook",
  newString: "useState and useReducer hooks",
  expectedVersion: 3
})

On version conflict: Error shows current version - re-read and retry.`,

  parameters: z.object({
    slug: z.string().describe('The entry slug to edit'),
    oldString: z
      .string()
      .describe('Exact text to find (must match exactly once)'),
    newString: z.string().describe('Replacement text'),
    expectedVersion: z
      .number()
      .describe('Expected current version (from ltm_read)'),
  }),

  async execute(args, ctx) {
    const {ltm, agentType} = ctx.extra as unknown as LTMToolContext
    const {slug, oldString, newString, expectedVersion} = args

    ctx.metadata({
      title: `ltm_edit("${slug}")`,
      metadata: {entrySlug: slug, operation: 'edit'},
    })

    try {
      await ltm.edit(slug, oldString, newString, expectedVersion, agentType)

      return {
        title: `ltm_edit("${slug}")`,
        metadata: {entrySlug: slug, operation: 'edit'},
        output: `Edited entry: ${slug} (now version ${expectedVersion + 1})`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('CAS conflict')) {
        const match = msg.match(/got (\d+)/)
        const currentVersion = match ? match[1] : 'unknown'
        return {
          title: `ltm_edit("${slug}")`,
          metadata: {entrySlug: slug, operation: 'edit'},
          output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
        }
      }
      return {
        title: `ltm_edit("${slug}")`,
        metadata: {entrySlug: slug, operation: 'edit'},
        output: `Failed to edit entry: ${msg}`,
      }
    }
  },
})

export const LTMReparentTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    newParentSlug: z.ZodNullable<z.ZodString>
    expectedVersion: z.ZodNumber
  }>,
  LTMMetadata
>('ltm_reparent', {
  description: `Move an entry to a new location in the tree. Use to:
- Reorganize knowledge into better structure
- Group related entries under a common parent

Example: ltm_reparent({
  slug: "oauth-flow",
  newParentSlug: "auth-system",
  expectedVersion: 2
})

Updates path for this entry and all descendants.`,

  parameters: z.object({
    slug: z.string().describe('The entry to move'),
    newParentSlug: z
      .string()
      .nullable()
      .describe('New parent slug (null for root level)'),
    expectedVersion: z
      .number()
      .describe('Expected current version (from ltm_read)'),
  }),

  async execute(args, ctx) {
    const {ltm, agentType} = ctx.extra as unknown as LTMToolContext
    const {slug, newParentSlug, expectedVersion} = args

    ctx.metadata({
      title: `ltm_reparent("${slug}")`,
      metadata: {entrySlug: slug, operation: 'reparent'},
    })

    try {
      const updated = await ltm.reparent(
        slug,
        newParentSlug,
        expectedVersion,
        agentType,
      )

      return {
        title: `ltm_reparent("${slug}")`,
        metadata: {entrySlug: slug, operation: 'reparent'},
        output: `Moved entry: ${slug} to ${updated.path}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('CAS conflict')) {
        const match = msg.match(/got (\d+)/)
        const currentVersion = match ? match[1] : 'unknown'
        return {
          title: `ltm_reparent("${slug}")`,
          metadata: {entrySlug: slug, operation: 'reparent'},
          output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
        }
      }
      return {
        title: `ltm_reparent("${slug}")`,
        metadata: {entrySlug: slug, operation: 'reparent'},
        output: `Failed to reparent entry: ${msg}`,
      }
    }
  },
})

export const LTMRenameTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    newSlug: z.ZodString
    expectedVersion: z.ZodNumber
  }>,
  LTMMetadata
>('ltm_rename', {
  description: `Change an entry's slug. Use to:
- Fix naming for clarity
- Align with naming conventions

Example: ltm_rename({
  slug: "auth",
  newSlug: "authentication",
  expectedVersion: 1
})

Updates all paths. Children keep their relative position.`,

  parameters: z.object({
    slug: z.string().describe('Current slug of the entry'),
    newSlug: z.string().describe('New slug to use'),
    expectedVersion: z
      .number()
      .describe('Expected current version (from ltm_read)'),
  }),

  async execute(args, ctx) {
    const {ltm, agentType} = ctx.extra as unknown as LTMToolContext
    const {slug, newSlug, expectedVersion} = args

    ctx.metadata({
      title: `ltm_rename("${slug}")`,
      metadata: {entrySlug: slug, operation: 'rename'},
    })

    try {
      const updated = await ltm.rename(
        slug,
        newSlug,
        expectedVersion,
        agentType,
      )

      return {
        title: `ltm_rename("${slug}")`,
        metadata: {entrySlug: slug, operation: 'rename'},
        output: `Renamed entry: ${slug} → ${newSlug}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('CAS conflict')) {
        const match = msg.match(/got (\d+)/)
        const currentVersion = match ? match[1] : 'unknown'
        return {
          title: `ltm_rename("${slug}")`,
          metadata: {entrySlug: slug, operation: 'rename'},
          output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
        }
      }
      return {
        title: `ltm_rename("${slug}")`,
        metadata: {entrySlug: slug, operation: 'rename'},
        output: `Failed to rename entry: ${msg}`,
      }
    }
  },
})

export const LTMArchiveTool = Tool.define<
  z.ZodObject<{
    slug: z.ZodString
    expectedVersion: z.ZodNumber
  }>,
  LTMMetadata
>('ltm_archive', {
  description: `Archive an LTM entry that is no longer relevant. Archived entries are soft-deleted and excluded from searches.

Example: ltm_archive({
  slug: "outdated-info",
  expectedVersion: 5
})`,

  parameters: z.object({
    slug: z.string().describe('The entry slug to archive'),
    expectedVersion: z
      .number()
      .describe('Expected current version (from ltm_read)'),
  }),

  async execute(args, ctx) {
    const {ltm} = ctx.extra as unknown as LTMToolContext
    const {slug, expectedVersion} = args

    ctx.metadata({
      title: `ltm_archive("${slug}")`,
      metadata: {entrySlug: slug, operation: 'archive'},
    })

    try {
      await ltm.archive(slug, expectedVersion)

      return {
        title: `ltm_archive("${slug}")`,
        metadata: {entrySlug: slug, operation: 'archive'},
        output: `Archived entry: ${slug}`,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('CAS conflict')) {
        const match = msg.match(/got (\d+)/)
        const currentVersion = match ? match[1] : 'unknown'
        return {
          title: `ltm_archive("${slug}")`,
          metadata: {entrySlug: slug, operation: 'archive'},
          output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
        }
      }
      return {
        title: `ltm_archive("${slug}")`,
        metadata: {entrySlug: slug, operation: 'archive'},
        output: `Failed to archive entry: ${msg}`,
      }
    }
  },
})

// ============================================================================
// Tool Collections
// ============================================================================

/** Read-only tools for main agent */
export const LTMReadOnlyTools = {
  ltm_glob: LTMGlobTool,
  ltm_search: LTMSearchTool,
  ltm_read: LTMReadTool,
}

/** Write tools for consolidation agent */
export const LTMWriteTools = {
  ltm_create: LTMCreateTool,
  ltm_update: LTMUpdateTool,
  ltm_edit: LTMEditTool,
  ltm_reparent: LTMReparentTool,
  ltm_rename: LTMRenameTool,
  ltm_archive: LTMArchiveTool,
}

/** All LTM tools */
export const LTMTools = {
  ...LTMReadOnlyTools,
  ...LTMWriteTools,
}
