/**
 * Tool system adapted from OpenCode (https://github.com/sst/opencode)
 * License: MIT
 */

export { Tool } from "./tool"
export { BashTool, type BashMetadata } from "./bash"
export { ReadTool, type ReadMetadata } from "./read"
export { EditTool, type EditMetadata } from "./edit"
export { WriteTool, type WriteMetadata } from "./write"
export { GlobTool, type GlobMetadata } from "./glob"
export { GrepTool, type GrepMetadata } from "./grep"
export { WebSearchTool, type WebSearchMetadata, type SearchResult } from "./web-search"
export { WebFetchTool, type WebFetchMetadata } from "./web-fetch"
export { ReflectTool, type ReflectMetadata, type ReflectToolContext } from "./reflect"
export { ResearchTool, type ResearchMetadata, type ResearchToolContext } from "./research"
export { McpStatusTool, type McpStatusMetadata } from "./mcp-status"
export {
  LTMGlobTool,
  LTMSearchTool,
  LTMReadTool,
  LTMCreateTool,
  LTMUpdateTool,
  LTMEditTool,
  LTMReparentTool,
  LTMRenameTool,
  LTMArchiveTool,
  LTMReadOnlyTools,
  LTMWriteTools,
  LTMTools,
  renderCompactTree,
  parseGlobDisplayDepth,
  type LTMToolContext,
  type LTMMetadata,
} from "./ltm"

// Distillation agent tools
export {
  buildDistillationTools,
  buildCreateDistillationTool,
  buildFinishDistillationTool,
  type DistillationToolResult,
  type DistillationToolContext,
} from "./distillation"

// Reflection agent tools (now in src/reflection/tools.ts)
export { buildReflectionTools, type ReflectionToolContext } from "../reflection/tools"
