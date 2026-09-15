import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { restorePersistedSession, type PersistedSessionSnapshot } from '../src/host/harness/session-restore.ts'

function source(): PersistedSessionSnapshot {
  const session = Session.create(SessionId('restore-contract'))
  session.append('turn/start', {} as never)
  return { meta: session.header, events: session.events }
}

describe('persisted Session restoration', () => {
  it('preserves the legacy public restore path', () => {
    const stored = source()
    const restored = restorePersistedSession(stored)
    expect(restored.id).toBe(stored.meta.id)
    expect(restored.events.slice(0, stored.events.length)).toEqual(stored.events)
  })

  it('passes the exact fork boundary to the current public factory', () => {
    const stored = { ...source(), inheritedEventCount: 1 }
    let argumentsSeen: unknown[] = []
    const runtime = { create(...args: unknown[]) {
      argumentsSeen = args
      return { id: stored.meta.id, snapshotEvents: () => stored.events, inheritedEventCount: args[3] }
    } } as unknown as Pick<typeof Session, 'create'>
    restorePersistedSession(stored, runtime)
    expect(argumentsSeen).toEqual([stored.meta.id, stored.events, stored.meta, 1])
    expect(argumentsSeen[1]).not.toBe(stored.events)
  })

  it.each([-1, 0.5, NaN, Infinity, 2])('rejects invalid inherited boundary %s before factory calls', inheritedEventCount => {
    const runtime = { create() { throw new Error('must not reach factory') } }
    expect(() => restorePersistedSession({ ...source(), inheritedEventCount }, runtime as never)).toThrow('Invalid persisted')
  })

  it('rejects a Host silently discarding a nonzero fork boundary', () => {
    expect(() => restorePersistedSession({ ...source(), inheritedEventCount: 1 })).toThrow('fork boundary')
  })

  it('does not require a new property for a legacy unseeded session', () => {
    expect(() => restorePersistedSession({ ...source(), inheritedEventCount: 0 })).not.toThrow()
  })

  it.each(['identity', 'prefix'])('rejects loss of %s during restore', loss => {
    const stored = source()
    const runtime = { create() {
      return { id: loss === 'identity' ? 'wrong' : stored.meta.id, snapshotEvents: () => loss === 'prefix' ? [] : stored.events }
    } }
    expect(() => restorePersistedSession(stored, runtime as never)).toThrow('identity and event prefix')
  })
})
