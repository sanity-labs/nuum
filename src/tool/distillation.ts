/**
 * Distillation tools for the distillation agent.
 *
 * These tools are used by the distillation agent to compress conversation
 * history into optimized working memory.
 */

import { tool } from "ai"
import type { CoreTool } from "ai"
import { z } from "zod"
import type { Storage } from "../storage"
import type { TemporalSummaryInsert } from "../storage/schema"
import { Identifier } from "../id"
import { Log } from "../util/log"
import { activity } from "../util/activity-log"
import { estimateSummaryTokens, type SummaryInput } from "../temporal/summary"
import { getEffectiveViewTokens } from "../temporal/compaction"

const log = Log.create({ service: "distillation-tools" })

/**
 * Result of a distillation tool execution.
 */
export interface DistillationToolResult {
  output: string
  done: boolean
  distillationCreated: boolean
  /** Contextual summary when finishing (for background reports) */
  summary?: string
}

/**
 * Context needed to build distillation tools.
 */
export interface DistillationToolContext {
  storage: Storage
  validIds: Set<string>
  targetTokens: number
}

/**
 * Build the create_distillation tool.
 *
 * This tool creates a distillation (summary) covering a range of messages.
 * It validates IDs, adjusts boundaries to preserve tool_call/tool_result pairs,
 * and reports progress toward the token target.
 */
export function buildCreateDistillationTool(
  ctx: DistillationToolContext,
  results: Map<string, DistillationToolResult>,
): CoreTool {
  const { storage, validIds, targetTokens } = ctx

  return tool({
    description:
      "Distill a range of conversation into optimized working memory. Focuses on retaining actionable intelligence while excising noise. Eliminating old cruft is also a form of optimization.",
    parameters: z.object({
      startId: z
        .string()
        .describe(
          "ULID of the first item to include (inclusive). Must be a visible ID.",
        ),
      endId: z
        .string()
        .describe(
          "ULID of the last item to include (inclusive). Must be a visible ID.",
        ),
      operationalContext: z
        .string()
        .describe(
          "Focused paragraph of what was accomplished, decided, or learned. Write as working notes - concrete and actionable, not narrative prose. Include file paths, specific values, and rationale for decisions.",
        ),
      retainedFacts: z
        .array(z.string())
        .describe(
          "Array of specific, referenceable facts. Each should be concrete and actionable, e.g., 'Protocol server is at src/jsonrpc/index.ts' or 'User prefers simplicity over backwards compatibility'.",
        ),
    }),
    execute: async (
      { startId, endId, operationalContext, retainedFacts },
      { toolCallId },
    ) => {
      // Validate IDs
      if (!validIds.has(startId)) {
        const result: DistillationToolResult = {
          output: `Error: startId "${startId}" is not a visible ID. Use only IDs shown in the conversation history.`,
          done: false,
          distillationCreated: false,
        }
        results.set(toolCallId, result)
        return result.output
      }
      if (!validIds.has(endId)) {
        const result: DistillationToolResult = {
          output: `Error: endId "${endId}" is not a visible ID. Use only IDs shown in the conversation history.`,
          done: false,
          distillationCreated: false,
        }
        results.set(toolCallId, result)
        return result.output
      }
      if (startId > endId) {
        const result: DistillationToolResult = {
          output: `Error: startId must be <= endId (got ${startId} > ${endId})`,
          done: false,
          distillationCreated: false,
        }
        results.set(toolCallId, result)
        return result.output
      }

      // Adjust boundaries to avoid cutting tool_call/tool_result pairs
      const allMessages = await storage.temporal.getMessages()
      const sortedMessages = [...allMessages].sort((a, b) =>
        a.id.localeCompare(b.id),
      )

      let adjustedStartId = startId
      let adjustedEndId = endId

      // Find the message at startId - if it's a tool_result, include the preceding tool_call
      const startIdx = sortedMessages.findIndex((m) => m.id === startId)
      if (startIdx > 0) {
        const startMsg = sortedMessages[startIdx]
        const prevMsg = sortedMessages[startIdx - 1]
        if (
          startMsg?.type === "tool_result" &&
          prevMsg?.type === "tool_call"
        ) {
          adjustedStartId = prevMsg.id
        }
      }

      // Find the message at endId - if it's a tool_call, include the following tool_result
      const endIdx = sortedMessages.findIndex((m) => m.id === endId)
      if (endIdx >= 0 && endIdx < sortedMessages.length - 1) {
        const endMsg = sortedMessages[endIdx]
        const nextMsg = sortedMessages[endIdx + 1]
        if (endMsg?.type === "tool_call" && nextMsg?.type === "tool_result") {
          adjustedEndId = nextMsg.id
        }
      }

      // Determine the order of the new distillation
      // If it subsumes any existing distillations, it's one order higher than the max subsumed
      const summaries = await storage.temporal.getSummaries()
      const subsumedSummaries = summaries.filter(
        (s) => s.startId >= adjustedStartId && s.endId <= adjustedEndId,
      )
      const maxSubsumedOrder =
        subsumedSummaries.length > 0
          ? Math.max(...subsumedSummaries.map((s) => s.orderNum))
          : 0
      const newOrder = maxSubsumedOrder + 1

      // Create the distillation (stored as summary for compatibility)
      const input: SummaryInput = {
        narrative: operationalContext,
        keyObservations: retainedFacts,
        tags: [], // Could extract tags from content in future
      }

      const summaryInsert: TemporalSummaryInsert = {
        id: Identifier.ascending("summary"),
        orderNum: newOrder,
        startId: adjustedStartId,
        endId: adjustedEndId,
        narrative: input.narrative,
        keyObservations: JSON.stringify(input.keyObservations),
        tags: JSON.stringify(input.tags),
        tokenEstimate: estimateSummaryTokens(input),
        createdAt: new Date().toISOString(),
      }

      await storage.temporal.createSummary(summaryInsert)

      // Note if boundaries were adjusted to preserve tool call pairs
      const wasAdjusted =
        adjustedStartId !== startId || adjustedEndId !== endId
      const adjustmentNote = wasAdjusted
        ? ` (adjusted to ${adjustedStartId} → ${adjustedEndId} to preserve tool call pairs)`
        : ""

      // Get current token count to report progress
      const currentTokens = await getEffectiveViewTokens(storage.temporal)
      const atTarget = currentTokens <= targetTokens
      const tokenStatus = atTarget
        ? `\n\n**Status:** ${currentTokens.toLocaleString()} tokens (✓ at/under target of ${targetTokens.toLocaleString()}). You may call finish_distillation or continue cleaning up.`
        : `\n\n**Status:** ${currentTokens.toLocaleString()} tokens (target: ${targetTokens.toLocaleString()}, need to distill ~${(currentTokens - targetTokens).toLocaleString()} more)`

      activity.distillation.info(
        `Created order-${newOrder} distillation (${summaryInsert.tokenEstimate} tokens, ${retainedFacts.length} facts) → ${currentTokens.toLocaleString()} tokens${atTarget ? " ✓" : ""}`,
      )

      const result: DistillationToolResult = {
        output: `Created order-${newOrder} distillation covering ${adjustedStartId} → ${adjustedEndId} (~${summaryInsert.tokenEstimate} tokens, ${retainedFacts.length} facts retained).${adjustmentNote}${subsumedSummaries.length > 0 ? ` Subsumed ${subsumedSummaries.length} existing distillations.` : ""}${tokenStatus}`,
        done: false,
        distillationCreated: true,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })
}

/**
 * Build the finish_distillation tool.
 *
 * Signals that distillation is complete and provides a contextual summary
 * for the background report.
 */
export function buildFinishDistillationTool(
  results: Map<string, DistillationToolResult>,
): CoreTool {
  return tool({
    description:
      "Signal that working memory optimization is complete. Write a contextual summary for your future self explaining what you compressed and what you retained.",
    parameters: z.object({
      summary: z
        .string()
        .describe(
          "A note to your future self: what did you compress and what key information did you retain? Example: 'Combined the three debugging sessions into one distillation - retained the key insight about the race condition and the fix in src/agent/loop.ts.'",
        ),
    }),
    execute: async ({ summary }, { toolCallId }) => {
      log.info("distillation finished", { summary })
      const result: DistillationToolResult = {
        output: `Distillation complete`,
        done: true,
        distillationCreated: false,
        summary,
      }
      results.set(toolCallId, result)
      return result.output
    },
  })
}

/**
 * Build all distillation tools.
 *
 * Returns the tools and a function to get the last result for tracking.
 */
export function buildDistillationTools(ctx: DistillationToolContext): {
  tools: Record<string, CoreTool>
  getLastResult: (toolCallId: string) => DistillationToolResult | undefined
} {
  const results = new Map<string, DistillationToolResult>()

  return {
    tools: {
      create_distillation: buildCreateDistillationTool(ctx, results),
      finish_distillation: buildFinishDistillationTool(results),
    },
    getLastResult: (toolCallId: string) => results.get(toolCallId),
  }
}
