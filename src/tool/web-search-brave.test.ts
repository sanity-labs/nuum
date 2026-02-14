import {describe, expect, test} from 'bun:test'
import {parseBraveResults, formatBraveResults} from './web-search-brave'

describe('Brave Search', () => {
  describe('parseBraveResults', () => {
    test('parses web results', () => {
      const data = {
        web: {
          results: [
            {
              title: 'Bun — A fast all-in-one JavaScript runtime',
              url: 'https://bun.sh',
              description: 'Bun is a fast JavaScript runtime.',
              age: '2 days ago',
              extra_snippets: ['Install with curl', 'Supports TypeScript natively'],
            },
            {
              title: 'Bun Docs',
              url: 'https://bun.sh/docs',
              description: 'Official documentation for Bun.',
            },
          ],
        },
      }

      const results = parseBraveResults(data)
      expect(results).toHaveLength(2)
      expect(results[0].title).toBe('Bun — A fast all-in-one JavaScript runtime')
      expect(results[0].url).toBe('https://bun.sh')
      expect(results[0].snippet).toBe('Bun is a fast JavaScript runtime.')
      expect((results[0] as any).age).toBe('2 days ago')
      expect((results[0] as any).extraSnippets).toEqual([
        'Install with curl',
        'Supports TypeScript natively',
      ])
      expect(results[1].title).toBe('Bun Docs')
      expect((results[1] as any).age).toBeUndefined()
      expect((results[1] as any).extraSnippets).toBeUndefined()
    })

    test('strips HTML from results', () => {
      const data = {
        web: {
          results: [
            {
              title: 'Test &amp; <b>Bold</b> Title',
              url: 'https://example.com',
              description: 'A &lt;tag&gt; with &quot;quotes&quot;',
              extra_snippets: ['<em>emphasized</em> text'],
            },
          ],
        },
      }

      const results = parseBraveResults(data)
      expect(results[0].title).toBe('Test & Bold Title')
      expect(results[0].snippet).toBe('A <tag> with "quotes"')
      expect((results[0] as any).extraSnippets[0]).toBe('emphasized text')
    })

    test('handles empty response', () => {
      expect(parseBraveResults({})).toEqual([])
      expect(parseBraveResults({web: {results: []}})).toEqual([])
    })

    test('handles missing web field', () => {
      const data = {query: {original: 'test'}}
      expect(parseBraveResults(data)).toEqual([])
    })
  })

  describe('formatBraveResults', () => {
    test('formats results with age and extra snippets', () => {
      const results = [
        {
          title: 'Example Page',
          url: 'https://example.com',
          snippet: 'Main description.',
          age: '3 days ago',
          extraSnippets: ['Extra info 1', 'Extra info 2'],
        },
      ] as any

      const output = formatBraveResults('test query', results)
      expect(output).toContain('Search results for "test query"')
      expect(output).toContain('**Example Page**')
      expect(output).toContain('URL: https://example.com')
      expect(output).toContain('Published: 3 days ago')
      expect(output).toContain('Main description.')
      expect(output).toContain('Extra info 1')
      expect(output).toContain('Extra info 2')
    })

    test('formats results without age', () => {
      const results = [
        {
          title: 'No Age',
          url: 'https://example.com',
          snippet: 'Description.',
        },
      ]

      const output = formatBraveResults('query', results)
      expect(output).not.toContain('Published:')
    })

    test('returns no results message', () => {
      const output = formatBraveResults('nothing', [])
      expect(output).toBe(
        'No search results found for "nothing". Try a different query.',
      )
    })

    test('numbers multiple results', () => {
      const results = [
        {title: 'First', url: 'https://a.com', snippet: 'A'},
        {title: 'Second', url: 'https://b.com', snippet: 'B'},
        {title: 'Third', url: 'https://c.com', snippet: 'C'},
      ]

      const output = formatBraveResults('multi', results)
      expect(output).toContain('1. **First**')
      expect(output).toContain('2. **Second**')
      expect(output).toContain('3. **Third**')
    })
  })
})
