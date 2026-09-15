import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run directly with Node, never through tests/setup.ts: this checks the actual
// Host artifact without the unit suite's simulated capability declaration.
const sessionUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2])).href
  : new URL('../../../deepseek-harness/packages/core/session/lib/index.js', import.meta.url).href
const { Session } = await import(sessionUrl)
const { assertYuqiSessionEventCompatibility, appendYuqiSessionEvent, TEAM_SESSION_EVENT } = await import('../../lib/index.js')
const id = 'yuqi-detached-envelope-probe'
const session = Session.create(id)
assertYuqiSessionEventCompatibility(session)
const event = appendYuqiSessionEvent(session, TEAM_SESSION_EVENT, { probe: 'cold-replay' })
assert.equal(event.ignorable, true, 'Host append must write the marker, not merely declare support')
assert.equal(session.events[0].ignorable, true, 'the marker must belong to the stored event')
const coldEvents = JSON.parse(JSON.stringify(session.events))
const restored = Session.create(id, coldEvents, session.header)
assert.deepEqual(restored.events[0], event, 'cold replay must retain the complete unknown downstream event')
assert.equal(session.events.length, 1, 'the probe must remain detached and must not create a real Team')
console.log(JSON.stringify({ status: 'passed', sessionModule: sessionUrl, checks: ['native-capability', 'append-marker', 'cold-replay'] }))
