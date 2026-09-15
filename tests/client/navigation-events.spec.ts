// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestTeamSettingsOpen,
  subscribeTeamSettingsOpen,
} from '../../src/client/team-settings-events.ts'
import {
  consumeTeamPanelOpen,
  isTeamPanelOpenRequest,
  OPEN_TEAM_PANEL_EVENT,
  requestTeamPanelOpen,
} from '../../src/client/team-panel-events.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('management navigation events', () => {
  it('delivers the teams page selection through the settings event', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTeamSettingsOpen(listener)
    requestTeamSettingsOpen('teams')
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith('teams')
    unsubscribe()
  })

  it('retains one pending Team panel request and consumes only the exact Team once', () => {
    const listener = vi.fn()
    window.addEventListener(OPEN_TEAM_PANEL_EVENT, listener)
    requestTeamPanelOpen('team-1')

    expect(listener).toHaveBeenCalledOnce()
    expect(isTeamPanelOpenRequest(listener.mock.calls[0]![0] as Event, 'team-1')).toBe(true)
    expect(isTeamPanelOpenRequest(listener.mock.calls[0]![0] as Event, 'team-2')).toBe(false)
    expect(consumeTeamPanelOpen('team-2')).toBe(false)
    expect(consumeTeamPanelOpen('team-1')).toBe(true)
    expect(consumeTeamPanelOpen('team-1')).toBe(false)
    window.removeEventListener(OPEN_TEAM_PANEL_EVENT, listener)
  })
})
