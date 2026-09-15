import { describe, expect, it } from 'vitest'
import {
  DurableJournalCoordinator,
  type Clock,
  type EventIdSource,
  type TeamEvent,
  type TeamEventJournal,
} from '../src/index.ts'
import { BeginVerificationCoordinator } from '../src/application/begin-verification.ts'
import { completeTeamEvents } from './fixtures.ts'

class ClockStub implements Clock {
  nowIso(): string { return '2026-08-16T00:00:00Z' }
}

class Ids implements EventIdSource {
  #next = 100
  next(): string { return `begin-verification-${this.#next++}` }
}

class Journal implements TeamEventJournal {
  readonly key = `begin-verification-${Math.random()}`
  readonly events: unknown[]
  readonly transactions: TeamEvent[][] = []
  constructor(seed: readonly unknown[]) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.transactions.push([...events])
    this.events.push(...events)
  }
}

class FailingJournal extends Journal {
  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.transactions.push([...events])
    throw new Error('append failed')
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    teamId: 'team-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    verificationId: 'verification-1',
    verifierSessionId: 'verifier-1',
    ...overrides,
  }
}

function coordinator() {
  return new BeginVerificationCoordinator(new ClockStub(), new Ids(), new DurableJournalCoordinator())
}

describe('BeginVerificationCoordinator', () => {
  it('atomically creates and starts verification for the latest settled successful attempt', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    const result = await coordinator().begin(request(), journal)

    expect(result.tasks['task-1']?.status).toBe('verifying')
    expect(result.verifications['verification-1']).toMatchObject({
      taskId: 'task-1', attemptId: 'attempt-1', verifierSessionId: 'verifier-1', status: 'running',
    })
    expect(journal.transactions).toHaveLength(1)
    expect(journal.transactions[0]?.map(event => event.type)).toEqual([
      'yuqi/verification-created', 'yuqi/verification-status-changed',
    ])
  })

  it('replays the same verification identity without creating or starting a second verification', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    const operation = coordinator()
    await operation.begin(request(), journal)
    const replay = await operation.begin(request(), journal)

    expect(replay.verifications['verification-1']?.status).toBe('running')
    expect(journal.transactions).toHaveLength(1)
  })

  it('rejects an idempotent-looking request from a different Team', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    const operation = coordinator()
    await operation.begin(request(), journal)

    await expect(operation.begin(request({ teamId: 'foreign-team' }), journal))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    expect(journal.transactions).toHaveLength(1)
  })

  it('rejects verification identity reuse with changed content and duplicate attempt identity', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    const operation = coordinator()
    await operation.begin(request(), journal)

    await expect(operation.begin(request({ verifierSessionId: 'other-verifier' }), journal))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    await expect(operation.begin(request({ verificationId: 'verification-2' }), journal))
      .rejects.toMatchObject({ code: 'VERIFICATION_OPERATION_CONFLICT' })
    expect(journal.transactions).toHaveLength(1)
  })

  it.each([
    ['wrong task', { taskId: 'missing-task' }],
    ['wrong attempt', { attemptId: 'missing-attempt' }],
  ])('rejects %s identity', async (_label, overrides) => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    await expect(coordinator().begin(request(overrides), journal))
      .rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
    expect(journal.transactions).toHaveLength(0)
  })

  it('rejects a task that is not verifying or an attempt that is not a settled success', async () => {
    const notVerifying = new Journal(completeTeamEvents().slice(0, 10))
    await expect(coordinator().begin(request(), notVerifying)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })

    const notSettled = new Journal(completeTeamEvents().slice(0, 8))
    await expect(coordinator().begin(request(), notSettled)).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
  })

  it('serializes concurrent identical requests and appends one bundle', async () => {
    const journal = new Journal(completeTeamEvents().slice(0, 11))
    const operation = coordinator()
    const [first, second] = await Promise.all([operation.begin(request(), journal), operation.begin(request(), journal)])

    expect(first.verifications['verification-1']?.status).toBe('running')
    expect(second.verifications['verification-1']?.status).toBe('running')
    expect(journal.transactions).toHaveLength(1)
  })

  it('poisons the journal after append failure and leaves no durable verification facts', async () => {
    const journal = new FailingJournal(completeTeamEvents().slice(0, 11))
    const operation = coordinator()

    await expect(operation.begin(request(), journal)).rejects.toMatchObject({ code: 'VERIFICATION_PERSISTENCE_FAILED' })
    expect(journal.events).toHaveLength(11)
    await expect(operation.begin(request(), journal)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })
})
