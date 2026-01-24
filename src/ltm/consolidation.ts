/**
 * LTM Knowledge Curator Agent
 *
 * Proactively maintains and improves the long-term knowledge base.
 * Runs BEFORE compaction, while full details are still available in temporal memory.
 *
 * Three priorities:
 * 1. CAPTURE - Extract insights from recent conversation
 * 2. STRENGTHEN - Proactively research and verify knowledge in current work area
 * 3. CURATE - Organize, cross-link, prune, and improve the knowledge base
 *
 * Tools available:
 *
 * Knowledge Base:
 * - ltm_glob, ltm_search, ltm_read: Navigate and search
 * - ltm_create, ltm_update, ltm_edit: Create and modify
 * - ltm_reparent, ltm_rename, ltm_archive: Organize
 *
 * Codebase Research:
 * - read: Read files to verify/enrich knowledge
 * - glob: Find files matching patterns
 * - grep: Search file contents
 *
 * Web Research:
 * - web_search: Search the web for information
 * - web_fetch: Read and extract info from a webpage
 *
 * Workflow:
 * - finish_consolidation: Signal completion
 */

import { tool } from "ai"
import type { CoreMessage, CoreTool } from "ai"
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
  WebSearchTool,
  WebFetchTool,
  ReadTool,
  GlobTool,
  GrepTool,
  renderCompactTree,
  type LTMToolContext,
} from "../tool"
import { buildAgentContext } from "../context"
import { runAgentLoop, stopOnTool } from "../agent/loop"

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
 * Result of a consolidation tool execution.
 */
interface ConsolidationToolResult {
  output: string
  done: boolean
  entryCreated?: boolean
  entryUpdated?: boolean
  entryArchived?: boolean
  summary?: string
}

/**
 * Build tools for the consolidation agent with execute callbacks.
 * Uses shared tool definitions from src/tool/ltm.ts.
 */
function buildConsolidationTools(
  storage: Storage,
): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => ConsolidationToolResult | undefined
} {
  // Track results by toolCallId for the agent loop to access
  const results = new Map<string, ConsolidationToolResult>()

  // Create LTM context for tool execution
  const createLTMContext = (toolCallId: string): Tool.Context & { extra: LTMToolContext } => {
    const ctx = Tool.createContext({
      sessionID: "consolidation",
      messageID: "consolidation",
      callID: toolCallId,
    })
    ;(ctx as Tool.Context & { extra: LTMToolContext }).extra = {
      ltm: storage.ltm,
      agentType: AGENT_TYPE,
    }
    return ctx as Tool.Context & { extra: LTMToolContext }
  }

  const tools: Record<string, CoreTool> = {}

  // LTM read-only tools (shared definitions)
  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMReadTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMGlobTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMSearchTool.definition.execute(args, createLTMContext(toolCallId))
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // LTM write tools (shared definitions)
  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMCreateTool.definition.execute(args, createLTMContext(toolCallId))
      const entryCreated = toolResult.output.startsWith("Created entry:")
      if (entryCreated) {
        log.info("created LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryCreated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_update = tool({
    description: LTMUpdateTool.definition.description,
    parameters: LTMUpdateTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMUpdateTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Updated entry:")
      if (entryUpdated) {
        log.info("updated LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_edit = tool({
    description: LTMEditTool.definition.description,
    parameters: LTMEditTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMEditTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Edited entry:")
      if (entryUpdated) {
        log.info("edited LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_reparent = tool({
    description: LTMReparentTool.definition.description,
    parameters: LTMReparentTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMReparentTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Moved entry:")
      if (entryUpdated) {
        log.info("reparented LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_rename = tool({
    description: LTMRenameTool.definition.description,
    parameters: LTMRenameTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMRenameTool.definition.execute(args, createLTMContext(toolCallId))
      const entryUpdated = toolResult.output.startsWith("Renamed entry:")
      if (entryUpdated) {
        log.info("renamed LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryUpdated }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_archive = tool({
    description: LTMArchiveTool.definition.description,
    parameters: LTMArchiveTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const toolResult = await LTMArchiveTool.definition.execute(args, createLTMContext(toolCallId))
      const entryArchived = toolResult.output.startsWith("Archived entry:")
      if (entryArchived) {
        log.info("archived LTM entry", { slug: args.slug })
      }
      const result: ConsolidationToolResult = { output: toolResult.output, done: false, entryArchived }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // File system tools for codebase research
  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const ctx = Tool.createContext({
        sessionID: "consolidation",
        messageID: "consolidation",
        callID: toolCallId,
      })
      const toolResult = await ReadTool.definition.execute(args, ctx)
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const ctx = Tool.createContext({
        sessionID: "consolidation",
        messageID: "consolidation",
        callID: toolCallId,
      })
      const toolResult = await GlobTool.definition.execute(args, ctx)
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const ctx = Tool.createContext({
        sessionID: "consolidation",
        messageID: "consolidation",
        callID: toolCallId,
      })
      const toolResult = await GrepTool.definition.execute(args, ctx)
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // Web tools for external research
  tools.web_search = tool({
    description: WebSearchTool.definition.description,
    parameters: WebSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const ctx = Tool.createContext({
        sessionID: "consolidation",
        messageID: "consolidation", 
        callID: toolCallId,
      })
      const toolResult = await WebSearchTool.definition.execute(args, ctx)
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.web_fetch = tool({
    description: WebFetchTool.definition.description,
    parameters: WebFetchTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      const ctx = Tool.createContext({
        sessionID: "consolidation",
        messageID: "consolidation",
        callID: toolCallId,
      })
      const toolResult = await WebFetchTool.definition.execute(args, ctx)
      const result: ConsolidationToolResult = { output: toolResult.output, done: false }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // finish_consolidation - Signal completion (consolidation-specific)
  tools.finish_consolidation = tool({
    description: "Call this when you have finished curating the knowledge base. Always call this to complete the task.",
    parameters: z.object({
      summary: z.string().describe("Brief summary of what you did: entries created/updated, research performed, organization changes, etc."),
    }),
    execute: async ({ summary }, { toolCallId }) => {
      const result: ConsolidationToolResult = { output: "Curation complete", done: true, summary }
      results.set(toolCallId, result)
      return result.output
    },
  })

  return {
    tools,
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}

/**
 * Build the LTM curation task content.
 * This is added as a user message to trigger the knowledge curation workflow.
 */
async function buildLTMReviewTurn(
  storage: Storage,
  recentlyUpdatedEntries: LTMEntry[],
): Promise<string> {
  // Get the full LTM tree (3 levels deep)
  const allEntries = await storage.ltm.glob("/**")
  const treeView = renderCompactTree(allEntries, 3)

  let content = `## Knowledge Base Curation Task

You are now the **Knowledge Curator**. Your job is to maintain and improve your long-term memory - a knowledge base that makes you more effective over time.

### Three Priorities (in order):

**1. CAPTURE** - Extract insights from the recent conversation
What did you learn? What decisions were made and why? What would help you work better next time?

**2. STRENGTHEN** - Proactively improve knowledge in the current work area
Look at what we're working on. Is your knowledge in this area solid? Use web search to:
- Verify facts you've recorded are still current
- Fill in gaps that would help you work more effectively
- Research related topics that might come up next
- Ensure technical details (APIs, libraries, protocols) are accurate

**3. CURATE** - Improve the knowledge base structure
Is it well-organized? Are entries cross-linked? Is anything stale or redundant?

---

### Current Knowledge Base

${treeView || "(empty - time to start building!)"}
`

  // Add recently updated entries if any
  if (recentlyUpdatedEntries.length > 0) {
    content += `
### Recently Modified Entries

${recentlyUpdatedEntries.map(e => `- **${e.slug}**: ${e.title}`).join("\n")}
`
  }

  content += `
---

### What Makes a GREAT Entry

**Accumulated wisdom (learnings, preferences, gotchas):**
- ✓ "User prefers simplicity over backwards compatibility - don't maintain legacy paths"
- ✓ "Haiku is unreliable with complex tool schemas - use workhorse tier instead"
- ✓ "MCP servers must be initialized before building tools - order matters"
- ✗ "We discussed the protocol today" (too vague, no actionable content)

**Decision rationale (the WHY matters):**
- ✓ "Chose raw NDJSON over JSON-RPC envelope because: simpler, matches Claude Code SDK, no users to migrate"
- ✗ "Using NDJSON format" (missing the WHY - useless for future decisions)

**Codebase documentation (valuable for complex projects!):**
- ✓ "src/jsonrpc/index.ts: Protocol server - handles stdin/stdout, message queuing, mid-turn injection via onBeforeTurn callback"
- ✓ "src/temporal/: Working memory system - compaction.ts (token budgets), view.ts (reconstruction), compaction-agent.ts (distillation)"
- ✓ "Tool pattern: parameters must be defined BEFORE Tool.define() call due to initialization order"
- ✗ "The config module handles configuration" (too obvious, adds no value)

**When to document code structure:**
- Complex modules with non-obvious responsibilities
- Files that interact in subtle ways
- Patterns that took effort to understand
- Entry points and key abstractions

---

### Curation Tasks (do these!)

**Organize the tree:**
- Group related entries under parent paths
- Use paths like /project/miriad-code/, /patterns/, /user-preferences/

**Cross-link for findability:**
- Use [[slug]] syntax to connect related entries
- Ask: "If I search for X, will I find this?"

**Maintain quality:**
- Combine entries that overlap significantly
- Split entries that cover too many topics
- Archive entries that are outdated or wrong
- Update entries with new information

**Enrich with research:**
- Use web_search/web_fetch to fact-check or fill gaps
- Look up documentation for libraries/APIs you reference
- Verify assumptions about external systems

---

### Tools Available

**Knowledge Base:**
- \`ltm_glob(pattern)\` - Browse tree ("/*" for top level, "/**" for all)
- \`ltm_search(query)\` - Find entries by keyword (ALWAYS search before creating!)
- \`ltm_read(slug)\` - Read full entry content
- \`ltm_create(slug, title, body, parentPath?)\` - New entry
- \`ltm_update(slug, body, version)\` - Full rewrite (CAS)
- \`ltm_edit(slug, old, new, version)\` - Surgical edit (CAS)
- \`ltm_reparent(slug, newParentPath, version)\` - Move entry
- \`ltm_rename(slug, newSlug, version)\` - Change slug
- \`ltm_archive(slug, version)\` - Remove outdated entry

**Codebase Research:**
- \`read(filePath)\` - Read a file to verify/enrich knowledge
- \`glob(pattern)\` - Find files matching pattern
- \`grep(pattern)\` - Search file contents

**Web Research:**
- \`web_search(query)\` - Search the web for information
- \`web_fetch(url, question)\` - Read a webpage and extract info

Use codebase tools to:
- Verify file paths in entries still exist
- Check if documented patterns are still accurate
- Explore related files to build richer documentation
- Confirm technical details before recording them

---

### Your Task

1. **First**: Capture any insights from the recent conversation (this is the priority)
2. **Then**: Look at your knowledge base - is it serving you well? Improve it.
3. **Finally**: Call \`finish_consolidation\` with a summary of what you did

Be proactive! This is YOUR knowledge base. Make it useful.
`

  return content
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

  // Build agent context (shared with all workloads)
  const ctx = await buildAgentContext(storage)

  // Find recently updated entries (updated in the last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const allEntries = await storage.ltm.glob("/**")
  const recentlyUpdated = allEntries.filter(
    (e) => e.updatedAt > oneHourAgo && e.slug !== "identity" && e.slug !== "behavior",
  )

  // Build the LTM review turn content (added as system message)
  const reviewTurnContent = await buildLTMReviewTurn(storage, recentlyUpdated)

  // Get model (use workhorse tier for consolidation - Haiku is unreliable with tool schemas)
  const model = Provider.getModelForTier("workhorse")

  // Build tools with execute callbacks
  const { tools, getLastResult } = buildConsolidationTools(storage)

  // Initial messages: conversation history + LTM review task as user message
  // (only the top-level system prompt can use system role)
  const initialMessages: CoreMessage[] = [
    ...ctx.historyTurns,
    { role: "user", content: `[SYSTEM TASK]\n\n${reviewTurnContent}` },
  ]

  // Run the agent loop using the generic loop abstraction
  const loopResult = await runAgentLoop({
    model,
    systemPrompt: ctx.systemPrompt,
    initialMessages,
    tools,
    maxTokens: 2048,
    temperature: 0,
    maxTurns: MAX_CONSOLIDATION_TURNS,
    isDone: stopOnTool("finish_consolidation"),
    onToolResult: (toolCallId) => {
      // Track results using our result tracking map
      const toolResult = getLastResult(toolCallId)
      if (toolResult?.entryCreated) {
        result.entriesCreated++
      }
      if (toolResult?.entryUpdated) {
        result.entriesUpdated++
      }
      if (toolResult?.entryArchived) {
        result.entriesArchived++
      }
      if (toolResult?.summary) {
        result.summary = toolResult.summary
      }
    },
  })

  result.usage.inputTokens += loopResult.usage.inputTokens
  result.usage.outputTokens += loopResult.usage.outputTokens

  // If no summary was set, the agent ended without calling finish_consolidation
  if (!result.summary) {
    result.summary = "Consolidation ended without explicit finish"
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
