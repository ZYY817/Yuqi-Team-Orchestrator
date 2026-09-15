import { describe, expect, it } from 'vitest'
import { summarizeTeamForConsole, teamConsoleSummarySchema } from '../src/application/team-console-summary.ts'
import { AttemptId, ControlOperationId, replayTeamEvents, TaskId, TeamEventId } from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, event, TASK_ID } from './fixtures.ts'
import { verificationOperationEvents } from './fixtures.ts'

describe('summarizeTeamForConsole', () => {
  it('exposes bounded revision and follow-up provenance without copying source transcripts', () => {
    const base = replayTeamEvents(completeTeamEvents())
    const task = base.tasks[TASK_ID]!
    const summary = summarizeTeamForConsole({ ...base,
      team: { ...base.team, continuedFrom: { sourceTeamId: 'previous-team', sourceControllerSessionId: 'previous-controller',
        sourceEventId: 'previous-event', operationId: 'followup-1', sourceSummary: 'Private source reference not needed by UI' } },
      tasks: { ...base.tasks, [TASK_ID]: { ...task, contract: { ...task.contract, kind: 'user-revision',
        userRevision: { sourceTaskId: TaskId('source-task'), sourceAttemptId: 'source-attempt', sourceRevision: 1,
          operationId: 'revision-1', requestDigest: 'a'.repeat(64) } } } },
    })
    const parsed = teamConsoleSummarySchema.parse(summary)
    expect(parsed.team.continuedFrom).toEqual({ sourceTeamId: 'previous-team', sourceControllerSessionId: 'previous-controller' })
    expect(parsed.tasks[0]?.revisionSource).toEqual({ taskId: 'source-task', operationId: 'revision-1' })
    expect(JSON.stringify(parsed)).not.toContain('Private source reference')
  })

  it('derives a completed Team view without copying a second state or inventing missing usage', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const summary = summarizeTeamForConsole(projection)
    expect(summary.team).toMatchObject({ status: 'completed', completedTaskCount: 1, runningTaskCount: 0, waitingTaskCount: 0, attentionTaskCount: 0 })
    expect(summary.tasks[0]).toMatchObject({
      taskId: 'task-1', model: 'deepseek/deepseek-v4', attemptStatus: 'completed', childSessionId: 'session-worker-1', nextAction: '已完成。',
    })
    expect(summary.team.duration).toEqual({ state: 'known', elapsedMs: 2_000 })
    expect(summary.tasks[0]?.duration).toEqual({ state: 'known', elapsedMs: 2_000 })
    expect(summary.tasks[0]?.usage).toEqual({ state: 'unavailable', label: 'Token：提供方未上报' })
    expect(summary.usage).toEqual({ state: 'unavailable', scope: '受管子 Agent', label: '用量：提供方未上报' })
    expect(Object.isFrozen(summary)).toBe(true)
    expect(summary.timeline?.map(entry => entry.kind)).toEqual(['attempt-started', 'attempt-ended'])
    expect(summary.timeline?.every(entry => entry.taskId === 'task-1' && Number.isFinite(Date.parse(entry.at)))).toBe(true)
  })

  it('aggregates exact disjoint Token buckets and labels in-flight totals as partial', () => {
    const base = completeTeamEvents()
    const evidenceIndex = base.findIndex(item => item.type === 'yuqi/attempt-evidence-recorded')
    const withUsage = base.map((item, index) => index === evidenceIndex
      ? event(995, {
          type: 'yuqi/attempt-evidence-recorded',
          taskId: TASK_ID,
          attemptId: ATTEMPT_ID,
          runId: 'run-usage',
          agentSessionId: 'session-worker-1',
          provider: 'in-process',
          stopReason: 'completed',
          hasAssistantOutput: true,
          reportedChangedFiles: ['src/a.ts', 'src/b.ts'],
          usage: { uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 },
          settledAt: '2026-08-15T00:00:10Z',
        })
      : item)
    const known = summarizeTeamForConsole(replayTeamEvents(withUsage))
    expect(known.usage).toEqual({
      state: 'known', scope: '受管子 Agent', uncachedInputTokens: 10, outputTokens: 3,
      cacheReadTokens: 4, cacheWriteTokens: 2, totalTokens: 19, label: '用量：19 tok',
    })
    expect(known.tasks[0]?.usage).toEqual({
      state: 'known', uncachedInputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2,
      totalTokens: 19, label: 'Token：19 tok',
    })
    expect(known.tasks[0]?.reportedChangedFiles).toEqual(['src/a.ts', 'src/b.ts'])

    const knownProjection = replayTeamEvents(withUsage)
    const attempt = knownProjection.attempts[ATTEMPT_ID]!
    const inFlightProjection = {
      ...knownProjection,
      attempts: { ...knownProjection.attempts, [ATTEMPT_ID]: { ...attempt, status: 'running' as const } },
    }
    expect(summarizeTeamForConsole(inFlightProjection).usage).toMatchObject({
      state: 'partial', totalTokens: 19, activeAttemptCount: 1, missingAttemptCount: 0,
    })

    const { usage: _usage, ...unreportedEvidence } = attempt.evidence!
    const partiallyReportedProjection = {
      ...knownProjection,
      attempts: {
        ...knownProjection.attempts,
        'attempt-unreported': { ...attempt, id: AttemptId('attempt-unreported'), evidence: unreportedEvidence },
      },
    }
    expect(summarizeTeamForConsole(partiallyReportedProjection).usage).toMatchObject({
      state: 'partial', totalTokens: 19, activeAttemptCount: 0, missingAttemptCount: 1,
    })
  })

  it('keeps the last durable live usage when terminal evidence wins without a usage payload', () => {
    const base = completeTeamEvents()
    const events = [
      ...base.slice(0, 8),
      event(996, {
        type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
        agentSessionId: 'session-worker-1',
        usage: { uncachedInputTokens: 20, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 },
      }),
      ...base.slice(8),
    ]
    const summary = summarizeTeamForConsole(replayTeamEvents(events))
    expect(summary.usage).toMatchObject({ state: 'known', totalTokens: 30 })
    expect(summary.tasks[0]?.usage).toMatchObject({ state: 'known', totalTokens: 30, label: 'Token：30 tok' })
  })

  it('keeps attempt-observed usage in the task row even when recovery has no evidence payload', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(997, {
        type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
        agentSessionId: 'session-worker-1',
        usage: { uncachedInputTokens: 12_000_000, outputTokens: 2_000_000, cacheReadTokens: 10, cacheWriteTokens: 0 },
      }),
    ])
    const { evidence: _previousEvidence, ...attempt } = projection.attempts[ATTEMPT_ID]!
    const recovered = {
      ...projection,
      team: { ...projection.team, status: 'paused' as const },
      tasks: { ...projection.tasks, [TASK_ID]: { ...projection.tasks[TASK_ID]!, status: 'failed' as const } },
      attempts: { ...projection.attempts, [ATTEMPT_ID]: { ...attempt, status: 'failed' as const } },
    }

    const summary = summarizeTeamForConsole(recovered)
    expect(summary.tasks[0]?.usage).toMatchObject({ state: 'known', totalTokens: 14_000_010 })
    expect(summary.usage).toMatchObject({ state: 'known', totalTokens: 14_000_010 })
    expect(summary.team.resumeDisposition).toBe('requires-reconciliation')
  })

  it('shows pending instead of zero before any attempt has settled', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 5))
    expect(summarizeTeamForConsole(projection).usage).toEqual({
      state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据',
    })
    expect(summarizeTeamForConsole(projection).tasks[0]?.usage).toEqual({ state: 'pending', label: 'Token：暂无数据' })
  })

  it('marks only the durable pre-dispatch plan review pause as a discoverable start choice', () => {
    const pausedForPlan = replayTeamEvents([
      ...completeTeamEvents().slice(0, 3),
      event(50, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('plan-review:team-1'), action: 'pause' }),
      event(51, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(52, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ])
    expect(summarizeTeamForConsole(pausedForPlan).team.planConfirmationPending).toBe(true)

    const manuallyPaused = replayTeamEvents([
      ...completeTeamEvents().slice(0, 3),
      event(53, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('manual-pause'), action: 'pause' }),
      event(54, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(55, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ])
    expect(summarizeTeamForConsole(manuallyPaused).team.planConfirmationPending).toBeUndefined()

    const pausedAgain = replayTeamEvents([
      ...completeTeamEvents().slice(0, 3),
      event(56, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('plan-review:team-1'), action: 'pause' }),
      event(57, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(58, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
      event(59, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('start-confirmed'), action: 'resume' }),
      event(60, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' }),
      event(61, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('pause-again'), action: 'pause' }),
      event(62, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(63, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ])
    expect(summarizeTeamForConsole(pausedAgain).team.planConfirmationPending).toBeUndefined()
  })

  it('includes readable prerequisite identities for the task panel', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 5))
    const root = projection.tasks[TASK_ID]!
    const downstreamId = TaskId('task-2')
    const withDependency = {
      ...projection,
      taskIds: [...projection.taskIds, downstreamId],
      tasks: {
        ...projection.tasks,
        [downstreamId]: {
          contract: { ...root.contract, taskId: downstreamId, goal: '实现页面布局', dependencies: [TASK_ID] },
          status: 'pending' as const, attemptIds: [], verificationIds: [], verificationAttemptFloor: 1,
        },
      },
    }
    expect(summarizeTeamForConsole(withDependency).tasks[1]).toMatchObject({
      dependencyCount: 1,
      dependencies: [{ taskId: 'task-1', goal: root.contract.goal, index: 1 }],
    })
  })

  it('shows the revised contract model for a retried task instead of its historical attempt model', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const retried = {
      ...projection,
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, status: 'ready' as const, contract: { ...task.contract, revision: 2, modelId: 'deepseek-v4-pro' } },
      },
    }
    expect(summarizeTeamForConsole(retried).tasks[0]?.model).toBe('deepseek-v4-pro')
  })

  it('shows provider-reported usage as a live partial total before settlement', () => {
    const projection = replayTeamEvents([...completeTeamEvents().slice(0, 8), event(98, {
      type: 'yuqi/attempt-usage-observed', taskId: TASK_ID, attemptId: ATTEMPT_ID,
      agentSessionId: 'session-worker-1',
      usage: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })])
    expect(summarizeTeamForConsole(projection).usage).toMatchObject({
      state: 'partial', totalTokens: 17, activeAttemptCount: 1, missingAttemptCount: 0,
    })
    expect(summarizeTeamForConsole(projection).tasks[0]?.usage).toMatchObject({ state: 'live', totalTokens: 17 })
  })

  it('keeps route history and the new provider visible after a model switch', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const firstAttempt = projection.attempts[ATTEMPT_ID]!
    const secondAttemptId = AttemptId('attempt-2')
    const switched = {
      ...projection,
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, status: 'running' as const, attemptIds: [ATTEMPT_ID, secondAttemptId] },
      },
      attempts: {
        ...projection.attempts,
        [ATTEMPT_ID]: {
          ...firstAttempt,
          modelProvider: 'controller',
          modelId: 'controller-model',
          route: { modelProvider: 'controller', modelId: 'controller-model' },
          routeBasis: 'automatic' as const,
          requestedTier: 'standard' as const,
          fallbackReason: 'automatic-candidates-exhausted' as const,
          catalogEvidence: [{ model: { modelProvider: 'external', modelId: 'unavailable' }, metadataResolved: false, routable: false }],
        },
        [secondAttemptId]: {
          ...firstAttempt,
          id: secondAttemptId,
          ordinal: 2,
          modelProvider: 'external',
          modelId: 'replacement-model',
          route: { modelProvider: 'external', modelId: 'replacement-model' },
          routeBasis: 'task-exact' as const,
          requestedTier: 'standard' as const,
          fallbackReason: 'automatic-candidates-exhausted' as const,
          catalogEvidence: [{ model: { modelProvider: 'external', modelId: 'unroutable' }, metadataResolved: true, routable: false }],
        },
      },
    }

    const summary = summarizeTeamForConsole(switched)
    expect(summary.tasks[0]).toMatchObject({
      model: 'external/replacement-model',
      route: { providerId: 'external', modelId: 'replacement-model', basis: 'task-exact' },
      routeHistory: [
        { attemptOrdinal: 1, providerId: 'controller', modelId: 'controller-model', basis: 'automatic', fallbackReason: 'automatic-candidates-exhausted', unavailableCandidates: ['external/unavailable'] },
        { attemptOrdinal: 2, providerId: 'external', modelId: 'replacement-model', basis: 'task-exact', requestedTier: 'standard', fallbackReason: 'automatic-candidates-exhausted', unavailableCandidates: ['external/unroutable'] },
      ],
    })
    expect(teamConsoleSummarySchema.parse(summary)).toEqual(summary)
  })

  it('skips a missing historical attempt instead of inventing route details', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const withMissingHistory = {
      ...projection,
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, attemptIds: [...task.attemptIds, AttemptId('missing-attempt')] },
      },
    }

    expect(summarizeTeamForConsole(withMissingHistory).tasks[0]?.routeHistory).toHaveLength(1)
  })

  it('derives running durations from durable starts and keeps them stable across replay', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const summary = summarizeTeamForConsole(projection)
    expect(summary.team.duration).toEqual({
      state: 'running', startedAt: '2026-08-15T00:00:08Z', elapsedMs: 0,
      activeStartedAts: ['2026-08-15T00:00:08Z'],
    })
    expect(summary.tasks[0]?.duration).toEqual({ state: 'running', startedAt: '2026-08-15T00:00:08Z' })
    expect(summarizeTeamForConsole(replayTeamEvents(completeTeamEvents().slice(0, 8)))).toEqual(summary)
  })

  it('freezes Team time while only verification remains, instead of timing an open panel', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 11))
    expect(summarizeTeamForConsole(projection).team.duration).toEqual({ state: 'known', elapsedMs: 2_000 })
  })

  it('degrades malformed or reversed durable timestamps instead of inventing a duration', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const invalid = {
      ...projection,
      team: { ...projection.team, startedAt: 'not-a-time', endedAt: '2026-08-15T00:00:17Z' },
      attempts: {
        ...projection.attempts,
        [ATTEMPT_ID]: { ...projection.attempts[ATTEMPT_ID]!, startedAt: '2026-08-15T00:00:11Z', endedAt: '2026-08-15T00:00:10Z' },
      },
    }
    const summary = summarizeTeamForConsole(invalid)
    expect(summary.team.duration).toEqual({ state: 'unavailable' })
    expect(summary.tasks[0]?.duration).toEqual({ state: 'unavailable' })
  })

  it('makes an unresolved runtime attempt visible as an attention item', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const summary = summarizeTeamForConsole(projection)
    expect(summary.team).toMatchObject({ status: 'needs_reconciliation', attentionTaskCount: 1, userDecisionCount: 0, controllerActionCount: 1 })
    expect(summary.attention).toEqual([{ owner: 'controller', code: 'attempt-outcome-unknown', taskId: 'task-1', message: expect.stringContaining('需主控') }])
    expect(summary.tasks[0]?.nextAction).toContain('结果尚未确认')
    expect(summary.tasks[0]?.duration).toEqual({ state: 'unavailable' })
  })

  it('makes an inconclusive verification explicit instead of leaving the task silently verifying', () => {
    const summary = summarizeTeamForConsole(replayTeamEvents(verificationOperationEvents()))
    expect(summary.tasks[0]?.nextAction).toContain('需人工确认')
    expect(summary.team.attentionTaskCount).toBe(1)
    expect(summary.team.userDecisionCount).toBe(1)
    expect(summary.attention[0]).toMatchObject({ owner: 'user', code: 'verification-inconclusive' })
  })

  it('treats impossible partial timing as unavailable and untouched dispatch as zero elapsed', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const attempt = projection.attempts[ATTEMPT_ID]!
    const { startedAt: _startedAt, ...attemptWithoutStart } = attempt
    const endedWithoutStart = {
      ...projection,
      attempts: { ...projection.attempts, [ATTEMPT_ID]: attemptWithoutStart },
    }
    expect(summarizeTeamForConsole(endedWithoutStart).team.duration).toEqual({ state: 'unavailable' })

    const { startedAt: _dispatchStart, endedAt: _dispatchEnd, ...attemptWithoutTiming } = attempt
    const dispatching = {
      ...projection,
      attempts: {
        ...projection.attempts,
        [ATTEMPT_ID]: { ...attemptWithoutTiming, status: 'dispatching' as const },
      },
    }
    expect(summarizeTeamForConsole(dispatching).team.duration).toEqual({ state: 'known', elapsedMs: 0 })
  })

  it('does not restart the duration clock for a manually cancelled attempt without an end timestamp', () => {
    const projection = replayTeamEvents([
      ...completeTeamEvents().slice(0, 8),
      event(990, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
      event(991, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('duration-scan'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'session-worker-1', state: 'durable' }] }),
      event(992, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
      event(993, { type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('duration-resolution'), observationOperationId: ControlOperationId('duration-scan'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'cancelled' }),
    ])
    expect(summarizeTeamForConsole(projection).tasks[0]?.duration).toEqual({ state: 'unavailable' })
  })

  it.each([
    ['verifying', '验证中'], ['blocked', '等待处理'], ['failed', '可在安全门禁'],
    ['cancelled', '已取消'], ['running', '正在执行'], ['pending', '等待调度'], ['ready', '等待调度'],
  ] as const)('explains the %s task state in Chinese', (status, text) => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks['task-1']!
    const withoutAttempt = { ...projection, tasks: { ...projection.tasks, 'task-1': { ...task, status, attemptIds: [] } } }
    const summary = summarizeTeamForConsole(withoutAttempt)
    expect(summary.tasks[0]).toMatchObject({ model: 'deepseek-v4', nextAction: expect.stringContaining(text) })
  })

  it('keeps recoverable failures with the controller instead of interrupting the user', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks['task-1']!
    const summary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'running' },
      tasks: { ...projection.tasks, 'task-1': { ...task, status: 'failed', attemptIds: [] } },
    })
    expect(summary.team).toMatchObject({ attentionTaskCount: 1, userDecisionCount: 0, controllerActionCount: 1 })
    expect(summary.attention).toEqual([{ owner: 'controller', code: 'task-failed', taskId: 'task-1', message: expect.stringContaining('主控') }])
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('does not count historical failures as attention for a %s Team', status => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const summary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status },
      tasks: { ...projection.tasks, [TASK_ID]: { ...task, status: 'failed' } },
    })
    expect(summary.attention).toEqual([])
    expect(summary.team).toMatchObject({ attentionTaskCount: 0, userDecisionCount: 0, controllerActionCount: 0 })
    expect(summary.tasks[0]?.status).toBe('failed')
  })

  it('projects the durable review checkpoint, independence, ownership, and bounded budgets', () => {
    const candidate = TeamEventId('event-16')
    const base = completeTeamEvents().slice(0, 16).map((item, index) => index === 0
      ? { ...item, reviewPolicy: { mode: 'quality-gate' as const, maxReworkRounds: 2, additionalPrompt: '' } }
      : item)
    const projection = replayTeamEvents([
      ...base,
      event(996, {
        type: 'yuqi/review-requested', reviewId: 'checkpoint-summary', trigger: 'quality-gate', candidateEventId: candidate, round: 0,
        checkpointSubject: 'team-completion', checkpointAnchor: { eventId: String(candidate) },
        automaticReworkBudget: { checkpointLimit: 2, teamLimit: 6 }, independentReviewerRequired: true,
      }),
      event(997, {
        type: 'yuqi/review-result-recorded', reviewId: 'checkpoint-summary', candidateEventId: candidate,
        reviewerSessionId: 'independent-reviewer', reviewerIndependent: true, reviewerIndependence: 'model-diverse',
        decision: 'inconclusive', findings: [], unverified: ['release evidence missing'],
      }),
    ])

    const summary = summarizeTeamForConsole(projection)
    expect(teamConsoleSummarySchema.parse(summary)).toEqual(summary)
    expect(summary.reviewCheckpoint).toEqual({
      reviewId: 'checkpoint-summary', trigger: 'quality-gate', subject: 'team-completion', phase: 'awaiting-controller',
      candidateEventId: 'event-16', round: 0, independence: 'model-diverse', nextOwner: 'user',
      automaticRework: {
        checkpointUsed: 0, checkpointLimit: 2, checkpointRemaining: 2,
        teamUsed: 0, teamLimit: 6, teamRemaining: 6, history: [],
      },
    })
    expect(summary.team.userDecisionCount).toBe(1)
  })

  it('formats paused blocked tasks cleanly and excludes them from controller attention', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const attempt = projection.attempts[ATTEMPT_ID]!
    const pausedSummary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'paused' },
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, status: 'blocked' },
      },
      attempts: {
        ...projection.attempts,
        [ATTEMPT_ID]: {
          ...attempt,
          taskOutcomeVersion: 1,
          ordinal: task.verificationAttemptFloor,
          evidence: {
            runId: 'run-1',
            agentSessionId: 'session-1',
            provider: 'in-process',
            settledAt: '2026-08-15T00:00:10Z',
            stopReason: 'completed',
            hasAssistantOutput: true,
            taskOutcome: { status: 'missing' },
          },
        },
      },
    })
    expect(pausedSummary.tasks[0]?.nextAction).toBe('任务已随团队暂停。点击「继续任务」后将自动恢复执行。')
    expect(pausedSummary.attention).toEqual([])
    expect(pausedSummary.team.controllerActionCount).toBe(0)
  })

  it('explains a dependency-waiting blocked task as paused rather than failed while the Team is paused', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const pausedSummary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'paused' },
      tasks: { ...projection.tasks, [TASK_ID]: { ...task, status: 'blocked', attemptIds: [] } },
    })
    expect(pausedSummary.tasks[0]?.nextAction).toBe('任务已随团队暂停。点击「继续任务」后将自动恢复执行。')
    expect(pausedSummary.tasks[0]?.durablyBlocked).toBeUndefined()
    expect(pausedSummary.attention).toEqual([])
    const runningSummary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'running' },
      tasks: { ...projection.tasks, [TASK_ID]: { ...task, status: 'blocked', attemptIds: [] } },
    })
    expect(runningSummary.tasks[0]?.nextAction).toBe('等待处理：依赖任务未成功完成。')
    expect(runningSummary.attention[0]?.code).toBe('dependency-blocked')
  })

  it('keeps the durable dependency reason for a task blocked by a failed prerequisite even while the Team is paused', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const dependent = {
      ...task,
      status: 'blocked' as const,
      attemptIds: [],
      contract: { ...task.contract, taskId: TaskId('task-dep'), dependencies: [TASK_ID] },
    }
    const summary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'paused' },
      taskIds: [...projection.taskIds, TaskId('task-dep')],
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, status: 'failed' },
        'task-dep': dependent,
      },
    })
    const depTask = summary.tasks.find(item => item.taskId === 'task-dep')!
    expect(depTask.durablyBlocked).toBe(true)
    expect(depTask.nextAction).toBe('等待处理：依赖任务未成功完成。')
  })

  it('keeps the reconcile wording and attention for an invalid outcome block even while the Team is paused', () => {
    const projection = replayTeamEvents(completeTeamEvents())
    const task = projection.tasks[TASK_ID]!
    const attempt = projection.attempts[ATTEMPT_ID]!
    const pausedSummary = summarizeTeamForConsole({
      ...projection,
      team: { ...projection.team, status: 'paused' },
      tasks: {
        ...projection.tasks,
        [TASK_ID]: { ...task, status: 'blocked' },
      },
      attempts: {
        ...projection.attempts,
        [ATTEMPT_ID]: {
          ...attempt,
          taskOutcomeVersion: 1,
          ordinal: task.verificationAttemptFloor,
          evidence: {
            runId: 'run-1',
            agentSessionId: 'session-1',
            provider: 'in-process',
            settledAt: '2026-08-15T00:00:10Z',
            stopReason: 'completed',
            hasAssistantOutput: true,
            taskOutcome: { status: 'invalid' },
          },
        },
      },
    })
    expect(pausedSummary.tasks[0]?.nextAction).toBe('任务受阻；请在主控处理原因后重试。 缺少有效的最终任务结果。')
    expect(pausedSummary.attention[0]?.code).toBe('task-blocked')
    expect(pausedSummary.team.controllerActionCount).toBe(1)
  })
})
