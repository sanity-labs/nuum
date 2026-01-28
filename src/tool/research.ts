/**
 * Research tool - investigates topics and builds knowledge in LTM.
 *
 * This tool spawns a sub-agent that has access to:
 * - Full LTM management (search, read, create, update, archive)
 * - Web search and fetch
 * - Conversation history search
 * - File system read access
 *
 * Use this when you need to:
 * - Deeply understand something before implementing
 * - Document a service, API, or system
 * - Build a profile of a company or technology
 * - Research best practices or prior art
 */

import { z } from "zod"
import { Tool } from "./tool"
import type { Storage } from "../storage"
import { runResearch } from "../research"

export interface ResearchMetadata {
  topic: string
  turnsUsed: number
  entriesCreated: string[]
  entriesUpdated: string[]
  inputTokens: number
  outputTokens: number
}

const DESCRIPTION = `Investigate a topic and build knowledge in your long-term memory.

This spawns a research sub-agent that can:
- Search and update your long-term knowledge base
- Search the web and fetch documentation
- Search your conversation history
- Read files in the codebase

Use this when you need to:
- Deeply understand something before implementing
- Document a service, API, or system
- Build a profile of a company or technology
- Research best practices or prior art

The sub-agent will research thoroughly and return a report of what it learned and what LTM entries it created or updated.`

const parameters = z.object({
  topic: z.string().describe(
    "The topic to research. Be specific about what you want to learn. Examples: 'How does Stripe's payment intent API work?', 'Document the authentication flow in our codebase', 'Research best practices for rate limiting'"
  ),
})

export const ResearchTool = Tool.define<typeof parameters, ResearchMetadata>(
  "research",
  {
    description: DESCRIPTION,
    parameters,
    async execute({ topic }, ctx) {
      // Get storage from context extra
      const storage = (ctx as Tool.Context & { extra: { storage: Storage } }).extra?.storage
      
      if (!storage) {
        return {
          output: "Error: Storage not available for research",
          title: "Research failed",
          metadata: {
            topic,
            turnsUsed: 0,
            entriesCreated: [],
            entriesUpdated: [],
            inputTokens: 0,
            outputTokens: 0,
          },
        }
      }

      try {
        const result = await runResearch(storage, topic)

        return {
          output: result.report,
          title: `Researched: ${topic.slice(0, 40)}${topic.length > 40 ? "..." : ""}`,
          metadata: {
            topic,
            turnsUsed: result.turnsUsed,
            entriesCreated: result.entriesCreated,
            entriesUpdated: result.entriesUpdated,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return {
          output: `Research failed: ${errorMsg}`,
          title: "Research error",
          metadata: {
            topic,
            turnsUsed: 0,
            entriesCreated: [],
            entriesUpdated: [],
            inputTokens: 0,
            outputTokens: 0,
          },
        }
      }
    },
  },
)

/**
 * Context type for research tool - needs storage access.
 */
export interface ResearchToolContext {
  storage: Storage
}
