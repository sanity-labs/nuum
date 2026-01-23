/**
 * Wildcard pattern matching for permission evaluation.
 * Simplified from OpenCode's util/wildcard.ts (removed remeda dependency).
 */

export namespace Wildcard {
  /**
   * Match a string against a wildcard pattern.
   * Supports * (any characters) and ? (single character).
   */
  export function match(str: string, pattern: string): boolean {
    let escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars
      .replace(/\*/g, ".*") // * becomes .*
      .replace(/\?/g, ".") // ? becomes .

    // If pattern ends with " *" (space + wildcard), make the trailing part optional
    // This allows "ls *" to match both "ls" and "ls -la"
    if (escaped.endsWith(" .*")) {
      escaped = escaped.slice(0, -3) + "( .*)?"
    }

    return new RegExp("^" + escaped + "$", "s").test(str)
  }
}
