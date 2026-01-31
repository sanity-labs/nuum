/**
 * Color utilities for CLI output
 *
 * Uses picocolors for ANSI color support with automatic TTY detection.
 * Provides semantic style helpers for consistent styling across the codebase.
 */

import pc from 'picocolors'

// Re-export picocolors for direct use
export {pc}

/**
 * Semantic styles for consistent coloring across the CLI.
 */
export const styles = {
  // Structural
  header: (s: string) => pc.bold(pc.cyan(s)),
  subheader: (s: string) => pc.cyan(s),
  label: (s: string) => pc.dim(s),
  separator: (s: string) => pc.dim(pc.gray(s)),

  // Status
  success: (s: string) => pc.green(s),
  warning: (s: string) => pc.yellow(s),
  error: (s: string) => pc.red(s),

  // Code/text
  code: (s: string) => pc.yellowBright(s),
  path: (s: string) => pc.redBright(s),
  command: (s: string) => pc.yellow(s),

  // Event types
  tool: (s: string) => pc.whiteBright(s),
  user: (s: string) => pc.blue(s),
  assistant: (s: string) => pc.green(s),

  // Metadata
  timestamp: (s: string) => pc.gray(s),
  number: (s: string) => pc.yellow(s),
  arrow: (s: string) => pc.dim(s),
}

/**
 * Color a percentage based on threshold levels.
 * < 50%: green, 50-80%: yellow, > 80%: red
 */
export function colorPercent(value: number, total: number): string {
  const pct = (value / total) * 100
  const formatted = pct.toFixed(1) + '%'
  if (pct < 50) return pc.green(formatted)
  if (pct < 80) return pc.yellow(formatted)
  return pc.red(formatted)
}

/**
 * Create a colored progress bar.
 */
export function progressBar(
  complete: number,
  total: number,
  width = 20,
): string {
  const filled = Math.round((complete / total) * width)
  const empty = width - filled
  return pc.green('█'.repeat(filled)) + pc.dim('░'.repeat(empty))
}
