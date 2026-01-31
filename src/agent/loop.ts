/**
 * Generic agent loop abstraction.
 *
 * Provides a reusable agent loop that can be configured for different use cases:
 * - Main agent (interactive coding assistant)
 * - Compaction agent (temporal summarization)
 * - Consolidation agent (LTM extraction)
 *
 * The loop handles:
 * - Model calls with tools
 * - Tool result tracking (via AI SDK execute callbacks)
 * - Message history management
 * - Token usage tracking
 * - Completion detection
 */

import type {
  CoreMessage,
  CoreTool,
  CoreAssistantMessage,
  CoreToolMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  LanguageModel,
} from 'ai'
import {Provider} from '../provider'
import {Log} from '../util/log'

const log = Log.create({service: 'agent-loop'})

/**
 * Add Anthropic cache control markers to messages.
 *
 * Follows OpenCode's caching strategy:
 * - Mark the last 3 messages with cache control
 * - Combined with system prompt caching in the provider layer
 *
 * Anthropic allows up to 4 cache breakpoints. We use:
 * 1. System prompt (in provider layer)
 * 2-4. Last 3 messages (here)
 *
 * The cache is prefix-based, so each breakpoint caches everything
 * up to and including that message.
 */
function addCacheMarkers(messages: CoreMessage[]): CoreMessage[] {
  if (messages.length === 0) return messages

  // Create a copy to avoid mutating the original
  const result = [...messages]

  // Mark the last 3 messages (or fewer if not enough messages)
  // This matches OpenCode's approach: i > len(messages)-3
  const startIdx = Math.max(0, messages.length - 3)
  for (let i = startIdx; i < messages.length; i++) {
    result[i] = {
      ...result[i],
      providerOptions: {
        anthropic: {cacheControl: {type: 'ephemeral'}},
      },
    } as CoreMessage
  }

  return result
}

/**
 * Error thrown when the agent loop is cancelled via AbortSignal.
 */
export class AgentLoopCancelledError extends Error {
  constructor() {
    super('Agent loop cancelled')
    this.name = 'AgentLoopCancelledError'
  }
}

/**
 * Options for running an agent loop.
 */
export interface AgentLoopOptions {
  /** The language model to use */
  model: LanguageModel
  /** System prompt */
  systemPrompt: string
  /** Initial messages (conversation history + user prompt) */
  initialMessages: CoreMessage[]
  /** Tools with execute callbacks */
  tools: Record<string, CoreTool>
  /** Maximum tokens for model response */
  maxTokens?: number
  /** Temperature for model response */
  temperature?: number
  /** Maximum number of turns before stopping */
  maxTurns: number
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal
  /**
   * Determine if the loop should stop based on tool calls.
   * Return true to stop the loop.
   * Default: stop when there are no tool calls.
   */
  isDone?: (toolCalls: ToolCallInfo[]) => boolean
  /**
   * Called after each tool execution with the result.
   * Use this to track metrics, log events, etc.
   * Can be async for logging to storage.
   */
  onToolResult?: (
    toolCallId: string,
    toolName: string,
    result: string,
  ) => void | Promise<void>
  /**
   * Called when the model produces text output.
   * Can be async for logging to storage.
   */
  onText?: (text: string) => void | Promise<void>
  /**
   * Called when a tool is called (before execution).
   * Can be async for logging to storage.
   */
  onToolCall?: (
    toolCallId: string,
    toolName: string,
    args: unknown,
  ) => void | Promise<void>
  /**
   * Called before each model turn. Can return additional user content to inject.
   * Use this for mid-turn message delivery - messages received while the agent
   * is running can be injected here to give the agent a chance to adjust.
   */
  onBeforeTurn?: () => string | null | Promise<string | null>
  /**
   * Called when the model is about to "think" (generate a response).
   * Useful for showing a "thinking" indicator in the UI.
   * Only called after the first turn (when there are tool results to process).
   */
  onThinking?: () => void
}

/**
 * Information about a tool call.
 */
export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  args: unknown
}

/**
 * Result of running an agent loop.
 */
export interface AgentLoopResult {
  /** Final text response from the model (if any) */
  finalText: string
  /** All messages in the conversation (including tool calls/results) */
  messages: CoreMessage[]
  /** Number of turns taken */
  turnsUsed: number
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
  /** Why the loop stopped */
  stopReason: 'done' | 'no_tool_calls' | 'max_turns' | 'cancelled'
}

/**
 * Run a generic agent loop.
 *
 * The loop continues until:
 * - isDone() returns true
 * - No tool calls are made (default isDone behavior)
 * - maxTurns is reached
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    model,
    systemPrompt,
    initialMessages,
    tools,
    maxTokens = 4096,
    temperature,
    maxTurns,
    abortSignal,
    isDone = (toolCalls) => toolCalls.length === 0,
    onToolResult,
    onText,
    onToolCall,
    onBeforeTurn,
    onThinking,
  } = options

  // Check if already cancelled
  if (abortSignal?.aborted) {
    throw new AgentLoopCancelledError()
  }

  const messages: CoreMessage[] = [...initialMessages]
  let finalText = ''
  let turnsUsed = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let stopReason: 'done' | 'no_tool_calls' | 'max_turns' | 'cancelled' =
    'max_turns'

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check for cancellation at start of each turn
    if (abortSignal?.aborted) {
      stopReason = 'cancelled'
      throw new AgentLoopCancelledError()
    }

    // Check for mid-turn user messages to inject
    const injectedContent = await onBeforeTurn?.()
    if (injectedContent) {
      messages.push({
        role: 'user',
        content: injectedContent,
      })
      log.info('injected mid-turn user message', {
        contentLength: injectedContent.length,
      })
    }

    turnsUsed++

    // Signal that the model is about to "think" (after first turn, when processing tool results)
    if (turn > 0) {
      onThinking?.()
    }

    // Add cache markers for Anthropic prompt caching
    // Mark the second-to-last message as a cache breakpoint
    // Combined with system prompt caching, this caches the stable context
    const messagesWithCache = addCacheMarkers(messages)

    const response = await Provider.generate({
      model,
      system: systemPrompt,
      messages: messagesWithCache,
      tools,
      maxTokens,
      temperature,
      cacheSystemPrompt: true,
    })

    totalInputTokens += response.usage.promptTokens
    totalOutputTokens += response.usage.completionTokens

    // Log cache metrics for observability
    // Note: Anthropic's input_tokens (promptTokens) only counts tokens AFTER the last
    // cache breakpoint. It does NOT include cached tokens. So:
    //   total = cacheRead + cacheWrite + promptTokens
    const anthropicMeta = response.providerMetadata?.anthropic as
      | {
          cacheCreationInputTokens?: number
          cacheReadInputTokens?: number
        }
      | undefined

    if (anthropicMeta) {
      const cacheWrite = anthropicMeta.cacheCreationInputTokens ?? 0
      const cacheRead = anthropicMeta.cacheReadInputTokens ?? 0
      const uncached = response.usage.promptTokens // This IS the uncached tokens
      const total = cacheRead + cacheWrite + uncached

      log.info('token usage', {
        input: total,
        output: response.usage.completionTokens,
        cacheWrite,
        cacheRead,
        uncached,
        cacheHitRate:
          total > 0 ? `${Math.round((cacheRead / total) * 100)}%` : '0%',
      })
    }

    // Handle text response
    if (response.text) {
      finalText = response.text
      await onText?.(response.text)
    }

    // Handle tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      const assistantParts: (TextPart | ToolCallPart)[] = []
      const toolResultParts: ToolResultPart[] = []

      if (response.text) {
        assistantParts.push({type: 'text', text: response.text})
      }

      // Collect tool call info for isDone check
      const toolCallInfos: ToolCallInfo[] = response.toolCalls.map((tc) => ({
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      }))

      // Cast toolResults to access the result property
      const toolResults = response.toolResults as
        | Array<{toolCallId: string; toolName: string; result: string}>
        | undefined

      for (let i = 0; i < response.toolCalls.length; i++) {
        const toolCall = response.toolCalls[i]

        assistantParts.push({
          type: 'tool-call',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.args,
        })

        // Notify about tool call
        await onToolCall?.(
          toolCall.toolCallId,
          toolCall.toolName,
          toolCall.args,
        )

        // Get the output from toolResults (AI SDK executed the callback)
        const toolResultOutput = toolResults?.[i]?.result ?? 'Error: No result'

        toolResultParts.push({
          type: 'tool-result',
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: toolResultOutput,
        })

        // Notify about tool result
        await onToolResult?.(
          toolCall.toolCallId,
          toolCall.toolName,
          toolResultOutput,
        )
      }

      // Add assistant message with tool calls
      const assistantMsg: CoreAssistantMessage = {
        role: 'assistant',
        content: assistantParts,
      }
      messages.push(assistantMsg)

      // Add tool results
      const toolMsg: CoreToolMessage = {
        role: 'tool',
        content: toolResultParts,
      }
      messages.push(toolMsg)

      // Check if we should stop
      if (isDone(toolCallInfos)) {
        stopReason = 'done'
        break
      }

      // Continue the loop for more turns
      continue
    }

    // No tool calls - add final assistant message and stop
    if (response.text) {
      const assistantMsg: CoreAssistantMessage = {
        role: 'assistant',
        content: response.text,
      }
      messages.push(assistantMsg)
    }

    // Check isDone with empty tool calls (default behavior stops here)
    if (isDone([])) {
      stopReason = 'no_tool_calls'
      break
    }
  }

  return {
    finalText,
    messages,
    turnsUsed,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
    stopReason,
  }
}

/**
 * Helper to create an isDone function that stops when a specific tool is called.
 */
export function stopOnTool(
  toolName: string,
): (toolCalls: ToolCallInfo[]) => boolean {
  return (toolCalls) => toolCalls.some((tc) => tc.toolName === toolName)
}

/**
 * Helper to create an isDone function that stops when no tools are called.
 */
export function stopOnNoTools(): (toolCalls: ToolCallInfo[]) => boolean {
  return (toolCalls) => toolCalls.length === 0
}
