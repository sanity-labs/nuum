/**
 * Terminal output renderer.
 *
 * ALL terminal output formatting happens here. This is the single source of truth
 * for how events are displayed to the user.
 *
 * Architecture:
 * - Events are structural data describing what happened
 * - This renderer converts events to formatted terminal output
 * - No colorization or formatting should happen anywhere else
 *
 * Output streams:
 * - Activity events (tool calls, results, thinking) → stderr
 * - Text responses → stdout
 * - This separation allows piping stdout while still seeing progress
 */

import pc from 'picocolors'
import * as readline from 'readline'

// =============================================================================
// Event Types
// =============================================================================

/** Worker/agent identifiers for attribution */
export type WorkerType =
  | 'main-agent'
  | 'ltm-curator'
  | 'distillation'
  | 'reflection'
  | 'research'
  | 'server'
  | 'mcp'

/** Tool execution started */
export interface ToolStartEvent {
  type: 'tool_start'
  worker: WorkerType
  tool: string
  args: Record<string, unknown>
}

/** Tool execution completed */
export interface ToolResultEvent {
  type: 'tool_result'
  worker: WorkerType
  tool: string
  summary: string
}

/** Tool execution failed */
export interface ToolErrorEvent {
  type: 'tool_error'
  worker: WorkerType
  tool: string
  error: string
}

/** Agent is processing/thinking */
export interface ThinkingEvent {
  type: 'thinking'
  worker: WorkerType
  message?: string
}

/** Agent text response */
export interface TextEvent {
  type: 'text'
  text: string
}

/** Worker lifecycle event */
export interface LifecycleEvent {
  type: 'lifecycle'
  worker: WorkerType
  action: 'start' | 'complete' | 'skip'
  message: string
  detail?: Record<string, unknown>
}

/** Info/warning/error message */
export interface InfoEvent {
  type: 'info'
  worker: WorkerType
  level: 'info' | 'warn' | 'error'
  message: string
}

/** All event types */
export type OutputEvent =
  | ToolStartEvent
  | ToolResultEvent
  | ToolErrorEvent
  | ThinkingEvent
  | TextEvent
  | LifecycleEvent
  | InfoEvent

// =============================================================================
// Renderer State
// =============================================================================

/** Track what was last output for spacing decisions */
let lastEventType: OutputEvent['type'] | 'none' = 'none'

/** REPL context for prompt-aware output */
let replContext: {
  rl: readline.Interface
  prompt: string
  isRunning: boolean
} | null = null

/** Reset state at start of each agent turn */
export function resetRenderer(): void {
  lastEventType = 'none'
}

/** Register REPL context for prompt-aware output */
export function setReplContext(rl: readline.Interface, prompt: string): void {
  replContext = {rl, prompt, isRunning: false}
}

/** Clear REPL context */
export function clearReplContext(): void {
  replContext = null
}

/** Mark REPL as running (agent processing, no prompt shown) */
export function setReplRunning(running: boolean): void {
  if (replContext) {
    replContext.isRunning = running
  }
}

// =============================================================================
// Terminal Utilities
// =============================================================================

const DEFAULT_WIDTH = 80
const BULLET = pc.blue('⏺')
const CONTINUATION_INDENT = '  '

function getTerminalWidth(): number {
  return process.stdout.columns || DEFAULT_WIDTH
}

/** Strip ANSI escape codes for width calculation */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

/** Calculate display width accounting for emojis */
function displayWidth(str: string): number {
  const stripped = stripAnsi(str)
  let width = 0
  for (const char of stripped) {
    const code = char.codePointAt(0) || 0
    if (
      (code >= 0x1f300 && code <= 0x1f9ff) ||
      (code >= 0x2600 && code <= 0x26ff) ||
      (code >= 0x2700 && code <= 0x27bf) ||
      (code >= 0x1f600 && code <= 0x1f64f) ||
      (code >= 0x1f680 && code <= 0x1f6ff)
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/** Wrap a single line to fit width */
function wrapLine(text: string, maxWidth: number): string[] {
  const tokens = text.split(/(\s+)/)
  const lines: string[] = []
  let currentLine = ''
  let currentWidth = 0

  for (const token of tokens) {
    if (!token) continue
    if (!currentLine && /^\s+$/.test(token)) continue

    const isWhitespace = /^\s+$/.test(token)
    const tokenWidth = displayWidth(token)

    if (currentWidth + tokenWidth <= maxWidth) {
      currentLine += token
      currentWidth += tokenWidth
    } else if (isWhitespace) {
      continue
    } else if (!currentLine) {
      currentLine = token
      currentWidth = tokenWidth
    } else {
      lines.push(currentLine)
      currentLine = token
      currentWidth = tokenWidth
    }
  }

  if (currentLine) lines.push(currentLine)
  return lines.length > 0 ? lines : ['']
}

/** Format text with bullet prefix and continuation indent */
function formatWithBullet(text: string): string {
  const termWidth = getTerminalWidth()
  const bulletPrefix = `${BULLET} `
  const bulletLen = displayWidth(bulletPrefix)
  const maxFirstLine = termWidth - bulletLen
  const maxContLine = termWidth - CONTINUATION_INDENT.length

  const inputLines = text.split('\n')
  const result: string[] = []
  let isFirstOutputLine = true

  for (const inputLine of inputLines) {
    if (inputLine === '') {
      result.push(isFirstOutputLine ? bulletPrefix : CONTINUATION_INDENT)
      isFirstOutputLine = false
      continue
    }

    const maxWidth = isFirstOutputLine ? maxFirstLine : maxContLine
    const wrapped = wrapLine(inputLine, maxWidth)

    for (const line of wrapped) {
      if (isFirstOutputLine) {
        result.push(bulletPrefix + line)
        isFirstOutputLine = false
      } else {
        result.push(CONTINUATION_INDENT + line)
      }
    }
  }

  return result.join('\n')
}

// =============================================================================
// Event Formatting
// =============================================================================

/** Icons for different event types */
const ICONS = {
  success: pc.green('✓'),
  error: pc.red('✗'),
  start: pc.blue('▶'),
  complete: pc.green('✓'),
  skip: pc.dim('⊘'),
  info: pc.blue('ℹ'),
  warn: pc.yellow('⚠'),
}

/** Truncate a string, showing start and end if too long */
function truncate(str: string, maxLen: number = 60): string {
  if (str.length <= maxLen) return str
  const half = Math.floor((maxLen - 5) / 2)
  return str.slice(0, half) + ' ... ' + str.slice(-half)
}

/** Format tool arguments for display */
function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    let display: string
    if (typeof value === 'string') {
      display = truncate(value, 50)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      display = String(value)
    } else {
      display = truncate(JSON.stringify(value), 40)
    }
    parts.push(`${pc.dim(key + '=')}${pc.cyan(display)}`)
  }
  return parts.length > 0
    ? `${pc.dim('(')}${parts.join(pc.dim(', '))}${pc.dim(')')}`
    : ''
}

/** Format a single event to string (without writing) */
function formatEvent(event: OutputEvent): string {
  switch (event.type) {
    case 'tool_start': {
      const args = formatToolArgs(event.args)
      return formatWithBullet(`${pc.magenta(event.tool)}${args}`)
    }

    case 'tool_result': {
      return formatWithBullet(
        `${ICONS.success} ${pc.magenta(event.tool)}${pc.dim(':')} ${event.summary}`,
      )
    }

    case 'tool_error': {
      return formatWithBullet(
        `${ICONS.error} ${pc.magenta(event.tool)}${pc.dim(':')} ${pc.red(truncate(event.error, 100))}`,
      )
    }

    case 'thinking': {
      const msg = event.message || 'processing...'
      return formatWithBullet(pc.dim(msg))
    }

    case 'text': {
      return formatWithBullet(event.text)
    }

    case 'lifecycle': {
      const icon =
        event.action === 'start'
          ? ICONS.start
          : event.action === 'complete'
            ? ICONS.complete
            : ICONS.skip
      const detail = event.detail
        ? pc.dim(` (${formatDetailArgs(event.detail)})`)
        : ''
      return formatWithBullet(`${icon} ${event.message}${detail}`)
    }

    case 'info': {
      const icon =
        event.level === 'error'
          ? ICONS.error
          : event.level === 'warn'
            ? ICONS.warn
            : ICONS.info
      const msg =
        event.level === 'error'
          ? pc.red(event.message)
          : event.level === 'warn'
            ? pc.yellow(event.message)
            : event.message
      return formatWithBullet(`${icon} ${msg}`)
    }
  }
}

/** Format detail args without colors on keys */
function formatDetailArgs(detail: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${String(value)}`)
  }
  return parts.join(', ')
}

/** Determine if we need a blank line before this event */
function needsBlankLineBefore(event: OutputEvent): boolean {
  if (lastEventType === 'none') return false

  // Text after activity needs blank line
  if (event.type === 'text' && lastEventType !== 'text') return true

  // Thinking after tool results needs blank line
  if (event.type === 'thinking' && lastEventType === 'tool_result') return true

  // Activity after text needs blank line
  if (event.type !== 'text' && lastEventType === 'text') return true

  return false
}

// =============================================================================
// Output Helpers
// =============================================================================

/** Write to stderr, handling REPL prompt if needed */
function writeStderr(text: string): void {
  if (replContext && !replContext.isRunning) {
    // Clear prompt line, write, restore prompt
    process.stdout.write('\r\x1b[K')
    process.stderr.write(text)
    replContext.rl.prompt(true)
  } else {
    process.stderr.write(text)
  }
}

/** Write to stdout */
function writeStdout(text: string): void {
  process.stdout.write(text)
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Render an event to the terminal.
 * - Activity events (tool_*, thinking, lifecycle, info) → stderr
 * - Text events → stdout
 */
export function render(event: OutputEvent): void {
  // Add spacing between event types
  if (needsBlankLineBefore(event)) {
    if (event.type === 'text') {
      writeStdout('\n')
    } else {
      writeStderr('\n')
    }
  }

  const formatted = formatEvent(event)

  if (event.type === 'text') {
    writeStdout(formatted + '\n')
  } else {
    writeStderr(formatted + '\n')
  }

  lastEventType = event.type
}

/**
 * Render final spacing before returning to prompt.
 */
export function renderEnd(): void {
  writeStdout('\n\n')
}

/**
 * Write raw output to stdout.
 *
 * Use for non-agent output that doesn't fit the event model:
 * - Version string (--version)
 * - REPL chrome (welcome, help, goodbye)
 * - JSON output format (--format json)
 *
 * For agent conversation output, use render() instead.
 */
export function renderRaw(text: string): void {
  writeStdout(text)
}

/**
 * Write raw output to stderr.
 *
 * Use for error formatting that has its own styling (error boxes).
 * For agent errors during conversation, use render() with InfoEvent instead.
 */
export function renderRawStderr(text: string): void {
  writeStderr(text)
}
