import { Context } from '@deepseek-ai/cordis'
import {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import {
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type PersistenceBackend,
} from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import {
  PROJECT_SUMMARY_SESSION_EVENT,
  REVIEW_SESSION_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_DETACHED_EVENT,
  TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
  TEAM_SESSION_EVENT,
  registerYuqiSessionEventTypes,
} from '../src/host/harness/session-journal.ts'

const YUQI_SESSION_EVENT_TYPES = [
  TEAM_SESSION_EVENT,
  PROJECT_SUMMARY_SESSION_EVENT,
  REVIEW_SESSION_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_DETACHED_EVENT,
  TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
] as const

describe('Yuqi Session event vocabulary lifecycle', () => {
  it('registers all required event types and disposes them once in reverse order', () => {
    const registered: string[] = []
    const disposed: string[] = []
    const register = vi.fn((type: string) => {
      registered.push(type)
      return () => { disposed.push(type) }
    })
    const dispose = registerYuqiSessionEventTypes(register)

    expect(registered).toEqual([
      ...YUQI_SESSION_EVENT_TYPES,
    ])
    dispose()
    dispose()
    expect(disposed).toEqual([...registered].reverse())
  })

  it('cold-loads downstream Yuqi events through the standard ignorable envelope', async () => {
    const id = SessionId('legacy-yuqi-event-vocabulary')
    const source = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
    const events = YUQI_SESSION_EVENT_TYPES.map((type, seq) => ({
      type,
      seq,
      time: seq,
      data: { legacy: true },
      ignorable: true,
    })) as unknown as SessionEvent[]
    expect(events.every(event => event.ignorable === true)).toBe(true)

    const revision = SessionPersistenceRevision('legacy-yuqi-event-vocabulary:1')
    const backend: PersistenceBackend = {
      name: 'legacy-yuqi-event-memory',
      async loadStored(requestedId) {
        if (requestedId !== id) return undefined
        return {
          meta: structuredClone(source.header),
          events: structuredClone(events),
          revision,
        }
      },
      async readStoredRevision(requestedId) { return requestedId === id ? revision : undefined },
      async appendBatch() {},
      async commitRepair() {},
      async list() { return [] },
    }
    const context = new Context()
    context.provide('sessions', {
      get: () => undefined,
      list: () => [],
      prepare: (sessionId: ReturnType<typeof SessionId>, options: { seed: SessionEvent[], meta: Session['header'] }) =>
        Session.create(sessionId, options.seed, options.meta),
    } as never)
    const persistence = new PersistenceCoordinator(context, backend)

    await expect(persistence.load(id)).resolves.toMatchObject({
      events: YUQI_SESSION_EVENT_TYPES.map(type => ({ type })),
    })
  })

})
