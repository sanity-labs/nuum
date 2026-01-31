/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/id/id.ts
 * License: MIT
 *
 * Modified prefixes for miriad-code entity types.
 */

import {z} from 'zod'
import {randomBytes} from 'crypto'

export namespace Identifier {
  const prefixes = {
    // Temporal memory
    message: 'msg',
    summary: 'sum',

    // Present state
    task: 'tsk',

    // LTM
    entry: 'ent',

    // Workers
    worker: 'wrk',

    // Background reports
    report: 'rpt',

    // Background tasks
    bgtask: 'bgt',
    queue: 'que',
    alarm: 'alm',

    // Misc
    session: 'ses',
    toolcall: 'tcl',
  } as const

  export type Prefix = keyof typeof prefixes

  export function schema(prefix: Prefix) {
    return z.string().startsWith(prefixes[prefix])
  }

  const LENGTH = 26

  // State for monotonic ID generation
  let lastTimestamp = 0
  let counter = 0

  export function ascending(prefix: Prefix, given?: string) {
    return generateID(prefix, false, given)
  }

  export function descending(prefix: Prefix, given?: string) {
    return generateID(prefix, true, given)
  }

  function generateID(
    prefix: Prefix,
    descending: boolean,
    given?: string,
  ): string {
    if (!given) {
      return create(prefix, descending)
    }

    if (!given.startsWith(prefixes[prefix])) {
      throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
    }
    return given
  }

  function randomBase62(length: number): string {
    const chars =
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    let result = ''
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  export function create(
    prefix: Prefix,
    descending: boolean,
    timestamp?: number,
  ): string {
    const currentTimestamp = timestamp ?? Date.now()

    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return (
      prefixes[prefix] +
      '_' +
      timeBytes.toString('hex') +
      randomBase62(LENGTH - 12)
    )
  }

  /** Extract timestamp from an ascending ID. Does not work with descending IDs. */
  export function timestamp(id: string): number {
    const prefix = id.split('_')[0]
    const hex = id.slice(prefix.length + 1, prefix.length + 13)
    const encoded = BigInt('0x' + hex)
    return Number(encoded / BigInt(0x1000))
  }
}
