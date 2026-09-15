/**
 * Harness rc.5 evidence boundary.
 *
 * rc.5 exposes child lifecycle and usage facts, but no Host-owned process,
 * HTTP, or screenshot collector. Keep those capabilities explicitly closed;
 * callers must persist an inconclusive verdict until a real collector is
 * provided by a later Harness integration.
 */

import type { EvidenceKind } from '../../domain/evidence-verdict.ts'
import type { HostEvidenceCollectionRequest, HostEvidenceCollectionResult, HostEvidenceCollectorPort } from '../../application/ports.ts'

export interface HarnessEvidenceCapability {
  readonly kind: EvidenceKind
  readonly available: boolean
  readonly reason: string
}

const UNAVAILABLE_REASON = 'The current Harness public API exposes no host-owned collector for this evidence kind'

/** Capability discovery is intentionally fail-closed for every structured kind. */
export const HARNESS_EVIDENCE_CAPABILITIES: readonly HarnessEvidenceCapability[] = Object.freeze([
  Object.freeze({ kind: 'build' as const, available: false as const, reason: UNAVAILABLE_REASON }),
  Object.freeze({ kind: 'test' as const, available: false as const, reason: UNAVAILABLE_REASON }),
  Object.freeze({ kind: 'interface' as const, available: false as const, reason: UNAVAILABLE_REASON }),
  Object.freeze({ kind: 'screenshot' as const, available: false as const, reason: UNAVAILABLE_REASON }),
])

/** Public rc.5 collector: no fake evidence is ever produced. */
export class HarnessEvidenceCollector implements HostEvidenceCollectorPort {
  capabilities(): readonly HarnessEvidenceCapability[] {
    return HARNESS_EVIDENCE_CAPABILITIES
  }

  async collect(request: HostEvidenceCollectionRequest): Promise<HostEvidenceCollectionResult> {
    const invalid = validateRequest(request)
    if (invalid !== undefined) return invalid
    if (request.signal?.aborted === true) {
      return { kind: 'aborted', reason: 'Evidence collection was cancelled before a Host collector was available' }
    }
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON }
  }
}

function validateRequest(request: HostEvidenceCollectionRequest): HostEvidenceCollectionResult | undefined {
  if (request.teamId.trim().length === 0 || request.taskId.trim().length === 0
    || request.attemptId.trim().length === 0 || request.verificationId.trim().length === 0) {
    return { kind: 'failed', code: 'INVALID_COLLECTION_IDENTITY', reason: 'Evidence collection identity must be non-empty' }
  }
  if (request.requirementIds.length === 0) {
    return { kind: 'failed', code: 'INVALID_COLLECTION_REQUIREMENTS', reason: 'Evidence collection requires at least one requirement id' }
  }
  const seen = new Set<string>()
  for (const requirementId of request.requirementIds) {
    if (requirementId.trim().length === 0 || seen.has(requirementId)) {
      return { kind: 'failed', code: 'INVALID_COLLECTION_REQUIREMENTS', reason: 'Evidence requirement ids must be non-empty and unique' }
    }
    seen.add(requirementId)
  }
  return undefined
}
