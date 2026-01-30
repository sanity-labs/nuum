/**
 * MCP (Model Context Protocol) client support
 *
 * Provides stdio and streamable-http transports for connecting to MCP servers.
 * Uses Claude-compatible config format for easy migration.
 */

import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { tool } from "ai"
import { jsonSchema } from "ai"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

export namespace Mcp {
  // ============================================================================
  // Config Schema (Claude-compatible)
  // ============================================================================

  /**
   * Stdio server config - spawns a local process
   */
  export const StdioServerConfigSchema = z.object({
    command: z.string(),
    args: z.array(z.string()).optional().default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
    disabled: z.boolean().optional().default(false),
    timeout: z.number().optional().default(30000),
  })
  export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>

  /**
   * HTTP server config - connects to remote server via streamable-http or SSE
   */
  export const HttpServerConfigSchema = z.object({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    transport: z.enum(["http", "sse"]).optional().default("http"),
    disabled: z.boolean().optional().default(false),
    timeout: z.number().optional().default(30000),
    // Reconnection options
    maxRetries: z.number().optional().default(5),
    initialReconnectionDelay: z.number().optional().default(1000),
    maxReconnectionDelay: z.number().optional().default(60000),
  })
  export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>

  /**
   * Union of all server types - discriminated by presence of 'command' vs 'url'
   */
  export const ServerConfigSchema = z.union([
    StdioServerConfigSchema,
    HttpServerConfigSchema,
  ])
  export type ServerConfig = z.infer<typeof ServerConfigSchema>

  /**
   * Full MCP config schema - map of server name to config
   */
  export const ConfigSchema = z.object({
    mcpServers: z.record(ServerConfigSchema).optional(),
  })
  export type ConfigType = z.infer<typeof ConfigSchema>

  /**
   * Config namespace for parsing (matches test expectations)
   */
  export const Config = {
    parse: (data: unknown): ConfigType => ConfigSchema.parse(data),
    safeParse: (data: unknown) => ConfigSchema.safeParse(data),
  }

  // ============================================================================
  // Config Loading
  // ============================================================================

  const CONFIG_FILE_PATH = path.join(
    os.homedir(),
    ".config",
    "miriad",
    "code.json"
  )
  const CONFIG_ENV_VAR = "MIRIAD_MCP_CONFIG"

  /**
   * Load MCP config from env var or file
   * Priority: env var > file
   */
  export async function loadConfig(): Promise<ConfigType> {
    // Try env var first
    const envConfig = process.env[CONFIG_ENV_VAR]
    if (envConfig) {
      try {
        const parsed = JSON.parse(envConfig)
        return ConfigSchema.parse(parsed)
      } catch (e) {
        console.error(`Failed to parse ${CONFIG_ENV_VAR}:`, e)
      }
    }

    // Try config file
    try {
      const content = await fs.readFile(CONFIG_FILE_PATH, "utf-8")
      const parsed = JSON.parse(content)
      return ConfigSchema.parse(parsed)
    } catch {
      // File doesn't exist or is invalid - return empty config
    }

    // Return empty config
    return { mcpServers: {} }
  }

  // ============================================================================
  // Type Guards
  // ============================================================================

  function isStdioConfig(config: ServerConfig): config is StdioServerConfig {
    return "command" in config
  }

  function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
    return "url" in config
  }

  // ============================================================================
  // Manager Class
  // ============================================================================

  interface ConnectedServer {
    name: string
    config: ServerConfig
    client: Client
    tools: Tool[]
    status: "connected" | "failed" | "disabled"
    error?: string
    sessionId?: string // For HTTP transports - enables session resumption
  }

  export class Manager {
    private servers: Map<string, ConnectedServer> = new Map()

    /**
     * Create transport for a server config
     */
    private createTransport(config: ServerConfig) {
      if (isStdioConfig(config)) {
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env,
          cwd: config.cwd,
          stderr: "pipe", // Capture stderr for logging
        })
      } else if (isHttpConfig(config)) {
        if (config.transport === "sse") {
          return new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
          })
        } else {
          return new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
            reconnectionOptions: {
              maxRetries: config.maxRetries ?? 5,
              initialReconnectionDelay: config.initialReconnectionDelay ?? 1000,
              maxReconnectionDelay: config.maxReconnectionDelay ?? 60000,
              reconnectionDelayGrowFactor: 1.5,
            },
          })
        }
      }
      throw new Error("Unknown server config type")
    }

    /**
     * Connect to a single MCP server
     */
    private async connectServer(
      name: string,
      config: ServerConfig
    ): Promise<ConnectedServer> {
      if (config.disabled) {
        return {
          name,
          config,
          client: null as unknown as Client,
          tools: [],
          status: "disabled",
        }
      }

      const client = new Client(
        { name: "miriad-code", version: "0.1.0" },
        { capabilities: {} }
      )

      try {
        const transport = this.createTransport(config)

        // Set up stderr logging for stdio transports
        if (transport instanceof StdioClientTransport && transport.stderr) {
          transport.stderr.on("data", (chunk: Buffer) => {
            console.error(`[mcp:${name}] ${chunk.toString().trim()}`)
          })
        }

        // Connect with timeout
        const timeoutMs = config.timeout ?? 30000
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection timeout")), timeoutMs)
          ),
        ])

        // Get available tools
        const toolsResult = await client.listTools()
        const tools = toolsResult.tools

        // Capture session ID for HTTP transports (enables session resumption)
        let sessionId: string | undefined
        if (transport instanceof StreamableHTTPClientTransport) {
          sessionId = transport.sessionId
          if (sessionId) {
            console.error(`[mcp:${name}] Connected with session ${sessionId.slice(0, 8)}..., ${tools.length} tools available`)
          } else {
            console.error(`[mcp:${name}] Connected (no session), ${tools.length} tools available`)
          }
        } else {
          console.error(`[mcp:${name}] Connected, ${tools.length} tools available`)
        }

        return {
          name,
          config,
          client,
          tools,
          status: "connected",
          sessionId,
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        console.error(`[mcp:${name}] Failed to connect: ${error}`)
        return {
          name,
          config,
          client,
          tools: [],
          status: "failed",
          error,
        }
      }
    }

    /**
     * Initialize all MCP servers from config
     */
    async initialize(config?: ConfigType): Promise<void> {
      const mcpConfig = config ?? (await loadConfig())

      // Close any existing connections
      await this.shutdown()

      if (!mcpConfig.mcpServers) return

      // Connect to all servers in parallel
      const entries = Object.entries(mcpConfig.mcpServers)
      const results = await Promise.all(
        entries.map(([name, serverConfig]) =>
          this.connectServer(name, serverConfig)
        )
      )

      // Store connected servers
      for (const server of results) {
        this.servers.set(server.name, server)
      }

      const connected = results.filter((s) => s.status === "connected").length
      const failed = results.filter((s) => s.status === "failed").length
      const disabled = results.filter((s) => s.status === "disabled").length

      if (entries.length > 0) {
        console.error(
          `[mcp] Initialized: ${connected} connected, ${failed} failed, ${disabled} disabled`
        )
      }
    }

    /**
     * Shutdown all MCP connections
     */
    async shutdown(): Promise<void> {
      for (const [name, server] of this.servers) {
        if (server.status === "connected") {
          try {
            await server.client.close()
            console.error(`[mcp:${name}] Disconnected`)
          } catch {
            // Ignore close errors
          }
        }
      }
      this.servers.clear()
    }

    /**
     * Get status of all servers
     */
    getStatus(): Array<{
      name: string
      status: string
      toolCount: number
      error?: string
    }> {
      return Array.from(this.servers.values()).map((s) => ({
        name: s.name,
        status: s.status,
        toolCount: s.tools.length,
        error: s.error,
      }))
    }

    /**
     * List all available tool names
     */
    listTools(): string[] {
      const tools: string[] = []
      for (const [serverName, server] of this.servers) {
        if (server.status !== "connected") continue
        for (const mcpTool of server.tools) {
          tools.push(`${serverName}__${mcpTool.name}`)
        }
      }
      return tools
    }

    /**
     * Convert MCP tool to AI SDK tool format
     */
    private convertMcpTool(serverName: string, mcpTool: Tool, client: Client) {
      return tool({
        description: mcpTool.description ?? `MCP tool: ${mcpTool.name}`,
        parameters: jsonSchema(mcpTool.inputSchema as any),
        execute: async (args) => {
          try {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: args as Record<string, unknown>,
            })

            // Check for MCP-level errors in the result
            if ("isError" in result && result.isError) {
              const content = "content" in result && Array.isArray(result.content) ? result.content : []
              const errorContent = content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n")
              return `Error: ${errorContent || "Tool execution failed"}`
            }

            // Extract text content from result
            if ("content" in result && Array.isArray(result.content)) {
              const textParts = result.content
                .filter(
                  (c): c is { type: "text"; text: string } => c.type === "text"
                )
                .map((c) => c.text)
              return textParts.join("\n")
            }

            // Fallback to JSON stringification
            return JSON.stringify(result)
          } catch (error) {
            // Connection errors, timeouts, etc. - return error to agent instead of crashing
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[mcp:${serverName}] Tool ${mcpTool.name} failed: ${message}`)
            return `Error: MCP tool call failed - ${message}. The server may be temporarily unavailable.`
          }
        },
      })
    }

    /**
     * Get all MCP tools as AI SDK tools
     * Tool names are prefixed with server name: "serverName__toolName"
     */
    getTools() {
      const tools: Record<string, any> = {}

      for (const [serverName, server] of this.servers) {
        if (server.status !== "connected") continue

        for (const mcpTool of server.tools) {
          const toolName = `${serverName}__${mcpTool.name}`
          tools[toolName] = this.convertMcpTool(
            serverName,
            mcpTool,
            server.client
          )
        }
      }

      return tools
    }
  }

  // ============================================================================
  // Singleton Instance with Config Change Detection
  // ============================================================================

  let manager: Manager | null = null
  let lastConfigHash: string | null = null

  /**
   * Compute a simple hash of the config for change detection
   */
  function hashConfig(config: ConfigType): string {
    return JSON.stringify(config)
  }

  /**
   * Get the singleton manager instance
   */
  export function getManager(): Manager {
    if (!manager) {
      manager = new Manager()
    }
    return manager
  }

  /**
   * Check if MCP is already initialized
   */
  export function isInitialized(): boolean {
    return manager !== null && lastConfigHash !== null
  }

  /**
   * Initialize MCP with config.
   * Only reinitializes if config has changed or not yet initialized.
   * Returns true if initialization was performed, false if skipped.
   */
  export async function initialize(config?: ConfigType): Promise<boolean> {
    const mcpConfig = config ?? (await loadConfig())
    const configHash = hashConfig(mcpConfig)

    // Skip if already initialized with same config
    if (manager && lastConfigHash === configHash) {
      return false
    }

    // Initialize (or reinitialize with new config)
    await getManager().initialize(mcpConfig)
    lastConfigHash = configHash
    return true
  }

  /**
   * Shutdown all MCP connections
   */
  export async function shutdown(): Promise<void> {
    if (manager) {
      await manager.shutdown()
      manager = null
      lastConfigHash = null
    }
  }

  /**
   * Build AI SDK tools from all connected MCP servers
   */
  export function buildAiTools() {
    return getManager().getTools()
  }

  /**
   * Get all MCP tools as AI SDK tools (alias for buildAiTools)
   */
  export function getTools() {
    return getManager().getTools()
  }

  /**
   * Get status of all MCP servers
   */
  export function getStatus() {
    return getManager().getStatus()
  }

  /**
   * Get list of all available MCP tool names
   */
  export function getToolNames(): string[] {
    return getManager().listTools()
  }
}
