import { describe, expect, it } from 'vitest'
import { EvidenceVerdictCoordinator, evaluateEvidenceVerdict, MAX_AUTOMATIC_REWORK_ROUNDS } from '../src/application/evidence-verdict.ts'
import { assessEvidenceRecord, parseStructuredEvidence } from '../src/domain/evidence-verdict.ts'

const requirements = [
  { checkId: 'build', kind: 'build' as const },
  { checkId: 'tests', kind: 'test' as const },
  { checkId: 'api', kind: 'interface' as const, expectedStatusCodes: [200] },
  { checkId: 'screen', kind: 'screenshot' as const },
]

const evidence = [
  { checkId: 'build', capturedAt: '2026-08-15T00:00:00Z', kind: 'build' as const, producer: 'build-runner' as const, command: 'pnpm run build', exitCode: 0, artifactDigest: 'sha256-build' },
  { checkId: 'tests', capturedAt: '2026-08-15T00:00:01Z', kind: 'test' as const, producer: 'test-runner' as const, command: 'pnpm test', exitCode: 0, total: 4, passed: 4, failed: 0, skipped: 0, reportDigest: 'sha256-tests' },
  { checkId: 'api', capturedAt: '2026-08-15T00:00:02Z', kind: 'interface' as const, producer: 'http-probe' as const, method: 'GET', path: '/health', statusCode: 200, responseDigest: 'sha256-response', contractDigest: 'sha256-contract' },
  { checkId: 'screen', capturedAt: '2026-08-15T00:00:03Z', kind: 'screenshot' as const, producer: 'screenshot-capture' as const, captureSource: 'browser' as const, format: 'image/png' as const, width: 1280, height: 720, artifactDigest: 'sha256-shot', referenceDigest: 'sha256-reference', comparison: 'match' as const },
]

function request(overrides: Partial<Parameters<typeof evaluateEvidenceVerdict>[0]> = {}) {
  return { requirements, evidence, rework: { currentAttempt: 1, maxAttempts: 3 }, ...overrides }
}

describe('evidence verdict', () => {
  it('passes only when every required structured check passes', () => {
    const result = evaluateEvidenceVerdict(request())
    expect(result.disposition).toBe('passed')
    expect(result.reasons).toEqual([])
    expect(result.rework).toBeUndefined()
  })

  it('never trusts child-shaped prose or malformed records as success', () => {
    const result = evaluateEvidenceVerdict(request({ evidence: [{ checkId: 'build', kind: 'build', status: 'passed', message: 'done' }] }))
    expect(result.disposition).toBe('inconclusive')
    expect(result.reasons[0]).toMatchObject({ checkId: 'build', code: 'invalid-evidence' })
  })

  it('returns failed with bounded retry advice for failed structured evidence', () => {
    const failed = evidence.map(item => item.checkId === 'tests' ? { ...item, exitCode: 1, failed: 1, passed: 3 } : item)
    const result = evaluateEvidenceVerdict(request({ evidence: failed }))
    expect(result.disposition).toBe('failed')
    expect(result.rework).toMatchObject({ action: 'retry', currentAttempt: 1, maxAttempts: 3, nextAttempt: 2 })
    expect(result.rework?.instructions).toContain('Fix the failing or incomplete tests, then rerun the test collector')
  })

  it('stops at the configured maximum and never exceeds the hard ceiling', () => {
    const failed = evidence.map(item => item.checkId === 'build' ? { ...item, exitCode: 2 } : item)
    const result = evaluateEvidenceVerdict(request({ evidence: failed, rework: { currentAttempt: 3, maxAttempts: 3 } }))
    expect(result.rework).toMatchObject({ action: 'stop', currentAttempt: 3, maxAttempts: 3 })
    expect(result.rework?.nextAttempt).toBeUndefined()
    expect(() => evaluateEvidenceVerdict(request({ rework: { currentAttempt: 1, maxAttempts: MAX_AUTOMATIC_REWORK_ROUNDS + 1 } }))).toThrow()
  })

  it('keeps incomplete evidence inconclusive, including skipped tests and unavailable screenshots', () => {
    const incomplete = evidence.map(item => {
      if (item.checkId === 'tests') return { ...item, skipped: 1, passed: 3 }
      if (item.checkId === 'screen') return { ...item, comparison: 'unavailable' as const }
      return item
    })
    const result = evaluateEvidenceVerdict(request({ evidence: incomplete }))
    expect(result.disposition).toBe('inconclusive')
    expect(result.rework).toBeUndefined()
  })

  it('keeps an unavailable all-optional collection inconclusive instead of passing', () => {
    const result = evaluateEvidenceVerdict({
      requirements: [{ checkId: 'optional-build', kind: 'build' as const, required: false }],
      evidence: [],
      rework: { currentAttempt: 1, maxAttempts: 2 },
    })
    expect(result.disposition).toBe('inconclusive')
  })

  it('does not let unrelated structured evidence satisfy an optional requirement', () => {
    const result = evaluateEvidenceVerdict(request({
      requirements: [{ checkId: 'optional-build', kind: 'build', required: false }],
      evidence: [evidence[1]!],
    }))
    expect(result.disposition).toBe('inconclusive')
    expect(result.reasons).toEqual([expect.objectContaining({ checkId: 'optional-build', code: 'missing-evidence' })])
  })

  it('bounds and redacts credential-shaped command and interface path text', () => {
    const command = parseStructuredEvidence({ ...evidence[0]!, command: 'pnpm test --token=super-secret' })
    expect(command).toMatchObject({ command: 'pnpm test --token=[REDACTED]' })
    const authorization = parseStructuredEvidence({ ...evidence[0]!, command: 'curl -H "Authorization: Bearer super-secret"' })
    expect(authorization).toMatchObject({ command: 'curl -H "Authorization: Bearer [REDACTED]"' })
    const path = parseStructuredEvidence({ ...evidence[2]!, path: '/health?api_key=super-secret' })
    expect(path).toMatchObject({ path: '/health?api_key=[REDACTED]' })
    expect(() => parseStructuredEvidence({ ...evidence[0]!, command: 'x'.repeat(513) })).toThrow()
  })

  it('covers interface defaults, explicit status contracts, and screenshot mismatch', () => {
    const interfaceEvidence = {
      checkId: 'api', capturedAt: '2026-08-15T00:00:02Z', kind: 'interface' as const, producer: 'http-probe' as const,
      method: 'GET', path: '/health', statusCode: 204, responseDigest: 'sha256-response', contractDigest: 'sha256-contract',
    }
    const mismatchShot = { ...evidence[3]!, comparison: 'mismatch' as const }
    const result = evaluateEvidenceVerdict(request({
      requirements: [
        { checkId: 'api', kind: 'interface' as const },
        { checkId: 'screen', kind: 'screenshot' as const },
      ],
      evidence: [interfaceEvidence, mismatchShot],
    }))
    expect(result.disposition).toBe('failed')
    expect(result.rework?.instructions).toEqual(expect.arrayContaining([
      'Fix the visual mismatch and capture a fresh screenshot comparison',
    ]))
    const statusFailure = evaluateEvidenceVerdict(request({
      requirements: [{ checkId: 'api', kind: 'interface' as const, expectedStatusCodes: [200] }],
      evidence: [{ ...interfaceEvidence, statusCode: 500 }],
    }))
    expect(statusFailure.disposition).toBe('failed')
  })

  it('rejects malformed test counts and mismatched structured evidence', () => {
    expect(() => parseStructuredEvidence({ ...evidence[1]!, total: 5 })).toThrow()
    const mismatch = assessEvidenceRecord(
      { checkId: 'build', kind: 'build' },
      parseStructuredEvidence(evidence[2]!),
    )
    expect(mismatch.outcome).toBe('inconclusive')
    expect(new EvidenceVerdictCoordinator().evaluate(request()).disposition).toBe('passed')
  })

  it('validates empty requirements, retry bounds, and invalid status contracts', () => {
    expect(() => evaluateEvidenceVerdict(request({ requirements: [] }))).toThrow(/At least one evidence requirement/)
    expect(() => evaluateEvidenceVerdict(request({ rework: { currentAttempt: 0, maxAttempts: 1 } }))).toThrow(/currentAttempt/)
    expect(() => evaluateEvidenceVerdict(request({ rework: { currentAttempt: 1, maxAttempts: MAX_AUTOMATIC_REWORK_ROUNDS + 1 } }))).toThrow(/maxAttempts/)
    expect(() => evaluateEvidenceVerdict(request({ requirements: [{ checkId: 'api', kind: 'interface' as const, expectedStatusCodes: [99] }] }))).toThrow(/Invalid expected HTTP status/)
  })

  it('treats an object with a throwing checkId getter as invalid input', () => {
    const malicious = Object.create(null) as Record<string, unknown>
    Object.defineProperty(malicious, 'checkId', { get: () => { throw new Error('getter trap') } })
    expect(() => evaluateEvidenceVerdict(request({ evidence: [malicious] }))).toThrow('getter trap')
    const withoutCheckId = evaluateEvidenceVerdict(request({ evidence: [{ message: 'child says done' }] }))
    expect(withoutCheckId.disposition).toBe('inconclusive')
  })

  it('rejects duplicate requirements and duplicate evidence for one check', () => {
    expect(() => evaluateEvidenceVerdict(request({ requirements: [...requirements, requirements[0]!] }))).toThrow(/Duplicate evidence requirement/)
    const duplicate = [...evidence, evidence[0]!]
    const result = evaluateEvidenceVerdict(request({ evidence: duplicate }))
    expect(result.disposition).toBe('inconclusive')
    expect(result.checks.find(check => check.checkId === 'build')).toMatchObject({ outcome: 'inconclusive' })
  })
})
