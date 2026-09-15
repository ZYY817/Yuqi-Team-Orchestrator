import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPreflightSession, materializePreflightSession } from '../../scripts/check-host-compatibility.mjs'

test('preflight reads current handles and closes exactly once', async () => {
  let closed = 0
  const host = { stat: async () => ({}), open: async (_id, access) => {
    assert.equal(access, 'read')
    return { header: { id: 's' }, inheritedEventCount: 1,
      read: async () => ({ events: [{ type: 'test' }] }), close: async () => { closed++ } }
  } }
  assert.deepEqual(await readPreflightSession(host, 's'), {
    meta: { id: 's' }, events: [{ type: 'test' }], inheritedEventCount: 1,
  })
  assert.equal(closed, 1)
})

test('missing current session does not open a handle', async () => {
  assert.equal(await readPreflightSession({ stat: async () => undefined,
    open: () => { throw new Error('must not open') } }, 's'), undefined)
})

test('legacy public reads remain supported', async () => {
  const host = { readRaw: async () => ({ meta: { id: 's' } }),
    readFrom: async () => ({ events: [] }) }
  assert.deepEqual(await readPreflightSession(host, 's'), { meta: { id: 's' }, events: [], inheritedEventCount: 0 })
})

test('current read failure closes and does not fall through to legacy', async () => {
  let closed = 0
  const error = new Error('read failed')
  await assert.rejects(readPreflightSession({ stat: async () => ({}),
    open: async () => ({ header: { id: 's' }, read: async () => { throw error },
      close: async () => { closed++ } }),
    readRaw: () => { throw new Error('must not fallback') } }, 's'), error)
  assert.equal(closed, 1)
})

test('malformed reads and identity mismatch fail closed', async () => {
  for (const [header, result] of [[{ id: 'other' }, { events: [] }], [{ id: 's' }, {}]]) {
    let closed = 0
    await assert.rejects(readPreflightSession({ stat: async () => ({}), open: async () => ({
      header, read: async () => result, close: async () => { closed++ },
    }) }, 's'))
    assert.equal(closed, 1)
  }
})

test('materialization selects one known capability without retrying writes', async () => {
  const session = { id: 's', header: { id: 's' } }
  let closed = 0
  await materializePreflightSession({ stat: async () => undefined, open: async () => { throw new Error('absent') }, create: async header => {
    assert.equal(header, session.header)
    return { close: async () => { closed++ } }
  } }, session)
  assert.equal(closed, 1)
  await assert.rejects(materializePreflightSession({
    ensureMaterialized: async () => { throw new Error('denied') },
    create: () => { throw new Error('must not retry') },
  }, session), /denied/)
})

test('existing materialized handle session is reused only with matching metadata', async () => {
  const session = { id: 's', header: { id: 's' } }
  const host = { stat: async () => ({}), open: async () => ({ header: session.header,
    read: async () => ({ events: [] }), close: async () => {} }),
    create: () => { throw new Error('must not recreate') } }
  await materializePreflightSession(host, session)
  await assert.rejects(materializePreflightSession(host, { id: 's', header: { id: 's', cwd: 'different' } }))
})
