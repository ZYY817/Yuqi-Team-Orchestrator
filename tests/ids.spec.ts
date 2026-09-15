import { describe, expect, it } from 'vitest'
import { AttemptId, TaskId, TeamEventId, TeamId, VerificationId } from '../src/index.ts'

describe('opaque ids', () => {
  it('preserves the serialized string without runtime decoration', () => {
    expect(TeamId('team')).toBe('team')
    expect(TaskId('task')).toBe('task')
    expect(AttemptId('attempt')).toBe('attempt')
    expect(VerificationId('verification')).toBe('verification')
    expect(TeamEventId('event')).toBe('event')
  })
})
