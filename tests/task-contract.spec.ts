import { describe, expect, it } from 'vitest'
import {
  MAX_VERIFICATION_CHECKS,
  MAX_VERIFICATION_OUTPUT_BYTES,
  MAX_VERIFICATION_TIMEOUT_MS,
  teamTaskContractSchema,
} from '../src/domain/task-contract.ts'
import { contract } from './fixtures.ts'

describe('team task verification contract', () => {
  it('keeps legacy contracts valid when verificationChecks is absent', () => {
    const parsed = teamTaskContractSchema.parse(contract())

    expect(parsed.verificationChecks).toBeUndefined()
    expect(parsed.maxAttempts).toBeUndefined()
  })

  it('accepts bounded Host-owned build and test references', () => {
    const parsed = teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [
        {
          checkId: 'build',
          kind: 'build',
          commandRef: 'workspace.build',
          timeoutMs: 120_000,
          stdoutMaxBytes: 64_000,
          stderrMaxBytes: 64_000,
        },
        {
          checkId: 'unit-tests',
          kind: 'test',
          commandRef: 'workspace.test',
          timeoutMs: 180_000,
          stdoutMaxBytes: 128_000,
          stderrMaxBytes: 128_000,
        },
      ],
      maxAttempts: 3,
    })

    expect(parsed.verificationChecks).toHaveLength(2)
    expect(parsed.maxAttempts).toBe(3)
  })

  it('rejects duplicate ids, shell-like references, unsupported fields, and excessive bounds', () => {
    const baseCheck = {
      checkId: 'build',
      kind: 'build' as const,
      commandRef: 'workspace.build',
      timeoutMs: 1_000,
      stdoutMaxBytes: 1_000,
      stderrMaxBytes: 1_000,
    }

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [baseCheck, { ...baseCheck, commandRef: 'workspace.other' }],
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [{ ...baseCheck, commandRef: 'pnpm test && echo secret' }],
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [{ ...baseCheck, argv: ['pnpm', 'test'] }],
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: Array.from({ length: MAX_VERIFICATION_CHECKS + 1 }, (_, index) => ({
        ...baseCheck,
        checkId: `check-${index}`,
      })),
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [{ ...baseCheck, timeoutMs: MAX_VERIFICATION_TIMEOUT_MS + 1 }],
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({
      ...contract(),
      verificationChecks: [{ ...baseCheck, stdoutMaxBytes: MAX_VERIFICATION_OUTPUT_BYTES + 1 }],
    })).toThrow()

    expect(() => teamTaskContractSchema.parse({ ...contract(), maxAttempts: 6 })).toThrow()
  })

  it('requires immutable provenance only for first-class review rework tasks', () => {
    expect(teamTaskContractSchema.parse({
      ...contract(), kind: 'review-rework', reviewRework: { sourceReviewId: 'review-1', round: 2 },
    })).toMatchObject({ kind: 'review-rework', reviewRework: { sourceReviewId: 'review-1', round: 2 } })
    expect(() => teamTaskContractSchema.parse({ ...contract(), kind: 'review-rework' })).toThrow()
    expect(() => teamTaskContractSchema.parse({
      ...contract(), kind: 'work', reviewRework: { sourceReviewId: 'review-1', round: 1 },
    })).toThrow()
    expect(() => teamTaskContractSchema.parse({
      ...contract(), kind: 'review-rework', reviewRework: { sourceReviewId: 'review-1', round: 4 },
    })).toThrow()
  })
})
