/**
 * Conversation history reconstruction for the agent.
 *
 * Builds the temporal part of the agent's context: the conversation
 * history reconstructed from messages and summaries. This is shared
 * across all workloads (main agent, compaction, consolidation).
 */

import type {CoreMessage} from 'ai'
import {Config} from '../config'
import type {Storage} from '../storage'
import {buildTemporalView, reconstructHistoryAsTurns} from '../temporal'

/**
 * Build the conversation history as proper CoreMessage[] turns.
 *
 * This is the "what happened" part of the agent context. It reconstructs
 * the conversation from temporal storage, respecting the token budget
 * and using summaries for older content.
 */
export async function buildConversationHistory(
  storage: Storage,
): Promise<CoreMessage[]> {
  const config = Config.get()
  const temporalBudget = config.tokenBudgets.temporalBudget

  // Fetch messages and summaries for temporal view
  const allMessages = await storage.temporal.getMessages()
  const allSummaries = await storage.temporal.getSummaries()

  // Build temporal view that fits within budget
  const temporalView = buildTemporalView({
    budget: temporalBudget,
    messages: allMessages,
    summaries: allSummaries,
  })

  // Reconstruct as proper conversation turns
  return reconstructHistoryAsTurns(temporalView)
}
