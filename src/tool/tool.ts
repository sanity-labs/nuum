/**
 * Adapted from OpenCode (https://github.com/sst/opencode)
 * Original file: packages/opencode/src/tool/tool.ts
 * License: MIT
 *
 * Simplified for miriad-code: removed Truncate/agent dependencies,
 * standalone tool definition pattern.
 */

import {z} from 'zod'

export namespace Tool {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Metadata {}

  /**
   * Permission request for ctx.ask()
   * Simplified from OpenCode's PermissionNext.Request
   */
  export interface PermissionRequest {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }

  /**
   * Tool execution context provided to every tool call
   */
  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    abort: AbortSignal
    callID?: string
    extra?: Record<string, unknown>

    /**
     * Report metadata about tool execution progress.
     * Used for streaming UI updates.
     */
    metadata(input: {title?: string; metadata?: M}): void

    /**
     * Request permission for an operation.
     * In Phase 1, this auto-approves. Will be wired to permission system later.
     */
    ask(input: PermissionRequest): Promise<void>
  }

  /**
   * Tool execution result
   */
  export interface Result<M extends Metadata = Metadata> {
    title: string
    metadata: M
    output: string
  }

  /**
   * Tool definition with parameters schema and execute function
   */
  export interface Definition<
    Parameters extends z.ZodType = z.ZodType,
    M extends Metadata = Metadata,
  > {
    description: string
    parameters: Parameters
    execute(args: z.infer<Parameters>, ctx: Context<M>): Promise<Result<M>>
  }

  /**
   * Registered tool info
   */
  export interface Info<
    Parameters extends z.ZodType = z.ZodType,
    M extends Metadata = Metadata,
  > {
    id: string
    definition: Definition<Parameters, M>
  }

  export type InferParameters<T extends Info> =
    T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> =
    T extends Info<z.ZodType, infer M> ? M : never

  /**
   * Define a tool with the given ID and definition.
   * Wraps the execute function with parameter validation.
   */
  export function define<Parameters extends z.ZodType, M extends Metadata>(
    id: string,
    definition: Definition<Parameters, M>,
  ): Info<Parameters, M> {
    const originalExecute = definition.execute

    const wrappedDefinition: Definition<Parameters, M> = {
      ...definition,
      async execute(args, ctx) {
        // Validate parameters
        try {
          definition.parameters.parse(args)
        } catch (error) {
          if (error instanceof z.ZodError) {
            const issues = error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', ')
            throw new Error(
              `The ${id} tool was called with invalid arguments: ${issues}.\n` +
                `Please rewrite the input so it satisfies the expected schema.`,
              {cause: error},
            )
          }
          throw error
        }

        return originalExecute(args, ctx)
      },
    }

    return {
      id,
      definition: wrappedDefinition,
    }
  }

  /**
   * Create a tool context with auto-approve permission.
   * Used for Phase 1 where we don't have interactive permission UI.
   */
  export function createContext(options: {
    sessionID: string
    messageID: string
    abort?: AbortSignal
    callID?: string
    onMetadata?: (input: {title?: string; metadata?: Metadata}) => void
  }): Context {
    return {
      sessionID: options.sessionID,
      messageID: options.messageID,
      abort: options.abort ?? new AbortController().signal,
      callID: options.callID,
      metadata(input) {
        options.onMetadata?.(input)
      },
      async ask(_input) {
        // Auto-approve in Phase 1
        // Will be wired to actual permission system later
      },
    }
  }
}
