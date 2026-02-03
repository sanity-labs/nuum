/**
 * Tests for version module.
 */

import {describe, expect, test} from 'bun:test'
import {VERSION, GIT_HASH, VERSION_STRING} from './version'

describe('version', () => {
  test('VERSION is a valid semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("GIT_HASH is a short hash or 'unknown'", () => {
    // Either a 7-char hex string or 'unknown'
    expect(GIT_HASH).toMatch(/^([a-f0-9]{7}|unknown)$/)
  })

  test('VERSION_STRING has correct format', () => {
    expect(VERSION_STRING).toMatch(
      /^nuum v\d+\.\d+\.\d+ \(([a-f0-9]{7}|unknown)\)$/,
    )
  })

  test('VERSION_STRING contains VERSION', () => {
    expect(VERSION_STRING).toContain(VERSION)
  })

  test('VERSION_STRING contains GIT_HASH', () => {
    expect(VERSION_STRING).toContain(GIT_HASH)
  })
})
