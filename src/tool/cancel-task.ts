/**
 * Cancel Task Tool
 *
 * Cancels a running background task.
 * Note: This marks the task as cancelled but cannot stop an already-running Promise.
 * The task will complete but its results will be discarded.
 */

import {z} from 'zod'
import type {TasksStorage} from '../storage'
import {Tool} from './tool'

/**
 * Context required for cancel_task tool.
 */
export interface CancelTaskToolContext {
  tasks: TasksStorage
}

export interface CancelTaskMetadata {
  taskId: string
  success: boolean
}

const DESCRIPTION = `Cancel a running background task.

Note: This marks the task as cancelled, but cannot stop work already in progress.
The task may still complete, but its results will be discarded.

Use list_tasks to see running tasks and their IDs.`

const parameters = z.object({
  taskId: z.string().describe('The task ID to cancel (from list_tasks)'),
})

export const CancelTaskTool = Tool.define<
  typeof parameters,
  CancelTaskMetadata
>('cancel_task', {
  description: DESCRIPTION,
  parameters,
  async execute({taskId}, ctx) {
    // Get tasks storage from context extra
    const tasksStorage = (ctx as Tool.Context & {extra: CancelTaskToolContext})
      .extra?.tasks

    if (!tasksStorage) {
      return {
        output: 'Error: Tasks storage not available',
        title: 'Cancel task failed',
        metadata: {
          taskId,
          success: false,
        },
      }
    }

    // Get the task
    const task = await tasksStorage.getTask(taskId)

    if (!task) {
      return {
        output: `Task not found: ${taskId}`,
        title: 'Task not found',
        metadata: {
          taskId,
          success: false,
        },
      }
    }

    if (task.status !== 'running') {
      return {
        output: `Task ${taskId} is not running (status: ${task.status})`,
        title: 'Cannot cancel',
        metadata: {
          taskId,
          success: false,
        },
      }
    }

    // Mark as failed with cancellation message
    await tasksStorage.failTask(taskId, 'Cancelled by user')

    return {
      output: `Task ${taskId} marked as cancelled.\nNote: The task may still complete in the background, but results will be discarded.`,
      title: 'Task cancelled',
      metadata: {
        taskId,
        success: true,
      },
    }
  },
})
