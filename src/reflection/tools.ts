/**
 * Reflection tools for the reflection agent.
 *
 * These tools are used by the reflection sub-agent to search conversation
 * history and long-term memory when answering questions about past events.
 *
 * - search_messages, get_message: Temporal FTS tools
 * - ltm_search, ltm_read, ltm_glob: Reused from ltm tools
 * - finish_reflection: Loop terminator
 */

import { tool } from "ai"
import type { CoreTool } from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import { activity } from "../util/activity-log"
import {
  Tool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  type LTMToolContext,
} from "../tool"

/**
 * Context needed to build reflection tools.
 */
export interface ReflectionToolContext {
  storage: Storage
}

/**
 * Build the search_messages tool.
 *
 * Full-text search on conversation history using FTS5.
 */
function buildSearchMessagesTool(ctx: ReflectionToolContext): CoreTool {
  const { storage } = ctx

  return tool({
    description:
      "Search conversation history using full-text search. Returns message snippets with matches highlighted as >>>match<<<.",
    parameters: z.object({
      query: z.string().describe("Search query - keywords to find in messages"),
      limit: z
        .number()
        .optional()
        .describe("Maximum results to return (default: 20)"),
    }),
    execute: async ({ query, limit }) => {
      activity.reflection.toolCall("search_messages", { query, limit })
      const results = await storage.temporal.searchFTS(query, limit ?? 20)

      if (results.length === 0) {
        activity.reflection.toolResult("search_messages", "0 matches")
        return `No messages found matching "${query}"`
      }

      const formatted = results
        .map((r) => `[${r.id}] (${r.type}) ${r.snippet}`)
        .join("\n\n")

      activity.reflection.toolResult("search_messages", `${results.length} matches`)
      return `Found ${results.length} messages:\n\n${formatted}`
    },
  })
}

/**
 * Build the get_message tool.
 *
 * Retrieves a specific message by ID with optional surrounding context.
 */
function buildGetMessageTool(ctx: ReflectionToolContext): CoreTool {
  const { storage } = ctx

  return tool({
    description:
      "Get a specific message by ID, optionally with surrounding context messages.",
    parameters: z.object({
      id: z.string().describe("Message ID (e.g., msg_01ABC...)"),
      contextBefore: z
        .number()
        .optional()
        .describe("Number of messages to include before (default: 0)"),
      contextAfter: z
        .number()
        .optional()
        .describe("Number of messages to include after (default: 0)"),
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

      const formatted = messages
        .map((m) => {
          const marker = m.id === id ? ">>> " : "    "
          return `${marker}[${m.id}] (${m.type})\n${marker}${m.content}`
        })
        .join("\n\n")

      activity.reflection.toolResult("get_message", `${messages.length} messages`)
      return formatted
    },
  })
}

/**
 * Create LTM context for tool execution.
 */
function createLTMContext(
  storage: Storage,
  toolCallId: string,
): Tool.Context & { extra: LTMToolContext } {
  const baseCtx = Tool.createContext({
    sessionID: "reflection",
    messageID: "reflection",
    callID: toolCallId,
  })
  ;(baseCtx as Tool.Context & { extra: LTMToolContext }).extra = {
    ltm: storage.ltm,
    agentType: "main", // Reflection reads but doesn't write
  }
  return baseCtx as Tool.Context & { extra: LTMToolContext }
}

/**
 * Wrap an LTM tool with activity logging.
 */
function wrapLTMTool(
  ltmTool: typeof LTMSearchTool | typeof LTMReadTool | typeof LTMGlobTool,
  toolName: string,
  storage: Storage,
  summarizeResult: (output: string) => string,
): CoreTool {
  return tool({
    description: ltmTool.definition.description,
    parameters: ltmTool.definition.parameters,
    execute: async (args, { toolCallId }) => {
      activity.reflection.toolCall(toolName, args)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResult = await ltmTool.definition.execute(
        args as any,
        createLTMContext(storage, toolCallId),
      )
      activity.reflection.toolResult(toolName, summarizeResult(toolResult.output))
      return toolResult.output
    },
  })
}

/**
 * Build all reflection tools.
 *
 * Returns the tools and a function to get the answer.
 */
export function buildReflectionTools(ctx: ReflectionToolContext): {
  tools: Record<string, CoreTool>
  getAnswer: () => string | null
} {
  let answer: string | null = null

  const tools: Record<string, CoreTool> = {
    // Temporal FTS tools
    search_messages: buildSearchMessagesTool(ctx),
    get_message: buildGetMessageTool(ctx),

    // LTM tools (reused with activity logging)
    ltm_search: wrapLTMTool(
      LTMSearchTool,
      "ltm_search",
      ctx.storage,
      (output) => `${(output.match(/^- \*\*/gm) || []).length} entries`,
    ),
    ltm_read: wrapLTMTool(
      LTMReadTool,
      "ltm_read",
      ctx.storage,
      (output) => output.slice(0, 50),
    ),
    ltm_glob: wrapLTMTool(
      LTMGlobTool,
      "ltm_glob",
      ctx.storage,
      (output) => `${output.split("\n").length} entries`,
    ),

    // Loop terminator
    finish_reflection: tool({
      description:
        "Complete the reflection and return your answer to the main agent.",
      parameters: z.object({
        answer: z
          .string()
          .describe(
            "Your answer or research findings. Be specific and include relevant details, quotes, or references.",
          ),
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
