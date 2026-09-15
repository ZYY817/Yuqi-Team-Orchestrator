import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveTeamParentSession, resolveTeamParentWithFallback } from '../../src/client/team-parent-session.ts'

function fixture() {
  const rows: Record<string, { parentId?: string; origin?: string; projectionValues?: unknown }> = { controller: { parentId: 'parent', origin: 'subagent' }, parent: {} }
  let address: { parentSessionId: string; childSessionId: string; mode: string } | undefined
  const sessions = { list: { getSnapshot: () => ({ byId: rows }) },
    subagentAddress: (id: string) => id === 'controller' ? address : undefined,
    refreshSubagents: vi.fn(async () => { address = { parentSessionId: 'parent', childSessionId: 'controller', mode: 'continuable' } }),
  }
  return { sessions: sessions as unknown as ClientContext['sessions'], rows, refresh: sessions.refreshSubagents,
    address: (value: typeof address) => { address = value } }
}
describe('exact native parent resolution', () => {
  it('refreshes the native child address and returns the user parent, never the background controller', async () => {
    const { sessions, refresh } = fixture()
    expect(await resolveTeamParentSession(sessions, 'controller')).toBe('parent')
    expect(refresh).toHaveBeenCalledWith('parent')
  })
  it('rejects an address with the wrong parent', async () => {
    const { sessions, address } = fixture()
    address({ parentSessionId: 'other', childSessionId: 'controller', mode: 'continuable' })
    expect(await resolveTeamParentSession(sessions, 'controller')).toBeUndefined()
  })
  it('rejects missing/child parents and does not invent a root for hidden controller IDs', async () => {
    const { sessions, rows } = fixture()
    rows.parent = { origin: 'subagent', parentId: 'grandparent' }
    expect(await resolveTeamParentSession(sessions, 'controller')).toBeUndefined()
    expect(await resolveTeamParentSession(sessions, 'yuqi-team-missing')).toBeUndefined()
  })
  it('allows only an existing native legacy root to target itself', async () => {
    const { sessions } = fixture()
    expect(await resolveTeamParentSession(sessions, 'parent')).toBe('parent')
    expect(await resolveTeamParentSession(sessions, 'missing')).toBeUndefined()
  })
  it('uses one exact projected root only when a cold-restored controller is missing from the native index', async () => {
    const { sessions, rows } = fixture()
    delete rows.controller
    rows.parent = { projectionValues: { yuqiTeam: { controllerSessionId: 'yuqi-team-cold', team: { id: 'team-1' } } } }
    expect(await resolveTeamParentSession(sessions, 'yuqi-team-cold', 'team-1')).toBe('parent')
    expect(await resolveTeamParentSession(sessions, 'yuqi-team-cold', 'other-team')).toBeUndefined()
  })
  it('rejects ambiguous or non-root projected matches', async () => {
    const { sessions, rows } = fixture()
    delete rows.controller
    rows.parent = { projectionValues: { yuqiTeam: { controllerSessionId: 'yuqi-team-cold', team: { id: 'team-1' } } } }
    rows.other = { projectionValues: { yuqiTeam: { controllerSessionId: 'yuqi-team-cold', team: { id: 'team-1' } } } }
    expect(await resolveTeamParentSession(sessions, 'yuqi-team-cold', 'team-1')).toBeUndefined()
    delete rows.other
    rows.parent = { origin: 'subagent', parentId: 'grandparent', projectionValues: { yuqiTeam: { controllerSessionId: 'yuqi-team-cold', team: { id: 'team-1' } } } }
    expect(await resolveTeamParentSession(sessions, 'yuqi-team-cold', 'team-1')).toBeUndefined()
  })
  it('uses the Host fallback only after native async resolution returns undefined', async () => {
    const { sessions } = fixture()
    const fallback = vi.fn(async () => 'host-parent')
    expect(await resolveTeamParentWithFallback(sessions, 'yuqi-team-missing', 'team-1', fallback)).toBe('host-parent')
    expect(fallback).toHaveBeenCalledOnce()
  })
  it('does not call the Host fallback when native resolution returns the exact parent', async () => {
    const { sessions } = fixture()
    const fallback = vi.fn(async () => 'host-parent')
    expect(await resolveTeamParentWithFallback(sessions, 'controller', 'team-1', fallback)).toBe('parent')
    expect(fallback).not.toHaveBeenCalled()
  })
  it('propagates a rejected Host fallback for the continuation admission gate to fail closed', async () => {
    const { sessions } = fixture()
    const fallback = vi.fn(async () => { throw new Error('Host rejected binding') })
    await expect(resolveTeamParentWithFallback(sessions, 'yuqi-team-missing', 'team-1', fallback)).rejects.toThrow('Host rejected binding')
    expect(fallback).toHaveBeenCalledOnce()
  })
})
