import { describe, expect, it } from 'vitest'
import { parseTeamEvent, replayTeamEvents, YuqiDomainError } from '../src/index.ts'
import { completeTeamEvents } from './fixtures.ts'

describe('durable event parsing and replay', () => {
  it('is deterministic across repeated replays', () => {
    const inputs = structuredClone(completeTeamEvents())
    expect(replayTeamEvents(inputs)).toEqual(replayTeamEvents(inputs))
  })

  it('reports the event index for malformed durable data', () => {
    const malformed = [...completeTeamEvents().slice(0, 2), { schemaVersion: 1, type: 'unknown' }]
    try {
      replayTeamEvents(malformed)
      expect.unreachable('replay should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(YuqiDomainError)
      expect((error as YuqiDomainError).code).toBe('INVALID_EVENT')
      expect((error as YuqiDomainError).details.eventIndex).toBe(2)
    }
  })

  it.each([null, 'event', 42])('rejects non-object input %j', (input) => {
    expect(() => parseTeamEvent(input)).toThrowError(YuqiDomainError)
  })

  it('rejects unknown schema versions before interpreting the payload', () => {
    try {
      parseTeamEvent({ schemaVersion: 2, type: 'yuqi/team-created' }, 7)
      expect.unreachable('parse should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(YuqiDomainError)
      expect((error as YuqiDomainError).code).toBe('UNSUPPORTED_SCHEMA_VERSION')
      expect((error as YuqiDomainError).details.eventIndex).toBe(7)
    }
  })
})
