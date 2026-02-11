/**
 * AI Provider integration for nuum
 *
 * Phase 1: Anthropic-only via @ai-sdk/anthropic
 * Simplified from OpenCode's multi-provider system.
 */

import {createAnthropic} from '@ai-sdk/anthropic'
import {
  generateText,
  streamText,
  tool,
  InvalidToolArgumentsError,
  NoSuchToolError,
  type CoreMessage,
  type CoreTool,
  type LanguageModel,
  type StreamTextResult,
  type GenerateTextResult,
  type ToolSet,
} from 'ai'
import {Mcp} from '../mcp/index.js'
import {z} from 'zod'
import {Config} from '../config'
import {Log} from '../util/log'

export namespace Provider {
  const log = Log.create({service: 'provider'})

  /**
   * Get an Anthropic API key from environment.
   * Throws if not found.
   */
  function getApiKey(): string {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required.\n' +
          'Set it with: export ANTHROPIC_API_KEY=sk-...',
      )
    }
    return key
  }

  /**
   * Create an Anthropic provider instance.
   */
  function createProvider() {
    return createAnthropic({
      apiKey: getApiKey(),
      headers: {
        // Enable Claude Code beta features
        // - claude-code: Claude Code specific features
        // - interleaved-thinking: Extended thinking with interleaved output
        // - context-1m: 1M token context window for Sonnet
        'anthropic-beta':
          'claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07',
      },
    })
  }

  /**
   * Get a language model for a given model ID.
   */
  export function getModel(modelId: string): LanguageModel {
    const anthropic = createProvider()
    return anthropic(modelId)
  }

  /**
   * Get a language model for a given tier.
   */
  export function getModelForTier(tier: Config.ModelTier): LanguageModel {
    const modelId = Config.resolveModelTier(tier)
    log.debug('resolving model tier', {tier, modelId})
    return getModel(modelId)
  }

  /**
   * Options for text generation
   */
  export interface GenerateOptions {
    model: LanguageModel
    messages: CoreMessage[]
    tools?: Record<string, CoreTool>
    maxTokens?: number
    temperature?: number
    abortSignal?: AbortSignal
    system?: string
    /** Enable Anthropic prompt caching for the system prompt */
    cacheSystemPrompt?: boolean
  }

  /**
   * Internal tool name for surfacing validation errors to the model.
   * This tool is added to every tool set and used by repairToolCall
   * to redirect invalid tool calls.
   */
  const INVALID_TOOL_CALL = '__invalid_tool_call__'

  /**
   * Create the internal error tool that surfaces validation errors.
   * The tool result includes what the agent tried to do so they can fix it.
   */
  function createInvalidToolCallTool(): CoreTool {
    return tool({
      description:
        'Internal tool - surfaces validation errors for invalid tool calls',
      parameters: z.object({
        toolName: z.string().describe('The tool that was called'),
        args: z.string().describe('The arguments that were provided (as JSON)'),
        error: z.string().describe('The validation error message'),
      }),
      execute: async ({toolName, args, error}) => {
        return `Error: Invalid tool call to "${toolName}"

You provided these arguments:
${args}

Validation error:
${error}

Please check the tool's parameter schema and try again with correct arguments.`
      },
    })
  }

  /**
   * Create a repair function that redirects invalid tool calls to our error tool.
   *
   * When the model makes a tool call with invalid arguments, instead of crashing
   * the turn, we redirect to __invalid_tool_call__ which returns the error as
   * a tool result. The model sees what it tried to do and can retry.
   *
   * Also provides context-aware errors for MCP servers that are still connecting
   * or have failed, so the agent knows to wait or adjust strategy.
   */
  function createToolCallRepairFunction<TOOLS extends ToolSet>() {
    return async ({
      toolCall,
      error,
    }: {
      toolCall: {toolName: string; toolCallId: string; args: unknown}
      tools: TOOLS
      parameterSchema: (options: {toolName: string}) => unknown
      error: NoSuchToolError | InvalidToolArgumentsError
    }) => {
      let errorMessage = error.message || String(error)

      // Check if this is a NoSuchToolError for an MCP server that's still connecting or failed
      if (error instanceof NoSuchToolError) {
        const manager = Mcp.getManager()
        const connectingServer = manager.getConnectingServerForTool(toolCall.toolName)
        if (connectingServer) {
          errorMessage = `MCP server "${connectingServer}" is still connecting. This tool is not yet available. Wait a moment and try again, or proceed with other work first.`
        } else {
          const failedServer = manager.getFailedServerForTool(toolCall.toolName)
          if (failedServer) {
            errorMessage = `MCP server "${failedServer.serverName}" failed to connect: ${failedServer.error}. This tool is unavailable for this session.`
          }
        }
      }

      log.warn('invalid tool call - redirecting to error tool', {
        toolName: toolCall.toolName,
        error: errorMessage,
      })

      // Redirect to our error tool with full context
      // Note: args must be a stringified JSON per LanguageModelV1FunctionToolCall type
      return {
        toolCallType: 'function' as const,
        toolName: INVALID_TOOL_CALL,
        toolCallId: toolCall.toolCallId,
        args: JSON.stringify({
          toolName: toolCall.toolName,
          args: JSON.stringify(toolCall.args, null, 2),
          error: errorMessage,
        }),
      }
    }
  }

  /**
   * Prepare messages with optional system prompt caching.
   *
   * When cacheSystemPrompt is true, converts the system string to a system message
   * with Anthropic cache control. This enables prompt caching for the (typically large
   * and stable) system prompt.
   */
  function prepareMessages(
    messages: CoreMessage[],
    system: string | undefined,
    cacheSystemPrompt: boolean,
  ): {messages: CoreMessage[]; system: string | undefined} {
    if (!system) {
      return {messages, system: undefined}
    }

    if (!cacheSystemPrompt) {
      // No caching - use the standard system parameter
      return {messages, system}
    }

    // With caching - convert system to a message with cache control
    // The AI SDK requires system prompts to be in the messages array to add providerOptions
    const systemMessage: CoreMessage = {
      role: 'system',
      content: system,
      providerOptions: {
        anthropic: {
          cacheControl: {type: 'ephemeral'},
        },
      },
    } as CoreMessage // Type assertion needed for providerOptions

    return {
      messages: [systemMessage, ...messages],
      system: undefined, // Don't pass system separately when it's in messages
    }
  }

  /**
   * Add the invalid tool call handler and wrap tools for runtime error resilience.
   *
   * This does two things:
   * 1. Adds __invalid_tool_call__ tool for surfacing validation errors
   * 2. Wraps each tool's execute to catch runtime errors
   */
  function prepareTools(
    tools: Record<string, CoreTool> | undefined,
  ): Record<string, CoreTool> | undefined {
    if (!tools) return undefined

    const prepared: Record<string, CoreTool> = {
      // Add our error handling tool
      [INVALID_TOOL_CALL]: createInvalidToolCallTool(),
    }

    for (const [name, t] of Object.entries(tools)) {
      const originalExecute = t.execute

      if (!originalExecute) {
        // Tool without execute - pass through unchanged
        prepared[name] = t
        continue
      }

      prepared[name] = {
        ...t,
        // Keep original schema so model sees proper parameter documentation
        execute: async (args: unknown, context: unknown) => {
          try {
            return await originalExecute(
              args,
              context as Parameters<typeof originalExecute>[1],
            )
          } catch (error) {
            // Return error as result instead of throwing
            const message =
              error instanceof Error ? error.message : String(error)
            log.warn('tool execution error - returning to model', {
              toolName: name,
              error: message,
            })
            return `Error executing tool "${name}": ${message}`
          }
        },
      }
    }

    return prepared
  }

  /**
   * Generate text without streaming.
   */
  export async function generate(
    options: GenerateOptions,
  ): Promise<GenerateTextResult<Record<string, CoreTool>, never>> {
    const {messages, system} = prepareMessages(
      options.messages,
      options.system,
      options.cacheSystemPrompt ?? false,
    )

    log.debug('generate', {
      model: options.model.modelId,
      messageCount: messages.length,
      hasTools: !!options.tools,
      cacheSystemPrompt: options.cacheSystemPrompt ?? false,
    })

    return generateText({
      model: options.model,
      messages,
      tools: prepareTools(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system,
      experimental_repairToolCall: createToolCallRepairFunction(),
    })
  }

  /**
   * Stream text generation.
   */
  export async function stream(
    options: GenerateOptions,
  ): Promise<StreamTextResult<Record<string, CoreTool>, never>> {
    const {messages, system} = prepareMessages(
      options.messages,
      options.system,
      options.cacheSystemPrompt ?? false,
    )

    log.debug('stream', {
      model: options.model.modelId,
      messageCount: messages.length,
      hasTools: !!options.tools,
      cacheSystemPrompt: options.cacheSystemPrompt ?? false,
    })

    return streamText({
      model: options.model,
      messages,
      tools: prepareTools(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system,
      experimental_repairToolCall: createToolCallRepairFunction(),
    })
  }

  /**
   * Tool definition schema for validation
   */
  export const ToolCallSchema = z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    args: z.record(z.unknown()),
  })
  export type ToolCall = z.infer<typeof ToolCallSchema>

  /**
   * Tool result schema for validation
   */
  export const ToolResultSchema = z.object({
    toolCallId: z.string(),
    result: z.unknown(),
  })
  export type ToolResult = z.infer<typeof ToolResultSchema>
}
