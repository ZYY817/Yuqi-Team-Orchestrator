import { describe, expect, it } from 'vitest'
import { assertRetainableOrphan } from '../src/host/harness/sidecar-orphan.ts'
import { SidecarRepository } from '../src/host/storage/session-sidecar.ts'
import { OwnedEventStore, type OwnedEventRecord, type OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { WORKSPACE_SNAPSHOT_LIMITS } from '../src/host/workspace-change-snapshot.ts'
import { completeTeamEvents, event, contract } from './fixtures.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'

function envelope(type: string, data: unknown, seq = 1) {
  return { type, data, seq, time: 1, ignorable: true }
}
const team = (events: readonly unknown[]) => envelope('yuqi/team-event', { events })
function snapshot() {
  return { version: 1, childSessionId: 'child', runId: 'run', scope: 'workspace', attribution: 'unavailable',
    beforeCapturedAt: '2026-09-06T00:00:00Z', afterCapturedAt: '2026-09-06T00:00:01Z',
    partial: false, reasons: [], limits: { ...WORKSPACE_SNAPSHOT_LIMITS },
    changes: [{ path: 'src/a.ts', kind: 'added', after: { sha256: 'a'.repeat(64), size: 12 } }] }
}
class Table implements OwnedEventTable {
  records = new Map<string, OwnedEventRecord>()
  get(key: string) { return this.records.get(key) }
  entries() { return this.records.entries() }
  async put(key: string, value: OwnedEventRecord) { this.records.set(key, value) }
  async update(key: string, fn: (value: OwnedEventRecord) => OwnedEventRecord) {
    const value = this.get(key)
    if (!value) throw new Error('missing-key')
    const next = fn(value)
    await this.put(key, next)
    return next
  }
}

describe('sidecar orphan classification', () => {
  it('retains strictly valid child workspace evidence', () => {
    expect(assertRetainableOrphan([envelope('yuqi/workspace-change-snapshot', snapshot())])).toBe('child-evidence')
  })
  it.each([
    { version: 2 }, { scope: 'agent' }, { attribution: 'owned' }, { beforeCapturedAt: 'invalid' },
    { partial: true }, { extra: true }, { limits: {} },
    { changes: [{ path: '../escape', kind: 'added', after: { sha256: 'a'.repeat(64), size: 1 } }] },
    { changes: [{ path: 'x', kind: 'deleted', after: { sha256: 'a'.repeat(64), size: 1 } }] },
    { changes: [{ path: 'x', kind: 'added', after: { sha256: 'invalid', size: 1 } }] },
  ])('rejects malformed child DTO %j', patch => {
    expect(() => assertRetainableOrphan([envelope('yuqi/workspace-change-snapshot', { ...snapshot(), ...patch })])).toThrow()
  })
  it('retains parent bridges for a still-active controller without reviving the parent', () => {
    const events = completeTeamEvents().slice(0, 3)
    expect(assertRetainableOrphan([
      envelope('yuqi/team-projection-bridge', { controllerSessionId: 'controller', sourceEventCount: events.length, events }),
      envelope('yuqi/team-parent-detached', { controllerSessionId: 'controller', bindingGeneration: 1 }, 2),
    ])).toBe('parent-index')
  })
  it('retains a valid detached-only parent index', () => {
    expect(assertRetainableOrphan([envelope('yuqi/team-parent-detached', {
      controllerSessionId: 'controller', bindingGeneration: 1,
    })])).toBe('parent-index')
  })
  it('rejects bridge cut mismatch and invalid detach payload', () => {
    expect(() => assertRetainableOrphan([envelope('yuqi/team-projection-bridge', {
      controllerSessionId: 'controller', sourceEventCount: 1, events: completeTeamEvents(),
    })])).toThrow()
    expect(() => assertRetainableOrphan([envelope('yuqi/team-parent-detached', {
      controllerSessionId: 'controller', bindingGeneration: 0,
    })])).toThrow()
  })
  it('retains a fully settled completed controller', () => {
    expect(assertRetainableOrphan([team(completeTeamEvents())])).toBe('terminal-controller')
  })
  it.each([1, 3, 8, 13])('rejects nonterminal controller cut %s', cut => {
    expect(() => assertRetainableOrphan([team(completeTeamEvents().slice(0, cut))])).toThrow()
  })
  it('rejects invalid Team payload rather than treating it as absent', () => {
    expect(() => assertRetainableOrphan([team([{ type: 'yuqi/team-created' }])])).toThrow()
  })
  it('rejects controller metadata without an authoritative Team stream', () => {
    expect(() => assertRetainableOrphan([envelope('yuqi/team-parent-binding', {
      parentSessionId: 'parent', generation: 1, operationId: 'bind', boundAt: '2026-09-06T00:00:00Z',
    })])).toThrow()
  })
  it('rejects a terminal failed controller that still has schedulable tasks', () => {
    const facts = [event(1, { type: 'yuqi/team-created', title: 't', objective: 'o' }),
      event(2, { type: 'yuqi/task-created', contract: contract() }),
      event(3, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(4, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed' })]
    expect(replayTeamEvents(facts).team.status).toBe('failed')
    expect(() => assertRetainableOrphan([team(facts)])).toThrow()
  })
  it.each([8, 13])('rejects a replay-valid failed Team with active work at cut %s', cut => {
    const facts = [...completeTeamEvents().slice(0, cut),
      event(100, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed' })]
    expect(replayTeamEvents(facts).team.status).toBe('failed')
    expect(() => assertRetainableOrphan([team(facts)])).toThrow('not safely retainable')
  })
  it('rejects mixed child and parent/control roles', () => {
    expect(() => assertRetainableOrphan([
      envelope('yuqi/workspace-change-snapshot', snapshot()),
      { ...team(completeTeamEvents()), seq: 2 },
    ])).toThrow()
  })
  it.each([[], [envelope('yuqi/unknown', {})], [envelope('yuqi/team-event', { events: [] })],
    [{ ...team(completeTeamEvents()), seq: 2 }], [{ ...team(completeTeamEvents()), ignorable: false }]].map(events => ({ events })))
  ('rejects empty, unknown, or corrupt envelopes %#', ({ events }) => {
    expect(() => assertRetainableOrphan(events)).toThrow()
  })
  it('reads detached stored evidence without any Session or write, and checks disposal', async () => {
    const table = new Table()
    const store = new OwnedEventStore({ table, controllerSessionId: 'child' })
    const evidence = envelope('yuqi/workspace-change-snapshot', snapshot())
    await store.commit({ expectedRevision: 0, operationId: 'op', events: [evidence] })
    const before = JSON.stringify([...table.entries()])
    const repo = new SidecarRepository(table)
    const events = repo.readStoredEvents('child')
    expect(assertRetainableOrphan(events)).toBe('child-evidence')
    ;(events[0]!.data as unknown as { changes: unknown[] }).changes.length = 0
    expect(repo.readStoredEvents('child')[0]).toEqual(evidence)
    expect(repo.readStoredEvents('absent')).toEqual([])
    expect(JSON.stringify([...table.entries()])).toBe(before)
    repo.dispose()
    expect(() => repo.readStoredEvents('child')).toThrow('disposed')
  })
  it('rejects stored envelope corruption through the readonly repository method', async () => {
    const table = new Table()
    const store = new OwnedEventStore({ table, controllerSessionId: 'child' })
    await store.commit({ expectedRevision: 0, operationId: 'op', events: [envelope('yuqi/x', {}, 9)] })
    expect(() => new SidecarRepository(table).readStoredEvents('child')).toThrow('envelope')
  })
  it('enumerates only identities without accessing payloads, but validates selected reads', () => {
    const table = new Table()
    const store = new OwnedEventStore({ table, controllerSessionId: 'child' })
    let payloadReads = 0
    const bad = Object.freeze({ controllerSessionId: 'child', schemaVersion: 1, revision: 1,
      get batches(): never { payloadReads++; throw new Error('payload accessed') } })
    table.records.set(store.key, bad)
    const repo = new SidecarRepository(table)
    expect(repo.listSessionIds()).toEqual(['child'])
    expect(payloadReads).toBe(0)
    expect(() => repo.readStoredEvents('child')).toThrow()
    table.records.clear()
    table.records.set('wrong-key', bad)
    expect(() => repo.listSessionIds()).toThrow('Invalid sidecar session key')
    expect(payloadReads).toBe(0)
  })
})
