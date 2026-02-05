/**
 * Set Alarm Tool
 *
 * Schedules a future self-trigger. When the alarm fires,
 * it queues a message and triggers a new turn if needed.
 */

import {z} from 'zod'
import type {TasksStorage} from '../storage'
import {Tool} from './tool'

/**
 * Context required for set_alarm tool.
 */
export interface SetAlarmToolContext {
  tasks: TasksStorage
}

export interface SetAlarmMetadata {
  alarmId: string
  firesAt: string
  delayMs: number
}

/**
 * Parse a delay string like "5m", "1h", "30s" into milliseconds.
 */
function parseDelay(delay: string): number | null {
  const match = delay.match(
    /^(\d+(?:\.\d+)?)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours)$/i,
  )
  if (!match) return null

  const value = parseFloat(match[1])
  const unit = match[2].toLowerCase()

  switch (unit) {
    case 's':
    case 'sec':
    case 'second':
    case 'seconds':
      return value * 1000
    case 'm':
    case 'min':
    case 'minute':
    case 'minutes':
      return value * 60 * 1000
    case 'h':
    case 'hr':
    case 'hour':
    case 'hours':
      return value * 60 * 60 * 1000
    default:
      return null
  }
}

const DESCRIPTION = `Schedule a future reminder (alarm).

When the alarm fires, you'll receive a message with your note.
Use this to:
- Check back on something later ("check if deploy succeeded")
- Set a reminder for a task
- Schedule periodic check-ins

Examples:
- set_alarm({ delay: "5m", note: "check deployment status" })
- set_alarm({ delay: "1h", note: "follow up on PR review" })
- set_alarm({ delay: "30s", note: "verify test results" })`

const parameters = z.object({
  delay: z
    .string()
    .describe('How long until the alarm fires (e.g., "5m", "1h", "30s")'),
  note: z
    .string()
    .describe("The reminder message you'll receive when the alarm fires"),
})

export const SetAlarmTool = Tool.define<typeof parameters, SetAlarmMetadata>(
  'set_alarm',
  {
    description: DESCRIPTION,
    parameters,
    async execute({delay, note}, ctx) {
      // Get tasks storage from context extra
      const tasksStorage = (ctx as Tool.Context & {extra: SetAlarmToolContext})
        .extra?.tasks

      if (!tasksStorage) {
        return {
          output: 'Error: Tasks storage not available',
          title: 'Set alarm failed',
          metadata: {
            alarmId: '',
            firesAt: '',
            delayMs: 0,
          },
        }
      }

      // Parse the delay
      const delayMs = parseDelay(delay)
      if (delayMs === null) {
        return {
          output: `Invalid delay format: "${delay}". Use formats like "5m", "1h", "30s".`,
          title: 'Invalid delay',
          metadata: {
            alarmId: '',
            firesAt: '',
            delayMs: 0,
          },
        }
      }

      // Calculate when the alarm should fire
      const firesAt = new Date(Date.now() + delayMs).toISOString()

      // Create the alarm (storage layer publishes BackgroundTasksChanged event)
      const alarmId = await tasksStorage.createAlarm({
        firesAt,
        note,
      })

      // Format the delay for display
      const displayDelay =
        delayMs >= 3600000
          ? `${Math.round((delayMs / 3600000) * 10) / 10}h`
          : delayMs >= 60000
            ? `${Math.round(delayMs / 60000)}m`
            : `${Math.round(delayMs / 1000)}s`

      return {
        output: `⏰ Alarm set for ${displayDelay} from now.\nNote: "${note}"\nFires at: ${firesAt}`,
        title: `Alarm in ${displayDelay}`,
        metadata: {
          alarmId,
          firesAt,
          delayMs,
        },
      }
    },
  },
)
