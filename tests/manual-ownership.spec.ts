import { describe, expect, it } from 'vitest'
import { AttemptId, ControlOperationId, DurableJournalCoordinator, planTeamSchedule, TaskRetryCoordinator, TeamControlCoordinator, TaskId, WorkspaceId, type TeamEvent, type TeamEventJournal } from '../src/index.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { manualReturnSummaryFor, manualTakeoverIssue } from '../src/domain/manual-ownership.ts'
import { summarizeTeamForConsole } from '../src/application/team-console-summary.ts'
import { buildBoundedParentReport } from '../src/host/harness/parent-report-delivery.ts'
import { completeTeamEvents, event } from './fixtures.ts'

function pausedEvents() {
  const workspace = {
    workspaceId: WorkspaceId('manual-workspace'),
    project: { projectRoot: 'F:/repo/app', repositoryRoot: 'F:/repo', gitCommonDirectory: 'F:/repo/.git', baselineRef: 'commit-1', volumeRoot: 'F:/', protectedRoots: [] },
    worktreePath: 'F:/managed/manual', branchName: 'yuqi/manual', status: 'provisioning' as const,
  }
  return [...completeTeamEvents().slice(0, 3),
    event(20, { type: 'yuqi/workspace-provisioning-started', workspace }),
    event(21, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
    event(22, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    event(23, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
  ]
}
const acquire = event(24, { type: 'yuqi/task-manual-acquired', taskId: TaskId('task-1'), operationId: ControlOperationId('manual-a'), workspacePath: 'F:/managed/manual' })
const returned = event(25, { type: 'yuqi/task-manual-returned', taskId: TaskId('task-1'), acquisitionId: ControlOperationId('manual-a'), operationId: ControlOperationId('manual-r'), summary: 'Updated app/a.txt; tests not run; verify remaining work.' })

describe('durable manual ownership', () => {
  it('replays matching operation identities without reacquisition and rejects conflicting identities', () => {
    const history = [...pausedEvents(), acquire, returned]
    const original = replayTeamEvents(history)
    const replayed = replayTeamEvents([...history, { ...acquire, eventId: event(40, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('unused'), action: 'pause' }).eventId }, { ...returned, eventId: event(41, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('unused'), action: 'pause' }).eventId }])
    expect(replayed.team.manualOwnership).toEqual(original.team.manualOwnership)
    expect(replayed.team.manualOwnershipOperations).toEqual(original.team.manualOwnershipOperations)
    expect(() => replayTeamEvents([...history, event(44, { type: 'yuqi/task-manual-acquired', taskId: TaskId('task-1'), operationId: ControlOperationId('manual-a'), workspacePath: 'F:/wrong-workspace' })])).toThrow(/workspace differs/)
    expect(() => replayTeamEvents([...history, event(42, { type: 'yuqi/task-manual-returned', taskId: TaskId('task-1'), acquisitionId: ControlOperationId('manual-a'), operationId: ControlOperationId('manual-r'), summary: 'different payload' })])).toThrow(/identity conflict/)
    expect(() => replayTeamEvents([...history, event(43, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('manual-a'), action: 'pause' })])).toThrow(/manual ownership/)
  })
  it('rejects stale acquisition returns and does not let an old replay return the new owner', () => {
    const history = [...pausedEvents(), acquire, returned, event(30, { type: 'yuqi/task-manual-acquired', taskId: TaskId('task-1'), operationId: ControlOperationId('manual-b'), workspacePath: 'F:/managed/manual' })]
    expect(() => replayTeamEvents([...history, event(31, { type: 'yuqi/task-manual-returned', taskId: TaskId('task-1'), acquisitionId: ControlOperationId('manual-a'), operationId: ControlOperationId('stale-return'), summary: 'late response' })])).toThrow(/ownership has changed/)
    const replayed = replayTeamEvents([...history, { ...returned, eventId: event(32, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('unused'), action: 'pause' }).eventId }])
    expect(replayed.team.manualOwnership).toMatchObject({ state: 'human-owned', acquisitionId: 'manual-b' })
    expect(manualReturnSummaryFor(replayed, 'task-1')).toContain('app/a.txt')
  })
  it('rejects resume/retry through their coordinators without writes and keeps the schedule inactive', async () => {
    const events: TeamEvent[] = [...pausedEvents(), acquire]
    const commits: TeamEvent[][] = []
    const journal: TeamEventJournal = { key: 'manual-controller', read: () => events, commit: async batch => { commits.push([...batch]); events.push(...batch) } }
    const transactions = new DurableJournalCoordinator()
    const clock = { nowIso: () => '2026-09-05T00:00:00Z' }
    const ids = { next: () => 'manual-control-event' }
    try {
      await expect(new TeamControlCoordinator(clock, ids, transactions).resume({ teamId: 'team-1', operationId: 'resume-held' }, journal)).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
      await expect(new TaskRetryCoordinator(clock, ids, transactions).retry({ teamId: 'team-1', taskId: 'task-1', operationId: 'retry-held' }, journal)).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
      expect(commits).toEqual([])
      const schedule = planTeamSchedule(replayTeamEvents(events), { maxConcurrency: 3 })
      expect(schedule.status).toBe('inactive')
      expect(schedule.dispatchTaskIds).toEqual([])
    } finally { await transactions.dispose() }
  })
  it('rejects direct attempt creation, child admission and task retry events while human-owned', () => {
    const history = [...pausedEvents(), acquire]
    const attempts = [
      event(30, { type: 'yuqi/attempt-created', taskId: TaskId('task-1'), attemptId: AttemptId('manual-attempt'), ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(31, { type: 'yuqi/attempt-admitted', taskId: TaskId('task-1'), attemptId: AttemptId('manual-attempt'), agentSessionId: 'child', messageId: 'message' }),
      event(32, { type: 'yuqi/task-retry-requested', taskId: TaskId('task-1'), operationId: ControlOperationId('retry-held') }),
    ]
    for (const attempt of attempts) expect(() => replayTeamEvents([...history, attempt])).toThrow(/Return manual ownership/)
  })
  it('requires confirmed pause, then fences resume and preserves return history across cold replay', () => {
    expect(manualTakeoverIssue(replayTeamEvents(pausedEvents().slice(0, -1)), 'task-1')).toBeDefined()
    const held = [...pausedEvents(), acquire]
    expect(replayTeamEvents(JSON.parse(JSON.stringify(held)))).toMatchObject({ team: { status: 'paused', manualOwnership: { state: 'human-owned' } } })
    expect(() => replayTeamEvents([...held, event(30, { type: 'yuqi/team-status-changed', from: 'paused', to: 'running' })])).toThrow()
    const history = [...held, returned]
    const projection = replayTeamEvents(history)
    expect(projection.team.status).toBe('paused')
    expect(projection.tasks['task-1']!.status).toBe('pending')
    expect(manualReturnSummaryFor(projection, 'task-1')).toContain('app/a.txt')
    expect(manualReturnSummaryFor(projection, 'other-task')).toBeUndefined()
    const report = buildBoundedParentReport({ controllerSessionId: 'controller', sourceEventCount: history.length, events: history }, 1)
    expect(report).toContain('manualReturnSummary task=task-1')
    expect(report).toContain('not verified completion')
    expect(report).toContain('app/a.txt')
  })
  it('cancellation retains ownership history but clears blocking attention and does not request return', () => {
    const history = [...pausedEvents(), acquire,
      event(30, { type: 'yuqi/team-status-changed', from: 'paused', to: 'cancelling' }),
      event(31, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'pending', to: 'cancelled' }),
      event(32, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]
    const projection = replayTeamEvents(history)
    expect(projection.team.manualOwnership?.state).toBe('human-owned')
    const summary = summarizeTeamForConsole(projection)
    expect(summary.attention).toEqual([])
    expect(summary.team.attentionTaskCount).toBe(0)
    const report = buildBoundedParentReport({ controllerSessionId: 'controller', sourceEventCount: history.length, events: history }, 1)
    expect(report).toContain('不要要求向已释放的主控交还')
  })
})
