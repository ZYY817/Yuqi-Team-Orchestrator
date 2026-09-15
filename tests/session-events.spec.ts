import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { readSessionEvents } from '../src/host/harness/session-events.ts'
import { readLatestTeamParentReportCheckpoint } from '../src/host/harness/session-journal.ts'

function event(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: seq, data: { turn: seq } }
}

describe('readSessionEvents', () => {
  it('reads the latest Team report checkpoint through the snapshot-only journal path', () => {
    const checkpoint = { controllerSessionId: 'controller-1', parentSessionId: 'parent-1', bindingGeneration: 1,
      sourceEventCount: 2, messageId: 'report-1', deliveredAt: '2026-09-06T00:00:00.000Z' }
    const entries = [{ type: 'yuqi/team-parent-report-checkpoint', seq: 0, time: 1, data: checkpoint }]
    const session = { id: 'controller-1', snapshotEvents: () => entries } as unknown as Parameters<typeof readLatestTeamParentReportCheckpoint>[0]
    expect(readLatestTeamParentReportCheckpoint(session, 'parent-1', 1)).toEqual(checkpoint)
    entries.push({ type: 'yuqi/team-parent-report-checkpoint', seq: 1, time: 2, data: { ...checkpoint, sourceEventCount: 3 } })
    expect(readLatestTeamParentReportCheckpoint(session, 'parent-1', 1)?.sourceEventCount).toBe(3)
    expect(readLatestTeamParentReportCheckpoint(session, 'other-parent', 1)).toBeUndefined()
  })
  it('returns the legacy array by identity with a readonly result type', () => {
    const events = [event(1)]
    const session = Object.freeze({ events })
    const result = readSessionEvents(session)
    expectTypeOf(result).toEqualTypeOf<readonly SessionEvent[]>()
    expect(result).toBe(events)
    expect(result).toEqual([event(1)])
    expect(Object.isFrozen(events)).toBe(false)
    expect(session.events).toBe(events)
  })

  it('prefers the snapshot method, preserves this, and does not read legacy events', () => {
    const events = Object.freeze([event(1)])
    class SnapshotSession {
      #events = events
      snapshotEvents() { return this.#events }
      get events(): never { throw new Error('legacy events must not be read') }
    }
    const session = Object.freeze(new SnapshotSession())
    expect(readSessionEvents(session)).toBe(events)
  })

  it.each(['legacy', 'snapshot'] as const)('accepts a real empty %s array', capability => {
    const events: SessionEvent[] = []
    const session = capability === 'legacy' ? { events } : { snapshotEvents: () => events }
    expect(readSessionEvents(session)).toBe(events)
  })

  it.each([null, undefined, 1, 'session', {}, { events: null }, { events: {} },
    { events: { length: 0 } }, { snapshotEvents: true }])('rejects missing public capability: %j', session => {
    expect(() => readSessionEvents(session)).toThrow(/Harness Session must expose/)
  })

  it('does not inspect a private log or manufacture an empty history', () => {
    const session = { get log(): never { throw new Error('private log must not be read') } }
    expect(() => readSessionEvents(session)).toThrow(/Harness Session must expose/)
  })

  it.each([undefined, null, {}, 'events', { length: 0 }, Promise.resolve([])])(
    'rejects invalid snapshot output without falling back: %j', output => {
      const session = { events: [event(1)], snapshotEvents: () => output }
      expect(() => readSessionEvents(session)).toThrow('Harness Session.snapshotEvents() must return an array')
    },
  )

  it('propagates snapshot failures without falling back', () => {
    const failure = new Error('snapshot unavailable')
    const session = { events: [event(1)], snapshotEvents() { throw failure } }
    expect(() => readSessionEvents(session)).toThrow(failure)
  })

  it('uses legacy events when snapshotEvents is not callable', () => {
    const events = [event(1)]
    expect(readSessionEvents({ snapshotEvents: true, events })).toBe(events)
  })

  it('rereads the legacy getter after append and array replacement', () => {
    let events = [event(1)]
    const session = { get events() { return events } }
    expect(readSessionEvents(session)).toBe(events)
    events.push(event(2))
    expect(readSessionEvents(session)).toEqual([event(1), event(2)])
    events = [...events, event(3)]
    expect(readSessionEvents(session)).toBe(events)
    expect(readSessionEvents(session)).toHaveLength(3)
  })

  it('calls snapshotEvents again after append without caching or cloning its output', () => {
    let events = Object.freeze([event(1)])
    let calls = 0
    const session = { snapshotEvents() { calls += 1; return events } }
    const first = readSessionEvents(session)
    expect(first).toBe(events)
    events = Object.freeze([...events, event(2)])
    expect(readSessionEvents(session)).toBe(events)
    expect(first).toHaveLength(1)
    expect(events).toHaveLength(2)
    expect(calls).toBe(2)
  })
})
