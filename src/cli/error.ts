/**
 * Error formatting for nuum CLI
 *
 * Provides nice, user-friendly error output with colors and helpful hints.
 */

import {pc} from '../util/colors'
import {err} from './output'

interface ErrorInfo {
  title: string
  message: string
  hint?: string
  details?: string
}

/**
 * Categorize an error and extract useful information for display.
 */
function categorizeError(error: unknown): ErrorInfo {
  if (!(error instanceof Error)) {
    return {
      title: 'Unknown Error',
      message: String(error),
    }
  }

  const msg = error.message

  // API / Rate limit errors
  if (
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('Too Many Requests')
  ) {
    return {
      title: 'Rate Limited',
      message: 'API rate limit exceeded',
      hint: 'Wait a moment and try again, or check your API usage limits.',
    }
  }

  if (msg.includes('ANTHROPIC_API_KEY') && msg.includes('required')) {
    return {
      title: 'Missing API Key',
      message: 'ANTHROPIC_API_KEY environment variable is not set',
      hint: 'Set it with: export ANTHROPIC_API_KEY=sk-ant-...',
    }
  }

  if (
    msg.includes('401') ||
    msg.includes('Unauthorized') ||
    msg.includes('invalid x-api-key') ||
    msg.includes('invalid_api_key') ||
    /invalid.*api.*key/i.test(msg)
  ) {
    return {
      title: 'Authentication Failed',
      message: 'Invalid or missing API key',
      hint: 'Set ANTHROPIC_API_KEY environment variable with a valid key.',
    }
  }

  if (
    msg.includes('API') ||
    msg.includes('fetch') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT')
  ) {
    return {
      title: 'API Error',
      message: msg,
      hint: 'Check your internet connection and try again.',
    }
  }

  // File system errors
  if (msg.includes('ENOENT')) {
    const match = msg.match(/ENOENT.*'([^']+)'/)
    const path = match?.[1] ?? 'unknown'
    return {
      title: 'File Not Found',
      message: `Cannot find: ${path}`,
      hint: 'Check that the file or directory exists.',
    }
  }

  if (msg.includes('EACCES') || msg.includes('EPERM')) {
    return {
      title: 'Permission Denied',
      message: msg,
      hint: 'Check file permissions or try running with appropriate access.',
    }
  }

  if (msg.includes('EROFS')) {
    return {
      title: 'Read-Only File System',
      message: msg,
      hint: 'Cannot write to this location. Try a different path.',
    }
  }

  // Database errors
  if (msg.includes('database') || msg.includes('SQLite') || msg.includes('SQLITE')) {
    return {
      title: 'Database Error',
      message: msg,
      hint: 'Try removing the database file and starting fresh, or check disk space.',
    }
  }

  // Context overflow
  if (msg.includes('context') && msg.includes('overflow')) {
    return {
      title: 'Context Overflow',
      message: 'Conversation history is too large',
      hint: "Run 'nuum --compact' to reduce context size.",
    }
  }

  // MCP errors
  if (msg.includes('MCP') || msg.includes('mcp')) {
    return {
      title: 'MCP Error',
      message: msg,
      hint: 'Check your MCP server configuration in ~/.nuum/mcp.json',
    }
  }

  // Generic error
  return {
    title: 'Error',
    message: msg,
    details: error.stack,
  }
}

/**
 * Format and print an error to stderr with nice styling.
 */
export function printError(error: unknown, options?: {verbose?: boolean}): void {
  const info = categorizeError(error)

  // Print styled error box
  const boxWidth = 60
  const topBorder = pc.red('╭' + '─'.repeat(boxWidth - 2) + '╮')
  const bottomBorder = pc.red('╰' + '─'.repeat(boxWidth - 2) + '╯')

  err.blank()
  err.line(topBorder)
  err.line(pc.red('│') + ' ' + pc.bold(pc.red(info.title.padEnd(boxWidth - 4))) + ' ' + pc.red('│'))
  err.line(pc.red('│') + ' '.repeat(boxWidth - 2) + pc.red('│'))

  // Word-wrap the message
  const messageLines = wrapText(info.message, boxWidth - 4)
  for (const line of messageLines) {
    err.line(pc.red('│') + ' ' + line.padEnd(boxWidth - 4) + ' ' + pc.red('│'))
  }

  if (info.hint) {
    err.line(pc.red('│') + ' '.repeat(boxWidth - 2) + pc.red('│'))
    const hintLines = wrapText(info.hint, boxWidth - 4)
    for (const line of hintLines) {
      err.line(pc.red('│') + ' ' + pc.dim(line.padEnd(boxWidth - 4)) + ' ' + pc.red('│'))
    }
  }

  err.line(bottomBorder)
  err.blank()

  // Show stack trace in verbose mode
  if (options?.verbose && info.details) {
    err.line(pc.dim('Stack trace:'))
    err.line(pc.dim(info.details))
    err.blank()
  }
}

/**
 * Simple word-wrap for text.
 */
function wrapText(text: string, maxWidth: number): string[] {
  // First, normalize the text - replace newlines with spaces
  const normalized = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
  
  const words = normalized.split(' ')
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= maxWidth) {
      currentLine += (currentLine ? ' ' : '') + word
    } else {
      if (currentLine) lines.push(currentLine)
      currentLine = word
    }
  }
  if (currentLine) lines.push(currentLine)

  return lines.length > 0 ? lines : ['']
}

/**
 * Print a simple error message (for validation errors, missing args, etc.)
 */
export function printSimpleError(message: string, hint?: string): void {
  err.blank()
  err.line(`${pc.red('✗')} ${pc.bold('Error:')} ${message}`)
  if (hint) {
    err.line(`  ${pc.dim(hint)}`)
  }
  err.blank()
}
