/** Structured, host-collected evidence used to accept one task attempt. */

import { z } from 'zod'

/** Evidence sources that can be independently re-run by the host. */
export const EVIDENCE_KINDS = ['build', 'test', 'interface', 'screenshot'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]

/** Durable outcome of the Host collector itself, before evidence assessment. */
export const EVIDENCE_COLLECTION_STATUSES = ['collected', 'unavailable', 'failed', 'aborted'] as const
export type EvidenceCollectionStatus = typeof EVIDENCE_COLLECTION_STATUSES[number]
export const evidenceCollectionStatusSchema = z.enum(EVIDENCE_COLLECTION_STATUSES)

/** Keep persisted Host text bounded and redact common credential-shaped values. */
export const MAX_PERSISTED_EVIDENCE_TEXT_LENGTH = 512

/** Hard safety ceiling shared by durable verdict validation and rework planning. */
export const MAX_VERDICT_REWORK_ROUNDS = 5

/** A machine-checkable acceptance requirement. All requirements are required by default. */
export interface EvidenceRequirement {
  readonly checkId: string
  readonly kind: EvidenceKind
  readonly required?: boolean | undefined
  /** Expected HTTP status codes for interface checks; defaults to 2xx. */
  readonly expectedStatusCodes?: readonly number[] | undefined
}

/** Runtime schema for one machine-checkable acceptance requirement. */
export const evidenceRequirementSchema = z.object({
  checkId: z.string().trim().min(1),
  kind: z.enum(EVIDENCE_KINDS),
  required: z.boolean().optional(),
  expectedStatusCodes: z.array(z.number().int().min(100).max(599)).optional(),
}).strict()

const evidenceBase = {
  checkId: z.string().trim().min(1),
  capturedAt: z.string().trim().min(1),
}

/** Build evidence contains facts from a real build/typecheck process, not a child claim. */
export const buildEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal('build'),
  producer: z.literal('build-runner'),
  command: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  exitCode: z.number().int().nonnegative(),
  artifactDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
}).strict()

/** Test evidence contains a complete machine-readable test-count report. */
export const testEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal('test'),
  producer: z.literal('test-runner'),
  command: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  exitCode: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  reportDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
}).superRefine((value, context) => {
  if (value.passed + value.failed + value.skipped !== value.total) {
    context.addIssue({ code: 'custom', path: ['total'], message: 'test counts must add up to total' })
  }
}).strict()

/** Interface evidence contains a replayable probe result and its contract digest. */
export const interfaceEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal('interface'),
  producer: z.literal('http-probe'),
  method: z.string().regex(/^[A-Z]+$/),
  path: z.string().regex(/^\/[^\s]*$/).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  statusCode: z.number().int().min(100).max(599),
  responseDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  contractDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
}).strict()

/** Screenshot evidence contains an artifact plus an independent structured comparison result. */
export const screenshotEvidenceSchema = z.object({
  ...evidenceBase,
  kind: z.literal('screenshot'),
  producer: z.literal('screenshot-capture'),
  captureSource: z.enum(['browser', 'desktop']),
  format: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  artifactDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  referenceDigest: z.string().trim().min(1).max(MAX_PERSISTED_EVIDENCE_TEXT_LENGTH),
  comparison: z.enum(['match', 'mismatch', 'unavailable']),
}).strict()

/** Runtime parser for evidence supplied by a host adapter. */
export const structuredEvidenceSchema = z.discriminatedUnion('kind', [
  buildEvidenceSchema,
  testEvidenceSchema,
  interfaceEvidenceSchema,
  screenshotEvidenceSchema,
])

/** Evidence whose producer is a known, host-owned checker. */
export type StructuredEvidence = Readonly<z.output<typeof structuredEvidenceSchema>>

/** Optional requirements remain a gate until their own checkId has evidence. */
export function isEvidenceRequirementRequired(
  requirement: EvidenceRequirement,
  evidence: readonly StructuredEvidence[],
): boolean {
  return requirement.required !== false || !evidence.some(candidate => candidate.checkId === requirement.checkId)
}

/** Stable outcome for one acceptance check. */
export type EvidenceCheckOutcome = 'passed' | 'failed' | 'inconclusive'

export type EvidenceReasonCode =
  | 'missing-evidence'
  | 'invalid-evidence'
  | 'unexpected-evidence'
  | 'build-failed'
  | 'tests-failed'
  | 'tests-incomplete'
  | 'interface-failed'
  | 'screenshot-mismatch'
  | 'screenshot-unavailable'
  | 'collector-unavailable'
  | 'collector-failed'
  | 'collector-aborted'

/** Why a check did not produce a passing verdict. */
export interface EvidenceReason {
  readonly checkId: string
  readonly code: EvidenceReasonCode
  readonly detail: string
}

/** Runtime schema for a durable evidence reason. */
export const evidenceReasonSchema = z.object({
  checkId: z.string().trim().min(1),
  code: z.enum([
    'missing-evidence', 'invalid-evidence', 'unexpected-evidence', 'build-failed',
    'tests-failed', 'tests-incomplete', 'interface-failed', 'screenshot-mismatch',
    'screenshot-unavailable', 'collector-unavailable', 'collector-failed', 'collector-aborted',
  ]),
  detail: z.string().trim().min(1),
}).strict()

/** Deterministic assessment of one structured evidence record. */
export interface EvidenceCheckAssessment {
  readonly checkId: string
  readonly kind: EvidenceKind
  readonly outcome: EvidenceCheckOutcome
  readonly reasons: readonly EvidenceReason[]
}

/** Parse one record. Callers should treat parse failure as inconclusive, never as success. */
export function parseStructuredEvidence(input: unknown): StructuredEvidence {
  const parsed = structuredEvidenceSchema.parse(input)
  switch (parsed.kind) {
    case 'build': return { ...parsed, command: redactSensitiveText(parsed.command) }
    case 'test': return { ...parsed, command: redactSensitiveText(parsed.command) }
    case 'interface': return { ...parsed, path: redactSensitivePath(parsed.path) }
    case 'screenshot': return parsed
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*(?:=|:)\s*bearer\s+)([^\s"'&]+)/giu, '$1[REDACTED]')
    .replace(/(\bbearer\s+)([^\s"'&]+)/giu, '$1[REDACTED]')
    .replace(
    /((?:--?(?:token|password|secret|api[-_]?key|authorization|access[-_]?token|bearer)|(?:token|password|secret|api[-_]?key|authorization|access[-_]?token))\s*(?:=|:)\s*(?!bearer\b)|--?(?:token|password|secret|api[-_]?key|authorization|access[-_]?token|bearer)\s+)([^\s"'&]+)/giu,
    '$1[REDACTED]',
    )
}

function redactSensitivePath(value: string): string {
  return value.replace(
    /([?&](?:token|password|secret|api[-_]?key|authorization|access[-_]?token)=)([^&#\s]*)/giu,
    '$1[REDACTED]',
  )
}

/** Assess one already parsed evidence record against its requirement. */
export function assessEvidenceRecord(
  requirement: EvidenceRequirement,
  evidence: StructuredEvidence,
): EvidenceCheckAssessment {
  if (requirement.kind !== evidence.kind || requirement.checkId !== evidence.checkId) {
    return assessment(requirement, 'inconclusive', [{
      checkId: requirement.checkId,
      code: 'invalid-evidence',
      detail: `Evidence kind or check id does not match ${requirement.checkId}`,
    }])
  }

  switch (evidence.kind) {
    case 'build':
      return evidence.exitCode === 0
        ? assessment(requirement, 'passed', [])
        : assessment(requirement, 'failed', [reason(requirement, 'build-failed', `Build exited with code ${evidence.exitCode}`)])
    case 'test':
      if (evidence.exitCode !== 0 || evidence.failed > 0) {
        return assessment(requirement, 'failed', [reason(requirement, 'tests-failed', `Test runner reported ${evidence.failed} failed test(s)`)] )
      }
      if (evidence.skipped > 0 || evidence.passed !== evidence.total) {
        return assessment(requirement, 'inconclusive', [reason(requirement, 'tests-incomplete', 'Test report contains skipped or unaccounted tests')])
      }
      return assessment(requirement, 'passed', [])
    case 'interface': {
      const expected = requirement.expectedStatusCodes ?? []
      const statusPassed = expected.length === 0
        ? evidence.statusCode >= 200 && evidence.statusCode < 300
        : expected.includes(evidence.statusCode)
      return statusPassed
        ? assessment(requirement, 'passed', [])
        : assessment(requirement, 'failed', [reason(requirement, 'interface-failed', `Interface probe returned HTTP ${evidence.statusCode}`)])
    }
    case 'screenshot':
      if (evidence.comparison === 'match') return assessment(requirement, 'passed', [])
      if (evidence.comparison === 'mismatch') {
        return assessment(requirement, 'failed', [reason(requirement, 'screenshot-mismatch', 'Screenshot comparison did not match the reference')])
      }
      return assessment(requirement, 'inconclusive', [reason(requirement, 'screenshot-unavailable', 'Screenshot comparison was unavailable')])
  }
}

function reason(requirement: EvidenceRequirement, code: EvidenceReasonCode, detail: string): EvidenceReason {
  return { checkId: requirement.checkId, code, detail }
}

function assessment(requirement: EvidenceRequirement, outcome: EvidenceCheckOutcome, reasons: readonly EvidenceReason[]): EvidenceCheckAssessment {
  return Object.freeze({
    checkId: requirement.checkId,
    kind: requirement.kind,
    outcome,
    reasons: Object.freeze(reasons.map(item => Object.freeze({ ...item }))),
  })
}
