import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { reviewResultSchema } from '../src/application/reviewer.ts'
import { HarnessReviewJournal, REVIEW_SESSION_EVENT } from '../src/host/harness/review-journal.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { TEAM_PARENT_PROJECTION_EVENT } from '../src/host/harness/session-journal.ts'
import { readSessionEvents } from '../src/host/harness/session-events.ts'
import { completeTeamEvents } from './fixtures.ts'
import { snapshotOnlySession } from './snapshot-session-fixture.ts'
import * as sessionRestore from '../src/host/harness/session-restore.ts'

it('forwards the persisted controller fork boundary to restorePersistedSession', async () => {
  const session = Session.create(SessionId('restore-controller'))
  session.append('turn/start', { turn: 1 })
  const snapshot = { meta: session.header, events: readSessionEvents(session), inheritedEventCount: 1 }
  const restore = vi.spyOn(sessionRestore, 'restorePersistedSession').mockReturnValue(session)
  const { service, persistence } = serviceWithPersistence()
  Object.assign(persistence, { load: async (id: SessionId) => String(id) === String(session.id) ? snapshot : undefined })
  try {
    await expect(service['loadPersistedControllerSession'](String(session.id))).resolves.toBe(session)
    expect(restore).toHaveBeenCalledExactlyOnceWith(snapshot)
    await expect(service['loadPersistedControllerSession']('different-controller')).resolves.toBeUndefined()
    expect(restore).toHaveBeenCalledTimes(1)
  } finally {
    restore.mockRestore()
  }
})

function serviceWithPersistence(initial: readonly SessionEvent[] = []) {
  let stored = [...initial]
  const persistence = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => {}),
    readFrom: vi.fn(async () => ({ events: [...stored] })),
    append: vi.fn(async (_id: SessionId, events: readonly SessionEvent[]) => { stored.push(...events) }),
  }
  // Exercise the existing methods without starting the service's background workers.
  const service = Object.create(YuqiTeamOrchestratorService.prototype) as YuqiTeamOrchestratorService
  Object.defineProperty(service, 'ctx', { value: { sessionPersistence: persistence } })
  return { service, persistence, stored: () => stored }
}

function observedSnapshot(session: Session, snapshot: () => readonly SessionEvent[]): Session {
  return new Proxy(snapshotOnlySession(session), {
    get(target, property) {
      if (property === 'append') return target.append.bind(target)
      return property === 'snapshotEvents' ? snapshot : Reflect.get(target, property)
    },
  })
}

describe('service snapshot comparison stages', () => {
  it('hydrates from one snapshot even when subsequent reads would change', async () => {
    const original = Session.create(SessionId('hydrate-stage'))
    original.append('turn/start', { turn: 1 })
    const durable = Session.create(original.id)
    durable.append('turn/start', { turn: 1 })
    durable.append('turn/start', { turn: 2 })
    const snapshot = vi.fn((): readonly SessionEvent[] => [])
      .mockReturnValueOnce(Object.freeze([...readSessionEvents(original)]))
    const { service } = serviceWithPersistence(readSessionEvents(durable))
    await service['hydrateLiveParentFromDurable'](observedSnapshot(original, snapshot))
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(readSessionEvents(original).map(event => event.data)).toEqual(readSessionEvents(durable).map(event => event.data))
  })

  it('reads once per flush comparison phase and refreshes after awaited persistence', async () => {
    const original = Session.create(SessionId('flush-stage'))
    original.append('turn/start', { turn: 1 })
    const prefix = [...readSessionEvents(original)]
    original.append('turn/start', { turn: 2 })
    const { service, persistence, stored } = serviceWithPersistence(prefix)
    let phaseRead = false
    const snapshot = vi.fn(() => {
      if (phaseRead) throw new Error('snapshot read twice within one comparison phase')
      phaseRead = true
      return Object.freeze([...readSessionEvents(original)])
    })
    persistence.readFrom.mockImplementation(async () => {
      phaseRead = false
      return { events: [...stored()] }
    })
    await expect(service['flushProjectionSession'](observedSnapshot(original, snapshot))).resolves.toBe(true)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(stored()).toEqual(readSessionEvents(original))
  })

  it('takes a fresh snapshot after projection append, then reuses it for verification', async () => {
    const original = Session.create(SessionId('projection-stage'))
    const durable = Session.create(original.id)
    const events = completeTeamEvents()
    durable.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: 'controller-stage', sourceEventCount: events.length, events })
    const snapshot = vi.fn(() => Object.freeze([...readSessionEvents(original)]))
    const { service, persistence } = serviceWithPersistence(readSessionEvents(durable))
    await expect(service['flushProjectionSession'](observedSnapshot(original, snapshot))).resolves.toBe(true)
    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(snapshot.mock.results[0]?.value).toHaveLength(0)
    expect(snapshot.mock.results[1]?.value).toHaveLength(1)
    expect(persistence.append).not.toHaveBeenCalled()
  })
})

describe.each(['legacy', 'snapshot'] as const)('Harness Session reads (%s)', capability => {
  const expose = (session: Session) => capability === 'snapshot' ? snapshotOnlySession(session) : session

  it('rereads reviewer results after append and ignores unrelated events', () => {
    const original = Session.create(SessionId('review-read'))
    const journal = new HarnessReviewJournal(expose(original), { flush: async () => true })
    expect(journal.read()).toEqual([])
    original.append('turn/start', { turn: 1 })
    const result = reviewResultSchema.parse({ reviewId: 'review-1', reviewerSessionId: 'reviewer-1', trigger: 'pre-completion', decision: 'pass', findings: [], unverified: [] })
    original.append(REVIEW_SESSION_EVENT, { result })
    expect(journal.read()).toEqual([result])
  })

  it('materializes the existing live events and checks fresh history after awaiting persistence', async () => {
    const original = Session.create(SessionId('durable-read'))
    original.append('turn/start', { turn: 1 })
    const { service, persistence, stored } = serviceWithPersistence()
    await service['ensureSessionDurable'](expose(original))
    expect(persistence.create).toHaveBeenCalledWith(original.header)
    expect(stored()).toEqual(readSessionEvents(original))
    expect(persistence.append).toHaveBeenCalledTimes(1)
    persistence.readFrom.mockImplementationOnce(async () => ({ events: [...stored()] })).mockImplementationOnce(async () => {
      original.append('turn/start', { turn: 2 })
      return { events: [...stored()] }
    })
    await expect(service['flushProjectionSession'](expose(original))).resolves.toBe(false)
  })

  it('hydrates a matching durable tail and refuses a divergent prefix', async () => {
    const original = Session.create(SessionId('hydrate-read'))
    original.append('turn/start', { turn: 1 })
    const durable = Session.create(original.id)
    durable.append('turn/start', { turn: 1 })
    durable.append('turn/start', { turn: 2 })
    const { service, persistence } = serviceWithPersistence(readSessionEvents(durable))
    await service['hydrateLiveParentFromDurable'](expose(original))
    expect(readSessionEvents(original).map(event => event.data)).toEqual(readSessionEvents(durable).map(event => event.data))
    expect(persistence.append).not.toHaveBeenCalled()
    const divergent = Session.create(original.id)
    divergent.append('turn/start', { turn: 99 })
    const before = [...readSessionEvents(divergent)]
    await service['hydrateLiveParentFromDurable'](expose(divergent))
    expect(readSessionEvents(divergent)).toEqual(before)
    await expect(service['flushProjectionSession'](expose(divergent))).resolves.toBe(false)
    expect(persistence.append).not.toHaveBeenCalled()
  })

  it('flushes only the live tail and preserves the normal flush short circuit', async () => {
    const original = Session.create(SessionId('flush-read'))
    original.append('turn/start', { turn: 1 })
    const prefix = [...readSessionEvents(original)]
    original.append('turn/start', { turn: 2 })
    const { service, persistence, stored } = serviceWithPersistence(prefix)
    await expect(service['flushProjectionSession'](expose(original), async () => true)).resolves.toBe(true)
    expect(persistence.readFrom).not.toHaveBeenCalled()
    await expect(service['flushProjectionSession'](expose(original), async () => false)).resolves.toBe(true)
    expect(persistence.append).toHaveBeenCalledWith(original.id, readSessionEvents(original).slice(prefix.length))
    expect(stored()).toEqual(readSessionEvents(original))
  })

  it('rereads after appending a durable projection bridge and preserves its payload events', async () => {
    const original = Session.create(SessionId('projection-read'))
    const durable = Session.create(original.id)
    const events = completeTeamEvents()
    durable.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: 'controller-read', sourceEventCount: events.length, events })
    const { service, persistence } = serviceWithPersistence(readSessionEvents(durable))
    await expect(service['flushProjectionSession'](expose(original))).resolves.toBe(true)
    expect(readSessionEvents(original).at(-1)?.data).toEqual(readSessionEvents(durable).at(-1)?.data)
    expect(persistence.append).not.toHaveBeenCalled()
    service['scanColdRecoverySession'](expose(original))
  })
})
