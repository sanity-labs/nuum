/**
 * Verbose output formatting for miriad-code
 *
 * Outputs structured debugging info to stderr, keeping stdout clean.
 */

import type { Storage, PresentState } from "../storage"
import type { CompactionResult } from "../temporal"

const SEPARATOR = "─".repeat(70)

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

export interface SummaryOrderStats {
  order: number
  count: number
  totalTokens: number
  coveringMessages?: number  // For order-1: how many messages covered
  coveringSummaries?: number // For order-2+: how many lower-order summaries covered
}

export interface MemoryStats {
  totalMessages: number
  totalSummaries: number
  summariesByOrder: SummaryOrderStats[]
  effectiveViewTokens: number  // Tokens in effective view (what goes to agent)
  totalMessageTokens: number   // Raw token count of all messages
  totalSummaryTokens: number   // Total tokens in summaries
  compactionThreshold: number
  ltmEntries: number
  identityTokens: number
  behaviorTokens: number
}

export interface TokenBudget {
  total: number
  systemPrompt: number
  identity: number
  behavior: number
  temporalView: number
  temporalSummaries: number  // Breakdown of temporal view
  temporalMessages: number   // Breakdown of temporal view
  present: number
  tools: number
  used: number
  available: number
}

export interface ExecutionEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error"
  content: string
  timestamp?: string
}

export class VerboseOutput {
  private enabled: boolean
  private events: ExecutionEvent[] = []

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  private log(message: string): void {
    if (this.enabled) {
      process.stderr.write(message + "\n")
    }
  }

  separator(title?: string): void {
    if (title) {
      this.log(`\n${SEPARATOR}\n${title}\n${SEPARATOR}`)
    } else {
      this.log(SEPARATOR)
    }
  }

  memoryStateBefore(stats: MemoryStats, present: PresentState): void {
    this.separator("MEMORY STATE (before prompt)")

    this.log(`Present:`)
    this.log(`  Mission: ${present.mission ?? "(none)"}`)
    this.log(`  Status: ${present.status ?? "(none)"}`)
    const completed = present.tasks.filter((t) => t.status === "completed").length
    const total = present.tasks.length
    if (total > 0) {
      const bar = "█".repeat(completed) + "░".repeat(total - completed)
      this.log(`  Tasks: [${completed}/${total} complete] ${bar}`)
    } else {
      this.log(`  Tasks: (none)`)
    }

    this.log(`\nTemporal:`)
    this.log(`  Total messages: ${stats.totalMessages} (${stats.totalMessageTokens.toLocaleString()} tokens)`)

    if (stats.summariesByOrder.length > 0) {
      const maxOrder = Math.max(...stats.summariesByOrder.map(s => s.order))
      this.log(`  Summaries: ${stats.totalSummaries} (orders 1-${maxOrder})`)
      for (const orderStats of stats.summariesByOrder) {
        const coverage = orderStats.order === 1
          ? orderStats.coveringMessages ? `covering ${orderStats.coveringMessages} messages` : ""
          : orderStats.coveringSummaries ? `covering ${orderStats.coveringSummaries} order-${orderStats.order - 1}` : ""
        this.log(`    Order ${orderStats.order}: ${orderStats.count} summaries (${orderStats.totalTokens.toLocaleString()} tokens${coverage ? ", " + coverage : ""})`)
      }
    } else {
      this.log(`  Summaries: ${stats.totalSummaries}`)
    }

    const needsCompaction = stats.effectiveViewTokens > stats.compactionThreshold
    this.log(`  Effective view: ${stats.effectiveViewTokens.toLocaleString()} / ${stats.compactionThreshold.toLocaleString()} tokens${needsCompaction ? " (compaction needed)" : ""}`)

    this.log(`\nLTM:`)
    this.log(`  Entries: ${stats.ltmEntries}`)
    this.log(`  /identity: ${stats.identityTokens.toLocaleString()} tokens`)
    this.log(`  /behavior: ${stats.behaviorTokens.toLocaleString()} tokens`)
  }

  tokenBudget(budget: TokenBudget): void {
    this.separator("TOKEN BUDGET")

    const pct = (n: number) => ((n / budget.total) * 100).toFixed(1)

    this.log(`Component            Tokens    % of ${(budget.total / 1000).toFixed(0)}k`)
    this.log("─".repeat(41))
    this.log(`System prompt       ${budget.systemPrompt.toString().padStart(7)}   ${pct(budget.systemPrompt).padStart(5)}%`)
    this.log(`Identity/behavior   ${(budget.identity + budget.behavior).toString().padStart(7)}   ${pct(budget.identity + budget.behavior).padStart(5)}%`)
    this.log(`Temporal summaries  ${budget.temporalSummaries.toString().padStart(7)}   ${pct(budget.temporalSummaries).padStart(5)}%`)
    this.log(`Temporal messages   ${budget.temporalMessages.toString().padStart(7)}   ${pct(budget.temporalMessages).padStart(5)}%`)
    this.log(`Present state       ${budget.present.toString().padStart(7)}   ${pct(budget.present).padStart(5)}%`)
    this.log(`Tools               ${budget.tools.toString().padStart(7)}   ${pct(budget.tools).padStart(5)}%`)
    this.log("─".repeat(41))
    this.log(`Total used          ${budget.used.toString().padStart(7)}   ${pct(budget.used).padStart(5)}%`)
    this.log(`Available           ${budget.available.toString().padStart(7)}   ${pct(budget.available).padStart(5)}%`)
  }

  executionStart(): void {
    this.separator("AGENT EXECUTION")
    this.events = []
  }

  event(event: ExecutionEvent): void {
    const ts = event.timestamp ?? formatTimestamp()
    const arrow = event.type === "user" || event.type === "tool_result" ? "→" : "←"
    const typeLabel = event.type.replace("_", " ")

    // Truncate long content for display
    const content =
      event.content.length > 100
        ? event.content.slice(0, 100) + "..."
        : event.content

    this.log(`[${ts}] ${arrow} ${typeLabel}: ${content}`)
    this.events.push({ ...event, timestamp: ts })
  }

  memoryStateAfter(
    stats: MemoryStats,
    present: PresentState,
    usage: { inputTokens: number; outputTokens: number },
  ): void {
    this.separator("MEMORY STATE (after prompt)")

    this.log(`Present:`)
    this.log(`  Mission: ${present.mission ?? "(none)"}`)
    this.log(`  Status: ${present.status ?? "(none)"}`)
    const completed = present.tasks.filter((t) => t.status === "completed").length
    const total = present.tasks.length
    if (total > 0) {
      const bar = "█".repeat(completed) + "░".repeat(total - completed)
      this.log(`  Tasks: [${completed}/${total} complete] ${bar}`)
    } else {
      this.log(`  Tasks: (none)`)
    }

    this.log(`\nTemporal:`)
    this.log(`  Total messages: ${stats.totalMessages} (${stats.totalMessageTokens.toLocaleString()} tokens)`)

    if (stats.summariesByOrder.length > 0) {
      const maxOrder = Math.max(...stats.summariesByOrder.map(s => s.order))
      this.log(`  Summaries: ${stats.totalSummaries} (orders 1-${maxOrder})`)
      for (const orderStats of stats.summariesByOrder) {
        const coverage = orderStats.order === 1
          ? orderStats.coveringMessages ? `covering ${orderStats.coveringMessages} messages` : ""
          : orderStats.coveringSummaries ? `covering ${orderStats.coveringSummaries} order-${orderStats.order - 1}` : ""
        this.log(`    Order ${orderStats.order}: ${orderStats.count} summaries (${orderStats.totalTokens.toLocaleString()} tokens${coverage ? ", " + coverage : ""})`)
      }
    } else {
      this.log(`  Summaries: ${stats.totalSummaries}`)
    }

    const needsCompaction = stats.effectiveViewTokens > stats.compactionThreshold
    this.log(`  Effective view: ${stats.effectiveViewTokens.toLocaleString()} / ${stats.compactionThreshold.toLocaleString()} tokens${needsCompaction ? " (compaction needed)" : ""}`)

    // Calculate cost estimate (Claude Opus 4.5 pricing: $15/$75 per 1M tokens)
    const inputCost = (usage.inputTokens / 1_000_000) * 15
    const outputCost = (usage.outputTokens / 1_000_000) * 75
    const totalCost = inputCost + outputCost

    this.log(`\nUsage: ${usage.inputTokens.toLocaleString()} input tokens, ${usage.outputTokens.toLocaleString()} output tokens`)
    this.log(`Cost: $${totalCost.toFixed(4)} (input: $${inputCost.toFixed(4)}, output: $${outputCost.toFixed(4)})`)
  }

  error(message: string, error?: Error): void {
    this.log(`\n[ERROR] ${message}`)
    if (error?.stack) {
      this.log(error.stack)
    }
  }

  compaction(result: CompactionResult): void {
    this.separator("COMPACTION")

    this.log(`Summaries created: ${result.summariesCreated}`)
    this.log(`Agent turns used: ${result.turnsUsed}`)

    const tokensCompressed = result.tokensBefore - result.tokensAfter
    this.log(`\nTokens:`)
    this.log(`  Before: ${result.tokensBefore.toLocaleString()}`)
    this.log(`  After: ${result.tokensAfter.toLocaleString()}`)
    this.log(`  Compressed: ${tokensCompressed.toLocaleString()}`)

    const ratio = tokensCompressed > 0
      ? (tokensCompressed / result.tokensBefore * 100).toFixed(1)
      : "0.0"
    this.log(`  Compression: ${ratio}%`)
  }
}
