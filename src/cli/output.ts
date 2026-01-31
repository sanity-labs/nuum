/**
 * Unified output module for CLI.
 *
 * Provides consistent output primitives across all CLI commands.
 * Using this instead of raw console.log/process.stdout gives us:
 * - Consistent behavior across the codebase
 * - Single place to control output (e.g., for testing, redirection)
 * - Clearer intent (out.blank() vs console.log())
 */

/**
 * Standard output (stdout) - for normal program output
 */
export const out = {
  /** Write text followed by newline */
  line: (text: string = ''): void => {
    process.stdout.write(text + '\n')
  },

  /** Write text without newline (for streaming) */
  write: (text: string): void => {
    process.stdout.write(text)
  },

  /** Write a blank line */
  blank: (): void => {
    process.stdout.write('\n')
  },
}

/**
 * Error output (stderr) - for errors and diagnostics
 */
export const err = {
  /** Write text followed by newline */
  line: (text: string = ''): void => {
    process.stderr.write(text + '\n')
  },

  /** Write text without newline */
  write: (text: string): void => {
    process.stderr.write(text)
  },

  /** Write a blank line */
  blank: (): void => {
    process.stderr.write('\n')
  },
}
