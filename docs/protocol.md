# Nuum Wire Protocol

Nuum communicates via **NDJSON over stdio** (newline-delimited JSON). This makes it easy to embed in host applications, orchestration platforms, and IDEs.

## Transport

- **Format**: Newline-delimited JSON (NDJSON)
- **Input**: stdin
- **Output**: stdout
- **Lifecycle**: Process stays alive between turns, accepts ongoing messages

## Starting the Server

```bash
nuum --stdio              # NDJSON protocol mode
nuum --stdio --db ./my.db # With custom database
```

## Input Messages (stdin → Nuum)

### User Message

Send a user message to start or continue a conversation:

```json
{"type":"user","message":{"role":"user","content":"Hello"}}
```

With content blocks:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}}
```

Fields:
- `type`: Always `"user"`
- `message.role`: Always `"user"`
- `message.content`: String or array of content blocks

### Control Messages

```json
{"type":"control","action":"interrupt"}
{"type":"control","action":"status"}
{"type":"control","action":"heartbeat"}
```

Actions:
- `interrupt`: Cancel the current turn
- `status`: Get server status
- `heartbeat`: Keep-alive ping

## Output Messages (Nuum → stdout)

### Init Message

Sent once on startup:

```json
{"type":"system","subtype":"init","session_id":"nuum_01JD...","version":"0.1.0","tools":["read","write","edit","bash","glob","grep"]}
```

### Assistant Message

The agent's response, possibly with tool calls:

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll help you with that."}],"model":"claude-sonnet-4-5-20250929"},"session_id":"nuum_01JD..."}
```

With tool use:
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_123","name":"read","input":{"filePath":"/tmp/test.txt"}}],"model":"claude-sonnet-4-5-20250929"},"session_id":"nuum_01JD..."}
```

### Tool Result

Emitted after each tool execution:

```json
{"type":"system","subtype":"tool_result","tool_result":{"type":"tool_result","tool_use_id":"call_123","content":"file contents here"}}
```

### Result Message

Sent when a turn completes:

```json
{"type":"result","subtype":"success","duration_ms":1234,"is_error":false,"num_turns":3,"session_id":"nuum_01JD...","result":"Done!","usage":{"input_tokens":100,"output_tokens":50}}
```

Subtypes:
- `success`: Turn completed normally
- `error`: Turn failed with error
- `cancelled`: Turn was interrupted

### Turn Accepted

Emitted immediately when a message is received and processing begins:

```json
{"type":"system","subtype":"turn_accepted","session_id":"nuum_01JD...","timestamp":"2026-02-05T15:30:00.000Z"}
```

This allows UIs to show a "thinking..." state before the first assistant output arrives.

### Tasks Snapshot

Emitted whenever background tasks or alarms change:

```json
{"type":"system","subtype":"tasks","tasks":[
  {"id":"bgtask_01JD...","type":"research","description":"How does Stripe work?","status":"running","createdAt":"2026-02-05T15:00:00Z"},
  {"id":"bgtask_01JE...","type":"alarm","description":"Check deployment","status":"pending","firesAt":"2026-02-05T16:00:00Z"}
],"session_id":"nuum_01JD..."}
```

Task types: `research`, `reflect`, `alarm`
Task statuses: `running` (for tasks), `pending` (for alarms)

This is emitted on:
- Task created (`background_research`, `background_reflect`)
- Task completed or failed
- Alarm created (`set_alarm`)
- Alarm fired

### System Messages

Various events and metadata:

```json
{"type":"system","subtype":"error","message":"Something went wrong"}
{"type":"system","subtype":"queued","position":1}
{"type":"system","subtype":"injected","message_count":2}
{"type":"system","subtype":"status_response","running":true,"session_id":"nuum_01JD..."}
{"type":"system","subtype":"heartbeat_ack"}
```

## Mid-Turn Message Injection

Messages sent while a turn is running are queued and injected at the next opportunity (before the next model call). This allows users to provide corrections or additional context mid-turn.

```
→ {"type":"user","message":{"role":"user","content":"Refactor the auth module"}}
← {"type":"assistant",...}  // Agent starts working
→ {"type":"user","message":{"role":"user","content":"Actually, focus on the login function only"}}
← {"type":"system","subtype":"queued","position":1}
← {"type":"system","subtype":"injected","message_count":1}
← {"type":"assistant",...}  // Agent sees the correction and adjusts
```

## Example Session

```
→ {"type":"user","message":{"role":"user","content":"Read /tmp/test.txt"}}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read that file."},{"type":"tool_use","id":"call_1","name":"read","input":{"filePath":"/tmp/test.txt"}}],"model":"claude-sonnet-4-5-20250929"},"session_id":"nuum_01JD..."}
← {"type":"system","subtype":"tool_result","tool_result":{"type":"tool_result","tool_use_id":"call_1","content":"Hello world!"}}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The file contains: Hello world!"}],"model":"claude-sonnet-4-5-20250929"},"session_id":"nuum_01JD..."}
← {"type":"result","subtype":"success","duration_ms":2500,"is_error":false,"num_turns":1,"session_id":"nuum_01JD...","result":"The file contains: Hello world!"}
```

## Session Identity

Nuum generates a stable `session_id` on first run, stored in the database. This ID persists forever for that database — one database = one agent identity.

The session_id appears in:
- The `init` message on startup
- All `assistant` messages
- All `result` messages

Clients can use this to correlate responses and track agent identity across restarts.

## Content Block Types

### Text
```json
{"type":"text","text":"Hello world"}
```

### Tool Use
```json
{"type":"tool_use","id":"call_123","name":"read","input":{"filePath":"/tmp/test.txt"}}
```

### Tool Result
```json
{"type":"tool_result","tool_use_id":"call_123","content":"file contents","is_error":false}
```
