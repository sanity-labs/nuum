/**
 * Claude Code SDK Protocol
 *
 * Raw NDJSON over stdin/stdout - no JSON-RPC envelope.
 * See docs/claude-code-protocol.md for the specification.
 */

import {z} from 'zod'

// =============================================================================
// Content Blocks
// =============================================================================

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | null
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

// =============================================================================
// Input Messages (stdin)
// =============================================================================

export const UserMessageSchema = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
  session_id: z.string().optional(),
  /** CAST-provided addition to base system prompt (stored, persists across messages) */
  system_prompt: z.string().optional(),
  /** CAST-provided MCP server config (takes precedence over env/file config) */
  mcp_servers: z.record(z.unknown()).optional(),
  /** CAST-provided environment variables (applied to child process spawns) */
  environment: z.record(z.string()).optional(),
})

export const ControlRequestSchema = z.object({
  type: z.literal('control'),
  action: z.enum(['interrupt', 'status', 'heartbeat']),
})

export type UserMessage = z.infer<typeof UserMessageSchema>
export type ControlRequest = z.infer<typeof ControlRequestSchema>
export type InputMessage = UserMessage | ControlRequest

export function parseInputMessage(
  line: string,
): {message: InputMessage} | {error: string} {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {error: 'Parse error: invalid JSON'}
  }

  // Try parsing as control request first (simpler schema)
  const controlResult = ControlRequestSchema.safeParse(parsed)
  if (controlResult.success) {
    return {message: controlResult.data}
  }

  // Try parsing as user message
  const userResult = UserMessageSchema.safeParse(parsed)
  if (userResult.success) {
    return {message: userResult.data}
  }

  return {error: `Invalid message: expected type 'user' or 'control'`}
}

export function isUserMessage(msg: InputMessage): msg is UserMessage {
  return msg.type === 'user'
}

export function isControlRequest(msg: InputMessage): msg is ControlRequest {
  return msg.type === 'control'
}

export function getPromptFromUserMessage(message: UserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') {
    return content
  }
  // Handle content block array - extract text from text blocks
  const textBlocks = content.filter(
    (block): block is {type: 'text'; text: string} =>
      typeof block === 'object' &&
      block !== null &&
      (block as {type?: string}).type === 'text',
  )
  return textBlocks.map((b) => b.text).join('\n')
}

// =============================================================================
// Output Messages (stdout)
// =============================================================================

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
    model: string
  }
  session_id?: string
}

/**
 * User message output — used for tool_result blocks.
 * Claude SDK emits tool results as user messages with content blocks.
 */
export interface UserOutputMessage {
  type: 'user'
  message: {
    role: 'user'
    content: ToolResultBlock[]
  }
  session_id?: string
}

/**
 * SDK-compatible result subtypes.
 * Success uses 'success', errors use specific SDK error subtypes.
 */
export type ResultSubtype =
  | 'success'
  | 'error_during_execution'
  | 'error_max_turns'
  | 'cancelled'

export interface ResultMessage {
  type: 'result'
  subtype: ResultSubtype
  duration_ms: number
  is_error: boolean
  num_turns: number
  session_id: string
  result?: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export interface SystemMessage {
  type: 'system'
  subtype: string
  session_id?: string
  [key: string]: unknown
}

export type OutputMessage =
  | AssistantMessage
  | UserOutputMessage
  | ResultMessage
  | SystemMessage

// =============================================================================
// Message Builders
// =============================================================================

export function assistantText(
  text: string,
  model: string,
  sessionId?: string,
): AssistantMessage {
  return {
    type: 'assistant',
    message: {role: 'assistant', content: [{type: 'text', text}], model},
    session_id: sessionId,
  }
}

export function assistantToolUse(
  id: string,
  name: string,
  input: unknown,
  model: string,
  sessionId?: string,
): AssistantMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{type: 'tool_use', id, name, input}],
      model,
    },
    session_id: sessionId,
  }
}

export function toolResult(
  toolUseId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError || undefined,
  }
}

/**
 * Build a user message containing tool_result blocks.
 * This matches Claude SDK format where tool results are user messages.
 */
export function userToolResult(
  toolUseId: string,
  content: string,
  sessionId?: string,
  isError = false,
): UserOutputMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [toolResult(toolUseId, content, isError)],
    },
    session_id: sessionId,
  }
}

export function resultMessage(
  sessionId: string,
  subtype: ResultSubtype,
  durationMs: number,
  numTurns: number,
  options: {result?: string; inputTokens?: number; outputTokens?: number} = {},
): ResultMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: durationMs,
    is_error: subtype !== 'success' && subtype !== 'cancelled',
    num_turns: numTurns,
    session_id: sessionId,
    result: options.result,
    usage:
      options.inputTokens !== undefined
        ? {
            input_tokens: options.inputTokens,
            output_tokens: options.outputTokens ?? 0,
          }
        : undefined,
  }
}

export function systemMessage(
  subtype: string,
  data: Record<string, unknown> = {},
): SystemMessage {
  return {type: 'system', subtype, ...data}
}
