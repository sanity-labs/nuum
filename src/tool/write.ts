/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/write.ts
 * License: MIT
 *
 * Simplified for nuum Phase 1:
 * - Removed LSP diagnostics integration (deferred to Phase 2)
 * - Removed Bus event publishing (deferred to Phase 2)
 * - Removed FileTime tracking (deferred to Phase 2)
 * - Kept diff preview for permission checks
 */

import {z} from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import {Tool} from './tool'
import {createTwoFilesPatch} from 'diff'
import {trimDiff} from './edit'

export interface WriteMetadata {
  created: boolean
  filepath: string
  diff: string
}

export const WriteTool = Tool.define<
  z.ZodObject<{
    filePath: z.ZodString
    content: z.ZodString
  }>,
  WriteMetadata
>('write', {
  description: `Write content to a file, creating it if it doesn't exist.

This will overwrite existing files completely. Use the 'edit' tool for surgical modifications.

- Creates parent directories if needed
- Shows diff preview for permission checks
- Returns success message with file path`,

  parameters: z.object({
    filePath: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),

  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(), filepath)
    }

    const title = path.basename(filepath)
    const existed = fs.existsSync(filepath)
    const contentOld = existed ? fs.readFileSync(filepath, 'utf-8') : ''

    // Generate diff for permission check
    const diff = trimDiff(
      createTwoFilesPatch(filepath, filepath, contentOld, params.content),
    )

    // Request permission with diff preview
    await ctx.ask({
      permission: 'edit',
      patterns: [filepath],
      always: ['*'],
      metadata: {
        filepath,
        diff,
      },
    })

    // Create parent directories if needed
    const dir = path.dirname(filepath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, {recursive: true})
    }

    // Write the file
    fs.writeFileSync(filepath, params.content, 'utf-8')

    // Note: LSP diagnostics deferred to Phase 2
    // In OpenCode, this would report LSP errors after write

    const output = existed
      ? `Wrote file successfully.`
      : `Wrote file successfully (created new file).`

    return {
      title,
      output,
      metadata: {
        created: !existed,
        filepath,
        diff,
      },
    }
  },
})
