/**
 * Web search tool using DuckDuckGo HTML search.
 * No API key required - parses HTML results directly.
 */

import {z} from 'zod'
import {Tool} from './tool'

export interface WebSearchMetadata {
  query: string
  resultCount: number
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const DESCRIPTION = `Search the web using DuckDuckGo.

Use this tool to find current information, documentation, or answers to questions that require up-to-date knowledge.

Today's date is {{date}}.

Returns a list of search results with titles, URLs, and snippets.`

/**
 * Extract the actual URL from DuckDuckGo's redirect URL.
 * DDG wraps URLs like: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
 */
function extractRealUrl(ddgUrl: string): string | null {
  // Try to extract from uddg parameter
  const uddgMatch = ddgUrl.match(/[?&]uddg=([^&]+)/)
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1])
    } catch {
      return null
    }
  }
  // If it's already a real URL, return it
  if (ddgUrl.startsWith('http://') || ddgUrl.startsWith('https://')) {
    return ddgUrl
  }
  return null
}

/**
 * Clean HTML content - remove tags and decode entities.
 */
function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '') // Remove HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .trim()
}

/**
 * Parse DuckDuckGo HTML search results.
 * DuckDuckGo's HTML interface returns results in a predictable format:
 * - Title in <a class="result__a">
 * - Snippet in <a class="result__snippet">
 * - URLs are wrapped in DDG redirects with actual URL in uddg parameter
 */
function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // Match result blocks - each contains a title link and snippet
  // Title: <a class="result__a" href="...">Title Text</a>
  // Snippet: <a class="result__snippet" href="...">Snippet text with <b>highlights</b></a>
  const titleRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

  // Extract all titles
  const titles: Array<{url: string; title: string}> = []
  let match
  while ((match = titleRegex.exec(html)) !== null) {
    const [, ddgUrl, title] = match
    const realUrl = extractRealUrl(ddgUrl)
    if (realUrl && title) {
      titles.push({url: realUrl, title: cleanHtml(title)})
    }
  }

  // Extract all snippets
  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    const [, snippetHtml] = match
    snippets.push(cleanHtml(snippetHtml))
  }

  // Combine titles and snippets (they appear in order)
  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] || '',
    })
  }

  return results.slice(0, 10) // Limit to 10 results
}

const parameters = z.object({
  query: z.string().describe('The search query'),
  maxResults: z
    .number()
    .optional()
    .describe('Maximum number of results to return (default: 8, max: 10)'),
})

export const DdgSearchTool = Tool.define<typeof parameters, WebSearchMetadata>(
  'web_search',
  {
    get description() {
      return DESCRIPTION.replace(
        '{{date}}',
        new Date().toISOString().slice(0, 10),
      )
    },
    parameters,
    async execute(args, ctx) {
      const {query, maxResults = 8} = args

      // Build DuckDuckGo HTML search URL
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 15000)

      try {
        const response = await fetch(searchUrl, {
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
          throw new Error(`Search failed with status ${response.status}`)
        }

        const html = await response.text()
        const results = parseSearchResults(html).slice(0, maxResults)

        if (results.length === 0) {
          return {
            output: `No search results found for "${query}". Try a different query.`,
            title: `Web search: ${query}`,
            metadata: {query, resultCount: 0},
          }
        }

        // Format results for the LLM
        const formatted = results
          .map((r, i) => {
            const parts = [`${i + 1}. **${r.title}**`, `   URL: ${r.url}`]
            if (r.snippet) {
              parts.push(`   ${r.snippet}`)
            }
            return parts.join('\n')
          })
          .join('\n\n')

        return {
          output: `Search results for "${query}":\n\n${formatted}`,
          title: `Web search: ${query}`,
          metadata: {query, resultCount: results.length},
        }
      } catch (error) {
        clearTimeout(timeoutId)

        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Search request timed out')
        }

        throw error
      }
    },
  },
)
