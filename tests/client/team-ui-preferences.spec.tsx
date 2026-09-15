// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setChildSessionArchived,
  restoreTeamDock,
  setTeamArchived,
  setTeamDockDismissed,
  setTeamDockHidden,
  useTeamUiPreference,
} from '../../src/client/team-ui-preferences.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('Team UI preferences', () => {
  it('restores the card without restoring children and resets the override only for a new child archive', async () => {
    const hook = renderHook(() => useTeamUiPreference('restore-card'))
    setChildSessionArchived('restore-card', 'child-1', true)
    setTeamDockDismissed('restore-card', true)
    restoreTeamDock('restore-card')
    await waitFor(() => expect(hook.result.current).toMatchObject({
      dockHidden: false, dockDismissed: false, dockRestored: true, archivedChildIds: ['child-1'],
    }))
    setChildSessionArchived('restore-card', 'child-1', true)
    await waitFor(() => expect(hook.result.current.dockRestored).toBe(true))
    setChildSessionArchived('restore-card', 'child-2', true)
    await waitFor(() => expect(hook.result.current.dockRestored).toBe(false))
    setTeamArchived('restore-card', true)
    setTeamDockHidden('restore-card', true)
    setTeamArchived('restore-card', false)
    await waitFor(() => expect(hook.result.current).toMatchObject({
      teamArchived: false, dockHidden: false, dockDismissed: false, dockRestored: true,
      archivedChildIds: ['child-1', 'child-2'],
    }))
  })

  it('persists hide/archive state, de-duplicates children, and restores each choice', async () => {
    const hook = renderHook(() => useTeamUiPreference('team-preferences'))
    expect(hook.result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })

    setTeamDockHidden('team-preferences', true)
    setChildSessionArchived('team-preferences', 'child-1', true)
    setChildSessionArchived('team-preferences', 'child-1', true)
    await waitFor(() => expect(hook.result.current).toMatchObject({ dockHidden: true, archivedChildIds: ['child-1'] }))

    setTeamDockHidden('team-preferences', false)
    setChildSessionArchived('team-preferences', 'child-1', false)
    await waitFor(() => expect(hook.result.current).toMatchObject({ dockHidden: false, archivedChildIds: [] }))
  })

  it('ignores malformed storage and invalid Team rows without breaking the UI', () => {
    localStorage.setItem('yuqi-team-orchestrator.ui.v1', '{broken')
    const malformed = renderHook(() => useTeamUiPreference('bad-team'))
    expect(malformed.result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })
    malformed.unmount()

    localStorage.setItem('yuqi-team-orchestrator.ui.v1', JSON.stringify({
      bad: { dockHidden: 'yes', archivedChildIds: [1], updatedAt: 'now' },
      good: { dockHidden: true, archivedChildIds: ['child', 2], updatedAt: 1 },
    }))
    window.dispatchEvent(new StorageEvent('storage'))
    const valid = renderHook(() => useTeamUiPreference('good'))
    expect(valid.result.current).toMatchObject({ dockHidden: true, archivedChildIds: ['child'] })
  })

  it.each([null, [], 'text'])('rejects an invalid preference root without leaking state: %j', invalidRoot => {
    localStorage.setItem('yuqi-team-orchestrator.ui.v1', JSON.stringify(invalidRoot))
    window.dispatchEvent(new StorageEvent('storage'))
    const hook = renderHook(() => useTeamUiPreference('missing'))
    expect(hook.result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })
  })

  it('skips null, array, and incomplete Team rows while retaining a valid sibling', () => {
    localStorage.setItem('yuqi-team-orchestrator.ui.v1', JSON.stringify({
      nullRow: null,
      arrayRow: [],
      missingArchive: { dockHidden: true, updatedAt: 1 },
      missingTimestamp: { dockHidden: true, archivedChildIds: [] },
      valid: { dockHidden: false, archivedChildIds: [], updatedAt: 2 },
    }))
    window.dispatchEvent(new StorageEvent('storage'))
    expect(renderHook(() => useTeamUiPreference('nullRow')).result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })
    expect(renderHook(() => useTeamUiPreference('arrayRow')).result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })
    expect(renderHook(() => useTeamUiPreference('valid')).result.current).toMatchObject({ dockHidden: false, archivedChildIds: [] })
  })

  it('bounds persisted Team UI history and supports removing an absent child id', () => {
    for (let index = 0; index < 105; index += 1) setTeamDockHidden(`bounded-${index}`, true)
    setChildSessionArchived('bounded-104', 'absent', false)
    const stored = JSON.parse(localStorage.getItem('yuqi-team-orchestrator.ui.v1') ?? '{}') as Record<string, unknown>
    expect(Object.keys(stored)).toHaveLength(100)
    expect(stored['bounded-104']).toBeDefined()
  })

  it('returns the stable empty preference when no Team is selected', () => {
    const hook = renderHook(() => useTeamUiPreference(undefined))
    expect(hook.result.current).toEqual({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [] })
  })

  it('falls back to memory when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const hook = renderHook(() => useTeamUiPreference('memory-team'))
    setTeamDockHidden('memory-team', true)
    await waitFor(() => expect(hook.result.current.dockHidden).toBe(true))
  })

  it('dismisses a terminal Team card independently from temporary minimization', async () => {
    const hook = renderHook(() => useTeamUiPreference('dismissed-team'))
    setTeamDockHidden('dismissed-team', true)
    setTeamDockDismissed('dismissed-team', true)
    await waitFor(() => expect(hook.result.current).toMatchObject({ dockHidden: false, dockDismissed: true }))
    setTeamDockDismissed('dismissed-team', false)
    await waitFor(() => expect(hook.result.current.dockDismissed).toBe(false))
  })

  it('archives and restores a whole Team while clearing transient dock state', async () => {
    const hook = renderHook(() => useTeamUiPreference('archived-team'))
    setTeamDockHidden('archived-team', true)
    setTeamDockDismissed('archived-team', true)
    setTeamArchived('archived-team', true)
    await waitFor(() => expect(hook.result.current).toMatchObject({
      dockHidden: false,
      dockDismissed: false,
      teamArchived: true,
      archivedChildIds: [],
    }))
    setTeamArchived('archived-team', false)
    await waitFor(() => expect(hook.result.current.teamArchived).toBe(false))
  })
})
