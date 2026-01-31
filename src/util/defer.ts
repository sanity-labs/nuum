/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/util/defer.ts
 * License: MIT
 */

export function defer<T extends () => void | Promise<void>>(
  fn: T,
): T extends () => Promise<void>
  ? {[Symbol.asyncDispose]: () => Promise<void>}
  : {[Symbol.dispose]: () => void} {
  return {
    [Symbol.dispose]() {
      fn()
    },
    [Symbol.asyncDispose]() {
      return Promise.resolve(fn())
    },
  } as any
}
