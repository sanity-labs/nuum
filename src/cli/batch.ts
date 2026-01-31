/**
 * Batch mode implementation for miriad-code
 *
 * Runs the agent with a single prompt and outputs the response.
 * With --verbose, shows memory state and execution trace on stderr.
 */

import {
  createStorage,
  initializeDefaultEntries,
  cleanupStaleWorkers,
  type Storage,
} from '../storage'
import {runAgent, type AgentEvent} from '../agent'
import {
  VerboseOutput,
  type MemoryStats,
  type TokenBudget,
  type SummaryOrderStats,
} from './verbose'
import {buildTemporalView} from '../temporal'
import {getEffectiveViewTokens} from '../memory'
import {Config} from '../config'
import {out} from './output'

export interface BatchOptions {
  prompt: string
  verbose: boolean
  dbPath: string
  format: 'text' | 'json'
}

/**
 * Estimate token count from text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Gather memory statistics for verbose output.
 */
async function getMemoryStats(storage: Storage): Promise<MemoryStats> {
  const messages = await storage.temporal.getMessages()
  const summaries = await storage.temporal.getSummaries()
  const effectiveViewTokens = await getEffectiveViewTokens(storage.temporal)
  const config = Config.get()

  // Get LTM stats
  const ltmEntries = await storage.ltm.glob('/**')
  const identity = await storage.ltm.read('identity')
  const behavior = await storage.ltm.read('behavior')

  // Calculate total message tokens
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

  // Convert to array and add coverage estimates
  for (const [order, stats] of orderMap.entries()) {
    const orderStats: SummaryOrderStats = {
      order,
      count: stats.count,
      totalTokens: stats.tokens,
    }

    // Estimate coverage (rough approximation)
    if (order === 1) {
      // Order-1 covers ~20 messages each on average
      orderStats.coveringMessages = stats.count * 20
    } else {
      // Higher orders cover ~5 lower-order summaries each
      orderStats.coveringSummaries = stats.count * 5
    }

    summariesByOrder.push(orderStats)
  }

  // Sort by order
  summariesByOrder.sort((a, b) => a.order - b.order)

  const totalSummaryTokens = summaries.reduce(
    (sum, s) => sum + s.tokenEstimate,
    0,
  )

  return {
    totalMessages: messages.length,
    totalSummaries: summaries.length,
    summariesByOrder,
    effectiveViewTokens,
    totalMessageTokens,
    totalSummaryTokens,
    compactionThreshold: config.tokenBudgets.compactionThreshold,
    ltmEntries: ltmEntries.length,
    identityTokens: identity ? estimateTokens(identity.body) : 0,
    behaviorTokens: behavior ? estimateTokens(behavior.body) : 0,
  }
}

/**
 * Calculate token budget for verbose output.
 */
async function calculateTokenBudget(
  stats: MemoryStats,
  storage: Storage,
): Promise<TokenBudget> {
  const config = Config.get()
  const total = config.tokenBudgets.mainAgentContext

  // Build temporal view to get actual token usage breakdown
  const messages = await storage.temporal.getMessages()
  const summaries = await storage.temporal.getSummaries()
  const temporalView = buildTemporalView({
    budget: config.tokenBudgets.temporalBudget,
    messages,
    summaries,
  })

  // Rough estimates for system components
  const systemPrompt = 500 // Base instructions
  const identity = stats.identityTokens
  const behavior = stats.behaviorTokens
  const temporalSummaries = temporalView.summaries.reduce(
    (sum, s) => sum + s.tokenEstimate,
    0,
  )
  const temporalMessages = temporalView.messages.reduce(
    (sum, m) => sum + m.tokenEstimate,
    0,
  )
  const temporalViewTokens = temporalSummaries + temporalMessages
  const present = 200 // Mission/status/tasks
  const tools = 2000 // Tool descriptions

  const used =
    systemPrompt + identity + behavior + temporalViewTokens + present + tools

  return {
    total,
    systemPrompt,
    identity,
    behavior,
    temporalView: temporalViewTokens,
    temporalSummaries,
    temporalMessages,
    present,
    tools,
    used,
    available: total - used,
  }
}

/**
 * Run the agent in batch mode.
 */
export async function runBatch(options: BatchOptions): Promise<void> {
  const verbose = new VerboseOutput(options.verbose)

  let storage: Storage | undefined

  try {
    // Initialize storage
    storage = createStorage(options.dbPath)
    await cleanupStaleWorkers(storage)
    await initializeDefaultEntries(storage)

    // Get initial memory state for verbose output
    const statsBefore = await getMemoryStats(storage)
    const presentBefore = await storage.present.get()

    if (options.verbose) {
      verbose.memoryStateBefore(statsBefore, presentBefore)
      verbose.tokenBudget(await calculateTokenBudget(statsBefore, storage))
      verbose.executionStart()
    }

    // Run the agent
    const events: AgentEvent[] = []

    const result = await runAgent(options.prompt, {
      storage,
      verbose: options.verbose,
      onEvent: (event) => {
        events.push(event)
        if (options.verbose) {
          // Handle compaction events specially
          if (event.type === 'compaction' && event.compactionResult) {
            verbose.compaction(event.compactionResult)
          } else if (event.type !== 'compaction' && event.type !== 'done') {
            verbose.event({
              type: event.type as
                | 'user'
                | 'assistant'
                | 'tool_call'
                | 'tool_result'
                | 'error',
              content: event.content,
            })
          }
        }
      },
    })

    // Get final memory state for verbose output
    if (options.verbose) {
      const statsAfter = await getMemoryStats(storage)
      const presentAfter = await storage.present.get()
      verbose.memoryStateAfter(statsAfter, presentAfter, result.usage)
    }

    // Output the response
    if (options.format === 'json') {
      const output = {
        response: result.response,
        usage: result.usage,
        events: events.map((e) => ({
          type: e.type,
          content: e.content,
          ...(e.toolName && {toolName: e.toolName}),
          ...(e.toolCallId && {toolCallId: e.toolCallId}),
        })),
      }
      out.line(JSON.stringify(output, null, 2))
    } else {
      out.line(result.response)
    }
  } catch (error) {
    // Let the error bubble up to be handled by the CLI entry point
    throw error
  }
}
