/**
 * JSON-RPC listener for miriad-code
 *
 * Implements NDJSON protocol over stdin/stdout for interactive mode.
 * Shares the agent core with batch mode via the onEvent callback pattern.
 */

import * as readline from "readline"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, type AgentEvent, type AgentOptions } from "../agent"
import {
  parseRequest,
  validateRunParams,
  createResponse,
  createErrorResponse,
  ErrorCodes,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol"
import { Log } from "../util/log"

const log = Log.create({ service: "jsonrpc" })

export interface JsonRpcServerOptions {
  dbPath: string
}

interface RequestState {
  id: string | number
  abortController: AbortController
}

/**
 * JSON-RPC server that listens on stdin and writes to stdout.
 */
export class JsonRpcServer {
  private storage: Storage
  private currentRequest: RequestState | null = null
  private rl: readline.Interface | null = null

  constructor(private options: JsonRpcServerOptions) {
    this.storage = createStorage(options.dbPath)
  }

  /**
   * Start listening for requests on stdin.
   */
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

  /**
   * Handle a single line of input (one JSON-RPC request).
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    const parseResult = parseRequest(trimmed)
    if ("error" in parseResult) {
      this.send(parseResult.error)
      return
    }

    const request = parseResult.request
    await this.handleRequest(request)
  }

  /**
   * Route the request to the appropriate handler.
   */
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
        this.send(
          createErrorResponse(request.id, ErrorCodes.METHOD_NOT_FOUND, `Method not found: ${request.method}`),
        )
    }
  }

  /**
   * Handle a 'run' request - execute a prompt.
   */
  private async handleRun(request: JsonRpcRequest): Promise<void> {
    // Check if already running
    if (this.currentRequest) {
      this.send(
        createErrorResponse(request.id, ErrorCodes.ALREADY_RUNNING, "A request is already running", {
          currentRequestId: this.currentRequest.id,
        }),
      )
      return
    }

    // Validate params
    const paramsResult = validateRunParams(request.params)
    if ("error" in paramsResult) {
      this.send(createErrorResponse(request.id, ErrorCodes.INVALID_PARAMS, paramsResult.error))
      return
    }

    const { prompt } = paramsResult.params
    const abortController = new AbortController()

    this.currentRequest = {
      id: request.id,
      abortController,
    }

    log.info("starting run", { requestId: request.id, promptLength: prompt.length })

    try {
      const agentOptions: AgentOptions = {
        storage: this.storage,
        verbose: false,
        abortSignal: abortController.signal,
        onEvent: (event) => this.handleAgentEvent(request.id, event),
      }

      const result = await runAgent(prompt, agentOptions)

      // Send completion message (if not cancelled)
      if (!abortController.signal.aborted) {
        this.send(
          createResponse(request.id, {
            type: "complete",
            response: result.response,
            usage: result.usage,
          }),
        )
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        // Already sent cancelled response
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      log.error("run failed", { requestId: request.id, error: message })

      this.send(
        createErrorResponse(request.id, ErrorCodes.INTERNAL_ERROR, message),
      )
    } finally {
      this.currentRequest = null
    }
  }

  /**
   * Handle agent events and stream them to stdout.
   */
  private handleAgentEvent(requestId: string | number, event: AgentEvent): void {
    switch (event.type) {
      case "assistant":
        this.send(
          createResponse(requestId, {
            type: "text",
            chunk: event.content,
          }),
        )
        break
      case "tool_call":
        if (event.toolName && event.toolCallId) {
          // Parse the args from the content (it's in format "name(args...)")
          let args: unknown = {}
          try {
            const argsMatch = event.content.match(/\((.+?)\.\.\.\)$/)
            if (argsMatch) {
              args = JSON.parse(argsMatch[1])
            }
          } catch {
            // Keep empty args
          }
          this.send(
            createResponse(requestId, {
              type: "tool_call",
              callId: event.toolCallId,
              name: event.toolName,
              args,
            }),
          )
        }
        break
      case "tool_result":
        if (event.toolCallId) {
          this.send(
            createResponse(requestId, {
              type: "tool_result",
              callId: event.toolCallId,
              result: event.content,
            }),
          )
        }
        break
      case "error":
        this.send(
          createResponse(requestId, {
            type: "error",
            message: event.content,
          }),
        )
        break
      // Ignore 'user', 'done', 'compaction' events for JSON-RPC output
    }
  }

  /**
   * Handle a 'cancel' request - abort the current run.
   */
  private async handleCancel(request: JsonRpcRequest): Promise<void> {
    if (!this.currentRequest) {
      this.send(createErrorResponse(request.id, ErrorCodes.NOT_RUNNING, "No request is currently running"))
      return
    }

    const cancelledId = this.currentRequest.id
    this.currentRequest.abortController.abort()

    log.info("request cancelled", { cancelledRequestId: cancelledId })

    // Send cancelled response for the original request
    this.send(createResponse(cancelledId, { type: "cancelled" }))

    // Send acknowledgement for the cancel request
    this.send(
      createResponse(request.id, {
        type: "status",
        running: false,
      }),
    )
  }

  /**
   * Handle a 'status' request - return current state.
   */
  private async handleStatus(request: JsonRpcRequest): Promise<void> {
    this.send(
      createResponse(request.id, {
        type: "status",
        running: this.currentRequest !== null,
        requestId: this.currentRequest?.id,
      }),
    )
  }

  /**
   * Send a JSON-RPC response to stdout.
   */
  private send(response: JsonRpcResponse): void {
    const line = JSON.stringify(response)
    process.stdout.write(line + "\n")
  }
}

/**
 * Start the JSON-RPC server.
 */
export async function runJsonRpc(options: JsonRpcServerOptions): Promise<void> {
  const server = new JsonRpcServer(options)
  await server.start()
}

// Re-export types
export type { JsonRpcRequest, JsonRpcResponse } from "./protocol"
