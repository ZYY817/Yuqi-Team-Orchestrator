import { describe, expect, it } from 'vitest'
import { OwnedTeamJournal } from '../src/host/storage/owned-team-journal.ts'
import { OwnedEventStore, type OwnedEventRecord, type OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { TeamBootstrapCoordinator } from '../src/application/bootstrap-team.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { TaskId } from '../src/domain/ids.ts'
import { createTeamEvent } from '../src/application/team-events.ts'

function setup() {
  const rows = new Map<string, OwnedEventRecord>()
  let fail = false
  const table: OwnedEventTable = {
    get: key => rows.get(key), entries: () => rows.entries(),
    async put(key, value) { if (fail) throw new Error('storage rejected'); rows.set(key, value) },
    async update(key, fn) {
      const next = fn(rows.get(key)!)
      if (fail) throw new Error('storage rejected')
      rows.set(key, next)
      return next
    },
  }
  const make = () => new OwnedTeamJournal(new OwnedEventStore({ table, controllerSessionId: 'owned-controller' }))
  const transactions = new DurableJournalCoordinator()
  const clock = { nowIso: () => '2026-09-06T00:00:00Z' }
  let id = 0
  const ids = { next: () => `owned-test-${id++}` }
  const coordinator = new TeamBootstrapCoordinator(clock, ids, transactions)
  const request = { metadata: { teamId: 'owned-team', title: 'Owned', objective: 'Test' }, tasks: [{
    taskId: TaskId('one'), revision: 1, goal: 'Read text', scope: ['one.txt'], nonGoals: ['write'],
    dependencies: [], fileScope: ['one.txt'], modelRole: 'worker' as const, modelId: 'test-model',
    acceptanceCriteria: ['Read'], authorityMode: 'read-only' as const, inputDigest: 'one', baselineRef: 'initial',
  }] }
  const pause = () => createTeamEvent(clock, ids, 'owned-team', { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' })
  const addTask = (taskId = 'two') => createTeamEvent(clock, ids, 'owned-team', { type: 'yuqi/task-created',
    contract: { ...request.tasks[0]!, taskId: TaskId(taskId), fileScope: [`${taskId}.txt`] } })
  return { make, coordinator, transactions, request, pause, addTask, fail: () => { fail = true } }
}

describe('owned Team journal application port', () => {
  it('creates and replays a complete Team through the existing coordinator', async () => {
    const s = setup()
    try {
      const journal = s.make()
      const projection = await s.coordinator.bootstrap(s.request, journal)
      expect(projection.team.status).toBe('running')
      expect(s.make().read()).toEqual(journal.read())
      await s.coordinator.bootstrap(s.request, s.make())
      expect(s.make().read()).toHaveLength(journal.read().length)
    } finally { await s.transactions.dispose() }
  })

  it('does not publish a rejected commit or permit subsequent side effects through a poisoned coordinator', async () => {
    const s = setup()
    try {
      const journal = s.make()
      await s.coordinator.bootstrap(s.request, journal)
      const before = journal.read()
      s.fail()
      await expect(s.transactions.run(journal, tx => tx.commit([s.pause()], 'INTENT_PERSISTENCE_FAILED', 'failed')))
        .rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
      expect(journal.read()).toEqual(before)
      await expect(s.transactions.run(journal, async () => {}))
        .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    } finally { await s.transactions.dispose() }
  })

  it('rejects stale readers rather than overwriting another controller decision', async () => {
    const s = setup()
    try {
      const a = s.make()
      await s.coordinator.bootstrap(s.request, a)
      const b = s.make()
      b.read()
      await a.commit([s.addTask()])
      b.read() // A display refresh must not authorize the older decision cut.
      await expect(b.commit([s.pause()])).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(b.read()).toEqual(a.read())
    } finally { await s.transactions.dispose() }
  })

  it('requires a read before a nonempty commit', async () => {
    const s = setup()
    try { await expect(s.make().commit([s.pause()])).rejects.toThrow('Read the Team journal') }
    finally { await s.transactions.dispose() }
  })

  it('accepts an exact stale retry without poisoning its coordinator', async () => {
    const s = setup()
    try {
      const a = s.make()
      await s.coordinator.bootstrap(s.request, a)
      const b = s.make()
      b.read()
      const batch = [s.pause()]
      await a.commit(batch)
      const before = a.read()
      await s.transactions.run(b, tx => tx.commit(batch, 'INTENT_PERSISTENCE_FAILED', 'failed'))
      expect(b.read()).toEqual(before)
      await expect(s.transactions.run(b, async () => 'not poisoned')).resolves.toBe('not poisoned')
    } finally { await s.transactions.dispose() }
  })

  it('does not authorize later writes by acknowledging an older identical batch', async () => {
    const s = setup()
    try {
      const a = s.make()
      await s.coordinator.bootstrap(s.request, a)
      const b = s.make()
      b.read()
      const earlier = [s.addTask('two')]
      const oldDecision = [s.addTask('four')]
      await a.commit(earlier)
      await a.commit([s.addTask('three')])
      await s.transactions.run(b, tx => tx.commit(earlier, 'INTENT_PERSISTENCE_FAILED', 'failed'))
      await expect(s.transactions.run(b, async () => 'not poisoned')).resolves.toBe('not poisoned')
      b.read()
      await expect(b.commit(oldDecision)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
      expect(b.read()).toEqual(a.read())
    } finally { await s.transactions.dispose() }
  })
})
