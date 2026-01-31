/**
 * LTM Curator Tools
 *
 * Tools for the LTM knowledge curator agent.
 * Includes LTM management, file system research, and web research tools.
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
  LTMRenameTool,
  LTMArchiveTool,
  WebSearchTool,
  WebFetchTool,
  ReadTool,
  GlobTool,
  GrepTool,
  type LTMToolContext,
} from '../tool'

const AGENT_TYPE: AgentType = 'ltm-consolidate'

/**
 * Result of a consolidation tool execution.
 */
export interface ConsolidationToolResult {
  output: string
  done: boolean
  entryCreated?: boolean
  entryUpdated?: boolean
  entryArchived?: boolean
  slug?: string
  title?: string
  summary?: string
}

/**
 * Build tools for the consolidation agent with execute callbacks.
 * Uses shared tool definitions from src/tool/ltm.ts.
 */
export function buildConsolidationTools(storage: Storage): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => ConsolidationToolResult | undefined
} {
  // Track results by toolCallId for the agent loop to access
  const results = new Map<string, ConsolidationToolResult>()

  // Create LTM context for tool execution
  const createLTMContext = (
    toolCallId: string,
  ): Tool.Context & {extra: LTMToolContext} => {
    const ctx = Tool.createContext({
      sessionID: 'consolidation',
      messageID: 'consolidation',
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
      sessionID: 'consolidation',
      messageID: 'consolidation',
      callID: toolCallId,
    })
  }

  const tools: Record<string, CoreTool> = {}

  // LTM read-only tools (shared definitions)
  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMReadTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMGlobTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
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
      const matchCount = (toolResult.output.match(/^- \*\*/gm) || []).length
      activity.ltmCurator.searchResult('ltm_search', matchCount, args.query)
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // LTM write tools (shared definitions)
  tools.ltm_create = tool({
    description: LTMCreateTool.definition.description,
    parameters: LTMCreateTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMCreateTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryCreated = toolResult.output.startsWith('Created entry:')
      if (entryCreated) {
        activity.ltmCurator.ltmOperation('create', args.slug, args.title)
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryCreated,
        slug: args.slug,
        title: args.title,
      }
      results.set(toolCallId, result)
      return result.output
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
      if (entryUpdated) {
        activity.ltmCurator.ltmOperation('update', args.slug)
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      }
      results.set(toolCallId, result)
      return result.output
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
      if (entryUpdated) {
        activity.ltmCurator.ltmOperation('update', args.slug, 'surgical edit')
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      }
      results.set(toolCallId, result)
      return result.output
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
      if (entryUpdated) {
        activity.ltmCurator.ltmOperation(
          'reparent',
          args.slug,
          `→ ${args.newParentSlug ?? 'root'}`,
        )
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.ltm_rename = tool({
    description: LTMRenameTool.definition.description,
    parameters: LTMRenameTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await LTMRenameTool.definition.execute(
        args,
        createLTMContext(toolCallId),
      )
      const entryUpdated = toolResult.output.startsWith('Renamed entry:')
      if (entryUpdated) {
        activity.ltmCurator.ltmOperation(
          'rename',
          args.slug,
          `→ ${args.newSlug}`,
        )
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryUpdated,
        slug: args.slug,
      }
      results.set(toolCallId, result)
      return result.output
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
      if (entryArchived) {
        activity.ltmCurator.ltmOperation('archive', args.slug)
      }
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
        entryArchived,
        slug: args.slug,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // File system tools for codebase research
  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await ReadTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await GlobTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
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
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // Web tools for external research
  tools.web_search = tool({
    description: WebSearchTool.definition.description,
    parameters: WebSearchTool.definition.parameters,
    execute: async (args, {toolCallId}) => {
      const toolResult = await WebSearchTool.definition.execute(
        args,
        createBaseContext(toolCallId),
      )
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
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
      const result: ConsolidationToolResult = {
        output: toolResult.output,
        done: false,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  // finish_consolidation - Signal completion (consolidation-specific)
  tools.finish_consolidation = tool({
    description:
      'Call this when you have finished curating the knowledge base. Write a contextual summary for your future self.',
    parameters: z.object({
      summary: z
        .string()
        .describe(
          "A note to your future self: what did you capture and why does it matter? Reference entries with [[slug]] syntax. Example: 'Captured the bloom filter insights in [[bloom-filter-overview]]. Archived X system workarounds since it's decommissioned.'",
        ),
    }),
    execute: async ({summary}, {toolCallId}) => {
      const result: ConsolidationToolResult = {
        output: 'Curation complete',
        done: true,
        summary,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })

  return {
    tools,
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}
