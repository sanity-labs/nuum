/**
 * REPL mode for miriad-code
 *
 * Human-friendly interactive mode with:
 * - Proper readline (history, arrow keys, Ctrl+R)
 * - Persistent history file
 * - Commands: /quit, /clear, /inspect, /dump, /help
 * - Streaming output with tool progress
 * - Ctrl+C interrupts request, Ctrl+D exits
 */

import * as readline from "readline"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { createStorage, initializeDefaultEntries, type Storage } from "../storage"
import { runAgent, AgentCancelledError, type AgentEvent, type AgentOptions } from "../agent"
import { runInspect, runDump } from "./inspect"

const PROMPT = "miriad-code> "
const HISTORY_FILE = path.join(os.homedir(), ".miriad-code-history")
const MAX_HISTORY = 1000

export interface ReplOptions {
  dbPath: string
}

/**
 * REPL session managing state and I/O.
 */
export class ReplSession {
  private storage: Storage
  private rl: readline.Interface | null = null
  private abortController: AbortController | null = null
  private isRunning = false
  private history: string[] = []

  constructor(private options: ReplOptions) {
    this.storage = createStorage(options.dbPath)
  }

  /**
   * Start the REPL.
   */
  async start(): Promise<void> {
    await initializeDefaultEntries(this.storage)

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
    this.rl.on("SIGINT", () => {
      if (this.isRunning && this.abortController) {
        // Cancel current request
        this.abortController.abort()
        process.stdout.write("\n^C - Request cancelled\n")
      } else {
        // Show hint
        process.stdout.write("\n(Use /quit or Ctrl+D to exit)\n")
        this.rl?.prompt()
      }
    })

    // Handle Ctrl+D (close)
    this.rl.on("close", () => {
      this.saveHistory()
      console.log("\nGoodbye!")
      process.exit(0)
    })

    // Handle input
    this.rl.on("line", (line) => {
      this.handleLine(line).catch((error) => {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
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
    console.log("miriad-code interactive mode")
    console.log("Type /help for commands, /quit to exit")
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
    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed)
      return
    }

    // Run agent with the prompt
    await this.runPrompt(trimmed)
  }

  /**
   * Handle a slash command.
   */
  private async handleCommand(input: string): Promise<void> {
    const parts = input.slice(1).split(/\s+/)
    const command = parts[0].toLowerCase()

    switch (command) {
      case "quit":
      case "exit":
      case "q":
        this.saveHistory()
        console.log("Goodbye!")
        process.exit(0)
        break

      case "clear":
        // Clear temporal history by reinitializing storage
        this.storage = createStorage(this.options.dbPath)
        await initializeDefaultEntries(this.storage)
        console.log("Conversation cleared. Starting fresh session.")
        this.rl?.prompt()
        break

      case "inspect":
        try {
          await runInspect(this.options.dbPath)
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.rl?.prompt()
        break

      case "dump":
        try {
          await runDump(this.options.dbPath)
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.rl?.prompt()
        break

      case "help":
      case "h":
      case "?":
        this.printHelp()
        this.rl?.prompt()
        break

      default:
        console.log(`Unknown command: /${command}`)
        console.log("Type /help for available commands.")
        this.rl?.prompt()
    }
  }

  /**
   * Print help message.
   */
  private printHelp(): void {
    console.log()
    console.log("Commands:")
    console.log("  /help, /h, /?    Show this help")
    console.log("  /quit, /exit, /q Exit the REPL")
    console.log("  /clear           Clear conversation history (fresh session)")
    console.log("  /inspect         Show memory statistics")
    console.log("  /dump            Show full system prompt")
    console.log()
    console.log("Shortcuts:")
    console.log("  Ctrl+C           Cancel current request")
    console.log("  Ctrl+D           Exit")
    console.log("  Up/Down arrows   Navigate history")
    console.log("  Ctrl+R           Reverse history search")
    console.log()
  }

  /**
   * Run the agent with a prompt and stream output.
   */
  private async runPrompt(prompt: string): Promise<void> {
    this.isRunning = true
    this.abortController = new AbortController()

    // Track if we've printed any output
    let hasOutput = false

    const agentOptions: AgentOptions = {
      storage: this.storage,
      verbose: false,
      abortSignal: this.abortController.signal,
      onEvent: (event) => this.handleAgentEvent(event, () => { hasOutput = true }),
    }

    try {
      await runAgent(prompt, agentOptions)

      // Ensure we end with a newline if there was output
      if (hasOutput) {
        console.log()
      }
    } catch (error) {
      if (error instanceof AgentCancelledError) {
        // Already handled in SIGINT
      } else {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      this.isRunning = false
      this.abortController = null
      console.log()
      this.rl?.prompt()
    }
  }

  /**
   * Handle agent events and stream them to console.
   */
  private handleAgentEvent(event: AgentEvent, markOutput: () => void): void {
    switch (event.type) {
      case "assistant":
        // Stream text as it comes
        process.stdout.write(event.content)
        markOutput()
        break

      case "tool_call":
        // Show tool call as progress indicator
        if (event.toolName) {
          const displayName = this.formatToolName(event.toolName)
          const args = this.formatToolArgs(event.content)
          process.stdout.write(`\n[${displayName}${args}...]\n`)
          markOutput()
        }
        break

      case "tool_result":
        // Don't show raw tool results - they're verbose
        // The assistant's response will summarize them
        break

      case "error":
        process.stdout.write(`\n[Error: ${event.content}]\n`)
        markOutput()
        break

      case "consolidation":
        // Show consolidation as subtle indicator
        if (event.consolidationResult?.ran) {
          const r = event.consolidationResult
          const changes = r.entriesCreated + r.entriesUpdated + r.entriesArchived
          if (changes > 0) {
            process.stdout.write(`\n[LTM updated: ${changes} change(s)]\n`)
          }
        }
        markOutput()
        break

      case "compaction":
        // Show compaction as subtle indicator
        process.stdout.write(`\n[Memory compacted]\n`)
        markOutput()
        break

      // Ignore 'user' and 'done' events
    }
  }

  /**
   * Format tool name for display.
   */
  private formatToolName(name: string): string {
    const displayNames: Record<string, string> = {
      bash: "Running command",
      read: "Reading",
      write: "Writing",
      edit: "Editing",
      glob: "Searching files",
      grep: "Searching content",
      present_set_mission: "Setting mission",
      present_set_status: "Setting status",
      present_update_tasks: "Updating tasks",
    }
    return displayNames[name] || name
  }

  /**
   * Extract relevant args for display.
   */
  private formatToolArgs(content: string): string {
    try {
      // Content is in format "name({...}...)"
      const match = content.match(/\((\{.+?\})\.\.\.\)$/)
      if (match) {
        const args = JSON.parse(match[1] + "}")

        // Show relevant arg based on tool
        if (args.path) return ` ${args.path}`
        if (args.file) return ` ${args.file}`
        if (args.pattern) return ` ${args.pattern}`
        if (args.command) return ` ${args.command.slice(0, 50)}${args.command.length > 50 ? "..." : ""}`
      }
    } catch {
      // Ignore parse errors
    }
    return ""
  }

  /**
   * Load history from file.
   */
  private loadHistory(): void {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const content = fs.readFileSync(HISTORY_FILE, "utf-8")
        this.history = content
          .split("\n")
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

      fs.writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n")
    } catch {
      // Ignore errors - history is optional
    }
  }

  /**
   * Add a line to history.
   */
  private addToHistory(line: string): void {
    // Skip commands from history
    if (line.startsWith("/")) {
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
