/**
 * Agent Pool - manages persistent Nuum agent instances
 *
 * Each agent lives as a separate SQLite database in .nuum/agents/<name>.db
 * relative to the working directory. Storage instances are cached for active
 * agents and closed on shutdown. Per-agent mutex serializes concurrent requests.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createStorage,
  initializeDefaultEntries,
  cleanupStaleWorkers,
  type Storage,
  type StorageWithDb,
} from '../storage'

const AGENTS_DIR = path.join(process.cwd(), '.nuum', 'agents')
const NAME_PATTERN = /^[a-z0-9_-]+$/

/** Grace period for a lock dir that exists but has no readable PID file. */
const LOCK_GRACE_MS = 5_000
/** Maximum age of a lock before treating it as stale regardless of PID. */
const LOCK_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Check if a file lock is stale by reading the PID file and checking
 * whether the holding process is still alive.
 *
 * Handles edge cases:
 * - Missing/corrupt PID file: uses lock dir mtime with a grace window
 * - PID reuse: uses timestamp as a max-age guard
 */
function isLockStale(lockDir: string, pidFile: string): boolean {
  let pid = NaN
  let lockTimestamp = NaN

  try {
    const content = fs.readFileSync(pidFile, 'utf-8')
    const [pidStr, timestampStr] = content.split('\n')
    pid = parseInt(pidStr, 10)
    lockTimestamp = parseInt(timestampStr, 10)
  } catch {
    // Can't read PID file — lock dir exists but no PID yet.
    // Fall through to mtime-based grace check below.
  }

  if (isNaN(pid)) {
    // No valid PID — process may have crashed between mkdir and writeFile.
    // Use lock dir mtime: if it's older than the grace period, treat as stale.
    try {
      const dirAge = Date.now() - fs.statSync(lockDir).mtimeMs
      return dirAge > LOCK_GRACE_MS
    } catch {
      return true // lock dir stat failed — treat as stale
    }
  }

  // Max-age guard: if the lock timestamp is older than LOCK_MAX_AGE_MS,
  // treat as stale regardless of PID (guards against PID reuse)
  if (!isNaN(lockTimestamp) && Date.now() - lockTimestamp > LOCK_MAX_AGE_MS) {
    return true
  }

  // Check if process is alive (signal 0 = existence check)
  try {
    process.kill(pid, 0)
    return false // process is alive
  } catch (e: any) {
    if (e.code === 'EPERM') return false // alive, no permission
    return true // ESRCH = process doesn't exist = stale
  }
}

export interface AgentInfo {
  name: string
  mission: string | null
  status: string | null
  createdAt: string | null
  lastActiveAt: string | null
}

/** Close a StorageWithDb's underlying SQLite connection. */
function closeStorage(storage: StorageWithDb): void {
  try {
    storage._db._rawDb.close()
  } catch {
    // Ignore close errors
  }
}

export class AgentPool {
  private storageCache = new Map<string, StorageWithDb>()
  private locks = new Map<string, Promise<void>>()

  /** Ensure the agents directory exists. */
  ensureAgentsDir(): void {
    fs.mkdirSync(AGENTS_DIR, {recursive: true})
  }

  /** Get the database path for an agent. */
  dbPathFor(name: string): string {
    return path.join(AGENTS_DIR, `${name}.db`)
  }

  /** Get the lock directory path for an agent. */
  private lockDir(name: string): string {
    return this.dbPathFor(name) + '.lock'
  }

  /**
   * Acquire a cross-process file lock using atomic mkdir.
   * Returns a release function that removes the lock.
   *
   * mkdir is atomic on POSIX — it either succeeds or throws EEXIST.
   * A PID file inside the lock dir enables stale lock detection.
   */
  async acquireFileLock(
    name: string,
    timeoutMs = 30_000,
  ): Promise<() => void> {
    const lockPath = this.lockDir(name)
    const pidFile = path.join(lockPath, 'pid')
    const deadline = Date.now() + timeoutMs

    while (true) {
      try {
        fs.mkdirSync(lockPath) // atomic — fails with EEXIST if held
        fs.writeFileSync(pidFile, `${process.pid}\n${Date.now()}`)
        return () => {
          try {
            fs.unlinkSync(pidFile)
          } catch {}
          try {
            fs.rmdirSync(lockPath)
          } catch {}
        }
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err

        // Check for stale lock
        if (isLockStale(lockPath, pidFile)) {
          try {
            fs.unlinkSync(pidFile)
          } catch {}
          try {
            fs.rmdirSync(lockPath)
          } catch {}
          continue
        }

        if (Date.now() > deadline) {
          // Best-effort cleanup: if the lock is old, try to remove it
          // before throwing so we don't permanently poison the lock
          try {
            const dirAge = Date.now() - fs.statSync(lockPath).mtimeMs
            if (dirAge > LOCK_GRACE_MS) {
              try {
                fs.unlinkSync(pidFile)
              } catch {}
              try {
                fs.rmdirSync(lockPath)
              } catch {}
            }
          } catch {}
          throw new Error(
            `Timeout acquiring lock for agent "${name}" — another process may be using it`,
          )
        }
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  }

  /** Validate an agent name. */
  static validateName(name: string): string | null {
    if (!NAME_PATTERN.test(name)) {
      return 'Agent name must match ^[a-z0-9_-]+$ (lowercase letters, digits, hyphens, underscores)'
    }
    if (name.length > 64) {
      return 'Agent name must be 64 characters or fewer'
    }
    return null
  }

  /** Check if an agent DB exists on disk. */
  agentExists(name: string): boolean {
    return fs.existsSync(this.dbPathFor(name))
  }

  /**
   * Acquire a per-agent mutex. Returns a release function.
   * Serializes via promise chain so only one operation runs per agent at a time.
   * Cleans up the lock entry when no further waiters remain.
   */
  async acquireLock(name: string): Promise<() => void> {
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })

    const prev = this.locks.get(name) ?? Promise.resolve()
    const chain = prev.then(() => next)
    this.locks.set(name, chain)
    await prev

    return () => {
      // Clean up if this is still the tail of the chain (no one else waiting)
      if (this.locks.get(name) === chain) {
        this.locks.delete(name)
      }
      release()
    }
  }

  /** Get or create a cached Storage instance for an agent. */
  async getOrCreateStorage(name: string): Promise<Storage> {
    const existing = this.storageCache.get(name)
    if (existing) return existing

    const dbPath = this.dbPathFor(name)
    const storage = createStorage(dbPath)
    await cleanupStaleWorkers(storage)
    this.storageCache.set(name, storage)
    return storage
  }

  /**
   * Create a new agent.
   * Caller must hold the per-agent lock.
   */
  async createAgent(name: string, systemPrompt?: string): Promise<void> {
    if (this.agentExists(name)) {
      throw new Error(`Agent "${name}" already exists`)
    }

    const storage = await this.getOrCreateStorage(name)
    await initializeDefaultEntries(storage)

    // If a system prompt overlay was provided, store it as the agent's mission
    if (systemPrompt) {
      await storage.present.setMission(systemPrompt)
    }
  }

  /**
   * List all agents by scanning the agents directory.
   * Uses short-lived DB connections for agents that aren't already cached,
   * to avoid keeping every agent's DB open indefinitely.
   */
  async listAgents(): Promise<AgentInfo[]> {
    this.ensureAgentsDir()

    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.db'))
    const agents: AgentInfo[] = []

    for (const file of files) {
      const name = file.replace(/\.db$/, '')
      try {
        const cached = this.storageCache.has(name)
        const storage = cached
          ? this.storageCache.get(name)!
          : createStorage(this.dbPathFor(name), {initialize: false})

        try {
          const state = await storage.present.get()
          const stats = fs.statSync(this.dbPathFor(name))

          agents.push({
            name,
            mission: state.mission,
            status: state.status,
            createdAt: stats.birthtime.toISOString(),
            lastActiveAt: stats.mtime.toISOString(),
          })
        } finally {
          // Close the connection if we opened it just for listing
          if (!cached) {
            closeStorage(storage as StorageWithDb)
          }
        }
      } catch {
        agents.push({
          name,
          mission: null,
          status: 'unknown',
          createdAt: null,
          lastActiveAt: null,
        })
      }
    }

    return agents
  }

  /** Close all cached storage connections. */
  closeAll(): void {
    for (const [, storage] of this.storageCache) {
      closeStorage(storage)
    }
    this.storageCache.clear()
    this.locks.clear()
  }
}
