import {afterEach, describe, expect, test} from 'bun:test'
import * as os from 'node:os'
import * as path from 'node:path'
import {Server} from './index'
import {Mcp} from '../mcp'

const originalLoadConfig = Mcp.loadConfig
const originalInitialize = Mcp.initialize
const originalReady = Mcp.ready

function makeServer(): Server {
  const dbPath = path.join(
    os.tmpdir(),
    `nuum-jsonrpc-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  )
  return new Server({
    dbPath,
    noStdin: true,
    outputHandler: () => {},
  })
}

afterEach(() => {
  ;(Mcp as any).loadConfig = originalLoadConfig
  ;(Mcp as any).initialize = originalInitialize
  ;(Mcp as any).ready = originalReady
})

describe('Server MCP reinitialize gating', () => {
  test('waits for Mcp.ready before returning when reinitialized', async () => {
    ;(Mcp as any).loadConfig = async () => ({mcpServers: {}})
    ;(Mcp as any).initialize = async () => true

    let resolveReady: () => void = () => {}
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    ;(Mcp as any).ready = async () => readyPromise

    const server = makeServer()
    let settled = false
    const callPromise = (server as any)
      .reinitializeMcpWithOverride({
        miriad: {command: 'mcp-server'},
      })
      .then(() => {
        settled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(settled).toBe(false)

    resolveReady()
    await callPromise
    expect(settled).toBe(true)
  })

  test('does not call Mcp.ready when initialize is skipped', async () => {
    ;(Mcp as any).loadConfig = async () => ({mcpServers: {}})
    ;(Mcp as any).initialize = async () => false

    let readyCalls = 0
    ;(Mcp as any).ready = async () => {
      readyCalls++
    }

    const server = makeServer()
    await (server as any).reinitializeMcpWithOverride({
      miriad: {command: 'mcp-server'},
    })

    expect(readyCalls).toBe(0)
  })

  test('times out waiting for Mcp.ready and continues', async () => {
    ;(Mcp as any).loadConfig = async () => ({mcpServers: {}})
    ;(Mcp as any).initialize = async () => true
    ;(Mcp as any).ready = async () => new Promise<void>(() => {})

    const originalSetTimeout = globalThis.setTimeout
    ;(globalThis as any).setTimeout = ((fn: TimerHandler, ms?: number, ...args: any[]) =>
      originalSetTimeout(fn, Math.min(ms ?? 0, 5), ...args)) as typeof setTimeout

    try {
      const server = makeServer()
      const started = Date.now()
      await (server as any).reinitializeMcpWithOverride({
        miriad: {command: 'mcp-server'},
      })
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(300)
    } finally {
      ;(globalThis as any).setTimeout = originalSetTimeout
    }
  })
})
