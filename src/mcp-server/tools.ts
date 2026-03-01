/**
 * MCP tool definitions for the Nuum MCP server.
 *
 * Tools: list_agents, create_agent, send_message
 */

import {z} from 'zod'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {AgentPool} from './agent-pool'
import {runAgent} from '../agent'

export function registerTools(mcp: McpServer, pool: AgentPool): void {
  // ---------------------------------------------------------------------------
  // list_agents
  // ---------------------------------------------------------------------------
  mcp.tool('list_agents', 'List all persistent Nuum agents', {}, async () => {
    try {
      const agents = await pool.listAgents()
      return {
        content: [{type: 'text', text: JSON.stringify(agents, null, 2)}],
      }
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        ],
      }
    }
  })

  // ---------------------------------------------------------------------------
  // create_agent
  // ---------------------------------------------------------------------------
  mcp.tool(
    'create_agent',
    'Create a new persistent Nuum agent with its own memory database',
    {
      name: z
        .string()
        .describe(
          'Agent name (lowercase letters, digits, hyphens, underscores)',
        ),
      system_prompt: z
        .string()
        .optional()
        .describe('Optional system prompt / mission for the agent'),
    },
    async ({name, system_prompt}) => {
      const validationError = AgentPool.validateName(name)
      if (validationError) {
        return {
          isError: true,
          content: [{type: 'text', text: JSON.stringify({error: validationError})}],
        }
      }

      const releaseFile = await pool.acquireFileLock(name)
      const release = await pool.acquireLock(name)
      try {
        await pool.createAgent(name, system_prompt)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({created: true, name}),
            },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        }
      } finally {
        release()
        releaseFile()
      }
    },
  )

  // ---------------------------------------------------------------------------
  // send_message
  // ---------------------------------------------------------------------------
  mcp.tool(
    'send_message',
    'Send a message to a named Nuum agent. The agent has persistent memory across calls.',
    {
      agent: z.string().describe('Agent name'),
      prompt: z.string().describe('The prompt to send to the agent'),
      create_if_missing: z
        .boolean()
        .default(false)
        .describe('If true, create the agent if it does not exist'),
      system_prompt: z
        .string()
        .optional()
        .describe(
          'System prompt / mission to set on creation (only used when creating a new agent)',
        ),
    },
    async ({agent, prompt, create_if_missing, system_prompt}) => {
      const validationError = AgentPool.validateName(agent)
      if (validationError) {
        return {
          isError: true,
          content: [{type: 'text', text: JSON.stringify({error: validationError})}],
        }
      }

      const releaseFile = await pool.acquireFileLock(agent)
      const release = await pool.acquireLock(agent)
      try {
        // Create if missing
        if (!pool.agentExists(agent)) {
          if (!create_if_missing) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Agent "${agent}" does not exist. Set create_if_missing=true to create it.`,
                  }),
                },
              ],
            }
          }
          await pool.createAgent(agent, system_prompt)
        }

        const storage = await pool.getOrCreateStorage(agent)
        const result = await runAgent(prompt, {storage})

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                response: result.response,
                usage: result.usage,
              }),
            },
          ],
        }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        }
      } finally {
        release()
        releaseFile()
      }
    },
  )
}
