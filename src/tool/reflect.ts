/**
 * Reflect tool - searches agent's own memory to answer questions.
 *
 * This tool spawns a sub-agent that has access to:
 * - Full-text search on conversation history
 * - Message retrieval with context
 * - LTM search and read
 *
 * Use this when you need to:
 * - Recall specifics that might be hidden by distillation
 * - Find decisions or rationale from past conversations
 * - Search for specific file paths, values, or patterns discussed
 * - Research your own knowledge base
 */

import { z } from "zod"
import { Tool } from "./tool"
import type { Storage } from "../storage"
import { runReflection } from "../reflection"

export interface ReflectMetadata {
  question: string
  turnsUsed: number
  inputTokens: number
  outputTokens: number
}

const DESCRIPTION = `Search your own memory to answer a question or research a topic.

This spawns a research sub-agent that can:
- Search conversation history with full-text search
- Retrieve specific messages with surrounding context
- Search and read your long-term knowledge base

Use this when you need to:
- Recall specifics that might be compressed in distillations
- Find past decisions and their rationale
- Search for file paths, values, or patterns discussed before
- Research what you know about a topic

The sub-agent will search, read, and synthesize an answer for you.`

const parameters = z.object({
  question: z.string().describe(
    "The question to answer or research task to complete. Be specific about what you're looking for."
  ),
})

export const ReflectTool = Tool.define<typeof parameters, ReflectMetadata>(
  "reflect",
  {
    description: DESCRIPTION,
    parameters,
    async execute({ question }, ctx) {
      // Get storage from context extra
      const storage = (ctx as Tool.Context & { extra: { storage: Storage } }).extra?.storage
      
      if (!storage) {
        return {
          output: "Error: Storage not available for reflection",
          title: "Reflection failed",
          metadata: {
            question,
            turnsUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        }
      }

      try {
        const result = await runReflection(storage, question)

        return {
          output: result.answer,
          title: `Reflected on: ${question.slice(0, 40)}${question.length > 40 ? "..." : ""}`,
          metadata: {
            question,
            turnsUsed: result.turnsUsed,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return {
          output: `Reflection failed: ${errorMsg}`,
          title: "Reflection error",
          metadata: {
            question,
            turnsUsed: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        }
      }
    },
  },
)

/**
 * Context type for reflect tool - needs storage access.
 */
export interface ReflectToolContext {
  storage: Storage
}
