/**
 * Verbose output formatting for nuum
 *
 * Outputs structured debugging info to stderr, keeping stdout clean.
 * Uses colors for visual clarity when running in a TTY.
 */

import type {Storage, PresentState} from '../storage'
import type {CompactionResult} from '../temporal'
import {pc, styles, colorPercent, progressBar} from '../util/colors'

const SEPARATOR_WIDTH = 70

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function separator(title?: string): string {
  const line = styles.separator('─'.repeat(SEPARATOR_WIDTH))
  if (title) {
    return `\n${line}\n${styles.header(title)}\n${line}`
  }
  return line
}

export interface SummaryOrderStats {
  order: number
  count: number
  totalTokens: number
  coveringMessages?: number // For order-1: how many messages covered
  coveringSummaries?: number // For order-2+: how many lower-order summaries covered
}

export interface MemoryStats {
  totalMessages: number
  totalSummaries: number
  summariesByOrder: SummaryOrderStats[]
  effectiveViewTokens: number // Tokens in effective view (what goes to agent)
  totalMessageTokens: number // Raw token count of all messages
  totalSummaryTokens: number // Total tokens in summaries
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
  temporalSummaries: number // Breakdown of temporal view
  temporalMessages: number // Breakdown of temporal view
  present: number
  tools: number
  used: number
  available: number
}

export interface ExecutionEvent {
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error'
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
      process.stderr.write(message + '\n')
    }
  }

  separator(title?: string): void {
    this.log(separator(title))
  }

  memoryStateBefore(stats: MemoryStats, present: PresentState): void {
    this.separator('MEMORY STATE (before prompt)')

    this.log(styles.subheader('\nPresent:'))
    this.log(
      `  ${styles.label('Mission:')} ${present.mission ?? pc.dim('(none)')}`,
    )
    this.log(
      `  ${styles.label('Status:')} ${present.status ?? pc.dim('(none)')}`,
    )
    const completed = present.tasks.filter(
      (t) => t.status === 'completed',
    ).length
    const total = present.tasks.length
    if (total > 0) {
      const bar = progressBar(completed, total, total)
      this.log(
        `  ${styles.label('Tasks:')} [${styles.number(String(completed))}/${styles.number(String(total))} complete] ${bar}`,
      )
    } else {
      this.log(`  ${styles.label('Tasks:')} ${pc.dim('(none)')}`)
    }

    this.log(styles.subheader('\nTemporal:'))
    this.log(
      `  ${styles.label('Total messages:')} ${styles.number(String(stats.totalMessages))} (${styles.number(stats.totalMessageTokens.toLocaleString())} tokens)`,
    )

    if (stats.summariesByOrder.length > 0) {
      const maxOrder = Math.max(...stats.summariesByOrder.map((s) => s.order))
      this.log(
        `  ${styles.label('Summaries:')} ${styles.number(String(stats.totalSummaries))} (orders 1-${maxOrder})`,
      )
      for (const orderStats of stats.summariesByOrder) {
        const coverage =
          orderStats.order === 1
            ? orderStats.coveringMessages
              ? pc.dim(`covering ${orderStats.coveringMessages} messages`)
              : ''
            : orderStats.coveringSummaries
              ? pc.dim(
                  `covering ${orderStats.coveringSummaries} order-${orderStats.order - 1}`,
                )
              : ''
        this.log(
          `    ${styles.label(`Order ${orderStats.order}:`)} ${styles.number(String(orderStats.count))} summaries (${styles.number(orderStats.totalTokens.toLocaleString())} tokens${coverage ? ', ' + coverage : ''})`,
        )
      }
    } else {
      this.log(
        `  ${styles.label('Summaries:')} ${styles.number(String(stats.totalSummaries))}`,
      )
    }

    const needsCompaction =
      stats.effectiveViewTokens > stats.compactionThreshold
    const viewStatus = needsCompaction
      ? styles.warning(' (compaction needed)')
      : ''
    this.log(
      `  ${styles.label('Effective view:')} ${styles.number(stats.effectiveViewTokens.toLocaleString())} / ${styles.number(stats.compactionThreshold.toLocaleString())} tokens${viewStatus}`,
    )

    this.log(styles.subheader('\nLTM:'))
    this.log(
      `  ${styles.label('Entries:')} ${styles.number(String(stats.ltmEntries))}`,
    )
    this.log(
      `  ${styles.label('/identity:')} ${styles.number(stats.identityTokens.toLocaleString())} tokens`,
    )
    this.log(
      `  ${styles.label('/behavior:')} ${styles.number(stats.behaviorTokens.toLocaleString())} tokens`,
    )
  }

  tokenBudget(budget: TokenBudget): void {
    this.separator('TOKEN BUDGET')

    const pct = (n: number) => colorPercent(n, budget.total)
    const totalK = (budget.total / 1000).toFixed(0)

    this.log(
      `\n${styles.label('Component'.padEnd(20))} ${styles.label('Tokens'.padStart(7))}   ${styles.label(`% of ${totalK}k`)}`,
    )
    this.log(styles.separator('─'.repeat(41)))
    this.log(
      `${'System prompt'.padEnd(20)} ${styles.number(budget.systemPrompt.toString().padStart(7))}   ${pct(budget.systemPrompt).padStart(10)}`,
    )
    this.log(
      `${'Identity/behavior'.padEnd(20)} ${styles.number((budget.identity + budget.behavior).toString().padStart(7))}   ${pct(budget.identity + budget.behavior).padStart(10)}`,
    )
    this.log(
      `${'Temporal summaries'.padEnd(20)} ${styles.number(budget.temporalSummaries.toString().padStart(7))}   ${pct(budget.temporalSummaries).padStart(10)}`,
    )
    this.log(
      `${'Temporal messages'.padEnd(20)} ${styles.number(budget.temporalMessages.toString().padStart(7))}   ${pct(budget.temporalMessages).padStart(10)}`,
    )
    this.log(
      `${'Present state'.padEnd(20)} ${styles.number(budget.present.toString().padStart(7))}   ${pct(budget.present).padStart(10)}`,
    )
    this.log(
      `${'Tools'.padEnd(20)} ${styles.number(budget.tools.toString().padStart(7))}   ${pct(budget.tools).padStart(10)}`,
    )
    this.log(styles.separator('─'.repeat(41)))
    this.log(
      `${pc.bold('Total used'.padEnd(20))} ${pc.bold(styles.number(budget.used.toString().padStart(7)))}   ${pct(budget.used).padStart(10)}`,
    )
    this.log(
      `${styles.success('Available'.padEnd(20))} ${styles.success(budget.available.toString().padStart(7))}   ${colorPercent(budget.available, budget.total).padStart(10)}`,
    )
  }

  executionStart(): void {
    this.separator('AGENT EXECUTION')
    this.events = []
  }

  event(event: ExecutionEvent): void {
    const ts = styles.timestamp(event.timestamp ?? formatTimestamp())
    const arrow =
      event.type === 'user' || event.type === 'tool_result' ? '→' : '←'
    const styledArrow = styles.arrow(arrow)

    // Color the type label based on event type
    let typeLabel: string
    switch (event.type) {
      case 'user':
        typeLabel = styles.user('user')
        break
      case 'assistant':
        typeLabel = styles.assistant('assistant')
        break
      case 'tool_call':
        typeLabel = styles.tool('tool call')
        break
      case 'tool_result':
        typeLabel = styles.tool('tool result')
        break
      case 'error':
        typeLabel = styles.error('error')
        break
    }

    // Truncate long content for display
    const content =
      event.content.length > 100
        ? event.content.slice(0, 100) + pc.dim('...')
        : event.content

    this.log(`[${ts}] ${styledArrow} ${typeLabel}: ${content}`)
    this.events.push({
      ...event,
      timestamp: event.timestamp ?? formatTimestamp(),
    })
  }

  memoryStateAfter(
    stats: MemoryStats,
    present: PresentState,
    usage: {inputTokens: number; outputTokens: number},
  ): void {
    this.separator('MEMORY STATE (after prompt)')

    this.log(styles.subheader('\nPresent:'))
    this.log(
      `  ${styles.label('Mission:')} ${present.mission ?? pc.dim('(none)')}`,
    )
    this.log(
      `  ${styles.label('Status:')} ${present.status ?? pc.dim('(none)')}`,
    )
    const completed = present.tasks.filter(
      (t) => t.status === 'completed',
    ).length
    const total = present.tasks.length
    if (total > 0) {
      const bar = progressBar(completed, total, total)
      this.log(
        `  ${styles.label('Tasks:')} [${styles.number(String(completed))}/${styles.number(String(total))} complete] ${bar}`,
      )
    } else {
      this.log(`  ${styles.label('Tasks:')} ${pc.dim('(none)')}`)
    }

    this.log(styles.subheader('\nTemporal:'))
    this.log(
      `  ${styles.label('Total messages:')} ${styles.number(String(stats.totalMessages))} (${styles.number(stats.totalMessageTokens.toLocaleString())} tokens)`,
    )

    if (stats.summariesByOrder.length > 0) {
      const maxOrder = Math.max(...stats.summariesByOrder.map((s) => s.order))
      this.log(
        `  ${styles.label('Summaries:')} ${styles.number(String(stats.totalSummaries))} (orders 1-${maxOrder})`,
      )
      for (const orderStats of stats.summariesByOrder) {
        const coverage =
          orderStats.order === 1
            ? orderStats.coveringMessages
              ? pc.dim(`covering ${orderStats.coveringMessages} messages`)
              : ''
            : orderStats.coveringSummaries
              ? pc.dim(
                  `covering ${orderStats.coveringSummaries} order-${orderStats.order - 1}`,
                )
              : ''
        this.log(
          `    ${styles.label(`Order ${orderStats.order}:`)} ${styles.number(String(orderStats.count))} summaries (${styles.number(orderStats.totalTokens.toLocaleString())} tokens${coverage ? ', ' + coverage : ''})`,
        )
      }
    } else {
      this.log(
        `  ${styles.label('Summaries:')} ${styles.number(String(stats.totalSummaries))}`,
      )
    }

    const needsCompaction =
      stats.effectiveViewTokens > stats.compactionThreshold
    const viewStatus = needsCompaction
      ? styles.warning(' (compaction needed)')
      : ''
    this.log(
      `  ${styles.label('Effective view:')} ${styles.number(stats.effectiveViewTokens.toLocaleString())} / ${styles.number(stats.compactionThreshold.toLocaleString())} tokens${viewStatus}`,
    )

    // Calculate cost estimate (Claude Opus 4.5 pricing: $15/$75 per 1M tokens)
    const inputCost = (usage.inputTokens / 1_000_000) * 15
    const outputCost = (usage.outputTokens / 1_000_000) * 75
    const totalCost = inputCost + outputCost

    this.log(styles.subheader('\nUsage:'))
    this.log(
      `  ${styles.label('Input:')} ${styles.number(usage.inputTokens.toLocaleString())} tokens`,
    )
    this.log(
      `  ${styles.label('Output:')} ${styles.number(usage.outputTokens.toLocaleString())} tokens`,
    )
    this.log(
      `  ${styles.label('Cost:')} ${styles.success('$' + totalCost.toFixed(4))} ${pc.dim(`(input: $${inputCost.toFixed(4)}, output: $${outputCost.toFixed(4)})`)}`,
    )
  }

  error(message: string, error?: Error): void {
    this.log(`\n${styles.error('[ERROR]')} ${message}`)
    if (error?.stack) {
      this.log(pc.dim(error.stack))
    }
  }

  compaction(result: CompactionResult): void {
    this.separator('COMPACTION')

    this.log(
      `\n${styles.label('Distillations created:')} ${styles.number(String(result.distillationsCreated))}`,
    )
    this.log(
      `${styles.label('Agent turns used:')} ${styles.number(String(result.turnsUsed))}`,
    )

    const tokensCompressed = result.tokensBefore - result.tokensAfter
    this.log(styles.subheader('\nTokens:'))
    this.log(
      `  ${styles.label('Before:')} ${styles.number(result.tokensBefore.toLocaleString())}`,
    )
    this.log(
      `  ${styles.label('After:')} ${styles.number(result.tokensAfter.toLocaleString())}`,
    )
    this.log(
      `  ${styles.label('Compressed:')} ${styles.success(tokensCompressed.toLocaleString())}`,
    )

    const ratio =
      tokensCompressed > 0
        ? ((tokensCompressed / result.tokensBefore) * 100).toFixed(1)
        : '0.0'
    this.log(`  ${styles.label('Compression:')} ${styles.success(ratio + '%')}`)
  }
}
