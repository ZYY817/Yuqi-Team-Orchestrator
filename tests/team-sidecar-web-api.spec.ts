import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it, vi } from 'vitest'
import { TEAM_SIDECAR_CHANNEL, TEAM_SIDECAR_MAX_RESPONSE_BYTES, teamSidecarSnapshotRequestSchema, type TeamSidecarReader } from '../src/domain/team-sidecar-web-contract.ts'
import { installTeamSidecarWebApi } from '../src/host/harness/team-sidecar-web-api.ts'
import { SidecarRepository, appendSidecarEvent } from '../src/host/storage/session-sidecar.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { readYuqiSessionEvents } from '../src/host/harness/session-journal.ts'

const event = { type: 'yuqi/annotation', seq: 1, time: 123, ignorable: true, data: { value: 'real plugin fact' } }
const page = { mode: 'sidecar' as const, sessions: [{ sessionId: 's1', source: 'sidecar' as const, events: [event] }] }
function fixture(reader: TeamSidecarReader = async () => page, recover?: (teamId: string, controllerSessionId: string, signal: AbortSignal) => Promise<void>, resolveParent?: (teamId: string, controllerSessionId: string, signal: AbortSignal) => Promise<string>) {
  let handler!: Parameters<HostConnectionHandle['rpc']['handle']>[1]
  let cleanup!: () => Promise<void>
  const dispose = vi.fn(async () => {})
  const handle = vi.fn((_channel: string, callback: typeof handler, _options: { authority: string }) => { handler = callback; return dispose })
  const get = vi.fn((_name: string) => ({ rpc: { handle } }))
  const warn = vi.fn()
  const ctx = { get, effect: (effect: () => typeof cleanup) => { cleanup = effect() }, logger: { warn } } as unknown as Context
  installTeamSidecarWebApi(ctx, reader, recover, resolveParent)
  return { handle, get, dispose, cleanup: () => cleanup(),
    warn, call: (payload: unknown = {}, signal = new AbortController().signal, endpoint = 'snapshot') => handler(endpoint, payload, signal) }
}

describe('plugin sidecar snapshot RPC', () => {
  it('accepts only an exact target recovery request', async () => {
    const recover = vi.fn(async () => {})
    const host = fixture(async () => page, recover)
    await expect(host.call({ teamId: 'team-1', controllerSessionId: 'yuqi-team-1' }, new AbortController().signal, 'recover-target')).resolves.toMatchObject({ ok: true })
    expect(recover).toHaveBeenCalledWith('team-1', 'yuqi-team-1', expect.any(AbortSignal))
    await expect(host.call({ teamId: 'team-1', controllerSessionId: 'wrong', extra: true }, new AbortController().signal, 'recover-target')).resolves.toMatchObject({ ok: false })
  })
  it('returns only the exact durable parent identity for a verified continuation target', async () => {
    const resolveParent = vi.fn(async () => 'user-parent')
    const host = fixture(async () => page, undefined, resolveParent)
    await expect(host.call({ teamId: 'team-1', controllerSessionId: 'yuqi-team-1' }, new AbortController().signal, 'resolve-parent'))
      .resolves.toEqual({ ok: true, value: { parentSessionId: 'user-parent' } })
    expect(resolveParent).toHaveBeenCalledWith('team-1', 'yuqi-team-1', expect.any(AbortSignal))
    await expect(host.call({ teamId: 'team-1', controllerSessionId: 'yuqi-team-1', extra: true }, new AbortController().signal, 'resolve-parent'))
      .resolves.toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })
  it('awaits target recovery and logs only a bounded failure category', async () => {
    let rejectRecovery!: (cause: unknown) => void
    const recovery = new Promise<void>((_resolve, reject) => { rejectRecovery = reject })
    const host = fixture(async () => page, async () => recovery)
    const pending = host.call({ teamId: 'team-1', controllerSessionId: 'yuqi-team-1' }, new AbortController().signal, 'recover-target')
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    rejectRecovery(new Error('private recovery path and credential=secret'))
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'internal', details: {} } })
    expect(host.warn).toHaveBeenCalledExactlyOnceWith('[yuqi-team] {"event":"host-compatibility-failure","schemaVersion":1,"stage":"sidecar-recover-target","category":"operation-failed"}')
    expect(JSON.stringify(host.warn.mock.calls)).not.toMatch(/private|credential|secret/)
  })
  it('reads real bound sidecar envelopes without returning native events or opening a domain', async () => {
    const records = new Map<string, OwnedEventRecord>()
    const table: OwnedEventTable = {
      get: key => records.get(key), entries: () => records.entries(),
      put: async (key, value) => { records.set(key, value) },
      update: async (key, transform) => { const value = transform(records.get(key)!); records.set(key, value); return value },
    }
    const repository = new SidecarRepository(table)
    const session = { id: 's1', events: [{ type: 'native/private', data: 'secret' }] } as unknown as Session
    repository.bind(session)
    const committed = await appendSidecarEvent(session, 'yuqi/annotation', { fact: true })
    const host = fixture(async () => ({ mode: 'sidecar', sessions: [{ sessionId: session.id, source: 'sidecar', events: readYuqiSessionEvents(session) }] }))
    expect(await host.call()).toEqual({ ok: true, value: { mode: 'sidecar', sessions: [{ sessionId: 's1', source: 'sidecar', events: [committed] }] } })
    repository.dispose()
    expect(await host.call()).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('[sidecar:read-failed]') } })
  })
  it('rejects oversized full event streams rather than truncating them', async () => {
    const host = fixture(async () => ({ mode: 'sidecar', sessions: [{ sessionId: 's1', source: 'sidecar', events: [{ ...event, data: 'x'.repeat(TEAM_SIDECAR_MAX_RESPONSE_BYTES) }] }] }))
    expect(await host.call()).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('[sidecar:response-too-large]') } })
  })
  it('accepts the exported response byte limit exactly and rejects one extra byte', async () => {
    const value = { mode: 'sidecar' as const, sessions: [{ sessionId: 's1', source: 'sidecar' as const, events: [{ ...event, data: '' }] }] }
    const overhead = Buffer.byteLength(JSON.stringify(value), 'utf8')
    value.sessions[0]!.events[0]!.data = 'x'.repeat(TEAM_SIDECAR_MAX_RESPONSE_BYTES - overhead)
    expect(Buffer.byteLength(JSON.stringify(value), 'utf8')).toBe(TEAM_SIDECAR_MAX_RESPONSE_BYTES)
    expect(await fixture(async () => value).call()).toMatchObject({ ok: true })
    value.sessions[0]!.events[0]!.data += 'x'
    expect(await fixture(async () => value).call()).toMatchObject({ ok: false, error: { code: 'internal', message: expect.stringContaining('[sidecar:response-too-large]') } })
  })
  it('registers an independent loopback channel with lifecycle cleanup', async () => {
    const host = fixture()
    expect(host.handle).toHaveBeenCalledWith(TEAM_SIDECAR_CHANNEL, expect.any(Function), { authority: 'loopback' })
    expect(host.get.mock.calls).toEqual([['connection']])
    await host.cleanup()
    expect(host.dispose).toHaveBeenCalledOnce()
  })
  it('fails explicitly when Connection is unavailable', () => {
    expect(() => installTeamSidecarWebApi({ get: () => undefined } as unknown as Context, async () => page)).toThrow('Host Connection RPC is required')
  })
  it('returns complete plugin envelopes and forwards bounded reader selection', async () => {
    const reader = vi.fn(async () => page)
    const host = fixture(reader)
    expect(await host.call({ sessionIds: ['s1'] })).toEqual({ ok: true, value: page })
    expect(reader).toHaveBeenCalledWith(['s1'], { limit: 200, signal: expect.any(AbortSignal) })
  })
  it('forwards opaque cursors and preserves empty advancing pages', async () => {
    const reader = vi.fn(async () => ({ mode: 'sidecar' as const, sessions: [], nextCursor: 'next' }))
    const host = fixture(reader)
    expect(await host.call({ cursor: 'previous' })).toEqual({ ok: true, value: { mode: 'sidecar', sessions: [], nextCursor: 'next' } })
    expect(reader).toHaveBeenCalledWith(undefined, expect.objectContaining({ cursor: 'previous', limit: 200 }))
  })
  it.each([null, [], { native: true }, { sessionIds: [''] }, { sessionIds: ['s1', 's1'] },
    { sessionIds: Array.from({ length: 201 }, (_, i) => String(i)) }, { cursor: '' }, { cursor: 1 }])('rejects invalid request %j before reading', async payload => {
    const reader = vi.fn(async () => page)
    expect(await fixture(reader).call(payload)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(reader).not.toHaveBeenCalled()
  })
  it('accepts exactly 200 requested IDs and an explicit empty selection', () => {
    expect(teamSidecarSnapshotRequestSchema.safeParse({ sessionIds: Array.from({ length: 200 }, (_, i) => String(i)) }).success).toBe(true)
    expect(teamSidecarSnapshotRequestSchema.safeParse({ sessionIds: [] }).success).toBe(true)
  })
  it('does not dispatch unknown endpoints', async () => {
    const reader = vi.fn(async () => page)
    expect(await fixture(reader).call({}, undefined, 'write')).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(reader).not.toHaveBeenCalled()
  })
  it.each([
    { ...event, type: 'tool/result' }, { ...event, ignorable: false }, { ...event, seq: 2 },
    { ...event, time: Infinity }, { ...event, secret: 'forbidden envelope field' },
    { ...event, data: undefined },
  ])('rejects invalid/native events without silently filtering %j', async invalid => {
    const host = fixture(async () => ({ mode: 'sidecar', sessions: [{ sessionId: 's1', source: 'sidecar', events: [invalid] }] }))
    expect(await host.call()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('rejects duplicate sessions, oversized pages and selection escapes', async () => {
    for (const sessions of [[...page.sessions, ...page.sessions], Array.from({ length: 201 }, (_, i) => ({ sessionId: String(i), source: 'sidecar' as const, events: [] }))]) {
      expect(await fixture(async () => ({ mode: 'sidecar', sessions })).call()).toMatchObject({ ok: false, error: { code: 'internal' } })
    }
    expect(await fixture().call({ sessionIds: ['other'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(await fixture().call({ sessionIds: [] })).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('rejects a nonadvancing cursor', async () => {
    expect(await fixture(async () => ({ mode: 'sidecar', sessions: [], nextCursor: 'same' })).call({ cursor: 'same' }))
      .toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('returns a sanitized error on read failure, never an empty success', async () => {
    const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
    const host = fixture(async () => { const error = new Error('credential=secret'); error.name = 'PrivateReaderError'; Object.assign(error, { code: 'PRIVATE_CODE' }); throw error })
    const result = await host.call({ sessionIds: ['s1'] })
    expect(result).toMatchObject({ ok: false, error: { code: 'internal', details: {} } })
    expect(JSON.stringify(result)).not.toContain('credential')
    expect(host.warn).toHaveBeenCalledWith('[yuqi-team] sidecar rpc failed phase=reader errorKind=unknown headerValidation=other reason=unclassified site=unknown stage=unknown requestedSessionCount=1 hasCursor=false')
    expect(JSON.stringify(host.warn.mock.calls)).not.toContain('credential')
    expect(stderr).toHaveBeenCalledWith(host.warn.mock.calls[0]![0])
    expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/credential|PrivateReaderError|PRIVATE_CODE/)
    } finally { stderr.mockRestore() }
  })
  it.each([
    [new SessionPersistenceCorruptionError('stored session "private-session" failed validation: Error: session header isSeeded must be a boolean', {}), 'SessionPersistenceCorruptionError', 'native-isSeeded'],
    [new Error('SessionPersistenceCorruptionError: stored session "private-session" failed validation: Error: session header isSeeded must be a boolean'), 'Error', 'serialized-isSeeded'],
    [new SessionPersistenceCorruptionError('stored session "private-session" failed validation: secret payload', {}), 'SessionPersistenceCorruptionError', 'other'],
  ])('writes only bounded failure categories to stderr (%s)', async (error, kind, header) => {
    const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = fixture(async () => { throw error })
      const result = await host.call()
      expect(result).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(stderr).toHaveBeenCalledExactlyOnceWith(`[yuqi-team] sidecar rpc failed phase=reader errorKind=${kind} headerValidation=${header} reason=unclassified site=unknown stage=unknown requestedSessionCount=0 hasCursor=false`)
      expect(JSON.stringify([result, stderr.mock.calls, host.warn.mock.calls])).not.toMatch(/private-session|secret payload/)
    } finally { stderr.mockRestore() }
  })
  it('categorizes known reader failures and stack sites without exposing private frames', async () => {
    const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const error = new Error('Invalid sidecar SessionEvent envelope')
      error.stack = 'Error: private-message\n    at readStoredEvents (C:/private-directory/private-file.js:8:9)\n    at readSidecarSnapshot (private-runtime.js:2:3)'
      const host = fixture(async () => { throw error })
      expect(await host.call()).toMatchObject({ ok: false, error: { code: 'internal' } })
      expect(stderr).toHaveBeenCalledExactlyOnceWith('[yuqi-team] sidecar rpc failed phase=reader errorKind=Error headerValidation=other reason=sidecar-envelope site=read-stored-facts stage=unknown requestedSessionCount=0 hasCursor=false')
      expect(JSON.stringify(stderr.mock.calls)).not.toMatch(/private|readStoredEvents|\.js/)
    } finally { stderr.mockRestore() }
  })
  it('allows explicit facility-absent legacy mode only without records or cursor', async () => {
    expect(await fixture(async () => ({ mode: 'legacy', sessions: [] })).call()).toEqual({ ok: true, value: { mode: 'legacy', sessions: [] } })
    expect(await fixture(async () => ({ ...page, mode: 'legacy' })).call()).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(await fixture(async () => ({ mode: 'legacy', sessions: [], nextCursor: 'next' })).call()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('allows mixed verified sources but never exports legacy event data', async () => {
    const mixed = { mode: 'sidecar' as const, sessions: [...page.sessions, { sessionId: 'old', source: 'legacy' as const, events: [] }] }
    expect(await fixture(async () => mixed).call()).toEqual({ ok: true, value: mixed })
    expect(await fixture(async () => ({ mode: 'sidecar', sessions: [{ sessionId: 'old', source: 'legacy', events: [event] }] })).call())
      .toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('honors cancellation before and after the read', async () => {
    const controller = new AbortController()
    const reader = vi.fn(async () => page)
    controller.abort()
    expect(await fixture(reader).call({}, controller.signal)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(reader).not.toHaveBeenCalled()
    const during = new AbortController()
    expect(await fixture(async () => { during.abort(); return page }).call({}, during.signal))
      .toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})
