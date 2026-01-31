import {describe, it, expect, beforeEach} from 'bun:test'
import {createInMemoryStorage, type Storage} from './index'

describe('TasksStorage', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createInMemoryStorage()
  })

  describe('createTask', () => {
    it('creates a task with running status', async () => {
      const id = await storage.tasks.createTask({
        type: 'research',
        description: 'Research Stripe API',
      })

      expect(id).toMatch(/^bgt_/)

      const task = await storage.tasks.getTask(id)
      expect(task).not.toBeNull()
      expect(task!.type).toBe('research')
      expect(task!.description).toBe('Research Stripe API')
      expect(task!.status).toBe('running')
    })
  })

  describe('listTasks', () => {
    it('lists all tasks', async () => {
      await storage.tasks.createTask({type: 'research', description: 'Task 1'})
      await storage.tasks.createTask({type: 'reflect', description: 'Task 2'})

      const tasks = await storage.tasks.listTasks()
      expect(tasks).toHaveLength(2)
    })

    it('filters by status', async () => {
      const id1 = await storage.tasks.createTask({
        type: 'research',
        description: 'Task 1',
      })
      await storage.tasks.createTask({type: 'reflect', description: 'Task 2'})
      await storage.tasks.completeTask(id1, {report: 'done'})

      const running = await storage.tasks.listTasks({status: 'running'})
      expect(running).toHaveLength(1)
      expect(running[0].description).toBe('Task 2')
    })
  })

  describe('completeTask', () => {
    it('marks task as completed with result', async () => {
      const id = await storage.tasks.createTask({
        type: 'research',
        description: 'Research something',
      })

      await storage.tasks.completeTask(id, {report: 'Found the answer'})

      const task = await storage.tasks.getTask(id)
      expect(task!.status).toBe('completed')
      expect(task!.result).toEqual({report: 'Found the answer'})
      expect(task!.completedAt).not.toBeNull()
    })
  })

  describe('failTask', () => {
    it('marks task as failed with error', async () => {
      const id = await storage.tasks.createTask({
        type: 'research',
        description: 'Research something',
      })

      await storage.tasks.failTask(id, 'Network error')

      const task = await storage.tasks.getTask(id)
      expect(task!.status).toBe('failed')
      expect(task!.error).toBe('Network error')
    })
  })

  describe('recoverKilledTasks', () => {
    it('marks running tasks as killed and returns them', async () => {
      const id1 = await storage.tasks.createTask({
        type: 'research',
        description: 'Task 1',
      })
      const id2 = await storage.tasks.createTask({
        type: 'reflect',
        description: 'Task 2',
      })
      await storage.tasks.completeTask(id2, {done: true})

      const killed = await storage.tasks.recoverKilledTasks()

      expect(killed).toHaveLength(1)
      expect(killed[0].id).toBe(id1)
      expect(killed[0].status).toBe('killed')

      // Verify it's actually updated in DB
      const task = await storage.tasks.getTask(id1)
      expect(task!.status).toBe('killed')
    })
  })

  describe('result queue', () => {
    it('queues and drains results', async () => {
      const taskId = await storage.tasks.createTask({
        type: 'research',
        description: 'Test',
      })

      await storage.tasks.queueResult(taskId, 'Result 1')
      await storage.tasks.queueResult(taskId, 'Result 2')

      expect(await storage.tasks.hasQueuedResults()).toBe(true)

      const results = await storage.tasks.drainQueue()
      expect(results).toHaveLength(2)
      expect(results[0].content).toBe('Result 1')
      expect(results[1].content).toBe('Result 2')

      expect(await storage.tasks.hasQueuedResults()).toBe(false)
    })
  })

  describe('alarms', () => {
    it('creates and lists alarms', async () => {
      const firesAt = new Date(Date.now() + 60000).toISOString()
      const id = await storage.tasks.createAlarm({
        firesAt,
        note: 'Check deployment',
      })

      expect(id).toMatch(/^bgt_/)

      const alarms = await storage.tasks.listAlarms()
      expect(alarms).toHaveLength(1)
      expect(alarms[0].note).toBe('Check deployment')
      expect(alarms[0].fired).toBe(false)
    })

    it('gets due alarms', async () => {
      const past = new Date(Date.now() - 1000).toISOString()
      const future = new Date(Date.now() + 60000).toISOString()

      await storage.tasks.createAlarm({firesAt: past, note: 'Past alarm'})
      await storage.tasks.createAlarm({firesAt: future, note: 'Future alarm'})

      const due = await storage.tasks.getDueAlarms()
      expect(due).toHaveLength(1)
      expect(due[0].note).toBe('Past alarm')
    })

    it('marks alarms as fired', async () => {
      const firesAt = new Date(Date.now() - 1000).toISOString()
      const id = await storage.tasks.createAlarm({firesAt, note: 'Test'})

      await storage.tasks.markAlarmFired(id)

      const due = await storage.tasks.getDueAlarms()
      expect(due).toHaveLength(0)

      const all = await storage.tasks.listAlarms({includeFired: true})
      expect(all).toHaveLength(1)
      expect(all[0].fired).toBe(true)
    })
  })
})
