/**
 * Inspect commands for miriad-code
 *
 * --inspect: Shows LTM tree structure + memory stats
 * --dump: Shows the system prompt + conversation turns as they would appear to the agent
 * --compact: Force run compaction to reduce effective view size
 *
 * --inspect and --dump work without API key (no LLM calls).
 * --compact requires API key (runs the compaction agent).
 */

import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { buildTemporalView, reconstructHistoryAsTurns } from "../temporal"
import { runMemoryCuration, getEffectiveViewTokens } from "../memory"
import { buildAgentContext } from "../context"
import { Config } from "../config"
import type { CoreMessage } from "ai"

const SEPARATOR = "═".repeat(70)
const SUBSEPARATOR = "─".repeat(70)

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Format a number with thousand separators.
 */
function fmt(n: number): string {
  return n.toLocaleString()
}

interface LTMTreeNode {
  slug: string
  path: string
  title: string | null
  body: string
  parentSlug: string | null
  children: LTMTreeNode[]
  archived: boolean
  tokens: number
}

/**
 * Build a tree structure from LTM entries.
 */
async function buildLTMTree(storage: Storage): Promise<LTMTreeNode[]> {
  const entries = await storage.ltm.glob("/**")
  const nodeMap = new Map<string, LTMTreeNode>()

  // First pass: create all nodes
  for (const entry of entries) {
    nodeMap.set(entry.slug, {
      slug: entry.slug,
      path: entry.path,
      title: entry.title,
      body: entry.body,
      parentSlug: entry.parentSlug,
      children: [],
      archived: !!entry.archivedAt,
      tokens: estimateTokens(entry.body),
    })
  }

  // Second pass: link children to parents
  const roots: LTMTreeNode[] = []
  for (const node of nodeMap.values()) {
    if (node.parentSlug && nodeMap.has(node.parentSlug)) {
      nodeMap.get(node.parentSlug)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Sort children by slug
  function sortChildren(node: LTMTreeNode) {
    node.children.sort((a, b) => a.slug.localeCompare(b.slug))
    for (const child of node.children) {
      sortChildren(child)
    }
  }
  for (const root of roots) {
    sortChildren(root)
  }

  return roots.sort((a, b) => a.slug.localeCompare(b.slug))
}

/**
 * Render LTM tree as indented text.
 */
function renderLTMTree(nodes: LTMTreeNode[], indent: number = 0): string {
  const lines: string[] = []
  const prefix = "  ".repeat(indent)

  for (const node of nodes) {
    const archived = node.archived ? " [archived]" : ""
    const title = node.title ? ` "${node.title}"` : ""
    const tokens = node.tokens > 0 ? ` (${fmt(node.tokens)} tokens)` : ""
    lines.push(`${prefix}/${node.slug}${title}${tokens}${archived}`)

    if (node.children.length > 0) {
      lines.push(renderLTMTree(node.children, indent + 1))
    }
  }

  return lines.join("\n")
}

interface SummaryOrderStats {
  order: number
  count: number
  totalTokens: number
}

interface MemoryStats {
  // Temporal (raw storage)
  totalMessages: number
  totalMessageTokens: number
  totalSummaries: number
  totalSummaryTokens: number
  summariesByOrder: SummaryOrderStats[]
  // Effective view (what goes to agent)
  viewSummaryCount: number
  viewSummaryTokens: number
  viewMessageCount: number
  viewMessageTokens: number
  viewTotalTokens: number
  compactionThreshold: number
  compactionTarget: number
  // Present
  mission: string | null
  status: string | null
  tasksPending: number
  tasksInProgress: number
  tasksCompleted: number
  tasksBlocked: number
  // LTM
  ltmTotalEntries: number
  ltmActiveEntries: number
  ltmTotalTokens: number
  identityTokens: number
  behaviorTokens: number
}

/**
 * Gather memory statistics.
 */
async function getMemoryStats(storage: Storage): Promise<MemoryStats> {
  const config = Config.get()
  const compactionThreshold = config.tokenBudgets.compactionThreshold
  const compactionTarget = config.tokenBudgets.compactionTarget

  // Get temporal data
  const messages = await storage.temporal.getMessages()
  const summaries = await storage.temporal.getSummaries()

  // Build temporal view (the effective context that goes to agents)
  const view = buildTemporalView({
    budget: compactionThreshold, // budget is informational
    messages,
    summaries,
  })

  // Calculate message tokens
  const totalMessageTokens = messages.reduce((sum, m) => sum + m.tokenEstimate, 0)

  // Calculate summary stats by order
  const summariesByOrder: SummaryOrderStats[] = []
  const orderMap = new Map<number, { count: number; tokens: number }>()

  for (const summary of summaries) {
    const existing = orderMap.get(summary.orderNum) ?? { count: 0, tokens: 0 }
    existing.count++
    existing.tokens += summary.tokenEstimate
    orderMap.set(summary.orderNum, existing)
  }

  for (const [order, stats] of orderMap.entries()) {
    summariesByOrder.push({
      order,
      count: stats.count,
      totalTokens: stats.tokens,
    })
  }
  summariesByOrder.sort((a, b) => a.order - b.order)

  const totalSummaryTokens = summaries.reduce((sum, s) => sum + s.tokenEstimate, 0)

  // Get present state
  const present = await storage.present.get()
  const tasksPending = present.tasks.filter(t => t.status === "pending").length
  const tasksInProgress = present.tasks.filter(t => t.status === "in_progress").length
  const tasksCompleted = present.tasks.filter(t => t.status === "completed").length
  const tasksBlocked = present.tasks.filter(t => t.status === "blocked").length

  // Get LTM stats
  const ltmEntries = await storage.ltm.glob("/**")
  const activeEntries = ltmEntries.filter(e => !e.archivedAt)
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")
  const ltmTotalTokens = ltmEntries.reduce((sum, e) => sum + estimateTokens(e.body), 0)

  return {
    totalMessages: messages.length,
    totalMessageTokens,
    totalSummaries: summaries.length,
    totalSummaryTokens,
    summariesByOrder,
    viewSummaryCount: view.summaries.length,
    viewSummaryTokens: view.breakdown.summaryTokens,
    viewMessageCount: view.messages.length,
    viewMessageTokens: view.breakdown.messageTokens,
    viewTotalTokens: view.totalTokens,
    compactionThreshold,
    compactionTarget,
    mission: present.mission,
    status: present.status,
    tasksPending,
    tasksInProgress,
    tasksCompleted,
    tasksBlocked,
    ltmTotalEntries: ltmEntries.length,
    ltmActiveEntries: activeEntries.length,
    ltmTotalTokens,
    identityTokens: identity ? estimateTokens(identity.body) : 0,
    behaviorTokens: behavior ? estimateTokens(behavior.body) : 0,
  }
}

/**
 * Run the --inspect command.
 * Shows LTM tree + memory stats.
 */
export async function runInspect(dbPath: string): Promise<void> {
  const storage = createStorage(dbPath)
  await initializeDefaultEntries(storage)

  const stats = await getMemoryStats(storage)
  const ltmTree = await buildLTMTree(storage)

  console.log()
  console.log(SEPARATOR)
  console.log("LONG-TERM MEMORY TREE")
  console.log(SEPARATOR)
  console.log()

  if (ltmTree.length > 0) {
    console.log(renderLTMTree(ltmTree))
  } else {
    console.log("(no entries)")
  }

  console.log()
  console.log(`Total: ${stats.ltmActiveEntries} active, ${stats.ltmTotalEntries - stats.ltmActiveEntries} archived (${fmt(stats.ltmTotalTokens)} tokens)`)

  console.log()
  console.log(SEPARATOR)
  console.log("TEMPORAL MEMORY")
  console.log(SEPARATOR)
  console.log()

  console.log(`Messages: ${fmt(stats.totalMessages)} (${fmt(stats.totalMessageTokens)} tokens)`)

  if (stats.summariesByOrder.length > 0) {
    console.log(`Summaries:`)
    for (const orderStats of stats.summariesByOrder) {
      console.log(`  Order-${orderStats.order}: ${orderStats.count} (${fmt(orderStats.totalTokens)} tokens)`)
    }
  } else {
    console.log(`Summaries: none`)
  }

  console.log()
  const needsCompaction = stats.viewTotalTokens > stats.compactionThreshold
  const compactionStatus = needsCompaction ? " (compaction needed)" : ""
  console.log(`Effective view (what goes to agent):`)
  console.log(`  Summaries: ${stats.viewSummaryCount} (${fmt(stats.viewSummaryTokens)} tokens)`)
  console.log(`  Messages: ${stats.viewMessageCount} (${fmt(stats.viewMessageTokens)} tokens)`)
  console.log(`  Total: ${fmt(stats.viewTotalTokens)} / ${fmt(stats.compactionThreshold)} threshold${compactionStatus}`)
  console.log(`  Target: ${fmt(stats.compactionTarget)} tokens`)

  console.log()
  console.log(SEPARATOR)
  console.log("PRESENT STATE")
  console.log(SEPARATOR)
  console.log()

  console.log(`Mission: ${stats.mission ?? "(none)"}`)
  console.log(`Status: ${stats.status ?? "(none)"}`)

  const totalTasks = stats.tasksPending + stats.tasksInProgress + stats.tasksCompleted + stats.tasksBlocked
  if (totalTasks > 0) {
    console.log(`Tasks: ${totalTasks} total`)
    if (stats.tasksPending > 0) console.log(`  Pending: ${stats.tasksPending}`)
    if (stats.tasksInProgress > 0) console.log(`  In progress: ${stats.tasksInProgress}`)
    if (stats.tasksCompleted > 0) console.log(`  Completed: ${stats.tasksCompleted}`)
    if (stats.tasksBlocked > 0) console.log(`  Blocked: ${stats.tasksBlocked}`)
  } else {
    console.log(`Tasks: none`)
  }

  console.log()
}

/**
 * Render a CoreMessage turn content for display.
 * Shows exactly what the agent would see.
 */
function renderTurnContent(turn: CoreMessage): string {
  if (typeof turn.content === "string") {
    return turn.content
  } else if (Array.isArray(turn.content)) {
    const parts: string[] = []
    for (const part of turn.content) {
      if (part.type === "text") {
        parts.push(part.text)
      } else if (part.type === "tool-call") {
        parts.push(`[tool_call: ${part.toolName}(${JSON.stringify(part.args)})]`)
      } else if (part.type === "tool-result") {
        const result = typeof part.result === "string"
          ? part.result.slice(0, 500) + (part.result.length > 500 ? "..." : "")
          : JSON.stringify(part.result).slice(0, 500)
        parts.push(`[tool_result: ${part.toolName}] ${result}`)
      }
    }
    return parts.join("\n")
  }
  return ""
}

/**
 * Run the --dump command.
 * Shows exactly what the agent sees - system prompt and conversation turns.
 * No decorative formatting, just the raw content as sent to the LLM.
 */
export async function runDump(dbPath: string): Promise<void> {
  const storage = createStorage(dbPath)
  await initializeDefaultEntries(storage)

  // Build agent context exactly as the agent sees it
  const ctx = await buildAgentContext(storage)
  const systemPrompt = ctx.systemPrompt
  const systemTokens = ctx.systemTokens
  const conversationTurns = ctx.historyTurns

  // Calculate conversation tokens (rough estimate)
  const conversationTokens = conversationTurns.reduce((sum, turn) => {
    if (typeof turn.content === "string") {
      return sum + estimateTokens(turn.content)
    } else if (Array.isArray(turn.content)) {
      let tokens = 0
      for (const part of turn.content) {
        if (part.type === "text") {
          tokens += estimateTokens(part.text)
        } else if (part.type === "tool-call") {
          tokens += estimateTokens(JSON.stringify(part.args)) + 20
        } else if (part.type === "tool-result") {
          tokens += estimateTokens(typeof part.result === "string" ? part.result : JSON.stringify(part.result))
        }
      }
      return sum + tokens
    }
    return sum
  }, 0)

  const totalTokens = systemTokens + conversationTokens

  // Header with stats
  console.log()
  console.log(`# Agent Prompt Dump`)
  console.log(`# System: ~${fmt(systemTokens)} tokens | Conversation: ${conversationTurns.length} turns, ~${fmt(conversationTokens)} tokens | Total: ~${fmt(totalTokens)} tokens`)
  console.log()

  // System prompt - exactly as sent
  console.log(`=== SYSTEM ===`)
  console.log(systemPrompt)

  // Conversation turns - exactly as sent
  if (conversationTurns.length > 0) {
    console.log()
    console.log(`=== CONVERSATION (${conversationTurns.length} turns) ===`)
    for (const turn of conversationTurns) {
      console.log()
      console.log(`--- ${turn.role.toUpperCase()} ---`)
      console.log(renderTurnContent(turn))
    }
  } else {
    console.log()
    console.log(`=== CONVERSATION (empty) ===`)
  }

  console.log()
}

/**
 * Run the --compact command.
 * Forces memory curation (LTM consolidation + distillation).
 */
export async function runCompact(dbPath: string): Promise<void> {
  const storage = createStorage(dbPath)
  await initializeDefaultEntries(storage)

  const config = Config.get()
  const threshold = config.tokenBudgets.compactionThreshold
  const target = config.tokenBudgets.compactionTarget

  // Check current size
  const tokensBefore = await getEffectiveViewTokens(storage.temporal)
  console.log(`Effective view: ${fmt(tokensBefore)} tokens`)
  console.log(`Threshold: ${fmt(threshold)} tokens`)
  console.log(`Target: ${fmt(target)} tokens`)
  console.log()

  if (tokensBefore <= target) {
    console.log(`Already under target, but running anyway (forced)...`)
  } else {
    console.log(`Running memory curation...`)
  }
  console.log()

  const result = await runMemoryCuration(storage, { force: true })

  if (!result.ran) {
    console.log(`Curation did not run (already in progress?)`)
    return
  }

  // Report consolidation results
  if (result.consolidation?.ran) {
    const c = result.consolidation
    const changes = c.entriesCreated + c.entriesUpdated + c.entriesArchived
    console.log(`LTM Consolidation:`)
    if (changes > 0) {
      console.log(`  ${c.entriesCreated} created, ${c.entriesUpdated} updated, ${c.entriesArchived} archived`)
    } else {
      console.log(`  No changes needed`)
    }
    console.log()
  }

  // Report distillation results
  if (result.distillation) {
    const d = result.distillation
    console.log(`Distillation:`)
    console.log(`  Distillations created: ${d.summariesCreated}`)
    console.log(`  Tokens: ${fmt(d.tokensBefore)} → ${fmt(d.tokensAfter)}`)
    console.log(`  Turns used: ${d.turnsUsed}`)
    console.log(`  LLM usage: ${fmt(d.usage.inputTokens)} input, ${fmt(d.usage.outputTokens)} output`)
  }
}
