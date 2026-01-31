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
export {isCoveredBySummary, isSubsumedByHigherOrder} from './coverage'

// Temporal view construction
export {
  buildTemporalView,
  reconstructHistoryAsTurns,
  type TemporalView,
  type BuildTemporalViewOptions,
} from './view'

// Compaction trigger and scheduling
export {
  shouldTriggerCompaction,
  getCompactionState,
  calculateCompactionTarget,
  getMessagesToCompact,
  getEffectiveViewTokens,
  shouldCreateOrder2Summary,
  shouldCreateHigherOrderSummary,
  COMPRESSION_TARGETS,
  type CompactionConfig,
  type CompactionState,
} from './compaction'

// Summary/distillation types
export {estimateSummaryTokens, type SummaryInput} from './summary'

// Mock LLM for testing
export {
  createMockLLM,
  type MockLLM,
  type MockLLMConfig,
  type MockSummaryOutput,
} from './mock-llm'

// Compaction agent
export {
  runCompaction,
  runCompactionWorker,
  type CompactionResult,
  type CompactionConfig as AgentCompactionConfig,
} from './compaction-agent'
