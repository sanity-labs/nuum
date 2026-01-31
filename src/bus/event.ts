/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/bus/bus-event.ts
 * License: MIT
 */

import {z} from 'zod'
import type {ZodType} from 'zod'

export namespace BusEvent {
  export type Definition<
    Type extends string = string,
    Properties extends ZodType = ZodType,
  > = {
    type: Type
    properties: Properties
  }

  const registry = new Map<string, Definition>()

  export function define<Type extends string, Properties extends ZodType>(
    type: Type,
    properties: Properties,
  ): Definition<Type, Properties> {
    const result = {
      type,
      properties,
    }
    registry.set(type, result)
    return result
  }

  export function payloads() {
    const entries = Array.from(registry.entries())
    if (entries.length === 0) {
      return z.never()
    }
    const schemas = entries.map(([type, def]) =>
      z.object({
        type: z.literal(type),
        properties: def.properties,
      }),
    )
    // Cast required because discriminatedUnion needs non-empty tuple type
    return z.discriminatedUnion(
      'type',
      schemas as unknown as [
        z.ZodDiscriminatedUnionOption<'type'>,
        ...z.ZodDiscriminatedUnionOption<'type'>[],
      ],
    )
  }
}
