import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { harnessSessionAccess, requireHarnessSessionStore } from '../src/host/harness/session-store-adapter.ts'

describe('Harness live SessionStore compatibility', () => {
  it('binds supported methods to the Host service and accepts sync or async flush results', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('session-compatible'))
    const service = {
      marker: session,
      get(this: { marker: Session }, id: SessionId) { return id === this.marker.id ? this.marker : undefined },
      list(this: { marker: Session }) { return [this.marker] },
      flush(this: { marker: Session }, candidate: Session) { return candidate === this.marker },
    }
    ctx.provide('sessions', service as never)

    const access = harnessSessionAccess(ctx)
    expect(access.get?.(session.id)).toBe(session)
    expect(access.get?.(SessionId('missing'))).toBeUndefined()
    expect(access.list?.()).toEqual([session])
    await expect(access.flush?.(session)).resolves.toBe(true)
  })

  it.each([
    ['get', { get: () => ({ id: 'malformed' }) }],
    ['list', { list: () => [{ id: 'malformed' }] }],
    ['flush', { flush: () => 'yes' }],
  ] as const)('rejects a malformed %s response at the adapter', async (capability, service) => {
    const ctx = new Context()
    ctx.provide('sessions', service as never)
    const access = harnessSessionAccess(ctx)
    const call: () => unknown = capability === 'get'
      ? () => access.get?.(SessionId('malformed'))
      : capability === 'list'
        ? () => access.list?.()
        : () => access.flush?.(Session.create(SessionId('malformed')))
    await expect((async () => call())()).rejects.toThrow(`Harness SessionStore.${capability} returned an invalid response`)
  })

  it('exposes no invented methods and requires only the flush capability', () => {
    const ctx = new Context()
    ctx.provide('sessions', {} as never)
    expect(harnessSessionAccess(ctx)).toEqual({})
    expect(() => requireHarnessSessionStore(ctx)).toThrow('Harness SessionStore.flush is unavailable')

    const flush = vi.fn(async () => true)
    const flushOnly = new Context()
    flushOnly.provide('sessions', { flush } as never)
    expect(requireHarnessSessionStore(flushOnly).flush).toBeTypeOf('function')
  })
})
