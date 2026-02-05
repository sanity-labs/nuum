/**
 * Event definitions for nuum
 *
 * Memory pattern inspired by Letta (https://github.com/letta-ai/letta)
 * Event bus pattern adapted from OpenCode (https://github.com/sst/opencode)
 */

import {z} from 'zod'
import {BusEvent} from './event'

/**
 * Events namespace containing all nuum event definitions.
 * See arch spec "Event Coordination" section.
 */
export namespace Events {
  // ─────────────────────────────────────────────────────────────────
  // Temporal compaction events
  // ─────────────────────────────────────────────────────────────────

  export const TemporalCompactionStarted = BusEvent.define(
    'temporal.compaction.started',
    z.object({
      workerId: z.string(),
      targetTokens: z.number(),
      uncompactedRange: z.object({
        from: z.string(),
        to: z.string(),
      }),
    }),
  )

  export const TemporalSummaryCreated = BusEvent.define(
    'temporal.summary.created',
    z.object({
      summaryId: z.string(),
      order: z.number(),
      startId: z.string(),
      endId: z.string(),
      tokenEstimate: z.number(),
    }),
  )

  export const TemporalCompactionComplete = BusEvent.define(
    'temporal.compaction.complete',
    z.object({
      workerId: z.string(),
      distillationsCreated: z.number(),
      tokensCompressed: z.number(),
    }),
  )

  // ─────────────────────────────────────────────────────────────────
  // LTM consolidation events
  // ─────────────────────────────────────────────────────────────────

  export const LTMConsolidationStarted = BusEvent.define(
    'ltm.consolidation.started',
    z.object({
      workerId: z.string(),
      triggerReason: z.enum(['scheduled', 'manual', 'threshold']),
    }),
  )

  export const LTMEntryUpdated = BusEvent.define(
    'ltm.entry.updated',
    z.object({
      slug: z.string(),
      operation: z.enum([
        'created',
        'updated',
        'deleted',
        'renamed',
        'reparented',
      ]),
      version: z.number(),
    }),
  )

  export const LTMConsolidationComplete = BusEvent.define(
    'ltm.consolidation.complete',
    z.object({
      workerId: z.string(),
      entriesModified: z.number(),
    }),
  )

  // ─────────────────────────────────────────────────────────────────
  // Worker lifecycle events
  // ─────────────────────────────────────────────────────────────────

  export const WorkerStarted = BusEvent.define(
    'worker.started',
    z.object({
      workerId: z.string(),
      workerType: z.enum([
        'temporal-compact',
        'ltm-consolidate',
        'ltm-reflect',
      ]),
    }),
  )

  export const WorkerCompleted = BusEvent.define(
    'worker.completed',
    z.object({
      workerId: z.string(),
      workerType: z.string(),
    }),
  )

  export const WorkerFailed = BusEvent.define(
    'worker.failed',
    z.object({
      workerId: z.string(),
      workerType: z.string(),
      error: z.string(),
    }),
  )

  // ─────────────────────────────────────────────────────────────────
  // Agent events
  // ─────────────────────────────────────────────────────────────────

  export const AgentTurnStarted = BusEvent.define(
    'agent.turn.started',
    z.object({
      sessionId: z.string(),
      messageId: z.string(),
    }),
  )

  export const AgentTurnCompleted = BusEvent.define(
    'agent.turn.completed',
    z.object({
      sessionId: z.string(),
      messageId: z.string(),
      inputTokens: z.number(),
      outputTokens: z.number(),
    }),
  )

  export const ToolCallStarted = BusEvent.define(
    'tool.call.started',
    z.object({
      sessionId: z.string(),
      toolName: z.string(),
      callId: z.string(),
    }),
  )

  export const ToolCallCompleted = BusEvent.define(
    'tool.call.completed',
    z.object({
      sessionId: z.string(),
      toolName: z.string(),
      callId: z.string(),
      durationMs: z.number(),
    }),
  )

  // ─────────────────────────────────────────────────────────────────
  // Present state events
  // ─────────────────────────────────────────────────────────────────

  export const PresentStateUpdated = BusEvent.define(
    'present.state.updated',
    z.object({
      sessionId: z.string(),
      field: z.enum(['mission', 'status', 'tasks']),
    }),
  )

  // ─────────────────────────────────────────────────────────────────
  // Background tasks events
  // ─────────────────────────────────────────────────────────────────

  export const BackgroundTasksChanged = BusEvent.define(
    'background.tasks.changed',
    z.object({
      reason: z.enum([
        'task_created',
        'task_completed',
        'task_failed',
        'task_cancelled',
        'alarm_created',
        'alarm_fired',
      ]),
      taskId: z.string().optional(),
    }),
  )
}
