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
import {
  Tool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  LTMCreateTool,
  LTMUpdateTool,
  LTMEditTool,
  LTMReparentTool,
  LTMRenameTool,
  LTMArchiveTool,
  type LTMToolContext,
} from "../tool"

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
 * Uses shared tool definitions from src/tool/ltm.ts.
 */
function buildConsolidationTools(): Record<string, CoreTool> {
  const tools: Record<string, CoreTool> = {}

  // LTM read-only tools (shared definitions)
  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
  })

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
  })

  // LTM write tools (shared definitions)
  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
  })

  tools.ltm_update = tool({
    description: LTMUpdateTool.definition.description,
    parameters: LTMUpdateTool.definition.parameters,
  })

  tools.ltm_edit = tool({
    description: LTMEditTool.definition.description,
    parameters: LTMEditTool.definition.parameters,
  })

  tools.ltm_reparent = tool({
    description: LTMReparentTool.definition.description,
    parameters: LTMReparentTool.definition.parameters,
  })

  tools.ltm_rename = tool({
    description: LTMRenameTool.definition.description,
    parameters: LTMRenameTool.definition.parameters,
  })

  tools.ltm_archive = tool({
    description: LTMArchiveTool.definition.description,
    parameters: LTMArchiveTool.definition.parameters,
  })

  // finish_consolidation - Signal completion (consolidation-specific)
  tools.finish_consolidation = tool({
    description: "Call this when you have finished reviewing the conversation and updating LTM. Always call this to complete consolidation.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what was extracted/updated (or 'No updates needed' if nothing changed)"),
    }),
  })

  return tools
}

/**
 * Create an LTM tool context for consolidation.
 */
function createLTMContext(storage: Storage): Tool.Context & { extra: LTMToolContext } {
  const ctx = Tool.createContext({
    sessionID: "consolidation",
    messageID: "consolidation",
  })
  ;(ctx as Tool.Context & { extra: LTMToolContext }).extra = {
    ltm: storage.ltm,
    agentType: AGENT_TYPE,
  }
  return ctx as Tool.Context & { extra: LTMToolContext }
}

/**
 * Execute a consolidation tool call using shared tool implementations.
 */
async function executeConsolidationTool(
  toolName: string,
  args: Record<string, unknown>,
  storage: Storage,
  result: ConsolidationResult,
): Promise<{ output: string; done: boolean }> {
  const ctx = createLTMContext(storage)

  switch (toolName) {
    // Read-only tools - delegate to shared implementations
    case "ltm_read": {
      const toolResult = await LTMReadTool.definition.execute(
        args as z.infer<typeof LTMReadTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    case "ltm_glob": {
      const toolResult = await LTMGlobTool.definition.execute(
        args as z.infer<typeof LTMGlobTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    case "ltm_search": {
      const toolResult = await LTMSearchTool.definition.execute(
        args as z.infer<typeof LTMSearchTool.definition.parameters>,
        ctx,
      )
      return { output: toolResult.output, done: false }
    }

    // Write tools - delegate to shared implementations and track results
    case "ltm_create": {
      const toolResult = await LTMCreateTool.definition.execute(
        args as z.infer<typeof LTMCreateTool.definition.parameters>,
        ctx,
      )
      // Track success (shared tool returns "Created entry:" on success)
      if (toolResult.output.startsWith("Created entry:")) {
        result.entriesCreated++
        log.info("created LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_update": {
      const toolResult = await LTMUpdateTool.definition.execute(
        args as z.infer<typeof LTMUpdateTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Updated entry:")) {
        result.entriesUpdated++
        log.info("updated LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_edit": {
      const toolResult = await LTMEditTool.definition.execute(
        args as z.infer<typeof LTMEditTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Edited entry:")) {
        result.entriesUpdated++
        log.info("edited LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_reparent": {
      const toolResult = await LTMReparentTool.definition.execute(
        args as z.infer<typeof LTMReparentTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Moved entry:")) {
        result.entriesUpdated++
        log.info("reparented LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_rename": {
      const toolResult = await LTMRenameTool.definition.execute(
        args as z.infer<typeof LTMRenameTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Renamed entry:")) {
        result.entriesUpdated++
        log.info("renamed LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    case "ltm_archive": {
      const toolResult = await LTMArchiveTool.definition.execute(
        args as z.infer<typeof LTMArchiveTool.definition.parameters>,
        ctx,
      )
      if (toolResult.output.startsWith("Archived entry:")) {
        result.entriesArchived++
        log.info("archived LTM entry", { slug: (args as { slug: string }).slug })
      }
      return { output: toolResult.output, done: false }
    }

    // Consolidation-specific tool
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
  const tools = buildConsolidationTools()

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
