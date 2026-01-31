/**
 * Drizzle schema definitions for miriad-code storage
 *
 * Memory pattern inspired by Letta (https://github.com/letta-ai/letta)
 * Schema follows arch-long-term-agent spec exactly.
 */

import {sqliteTable, text, integer, index} from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────────────────────────
// Temporal Memory - chronological log of all agent experience
// ─────────────────────────────────────────────────────────────────

/**
 * Every operation the agent experiences.
 * Append-only, never modified.
 */
export const temporalMessages = sqliteTable(
  'temporal_messages',
  {
    id: text('id').primaryKey(), // ULID - lexicographically ordered
    type: text('type').notNull(), // 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system'
    content: text('content').notNull(), // JSON for tool calls/results, plain text otherwise
    tokenEstimate: integer('token_estimate').notNull(),
    createdAt: text('created_at').notNull(), // ISO 8601
  },
  (table) => [index('idx_temporal_messages_created').on(table.id)],
)

/**
 * Summarizes a range of messages/summaries.
 * Immutable once created (no CAS needed).
 */
export const temporalSummaries = sqliteTable(
  'temporal_summaries',
  {
    id: text('id').primaryKey(), // ULID
    orderNum: integer('order_num').notNull(), // 1 = messages, 2+ = summaries
    startId: text('start_id').notNull(), // First covered ULID (inclusive)
    endId: text('end_id').notNull(), // Last covered ULID (inclusive)
    narrative: text('narrative').notNull(), // Prose summary of events
    keyObservations: text('key_observations').notNull(), // JSON array of strings
    tags: text('tags').notNull().default('[]'), // JSON array - auto-extracted topics
    tokenEstimate: integer('token_estimate').notNull(),
    createdAt: text('created_at').notNull(), // ISO 8601
  },
  (table) => [
    index('idx_temporal_summaries_order').on(table.orderNum, table.id),
    index('idx_temporal_summaries_range').on(table.startId, table.endId),
  ],
)

// ─────────────────────────────────────────────────────────────────
// Present Memory - current situational awareness
// ─────────────────────────────────────────────────────────────────

/**
 * Single-row table for current mission/status/tasks.
 */
export const presentState = sqliteTable('present_state', {
  id: integer('id').primaryKey().default(1),
  mission: text('mission'), // High-level objective
  status: text('status'), // Current state
  tasks: text('tasks').notNull().default('[]'), // JSON array of Task objects
})

// ─────────────────────────────────────────────────────────────────
// Long-Term Memory - hierarchical knowledge base
// ─────────────────────────────────────────────────────────────────

/**
 * LTM entry with tree structure and CAS versioning.
 */
export const ltmEntries = sqliteTable(
  'ltm_entries',
  {
    slug: text('slug').primaryKey(), // Unique identifier (e.g., "react/hooks/useEffect")
    parentSlug: text('parent_slug'), // Parent for tree structure (self-reference)
    path: text('path').notNull(), // Materialized path ("/react/hooks/useEffect")
    title: text('title').notNull(), // Display name
    body: text('body').notNull(), // Markdown content
    links: text('links').notNull().default('[]'), // JSON array - cross-references via [[slug]]
    version: integer('version').notNull().default(1), // For CAS operations
    createdBy: text('created_by').notNull(), // 'main' | 'ltm-consolidate' | 'ltm-reflect'
    updatedBy: text('updated_by').notNull(), // Which agent last modified
    archivedAt: text('archived_at'), // Soft-delete timestamp (null = active)
    createdAt: text('created_at').notNull(), // ISO 8601
    updatedAt: text('updated_at').notNull(), // ISO 8601
  },
  (table) => [
    index('idx_ltm_entries_path').on(table.path),
    index('idx_ltm_entries_parent').on(table.parentSlug),
  ],
)

// ─────────────────────────────────────────────────────────────────
// Session - singleton identity and configuration
// ─────────────────────────────────────────────────────────────────

/**
 * Session configuration as key-value pairs.
 * This is a singleton - there's only one session per database.
 *
 * Keys:
 * - "id": Session ID (generated once, never changes)
 * - "created_at": When session was first created
 * - "system_prompt_overlay": CAST-provided addition to base prompt
 */
export const sessionConfig = sqliteTable('session_config', {
  key: text('key').primaryKey(),
  value: text('value'),
})

// ─────────────────────────────────────────────────────────────────
// Background Workers - job tracking
// ─────────────────────────────────────────────────────────────────

/**
 * Background worker job tracking.
 */
export const workers = sqliteTable('workers', {
  id: text('id').primaryKey(),
  type: text('type').notNull(), // 'temporal-compact' | 'ltm-consolidate' | 'ltm-reflect'
  status: text('status').notNull(), // 'pending' | 'running' | 'completed' | 'failed'
  startedAt: text('started_at'), // ISO 8601
  completedAt: text('completed_at'), // ISO 8601
  error: text('error'), // Error message if failed
})

// ─────────────────────────────────────────────────────────────────
// Background Reports - ambient reports from background workers
// ─────────────────────────────────────────────────────────────────

/**
 * Background reports filed by workers (LTM curator, distillation, etc.)
 * that get surfaced to the main agent at the start of the next turn.
 */
export const backgroundReports = sqliteTable(
  'background_reports',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull(),
    subsystem: text('subsystem').notNull(), // 'ltm_curator' | 'distillation' | etc.
    report: text('report').notNull(), // JSON report content
    surfacedAt: text('surfaced_at'), // NULL until shown to main agent
  },
  (table) => [index('idx_background_reports_unsurfaced').on(table.surfacedAt)],
)

// ─────────────────────────────────────────────────────────────────
// Background Tasks - conscious async tasks (research, reflect, alarms)
// ─────────────────────────────────────────────────────────────────

/**
 * Background tasks spawned by the agent (research, reflect).
 * These are "conscious" tasks - the agent explicitly started them
 * and expects results.
 */
export const backgroundTasks = sqliteTable(
  'background_tasks',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(), // 'research' | 'reflect'
    description: text('description').notNull(), // Human-readable description
    status: text('status').notNull(), // 'running' | 'completed' | 'failed' | 'killed'
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
    result: text('result'), // JSON blob with task result
    error: text('error'), // Error message if failed
  },
  (table) => [index('idx_background_tasks_status').on(table.status)],
)

/**
 * Queue for completed background task results.
 * Drained at end of turn to continue processing.
 */
export const backgroundTaskQueue = sqliteTable(
  'background_task_queue',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull(),
    createdAt: text('created_at').notNull(),
    content: text('content').notNull(), // The message to inject
  },
  (table) => [index('idx_background_task_queue_created').on(table.createdAt)],
)

/**
 * Alarms - scheduled "notes to self" that trigger turns.
 */
export const alarms = sqliteTable(
  'alarms',
  {
    id: text('id').primaryKey(),
    firesAt: text('fires_at').notNull(), // ISO timestamp
    note: text('note').notNull(), // The "note to self"
    fired: integer('fired').notNull().default(0), // 1 if already fired
  },
  (table) => [index('idx_alarms_fires_at').on(table.firesAt)],
)

// ─────────────────────────────────────────────────────────────────
// Type exports for use in storage implementations
// ─────────────────────────────────────────────────────────────────

export type TemporalMessage = typeof temporalMessages.$inferSelect
export type TemporalMessageInsert = typeof temporalMessages.$inferInsert

export type TemporalSummary = typeof temporalSummaries.$inferSelect
export type TemporalSummaryInsert = typeof temporalSummaries.$inferInsert

export type PresentStateRow = typeof presentState.$inferSelect
export type PresentStateInsert = typeof presentState.$inferInsert

export type LTMEntry = typeof ltmEntries.$inferSelect
export type LTMEntryInsert = typeof ltmEntries.$inferInsert

export type Worker = typeof workers.$inferSelect
export type WorkerInsert = typeof workers.$inferInsert

export type BackgroundReportRow = typeof backgroundReports.$inferSelect
export type BackgroundReportInsert = typeof backgroundReports.$inferInsert

export type BackgroundTask = typeof backgroundTasks.$inferSelect
export type BackgroundTaskInsert = typeof backgroundTasks.$inferInsert

export type BackgroundTaskQueueRow = typeof backgroundTaskQueue.$inferSelect
export type BackgroundTaskQueueInsert = typeof backgroundTaskQueue.$inferInsert

export type Alarm = typeof alarms.$inferSelect
export type AlarmInsert = typeof alarms.$inferInsert
