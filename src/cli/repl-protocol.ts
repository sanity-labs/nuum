/**
 * Protocol REPL for miriad-code
 *
 * Interactive REPL that communicates with the agent via the Claude Code SDK protocol.
 * Useful for testing the protocol implementation and mid-turn message injection.
 *
 * Features:
 * - Sends user messages via protocol
 * - Shows all protocol messages (assistant, system, result)
 * - Supports mid-turn message injection (type while agent is working)
 * - Commands: /quit, /status, /interrupt, /help
 */

import * as readline from "readline"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { spawn, type ChildProcess } from "child_process"
import type { OutputMessage } from "../jsonrpc/protocol"

const PROMPT = "protocol> "
const HISTORY_FILE = path.join(os.homedir(), ".miriad-code-protocol-history")
const MAX_HISTORY = 1000

export interface ProtocolReplOptions {
  dbPath: string
}

/**
 * Protocol REPL session.
 */
export class ProtocolReplSession {
  private rl: readline.Interface | null = null
  private serverProcess: ChildProcess | null = null
  private history: string[] = []
  private isRunning = false
  private sessionId = `session_${Date.now()}`
  private lineBuffer = ""

  constructor(private options: ProtocolReplOptions) {}

  /**
   * Start the REPL.
   */
  async start(): Promise<void> {
    // Load history
    this.loadHistory()

    // Start the server process
    this.startServer()

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
      if (this.isRunning) {
        // Send interrupt to server
        this.sendControl("interrupt")
        process.stdout.write("\n^C - Interrupt sent\n")
      } else {
        process.stdout.write("\n(Use /quit or Ctrl+D to exit)\n")
        this.rl?.prompt()
      }
    })

    // Handle Ctrl+D (close)
    this.rl.on("close", () => {
      this.shutdown()
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
   * Start the server subprocess.
   */
  private startServer(): void {
    const args = ["run", "src/cli/index.ts", "--stdio", "--db", this.options.dbPath]
    
    this.serverProcess = spawn("bun", args, {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: process.cwd(),
    })

    // Handle server stdout (NDJSON messages)
    this.serverProcess.stdout?.on("data", (data: Buffer) => {
      this.lineBuffer += data.toString()
      
      // Process complete lines
      const lines = this.lineBuffer.split("\n")
      this.lineBuffer = lines.pop() || "" // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          this.handleServerMessage(line.trim())
        }
      }
    })

    // Handle server exit
    this.serverProcess.on("exit", (code) => {
      console.log(`\nServer exited with code ${code}`)
      process.exit(code ?? 0)
    })

    this.serverProcess.on("error", (error) => {
      console.error(`Server error: ${error.message}`)
      process.exit(1)
    })
  }

  /**
   * Handle a message from the server.
   */
  private handleServerMessage(line: string): void {
    try {
      const msg = JSON.parse(line) as OutputMessage
      this.displayMessage(msg)
    } catch (error) {
      // Not JSON - might be log output, ignore
    }
  }

  /**
   * Display a protocol message.
   */
  private displayMessage(msg: OutputMessage): void {
    // Clear the current line and move cursor to start
    process.stdout.write("\r\x1b[K")

    switch (msg.type) {
      case "assistant":
        // Show assistant text
        const text = msg.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("")
        if (text) {
          console.log(`\x1b[36m${text}\x1b[0m`) // Cyan
        }
        
        // Show tool calls
        // Tool calls are already logged by activity log, no need to duplicate
        break

      case "result":
        this.isRunning = false
        const status = msg.subtype === "success" ? "\x1b[32m✓\x1b[0m" : 
                       msg.subtype === "cancelled" ? "\x1b[33m⊘\x1b[0m" : 
                       "\x1b[31m✗\x1b[0m"
        console.log(`\n${status} ${msg.subtype} (${msg.duration_ms}ms, ${msg.num_turns} turns)`)
        if (msg.usage) {
          console.log(`  tokens: ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`)
        }
        this.rl?.prompt()
        break

      case "system":
        switch (msg.subtype) {
          case "queued":
            console.log(`\x1b[90m[Queued: position ${(msg as any).position}]\x1b[0m`) // Gray
            break
          case "injected":
            console.log(`\x1b[90m[Injected: ${(msg as any).message_count} message(s)]\x1b[0m`)
            break
          case "interrupted":
            console.log(`\x1b[33m[Interrupted]\x1b[0m`)
            break
          case "status":
            console.log(`\x1b[90m[Status: running=${(msg as any).running}, queued=${(msg as any).queued_messages}]\x1b[0m`)
            this.rl?.prompt()
            break
          case "tool_result":
            // Don't show raw tool results - too verbose
            break
          case "error":
            console.log(`\x1b[31m[Error: ${(msg as any).message}]\x1b[0m`)
            break
          default:
            console.log(`\x1b[90m[${msg.subtype}]\x1b[0m`)
        }
        break
    }
  }

  /**
   * Print welcome message.
   */
  private printWelcome(): void {
    console.log()
    console.log("miriad-code protocol REPL")
    console.log("Type messages to send to the agent via protocol")
    console.log("Messages sent while agent is working will be injected mid-turn")
    console.log("Type /help for commands")
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

    // Send user message
    this.sendUserMessage(trimmed)
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
        this.shutdown()
        break

      case "status":
        this.sendControl("status")
        break

      case "interrupt":
      case "cancel":
        this.sendControl("interrupt")
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
    console.log("  /help, /h, /?     Show this help")
    console.log("  /quit, /exit, /q  Exit the REPL")
    console.log("  /status           Get server status")
    console.log("  /interrupt        Cancel current turn")
    console.log()
    console.log("Shortcuts:")
    console.log("  Ctrl+C            Send interrupt")
    console.log("  Ctrl+D            Exit")
    console.log()
    console.log("Mid-turn messaging:")
    console.log("  Type while the agent is working to inject messages")
    console.log("  Messages are queued and injected before the next model call")
    console.log()
  }

  /**
   * Send a user message to the server.
   */
  private sendUserMessage(content: string): void {
    const msg = {
      type: "user",
      message: { role: "user", content },
      session_id: this.sessionId,
    }
    this.serverProcess?.stdin?.write(JSON.stringify(msg) + "\n")
    this.isRunning = true
  }

  /**
   * Send a control request to the server.
   */
  private sendControl(action: "interrupt" | "status"): void {
    const msg = { type: "control", action }
    this.serverProcess?.stdin?.write(JSON.stringify(msg) + "\n")
  }

  /**
   * Shutdown the REPL.
   */
  private shutdown(): void {
    this.saveHistory()
    console.log("\nGoodbye!")
    this.serverProcess?.kill()
    process.exit(0)
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
      // @ts-expect-error - history is internal but accessible
      const rlHistory: string[] = this.rl?.history || []
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
    if (line.startsWith("/")) return
    this.history.push(line)
  }
}

/**
 * Start the protocol REPL.
 */
export async function runProtocolRepl(options: ProtocolReplOptions): Promise<void> {
  const session = new ProtocolReplSession(options)
  await session.start()
}
