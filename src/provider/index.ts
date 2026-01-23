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
        "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
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
    log.info("resolving model tier", { tier, modelId })
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
   * Generate text without streaming.
   */
  export async function generate(options: GenerateOptions): Promise<GenerateTextResult<Record<string, CoreTool>, never>> {
    log.info("generate", {
      model: options.model.modelId,
      messageCount: options.messages.length,
      hasTools: !!options.tools,
    })

    return generateText({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
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
    log.info("stream", {
      model: options.model.modelId,
      messageCount: options.messages.length,
      hasTools: !!options.tools,
    })

    return streamText({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
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
