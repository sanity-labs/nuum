/**
 * REPL mode for miriad-code
 *
 * Human-friendly interactive mode with:
 * - Proper readline (history, arrow keys, Ctrl+R)
 * - Persistent history file
 * - Commands: /quit, /inspect, /dump, /help
 * - Streaming output with tool progress
 * - Ctrl+C interrupts request, Ctrl+D exits
 *
 * Uses Server internally for consistent behavior with stdio mode,
 * including background tasks and alarm polling.
 */

import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {Server, type ServerOptions} from '../jsonrpc'
import {runInspect, runDump} from './inspect'

const PROMPT = 'miriad-code> '
const HISTORY_FILE = path.join(os.homedir(), '.miriad-code-history')
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

    // Handle Ctrl+C (SIGINT)
    this.rl.on('SIGINT', () => {
      if (this.isRunning) {
        // Cancel current request via server
        this.server.interrupt()
        process.stdout.write('\n^C - Request cancelled\n')
      } else {
        // Show hint
        process.stdout.write('\n(Use /quit or Ctrl+D to exit)\n')
        this.rl?.prompt()
      }
    })

    // Handle Ctrl+D (close)
    this.rl.on('close', () => {
      this.saveHistory()
      console.log('\nGoodbye!')
      this.server.shutdown('user exit')
    })

    // Handle input
    this.rl.on('line', (line) => {
      this.handleLine(line).catch((error) => {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
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
    console.log()
    console.log('miriad-code interactive mode')
    console.log('Type /help for commands, /quit to exit')
    console.log()
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
        this.saveHistory()
        console.log('Goodbye!')
        this.server.shutdown('user exit')
        break

      case 'inspect':
        try {
          await runInspect(this.options.dbPath)
        } catch (error) {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        this.rl?.prompt()
        break

      case 'dump':
        try {
          await runDump(this.options.dbPath)
        } catch (error) {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
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
        console.log(`Unknown command: /${command}`)
        console.log('Type /help for available commands.')
        this.rl?.prompt()
    }
  }

  /**
   * Print help message.
   */
  private printHelp(): void {
    console.log()
    console.log('Commands:')
    console.log('  /help, /h, /?    Show this help')
    console.log('  /quit, /exit, /q Exit the REPL')

    console.log('  /inspect         Show memory statistics')
    console.log('  /dump            Show full system prompt')
    console.log()
    console.log('Shortcuts:')
    console.log('  Ctrl+C           Cancel current request')
    console.log('  Ctrl+D           Exit')
    console.log('  Up/Down arrows   Navigate history')
    console.log('  Ctrl+R           Reverse history search')
    console.log()
  }

  /**
   * Run the agent with a prompt via server.
   */
  private async runPrompt(prompt: string): Promise<void> {
    this.isRunning = true

    try {
      // Send message to server (it handles everything)
      await this.server.sendUserMessage(prompt)
    } finally {
      this.isRunning = false
      console.log()
      this.rl?.prompt()
    }
  }

  /**
   * Handle output messages from the server.
   * Translates protocol messages to human-friendly console output.
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
              process.stdout.write(block.text)
            } else if (block.type === 'tool_use' && block.name) {
              // Show tool call as progress indicator
              const displayName = this.formatToolName(block.name)
              const args = this.formatToolArgs(block.input)
              process.stdout.write(`\n[${displayName}${args}...]\n`)
            }
          }
        }
        break
      }

      case 'system': {
        const subtype = msg.subtype as string
        switch (subtype) {
          case 'init':
            // Ignore init message in REPL
            break
          case 'tool_result':
            // Don't show raw tool results - they're verbose
            break
          case 'error':
            process.stdout.write(
              `\n[Error: ${(msg as {message?: string}).message}]\n`,
            )
            break
          case 'consolidation': {
            const changes =
              ((msg as {entries_created?: number}).entries_created ?? 0) +
              ((msg as {entries_updated?: number}).entries_updated ?? 0) +
              ((msg as {entries_archived?: number}).entries_archived ?? 0)
            if (changes > 0) {
              process.stdout.write(`\n[LTM updated: ${changes} change(s)]\n`)
            }
            break
          }
          case 'interrupted':
            // Already handled by SIGINT handler
            break
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
   * Format tool name for display.
   */
  private formatToolName(name: string): string {
    const displayNames: Record<string, string> = {
      bash: 'Running command',
      read: 'Reading',
      write: 'Writing',
      edit: 'Editing',
      glob: 'Searching files',
      grep: 'Searching content',
      present_set_mission: 'Setting mission',
      present_set_status: 'Setting status',
      present_update_tasks: 'Updating tasks',
      set_alarm: 'Setting alarm',
      list_tasks: 'Listing tasks',
      background_research: 'Starting research',
      background_reflect: 'Starting reflection',
      cancel_task: 'Cancelling task',
    }
    return displayNames[name] || name
  }

  /**
   * Extract relevant args for display.
   */
  private formatToolArgs(input: unknown): string {
    if (!input || typeof input !== 'object') return ''
    const args = input as Record<string, unknown>

    // Show relevant arg based on tool
    if (args.path) return ` ${args.path}`
    if (args.filePath) return ` ${args.filePath}`
    if (args.pattern) return ` ${args.pattern}`
    if (args.command) {
      const cmd = String(args.command)
      return ` ${cmd.slice(0, 50)}${cmd.length > 50 ? '...' : ''}`
    }
    if (args.delay) return ` ${args.delay}`
    if (args.topic) return ` "${String(args.topic).slice(0, 40)}..."`
    if (args.question) return ` "${String(args.question).slice(0, 40)}..."`

    return ''
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
