/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/glob.ts
 * License: MIT
 *
 * Uses ripgrep for file listing (respects .gitignore, handles hidden files correctly).
 */

import {z} from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import {Tool} from './tool'
import {Ripgrep} from '../file/ripgrep'

const MAX_RESULTS = 100

export interface GlobMetadata {
  count: number
  truncated: boolean
}

export const GlobTool = Tool.define<
  z.ZodObject<{
    pattern: z.ZodString
    path: z.ZodOptional<z.ZodString>
  }>,
  GlobMetadata
>('glob', {
  description: `Find files matching a glob pattern.

Examples:
- "**/*.ts" - all TypeScript files
- "src/**/*.{ts,tsx}" - TypeScript files in src
- "**/test*.ts" - test files anywhere

Returns up to 100 results sorted by modification time (newest first).
Respects .gitignore patterns.`,

  parameters: z.object({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
      ),
  }),

  async execute(params, ctx) {
    let search = params.path ?? process.cwd()
    search = path.isAbsolute(search)
      ? search
      : path.resolve(process.cwd(), search)

    const title = path.basename(search)

    // Request permission
    await ctx.ask({
      permission: 'glob',
      patterns: [params.pattern],
      always: ['*'],
      metadata: {
        pattern: params.pattern,
        path: params.path,
      },
    })

    // Collect files using ripgrep
    const files: Array<{path: string; mtime: number}> = []
    let truncated = false

    for await (const file of Ripgrep.files({
      cwd: search,
      glob: [params.pattern],
    })) {
      if (files.length >= MAX_RESULTS) {
        truncated = true
        break
      }

      const full = path.resolve(search, file)
      let mtime = 0
      try {
        const stats = fs.statSync(full)
        mtime = stats.mtimeMs
      } catch {
        // File may have been deleted between listing and stat
      }

      files.push({path: full, mtime})
    }

    // Sort by modification time (newest first)
    files.sort((a, b) => b.mtime - a.mtime)

    // Format output
    const output: string[] = []
    if (files.length === 0) {
      output.push('No files found')
    } else {
      output.push(...files.map((f) => f.path))
      if (truncated) {
        output.push('')
        output.push(
          '(Results are truncated. Consider using a more specific path or pattern.)',
        )
      }
    }

    return {
      title,
      metadata: {
        count: files.length,
        truncated,
      },
      output: output.join('\n'),
    }
  },
})
