import {
  AttemptId,
  ControlOperationId,
  parseTeamEvent,
  TaskId,
  TeamEventId,
  TeamId,
  VerificationId,
} from '../src/index.ts'
import type { TeamEvent, TeamTaskContract } from '../src/index.ts'

type EventBody = TeamEvent extends infer Event
  ? Event extends TeamEvent
    ? Omit<Event, 'schemaVersion' | 'eventId' | 'teamId' | 'occurredAt'>
    : never
  : never

export const TEAM_ID = TeamId('team-1')
export const TASK_ID = TaskId('task-1')
export const ATTEMPT_ID = AttemptId('attempt-1')
export const VERIFICATION_ID = VerificationId('verification-1')

export function contract(taskId = TASK_ID, revision = 1, dependencies: readonly ReturnType<typeof TaskId>[] = []): TeamTaskContract {
  return {
    taskId,
    revision,
    goal: `Deliver ${taskId}`,
    scope: ['src'],
    nonGoals: ['deployment'],
    dependencies: [...dependencies],
    fileScope: ['src/**'],
    modelRole: 'worker',
    modelId: 'deepseek-v4',
    acceptanceCriteria: ['tests pass'],
    authorityMode: 'write-authorized',
    inputDigest: `digest-${revision}`,
    baselineRef: 'commit-1',
  }
}

export function event(
  index: number,
  body: EventBody,
  teamId = TEAM_ID,
): TeamEvent {
  return parseTeamEvent({
    schemaVersion: 1,
    eventId: TeamEventId(`event-${index}`),
    teamId,
    occurredAt: `2026-08-15T00:00:${String(index).padStart(2, '0')}Z`,
    ...body,
  })
}

export function completeTeamEvents(): readonly TeamEvent[] {
  return [
    event(1, { type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(3, { type: 'yuqi/task-created', contract: contract() }),
    event(4, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
    event(5, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    event(6, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
    event(7, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'session-worker-1', messageId: 'message-1' }),
    event(8, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'running' }),
    event(9, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'settled' }),
    event(10, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'run-1', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-15T00:00:10Z' }),
    event(11, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
    event(12, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, verifierSessionId: 'session-verifier-1' }),
    event(13, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VERIFICATION_ID, from: 'pending', to: 'running' }),
    event(14, {
      type: 'yuqi/verification-verdict-recorded',
      operationId: ControlOperationId('fixture-verdict-passed'),
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      verificationId: VERIFICATION_ID,
      disposition: 'passed',
      requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [{
        checkId: 'build', capturedAt: '2026-08-15T00:00:14Z', kind: 'build', producer: 'build-runner',
        command: 'pnpm run build', exitCode: 0, artifactDigest: 'sha256-fixture-build',
      }],
      reasons: [],
    }),
    event(15, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'settled', to: 'completed' }),
    event(16, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'verifying', to: 'completed' }),
    event(17, { type: 'yuqi/team-status-changed', from: 'running', to: 'completed' }),
  ]
}

/** A valid active-verification journal carrying one inconclusive verdict operation. */
export function verificationOperationEvents(operationId = 'verification-operation'): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 13),
    event(180, {
      type: 'yuqi/verification-verdict-recorded',
      operationId: ControlOperationId(operationId),
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      verificationId: VERIFICATION_ID,
      disposition: 'inconclusive',
      requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [],
      reasons: [{ checkId: 'build', code: 'missing-evidence', detail: 'No structured host evidence was supplied' }],
    }),
  ]
}
