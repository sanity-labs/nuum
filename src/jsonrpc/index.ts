/**
 * JSON-RPC server for miriad-code
 *
 * NDJSON over stdin/stdout with Claude Code SDK compatible messages.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseRequest,
  validateRunParams,
  createResponse,
  createErrorResponse,
  assistantText,
  assistantToolUse,
  toolResult,
  resultMessage,
  systemMessage,
  ErrorCodes,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol"
import { Log } from "../util/log"
import { Config } from "../config"

const log = Log.create({ service: "jsonrpc" })

export interface JsonRpcServerOptions {
  dbPath: string
}

interface RequestState {
  id: string | number
  sessionId: string
  abortController: AbortController
  model: string
  numTurns: number
  startTime: number
}

export class JsonRpcServer {
  private storage: Storage
  private currentRequest: RequestState | null = null
  private rl: readline.Interface | null = null

  constructor(private options: JsonRpcServerOptions) {
    this.storage = createStorage(options.dbPath)
  }

  async start(): Promise<void> {
    await initializeDefaultEntries(this.storage)

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
      process.exit(0)
    })

    log.info("JSON-RPC server started", { dbPath: this.options.dbPath })
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    const parseResult = parseRequest(trimmed)
    if ("error" in parseResult) {
      this.send(parseResult.error)
      return
    }

    await this.handleRequest(parseResult.request)
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    switch (request.method) {
      case "run":
        await this.handleRun(request)
        break
      case "cancel":
        await this.handleCancel(request)
        break
      case "status":
        await this.handleStatus(request)
        break
      default:
        this.send(createErrorResponse(request.id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${request.method}`))
    }
  }

  private async handleRun(request: JsonRpcRequest): Promise<void> {
    if (this.currentRequest) {
      this.send(
        createErrorResponse(request.id, ErrorCodes.ALREADY_RUNNING, "A request is already running", {
          currentRequestId: this.currentRequest.id,
        }),
      )
      return
    }

    const paramsResult = validateRunParams(request.params)
    if ("error" in paramsResult) {
      this.send(createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, paramsResult.error))
      return
    }

    const { prompt, session_id } = paramsResult.params
    const abortController = new AbortController()
    const sessionId = session_id ?? `session_${Date.now()}`

    this.currentRequest = {
      id: request.id,
      sessionId,
      abortController,
      model: Config.model ?? "unknown",
      numTurns: 0,
      startTime: Date.now(),
    }

    log.info("starting run", { requestId: request.id, sessionId, promptLength: prompt.length })

    try {
      const agentOptions: AgentOptions = {
        storage: this.storage,
        verbose: false,
        abortSignal: abortController.signal,
        onEvent: (event) => this.handleAgentEvent(request.id, event),
      }

      const result = await runAgent(prompt, agentOptions)

      if (!abortController.signal.aborted) {
        this.send(
          createResponse(
            request.id,
            resultMessage(sessionId, "success", Date.now() - this.currentRequest.startTime, this.currentRequest.numTurns, {
              result: result.response,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
            }),
          ),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) return

      const message = error instanceof Error ? error.message : String(error)
      log.error("run failed", { requestId: request.id, error: message })

      this.send(
        createResponse(
          request.id,
          resultMessage(sessionId, "error", Date.now() - (this.currentRequest?.startTime ?? Date.now()), this.currentRequest?.numTurns ?? 0, {
            result: message,
          }),
        ),
      )
    } finally {
      this.currentRequest = null
    }
  }

  private handleAgentEvent(requestId: string | number, event: AgentEvent): void {
    if (!this.currentRequest) return
    const { model } = this.currentRequest

    switch (event.type) {
      case "assistant":
        this.send(createResponse(requestId, assistantText(event.content, model)))
        break

      case "tool_call":
        if (event.toolName && event.toolCallId) {
          this.send(createResponse(requestId, assistantToolUse(event.toolCallId, event.toolName, event.toolArgs ?? {}, model)))
        }
        break

      case "tool_result":
        if (event.toolCallId) {
          this.currentRequest.numTurns++
          this.send(
            createResponse(requestId, systemMessage("tool_result", { tool_result: toolResult(event.toolCallId, event.content) })),
          )
        }
        break

      case "error":
        this.send(createResponse(requestId, systemMessage("error", { message: event.content })))
        break

      case "consolidation":
        if (event.consolidationResult?.ran) {
          this.send(
            createResponse(
              requestId,
              systemMessage("consolidation", {
                entries_created: event.consolidationResult.entriesCreated,
                entries_updated: event.consolidationResult.entriesUpdated,
                entries_archived: event.consolidationResult.entriesArchived,
                summary: event.consolidationResult.summary,
              }),
            ),
          )
        }
        break
    }
  }

  private async handleCancel(request: JsonRpcRequest): Promise<void> {
    if (!this.currentRequest) {
      this.send(createErrorResponse(request.id, ErrorCodes.NOT_RUNNING, "No request is currently running"))
      return
    }

    const { id: cancelledId, sessionId, startTime, numTurns, abortController } = this.currentRequest
    this.currentRequest = null
    abortController.abort()

    log.info("request cancelled", { cancelledRequestId: cancelledId })

    this.send(createResponse(cancelledId, resultMessage(sessionId, "cancelled", Date.now() - startTime, numTurns)))
    this.send(createResponse(request.id, systemMessage("status", { running: false })))
  }

  private async handleStatus(request: JsonRpcRequest): Promise<void> {
    this.send(
      createResponse(
        request.id,
        systemMessage("status", {
          running: this.currentRequest !== null,
          request_id: this.currentRequest?.id,
          session_id: this.currentRequest?.sessionId,
        }),
      ),
    )
  }

  private send(response: JsonRpcResponse): void {
    process.stdout.write(JSON.stringify(response) + "\n")
  }
}

export async function runJsonRpc(options: JsonRpcServerOptions): Promise<void> {
  const server = new JsonRpcServer(options)
  await server.start()
}

export type { JsonRpcRequest, JsonRpcResponse } from "./protocol"
