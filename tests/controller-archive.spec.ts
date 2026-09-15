import { describe, expect, it } from 'vitest'
import { archiveObsoleteYuqiControllers, archiveTerminalYuqiControllers, isLegacyController, isYuqiController } from '../src/host/harness/controller-archive.ts'
import { completeTeamEvents } from './fixtures.ts'

describe('legacy Yuqi controller archive', () => {
  it('archives only proven terminal legacy controllers, never header-only, live, or active sessions', async () => {
    const archived: string[] = []
    const result = await archiveObsoleteYuqiControllers(
      { archiveSession: async id => { archived.push(id) } },
      {
        list: async () => [
          { id: 'yuqi-team-header-only', parentSession: 'parent', origin: 'subagent' as const },
          { id: 'yuqi-team-terminal', parentSession: 'parent', origin: 'subagent' as const },
          { id: 'yuqi-team-active', parentSession: 'parent', origin: 'subagent' as const },
          { id: 'yuqi-team-new', parentSession: 'parent' },
          { id: 'ordinary-child', parentSession: 'parent', origin: 'subagent' as const },
        ],
        inspect: async id => ({ events: id === 'yuqi-team-terminal'
          ? [{ type: 'yuqi/team-event', data: { events: completeTeamEvents() } }]
          : id === 'yuqi-team-active'
            ? [{ type: 'yuqi/team-event', data: { events: completeTeamEvents().slice(0, 8) } }]
            : [] }),
      },
      { get: id => id === 'yuqi-team-active' ? {} : undefined },
    )
    expect(result).toEqual(['yuqi-team-terminal'])
    expect(archived).toEqual(result)
  })

  it('requires the exact old subagent classification before archiving', () => {
    expect(isLegacyController({ id: 'yuqi-team-old', parentSession: 'parent', origin: 'subagent' })).toBe(true)
    expect(isLegacyController({ id: 'yuqi-team-new', parentSession: 'parent' })).toBe(false)
    expect(isLegacyController({ id: 'not-yuqi-team', parentSession: 'parent', origin: 'subagent' })).toBe(false)
  })

  it('does not archive when the live Session directory is unavailable', async () => {
    const archiveSession = async (): Promise<void> => { throw new Error('must not archive') }
    const result = await archiveObsoleteYuqiControllers(
      { archiveSession },
      {
        list: async () => [{ id: 'yuqi-team-terminal', parentSession: 'parent', origin: 'subagent' as const }],
        inspect: async () => ({ events: [{ type: 'yuqi/team-event', data: { events: completeTeamEvents() } }] }),
      },
      {},
    )
    expect(result).toEqual([])
  })

  it('organizes current terminal orchestrator sessions only with event and inactivity proof', async () => {
    const archived: string[] = []
    const result = await archiveTerminalYuqiControllers(
      { archiveSession: async id => { archived.push(id) } },
      {
        list: async () => [
          { id: 'yuqi-team-current', parentSession: 'entry' },
          { id: 'yuqi-team-live', parentSession: 'entry' },
          { id: 'yuqi-team-header-only', parentSession: 'entry' },
        ],
        inspect: async id => ({ events: id === 'yuqi-team-header-only' ? [] : [{ type: 'yuqi/team-event', data: { events: completeTeamEvents() } }] }),
      },
      { get: id => id === 'yuqi-team-live' ? {} : undefined },
    )
    expect(result).toEqual(['yuqi-team-current'])
    expect(archived).toEqual(['yuqi-team-current'])
    expect(isYuqiController({ id: 'yuqi-team-current', parentSession: 'entry' })).toBe(true)
    expect(isYuqiController({ id: 'ordinary', parentSession: 'entry' })).toBe(false)
  })
})
