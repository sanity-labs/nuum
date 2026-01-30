/**
 * List Tasks Tool
 *
 * Shows background tasks (research, reflect) and alarms.
 * Gives the agent visibility into what's running and scheduled.
 */

import { z } from "zod"
import type { TasksStorage, BackgroundTask, Alarm } from "../storage"
import { Tool } from "./tool"

/**
 * Context required for list_tasks tool.
 */
export interface ListTasksToolContext {
  tasks: TasksStorage
}

export interface ListTasksMetadata {
  runningCount: number
  alarmCount: number
  completedCount: number
}

/**
 * Format elapsed time in human-readable form.
 */
function formatElapsed(startTime: string): string {
  const start = new Date(startTime).getTime()
  const now = Date.now()
  const elapsed = Math.floor((now - start) / 1000)

  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
  const hours = Math.floor(elapsed / 3600)
  const mins = Math.floor((elapsed % 3600) / 60)
  return `${hours}h ${mins}m`
}

/**
 * Format time until alarm fires.
 */
function formatTimeUntil(firesAt: string): string {
  const fires = new Date(firesAt).getTime()
  const now = Date.now()
  const remaining = Math.floor((fires - now) / 1000)

  if (remaining <= 0) return "due now"
  if (remaining < 60) return `in ${remaining}s`
  if (remaining < 3600) return `in ${Math.floor(remaining / 60)}m`
  const hours = Math.floor(remaining / 3600)
  const mins = Math.floor((remaining % 3600) / 60)
  return `in ${hours}h ${mins}m`
}

/**
 * Format a task for display.
 */
function formatTask(task: BackgroundTask): string {
  const elapsed = formatElapsed(task.createdAt)
  const statusIcon = {
    running: "🔄",
    completed: "✅",
    failed: "❌",
    killed: "💀",
  }[task.status]

  let line = `${statusIcon} #${task.id.slice(-8)} ${task.type}: "${task.description}" (${task.status}, ${elapsed})`

  if (task.error) {
    line += `\n   Error: ${task.error}`
  }

  return line
}

/**
 * Format an alarm for display.
 */
function formatAlarm(alarm: Alarm): string {
  const timeUntil = formatTimeUntil(alarm.firesAt)
  return `⏰ #${alarm.id.slice(-8)}: "${alarm.note}" (${timeUntil})`
}

const DESCRIPTION = `List background tasks and alarms.

Shows:
- Running background tasks (research, reflect)
- Scheduled alarms (notes to self)
- Recent completed/failed tasks (if includeCompleted=true)

Use this to see what's in progress or scheduled.`

const parameters = z.object({
  includeCompleted: z
    .boolean()
    .optional()
    .describe("Include completed/failed tasks (default: false, only shows running)"),
})

export const ListTasksTool = Tool.define<typeof parameters, ListTasksMetadata>(
  "list_tasks",
  {
    description: DESCRIPTION,
    parameters,
    async execute({ includeCompleted }, ctx) {
      // Get tasks storage from context extra
      const tasksStorage = (ctx as Tool.Context & { extra: ListTasksToolContext }).extra?.tasks

      if (!tasksStorage) {
        return {
          output: "Error: Tasks storage not available",
          title: "List tasks failed",
          metadata: {
            runningCount: 0,
            alarmCount: 0,
            completedCount: 0,
          },
        }
      }

      // Get tasks
      const allTasks = await tasksStorage.listTasks({ limit: 20 })
      const runningTasks = allTasks.filter((t: BackgroundTask) => t.status === "running")
      const completedTasks = allTasks.filter((t: BackgroundTask) => t.status !== "running")

      // Get alarms
      const alarms = await tasksStorage.listAlarms()

      // Build output
      const lines: string[] = []

      // Running tasks
      if (runningTasks.length > 0) {
        lines.push("**Running Tasks:**")
        for (const task of runningTasks) {
          lines.push(formatTask(task))
        }
      }

      // Alarms
      if (alarms.length > 0) {
        if (lines.length > 0) lines.push("")
        lines.push("**Scheduled Alarms:**")
        for (const alarm of alarms) {
          lines.push(formatAlarm(alarm))
        }
      }

      // Completed tasks (if requested)
      if (includeCompleted && completedTasks.length > 0) {
        if (lines.length > 0) lines.push("")
        lines.push("**Recent Completed/Failed:**")
        for (const task of completedTasks.slice(0, 10)) {
          lines.push(formatTask(task))
        }
      }

      // Empty state
      if (lines.length === 0) {
        return {
          output: "No background tasks or alarms.",
          title: "No tasks",
          metadata: {
            runningCount: 0,
            alarmCount: 0,
            completedCount: 0,
          },
        }
      }

      return {
        output: lines.join("\n"),
        title: `${runningTasks.length} running, ${alarms.length} alarms`,
        metadata: {
          runningCount: runningTasks.length,
          alarmCount: alarms.length,
          completedCount: completedTasks.length,
        },
      }
    },
  },
)
