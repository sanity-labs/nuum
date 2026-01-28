/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/file/ripgrep.ts
 * License: MIT
 *
 * Simplified for miriad-code Phase 1:
 * - Uses system ripgrep (assumes `rg` is in PATH or ~/bin)
 * - Removed auto-download logic (not needed in container environment)
 * - Kept core functionality: files() for glob, filepath() for binary path
 */

import { spawn } from "child_process"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { getSpawnEnvironment } from "../context/environment"

export namespace Ripgrep {
  let cachedPath: string | null = null

  /**
   * Get the path to the ripgrep binary.
   * Checks system PATH first, then ~/bin.
   */
  export async function filepath(): Promise<string> {
    if (cachedPath) return cachedPath

    // Check PATH first
    const proc = spawn("which", ["rg"])
    const result = await new Promise<string>((resolve) => {
      let output = ""
      proc.stdout.on("data", (data) => {
        output += data.toString()
      })
      proc.on("close", (code) => {
        resolve(code === 0 ? output.trim() : "")
      })
    })

    if (result) {
      cachedPath = result
      return result
    }

    // Check ~/bin
    const homeBinPath = path.join(os.homedir(), "bin", "rg")
    if (fs.existsSync(homeBinPath)) {
      cachedPath = homeBinPath
      return homeBinPath
    }

    throw new Error(
      "ripgrep not found. Install with: apt install ripgrep\n" +
        "Or download manually to ~/bin/rg"
    )
  }

  /**
   * List files matching glob patterns.
   * Yields file paths relative to cwd.
   */
  export async function* files(input: {
    cwd: string
    glob?: string[]
    hidden?: boolean
    follow?: boolean
    maxDepth?: number
  }): AsyncGenerator<string, void, unknown> {
    const rgPath = await filepath()

    const args = ["--files", "--glob=!.git/*"]
    if (input.follow !== false) args.push("--follow")
    if (input.hidden !== false) args.push("--hidden")
    if (input.maxDepth !== undefined) args.push(`--max-depth=${input.maxDepth}`)
    if (input.glob) {
      for (const g of input.glob) {
        args.push(`--glob=${g}`)
      }
    }

    // Verify cwd exists
    if (!fs.existsSync(input.cwd) || !fs.statSync(input.cwd).isDirectory()) {
      throw Object.assign(new Error(`No such directory: '${input.cwd}'`), {
        code: "ENOENT",
        errno: -2,
        path: input.cwd,
      })
    }

    const proc = spawn(rgPath, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: getSpawnEnvironment(),
    })

    let buffer = ""

    for await (const chunk of proc.stdout) {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ""

      for (const line of lines) {
        if (line) yield line
      }
    }

    if (buffer) yield buffer

    // Wait for process to exit
    await new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        // Exit code 1 means no matches (which is fine)
        // Exit code 2 means some error (but may have partial results)
        if (code !== 0 && code !== 1 && code !== 2) {
          reject(new Error(`ripgrep exited with code ${code}`))
        } else {
          resolve()
        }
      })
      proc.on("error", reject)
    })
  }
}
