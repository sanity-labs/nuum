/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/grep.ts
 * License: MIT
 *
 * Uses ripgrep directly for content search.
 */

import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { getSpawnEnvironment } from "../context/environment"

const MAX_LINE_LENGTH = 2000
const MAX_RESULTS = 100

export interface GrepMetadata {
  matches: number
  truncated: boolean
}

export const GrepTool = Tool.define<
  z.ZodObject<{
    pattern: z.ZodString
    path: z.ZodOptional<z.ZodString>
    include: z.ZodOptional<z.ZodString>
  }>,
  GrepMetadata
>("grep", {
  description: `Search for text patterns in files using regex.

Examples:
- pattern: "function.*export" - find exported functions
- pattern: "TODO|FIXME" - find TODO comments
- include: "*.ts" - only search TypeScript files

Returns matches sorted by file modification time (newest first).
Respects .gitignore patterns.`,

  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),

  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    let searchPath = params.path ?? process.cwd()
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(process.cwd(), searchPath)

    const title = params.pattern

    // Request permission
    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    // Build ripgrep arguments
    const rgPath = await Ripgrep.filepath()
    const args = [
      "-nH",
      "--hidden",
      "--follow",
      "--no-messages",
      "--field-match-separator=|",
      "--regexp",
      params.pattern,
    ]
    if (params.include) {
      args.push("--glob", params.include)
    }
    args.push(searchPath)

    // Run ripgrep
    const proc = spawn(rgPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getSpawnEnvironment(),
    })

    let output = ""
    let errorOutput = ""

    proc.stdout.on("data", (data) => {
      output += data.toString()
    })
    proc.stderr.on("data", (data) => {
      errorOutput += data.toString()
    })

    const exitCode = await new Promise<number>((resolve) => {
      proc.on("close", resolve)
    })

    // Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
    if (exitCode === 1 || (exitCode === 2 && !output.trim())) {
      return {
        title,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    const hasErrors = exitCode === 2

    // Parse output
    const lines = output.trim().split(/\r?\n/)
    const matches: Array<{
      path: string
      modTime: number
      lineNum: number
      lineText: string
    }> = []

    for (const line of lines) {
      if (!line) continue

      const [filePath, lineNumStr, ...lineTextParts] = line.split("|")
      if (!filePath || !lineNumStr || lineTextParts.length === 0) continue

      const lineNum = parseInt(lineNumStr, 10)
      const lineText = lineTextParts.join("|")

      let modTime = 0
      try {
        const stats = fs.statSync(filePath)
        modTime = stats.mtimeMs
      } catch {
        // File may have been deleted
        continue
      }

      matches.push({
        path: filePath,
        modTime,
        lineNum,
        lineText,
      })
    }

    // Sort by modification time (newest first)
    matches.sort((a, b) => b.modTime - a.modTime)

    const truncated = matches.length > MAX_RESULTS
    const finalMatches = truncated ? matches.slice(0, MAX_RESULTS) : matches

    if (finalMatches.length === 0) {
      return {
        title,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    // Format output
    const outputLines = [`Found ${finalMatches.length} matches`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH
          ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..."
          : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push("(Results are truncated. Consider using a more specific path or pattern.)")
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title,
      metadata: {
        matches: finalMatches.length,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
