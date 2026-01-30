/**
 * Background Research Tool
 *
 * Spawns a research task in the background and returns immediately.
 * The research runs asynchronously and results are delivered when complete.
 */

import { z } from "zod"
import type { Storage } from "../storage"
import { Tool } from "./tool"
import { runResearch } from "../research"
import { Log } from "../util/log"

const log = Log.create({ service: "background-research" })

/**
 * Context required for background_research tool.
 */
export interface BackgroundResearchToolContext {
  storage: Storage
}

export interface BackgroundResearchMetadata {
  taskId: string
  topic: string
}

const DESCRIPTION = `Start a research task in the background.

This spawns a research sub-agent that runs asynchronously while you continue working.
When the research completes, you'll receive the results automatically.

Use this when:
- You want to research something without blocking your current work
- The research might take a while and you have other things to do
- You want to parallelize multiple research tasks

The research agent can:
- Search and update your long-term knowledge base
- Search the web and fetch documentation
- Search your conversation history
- Read files in the codebase

Example: background_research({ topic: "How does Stripe's payment intent API work?" })`

const parameters = z.object({
  topic: z.string().describe(
    "The topic to research. Be specific about what you want to learn."
  ),
})

export const BackgroundResearchTool = Tool.define<typeof parameters, BackgroundResearchMetadata>(
  "background_research",
  {
    description: DESCRIPTION,
    parameters,
    async execute({ topic }, ctx) {
      // Get storage from context extra
      const storage = (ctx as Tool.Context & { extra: BackgroundResearchToolContext }).extra?.storage

      if (!storage) {
        return {
          output: "Error: Storage not available for background research",
          title: "Background research failed",
          metadata: {
            taskId: "",
            topic,
          },
        }
      }

      // Check for max concurrent tasks (prevent runaway spawning)
      const MAX_CONCURRENT_TASKS = 3
      const runningTasks = await storage.tasks.listTasks({ status: "running" })
      if (runningTasks.length >= MAX_CONCURRENT_TASKS) {
        return {
          output: `Too many background tasks running (${runningTasks.length}/${MAX_CONCURRENT_TASKS}). Wait for some to complete or cancel them with cancel_task.`,
          title: "Too many tasks",
          metadata: {
            taskId: "",
            topic,
          },
        }
      }

      // Create the task record
      const taskId = await storage.tasks.createTask({
        type: "research",
        description: topic.slice(0, 100) + (topic.length > 100 ? "..." : ""),
      })

      log.info("spawning background research", { taskId, topic: topic.slice(0, 50) })

      // Spawn the research in the background (fire and forget)
      // The promise runs independently and updates the task when done
      runBackgroundResearch(storage, taskId, topic).catch((error) => {
        log.error("background research failed", { taskId, error })
      })

      return {
        output: `🔬 Research started in background.\nTask ID: ${taskId}\nTopic: "${topic}"\n\nYou'll receive the results when the research completes. Use list_tasks to check status.`,
        title: `Research started: ${topic.slice(0, 30)}...`,
        metadata: {
          taskId,
          topic,
        },
      }
    },
  },
)

/**
 * Run research in the background and update task status when done.
 */
async function runBackgroundResearch(
  storage: Storage,
  taskId: string,
  topic: string,
): Promise<void> {
  try {
    const result = await runResearch(storage, topic)

    // Format the result for the agent
    const entriesCreated = result.entriesCreated.length
    const entriesUpdated = result.entriesUpdated.length
    const report = [
      `## Research Complete: ${topic}`,
      "",
      result.report,
      "",
      `---`,
      `*Research used ${result.turnsUsed} turns, ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens*`,
      entriesCreated > 0 ? `*Created ${entriesCreated} LTM entries: ${result.entriesCreated.join(", ")}*` : "",
      entriesUpdated > 0 ? `*Updated ${entriesUpdated} LTM entries: ${result.entriesUpdated.join(", ")}*` : "",
    ].filter(Boolean).join("\n")

    // Mark task as completed
    await storage.tasks.completeTask(taskId, {
      report: result.report,
      entriesCreated: result.entriesCreated,
      entriesUpdated: result.entriesUpdated,
      turnsUsed: result.turnsUsed,
      usage: result.usage,
    })

    // Queue the result for delivery
    await storage.tasks.queueResult(taskId, report)

    log.info("background research completed", { 
      taskId, 
      turnsUsed: result.turnsUsed,
      entriesCreated,
      entriesUpdated,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    
    // Mark task as failed
    await storage.tasks.failTask(taskId, errorMsg)

    // Queue the error for delivery
    await storage.tasks.queueResult(
      taskId,
      `## Research Failed: ${topic}\n\nError: ${errorMsg}`
    )

    log.error("background research failed", { taskId, error: errorMsg })
  }
}
