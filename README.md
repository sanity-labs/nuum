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

```bash
# Basic usage
miriad-code -p "What files are in src/"

# With verbose debugging output
miriad-code -p "Refactor the auth module" --verbose

# Specify database path
miriad-code -p "Hello" --db=./my-agent.db
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

Phase 1 uses environment variables:

```bash
AGENT_PROVIDER=anthropic
AGENT_MODEL_REASONING=claude-opus-4-5-20251101
AGENT_MODEL_WORKHORSE=claude-sonnet-4-5-20250929
AGENT_MODEL_FAST=claude-haiku-4-5-20251001
AGENT_DB=./agent.db
ANTHROPIC_API_KEY=your-key-here
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
