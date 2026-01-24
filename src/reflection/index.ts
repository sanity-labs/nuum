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

import { tool } from "ai"
import type { CoreMessage, CoreTool } from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import { Provider } from "../provider"
import { Log } from "../util/log"
import { activity } from "../util/activity-log"
import { buildAgentContext } from "../context"
import { runAgentLoop, stopOnTool } from "../agent/loop"
import {
  Tool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  type LTMToolContext,
} from "../tool"

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
 * Build tools for the reflection agent.
 */
function buildReflectionTools(storage: Storage): {
  tools: Record<string, CoreTool>
  getAnswer: () => string | null
} {
  let answer: string | null = null

  // Create LTM context for tool execution
  const createLTMContext = (toolCallId: string): Tool.Context & { extra: LTMToolContext } => {
    const ctx = Tool.createContext({
      sessionID: "reflection",
      messageID: "reflection",
      callID: toolCallId,
    })
    ;(ctx as Tool.Context & { extra: LTMToolContext }).extra = {
      ltm: storage.ltm,
      agentType: "main", // Reflection reads but doesn't write
    }
    return ctx as Tool.Context & { extra: LTMToolContext }
  }

  const tools: Record<string, CoreTool> = {
    // Search messages using FTS
    search_messages: tool({
      description: "Search conversation history using full-text search. Returns message snippets with matches highlighted as >>>match<<<.",
      parameters: z.object({
        query: z.string().describe("Search query - keywords to find in messages"),
        limit: z.number().optional().describe("Maximum results to return (default: 20)"),
      }),
      execute: async ({ query, limit }) => {
        activity.reflection.toolCall("search_messages", { query, limit })
        const results = await storage.temporal.searchFTS(query, limit ?? 20)
        
        if (results.length === 0) {
          activity.reflection.toolResult("search_messages", "0 matches")
          return `No messages found matching "${query}"`
        }

        const formatted = results.map(r => 
          `[${r.id}] (${r.type}) ${r.snippet}`
        ).join("\n\n")

        activity.reflection.toolResult("search_messages", `${results.length} matches`)
        return `Found ${results.length} messages:\n\n${formatted}`
      },
    }),

    // Get message with context
    get_message: tool({
      description: "Get a specific message by ID, optionally with surrounding context messages.",
      parameters: z.object({
        id: z.string().describe("Message ID (e.g., msg_01ABC...)"),
        contextBefore: z.number().optional().describe("Number of messages to include before (default: 0)"),
        contextAfter: z.number().optional().describe("Number of messages to include after (default: 0)"),
      }),
      execute: async ({ id, contextBefore, contextAfter }) => {
        activity.reflection.toolCall("get_message", { id, contextBefore, contextAfter })
        const messages = await storage.temporal.getMessageWithContext({
          id,
          contextBefore: contextBefore ?? 0,
          contextAfter: contextAfter ?? 0,
        })

        if (messages.length === 0) {
          activity.reflection.toolResult("get_message", "not found")
          return `Message not found: ${id}`
        }

        const formatted = messages.map(m => {
          const marker = m.id === id ? ">>> " : "    "
          return `${marker}[${m.id}] (${m.type})\n${marker}${m.content}`
        }).join("\n\n")

        activity.reflection.toolResult("get_message", `${messages.length} messages`)
        return formatted
      },
    }),

    // LTM tools (reuse existing definitions)
    ltm_search: tool({
      description: LTMSearchTool.definition.description,
      parameters: LTMSearchTool.definition.parameters,
      execute: async (args, { toolCallId }) => {
        activity.reflection.toolCall("ltm_search", args)
        const toolResult = await LTMSearchTool.definition.execute(args, createLTMContext(toolCallId))
        const matchCount = (toolResult.output.match(/^- \*\*/gm) || []).length
        activity.reflection.toolResult("ltm_search", `${matchCount} entries`)
        return toolResult.output
      },
    }),

    ltm_read: tool({
      description: LTMReadTool.definition.description,
      parameters: LTMReadTool.definition.parameters,
      execute: async (args, { toolCallId }) => {
        activity.reflection.toolCall("ltm_read", args)
        const toolResult = await LTMReadTool.definition.execute(args, createLTMContext(toolCallId))
        activity.reflection.toolResult("ltm_read", toolResult.output.slice(0, 50))
        return toolResult.output
      },
    }),

    ltm_glob: tool({
      description: LTMGlobTool.definition.description,
      parameters: LTMGlobTool.definition.parameters,
      execute: async (args, { toolCallId }) => {
        activity.reflection.toolCall("ltm_glob", args)
        const toolResult = await LTMGlobTool.definition.execute(args, createLTMContext(toolCallId))
        const lineCount = toolResult.output.split("\n").length
        activity.reflection.toolResult("ltm_glob", `${lineCount} entries`)
        return toolResult.output
      },
    }),

    // Finish reflection
    finish_reflection: tool({
      description: "Complete the reflection and return your answer to the main agent.",
      parameters: z.object({
        answer: z.string().describe("Your answer or research findings. Be specific and include relevant details, quotes, or references."),
      }),
      execute: async ({ answer: ans }) => {
        activity.reflection.toolResult("finish_reflection", `${ans.length} chars`)
        answer = ans
        return "Reflection complete."
      },
    }),
  }

  return {
    tools,
    getAnswer: () => answer,
  }
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
  const { tools, getAnswer } = buildReflectionTools(storage)

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
