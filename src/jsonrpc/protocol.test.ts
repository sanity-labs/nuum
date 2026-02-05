/**
 * Tests for Claude Code SDK protocol parsing and message builders.
 */

import {describe, expect, test} from 'bun:test'
import {
  parseInputMessage,
  isUserMessage,
  isControlRequest,
  getPromptFromUserMessage,
  assistantText,
  assistantToolUse,
  toolResult,
  userToolResult,
  resultMessage,
  systemMessage,
  type UserMessage,
} from './protocol'

describe('parseInputMessage', () => {
  describe('user messages', () => {
    test('parses valid user message with string content', () => {
      const line = '{"type":"user","message":{"role":"user","content":"Hello"}}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result) {
        expect(isUserMessage(result.message)).toBe(true)
        if (isUserMessage(result.message)) {
          expect(result.message.type).toBe('user')
          expect(result.message.message.role).toBe('user')
          expect(result.message.message.content).toBe('Hello')
        }
      }
    })

    test('parses user message with session_id', () => {
      const line =
        '{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"sess_123"}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isUserMessage(result.message)) {
        expect(result.message.session_id).toBe('sess_123')
      }
    })

    test('parses user message with content block array', () => {
      const line =
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"},{"type":"text","text":"World"}]}}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isUserMessage(result.message)) {
        expect(Array.isArray(result.message.message.content)).toBe(true)
      }
    })

    test('parses user message with system_prompt', () => {
      const line =
        '{"type":"user","message":{"role":"user","content":"Hello"},"system_prompt":"Always respond in French."}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isUserMessage(result.message)) {
        expect(result.message.system_prompt).toBe('Always respond in French.')
      }
    })

    test('parses user message with mcp_servers', () => {
      const line =
        '{"type":"user","message":{"role":"user","content":"Hello"},"mcp_servers":{"my-server":{"command":"node","args":["server.js"]}}}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isUserMessage(result.message)) {
        expect(result.message.mcp_servers).toEqual({
          'my-server': {command: 'node', args: ['server.js']},
        })
      }
    })
  })

  describe('control requests', () => {
    test('parses interrupt control request', () => {
      const line = '{"type":"control","action":"interrupt"}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result) {
        expect(isControlRequest(result.message)).toBe(true)
        if (isControlRequest(result.message)) {
          expect(result.message.action).toBe('interrupt')
        }
      }
    })

    test('parses status control request', () => {
      const line = '{"type":"control","action":"status"}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isControlRequest(result.message)) {
        expect(result.message.action).toBe('status')
      }
    })

    test('parses heartbeat control request', () => {
      const line = '{"type":"control","action":"heartbeat"}'
      const result = parseInputMessage(line)
      expect('message' in result).toBe(true)
      if ('message' in result && isControlRequest(result.message)) {
        expect(result.message.action).toBe('heartbeat')
      }
    })
  })

  describe('error cases', () => {
    test('returns error for invalid JSON', () => {
      const result = parseInputMessage('not json')
      expect('error' in result).toBe(true)
      if ('error' in result) {
        expect(result.error).toContain('Parse error')
      }
    })

    test('returns error for unknown message type', () => {
      const result = parseInputMessage('{"type":"unknown"}')
      expect('error' in result).toBe(true)
    })

    test('returns error for missing message field in user message', () => {
      const result = parseInputMessage('{"type":"user"}')
      expect('error' in result).toBe(true)
    })

    test('returns error for invalid control action', () => {
      const result = parseInputMessage('{"type":"control","action":"invalid"}')
      expect('error' in result).toBe(true)
    })
  })
})

describe('getPromptFromUserMessage', () => {
  test('extracts string content', () => {
    const message: UserMessage = {
      type: 'user',
      message: {role: 'user', content: 'Hello world'},
    }
    expect(getPromptFromUserMessage(message)).toBe('Hello world')
  })

  test('extracts text from content block array', () => {
    const message: UserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {type: 'text', text: 'Hello'},
          {type: 'text', text: 'World'},
        ],
      },
    }
    expect(getPromptFromUserMessage(message)).toBe('Hello\nWorld')
  })

  test('ignores non-text blocks', () => {
    const message: UserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {type: 'text', text: 'Hello'},
          {type: 'tool_result', tool_use_id: '123', content: 'result'},
        ],
      },
    }
    expect(getPromptFromUserMessage(message)).toBe('Hello')
  })
})

describe('message builders', () => {
  test('assistantText creates text content block', () => {
    const msg = assistantText('Hello', 'claude-sonnet-4-20250514')
    expect(msg.type).toBe('assistant')
    expect(msg.message.role).toBe('assistant')
    expect(msg.message.model).toBe('claude-sonnet-4-20250514')
    expect(msg.message.content).toEqual([{type: 'text', text: 'Hello'}])
  })

  test('assistantText includes session_id when provided', () => {
    const msg = assistantText('Hello', 'claude-sonnet-4-20250514', 'sess_123')
    expect(msg.session_id).toBe('sess_123')
  })

  test('assistantText has undefined session_id when not provided', () => {
    const msg = assistantText('Hello', 'claude-sonnet-4-20250514')
    expect(msg.session_id).toBeUndefined()
  })

  test('assistantToolUse creates tool_use content block', () => {
    const msg = assistantToolUse(
      'call_123',
      'read',
      {filePath: '/foo'},
      'claude-sonnet-4-20250514',
    )
    expect(msg.type).toBe('assistant')
    expect(msg.message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call_123',
        name: 'read',
        input: {filePath: '/foo'},
      },
    ])
  })

  test('assistantToolUse includes session_id when provided', () => {
    const msg = assistantToolUse('call_123', 'read', {}, 'model', 'sess_456')
    expect(msg.session_id).toBe('sess_456')
  })

  test('toolResult creates tool_result block', () => {
    const block = toolResult('call_123', 'file contents')
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'call_123',
      content: 'file contents',
      is_error: undefined,
    })
  })

  test('toolResult with error flag', () => {
    const block = toolResult('call_123', 'error message', true)
    expect(block.is_error).toBe(true)
  })

  test('userToolResult creates SDK-compatible user message with tool_result', () => {
    const msg = userToolResult('call_123', 'file contents', 'sess_456')
    expect(msg.type).toBe('user')
    expect(msg.message.role).toBe('user')
    expect(msg.message.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_123',
        content: 'file contents',
        is_error: undefined,
      },
    ])
    expect(msg.session_id).toBe('sess_456')
  })

  test('userToolResult with error flag', () => {
    const msg = userToolResult('call_123', 'error message', 'sess_456', true)
    expect(msg.message.content[0].is_error).toBe(true)
  })

  test('userToolResult without session_id', () => {
    const msg = userToolResult('call_123', 'content')
    expect(msg.session_id).toBeUndefined()
  })

  test('resultMessage creates success result', () => {
    const msg = resultMessage('sess_123', 'success', 1000, 5, {
      result: 'Done!',
      inputTokens: 100,
      outputTokens: 50,
    })
    expect(msg.type).toBe('result')
    expect(msg.subtype).toBe('success')
    expect(msg.is_error).toBe(false)
    expect(msg.duration_ms).toBe(1000)
    expect(msg.num_turns).toBe(5)
    expect(msg.session_id).toBe('sess_123')
    expect(msg.result).toBe('Done!')
    expect(msg.usage).toEqual({input_tokens: 100, output_tokens: 50})
  })

  test('resultMessage creates error result with SDK subtype', () => {
    const msg = resultMessage('sess_123', 'error_during_execution', 500, 2, {
      result: 'Something broke',
    })
    expect(msg.subtype).toBe('error_during_execution')
    expect(msg.is_error).toBe(true)
  })

  test('resultMessage creates max_turns error result', () => {
    const msg = resultMessage('sess_123', 'error_max_turns', 500, 10)
    expect(msg.subtype).toBe('error_max_turns')
    expect(msg.is_error).toBe(true)
  })

  test('resultMessage creates cancelled result', () => {
    const msg = resultMessage('sess_123', 'cancelled', 300, 1)
    expect(msg.subtype).toBe('cancelled')
    expect(msg.is_error).toBe(false)
  })

  test('systemMessage creates system message', () => {
    const msg = systemMessage('status', {running: true})
    expect(msg.type).toBe('system')
    expect(msg.subtype).toBe('status')
    expect(msg.running).toBe(true)
  })

  test('systemMessage for queued notification', () => {
    const msg = systemMessage('queued', {session_id: 'sess_1', position: 2})
    expect(msg.subtype).toBe('queued')
    expect(msg.position).toBe(2)
  })

  test('systemMessage for init (CAST integration)', () => {
    const msg = systemMessage('init', {
      session_id: 'sess_123',
      model: 'claude-opus-4-6',
      tools: ['read', 'write', 'bash'],
    })
    expect(msg.type).toBe('system')
    expect(msg.subtype).toBe('init')
    expect(msg.session_id).toBe('sess_123')
    expect(msg.model).toBe('claude-opus-4-6')
    expect(msg.tools).toEqual(['read', 'write', 'bash'])
  })

  test('systemMessage for heartbeat_ack (CAST integration)', () => {
    const timestamp = new Date().toISOString()
    const msg = systemMessage('heartbeat_ack', {
      timestamp,
      session_id: 'sess_123',
    })
    expect(msg.type).toBe('system')
    expect(msg.subtype).toBe('heartbeat_ack')
    expect(msg.timestamp).toBe(timestamp)
    expect(msg.session_id).toBe('sess_123')
  })

  test('systemMessage for interrupted', () => {
    const msg = systemMessage('interrupted', {session_id: 'sess_123'})
    expect(msg.subtype).toBe('interrupted')
    expect(msg.session_id).toBe('sess_123')
  })

  test('systemMessage for injected', () => {
    const msg = systemMessage('injected', {
      message_count: 2,
      content_length: 150,
      session_id: 'sess_123',
    })
    expect(msg.subtype).toBe('injected')
    expect(msg.message_count).toBe(2)
    expect(msg.content_length).toBe(150)
    expect(msg.session_id).toBe('sess_123')
  })
})

describe('NDJSON format', () => {
  test('output messages serialize to valid JSON', () => {
    const msg = assistantText('Hello', 'claude-sonnet-4-20250514')
    const json = JSON.stringify(msg)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  test('multiple messages can be joined with newlines', () => {
    const messages = [
      assistantText('Hello', 'claude-sonnet-4-20250514'),
      assistantText(' world', 'claude-sonnet-4-20250514'),
      resultMessage('sess_1', 'success', 1000, 1, {
        result: 'Hello world',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ]
    const ndjson = messages.map((m) => JSON.stringify(m)).join('\n')
    const lines = ndjson.split('\n')
    expect(lines.length).toBe(3)
    lines.forEach((line) => {
      expect(() => JSON.parse(line)).not.toThrow()
    })
  })

  test('user message round-trips through JSON', () => {
    const input =
      '{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"test"}'
    const result = parseInputMessage(input)
    expect('message' in result).toBe(true)
    if ('message' in result && isUserMessage(result.message)) {
      const roundTripped = JSON.stringify(result.message)
      expect(JSON.parse(roundTripped)).toEqual(result.message)
    }
  })

  test('control request round-trips through JSON', () => {
    const input = '{"type":"control","action":"interrupt"}'
    const result = parseInputMessage(input)
    expect('message' in result).toBe(true)
    if ('message' in result && isControlRequest(result.message)) {
      const roundTripped = JSON.stringify(result.message)
      expect(JSON.parse(roundTripped)).toEqual(result.message)
    }
  })
})
