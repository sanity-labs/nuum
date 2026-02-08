import {describe, test, expect} from 'bun:test'
import {getMaxOutputTokens} from './loop'

describe('getMaxOutputTokens', () => {
  test('returns 128K for Opus 4.6', () => {
    expect(getMaxOutputTokens('claude-opus-4-6')).toBe(128_000)
    expect(getMaxOutputTokens('claude-opus-4-6-20250918')).toBe(128_000)
  })

  test('returns 64K for Sonnet 4.5', () => {
    expect(getMaxOutputTokens('claude-sonnet-4-5-20250929')).toBe(64_000)
    expect(getMaxOutputTokens('claude-sonnet-4-5')).toBe(64_000)
  })

  test('returns 64K for Haiku 4.5', () => {
    expect(getMaxOutputTokens('claude-haiku-4-5-20251001')).toBe(64_000)
    expect(getMaxOutputTokens('claude-haiku-4-5')).toBe(64_000)
  })

  test('returns 8K for older 3.5 models', () => {
    expect(getMaxOutputTokens('claude-3-5-sonnet-20241022')).toBe(8_192)
    expect(getMaxOutputTokens('claude-3-5-haiku-20241022')).toBe(8_192)
  })

  test('returns 16K default for unknown models', () => {
    expect(getMaxOutputTokens('claude-future-model')).toBe(16_384)
    expect(getMaxOutputTokens('some-other-model')).toBe(16_384)
  })
})
