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
 */

import type {Storage} from '../storage'
import type {TemporalMessage, LTMEntry} from '../storage/schema'
import {Identifier} from '../id'
import {Log} from '../util/log'
import {runSubAgent} from '../sub-agent'
import {buildConsolidationTools, type ConsolidationToolResult} from './tools'
import {renderCompactTree} from '../tool'

const log = Log.create({service: 'consolidation-agent'})

const MAX_CONSOLIDATION_TURNS = 20

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
  /** Specific details about what changed (for background reports) */
  details: string[]
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
    if (msg.type === 'tool_call' || msg.type === 'tool_result') {
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
 * Build the LTM curation task content.
 * This is added as a user message to trigger the knowledge curation workflow.
 */
async function buildLTMReviewPrompt(
  storage: Storage,
  recentlyUpdatedEntries: LTMEntry[],
): Promise<string> {
  // Get the full LTM tree (3 levels deep)
  const allEntries = await storage.ltm.glob('/**')
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

${treeView || '(empty - time to start building!)'}
`

  // Add recently updated entries if any
  if (recentlyUpdatedEntries.length > 0) {
    content += `
### Recently Modified Entries

${recentlyUpdatedEntries.map((e) => `- **${e.slug}**: ${e.title}`).join('\n')}
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

---

### Tools Available

**Knowledge Base:**
- \`ltm_glob(pattern)\` - Browse tree ("/*" for top level, "/**" for all)
- \`ltm_search(query)\` - Find entries by keyword (ALWAYS search before creating!)
- \`ltm_read(slug)\` - Read full entry content
- \`ltm_create(slug, parentSlug, title, body)\` - New entry (parentSlug=null for root, or parent's slug)
- \`ltm_update(slug, body, version)\` - Full rewrite (CAS)
- \`ltm_edit(slug, old, new, version)\` - Surgical edit (CAS)
- \`ltm_reparent(slug, newParentSlug, version)\` - Move entry to new parent
- \`ltm_rename(slug, newSlug, version)\` - Change entry slug
- \`ltm_archive(slug, version)\` - Remove outdated entry

**Codebase Research:**
- \`read(filePath)\` - Read a file to verify/enrich knowledge
- \`glob(pattern)\` - Find files matching pattern
- \`grep(pattern)\` - Search file contents

**Web Research:**
- \`web_search(query)\` - Search the web for information
- \`web_fetch(url, question)\` - Read a webpage and extract info

---

### Special Entries: /identity and /behavior

These two entries are ALWAYS visible in your system prompt. Keep them current!

**/identity** - Your self-understanding
This frames everything you do. It's how you understand yourself in relationship to:
- The humans you work with (who are they? what's your relationship?)
- The kind of work you do together (what domains? what patterns?)
- Your environment (tools, systems, context you operate in)
- Other agents or entities you interact with
- Your own nature and capabilities

**/behavior** - How you operate
- User preferences you've learned
- Working patterns that work well
- Guidelines for code quality, testing, commits
- Communication style preferences

---

### Your Task

1. **First**: Capture any insights from the recent conversation (this is the priority)
2. **Then**: Look at your knowledge base - is it serving you well? Improve it.
3. **Check**: Are /identity and /behavior current? Update them if you've learned something new.
4. **Finally**: Call \`finish_consolidation\` with a contextual summary

### Writing Your Summary

When you call \`finish_consolidation\`, write a brief note to your future self explaining what you captured and why it matters.

**Good summaries** explain the WHAT and WHY:
- "Captured the insights on probabilistic filtering in [[bloom-filter-overview]]. Also archived the X system workarounds since it's been decommissioned."
- "Updated [[user-preferences]] with the new testing philosophy - run tests before committing."

**Avoid mechanical summaries**:
- ✗ "Created 2 entries, updated 1 entry"
- ✗ "Finished curation"

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
    summary: '',
    details: [],
    usage: {inputTokens: 0, outputTokens: 0},
  }

  // Check if conversation is noteworthy
  if (!isConversationNoteworthy(messages)) {
    log.info('skipping consolidation - conversation not noteworthy', {
      messageCount: messages.length,
    })
    result.summary = 'Skipped - conversation not noteworthy'
    return result
  }

  result.ran = true
  log.info('starting consolidation', {messageCount: messages.length})

  // Find recently updated entries (updated in the last hour)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const allEntries = await storage.ltm.glob('/**')
  const recentlyUpdated = allEntries.filter(
    (e) =>
      e.updatedAt > oneHourAgo &&
      e.slug !== 'identity' &&
      e.slug !== 'behavior',
  )

  // Build the task prompt
  const taskPrompt = await buildLTMReviewPrompt(storage, recentlyUpdated)

  // Build tools with result tracking
  const {tools, getLastResult} = buildConsolidationTools(storage)

  // Run sub-agent
  const subAgentResult = await runSubAgent(storage, {
    name: 'ltm-curator',
    taskPrompt,
    tools,
    finishToolName: 'finish_consolidation',
    extractResult: () => {
      // Extract summary from the last finish_consolidation call
      // This is a bit awkward - we track it via onToolResult
      return result.summary
    },
    tier: 'workhorse',
    maxTurns: MAX_CONSOLIDATION_TURNS,
    maxTokens: 2048,
    onToolResult: (toolCallId) => {
      const toolResult = getLastResult(toolCallId)
      if (!toolResult) return

      if (toolResult.entryCreated) {
        result.entriesCreated++
        if (toolResult.slug) {
          result.details.push(
            `Created [[${toolResult.slug}]]${toolResult.title ? ` - ${toolResult.title}` : ''}`,
          )
        }
      }
      if (toolResult.entryUpdated) {
        result.entriesUpdated++
        if (toolResult.slug) {
          result.details.push(`Updated [[${toolResult.slug}]]`)
        }
      }
      if (toolResult.entryArchived) {
        result.entriesArchived++
        if (toolResult.slug) {
          result.details.push(`Archived [[${toolResult.slug}]]`)
        }
      }
      if (toolResult.summary) {
        result.summary = toolResult.summary
      }
    },
  })

  result.usage = subAgentResult.usage

  // If no summary was set, the agent ended without calling finish_consolidation
  if (!result.summary) {
    result.summary = 'Consolidation ended without explicit finish'
  }

  log.info('consolidation complete', {
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
  const workerId = Identifier.ascending('worker')
  await storage.workers.create({
    id: workerId,
    type: 'ltm-consolidate',
    status: 'running',
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
