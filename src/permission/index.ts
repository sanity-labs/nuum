/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/permission/next.ts
 * License: MIT
 *
 * Simplified for nuum: removed Instance/Storage/Config dependencies,
 * standalone permission evaluation with in-memory ruleset.
 */

import {z} from 'zod'
import os from 'os'
import {Wildcard} from './wildcard'
import {Log} from '../util/log'

export {Wildcard} from './wildcard'

export namespace Permission {
  const log = Log.create({service: 'permission'})

  function expand(pattern: string): string {
    if (pattern.startsWith('~/')) return os.homedir() + pattern.slice(1)
    if (pattern === '~') return os.homedir()
    if (pattern.startsWith('$HOME/')) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith('$HOME')) return os.homedir() + pattern.slice(5)
    return pattern
  }

  export const Action = z.enum(['allow', 'deny', 'ask'])
  export type Action = z.infer<typeof Action>

  export const Rule = z.object({
    permission: z.string(),
    pattern: z.string(),
    action: Action,
  })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array()
  export type Ruleset = z.infer<typeof Ruleset>

  /**
   * Merge multiple rulesets into one.
   * Later rules take precedence.
   */
  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  /**
   * Evaluate a permission request against a ruleset.
   * Returns the matching rule, or a default "ask" rule if no match.
   */
  export function evaluate(
    permission: string,
    pattern: string,
    ...rulesets: Ruleset[]
  ): Rule {
    const merged = merge(...rulesets)
    log.info('evaluate', {permission, pattern, ruleset: merged})

    const match = merged.findLast(
      (rule) =>
        Wildcard.match(permission, rule.permission) &&
        Wildcard.match(pattern, rule.pattern),
    )

    return match ?? {action: 'ask', permission, pattern: '*'}
  }

  /**
   * Create a default ruleset that allows everything in a directory.
   * Used for Phase 1 auto-approve mode.
   */
  export function allowAll(): Ruleset {
    return [{permission: '*', pattern: '*', action: 'allow'}]
  }

  /**
   * Create a ruleset from a simple config object.
   */
  export function fromConfig(
    config: Record<string, Action | Record<string, Action>>,
  ): Ruleset {
    const ruleset: Ruleset = []
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        ruleset.push({
          permission: key,
          action: value,
          pattern: '*',
        })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({
          permission: key,
          pattern: expand(pattern),
          action,
        })),
      )
    }
    return ruleset
  }

  /** User rejected without message - halts execution */
  export class RejectedError extends Error {
    constructor() {
      super('The user rejected permission to use this specific tool call.')
    }
  }

  /** User rejected with message - continues with guidance */
  export class CorrectedError extends Error {
    constructor(message: string) {
      super(
        `The user rejected permission to use this specific tool call with the following feedback: ${message}`,
      )
    }
  }

  /** Auto-rejected by config rule - halts execution */
  export class DeniedError extends Error {
    constructor(public readonly ruleset: Ruleset) {
      super(
        `The user has specified a rule which prevents you from using this specific tool call. ` +
          `Relevant rules: ${JSON.stringify(ruleset)}`,
      )
    }
  }
}
