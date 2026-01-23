/**
 * Tests for JSON-RPC protocol parsing and validation.
 */

import { describe, expect, test } from "bun:test"
import {
  parseRequest,
  validateRunParams,
  createResponse,
  createErrorResponse,
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

describe("createResponse", () => {
  test("creates text chunk response", () => {
    const response = createResponse(1, { type: "text", chunk: "Hello" })
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.result).toEqual({ type: "text", chunk: "Hello" })
    expect(response.error).toBeUndefined()
  })

  test("creates complete response", () => {
    const response = createResponse("abc", {
      type: "complete",
      response: "Done!",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    expect(response.id).toBe("abc")
    expect(response.result).toEqual({
      type: "complete",
      response: "Done!",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
  })

  test("creates tool_call response", () => {
    const response = createResponse(1, {
      type: "tool_call",
      callId: "call_123",
      name: "read",
      args: { path: "/foo" },
    })
    expect(response.result).toEqual({
      type: "tool_call",
      callId: "call_123",
      name: "read",
      args: { path: "/foo" },
    })
  })
})

describe("createErrorResponse", () => {
  test("creates error with code and message", () => {
    const response = createErrorResponse(1, ErrorCodes.INTERNAL_ERROR, "Something broke")
    expect(response.jsonrpc).toBe("2.0")
    expect(response.id).toBe(1)
    expect(response.error).toEqual({
      code: ErrorCodes.INTERNAL_ERROR,
      message: "Something broke",
    })
    expect(response.result).toBeUndefined()
  })

  test("creates error with data", () => {
    const response = createErrorResponse(1, ErrorCodes.INVALID_PARAMS, "Bad params", { field: "prompt" })
    expect(response.error?.data).toEqual({ field: "prompt" })
  })

  test("handles null id", () => {
    const response = createErrorResponse(null, ErrorCodes.PARSE_ERROR, "Parse error")
    expect(response.id).toBe(0)
  })
})

describe("NDJSON format", () => {
  test("response serializes to valid JSON", () => {
    const response = createResponse(1, { type: "text", chunk: "Hello" })
    const json = JSON.stringify(response)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test("multiple responses can be joined with newlines", () => {
    const responses = [
      createResponse(1, { type: "text", chunk: "Hello" }),
      createResponse(1, { type: "text", chunk: " world" }),
      createResponse(1, { type: "complete", response: "Hello world", usage: { inputTokens: 10, outputTokens: 5 } }),
    ]
    const ndjson = responses.map((r) => JSON.stringify(r)).join("\n")
    const lines = ndjson.split("\n")
    expect(lines.length).toBe(3)
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow()
    })
  })
})
