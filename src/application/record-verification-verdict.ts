/** Durable application coordinator for host-structured verification verdicts. */

import { ControlOperationId, FileLeaseId, TaskId, AttemptId, VerificationId } from '../domain/ids.ts'
import type { EvidenceCollectionStatus, EvidenceRequirement, StructuredEvidence } from '../domain/evidence-verdict.ts'
import { parseStructuredEvidence } from '../domain/evidence-verdict.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents, teamAutomaticReworkCount } from '../domain/projection.ts'
import { DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS } from '../domain/review-policy.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import type { JournalTransaction } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, HostEvidenceCollectionRequest, HostEvidenceCollectionResult, HostEvidenceCollectorPort, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { evaluateEvidenceVerdict } from './evidence-verdict.ts'
import type { EvidenceVerdictRequest } from './evidence-verdict.ts'

/** Request to persist one verdict for one exact verification identity. */
export interface RecordVerificationVerdictRequest extends Omit<EvidenceVerdictRequest, 'evidence' | 'collectionStatus'> {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId: string
  readonly operationId: string
  readonly evidence: readonly unknown[]
}

/** Request shape for a Host-owned collection before verdict persistence. */
export type CollectedVerificationVerdictRequest = Omit<RecordVerificationVerdictRequest, 'evidence'> & {
  readonly signal?: AbortSignal
}

/** Evaluates evidence and persists only the resulting durable verdict fact. */
export class VerificationVerdictCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator
  readonly #collections = new Map<string, {
    readonly request: CollectedVerificationVerdictRequest
    readonly promise: Promise<TeamProjection>
  }>()

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  record(request: RecordVerificationVerdictRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      return this.#recordInTransaction(request, request.evidence, transaction, undefined, 'collected')
    })
  }

  /** Collect outside the journal gate, then revalidate and commit atomically. */
  recordFromCollector(
    request: CollectedVerificationVerdictRequest,
    journal: TeamEventJournal,
    collector: HostEvidenceCollectorPort,
  ): Promise<TeamProjection> {
    const key = collectionKey(journal.key, request.operationId)
    const active = this.#collections.get(key)
    if (active !== undefined) {
      assertPendingCollectionReplayCompatible(active.request, request)
      return active.promise
    }

    const promise = this.#collectAndRecord(request, journal, collector)
    this.#collections.set(key, { request, promise })
    void promise.then(
      () => this.#clearCollection(key, promise),
      () => this.#clearCollection(key, promise),
    )
    return promise
  }

  async #collectAndRecord(
    request: CollectedVerificationVerdictRequest,
    journal: TeamEventJournal,
    collector: HostEvidenceCollectorPort,
  ): Promise<TeamProjection> {
    const replay = await this.#transactions.run(journal, async transaction => {
      const current = this.#validateCommandIdentity(transaction.read(), request)
      const operationId = ControlOperationId(request.operationId)
      const existing = current.verificationVerdictOperations[operationId]
      if (existing !== undefined) {
        assertOperationReplayCompatible(existing, request, operationId)
        return current
      }

      assertCurrentVerification(current, request)
      // Validate all caller-provided requirements and rework limits before the
      // host collector is reached; malformed requests have zero side effects.
      evaluateEvidenceVerdict({ requirements: request.requirements, evidence: [], rework: request.rework })
      return undefined
    })
    if (replay !== undefined) return replay

    const collectionRequest: HostEvidenceCollectionRequest = {
      teamId: request.teamId,
      taskId: request.taskId,
      attemptId: request.attemptId,
      verificationId: request.verificationId,
      requirementIds: request.requirements.map(requirement => requirement.checkId),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    const collected = await collectWithAbort(collector, collectionRequest)
    return this.#transactions.run(journal, async transaction => {
      const evidence = collected.kind === 'collected' ? collected.evidence : []
      return this.#recordInTransaction(request, evidence, transaction, undefined, collected.kind)
    })
  }

  #clearCollection(key: string, promise: Promise<TeamProjection>): void {
    if (this.#collections.get(key)?.promise === promise) this.#collections.delete(key)
  }

  #validateCommandIdentity(
    inputs: readonly unknown[],
    request: Pick<RecordVerificationVerdictRequest, 'teamId' | 'operationId'>,
  ): TeamProjection {
    const current = replayTeamEvents(inputs)
    if (current.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    const operationId = ControlOperationId(request.operationId)
    if (current.controlOperations[operationId] !== undefined || current.taskRetryOperations[operationId] !== undefined
      || current.reconciliationOperations[operationId] !== undefined || current.attemptResolutionOperations[operationId] !== undefined
      || current.attemptResolutionProofs[operationId] !== undefined || current.recoveryClearOperations[operationId] !== undefined) {
      throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Verification operation ${operationId} was already used for another command`)
    }
    return current
  }

  async #recordInTransaction(
    request: Omit<RecordVerificationVerdictRequest, 'evidence'>,
    evidence: readonly unknown[],
    transaction: JournalTransaction,
    knownCurrent?: TeamProjection,
    collectionStatus: EvidenceCollectionStatus = 'collected',
  ): Promise<TeamProjection> {
    const current = knownCurrent ?? this.#validateCommandIdentity(transaction.read(), request)
    const operationId = ControlOperationId(request.operationId)
    const validEvidence = collectionStatus === 'collected' ? collectValidEvidence(evidence) : []
    const verdict = evaluateEvidenceVerdict({
      requirements: request.requirements,
      evidence: validEvidence,
      rework: request.rework,
      collectionStatus,
    })
    const existing = current.verificationVerdictOperations[operationId]
    if (existing !== undefined) {
      if (existing.verificationId !== request.verificationId || existing.taskId !== request.taskId || existing.attemptId !== request.attemptId
        || existing.disposition !== verdict.disposition || JSON.stringify(existing.requirements) !== JSON.stringify(request.requirements)
        || JSON.stringify(existing.evidence) !== JSON.stringify(validEvidence)
        || existing.collectionStatus !== collectionStatus
        || existing.reworkBudget?.currentAttempt !== request.rework.currentAttempt
        || existing.reworkBudget?.maxAttempts !== request.rework.maxAttempts) {
        throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Verification operation ${operationId} was reused with different content`)
      }
      return current
    }

    assertCurrentVerification(current, request)
    const teamReworkBudgetExhausted = verdict.disposition === 'failed'
      && verdict.rework?.action === 'retry'
      && teamAutomaticReworkCount(current) >= DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS
    const durableRework = teamReworkBudgetExhausted && verdict.rework !== undefined
      ? {
          action: 'stop' as const,
          currentAttempt: verdict.rework.currentAttempt,
          maxAttempts: verdict.rework.maxAttempts,
          instructions: ['Team automatic correction budget exhausted; awaiting controller'],
        }
      : verdict.rework
    const event = createTeamEvent(this.#clock, this.#eventIds, request.teamId, {
      type: 'yuqi/verification-verdict-recorded',
      operationId,
      taskId: TaskId(request.taskId),
      attemptId: AttemptId(request.attemptId),
      verificationId: VerificationId(request.verificationId),
      disposition: verdict.disposition,
      requirements: request.requirements.map(requirement => ({
        checkId: requirement.checkId,
        kind: requirement.kind,
        ...(requirement.required === undefined ? {} : { required: requirement.required }),
        ...(requirement.expectedStatusCodes === undefined ? {} : { expectedStatusCodes: [...requirement.expectedStatusCodes] }),
      })),
      evidence: [...validEvidence],
      reasons: [...verdict.reasons],
      collectionStatus,
      reworkBudget: { currentAttempt: request.rework.currentAttempt, maxAttempts: request.rework.maxAttempts },
      ...(durableRework === undefined ? {} : { rework: { ...durableRework, instructions: [...durableRework.instructions] } }),
    })
    const transitionEvents = verdict.disposition === 'passed'
      ? this.#completionEvents(transaction.read(), event, request.teamId, request.taskId, request.attemptId)
      : verdict.disposition === 'failed' && durableRework?.action === 'stop' && !teamReworkBudgetExhausted
        ? this.#terminalFailureEvents(transaction.read(), event, request.teamId, request.taskId, request.attemptId)
        : verdict.disposition === 'inconclusive'
          ? this.#manualConfirmationEvents(transaction.read(), event, request.teamId, request.taskId, request.attemptId, request.verificationId)
          : []
    const events = [event, ...transitionEvents]
    // A control request may arrive while the Host is collecting evidence.  Do
    // the terminal control transition after every verdict disposition, not
    // just a passing one, otherwise a cancelled Team can remain permanently
    // in `cancelling` after failed or inconclusive verification.
    const afterTransitions = validateTeamEvents(transaction.read(), events)
    const terminal = terminalControlEvent(afterTransitions, this.#clock, this.#eventIds, request.teamId)
    const committedEvents = terminal === undefined ? events : [...events, terminal]
    const next = validateTeamEvents(transaction.read(), committedEvents)
    await transaction.commit(committedEvents, 'VERIFICATION_PERSISTENCE_FAILED', 'Yuqi could not durably persist the verification verdict and completion facts')
    return next
  }

  #completionEvents(
    inputs: readonly unknown[],
    verdictEvent: ReturnType<typeof createTeamEvent>,
    teamId: string,
    taskId: string,
    attemptId: string,
  ): readonly ReturnType<typeof createTeamEvent>[] {
    const current = validateTeamEvents(inputs, [verdictEvent])
    const attempt = current.attempts[attemptId]
    const task = current.tasks[taskId]
    if ((attempt?.status !== 'settled' && attempt?.status !== 'completed') || task?.status !== 'verifying') return []
    const completionEvents: ReturnType<typeof createTeamEvent>[] = []
    for (const leaseId of current.fileLeaseIds) {
      const lease = current.fileLeases[leaseId]!
      if (lease.status === 'active' && lease.taskId === taskId && lease.attemptId === attemptId) {
        completionEvents.push(createTeamEvent(this.#clock, this.#eventIds, teamId, {
          type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId: TaskId(taskId),
          attemptId: AttemptId(attemptId), reason: 'verification passed',
        }))
      }
    }
    if (attempt.status === 'settled') {
      completionEvents.push(createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/attempt-status-changed', taskId: TaskId(taskId), attemptId: AttemptId(attemptId), from: 'settled', to: 'completed',
      }))
    }
    const taskCompleted = createTeamEvent(this.#clock, this.#eventIds, teamId, {
      type: 'yuqi/task-status-changed', taskId: TaskId(taskId), from: 'verifying', to: 'completed',
    })
    completionEvents.push(taskCompleted)
    validateTeamEvents(inputs, [verdictEvent, ...completionEvents])
    return completionEvents
  }

  #terminalFailureEvents(
    inputs: readonly unknown[],
    verdictEvent: ReturnType<typeof createTeamEvent>,
    teamId: string,
    taskId: string,
    attemptId: string,
  ): readonly ReturnType<typeof createTeamEvent>[] {
    const current = validateTeamEvents(inputs, [verdictEvent])
    const attempt = current.attempts[attemptId]
    const task = current.tasks[taskId]
    if (attempt?.status !== 'settled' || task?.status !== 'verifying'
      || (current.team.status !== 'running' && current.team.status !== 'cancelling' && current.team.status !== 'pausing')) return []

    const events: ReturnType<typeof createTeamEvent>[] = []
    for (const leaseId of current.fileLeaseIds) {
      const lease = current.fileLeases[leaseId]!
      if (lease.status === 'active' && lease.taskId === taskId && lease.attemptId === attemptId) {
        events.push(createTeamEvent(this.#clock, this.#eventIds, teamId, {
          type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId: TaskId(taskId),
          attemptId: AttemptId(attemptId), reason: 'verification failed without retry',
        }))
      }
    }
    events.push(
      createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/attempt-status-changed', taskId: TaskId(taskId), attemptId: AttemptId(attemptId),
        from: 'settled', to: 'verification_failed',
      }),
      createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/task-status-changed', taskId: TaskId(taskId), from: 'verifying', to: 'failed',
      }),
    )
    if (current.team.status === 'running') {
      events.push(createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/team-status-changed', from: 'running', to: 'failed',
      }))
    }
    validateTeamEvents(inputs, [verdictEvent, ...events])
    return events
  }

  /**
   * An unavailable Host check is neither success nor failure.  Close its
   * verification lifecycle and release exclusive files so the durable task is
   * visibly waiting for a human decision instead of appearing to run forever.
   * A later explicit retry may safely create a fresh attempt.
   */
  #manualConfirmationEvents(
    inputs: readonly unknown[],
    verdictEvent: ReturnType<typeof createTeamEvent>,
    teamId: string,
    taskId: string,
    attemptId: string,
    verificationId: string,
  ): readonly ReturnType<typeof createTeamEvent>[] {
    const current = validateTeamEvents(inputs, [verdictEvent])
    const task = current.tasks[taskId]
    const attempt = current.attempts[attemptId]
    const verification = current.verifications[verificationId]
    if (task?.status !== 'verifying' || attempt?.status !== 'settled' || verification?.status !== 'running') return []
    const events: ReturnType<typeof createTeamEvent>[] = []
    for (const leaseId of current.fileLeaseIds) {
      const lease = current.fileLeases[leaseId]!
      if (lease.status === 'active' && lease.taskId === taskId && lease.attemptId === attemptId) {
        events.push(createTeamEvent(this.#clock, this.#eventIds, teamId, {
          type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId: TaskId(taskId),
          attemptId: AttemptId(attemptId), reason: 'verification requires human confirmation',
        }))
      }
    }
    events.push(
      createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/verification-status-changed', taskId: TaskId(taskId), attemptId: AttemptId(attemptId),
        verificationId: VerificationId(verificationId), from: 'running', to: 'waived', reason: 'Host evidence is inconclusive; awaiting human confirmation',
      }),
      createTeamEvent(this.#clock, this.#eventIds, teamId, {
        type: 'yuqi/task-status-changed', taskId: TaskId(taskId), from: 'verifying', to: 'blocked', reason: 'Host evidence is inconclusive; awaiting human confirmation',
      }),
    )
    validateTeamEvents(inputs, [verdictEvent, ...events])
    return events
  }
}

function terminalControlEvent(
  projection: TeamProjection,
  clock: Clock,
  eventIds: EventIdSource,
  teamId: string,
): ReturnType<typeof createTeamEvent> | undefined {
  const hasActiveAttempt = Object.values(projection.attempts)
    .some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
  const hasActiveVerification = Object.values(projection.verifications)
    .some(verification => verification.status === 'pending' || verification.status === 'running')
  const hasActiveLease = Object.values(projection.fileLeases).some(lease => lease.status === 'active')
  if (hasActiveAttempt || hasActiveVerification || hasActiveLease) return undefined
  if (projection.team.status === 'cancelling') {
    return createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled', reason: 'verification finished after cancellation',
    })
  }
  if (projection.team.status === 'pausing') {
    return createTeamEvent(clock, eventIds, teamId, {
      type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'verification finished after pause',
    })
  }
  return undefined
}

function assertOperationReplayCompatible(
  existing: TeamProjection['verificationVerdictOperations'][string],
  request: Pick<RecordVerificationVerdictRequest, 'teamId' | 'taskId' | 'attemptId' | 'verificationId' | 'requirements' | 'rework'>,
  operationId: string,
): void {
  if (existing === undefined || existing.taskId !== request.taskId || existing.attemptId !== request.attemptId
    || existing.verificationId !== request.verificationId || JSON.stringify(existing.requirements) !== JSON.stringify(request.requirements)
    || existing.reworkBudget?.currentAttempt !== request.rework.currentAttempt
    || existing.reworkBudget?.maxAttempts !== request.rework.maxAttempts) {
    throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Verification operation ${operationId} was reused with different content`)
  }
}

function assertPendingCollectionReplayCompatible(
  existing: CollectedVerificationVerdictRequest,
  request: CollectedVerificationVerdictRequest,
): void {
  if (existing.teamId !== request.teamId || existing.taskId !== request.taskId || existing.attemptId !== request.attemptId
    || existing.verificationId !== request.verificationId || JSON.stringify(existing.requirements) !== JSON.stringify(request.requirements)
    || existing.rework.currentAttempt !== request.rework.currentAttempt || existing.rework.maxAttempts !== request.rework.maxAttempts) {
    throw new YuqiOrchestratorError('VERIFICATION_OPERATION_CONFLICT', `Verification operation ${request.operationId} was reused with different content`)
  }
}

function collectionKey(journalKey: string, operationId: string): string {
  return JSON.stringify([journalKey, operationId])
}

async function collectWithAbort(
  collector: HostEvidenceCollectorPort,
  request: HostEvidenceCollectionRequest,
): Promise<HostEvidenceCollectionResult> {
  const signal = request.signal
  if (signal === undefined) return collector.collect(request)
  if (signal.aborted) return abortedCollection()

  let resolveAbort!: (result: HostEvidenceCollectionResult) => void
  const aborted = new Promise<HostEvidenceCollectionResult>(resolve => { resolveAbort = resolve })
  const onAbort = (): void => resolveAbort(abortedCollection())
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([collector.collect(request), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function abortedCollection(): HostEvidenceCollectionResult {
  return { kind: 'aborted', reason: 'Host evidence collection was aborted' }
}

function collectValidEvidence(inputs: readonly unknown[]): readonly StructuredEvidence[] {
  const valid: StructuredEvidence[] = []
  for (const input of inputs) {
    try {
      valid.push(parseStructuredEvidence(input))
    } catch {
      // Malformed evidence is deliberately omitted from durable facts; the resulting
      // missing check remains inconclusive and cannot advance verification to passed.
    }
  }
  return valid
}

function assertCurrentVerification(
  projection: TeamProjection,
  request: Pick<RecordVerificationVerdictRequest, 'taskId' | 'attemptId' | 'verificationId'>,
): void {
  const task = projection.tasks[request.taskId]
  const attempt = projection.attempts[request.attemptId]
  const verification = projection.verifications[request.verificationId]
  if (task === undefined || attempt === undefined || verification === undefined
    || attempt.taskId !== request.taskId || verification.taskId !== request.taskId || verification.attemptId !== request.attemptId) {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Verification ${request.verificationId} does not match the requested task attempt`)
  }
  if (task.status !== 'verifying' || verification.status !== 'running') {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Verification ${request.verificationId} is not actively running`)
  }
  /* v8 ignore next 3 -- replay invariants require an active verification to
   * target the task's latest attempt at or above verificationAttemptFloor;
   * this remains a defense against a non-replay Projection implementation. */
  if (task.attemptIds.at(-1) !== attempt.id || attempt.ordinal < task.verificationAttemptFloor) {
    throw new YuqiOrchestratorError('VERIFICATION_NOT_ALLOWED', `Verification ${request.verificationId} targets an old attempt`)
  }
}
