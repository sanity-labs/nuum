/**
 * System status inspection tool.
 *
 * Shows runtime information: version, models, MCP servers, and configuration.
 * Renamed from mcp_status to system_status to reflect broader scope.
 */

import {z} from 'zod'
import {Tool} from './tool'
import {Mcp} from '../mcp'
import {Config} from '../config'
import {VERSION, GIT_HASH} from '../version'

export interface SystemStatusMetadata {
  version: string
  gitHash: string
  models: {reasoning: string; workhorse: string; fast: string}
  mcpServerCount: number
  mcpConnectedCount: number
  mcpToolCount: number
}

const parameters = z.object({})

export const SystemStatusTool = Tool.define<
  typeof parameters,
  SystemStatusMetadata
>('system_status', {
  description: `Get system status including version, models, and MCP server connections.

Shows:
- Nuum version and git hash
- Configured models (reasoning, workhorse, fast tiers)
- MCP server connection status and available tools

Use this when:
- You want to verify what version of nuum is running
- You need to check which models are configured
- A tool you expect isn't available
- Debugging MCP connection issues`,
  parameters,
  async execute(_args, _ctx) {
    const config = Config.get()
    const mcpStatus = Mcp.getStatus()
    const mcpToolNames = Mcp.getToolNames()

    let output = '## System Status\n\n'

    // Version info
    output += `### Version\n`
    output += `- **nuum** v${VERSION} (${GIT_HASH})\n\n`

    // Model configuration
    output += `### Models\n`
    output += `- **Reasoning:** ${config.models.reasoning}\n`
    output += `- **Workhorse:** ${config.models.workhorse}\n`
    output += `- **Fast:** ${config.models.fast}\n\n`

    // MCP servers
    output += `### MCP Servers\n\n`

    if (mcpStatus.length === 0) {
      output += 'No MCP servers configured.\n'
    } else {
      let connectedCount = 0

      for (const server of mcpStatus) {
        const statusIcon =
          server.status === 'connected'
            ? '✓'
            : server.status === 'degraded'
              ? '⚠'
              : server.status === 'connecting'
                ? '⋯'
                : '✗'

        output += `**${server.name}** ${statusIcon}\n`

        if (
          server.status === 'connected' ||
          server.status === 'degraded'
        ) {
          connectedCount++
          const serverTools = mcpToolNames.filter((t) =>
            t.startsWith(`${server.name}__`),
          )
          if (server.status === 'degraded') {
            output += `- ${server.activeToolCount}/${server.toolCount} tools active: ${serverTools.map((t) => t.replace(`${server.name}__`, '')).join(', ')}\n`
            for (const issue of server.issues) {
              output += `  - ⚠ Skipped "${issue.tool}": ${issue.message}\n`
            }
          } else {
            output += `- ${server.toolCount} tools: ${serverTools.map((t) => t.replace(`${server.name}__`, '')).join(', ')}\n`
          }
        } else if (server.error) {
          output += `- Error: ${server.error}\n`
        } else {
          output += `- Status: ${server.status}\n`
        }

        output += '\n'
      }

      const totalTools = mcpToolNames.length
      output += `---\n`
      output += `**MCP Summary:** ${connectedCount}/${mcpStatus.length} servers connected, ${totalTools} tools available\n`

      return {
        output,
        title: 'System Status',
        metadata: {
          version: VERSION,
          gitHash: GIT_HASH,
          models: config.models,
          mcpServerCount: mcpStatus.length,
          mcpConnectedCount: connectedCount,
          mcpToolCount: totalTools,
        },
      }
    }

    return {
      output,
      title: 'System Status',
      metadata: {
        version: VERSION,
        gitHash: GIT_HASH,
        models: config.models,
        mcpServerCount: 0,
        mcpConnectedCount: 0,
        mcpToolCount: 0,
      },
    }
  },
})

// Keep backward compatibility export name for imports
export const McpStatusTool = SystemStatusTool
