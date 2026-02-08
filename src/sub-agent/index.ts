/**
 * Sub-Agent Framework
 *
 * Generic abstraction for running sub-agents that inherit the main agent's
 * context and run with a specific task and toolset.
 *
 * Used by:
 * - Reflection agent (search memory, answer questions)
 * - LTM curator (capture and organize knowledge)
 * - Research agent (investigate topics, build knowledge)
 *
 * NOT used by:
 * - Distillation agent (needs reconstructed temporal view, not raw history)
 */

import type {CoreMessage, CoreTool} from 'ai'
import type {Storage} from '../storage'
import type {Config} from '../config'
import {Provider} from '../provider'
import {Log} from '../util/log'
import {buildAgentContext} from '../context'
import {runAgentLoop, stopOnTool} from '../agent/loop'

const log = Log.create({service: 'sub-agent'})

/**
 * Configuration for a sub-agent run.
 */
export interface SubAgentConfig<TResult> {
  /** Name for logging */
  name: string

  /** The task prompt - what the sub-agent should do */
  taskPrompt: string

  /** Tools available to the sub-agent */
  tools: Record<string, CoreTool>

  /** Name of the tool that signals completion */
  finishToolName: string

  /** Extract result from the finish tool call */
  extractResult: () => TResult

  /** Model tier to use (default: workhorse) */
  tier?: Config.ModelTier

  /** Max turns before giving up (default: 20) */
  maxTurns?: number

  /** Max output tokens per turn (default: 4096) */
  maxTokens?: number

  /** Temperature (default: 0) */
  temperature?: number

  /** Called after each tool result (for tracking) */
  onToolResult?: (toolCallId: string) => void
}

/**
 * Result of a sub-agent run.
 */
export interface SubAgentResult<TResult> {
  /** The extracted result from the finish tool */
  result: TResult

  /** Number of turns used */
  turnsUsed: number

  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }

  /** How the loop ended */
  stopReason: 'done' | 'no_tool_calls' | 'max_turns' | 'cancelled'
}

/**
 * Run a sub-agent with the given configuration.
 *
 * The sub-agent inherits the main agent's system prompt and conversation
 * history (for context and cache efficiency), then receives the task
 * as a [SYSTEM TASK] user message.
 */
export async function runSubAgent<TResult>(
  storage: Storage,
  config: SubAgentConfig<TResult>,
): Promise<SubAgentResult<TResult>> {
  const {
    name,
    taskPrompt,
    tools,
    finishToolName,
    extractResult,
    tier = 'workhorse',
    maxTurns = 20,
    maxTokens,
    temperature = 0,
    onToolResult,
  } = config

  log.info(`starting sub-agent: ${name}`, {maxTurns, tier})

  // Build agent context (same as main agent for cache efficiency)
  const ctx = await buildAgentContext(storage)

  // Get model for the specified tier
  const model = Provider.getModelForTier(tier)

  // Initial messages: conversation history + task
  const initialMessages: CoreMessage[] = [
    ...ctx.historyTurns,
    {role: 'user', content: `[SYSTEM TASK]\n\n${taskPrompt}`},
  ]

  // Run the agent loop
  const loopResult = await runAgentLoop({
    model,
    systemPrompt: ctx.systemPrompt,
    initialMessages,
    tools,
    maxTokens,
    temperature,
    maxTurns,
    isDone: stopOnTool(finishToolName),
    onToolResult,
  })

  log.info(`sub-agent complete: ${name}`, {
    turnsUsed: loopResult.turnsUsed,
    stopReason: loopResult.stopReason,
  })

  return {
    result: extractResult(),
    turnsUsed: loopResult.turnsUsed,
    usage: loopResult.usage,
    stopReason: loopResult.stopReason,
  }
}
