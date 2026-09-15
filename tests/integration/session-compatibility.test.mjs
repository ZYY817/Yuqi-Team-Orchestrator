import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session } from '@deepseek-ai/dsh-session'
import {
  appendCompatibleYuqiSessionEvent,
  assertYuqiSessionEventCompatibility,
} from '../../src/host/harness/session-compatibility.ts'

// Independent unit model; no Host constructors, prototypes or flags are patched.
function runtime({ writesMarker = true, losesReplay = false, marksSeed = false } = {}) {
  return class DetachedSession {
    static creates = 0
    static create(id, seed = [], header = { id }) {
      this.creates++
      const instance = new this()
      instance.id = id
      instance.header = header
      instance.events = structuredClone(seed)
      if (losesReplay && seed.length) delete instance.events[0].ignorable
      if (marksSeed && seed.length) instance.append('session/end-seed', {})
      return instance
    }
    append(type, data, options) {
      const event = Object.freeze({ type, data, seq: this.events.length, time: 1,
        ...(writesMarker && options?.ignorable ? { ignorable: true } : {}) })
      this.events.push(event)
      return event
    }
  }
}

test('native behavior is sufficient without inventing a capability flag; target is untouched by probing', () => {
  const Runtime = runtime()
  const target = Runtime.create('target')
  const before = JSON.stringify(target)
  assertYuqiSessionEventCompatibility(target)
  assert.equal(JSON.stringify(target), before)
  assert.equal(Runtime.creates, 3)
  const event = appendCompatibleYuqiSessionEvent(target, 'yuqi/team-event', { task: 'a' })
  assert.equal(event.ignorable, true)
  assert.equal(target.events.length, 1)
  assert.equal(Runtime.creates, 3, 'successful probe is reused for the same implementation')
})

test('snapshot-only public API is accepted only when native marker and replay are preserved', () => {
  class SnapshotSession {
    #entries = []
    static create(id, seed = [], header = { id }) {
      const s = new this()
      s.id = id
      s.header = header
      s.#entries = structuredClone(seed)
      return s
    }
    snapshotEvents() { return this.#entries }
    append(type, data, options) {
      const event = Object.freeze({ type, data, seq: this.#entries.length, time: 1,
        ...(options?.ignorable ? { ignorable: true } : {}) })
      this.#entries = [...this.#entries, event]
      return event
    }
  }
  const s = SnapshotSession.create('snapshot-only')
  assertYuqiSessionEventCompatibility(s)
  assert.deepEqual(s.snapshotEvents(), [])
  appendCompatibleYuqiSessionEvent(s, 'yuqi/team-event', { task: 'a' })
  assert.equal(s.snapshotEvents()[0].ignorable, true)
  assert.equal('events' in s, false)
})

test('Host lifecycle markers after the restored seed do not invalidate the preserved event', () => {
  const target = runtime({ marksSeed: true }).create('target')
  assertYuqiSessionEventCompatibility(target)
  assert.deepEqual(target.events, [])
})

for (const [label, options] of [
  ['append silently discards the marker', { writesMarker: false }],
  ['JSON replay loses the marker', { losesReplay: true }],
]) {
  test(`rejects before target writes when ${label}`, () => {
    const target = runtime(options).create('target')
    assert.throws(() => appendCompatibleYuqiSessionEvent(target, 'yuqi/team-event', {}), { code: 'HOST_SESSION_INCOMPATIBLE' })
    assert.deepEqual(target.events, [])
  })
}

test('a changed append implementation invalidates a successful probe', () => {
  const Runtime = runtime()
  const target = Runtime.create('target')
  assertYuqiSessionEventCompatibility(target)
  Runtime.prototype.append = function () { throw new Error('changed implementation') }
  assert.throws(() => appendCompatibleYuqiSessionEvent(target, 'yuqi/team-event', {}), { code: 'HOST_SESSION_INCOMPATIBLE' })
  assert.deepEqual(target.events, [])
})

test('an instance append failure remains an append failure after native capability admission', () => {
  const target = runtime().create('target')
  let calls = 0
  const failure = new Error('append failed')
  target.append = () => { calls++; throw failure }
  assert.throws(() => appendCompatibleYuqiSessionEvent(target, 'yuqi/team-event', {}), error => error === failure)
  assert.equal(calls, 1)
  assert.deepEqual(target.events, [])
})

test('a Host without the detached create API fails with the stable compatibility error', () => {
  assert.throws(() => assertYuqiSessionEventCompatibility({ constructor: {}, append() {} }), { code: 'HOST_SESSION_INCOMPATIBLE' })
})

test('installed rc.2 is rejected without touching its real Session or modifying its runtime', () => {
  const target = Session.create('yuqi-rc2-compatibility-test')
  const before = JSON.stringify(target.events)
  assert.throws(() => appendCompatibleYuqiSessionEvent(target, 'yuqi/team-event', {}), { code: 'HOST_SESSION_INCOMPATIBLE' })
  assert.equal(JSON.stringify(target.events), before)
})
