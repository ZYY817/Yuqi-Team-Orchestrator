import { describe, expect, it } from 'vitest'
import { HarnessEvidenceCollector, HARNESS_EVIDENCE_CAPABILITIES } from '../src/index.ts'

const identity = {
  teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-1', requirementIds: ['build', 'test'],
}

describe('Harness rc.5 evidence collector', () => {
  it('discovers every structured evidence kind as unavailable', () => {
    const collector = new HarnessEvidenceCollector()
    expect(collector.capabilities()).toBe(HARNESS_EVIDENCE_CAPABILITIES)
    expect(collector.capabilities()).toEqual([
      { kind: 'build', available: false, reason: expect.stringContaining('no host-owned collector') },
      { kind: 'test', available: false, reason: expect.stringContaining('no host-owned collector') },
      { kind: 'interface', available: false, reason: expect.stringContaining('no host-owned collector') },
      { kind: 'screenshot', available: false, reason: expect.stringContaining('no host-owned collector') },
    ])
  })

  it('never fabricates evidence when rc.5 has no collector', async () => {
    await expect(new HarnessEvidenceCollector().collect(identity)).resolves.toEqual({
      kind: 'unavailable', reason: expect.stringContaining('current Harness public API'),
    })
  })

  it('fails closed for cancellation and invalid collection boundaries', async () => {
    const collector = new HarnessEvidenceCollector()
    const controller = new AbortController()
    controller.abort()
    await expect(collector.collect({ ...identity, signal: controller.signal })).resolves.toMatchObject({ kind: 'aborted' })
    await expect(collector.collect({ ...identity, teamId: ' ' })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_COLLECTION_IDENTITY' })
    await expect(collector.collect({ ...identity, requirementIds: [] })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_COLLECTION_REQUIREMENTS' })
    await expect(collector.collect({ ...identity, requirementIds: ['build', 'build'] })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_COLLECTION_REQUIREMENTS' })
    await expect(collector.collect({ ...identity, requirementIds: [' '] })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_COLLECTION_REQUIREMENTS' })
  })
})
