/**
 * Storage layer verification script
 *
 * Run with: bun src/storage/verify.ts
 */

import {
  createInMemoryStorage,
  createStorage,
  initializeDefaultEntries,
  ConflictError,
  getRawConnection,
} from './index'
import {Identifier} from '../id'
import * as fs from 'fs'
import * as path from 'path'

async function verify() {
  console.log('=== Storage Layer Verification ===\n')

  const storage = createInMemoryStorage()
  let passed = 0
  let failed = 0

  function check(name: string, condition: boolean, details?: string) {
    if (condition) {
      console.log(`✓ ${name}`)
      passed++
    } else {
      console.log(`✗ ${name}${details ? `: ${details}` : ''}`)
      failed++
    }
  }

  // 1. estimateUncompactedTokens - messages not covered by summaries
  console.log('\n--- Temporal Storage ---')

  const msg1 = {
    id: Identifier.ascending('message'),
    type: 'user',
    content: 'Hello',
    tokenEstimate: 10,
    createdAt: new Date().toISOString(),
  }
  const msg2 = {
    id: Identifier.ascending('message'),
    type: 'assistant',
    content: 'Hi there',
    tokenEstimate: 15,
    createdAt: new Date().toISOString(),
  }
  const msg3 = {
    id: Identifier.ascending('message'),
    type: 'user',
    content: 'How are you?',
    tokenEstimate: 20,
    createdAt: new Date().toISOString(),
  }

  await storage.temporal.appendMessage(msg1)
  await storage.temporal.appendMessage(msg2)
  await storage.temporal.appendMessage(msg3)

  let uncompacted = await storage.temporal.estimateUncompactedTokens()
  check(
    '1. estimateUncompactedTokens (no summaries)',
    uncompacted === 45,
    `got ${uncompacted}, expected 45`,
  )

  // Add a summary covering msg1 and msg2
  await storage.temporal.createSummary({
    id: Identifier.ascending('summary'),
    orderNum: 1,
    startId: msg1.id,
    endId: msg2.id,
    narrative: 'User greeted, assistant responded',
    keyObservations: JSON.stringify(['Initial greeting']),
    tags: '[]',
    tokenEstimate: 30,
    createdAt: new Date().toISOString(),
  })

  uncompacted = await storage.temporal.estimateUncompactedTokens()
  check(
    '1b. estimateUncompactedTokens (after summary)',
    uncompacted === 20,
    `got ${uncompacted}, expected 20 (only msg3)`,
  )

  // 4. Messages ordered by ULID
  const messages = await storage.temporal.getMessages()
  const orderedCorrectly =
    messages[0].id === msg1.id &&
    messages[1].id === msg2.id &&
    messages[2].id === msg3.id
  check('4. Messages ordered by ULID', orderedCorrectly)

  // 5. getSummaries filters by order
  const order1Summaries = await storage.temporal.getSummaries(1)
  check(
    '5. getSummaries(order) filters correctly',
    order1Summaries.length === 1 && order1Summaries[0].orderNum === 1,
  )

  // --- LTM Storage ---
  console.log('\n--- LTM Storage ---')

  // 2. CAS - update with wrong version throws ConflictError
  const testEntry = await storage.ltm.create({
    slug: 'test-entry',
    parentSlug: null,
    title: 'Test Entry',
    body: 'Original content',
    createdBy: 'main',
  })

  check('8a. createdBy set correctly', testEntry.createdBy === 'main')
  check('8b. updatedBy set correctly on create', testEntry.updatedBy === 'main')

  // Update with correct version
  const updated = await storage.ltm.update(
    'test-entry',
    'Updated content',
    1,
    'ltm-consolidate',
  )
  check('2a. CAS update with correct version succeeds', updated.version === 2)
  check(
    '8c. updatedBy changed after update',
    updated.updatedBy === 'ltm-consolidate',
  )

  // Update with wrong version should throw
  let casErrorThrown = false
  try {
    await storage.ltm.update('test-entry', 'Should fail', 1, 'main') // version 1 is stale
  } catch (e) {
    casErrorThrown = e instanceof ConflictError
  }
  check(
    '2b. CAS update with wrong version throws ConflictError',
    casErrorThrown,
  )

  // 6. glob() handles path patterns
  await storage.ltm.create({
    slug: 'knowledge',
    parentSlug: null,
    title: 'Knowledge',
    body: 'Root',
    createdBy: 'main',
  })
  await storage.ltm.create({
    slug: 'react',
    parentSlug: 'knowledge',
    title: 'React',
    body: 'React docs',
    createdBy: 'main',
  })
  await storage.ltm.create({
    slug: 'hooks',
    parentSlug: 'react',
    title: 'Hooks',
    body: 'Hooks docs',
    createdBy: 'main',
  })

  const globResult = await storage.ltm.glob('/knowledge/**')
  check(
    "6. glob('/knowledge/**') matches subtree",
    globResult.length >= 2,
    `got ${globResult.length} entries`,
  )

  // 7. archivedAt excluded from normal reads
  await storage.ltm.archive('test-entry', 2)
  const archivedRead = await storage.ltm.read('test-entry')
  check('7. Archived entries excluded from read()', archivedRead === null)

  const globAfterArchive = await storage.ltm.glob('/**')
  const archivedInGlob = globAfterArchive.some((e) => e.slug === 'test-entry')
  check('7b. Archived entries excluded from glob()', !archivedInGlob)

  // --- Present Storage ---
  console.log('\n--- Present Storage ---')

  // 9. Tasks JSON round-trip
  const tasks = [
    {id: 'task-1', content: 'First task', status: 'pending' as const},
    {id: 'task-2', content: 'Second task', status: 'in_progress' as const},
    {id: 'task-3', content: 'Third task', status: 'completed' as const},
    {
      id: 'task-4',
      content: 'Fourth task',
      status: 'blocked' as const,
      blockedReason: 'Waiting for X',
    },
  ]

  await storage.present.setTasks(tasks)
  const state = await storage.present.get()

  const tasksMatch =
    state.tasks.length === 4 &&
    state.tasks[0].status === 'pending' &&
    state.tasks[1].status === 'in_progress' &&
    state.tasks[2].status === 'completed' &&
    state.tasks[3].status === 'blocked' &&
    state.tasks[3].blockedReason === 'Waiting for X'

  check('9. Tasks JSON round-trip preserves structure', tasksMatch)

  // 3. /identity and /behavior defaults
  console.log('\n--- Default Entries ---')

  await initializeDefaultEntries(storage)

  const identity = await storage.ltm.read('identity')
  const behavior = await storage.ltm.read('behavior')

  check('3a. /identity created', identity !== null)
  check(
    '3b. /identity has sensible content',
    identity?.body.includes('Identity') ?? false,
  )
  check('3c. /behavior created', behavior !== null)
  check(
    '3d. /behavior has sensible content',
    behavior?.body.includes('Behavior') ?? false,
  )

  // 10. WAL mode - test with a real file
  console.log('\n--- Database ---')

  const testDbPath = path.join('/tmp', `nuum-verify-${Date.now()}.db`)
  try {
    const fileStorage = createStorage(testDbPath)
    const rawDb = getRawConnection(fileStorage._db)
    const walResult = rawDb.pragma('journal_mode') as {journal_mode: string}[]
    const isWal = walResult[0]?.journal_mode === 'wal'
    check('10. WAL mode enabled', isWal, `got ${JSON.stringify(walResult)}`)
  } finally {
    // Cleanup
    try {
      fs.unlinkSync(testDbPath)
    } catch {}
    try {
      fs.unlinkSync(testDbPath + '-wal')
    } catch {}
    try {
      fs.unlinkSync(testDbPath + '-shm')
    } catch {}
  }

  // Summary
  console.log('\n=== Summary ===')
  console.log(`Passed: ${passed}`)
  console.log(`Failed: ${failed}`)

  if (failed > 0) {
    process.exit(1)
  }
}

verify().catch(console.error)
