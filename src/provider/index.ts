/**
 * AI Provider integration for miriad-code
 *
 * Phase 1: Anthropic-only via @ai-sdk/anthropic
 * Simplified from OpenCode's multi-provider system.
 */

import { createAnthropic } from "@ai-sdk/anthropic"
import {
  generateText,
  streamText,
  type CoreMessage,
  type CoreTool,
  type LanguageModel,
  type StreamTextResult,
  type GenerateTextResult,
} from "ai"
import { z } from "zod"
import { Config } from "../config"
import { Log } from "../util/log"

export namespace Provider {
  const log = Log.create({ service: "provider" })

  /**
   * Get an Anthropic API key from environment.
   * Throws if not found.
   */
  function getApiKey(): string {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required.\n" +
          "Set it with: export ANTHROPIC_API_KEY=sk-...",
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
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-1m-2025-08-07",
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
    log.debug("resolving model tier", { tier, modelId })
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
  }

  /**
   * Wrap tools to make them resilient to validation errors.
   * 
   * When the model makes a tool call with invalid arguments (wrong param names,
   * type mismatches, etc.), we want the model to see the error and retry -
   * not crash the turn.
   * 
   * For each tool, we create a wrapper that:
   * 1. Keeps the original schema (so model sees proper parameter docs)
   * 2. Wraps execute to catch any errors and return them as results
   * 
   * Note: This catches errors thrown by the execute function itself.
   * Schema validation errors from the AI SDK are handled separately via
   * experimental_repairToolCall.
   */
  function wrapToolsForErrorResilience(
    tools: Record<string, CoreTool> | undefined
  ): Record<string, CoreTool> | undefined {
    if (!tools) return undefined

    const wrapped: Record<string, CoreTool> = {}

    for (const [name, tool] of Object.entries(tools)) {
      const originalExecute = tool.execute

      if (!originalExecute) {
        // Tool without execute - pass through unchanged
        wrapped[name] = tool
        continue
      }

      wrapped[name] = {
        ...tool,
        // Keep original schema so model sees proper parameter documentation
        execute: async (args: unknown, context: unknown) => {
          try {
            return await originalExecute(args, context as Parameters<typeof originalExecute>[1])
          } catch (error) {
            // Return error as result instead of throwing
            const message = error instanceof Error ? error.message : String(error)
            log.warn("tool execution error - returning to model", {
              toolName: name,
              error: message,
            })
            return `Error executing tool ${name}: ${message}`
          }
        },
      }
    }

    return wrapped
  }



  /**
   * Generate text without streaming.
   */
  export async function generate(options: GenerateOptions): Promise<GenerateTextResult<Record<string, CoreTool>, never>> {
    log.debug("generate", {
      model: options.model.modelId,
      messageCount: options.messages.length,
      hasTools: !!options.tools,
    })

    return generateText({
      model: options.model,
      messages: options.messages,
      tools: wrapToolsForErrorResilience(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system: options.system,
    })
  }

  /**
   * Stream text generation.
   */
  export async function stream(
    options: GenerateOptions,
  ): Promise<StreamTextResult<Record<string, CoreTool>, never>> {
    log.debug("stream", {
      model: options.model.modelId,
      messageCount: options.messages.length,
      hasTools: !!options.tools,
    })

    return streamText({
      model: options.model,
      messages: options.messages,
      tools: wrapToolsForErrorResilience(options.tools),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      abortSignal: options.abortSignal,
      system: options.system,
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
