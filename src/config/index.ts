/**
 * Configuration for nuum
 *
 * Phase 1: Simple env-based config with sensible defaults.
 * Only ANTHROPIC_API_KEY is required.
 */

import {z} from 'zod'

export namespace Config {
  /**
   * Model tiers for different use cases.
   * See arch spec for token budget rationale.
   */
  export type ModelTier = 'reasoning' | 'workhorse' | 'fast'

  export const Schema = z.object({
    provider: z.string().default('anthropic'),
    models: z.object({
      /** Main agent, LTM reflection - best judgment (Opus 4.5, 200k context) */
      reasoning: z.string().default('claude-opus-4-6'),
      /** Memory management, search - high context (Sonnet 4.5, 1M beta) */
      workhorse: z.string().default('claude-sonnet-4-5-20250929'),
      /** Quick classifications - fast response (Haiku 4.5, 200k context) */
      fast: z.string().default('claude-haiku-4-5-20251001'),
    }),
    db: z.string().default('./agent.db'),
    tokenBudgets: z.object({
      /** Main agent context limit (Opus 200k, leave room for response) */
      mainAgentContext: z.number().default(180_000),
      /** Max tokens for temporal view in prompt */
      temporalBudget: z.number().default(64_000),
      /** Soft limit: run compaction synchronously before turn if exceeded */
      compactionThreshold: z.number().default(80_000),
      /** Target size after compaction */
      compactionTarget: z.number().default(60_000),
      /** Hard limit: refuse turn entirely if exceeded (emergency brake) */
      compactionHardLimit: z.number().default(150_000),
      /** Minimum recent messages to preserve (never summarized) */
      recencyBufferMessages: z.number().default(10),
      /** Temporal search sub-agent budget (Sonnet 1M beta) */
      temporalQueryBudget: z.number().default(512_000),
      /** LTM reflection sub-agent budget (Opus) */
      ltmReflectBudget: z.number().default(180_000),
      /** LTM consolidation worker budget (Sonnet 1M beta) */
      ltmConsolidateBudget: z.number().default(512_000),
    }),
  })

  export type Config = z.infer<typeof Schema>

  let cached: Config | null = null

  /**
   * Get the current configuration.
   * Loads from environment variables with sensible defaults.
   */
  export function get(): Config {
    if (cached) return cached

    cached = Schema.parse({
      provider: process.env.AGENT_PROVIDER,
      models: {
        reasoning: process.env.AGENT_MODEL_REASONING,
        workhorse: process.env.AGENT_MODEL_WORKHORSE,
        fast: process.env.AGENT_MODEL_FAST,
      },
      db: process.env.AGENT_DB,
      tokenBudgets: {},
    })

    return cached
  }

  /**
   * Get the model ID for a given tier.
   */
  export function resolveModelTier(tier: ModelTier): string {
    const config = get()
    return config.models[tier]
  }

  /**
   * Reset cached config (for testing).
   */
  export function reset(): void {
    cached = null
  }
}
