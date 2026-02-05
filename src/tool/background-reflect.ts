/**
 * Background Reflect Tool
 *
 * Spawns a reflection task in the background and returns immediately.
 * The reflection runs asynchronously and results are delivered when complete.
 */

import {z} from 'zod'
import type {Storage} from '../storage'
import {Tool} from './tool'
import {runReflection} from '../reflection'
import {Log} from '../util/log'

const log = Log.create({service: 'background-reflect'})

/**
 * Context required for background_reflect tool.
 */
export interface BackgroundReflectToolContext {
  storage: Storage
}

export interface BackgroundReflectMetadata {
  taskId: string
  question: string
}

const DESCRIPTION = `Start a reflection task in the background.

This spawns a reflection sub-agent that runs asynchronously while you continue working.
When the reflection completes, you'll receive the answer automatically.

Use this when:
- You want to search your memory without blocking your current work
- The question might require extensive searching
- You want to parallelize multiple reflection tasks

The reflection agent can:
- Search your conversation history with full-text search
- Retrieve specific messages with surrounding context
- Search and read your long-term knowledge base

Example: background_reflect({ question: "What did we decide about the API authentication approach?" })`

const parameters = z.object({
  question: z
    .string()
    .describe(
      "The question to answer or research task to complete. Be specific about what you're looking for.",
    ),
})

export const BackgroundReflectTool = Tool.define<
  typeof parameters,
  BackgroundReflectMetadata
>('background_reflect', {
  description: DESCRIPTION,
  parameters,
  async execute({question}, ctx) {
    // Get storage from context extra
    const storage = (
      ctx as Tool.Context & {extra: BackgroundReflectToolContext}
    ).extra?.storage

    if (!storage) {
      return {
        output: 'Error: Storage not available for background reflection',
        title: 'Background reflection failed',
        metadata: {
          taskId: '',
          question,
        },
      }
    }

    // Check for max concurrent tasks (prevent runaway spawning)
    const MAX_CONCURRENT_TASKS = 3
    const runningTasks = await storage.tasks.listTasks({status: 'running'})
    if (runningTasks.length >= MAX_CONCURRENT_TASKS) {
      return {
        output: `Too many background tasks running (${runningTasks.length}/${MAX_CONCURRENT_TASKS}). Wait for some to complete or cancel them with cancel_task.`,
        title: 'Too many tasks',
        metadata: {
          taskId: '',
          question,
        },
      }
    }

    // Create the task record (storage layer publishes BackgroundTasksChanged event)
    const taskId = await storage.tasks.createTask({
      type: 'reflect',
      description:
        question.slice(0, 100) + (question.length > 100 ? '...' : ''),
    })

    log.info('spawning background reflection', {
      taskId,
      question: question.slice(0, 50),
    })

    // Spawn the reflection in the background (fire and forget)
    runBackgroundReflection(storage, taskId, question).catch((error) => {
      log.error('background reflection failed', {taskId, error})
    })

    return {
      output: `🔍 Reflection started in background.\nTask ID: ${taskId}\nQuestion: "${question}"\n\nYou'll receive the answer when the reflection completes. Use list_tasks to check status.`,
      title: `Reflection started: ${question.slice(0, 30)}...`,
      metadata: {
        taskId,
        question,
      },
    }
  },
})

/**
 * Run reflection in the background and update task status when done.
 */
async function runBackgroundReflection(
  storage: Storage,
  taskId: string,
  question: string,
): Promise<void> {
  try {
    const result = await runReflection(storage, question)

    // Format the result for the agent
    const report = [
      `## Reflection Complete: ${question}`,
      '',
      result.answer,
      '',
      `---`,
      `*Reflection used ${result.turnsUsed} turns, ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens*`,
    ].join('\n')

    // Mark task as completed (storage layer publishes BackgroundTasksChanged event)
    await storage.tasks.completeTask(taskId, {
      answer: result.answer,
      turnsUsed: result.turnsUsed,
      usage: result.usage,
    })

    // Queue the result for delivery
    await storage.tasks.queueResult(taskId, report)

    log.info('background reflection completed', {
      taskId,
      turnsUsed: result.turnsUsed,
    })
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    // Mark task as failed (storage layer publishes BackgroundTasksChanged event)
    await storage.tasks.failTask(taskId, errorMsg)

    // Queue the error for delivery
    await storage.tasks.queueResult(
      taskId,
      `## Reflection Failed: ${question}\n\nError: ${errorMsg}`,
    )

    log.error('background reflection failed', {taskId, error: errorMsg})
  }
}
