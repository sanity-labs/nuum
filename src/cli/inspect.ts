/**
 * Inspect commands for nuum
 *
 * --inspect: Shows LTM tree structure + memory stats
 * --dump: Shows the system prompt + conversation turns as they would appear to the agent
 * --compact: Force run compaction to reduce effective view size
 *
 * --inspect and --dump work without API key (no LLM calls).
 * --compact requires API key (runs the compaction agent).
 */

import {createStorage, initializeDefaultEntries, type Storage} from '../storage'
import {buildTemporalView} from '../temporal'
import {runMemoryCuration, getEffectiveViewTokens} from '../memory'
import {buildAgentContext} from '../context'
import {Config} from '../config'
import {pc, styles} from '../util/colors'
import type {CoreMessage} from 'ai'

// Diagnostic output - these commands are standalone tools, not agent conversation
const log = console.log
const blank = () => console.log()

const SEPARATOR = styles.separator('═'.repeat(70))
const SUBSEPARATOR = styles.separator('─'.repeat(70))

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
  return styles.number(n.toLocaleString())
}

/**
 * Format a plain number without coloring (for inline use).
 */
function fmtPlain(n: number): string {
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
  const entries = await storage.ltm.glob('/**')
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
 * Render LTM tree as indented text with colors.
 */
function renderLTMTree(nodes: LTMTreeNode[], indent: number = 0): string {
  const lines: string[] = []

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const isLast = i === nodes.length - 1

    // Build prefix for tree structure
    const branch = indent === 0 ? '' : isLast ? '└── ' : '├── '
    const childPrefix = indent === 0 ? '' : isLast ? '    ' : '│   '
    const linePrefix = pc.dim('  '.repeat(Math.max(0, indent - 1)) + branch)

    const archived = node.archived ? pc.dim(' [archived]') : ''
    const title = node.title ? pc.dim(` "${node.title}"`) : ''
    const tokens =
      node.tokens > 0 ? pc.dim(` (${fmtPlain(node.tokens)} tokens)`) : ''
    const path = styles.path('/' + node.slug)

    lines.push(`${linePrefix}${path}${title}${tokens}${archived}`)

    if (node.children.length > 0) {
      lines.push(renderLTMTree(node.children, indent + 1))
    }
  }

  return lines.join('\n')
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
  const totalMessageTokens = messages.reduce(
    (sum, m) => sum + m.tokenEstimate,
    0,
  )

  // Calculate summary stats by order
  const summariesByOrder: SummaryOrderStats[] = []
  const orderMap = new Map<number, {count: number; tokens: number}>()

  for (const summary of summaries) {
    const existing = orderMap.get(summary.orderNum) ?? {count: 0, tokens: 0}
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

  const totalSummaryTokens = summaries.reduce(
    (sum, s) => sum + s.tokenEstimate,
    0,
  )

  // Get present state
  const present = await storage.present.get()
  const tasksPending = present.tasks.filter(
    (t) => t.status === 'pending',
  ).length
  const tasksInProgress = present.tasks.filter(
    (t) => t.status === 'in_progress',
  ).length
  const tasksCompleted = present.tasks.filter(
    (t) => t.status === 'completed',
  ).length
  const tasksBlocked = present.tasks.filter(
    (t) => t.status === 'blocked',
  ).length

  // Get LTM stats
  const ltmEntries = await storage.ltm.glob('/**')
  const activeEntries = ltmEntries.filter((e) => !e.archivedAt)
  const identity = await storage.ltm.read('identity')
  const behavior = await storage.ltm.read('behavior')
  const ltmTotalTokens = ltmEntries.reduce(
    (sum, e) => sum + estimateTokens(e.body),
    0,
  )

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

  blank()
  log(SEPARATOR)
  log(styles.header('LONG-TERM MEMORY TREE'))
  log(SEPARATOR)
  blank()

  if (ltmTree.length > 0) {
    log(renderLTMTree(ltmTree))
  } else {
    log(pc.dim('(no entries)'))
  }

  blank()
  const archivedCount = stats.ltmTotalEntries - stats.ltmActiveEntries
  log(
    `${styles.label('Total:')} ${fmt(stats.ltmActiveEntries)} active${archivedCount > 0 ? `, ${fmt(archivedCount)} archived` : ''} (${fmt(stats.ltmTotalTokens)} tokens)`,
  )

  blank()
  log(SEPARATOR)
  log(styles.header('TEMPORAL MEMORY'))
  log(SEPARATOR)
  blank()

  log(
    `${styles.label('Messages:')} ${fmt(stats.totalMessages)} (${fmt(stats.totalMessageTokens)} tokens)`,
  )

  if (stats.summariesByOrder.length > 0) {
    log(`${styles.label('Summaries:')}`)
    for (const orderStats of stats.summariesByOrder) {
      log(
        `  ${pc.dim(`Order-${orderStats.order}:`)} ${fmt(orderStats.count)} (${fmt(orderStats.totalTokens)} tokens)`,
      )
    }
  } else {
    log(`${styles.label('Summaries:')} ${pc.dim('none')}`)
  }

  blank()
  const needsCompaction = stats.viewTotalTokens > stats.compactionThreshold
  const compactionStatus = needsCompaction
    ? styles.warning(' (compaction needed)')
    : ''
  log(
    `${styles.label('Effective view')} ${pc.dim('(what goes to agent)')}:`,
  )
  log(
    `  ${styles.label('Summaries:')} ${fmt(stats.viewSummaryCount)} (${fmt(stats.viewSummaryTokens)} tokens)`,
  )
  log(
    `  ${styles.label('Messages:')} ${fmt(stats.viewMessageCount)} (${fmt(stats.viewMessageTokens)} tokens)`,
  )
  log(
    `  ${styles.label('Total:')} ${fmt(stats.viewTotalTokens)} / ${fmt(stats.compactionThreshold)} threshold${compactionStatus}`,
  )
  log(
    `  ${styles.label('Target:')} ${fmt(stats.compactionTarget)} tokens`,
  )

  blank()
  log(SEPARATOR)
  log(styles.header('PRESENT STATE'))
  log(SEPARATOR)
  blank()

  log(
    `${styles.label('Mission:')} ${stats.mission ?? pc.dim('(none)')}`,
  )
  log(`${styles.label('Status:')} ${stats.status ?? pc.dim('(none)')}`)

  const totalTasks =
    stats.tasksPending +
    stats.tasksInProgress +
    stats.tasksCompleted +
    stats.tasksBlocked
  if (totalTasks > 0) {
    log(`${styles.label('Tasks:')} ${fmt(totalTasks)} total`)
    if (stats.tasksPending > 0)
      log(`  ${pc.dim('Pending:')} ${fmt(stats.tasksPending)}`)
    if (stats.tasksInProgress > 0)
      log(
        `  ${styles.warning('In progress:')} ${fmt(stats.tasksInProgress)}`,
      )
    if (stats.tasksCompleted > 0)
      log(
        `  ${styles.success('Completed:')} ${fmt(stats.tasksCompleted)}`,
      )
    if (stats.tasksBlocked > 0)
      log(`  ${styles.error('Blocked:')} ${fmt(stats.tasksBlocked)}`)
  } else {
    log(`${styles.label('Tasks:')} ${pc.dim('none')}`)
  }

  blank()
}

/**
 * Render a CoreMessage turn content for display.
 * Shows exactly what the agent would see.
 */
function renderTurnContent(turn: CoreMessage): string {
  if (typeof turn.content === 'string') {
    return turn.content
  } else if (Array.isArray(turn.content)) {
    const parts: string[] = []
    for (const part of turn.content) {
      if (part.type === 'text') {
        parts.push(part.text)
      } else if (part.type === 'tool-call') {
        parts.push(
          styles.tool(
            `[tool_call: ${part.toolName}(${JSON.stringify(part.args)})]`,
          ),
        )
      } else if (part.type === 'tool-result') {
        const result =
          typeof part.result === 'string'
            ? part.result.slice(0, 500) +
              (part.result.length > 500 ? '...' : '')
            : JSON.stringify(part.result).slice(0, 500)
        parts.push(pc.dim(`[tool_result: ${part.toolName}] `) + result)
      }
    }
    return parts.join('\n')
  }
  return ''
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
    if (typeof turn.content === 'string') {
      return sum + estimateTokens(turn.content)
    } else if (Array.isArray(turn.content)) {
      let tokens = 0
      for (const part of turn.content) {
        if (part.type === 'text') {
          tokens += estimateTokens(part.text)
        } else if (part.type === 'tool-call') {
          tokens += estimateTokens(JSON.stringify(part.args)) + 20
        } else if (part.type === 'tool-result') {
          tokens += estimateTokens(
            typeof part.result === 'string'
              ? part.result
              : JSON.stringify(part.result),
          )
        }
      }
      return sum + tokens
    }
    return sum
  }, 0)

  const totalTokens = systemTokens + conversationTokens

  // Header with stats
  blank()
  log(styles.header('Agent Prompt Dump'))
  log(
    pc.dim(
      `System: ~${fmtPlain(systemTokens)} tokens | Conversation: ${conversationTurns.length} turns, ~${fmtPlain(conversationTokens)} tokens | Total: ~${fmtPlain(totalTokens)} tokens`,
    ),
  )
  blank()

  // System prompt - exactly as sent
  log(styles.subheader('=== SYSTEM ==='))
  log(systemPrompt)

  // Conversation turns - exactly as sent
  if (conversationTurns.length > 0) {
    blank()
    log(
      styles.subheader(
        `=== CONVERSATION (${conversationTurns.length} turns) ===`,
      ),
    )
    for (const turn of conversationTurns) {
      blank()
      const roleColor = turn.role === 'user' ? styles.user : styles.assistant
      log(roleColor(`--- ${turn.role.toUpperCase()} ---`))
      log(renderTurnContent(turn))
    }
  } else {
    blank()
    log(styles.subheader('=== CONVERSATION (empty) ==='))
  }

  blank()
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
  log(`${styles.label('Effective view:')} ${fmt(tokensBefore)} tokens`)
  log(`${styles.label('Threshold:')} ${fmt(threshold)} tokens`)
  log(`${styles.label('Target:')} ${fmt(target)} tokens`)
  blank()

  if (tokensBefore <= target) {
    log(pc.dim(`Already under target, but running anyway (forced)...`))
  } else {
    log(`Running memory curation...`)
  }
  blank()

  const result = await runMemoryCuration(storage, {force: true})

  if (!result.ran) {
    log(styles.warning(`Curation did not run (already in progress?)`))
    return
  }

  // Report consolidation results
  if (result.consolidation?.ran) {
    const c = result.consolidation
    const changes = c.entriesCreated + c.entriesUpdated + c.entriesArchived
    log(styles.subheader(`LTM Consolidation:`))
    if (changes > 0) {
      log(
        `  ${styles.success(String(c.entriesCreated))} created, ${styles.number(String(c.entriesUpdated))} updated, ${pc.dim(String(c.entriesArchived))} archived`,
      )
    } else {
      log(pc.dim(`  No changes needed`))
    }
    blank()
  }

  // Report distillation results
  if (result.distillation) {
    const d = result.distillation
    log(styles.subheader(`Distillation:`))
    log(
      `  ${styles.label('Distillations created:')} ${fmt(d.distillationsCreated)}`,
    )
    log(
      `  ${styles.label('Tokens:')} ${fmt(d.tokensBefore)} ${pc.dim('→')} ${styles.success(fmtPlain(d.tokensAfter))}`,
    )
    log(`  ${styles.label('Turns used:')} ${fmt(d.turnsUsed)}`)
    log(
      `  ${styles.label('LLM usage:')} ${fmt(d.usage.inputTokens)} input, ${fmt(d.usage.outputTokens)} output`,
    )
  }
}
