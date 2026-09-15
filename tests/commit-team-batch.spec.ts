import { describe, expect, it } from 'vitest'
import {
  planTeamSchedule,
  replayTeamEvents,
  TaskId,
  TeamBatchIntentCoordinator,
} from '../src/index.ts'
import type {
  Clock,
  EventIdSource,
  PrepareTeamBatchRequest,
  TeamEvent,
  TeamEventJournal,
} from '../src/index.ts'
import { contract, event, TEAM_ID } from './fixtures.ts'

class TestClock implements Clock {
  #tick = 0
  nowIso(): string { return `2026-08-15T11:00:${String(this.#tick++).padStart(2, '0')}Z` }
}

class TestIds implements EventIdSource {
  #next = 1
  next(): string { return `commit-batch-${this.#next++}` }
}

class MemoryJournal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  readonly #fail: boolean
  readonly #barrier: Promise<void> | undefined

  constructor(key: string, events: readonly unknown[], options: { fail?: boolean; barrier?: Promise<void> } = {}) {
    this.key = key
    this.events = [...events]
    this.#fail = options.fail ?? false
    this.#barrier = options.barrier
  }

  read(): readonly unknown[] { return this.events }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.transactions.push([...events])
    if (this.#barrier !== undefined) await this.#barrier
    this.events.push(...events)
    if (this.#fail) throw new Error('flush failed')
  }
}

function sourceEvents(): readonly TeamEvent[] {
  const left = TaskId('commit-left')
  const right = TaskId('commit-right')
  return [
    event(700, { type: 'yuqi/team-created', title: 'Commit batch', objective: 'Persist before start' }),
    event(701, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(702, { type: 'yuqi/task-created', contract: { ...contract(left), fileScope: ['src/**'] } }),
    event(703, { type: 'yuqi/task-created', contract: { ...contract(right), fileScope: ['tests/**'] } }),
  ]
}

function request(events: readonly unknown[]): PrepareTeamBatchRequest {
  const projection = replayTeamEvents(events)
  return {
    teamId: TEAM_ID,
    plan: planTeamSchedule(projection, { maxConcurrency: 2 }),
    maxConcurrency: 2,
    attempts: [
      { taskId: 'commit-left', attemptId: 'commit-attempt-left', modelProvider: 'p', modelId: 'deepseek-v4' },
      { taskId: 'commit-right', attemptId: 'commit-attempt-right', modelProvider: 'p', modelId: 'deepseek-v4' },
    ],
  }
}

describe('TeamBatchIntentCoordinator', () => {
  it('persists the entire batch in one transaction', async () => {
    const journal = new MemoryJournal('controller', sourceEvents())
    const coordinator = new TeamBatchIntentCoordinator(new TestClock(), new TestIds())
    const prepared = await coordinator.commit(request(journal.read()), journal)
    expect(journal.transactions).toHaveLength(1)
    expect(journal.transactions[0]).toEqual(prepared.events)
    expect(prepared.projection.tasks['commit-left']?.status).toBe('running')
    expect(replayTeamEvents(journal.read())).toEqual(prepared.projection)
  })

  it('serializes competing batches so the second observes a stale plan', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new MemoryJournal('controller', sourceEvents(), { barrier })
    const coordinator = new TeamBatchIntentCoordinator(new TestClock(), new TestIds())
    const batch = request(journal.read())
    const first = coordinator.commit(batch, journal)
    const second = coordinator.commit(batch, journal)
    await Promise.resolve()
    expect(journal.transactions).toHaveLength(1)
    release()
    await expect(first).resolves.toBeDefined()
    await expect(second).rejects.toMatchObject({ code: 'SCHEDULE_NOT_RUNNABLE' })
    expect(journal.transactions).toHaveLength(1)
  })

  it('wraps a failed durability barrier and leaves replay fail-closed', async () => {
    const journal = new MemoryJournal('controller', sourceEvents(), { fail: true })
    const coordinator = new TeamBatchIntentCoordinator(new TestClock(), new TestIds())
    const batch = request(journal.read())
    await expect(coordinator.commit(batch, journal)).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    await expect(coordinator.commit(batch, journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })

  it('drains accepted work on dispose and rejects new commits', async () => {
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const journal = new MemoryJournal('controller', sourceEvents(), { barrier })
    const coordinator = new TeamBatchIntentCoordinator(new TestClock(), new TestIds())
    const accepted = coordinator.commit(request(journal.read()), journal)
    const disposal = coordinator.dispose()
    await expect(coordinator.commit(request(sourceEvents()), new MemoryJournal('other', sourceEvents()))).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
    release()
    await expect(Promise.all([accepted, disposal])).resolves.toHaveLength(2)
  })
})
