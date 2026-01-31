/**
 * Research Agent
 *
 * A sub-agent that investigates topics and builds knowledge in LTM.
 * Called by the main agent via the `research` tool when it needs to
 * deeply understand something before acting.
 *
 * The research agent has access to:
 * - Full LTM management (search, read, create, update, archive)
 * - Web search and fetch
 * - Conversation history search
 * - File system read access (glob, read, grep)
 *
 * Unlike the LTM curator (which runs in background), the research agent
 * is on-demand and returns a report of what it learned.
 */

import type {Storage} from '../storage'
import {activity} from '../util/activity-log'
import {runSubAgent, type SubAgentResult} from '../sub-agent'
import {buildResearchTools, type ResearchToolResult} from './tools'

const MAX_RESEARCH_TURNS = 50

/**
 * Result of a research run.
 */
export interface ResearchResult {
  /** The research report */
  report: string
  /** LTM entries created during research */
  entriesCreated: string[]
  /** LTM entries updated during research */
  entriesUpdated: string[]
  /** Number of agent turns taken */
  turnsUsed: number
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Build the research task prompt.
 */
function buildResearchPrompt(topic: string): string {
  return `## Research Mode

I am now in **research mode**. My task is to investigate a topic and build knowledge in my LTM.

**Topic to research:**
${topic}

---

### My Approach

1. **Check existing knowledge** - What do I already know? (ltm_search, ltm_glob, ltm_read)
2. **Search conversation history** - Have we discussed this before? (search_messages, get_message)
3. **Research external sources** - What can I learn from the web? (web_search, web_fetch)
4. **Read relevant code** - If it's about our codebase, look at the source (glob, read, grep)
5. **Synthesize into LTM** - Create or update entries with what I learned (ltm_create, ltm_update)
6. **Return a report** - Summarize findings and what was added (finish_research)

### Guidelines

- **Don't duplicate** - Search before creating. Update existing entries if relevant.
- **Cross-link** - Use [[slug]] syntax to connect related entries.
- **Cite sources** - Note where information came from (URLs, file paths, conversation IDs).
- **Be thorough** - This is directed research, not a quick lookup. Take time to understand deeply.
- **Focus on actionable knowledge** - What will help me work more effectively?

### Tools Available

**LTM (full access):**
- \`ltm_glob(pattern)\` - Browse tree structure
- \`ltm_search(query)\` - Find entries by keyword
- \`ltm_read(slug)\` - Read full entry
- \`ltm_create(slug, parentSlug, title, body)\` - Create new entry
- \`ltm_update(slug, body, version)\` - Replace entry content
- \`ltm_edit(slug, old, new, version)\` - Surgical edit
- \`ltm_reparent(slug, newParentSlug, version)\` - Move entry
- \`ltm_archive(slug, version)\` - Remove outdated entry

**History:**
- \`search_messages(query)\` - Full-text search in conversation history
- \`get_message(id, contextBefore, contextAfter)\` - Get specific message with context

**Web:**
- \`web_search(query)\` - Search the web
- \`web_fetch(url, question)\` - Read a webpage and extract info

**Files:**
- \`glob(pattern)\` - Find files matching pattern
- \`read(filePath)\` - Read file contents
- \`grep(pattern)\` - Search file contents

**Control:**
- \`finish_research(report)\` - Complete research and return findings

---

When done, call \`finish_research\` with a report that includes:
1. Summary of what I learned
2. What LTM entries I created or updated (with [[slug]] references)
3. Key sources consulted

Be thorough! This is research, not a quick answer.
`
}

/**
 * Run the research agent to investigate a topic and build knowledge.
 */
export async function runResearch(
  storage: Storage,
  topic: string,
): Promise<ResearchResult> {
  activity.research?.start?.('Research', {topic: topic.slice(0, 50)})

  const result: ResearchResult = {
    report: '',
    entriesCreated: [],
    entriesUpdated: [],
    turnsUsed: 0,
    usage: {inputTokens: 0, outputTokens: 0},
  }

  // Build tools with result tracking
  const {tools, getLastResult} = buildResearchTools(storage)

  // Run sub-agent
  const subAgentResult: SubAgentResult<string | null> = await runSubAgent(
    storage,
    {
      name: 'research',
      taskPrompt: buildResearchPrompt(topic),
      tools,
      finishToolName: 'finish_research',
      extractResult: () => {
        // Report is captured via onToolResult
        return result.report || null
      },
      tier: 'workhorse',
      maxTurns: MAX_RESEARCH_TURNS,
      maxTokens: 8192,
      onToolResult: (toolCallId) => {
        const toolResult = getLastResult(toolCallId)
        if (!toolResult) return

        if (toolResult.entryCreated && toolResult.slug) {
          result.entriesCreated.push(toolResult.slug)
        }
        if (toolResult.entryUpdated && toolResult.slug) {
          result.entriesUpdated.push(toolResult.slug)
        }
        if (toolResult.report) {
          result.report = toolResult.report
        }
      },
    },
  )

  result.turnsUsed = subAgentResult.turnsUsed
  result.usage = subAgentResult.usage

  // If no report was set, the agent ended without calling finish_research
  if (!result.report) {
    result.report = 'Research ended without explicit report.'
  }

  activity.research?.complete?.(
    `${result.turnsUsed} turns, ${result.entriesCreated.length} created, ${result.entriesUpdated.length} updated`,
  )

  return result
}
