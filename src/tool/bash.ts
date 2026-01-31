/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/bash.ts
 * License: MIT
 *
 * Simplified for miriad-code: removed tree-sitter parsing, Instance dependency.
 * Basic bash execution with timeout and abort support.
 */

import {z} from 'zod'
import {spawn} from 'child_process'
import {Tool} from './tool'
import {Shell} from '../shell'
import {Log} from '../util/log'
import {getSpawnEnvironment} from '../context/environment'

const MAX_OUTPUT_LENGTH = 50_000
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes

const log = Log.create({service: 'bash-tool'})

export interface BashMetadata {
  output: string
  exit: number | null
  description: string
  truncated?: boolean
}

export const BashTool = Tool.define<
  z.ZodObject<{
    command: z.ZodString
    timeout: z.ZodOptional<z.ZodNumber>
    workdir: z.ZodOptional<z.ZodString>
    description: z.ZodString
  }>,
  BashMetadata
>('bash', {
  description: `Execute a bash command in a persistent shell session.

IMPORTANT: Prefer dedicated tools for file operations instead of bash:
- Use Read tool instead of cat/head/tail
- Use Edit tool instead of sed/awk
- Use Write tool instead of echo with redirection
- Use Glob tool instead of find/ls

Use this tool for:
- Git operations
- Package management (npm, pnpm, etc.)
- Running tests and builds
- System commands that don't have dedicated tools`,

  parameters: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z
      .number()
      .describe('Optional timeout in milliseconds (default: 120000)')
      .optional(),
    workdir: z
      .string()
      .describe(
        'Working directory for the command (default: current directory)',
      )
      .optional(),
    description: z
      .string()
      .describe(
        'Clear, concise description of what this command does in 5-10 words',
      ),
  }),

  async execute(params, ctx) {
    const shell = Shell.acceptable()
    const cwd = params.workdir || process.cwd()
    const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS

    log.debug('executing', {command: params.command, cwd, shell})

    if (timeout < 0) {
      throw new Error(
        `Invalid timeout value: ${timeout}. Timeout must be a positive number.`,
      )
    }

    // Request permission (auto-approved in Phase 1)
    await ctx.ask({
      permission: 'bash',
      patterns: [params.command],
      always: ['*'],
      metadata: {},
    })

    const proc = spawn(params.command, {
      shell,
      cwd,
      env: getSpawnEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    let output = ''

    ctx.metadata({
      metadata: {
        output: '',
        exit: null,
        description: params.description,
      },
    })

    const append = (chunk: Buffer) => {
      output += chunk.toString()
      ctx.metadata({
        metadata: {
          output:
            output.length > MAX_OUTPUT_LENGTH
              ? output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n... (truncated)'
              : output,
          exit: null,
          description: params.description,
        },
      })
    }

    proc.stdout?.on('data', append)
    proc.stderr?.on('data', append)

    let timedOut = false
    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, {exited: () => exited})

    if (ctx.abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    ctx.abort.addEventListener('abort', abortHandler, {once: true})

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      void kill()
    }, timeout + 100)

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeoutTimer)
        ctx.abort.removeEventListener('abort', abortHandler)
      }

      proc.once('exit', () => {
        exited = true
        cleanup()
        resolve()
      })

      proc.once('error', (error) => {
        exited = true
        cleanup()
        reject(error)
      })
    })

    const resultMetadata: string[] = []

    if (timedOut) {
      resultMetadata.push(
        `Command terminated after exceeding timeout (${timeout}ms)`,
      )
    }

    if (aborted) {
      resultMetadata.push('Command aborted by user')
    }

    if (resultMetadata.length > 0) {
      output +=
        '\n\n<bash_metadata>\n' +
        resultMetadata.join('\n') +
        '\n</bash_metadata>'
    }

    const truncated = output.length > MAX_OUTPUT_LENGTH
    const finalOutput = truncated
      ? output.slice(0, MAX_OUTPUT_LENGTH) + '\n\n... (truncated)'
      : output

    return {
      title: params.description,
      metadata: {
        output: finalOutput,
        exit: proc.exitCode,
        description: params.description,
        truncated,
      },
      output: finalOutput,
    }
  },
})
