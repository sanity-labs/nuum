/**
 * Inspect commands for miriad-code
 *
 * --inspect: Shows memory stats (temporal, present, LTM) with token counts
 * --dump: Shows the raw system prompt that would be sent to the LLM
 *
 * Both commands work without API key (no LLM calls).
 */

import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { buildTemporalView, renderTemporalView } from "../temporal"
import { Config } from "../config"

const SEPARATOR = "═".repeat(70)
const SUBSEPARATOR = "─".repeat(70)

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

interface SummaryOrderStats {
  order: number
  count: number
  totalTokens: number
  coveringMessages?: number
  coveringSummaries?: number
}

interface MemoryStats {
  // Temporal
  totalMessages: number
  totalMessageTokens: number
  totalSummaries: number
  totalSummaryTokens: number
  summariesByOrder: SummaryOrderStats[]
  uncompactedTokens: number
  temporalBudget: number
  compactionThreshold: number
  // View
  viewSummaryCount: number
  viewSummaryTokens: number
  viewMessageCount: number
  viewMessageTokens: number
  viewTotalTokens: number
  compressionRatio: number | null
  // Present
  mission: string | null
  status: string | null
  tasksPending: number
  tasksInProgress: number
  tasksCompleted: number
  tasksBlocked: number
  // LTM
  ltmEntries: number
  ltmActiveEntries: number
  identityTokens: number
  behaviorTokens: number
  knowledgeEntries: number
  knowledgeTokens: number
}

/**
 * Gather memory statistics for --inspect output.
 */
async function getMemoryStats(storage: Storage): Promise<MemoryStats> {
  const config = Config.get()
  const temporalBudget = config.tokenBudgets.temporalBudget
  const compactionThreshold = config.tokenBudgets.compactionThreshold

  // Get temporal data
  const messages = await storage.temporal.getMessages()
  const summaries = await storage.temporal.getSummaries()
  const uncompactedTokens = await storage.temporal.estimateUncompactedTokens()

  // Build temporal view
  const view = buildTemporalView({
    budget: temporalBudget,
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
    const orderStats: SummaryOrderStats = {
      order,
      count: stats.count,
      totalTokens: stats.tokens,
    }
    if (order === 1) {
      orderStats.coveringMessages = stats.count * 20 // Rough estimate
    } else {
      orderStats.coveringSummaries = stats.count * 5 // Rough estimate
    }
    summariesByOrder.push(orderStats)
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

  // Count knowledge entries (not identity or behavior)
  const knowledgeEntries = activeEntries.filter(e => e.slug !== "identity" && e.slug !== "behavior")
  const knowledgeTokens = knowledgeEntries.reduce((sum, e) => sum + estimateTokens(e.body), 0)

  // Calculate compression ratio
  let compressionRatio: number | null = null
  if (totalSummaryTokens > 0 && totalMessageTokens > 0) {
    compressionRatio = totalMessageTokens / totalSummaryTokens
  }

  return {
    totalMessages: messages.length,
    totalMessageTokens,
    totalSummaries: summaries.length,
    totalSummaryTokens,
    summariesByOrder,
    uncompactedTokens,
    temporalBudget,
    compactionThreshold,
    viewSummaryCount: view.summaries.length,
    viewSummaryTokens: view.breakdown.summaryTokens,
    viewMessageCount: view.messages.length,
    viewMessageTokens: view.breakdown.messageTokens,
    viewTotalTokens: view.totalTokens,
    compressionRatio,
    mission: present.mission,
    status: present.status,
    tasksPending,
    tasksInProgress,
    tasksCompleted,
    tasksBlocked,
    ltmEntries: ltmEntries.length,
    ltmActiveEntries: activeEntries.length,
    identityTokens: identity ? estimateTokens(identity.body) : 0,
    behaviorTokens: behavior ? estimateTokens(behavior.body) : 0,
    knowledgeEntries: knowledgeEntries.length,
    knowledgeTokens,
  }
}

/**
 * Format a number with thousand separators.
 */
function fmt(n: number): string {
  return n.toLocaleString()
}

/**
 * Run the --inspect command.
 */
export async function runInspect(dbPath: string): Promise<void> {
  const storage = createStorage(dbPath)
  await initializeDefaultEntries(storage)

  const stats = await getMemoryStats(storage)
  const config = Config.get()

  console.log()
  console.log(SEPARATOR)
  console.log("TEMPORAL MEMORY")
  console.log(SEPARATOR)
  console.log()
  console.log(`Messages: ${fmt(stats.totalMessages)} (${fmt(stats.totalMessageTokens)} tokens)`)
  console.log()

  if (stats.summariesByOrder.length > 0) {
    console.log("Summaries:")
    for (const orderStats of stats.summariesByOrder) {
      const coverage = orderStats.order === 1
        ? orderStats.coveringMessages ? ` (covering ~${orderStats.coveringMessages} messages)` : ""
        : orderStats.coveringSummaries ? ` (covering ~${orderStats.coveringSummaries} order-${orderStats.order - 1} summaries)` : ""
      console.log(`  Order-${orderStats.order}: ${orderStats.count} summaries (${fmt(orderStats.totalTokens)} tokens)${coverage}`)
    }
    console.log()
  } else {
    console.log("Summaries: none")
    console.log()
  }

  console.log("Compaction:")
  console.log(`  Uncompacted: ${fmt(stats.uncompactedTokens)} tokens`)
  console.log(`  Threshold: ${fmt(stats.compactionThreshold)} tokens`)
  const compactionPct = ((stats.uncompactedTokens / stats.compactionThreshold) * 100).toFixed(1)
  console.log(`  Status: ${compactionPct}% of threshold`)
  console.log()

  if (stats.compressionRatio !== null) {
    console.log(`Compression ratio: ${stats.compressionRatio.toFixed(1)}x`)
    console.log()
  }

  console.log("Effective view (what goes to LLM):")
  console.log(`  Summaries: ${stats.viewSummaryCount} (${fmt(stats.viewSummaryTokens)} tokens)`)
  console.log(`  Messages: ${stats.viewMessageCount} (${fmt(stats.viewMessageTokens)} tokens)`)
  console.log(`  Total: ${fmt(stats.viewTotalTokens)} tokens`)

  console.log()
  console.log(SEPARATOR)
  console.log("PRESENT STATE")
  console.log(SEPARATOR)
  console.log()
  console.log(`Mission: ${stats.mission ?? "(none)"}`)
  console.log(`Status: ${stats.status ?? "(none)"}`)
  console.log()

  const totalTasks = stats.tasksPending + stats.tasksInProgress + stats.tasksCompleted + stats.tasksBlocked
  if (totalTasks > 0) {
    console.log(`Tasks: ${totalTasks} total`)
    if (stats.tasksPending > 0) console.log(`  Pending: ${stats.tasksPending}`)
    if (stats.tasksInProgress > 0) console.log(`  In progress: ${stats.tasksInProgress}`)
    if (stats.tasksCompleted > 0) console.log(`  Completed: ${stats.tasksCompleted}`)
    if (stats.tasksBlocked > 0) console.log(`  Blocked: ${stats.tasksBlocked}`)
  } else {
    console.log("Tasks: none")
  }

  console.log()
  console.log(SEPARATOR)
  console.log("LONG-TERM MEMORY")
  console.log(SEPARATOR)
  console.log()
  console.log(`Entries: ${stats.ltmActiveEntries} active (${stats.ltmEntries - stats.ltmActiveEntries} archived)`)
  console.log()
  console.log(`/identity: ${fmt(stats.identityTokens)} tokens`)
  console.log(`/behavior: ${fmt(stats.behaviorTokens)} tokens`)
  if (stats.knowledgeEntries > 0) {
    console.log(`/knowledge: ${stats.knowledgeEntries} entries (${fmt(stats.knowledgeTokens)} tokens)`)
  }

  console.log()
  console.log(SEPARATOR)
  console.log("TOKEN BUDGET")
  console.log(SEPARATOR)
  console.log()

  const total = config.tokenBudgets.mainAgentContext
  const systemBase = 500 // Base prompt
  const tools = 2000 // Tool definitions
  const presentTokens = 200 // Present state estimate

  const used = systemBase + stats.identityTokens + stats.behaviorTokens + stats.viewTotalTokens + presentTokens + tools
  const available = total - used

  const pct = (n: number) => ((n / total) * 100).toFixed(1)

  console.log(`Component             Tokens    % of ${(total / 1000).toFixed(0)}k`)
  console.log(SUBSEPARATOR.slice(0, 45))
  console.log(`System prompt       ${systemBase.toString().padStart(8)}   ${pct(systemBase).padStart(5)}%`)
  console.log(`Identity            ${stats.identityTokens.toString().padStart(8)}   ${pct(stats.identityTokens).padStart(5)}%`)
  console.log(`Behavior            ${stats.behaviorTokens.toString().padStart(8)}   ${pct(stats.behaviorTokens).padStart(5)}%`)
  console.log(`Temporal summaries  ${stats.viewSummaryTokens.toString().padStart(8)}   ${pct(stats.viewSummaryTokens).padStart(5)}%`)
  console.log(`Temporal messages   ${stats.viewMessageTokens.toString().padStart(8)}   ${pct(stats.viewMessageTokens).padStart(5)}%`)
  console.log(`Present state       ${presentTokens.toString().padStart(8)}   ${pct(presentTokens).padStart(5)}%`)
  console.log(`Tools               ${tools.toString().padStart(8)}   ${pct(tools).padStart(5)}%`)
  console.log(SUBSEPARATOR.slice(0, 45))
  console.log(`Total used          ${used.toString().padStart(8)}   ${pct(used).padStart(5)}%`)
  console.log(`Available           ${available.toString().padStart(8)}   ${pct(available).padStart(5)}%`)
  console.log()
}

/**
 * Build the full system prompt for --dump output.
 */
async function buildFullPrompt(storage: Storage): Promise<{
  sections: Array<{ name: string; content: string; tokens: number }>
  totalTokens: number
}> {
  const config = Config.get()
  const temporalBudget = config.tokenBudgets.temporalBudget

  // Get identity and behavior
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")

  // Get present state
  const present = await storage.present.get()

  // Get temporal history
  const allMessages = await storage.temporal.getMessages()
  const allSummaries = await storage.temporal.getSummaries()
  const temporalView = buildTemporalView({
    budget: temporalBudget,
    messages: allMessages,
    summaries: allSummaries,
  })

  const sections: Array<{ name: string; content: string; tokens: number }> = []

  // Base system prompt
  const basePrompt = `You are a coding assistant with persistent memory.

Your memory spans across conversations, allowing you to remember past decisions, track ongoing projects, and learn user preferences.`
  sections.push({ name: "SYSTEM PROMPT (base)", content: basePrompt, tokens: estimateTokens(basePrompt) })

  // Identity
  if (identity) {
    const identityContent = `<identity>
${identity.body}
</identity>`
    sections.push({ name: "IDENTITY", content: identityContent, tokens: estimateTokens(identityContent) })
  }

  // Behavior
  if (behavior) {
    const behaviorContent = `<behavior>
${behavior.body}
</behavior>`
    sections.push({ name: "BEHAVIOR", content: behaviorContent, tokens: estimateTokens(behaviorContent) })
  }

  // Temporal history
  if (temporalView.summaries.length > 0 || temporalView.messages.length > 0) {
    const temporalContent = `<conversation_history>
The following is your memory of previous interactions with this user:

${renderTemporalView(temporalView)}
</conversation_history>`
    const summaryInfo = temporalView.summaries.length > 0
      ? `${temporalView.summaries.length} summaries`
      : "no summaries"
    const messageInfo = temporalView.messages.length > 0
      ? `${temporalView.messages.length} messages`
      : "no messages"
    sections.push({
      name: `CONVERSATION HISTORY (${summaryInfo}, ${messageInfo})`,
      content: temporalContent,
      tokens: estimateTokens(temporalContent),
    })
  }

  // Present state
  let presentContent = `<present_state>
<mission>${present.mission ?? "(none)"}</mission>
<status>${present.status ?? "(none)"}</status>
<tasks>
`
  for (const task of present.tasks) {
    presentContent += `  <task status="${task.status}">${task.content}</task>\n`
  }
  presentContent += `</tasks>
</present_state>`
  sections.push({ name: "PRESENT STATE", content: presentContent, tokens: estimateTokens(presentContent) })

  // Tools description
  const toolsContent = `You have access to tools for file operations (read, write, edit, bash, glob, grep).
Use tools to accomplish tasks. Always explain what you're doing.

When you're done with a task, update the present state if appropriate.`
  sections.push({ name: "TOOLS DESCRIPTION", content: toolsContent, tokens: estimateTokens(toolsContent) })

  const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0)

  return { sections, totalTokens }
}

/**
 * Run the --dump command.
 */
export async function runDump(dbPath: string): Promise<void> {
  const storage = createStorage(dbPath)
  await initializeDefaultEntries(storage)

  const { sections, totalTokens } = await buildFullPrompt(storage)

  console.log()
  console.log(SEPARATOR)
  console.log(`SYSTEM PROMPT DUMP (${fmt(totalTokens)} tokens total)`)
  console.log(SEPARATOR)

  for (const section of sections) {
    console.log()
    console.log(SUBSEPARATOR)
    console.log(`${section.name} (${fmt(section.tokens)} tokens)`)
    console.log(SUBSEPARATOR)
    console.log()
    console.log(section.content)
  }

  console.log()
  console.log(SEPARATOR)
  console.log(`END OF DUMP (${fmt(totalTokens)} tokens total)`)
  console.log(SEPARATOR)
  console.log()
}
