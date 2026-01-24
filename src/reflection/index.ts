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

import type { CoreMessage } from "ai"
import type { Storage } from "../storage"
import { Provider } from "../provider"
import { Log } from "../util/log"
import { activity } from "../util/activity-log"
import { buildAgentContext } from "../context"
import { runAgentLoop, stopOnTool } from "../agent/loop"
import { buildReflectionSearchTools } from "../tool/reflection-search"

const log = Log.create({ service: "reflection-agent" })

const MAX_REFLECTION_TURNS = 20

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
  activity.reflection.start("Memory research", { question: question.slice(0, 50) })

  // Build agent context (same as main agent for cache efficiency)
  const ctx = await buildAgentContext(storage)

  // Get model (workhorse tier for handling lots of context)
  const model = Provider.getModelForTier("workhorse")

  // Build tools
  const { tools, getAnswer } = buildReflectionSearchTools({ storage })

  // Build the reflection task prompt
  const taskPrompt = buildReflectionPrompt(question)

  // Initial messages: conversation history + reflection task
  const initialMessages: CoreMessage[] = [
    ...ctx.historyTurns,
    { role: "user", content: `[SYSTEM TASK]\n\n${taskPrompt}` },
  ]

  // Run the agent loop
  const loopResult = await runAgentLoop({
    model,
    systemPrompt: ctx.systemPrompt,
    initialMessages,
    tools,
    maxTokens: 4096,
    temperature: 0,
    maxTurns: MAX_REFLECTION_TURNS,
    isDone: stopOnTool("finish_reflection"),
  })

  const answer = getAnswer()

  if (!answer) {
    // Agent didn't call finish_reflection - use final text as fallback
    log.warn("reflection agent did not call finish_reflection", {
      turnsUsed: loopResult.turnsUsed,
    })
  }

  const result: ReflectionResult = {
    answer: answer ?? loopResult.finalText ?? "Unable to find relevant information.",
    turnsUsed: loopResult.turnsUsed,
    usage: loopResult.usage,
  }

  activity.reflection.complete(`${result.turnsUsed} turns, ${result.answer.length} chars`)

  return result
}
