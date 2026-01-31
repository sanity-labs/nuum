/**
 * Activity logging for human-readable output.
 *
 * Provides clear, attributed logging for:
 * - Tool calls with smart result truncation
 * - Worker lifecycle (start, progress, complete)
 * - Agent reasoning and decisions
 *
 * All output goes through the renderer for consistent formatting.
 */

import {render, type WorkerType} from '../cli/renderer'

// Re-export WorkerType for convenience
export type {WorkerType}

/**
 * Format bytes/lines for display.
 */
function formatSize(bytes?: number, lines?: number): string {
  const parts: string[] = []
  if (lines !== undefined) parts.push(`${lines} lines`)
  if (bytes !== undefined) {
    if (bytes < 1024) parts.push(`${bytes}b`)
    else parts.push(`${(bytes / 1024).toFixed(1)}kb`)
  }
  return parts.join(', ')
}

/**
 * Activity logger for a specific worker.
 */
export class ActivityLog {
  constructor(private worker: WorkerType) {}

  /**
   * Log a tool call being made.
   */
  toolCall(name: string, args: Record<string, unknown>): void {
    render({
      type: 'tool_start',
      worker: this.worker,
      tool: name,
      args,
    })
  }

  /**
   * Log a successful tool result.
   */
  toolResult(name: string, summary: string): void {
    render({
      type: 'tool_result',
      worker: this.worker,
      tool: name,
      summary,
    })
  }

  /**
   * Log a tool error.
   */
  toolError(name: string, error: string): void {
    render({
      type: 'tool_error',
      worker: this.worker,
      tool: name,
      error,
    })
  }

  /**
   * Log a file read result.
   */
  fileRead(path: string, lines: number, bytes: number): void {
    render({
      type: 'tool_result',
      worker: this.worker,
      tool: 'read',
      summary: formatSize(bytes, lines),
    })
  }

  /**
   * Log a search/glob result.
   */
  searchResult(
    type: 'glob' | 'grep' | 'ltm_search',
    count: number,
    _query?: string,
  ): void {
    render({
      type: 'tool_result',
      worker: this.worker,
      tool: type,
      summary: `${count} matches`,
    })
  }

  /**
   * Log an LTM operation.
   */
  ltmOperation(
    op: 'create' | 'update' | 'archive' | 'reparent' | 'rename',
    slug: string,
    detail?: string,
  ): void {
    render({
      type: 'tool_result',
      worker: this.worker,
      tool: `ltm_${op}`,
      summary: `"${slug}"${detail ? ` - ${detail}` : ''}`,
    })
  }

  /**
   * Log worker starting.
   */
  start(description: string, detail?: Record<string, unknown>): void {
    render({
      type: 'lifecycle',
      worker: this.worker,
      action: 'start',
      message: description,
      detail,
    })
  }

  /**
   * Log worker completing successfully.
   */
  complete(summary: string): void {
    render({
      type: 'lifecycle',
      worker: this.worker,
      action: 'complete',
      message: summary,
    })
  }

  /**
   * Log worker skipping (nothing to do).
   */
  skip(reason: string): void {
    render({
      type: 'lifecycle',
      worker: this.worker,
      action: 'skip',
      message: `Skipped: ${reason}`,
    })
  }

  /**
   * Log agent thinking/reasoning.
   */
  thinking(thought: string): void {
    render({
      type: 'thinking',
      worker: this.worker,
      message: thought,
    })
  }

  /**
   * Log general info.
   */
  info(message: string): void {
    render({
      type: 'info',
      worker: this.worker,
      level: 'info',
      message,
    })
  }

  /**
   * Log a warning.
   */
  warn(message: string): void {
    render({
      type: 'info',
      worker: this.worker,
      level: 'warn',
      message,
    })
  }

  /**
   * Log an error.
   */
  error(message: string): void {
    render({
      type: 'info',
      worker: this.worker,
      level: 'error',
      message,
    })
  }

  /**
   * Log token usage/reduction.
   */
  tokens(before: number, after: number, detail?: string): void {
    const reduction = Math.round((1 - after / before) * 100)
    const msg = `${before.toLocaleString()} → ${after.toLocaleString()} tokens (${reduction}% reduction${detail ? `, ${detail}` : ''})`
    render({
      type: 'info',
      worker: this.worker,
      level: 'info',
      message: msg,
    })
  }
}

// Pre-created loggers for each worker type
export const activity = {
  mainAgent: new ActivityLog('main-agent'),
  ltmCurator: new ActivityLog('ltm-curator'),
  distillation: new ActivityLog('distillation'),
  reflection: new ActivityLog('reflection'),
  research: new ActivityLog('research'),
  server: new ActivityLog('server'),
  mcp: new ActivityLog('mcp'),
}
