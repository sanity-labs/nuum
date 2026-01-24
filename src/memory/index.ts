/**
 * Memory Management Module
 *
 * Orchestrates the full memory curation workflow:
 * 1. LTM Consolidation - Extract durable knowledge from recent conversation
 * 2. Distillation - Compress working memory (temporal) to target size
 *
 * This is the single source of truth for running memory management.
 * Used by both the main agent (async background) and CLI (--compact).
 */

import type { Storage } from "../storage"
import { Config } from "../config"
import {
  shouldTriggerCompaction,
  runCompactionWorker,
  getMessagesToCompact,
  getEffectiveViewTokens,
  type CompactionResult,
} from "../temporal"
import { runConsolidationWorker, type ConsolidationResult } from "../ltm"
import { activity } from "../util/activity-log"

/**
 * Result of a full memory curation run.
 */
export interface MemoryCurationResult {
  /** Whether curation ran at all */
  ran: boolean
  /** LTM consolidation result (if ran) */
  consolidation?: ConsolidationResult
  /** Distillation/compaction result (if ran) */
  distillation?: CompactionResult
}

/**
 * Options for memory curation.
 */
export interface MemoryCurationOptions {
  /** Skip the "should trigger" check and force run */
  force?: boolean
  /** Custom compaction threshold (default from config) */
  compactionThreshold?: number
  /** Custom compaction target (default from config) */
  compactionTarget?: number
}

/**
 * Flag to prevent concurrent curation runs.
 */
let curationInProgress = false

/**
 * Check if memory curation is currently running.
 */
export function isCurationInProgress(): boolean {
  return curationInProgress
}

/**
 * Run the full memory curation workflow.
 *
 * Phase 1: LTM Consolidation
 * - Extract durable knowledge from recent messages
 * - Must run BEFORE distillation while raw messages are available
 *
 * Phase 2: Distillation (Compaction)
 * - Compress working memory to target size
 * - Creates distillations that subsume older messages
 *
 * @param storage - Storage instance
 * @param options - Curation options
 * @returns Result of the curation run
 */
export async function runMemoryCuration(
  storage: Storage,
  options: MemoryCurationOptions = {},
): Promise<MemoryCurationResult> {
  // Prevent concurrent runs
  if (curationInProgress) {
    return { ran: false }
  }

  const config = Config.get()
  const threshold = options.compactionThreshold ?? config.tokenBudgets.compactionThreshold
  const target = options.compactionTarget ?? config.tokenBudgets.compactionTarget

  // Check if we should run (unless forced)
  if (!options.force) {
    const shouldRun = await shouldTriggerCompaction(
      storage.temporal,
      storage.workers,
      { compactionThreshold: threshold, compactionTarget: target },
    )
    if (!shouldRun) {
      return { ran: false }
    }
  }

  curationInProgress = true
  const result: MemoryCurationResult = { ran: true }

  try {
    // Phase 1: LTM Consolidation
    result.consolidation = await runLTMConsolidation(storage)

    // Phase 2: Distillation
    result.distillation = await runDistillation(storage, threshold, target, options.force)

    return result
  } finally {
    curationInProgress = false
  }
}

/**
 * Run LTM consolidation phase.
 */
async function runLTMConsolidation(storage: Storage): Promise<ConsolidationResult | undefined> {
  const { messages } = await getMessagesToCompact(storage.temporal)
  
  if (messages.length === 0) {
    return undefined
  }

  activity.ltmCurator.start("Knowledge curation", { messages: messages.length })

  try {
    const result = await runConsolidationWorker(storage, messages)

    if (result.ran) {
      const changes = result.entriesCreated + result.entriesUpdated + result.entriesArchived
      if (changes > 0) {
        activity.ltmCurator.complete(
          `${result.entriesCreated} created, ${result.entriesUpdated} updated, ${result.entriesArchived} archived`
        )
      } else {
        activity.ltmCurator.complete("No changes needed")
      }
    } else {
      activity.ltmCurator.skip(result.summary)
    }

    return result
  } catch (error) {
    activity.ltmCurator.error(error instanceof Error ? error.message : String(error))
    // Non-fatal - continue with distillation
    return undefined
  }
}

/**
 * Run distillation (compaction) phase.
 */
async function runDistillation(
  storage: Storage,
  threshold: number,
  target: number,
  force?: boolean,
): Promise<CompactionResult | undefined> {
  const tokensBefore = await getEffectiveViewTokens(storage.temporal)
  
  activity.distillation.start("Working memory optimization", {
    tokens: tokensBefore,
    target,
  })

  try {
    const result = await runCompactionWorker(storage, {
      compactionThreshold: threshold,
      compactionTarget: target,
      force,
    })

    activity.distillation.tokens(
      result.tokensBefore,
      result.tokensAfter,
      `${result.summariesCreated} distillations`
    )

    return result
  } catch (error) {
    activity.distillation.error(error instanceof Error ? error.message : String(error))
    return undefined
  }
}

// Re-export for convenience
export { getEffectiveViewTokens } from "../temporal"
