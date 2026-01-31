/**
 * Agent context building module.
 *
 * This module owns the "fork point" for the agent - everything needed
 * to set up the shared context before a workload-specific task is added.
 *
 * The agent is conceptually ONE agent with multiple workloads:
 * - Main: interactive coding assistance
 * - Compaction: episodic memory cleanup
 * - Consolidation: long-term memory extraction
 *
 * All workloads share the same system prompt and conversation history
 * (for prompt caching efficiency and conceptual consistency). They
 * diverge only at the final user message which specifies the task.
 */

import type {CoreMessage} from 'ai'
import type {Storage} from '../storage'
import {buildSystemPrompt} from './system-prompt'
import {buildConversationHistory} from './history'

export {buildSystemPrompt} from './system-prompt'
export {buildConversationHistory} from './history'

/**
 * The complete agent context before a workload-specific task is added.
 */
export interface AgentContext {
  /** The system prompt (identity, behavior, present state, instructions) */
  systemPrompt: string
  /** Estimated tokens in the system prompt */
  systemTokens: number
  /** The conversation history as proper turns */
  historyTurns: CoreMessage[]
}

/**
 * Build the complete agent context.
 *
 * This is the shared foundation for all workloads. After calling this,
 * each workload adds its specific task as a final user message:
 *
 * ```typescript
 * const ctx = await buildAgentContext(storage)
 * const messages = [...ctx.historyTurns, { role: "user", content: taskPrompt }]
 * ```
 */
export async function buildAgentContext(
  storage: Storage,
): Promise<AgentContext> {
  const {prompt: systemPrompt, tokens: systemTokens} =
    await buildSystemPrompt(storage)
  const historyTurns = await buildConversationHistory(storage)

  return {
    systemPrompt,
    systemTokens,
    historyTurns,
  }
}
