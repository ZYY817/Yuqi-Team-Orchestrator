// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { requestTeamSettingsOpen, subscribeTeamSettingsOpen } from '../../src/client/team-settings-events.ts'

describe('Team settings events without a browser Host', () => {
  it('keeps request and subscription APIs safe during server-side registration', () => {
    const listener = vi.fn()
    expect(() => requestTeamSettingsOpen()).not.toThrow()
    const unsubscribe = subscribeTeamSettingsOpen(listener)
    expect(listener).not.toHaveBeenCalled()
    expect(() => unsubscribe()).not.toThrow()
  })
})
