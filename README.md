# Nuum

An AI coding agent with continuous memory — infinite context across sessions.

*Nuum* — from "continuum" — maintains persistent memory across conversations, learning your codebase, preferences, and decisions over time.

## Design Philosophy

Nuum is **optimized for embedding**. While it can run standalone, it's designed to be integrated into host applications, IDEs, and orchestration platforms via a simple **NDJSON-over-stdio** protocol.

- **Stateless process, stateful memory** — The process can restart anytime; all state lives in SQLite
- **Simple wire protocol** — JSON messages over stdin/stdout, easy to integrate from any language
- **Mid-turn injection** — Send corrections while the agent is working; they're injected into the conversation
- **Persistent identity** — One database = one agent with continuous memory forever

See [docs/protocol.md](docs/protocol.md) for the full wire protocol specification.

## Installation

```bash
# Using bunx (recommended - runs in Bun, fast)
bunx @miriad-systems/nuum

# Using npx (runs in Node.js)
npx @miriad-systems/nuum
```

## Usage

### Embedded Mode (for host applications)

```bash
nuum --stdio              # NDJSON protocol over stdin/stdout
nuum --stdio --db ./my.db # With custom database
```

Send JSON messages to stdin, receive responses on stdout:

```json
→ {"type":"user","message":{"role":"user","content":"Hello"}}
← {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help?"}]},"session_id":"nuum_01JD..."}
← {"type":"result","subtype":"success","duration_ms":800,"session_id":"nuum_01JD..."}
```

### Interactive Mode

```bash
nuum                      # Start interactive session
nuum --db ./my-project.db # With specific database
```

### Batch Mode

```bash
nuum -p "What is 2+2?"
nuum -p "Read src/index.ts and explain what it does"
nuum -p "Refactor the auth module" --verbose
```

### CLI Reference

```
nuum                          Start interactive session
nuum --stdio                  Embedded mode (NDJSON protocol)
nuum -p "prompt"              Batch mode
nuum --help                   Show help

Options:
  -p, --prompt <text>   Run with a prompt (batch mode)
  -v, --verbose         Show memory state and debug output
      --stdio           NDJSON protocol mode for embedding
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show help message
```

## Configuration

Only `ANTHROPIC_API_KEY` is required:

```bash
# Required
ANTHROPIC_API_KEY=your-key-here

# Optional (defaults shown)
AGENT_MODEL_REASONING=claude-opus-4-5-20251101
AGENT_MODEL_WORKHORSE=claude-sonnet-4-5-20250929
AGENT_MODEL_FAST=claude-haiku-4-5-20251001
AGENT_DB=./agent.db
```

## How Memory Works

### Temporal Memory (Working Memory)
Every message is logged chronologically. As the conversation grows, older content is **distilled** — compressed to retain actionable intelligence: file paths, decisions and rationale, user preferences, specific values.

### Present State
Tracks the current mission, status, and task list. Updated by the agent as work progresses. Always visible in context.

### Long-Term Memory (LTM)
A hierarchical knowledge base that persists across sessions. Contains identity, behavioral guidelines, and accumulated knowledge. Background workers consolidate important information from conversations into LTM.

## Development

```bash
bun install          # Install dependencies
bun run dev          # Run in development
bun run typecheck    # Type check
bun test             # Run tests
bun run build        # Build for distribution
```

## Acknowledgments

### Letta (formerly MemGPT)

Memory architecture influenced by [Letta](https://github.com/letta-ai/letta):
- Core memory always in context
- Agent-editable memory
- Background memory workers

### OpenCode

Infrastructure adapted from [OpenCode](https://github.com/anthropics/opencode):
- Tool definition patterns
- Permission system
- Process management

## License

MIT
