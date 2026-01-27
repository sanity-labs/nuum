/**
 * System prompt building for the agent.
 *
 * Builds the static part of the agent's context: identity, behavior,
 * and instructions. This is shared across all workloads (main agent,
 * compaction, consolidation) for prompt caching efficiency.
 * 
 * NOTE: Present state (mission, status, tasks) is NOT included here.
 * It changes frequently and would invalidate the cache. Instead, the
 * present_* tools return the full state, so it appears in conversation
 * history when the agent checks or updates it.
 */

import type { Storage } from "../storage"

/**
 * Estimate token count from text (rough approximation).
 * ~4 chars per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Build the system prompt (identity, behavior, instructions).
 *
 * This is the "who you are" part of the agent context. It's identical
 * across all workloads to maximize prompt caching.
 */
export async function buildSystemPrompt(storage: Storage): Promise<{ prompt: string; tokens: number }> {
  // Get identity and behavior from LTM
  const identity = await storage.ltm.read("identity")
  const behavior = await storage.ltm.read("behavior")

  // Build system prompt (no temporal history - that goes in conversation turns)
  // NOTE: Present state is NOT included - it changes frequently and would
  // invalidate the cache. The agent sees it via tool results in history.
  let prompt = `You are a coding assistant with persistent memory.

Your memory spans across conversations, allowing you to remember past decisions, track ongoing projects, and learn user preferences.

`

  // Add identity
  if (identity) {
    prompt += `<identity>
${identity.body}
</identity>

`
  }

  // Add behavior
  if (behavior) {
    prompt += `<behavior>
${behavior.body}
</behavior>

`
  }

  // Add available tools description
  prompt += `You have access to tools for file operations (read, write, edit, bash, glob, grep).
Use tools to accomplish tasks. Always explain what you're doing.

When you're done with a task, update the present state if appropriate.

## Long-Term Memory

You have a knowledge base managed by a background process. It extracts important information from conversations and maintains organized knowledge.

To recall information:
- ltm_glob(pattern) - browse the knowledge tree structure
- ltm_search(query) - find relevant entries
- ltm_read(slug) - read a specific entry

Knowledge entries may contain [[slug]] cross-references to related entries. Follow these links to explore connected knowledge.

You do NOT manage this memory directly. Focus on your work - memory happens automatically.
Your /identity and /behavior entries are always visible to guide you.

## Reflection

When you need to remember something specific from past conversations - a file path, a decision, a value, something the user said - use the **reflect** tool. It searches your full conversation history and knowledge base.

Use reflect when:
- You're unsure about something discussed before
- You need a specific value or path from earlier work
- The user asks "remember when..." or "what did we decide about..."
- You want to verify your memory before acting

## Message Prefixes

Messages in your history have automatic prefixes like \`[2026-01-26 15:30 id:msg_xxx]\` showing timestamp and ID. These are added by the system for internal tracking - you don't need to reference or echo them. Just read the message content normally.
`

  // Add CAST-provided system prompt overlay (if any)
  const systemPromptOverlay = await storage.session.getSystemPromptOverlay()
  if (systemPromptOverlay) {
    prompt += `
${systemPromptOverlay}
`
  }

  return { prompt, tokens: estimateTokens(prompt) }
}
