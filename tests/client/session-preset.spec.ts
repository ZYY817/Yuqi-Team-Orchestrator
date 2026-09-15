import { describe, expect, it } from 'vitest'
import { sessionPreset } from '../../src/client/session-preset.ts'

describe('official preset source compatibility', () => {
  it('reads projection-only rows', () => {
    expect(sessionPreset({ projectionValues: { agentPreset: 'yuqi-team' } })).toBe('yuqi-team')
  })
  it('does not revive stale root metadata after projection clears the preset', () => {
    expect(sessionPreset({ agentPreset: 'yuqi-team', projectionValues: { agentPreset: null } })).toBeUndefined()
  })
  it('retains legacy compatibility without a preset projection', () => {
    expect(sessionPreset({ agentPreset: 'yuqi-team', projectionValues: {} })).toBe('yuqi-team')
    expect(sessionPreset(undefined)).toBeUndefined()
  })
})
