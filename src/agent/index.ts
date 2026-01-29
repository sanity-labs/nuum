/**
 * Core agent implementation for miriad-code
 *
 * Main agent loop that:
 * 1. Builds the prompt from memory (temporal, present, LTM)
 * 2. Calls the AI model with tools
 * 3. Executes tool calls
 * 4. Logs everything to temporal memory
 * 5. Updates present state
 */

import { tool } from "ai"
import type {
  CoreMessage,
  CoreTool,
} from "ai"
import { z } from "zod"
import { Provider } from "../provider"
import { Config } from "../config"
import type { Storage, Task } from "../storage"
import { Identifier } from "../id"
import {
  Tool,
  BashTool,
  ReadTool,
  EditTool,
  WriteTool,
  GlobTool,
  GrepTool,
  WebSearchTool,
  WebFetchTool,
  McpStatusTool,
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  ReflectTool,
  ResearchTool,
  type LTMToolContext,
  type ReflectToolContext,
  type ResearchToolContext,
} from "../tool"
import { runAgentLoop, AgentLoopCancelledError } from "./loop"
import { buildAgentContext } from "../context"
import { runMemoryCuration, getEffectiveViewTokens, type MemoryCurationResult, type ConsolidationResult, type CompactionResult } from "../memory"
import { Log } from "../util/log"
import { activity } from "../util/activity-log"
import { Mcp } from "../mcp"
import { refreshSkills } from "../skills"

const log = Log.create({ service: "agent" })

const MAX_TURNS = 200

/**
 * Surface any pending background reports to temporal storage.
 * 
 * Background workers (LTM curator, distillation) file reports that get
 * surfaced to the main agent at the start of the next turn. This makes
 * the memory system visible to the agent.
 */
async function surfaceBackgroundReports(storage: Storage): Promise<void> {
  const reports = await storage.background.getUnsurfaced()
  if (reports.length === 0) return
  
  log.info("surfacing background reports", { count: reports.length })
  
  for (const report of reports) {
    const toolCallId = Identifier.ascending("toolcall")
    
    // Append tool call
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "tool_call",
      content: JSON.stringify({
        name: "background_activity",
        args: { subsystem: report.subsystem },
        toolCallId,
      }),
      tokenEstimate: 20,
      createdAt: report.createdAt,
    })
    
    // Format the report content
    const reportContent = formatBackgroundReport(report.subsystem, report.report)
    
    // Append tool result
    await storage.temporal.appendMessage({
      id: Identifier.ascending("message"),
      type: "tool_result",
      content: JSON.stringify({
        toolCallId,
        result: reportContent,
      }),
      tokenEstimate: estimateTokens(reportContent),
      createdAt: report.createdAt,
    })
    
    // Mark as surfaced
    await storage.background.markSurfaced(report.id)
  }
}

/**
 * Format a background report for display to the agent.
 * 
 * The report should read like a note from your past self explaining what
 * happened while you were away. The summary is the primary content - it's
 * a contextual narrative written by the background worker.
 */
function formatBackgroundReport(subsystem: string, report: Record<string, unknown>): string {
  switch (subsystem) {
    case "ltm_curator": {
      const r = report as {
        entriesCreated?: number
        entriesUpdated?: number
        entriesArchived?: number
        details?: string[]
        summary?: string
      }
      
      // If we have a narrative summary, use it as the primary content
      if (r.summary) {
        return `[Knowledge Curator] ${r.summary}`
      }
      
      // Fallback to mechanical format if no summary
      const lines = ["[Knowledge Curator] I organized my knowledge:"]
      if (r.entriesCreated) lines.push(`- Created ${r.entriesCreated} new entries`)
      if (r.entriesUpdated) lines.push(`- Updated ${r.entriesUpdated} existing entries`)
      if (r.entriesArchived) lines.push(`- Archived ${r.entriesArchived} outdated entries`)
      if (r.details && r.details.length > 0) {
        lines.push("")
        lines.push(...r.details.map(d => `- ${d}`))
      }
      return lines.join("\n")
    }
    
    case "distillation": {
      const r = report as {
        tokensBefore?: number
        tokensAfter?: number
        distillationsCreated?: number
        summary?: string
      }
      
      // If we have a narrative summary, use it as the primary content
      if (r.summary) {
        const tokenInfo = r.tokensBefore && r.tokensAfter 
          ? ` (${r.tokensBefore.toLocaleString()} → ${r.tokensAfter.toLocaleString()} tokens)`
          : ""
        return `[Memory Compaction]${tokenInfo} ${r.summary}`
      }
      
      // Fallback to mechanical format if no summary
      const lines = ["[Memory Compaction] I compressed my working memory:"]
      if (r.tokensBefore && r.tokensAfter) {
        const saved = r.tokensBefore - r.tokensAfter
        lines.push(`- Reduced from ${r.tokensBefore.toLocaleString()} to ${r.tokensAfter.toLocaleString()} tokens (saved ${saved.toLocaleString()})`)
      }
      if (r.distillationsCreated) {
        lines.push(`- Created ${r.distillationsCreated} distillation${r.distillationsCreated > 1 ? "s" : ""}`)
      }
      return lines.join("\n")
    }
    
    default:
      return `[${subsystem}] ${JSON.stringify(report, null, 2)}`
  }
}

/**
 * Summarize a tool result for activity logging.
 * Provides a human-readable summary without overwhelming detail.
 */
function summarizeToolResult(toolName: string, result: string): string {
  const lines = result.split("\n").length
  const bytes = result.length
  
  // Format size info
  const sizeInfo = bytes < 1024 
    ? `${bytes}b` 
    : `${(bytes / 1024).toFixed(1)}kb`
  
  switch (toolName) {
    case "read":
      return `${lines} lines, ${sizeInfo}`
    case "glob":
    case "grep": {
      // Count matches
      const matchCount = result.split("\n").filter(l => l.trim()).length
      return `${matchCount} matches`
    }
    case "bash": {
      // Show exit status if present, otherwise line count
      if (result.includes("exit code")) {
        return result.slice(0, 80)
      }
      return `${lines} lines output`
    }
    case "write":
    case "edit":
      return result.slice(0, 60)
    case "web_search": {
      const resultCount = (result.match(/^\d+\./gm) || []).length
      return `${resultCount} results`
    }
    case "web_fetch":
      return `${sizeInfo} extracted`
    case "ltm_search": {
      const entryCount = (result.match(/^- \*\*/gm) || []).length
      return `${entryCount} entries found`
    }
    case "ltm_glob":
      return `${lines} entries`
    case "ltm_read":
    case "ltm_create":
    case "ltm_update":
    case "ltm_edit":
    case "ltm_archive":
    case "ltm_reparent":
    case "ltm_rename":
      return result.slice(0, 60)
    case "mcp_status": {
      const match = result.match(/(\d+)\/(\d+) servers connected, (\d+) tools/)
      if (match) {
        return `${match[1]}/${match[2]} servers, ${match[3]} tools`
      }
      return "MCP status retrieved"
    }
    default:
      // Generic: show truncated result
      return result.length > 60 ? result.slice(0, 57) + "..." : result
  }
}

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 * Used for temporal message logging.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface AgentOptions {
  storage: Storage
  verbose?: boolean
  onEvent?: (event: AgentEvent) => void
  /** AbortSignal for cancellation support */
  abortSignal?: AbortSignal
  /**
   * Called before each model turn. Can return additional user content to inject.
   * Use this for mid-turn message delivery - messages received while the agent
   * is running can be injected here to give the agent a chance to adjust.
   */
  onBeforeTurn?: () => string | null | Promise<string | null>
}

export interface AgentEvent {
  type: "user" | "assistant" | "tool_call" | "tool_result" | "error" | "done" | "consolidation" | "compaction"
  content: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  consolidationResult?: ConsolidationResult
  compactionResult?: CompactionResult
}

export interface AgentResult {
  response: string
  usage: {
    inputTokens: number
    outputTokens: number
  }
}

/**
 * Context factory for creating tool execution contexts.
 * Centralizes context creation and LTM injection.
 */
interface ToolContextFactory {
  createContext(callId: string): Tool.Context
  createLTMContext(callId: string): Tool.Context & { extra: LTMToolContext }
  createReflectContext(callId: string): Tool.Context & { extra: ReflectToolContext }
  createResearchContext(callId: string): Tool.Context & { extra: ResearchToolContext }
}

function createToolContextFactory(
  storage: Storage,
  sessionId: string,
  messageId: string,
  abortSignal?: AbortSignal,
): ToolContextFactory {
  const baseContext = {
    sessionID: sessionId,
    messageID: messageId,
    abort: abortSignal ?? new AbortController().signal,
  }

  return {
    createContext(callId: string): Tool.Context {
      return Tool.createContext({
        ...baseContext,
        callID: callId,
      })
    },
    createLTMContext(callId: string): Tool.Context & { extra: LTMToolContext } {
      const ctx = Tool.createContext({
        ...baseContext,
        callID: callId,
      }) as Tool.Context & { extra: LTMToolContext }
      ctx.extra = {
        ltm: storage.ltm,
        agentType: "main",
      }
      return ctx
    },
    createReflectContext(callId: string): Tool.Context & { extra: ReflectToolContext } {
      const ctx = Tool.createContext({
        ...baseContext,
        callID: callId,
      }) as Tool.Context & { extra: ReflectToolContext }
      ctx.extra = {
        storage,
      }
      return ctx
    },
    createResearchContext(callId: string): Tool.Context & { extra: ResearchToolContext } {
      const ctx = Tool.createContext({
        ...baseContext,
        callID: callId,
      }) as Tool.Context & { extra: ResearchToolContext }
      ctx.extra = {
        storage,
      }
      return ctx
    },
  }
}

/**
 * Wrap a tool execution with error handling.
 * Returns errors as string results instead of throwing, so the agent can see and react to them.
 */
async function safeExecute<T>(
  toolName: string,
  fn: () => Promise<{ output: string } & T>,
): Promise<string> {
  try {
    const result = await fn()
    return result.output
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `Error executing tool ${toolName}: ${message}`
  }
}

/**
 * Convert our Tool definitions to AI SDK CoreTool format with execute callbacks.
 * This eliminates the need for a separate executeTool() switch statement.
 *
 * Also includes any MCP tools that have been connected.
 */
function buildTools(
  storage: Storage,
  sessionId: string,
  messageId: string,
  abortSignal?: AbortSignal,
): Record<string, CoreTool> {
  const factory = createToolContextFactory(storage, sessionId, messageId, abortSignal)
  const tools: Record<string, CoreTool> = {}

  // Add MCP tools first (if any servers are connected)
  // MCP tools are already wrapped as AI SDK CoreTool by Mcp.getTools()
  const mcpTools = Mcp.getTools()
  Object.assign(tools, mcpTools)

  // File operation tools - wire execute with error handling
  tools.bash = tool({
    description: BashTool.definition.description,
    parameters: BashTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("bash", () => BashTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.read = tool({
    description: ReadTool.definition.description,
    parameters: ReadTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("read", () => ReadTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.write = tool({
    description: WriteTool.definition.description,
    parameters: WriteTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("write", () => WriteTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.edit = tool({
    description: EditTool.definition.description,
    parameters: EditTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("edit", () => EditTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.glob = tool({
    description: GlobTool.definition.description,
    parameters: GlobTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("glob", () => GlobTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.grep = tool({
    description: GrepTool.definition.description,
    parameters: GrepTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("grep", () => GrepTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  // Web tools
  tools.web_search = tool({
    description: WebSearchTool.definition.description,
    parameters: WebSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("web_search", () => WebSearchTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.web_fetch = tool({
    description: WebFetchTool.definition.description,
    parameters: WebFetchTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("web_fetch", () => WebFetchTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  tools.mcp_status = tool({
    description: McpStatusTool.definition.description,
    parameters: McpStatusTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("mcp_status", () => McpStatusTool.definition.execute(args, factory.createContext(toolCallId))),
  })

  // Present state tools - inline execution
  tools.present_set_mission = tool({
    description: "Set the current mission (high-level objective)",
    parameters: z.object({
      mission: z.string().nullable().describe("The mission to set, or null to clear"),
    }),
    execute: async ({ mission }) => {
      await storage.present.setMission(mission)
      return `Mission ${mission ? "set to: " + mission : "cleared"}`
    },
  })

  tools.present_set_status = tool({
    description: "Set the current status (what you're working on now)",
    parameters: z.object({
      status: z.string().nullable().describe("The status to set, or null to clear"),
    }),
    execute: async ({ status }) => {
      await storage.present.setStatus(status)
      return `Status ${status ? "set to: " + status : "cleared"}`
    },
  })

  tools.present_update_tasks = tool({
    description: "Update the task list",
    parameters: z.object({
      tasks: z.array(
        z.object({
          id: z.string().describe("Unique task ID"),
          content: z.string().describe("Task description (imperative form)"),
          status: z.enum(["pending", "in_progress", "completed", "blocked"]),
          blockedReason: z.string().optional().describe("Why the task is blocked"),
        }),
      ),
    }),
    execute: async ({ tasks }) => {
      await storage.present.setTasks(tasks)
      return `Tasks updated (${tasks.length} tasks)`
    },
  })

  // LTM retrieval tools - use shared definitions with LTM context
  tools.ltm_glob = tool({
    description: LTMGlobTool.definition.description,
    parameters: LTMGlobTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("ltm_glob", () => LTMGlobTool.definition.execute(args, factory.createLTMContext(toolCallId))),
  })

  tools.ltm_search = tool({
    description: LTMSearchTool.definition.description,
    parameters: LTMSearchTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("ltm_search", () => LTMSearchTool.definition.execute(args, factory.createLTMContext(toolCallId))),
  })

  tools.ltm_read = tool({
    description: LTMReadTool.definition.description,
    parameters: LTMReadTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("ltm_read", () => LTMReadTool.definition.execute(args, factory.createLTMContext(toolCallId))),
  })

  // Reflection tool - search own memory to answer questions
  tools.reflect = tool({
    description: ReflectTool.definition.description,
    parameters: ReflectTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("reflect", () => ReflectTool.definition.execute(args, factory.createReflectContext(toolCallId))),
  })

  // Research tool - investigate topics and build LTM knowledge
  tools.research = tool({
    description: ResearchTool.definition.description,
    parameters: ResearchTool.definition.parameters,
    execute: async (args, { toolCallId }) =>
      safeExecute("research", () => ResearchTool.definition.execute(args, factory.createResearchContext(toolCallId))),
  })

  return tools
}



/**
 * Re-export the cancellation error from the generic loop.
 */
export { AgentLoopCancelledError as AgentCancelledError } from "./loop"

/**
 * Re-export MCP namespace for direct access to config/status.
 */
export { Mcp } from "../mcp"

// Re-export context building functions for backward compatibility
// Prefer importing directly from "../context" for new code
export { buildSystemPrompt, buildConversationHistory, buildAgentContext } from "../context"

/**
 * Initialize MCP servers from config.
 * Only reinitializes if config has changed.
 * Returns true if initialization was performed.
 */
export async function initializeMcp(): Promise<boolean> {
  try {
    const didInitialize = await Mcp.initialize()
    if (didInitialize) {
      const status = Mcp.getStatus()
      if (status.length > 0) {
        log.info("MCP servers connected", {
          servers: status.map((s) => `${s.name} (${s.toolCount} tools)`),
        })
      }
    }
    return didInitialize
  } catch (error) {
    log.error("Failed to initialize MCP", { error })
    return false
  }
}

/**
 * Disconnect from all MCP servers.
 * Call this on shutdown.
 */
export async function shutdownMcp(): Promise<void> {
  await Mcp.shutdown()
}
/**
 * Run the main agent loop.
 */
export async function runAgent(
  prompt: string,
  options: AgentOptions,
): Promise<AgentResult> {
  const { storage, onEvent, abortSignal, onBeforeTurn } = options
  const sessionId = Identifier.ascending("session")

  // Initialize MCP servers (loads config and connects)
  await initializeMcp()

  // Surface any pending background reports (LTM curator, distillation)
  // This makes the memory system visible to the agent
  await surfaceBackgroundReports(storage)

  // Pre-turn compaction gate: ensure we're not overflowing before starting
  const config = Config.get()
  const softLimit = config.tokenBudgets.compactionThreshold
  const hardLimit = config.tokenBudgets.compactionHardLimit
  const tokensBefore = await getEffectiveViewTokens(storage.temporal)

  if (tokensBefore > hardLimit) {
    // Emergency brake: refuse turn entirely
    log.error("context overflow - refusing turn", { tokens: tokensBefore, hardLimit })
    throw new Error(
      `Context overflow: ${tokensBefore} tokens exceeds hard limit of ${hardLimit}. ` +
      `Run 'miriad-code --compact' to reduce context size before continuing.`
    )
  }

  if (tokensBefore > softLimit) {
    // Proactive compaction: run synchronously before proceeding
    log.warn("approaching token limit, running compaction before turn", { 
      tokens: tokensBefore, 
      softLimit,
      target: config.tokenBudgets.compactionTarget 
    })
    
    await runMemoryCuration(storage, { force: true })
    
    // Verify compaction helped
    const tokensAfter = await getEffectiveViewTokens(storage.temporal)
    if (tokensAfter > softLimit) {
      log.warn("compaction didn't reduce tokens below soft limit", { 
        before: tokensBefore, 
        after: tokensAfter,
        softLimit 
      })
      // Continue anyway - we tried our best, and we're still under hard limit
    } else {
      log.info("pre-turn compaction successful", { before: tokensBefore, after: tokensAfter })
    }
  }

  // Get the model
  const model = Provider.getModelForTier("reasoning")

  // Build agent context (shared with all workloads)
  const ctx = await buildAgentContext(storage)

  // Log user message to temporal
  const userMessageId = Identifier.ascending("message")
  try {
    await storage.temporal.appendMessage({
      id: userMessageId,
      type: "user",
      content: prompt,
      tokenEstimate: estimateTokens(prompt),
      createdAt: new Date().toISOString(),
    })
  } catch (error) {
    log.error("failed to persist user message", {
      messageId: userMessageId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }

  // Build tools with execute callbacks wired up
  const tools = buildTools(storage, sessionId, userMessageId, abortSignal)

  // Initialize messages with history + current user prompt
  const initialMessages: CoreMessage[] = [
    ...ctx.historyTurns,
    { role: "user", content: prompt },
  ]

  onEvent?.({ type: "user", content: prompt })

  // Track whether we've logged the assistant text (to avoid double-logging)
  let lastLoggedText = ""

  // Run the generic agent loop with callbacks for temporal logging and events
  const result = await runAgentLoop({
    model,
    systemPrompt: ctx.systemPrompt,
    initialMessages,
    tools,
    maxTokens: 8192,
    maxTurns: MAX_TURNS,
    abortSignal,

    // Log assistant text to temporal and emit event
    onText: async (text) => {
      // Only log if this is new text (avoid double-logging on final turn)
      if (text !== lastLoggedText) {
        const assistantMessageId = Identifier.ascending("message")
        try {
          await storage.temporal.appendMessage({
            id: assistantMessageId,
            type: "assistant",
            content: text,
            tokenEstimate: estimateTokens(text),
            createdAt: new Date().toISOString(),
          })
          // Only mark as logged after successful persistence
          lastLoggedText = text
        } catch (error) {
          log.error("failed to persist assistant message", {
            messageId: assistantMessageId,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        onEvent?.({ type: "assistant", content: text })
      }
    },

    // Log tool calls to temporal and emit event
    onToolCall: async (toolCallId, toolName, args) => {
      // Activity log for human-readable output
      activity.mainAgent.toolCall(toolName, args as Record<string, unknown>)
      
      const toolCallMsgId = Identifier.ascending("message")
      try {
        await storage.temporal.appendMessage({
          id: toolCallMsgId,
          type: "tool_call",
          content: JSON.stringify({ name: toolName, args, toolCallId }),
          tokenEstimate: estimateTokens(JSON.stringify(args)),
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        log.error("failed to persist tool call", {
          messageId: toolCallMsgId,
          toolName,
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      onEvent?.({
        type: "tool_call",
        content: `${toolName}(${JSON.stringify(args).slice(0, 100)}...)`,
        toolName,
        toolCallId,
        toolArgs: args,
      })
    },

    // Log tool results to temporal and emit event
    onToolResult: async (toolCallId, toolName, toolResult) => {
      // Activity log with smart summary based on tool type
      const resultSummary = summarizeToolResult(toolName, toolResult)
      activity.mainAgent.toolResult(toolName, resultSummary)
      
      const toolResultMsgId = Identifier.ascending("message")
      try {
        await storage.temporal.appendMessage({
          id: toolResultMsgId,
          type: "tool_result",
          content: toolResult,
          tokenEstimate: estimateTokens(toolResult),
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        log.error("failed to persist tool result", {
          messageId: toolResultMsgId,
          toolName,
          toolCallId,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      onEvent?.({
        type: "tool_result",
        content: toolResult.slice(0, 200) + (toolResult.length > 200 ? "..." : ""),
        toolCallId,
      })
    },

    // Check for mid-turn messages to inject
    onBeforeTurn: async () => {
      // Refresh skills cache to pick up newly installed skills
      refreshSkills()
      
      const content = await onBeforeTurn?.()
      if (content) {
        // Persist the injected user message to temporal
        const injectedMsgId = Identifier.ascending("message")
        try {
          await storage.temporal.appendMessage({
            id: injectedMsgId,
            type: "user",
            content: content,
            tokenEstimate: estimateTokens(content),
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          log.error("failed to persist injected user message", {
            messageId: injectedMsgId,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        onEvent?.({ type: "user", content })
        return content
      }
      return null
    },
  })

  onEvent?.({ type: "done", content: result.finalText })

  // Run memory curation in background (LTM consolidation + distillation)
  // Fire-and-forget: don't block the main agent
  runMemoryCuration(storage).then((curationResult) => {
    if (curationResult.ran) {
      if (curationResult.consolidation?.ran) {
        onEvent?.({
          type: "consolidation",
          content: curationResult.consolidation.summary || "LTM consolidation complete",
          consolidationResult: curationResult.consolidation,
        })
      }
      if (curationResult.distillation) {
        const d = curationResult.distillation
        onEvent?.({
          type: "compaction",
          content: `Distilled ${d.tokensBefore - d.tokensAfter} tokens (${d.distillationsCreated} distillations)`,
          compactionResult: d,
        })
      }
    }
  }).catch((error) => {
    log.error("background memory curation failed", { error: error instanceof Error ? error.message : String(error) })
  })

  return {
    response: result.finalText,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  }
}
