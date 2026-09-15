import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import {
  classifyHostCompatibilityFailure,
  inspectHostCompatibility,
  logHostCompatibilityFailure,
  logHostCompatibilityReport,
} from '../src/host/harness/host-compatibility-diagnostics.ts'

function fixture(options: { storage?: boolean } = {}) {
  const calls = { sessions: 0, storage: 0 }
  const info = vi.fn()
  const error = vi.fn()
  const sessions = { get: vi.fn(), list: vi.fn(), flush: vi.fn() }
  const persistence = {
    list: vi.fn(), inspect: vi.fn(), open: vi.fn(), load: vi.fn(), readFrom: vi.fn(),
    ensureMaterialized: vi.fn(), create: vi.fn(),
  }
  const storage = options.storage === false ? undefined : { open: vi.fn() }
  const ctx = {
    get(name: string) { calls.sessions += 1; return name === 'sessions' ? sessions : undefined },
    sessionPersistence: persistence,
    reflect: { get(name: string) { calls.storage += 1; return name === 'storageDomain' ? storage : undefined } },
    logger: { info, error },
  } as unknown as Context
  return { ctx, calls, info, error, sessions, persistence, storage }
}

describe('Host compatibility diagnostics', () => {
  it('reports public capabilities and selections without invoking them', () => {
    const host = fixture()
    const report = inspectHostCompatibility(host.ctx)

    expect(report).toMatchObject({
      event: 'host-compatibility-report', schemaVersion: 1,
      assessment: 'capabilities-only', unknownVersionCompatibility: 'not-asserted',
      session: { create: true, append: true, store: { get: true, list: true, flush: true } },
      persistence: { inspect: true, open: true, load: true, readFrom: true },
      storage: { domainOpen: true, journalPreference: 'sidecar-if-open-succeeds' },
    })
    expect(host.sessions.get).not.toHaveBeenCalled()
    expect(host.sessions.list).not.toHaveBeenCalled()
    expect(host.sessions.flush).not.toHaveBeenCalled()
    expect(host.persistence.list).not.toHaveBeenCalled()
    expect(host.persistence.inspect).not.toHaveBeenCalled()
    expect(host.persistence.open).not.toHaveBeenCalled()
    expect(host.storage?.open).not.toHaveBeenCalled()
  })

  it('emits one searchable structured startup record and selects native fallback when storage is absent', () => {
    const host = fixture({ storage: false })
    logHostCompatibilityReport(host.ctx)
    expect(host.info).toHaveBeenCalledTimes(1)
    const line = host.info.mock.calls[0]![0] as string
    expect(line.startsWith('[yuqi-team] ')).toBe(true)
    expect(JSON.parse(line.slice('[yuqi-team] '.length))).toMatchObject({
      event: 'host-compatibility-report',
      storage: { domainOpen: false, journalPreference: 'native-session-requires-envelope-check' },
    })
  })

  it('classifies only explicit compatibility identities, not suggestive ordinary messages', () => {
    expect(classifyHostCompatibilityFailure(Object.assign(new Error('opaque'), { name: 'SessionFormatUnsupportedError' })))
      .toBe('session-format-unsupported')
    expect(classifyHostCompatibilityFailure(new Error('provider says file not found and older than expected')))
      .toBe('operation-failed')
    const wrapped = new Error('outer', { cause: new YuqiOrchestratorError('HOST_SESSION_INCOMPATIBLE', 'private') })
    expect(classifyHostCompatibilityFailure(wrapped)).toBe('session-envelope-incompatible')
  })

  it('logs a stable stage/category without leaking messages, tokens, paths, codes, or stacks', () => {
    const host = fixture()
    const secret = 'token=secret C:\\Users\\private\\session.log'
    const cause = Object.assign(new Error(secret), { code: secret })
    logHostCompatibilityFailure(host.ctx, 'storage-domain-open', cause)
    expect(host.error).toHaveBeenCalledTimes(1)
    const line = host.error.mock.calls[0]![0] as string
    expect(line).not.toContain('secret')
    expect(line).not.toContain('Users')
    expect(JSON.parse(line.slice('[yuqi-team] '.length))).toEqual({
      event: 'host-compatibility-failure', schemaVersion: 1, stage: 'storage-domain-open',
      category: 'operation-failed',
    })
  })

  it('cannot be disrupted by throwing Error property getters', () => {
    const host = fixture()
    const cause = new Error('hidden')
    for (const key of ['name', 'message', 'code', 'cause']) {
      Object.defineProperty(cause, key, { get() { throw new Error(`getter ${key}`) } })
    }
    expect(() => logHostCompatibilityFailure(host.ctx, 'team-bootstrap', cause)).not.toThrow()
    expect(host.error).toHaveBeenCalledWith(expect.stringContaining('"category":"operation-failed"'))
  })

  it('keeps startup best-effort when logger delivery fails', () => {
    const host = fixture()
    host.info.mockImplementation(() => { throw new Error('logger offline') })
    expect(() => logHostCompatibilityReport(host.ctx)).not.toThrow()
  })
})
