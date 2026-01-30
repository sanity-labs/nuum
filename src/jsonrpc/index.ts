/**
 * Claude Code SDK Protocol Server
 *
 * Raw NDJSON over stdin/stdout. Process stays alive between turns.
 * Supports out-of-turn message delivery - messages received during a turn
 * are queued and processed after the current turn completes.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, cleanupStaleWorkers, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseInputMessage,
  isUserMessage,
  isControlRequest,
  getPromptFromUserMessage,
  assistantText,
  assistantToolUse,
  toolResult,
  resultMessage,
  systemMessage,
  type OutputMessage,
  type UserMessage,
  type ControlRequest,
} from "./protocol"
import { Log } from "../util/log"
import { Config } from "../config"
import { Mcp } from "../mcp"
import { Identifier } from "../id"
import { setEnvironment } from "../context/environment"

// Get the model ID for the reasoning tier (main agent)
function getModelId(): string {
  return Config.resolveModelTier("reasoning")
}

const log = Log.create({ service: "server" })

export interface ServerOptions {
  dbPath: string
  /**
   * Custom output handler. If not provided, outputs to stdout as NDJSON.
   * Used by REPL to intercept and format output for human display.
   */
  outputHandler?: (message: OutputMessage) => void
  /**
   * If true, don't set up stdin reading (for programmatic use).
   */
  noStdin?: boolean
}

interface TurnState {
  sessionId: string
  abortController: AbortController
  model: string
  numTurns: number
  startTime: number
}

export class Server {
  private storage: Storage
  private currentTurn: TurnState | null = null
  private messageQueue: UserMessage[] = []
  private rl: readline.Interface | null = null
  private processing = false
  private sessionId: string = "" // Set in start()
  private alarmInterval: ReturnType<typeof setInterval> | null = null
  private checkingAlarms = false // Prevent re-entrancy
  private outputHandler: (message: OutputMessage) => void
  private turnCompleteResolve: (() => void) | null = null // For programmatic use

  constructor(private options: ServerOptions) {
    this.storage = createStorage(options.dbPath)
    this.outputHandler = options.outputHandler ?? ((msg) => {
      process.stdout.write(JSON.stringify(msg) + "\n")
    })
  }

  async start(): Promise<void> {
    await cleanupStaleWorkers(this.storage)
    await initializeDefaultEntries(this.storage)
    await this.recoverKilledTasks()

    // Get or create session ID (persisted in database)
    this.sessionId = await this.storage.session.getId()

    // Initialize MCP servers
    await Mcp.initialize()
    const mcpTools = Mcp.getToolNames()

    // Setup SIGTERM handler for graceful shutdown (only for stdio mode)
    if (!this.options.noStdin) {
      process.on("SIGTERM", () => this.shutdown("SIGTERM"))
      process.on("SIGINT", () => this.shutdown("SIGINT"))

      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      })

      this.rl.on("line", (line) => {
        this.handleLine(line).catch((error) => {
          log.error("unhandled error in line handler", { error })
        })
      })

      this.rl.on("close", () => {
        log.info("stdin closed, shutting down")
        this.shutdown("stdin closed")
      })
    }

    // Start alarm polling (check every second)
    this.alarmInterval = setInterval(() => {
      this.checkAlarms().catch((error) => {
        log.error("error checking alarms", { error })
      })
    }, 1000)

    log.info("server started", { dbPath: this.options.dbPath, sessionId: this.sessionId })

    // Emit init message (matches Claude SDK format)
    this.send(systemMessage("init", {
      session_id: this.sessionId,
      model: getModelId(),
      tools: mcpTools,
    }))
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    const parseResult = parseInputMessage(trimmed)
    if ("error" in parseResult) {
      this.send(systemMessage("error", { message: parseResult.error }))
      return
    }

    const msg = parseResult.message

    if (isControlRequest(msg)) {
      await this.handleControlRequest(msg)
    } else if (isUserMessage(msg)) {
      await this.handleUserMessage(msg)
    }
  }

  private async handleControlRequest(request: ControlRequest): Promise<void> {
    switch (request.action) {
      case "interrupt":
        if (this.currentTurn) {
          log.info("interrupting current turn", { sessionId: this.currentTurn.sessionId })
          this.currentTurn.abortController.abort()
          this.send(systemMessage("interrupted", { session_id: this.currentTurn.sessionId }))
        } else {
          this.send(systemMessage("error", { message: "No turn is currently running" }))
        }
        break

      case "status":
        this.send(
          systemMessage("status", {
            running: this.currentTurn !== null,
            session_id: this.currentTurn?.sessionId ?? this.sessionId,
            queued_messages: this.messageQueue.length,
          }),
        )
        break

      case "heartbeat":
        this.send(
          systemMessage("heartbeat_ack", {
            timestamp: new Date().toISOString(),
            session_id: this.sessionId,
          }),
        )
        break
    }
  }

  /**
   * Recover tasks that were killed when the agent restarted.
   * Files reports to the subconscious queue so agent learns about them.
   */
  private async recoverKilledTasks(): Promise<void> {
    const killedTasks = await this.storage.tasks.recoverKilledTasks()
    
    if (killedTasks.length === 0) return
    
    log.info("recovered killed tasks", { count: killedTasks.length })
    
    // File each killed task to the subconscious queue (background reports)
    for (const task of killedTasks) {
      await this.storage.background.fileReport({
        subsystem: "task_recovery",
        report: {
          message: `Background task was killed when agent restarted: ${task.type} - "${task.description}". You may want to restart it.`,
          taskId: task.id,
          type: task.type,
          description: task.description,
        },
      })
    }
  }

  /**
   * Graceful shutdown - close storage and exit.
   * Public so REPL can call it.
   */
  async shutdown(reason: string): Promise<void> {
    log.info("shutting down", { reason })
    
    // Stop alarm polling
    if (this.alarmInterval) {
      clearInterval(this.alarmInterval)
      this.alarmInterval = null
    }
    
    // Cancel any running turn
    if (this.currentTurn) {
      this.currentTurn.abortController.abort()
    }

    // Close MCP connections
    await Mcp.shutdown()

    // Close readline
    this.rl?.close()

    process.exit(0)
  }

  /**
   * Interrupt the current turn (for programmatic use).
   */
  interrupt(): void {
    if (this.currentTurn) {
      log.info("interrupting current turn", { sessionId: this.currentTurn.sessionId })
      this.currentTurn.abortController.abort()
      this.send(systemMessage("interrupted", { session_id: this.currentTurn.sessionId }))
    }
  }

  /**
   * Send a user message programmatically (for REPL use).
   * Returns a promise that resolves when the turn completes.
   */
  async sendUserMessage(prompt: string): Promise<void> {
    const userMessage: UserMessage = {
      type: "user",
      session_id: this.sessionId,
      message: {
        role: "user",
        content: prompt,
      },
    }

    // Create a promise that will be resolved when the turn completes
    const turnComplete = new Promise<void>((resolve) => {
      this.turnCompleteResolve = resolve
    })

    await this.handleUserMessage(userMessage)

    // Wait for turn to complete
    await turnComplete
  }

  /**
   * Check for due alarms and queued results, trigger self-turns if needed.
   */
  private async checkAlarms(): Promise<void> {
    // Prevent re-entrancy
    if (this.checkingAlarms) return
    this.checkingAlarms = true

    try {
      // Check for due alarms
      const dueAlarms = await this.storage.tasks.getDueAlarms()
      if (dueAlarms.length > 0) {
        log.info("alarms fired", { count: dueAlarms.length })

        // Mark alarms as fired and queue results
        for (const alarm of dueAlarms) {
          await this.storage.tasks.markAlarmFired(alarm.id)
          
          // Queue to conscious queue
          await this.storage.tasks.queueResult(
            alarm.id,
            `⏰ **Alarm fired**: ${alarm.note}`
          )
        }
      }

      // Check if there are any queued results (from alarms or background tasks)
      const hasResults = await this.storage.tasks.hasQueuedResults()
      
      // If no turn is running and we have results, trigger a self-turn
      if (hasResults && !this.currentTurn && !this.processing) {
        await this.triggerSelfTurn()
      }
    } finally {
      this.checkingAlarms = false
    }
  }

  /**
   * Trigger a turn with queued conscious results (alarms, background task completions).
   */
  private async triggerSelfTurn(): Promise<void> {
    // Drain the conscious queue
    const results = await this.storage.tasks.drainQueue()
    if (results.length === 0) return

    log.info("triggering self-turn", { resultCount: results.length })

    // Combine all results into a single prompt
    const content = results.map(r => r.content).join("\n\n")
    
    // Create a synthetic user message for the self-turn
    const selfMessage: UserMessage = {
      type: "user",
      session_id: this.sessionId,
      message: {
        role: "user",
        content: `[SYSTEM: Background events occurred]\n\n${content}`,
      },
    }

    // Process the self-turn
    await this.processTurn(selfMessage)
    
    // Process any queued messages that came in during the self-turn
    await this.processQueue()
  }

  private async handleUserMessage(userMessage: UserMessage): Promise<void> {
    // If a turn is running, queue the message
    if (this.currentTurn) {
      this.messageQueue.push(userMessage)
      log.info("queued message", { 
        sessionId: userMessage.session_id, 
        queueLength: this.messageQueue.length,
        currentSession: this.currentTurn.sessionId,
      })
      this.send(
        systemMessage("queued", {
          session_id: userMessage.session_id,
          position: this.messageQueue.length,
        }),
      )
      return
    }

    // Process this message
    await this.processTurn(userMessage)

    // Process any queued messages
    await this.processQueue()
  }

  private async processTurn(userMessage: UserMessage): Promise<void> {
    // Always use our persistent session ID (ignore client's session_id)
    const sessionId = this.sessionId
    const prompt = getPromptFromUserMessage(userMessage)
    const abortController = new AbortController()

    // If CAST provided a system_prompt, store it for this session
    if (userMessage.system_prompt !== undefined) {
      await this.storage.session.setSystemPromptOverlay(userMessage.system_prompt || null)
    }

    // If CAST provided mcp_servers, reinitialize MCP with merged config
    // Priority: message config > env var > file
    if (userMessage.mcp_servers !== undefined) {
      await this.reinitializeMcpWithOverride(userMessage.mcp_servers)
    }

    // If CAST provided environment, apply it for this turn
    // Environment is used by child process spawns (bash, grep, etc.)
    if (userMessage.environment !== undefined) {
      setEnvironment(userMessage.environment)
      log.info("applied environment from message", { 
        count: Object.keys(userMessage.environment).length 
      })
    } else {
      // Clear environment if not provided (don't carry over from previous turn)
      setEnvironment({})
    }

    this.currentTurn = {
      sessionId,
      abortController,
      model: getModelId(),
      numTurns: 0,
      startTime: Date.now(),
    }

    log.debug("starting turn", { sessionId, promptLength: prompt.length })

    try {
      const agentOptions: AgentOptions = {
        storage: this.storage,
        verbose: false,
        abortSignal: abortController.signal,
        onEvent: (event) => this.handleAgentEvent(event),
        // Drain queued messages and inject them mid-turn
        onBeforeTurn: () => this.drainQueueForInjection(),
      }

      const result = await runAgent(prompt, agentOptions)

      if (!abortController.signal.aborted) {
        this.send(
          resultMessage(sessionId, "success", Date.now() - this.currentTurn.startTime, this.currentTurn.numTurns, {
            result: result.response,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          }),
        )
      } else {
        // Turn was interrupted
        this.send(
          resultMessage(sessionId, "cancelled", Date.now() - this.currentTurn.startTime, this.currentTurn.numTurns),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // Turn was interrupted - already sent cancelled result
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      log.error("turn failed", { sessionId, error: message })

      this.send(
        resultMessage(sessionId, "error", Date.now() - (this.currentTurn?.startTime ?? Date.now()), this.currentTurn?.numTurns ?? 0, {
          result: message,
        }),
      )
    } finally {
      this.currentTurn = null
      // Resolve the turn complete promise (for programmatic use)
      if (this.turnCompleteResolve) {
        this.turnCompleteResolve()
        this.turnCompleteResolve = null
      }
    }
  }

  private async processQueue(): Promise<void> {
    // Prevent re-entrancy
    if (this.processing) return
    this.processing = true

    try {
      while (this.messageQueue.length > 0 && !this.currentTurn) {
        const nextMessage = this.messageQueue.shift()!
        log.info("processing queued message", { 
          sessionId: nextMessage.session_id,
          remainingInQueue: this.messageQueue.length,
        })
        await this.processTurn(nextMessage)
      }
    } finally {
      this.processing = false
    }
  }

  /**
   * Drain all queued messages and return them concatenated for mid-turn injection.
   * Returns null if no messages are queued.
   */
  private drainQueueForInjection(): string | null {
    if (this.messageQueue.length === 0) {
      return null
    }

    const messages = this.messageQueue.splice(0, this.messageQueue.length)
    const contents = messages.map(m => getPromptFromUserMessage(m))
    const combined = contents.join("\n\n")

    log.info("injecting mid-turn messages", { 
      messageCount: messages.length,
      combinedLength: combined.length,
    })

    // Notify about the injection
    this.send(systemMessage("injected", { 
      message_count: messages.length,
      content_length: combined.length,
      session_id: this.currentTurn?.sessionId ?? this.sessionId,
    }))

    return combined
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (!this.currentTurn) return
    const { model, sessionId } = this.currentTurn

    switch (event.type) {
      case "assistant":
        this.send(assistantText(event.content, model, sessionId))
        break

      case "tool_call":
        if (event.toolName && event.toolCallId) {
          this.send(assistantToolUse(event.toolCallId, event.toolName, event.toolArgs ?? {}, model, sessionId))
        }
        break

      case "tool_result":
        if (event.toolCallId) {
          this.currentTurn.numTurns++
          this.send(systemMessage("tool_result", { 
            tool_result: toolResult(event.toolCallId, event.content),
            session_id: sessionId,
          }))
        }
        break

      case "error":
        this.send(systemMessage("error", { message: event.content, session_id: sessionId }))
        break

      case "consolidation":
        if (event.consolidationResult?.ran) {
          this.send(
            systemMessage("consolidation", {
              entries_created: event.consolidationResult.entriesCreated,
              entries_updated: event.consolidationResult.entriesUpdated,
              entries_archived: event.consolidationResult.entriesArchived,
              summary: event.consolidationResult.summary,
              session_id: sessionId,
            }),
          )
        }
        break
    }
  }

  /**
   * Reinitialize MCP with message-provided config override.
   * Merges with base config (env var > file), message takes precedence.
   * Only reinitializes if the merged config differs from current.
   */
  private async reinitializeMcpWithOverride(mcpServers: Record<string, unknown>): Promise<void> {
    // Load base config (env var > file)
    const baseConfig = await Mcp.loadConfig()
    
    // Merge: message config overrides base config
    const mergedConfig: Mcp.ConfigType = {
      mcpServers: {
        ...baseConfig.mcpServers,
        ...mcpServers as Record<string, Mcp.ServerConfig>,
      },
    }
    
    // Initialize will skip if config hash unchanged
    const reinitialized = await Mcp.initialize(mergedConfig)
    if (reinitialized) {
      log.info("MCP reinitialized with message config", { 
        serverCount: Object.keys(mergedConfig.mcpServers ?? {}).length 
      })
    }
  }

  private send(message: OutputMessage): void {
    this.outputHandler(message)
  }
}

export async function runServer(options: ServerOptions): Promise<void> {
  const server = new Server(options)
  await server.start()
}

export type { UserMessage, ControlRequest, OutputMessage } from "./protocol"
