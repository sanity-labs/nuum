/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/shell/shell.ts
 * License: MIT
 *
 * Simplified for miriad-code: removed Flag dependency, cross-platform shell detection.
 */

import { spawn, type ChildProcess } from "child_process"
import path from "path"
import { lazy } from "../util/lazy"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  /**
   * Kill a process and all its children.
   * On Unix, uses process groups. On Windows, uses taskkill.
   */
  export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
    const pid = proc.pid
    if (!pid || opts?.exited?.()) return

    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    try {
      process.kill(-pid, "SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        process.kill(-pid, "SIGKILL")
      }
    } catch {
      proc.kill("SIGTERM")
      await sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) {
        proc.kill("SIGKILL")
      }
    }
  }

  const BLACKLIST = new Set(["fish", "nu"])

  function fallback(): string {
    if (process.platform === "win32") {
      // Try to find Git Bash
      const gitBashPath = process.env.OPENCODE_GIT_BASH_PATH
      if (gitBashPath) return gitBashPath

      // Common Git Bash locations
      const possiblePaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      ]
      // In real code we'd check if these exist, but for now just return cmd
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") return "/bin/zsh"
    return "/bin/bash"
  }

  /**
   * Get the user's preferred shell from $SHELL, or fallback to a reasonable default.
   */
  export const preferred = lazy(() => {
    const s = process.env.SHELL
    if (s) return s
    return fallback()
  })

  /**
   * Get an acceptable shell for command execution.
   * Excludes problematic shells like fish and nu that have incompatible syntax.
   */
  export const acceptable = lazy(() => {
    const s = process.env.SHELL
    if (s) {
      const basename = process.platform === "win32" ? path.win32.basename(s) : path.basename(s)
      if (!BLACKLIST.has(basename)) return s
    }
    return fallback()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
