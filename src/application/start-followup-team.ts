/** Source-journal saga: durable intent precedes any new Team side effect. */
import { ControlOperationId } from '../domain/ids.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { z } from 'zod'

const exactIdentity = z.string().min(1).refine(value => value === value.trim(), 'Identity must be exact')
export const reconcileFollowupTeamRequestSchema = z.object({
  teamId: exactIdentity,
  operationId: exactIdentity,
  parentSessionId: exactIdentity,
  sourceControllerSessionId: exactIdentity,
}).strict()
export const followupTargetCandidateSchema = z.object({
  teamId: exactIdentity,
  controllerSessionId: exactIdentity,
  sourceTeamId: exactIdentity,
  sourceControllerSessionId: exactIdentity,
  operationId: exactIdentity,
  parentSessionId: exactIdentity,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()
export type ReconcileFollowupTeamRequest = z.infer<typeof reconcileFollowupTeamRequestSchema>
export type FollowupTargetCandidate = z.infer<typeof followupTargetCandidateSchema>
export type ReconcileFollowupTeamResult = {
  readonly kind: 'existing' | 'reconciled'
  readonly teamId: string
  readonly controllerSessionId: string
}

export interface StartFollowupTeamRequest {
  readonly teamId: string
  readonly operationId: string
  readonly requestDigest: string
  readonly parentSessionId: string
}

export interface FollowupTeamIdentity {
  readonly teamId: string
  readonly controllerSessionId: string
}

export type StartFollowupTeamResult<Value extends FollowupTeamIdentity> =
  | { readonly kind: 'existing'; readonly teamId: string; readonly controllerSessionId: string }
  | { readonly kind: 'started'; readonly value: Value }

/** All instances must share the source controller's DurableJournalCoordinator.
 * The gate remains held across preflight, start and publication: callbacks must not re-enter
 * this same source journal gate (a target Team's separate journal is fine).
 * Never compensates, deletes intent, or retries a possibly completed start.
 * Domain replay owns source status, lease and operation-identity admission.
 */
export class StartFollowupTeamCoordinator {
  constructor(
    private readonly clock: Clock,
    private readonly eventIds: EventIdSource,
    private readonly transactions: DurableJournalCoordinator,
  ) {}

  /** findTargets must exhaust the authoritative Host enumeration for this
   * intent, verify native target identity, durable continuation provenance and
   * parent binding, and reject partial/failed enumeration. Never accept caller
   * claims, cached summaries or a single page as proof of uniqueness. Optional
   * digest supports older target provenance; when present it must match intent.
   * Every supplied candidate must match: mixed/untrusted results fail closed.
   * Same-process poison is deliberately enforced before enumeration. A new gate
   * is appropriate only after external recovery, not as an in-process bypass.
   */
  reconcile(
    input: ReconcileFollowupTeamRequest,
    journal: TeamEventJournal,
    findTargets: () => Promise<readonly FollowupTargetCandidate[]>,
  ): Promise<ReconcileFollowupTeamResult> {
    const request = reconcileFollowupTeamRequestSchema.parse(input)
    return this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId || journal.key !== request.sourceControllerSessionId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Follow-up reconciliation targets another source Team or controller')
      }
      const intent = current.followupOperations?.[request.operationId]
      if (intent === undefined) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Unknown follow-up intent; no target can be confirmed')
      }
      if (intent.parentSessionId !== request.parentSessionId) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Follow-up parent does not match the durable intent')
      }
      if (intent.targetTeamId !== undefined && intent.targetControllerSessionId !== undefined) {
        return { kind: 'existing', teamId: intent.targetTeamId, controllerSessionId: intent.targetControllerSessionId }
      }
      if (intent.targetTeamId !== undefined || intent.targetControllerSessionId !== undefined) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Follow-up target identity is incomplete')
      }
      let raw: readonly FollowupTargetCandidate[]
      try {
        raw = await findTargets()
      } catch (cause) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Follow-up target enumeration is unknown; intent retained', { cause })
      }
      const parsed = z.array(followupTargetCandidateSchema).safeParse(raw)
      if (!parsed.success) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Untrusted follow-up target records; intent retained')
      }
      const candidates = parsed.data
      if (candidates.some(candidate => candidate.sourceTeamId !== request.teamId
        || candidate.sourceControllerSessionId !== request.sourceControllerSessionId
        || candidate.operationId !== request.operationId || candidate.parentSessionId !== request.parentSessionId
        || (candidate.requestDigest !== undefined && candidate.requestDigest !== intent.requestDigest)
        || candidate.teamId === request.teamId || candidate.controllerSessionId === request.sourceControllerSessionId
        || candidate.controllerSessionId === request.parentSessionId)) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Follow-up target provenance conflicts with the intent; intent retained')
      }
      if (candidates.length === 0) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Follow-up target remains unknown; intent retained')
      }
      if (candidates.length !== 1) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Multiple follow-up targets were found; intent retained')
      }
      const target = candidates[0]!
      const created = createTeamEvent(this.clock, this.eventIds, request.teamId, {
        type: 'yuqi/team-followup-created', operationId: ControlOperationId(request.operationId),
        targetTeamId: target.teamId, targetControllerSessionId: target.controllerSessionId,
      })
      validateTeamEvents(transaction.read(), [created])
      await transaction.commit([created], 'SETTLEMENT_PERSISTENCE_FAILED', 'Could not durably reconcile the follow-up target')
      return { kind: 'reconciled', teamId: target.teamId, controllerSessionId: target.controllerSessionId }
    })
  }

  start<Value extends FollowupTeamIdentity>(
    input: StartFollowupTeamRequest,
    journal: TeamEventJournal,
    start: () => Promise<Value>,
    validateStart?: () => Promise<void>,
  ): Promise<StartFollowupTeamResult<Value>> {
    // Freeze the request cut before queuing; caller mutation cannot retarget it.
    const request = { teamId: input.teamId, operationId: input.operationId,
      requestDigest: input.requestDigest, parentSessionId: input.parentSessionId }
    return this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Follow-up targets another source Team')
      }
      const existing = current.followupOperations?.[request.operationId]
      if (existing !== undefined) {
        if (existing.requestDigest !== request.requestDigest || existing.parentSessionId !== request.parentSessionId) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Follow-up operation was reused with a different request or parent')
        }
        if (existing.targetTeamId !== undefined && existing.targetControllerSessionId !== undefined) {
          return { kind: 'existing', teamId: existing.targetTeamId, controllerSessionId: existing.targetControllerSessionId }
        }
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Follow-up intent has no confirmed target; reconcile before starting another Team')
      }
      const operationId = ControlOperationId(request.operationId)
      const intent = createTeamEvent(this.clock, this.eventIds, request.teamId, {
        type: 'yuqi/team-followup-requested', operationId,
        requestDigest: request.requestDigest, parentSessionId: request.parentSessionId,
      })
      validateTeamEvents(transaction.read(), [intent])
      // Side-effect-free preflight only for a new intent. Errors propagate before
      // persistence, leaving this operation retryable without reconciliation.
      await validateStart?.()
      await transaction.commit([intent], 'INTENT_PERSISTENCE_FAILED', 'Could not durably request the follow-up Team')

      let value: Value
      try {
        value = await start()
      } catch (cause) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Follow-up start did not return a confirmed target; its durable intent is retained', { cause })
      }
      const created = createTeamEvent(this.clock, this.eventIds, request.teamId, {
        type: 'yuqi/team-followup-created', operationId,
        targetTeamId: value.teamId, targetControllerSessionId: value.controllerSessionId,
      })
      validateTeamEvents(transaction.read(), [created])
      await transaction.commit([created], 'SETTLEMENT_PERSISTENCE_FAILED', 'Could not durably confirm the follow-up Team')
      return { kind: 'started', value }
    })
  }
}
