/**
 * REPL mode for miriad-code
 *
 * Human-friendly interactive mode with:
 * - Proper readline (history, arrow keys, Ctrl+R)
 * - Persistent history file
 * - Commands: /quit, /inspect, /dump, /help
 * - Streaming output with tool progress
 * - Ctrl+C interrupts request, Ctrl+D exits
 * - Colorized output with markdown rendering
 *
 * Uses Server internally for consistent behavior with stdio mode,
 * including background tasks and alarm polling.
 */

import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {Server} from '../jsonrpc'
import {runInspect, runDump} from './inspect'
import {pc, styles} from '../util/colors'
import {renderMarkdown} from '../util/markdown'
import {
  render,
  renderEnd,
  resetRenderer,
  setReplContext,
  clearReplContext,
  setReplRunning,
  renderRaw,
} from './renderer'

const PROMPT = pc.cyan('nuum') + pc.dim('> ')
const HISTORY_FILE = path.join(os.homedir(), '.nuum-history')
const MAX_HISTORY = 1000

export interface ReplOptions {
  dbPath: string
}

/**
 * REPL session managing state and I/O.
 * Wraps Server to provide human-friendly interactive mode.
 */
export class ReplSession {
  private server: Server
  private rl: readline.Interface | null = null
  private history: string[] = []
  private isRunning = false

  constructor(private options: ReplOptions) {
    // Create server with REPL output handler, no stdin (REPL handles input)
    this.server = new Server({
      dbPath: options.dbPath,
      outputHandler: (message) => this.handleServerOutput(message),
      noStdin: true,
    })
  }

  /**
   * Start the REPL.
   */
  async start(): Promise<void> {
    // Initialize server (starts alarm loop, MCP, etc.)
    await this.server.start()

    // Load history
    this.loadHistory()

    // Create readline interface
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
      historySize: MAX_HISTORY,
      terminal: true,
    })

    // Populate history
    for (const line of this.history) {
      // @ts-expect-error - history is internal but accessible
      this.rl.history?.unshift(line)
    }

    // Register REPL context for prompt-aware background output
    setReplContext(this.rl, PROMPT)

    // Handle Ctrl+C (SIGINT)
    this.rl.on('SIGINT', () => {
      if (this.isRunning) {
        // Cancel current request via server
        this.server.interrupt()
        renderRaw('\n')
        renderRaw(styles.warning('^C - Request cancelled') + '\n')
      } else {
        // Show hint
        renderRaw('\n')
        renderRaw(pc.dim('(Use /quit or Ctrl+D to exit)') + '\n')
        this.rl?.prompt()
      }
    })

    // Handle Ctrl+D (close)
    this.rl.on('close', () => {
      clearReplContext()
      this.saveHistory()
      renderRaw('\n')
      renderRaw(pc.dim('Goodbye!') + '\n')
      this.server.shutdown('user exit')
    })

    // Handle input
    this.rl.on('line', (line) => {
      this.handleLine(line).catch((error) => {
        renderRaw(
          styles.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          ) + '\n',
        )
        this.rl?.prompt()
      })
    })

    // Print welcome message
    this.printWelcome()
    this.rl.prompt()
  }

  /**
   * Print welcome message.
   */
  private printWelcome(): void {
    renderRaw('\n')
    renderRaw(
      pc.bold(pc.cyan('nuum')) + ' ' + pc.dim('interactive mode') + '\n',
    )
    renderRaw(pc.dim('Type /help for commands, /quit to exit') + '\n')
    renderRaw('\n')
  }

  /**
   * Handle a line of input.
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) {
      this.rl?.prompt()
      return
    }

    // Add to history
    this.addToHistory(trimmed)

    // Check for commands
    if (trimmed.startsWith('/')) {
      await this.handleCommand(trimmed)
      return
    }

    // Run agent with the prompt via server
    await this.runPrompt(trimmed)
  }

  /**
   * Handle a slash command.
   */
  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/)
    const command = parts[0].toLowerCase()

    switch (command) {
      case 'quit':
      case 'exit':
      case 'q':
        clearReplContext()
        this.saveHistory()
        renderRaw(pc.dim('Goodbye!') + '\n')
        this.server.shutdown('user exit')
        break

      case 'inspect':
        try {
          await runInspect(this.options.dbPath)
        } catch (error) {
          renderRaw(
            styles.error(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            ) + '\n',
          )
        }
        this.rl?.prompt()
        break

      case 'dump':
        try {
          await runDump(this.options.dbPath)
        } catch (error) {
          renderRaw(
            styles.error(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            ) + '\n',
          )
        }
        this.rl?.prompt()
        break

      case 'help':
      case 'h':
      case '?':
        this.printHelp()
        this.rl?.prompt()
        break

      default:
        renderRaw(styles.warning(`Unknown command: /${command}`) + '\n')
        renderRaw(pc.dim('Type /help for available commands.') + '\n')
        this.rl?.prompt()
    }
  }

  /**
   * Print help message.
   */
  private printHelp(): void {
    renderRaw('\n')
    renderRaw(styles.header('Commands') + '\n')
    renderRaw(
      `  ${pc.cyan('/help')}, ${pc.cyan('/h')}, ${pc.cyan('/?')}    ${pc.dim('Show this help')}\n`,
    )
    renderRaw(
      `  ${pc.cyan('/quit')}, ${pc.cyan('/exit')}, ${pc.cyan('/q')} ${pc.dim('Exit the REPL')}\n`,
    )
    renderRaw(
      `  ${pc.cyan('/inspect')}         ${pc.dim('Show memory statistics')}\n`,
    )
    renderRaw(
      `  ${pc.cyan('/dump')}            ${pc.dim('Show full system prompt')}\n`,
    )
    renderRaw('\n')
    renderRaw(styles.header('Shortcuts') + '\n')
    renderRaw(
      `  ${pc.yellow('Ctrl+C')}           ${pc.dim('Cancel current request')}\n`,
    )
    renderRaw(`  ${pc.yellow('Ctrl+D')}           ${pc.dim('Exit')}\n`)
    renderRaw(
      `  ${pc.yellow('Up/Down arrows')}   ${pc.dim('Navigate history')}\n`,
    )
    renderRaw(
      `  ${pc.yellow('Ctrl+R')}           ${pc.dim('Reverse history search')}\n`,
    )
    renderRaw('\n')
  }

  /**
   * Run the agent with a prompt via server.
   */
  private async runPrompt(prompt: string): Promise<void> {
    this.isRunning = true
    setReplRunning(true)
    resetRenderer()
    resetRenderer()

    try {
      // Add blank line before agent response
      renderRaw('\n')
      // Send message to server (it handles everything)
      await this.server.sendUserMessage(prompt)
    } finally {
      this.isRunning = false
      setReplRunning(false)
      renderEnd()
      this.rl?.prompt()
    }
  }

  /**
   * Handle output messages from the server.
   * Translates protocol messages to human-friendly console output.
   *
   * Tool calls and results are handled by the activity log (via renderer).
   * We only handle text output and some system messages here.
   */
  private handleServerOutput(message: unknown): void {
    const msg = message as Record<string, unknown>
    const type = msg.type as string

    switch (type) {
      case 'assistant': {
        const assistantMsg = msg.message as {
          content?: Array<{
            type: string
            text?: string
            name?: string
            input?: unknown
          }>
        }
        if (assistantMsg?.content) {
          for (const block of assistantMsg.content) {
            if (block.type === 'text' && block.text) {
              // Render text through the renderer (with markdown)
              render({type: 'text', text: renderMarkdown(block.text)})
            }
            // Tool calls are handled by activity log, not here
          }
        }
        break
      }

      case 'system': {
        const subtype = msg.subtype as string
        switch (subtype) {
          case 'init':
          case 'tool_result':
          case 'interrupted':
            // Handled elsewhere or ignored
            break
          case 'error':
            render({
              type: 'info',
              worker: 'server',
              level: 'error',
              message: (msg as {message?: string}).message || 'Unknown error',
            })
            break
          case 'consolidation': {
            const changes =
              ((msg as {entries_created?: number}).entries_created ?? 0) +
              ((msg as {entries_updated?: number}).entries_updated ?? 0) +
              ((msg as {entries_archived?: number}).entries_archived ?? 0)
            if (changes > 0) {
              render({
                type: 'lifecycle',
                worker: 'ltm-curator',
                action: 'complete',
                message: `LTM updated: ${changes} change(s)`,
              })
            }
            break
          }
        }
        break
      }

      case 'result': {
        // Turn completed - handled by runPrompt finally block
        break
      }
    }
  }

  /**
   * Load history from file.
   */
  private loadHistory(): void {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const content = fs.readFileSync(HISTORY_FILE, 'utf-8')
        this.history = content
          .split('\n')
          .filter((line) => line.trim())
          .slice(-MAX_HISTORY)
      }
    } catch {
      // Ignore errors - history is optional
    }
  }

  /**
   * Save history to file.
   */
  private saveHistory(): void {
    try {
      // Get history from readline
      // @ts-expect-error - history is internal but accessible
      const rlHistory: string[] = this.rl?.history || []

      // Merge with existing history, dedupe, and limit
      const allHistory = [...new Set([...rlHistory.reverse(), ...this.history])]
      const trimmed = allHistory.slice(-MAX_HISTORY)

      fs.writeFileSync(HISTORY_FILE, trimmed.join('\n') + '\n')
    } catch {
      // Ignore errors - history is optional
    }
  }

  /**
   * Add a line to history.
   */
  private addToHistory(line: string): void {
    // Skip commands from history
    if (line.startsWith('/')) {
      return
    }
    this.history.push(line)
  }
}

/**
 * Start the REPL.
 */
export async function runRepl(options: ReplOptions): Promise<void> {
  const session = new ReplSession(options)
  await session.start()
}
