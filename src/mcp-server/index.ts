/**
 * Nuum MCP Server
 *
 * Exposes Nuum over the Model Context Protocol.
 * Other agents (Claude Code, Codex, etc.) can create, list, and converse
 * with persistent Nuum agent instances via MCP tools.
 *
 * Usage: nuum --mcp
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {VERSION} from '../version'
import {AgentPool} from './agent-pool'
import {registerTools} from './tools'
import {initializeMcp, shutdownMcp} from '../agent'

export async function runMcpServer(): Promise<void> {
  const pool = new AgentPool()
  pool.ensureAgentsDir()

  // Initialize outbound MCP clients (Linear, Sentry, etc.) once at startup
  await initializeMcp()

  const mcp = new McpServer(
    {name: 'nuum', version: VERSION},
    {capabilities: {tools: {}}},
  )

  registerTools(mcp, pool)

  const transport = new StdioServerTransport()
  await mcp.connect(transport)

  // Graceful shutdown
  const shutdown = () => {
    pool.closeAll()
    shutdownMcp()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
