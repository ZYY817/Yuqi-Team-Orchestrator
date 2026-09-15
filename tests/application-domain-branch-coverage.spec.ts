import { describe, expect, it } from 'vitest'
import {
  AttemptId,
  ControlOperationId,
  DurableJournalCoordinator,
  TaskId,
  TaskRetryCoordinator,
  TeamEventId,
  TeamId,
  VerificationId,
  parseTeamEvent,
  replayTeamEvents,
  type Clock,
  type EventIdSource,
  type TeamEvent,
  type TeamEventJournal,
} from '../src/index.ts'
import { decideQualityGate } from '../src/application/quality-gate.ts'
import { summarizeTeamForConsole } from '../src/application/team-console-summary.ts'
import { teamRunDisposition } from '../src/application/run-team-loop.ts'
import { AutomaticTaskRetryCoordinator, automaticRetryOperationId } from '../src/application/verification-retry.ts'
import {
  modelCatalogFactSchema,
  providerModelRefSchema,
  providerScopeSchema,
  taskModelRequestSchema,
  teamModelPolicySchema,
} from '../src/domain/model-route.ts'
import {
  normalizeReviewPolicy,
  reviewResultSchema,
  reviewTriggerSchema,
  reviewerVerdictSchema,
  reviewUserDecisionSchema,
} from '../src/domain/review-policy.ts'
import { modelRequestForTask, teamTaskContractSchema, verificationChecksSchema } from '../src/domain/task-contract.ts'
import { ATTEMPT_ID, completeTeamEvents, contract, event, TASK_ID, TEAM_ID, VERIFICATION_ID } from './fixtures.ts'

const structuredModel = { modelProvider: 'provider-a', modelId: 'model-a' }
const check = {
  checkId: 'build', kind: 'build' as const, commandRef: 'workspace.build',
  timeoutMs: 1_000, stdoutMaxBytes: 1_000, stderrMaxBytes: 1_000,
}

class ClockStub implements Clock {
  nowIso(): string { return '2026-08-31T00:00:00Z' }
}

class Ids implements EventIdSource {
  #index = 0
  next(): string { return `branch-event-${++this.#index}` }
}

class Journal implements TeamEventJournal {
  readonly key = 'application-domain-branch-journal'
  readonly events: unknown[]
  constructor(seed: readonly unknown[]) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function retryCoordinator(): AutomaticTaskRetryCoordinator {
  return new AutomaticTaskRetryCoordinator(
    new TaskRetryCoordinator(new ClockStub(), new Ids(), new DurableJournalCoordinator()),
  )
}

function failedVerdict(operationId = 'branch-verdict'): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 13),
    event(700, {
      type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId(operationId),
      taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID,
      disposition: 'failed', requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [{
        checkId: 'build', capturedAt: '2026-08-31T00:00:00Z', kind: 'build', producer: 'build-runner',
        command: 'pnpm build', exitCode: 1, artifactDigest: 'sha256-branch',
      }],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
      rework: { action: 'retry', currentAttempt: 1, maxAttempts: 3, nextAttempt: 2, instructions: ['fix'] },
    }),
  ]
}

function parseEvent(body: Record<string, unknown>) {
  return parseTeamEvent({
    schemaVersion: 1, eventId: TeamEventId('branch-event'), teamId: TEAM_ID,
    occurredAt: '2026-08-31T00:00:00Z', ...body,
  })
}

describe('application/domain residual branch coverage', () => {
  it('covers every model-route variant, defaults, and validation rejection', () => {
    expect(providerModelRefSchema.parse({ modelProvider: ' p ', modelId: ' m ' })).toEqual({ modelProvider: 'p', modelId: 'm' })
    expect(providerScopeSchema.parse({ kind: 'controller-only' })).toEqual({ kind: 'controller-only' })
    expect(providerScopeSchema.parse({ kind: 'controller-plus-allowlist', providerAllowlist: ['a', 'b'] })).toMatchObject({ providerAllowlist: ['a', 'b'] })
    expect(providerScopeSchema.safeParse({ kind: 'controller-plus-allowlist', providerAllowlist: ['a', 'a'] }).success).toBe(false)
    expect(providerScopeSchema.safeParse({ kind: 'controller-plus-allowlist', providerAllowlist: [''] }).success).toBe(false)

    expect(teamModelPolicySchema.parse({ kind: 'inherit' })).toEqual({ kind: 'inherit' })
    expect(teamModelPolicySchema.parse({ kind: 'fixed', model: structuredModel })).toMatchObject({ kind: 'fixed' })
    expect(teamModelPolicySchema.parse({ kind: 'automatic', tierCandidates: {} })).toEqual({
      kind: 'automatic', tierCandidates: { quick: [], standard: [], critical: [] },
    })
    const automatic = teamModelPolicySchema.parse({
      kind: 'automatic', tierCandidates: { quick: [structuredModel], standard: [], critical: [structuredModel] },
    })
    expect(automatic.kind === 'automatic' ? automatic.tierCandidates.critical : []).toHaveLength(1)

    for (const request of [
      { kind: 'exact', model: structuredModel }, { kind: 'tier', tier: 'quick' },
      { kind: 'tier', tier: 'standard' }, { kind: 'tier', tier: 'critical' },
      { kind: 'default' }, { kind: 'legacy', modelId: 'legacy' },
    ]) expect(taskModelRequestSchema.safeParse(request).success).toBe(true)
    expect(taskModelRequestSchema.safeParse({ kind: 'tier', tier: 'slow' }).success).toBe(false)
    expect(taskModelRequestSchema.safeParse({ kind: 'legacy', modelId: ' ' }).success).toBe(false)
    expect(modelCatalogFactSchema.parse({ model: structuredModel, metadataResolved: false, routable: true })).toMatchObject({ routable: true })
    expect(modelCatalogFactSchema.safeParse({ model: structuredModel, metadataResolved: true }).success).toBe(false)
  })

  it('normalizes review policy and exercises all verdict invariants', () => {
    const defaults = normalizeReviewPolicy(undefined)
    expect(defaults).toMatchObject({ mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' })
    expect(Object.isFrozen(defaults)).toBe(true)
    expect(normalizeReviewPolicy({ mode: 'off' })).toMatchObject({ mode: 'off', maxReworkRounds: 2 })
    expect(normalizeReviewPolicy({ maxReworkRounds: 0, additionalPrompt: ' inspect ' })).toMatchObject({ additionalPrompt: 'inspect' })

    const finding = { severity: 'high', evidence: ['line 1'], impact: 'breaks flow', recommendation: 'fix it' }
    expect(reviewerVerdictSchema.safeParse({ decision: 'pass', findings: [], unverified: [] }).success).toBe(true)
    expect(reviewerVerdictSchema.safeParse({ decision: 'changes_required', findings: [finding], unverified: [] }).success).toBe(true)
    expect(reviewerVerdictSchema.safeParse({ decision: 'inconclusive', findings: [], unverified: ['missing host fact'] }).success).toBe(true)
    expect(reviewerVerdictSchema.safeParse({ decision: 'pass', findings: [finding], unverified: [] }).success).toBe(false)
    expect(reviewerVerdictSchema.safeParse({ decision: 'pass', findings: [], unverified: ['x'] }).success).toBe(false)
    expect(reviewerVerdictSchema.safeParse({ decision: 'changes_required', findings: [], unverified: [] }).success).toBe(false)
    expect(reviewerVerdictSchema.safeParse({ decision: 'inconclusive', findings: [], unverified: [] }).success).toBe(false)

    for (const trigger of ['plan-confirmation', 'public-contract-change', 'pre-completion', 'consecutive-failure', 'user-request', 'quality-gate', 'rework-verification']) {
      expect(reviewTriggerSchema.safeParse(trigger).success).toBe(true)
    }
    for (const decision of ['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel']) {
      expect(reviewUserDecisionSchema.safeParse(decision).success).toBe(true)
    }
    expect(reviewResultSchema.safeParse({
      reviewId: 'review', trigger: 'user-request', reviewerSessionId: 'reviewer',
      decision: 'pass', findings: [], unverified: [],
    }).success).toBe(true)
  })

  it('covers structured, legacy, verification, and review-rework task contracts', () => {
    const legacy = teamTaskContractSchema.parse(contract())
    expect(modelRequestForTask(legacy)).toEqual({ kind: 'legacy', modelId: 'deepseek-v4' })
    const { modelId: _legacyId, ...withoutLegacy } = contract()
    const exact = teamTaskContractSchema.parse({ ...withoutLegacy, modelRequest: { kind: 'exact', model: structuredModel } })
    expect(modelRequestForTask(exact)).toEqual({ kind: 'exact', model: structuredModel })
    expect(teamTaskContractSchema.safeParse(withoutLegacy).success).toBe(false)
    expect(teamTaskContractSchema.safeParse({ ...contract(), modelRequest: { kind: 'default' } }).success).toBe(false)
    expect(teamTaskContractSchema.safeParse({ ...contract(), kind: 'review-rework' }).success).toBe(false)
    expect(teamTaskContractSchema.safeParse({ ...contract(), reviewRework: { sourceReviewId: 'review', round: 1 } }).success).toBe(false)
    expect(teamTaskContractSchema.safeParse({
      ...contract(), kind: 'review-rework', reviewRework: { sourceReviewId: 'review', round: 1 },
    }).success).toBe(true)

    expect(verificationChecksSchema.safeParse([check]).success).toBe(true)
    expect(verificationChecksSchema.safeParse([check, { ...check, checkId: 'test', kind: 'test' }]).success).toBe(true)
    expect(verificationChecksSchema.safeParse([check, { ...check }]).success).toBe(false)
    expect(verificationChecksSchema.safeParse([]).success).toBe(false)
    expect(verificationChecksSchema.safeParse([{ ...check, checkId: '-bad' }]).success).toBe(false)
    expect(verificationChecksSchema.safeParse([{ ...check, timeoutMs: 0 }]).success).toBe(false)
  })

  it('validates waiver requirements and every attempt route evidence combination', () => {
    const decision = {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('decision'),
      reviewId: 'review', candidateEventId: TeamEventId('candidate'), round: 0,
    }
    expect(() => parseEvent({ ...decision, decision: 'waive' })).toThrow(/waive requires a reason/)
    expect(parseEvent({ ...decision, decision: 'waive', reason: ' accepted risk ' })).toMatchObject({ reason: 'accepted risk' })
    expect(parseEvent({ ...decision, decision: 'cancel' })).toMatchObject({ decision: 'cancel' })

    const attempt = { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1 }
    expect(() => parseEvent(attempt)).toThrow(/attempt route is required/)
    expect(() => parseEvent({ ...attempt, modelProvider: 'p' })).toThrow(/legacy flat route requires/)
    expect(() => parseEvent({ ...attempt, modelId: 'm' })).toThrow(/legacy flat route requires/)
    expect(() => parseEvent({ ...attempt, route: structuredModel, modelProvider: 'p', modelId: 'm', routeBasis: 'user-fixed', catalogEvidence: [] })).toThrow(/mutually exclusive/)
    expect(() => parseEvent({ ...attempt, modelProvider: 'p', modelId: 'm', requestedTier: 'quick' })).toThrow(/cannot claim structured routing evidence/)
    expect(() => parseEvent({ ...attempt, route: structuredModel })).toThrow(/structured routes require/)
    expect(() => parseEvent({ ...attempt, route: structuredModel, routeBasis: 'automatic' })).toThrow(/structured routes require/)
    expect(parseEvent({ ...attempt, modelProvider: 'p', modelId: 'm', routeBasis: 'user-fixed' })).toMatchObject({ modelId: 'm' })
    expect(parseEvent({
      ...attempt, route: structuredModel, routeBasis: 'automatic', requestedTier: 'critical',
      fallbackReason: 'automatic-candidates-exhausted', catalogEvidence: [{ model: structuredModel, metadataResolved: true, routable: true }],
      recoveryToken: 'safe_token-1',
    })).toMatchObject({ routeBasis: 'automatic', requestedTier: 'critical' })
  })

  it('parses direct and git recovery proofs plus unique budget alerts', () => {
    const principal = { kind: 'controller-session', sessionId: 'controller' }
    const common = { workspaceId: 'workspace', projectRoot: 'F:\\repo', volumeRoot: 'F:\\', protectedRoots: [], worktreePath: 'F:\\work', branchName: 'branch' }
    const direct = { mode: 'direct', ...common }
    const git = { ...common, repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git', baselineRef: 'abc' }
    const base = { type: 'yuqi/team-recovery-cleared', operationId: 'recover', target: 'paused', proof: { principal, childQuiescent: true, localInFlight: false, gitVerified: true } }
    expect(parseEvent({ ...base, proof: { ...base.proof, workspace: direct } })).toMatchObject({ target: 'paused' })
    expect(parseEvent({ ...base, target: 'running', proof: { ...base.proof, workspace: git } })).toMatchObject({ target: 'running' })
    expect(parseEvent({ type: 'yuqi/budget-policy-set', operationId: 'budget', revision: 1, tokenLimit: 100, alerts: [50, 80], stopBehavior: 'block-new' })).toMatchObject({ alerts: [50, 80] })
    expect(() => parseEvent({ type: 'yuqi/budget-policy-set', operationId: 'budget', revision: 1, tokenLimit: 100, alerts: [50, 50], stopBehavior: 'block-new' })).toThrow(/unique/)
  })

  it('summarizes all model request labels, routes, workspaces, extras, and attention owners', () => {
    const base = replayTeamEvents(completeTeamEvents().slice(0, 5))
    const root = base.tasks[TASK_ID]!
    const ids = [TaskId('exact'), TaskId('tier'), TaskId('default'), TaskId('blocked'), TaskId('failed')]
    const requests = [
      { kind: 'exact' as const, model: structuredModel }, { kind: 'tier' as const, tier: 'critical' as const },
      { kind: 'default' as const }, { kind: 'legacy' as const, modelId: 'legacy-b' }, { kind: 'legacy' as const, modelId: 'legacy-c' },
    ]
    const tasks = Object.fromEntries(ids.map((id, index) => [id, {
      ...root, status: index === 3 ? 'blocked' as const : index === 4 ? 'failed' as const : 'pending' as const,
      contract: { ...root.contract, taskId: id, modelId: undefined, modelRequest: requests[index], dependencies: index === 1 ? [TaskId('missing')] : [] },
      attemptIds: [], verificationIds: [],
    }]))
    const projection = { ...base, taskIds: ids, tasks, workspace: { project: { mode: 'direct' } } } as never
    const extras = {
      controllerSessionId: 'controller', projectSummary: {
        schemaVersion: 1, overallProgress: 'ready', architectureDecisions: [], pitfalls: [], conventions: [],
        documentLinks: [], updatedAt: '2026-08-31T00:00:00Z',
      },
      review: { reviewId: 'r', trigger: 'user-request', reviewerSessionId: 'v', decision: 'pass', findings: [], unverified: [] },
    } as never
    const summary = summarizeTeamForConsole(projection, extras)
    expect(summary.tasks.map(task => task.model)).toEqual(['provider-a/model-a', 'tier:critical', 'default', 'legacy-b', 'legacy-c'])
    expect(summary.tasks[1]?.dependencies).toEqual([{ taskId: 'missing', goal: 'missing', index: 0 }])
    expect(summary.team.workspaceMode).toBe('direct')
    expect(summary.attention.map(item => item.owner)).toEqual(['controller', 'controller'])
    expect(summary.controllerSessionId).toBe('controller')
    expect(summary.projectSummary).toBeDefined()
    expect(summary.review).toMatchObject({ decision: 'pass' })
    expect(summary.tasks).toHaveLength(5)
  })

  it('surfaces durable reviewer user attention and waiver details', () => {
    const candidate = TeamEventId('event-16')
    const qualityBase = completeTeamEvents().slice(0, 16).map((item, index) => index === 0
      ? { ...item, reviewPolicy: { mode: 'quality-gate' as const, maxReworkRounds: 0, additionalPrompt: '' } }
      : item) as readonly TeamEvent[]
    const awaiting = replayTeamEvents([
      ...qualityBase,
      event(710, { type: 'yuqi/review-requested', reviewId: 'review-awaiting', trigger: 'quality-gate', candidateEventId: candidate, round: 0 }),
      event(711, {
        type: 'yuqi/review-result-recorded', reviewId: 'review-awaiting', candidateEventId: candidate,
        reviewerSessionId: 'reviewer', decision: 'inconclusive', findings: [], unverified: ['missing'],
      }),
    ])
    expect(summarizeTeamForConsole(awaiting).attention.at(-1)).toMatchObject({ owner: 'user' })
    const waived = replayTeamEvents([
      ...qualityBase,
      event(712, { type: 'yuqi/review-requested', reviewId: 'review-waived', trigger: 'quality-gate', candidateEventId: candidate, round: 0 }),
      event(713, {
        type: 'yuqi/review-result-recorded', reviewId: 'review-waived', candidateEventId: candidate,
        reviewerSessionId: 'reviewer', decision: 'inconclusive', findings: [], unverified: ['missing'],
      }),
      event(714, {
        type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('waive'), reviewId: 'review-waived',
        candidateEventId: candidate, round: 0, decision: 'waive', reason: 'known limitation',
      }),
    ])
    expect(summarizeTeamForConsole(waived).review).toMatchObject({ userDecision: 'waive', waiveReason: 'known limitation' })
  })

  it('maps every run-loop stop reason without collapsing the exact reason', () => {
    expect([
      'completed', 'failed', 'cancelled', 'aborted', 'needs_reconciliation', 'paused', 'inactive', 'max-cycles', 'no-progress',
    ].map(reason => teamRunDisposition(reason as Parameters<typeof teamRunDisposition>[0]))).toEqual([
      'completed', 'failed', 'cancelled', 'needs_reconciliation', 'needs_reconciliation',
      'recoverable', 'recoverable', 'yielded', 'recoverable',
    ])
  })

  it('fails automatic retry closed for mismatched durable identities', async () => {
    expect(() => automaticRetryOperationId('   ')).toThrow(/non-empty/)
    const coordinator = retryCoordinator()
    const valid = { teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, verdictOperationId: 'branch-verdict' }
    await expect(coordinator.retry({ ...valid, teamId: TeamId('other') }, new Journal(completeTeamEvents()))).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(coordinator.retry({ ...valid, taskId: TaskId('other') }, new Journal(failedVerdict()))).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await expect(coordinator.retry({ ...valid, attemptId: AttemptId('other') }, new Journal(failedVerdict()))).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await expect(coordinator.retry({ ...valid, verificationId: VerificationId('other') }, new Journal(failedVerdict()))).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
  })

  it('covers quality-gate terminal, non-running, incomplete, missing-candidate, and legacy policy branches', () => {
    const completed = replayTeamEvents(completeTeamEvents())
    expect(decideQualityGate(completed).kind).toBe('complete')
    expect(decideQualityGate({ ...completed, team: { ...completed.team, status: 'paused' } }).kind).toBe('await-user')
    const running = replayTeamEvents(completeTeamEvents().slice(0, 5))
    expect(decideQualityGate(running).kind).toBe('verify')
    const completedTask = replayTeamEvents(completeTeamEvents().slice(0, 16))
    const { completionCandidateEventId: _candidate, ...withoutCandidate } = completedTask
    expect(decideQualityGate(withoutCandidate as typeof completedTask).kind).toBe('await-user')
    expect(decideQualityGate(completedTask).kind).toBe('complete')
  })
})
