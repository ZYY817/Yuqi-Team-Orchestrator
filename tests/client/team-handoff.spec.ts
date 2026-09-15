// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canHandoff, getHandoffAttempt, submitTeamHandoff, validHandoffContext,
  type TeamHandoffResult, type TeamHandoffSource,
} from '../../src/client/team-handoff.ts'

let sequence = 0
const source = (): TeamHandoffSource => ({ sessionId: `handoff-unit-${++sequence}`, cwd: 'F:\\workspace\\new', isTeam: false, isIdle: true })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear() })

describe('Team handoff boundary', () => {
  it('requires an idle ordinary root session and explicit goal', () => {
    const row = source()
    expect(canHandoff(row)).toBe(true)
    for (const change of [{ isIdle: false }, { isTeam: true }, { parentSessionId: 'parent' }, { agentPreset: 'yuqi-team' }, { cwd: '' }]) {
      expect(canHandoff({ ...row, ...change })).toBe(false)
    }
    expect(validHandoffContext({ goal: '  ', summary: 'not a goal' })).toBe(false)
    expect(validHandoffContext({ goal: 'g'.repeat(4001), summary: '' })).toBe(false)
    expect(validHandoffContext({ goal: 'goal', summary: 'x'.repeat(12001) })).toBe(false)
    expect(validHandoffContext({ goal: 'goal', summary: '' })).toBe(true)
  })

  it('sends explicit context once, retaining identity during pending and unknown outcomes', async () => {
    const row = source()
    let finish!: (result: TeamHandoffResult) => void
    const port = vi.fn(() => new Promise<TeamHandoffResult>(resolve => { finish = resolve }))
    const pending = submitTeamHandoff(row, { goal: '  write a.txt ', summary: '' }, port)
    const attempt = getHandoffAttempt(row.sessionId)!
    expect(attempt.kind).toBe('pending')
    expect(attempt.targetSessionId).toMatch(/^[a-f\d-]{36}$/i)
    await submitTeamHandoff(row, { goal: 'different', summary: 'do not send' }, port)
    expect(port).toHaveBeenCalledTimes(1)
    expect(port.mock.calls[0]).toEqual([{ sourceSessionId: row.sessionId, targetSessionId: attempt.targetSessionId, context: { goal: 'write a.txt', summary: '' } }])
    finish({ kind: 'unknown' })
    await pending
    await submitTeamHandoff(row, { goal: 'again', summary: '' }, port)
    expect(getHandoffAttempt(row.sessionId)).toEqual({ targetSessionId: attempt.targetSessionId, kind: 'unknown' })
    expect(port).toHaveBeenCalledTimes(1)
  })

  it.each(['opened', 'created', 'rejected'] as const)('retains %s without another create', async kind => {
    const row = source()
    const port = vi.fn(async () => ({ kind, message: 'Host result' }))
    const first = await submitTeamHandoff(row, { goal: 'goal', summary: 'user summary' }, port)
    const second = await submitTeamHandoff(row, { goal: 'retry', summary: '' }, port)
    expect(first?.kind).toBe(kind)
    expect(second).toEqual(first)
    expect(port).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(`yuqi-team-handoff.v1:${row.sessionId}`)).not.toContain('user summary')
  })

  it('treats thrown errors and a mismatched target as unknown', async () => {
    const failed = await submitTeamHandoff(source(), { goal: 'goal', summary: '' }, async () => { throw new Error('offline') })
    expect(failed?.kind).toBe('unknown')
    const mismatch = await submitTeamHandoff(source(), { goal: 'goal', summary: '' }, async () => ({ kind: 'opened', sessionId: 'wrong-target' }))
    expect(mismatch?.kind).toBe('unknown')
    expect(mismatch?.targetSessionId).not.toBe('wrong-target')
  })

  it('allows editing after an explicit safe rejection while retaining the target', async () => {
    const row = source()
    const port = vi.fn(async () => ({ kind: 'rejected' as const, retryable: true }))
    const first = await submitTeamHandoff(row, { goal: 'first', summary: '' }, port)
    expect(first?.retryable).toBe(true)
    const second = await submitTeamHandoff(row, { goal: 'edited', summary: 'new summary' }, port)
    expect(second?.targetSessionId).toBe(first?.targetSessionId)
    expect(port).toHaveBeenCalledTimes(2)
    expect(port.mock.calls[1]).toEqual([{ sourceSessionId: row.sessionId, targetSessionId: first!.targetSessionId, context: { goal: 'edited', summary: 'new summary' } }])
  })

  it('ignores retryable on an unknown result', async () => {
    const row = source()
    const port = vi.fn(async () => ({ kind: 'unknown' as const, retryable: true }))
    const result = await submitTeamHandoff(row, { goal: 'goal', summary: '' }, port)
    expect(result?.retryable).toBeUndefined()
    await submitTeamHandoff(row, { goal: 'retry', summary: '' }, port)
    expect(port).toHaveBeenCalledTimes(1)
  })

  it('surfaces timeout without retry and reconciles a late result to the same target', async () => {
    vi.useFakeTimers()
    const row = source()
    let finish!: (result: TeamHandoffResult) => void
    const port = vi.fn(() => new Promise<TeamHandoffResult>(resolve => { finish = resolve }))
    const pending = submitTeamHandoff(row, { goal: 'goal', summary: '' }, port)
    const target = getHandoffAttempt(row.sessionId)!.targetSessionId
    await vi.advanceTimersByTimeAsync(15_000)
    expect(getHandoffAttempt(row.sessionId)?.kind).toBe('unknown')
    await submitTeamHandoff(row, { goal: 'goal', summary: '' }, port)
    expect(port).toHaveBeenCalledTimes(1)
    finish({ kind: 'created', sessionId: target })
    await pending
    expect(getHandoffAttempt(row.sessionId)).toEqual({ kind: 'created', targetSessionId: target })
  })

  it('restores an unresolved persisted identity without invoking the adapter', async () => {
    const row = source()
    sessionStorage.setItem(`yuqi-team-handoff.v1:${row.sessionId}`, JSON.stringify({ targetSessionId: 'retained-id', kind: 'pending' }))
    const port = vi.fn(async () => ({ kind: 'opened' as const }))
    expect(await submitTeamHandoff(row, { goal: 'goal', summary: '' }, port)).toEqual({ kind: 'unknown', targetSessionId: 'retained-id' })
    expect(port).not.toHaveBeenCalled()
  })

  it('does not call Host when identity cannot be saved or eligibility is lost', async () => {
    const port = vi.fn(async () => ({ kind: 'opened' as const }))
    await submitTeamHandoff({ ...source(), isIdle: false }, { goal: 'goal', summary: '' }, port)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    expect((await submitTeamHandoff(source(), { goal: 'goal', summary: '' }, port))?.kind).toBe('rejected')
    expect(port).not.toHaveBeenCalled()
  })
})
