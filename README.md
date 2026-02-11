# Nuum

An AI coding agent with **"infinite memory"** — continuous context across sessions.

*Nuum* — from "continuum" — maintains persistent memory across conversations, learning your codebase, preferences, and decisions over time.

📖 **[How We Solved the Agent Memory Problem](https://www.sanity.io/blog/how-we-solved-the-agent-memory-problem)** — the full technical deep-dive on why agents forget and how Nuum fixes it.

## Quick Start

```bash
export ANTHROPIC_API_KEY=your-key-here

# Install and run interactively
bunx @sanity-labs/nuum --repl

# Or with npx
npx @sanity-labs/nuum --repl
```

That's it. Start chatting. Your agent remembers everything.

### REPL Commands

```
/help     Show available commands
/inspect  Show memory statistics
/dump     Show full system prompt
/quit     Exit
```

### Other Modes

```bash
nuum -p "What files are in src/"     # Single prompt
nuum --mcp                            # Run as an MCP server
nuum --inspect                        # View memory stats
nuum --db ./project.db --repl         # Custom database
```

---

## ⚠️ Experimental Software

Nuum currently runs in **full autonomy mode** — no permission prompts, no confirmations. It was created for [Miriad](https://miriad.systems) as an embedded agent engine, typically running in containerized environments where the host platform manages security.

**Why we built this:** We were frustrated with how traditional coding agents seem to suffer some kind of contextual collapse after prolonged use — getting mixed up, repeating mistakes, losing track of decisions. Nuum explores how to keep agents effective indefinitely through selective, recursive memory compression and active knowledge management.

---

## MCP Servers

Nuum supports [Model Context Protocol](https://modelcontextprotocol.io/) servers for extended capabilities. Configure via environment variable:

```bash
export NUUM_MCP_SERVERS='{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
  },
  "github": {
    "command": "npx", 
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_TOKEN": "your-token" }
  }
}'
```

Or pass via protocol when embedding:

```json
{"type":"user","message":{...},"mcp_servers":{"name":{"command":"...","args":[...]}}}
```

MCP tools appear alongside built-in tools. The agent discovers and uses them automatically.

---

## MCP Server Mode

The `--mcp` flag starts nuum as an MCP server, allowing other tools (Claude Code, Codex, etc.) to interact with persistent nuum instances. Each instance gets its own SQLite database with full persistent memory.

Agent databases live in `.nuum/agents/<name>.db` relative to the working directory.

### Setup

```bash
# Add to Claude Code
claude mcp add nuum -- nuum --mcp

# Or from source during development
claude mcp add nuum -- bun run /path/to/nuum/dist/index.js --mcp
```

For other MCP clients:

```json
{
  "mcpServers": {
    "nuum": {
      "command": "nuum",
      "args": ["--mcp"]
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents with name, mission, status, and timestamps |
| `create_agent` | Create a new agent with optional system prompt |
| `send_message` | Send a message to an agent (with optional `create_if_missing`) |

Each agent is a persistent conversation — just call `send_message` with the same agent name to continue where you left off.

### Example

```
# Create a specialized agent
create_agent(name: "reviewer", system_prompt: "You are a code review specialist")

# Send it a prompt
send_message(agent: "reviewer", prompt: "Review this function for bugs: ...")

# Continue the conversation (agent remembers everything)
send_message(agent: "reviewer", prompt: "What about error handling?")

# Or create-on-first-use
send_message(agent: "helper", prompt: "Hello!", create_if_missing: true)
```

---

## Embedding in Applications

Nuum is designed to be **embedded**. While it runs standalone, its primary use case is integration into host applications, IDEs, and orchestration platforms.

```bash
nuum --stdio              # NDJSON protocol over stdin/stdout
nuum --stdio --db ./my.db # With custom database
```

**Key properties:**
- **Stateless process, stateful memory** — Process can restart anytime; all state lives in SQLite
- **Simple wire protocol** — JSON messages over stdin/stdout, easy to integrate from any language
- **Mid-turn injection** — Send corrections while the agent is working
- **Persistent identity** — One database = one agent with continuous memory

See **[docs/protocol.md](docs/protocol.md)** for the full wire protocol specification.

---

## Memory Architecture

Nuum has a three-tier memory system that mirrors human cognition.

**Key insight:** Agents perform best when context is **30-50% full** — informed but not overwhelmed. Nuum's memory system maintains this sweet spot automatically.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              WORKING MEMORY                                  │
│                         (Temporal Message Store)                             │
│                                                                              │
│  Recent messages live here in full detail. As context grows, older          │
│  content is recursively distilled — compressed while retaining what         │
│  matters for effective action.                                              │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ msg msg msg msg msg msg msg msg msg msg msg msg msg msg msg msg ... │    │
│  │  │   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │      │    │
│  │  └───┴───┴───┴───┘   └───┴───┴───┘   └───┴───┴───┘   │   │   │      │    │
│  │         │                   │               │         │   │   │      │    │
│  │    [distill-1]         [distill-2]    [distill-3]    │   │   │      │    │
│  │         │                   │               │         │   │   │      │    │
│  │         └───────────────────┴───────────────┘         │   │   │      │    │
│  │                             │                         │   │   │      │    │
│  │                      [distill-4]                      │   │   │      │    │
│  │                             │                         │   │   │      │    │
│  │                             └─────────────────────────┘   │   │      │    │
│  │                                         │                 │   │      │    │
│  │                                   [distill-5]        [recent msgs]   │    │
│  │                                                                      │    │
│  │  Older ◄──────────────────────────────────────────────────► Newer   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  The agent sees: [distill-5] + [recent messages]                            │
│  55x compression ratio achieved (1.3M tokens → 25k effective)               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              PRESENT STATE                                   │
│                                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────┐      │
│  │   Mission   │  │   Status    │  │            Tasks                │      │
│  │             │  │             │  │  ☑ Setup repository             │      │
│  │  "Build     │  │ "reviewing  │  │  ☑ Implement auth               │      │
│  │   auth      │  │  PR #42"    │  │  ☐ Write tests                  │      │
│  │   system"   │  │             │  │  ☐ Deploy to staging            │      │
│  └─────────────┘  └─────────────┘  └─────────────────────────────────┘      │
│                                                                              │
│  Agent-managed working state. Updated as work progresses.                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                            LONG-TERM MEMORY                                  │
│                          (Knowledge Base Tree)                               │
│                                                                              │
│  /identity ─────────────── "Who I am, my nature and relationships"          │
│  /behavior ─────────────── "How I should operate, user preferences"         │
│  /nuum                                                                │
│    ├── /cast-integration ─ "CAST/Miriad integration notes"                  │
│    ├── /memory                                                               │
│    │     └── /background-reports-system                                      │
│    ├── /anthropic-prompt-caching                                             │
│    └── /distillation-improvements-jan2026                                    │
│  /mcp                                                                        │
│    ├── /mcp-implementation                                                   │
│    └── /mcp-config-resolution                                                │
│                                                                              │
│  Hierarchical knowledge that persists forever. Background workers           │
│  extract important information from conversations and organize it here.     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Recursive Distillation

**No pause for compaction.** Unlike most coding agents that stop mid-conversation to "compact memory," Nuum's distillation runs concurrently while you work. You never wait for memory management — it happens invisibly in the background.

The distillation system is **not summarization** — it's operational intelligence extraction:

**RETAIN** (actionable intelligence):
- File paths and what they contain
- Decisions made and WHY (rationale matters)
- User preferences and corrections
- Specific values: URLs, configs, commands
- Errors and how they were resolved

**EXCISE** (noise):
- Back-and-forth debugging that led nowhere
- Missteps and corrections (keep only final approach)
- Verbose tool outputs
- Narrative filler ("Let me check...")
- Casual chatter and acknowledgments

Distillations are recursive — older distillations get distilled again, creating a fractal compression where ancient history becomes highly compressed while recent work stays detailed.

### Long-Term Memory Curation

A background worker (the **LTM Curator**) runs continuously in the background:

1. **CAPTURES** important information into knowledge entries
2. **STRENGTHENS** entries by researching and adding context  
3. **CURATES** the knowledge tree structure

The curator has access to web search, file reading, and the full knowledge base. It works autonomously — you never see it running, but the agent's knowledge grows over time. Reports are filed silently and surfaced to the main agent on the next interaction.

### Reflection

When the agent needs to recall something specific — a file path, a decision, a value from weeks ago — it uses the **reflect** tool:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              REFLECTION                                      │
│                                                                              │
│   Main Agent                         Reflection Sub-Agent                    │
│       │                                      │                               │
│       │  "What was the auth bug fix?"        │                               │
│       │ ────────────────────────────────────►│                               │
│       │                                      │                               │
│       │                          ┌───────────┴───────────┐                   │
│       │                          │  Search FTS index     │                   │
│       │                          │  Search LTM entries   │                   │
│       │                          │  Read relevant docs   │                   │
│       │                          │  Synthesize answer    │                   │
│       │                          └───────────┬───────────┘                   │
│       │                                      │                               │
│       │  "The auth bug was in session.ts,    │                               │
│       │   line 42. Fixed by adding null      │                               │
│       │   check. Committed in abc123."       │                               │
│       │ ◄────────────────────────────────────│                               │
│       │                                      │                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

Reflection searches the full conversation history (via FTS5 full-text search) and the knowledge base, then synthesizes an answer. It's like the agent asking its own memory system a question.

---

## Configuration

```bash
# Required
ANTHROPIC_API_KEY=your-key-here

# Optional (defaults shown)
AGENT_MODEL_REASONING=claude-opus-4-5-20251101
AGENT_MODEL_WORKHORSE=claude-sonnet-4-5-20250929
AGENT_MODEL_FAST=claude-haiku-4-5-20251001
AGENT_DB=./agent.db
```

---

## Development

```bash
bun install          # Install dependencies
bun run dev          # Run in development
bun run typecheck    # Type check
bun test             # Run tests
bun run build        # Build for distribution
```

---

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

---

## License

MIT

---

<p align="center">
  Nuum is part of <a href="https://miriad.systems">Miriad</a>, experimental software from <a href="https://sanity.io">Sanity.io</a>
</p>
