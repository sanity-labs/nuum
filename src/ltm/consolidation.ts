/**
 * LTM Consolidation Agent
 *
 * Extracts durable knowledge from raw conversation messages into long-term memory.
 * Runs BEFORE compaction, while full details are still available in temporal memory.
 *
 * This is a mini-agent with limited tools focused on LTM operations:
 * - ltm_read: Read existing LTM entries
 * - ltm_create: Create new knowledge entries
 * - ltm_update: Update existing entries (with CAS)
 * - ltm_archive: Archive outdated entries
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
    description: "Read an LTM entry by path (slug). Returns the entry content or null if not found.",
    parameters: z.object({
      path: z.string().describe("The entry path/slug to read (e.g., 'identity', 'knowledge/preferences')"),
    }),
  })

  // ltm_create - Create a new LTM entry
  tools.ltm_create = tool({
    description: "Create a new LTM entry. Use for new knowledge that should be retained long-term. Required: slug, parentSlug, title, body.",
    parameters: z.object({
      slug: z.string().describe("Required. Unique identifier for the entry (e.g., 'project-auth-patterns')"),
      parentSlug: z.string().nullable().describe("Required. Parent entry slug for hierarchy (null for root level, 'knowledge' for general knowledge)"),
      title: z.string().describe("Required. Human-readable title"),
      body: z.string().describe("Required. The knowledge content to store - this is the main content of the entry"),
      tags: z.array(z.string()).optional().describe("Optional. Tags for searchability"),
    }),
  })

  // ltm_update - Update an existing LTM entry
  tools.ltm_update = tool({
    description: "Update an existing LTM entry. Uses compare-and-swap to prevent conflicts.",
    parameters: z.object({
      slug: z.string().describe("The entry slug to update"),
      newBody: z.string().describe("The new content to replace the existing body"),
      expectedVersion: z.number().describe("Expected current version (for CAS). Get this from ltm_read."),
    }),
  })

  // ltm_archive - Archive an outdated LTM entry
  tools.ltm_archive = tool({
    description: "Archive an LTM entry that is no longer relevant. Archived entries are soft-deleted.",
    parameters: z.object({
      slug: z.string().describe("The entry slug to archive"),
      expectedVersion: z.number().describe("Expected current version (for CAS). Get this from ltm_read."),
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
      const { path } = args as { path: string }
      const entry = await storage.ltm.read(path)
      if (!entry) {
        return { output: `Entry not found: ${path}`, done: false }
      }
      return {
        output: JSON.stringify({
          slug: entry.slug,
          title: entry.title,
          body: entry.body,
          version: entry.version,
          tags: JSON.parse(entry.tags),
        }, null, 2),
        done: false,
      }
    }

    case "ltm_create": {
      const { slug, parentSlug, title, body, tags } = args as {
        slug: string
        parentSlug: string | null
        title: string
        body: string
        tags?: string[]
      }
      try {
        await storage.ltm.create({
          slug,
          parentSlug,
          title,
          body,
          tags,
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
        return { output: `Updated entry: ${slug}`, done: false }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { output: `Failed to update entry: ${msg}`, done: false }
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

  prompt += `\n## Instructions
1. Review the conversation for durable knowledge worth retaining
2. Use ltm_read(path) to check existing entries before updating
3. Use ltm_create(slug, parentSlug, title, body) to add new knowledge - ALL fields are required:
   - slug: unique identifier (e.g., "user-prefers-typescript")
   - parentSlug: parent entry or null for root (use "knowledge" for general knowledge)
   - title: human-readable title
   - body: the actual knowledge content to store (REQUIRED - do not omit)
4. Use ltm_update(slug, newBody, expectedVersion) to modify existing entries
5. Be selective - only extract truly valuable, long-lasting information
6. Call finish_consolidation(summary) when done (even if no changes were made)
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

  // Get model (use fast tier for consolidation)
  const model = Provider.getModelForTier("fast")

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
