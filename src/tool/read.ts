/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/read.ts
 * License: MIT
 *
 * Simplified for nuum: removed LSP/FileTime/Instance dependencies.
 * Basic file reading with line numbers.
 */

import {z} from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import {Tool} from './tool'

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024

export interface ReadMetadata {
  preview: string
  truncated: boolean
}

export const ReadTool = Tool.define<
  z.ZodObject<{
    filePath: z.ZodString
    offset: z.ZodOptional<z.ZodNumber>
    limit: z.ZodOptional<z.ZodNumber>
  }>,
  ReadMetadata
>('read', {
  description: `Read a file from the filesystem.

Returns file contents with line numbers. Use offset and limit for large files.

- Default limit: 2000 lines
- Lines longer than 2000 characters are truncated
- Binary files are rejected`,

  parameters: z.object({
    filePath: z.string().describe('The absolute path to the file to read'),
    offset: z
      .number()
      .describe('Line number to start reading from (0-based)')
      .optional(),
    limit: z
      .number()
      .describe('Number of lines to read (default: 2000)')
      .optional(),
  }),

  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(), filepath)
    }

    const title = path.basename(filepath)

    // Request permission (auto-approved in Phase 1)
    await ctx.ask({
      permission: 'read',
      patterns: [filepath],
      always: ['*'],
      metadata: {},
    })

    if (!fs.existsSync(filepath)) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      try {
        const dirEntries = fs.readdirSync(dir)
        const suggestions = dirEntries
          .filter(
            (entry) =>
              entry.toLowerCase().includes(base.toLowerCase()) ||
              base.toLowerCase().includes(entry.toLowerCase()),
          )
          .map((entry) => path.join(dir, entry))
          .slice(0, 3)

        if (suggestions.length > 0) {
          throw new Error(
            `File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join('\n')}`,
          )
        }
      } catch {
        // Directory doesn't exist or can't be read
      }

      throw new Error(`File not found: ${filepath}`)
    }

    const stat = fs.statSync(filepath)
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filepath}`)
    }

    // Check if binary
    if (isBinaryFile(filepath)) {
      throw new Error(`Cannot read binary file: ${filepath}`)
    }

    const content = fs.readFileSync(filepath, 'utf-8')
    const lines = content.split('\n')

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0

    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false

    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      const line =
        lines[i].length > MAX_LINE_LENGTH
          ? lines[i].substring(0, MAX_LINE_LENGTH) + '...'
          : lines[i]
      const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    const numbered = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, ' ')}\t${line}`
    })

    const preview = raw.slice(0, 20).join('\n')

    let output = '<file>\n'
    output += numbered.join('\n')

    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += '\n</file>'

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
      },
    }
  },
})

function isBinaryFile(filepath: string): boolean {
  const ext = path.extname(filepath).toLowerCase()

  // Known binary extensions
  const binaryExtensions = new Set([
    '.zip',
    '.tar',
    '.gz',
    '.exe',
    '.dll',
    '.so',
    '.class',
    '.jar',
    '.war',
    '.7z',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.bin',
    '.dat',
    '.obj',
    '.o',
    '.a',
    '.lib',
    '.wasm',
    '.pyc',
    '.pyo',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.ico',
    '.webp',
    '.mp3',
    '.mp4',
    '.avi',
    '.mov',
    '.pdf',
  ])

  if (binaryExtensions.has(ext)) {
    return true
  }

  // Check file content for binary markers
  try {
    const fd = fs.openSync(filepath, 'r')
    const buffer = Buffer.alloc(4096)
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0)
    fs.closeSync(fd)

    if (bytesRead === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true // null byte = binary
      if (buffer[i] < 9 || (buffer[i] > 13 && buffer[i] < 32)) {
        nonPrintableCount++
      }
    }

    // >30% non-printable = binary
    return nonPrintableCount / bytesRead > 0.3
  } catch {
    return false
  }
}
