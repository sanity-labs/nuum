/**
 * Tests for JSON-RPC protocol parsing and validation.
 */

import { describe, expect, test } from "bun:test"
import {
  parseRequest,
  validateRunParams,
  createResponse,
  createErrorResponse,
  assistantText,
  assistantToolUse,
  toolResult,
  resultMessage,
  systemMessage,
  ErrorCodes,
} from "./protocol"

describe("parseRequest", () => {
  test("parses valid run request", () => {
    const line = '{"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"Hello"}}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.jsonrpc).toBe("2.0")
      expect(result.request.id).toBe(1)
      expect(result.request.method).toBe("run")
      expect(result.request.params).toEqual({ prompt: "Hello" })
    }
  })

  test("parses valid cancel request", () => {
    const line = '{"jsonrpc":"2.0","id":2,"method":"cancel"}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.method).toBe("cancel")
    }
  })

  test("parses valid status request", () => {
    const line = '{"jsonrpc":"2.0","id":"abc","method":"status"}'
    const result = parseRequest(line)
    expect("request" in result).toBe(true)
    if ("request" in result) {
      expect(result.request.id).toBe("abc")
      expect(result.request.method).toBe("status")
    }
  })

  test("returns error for invalid JSON", () => {
    const result = parseRequest("not json")
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error.error?.code).toBe(ErrorCodes.PARSE_ERROR)
    }
  })

  test("returns error for invalid request structure", () => {
    const result = parseRequest('{"foo":"bar"}')
    expect("error" in result).toBe(true)
    if ("error" in result) {
      expect(result.error.error?.code).toBe(ErrorCodes.INVALID_REQUEST)
    }
  })

  test("returns error for missing jsonrpc version", () => {
    const result = parseRequest('{"id":1,"method":"run"}')
    expect("error" in result).toBe(true)
  })

  test("returns error for invalid method", () => {
    const result = parseRequest('{"jsonrpc":"2.0","id":1,"method":"invalid"}')
    expect("error" in result).toBe(true)
  })
})

describe("validateRunParams", () => {
  test("validates correct params", () => {
    const result = validateRunParams({ prompt: "Hello world" })
    expect("params" in result).toBe(true)
    if ("params" in result) {
      expect(result.params.prompt).toBe("Hello world")
    }
  })

  test("validates params with session_id", () => {
    const result = validateRunParams({ prompt: "Hello", session_id: "sess_123" })
    expect("params" in result).toBe(true)
    if ("params" in result) {
      expect(result.params.session_id).toBe("sess_123")
    }
  })

  test("returns error for missing prompt", () => {
    const result = validateRunParams({})
    expect("error" in result).toBe(true)
  })

  test("returns error for non-string prompt", () => {
    const result = validateRunParams({ prompt: 123 })
    expect("error" in result).toBe(true)
  })

  test("returns error for undefined params", () => {
    const result = validateRunParams(undefined)
    expect("error" in result).toBe(true)
  })
})

describe("message builders", () => {
  test("assistantText creates text content block", () => {
    const msg = assistantText("Hello", "claude-sonnet-4-20250514")
    expect(msg.type).toBe("assistant")
    expect(msg.message.role).toBe("assistant")
    expect(msg.message.model).toBe("claude-sonnet-4-20250514")
    expect(msg.message.content).toEqual([{ type: "text", text: "Hello" }])
  })

  test("assistantToolUse creates tool_use content block", () => {
    const msg = assistantToolUse("call_123", "read", { filePath: "/foo" }, "claude-sonnet-4-20250514")
    expect(msg.type).toBe("assistant")
    expect(msg.message.content).toEqual([
      { type: "tool_use", id: "call_123", name: "read", input: { filePath: "/foo" } },
    ])
  })

  test("toolResult creates tool_result block", () => {
    const block = toolResult("call_123", "file contents")
    expect(block).toEqual({ type: "tool_result", tool_use_id: "call_123", content: "file contents", is_error: undefined })
  })

  test("toolResult with error flag", () => {
    const block = toolResult("call_123", "error message", true)
    expect(block.is_error).toBe(true)
  })

  test("resultMessage creates success result", () => {
    const msg = resultMessage("sess_123", "success", 1000, 5, {
      result: "Done!",
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(msg.type).toBe("result")
    expect(msg.subtype).toBe("success")
    expect(msg.is_error).toBe(false)
    expect(msg.duration_ms).toBe(1000)
    expect(msg.num_turns).toBe(5)
    expect(msg.session_id).toBe("sess_123")
    expect(msg.result).toBe("Done!")
    expect(msg.usage).toEqual({ input_tokens: 100, output_tokens: 50 })
  })

  test("resultMessage creates error result", () => {
    const msg = resultMessage("sess_123", "error", 500, 2, { result: "Something broke" })
    expect(msg.subtype).toBe("error")
    expect(msg.is_error).toBe(true)
  })

  test("systemMessage creates system message", () => {
    const msg = systemMessage("status", { running: true, request_id: 1 })
    expect(msg.type).toBe("system")
    expect(msg.subtype).toBe("status")
    expect(msg.running).toBe(true)
    expect(msg.request_id).toBe(1)
  })
})

describe("createResponse", () => {
  test("wraps message in JSON-RPC envelope", () => {
    const msg = assistantText("Hello", "claude-sonnet-4-20250514")
    const response = createResponse(1, msg)
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.result).toBe(msg)
    expect(response.error).toBeUndefined()
  })
})

describe("createErrorResponse", () => {
  test("creates error with code and message", () => {
    const response = createErrorResponse(1, ErrorCodes.INTERNAL_ERROR, "Something broke")
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.error).toEqual({ code: ErrorCodes.INTERNAL_ERROR, message: "Something broke" })
    expect(response.result).toBeUndefined()
  })

  test("creates error with data", () => {
    const response = createErrorResponse(1, ErrorCodes.INVALID_PARAMS, "Bad params", { field: "prompt" })
    expect(response.error?.data).toEqual({ field: "prompt" })
  })

  test("handles null id per JSON-RPC 2.0 spec", () => {
    const response = createErrorResponse(null, ErrorCodes.PARSE_ERROR, "Parse error")
    expect(response.id).toBeNull()
  })
})

describe("NDJSON format", () => {
  test("response serializes to valid JSON", () => {
    const response = createResponse(1, assistantText("Hello", "claude-sonnet-4-20250514"))
    const json = JSON.stringify(response)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test("multiple responses can be joined with newlines", () => {
    const responses = [
      createResponse(1, assistantText("Hello", "claude-sonnet-4-20250514")),
      createResponse(1, assistantText(" world", "claude-sonnet-4-20250514")),
      createResponse(1, resultMessage("sess_1", "success", 1000, 1, { result: "Hello world", inputTokens: 10, outputTokens: 5 })),
    ]
    const ndjson = responses.map((r) => JSON.stringify(r)).join("\n")
    const lines = ndjson.split("\n")
    expect(lines.length).toBe(3)
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow()
    })
  })
})
