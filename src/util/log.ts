/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/util/log.ts
 * License: MIT
 *
 * Simplified for miriad-code: removed Global.Path dependency, stderr-only output.
 */

import {z} from 'zod'

export namespace Log {
  export const Level = z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  export type Level = z.infer<typeof Level>

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = 'INFO'

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

    function build(message: unknown, extra?: Record<string, unknown>) {
      const prefix = Object.entries({
        ...tags,
        ...extra,
      })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const prefix = `${key}=`
          if (value instanceof Error) return prefix + formatError(value)
          if (typeof value === 'object') return prefix + JSON.stringify(value)
          return prefix + value
        })
        .join(' ')
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return (
        [next.toISOString().split('.')[0], '+' + diff + 'ms', prefix, message]
          .filter(Boolean)
          .join(' ') + '\n'
      )
    }

    const result: Logger = {
      debug(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('DEBUG')) {
          write('DEBUG ' + build(message, extra))
        }
      },
      info(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('INFO')) {
          write('INFO  ' + build(message, extra))
        }
      },
      error(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('ERROR')) {
          write('ERROR ' + build(message, extra))
        }
      },
      warn(message?: string, extra?: Record<string, unknown>) {
        if (shouldLog('WARN')) {
          write('WARN  ' + build(message, extra))
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
