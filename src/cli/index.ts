#!/usr/bin/env node
/**
 * miriad-code CLI entry point
 *
 * Phase 1 deliverable: `miriad-code -p "prompt" --verbose`
 * Phase 2.1: `miriad-code --inspect` and `miriad-code --dump`
 * Phase 3a: `miriad-code --stdio` for JSON-RPC mode
 */

import { parseArgs } from "util"
import { runBatch } from "./batch"
import { runInspect, runDump } from "./inspect"
import { runJsonRpc } from "../jsonrpc"

interface CliOptions {
  prompt: string | undefined
  verbose: boolean
  db: string
  format: "text" | "json"
  help: boolean
  inspect: boolean
  dump: boolean
  stdio: boolean
}

function parseCliArgs(): CliOptions {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      verbose: { type: "boolean", short: "v", default: false },
      db: { type: "string", default: "./agent.db" },
      format: { type: "string", default: "text" },
      help: { type: "boolean", short: "h", default: false },
      inspect: { type: "boolean", default: false },
      dump: { type: "boolean", default: false },
      stdio: { type: "boolean", default: false },
    },
    allowPositionals: false,
  })

  return {
    prompt: values.prompt,
    verbose: values.verbose ?? false,
    db: values.db ?? "./agent.db",
    format: (values.format as "text" | "json") ?? "text",
    help: values.help ?? false,
    inspect: values.inspect ?? false,
    dump: values.dump ?? false,
    stdio: values.stdio ?? false,
  }
}

function printHelp(): void {
  console.log(`
miriad-code - A coding agent with persistent memory

Usage:
  miriad-code -p "prompt"           Run agent with a prompt
  miriad-code -p "prompt" --verbose Show debug output
  miriad-code --stdio               Start JSON-RPC mode over stdin/stdout
  miriad-code --inspect             Show memory stats (no LLM call)
  miriad-code --dump                Show raw system prompt (no LLM call)
  miriad-code --help                Show this help

Options:
  -p, --prompt <text>   The prompt to send to the agent
  -v, --verbose         Show memory state, token usage, and execution trace
      --stdio           Start JSON-RPC listener on stdin/stdout
      --inspect         Show memory statistics: temporal, present, LTM
      --dump            Dump the full system prompt that would be sent to LLM
      --db <path>       SQLite database path (default: ./agent.db)
      --format <type>   Output format: text or json (default: text)
  -h, --help            Show this help message

JSON-RPC Mode (--stdio):
  Accepts NDJSON requests on stdin, streams responses on stdout.

  Request: {"jsonrpc":"2.0","id":1,"method":"run","params":{"prompt":"..."}}
  Response: {"jsonrpc":"2.0","id":1,"result":{"type":"text","chunk":"..."}}
           {"jsonrpc":"2.0","id":1,"result":{"type":"complete","response":"..."}}

  Methods: run, cancel, status

Examples:
  miriad-code -p "What files are in src/"
  miriad-code -p "Refactor the auth module" --verbose
  miriad-code -p "List todos" --format=json
  miriad-code --inspect --db ./my-agent.db
  miriad-code --dump
  miriad-code --stdio --db ./agent.db
`)
}

async function main(): Promise<void> {
  const options = parseCliArgs()

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  // Handle --stdio (JSON-RPC mode)
  if (options.stdio) {
    try {
      await runJsonRpc({ dbPath: options.db })
      // runJsonRpc keeps running until stdin closes
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
      } else {
        console.error("Unknown error:", error)
      }
      process.exit(1)
    }
  }

  // Handle --inspect (no LLM call)
  if (options.inspect) {
    try {
      await runInspect(options.db)
      process.exit(0)
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
      } else {
        console.error("Unknown error:", error)
      }
      process.exit(1)
    }
  }

  // Handle --dump (no LLM call)
  if (options.dump) {
    try {
      await runDump(options.db)
      process.exit(0)
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`)
      } else {
        console.error("Unknown error:", error)
      }
      process.exit(1)
    }
  }

  // Regular prompt mode requires --prompt
  if (!options.prompt) {
    console.error("Error: --prompt (-p) is required (or use --stdio/--inspect/--dump)")
    console.error("Run with --help for usage information")
    process.exit(1)
  }

  try {
    await runBatch({
      prompt: options.prompt,
      verbose: options.verbose,
      dbPath: options.db,
      format: options.format,
    })
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
      if (options.verbose && error.stack) {
        console.error(error.stack)
      }
    } else {
      console.error("Unknown error:", error)
    }
    process.exit(1)
  }
}

main()
