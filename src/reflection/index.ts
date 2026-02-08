/**
 * Reflection Agent
 *
 * A sub-agent that researches the agent's own memory to answer questions.
 * Called by the main agent via the `reflect` tool when it needs to recall
 * specifics that might be hidden by distillation or buried in history.
 *
 * The reflection agent has access to:
 * - Full-text search on temporal messages (with snippets)
 * - Message retrieval with context
 * - LTM search and read
 *
 * It inherits the same system prompt as the main agent (for context)
 * but has different tools focused on memory research.
 */

import type {Storage} from '../storage'
import {activity} from '../util/activity-log'
import {runSubAgent, type SubAgentResult} from '../sub-agent'
import {buildReflectionTools} from './tools'

/**
 * Result of a reflection.
 */
export interface ReflectionResult {
  /** The answer/report from the reflection agent */
  answer: string
  /** Number of agent turns taken */
  turnsUsed: number
  /** Token usage */
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Build the reflection task prompt.
 */
function buildReflectionPrompt(question: string): string {
  return `## Reflection Mode

I am now in **reflection mode**. My task is to search my own memory to answer a question.

In this mode, I have different tools than usual. I can ONLY use these memory research tools:
- **search_messages** - Full-text search in conversation history
- **get_message** - Get a specific message with context
- **ltm_search** - Search long-term memory
- **ltm_read** - Read an LTM entry
- **ltm_glob** - Browse LTM structure
- **finish_reflection** - Return my answer

I cannot use file tools, web tools, or any other tools in this mode.

---

**Question to answer:**
${question}

---

I'll search my memory now. Once I have enough information, I MUST call finish_reflection with my answer - that's how I return results to the main agent.
`
}

/**
 * Run the reflection agent to research memory and answer a question.
 */
export async function runReflection(
  storage: Storage,
  question: string,
): Promise<ReflectionResult> {
  activity.reflection.start('Memory research', {
    question: question.slice(0, 50),
  })

  // Build tools
  const {tools, getAnswer} = buildReflectionTools({storage})

  // Run sub-agent
  const result: SubAgentResult<string | null> = await runSubAgent(storage, {
    name: 'reflection',
    taskPrompt: buildReflectionPrompt(question),
    tools,
    finishToolName: 'finish_reflection',
    extractResult: getAnswer,
    tier: 'workhorse',
    maxTurns: 20,
    // maxTokens: omitted — auto-detected from model
  })

  const answer = result.result ?? 'Unable to find relevant information.'

  activity.reflection.complete(
    `${result.turnsUsed} turns, ${answer.length} chars`,
  )

  return {
    answer,
    turnsUsed: result.turnsUsed,
    usage: result.usage,
  }
}
