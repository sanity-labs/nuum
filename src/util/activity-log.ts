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

import pc from 'picocolors'

// Worker/agent identifiers for attribution
export type WorkerType =
  | 'main-agent'
  | 'ltm-curator'
  | 'distillation'
  | 'reflection'
  | 'research'
  | 'server'
  | 'mcp'

// Icons for different activity types (with colors)
const ICONS = {
  tool_call: pc.yellow('🔧'),
  tool_result: pc.green('✓'),
  tool_error: pc.red('✗'),
  search: pc.cyan('🔍'),
  create: pc.green('📝'),
  update: pc.yellow('📝'),
  delete: pc.red('🗑️'),
  start: pc.blue('▶'),
  complete: pc.green('✓'),
  skip: pc.dim('⊘'),
  thinking: pc.magenta('💭'),
  info: pc.blue('ℹ'),
  warn: pc.yellow('⚠'),
  error: pc.red('✗'),
} as const

/**
 * Format a worker tag for consistent attribution.
 */
function formatWorker(worker: WorkerType): string {
  return pc.dim(`[${worker}]`)
}

/**
 * Format a tool/operation name.
 */
function formatOp(name: string): string {
  return pc.magenta(name)
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
    const keyStr = pc.dim(key + '=')
    if (typeof value === 'string') {
      parts.push(keyStr + pc.cyan(truncate(value, 60)))
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(keyStr + pc.yellow(String(value)))
    } else {
      parts.push(keyStr + pc.cyan(truncate(JSON.stringify(value), 40)))
    }
  }
  return parts.join(pc.dim(', '))
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
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_call} ${formatOp(name)}${pc.dim('(')}${argsStr}${pc.dim(')')}`,
    )
  }

  /**
   * Log a successful tool result.
   */
  toolResult(name: string, summary: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_result} ${formatOp(name)}${pc.dim(':')} ${summary}`,
    )
  }

  /**
   * Log a tool error.
   */
  toolError(name: string, error: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_error} ${formatOp(name)}${pc.dim(':')} ${pc.red(truncate(error, 100))}`,
    )
  }

  /**
   * Log a file read result.
   */
  fileRead(path: string, lines: number, bytes: number): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.tool_result} ${formatOp('read')}${pc.dim(':')} ${formatSize(bytes, lines)}`,
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
    const queryStr = query ? ` ${pc.cyan('"' + truncate(query, 30) + '"')}` : ''
    write(
      `${formatWorker(this.worker)} ${ICONS.search} ${formatOp(type)}${queryStr} ${pc.dim('→')} ${pc.yellow(String(count))} results`,
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
    const detailStr = detail ? pc.dim(` - ${detail}`) : ''
    write(
      `${formatWorker(this.worker)} ${icon} ${formatOp('ltm_' + op)}${pc.dim('(')}${pc.cyan('"' + slug + '"')}${pc.dim(')')}${detailStr}`,
    )
  }

  /**
   * Log worker starting.
   */
  start(description: string, detail?: Record<string, unknown>): void {
    const detailStr = detail ? pc.dim(` (${formatArgs(detail)})`) : ''
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
    write(
      `${formatWorker(this.worker)} ${ICONS.skip} ${pc.dim('Skipped:')} ${reason}`,
    )
  }

  /**
   * Log agent thinking/reasoning.
   */
  thinking(thought: string): void {
    write(
      `${formatWorker(this.worker)} ${ICONS.thinking} ${pc.dim(truncate(thought, 150))}`,
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
    write(`${formatWorker(this.worker)} ${ICONS.warn} ${pc.yellow(message)}`)
  }

  /**
   * Log an error.
   */
  error(message: string): void {
    write(`${formatWorker(this.worker)} ${ICONS.error} ${pc.red(message)}`)
  }

  /**
   * Log token usage/reduction.
   */
  tokens(before: number, after: number, detail?: string): void {
    const reduction = Math.round((1 - after / before) * 100)
    const detailStr = detail ? pc.dim(`, ${detail}`) : ''
    write(
      `${formatWorker(this.worker)} ${ICONS.info} ${pc.yellow(before.toLocaleString())} ${pc.dim('→')} ${pc.green(after.toLocaleString())} tokens ${pc.dim('(')}${pc.green(reduction + '%')} reduction${detailStr}${pc.dim(')')}`,
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
