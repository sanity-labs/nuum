/**
 * Temporal view construction.
 *
 * Builds the temporal context as proper conversation turns (CoreMessage[]).
 * The ENTIRE history is always represented - older content is summarized,
 * recent content is raw messages. No content is dropped.
 *
 * If the view exceeds the token budget, that signals compaction is needed -
 * but the view still includes everything.
 */

import type {
  CoreMessage,
  CoreAssistantMessage,
  CoreToolMessage,
  ToolCallPart,
  ToolResultPart,
} from "ai"
import type { TemporalMessage, TemporalSummary } from "../storage/schema"
import { isCoveredBySummary, isSubsumedByHigherOrder } from "./coverage"
import { Log } from "../util/log"

const log = Log.create({ service: "temporal-view" })

export interface TemporalView {
  /** Summaries included in the view, sorted chronologically */
  summaries: TemporalSummary[]
  /** Raw messages included in the view, sorted chronologically */
  messages: TemporalMessage[]
  /** Total tokens used by this view */
  totalTokens: number
  /** Token breakdown for debugging */
  breakdown: {
    summaryTokens: number
    messageTokens: number
  }
}

export interface BuildTemporalViewOptions {
  /** Token budget (informational - view may exceed if compaction is needed) */
  budget: number
  /** All messages in the temporal store */
  messages: TemporalMessage[]
  /** All summaries in the temporal store */
  summaries: TemporalSummary[]
}

/**
 * Build a temporal view representing the ENTIRE conversation history.
 *
 * Algorithm:
 * 1. Get all effective summaries (not subsumed by higher-order ones)
 * 2. Get all messages NOT covered by any summary
 * 3. Include everything - the full history is always represented
 *
 * The budget parameter is purely informational. If totalTokens exceeds budget,
 * that signals compaction should be triggered - but we NEVER drop content.
 * The agent always sees the complete history, just recursively summarized.
 */
export function buildTemporalView(options: BuildTemporalViewOptions): TemporalView {
  const { messages, summaries } = options

  // Handle empty history
  if (messages.length === 0 && summaries.length === 0) {
    return {
      summaries: [],
      messages: [],
      totalTokens: 0,
      breakdown: { summaryTokens: 0, messageTokens: 0 },
    }
  }

  // 1. Get all effective summaries (not subsumed by higher-order ones)
  // These represent the most compressed form of older history
  const effectiveSummaries = summaries.filter(
    summary => !isSubsumedByHigherOrder(summary, summaries)
  )

  // 2. Get all messages NOT covered by any summary
  // These are recent messages that haven't been compacted yet
  const uncoveredMessages = messages.filter(
    msg => !isCoveredBySummary(msg.id, summaries)
  )

  // Sort summaries chronologically (by startId)
  const sortedSummaries = [...effectiveSummaries].sort(
    (a, b) => a.startId.localeCompare(b.startId)
  )

  // Sort messages chronologically (by id)
  const sortedMessages = [...uncoveredMessages].sort(
    (a, b) => a.id.localeCompare(b.id)
  )

  // Calculate token totals - no dropping, include everything
  const summaryTokens = sortedSummaries.reduce((sum, s) => sum + s.tokenEstimate, 0)
  const messageTokens = sortedMessages.reduce((sum, m) => sum + m.tokenEstimate, 0)

  return {
    summaries: sortedSummaries,
    messages: sortedMessages,
    totalTokens: summaryTokens + messageTokens,
    breakdown: {
      summaryTokens,
      messageTokens,
    },
  }
}

/**
 * Reconstruct temporal history as proper CoreMessage[] turns.
 *
 * This converts the temporal view into actual conversation turns that the
 * model can understand natively, rather than serializing everything into
 * the system prompt.
 *
 * Messages include their ULID as a prefix (e.g., [id:msg-xxx]) to enable
 * the compaction agent to reference specific ranges when creating summaries.
 *
 * Summaries are inserted as system messages at the appropriate position
 * in the conversation flow, with their range visible (from/to IDs).
 */
export function reconstructHistoryAsTurns(view: TemporalView): CoreMessage[] {
  const turns: CoreMessage[] = []

  // Interleave summaries and messages chronologically
  // Both are already sorted by their IDs (chronological order)
  let summaryIdx = 0
  let messageIdx = 0

  while (summaryIdx < view.summaries.length || messageIdx < view.messages.length) {
    const summary = view.summaries[summaryIdx]
    const message = view.messages[messageIdx]

    // Determine which comes first chronologically
    // Summaries use startId for ordering, messages use id
    const summaryKey = summary?.startId
    const messageKey = message?.id

    if (summaryKey && (!messageKey || summaryKey < messageKey)) {
      // Insert summary as an assistant message (represents past assistant work)
      let observations: string[] = []
      try {
        observations = JSON.parse(summary.keyObservations) as string[]
      } catch (error) {
        log.error("failed to parse summary keyObservations", {
          summaryId: summary.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      let summaryContent = `[distilled from:${summary.startId} to:${summary.endId}]\n${summary.narrative}`
      if (observations.length > 0) {
        summaryContent += "\n\nRetained facts:\n" + observations.map(o => `• ${o}`).join("\n")
      }

      turns.push({
        role: "assistant",
        content: summaryContent,
      })
      summaryIdx++
    } else if (messageKey) {
      // Process message based on type
      const processed = processMessageForTurn(message, view.messages, messageIdx)
      if (processed.turns.length > 0) {
        turns.push(...processed.turns)
      }
      messageIdx = processed.nextIdx
    } else {
      break
    }
  }

  return turns
}

/**
 * Format message content with ID prefix.
 * The ID prefix allows the compaction agent to reference specific messages.
 */
function formatWithId(id: string, content: string): string {
  return `[id:${id}] ${content}`
}

/**
 * Process a message and potentially following related messages into CoreMessage turns.
 * Groups tool_call + tool_result sequences together.
 * All messages include their ULID as a prefix for compaction agent reference.
 */
function processMessageForTurn(
  message: TemporalMessage,
  allMessages: TemporalMessage[],
  currentIdx: number,
): { turns: CoreMessage[]; nextIdx: number } {
  const turns: CoreMessage[] = []

  switch (message.type) {
    case "user":
      turns.push({ role: "user", content: formatWithId(message.id, message.content) })
      return { turns, nextIdx: currentIdx + 1 }

    case "assistant": {
      // Check if next messages are tool calls from same assistant turn
      const toolCalls: ToolCallPart[] = []
      const toolResults: ToolResultPart[] = []
      let nextIdx = currentIdx + 1
      let lastMessageId = message.id

      // Look ahead for tool_call messages
      while (nextIdx < allMessages.length && allMessages[nextIdx].type === "tool_call") {
        const toolCallMsg = allMessages[nextIdx]
        lastMessageId = toolCallMsg.id
        try {
          const parsed = JSON.parse(toolCallMsg.content) as { name: string; args: unknown; toolCallId?: string }
          toolCalls.push({
            type: "tool-call",
            toolCallId: parsed.toolCallId || `call_${nextIdx}`,
            toolName: parsed.name,
            args: parsed.args as Record<string, unknown>,
          })
        } catch (error) {
          log.error("failed to parse tool call message", {
            messageId: toolCallMsg.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        nextIdx++
      }

      // Look ahead for corresponding tool_result messages
      while (nextIdx < allMessages.length && allMessages[nextIdx].type === "tool_result") {
        const toolResultMsg = allMessages[nextIdx]
        lastMessageId = toolResultMsg.id
        const correspondingCall = toolCalls[toolResults.length]
        if (correspondingCall) {
          toolResults.push({
            type: "tool-result",
            toolCallId: correspondingCall.toolCallId,
            toolName: correspondingCall.toolName,
            result: toolResultMsg.content,
          })
        }
        nextIdx++
      }

      if (toolCalls.length > 0) {
        // Assistant message with tool calls - prefix with ID range
        const assistantContent: (ToolCallPart | { type: "text"; text: string })[] = []
        const idPrefix = message.id === lastMessageId
          ? `[id:${message.id}]`
          : `[id:${message.id}...${lastMessageId}]`
        if (message.content) {
          assistantContent.push({ type: "text", text: `${idPrefix} ${message.content}` })
        } else {
          assistantContent.push({ type: "text", text: idPrefix })
        }
        assistantContent.push(...toolCalls)

        const assistantMsg: CoreAssistantMessage = {
          role: "assistant",
          content: assistantContent,
        }
        turns.push(assistantMsg)

        // Tool results
        if (toolResults.length > 0) {
          const toolMsg: CoreToolMessage = {
            role: "tool",
            content: toolResults,
          }
          turns.push(toolMsg)
        }
      } else {
        // Simple assistant message without tools
        turns.push({ role: "assistant", content: formatWithId(message.id, message.content) })
      }

      return { turns, nextIdx }
    }

    case "tool_call": {
      // Tool calls without a preceding assistant message (model made tool calls without text)
      // Process them as a standalone assistant turn with tool calls
      const toolCalls: ToolCallPart[] = []
      const toolResults: ToolResultPart[] = []
      let nextIdx = currentIdx
      let firstMessageId = message.id
      let lastMessageId = message.id

      // Consume all consecutive tool_call messages
      while (nextIdx < allMessages.length && allMessages[nextIdx].type === "tool_call") {
        const toolCallMsg = allMessages[nextIdx]
        lastMessageId = toolCallMsg.id
        try {
          const parsed = JSON.parse(toolCallMsg.content) as { name: string; args: unknown; toolCallId?: string }
          toolCalls.push({
            type: "tool-call",
            toolCallId: parsed.toolCallId || `call_${nextIdx}`,
            toolName: parsed.name,
            args: parsed.args as Record<string, unknown>,
          })
        } catch (error) {
          log.error("failed to parse tool call message", {
            messageId: toolCallMsg.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        nextIdx++
      }

      // Consume corresponding tool_result messages
      while (nextIdx < allMessages.length && allMessages[nextIdx].type === "tool_result") {
        const toolResultMsg = allMessages[nextIdx]
        lastMessageId = toolResultMsg.id
        const correspondingCall = toolCalls[toolResults.length]
        if (correspondingCall) {
          toolResults.push({
            type: "tool-result",
            toolCallId: correspondingCall.toolCallId,
            toolName: correspondingCall.toolName,
            result: toolResultMsg.content,
          })
        }
        nextIdx++
      }

      if (toolCalls.length > 0) {
        // Create assistant message with tool calls (no text content)
        const idPrefix = firstMessageId === lastMessageId
          ? `[id:${firstMessageId}]`
          : `[id:${firstMessageId}...${lastMessageId}]`
        const assistantContent: (ToolCallPart | { type: "text"; text: string })[] = [
          { type: "text", text: idPrefix },
          ...toolCalls,
        ]

        const assistantMsg: CoreAssistantMessage = {
          role: "assistant",
          content: assistantContent,
        }
        turns.push(assistantMsg)

        // Tool results
        if (toolResults.length > 0) {
          const toolMsg: CoreToolMessage = {
            role: "tool",
            content: toolResults,
          }
          turns.push(toolMsg)
        }
      }

      return { turns, nextIdx }
    }

    case "tool_result":
      // Tool result without preceding tool_call - this is truly orphaned
      log.warn("orphaned tool_result in history reconstruction", {
        messageId: message.id,
      })
      return { turns: [], nextIdx: currentIdx + 1 }

    case "system":
      // System messages become assistant messages (context injections)
      turns.push({
        role: "assistant",
        content: `[system ${formatWithId(message.id, message.content)}]`,
      })
      return { turns, nextIdx: currentIdx + 1 }

    default:
      return { turns: [], nextIdx: currentIdx + 1 }
  }
}

/**
 * Render the temporal view as XML for the system prompt.
 * @deprecated Use reconstructHistoryAsTurns instead for proper conversation turns.
 */
export function renderTemporalView(view: TemporalView): string {
  if (view.summaries.length === 0 && view.messages.length === 0) {
    return "<conversation_history>\nNo previous conversation history.\n</conversation_history>"
  }

  const parts: string[] = ["<conversation_history>"]

  // Render summaries (oldest first)
  for (const summary of view.summaries) {
    let observations: string[] = []
    try {
      observations = JSON.parse(summary.keyObservations) as string[]
    } catch (error) {
      log.error("failed to parse summary keyObservations", {
        summaryId: summary.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    parts.push(
      `<summary order="${summary.orderNum}" from="${summary.startId}" to="${summary.endId}">`,
    )
    parts.push(summary.narrative)
    if (observations.length > 0) {
      parts.push("Key observations:")
      for (const obs of observations) {
        parts.push(`- ${obs}`)
      }
    }
    parts.push("</summary>")
    parts.push("")
  }

  // Render recent messages
  for (const msg of view.messages) {
    const prefix = getMessagePrefix(msg.type)
    parts.push(`${prefix}: ${msg.content}`)
  }

  parts.push("</conversation_history>")

  return parts.join("\n")
}

function getMessagePrefix(type: string): string {
  switch (type) {
    case "user":
      return "[User]"
    case "assistant":
      return "[Assistant]"
    case "tool_call":
      return "[Tool Call]"
    case "tool_result":
      return "[Tool Result]"
    case "system":
      return "[System]"
    default:
      return "[Unknown]"
  }
}
