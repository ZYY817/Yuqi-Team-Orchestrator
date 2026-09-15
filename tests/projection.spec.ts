import { describe, expect, it } from 'vitest'
import {
  applyTeamEvent,
  AttemptId,
  checkpointAutomaticReworkCount,
  consecutiveTaskVerificationFailures,
  ControlOperationId,
  replayTeamEvents,
  reviewAutomaticReworkBudget,
  TaskId,
  TeamEventId,
  TeamId,
  VerificationId,
  WorkspaceId,
  FileLeaseId,
  YuqiDomainError,
} from '../src/index.ts'
import type { TeamEvent } from '../src/index.ts'
import type { ReviewCheckpointAnchor } from '../src/domain/review-policy.ts'
import { ATTEMPT_ID, completeTeamEvents, contract, event, TASK_ID, TEAM_ID, VERIFICATION_ID } from './fixtures.ts'

describe('Team projection', () => {
  function expectCode(action: () => unknown, code: YuqiDomainError['code']): void {
    try {
      action()
      expect.unreachable('operation should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(YuqiDomainError)
      expect((error as YuqiDomainError).code).toBe(code)
    }
  }

  function reviewCandidateEvents(maxReworkRounds = 1): readonly TeamEvent[] {
    return [
      event(1, {
        type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, -1),
    ]
  }

  function recoveryWorkspace() {
    return {
      workspaceId: WorkspaceId('recovery-workspace'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\recovery', branchName: 'yuqi/recovery', status: 'provisioning' as const,
    }
  }

  function recoveryWorkspaceProof() {
    const workspace = recoveryWorkspace()
    return {
      workspaceId: workspace.workspaceId, projectRoot: workspace.project.projectRoot,
      repositoryRoot: workspace.project.repositoryRoot, gitCommonDirectory: workspace.project.gitCommonDirectory,
      baselineRef: workspace.project.baselineRef, volumeRoot: workspace.project.volumeRoot,
      protectedRoots: workspace.project.protectedRoots, worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
    }
  }

  it('rebuilds a completed Team from the complete event sequence', () => {
    const state = replayTeamEvents(completeTeamEvents())

    expect(state.team).toEqual({
      id: TEAM_ID, startedAt: '2026-08-15T00:00:02Z', endedAt: '2026-08-15T00:00:17Z',
      title: 'Yuqi Team', objective: 'Build the plugin', locale: 'zh', status: 'completed', directWriteStrategy: 'planned-scope-parallel',
    })
    expect(state.tasks[TASK_ID]).toMatchObject({ status: 'completed', attemptIds: [ATTEMPT_ID], verificationIds: [VERIFICATION_ID] })
    expect(state.attempts[ATTEMPT_ID]).toMatchObject({
      startedAt: '2026-08-15T00:00:08Z', endedAt: '2026-08-15T00:00:10Z',
      status: 'completed', ordinal: 1, agentSessionId: 'session-worker-1', messageId: 'message-1', evidence: { runId: 'run-1', stopReason: 'completed' },
    })
    expect(state.verifications[VERIFICATION_ID]).toMatchObject({ status: 'passed', verifierSessionId: 'session-verifier-1' })
    expect(Object.keys(state.appliedEventFingerprints)).toHaveLength(17)
    expect(state.attempts[ATTEMPT_ID]?.route).toBeUndefined()
    expect(state.attempts[ATTEMPT_ID]?.routeBasis).toBeUndefined()
  })

  it('replays a structured attempt route with immutable decision evidence', () => {
    const catalogEvidence = [{
      model: { modelProvider: 'allowed-provider', modelId: 'tier-model' },
      metadataResolved: true,
      routable: true,
    }]
    const structuredAttempt = AttemptId('structured-attempt')
    const state = replayTeamEvents([...completeTeamEvents().slice(0, 5), event(170, {
      type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: structuredAttempt, ordinal: 1,
      route: { modelProvider: 'allowed-provider', modelId: 'tier-model' },
      routeBasis: 'automatic', requestedTier: 'critical', catalogEvidence,
    })])

    expect(state.attempts[structuredAttempt]).toMatchObject({
      route: { modelProvider: 'allowed-provider', modelId: 'tier-model' },
      modelProvider: 'allowed-provider', modelId: 'tier-model', routeBasis: 'automatic',
      requestedTier: 'critical', catalogEvidence,
    })
  })

  it('records only monotonic live usage for the admitted running child', () => {
    const usage = { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 }
    const active = [...completeTeamEvents().slice(0, 8), event(90, {
      type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      agentSessionId: 'session-worker-1', usage,
    })]
    expect(replayTeamEvents(active).attempts[ATTEMPT_ID]?.observedUsage).toEqual(usage)
    expectCode(() => replayTeamEvents([...active, event(91, {
      type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      agentSessionId: 'session-worker-1', usage: { ...usage, outputTokens: 3 },
    })]), 'INVALID_EVENT')
    expectCode(() => replayTeamEvents([...active, event(92, {
      type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      agentSessionId: 'another-child', usage,
    })]), 'REFERENCE_MISMATCH')
  })

  it('rejects terminal usage that is lower than a persisted live observation', () => {
    const usage = { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 }
    const active = [...completeTeamEvents().slice(0, 8), event(93, {
      type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      agentSessionId: 'session-worker-1', usage,
    }), event(94, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'settled',
    })]
    expectCode(() => replayTeamEvents([...active, event(95, {
      type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'run-lower',
      agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true,
      usage: { ...usage, outputTokens: 3 }, settledAt: '2026-08-15T00:01:35Z',
    })]), 'INVALID_EVENT')
  })

  it('rejects Task completion without a durable passed verdict or completed settlement', () => {
    const activeVerification = completeTeamEvents().slice(0, 13)
    const completedAttempt = event(180, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      from: 'settled', to: 'completed',
    })
    expectCode(() => replayTeamEvents([...activeVerification, completedAttempt, event(181, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const withoutAttempt = completeTeamEvents().slice(0, 5)
    expectCode(() => replayTeamEvents([...withoutAttempt, event(182, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying',
    }), event(183, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const withoutVerification = [...completeTeamEvents().slice(0, 11), event(184, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      from: 'settled', to: 'completed',
    })]
    expectCode(() => replayTeamEvents([...withoutVerification, event(185, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const noEvidence = completeTeamEvents().slice(0, 9)
    expectCode(() => replayTeamEvents([...noEvidence, event(186, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      from: 'settled', to: 'completed',
    }), event(187, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }), event(188, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed',
    })]), 'INVALID_TRANSITION')
  })

  it('rejects Task completion when settlement exists but the latest verdict failed', () => {
    const failedVerdict = event(189, {
      type: 'yuqi/verification-verdict-recorded',
      operationId: ControlOperationId('failed-before-completion'),
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      verificationId: VERIFICATION_ID,
      disposition: 'failed',
      requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [{
        checkId: 'build', capturedAt: '2026-08-15T00:00:19Z', kind: 'build', producer: 'build-runner',
        command: 'pnpm run build', exitCode: 1, artifactDigest: 'sha256-failed-build',
      }],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
      rework: { action: 'stop', currentAttempt: 1, maxAttempts: 1, instructions: ['Fix the build'] },
    })
    expectCode(() => replayTeamEvents([
      ...completeTeamEvents().slice(0, 13),
      failedVerdict,
      event(190, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' }),
      event(191, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed' }),
    ]), 'INVALID_TRANSITION')
  })

  it('rejects unknown latest attempts and incomplete Tasks from completing the Team', () => {
    const activeVerification = completeTeamEvents().slice(0, 13)
    expectCode(() => replayTeamEvents([...activeVerification, event(185, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      from: 'settled', to: 'unknown',
    }), event(186, {
      type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed',
    })]), 'INVALID_TRANSITION')

    expectCode(() => replayTeamEvents([...activeVerification, event(186, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const teamUnknownAttempt = [...activeVerification, event(187, {
      type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      from: 'settled', to: 'unknown',
    }), event(188, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]
    expectCode(() => replayTeamEvents(teamUnknownAttempt), 'INVALID_TRANSITION')

    const incompleteTask = [...activeVerification, event(189, {
      type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      verificationId: VERIFICATION_ID, from: 'running', to: 'failed',
    }), event(190, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]
    expectCode(() => replayTeamEvents(incompleteTask), 'INVALID_TRANSITION')

    expectCode(() => replayTeamEvents([...completeTeamEvents().slice(0, 13), event(191, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')
  })

  it('keeps a prior admitted terminal attempt without evidence as a Team reconciliation gap after retry', () => {
    const retryAttempt = AttemptId('attempt-2')
    const retryVerification = VerificationId('verification-2')
    const events = [
      ...completeTeamEvents().slice(0, 8),
      event(201, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }),
      event(202, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(203, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-gap'), taskId: TASK_ID }),
      event(204, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(205, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: retryAttempt, ordinal: 2, modelProvider: 'p', modelId: 'm' }),
      event(206, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: retryAttempt, agentSessionId: 'session-worker-2', messageId: 'message-2' }),
      event(207, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'dispatching', to: 'running' }),
      event(208, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'running', to: 'settled' }),
      event(209, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: retryAttempt, runId: 'run-2', agentSessionId: 'session-worker-2', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T00:02:09Z' }),
      event(210, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(211, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification, verifierSessionId: 'session-verifier-2' }),
      event(212, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification, from: 'pending', to: 'running' }),
      event(213, { type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId('retry-gap-verdict'), taskId: TASK_ID, attemptId: retryAttempt, verificationId: retryVerification, disposition: 'passed', requirements: [{ checkId: 'build', kind: 'build' }], evidence: [{ checkId: 'build', capturedAt: '2026-08-15T00:02:13Z', kind: 'build', producer: 'build-runner', command: 'pnpm run build', exitCode: 0, artifactDigest: 'sha256-retry-build' }], reasons: [] }),
      event(214, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'settled', to: 'completed' }),
      event(215, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed' }),
      event(216, { type: 'yuqi/team-status-changed', from: 'running', to: 'completed' }),
    ]
    expectCode(() => replayTeamEvents(events), 'INVALID_TRANSITION')
  })

  it('rejects Team completion while a durable file lease, incomplete workspace, or reconciliation gap remains', () => {
    const workspace = {
      workspaceId: WorkspaceId('completion-workspace'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\completion', branchName: 'yuqi/completion', status: 'provisioning' as const,
    }
    const withLease = [
      ...completeTeamEvents().slice(0, 16),
      event(188, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(189, { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('completion-workspace') }),
      event(190, { type: 'yuqi/file-lease-acquired', lease: {
        leaseId: FileLeaseId('completion-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active',
      } }),
    ]
    expectCode(() => replayTeamEvents([...withLease, event(191, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const withWorkspaceProvisioning = [
      ...completeTeamEvents().slice(0, 16),
      event(192, { type: 'yuqi/workspace-provisioning-started', workspace }),
    ]
    expectCode(() => replayTeamEvents([...withWorkspaceProvisioning, event(193, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const withWorkspaceGap = [
      ...completeTeamEvents().slice(0, 16),
      event(194, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(195, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WorkspaceId('completion-workspace'), reason: 'drift' }),
    ]
    expectCode(() => replayTeamEvents([...withWorkspaceGap, event(196, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')

    const withTeamReconciliationGap = [
      ...completeTeamEvents().slice(0, 16),
      event(197, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
      event(198, { type: 'yuqi/team-status-changed', from: 'needs_reconciliation', to: 'completed' }),
    ]
    expectCode(() => replayTeamEvents(withTeamReconciliationGap), 'INVALID_TRANSITION')
  })

  it('rejects Task completion when an older verification remains active', () => {
    const secondVerification = VerificationId('verification-second')
    const events = [
      ...completeTeamEvents().slice(0, 13),
      event(199, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: secondVerification, verifierSessionId: 'session-verifier-2' }),
      event(200, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: secondVerification, from: 'pending', to: 'running' }),
      event(201, { type: 'yuqi/verification-verdict-recorded', operationId: ControlOperationId('second-verdict'), taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: secondVerification, disposition: 'passed', requirements: [{ checkId: 'build', kind: 'build' }], evidence: [{ checkId: 'build', capturedAt: '2026-08-15T00:02:01Z', kind: 'build', producer: 'build-runner', command: 'pnpm run build', exitCode: 0, artifactDigest: 'sha256-second-build' }], reasons: [] }),
      event(202, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' }),
      event(203, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed' }),
    ]
    expectCode(() => replayTeamEvents(events), 'INVALID_TRANSITION')
  })

  it('rejects Team completion while a normally active attempt is still running', () => {
    expectCode(() => replayTeamEvents([...completeTeamEvents().slice(0, 8), event(204, {
      type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
    })]), 'INVALID_TRANSITION')
  })

  it('rejects completion against an old verification after retry', () => {
    const retryAttempt = AttemptId('attempt-old-verification-retry')
    const events = [
      ...completeTeamEvents().slice(0, 13),
      event(205, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, from: 'running', to: 'failed' }),
      event(206, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-old-verification'), taskId: TASK_ID }),
      event(207, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(208, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: retryAttempt, ordinal: 2, modelProvider: 'p', modelId: 'm' }),
      event(209, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: retryAttempt, agentSessionId: 'session-worker-retry', messageId: 'message-retry' }),
      event(210, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'dispatching', to: 'running' }),
      event(211, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: retryAttempt, from: 'running', to: 'settled' }),
      event(212, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: retryAttempt, runId: 'run-old-verification-retry', agentSessionId: 'session-worker-retry', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T00:02:12Z' }),
      event(213, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(214, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed' }),
    ]
    expectCode(() => replayTeamEvents(events), 'INVALID_TRANSITION')
  })

  it('returns the same projection for duplicate event delivery', () => {
    const events = completeTeamEvents()
    const state = replayTeamEvents(events)
    expect(applyTeamEvent(state, events[16]!, 17)).toBe(state)
  })

  it('clears recovery only through matching durable proof and preserves operation identity', () => {
    const workspace = recoveryWorkspace()
    const needsRecovery = replayTeamEvents([
      event(700, { type: 'yuqi/team-created', title: 'Recovery Team', objective: 'Recover safely' }),
      event(701, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(702, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(703, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
      event(704, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    expectCode(() => applyTeamEvent(needsRecovery, event(705, {
      type: 'yuqi/team-status-changed', from: 'needs_reconciliation', to: 'paused',
    })), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent(needsRecovery, event(706, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('clear-recovery'), target: 'paused',
      proof: {
        principal: { kind: 'controller-session', sessionId: 'controller-1' }, childQuiescent: true,
        localInFlight: false, gitVerified: true,
        workspace: { ...recoveryWorkspaceProof(), baselineRef: 'different-commit' },
      },
    })), 'REFERENCE_MISMATCH')

    const clear = (index: number, target: 'paused' | 'running' = 'paused', sessionId = 'controller-1') => event(index, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('clear-recovery'), target,
      proof: {
        principal: { kind: 'controller-session', sessionId }, childQuiescent: true,
        localInFlight: false, gitVerified: true, workspace: recoveryWorkspaceProof(),
      },
    })
    const cleared = applyTeamEvent(needsRecovery, clear(707))
    expect(cleared.team.status).toBe('paused')
    expect(cleared.recoveryClearOperations['clear-recovery']).toEqual({
      id: 'clear-recovery', target: 'paused', principal: { kind: 'controller-session', sessionId: 'controller-1' },
    })
    expect(applyTeamEvent(cleared, clear(708)).recoveryClearOperations).toEqual(cleared.recoveryClearOperations)
    expectCode(() => applyTeamEvent(cleared, clear(709, 'running')), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => applyTeamEvent(cleared, clear(710, 'paused', 'controller-2')), 'ENTITY_ALREADY_EXISTS')
  })

  it('enforces review request and result ownership for one completion candidate', () => {
    const base = replayTeamEvents(reviewCandidateEvents())
    const candidateEventId = base.completionCandidateEventId!
    const requested = replayTeamEvents([...reviewCandidateEvents(), event(720, {
      type: 'yuqi/review-requested', reviewId: 'review-owned', trigger: 'quality-gate', candidateEventId, round: 0,
    })])
    expect(requested.reviews['review-owned']).toMatchObject({
      automaticReworkBudget: { checkpointLimit: 1, teamLimit: 6 },
      independentReviewerRequired: false,
    })
    expectCode(() => applyTeamEvent(requested, event(721, {
      type: 'yuqi/review-requested', reviewId: 'review-concurrent', trigger: 'quality-gate', candidateEventId, round: 0,
    })), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent(base, event(722, {
      type: 'yuqi/review-requested', reviewId: 'review-stale', trigger: 'quality-gate', candidateEventId: TeamEventId('stale-candidate'), round: 0,
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(requested, event(723, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-owned', candidateEventId: TeamEventId('stale-candidate'),
      reviewerSessionId: 'reviewer', decision: 'pass', findings: [], unverified: [],
    })), 'REFERENCE_MISMATCH')

    const passed = applyTeamEvent(requested, event(724, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-owned', candidateEventId,
      reviewerSessionId: 'reviewer', decision: 'pass', findings: [], unverified: [],
    }))
    expect(passed.reviews['review-owned']).toMatchObject({ status: 'completed', result: { decision: 'pass' } })
    expectCode(() => applyTeamEvent(passed, event(725, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-owned', candidateEventId,
      reviewerSessionId: 'reviewer-2', decision: 'inconclusive', findings: [], unverified: ['not checked'],
    })), 'ENTITY_ALREADY_EXISTS')
  })

  it('keeps review user decisions idempotent, cycle-bound, and single-resolution', () => {
    const base = replayTeamEvents(reviewCandidateEvents())
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(730, {
      type: 'yuqi/review-requested', reviewId: 'review-user', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const awaiting = applyTeamEvent(requested, event(731, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-user', candidateEventId,
      reviewerSessionId: 'reviewer', decision: 'inconclusive', findings: [], unverified: ['runtime unavailable'],
    }))
    const decision = (index: number, operationId = 'user-resolution', value: 'retry_review' | 'fail' = 'retry_review') => event(index, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId(operationId),
      reviewId: 'review-user', candidateEventId, round: 0, decision: value,
    })
    expectCode(() => applyTeamEvent(requested, decision(732)), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent(awaiting, event(733, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('stale-resolution'),
      reviewId: 'review-user', candidateEventId: TeamEventId('stale-candidate'), round: 0, decision: 'retry_review',
    })), 'REFERENCE_MISMATCH')

    const decided = applyTeamEvent(awaiting, decision(734))
    expect(decided.reviewUserDecisionOperations['user-resolution']).toMatchObject({
      reviewId: 'review-user', candidateEventId, round: 0, decision: 'retry_review',
    })
    expect(applyTeamEvent(decided, decision(735)).reviewUserDecisionOperations).toEqual(decided.reviewUserDecisionOperations)
    expectCode(() => applyTeamEvent(decided, decision(736, 'user-resolution', 'fail')), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => applyTeamEvent(decided, decision(737, 'second-resolution', 'fail')), 'INVALID_TRANSITION')
  })

  it('accepts only one correctly sourced next-round review rework task', () => {
    const base = replayTeamEvents(reviewCandidateEvents())
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(740, {
      type: 'yuqi/review-requested', reviewId: 'review-rework-source', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const changed = applyTeamEvent(requested, event(741, {
      type: 'yuqi/review-result-recorded', reviewId: 'review-rework-source', candidateEventId,
      reviewerSessionId: 'reviewer', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'broken', recommendation: 'repair' }], unverified: [],
    }))
    const reworkContract = (taskId: string, sourceReviewId = 'review-rework-source', round = 1) => ({
      ...contract(TaskId(taskId)), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId, round }, dependencies: [TASK_ID],
    })
    expectCode(() => applyTeamEvent(changed, event(742, {
      type: 'yuqi/task-created', contract: reworkContract('wrong-source', 'missing-review'),
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(changed, event(743, {
      type: 'yuqi/task-created', contract: reworkContract('wrong-round', 'review-rework-source', 2),
    })), 'INVALID_TASK_CONTRACT')

    const withRework = applyTeamEvent(changed, event(744, {
      type: 'yuqi/task-created', contract: reworkContract('review-rework-1'),
    }))
    expect(withRework.tasks['review-rework-1']).toMatchObject({
      status: 'pending', contract: { kind: 'review-rework', reviewRework: { sourceReviewId: 'review-rework-source', round: 1 } },
    })
    expectCode(() => applyTeamEvent(withRework, event(745, {
      type: 'yuqi/task-created', contract: reworkContract('duplicate-rework'),
    })), 'ENTITY_ALREADY_EXISTS')
  })

  it('rejects different event content that reuses an applied event id', () => {
    const events = completeTeamEvents()
    const state = replayTeamEvents(events.slice(0, 2))
    const collision = { ...events[1]!, to: 'failed' as const }
    try {
      applyTeamEvent(state, collision, 2)
      expect.unreachable('collision should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(YuqiDomainError)
      expect((error as YuqiDomainError).code).toBe('EVENT_ID_COLLISION')
    }
  })

  it('does not mutate an earlier projection', () => {
    const created = applyTeamEvent(undefined, completeTeamEvents()[0]!, 0)
    const snapshot = structuredClone(created)
    const running = applyTeamEvent(created, completeTeamEvents()[1]!, 1)
    expect(created).toEqual(snapshot)
    expect(running).not.toBe(created)
    expect(running.team.status).toBe('running')
  })

  it('accepts a revision that advances by one and keeps prior views immutable', () => {
    const initial = replayTeamEvents(completeTeamEvents().slice(0, 4))
    const revisedContract = contract(TASK_ID, 2)
    const revised = applyTeamEvent(initial, event(20, { type: 'yuqi/task-revised', contract: revisedContract }), 4)
    expect(initial.tasks[TASK_ID]?.contract.revision).toBe(1)
    expect(revised.tasks[TASK_ID]?.contract.revision).toBe(2)
  })

  it('rejects contract revision after task execution has started', () => {
    const running = completeTeamEvents().slice(0, 6)
    expectCode(() => replayTeamEvents([...running, event(201, {
      type: 'yuqi/task-revised', contract: contract(TASK_ID, 2),
    })]), 'INVALID_TRANSITION')
  })

  it('rejects attempt creation unless its task is running', () => {
    const ready = completeTeamEvents().slice(0, 4)
    expectCode(() => replayTeamEvents([...ready, event(202, {
      type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: AttemptId('ready-attempt'), ordinal: 1,
      modelProvider: 'p', modelId: 'm',
    })]), 'INVALID_TRANSITION')
  })

  it('accepts topologically ordered task dependencies', () => {
    const firstTask = TaskId('task-first')
    const events = [
      event(1, { type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build' }),
      event(2, { type: 'yuqi/task-created', contract: contract(firstTask) }),
      event(3, { type: 'yuqi/task-created', contract: contract(TASK_ID, 1, [firstTask]) }),
    ]
    expect(replayTeamEvents(events).tasks[TASK_ID]?.contract.dependencies).toEqual([firstTask])
    expect(replayTeamEvents(events).taskIds).toEqual([firstTask, TASK_ID])
  })

  it('rejects a dependency cycle introduced by task revision', () => {
    const firstTask = TaskId('cycle-first')
    const secondTask = TaskId('cycle-second')
    const inputs = [
      event(90, { type: 'yuqi/team-created', title: 'Cycle', objective: 'Reject cycles' }),
      event(91, { type: 'yuqi/task-created', contract: contract(firstTask) }),
      event(92, { type: 'yuqi/task-created', contract: contract(secondTask, 1, [firstTask]) }),
      event(93, { type: 'yuqi/task-revised', contract: contract(firstTask, 2, [secondTask]) }),
    ]
    expectCode(() => replayTeamEvents(inputs), 'INVALID_TASK_CONTRACT')
  })

  it('rejects the one-hundred-first Team task', () => {
    const inputs: TeamEvent[] = [event(100, { type: 'yuqi/team-created', title: 'Bounded', objective: 'Limit tasks' })]
    for (let index = 1; index <= 101; index += 1) {
      const taskId = TaskId(`bounded-${index}`)
      inputs.push(event(100 + index, { type: 'yuqi/task-created', contract: contract(taskId) }))
    }
    expectCode(() => replayTeamEvents(inputs), 'INVALID_TASK_CONTRACT')
  })

  it.each([
    ['missing Team', [event(1, { type: 'yuqi/task-created', contract: contract() })], 'TEAM_NOT_CREATED'],
    ['empty stream', [], 'TEAM_NOT_CREATED'],
    ['second Team creation', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/team-created', title: 'B', objective: 'B' })], 'TEAM_ALREADY_CREATED'],
    ['wrong Team id', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }, TeamId('other'))], 'TEAM_ID_MISMATCH'],
    ['missing dependency', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/task-created', contract: contract(TASK_ID, 1, [TaskId('missing')]) })], 'ENTITY_NOT_FOUND'],
    ['self dependency', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/task-created', contract: contract(TASK_ID, 1, [TASK_ID]) })], 'INVALID_TASK_CONTRACT'],
    ['duplicate dependency', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/task-created', contract: contract(TaskId('base')) }), event(3, { type: 'yuqi/task-created', contract: contract(TASK_ID, 1, [TaskId('base'), TaskId('base')]) })], 'INVALID_TASK_CONTRACT'],
    ['new task revision', [event(1, { type: 'yuqi/team-created', title: 'A', objective: 'A' }), event(2, { type: 'yuqi/task-created', contract: contract(TASK_ID, 2) })], 'INVALID_TASK_REVISION'],
  ])('rejects %s', (_name, inputs, code) => {
    try {
      replayTeamEvents(inputs)
      expect.unreachable('replay should reject')
    } catch (error) {
      expect(error).toBeInstanceOf(YuqiDomainError)
      expect((error as YuqiDomainError).code).toBe(code)
    }
  })

  it('rejects duplicate entities, bad ordinals, and mismatched references', () => {
    const base = completeTeamEvents().slice(0, 7)
    const duplicateTask = event(30, { type: 'yuqi/task-created', contract: contract() })
    expect(() => replayTeamEvents([...base, duplicateTask])).toThrowError(YuqiDomainError)

    const badOrdinal = event(31, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: AttemptId('attempt-2'), ordinal: 3, modelProvider: 'p', modelId: 'm' })
    expect(() => replayTeamEvents([...base, badOrdinal])).toThrowError(YuqiDomainError)

    const wrongTask = event(32, { type: 'yuqi/attempt-status-changed', taskId: TaskId('other'), attemptId: ATTEMPT_ID, from: 'running', to: 'settled' })
    expect(() => replayTeamEvents([...base, wrongTask])).toThrowError(YuqiDomainError)

    const missingVerification = event(33, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('missing'), from: 'pending', to: 'running' })
    expect(() => replayTeamEvents([...base, missingVerification])).toThrowError(YuqiDomainError)
  })

  it('rejects stale from-states and invalid revised contracts', () => {
    const created = completeTeamEvents()[0]!
    expectCode(() => replayTeamEvents([created, event(40, { type: 'yuqi/team-status-changed', from: 'running', to: 'failed' })]), 'INVALID_TRANSITION')

    const withTask = completeTeamEvents().slice(0, 4)
    expectCode(() => replayTeamEvents([...withTask, event(41, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' })]), 'INVALID_TRANSITION')
    expectCode(() => replayTeamEvents([...withTask, event(42, { type: 'yuqi/task-revised', contract: contract(TASK_ID, 3) })]), 'INVALID_TASK_REVISION')

    const withAttempt = completeTeamEvents().slice(0, 7)
    expectCode(() => replayTeamEvents([...withAttempt, event(43, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' })]), 'INVALID_TRANSITION')

    const withVerification = completeTeamEvents().slice(0, 13)
    expectCode(() => replayTeamEvents([...withVerification, event(44, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, from: 'pending', to: 'passed' })]), 'INVALID_TRANSITION')
  })

  it('rejects missing entities and duplicate attempt or verification ids', () => {
    const created = completeTeamEvents()[0]!
    expectCode(() => replayTeamEvents([created, event(50, { type: 'yuqi/task-status-changed', taskId: TaskId('missing'), from: 'pending', to: 'ready' })]), 'ENTITY_NOT_FOUND')
    expectCode(() => replayTeamEvents([created, event(51, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: AttemptId('missing'), from: 'running', to: 'settled' })]), 'ENTITY_NOT_FOUND')

    const withAttempt = completeTeamEvents().slice(0, 8)
    expectCode(() => replayTeamEvents([...withAttempt, event(52, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 2, modelProvider: 'p', modelId: 'm' })]), 'ENTITY_ALREADY_EXISTS')

    const withVerification = completeTeamEvents().slice(0, 13)
    expectCode(() => replayTeamEvents([...withVerification, event(53, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, verifierSessionId: 's' })]), 'ENTITY_ALREADY_EXISTS')
  })

  it('rejects verification references that disagree with the attempt and recorded verification', () => {
    const secondTask = TaskId('task-2')
    const setup = [
      ...completeTeamEvents().slice(0, 8),
      event(60, { type: 'yuqi/task-created', contract: contract(secondTask) }),
    ]
    expectCode(() => replayTeamEvents([...setup, event(61, { type: 'yuqi/verification-created', taskId: secondTask, attemptId: ATTEMPT_ID, verificationId: VerificationId('v2'), verifierSessionId: 's' })]), 'REFERENCE_MISMATCH')

    const withVerification = completeTeamEvents().slice(0, 13)
    expectCode(() => replayTeamEvents([...withVerification, event(62, { type: 'yuqi/verification-status-changed', taskId: secondTask, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, from: 'pending', to: 'running' })]), 'REFERENCE_MISMATCH')
    expectCode(() => replayTeamEvents([...withVerification, event(63, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: AttemptId('other'), verificationId: VERIFICATION_ID, from: 'pending', to: 'running' })]), 'REFERENCE_MISMATCH')
  })

  it('starts verification only for the current settled attempt with durable evidence', () => {
    const verification = (attemptId: ReturnType<typeof AttemptId>, index: number) => event(index, {
      type: 'yuqi/verification-created', taskId: TASK_ID, attemptId,
      verificationId: VerificationId(`verification-${index}`), verifierSessionId: 'verifier',
    })
    expectCode(() => replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(64, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      verification(ATTEMPT_ID, 65),
    ]), 'INVALID_TRANSITION')
    expectCode(() => replayTeamEvents([
      ...completeTeamEvents().slice(0, 9),
      event(66, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      verification(ATTEMPT_ID, 67),
    ]), 'INVALID_TRANSITION')

    const newerAttempt = AttemptId('attempt-2')
    const twoSettledAttempts = [
      ...completeTeamEvents().slice(0, 11),
      event(68, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'failed' }),
      event(681, { type: 'yuqi/task-retry-requested', operationId: ControlOperationId('retry-for-current-attempt'), taskId: TASK_ID }),
      event(682, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(683, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: newerAttempt, ordinal: 2, modelProvider: 'p', modelId: 'm' }),
      event(684, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: newerAttempt, agentSessionId: 'child-2', messageId: 'message-2' }),
      event(685, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: newerAttempt, from: 'dispatching', to: 'running' }),
      event(686, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: newerAttempt, from: 'running', to: 'settled' }),
      event(687, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: newerAttempt, runId: 'run-2', agentSessionId: 'child-2', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T04:01:00Z' }),
      event(688, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
    ]
    expectCode(() => replayTeamEvents([...twoSettledAttempts, verification(ATTEMPT_ID, 689)]), 'INVALID_TRANSITION')
  })

  it('enforces attempt admission identity, ordering, and uniqueness', () => {
    const createdAttempt = completeTeamEvents().slice(0, 6)
    expectCode(() => replayTeamEvents([...createdAttempt, event(69, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'running' })]), 'INVALID_TRANSITION')
    expectCode(() => replayTeamEvents([...createdAttempt, event(70, { type: 'yuqi/attempt-admitted', taskId: TaskId('other'), attemptId: ATTEMPT_ID, agentSessionId: 'child', messageId: 'message' })]), 'REFERENCE_MISMATCH')

    const admitted = completeTeamEvents().slice(0, 7)
    expectCode(() => replayTeamEvents([...admitted, event(71, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'child-2', messageId: 'message-2' })]), 'ENTITY_ALREADY_EXISTS')

    const failedBeforeAdmission = [
      ...createdAttempt,
      event(72, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'failed' }),
    ]
    expectCode(() => replayTeamEvents([...failedBeforeAdmission, event(73, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'child', messageId: 'message' })]), 'INVALID_TRANSITION')

    const secondTask = TaskId('same-child-second-task')
    const secondAttempt = AttemptId('same-child-second-attempt')
    const sameChildTwice = [
      ...completeTeamEvents().slice(0, 8),
      event(74, { type: 'yuqi/task-created', contract: contract(secondTask) }),
      event(75, { type: 'yuqi/task-status-changed', taskId: secondTask, from: 'pending', to: 'ready' }),
      event(76, { type: 'yuqi/task-status-changed', taskId: secondTask, from: 'ready', to: 'running' }),
      event(77, { type: 'yuqi/attempt-created', taskId: secondTask, attemptId: secondAttempt, ordinal: 1, modelProvider: 'p', modelId: 'm' }),
      event(78, { type: 'yuqi/attempt-admitted', taskId: secondTask, attemptId: secondAttempt, agentSessionId: 'session-worker-1', messageId: 'message-second' }),
    ]
    expectCode(() => replayTeamEvents(sameChildTwice), 'ENTITY_ALREADY_EXISTS')
  })

  it('binds a recovered child only through its durable recovery token without inventing admission evidence', () => {
    const recoveryToken = 'recovery_token_1'
    const recoverable = [
      ...completeTeamEvents().slice(0, 5),
      event(90, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'p', modelId: 'm', recoveryToken }),
    ]
    const recovered = event(91, { type: 'yuqi/attempt-child-recovered', taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'recovered-child', recoveryToken })
    const state = replayTeamEvents([...recoverable, recovered])
    expect(state.attempts[ATTEMPT_ID]).toMatchObject({ agentSessionId: 'recovered-child', recoveryToken })
    expect(state.attempts[ATTEMPT_ID]?.messageId).toBeUndefined()
    expect(applyTeamEvent(state, recovered)).toBe(state)
    expect(applyTeamEvent(state, event(911, {
      type: 'yuqi/attempt-child-recovered', taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'recovered-child', recoveryToken,
    })).attempts[ATTEMPT_ID]).toBe(state.attempts[ATTEMPT_ID])
    expectCode(() => replayTeamEvents([...recoverable, recovered, event(92, {
      type: 'yuqi/attempt-child-recovered', taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'other-child', recoveryToken,
    })]), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => replayTeamEvents([...recoverable, event(93, {
      type: 'yuqi/attempt-child-recovered', taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'recovered-child', recoveryToken: 'wrong_token',
    })]), 'REFERENCE_MISMATCH')
    expectCode(() => replayTeamEvents([...recoverable, event(94, {
      type: 'yuqi/attempt-child-recovered', taskId: TaskId('wrong-task'), attemptId: ATTEMPT_ID, childSessionId: 'recovered-child', recoveryToken,
    })]), 'REFERENCE_MISMATCH')
    expectCode(() => replayTeamEvents([...recoverable,
      event(95, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'failed' }),
      event(96, { type: 'yuqi/attempt-child-recovered', taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'recovered-child', recoveryToken }),
    ]), 'INVALID_TRANSITION')

    const otherTask = TaskId('other-recovery-task')
    const otherAttempt = AttemptId('other-recovery-attempt')
    const collision = [
      ...recoverable,
      recovered,
      event(97, { type: 'yuqi/task-created', contract: contract(otherTask) }),
      event(98, { type: 'yuqi/task-status-changed', taskId: otherTask, from: 'pending', to: 'ready' }),
      event(99, { type: 'yuqi/task-status-changed', taskId: otherTask, from: 'ready', to: 'running' }),
      event(100, { type: 'yuqi/attempt-created', taskId: otherTask, attemptId: otherAttempt, ordinal: 1, modelProvider: 'p', modelId: 'm', recoveryToken: 'other_token' }),
      event(101, { type: 'yuqi/attempt-child-recovered', taskId: otherTask, attemptId: otherAttempt, childSessionId: 'recovered-child', recoveryToken: 'other_token' }),
    ]
    expectCode(() => replayTeamEvents(collision), 'ENTITY_ALREADY_EXISTS')
  })

  it('treats opaque special ids as own dictionary keys without prototype semantics', () => {
    const specialTask = TaskId('__proto__')
    const specialAttempt = AttemptId('constructor')
    const specialVerification = VerificationId('toString')
    const created = { ...event(100, { type: 'yuqi/team-created', title: 'Special IDs', objective: 'Keep ids opaque' }), eventId: TeamEventId('hasOwnProperty') }
    const inputs = [
      created,
      event(101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(102, { type: 'yuqi/task-created', contract: contract(specialTask) }),
      event(103, { type: 'yuqi/task-status-changed', taskId: specialTask, from: 'pending', to: 'ready' }),
      event(104, { type: 'yuqi/task-status-changed', taskId: specialTask, from: 'ready', to: 'running' }),
      event(105, { type: 'yuqi/attempt-created', taskId: specialTask, attemptId: specialAttempt, ordinal: 1, modelProvider: 'p', modelId: 'm' }),
      event(106, { type: 'yuqi/attempt-admitted', taskId: specialTask, attemptId: specialAttempt, agentSessionId: 'child', messageId: 'message' }),
      event(107, { type: 'yuqi/attempt-status-changed', taskId: specialTask, attemptId: specialAttempt, from: 'dispatching', to: 'running' }),
      event(108, { type: 'yuqi/attempt-status-changed', taskId: specialTask, attemptId: specialAttempt, from: 'running', to: 'settled' }),
      event(109, { type: 'yuqi/attempt-evidence-recorded', taskId: specialTask, attemptId: specialAttempt, runId: 'run', agentSessionId: 'child', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T04:00:00Z' }),
      event(110, { type: 'yuqi/task-status-changed', taskId: specialTask, from: 'running', to: 'verifying' }),
      event(111, { type: 'yuqi/verification-created', taskId: specialTask, attemptId: specialAttempt, verificationId: specialVerification, verifierSessionId: 'verifier' }),
    ]
    const state = replayTeamEvents(inputs)

    expect(Object.hasOwn(state.tasks, specialTask)).toBe(true)
    expect(Object.hasOwn(state.attempts, specialAttempt)).toBe(true)
    expect(Object.hasOwn(state.verifications, specialVerification)).toBe(true)
    expect(Object.hasOwn(state.appliedEventFingerprints, 'hasOwnProperty')).toBe(true)
    expect(Object.getPrototypeOf(state.tasks)).toBeNull()
    expect(Object.getPrototypeOf(state.attempts)).toBeNull()
    expect(Object.getPrototypeOf(state.verifications)).toBeNull()
    expect(applyTeamEvent(state, created)).toBe(state)
  })

  it('enforces settlement evidence ownership, terminal ordering, and uniqueness', () => {
    const evidence = { type: 'yuqi/attempt-evidence-recorded' as const, taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'run-x', agentSessionId: 'session-worker-1', provider: 'p', stopReason: 'completed', hasAssistantOutput: false, settledAt: '2026-08-15T02:00:00Z' }
    const running = completeTeamEvents().slice(0, 8)
    expectCode(() => replayTeamEvents([...running, event(80, evidence)]), 'INVALID_TRANSITION')

    const settled = completeTeamEvents().slice(0, 9)
    expectCode(() => replayTeamEvents([...settled, event(81, { ...evidence, taskId: TaskId('other') })]), 'REFERENCE_MISMATCH')
    expectCode(() => replayTeamEvents([...settled, event(82, { ...evidence, agentSessionId: 'other-child' })]), 'REFERENCE_MISMATCH')

    const withEvidence = completeTeamEvents().slice(0, 10)
    expectCode(() => replayTeamEvents([...withEvidence, event(83, evidence)]), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => replayTeamEvents([
      ...settled,
      event(84, { ...evidence, stopReason: 'error' }),
    ]), 'INVALID_TRANSITION')

    const usage = { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 }
    const projected = replayTeamEvents([...settled, event(85, { ...evidence, runId: 'run-usage', usage })])
    expect(projected.attempts[ATTEMPT_ID]?.evidence?.usage).toEqual(usage)
  })

  it('rejects a parsed event object carrying an unsupported version', () => {
    const incompatible = { ...completeTeamEvents()[0]!, schemaVersion: 2 } as unknown as TeamEvent
    expectCode(() => applyTeamEvent(undefined, incompatible, 0), 'UNSUPPORTED_SCHEMA_VERSION')
  })

  it('clears recovery only with matching durable workspace proof and idempotent command facts', () => {
    const workspaceId = WorkspaceId('projection-recovery-workspace')
    const workspace = {
      workspaceId,
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-recovery', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\projection-recovery', branchName: 'yuqi/projection-recovery', status: 'provisioning' as const,
    }
    const recoverable = replayTeamEvents([
      ...completeTeamEvents().slice(0, -1),
      event(900, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(901, { type: 'yuqi/workspace-provisioned', workspaceId }),
      event(902, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const workspaceProof = {
      workspaceId, projectRoot: workspace.project.projectRoot, repositoryRoot: workspace.project.repositoryRoot,
      gitCommonDirectory: workspace.project.gitCommonDirectory, baselineRef: workspace.project.baselineRef,
      volumeRoot: workspace.project.volumeRoot, protectedRoots: [], worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
    }
    const clearProof = {
      principal: { kind: 'controller-session' as const, sessionId: 'controller-projection' },
      childQuiescent: true, localInFlight: false, gitVerified: true, workspace: workspaceProof,
    } as const
    const clear = event(903, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('projection-clear'), target: 'paused', proof: clearProof,
    })
    const cleared = applyTeamEvent(recoverable, clear)
    expect(cleared.team.status).toBe('paused')
    expect(cleared.recoveryClearOperations['projection-clear']).toMatchObject({
      target: 'paused', principal: { sessionId: 'controller-projection' },
    })
    const repeatedClear = applyTeamEvent(cleared, event(904, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('projection-clear'), target: 'paused', proof: clearProof,
    }))
    expect(repeatedClear.team).toEqual(cleared.team)
    expect(repeatedClear.recoveryClearOperations).toEqual(cleared.recoveryClearOperations)

    expectCode(() => applyTeamEvent(recoverable, event(905, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('bad-proof-clear'), target: 'paused',
      proof: { ...clearProof, workspace: { ...workspaceProof, baselineRef: 'other-commit' } },
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(cleared, event(906, {
      type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId('projection-clear'), target: 'running', proof: clearProof,
    })), 'ENTITY_ALREADY_EXISTS')
  })

  it('enforces review request, result, and user-decision cycle identity', () => {
    const completedGraph = replayTeamEvents([
      event(920, {
        type: 'yuqi/team-created', title: 'Review projection', objective: 'Keep review cycles durable',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, -1),
    ])
    const candidateEventId = completedGraph.completionCandidateEventId!
    const request = event(921, {
      type: 'yuqi/review-requested', reviewId: 'projection-review', trigger: 'quality-gate', candidateEventId, round: 0,
    })
    const requested = applyTeamEvent(completedGraph, request)
    expect(requested.reviews['projection-review']).toMatchObject({ status: 'requested', round: 0, candidateEventId })
    expectCode(() => applyTeamEvent(requested, event(922, {
      type: 'yuqi/review-requested', reviewId: 'parallel-review', trigger: 'quality-gate', candidateEventId, round: 0,
    })), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent(completedGraph, event(923, {
      type: 'yuqi/review-requested', reviewId: 'stale-review', trigger: 'quality-gate',
      candidateEventId: TeamEventId('stale-candidate'), round: 0,
    })), 'REFERENCE_MISMATCH')

    const inconclusiveResult = event(924, {
      type: 'yuqi/review-result-recorded', reviewId: 'projection-review', candidateEventId,
      reviewerSessionId: 'reviewer-projection', decision: 'inconclusive', findings: [], unverified: ['missing runtime'],
    })
    const awaiting = applyTeamEvent(requested, inconclusiveResult)
    expect(awaiting.reviews['projection-review']?.status).toBe('awaiting_user')
    expectCode(() => applyTeamEvent(awaiting, event(925, {
      type: 'yuqi/review-result-recorded', reviewId: 'projection-review', candidateEventId,
      reviewerSessionId: 'reviewer-projection', decision: 'inconclusive', findings: [], unverified: ['missing runtime'],
    })), 'ENTITY_ALREADY_EXISTS')

    const waive = event(926, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('projection-waive'),
      reviewId: 'projection-review', candidateEventId, round: 0, decision: 'waive', reason: 'accepted risk',
    })
    const waived = applyTeamEvent(awaiting, waive)
    expect(waived.reviews['projection-review']?.userDecision).toMatchObject({ decision: 'waive', reason: 'accepted risk' })
    const repeatedWaive = applyTeamEvent(waived, event(927, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('projection-waive'),
      reviewId: 'projection-review', candidateEventId, round: 0, decision: 'waive', reason: 'accepted risk',
    }))
    expect(repeatedWaive.reviews).toEqual(waived.reviews)
    expect(repeatedWaive.reviewUserDecisionOperations).toEqual(waived.reviewUserDecisionOperations)
    expectCode(() => applyTeamEvent(waived, event(928, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('projection-waive'),
      reviewId: 'projection-review', candidateEventId, round: 0, decision: 'cancel',
    })), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => applyTeamEvent(awaiting, event(929, {
      type: 'yuqi/review-user-decision-recorded', operationId: ControlOperationId('stale-waive'),
      reviewId: 'projection-review', candidateEventId, round: 1, decision: 'waive', reason: 'accepted risk',
    })), 'REFERENCE_MISMATCH')
  })

  it('allows one review rework task and rejects forged round, source, or duplicate provenance', () => {
    const base = replayTeamEvents([
      event(940, {
        type: 'yuqi/team-created', title: 'Rework projection', objective: 'Bound reviewer rework',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, -1),
    ])
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(941, {
      type: 'yuqi/review-requested', reviewId: 'rework-source', trigger: 'quality-gate', candidateEventId, round: 0,
    }))
    const changed = applyTeamEvent(requested, event(942, {
      type: 'yuqi/review-result-recorded', reviewId: 'rework-source', candidateEventId,
      reviewerSessionId: 'reviewer-rework', decision: 'changes_required',
      findings: [{ severity: 'high', evidence: ['src/a.ts:1'], impact: 'unsafe', recommendation: 'repair' }], unverified: [],
    }))
    const reworkContract = {
      ...contract(TaskId('projection-rework')), kind: 'review-rework' as const,
      reviewRework: { sourceReviewId: 'rework-source', round: 1 }, dependencies: [TASK_ID],
    }
    const withRework = applyTeamEvent(changed, event(943, { type: 'yuqi/task-created', contract: reworkContract }))
    expect(withRework.tasks['projection-rework']?.contract.reviewRework).toEqual({ sourceReviewId: 'rework-source', round: 1 })

    expectCode(() => applyTeamEvent(withRework, event(944, {
      type: 'yuqi/task-created',
      contract: { ...reworkContract, taskId: TaskId('duplicate-rework'), inputDigest: 'duplicate-rework' },
    })), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => applyTeamEvent(changed, event(945, {
      type: 'yuqi/task-created',
      contract: { ...reworkContract, taskId: TaskId('wrong-round-rework'), inputDigest: 'wrong-round', reviewRework: { sourceReviewId: 'rework-source', round: 2 } },
    })), 'INVALID_TASK_CONTRACT')
    expectCode(() => applyTeamEvent(changed, event(946, {
      type: 'yuqi/task-created',
      contract: { ...reworkContract, taskId: TaskId('forged-source-rework'), inputDigest: 'forged-source', reviewRework: { sourceReviewId: 'missing-review', round: 1 } },
    })), 'REFERENCE_MISMATCH')
  })

  it('records task-stop intent idempotently and rejects unsafe or conflicting targets', () => {
    const running = completeTeamEvents().slice(0, 8)
    const stop = event(880, {
      type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-task-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
    })
    const stoppedIntent = replayTeamEvents([...running, stop])
    expect(stoppedIntent.controlOperations['stop-task-1']).toEqual({
      id: 'stop-task-1', action: 'stop-task', taskId: TASK_ID, attemptId: ATTEMPT_ID,
    })
    expect(replayTeamEvents([...running, stop, event(881, {
      type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-task-1'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
    })]).controlOperations['stop-task-1']).toEqual(stoppedIntent.controlOperations['stop-task-1'])
    expectCode(() => replayTeamEvents([...running, stop, event(882, {
      type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-task-1'), taskId: TASK_ID, attemptId: AttemptId('attempt-other'),
    })]), 'ENTITY_ALREADY_EXISTS')

    expectCode(() => replayTeamEvents([
      ...running,
      event(883, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('shared-stop'), action: 'pause' }),
      event(884, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(885, { type: 'yuqi/task-stop-requested', operationId: ControlOperationId('shared-stop'), taskId: TASK_ID, attemptId: ATTEMPT_ID }),
    ]), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => replayTeamEvents([
      ...running,
      event(893, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('shared-budget-stop'), revision: 1, tokenLimit: 10_000, alerts: [80], stopBehavior: 'block-new' }),
      event(894, { type: 'yuqi/task-stop-requested', operationId: ControlOperationId('shared-budget-stop'), taskId: TASK_ID, attemptId: ATTEMPT_ID }),
    ]), 'ENTITY_ALREADY_EXISTS')
    expectCode(() => replayTeamEvents([
      ...running,
      event(886, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('pause-first'), action: 'pause' }),
      event(887, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(888, { type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-paused'), taskId: TASK_ID, attemptId: ATTEMPT_ID }),
    ]), 'INVALID_TRANSITION')

    const cancelledTask = [
      ...running,
      event(889, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'cancelled' }),
      event(890, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'stopped', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T00:00:10Z' }),
      event(891, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'cancelled' }),
    ]
    expectCode(() => replayTeamEvents([...cancelledTask, event(892, {
      type: 'yuqi/task-stop-requested', operationId: ControlOperationId('stop-terminal'), taskId: TASK_ID, attemptId: ATTEMPT_ID,
    })]), 'INVALID_TRANSITION')
  })

  it('keeps journal recovery idempotent and rejects every conflicting durable identity', () => {
    const workspace = recoveryWorkspace()
    const recoverable = replayTeamEvents([
      event(1_100, { type: 'yuqi/team-created', title: 'Journal recovery', objective: 'Recover durably' }),
      event(1_101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(1_102, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(1_103, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
      event(1_104, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const clear = (index: number, sessionId = 'journal-controller') => event(index, {
      type: 'yuqi/team-recovery-cleared-from-journal', operationId: ControlOperationId('journal-clear'),
      target: 'paused', controllerSessionId: sessionId, workspace: recoveryWorkspaceProof(),
    })
    const cleared = applyTeamEvent(recoverable, clear(1_105))
    expect(cleared.team.status).toBe('paused')
    const repeated = applyTeamEvent(cleared, clear(1_106))
    expect(repeated.team).toEqual(cleared.team)
    expect(repeated.recoveryClearOperations).toEqual(cleared.recoveryClearOperations)
    expectCode(() => applyTeamEvent(cleared, clear(1_107, 'other-controller')), 'ENTITY_ALREADY_EXISTS')

    const wrongTarget = {
      ...cleared,
      recoveryClearOperations: {
        ...cleared.recoveryClearOperations,
        'journal-clear': { ...cleared.recoveryClearOperations['journal-clear']!, target: 'running' as const },
      },
    }
    expectCode(() => applyTeamEvent(wrongTarget, clear(1_108)), 'ENTITY_ALREADY_EXISTS')
    const wrongBasis = {
      ...cleared,
      recoveryClearOperations: {
        ...cleared.recoveryClearOperations,
        'journal-clear': { ...cleared.recoveryClearOperations['journal-clear']!, basis: undefined as never },
      },
    }
    expectCode(() => applyTeamEvent(wrongBasis, clear(1_109)), 'ENTITY_ALREADY_EXISTS')

    const operationCollision = {
      ...recoverable,
      controlOperations: {
        ...recoverable.controlOperations,
        'journal-clear': { id: ControlOperationId('journal-clear'), action: 'pause' as const },
      },
    }
    expectCode(() => applyTeamEvent(operationCollision, clear(1_109_1)), 'ENTITY_ALREADY_EXISTS')

    expectCode(() => applyTeamEvent({ ...recoverable, team: { ...recoverable.team, status: 'running' } }, clear(1_110)), 'INVALID_TRANSITION')
    const cancellation = {
      ...recoverable,
      latestTeamControlOperationId: ControlOperationId('cancel-before-clear'),
      controlOperations: {
        ...recoverable.controlOperations,
        'cancel-before-clear': { id: ControlOperationId('cancel-before-clear'), action: 'cancel' as const },
      },
    }
    expectCode(() => applyTeamEvent(cancellation, clear(1_111)), 'INVALID_TRANSITION')

    const activeAttemptSource = replayTeamEvents(completeTeamEvents().slice(0, 8))
    expectCode(() => applyTeamEvent({
      ...recoverable, attempts: activeAttemptSource.attempts,
    }, clear(1_112)), 'INVALID_TRANSITION')
    const activeVerificationSource = replayTeamEvents(completeTeamEvents().slice(0, 13))
    expectCode(() => applyTeamEvent({
      ...recoverable, verifications: activeVerificationSource.verifications,
    }, clear(1_113)), 'INVALID_TRANSITION')
    const activeLease = {
      ...recoverable,
      fileLeases: {
        active: { leaseId: FileLeaseId('active'), status: 'active' as const },
      },
    }
    expectCode(() => applyTeamEvent(activeLease as unknown as typeof recoverable, clear(1_113_1)), 'INVALID_TRANSITION')
    for (const status of ['active', 'unknown'] as const) {
      const unresolvedReservation = {
        ...recoverable,
        budgetReservations: {
          unresolved: { reservationId: 'unresolved', status },
        },
      }
      expectCode(() => applyTeamEvent(unresolvedReservation as unknown as typeof recoverable, clear(status === 'active' ? 1_113_2 : 1_113_3)), 'INVALID_TRANSITION')
    }

    const { workspace: _workspace, ...withoutWorkspace } = recoverable
    expectCode(() => applyTeamEvent(withoutWorkspace, clear(1_114)), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent({
      ...recoverable, workspace: { ...recoverable.workspace!, status: 'provisioning' },
    }, clear(1_115)), 'INVALID_TRANSITION')
    expectCode(() => applyTeamEvent(recoverable, event(1_116, {
      type: 'yuqi/team-recovery-cleared-from-journal', operationId: ControlOperationId('journal-mismatch'),
      target: 'paused', controllerSessionId: 'journal-controller',
      workspace: { ...recoveryWorkspaceProof(), baselineRef: 'different-baseline' },
    })), 'REFERENCE_MISMATCH')
  })

  it('validates explicit task checkpoints and failure escalation evidence', () => {
    const base = replayTeamEvents(reviewCandidateEvents(2))
    const candidateEventId = base.completionCandidateEventId!
    const checkpoint = (index: number, reviewId: string, checkpointSubject: 'task-attempt' | 'failure-escalation', checkpointAnchor: ReviewCheckpointAnchor) => event(index, {
      type: 'yuqi/review-requested', reviewId, trigger: checkpointSubject === 'failure-escalation' ? 'consecutive-failure' : 'pre-completion',
      candidateEventId, round: 0, checkpointSubject, checkpointAnchor,
    })

    expectCode(() => applyTeamEvent(base, checkpoint(1_120, 'missing-task-anchor', 'task-attempt', {
      eventId: candidateEventId,
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(base, checkpoint(1_121, 'missing-attempt-anchor', 'task-attempt', {
      eventId: candidateEventId, taskId: TASK_ID,
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(base, checkpoint(1_122, 'unknown-task-anchor', 'task-attempt', {
      eventId: candidateEventId, taskId: TaskId('missing-task'), attemptId: ATTEMPT_ID,
    })), 'REFERENCE_MISMATCH')
    expectCode(() => applyTeamEvent(base, checkpoint(1_123, 'unknown-attempt-anchor', 'task-attempt', {
      eventId: candidateEventId, taskId: TASK_ID, attemptId: AttemptId('missing-attempt'),
    })), 'REFERENCE_MISMATCH')

    const anchor = { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID }
    const taskCheckpoint = applyTeamEvent(base, checkpoint(1_124, 'valid-task-checkpoint', 'task-attempt', anchor))
    expect(taskCheckpoint.reviews['valid-task-checkpoint']).toMatchObject({ checkpointSubject: 'task-attempt', checkpointAnchor: anchor })
    expectCode(() => applyTeamEvent(base, checkpoint(1_125, 'early-failure-escalation', 'failure-escalation', anchor)), 'INVALID_TRANSITION')

    const verdictTemplate = Object.values(base.verificationVerdictOperations)[0]!
    const withTwoFailures = {
      ...base,
      verificationVerdictOperations: {
        first: { ...verdictTemplate, taskId: TASK_ID, disposition: 'failed' as const },
        second: { ...verdictTemplate, taskId: TASK_ID, disposition: 'failed' as const },
      },
    }
    const escalated = applyTeamEvent(withTwoFailures as typeof base, checkpoint(1_126, 'valid-failure-escalation', 'failure-escalation', anchor))
    expect(escalated.reviews['valid-failure-escalation']).toMatchObject({ checkpointSubject: 'failure-escalation' })
  })

  it('counts checkpoint retries and trailing failed verdicts without crossing task boundaries', () => {
    const base = replayTeamEvents(reviewCandidateEvents(2))
    const candidateEventId = base.completionCandidateEventId!
    const requested = applyTeamEvent(base, event(1_130, {
      type: 'yuqi/review-requested', reviewId: 'counting-checkpoint', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt',
      checkpointAnchor: { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID },
    }))
    const checkpoint = requested.reviews['counting-checkpoint']!
    const otherTask = TaskId('other-counting-task')
    const withRetries = {
      ...requested,
      taskRetryOperations: {
        'automatic-retry:same': { taskId: TASK_ID },
        'automatic-retry:other': { taskId: otherTask },
        'manual-retry:same': { taskId: TASK_ID },
      },
    }
    expect(checkpointAutomaticReworkCount(withRetries as unknown as typeof requested, checkpoint)).toBe(1)

    const { automaticReworkBudget: _automaticReworkBudget, ...checkpointWithoutBudget } = checkpoint
    const legacyCheckpoint = checkpointWithoutBudget as unknown as typeof checkpoint
    expect(reviewAutomaticReworkBudget(requested, legacyCheckpoint)).toEqual({ checkpointLimit: 2, teamLimit: 6 })
    const { reviewPolicy: _reviewPolicy, ...teamWithoutPolicy } = requested.team
    const noPolicy = { ...requested, team: teamWithoutPolicy }
    expect(reviewAutomaticReworkBudget(noPolicy, legacyCheckpoint)).toEqual({ checkpointLimit: 2, teamLimit: 6 })

    const verdictTemplate = Object.values(base.verificationVerdictOperations)[0]!
    const failedStreak = {
      ...base,
      verificationVerdictOperations: {
        passedBeforeStreak: { ...verdictTemplate, taskId: TASK_ID, disposition: 'passed' as const },
        failedOne: { ...verdictTemplate, taskId: TASK_ID, disposition: 'failed' as const },
        failedTwo: { ...verdictTemplate, taskId: TASK_ID, disposition: 'failed' as const },
        ignoredOtherTask: { ...verdictTemplate, taskId: otherTask, disposition: 'failed' as const },
      },
    }
    expect(consecutiveTaskVerificationFailures(failedStreak as typeof base, TASK_ID)).toBe(2)
    const endingInPass = {
      ...failedStreak,
      verificationVerdictOperations: {
        ...failedStreak.verificationVerdictOperations,
        latestPass: { ...verdictTemplate, taskId: TASK_ID, disposition: 'passed' as const },
      },
    }
    expect(consecutiveTaskVerificationFailures(endingInPass as typeof base, TASK_ID)).toBe(0)
  })

  it('derives repeated finding fingerprints from legacy review results', () => {
    const base = replayTeamEvents(reviewCandidateEvents(2))
    const candidateEventId = base.completionCandidateEventId!
    const anchor = { eventId: candidateEventId, taskId: TASK_ID, attemptId: ATTEMPT_ID }
    const current = applyTeamEvent(base, event(1_140, {
      type: 'yuqi/review-requested', reviewId: 'current-repeat-check', trigger: 'pre-completion',
      candidateEventId, round: 0, checkpointSubject: 'task-attempt', checkpointAnchor: anchor,
    }))
    const finding = { severity: 'high' as const, evidence: ['src/repeat.ts:1'], impact: 'repeats', recommendation: 'repair' }
    const currentReview = current.reviews['current-repeat-check']!
    const legacyPrevious = {
      ...currentReview, id: 'legacy-previous', status: 'completed' as const, phase: 'reworking' as const,
      findingFingerprints: [],
      result: { reviewerSessionId: 'legacy-reviewer', decision: 'changes_required' as const, findings: [finding], unverified: [] },
    }
    const withLegacyPrevious = {
      ...current,
      reviews: { ...current.reviews, 'legacy-previous': legacyPrevious },
      reviewIds: ['legacy-previous', 'current-repeat-check'],
    }
    const repeated = applyTeamEvent(withLegacyPrevious as typeof current, event(1_141, {
      type: 'yuqi/review-result-recorded', reviewId: 'current-repeat-check', candidateEventId,
      reviewerSessionId: 'current-reviewer', decision: 'changes_required', findings: [finding], unverified: [],
    }))
    expect(repeated.reviews['current-repeat-check']).toMatchObject({ status: 'awaiting_user', phase: 'awaiting-controller' })

    const withoutLegacyResult = {
      ...withLegacyPrevious,
      reviews: {
        ...withLegacyPrevious.reviews,
        'legacy-previous': { ...legacyPrevious, result: undefined as never },
      },
    }
    const fresh = applyTeamEvent(withoutLegacyResult as typeof current, event(1_142, {
      type: 'yuqi/review-result-recorded', reviewId: 'current-repeat-check', candidateEventId,
      reviewerSessionId: 'fresh-reviewer', decision: 'changes_required', findings: [finding], unverified: [],
    }))
    expect(fresh.reviews['current-repeat-check']).toMatchObject({ status: 'completed', phase: 'reworking' })
  })
})
