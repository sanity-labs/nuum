/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/util/log.ts
 * License: MIT
 *
 * Simplified for nuum: removed Global.Path dependency, stderr-only output.
 * Enhanced with colors for better readability.
 */

import {z} from 'zod'
import pc from 'picocolors'

export namespace Log {
  export const Level = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  // Color functions for each level
  const levelColors: Record<Level, (s: string) => string> = {
    DEBUG: pc.gray,
    INFO: pc.blue,
    WARN: (s) => pc.bold(pc.yellow(s)),
    ERROR: (s) => pc.bold(pc.red(s)),
  }

  // Default to WARN so INFO logs don't appear unless verbose mode is enabled
  let level: Level = 'WARN'

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: string, extra?: Record<string, unknown>): void
    info(message?: string, extra?: Record<string, unknown>): void
    error(message?: string, extra?: Record<string, unknown>): void
    warn(message?: string, extra?: Record<string, unknown>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(
      message: string,
      extra?: Record<string, unknown>,
    ): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({service: 'default'})

  export interface Options {
    level?: Level
  }

  let write = (msg: string) => {
    process.stderr.write(msg)
    return msg.length
  }

  export function init(options: Options) {
    if (options.level) level = options.level
  }

  export function setLevel(newLevel: Level) {
    level = newLevel
  }

  export function setWriter(fn: (msg: string) => number) {
    write = fn
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    return error.cause instanceof Error && depth < 10
      ? result + ' Caused by: ' + formatError(error.cause, depth + 1)
      : result
  }

  let last = Date.now()

  export function create(tags?: Record<string, unknown>) {
    tags = tags || {}

    const service = tags['service']
    if (service && typeof service === 'string') {
      const cached = loggers.get(service)
      if (cached) {
        return cached
      }
    }

    function build(
      logLevel: Level,
      message: unknown,
      extra?: Record<string, unknown>,
    ) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const keyStr = pc.dim(key + '=')
          if (value instanceof Error) return keyStr + pc.red(formatError(value))
          if (typeof value === 'object')
            return keyStr + pc.cyan(JSON.stringify(value))
          return keyStr + value
        })
        .join(' ')
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()

      const timestamp = pc.dim(next.toISOString().split('.')[0])
      const duration = pc.dim('+' + diff + 'ms')
      const levelStr = levelColors[logLevel](logLevel.padEnd(5))

      return (
        [levelStr, timestamp, duration, prefix, message]
          .filter(Boolean)
          .join(' ') + '\n'
      )
    }

    const result: Logger = {
      debug(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('DEBUG')) {
          write(build('DEBUG', message, extra))
        }
      },
      info(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('INFO')) {
          write(build('INFO', message, extra))
        }
      },
      error(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('ERROR')) {
          write(build('ERROR', message, extra))
        }
      },
      warn(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('WARN')) {
          write(build('WARN', message, extra))
        }
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({...tags})
      },
      time(message: string, extra?: Record<string, unknown>) {
        const now = Date.now()
        result.info(message, {status: 'started', ...extra})
        function stop() {
          result.info(message, {
            status: 'completed',
            duration: Date.now() - now,
            ...extra,
          })
        }
        return {
          stop,
          [Symbol.dispose]() {
            stop()
          },
        }
      },
    }

    if (service && typeof service === 'string') {
      loggers.set(service, result)
    }

    return result
  }
}
