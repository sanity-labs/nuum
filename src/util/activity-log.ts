/**
 * Activity logging for human-readable output.
 *
 * Provides clear, attributed logging for:
 * - Tool calls with smart result truncation
 * - Worker lifecycle (start, progress, complete)
 * - Agent reasoning and decisions
 *
 * Output goes to stderr, separate from protocol messages on stdout.
 */

// Worker/agent identifiers for attribution
export type WorkerType =
  | 'main-agent'
  | 'ltm-curator'
  | 'distillation'
  | 'reflection'
  | 'research'
  | 'server'
  | 'mcp'

// Icons for different activity types
const ICONS = {
  tool_call: '🔧',
  tool_result: '✓',
  tool_error: '✗',
  search: '🔍',
  create: '📝',
  update: '📝',
  delete: '🗑️',
  start: '▶',
  complete: '✓',
  skip: '⊘',
  thinking: '💭',
  info: 'ℹ',
  warn: '⚠',
  error: '✗',
} as const

/**
 * Format a worker tag for consistent attribution.
 */
function formatWorker(worker: WorkerType): string {
  return `[${worker}]`
}

/**
 * Truncate a string smartly - show start and end if too long.
 */
function truncate(str: string, maxLen: number = 100): string {
  if (str.length <= maxLen) return str
  const half = Math.floor((maxLen - 5) / 2)
  return str.slice(0, half) + ' ... ' + str.slice(-half)
}

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
 * Format tool arguments for display.
 */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      parts.push(`${key}=${truncate(value, 60)}`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key}=${value}`)
    } else {
      parts.push(`${key}=${truncate(JSON.stringify(value), 40)}`)
    }
  }
  return parts.join(', ')
}

/**
 * Write a log line to stderr.
 */
function write(line: string): void {
  process.stderr.write(line + '\n')
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
    const argsStr = formatArgs(args)
    write(`${formatWorker(this.worker)} ${ICONS.tool_call} ${name}(${argsStr})`)
  }

  /**
   * Log a successful tool result.
   */
  toolResult(name: string, summary: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_result} ${name}: ${summary}`,
    )
  }

  /**
   * Log a tool error.
   */
  toolError(name: string, error: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_error} ${name}: ${truncate(error, 100)}`,
    )
  }

  /**
   * Log a file read result.
   */
  fileRead(path: string, lines: number, bytes: number): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_result} read: ${formatSize(bytes, lines)}`,
    )
  }

  /**
   * Log a search/glob result.
   */
  searchResult(
    type: 'glob' | 'grep' | 'ltm_search',
    count: number,
    query?: string,
  ): void {
    const queryStr = query ? ` "${truncate(query, 30)}"` : ''
    write(
      `${formatWorker(this.worker)} ${ICONS.search} ${type}${queryStr} → ${count} results`,
    )
  }

  /**
   * Log an LTM operation.
   */
  ltmOperation(
    op: 'create' | 'update' | 'archive' | 'reparent' | 'rename',
    slug: string,
    detail?: string,
  ): void {
    const icon = op === 'archive' ? ICONS.delete : ICONS.update
    const detailStr = detail ? ` - ${detail}` : ''
    write(
      `${formatWorker(this.worker)} ${icon} ltm_${op}("${slug}")${detailStr}`,
    )
  }

  /**
   * Log worker starting.
   */
  start(description: string, detail?: Record<string, unknown>): void {
    const detailStr = detail ? ` (${formatArgs(detail)})` : ''
    write(
      `${formatWorker(this.worker)} ${ICONS.start} ${description}${detailStr}`,
    )
  }

  /**
   * Log worker completing successfully.
   */
  complete(summary: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.complete} ${summary}`)
  }

  /**
   * Log worker skipping (nothing to do).
   */
  skip(reason: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.skip} Skipped: ${reason}`)
  }

  /**
   * Log agent thinking/reasoning.
   */
  thinking(thought: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.thinking} ${truncate(thought, 150)}`,
    )
  }

  /**
   * Log general info.
   */
  info(message: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.info} ${message}`)
  }

  /**
   * Log a warning.
   */
  warn(message: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.warn} ${message}`)
  }

  /**
   * Log an error.
   */
  error(message: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.error} ${message}`)
  }

  /**
   * Log token usage/reduction.
   */
  tokens(before: number, after: number, detail?: string): void {
    const reduction = Math.round((1 - after / before) * 100)
    const detailStr = detail ? `, ${detail}` : ''
    write(
      `${formatWorker(this.worker)} ${ICONS.info} ${before.toLocaleString()} → ${after.toLocaleString()} tokens (${reduction}% reduction${detailStr})`,
    )
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
