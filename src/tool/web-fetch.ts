/**
 * Web fetch tool with LLM-powered content extraction.
 *
 * Fetches a URL, simplifies the HTML (removing scripts, styles, ads),
 * and uses an LLM to answer a question about the content.
 */

import {z} from 'zod'
import {Tool} from './tool'
import {Provider} from '../provider'

export interface WebFetchMetadata {
  url: string
  question: string
  contentLength: number
  truncated: boolean
}

const DESCRIPTION = `Fetch a web page and extract information using AI.

Use this tool when you need to read and understand the content of a specific URL.
Provide a question or instruction about what information to extract.

Examples:
- fetch("https://example.com/docs", "What are the main API endpoints?")
- fetch("https://news.site.com", "What are today's top headlines?")
- fetch("https://github.com/user/repo", "What does this project do?")

The tool will fetch the page, clean up the HTML, and use AI to answer your question.`

/**
 * Strip non-essential HTML elements and convert to readable text.
 * Removes scripts, styles, nav, ads, etc. Keeps structural content.
 */
function simplifyHtml(html: string): string {
  let content = html

  // Remove script tags and their content
  content = content.replace(
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    '',
  )

  // Remove style tags and their content
  content = content.replace(
    /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
    '',
  )

  // Remove noscript tags
  content = content.replace(
    /<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi,
    '',
  )

  // Remove SVG elements
  content = content.replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')

  // Remove common non-content elements
  content = content.replace(
    /<(nav|header|footer|aside|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  )

  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '')

  // Remove inline styles and event handlers from remaining tags
  content = content.replace(/\s+(style|on\w+)="[^"]*"/gi, '')
  content = content.replace(/\s+(style|on\w+)='[^']*'/gi, '')

  // Remove class and id attributes (they're not useful for content)
  content = content.replace(/\s+(class|id|data-[\w-]+)="[^"]*"/gi, '')

  // Convert common block elements to newlines for readability
  content = content.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n')
  content = content.replace(/<(br|hr)[^>]*\/?>/gi, '\n')

  // Convert links to markdown-style for context
  content = content.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi,
    '[$2]($1)',
  )

  // Remove remaining HTML tags
  content = content.replace(/<[^>]+>/g, ' ')

  // Decode common HTML entities
  content = content
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')

  // Collapse multiple whitespace/newlines
  content = content.replace(/[ \t]+/g, ' ')
  content = content.replace(/\n\s*\n/g, '\n\n')
  content = content.trim()

  return content
}

/**
 * Truncate content to fit within token budget.
 * Rough estimate: 1 token ≈ 4 characters for English text.
 */
function truncateContent(
  content: string,
  maxTokens: number,
): {content: string; truncated: boolean} {
  const maxChars = maxTokens * 4
  if (content.length <= maxChars) {
    return {content, truncated: false}
  }
  return {
    content: content.slice(0, maxChars) + '\n\n[Content truncated...]',
    truncated: true,
  }
}

const parameters = z.object({
  url: z.string().url().describe('The URL to fetch'),
  question: z
    .string()
    .describe(
      "What information to extract from the page (e.g., 'What are the main headlines?' or 'Summarize this article')",
    ),
})

export const WebFetchTool = Tool.define<typeof parameters, WebFetchMetadata>(
  'web_fetch',
  {
    description: DESCRIPTION,
    parameters,
    async execute(args, ctx) {
      const {url, question} = args

      // Fetch the page
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000)

      let html: string
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          signal: AbortSignal.any([controller.signal, ctx.abort]),
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
          )
        }

        const contentType = response.headers.get('content-type') || ''
        if (
          !contentType.includes('text/html') &&
          !contentType.includes('text/plain')
        ) {
          // For non-HTML content, just return raw text
          const text = await response.text()
          const {content, truncated} = truncateContent(text, 50000)
          return {
            output: `Content from ${url}:\n\n${content}`,
            title: `Fetched: ${url}`,
            metadata: {url, question, contentLength: text.length, truncated},
          }
        }

        html = await response.text()
      } catch (error) {
        clearTimeout(timeoutId)

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`Request to ${url} timed out`)
        }

        throw error
      }

      // Simplify HTML to readable text
      const simplifiedContent = simplifyHtml(html)

      // Truncate to fit in context (leave room for system prompt and response)
      // Using ~50k tokens for content, which is well within Sonnet's context
      const {content: truncatedContent, truncated} = truncateContent(
        simplifiedContent,
        50000,
      )

      // Use the workhorse model (Sonnet) to extract information
      const model = Provider.getModelForTier('workhorse')

      const systemPrompt = `You are a helpful assistant that extracts information from web pages.
You will be given the text content of a web page and a question about it.
Answer the question based solely on the provided content.
Be concise but thorough. If the information isn't in the content, say so.
Format your response clearly with markdown if appropriate.`

      const result = await Provider.generate({
        model,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `URL: ${url}

PAGE CONTENT:
${truncatedContent}

QUESTION: ${question}`,
          },
        ],
        maxTokens: 4096,
        temperature: 0,
        abortSignal: ctx.abort,
      })

      return {
        output: result.text,
        title: `Fetched: ${url}`,
        metadata: {
          url,
          question,
          contentLength: simplifiedContent.length,
          truncated,
        },
      }
    },
  },
)
