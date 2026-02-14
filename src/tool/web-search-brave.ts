/**
 * Web search tool using Brave Search API.
 * Requires BRAVE_SEARCH_API_KEY environment variable.
 */

import {z} from 'zod'
import {Tool} from './tool'
import type {WebSearchMetadata, SearchResult} from './web-search-ddg'

const DESCRIPTION = `Search the web using Brave Search.

Use this tool to find current information, documentation, or answers to questions that require up-to-date knowledge.

Supports freshness filtering: use freshness="24h" for very recent results, "1w" for past week, "1m" for past month, "1y" for past year.

Today's date is {{date}}.

Returns a list of search results with titles, URLs, and snippets.`

const parameters = z.object({
  query: z.string().describe('The search query'),
  maxResults: z
    .number()
    .optional()
    .describe('Maximum number of results to return (default: 8, max: 20)'),
  freshness: z
    .enum(['24h', '1w', '1m', '1y'])
    .optional()
    .describe(
      'Filter by recency: 24h (past day), 1w (past week), 1m (past month), 1y (past year)',
    ),
})

/** Map our freshness values to Brave API format */
const FRESHNESS_MAP: Record<string, string> = {
  '24h': 'pd',
  '1w': 'pw',
  '1m': 'pm',
  '1y': 'py',
}

/** Strip HTML tags from Brave snippets */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

interface BraveWebResult {
  title: string
  url: string
  description: string
  age?: string
  extra_snippets?: string[]
}

interface BraveSearchResponse {
  web?: {
    results: BraveWebResult[]
  }
  query?: {
    original: string
  }
}

export function parseBraveResults(data: BraveSearchResponse): SearchResult[] {
  const webResults = data.web?.results ?? []
  return webResults.map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    snippet: stripHtml(r.description),
    age: r.age,
    extraSnippets: r.extra_snippets?.map(stripHtml),
  }))
}

export function formatBraveResults(
  query: string,
  results: SearchResult[],
): string {
  if (results.length === 0) {
    return `No search results found for "${query}". Try a different query.`
  }

  const formatted = results
    .map((r, i) => {
      const parts = [`${i + 1}. **${r.title}**`, `   URL: ${r.url}`]
      if ((r as BraveResult).age) {
        parts.push(`   Published: ${(r as BraveResult).age}`)
      }
      if (r.snippet) {
        parts.push(`   ${r.snippet}`)
      }
      const extra = (r as BraveResult).extraSnippets
      if (extra?.length) {
        for (const s of extra) {
          parts.push(`   ${s}`)
        }
      }
      return parts.join('\n')
    })
    .join('\n\n')

  return `Search results for "${query}":\n\n${formatted}`
}

interface BraveResult extends SearchResult {
  age?: string
  extraSnippets?: string[]
}

export const BraveSearchTool = Tool.define<
  typeof parameters,
  WebSearchMetadata
>('web_search', {
  get description() {
    return DESCRIPTION.replace('{{date}}', new Date().toISOString().slice(0, 10))
  },
  parameters,
  async execute(args, ctx) {
    const {query, maxResults = 8, freshness} = args
    const apiKey = process.env.BRAVE_SEARCH_API_KEY

    if (!apiKey) {
      throw new Error(
        'BRAVE_SEARCH_API_KEY is not set. Cannot use Brave Search.',
      )
    }

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(maxResults, 20)),
      text_decorations: 'false',
      extra_snippets: 'true',
    })

    if (freshness) {
      const mapped = FRESHNESS_MAP[freshness]
      if (mapped) {
        params.set('freshness', mapped)
      }
    }

    const url = `https://api.search.brave.com/res/v1/web/search?${params}`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.any([controller.signal, ctx.abort]),
      })

      clearTimeout(timeoutId)

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          'Brave Search API key is invalid or expired. Check BRAVE_SEARCH_API_KEY.',
        )
      }

      if (response.status === 429) {
        throw new Error('Brave Search rate limited. Try again in a moment.')
      }

      if (!response.ok) {
        throw new Error(`Brave Search failed with status ${response.status}`)
      }

      const data = (await response.json()) as BraveSearchResponse
      const results = parseBraveResults(data).slice(0, maxResults)
      const output = formatBraveResults(query, results)

      return {
        output,
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
})
