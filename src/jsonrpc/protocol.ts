/**
 * JSON-RPC protocol types and validation for miriad-code
 *
 * NDJSON format over stdio for interactive mode.
 */

import { z } from "zod"

// JSON-RPC request schemas
export const RunParamsSchema = z.object({
  prompt: z.string(),
})

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.enum(["run", "cancel", "status"]),
  params: z.unknown().optional(),
})

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>
export type RunParams = z.infer<typeof RunParamsSchema>

// JSON-RPC response types
export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number
  result?: JsonRpcResult
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// Result types for streaming responses
export type JsonRpcResult =
  | TextChunkResult
  | ToolCallResult
  | ToolResultResult
  | CompleteResult
  | CancelledResult
  | StatusResult
  | ErrorResult

export interface TextChunkResult {
  type: "text"
  chunk: string
}

export interface ToolCallResult {
  type: "tool_call"
  callId: string
  name: string
  args: unknown
}

export interface ToolResultResult {
  type: "tool_result"
  callId: string
  result: string
}

export interface CompleteResult {
  type: "complete"
  response: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface CancelledResult {
  type: "cancelled"
}

export interface StatusResult {
  type: "status"
  running: boolean
  requestId?: string | number
}

export interface ErrorResult {
  type: "error"
  message: string
}

// Standard JSON-RPC error codes
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom error codes
  ALREADY_RUNNING: -32001,
  NOT_RUNNING: -32002,
  CANCELLED: -32003,
} as const

/**
 * Create a JSON-RPC response object.
 */
export function createResponse(id: string | number, result: JsonRpcResult): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  }
}

/**
 * Create a JSON-RPC error response.
 */
export function createErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? 0,
    error: { code, message, data },
  }
}

/**
 * Parse and validate a JSON-RPC request.
 */
export function parseRequest(line: string): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return {
      error: createErrorResponse(null, ErrorCodes.PARSE_ERROR, "Parse error: invalid JSON"),
    }
  }

  const result = JsonRpcRequestSchema.safeParse(parsed)
  if (!result.success) {
    return {
      error: createErrorResponse(
        (parsed as { id?: unknown })?.id ?? null,
        ErrorCodes.INVALID_REQUEST,
        "Invalid request",
        result.error.format(),
      ),
    }
  }

  return { request: result.data }
}

/**
 * Validate run params.
 */
export function validateRunParams(params: unknown): { params: RunParams } | { error: string } {
  const result = RunParamsSchema.safeParse(params)
  if (!result.success) {
    return { error: result.error.format()._errors.join(", ") || "Invalid params" }
  }
  return { params: result.data }
}
