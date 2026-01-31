/**
 * Research Agent Tools
 *
 * Tools for the research sub-agent. Combines:
 * - Full LTM management (create, update, archive)
 * - Web research (search, fetch)
 * - History search (FTS on temporal messages)
 * - File system read access (glob, read, grep)
 */

import {tool} from 'ai'
import type {CoreTool} from 'ai'
import {z} from 'zod'
import type {Storage} from '../storage'
import type {AgentType} from '../storage/ltm'
import {activity} from '../util/activity-log'
import {
  Tool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  LTMCreateTool,
  LTMUpdateTool,
  LTMEditTool,
  LTMReparentTool,
  LTMArchiveTool,
  WebSearchTool,
  WebFetchTool,
  ReadTool,
  GlobTool,
  GrepTool,
  type LTMToolContext,
} from '../tool'

const AGENT_TYPE: AgentType = 'research'

/**
 * Result of a research tool execution.
 */
export interface ResearchToolResult {
  output: string
  done: boolean
  entryCreated?: boolean
  entryUpdated?: boolean
  entryArchived?: boolean
  slug?: string
  title?: string
  report?: string
}

/**
 * Build tools for the research agent.
 */
export function buildResearchTools(storage: Storage): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => ResearchToolResult | undefined
} {
  const results = new Map<string, ResearchToolResult>()

  // Create LTM context for tool execution
  const createLTMContext = (
    toolCallId: string,
  ): Tool.Context & {extra: LTMToolContext} => {
    const ctx = Tool.createContext({
      sessionID: 'research',
      messageID: 'research',
      callID: toolCallId,
    })
    ;(ctx as Tool.Context & {extra: LTMToolContext}).extra = {
      ltm: storage.ltm,
      agentType: AGENT_TYPE,
    }
    return ctx as Tool.Context & {extra: LTMToolContext}
  }

  // Create base context for non-LTM tools
  const createBaseContext = (toolCallId: string): Tool.Context => {
    return Tool.createContext({
      sessionID: 'research',
      messageID: 'research',
      callID: toolCallId,
    })
  }

  const tools: Record<string, CoreTool> = {}

  // === LTM Tools ===

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMGlobTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMSearchTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMReadTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMCreateTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryCreated = toolResult.output.startsWith('Created entry:')
      results.set(toolCallId, {
        output: toolResult.output,
        done: false,
        entryCreated,
        slug: args.slug,
        title: args.title,
      })
      return toolResult.output
    },
  })

  tools.ltm_update = tool({
    description: LTMUpdateTool.definition.description,
    parameters: LTMUpdateTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMUpdateTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryUpdated = toolResult.output.startsWith('Updated entry:')
      results.set(toolCallId, {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      })
      return toolResult.output
    },
  })

  tools.ltm_edit = tool({
    description: LTMEditTool.definition.description,
    parameters: LTMEditTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMEditTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryUpdated = toolResult.output.startsWith('Edited entry:')
      results.set(toolCallId, {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      })
      return toolResult.output
    },
  })

  tools.ltm_reparent = tool({
    description: LTMReparentTool.definition.description,
    parameters: LTMReparentTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMReparentTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryUpdated = toolResult.output.startsWith('Moved entry:')
      results.set(toolCallId, {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      })
      return toolResult.output
    },
  })

  tools.ltm_archive = tool({
    description: LTMArchiveTool.definition.description,
    parameters: LTMArchiveTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMArchiveTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryArchived = toolResult.output.startsWith('Archived entry:')
      results.set(toolCallId, {
        output: toolResult.output,
        done: false,
        entryArchived,
        slug: args.slug,
      })
      return toolResult.output
    },
  })

  // === History Search Tools ===

  tools.search_messages = tool({
    description:
      'Search conversation history using full-text search. Returns message snippets with matches highlighted.',
    parameters: z.object({
      query: z.string().describe('Search query - keywords to find in messages'),
      limit: z
        .number()
        .optional()
        .describe('Maximum results to return (default: 20)'),
    }),
    execute: async ({query, limit}, {toolCallId}) => {
      const searchResults = await storage.temporal.searchFTS(query, limit ?? 20)

      if (searchResults.length === 0) {
        const output = `No messages found matching "${query}"`
        results.set(toolCallId, {output, done: false})
        return output
      }

      const formatted = searchResults
        .map((r) => `[${r.id}] (${r.type}) ${r.snippet}`)
        .join('\n\n')

      const output = `Found ${searchResults.length} messages:\n\n${formatted}`
      results.set(toolCallId, {output, done: false})
      return output
    },
  })

  tools.get_message = tool({
    description:
      'Get a specific message by ID, optionally with surrounding context messages.',
    parameters: z.object({
      id: z.string().describe('Message ID (e.g., msg_01ABC...)'),
      contextBefore: z
        .number()
        .optional()
        .describe('Number of messages to include before (default: 0)'),
      contextAfter: z
        .number()
        .optional()
        .describe('Number of messages to include after (default: 0)'),
    }),
    execute: async ({id, contextBefore, contextAfter}, {toolCallId}) => {
      const messages = await storage.temporal.getMessageWithContext({
        id,
        contextBefore: contextBefore ?? 0,
        contextAfter: contextAfter ?? 0,
      })

      if (messages.length === 0) {
        const output = `Message not found: ${id}`
        results.set(toolCallId, {output, done: false})
        return output
      }

      const formatted = messages
        .map((m) => {
          const marker = m.id === id ? '>>> ' : '    '
          return `${marker}[${m.id}] (${m.type})\n${marker}${m.content}`
        })
        .join('\n\n')

      results.set(toolCallId, {output: formatted, done: false})
      return formatted
    },
  })

  // === Web Tools ===

  tools.web_search = tool({
    description: WebSearchTool.definition.description,
    parameters: WebSearchTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await WebSearchTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.web_fetch = tool({
    description: WebFetchTool.definition.description,
    parameters: WebFetchTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await WebFetchTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  // === File System Tools ===

  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await GlobTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await ReadTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await GrepTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      results.set(toolCallId, {output: toolResult.output, done: false})
      return toolResult.output
    },
  })

  // === Finish Tool ===

  tools.finish_research = tool({
    description:
      'Complete the research and return your findings to the main agent.',
    parameters: z.object({
      report: z
        .string()
        .describe(
          'Your research report. Include: 1) Summary of what you learned, 2) LTM entries created/updated with [[slug]] references, 3) Key sources consulted.',
        ),
    }),
    execute: async ({report}, {toolCallId}) => {
      results.set(toolCallId, {
        output: 'Research complete.',
        done: true,
        report,
      })
      return 'Research complete.'
    },
  })

  return {
    tools,
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}
