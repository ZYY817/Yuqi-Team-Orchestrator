import { describe, expect, it } from 'vitest'
import { applyTeamEvent, replayTeamEvents } from '../src/domain/projection.ts'
import { decideQualityGate } from '../src/application/quality-gate.ts'
import { decideReviewCheckpoint } from '../src/application/review-checkpoint.ts'
import { reviewFindingFingerprint } from '../src/domain/review-policy.ts'
import { ControlOperationId, TaskId, TeamEventId } from '../src/domain/ids.ts'
import { ATTEMPT_ID, contract, completeTeamEvents, event, TASK_ID } from './fixtures.ts'

function runningCompleted(mode: 'off' | 'manual' | 'quality-gate' = 'quality-gate', maxReworkRounds = 2) {
  return replayTeamEvents([
    event(1, {
      type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin',
      reviewPolicy: { mode, maxReworkRounds, additionalPrompt: '' },
    }),
    ...completeTeamEvents().slice(1, -1),
  ])
}

describe('reviewer quality-gate state machine', () => {
  it('waits while the Team is not running and verifies incomplete tasks', () => {
    const completed = replayTeamEvents(completeTeamEvents())
    expect(decideQualityGate(completed)).toMatchObject({ kind: 'complete' })

    const running = runningCompleted()
    expect(decideQualityGate({ ...running, team: { ...running.team, status: 'paused' } })).toMatchObject({ kind: 'await-user' })
    expect(decideQualityGate({
      ...running,
      tasks: { ...running.tasks, [TASK_ID]: { ...running.tasks[TASK_ID]!, status: 'failed' } },
    })).toEqual({ kind: 'verify', taskIds: [TASK_ID], reason: 'Task graph must finish execution and verification before review' })
    const { completionCandidateEventId: _candidate, ...withoutCandidate } = running
    expect(decideQualityGate(withoutCandidate)).toMatchObject({ kind: 'await-user' })
  })

  it('does not gate legacy, off, or unrequested manual Teams', () => {
    expect(decideQualityGate(replayTeamEvents(completeTeamEvents()))).toMatchObject({ kind: 'complete' })
    expect(decideQualityGate(runningCompleted('off'))).toMatchObject({ kind: 'complete' })
    expect(decideQualityGate(runningCompleted('manual'))).toMatchObject({ kind: 'complete' })
  })

  it('requires quality-gate review even for a simple single-task Team', () => {
    const projection = runningCompleted()
    expect(decideQualityGate(projection)).toEqual({
      kind: 'review', trigger: 'quality-gate', candidateEventId: projection.completionCandidateEventId,
      round: 0, reason: 'Quality gate requires review for every completion candidate',
    })
    expect(() => applyTeamEvent(projection, event(100, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    }))).toThrow(/quality gate/u)
  })

  it('keeps plan review separate from the final completion checkpoint', () => {
    const planEventId = TeamEventId('event-1')
    const projection = replayTeamEvents([
      event(1, {
        type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(3, { type: 'yuqi/task-created', contract: contract() }),
      event(20, {
        type: 'yuqi/review-requested', reviewId: 'review-plan', trigger: 'plan-confirmation',
        candidateEventId: planEventId, round: 0, checkpointSubject: 'team-plan',
        checkpointAnchor: { eventId: planEventId },
        automaticReworkBudget: { checkpointLimit: 2, teamLimit: 6 }, independentReviewerRequired: true,
      }),
      event(21, {
        type: 'yuqi/review-result-recorded', reviewId: 'review-plan', candidateEventId: planEventId,
        reviewerSessionId: 'reviewer-plan', reviewerIndependent: true,
        decision: 'pass', findings: [], unverified: [],
      }),
      ...completeTeamEvents().slice(3, -1),
    ])
    expect(projection.reviews['review-plan']).toMatchObject({ checkpointSubject: 'team-plan', result: { decision: 'pass' } })
    expect(decideReviewCheckpoint(projection)).toMatchObject({
      kind: 'review', trigger: 'quality-gate', checkpointSubject: 'team-completion',
      candidateEventId: projection.completionCandidateEventId,
    })
  })

  it('turns changes into a new rework task and awaits user after exhaustion', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(101, {
      type: 'yuqi/review-requested', reviewId: 'review-1', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const changed = applyTeamEvent(requested, event(102, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-1', candidateEventId, reviewerSessionId: 'reviewer-1',
      decision: 'changes_required', findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'unsafe', recommendation: 'fix it' }], unverified: [],
    }))
    expect(decideQualityGate(changed)).toMatchObject({ kind: 'create-rework', sourceReviewId: 'review-1', round: 1 })
    const rework = { ...contract(TaskId('review-rework-1')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'review-1', round: 1 }, dependencies: [TASK_ID] }
    const withRework = applyTeamEvent(changed, event(103, { type: 'yuqi/task-created', contract: rework }))
    expect(withRework.tasks[TASK_ID]?.status).toBe('completed')
    expect(decideQualityGate(withRework)).toMatchObject({ kind: 'verify', taskIds: ['review-rework-1'] })

    const noRework = runningCompleted('quality-gate', 0)
    const noReworkCandidate = noRework.completionCandidateEventId!
    const exhaustedRequested = applyTeamEvent(noRework, event(104, {
      type: 'yuqi/review-requested', reviewId: 'review-final', trigger: 'quality-gate', candidateEventId: noReworkCandidate, round: 0,
    }))
    const exhausted = applyTeamEvent(exhaustedRequested, event(105, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-final', candidateEventId: noReworkCandidate, reviewerSessionId: 'reviewer-2',
      decision: 'changes_required', findings: [{ severity: 'medium', evidence: ['src/b.ts:2'], impact: 'risk', recommendation: 'inspect' }], unverified: [],
    }))
    expect(decideQualityGate(exhausted)).toMatchObject({ kind: 'await-user', reviewId: 'review-final' })
  })

  it('verifies the last permitted early rework instead of blocking it on exhausted write budget', () => {
    const base = runningCompleted('quality-gate', 1)
    const candidateEventId = base.completionCandidateEventId!
    const anchor = { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID }
    const requested = applyTeamEvent(base, event(106, {
      type: 'yuqi/review-requested', reviewId: 'last-rework', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt', checkpointAnchor: anchor,
      automaticReworkBudget: { checkpointLimit: 1, teamLimit: 1 },
    }))
    const changed = applyTeamEvent(requested, event(107, {
      type: 'yuqi/review-result-recorded', reviewId: 'last-rework', candidateEventId,
      reviewerSessionId: 'reviewer-last', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'broken', recommendation: 'repair' }], unverified: [],
    }))
    const reworkId = TaskId('last-permitted-rework')
    const pending = applyTeamEvent(changed, event(108, { type: 'yuqi/task-created', contract: {
      ...contract(reworkId), kind: 'review-rework', dependencies: [TASK_ID],
      reviewRework: { sourceReviewId: 'last-rework', round: 1 },
    } }))
    const target = { subject: 'task-attempt' as const, anchor, candidateEventId }
    expect(decideReviewCheckpoint(pending, target)).toMatchObject({ kind: 'verify', taskIds: [reworkId] })
    const finished = { ...pending, tasks: { ...pending.tasks, [reworkId]: { ...pending.tasks[reworkId]!, status: 'completed' as const } } }
    expect(decideReviewCheckpoint(finished, target)).toMatchObject({ kind: 'review', trigger: 'rework-verification', round: 1 })
  })

  it('fails closed for a stale review candidate', () => {
    const projection = runningCompleted()
    const candidateEventId = projection.completionCandidateEventId!
    const requested = applyTeamEvent(projection, event(110, {
      type: 'yuqi/review-requested', reviewId: 'review-stale', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const stale = { ...requested, completionCandidateEventId: 'different-candidate' as never }
    expect(decideQualityGate(stale)).toMatchObject({ kind: 'await-user', reviewId: 'review-stale' })
  })

  it('covers requested, pass, retry, waive, and terminal user decisions', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(130, {
      type: 'yuqi/review-requested', reviewId: 'review-decisions', trigger: 'user-request', candidateEventId, round: 0,
    }))
    expect(decideQualityGate(requested)).toMatchObject({ kind: 'review', trigger: 'user-request', round: 0 })

    const passed = applyTeamEvent(requested, event(131, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-decisions', candidateEventId,
      reviewerSessionId: 'reviewer-pass', decision: 'pass', findings: [], unverified: [],
    }))
    expect(decideQualityGate(passed)).toMatchObject({ kind: 'complete' })

    const inconclusive = applyTeamEvent(requested, event(132, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-decisions', candidateEventId,
      reviewerSessionId: 'reviewer-inconclusive', decision: 'inconclusive', findings: [], unverified: ['environment unavailable'],
    }))

    for (const [decision, reason, expected] of [
      ['waive', 'accepted risk', 'complete'],
      ['retry_review', undefined, 'review'],
      ['fail', undefined, 'await-user'],
      ['cancel', undefined, 'await-user'],
    ] as const) {
      const decided = applyTeamEvent(inconclusive, event(140 + decision.length, {
        type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId(`decision-${decision}`),
        reviewId: 'review-decisions', candidateEventId, round: 0, decision,
        ...(reason === undefined ? {} : { reason }),
      }))
      expect(decideQualityGate(decided)).toMatchObject({ kind: expected })
      if (decision === 'retry_review') {
        expect(decideQualityGate(decided)).toMatchObject({ retryKey: 'decision-retry_review' })
      }
    }
  })

  it('prioritizes unfinished verification across pending, exhausted, and user-decided reviews', () => {
    const base = runningCompleted('quality-gate', 0)
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(150, {
      type: 'yuqi/review-requested', reviewId: 'review-combinations', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    expect(decideQualityGate(requested)).toEqual({
      kind: 'review', trigger: 'quality-gate', candidateEventId, round: 0,
      reason: 'Durable review request has no result',
    })
    expect(decideQualityGate({
      ...requested,
      tasks: { ...requested.tasks, [TASK_ID]: { ...requested.tasks[TASK_ID]!, status: 'verifying' } },
    })).toEqual({
      kind: 'verify', taskIds: [TASK_ID], reason: 'Task graph must finish execution and verification before review',
    })

    const exhausted = applyTeamEvent(requested, event(151, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-combinations', candidateEventId,
      reviewerSessionId: 'reviewer-combinations', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'unsafe', recommendation: 'repair' }], unverified: [],
    }))
    expect(decideQualityGate(exhausted)).toEqual({
      kind: 'await-user', reviewId: 'review-combinations', reason: 'Review is inconclusive or its rework budget is exhausted',
    })

    for (const [decision, reason, expectedKind] of [
      ['retry_review', undefined, 'review'],
      ['authorize_final_rework', undefined, 'create-rework'],
      ['waive', 'risk accepted', 'complete'],
      ['fail', undefined, 'await-user'],
      ['cancel', undefined, 'await-user'],
    ] as const) {
      const decided = applyTeamEvent(exhausted, event(152 + decision.length, {
        type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId(`combination-${decision}`),
        reviewId: 'review-combinations', candidateEventId, round: 0, decision,
        ...(reason === undefined ? {} : { reason }),
      }))
      expect(decideQualityGate(decided)).toMatchObject({ kind: expectedKind })
      expect(decideQualityGate({
        ...decided,
        tasks: { ...decided.tasks, [TASK_ID]: { ...decided.tasks[TASK_ID]!, status: 'verifying' } },
      })).toEqual({
        kind: 'verify', taskIds: [TASK_ID], reason: 'Task graph must finish execution and verification before review',
      })
    }
  })

  it('handles authorized final rework before and after verification', () => {
    const base = runningCompleted('quality-gate', 0)
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(160, {
      type: 'yuqi/review-requested', reviewId: 'review-final-rework', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const changed = applyTeamEvent(requested, event(161, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-final-rework', candidateEventId,
      reviewerSessionId: 'reviewer-final', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/final.ts:1'], impact: 'broken', recommendation: 'repair' }], unverified: [],
    }))
    const authorized = applyTeamEvent(changed, event(162, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('authorize-final'), reviewId: 'review-final-rework',
      candidateEventId, round: 0, decision: 'authorize_final_rework',
    }))
    expect(decideQualityGate(authorized)).toMatchObject({ kind: 'create-rework', sourceReviewId: 'review-final-rework' })

    const reworkContract = {
      ...contract(TaskId('final-rework')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'review-final-rework', round: 1 }, dependencies: [TASK_ID],
    }
    const withRework = applyTeamEvent(authorized, event(163, { type: 'yuqi/task-created', contract: reworkContract }))
    expect(decideQualityGate(withRework)).toMatchObject({ kind: 'verify', taskIds: ['final-rework'] })

    const completedRework = {
      ...withRework,
      tasks: { ...withRework.tasks, 'final-rework': { ...withRework.tasks['final-rework']!, status: 'completed' as const } },
    }
    expect(decideQualityGate(completedRework)).toMatchObject({ kind: 'review', trigger: 'rework-verification' })
  })

  it('keeps pending and retried nonzero review rounds in rework-verification', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(170, {
      type: 'yuqi/review-requested', reviewId: 'round-review', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const pendingRoundOne = {
      ...requested,
      reviews: {
        ...requested.reviews,
        'round-review': { ...requested.reviews['round-review']!, trigger: 'rework-verification' as const, round: 1 },
      },
    }
    expect(decideQualityGate(pendingRoundOne)).toEqual({
      kind: 'review', trigger: 'rework-verification', candidateEventId, round: 1,
      reason: 'Durable review request has no result',
    })

    const inconclusive = applyTeamEvent(requested, event(171, {
      type: 'yuqi/review-result-recorded', reviewId: 'round-review', candidateEventId,
      reviewerSessionId: 'round-reviewer', decision: 'inconclusive', findings: [], unverified: ['runtime unavailable'],
    }))
    const retried = applyTeamEvent(inconclusive, event(172, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('retry-round'),
      reviewId: 'round-review', candidateEventId, round: 0, decision: 'retry_review',
    }))
    const retriedRoundOne = {
      ...retried,
      reviews: { ...retried.reviews, 'round-review': { ...retried.reviews['round-review']!, round: 1 } },
    }
    expect(decideQualityGate(retriedRoundOne)).toMatchObject({
      kind: 'review', trigger: 'rework-verification', candidateEventId, round: 1,
    })
  })

  it('combines stale candidates with rework verification and preserves exhausted user ownership', () => {
    const base = runningCompleted('quality-gate', 1)
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(180, {
      type: 'yuqi/review-requested', reviewId: 'stale-rework-review', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const changed = applyTeamEvent(requested, event(181, {
      type: 'yuqi/review-result-recorded', reviewId: 'stale-rework-review', candidateEventId,
      reviewerSessionId: 'stale-reviewer', decision: 'changes_required',
      findings: [{ severity: 'medium', evidence: ['src/rework.ts:1'], impact: 'incomplete', recommendation: 'finish' }], unverified: [],
    }))
    const reworkContract = {
      ...contract(TaskId('stale-rework-task')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'stale-rework-review', round: 1 }, dependencies: [TASK_ID],
    }
    const withRework = applyTeamEvent(changed, event(182, { type: 'yuqi/task-created', contract: reworkContract }))
    expect(decideQualityGate(withRework)).toEqual({
      kind: 'verify', taskIds: [TaskId('stale-rework-task')],
      reason: 'Task graph must finish execution and verification before review',
    })

    const newCandidate = 'candidate-after-rework' as never
    const verifiedRework = {
      ...withRework,
      completionCandidateEventId: newCandidate,
      tasks: {
        ...withRework.tasks,
        'stale-rework-task': { ...withRework.tasks['stale-rework-task']!, status: 'completed' as const },
      },
    }
    expect(decideQualityGate(verifiedRework)).toEqual({
      kind: 'review', trigger: 'rework-verification', candidateEventId: newCandidate, round: 1,
      reason: 'Completed rework produced a new candidate requiring verification review',
    })

    const exhaustedRequest = applyTeamEvent(verifiedRework, event(183, {
      type: 'yuqi/review-requested', reviewId: 'exhausted-review', trigger: 'rework-verification',
      candidateEventId: newCandidate, round: 1,
    }))
    const exhausted = applyTeamEvent(exhaustedRequest, event(184, {
      type: 'yuqi/review-result-recorded', reviewId: 'exhausted-review', candidateEventId: newCandidate,
      reviewerSessionId: 'exhausted-reviewer', decision: 'changes_required',
      findings: [{ severity: 'low', evidence: ['src/rework.ts:2'], impact: 'residual', recommendation: 'decide' }], unverified: [],
    }))
    expect(decideQualityGate(exhausted)).toEqual({
      kind: 'await-user', reviewId: 'exhausted-review',
      reason: 'Review is inconclusive or its rework budget is exhausted',
    })
  })

  it('forbids adding any ordinary task after a Team is terminal', () => {
    const completed = replayTeamEvents(completeTeamEvents())
    expect(() => applyTeamEvent(completed, event(120, {
      type: 'yuqi/task-created', contract: contract(TaskId('late-task')),
    }))).toThrow(/terminal Team/u)
  })

  it('persists checkpoint identity, independence, fingerprints, and controller-owned exhaustion', () => {
    const base = runningCompleted('quality-gate', 1)
    const candidateEventId = base.completionCandidateEventId!
    const anchor = { eventId: String(candidateEventId) }
    const requested = applyTeamEvent(base, event(990, {
      type: 'yuqi/review-requested', reviewId: 'checkpoint-review', trigger: 'quality-gate', candidateEventId, round: 0,
      checkpointSubject: 'team-completion', checkpointAnchor: anchor,
      automaticReworkBudget: { checkpointLimit: 1, teamLimit: 2 }, independentReviewerRequired: true,
    }))
    const finding = { severity: 'high' as const, evidence: ['src/checkpoint.ts:1'], impact: 'unsafe', recommendation: 'repair' }
    const changed = applyTeamEvent(requested, event(991, {
      type: 'yuqi/review-result-recorded', reviewId: 'checkpoint-review', candidateEventId,
      reviewerSessionId: 'independent-reviewer', reviewerIndependent: true,
      decision: 'changes_required', findings: [finding], findingFingerprints: [reviewFindingFingerprint(finding)], unverified: [],
    }))
    expect(changed.reviews['checkpoint-review']).toMatchObject({
      checkpointSubject: 'team-completion', checkpointAnchor: anchor, phase: 'reworking',
      independentReviewerRequired: true,
      reviewerIndependent: true, findingFingerprints: [reviewFindingFingerprint(finding)],
    })
    expect(decideReviewCheckpoint(changed)).toMatchObject({
      kind: 'create-rework', authorityMode: 'write-authorized', sourceReviewId: 'checkpoint-review',
    })

    const { result: _result, userDecision: _userDecision, ...repeatedReviewBase } = changed.reviews['checkpoint-review']!
    const repeatedRequest = {
      ...changed,
      reviews: {
        ...changed.reviews,
        repeated: { ...repeatedReviewBase, id: 'repeated', status: 'requested' as const, phase: 'reviewing' as const },
      },
      reviewIds: [...changed.reviewIds, 'repeated'],
    }
    const repeated = applyTeamEvent(repeatedRequest, event(992, {
      type: 'yuqi/review-result-recorded', reviewId: 'repeated', candidateEventId,
      reviewerSessionId: 'second-independent-reviewer', reviewerIndependent: true,
      decision: 'changes_required', findings: [finding], findingFingerprints: [reviewFindingFingerprint(finding)], unverified: [],
    }))
    expect(repeated.reviews.repeated).toMatchObject({ phase: 'awaiting-controller', status: 'awaiting_user' })
    expect(decideReviewCheckpoint(repeated)).toMatchObject({ kind: 'awaiting-controller', reviewId: 'repeated' })
  })

  it('rejects a forged independent reviewer session and full-access automatic rework', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(995, {
      type: 'yuqi/review-requested', reviewId: 'independent-review', trigger: 'quality-gate', candidateEventId, round: 0,
      checkpointSubject: 'team-completion', checkpointAnchor: { eventId: String(candidateEventId) }, independentReviewerRequired: true,
    }))
    expect(() => applyTeamEvent(requested, event(996, {
      type: 'yuqi/review-result-recorded', reviewId: 'independent-review', candidateEventId,
      reviewerSessionId: String(Object.values(base.attempts)[0]!.agentSessionId), reviewerIndependent: true,
      decision: 'pass', findings: [], findingFingerprints: [], unverified: [],
    }))).toThrow(/independent reviewer/u)

    const finding = { severity: 'high' as const, evidence: ['src/full.ts:1'], impact: 'unsafe', recommendation: 'repair' }
    const changed = applyTeamEvent(requested, event(997, {
      type: 'yuqi/review-result-recorded', reviewId: 'independent-review', candidateEventId,
      reviewerSessionId: 'independent', reviewerIndependent: true,
      decision: 'changes_required', findings: [finding], findingFingerprints: [reviewFindingFingerprint(finding)], unverified: [],
    }))
    expect(() => applyTeamEvent(changed, event(998, {
      type: 'yuqi/task-created', contract: {
        ...contract(TaskId('full-access-rework')), authorityMode: 'full-access', kind: 'review-rework',
        reviewRework: { sourceReviewId: 'independent-review', round: 1 }, dependencies: [TASK_ID],
      },
    }))).toThrow(/write-authorized/u)
  })

  it('routes explicit checkpoint subjects and enforces both automatic rework budgets', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!

    for (const [subject, trigger] of [
      ['team-plan', 'plan-confirmation'],
      ['failure-escalation', 'consecutive-failure'],
      ['task-attempt', 'quality-gate'],
    ] as const) {
      expect(decideReviewCheckpoint(base, {
        subject,
        anchor: { eventId: candidateEventId, taskId: TASK_ID },
        candidateEventId,
        independentReviewerRequired: false,
      })).toMatchObject({
        kind: 'review', trigger, checkpointSubject: subject,
        independentReviewerRequired: false,
        reason: `Durable ${subject} checkpoint requires independent review`,
      })
    }

    expect(decideReviewCheckpoint(base, {
      subject: 'team-plan', anchor: { eventId: candidateEventId }, candidateEventId,
      round: 1, automaticReworkBudget: { checkpointLimit: 1, teamLimit: 2 },
    })).toMatchObject({ kind: 'awaiting-controller', reason: expect.stringContaining('round zero') })
    expect(decideReviewCheckpoint(base, {
      subject: 'team-plan', anchor: { eventId: candidateEventId }, candidateEventId,
      round: 0, automaticReworkBudget: { checkpointLimit: 1, teamLimit: 0 },
    })).toMatchObject({ kind: 'awaiting-controller', reason: expect.stringContaining('exceeds') })
    expect(decideReviewCheckpoint(base, {
      subject: 'team-plan', anchor: { eventId: candidateEventId }, candidateEventId,
      round: 0, automaticReworkBudget: { checkpointLimit: 0, teamLimit: 0 },
    })).toMatchObject({ kind: 'review', round: 0 })

    const legacyPolicyShape = {
      ...base,
      team: { ...base.team, reviewPolicy: { ...base.team.reviewPolicy!, maxReworkRounds: undefined } },
    }
    expect(decideReviewCheckpoint(legacyPolicyShape as unknown as typeof base, {
      subject: 'team-plan', anchor: { eventId: candidateEventId }, candidateEventId,
    })).toMatchObject({
      kind: 'review', automaticReworkBudget: { checkpointLimit: 2, teamLimit: 6 },
    })
  })

  it('matches an explicit checkpoint only when every anchor field agrees', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const anchor = { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID }
    const requested = applyTeamEvent(base, event(1_010, {
      type: 'yuqi/review-requested', reviewId: 'anchored-review', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt', checkpointAnchor: anchor,
      automaticReworkBudget: { checkpointLimit: 2, teamLimit: 6 }, independentReviewerRequired: true,
    }))

    expect(decideReviewCheckpoint(requested, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'review', trigger: 'pre-completion' })

    for (const target of [
      { subject: 'team-plan' as const, anchor },
      { subject: 'task-attempt' as const, anchor: { ...anchor, eventId: TeamEventId('other-event') } },
      { subject: 'task-attempt' as const, anchor: { ...anchor, taskId: TaskId('other-task') } },
      { subject: 'task-attempt' as const, anchor: { ...anchor, attemptId: 'other-attempt' as never } },
    ]) {
      expect(decideReviewCheckpoint(requested, {
        ...target, candidateEventId,
      })).toMatchObject({ kind: 'review' })
    }
  })

  it('fails closed for stale changed checkpoints until their rework is completed', () => {
    const base = runningCompleted()
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(1_020, {
      type: 'yuqi/review-requested', reviewId: 'stale-changed', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt',
      checkpointAnchor: { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID },
    }))
    const changed = applyTeamEvent(requested, event(1_021, {
      type: 'yuqi/review-result-recorded', reviewId: 'stale-changed', candidateEventId,
      reviewerSessionId: 'stale-changed-reviewer', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'unsafe', recommendation: 'repair' }],
      unverified: [],
    }))
    expect(decideReviewCheckpoint(changed, {
      subject: 'task-attempt', anchor: { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID },
      candidateEventId: TeamEventId('new-candidate'),
    })).toMatchObject({ kind: 'awaiting-controller', reviewId: 'stale-changed' })

    const reworkContract = {
      ...contract(TaskId('stale-pending-rework')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'stale-changed', round: 1 }, dependencies: [TASK_ID],
    }
    const withPendingRework = applyTeamEvent(changed, event(1_022, { type: 'yuqi/task-created', contract: reworkContract }))
    expect(decideReviewCheckpoint(withPendingRework, {
      subject: 'task-attempt', anchor: { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID },
      candidateEventId: TeamEventId('newer-candidate'),
    })).toMatchObject({ kind: 'awaiting-controller', reviewId: 'stale-changed' })
  })

  it('covers target-scoped rework verification, task limits, and unusable results', () => {
    const base = runningCompleted('quality-gate', 2)
    const candidateEventId = base.completionCandidateEventId!
    const anchor = { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID }
    const requested = applyTeamEvent(base, event(1_030, {
      type: 'yuqi/review-requested', reviewId: 'target-rework', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt', checkpointAnchor: anchor,
    }))
    const changed = applyTeamEvent(requested, event(1_031, {
      type: 'yuqi/review-result-recorded', reviewId: 'target-rework', candidateEventId,
      reviewerSessionId: 'target-reviewer', decision: 'changes_required',
      findings: [{ severity: 'medium', evidence: ['src/target.ts:1'], impact: 'incomplete', recommendation: 'finish' }],
      unverified: [],
    }))
    const ordinaryPendingContract = {
      ...contract(TaskId('ordinary-pending-rework')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'target-rework', round: 1 }, dependencies: [TASK_ID],
    }
    const withOrdinaryPendingRework = applyTeamEvent(changed, event(1_032, {
      type: 'yuqi/task-created', contract: ordinaryPendingContract,
    }))
    expect(decideReviewCheckpoint(withOrdinaryPendingRework, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'verify', taskIds: ['ordinary-pending-rework'] })

    const authorized = {
      ...changed,
      reviews: {
        ...changed.reviews,
        'target-rework': {
          ...changed.reviews['target-rework']!,
          userDecision: {
            operationId: ControlOperationId('target-authorize'), reviewId: 'target-rework',
            candidateEventId, round: 0, decision: 'authorize_final_rework' as const,
          },
        },
      },
    }
    const reworkContract = {
      ...contract(TaskId('target-pending-rework')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'target-rework', round: 1 }, dependencies: [TASK_ID],
    }
    const withPendingRework = applyTeamEvent(authorized, event(1_033, { type: 'yuqi/task-created', contract: reworkContract }))
    expect(decideReviewCheckpoint(withPendingRework, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'verify', taskIds: ['target-pending-rework'] })

    const completedRework = {
      ...withPendingRework,
      tasks: {
        ...withPendingRework.tasks,
        'target-pending-rework': { ...withPendingRework.tasks['target-pending-rework']!, status: 'completed' as const },
      },
    }
    expect(decideReviewCheckpoint(completedRework, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'review', trigger: 'rework-verification' })

    const ordinaryTask = base.tasks[TASK_ID]!
    const taskIds = Array.from({ length: 100 }, (_, index) => TaskId(`limit-task-${index}`))
    const atTaskLimit = {
      ...changed,
      taskIds,
      tasks: Object.fromEntries(taskIds.map(taskId => [taskId, {
        ...ordinaryTask,
        contract: { ...ordinaryTask.contract, taskId },
      }])),
    }
    expect(decideReviewCheckpoint(atTaskLimit as typeof changed, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'awaiting-controller', reason: expect.stringContaining('task limit') })

    const unusable = {
      ...requested,
      reviews: {
        ...requested.reviews,
        'target-rework': {
          ...requested.reviews['target-rework']!, status: 'completed' as const, phase: 'satisfied' as const,
        },
      },
    }
    expect(decideReviewCheckpoint(unusable, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'awaiting-controller', reason: expect.stringContaining('no usable durable result') })

    const legacyIndependence = {
      ...requested,
      reviews: {
        ...requested.reviews,
        'target-rework': {
          ...requested.reviews['target-rework']!, independentReviewerRequired: undefined as never,
        },
      },
    }
    expect(decideReviewCheckpoint(legacyIndependence, {
      subject: 'task-attempt', anchor, candidateEventId,
    })).toMatchObject({ kind: 'review', independentReviewerRequired: false })
  })
})
