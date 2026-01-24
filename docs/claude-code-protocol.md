# Claude Code SDK Protocol Specification

This document describes the Claude Code SDK wire protocol, extracted from the
official `claude-code-sdk-python` repository. Our goal is to support a compatible
subset of this protocol.

## Transport

- **Format**: Newline-delimited JSON (NDJSON) over stdin/stdout
- **Direction**: Bidirectional - both sides can send messages
- **Subprocess**: SDK spawns CLI with `--output-format stream-json --input-format stream-json`

## Message Types

All messages have a `type` field that determines their structure.

### User Message (`type: "user"`)

```typescript
interface UserMessage {
  type: "user"
  message: {
    role: "user"
    content: string | ContentBlock[]
  }
  uuid?: string
  parent_tool_use_id?: string  // For tool result responses
  tool_use_result?: object     // Tool result metadata
  session_id?: string
}
```

### Assistant Message (`type: "assistant"`)

```typescript
interface AssistantMessage {
  type: "assistant"
  message: {
    role: "assistant"
    content: ContentBlock[]
    model: string              // e.g., "claude-sonnet-4-20250514"
    error?: AssistantMessageError
  }
  parent_tool_use_id?: string
}

type AssistantMessageError = 
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
```

### System Message (`type: "system"`)

```typescript
interface SystemMessage {
  type: "system"
  subtype: string  // e.g., "init", "status", etc.
  // ... additional fields based on subtype
}
```

### Result Message (`type: "result"`)

Sent when a conversation turn completes.

```typescript
interface ResultMessage {
  type: "result"
  subtype: string
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  session_id: string
  total_cost_usd?: number
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  result?: string              // Final text response
  structured_output?: any      // If using JSON schema output
}
```

### Stream Event (`type: "stream_event"`)

For partial message updates during streaming (requires `--include-partial-messages`).

```typescript
interface StreamEvent {
  type: "stream_event"
  uuid: string
  session_id: string
  event: object  // Raw Anthropic API stream event
  parent_tool_use_id?: string
}
```

## Content Blocks

Messages contain arrays of content blocks:

### Text Block

```typescript
interface TextBlock {
  type: "text"
  text: string
}
```

### Thinking Block

Extended thinking content (requires beta flag).

```typescript
interface ThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string  // Verification signature
}
```

### Tool Use Block

Request to execute a tool.

```typescript
interface ToolUseBlock {
  type: "tool_use"
  id: string         // Unique tool call ID
  name: string       // Tool name
  input: object      // Tool arguments
}
```

### Tool Result Block

Result from tool execution.

```typescript
interface ToolResultBlock {
  type: "tool_result"
  tool_use_id: string           // References tool_use.id
  content: string | ContentBlock[] | null
  is_error?: boolean
}
```

## Control Protocol

Bidirectional control messages for runtime interaction.

### Control Request (CLI → SDK)

```typescript
interface ControlRequest {
  type: "control_request"
  request_id: string
  request: ControlRequestPayload
}

type ControlRequestPayload =
  | { subtype: "can_use_tool", tool_name: string, input: object, permission_suggestions?: any[] }
  | { subtype: "hook_callback", callback_id: string, input: any, tool_use_id?: string }
  | { subtype: "mcp_message", server_name: string, message: object }
```

### Control Request (SDK → CLI)

```typescript
interface ControlRequest {
  type: "control_request"
  request_id: string
  request: ControlRequestPayload
}

type ControlRequestPayload =
  | { subtype: "initialize", hooks?: object }
  | { subtype: "interrupt" }
  | { subtype: "set_permission_mode", mode: PermissionMode }
  | { subtype: "set_model", model: string | null }
  | { subtype: "rewind_files", user_message_id: string }
```

### Control Response

```typescript
interface ControlResponse {
  type: "control_response"
  response: {
    subtype: "success" | "error"
    request_id: string
    response?: object  // For success
    error?: string     // For error
  }
}
```

## What We Support (miriad-code)

We use JSON-RPC 2.0 envelope with Claude Code SDK compatible message types.

### Implemented

| Feature | Status | Notes |
|---------|--------|-------|
| Assistant messages | ✅ | `type: "assistant"` with content blocks |
| Text blocks | ✅ | `{type: "text", text: string}` |
| Tool use blocks | ✅ | `{type: "tool_use", id, name, input}` |
| Tool result blocks | ✅ | `{type: "tool_result", tool_use_id, content}` |
| Result message | ✅ | `type: "result"` with usage, duration, etc. |
| System messages | ✅ | `type: "system"` for status, errors, consolidation |

### Not Implemented

| Feature | Notes |
|---------|-------|
| Thinking blocks | Requires beta flag |
| Stream events | Partial message updates |
| Control protocol | Permission callbacks, hooks, MCP routing |
| User messages | We use JSON-RPC `run` method instead |

## Example Message Flow

### Simple Query

```json
// SDK → CLI (input)
{"type":"user","message":{"role":"user","content":"Hello"},"session_id":"default"}

// CLI → SDK (streaming output)
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help?"}],"model":"claude-sonnet-4-20250514"}}
{"type":"result","subtype":"success","duration_ms":1234,"duration_api_ms":1000,"is_error":false,"num_turns":1,"session_id":"abc123","usage":{"input_tokens":10,"output_tokens":20}}
```

### Tool Use

```json
// CLI → SDK (assistant wants to use tool)
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me read that file."},{"type":"tool_use","id":"call_123","name":"read","input":{"filePath":"/tmp/test.txt"}}],"model":"claude-sonnet-4-20250514"}}

// SDK → CLI (tool result as user message)
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_123","content":"File contents here"}]},"session_id":"default"}

// CLI → SDK (assistant continues)
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The file contains..."}],"model":"claude-sonnet-4-20250514"}}
{"type":"result","subtype":"success",...}
```

## References

- Source: https://github.com/anthropics/claude-code-sdk-python
- Files analyzed:
  - `src/claude_agent_sdk/types.py` (756 lines)
  - `src/claude_agent_sdk/_internal/query.py` (622 lines)
  - `src/claude_agent_sdk/_internal/message_parser.py` (181 lines)
  - `src/claude_agent_sdk/_internal/transport/subprocess_cli.py` (673 lines)
