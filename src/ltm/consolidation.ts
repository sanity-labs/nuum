/**
 * LTM Consolidation Agent
 *
 * Extracts durable knowledge from raw conversation messages into long-term memory.
 * Runs BEFORE compaction, while full details are still available in temporal memory.
 *
 * This is a mini-agent (the "LTM Manager") with tools for knowledge curation:
 *
 * Navigation & Search:
 * - ltm_read: Read a specific entry
 * - ltm_glob: Browse tree structure
 * - ltm_search: Find related entries
 *
 * Creation & Modification:
 * - ltm_create: Create new knowledge entries
 * - ltm_update: Full rewrite of entry body (CAS)
 * - ltm_edit: Surgical find-replace (CAS)
 *
 * Organization:
 * - ltm_reparent: Move entry to new parent
 * - ltm_rename: Change entry slug
 * - ltm_archive: Soft-delete outdated entries
 *
 * Workflow:
 * - finish_consolidation: Signal completion
 */

import { tool } from "ai"
import type { CoreMessage, CoreTool, ToolCallPart, ToolResultPart, CoreAssistantMessage, CoreToolMessage } from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import type { TemporalMessage, LTMEntry } from "../storage/schema"
import type { AgentType } from "../storage/ltm"
import { Provider } from "../provider"
import { Identifier } from "../id"
import { Log } from "../util/log"

const log = Log.create({ service: "consolidation-agent" })

const MAX_CONSOLIDATION_TURNS = 10
const AGENT_TYPE: AgentType = "ltm-consolidate"

/**
 * Result of a consolidation run.
 */
export interface ConsolidationResult {
  /** Whether consolidation ran (false if skipped as trivial) */
  ran: boolean
  /** Number of LTM entries created */
  entriesCreated: number
  /** Number of LTM entries updated */
  entriesUpdated: number
  /** Number of LTM entries archived */
  entriesArchived: number
  /** Summary from the agent */
  summary: string
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Check if a conversation is noteworthy enough to warrant LTM consolidation.
 *
 * Trivial conversations (greetings, simple questions) don't need LTM updates.
 */
export function isConversationNoteworthy(messages: TemporalMessage[]): boolean {
  // Too few messages - probably trivial
  if (messages.length < 5) {
    return false
  }

  // Check for indicators of noteworthy content
  let hasToolUsage = false
  let hasSubstantialContent = false

  for (const msg of messages) {
    // Tool calls indicate real work was done
    if (msg.type === "tool_call" || msg.type === "tool_result") {
      hasToolUsage = true
    }

    // Check content length - substantial conversations have longer messages
    if (msg.content.length > 200) {
      hasSubstantialContent = true
    }
  }

  // Noteworthy if tools were used or conversation was substantial
  return hasToolUsage || hasSubstantialContent
}

/**
 * Build tools for the consolidation agent.
 */
function buildConsolidationTools(
  storage: Storage,
  result: ConsolidationResult,
): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {}

  // ltm_read - Read an LTM entry
  tools.ltm_read = tool({
    description: `Read an LTM entry by slug. Returns entry content, version, and path.

Use AFTER ltm_search finds relevant results, or when you know the exact slug.
The version is needed for CAS operations (edit, update, reparent, rename).

Example: ltm_read({ slug: "react-hooks" })
Returns: { slug, title, body, path, version } or "Entry not found"`,
    parameters: z.object({
      slug: z.string().describe("The entry slug to read (e.g., 'identity', 'react-hooks')"),
    }),
  })

  // ltm_glob - Browse tree structure (NEW)
  tools.ltm_glob = tool({
    description: `Browse the LTM tree structure. Use this BEFORE creating entries to:
- Find where related knowledge already exists
- Understand the tree organization
- Identify the right parent for new entries

Example: ltm_glob({ pattern: "/knowledge/**" })
Example: ltm_glob({ pattern: "/*", maxDepth: 1 })
Returns: [{ slug, title, path, hasChildren }, ...]`,
    parameters: z.object({
      pattern: z.string().describe("Glob pattern: '/**' (all), '/knowledge/**' (subtree), '/*' (root only)"),
      maxDepth: z.number().optional().describe("Maximum tree depth to return"),
    }),
  })

  // ltm_search - Search for related entries (NEW)
  tools.ltm_search = tool({
    description: `Search LTM by keyword. Use BEFORE creating new entries to:
- Find related entries (avoid duplicates!)
- Find entries to update or merge
- Discover existing knowledge on a topic

Example: ltm_search({ query: "authentication" })
Example: ltm_search({ query: "hooks", path: "/knowledge/react", limit: 5 })
Returns: [{ slug, title, path, snippet }, ...] ranked by relevance`,
    parameters: z.object({
      query: z.string().describe("Search keywords"),
      path: z.string().optional().describe("Limit search to subtree (e.g., '/knowledge')"),
      limit: z.number().optional().describe("Max results (default: 10)"),
    }),
  })

  // ltm_create - Create a new LTM entry
  tools.ltm_create = tool({
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
      slug: z.string().describe("Unique identifier for the entry (e.g., 'project-auth-patterns')"),
      parentSlug: z.string().nullable().describe("Parent slug for hierarchy (null for root, 'knowledge' for general)"),
      title: z.string().describe("Human-readable title"),
      body: z.string().describe("Content with [[slug]] cross-links to related entries"),
    }),
  })

  // ltm_update - Update an existing LTM entry (full rewrite)
  tools.ltm_update = tool({
    description: `Replace an entry's entire body. Use for major rewrites.
For small changes, use ltm_edit instead (surgical find-replace).

Example: ltm_update({
  slug: "react-hooks",
  newBody: "Updated content with new information...",
  expectedVersion: 3
})

On version conflict: Error shows current version. Re-read and retry.`,
    parameters: z.object({
      slug: z.string().describe("The entry slug to update"),
      newBody: z.string().describe("The new content to replace the existing body"),
      expectedVersion: z.number().describe("Expected current version (from ltm_read)"),
    }),
  })

  // ltm_edit - Surgical find-replace (NEW)
  tools.ltm_edit = tool({
    description: `Surgical find-replace within an entry. Use for precise edits.

Requires EXACT match of oldText (must appear exactly once).
For full rewrites, use ltm_update instead.

Example: ltm_edit({
  slug: "react-hooks",
  oldText: "useState hook",
  newText: "useState and useReducer hooks",
  expectedVersion: 3
})

On version conflict: Error shows current version - re-read and retry.`,
    parameters: z.object({
      slug: z.string().describe("The entry slug to edit"),
      oldText: z.string().describe("Exact text to find (must match exactly once)"),
      newText: z.string().describe("Replacement text"),
      expectedVersion: z.number().describe("Expected current version (from ltm_read)"),
    }),
  })

  // ltm_reparent - Move entry in tree (NEW)
  tools.ltm_reparent = tool({
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
      slug: z.string().describe("The entry to move"),
      newParentSlug: z.string().nullable().describe("New parent slug (null for root level)"),
      expectedVersion: z.number().describe("Expected current version (from ltm_read)"),
    }),
  })

  // ltm_rename - Change entry slug (NEW)
  tools.ltm_rename = tool({
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
      slug: z.string().describe("Current slug of the entry"),
      newSlug: z.string().describe("New slug to use"),
      expectedVersion: z.number().describe("Expected current version (from ltm_read)"),
    }),
  })

  // ltm_archive - Archive an outdated LTM entry
  tools.ltm_archive = tool({
    description: "Archive an LTM entry that is no longer relevant. Archived entries are soft-deleted and excluded from searches.",
    parameters: z.object({
      slug: z.string().describe("The entry slug to archive"),
      expectedVersion: z.number().describe("Expected current version (from ltm_read)"),
    }),
  })

  // finish_consolidation - Signal completion
  tools.finish_consolidation = tool({
    description: "Call this when you have finished reviewing the conversation and updating LTM. Always call this to complete consolidation.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what was extracted/updated (or 'No updates needed' if nothing changed)"),
    }),
  })

  return tools
}

/**
 * Execute a consolidation tool call.
 */
async function executeConsolidationTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  result: ConsolidationResult,
): Promise<{ output: string; done: boolean }> {
  switch (toolName) {
    case "ltm_read": {
      const { slug } = args as { slug: string }
      const entry = await storage.ltm.read(slug)
      if (!entry) {
        return { output: `Entry not found: ${slug}`, done: false }
      }
      return {
        output: JSON.stringify({
          slug: entry.slug,
          title: entry.title,
          body: entry.body,
          path: entry.path,
          version: entry.version,
        }, null, 2),
        done: false,
      }
    }

    case "ltm_glob": {
      const { pattern, maxDepth } = args as { pattern: string; maxDepth?: number }
      try {
        const entries = await storage.ltm.glob(pattern, maxDepth)
        const children = await Promise.all(entries.map(async e => {
          const kids = await storage.ltm.getChildren(e.slug)
          return {
            slug: e.slug,
            title: e.title,
            path: e.path,
            hasChildren: kids.length > 0,
          }
        }))
        return {
          output: JSON.stringify(children, null, 2),
          done: false,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { output: `Failed to glob: ${msg}`, done: false }
      }
    }

    case "ltm_search": {
      const { query, path, limit } = args as { query: string; path?: string; limit?: number }
      try {
        const results = await storage.ltm.search(query, path)
        const limited = results.slice(0, limit ?? 10)
        const formatted = limited.map(r => ({
          slug: r.entry.slug,
          title: r.entry.title,
          path: r.entry.path,
          snippet: r.entry.body.slice(0, 150) + (r.entry.body.length > 150 ? "..." : ""),
        }))
        return {
          output: formatted.length > 0
            ? JSON.stringify(formatted, null, 2)
            : `No entries found matching "${query}"`,
          done: false,
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { output: `Failed to search: ${msg}`, done: false }
      }
    }

    case "ltm_create": {
      const { slug, parentSlug, title, body } = args as {
        slug: string
        parentSlug: string | null
        title: string
        body: string
      }
      try {
        await storage.ltm.create({
          slug,
          parentSlug,
          title,
          body,
          createdBy: AGENT_TYPE,
        })
        result.entriesCreated++
        log.info("created LTM entry", { slug, parentSlug })
        return { output: `Created entry: ${slug}`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { output: `Failed to create entry: ${msg}`, done: false }
      }
    }

    case "ltm_update": {
      const { slug, newBody, expectedVersion } = args as {
        slug: string
        newBody: string
        expectedVersion: number
      }
      try {
        await storage.ltm.update(slug, newBody, expectedVersion, AGENT_TYPE)
        result.entriesUpdated++
        log.info("updated LTM entry", { slug })
        return { output: `Updated entry: ${slug} (now version ${expectedVersion + 1})`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Provide helpful CAS error message
        if (msg.includes("CAS conflict")) {
          const match = msg.match(/got (\d+)/)
          const currentVersion = match ? match[1] : "unknown"
          return {
            output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
            done: false,
          }
        }
        return { output: `Failed to update entry: ${msg}`, done: false }
      }
    }

    case "ltm_edit": {
      const { slug, oldText, newText, expectedVersion } = args as {
        slug: string
        oldText: string
        newText: string
        expectedVersion: number
      }
      try {
        await storage.ltm.edit(slug, oldText, newText, expectedVersion, AGENT_TYPE)
        result.entriesUpdated++
        log.info("edited LTM entry", { slug })
        return { output: `Edited entry: ${slug} (now version ${expectedVersion + 1})`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("CAS conflict")) {
          const match = msg.match(/got (\d+)/)
          const currentVersion = match ? match[1] : "unknown"
          return {
            output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
            done: false,
          }
        }
        return { output: `Failed to edit entry: ${msg}`, done: false }
      }
    }

    case "ltm_reparent": {
      const { slug, newParentSlug, expectedVersion } = args as {
        slug: string
        newParentSlug: string | null
        expectedVersion: number
      }
      try {
        const updated = await storage.ltm.reparent(slug, newParentSlug, expectedVersion, AGENT_TYPE)
        result.entriesUpdated++
        log.info("reparented LTM entry", { slug, newParentSlug, newPath: updated.path })
        return { output: `Moved entry: ${slug} to ${updated.path}`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("CAS conflict")) {
          const match = msg.match(/got (\d+)/)
          const currentVersion = match ? match[1] : "unknown"
          return {
            output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
            done: false,
          }
        }
        return { output: `Failed to reparent entry: ${msg}`, done: false }
      }
    }

    case "ltm_rename": {
      const { slug, newSlug, expectedVersion } = args as {
        slug: string
        newSlug: string
        expectedVersion: number
      }
      try {
        const updated = await storage.ltm.rename(slug, newSlug, expectedVersion, AGENT_TYPE)
        result.entriesUpdated++
        log.info("renamed LTM entry", { slug, newSlug, newPath: updated.path })
        return { output: `Renamed entry: ${slug} → ${newSlug}`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("CAS conflict")) {
          const match = msg.match(/got (\d+)/)
          const currentVersion = match ? match[1] : "unknown"
          return {
            output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
            done: false,
          }
        }
        return { output: `Failed to rename entry: ${msg}`, done: false }
      }
    }

    case "ltm_archive": {
      const { slug, expectedVersion } = args as {
        slug: string
        expectedVersion: number
      }
      try {
        await storage.ltm.archive(slug, expectedVersion)
        result.entriesArchived++
        log.info("archived LTM entry", { slug })
        return { output: `Archived entry: ${slug}`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes("CAS conflict")) {
          const match = msg.match(/got (\d+)/)
          const currentVersion = match ? match[1] : "unknown"
          return {
            output: `Version conflict: expected ${expectedVersion}, current is ${currentVersion}. Re-read with ltm_read("${slug}") and retry with the current version.`,
            done: false,
          }
        }
        return { output: `Failed to archive entry: ${msg}`, done: false }
      }
    }

    case "finish_consolidation": {
      const { summary } = args as { summary: string }
      result.summary = summary
      return { output: "Consolidation complete", done: true }
    }

    default:
      return { output: `Unknown tool: ${toolName}`, done: false }
  }
}

/**
 * Build the consolidation prompt.
 */
function buildConsolidationPrompt(
  messages: TemporalMessage[],
  currentLTM: { identity: LTMEntry | null; behavior: LTMEntry | null; knowledge: LTMEntry[] },
): string {
  let prompt = `You are reviewing a conversation to extract durable knowledge for long-term memory.

Your task: Review the conversation below and decide if any information should be saved to LTM.

## What to Extract
- User preferences and working style
- Project-specific patterns and conventions
- Technical decisions and their rationale
- Important facts about the codebase or workflow
- Corrections to existing knowledge

## What NOT to Extract
- Transient task details (these go in temporal memory)
- Obvious or trivial information
- Speculative or uncertain information

## Current LTM State
`

  // Add identity
  if (currentLTM.identity) {
    prompt += `\n### /identity\n${currentLTM.identity.body}\n`
  } else {
    prompt += `\n### /identity\n(not set)\n`
  }

  // Add behavior
  if (currentLTM.behavior) {
    prompt += `\n### /behavior\n${currentLTM.behavior.body}\n`
  } else {
    prompt += `\n### /behavior\n(not set)\n`
  }

  // Add knowledge entries
  if (currentLTM.knowledge.length > 0) {
    prompt += `\n### /knowledge entries\n`
    for (const entry of currentLTM.knowledge) {
      prompt += `- ${entry.slug}: ${entry.title}\n`
    }
  }

  prompt += `\n## Conversation to Review\n`

  // Add messages
  for (const msg of messages) {
    const prefix = msg.type === "user" ? "User" : msg.type === "assistant" ? "Assistant" : `[${msg.type}]`
    // Truncate very long messages
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + "... [truncated]" : msg.content
    prompt += `\n${prefix}: ${content}\n`
  }

  prompt += `\n## Your Role: Knowledge Curator

Your job is to maintain the knowledge base as a SHARP tool, not a garbage pile.

### Before Creating Entries
1. Use ltm_search() to check if related knowledge exists - avoid duplicates!
2. Use ltm_glob() to understand the tree structure and find the right location
3. Decide: create new, update existing, or merge?

### When Curating
- Merge overlapping entries rather than creating duplicates
- Use ltm_reparent() to organize entries logically
- Use ltm_rename() to fix unclear slugs
- Keep entries focused and specific
- Use [[slug]] syntax to cross-link related entries

### Cross-Linking Convention
Use [[slug]] in entry bodies to reference other knowledge entries.
Example: "This builds on [[auth-patterns]] and relates to [[oauth-flow]]"
Cross-links help navigate connected knowledge.

### What to Extract
- User preferences and working style
- Project-specific patterns and conventions
- Technical decisions and their rationale
- Important facts about the codebase or workflow
- Corrections to existing knowledge

### What NOT to Extract
- Transient task details (these go in temporal memory)
- Obvious or trivial information
- Speculative or uncertain information

### Workflow
1. Review the conversation for durable knowledge
2. Search for existing related entries
3. Update or create entries as needed
4. Call finish_consolidation when done (even if no changes were made)

The knowledge base should get SHARPER over time, not just bigger.
`

  return prompt
}

/**
 * Run the consolidation agent.
 *
 * Extracts durable knowledge from raw messages before compaction runs.
 */
export async function runConsolidation(
  storage: Storage,
  messages: TemporalMessage[],
): Promise<ConsolidationResult> {
  const result: ConsolidationResult = {
    ran: false,
    entriesCreated: 0,
    entriesUpdated: 0,
    entriesArchived: 0,
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  }

  // Check if conversation is noteworthy
  if (!isConversationNoteworthy(messages)) {
    log.info("skipping consolidation - conversation not noteworthy", {
      messageCount: messages.length,
    })
    result.summary = "Skipped - conversation not noteworthy"
    return result
  }

  result.ran = true
  log.info("starting consolidation", { messageCount: messages.length })

  // Get current LTM state for context
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")
  const allEntries = await storage.ltm.glob("/**")
  const knowledge = allEntries.filter(e => e.slug !== "identity" && e.slug !== "behavior")

  // Build the consolidation prompt
  const systemPrompt = buildConsolidationPrompt(messages, { identity, behavior, knowledge })

  // Get model (use workhorse tier for consolidation - Haiku is unreliable with tool schemas)
  const model = Provider.getModelForTier("workhorse")

  // Build tools
  const tools = buildConsolidationTools(storage, result)

  // Agent loop
  const agentMessages: CoreMessage[] = [
    { role: "user", content: "Review this conversation and extract any durable knowledge to LTM." },
  ]

  for (let turn = 0; turn < MAX_CONSOLIDATION_TURNS; turn++) {
    const response = await Provider.generate({
      model,
      system: systemPrompt,
      messages: agentMessages,
      tools,
      maxTokens: 2048,
      temperature: 0,
    })

    result.usage.inputTokens += response.usage.promptTokens
    result.usage.outputTokens += response.usage.completionTokens

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const assistantParts: (import("ai").TextPart | ToolCallPart)[] = []
      const toolResultParts: ToolResultPart[] = []

      if (response.text) {
        assistantParts.push({ type: "text", text: response.text })
      }

      let done = false

      for (const toolCall of response.toolCalls) {
        assistantParts.push({
          type: "tool-call",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        })

        const { output, done: toolDone } = await executeConsolidationTool(
          toolCall.toolName,
          toolCall.args as Record<string, unknown>,
          storage,
          result,
        )

        toolResultParts.push({
          type: "tool-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: output,
        })

        if (toolDone) {
          done = true
        }
      }

      agentMessages.push({ role: "assistant", content: assistantParts })
      agentMessages.push({ role: "tool", content: toolResultParts })

      if (done) {
        break
      }
    } else {
      // No tool calls - agent might be done
      if (response.text) {
        agentMessages.push({ role: "assistant", content: response.text })
      }
      // Give the agent one more chance to call finish_consolidation
      if (turn === MAX_CONSOLIDATION_TURNS - 1) {
        result.summary = "Consolidation ended without explicit finish"
      }
      break
    }
  }

  log.info("consolidation complete", {
    entriesCreated: result.entriesCreated,
    entriesUpdated: result.entriesUpdated,
    entriesArchived: result.entriesArchived,
    summary: result.summary,
  })

  return result
}

/**
 * Run consolidation as a worker with tracking.
 */
export async function runConsolidationWorker(
  storage: Storage,
  messages: TemporalMessage[],
): Promise<ConsolidationResult> {
  // Create worker record
  const workerId = Identifier.ascending("worker")
  await storage.workers.create({
    id: workerId,
    type: "ltm-consolidate",
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  })

  try {
    const result = await runConsolidation(storage, messages)
    await storage.workers.complete(workerId)
    return result
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await storage.workers.fail(workerId, error)
    throw e
  }
}
