/**
 * Temporal summarization module.
 *
 * Phase 2 implementation of the temporal memory system with:
 * - Recursive summarization (order-1 through order-N)
 * - Compaction triggering and scheduling
 * - Temporal view construction
 * - Coverage detection
 */

// Coverage detection
export {
  isCoveredBySummary,
  isSubsumedByHigherOrder,
  getUncoveredMessages,
  getEffectiveSummaries,
  findCoverageGaps,
} from "./coverage"

// Temporal view construction
export {
  buildTemporalView,
  reconstructHistoryAsTurns,
  renderTemporalView,
  type TemporalView,
  type BuildTemporalViewOptions,
} from "./view"

// Compaction trigger and scheduling
export {
  shouldTriggerCompaction,
  getCompactionState,
  calculateCompactionTarget,
  getMessagesToCompact,
  shouldCreateOrder2Summary,
  shouldCreateHigherOrderSummary,
  COMPRESSION_TARGETS,
  type CompactionConfig,
  type CompactionState,
} from "./compaction"

// Summary creation
export {
  estimateSummaryTokens,
  createSummaryInsert,
  validateSummaryRange,
  validateSummaryTokens,
  findBreakpoints,
  groupMessagesForSummary,
  groupSummariesForHigherOrder,
  type SummaryInput,
  type CreateSummaryParams,
} from "./summary"

// Recursive summarization
export {
  getUnsubsumedSummariesAtOrder,
  getNextOrderToSummarize,
  calculateHigherOrderRange,
  checkCompressionInvariant,
  getExpectedTokenBudget,
  estimateRequiredOrders,
  calculateCompressionRatio,
  validateRecursiveSummary,
} from "./recursive"

// Mock LLM for testing
export { createMockLLM, type MockLLM, type MockLLMConfig, type MockSummaryOutput } from "./mock-llm"

// Compaction agent
export {
  runCompaction,
  runCompactionWorker,
  createSummarizationLLM,
  type CompactionResult,
  type SummarizationLLM,
} from "./compaction-agent"
