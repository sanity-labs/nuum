/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/edit.ts
 * License: MIT
 *
 * The approaches in this edit tool are sourced from:
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
 * - https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
 * - https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts
 *
 * Simplified for nuum Phase 1:
 * - Removed LSP diagnostics integration (deferred to Phase 2)
 * - Removed Bus event publishing (deferred to Phase 2)
 * - Removed FileTime tracking (deferred to Phase 2)
 * - Removed Instance.worktree references (using process.cwd())
 * - Kept the full 9-replacer matching system for robust edit handling
 */

import {z} from 'zod'
import * as fs from 'fs'
import * as path from 'path'
import {Tool} from './tool'
import {createTwoFilesPatch, diffLines} from 'diff'

export interface EditMetadata {
  diff: string
  additions: number
  deletions: number
}

export const EditTool = Tool.define<
  z.ZodObject<{
    filePath: z.ZodString
    oldString: z.ZodString
    newString: z.ZodString
    replaceAll: z.ZodOptional<z.ZodBoolean>
  }>,
  EditMetadata
>('edit', {
  description: `Make surgical text replacements in a file.

Use this tool for targeted edits when you know exactly what text to change.
The old_string must match EXACTLY one location in the file (unless replaceAll is true).

Rules:
- old_string and new_string must be different
- old_string must be unique in the file (or use replaceAll=true)
- Preserves file encoding and line endings
- Use Write tool for creating new files or complete rewrites`,

  parameters: z.object({
    filePath: z.string().describe('The absolute path to the file to modify'),
    oldString: z.string().describe('The text to replace'),
    newString: z
      .string()
      .describe(
        'The text to replace it with (must be different from oldString)',
      ),
    replaceAll: z
      .boolean()
      .optional()
      .describe('Replace all occurrences of oldString (default false)'),
  }),

  async execute(params, ctx) {
    if (!params.filePath) {
      throw new Error('filePath is required')
    }

    if (params.oldString === params.newString) {
      throw new Error('oldString and newString must be different')
    }

    let filePath = params.filePath
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(process.cwd(), filePath)
    }

    const title = path.basename(filePath)

    // Handle empty oldString (create new file)
    if (params.oldString === '') {
      await ctx.ask({
        permission: 'edit',
        patterns: [filePath],
        always: ['*'],
        metadata: {filepath: filePath},
      })

      // Ensure parent directory exists
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true})
      }

      fs.writeFileSync(filePath, params.newString, 'utf-8')
      const diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, '', params.newString),
      )

      return {
        title,
        output: 'Edit applied successfully (created new file).',
        metadata: {
          diff,
          additions: params.newString.split('\n').length,
          deletions: 0,
        },
      }
    }

    // Check file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File ${filePath} not found`)
    }

    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`)
    }

    const contentOld = fs.readFileSync(filePath, 'utf-8')
    const contentNew = replace(
      contentOld,
      params.oldString,
      params.newString,
      params.replaceAll,
    )

    const diff = trimDiff(
      createTwoFilesPatch(
        filePath,
        filePath,
        normalizeLineEndings(contentOld),
        normalizeLineEndings(contentNew),
      ),
    )

    await ctx.ask({
      permission: 'edit',
      patterns: [filePath],
      always: ['*'],
      metadata: {filepath: filePath, diff},
    })

    fs.writeFileSync(filePath, contentNew, 'utf-8')

    // Calculate additions/deletions
    let additions = 0
    let deletions = 0
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) additions += change.count || 0
      if (change.removed) deletions += change.count || 0
    }

    // Note: LSP diagnostics deferred to Phase 2
    // In OpenCode, this would report LSP errors after edit

    return {
      title,
      output: 'Edit applied successfully.',
      metadata: {
        diff,
        additions,
        deletions,
      },
    }
  },
})

function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n')
}

// ============================================================================
// Replacer System - 9 strategies tried in order for fuzzy matching
// ============================================================================

export type Replacer = (
  content: string,
  find: string,
) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({length: a.length + 1}, (_, i) =>
    Array.from({length: b.length + 1}, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      )
    }
  }
  return matrix[a.length][b.length]
}

/**
 * Strategy 1: Simple exact match
 */
export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

/**
 * Strategy 2: Line-trimmed matching - ignores leading/trailing whitespace per line
 */
export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

/**
 * Strategy 3: Block anchor matching - uses first/last lines as anchors with Levenshtein
 */
export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split('\n')
  const searchLines = find.split('\n')

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === '') {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{startLine: number; endLine: number}> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({startLine: i, endLine: j})
        break
      }
    }
  }

  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const {startLine, endLine} = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: {startLine: number; endLine: number} | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const {startLine, endLine} = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2)

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck
    } else {
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const {startLine, endLine} = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

/**
 * Strategy 4: Whitespace normalized matching - collapses all whitespace
 */
export const WhitespaceNormalizedReplacer: Replacer = function* (
  content,
  find,
) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim()
  const normalizedFind = normalizeWhitespace(find)

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words
            .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('\\s+')
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split('\n')
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n')
      }
    }
  }
}

/**
 * Strategy 5: Indentation flexible matching - ignores indentation differences
 */
export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split('\n')
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join('\n')
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n')
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

/**
 * Strategy 6: Escape normalized matching - handles escape sequences
 */
export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case 'n':
          return '\n'
        case 't':
          return '\t'
        case 'r':
          return '\r'
        case "'":
          return "'"
        case '"':
          return '"'
        case '`':
          return '`'
        case '\\':
          return '\\'
        case '\n':
          return '\n'
        case '$':
          return '$'
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  const lines = content.split('\n')
  const findLines = unescapedFind.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

/**
 * Strategy 7: Trimmed boundary matching - tries with trimmed boundaries
 */
export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    return
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  const lines = content.split('\n')
  const findLines = find.split('\n')

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n')

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

/**
 * Strategy 8: Context-aware matching - uses surrounding lines for context
 */
export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split('\n')
  if (findLines.length < 3) {
    return
  }

  if (findLines[findLines.length - 1] === '') {
    findLines.pop()
  }

  const contentLines = content.split('\n')

  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join('\n')

        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (
            totalNonEmptyLines === 0 ||
            matchingLines / totalNonEmptyLines >= 0.5
          ) {
            yield block
            break
          }
        }
        break
      }
    }
  }
}

/**
 * Strategy 9: Multi-occurrence matching - yields all exact matches
 */
export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

/**
 * Trim diff output for cleaner display
 */
export function trimDiff(diff: string): string {
  const lines = diff.split('\n')
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
      !line.startsWith('---') &&
      !line.startsWith('+++'),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const lineContent = line.slice(1)
    if (lineContent.trim().length > 0) {
      const match = lineContent.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff

  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) &&
      !line.startsWith('---') &&
      !line.startsWith('+++')
    ) {
      const prefix = line[0]
      const lineContent = line.slice(1)
      return prefix + lineContent.slice(min)
    }
    return line
  })

  return trimmedLines.join('\n')
}

/**
 * Main replace function - tries all 9 replacer strategies in order
 */
export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string {
  if (oldString === newString) {
    throw new Error('oldString and newString must be different')
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return (
        content.substring(0, index) +
        newString +
        content.substring(index + search.length)
      )
    }
  }

  if (notFound) {
    throw new Error('oldString not found in content')
  }
  throw new Error(
    'Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match.',
  )
}
