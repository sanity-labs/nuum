/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/bus/index.ts
 * License: MIT
 *
 * Simplified for nuum: removed Instance/Global dependencies,
 * standalone event bus implementation.
 */

import {z} from 'zod'
import {Log} from '../util/log'
import {BusEvent} from './event'

export {BusEvent} from './event'

export namespace Bus {
  const log = Log.create({service: 'bus'})
  type Subscription = (event: unknown) => void | Promise<void>

  const subscriptions = new Map<string, Subscription[]>()

  export async function publish<Definition extends BusEvent.Definition>(
    def: Definition,
    properties: z.output<Definition['properties']>,
  ) {
    const payload = {
      type: def.type,
      properties,
    }
    log.info('publishing', {
      type: def.type,
    })
    const pending: (void | Promise<void>)[] = []
    for (const key of [def.type, '*']) {
      const match = subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(payload))
      }
    }
    return Promise.all(pending)
  }

  export function subscribe<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition['type']
      properties: z.infer<Definition['properties']>
    }) => void | Promise<void>,
  ) {
    return raw(def.type, callback as Subscription)
  }

  export function once<Definition extends BusEvent.Definition>(
    def: Definition,
    callback: (event: {
      type: Definition['type']
      properties: z.infer<Definition['properties']>
    }) => 'done' | undefined,
  ) {
    const unsub = subscribe(def, (event) => {
      if (callback(event)) unsub()
    })
  }

  export function subscribeAll(
    callback: (event: unknown) => void | Promise<void>,
  ) {
    return raw('*', callback)
  }

  function raw(type: string, callback: Subscription) {
    log.info('subscribing', {type})
    let match = subscriptions.get(type) ?? []
    match.push(callback)
    subscriptions.set(type, match)

    return () => {
      log.info('unsubscribing', {type})
      const match = subscriptions.get(type)
      if (!match) return
      const index = match.indexOf(callback)
      if (index === -1) return
      match.splice(index, 1)
    }
  }

  /** Clear all subscriptions - useful for testing */
  export function reset() {
    subscriptions.clear()
  }
}
