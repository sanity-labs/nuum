/**
 * Markdown-to-ANSI renderer for terminal output
 *
 * Converts common Markdown syntax to ANSI-styled terminal output:
 * - `code` → highlighted
 * - **bold** → bold
 * - *italic* → dim (terminal approximation)
 * - [link](url) → underlined with dim url
 */

import {pc, styles} from './colors'

/**
 * Render inline Markdown to ANSI-styled text.
 * Handles code spans, bold, italic, and links.
 */
export function renderMarkdown(text: string): string {
  // Process in order of precedence to avoid conflicts

  // Code blocks (```...```) - preserve as-is but dim the fences
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return styles.label('```' + lang) + '\n' + code.trimEnd() + '\n' + styles.label('```')
  })

  // Inline code (`...`) - use code style
  text = text.replace(/`([^`]+)`/g, (_, code) => styles.code(code))

  // Bold (**...**) - bold
  text = text.replace(/\*\*([^*]+)\*\*/g, (_, content) => pc.bold(content))

  // Italic (*...*) - dim (avoiding conflict with bold)
  // Only match single asterisks not preceded/followed by another asterisk
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, content) =>
    styles.label(content),
  )

  // Links [text](url) - underlined text, dim url
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    return pc.underline(linkText) + styles.label(` (${url})`)
  })

  // Headers (# ...) - use header style
  text = text.replace(/^(#{1,6})\s+(.+)$/gm, (_, _hashes, content) => {
    return styles.header(content)
  })

  // Bullet points - dim bullet, normal text
  text = text.replace(/^(\s*)[-*]\s+/gm, (_, indent) => {
    return indent + styles.label('•') + ' '
  })

  // Numbered lists - dim number
  text = text.replace(/^(\s*)(\d+)\.\s+/gm, (_, indent, num) => {
    return indent + styles.label(num + '.') + ' '
  })

  return text
}

/**
 * Check if a string contains Markdown that would benefit from rendering.
 */
export function hasMarkdown(text: string): boolean {
  return /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|^#{1,6}\s|^[-*]\s|^\d+\.\s/m.test(
    text,
  )
}
