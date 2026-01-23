/**
 * LTM (Long-Term Memory) module
 *
 * Provides consolidation of durable knowledge from conversations.
 */

export {
  runConsolidation,
  runConsolidationWorker,
  isConversationNoteworthy,
  type ConsolidationResult,
} from "./consolidation"
