/**
 * MCP (Model Context Protocol) client support
 *
 * Provides stdio and streamable-http transports for connecting to MCP servers.
 * Uses Claude-compatible config format for easy migration.
 */

import {z} from 'zod'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js'
import type {Tool} from '@modelcontextprotocol/sdk/types.js'
import {tool} from 'ai'
import {jsonSchema} from 'ai'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

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
    transport: z.enum(['http', 'sse']).optional().default('http'),
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
    '.config',
    'nuum',
    'mcp.json',
  )
  const CONFIG_ENV_VAR = 'NUUM_MCP_CONFIG'

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
      const content = await fs.readFile(CONFIG_FILE_PATH, 'utf-8')
      const parsed = JSON.parse(content)
      return ConfigSchema.parse(parsed)
    } catch {
      // File doesn't exist or is invalid - return empty config
    }

    // Return empty config
    return {mcpServers: {}}
  }

  // ============================================================================
  // Type Guards
  // ============================================================================

  function isStdioConfig(config: ServerConfig): config is StdioServerConfig {
    return 'command' in config
  }

  function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
    return 'url' in config
  }

  // ============================================================================
  // Tool Name Validation
  // ============================================================================

  /**
   * Anthropic API tool name pattern: letters, numbers, underscores, hyphens, 1-64 chars.
   * MCP spec has no constraints (just `type: string`), but the Anthropic API rejects
   * tool names that don't match this pattern, killing the entire turn.
   */
  const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

  export interface McpServerIssue {
    type: 'invalid_tool_name'
    tool: string // raw MCP tool name
    effectiveName: string // prefixed name that failed validation
    message: string
  }

  /**
   * Validate a tool name against the Anthropic API pattern.
   * Returns null if valid, or an McpServerIssue if invalid.
   */
  export function validateToolName(
    serverName: string,
    mcpToolName: string,
  ): McpServerIssue | null {
    const effectiveName = `${serverName}__${mcpToolName}`
    if (TOOL_NAME_PATTERN.test(effectiveName)) {
      return null
    }

    // Find the first invalid character for a helpful message
    const invalidChars = effectiveName
      .split('')
      .filter((c) => !/[a-zA-Z0-9_-]/.test(c))
    const uniqueInvalid = Array.from(new Set(invalidChars))

    let message: string
    if (effectiveName.length > 64) {
      message = `Effective tool name "${effectiveName}" exceeds 64 character limit (${effectiveName.length} chars)`
    } else if (effectiveName.length === 0) {
      message = `Tool name is empty`
    } else {
      message = `Effective tool name "${effectiveName}" contains invalid character(s): ${uniqueInvalid.map((c) => `"${c}"`).join(', ')} (allowed: a-z, A-Z, 0-9, _, -)`
    }

    return {
      type: 'invalid_tool_name',
      tool: mcpToolName,
      effectiveName,
      message,
    }
  }

  // ============================================================================
  // Manager Class
  // ============================================================================

  interface ConnectedServer {
    name: string
    config: ServerConfig
    client: Client
    tools: Tool[] // only valid tools
    allToolCount: number // total tools reported by server (before validation)
    issues: McpServerIssue[]
    status: 'connecting' | 'connected' | 'degraded' | 'failed' | 'disabled'
    error?: string
    sessionId?: string // For HTTP transports - enables session resumption
  }

  export class Manager {
    private servers: Map<string, ConnectedServer> = new Map()
    private _readyPromise: Promise<void> | null = null
    private _shutdownRequested = false

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
          stderr: 'pipe', // Capture stderr for logging
        })
      } else if (isHttpConfig(config)) {
        if (config.transport === 'sse') {
          return new SSEClientTransport(new URL(config.url), {
            requestInit: config.headers ? {headers: config.headers} : undefined,
          })
        } else {
          return new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? {headers: config.headers} : undefined,
            reconnectionOptions: {
              maxRetries: config.maxRetries ?? 5,
              initialReconnectionDelay: config.initialReconnectionDelay ?? 1000,
              maxReconnectionDelay: config.maxReconnectionDelay ?? 60000,
              reconnectionDelayGrowFactor: 1.5,
            },
          })
        }
      }
      throw new Error('Unknown server config type')
    }

    /**
     * Connect to a single MCP server
     */
    private async connectServer(
      name: string,
      config: ServerConfig,
    ): Promise<ConnectedServer> {
      if (config.disabled) {
        return {
          name,
          config,
          client: null as unknown as Client,
          tools: [],
          allToolCount: 0,
          issues: [],
          status: 'disabled',
        }
      }

      const client = new Client(
        {name: 'nuum', version: '0.1.0'},
        {capabilities: {}},
      )

      try {
        const transport = this.createTransport(config)

        // Set up stderr logging for stdio transports
        if (transport instanceof StdioClientTransport && transport.stderr) {
          transport.stderr.on('data', (chunk: Buffer) => {
            console.error(`[mcp:${name}] ${chunk.toString().trim()}`)
          })
        }

        // Connect with timeout
        const timeoutMs = config.timeout ?? 30000
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Connection timeout')),
              timeoutMs,
            ),
          ),
        ])

        // Get available tools
        const toolsResult = await client.listTools()
        const allTools = toolsResult.tools

        // Validate tool names against Anthropic API pattern
        const validTools: Tool[] = []
        const issues: McpServerIssue[] = []

        for (const mcpTool of allTools) {
          const issue = validateToolName(name, mcpTool.name)
          if (issue) {
            issues.push(issue)
            console.error(
              `[mcp:${name}] Skipping tool "${mcpTool.name}": ${issue.message}`,
            )
          } else {
            validTools.push(mcpTool)
          }
        }

        // Capture session ID for HTTP transports (enables session resumption)
        let sessionId: string | undefined
        if (transport instanceof StreamableHTTPClientTransport) {
          sessionId = transport.sessionId
          if (sessionId) {
            console.error(
              `[mcp:${name}] Connected with session ${sessionId.slice(0, 8)}..., ${validTools.length}/${allTools.length} tools available`,
            )
          } else {
            console.error(
              `[mcp:${name}] Connected (no session), ${validTools.length}/${allTools.length} tools available`,
            )
          }
        } else {
          console.error(
            `[mcp:${name}] Connected, ${validTools.length}/${allTools.length} tools available`,
          )
        }

        const status = issues.length > 0 ? 'degraded' : 'connected'

        return {
          name,
          config,
          client,
          tools: validTools,
          allToolCount: allTools.length,
          issues,
          status,
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
          allToolCount: 0,
          issues: [],
          status: 'failed',
          error,
        }
      }
    }

    /**
     * Initialize all MCP servers from config.
     * Non-blocking: registers servers as 'connecting' immediately,
     * then connects in the background. Use ready() to wait for all
     * connections to settle.
     */
    async initialize(config?: ConfigType): Promise<void> {
      const mcpConfig = config ?? (await loadConfig())

      // Close any existing connections
      await this.shutdown()

      if (!mcpConfig.mcpServers) return

      const entries = Object.entries(mcpConfig.mcpServers)

      // Register all servers as 'connecting' immediately (disabled servers get their final status)
      for (const [name, serverConfig] of entries) {
        if (serverConfig.disabled) {
          this.servers.set(name, {
            name,
            config: serverConfig,
            client: null as unknown as Client,
            tools: [],
            allToolCount: 0,
            issues: [],
            status: 'disabled',
          })
        } else {
          this.servers.set(name, {
            name,
            config: serverConfig,
            client: null as unknown as Client,
            tools: [],
            allToolCount: 0,
            issues: [],
            status: 'connecting',
          })
        }
      }

      // Connect all servers in parallel in the background
      this._shutdownRequested = false
      this._readyPromise = this.connectAllServers(entries)
    }

    /**
     * Connect all servers and update their status as they complete.
     */
    private async connectAllServers(
      entries: [string, ServerConfig][],
    ): Promise<void> {
      const nonDisabled = entries.filter(([, config]) => !config.disabled)

      // Connect in parallel, updating each server as it completes
      await Promise.allSettled(
        nonDisabled.map(async ([name, serverConfig]) => {
          const result = await this.connectServer(name, serverConfig)
          // If shutdown was requested while connecting, close immediately
          if (this._shutdownRequested) {
            if (result.status === 'connected' || result.status === 'degraded') {
              try { await result.client.close() } catch {}
            }
            return
          }
          // Update the server entry in-place as soon as it connects
          this.servers.set(name, result)
          const icon = result.status === 'connected' ? '✅' :
            result.status === 'degraded' ? '⚠️' : '❌'
          console.error(
            `[mcp:${name}] ${icon} ${result.status === 'connected' || result.status === 'degraded'
              ? `Connected (${result.tools.length}/${result.allToolCount} tools)`
              : `Failed: ${result.error}`}`,
          )
        }),
      )

      if (this._shutdownRequested) return

      // Log summary
      const allServers = Array.from(this.servers.values())
      const connected = allServers.filter((s) => s.status === 'connected').length
      const degraded = allServers.filter((s) => s.status === 'degraded').length
      const failed = allServers.filter((s) => s.status === 'failed').length
      const disabled = allServers.filter((s) => s.status === 'disabled').length

      if (entries.length > 0) {
        const parts = [`${connected} connected`]
        if (degraded > 0) parts.push(`${degraded} degraded`)
        if (failed > 0) parts.push(`${failed} failed`)
        if (disabled > 0) parts.push(`${disabled} disabled`)
        console.error(`[mcp] All settled: ${parts.join(', ')}`)
      }
    }

    /**
     * Wait for all MCP servers to finish connecting (or fail).
     * Use this when you need to ensure all servers are settled before proceeding.
     */
    async ready(): Promise<void> {
      if (this._readyPromise) {
        await this._readyPromise
      }
    }

    /**
     * Shutdown all MCP connections.
     * Signals background connections to abort and closes established connections.
     */
    async shutdown(): Promise<void> {
      // Signal background connections to abort
      this._shutdownRequested = true

      // Close any already-connected servers
      for (const [name, server] of this.servers) {
        if (server.status === 'connected' || server.status === 'degraded') {
          try {
            await server.client.close()
            console.error(`[mcp:${name}] Disconnected`)
          } catch {
            // Ignore close errors
          }
        }
      }
      this.servers.clear()

      // Wait for background connections to finish (they'll see _shutdownRequested and clean up)
      if (this._readyPromise) {
        await this._readyPromise.catch(() => {})
        this._readyPromise = null
      }
    }

    /**
     * Get status of all servers
     */
    getStatus(): Array<{
      name: string
      status: string
      toolCount: number
      activeToolCount: number
      issues: McpServerIssue[]
      error?: string
    }> {
      return Array.from(this.servers.values()).map((s) => ({
        name: s.name,
        status: s.status,
        toolCount: s.allToolCount,
        activeToolCount: s.tools.length,
        issues: s.issues,
        error: s.error,
      }))
    }

    /**
     * List all available tool names (only valid tools from connected/degraded servers)
     */
    listTools(): string[] {
      const tools: string[] = []
      for (const [serverName, server] of this.servers) {
        if (server.status !== 'connected' && server.status !== 'degraded')
          continue
        for (const mcpTool of server.tools) {
          tools.push(`${serverName}__${mcpTool.name}`)
        }
      }
      return tools
    }

    /**
     * Check if a tool name belongs to a server that's still connecting.
     * Returns the server name if so, null otherwise.
     */
    getConnectingServerForTool(toolName: string): string | null {
      // Tool names are formatted as "serverName__toolName"
      const sep = toolName.indexOf('__')
      if (sep === -1) return null
      const serverName = toolName.slice(0, sep)
      const server = this.servers.get(serverName)
      if (server && server.status === 'connecting') {
        return serverName
      }
      return null
    }

    /**
     * Check if a tool name belongs to a server that failed to connect.
     * Returns the error message if so, null otherwise.
     */
    getFailedServerForTool(toolName: string): { serverName: string, error: string } | null {
      const sep = toolName.indexOf('__')
      if (sep === -1) return null
      const serverName = toolName.slice(0, sep)
      const server = this.servers.get(serverName)
      if (server && server.status === 'failed') {
        return { serverName, error: server.error ?? 'Unknown error' }
      }
      return null
    }

    /**
     * Check if a tool name belongs to a connected/degraded server and exists there.
     * Returns the server name if found, null otherwise.
     */
    getConnectedServerForTool(toolName: string): string | null {
      const sep = toolName.indexOf('__')
      if (sep === -1) return null
      const serverName = toolName.slice(0, sep)
      const mcpToolName = toolName.slice(sep + 2)
      const server = this.servers.get(serverName)
      if (!server) return null
      if (server.status !== 'connected' && server.status !== 'degraded') {
        return null
      }
      if (server.tools.some((t) => t.name === mcpToolName)) {
        return serverName
      }
      return null
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
            if ('isError' in result && result.isError) {
              const content =
                'content' in result && Array.isArray(result.content)
                  ? result.content
                  : []
              const errorContent = content
                .filter(
                  (c): c is {type: 'text'; text: string} => c.type === 'text',
                )
                .map((c) => c.text)
                .join('\n')
              return `Error: ${errorContent || 'Tool execution failed'}`
            }

            // Extract text content from result
            if ('content' in result && Array.isArray(result.content)) {
              const textParts = result.content
                .filter(
                  (c): c is {type: 'text'; text: string} => c.type === 'text',
                )
                .map((c) => c.text)
              return textParts.join('\n')
            }

            // Fallback to JSON stringification
            return JSON.stringify(result)
          } catch (error) {
            // Connection errors, timeouts, etc. - return error to agent instead of crashing
            const message =
              error instanceof Error ? error.message : String(error)
            console.error(
              `[mcp:${serverName}] Tool ${mcpTool.name} failed: ${message}`,
            )
            return `Error: MCP tool call failed - ${message}. The server may be temporarily unavailable.`
          }
        },
      })
    }

    /**
     * Get all MCP tools as AI SDK tools
     * Tool names are prefixed with server name: "serverName__toolName"
     * Only includes valid tools from connected/degraded servers.
     */
    getTools() {
      const tools: Record<string, any> = {}

      for (const [serverName, server] of this.servers) {
        if (server.status !== 'connected' && server.status !== 'degraded')
          continue

        for (const mcpTool of server.tools) {
          const toolName = `${serverName}__${mcpTool.name}`
          tools[toolName] = this.convertMcpTool(
            serverName,
            mcpTool,
            server.client,
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
  function canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonicalize)
    const obj = value as Record<string, unknown>
    const sorted = Object.keys(obj)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, canonicalize(obj[key])] as const)
    return Object.fromEntries(sorted)
  }

  function hashConfig(config: ConfigType): string {
    return JSON.stringify(canonicalize(config))
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
   * Wait for all MCP servers to finish connecting (or fail).
   */
  export async function ready(): Promise<void> {
    if (manager) {
      await manager.ready()
    }
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
