/** Evidence acceptance and bounded automatic rework planning. */

import {
  assessEvidenceRecord,
  isEvidenceRequirementRequired,
  MAX_VERDICT_REWORK_ROUNDS,
  parseStructuredEvidence,
} from '../domain/evidence-verdict.ts'
import type {
  EvidenceCheckAssessment,
  EvidenceCheckOutcome,
  EvidenceKind,
  EvidenceCollectionStatus,
  EvidenceReason,
  EvidenceRequirement,
  StructuredEvidence,
} from '../domain/evidence-verdict.ts'

/** Hard safety ceiling for automatic rework rounds. */
export const MAX_AUTOMATIC_REWORK_ROUNDS = MAX_VERDICT_REWORK_ROUNDS

export interface ReworkBudget {
  /** One-based current attempt number. */
  readonly currentAttempt: number
  /** Inclusive maximum number of attempts permitted for this task. */
  readonly maxAttempts: number
}

export type ReworkAction = 'retry' | 'stop'

/** Bounded, evidence-derived guidance for a failed attempt. */
export interface ReworkAdvice {
  readonly action: ReworkAction
  readonly currentAttempt: number
  readonly maxAttempts: number
  readonly nextAttempt?: number
  readonly instructions: readonly string[]
}

export interface EvidenceVerdict {
  readonly disposition: 'passed' | 'failed' | 'inconclusive'
  readonly checks: readonly EvidenceCheckAssessment[]
  readonly reasons: readonly EvidenceReason[]
  readonly rework?: ReworkAdvice
}

export interface EvidenceVerdictRequest {
  readonly requirements: readonly EvidenceRequirement[]
  /** Unknown values are accepted only as input so malformed records become inconclusive. */
  readonly evidence: readonly unknown[]
  readonly rework: ReworkBudget
  /** Host collection outcome; omitted means a direct structured-evidence evaluation. */
  readonly collectionStatus?: EvidenceCollectionStatus
}

type FailedEvidenceReasonCode = 'build-failed' | 'tests-failed' | 'tests-incomplete' | 'interface-failed' | 'screenshot-mismatch' | 'screenshot-unavailable'

/**
 * Evaluate only host-checkable evidence. A child message, prose claim, or unknown
 * evidence producer cannot produce a passing verdict because it is rejected as
 * malformed/inconclusive before assessment.
 */
export function evaluateEvidenceVerdict(request: EvidenceVerdictRequest): EvidenceVerdict {
  validateRequest(request)
  const requirements = request.requirements.map(normalizeRequirement)
  const collectionStatus = request.collectionStatus ?? 'collected'
  const parsed = request.evidence.map(parseSafely)
  const checks = collectionStatus === 'collected'
    ? requirements.map((requirement) => assessRequirement(requirement, parsed))
    : requirements.map(requirement => ({
      checkId: requirement.checkId,
      kind: requirement.kind,
      outcome: 'inconclusive' as const,
      reasons: [collectionReason(requirement.checkId, collectionStatus)],
    }))
  const reasons = checks.flatMap(check => check.reasons)
  const structuredEvidence = parsed.flatMap(item => item.evidence === undefined ? [] : [item.evidence])
  const requiredChecks = collectionStatus === 'collected'
    ? checks.filter((_, index) => isEvidenceRequirementRequired(requirements[index]!, structuredEvidence))
    : checks
  const failed = requiredChecks.some(check => check.outcome === 'failed')
  const inconclusive = requiredChecks.some(check => check.outcome === 'inconclusive')
  const disposition = failed ? 'failed' : inconclusive ? 'inconclusive' : 'passed'
  const rework = disposition === 'failed' ? makeReworkAdvice(request.rework, reasons) : undefined
  return Object.freeze({
    disposition,
    checks: Object.freeze(checks),
    reasons: Object.freeze(reasons.map(item => Object.freeze({ ...item }))),
    ...(rework === undefined ? {} : { rework }),
  })
}

/** Small application facade for callers that prefer an object seam. It has no I/O. */
export class EvidenceVerdictCoordinator {
  evaluate(request: EvidenceVerdictRequest): EvidenceVerdict {
    return evaluateEvidenceVerdict(request)
  }
}

type ParsedEvidence = { readonly evidence?: StructuredEvidence; readonly invalidReason?: EvidenceReason }

function parseSafely(input: unknown): ParsedEvidence {
  const suppliedCheckId = typeof input === 'object' && input !== null && 'checkId' in input
    && typeof Reflect.get(input, 'checkId') === 'string'
    ? Reflect.get(input, 'checkId') as string
    : ''
  try {
    return { evidence: parseStructuredEvidence(input) }
  } catch {
    return { invalidReason: { checkId: suppliedCheckId, code: 'invalid-evidence', detail: 'Evidence is not a valid host-collected structured record' } }
  }
}

function collectionReason(checkId: string, status: Exclude<EvidenceCollectionStatus, 'collected'>): EvidenceReason {
  const code = status === 'unavailable'
    ? 'collector-unavailable'
    : status === 'failed'
      ? 'collector-failed'
      : 'collector-aborted'
  return { checkId, code, detail: `Host evidence collector status: ${status}` }
}

function assessRequirement(requirement: EvidenceRequirement, parsed: readonly ParsedEvidence[]): EvidenceCheckAssessment {
  const candidates = parsed.filter(item => item.evidence?.checkId === requirement.checkId || item.invalidReason?.checkId === requirement.checkId)
  if (candidates.length === 0) {
    return {
      checkId: requirement.checkId,
      kind: requirement.kind,
      outcome: 'inconclusive',
      reasons: [{ checkId: requirement.checkId, code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
    }
  }
  if (candidates.length > 1) {
    return {
      checkId: requirement.checkId,
      kind: requirement.kind,
      outcome: 'inconclusive',
      reasons: [{ checkId: requirement.checkId, code: 'invalid-evidence', detail: 'More than one evidence record was supplied for the same check' }],
    }
  }
  const candidate = candidates[0]!
  if (candidate.evidence === undefined) {
    return {
      checkId: requirement.checkId,
      kind: requirement.kind,
      outcome: 'inconclusive',
      reasons: [candidate.invalidReason!],
    }
  }
  return assessEvidenceRecord(requirement, candidate.evidence)
}

function normalizeRequirement(requirement: EvidenceRequirement): EvidenceRequirement {
  return {
    ...requirement,
    ...(requirement.required === undefined ? { required: true } : {}),
    ...(requirement.expectedStatusCodes === undefined ? {} : { expectedStatusCodes: [...requirement.expectedStatusCodes] }),
  }
}

function validateRequest(request: EvidenceVerdictRequest): void {
  if (request.requirements.length === 0) throw new TypeError('At least one evidence requirement is required')
  if (!Number.isSafeInteger(request.rework.currentAttempt) || request.rework.currentAttempt < 1) {
    throw new TypeError('currentAttempt must be a positive integer')
  }
  if (!Number.isSafeInteger(request.rework.maxAttempts)
    || request.rework.maxAttempts < request.rework.currentAttempt
    || request.rework.maxAttempts > MAX_AUTOMATIC_REWORK_ROUNDS) {
    throw new TypeError(`maxAttempts must be between currentAttempt and ${MAX_AUTOMATIC_REWORK_ROUNDS}`)
  }
  const ids = new Set<string>()
  for (const requirement of request.requirements) {
    if (ids.has(requirement.checkId)) throw new TypeError(`Duplicate evidence requirement ${requirement.checkId}`)
    ids.add(requirement.checkId)
    if (requirement.expectedStatusCodes?.some(code => !Number.isInteger(code) || code < 100 || code > 599)) {
      throw new TypeError(`Invalid expected HTTP status for ${requirement.checkId}`)
    }
  }
}

function makeReworkAdvice(budget: ReworkBudget, reasons: readonly EvidenceReason[]): ReworkAdvice {
  const kinds = new Set<EvidenceKind>(reasons
    .filter((reason): reason is EvidenceReason & { readonly code: FailedEvidenceReasonCode } =>
      ['build-failed', 'tests-failed', 'tests-incomplete', 'interface-failed', 'screenshot-mismatch', 'screenshot-unavailable'].includes(reason.code))
    .map(reason => reasonToKind(reason.code)))
  const instructions = [...kinds].map(kind => instructionFor(kind))
  const action: ReworkAction = budget.currentAttempt < budget.maxAttempts ? 'retry' : 'stop'
  return Object.freeze({
    action,
    currentAttempt: budget.currentAttempt,
    maxAttempts: budget.maxAttempts,
    ...(action === 'retry' ? { nextAttempt: budget.currentAttempt + 1 } : {}),
    instructions: Object.freeze(instructions),
  })
}

function reasonToKind(code: FailedEvidenceReasonCode): EvidenceKind {
  switch (code) {
    case 'build-failed': return 'build'
    case 'tests-failed':
    case 'tests-incomplete': return 'test'
    case 'interface-failed': return 'interface'
    case 'screenshot-mismatch':
    case 'screenshot-unavailable': return 'screenshot'
  }
}

function instructionFor(kind: EvidenceKind): string {
  switch (kind) {
    case 'build': return 'Fix the build/typecheck failure, then rerun the build collector'
    case 'test': return 'Fix the failing or incomplete tests, then rerun the test collector'
    case 'interface': return 'Fix the interface contract or endpoint behavior, then rerun the probe'
    case 'screenshot': return 'Fix the visual mismatch and capture a fresh screenshot comparison'
  }
}
