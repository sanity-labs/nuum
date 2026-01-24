# Nuum

An AI coding agent with continuous memory — infinite context across sessions.

*Nuum* — from "continuum" — maintains persistent memory across conversations, learning your codebase, preferences, and decisions over time.

## Installation

```bash
# Using bunx (recommended - runs in Bun, fast)
bunx @miriad-systems/nuum

# Using npx (runs in Node.js)
npx @miriad-systems/nuum
```

## Overview

Nuum is designed for extended coding sessions where context preservation matters. It manages three tiers of memory:

- **Temporal Memory** — Chronological log of all agent experience, distilled over time to retain actionable intelligence
- **Present Memory** — Current mission, status, and task list for situational awareness
- **Long-Term Memory (LTM)** — Hierarchical knowledge base of durable facts and preferences

## Usage

### Interactive Mode

```bash
# Start interactive session
nuum

# With a specific database
nuum --db ./my-project.db
```

### Batch Mode

```bash
# Simple prompt
nuum -p "What is 2+2?"

# Execute shell commands
nuum -p "List all TypeScript files in the src directory"

# Read and analyze files
nuum -p "Read src/index.ts and explain what it does"
```

### Verbose Mode

```bash
# Show memory state, token budget, and execution trace
nuum -p "Refactor the auth module" --verbose
```

### Persistent Memory

The agent remembers across invocations when using the same database:

```bash
# First invocation - store information
nuum -p "Remember: my favorite color is blue" --db=./session.db

# Second invocation - recall information  
nuum -p "What is my favorite color?" --db=./session.db
# Agent will recall: "Your favorite color is blue"
```

### CLI Reference

```
nuum                          Start interactive session
nuum -p "prompt"              Run with a prompt (batch mode)
nuum -p "prompt" --verbose    Show debug output
nuum --help                   Show help

Options:
  -p, --prompt <text>   The prompt to send
  -v, --verbose         Show memory state, token usage, execution trace
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show help message
```

## Configuration

Only `ANTHROPIC_API_KEY` is required. All other settings have sensible defaults:

```bash
# Required
ANTHROPIC_API_KEY=your-key-here

# Optional (defaults shown)
AGENT_PROVIDER=anthropic
AGENT_MODEL_REASONING=claude-opus-4-5-20251101
AGENT_MODEL_WORKHORSE=claude-sonnet-4-5-20250929
AGENT_MODEL_FAST=claude-haiku-4-5-20251001
AGENT_DB=./agent.db
```

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Type check
bun run typecheck

# Run tests
bun test

# Build
bun run build
```

## How Memory Works

### Temporal Memory (Working Memory)
Every message is logged chronologically. As the conversation grows, older content is **distilled** — not summarized narratively, but compressed to retain actionable intelligence: file paths, decisions and their rationale, user preferences, specific values.

### Present State
Tracks the current mission, status, and task list. Updated by the agent as work progresses. Always visible in context for situational awareness.

### Long-Term Memory
A hierarchical knowledge base that persists across sessions. The agent can read, search, and (via background workers) write to LTM. Contains identity, behavioral guidelines, and accumulated knowledge.

## Acknowledgments

### Letta (formerly MemGPT)

The memory architecture is influenced by [Letta](https://github.com/letta-ai/letta):

- **Core memory always in context** — identity and behavioral guidelines always present
- **Agent-editable memory** — agents can modify their own knowledge stores
- **Background memory workers** — async memory consolidation

### OpenCode

Infrastructure adapted from [OpenCode](https://github.com/anthropics/opencode):

- Tool definition patterns
- Permission system
- Process management
- AI SDK integration

## License

MIT
