import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { OwnedEventStore, type OwnedEventRecord, type OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { SidecarRepository, appendSidecarEvent, hasSidecarSession, readSidecarEvents } from '../src/host/storage/session-sidecar.ts'

class Table implements OwnedEventTable {
  records = new Map<string, OwnedEventRecord>()
  beforeWrite: () => Promise<void> = async () => {}
  get(key: string) { return this.records.get(key) }
  entries() { return this.records.entries() }
  async put(key: string, value: OwnedEventRecord) {
    await this.beforeWrite()
    this.records.set(key, value)
  }
  async update(key: string, transform: (value: OwnedEventRecord) => OwnedEventRecord) {
    const value = transform(this.records.get(key)!)
    await this.put(key, value)
    return value
  }
}
function session(id = 'controller', events: unknown[] = []) {
  return Object.freeze({ id, events, append: vi.fn() }) as unknown as Session
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('Session sidecar', () => {
  it('awaits beforeAppend inside the session queue before publishing any sidecar facts', async () => {
    const table = new Table(), live = session('parent')
    const entered = deferred(), release = deferred()
    const beforeAppend = vi.fn(async (received: Session) => {
      expect(received).toBe(live)
      entered.resolve()
      await release.promise
    })
    const repo = new SidecarRepository(table, { beforeAppend })
    repo.bind(live)
    expect(beforeAppend).not.toHaveBeenCalled()
    const first = appendSidecarEvent(live, 'yuqi/first', {})
    await entered.promise
    const second = appendSidecarEvent(live, 'yuqi/second', {})
    expect(beforeAppend).toHaveBeenCalledTimes(1)
    expect(table.records.size).toBe(0)
    expect(readSidecarEvents(live)).toEqual([])
    release.resolve()
    expect((await Promise.all([first, second])).map(event => event.seq)).toEqual([1, 2])
    expect(beforeAppend).toHaveBeenCalledTimes(2)
    expect(live.append).not.toHaveBeenCalled()
  })

  it.each([false, true])('does not write or consume revision on beforeAppend failure (existing=%s)', async existing => {
    const table = new Table(), live = session('child')
    const beforeAppend = vi.fn(async (_session: Session) => {})
    const repo = new SidecarRepository(table, { beforeAppend })
    repo.bind(live)
    if (existing) await appendSidecarEvent(live, 'yuqi/initial', {})
    const before = [...table.entries()]
    const failure = new Error('header persistence failed')
    beforeAppend.mockRejectedValueOnce(failure)
    await expect(appendSidecarEvent(live, 'yuqi/failed', {})).rejects.toBe(failure)
    expect([...table.entries()]).toEqual(before)
    expect(readSidecarEvents(live)).toHaveLength(existing ? 1 : 0)
    expect((await appendSidecarEvent(live, 'yuqi/retry', {})).seq).toBe(existing ? 2 : 1)
    expect(live.append).not.toHaveBeenCalled()
  })

  it.each(['disposed', 'legacy'])('rechecks %s after the asynchronous prerequisite', async reason => {
    const table = new Table(), events: unknown[] = [], live = session('child', events)
    const entered = deferred(), release = deferred()
    const repo = new SidecarRepository(table, { beforeAppend: async () => {
      entered.resolve()
      await release.promise
    } })
    repo.bind(live)
    const pending = appendSidecarEvent(live, 'yuqi/annotation', {})
    const rejection = expect(pending).rejects.toThrow(reason)
    await entered.promise
    if (reason === 'disposed') repo.dispose()
    else events.push({ type: 'yuqi/legacy' })
    release.resolve()
    await rejection
    expect(table.records.size).toBe(0)
    expect(live.append).not.toHaveBeenCalled()
  })

  it('binds without modifying the Session and stores full envelopes for every session role', async () => {
    const table = new Table(), repo = new SidecarRepository(table)
    const controller = session(), parent = session('parent'), child = session('child')
    expect(readSidecarEvents(controller)).toBeUndefined()
    expect(hasSidecarSession(controller)).toBe(false)
    await expect(appendSidecarEvent(controller, 'yuqi/team-event', {})).rejects.toThrow('not bound')
    for (const live of [controller, parent, child]) {
      repo.bind(live)
      repo.bind(live)
      expect(readSidecarEvents(live)).toEqual([])
      const event = await appendSidecarEvent(live, 'yuqi/annotation', { nested: { n: 1 } })
      expect(event).toEqual({ type: 'yuqi/annotation', data: { nested: { n: 1 } }, seq: 1, time: expect.any(Number), ignorable: true })
      expect(new OwnedEventStore({ table, controllerSessionId: live.id }).read().events).toEqual([event])
      ;(event.data as unknown as { nested: { n: number } }).nested.n = 99
      expect(readSidecarEvents(live)?.[0]?.data).toEqual({ nested: { n: 1 } })
      expect(live.events).toEqual([])
      expect(live.append).not.toHaveBeenCalled()
    }
    expect(repo.listSessionIds()).toEqual(['controller', 'parent', 'child'])
    repo.dispose()
    expect(() => hasSidecarSession(controller)).toThrow('disposed')
    expect(() => readSidecarEvents(controller)).toThrow('disposed')
    await expect(appendSidecarEvent(controller, 'yuqi/annotation', {})).rejects.toThrow('disposed')
    expect(() => repo.bind(controller)).toThrow('disposed')
    expect(() => repo.listSessionIds()).toThrow('disposed')
    const reopened = new SidecarRepository(table)
    reopened.bind(controller)
    expect((await appendSidecarEvent(controller, 'yuqi/annotation', {})).seq).toBe(2)
  })

  it('keeps compacted bridge envelopes readable with continuous sidecar sequence numbers', async () => {
    const table = new Table(), repo = new SidecarRepository(table), parent = session('parent')
    repo.bind(parent)
    const bridge = (revision: number) => ({ controllerSessionId: 'controller', bindingGeneration: 1,
      bridgeRevision: revision, sourceEventCount: 1, events: [{ eventId: `event-${revision}` }] })
    await appendSidecarEvent(parent, 'yuqi/team-projection-bridge', bridge(1))
    await appendSidecarEvent(parent, 'yuqi/team-projection-bridge', bridge(2))
    await appendSidecarEvent(parent, 'yuqi/team-projection-bridge', bridge(3))

    expect(readSidecarEvents(parent)?.map(event => [event.type, event.seq])).toEqual([
      ['yuqi/team-projection-bridge', 1], ['yuqi/team-projection-compacted', 2], ['yuqi/team-projection-bridge', 3],
    ])
    expect(new OwnedEventStore({ table, controllerSessionId: parent.id }).read().revision).toBe(3)
  })

  it('serializes revisions across aliases and repositories and publishes only committed events', async () => {
    const table = new Table(), repo = new SidecarRepository(table)
    const live = session(), alias = session()
    repo.bind(live)
    new SidecarRepository(table).bind(alias)
    const entered = deferred(), release = deferred()
    table.beforeWrite = async () => { entered.resolve(); await release.promise }
    let returned = false
    const first = appendSidecarEvent(live, 'yuqi/one', {}).then(event => { returned = true; return event })
    await entered.promise
    const second = appendSidecarEvent(alias, 'yuqi/two', {})
    expect(readSidecarEvents(live)).toEqual([])
    expect(repo.listSessionIds()).toEqual([])
    expect(returned).toBe(false)
    release.resolve()
    expect((await Promise.all([first, second])).map(event => event.seq)).toEqual([1, 2])
    expect(readSidecarEvents(alias)?.map(event => event.type)).toEqual(['yuqi/one', 'yuqi/two'])
  })

  it.each([false, true])('recovers from failed commit without exposing facts or consuming seq (existing=%s)', async existing => {
    const table = new Table(), repo = new SidecarRepository(table), live = session()
    repo.bind(live)
    if (existing) await appendSidecarEvent(live, 'yuqi/initial', {})
    const before = readSidecarEvents(live)
    table.beforeWrite = async () => { throw new Error('disk failure') }
    await expect(appendSidecarEvent(live, 'yuqi/fail', {})).rejects.toThrow('disk failure')
    expect(readSidecarEvents(live)).toEqual(before)
    table.beforeWrite = async () => {}
    expect((await appendSidecarEvent(live, 'yuqi/retry', {})).seq).toBe(existing ? 2 : 1)
    await expect(appendSidecarEvent(live, 'message', {})).rejects.toThrow('Only yuqi/')
    await expect(appendSidecarEvent(live, 'yuqi/invalid', undefined)).rejects.toThrow()
  })

  it('rejects legacy facts on either native read surface and conflicting bindings', () => {
    const repo = new SidecarRepository(new Table())
    for (const live of [session('legacy', [{ type: 'yuqi/team-event' }]),
      { id: 'snapshot', snapshotEvents: () => [{ type: 'yuqi/annotation' }] } as unknown as Session]) {
      expect(() => repo.bind(live)).toThrow('legacy')
      expect(hasSidecarSession(live)).toBe(false)
    }
    const live = session('native', [{ type: 'message', seq: 900 }])
    repo.bind(live)
    expect(() => new SidecarRepository(new Table()).bind(live)).toThrow('already bound')
  })

  it('rejects bare TeamEvents in existing owned records rather than hiding history', async () => {
    const table = new Table(), live = session()
    await new OwnedEventStore({ table, controllerSessionId: live.id }).commit({
      expectedRevision: 0, operationId: 'old', events: [{ type: 'team.created' }],
    })
    expect(() => new SidecarRepository(table).bind(live)).toThrow('envelope')
    expect(readSidecarEvents(live)).toBeUndefined()
  })

  it('keeps native seq independent and rejects native yuqi facts introduced after binding', async () => {
    const events: unknown[] = [{ type: 'message', seq: 900 }]
    const live = session('native', events), repo = new SidecarRepository(new Table())
    repo.bind(live)
    expect((await appendSidecarEvent(live, 'yuqi/annotation', {})).seq).toBe(1)
    events.push({ type: 'yuqi/legacy' })
    expect(() => repo.bind(live)).toThrow('legacy')
    await expect(appendSidecarEvent(live, 'yuqi/annotation', {})).rejects.toThrow('legacy')
    expect(readSidecarEvents(live)).toHaveLength(1)
  })

  it('drains an in-flight commit, rejects queued work on dispose, and preserves committed history', async () => {
    const table = new Table(), repo = new SidecarRepository(table), live = session()
    repo.bind(live)
    await appendSidecarEvent(live, 'yuqi/initial', {})
    const entered = deferred(), release = deferred()
    table.beforeWrite = async () => { entered.resolve(); await release.promise }
    const pending = appendSidecarEvent(live, 'yuqi/pending', {})
    await entered.promise
    const queued = appendSidecarEvent(live, 'yuqi/queued', {})
    const rejection = expect(queued).rejects.toThrow('disposed')
    expect(readSidecarEvents(live)?.map(event => event.seq)).toEqual([1])
    repo.dispose()
    repo.dispose()
    release.resolve()
    expect((await pending).seq).toBe(2)
    await rejection
    expect(() => hasSidecarSession(live)).toThrow('disposed')
    expect(() => readSidecarEvents(live)).toThrow('disposed')
    await expect(appendSidecarEvent(live, 'yuqi/late', {})).rejects.toThrow('disposed')
    new SidecarRepository(table).bind(live)
    expect(readSidecarEvents(live)?.map(event => event.type)).toEqual(['yuqi/initial', 'yuqi/pending'])
  })

  it('blocks native fallback for disposed empty bindings while leaving unbound objects distinct', async () => {
    const repo = new SidecarRepository(new Table()), live = session(), unbound = session('unbound')
    repo.bind(live)
    repo.dispose()
    expect(() => readSidecarEvents(live) ?? live.events).toThrow('disposed')
    const appendWithFallback = async () => {
      if (hasSidecarSession(live)) return appendSidecarEvent(live, 'yuqi/annotation', {})
      return Reflect.apply(live.append, live, ['yuqi/annotation', {}])
    }
    await expect(appendWithFallback()).rejects.toThrow('disposed')
    await expect(appendSidecarEvent(live, 'yuqi/annotation', {})).rejects.toThrow('disposed')
    expect(live.append).not.toHaveBeenCalled()
    expect(readSidecarEvents(unbound)).toBeUndefined()
    expect(hasSidecarSession(unbound)).toBe(false)
  })
})
