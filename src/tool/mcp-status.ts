/**
 * MCP status inspection tool.
 * 
 * Allows the agent to see what MCP servers are configured,
 * their connection status, and what tools are available.
 */

import { z } from "zod"
import { Tool } from "./tool"
import { Mcp } from "../mcp"

export interface McpStatusMetadata {
  serverCount: number
  connectedCount: number
  toolCount: number
}

const parameters = z.object({})

export const McpStatusTool = Tool.define<typeof parameters, McpStatusMetadata>(
  "mcp_status",
  {
    description: `Inspect MCP (Model Context Protocol) server status.

Shows:
- Configured MCP servers and their connection status
- Available tools from each connected server
- Any connection errors

Use this when:
- A tool you expect isn't available
- You want to see what MCP capabilities are configured
- Debugging MCP connection issues`,
    parameters,
    async execute(_args, _ctx) {
      const status = Mcp.getStatus()
      const toolNames = Mcp.getToolNames()
      
      let output = "## MCP Server Status\n\n"
      
      if (status.length === 0) {
        output += "No MCP servers configured.\n"
        return {
          output,
          title: "MCP Status",
          metadata: {
            serverCount: 0,
            connectedCount: 0,
            toolCount: 0,
          },
        }
      }
      
      let connectedCount = 0
      
      for (const server of status) {
        const statusIcon = server.status === "connected" ? "✓" : 
                          server.status === "connecting" ? "⋯" : "✗"
        
        output += `### ${server.name} ${statusIcon}\n`
        output += `- Status: ${server.status}\n`
        
        if (server.status === "connected") {
          connectedCount++
          output += `- Tools: ${server.toolCount}\n`
          
          // List tools from this server
          const serverTools = toolNames.filter(t => t.startsWith(`${server.name}__`))
          if (serverTools.length > 0) {
            output += `- Available:\n`
            for (const tool of serverTools) {
              const toolName = tool.replace(`${server.name}__`, "")
              output += `  - ${toolName}\n`
            }
          }
        } else if (server.error) {
          output += `- Error: ${server.error}\n`
        }
        
        output += "\n"
      }
      
      output += `---\n`
      output += `**Summary:** ${connectedCount}/${status.length} servers connected, ${toolNames.length} tools available\n`
      
      return {
        output,
        title: "MCP Status",
        metadata: {
          serverCount: status.length,
          connectedCount,
          toolCount: toolNames.length,
        },
      }
    },
  }
)
