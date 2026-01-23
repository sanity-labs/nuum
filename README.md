# miriad-code

A long-term execution coding agent with active memory management.

## Overview

miriad-code is designed for extended coding sessions where context preservation matters. It manages three tiers of memory:

- **Temporal Memory** — Chronological log of all agent experience, recursively summarized to fit unbounded history into context
- **Present Memory** — Current mission, status, and task list for situational awareness
- **Long-Term Memory (LTM)** — Hierarchical knowledge base of retained information

## Status

**Phase 1** — Core loop with batch mode (`-p`) and verbose output.

## Usage

### Basic Execution

```bash
# Simple prompt
miriad-code -p "What is 2+2?"

# Execute shell commands
miriad-code -p "List all TypeScript files in the src directory"

# Read and analyze files
miriad-code -p "Read src/index.ts and explain what it does"
```

### Verbose Mode

```bash
# Show memory state, token budget, and execution trace
miriad-code -p "Refactor the auth module" --verbose
```

Verbose output shows:
- Memory state before/after (present, temporal, LTM)
- Token budget breakdown
- Execution trace with timestamps
- Cost estimate

### Persistent Memory (Multi-turn)

The agent remembers across invocations when using the same database:

```bash
# First invocation - store information
miriad-code -p "Remember: my favorite color is blue" --db=./session.db

# Second invocation - recall information
miriad-code -p "What is my favorite color?" --db=./session.db
# Agent will recall: "Your favorite color is blue"
```

### Output Formats

```bash
# Plain text output (default)
miriad-code -p "Summarize README.md"

# JSON output with events and usage stats
miriad-code -p "List todos" --format=json
```

### Database Path

```bash
# Default: ./agent.db
miriad-code -p "Hello"

# Custom path
miriad-code -p "Hello" --db=/path/to/my-agent.db

# In-memory (no persistence)
miriad-code -p "Hello" --db=:memory:
```

### CLI Reference

```
miriad-code -p "prompt"           Run agent with a prompt
miriad-code -p "prompt" --verbose Show debug output
miriad-code --help                Show help

Options:
  -p, --prompt <text>   The prompt to send (required)
  -v, --verbose         Show memory state, token usage, execution trace
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show help message
```

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev -- -p "test prompt"

# Type check
bun run typecheck

# Build
bun run build
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

## Acknowledgments

### Letta (formerly MemGPT)

The long-term memory philosophy is influenced by [Letta](https://github.com/letta-ai/letta), a framework for building agents with persistent memory. We drew from their conceptual foundation:

- **Core memory always in context** — identity and behavioral guidelines always present
- **Agent-editable memory** — agents can modify their own knowledge stores
- **Background memory workers** — the "sleeptime" pattern for async memory consolidation

Where we diverge: Letta's context compression uses single-level summarization that blocks conversation. Our recursive temporal summarization with true async background processing and ULID-anchored immutable summaries is a different approach designed for long-running coding agents.

### OpenCode

Infrastructure code (tool system, shell execution, permission system) is adapted from [OpenCode](https://github.com/anthropics/opencode). We built upon their foundations for:

- Tool definition patterns
- Permission system
- Process management
- AI SDK integration

## License

MIT
