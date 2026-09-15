import { describe, expect, it } from 'vitest'
import {
  AttemptId,
  AttemptResolutionCoordinator,
  ControlOperationId,
  DurableJournalCoordinator,
  FileLeaseId,
  RecoveryClearCoordinator,
  TeamEventId,
  TeamId,
  VerificationId,
  TaskId,
  WorkspaceId,
  replayTeamEvents,
  YuqiOrchestratorError,
} from '../src/index.ts'
import type {
  AttemptResolutionSafetyPort,
  AttemptRuntimeObservation,
  AttemptResolutionProof,
  RecoveryClearProof,
  RecoveryClearSafetyPort,
  TeamEvent,
  TeamEventJournal,
} from '../src/index.ts'
import { ATTEMPT_ID, completeTeamEvents, contract, event, TASK_ID, TEAM_ID } from './fixtures.ts'

const WORKSPACE_ID = WorkspaceId('recovery-workspace')
const WORKSPACE = {
  workspaceId: WORKSPACE_ID,
  project: {
    projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
    baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
  },
  worktreePath: 'F:\\managed\\recovery', branchName: 'yuqi/recovery', status: 'provisioning' as const,
}

class Journal implements TeamEventJournal {
  readonly key = 'recovery-controller'
  readonly events: TeamEvent[]
  fail = false
  constructor(events: readonly TeamEvent[]) { this.events = [...events] }
  read(): readonly TeamEvent[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (this.fail) throw new Error('append failed')
    this.events.push(...events)
  }
}

class Safety implements AttemptResolutionSafetyPort, RecoveryClearSafetyPort {
  readonly proofWorkspace = {
    workspaceId: String(WORKSPACE_ID), projectRoot: WORKSPACE.project.projectRoot,
    repositoryRoot: WORKSPACE.project.repositoryRoot, gitCommonDirectory: WORKSPACE.project.gitCommonDirectory,
    baselineRef: WORKSPACE.project.baselineRef, volumeRoot: WORKSPACE.project.volumeRoot,
    protectedRoots: [...WORKSPACE.project.protectedRoots], worktreePath: WORKSPACE.worktreePath, branchName: WORKSPACE.branchName,
  }
  async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof> {
    return {
      principal: { kind: 'controller-session', sessionId: 'host-controller' },
      observationState: request.observation.state as 'durable' | 'missing' | 'not-admitted',
      childQuiescent: true, localInFlight: false, gitVerified: true,
      workspace: this.proofWorkspace,
      leaseIds: [...request.leaseIds ?? []],
    }
  }
  async assertRecoveryClear(_request: Parameters<RecoveryClearSafetyPort['assertRecoveryClear']>[0]): Promise<RecoveryClearProof> {
    return {
      principal: { kind: 'controller-session', sessionId: 'host-controller' },
      childQuiescent: true, localInFlight: false, gitVerified: true, workspace: this.proofWorkspace,
    }
  }
}

class NoWorkspaceSafety extends Safety {
  async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof> {
    return {
      principal: { kind: 'controller-session', sessionId: 'host-controller' },
      observationState: request.observation.state as 'durable' | 'missing' | 'not-admitted',
      childQuiescent: true, localInFlight: false, gitVerified: true, leaseIds: [...request.leaseIds ?? []],
    }
  }
}

class BadResolutionSafety extends Safety {
  constructor(readonly mode: 'none' | 'principal' | 'lease' | 'workspace') { super() }
  async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof> {
    if (this.mode === 'none') return undefined as never
    const proof = await super.assertQuiescent(request)
    if (proof === undefined) return proof
    if (this.mode === 'principal') return { ...proof, principal: { kind: 'controller-session', sessionId: '' } }
    if (this.mode === 'lease') return { ...proof, leaseIds: ['foreign-proof-lease'] }
    return { ...proof, workspace: { ...this.proofWorkspace, baselineRef: 'drifted' } }
  }
}

function recoveryClearEvent(index: number, target: 'paused' | 'running' = 'paused', operationId = 'direct-clear'): TeamEvent {
  const proof = { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID }
  return event(index, {
    type: 'yuqi/team-recovery-cleared', operationId: ControlOperationId(operationId), target,
    proof: { principal: { kind: 'controller-session', sessionId: 'host-controller' }, childQuiescent: true, localInFlight: false, gitVerified: true, workspace: proof },
  })
}

function resolutionProofEvent(index: number, overrides: Record<string, unknown> = {}, operationId = `direct-proof-${index}`): TeamEvent {
  const proof = new Safety().proofWorkspace
  return event(index, {
    type: 'yuqi/attempt-resolution-proof-recorded', operationId: ControlOperationId(operationId),
    observationOperationId: ControlOperationId('scan-recovery'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed',
    proof: { principal: { kind: 'controller-session', sessionId: 'host-controller' }, observationState: 'missing', childQuiescent: true, localInFlight: false, gitVerified: true, workspace: proof, leaseIds: [], ...overrides },
  } as never)
}

function unresolvedEvents(): readonly TeamEvent[] {
  return [
    event(1, { type: 'yuqi/team-created', title: 'Recovery', objective: 'negative recovery' }),
    event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    event(3, { type: 'yuqi/task-created', contract: contract() }),
    event(4, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
    event(5, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
    event(6, { type: 'yuqi/workspace-provisioning-started', workspace: WORKSPACE }),
    event(7, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID }),
    event(8, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
    event(9, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'child-reappears', messageId: 'msg-1' }),
    event(10, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'running' }),
    event(11, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'unknown' }),
    event(12, { type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('scan-recovery'), observations: [{ taskId: TASK_ID, attemptId: ATTEMPT_ID, childSessionId: 'child-reappears', state: 'missing' }] }),
    event(13, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
  ]
}

async function resolvedJournal(): Promise<Journal> {
  const journal = new Journal(unresolvedEvents())
  const transactions = new DurableJournalCoordinator()
  await new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:00:00Z' }, { next: () => `resolve-${Math.random()}` }, transactions).resolve({
    teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'resolve-recovery', observationOperationId: 'scan-recovery', decision: 'failed',
  }, journal, new Safety())
  await transactions.dispose()
  return journal
}

describe('durable manual recovery gate', () => {
  it('closes an admitted no-evidence attempt only through proof and defaults to paused', async () => {
    const journal = await resolvedJournal()
    expect(replayTeamEvents(journal.read()).attempts[ATTEMPT_ID]?.resolutionProofOperationId).toBe('resolve-recovery')
    const transactions = new DurableJournalCoordinator()
    let recoveryRequest: Parameters<RecoveryClearSafetyPort['assertRecoveryClear']>[0] | undefined
    const safety = new Safety()
    const cleared = await new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:01:00Z' }, { next: () => 'clear-recovery' }, transactions).clear({
      teamId: TEAM_ID, operationId: 'clear-recovery',
    }, journal, { async assertRecoveryClear(request) { recoveryRequest = request; return safety.assertRecoveryClear(request) } })
    expect(cleared.team.status).toBe('paused')
    expect(cleared.team.status).not.toBe('completed')
    expect(recoveryRequest?.retainDirtyWorkspace).toBe(true)
    await transactions.dispose()
  })

  it('clears a quiescent gate to paused from durable journal facts without Host verification', async () => {
    const journal = await resolvedJournal()
    const transactions = new DurableJournalCoordinator()
    const coordinator = new RecoveryClearCoordinator(
      { nowIso: () => '2026-08-16T00:01:10Z' },
      { next: () => 'clear-from-journal-event' },
      transactions,
    )

    const cleared = await coordinator.clearFromDurableJournal({
      teamId: TEAM_ID, operationId: 'clear-from-journal',
    }, journal, 'controller-dormant')
    expect(cleared.team.status).toBe('paused')
    expect(cleared.recoveryClearOperations['clear-from-journal']).toMatchObject({
      target: 'paused', basis: 'durable-journal', principal: { sessionId: 'controller-dormant' },
    })
    expect(journal.events.at(-1)?.type).toBe('yuqi/team-recovery-cleared-from-journal')
    const eventCount = journal.events.length
    await expect(coordinator.clearFromDurableJournal({
      teamId: TEAM_ID, operationId: 'clear-from-journal',
    }, journal, 'controller-dormant')).resolves.toEqual(cleared)
    expect(journal.events).toHaveLength(eventCount)
    await transactions.dispose()
  })

  it('does not clear a current durable cancellation intent to paused', async () => {
    const journal = await resolvedJournal()
    journal.events.push(event(39, {
      type: 'yuqi/team-control-requested', operationId: ControlOperationId('pending-cancel-clear'), action: 'cancel',
    }))
    const transactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator(
      { nowIso: () => '2026-08-16T00:01:20Z' }, { next: () => 'blocked-clear-event' }, transactions,
    ).clearFromDurableJournal({ teamId: TEAM_ID, operationId: 'blocked-clear' }, journal, 'controller-dormant'))
      .rejects.toThrow(/active cancellation intent/)
    await transactions.dispose()
  })

  it('does not clear a recovery gate while a durable reviewer may still write', async () => {
    const journal = new Journal([
      event(1, {
        type: 'yuqi/team-created', title: 'Recovery review', objective: 'Keep reviewer ownership',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...completeTeamEvents().slice(1, 16),
      event(18, {
        type: 'yuqi/review-requested', reviewId: 'pending-recovery-review', trigger: 'quality-gate',
        candidateEventId: TeamEventId('event-16'), round: 0,
      }),
      event(19, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const transactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator(
      { nowIso: () => '2026-08-16T00:01:25Z' }, { next: () => 'pending-review-clear-event' }, transactions,
    ).clearFromDurableJournal({ teamId: TEAM_ID, operationId: 'pending-review-clear' }, journal, 'controller-dormant'))
      .rejects.toThrow(/reviewer is pending/)
    expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation')
    await transactions.dispose()
  })

  it('does not persist a recovery clear after its caller cancels during Host proof', async () => {
    const journal = await resolvedJournal()
    const eventCount = journal.events.length
    const controller = new AbortController()
    const transactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator(
      { nowIso: () => '2026-08-16T00:01:26Z' }, { next: () => 'cancelled-clear-event' }, transactions,
    ).clear({ teamId: TEAM_ID, operationId: 'cancelled-clear', signal: controller.signal }, journal, {
      async assertRecoveryClear() {
        controller.abort(new Error('cancelled after recovery proof'))
        return new Safety().assertRecoveryClear({} as never)
      },
    })).rejects.toThrow(/cancelled after recovery proof/)
    expect(journal.events).toHaveLength(eventCount)
    expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation')
    await transactions.dispose()
  })

  it('passes unadmitted attempts to host proof without inventing a child binding', async () => {
    const journal = new Journal([
      ...unresolvedEvents().slice(0, 8),
      event(40, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'failed' }),
      event(41, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(42, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const transactions = new DurableJournalCoordinator()
    const cleared = await new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:01:30Z' }, { next: () => 'clear-unadmitted' }, transactions).clear({
      teamId: TEAM_ID, operationId: 'clear-unadmitted',
    }, journal, new Safety())
    expect(cleared.team.status).toBe('paused')
    await transactions.dispose()
  })

  it('persists Git-ready workspace recovery before clearing a workspace gap', async () => {
    const journal = await resolvedJournal()
    journal.events.push(event(30, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'simulated drift' }))
    const transactions = new DurableJournalCoordinator()
    let eventNumber = 0
    const cleared = await new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:02:00Z' }, { next: () => `clear-workspace-${eventNumber++}` }, transactions).clear({
      teamId: TEAM_ID, operationId: 'clear-workspace', target: 'running', signal: new AbortController().signal,
    }, journal, new Safety())
    expect(cleared.workspace?.status).toBe('ready')
    expect(cleared.team.status).toBe('running')
    expect(journal.events.map(item => item.type)).toContain('yuqi/team-recovery-cleared')
    expect(journal.events.map(item => item.type)).toContain('yuqi/workspace-recovery-verified')
    await transactions.dispose()
  })

  it('does not partially commit when the recovery bundle append fails', async () => {
    const journal = await resolvedJournal()
    const before = journal.events.length
    journal.fail = true
    const transactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:03:00Z' }, { next: () => 'clear-failure' }, transactions).clear({
      teamId: TEAM_ID, operationId: 'clear-failure',
    }, journal, new Safety())).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(journal.events).toHaveLength(before)
    await transactions.dispose()
  })

  it('does not leave a proof or terminal child when the resolution bundle append fails', async () => {
    const journal = new Journal(unresolvedEvents())
    const before = journal.events.length
    journal.fail = true
    const transactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:03:30Z' }, { next: (() => { let i = 0; return () => `bundle-failure-${i++}` })() }, transactions).resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'bundle-failure', observationOperationId: 'scan-recovery', decision: 'failed',
    }, journal, new Safety())).rejects.toMatchObject({ code: 'INTENT_PERSISTENCE_FAILED' })
    expect(journal.events).toHaveLength(before)
    await transactions.dispose()
  })

  it('replays an identical clear and rejects a clear requested after the team is paused', async () => {
    const journal = await resolvedJournal()
    const transactions = new DurableJournalCoordinator()
    const coordinator = new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:03:45Z' }, { next: () => 'clear-replay-event' }, transactions)
    await coordinator.clear({ teamId: TEAM_ID, operationId: 'clear-replay' }, journal, new Safety())
    await expect(coordinator.clear({ teamId: TEAM_ID, operationId: 'clear-replay' }, journal, new Safety()))
      .resolves.toMatchObject({ team: { status: 'paused' } })
    await expect(coordinator.clear({ teamId: TEAM_ID, operationId: 'clear-after-paused' }, journal, new Safety()))
      .rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('rejects direct needs-to-running status and a second clear with a different target', async () => {
    const journal = await resolvedJournal()
    expect(() => replayTeamEvents([...journal.read(), event(40, { type: 'yuqi/team-status-changed', from: 'needs_reconciliation', to: 'running' })])).toThrow(/durable recovery proof/)
    const transactions = new DurableJournalCoordinator()
    const coordinator = new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:04:00Z' }, { next: () => 'clear-conflict' }, transactions)
    await coordinator.clear({ teamId: TEAM_ID, operationId: 'clear-conflict' }, journal, new Safety())
    await expect(coordinator.clear({ teamId: TEAM_ID, operationId: 'clear-conflict', target: 'running' }, journal, new Safety())).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await transactions.dispose()
  })

  it('treats budget policy operation ids as globally occupied before host proof', async () => {
    const journal = await resolvedJournal()
    journal.events.push(event(400, {
      type: 'yuqi/budget-policy-set', operationId: ControlOperationId('shared-budget-clear'), revision: 1,
      tokenLimit: 100, alerts: [], stopBehavior: 'block-new',
    }))
    const before = journal.events.length
    let hostCalls = 0
    const transactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:04:30Z' }, { next: () => 'shared-budget-clear-event' }, transactions).clear({
      teamId: TEAM_ID, operationId: 'shared-budget-clear',
    }, journal, { async assertRecoveryClear() { hostCalls += 1; throw new Error('must not reach host') } })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(hostCalls).toBe(0)
    expect(journal.events).toHaveLength(before)
    expect(() => replayTeamEvents([...journal.read(), recoveryClearEvent(401, 'paused', 'shared-budget-clear')])).toThrow(/already used for another command/)
    await transactions.dispose()
  })

  it('replays an identical clear and rejects a conflicting clear operation', async () => {
    const journal = await resolvedJournal()
    const first = recoveryClearEvent(41)
    const same = recoveryClearEvent(42)
    const different = recoveryClearEvent(43, 'running')
    const replayed = replayTeamEvents([...journal.read(), first, same])
    expect(replayed.team.status).toBe('paused')
    expect(() => replayTeamEvents([...journal.read(), first, different])).toThrow(/reused with different content/)
    const conflictJournal = new Journal([...journal.read(), event(44, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('direct-clear'), action: 'pause' })])
    expect(() => replayTeamEvents([...conflictJournal.read(), first])).toThrow(/already used for another command/)
  })

  it('rejects recovery when there is no workspace, an active attempt, verification, lease, or unknown budget', async () => {
    const base = [...unresolvedEvents()]
    const noWorkspace = new Journal(base.filter(item => item.type !== 'yuqi/workspace-provisioning-started' && item.type !== 'yuqi/workspace-provisioned'))
    const noWorkspaceTransactions = new DurableJournalCoordinator()
    let noWorkspaceEvent = 0
    const noWorkspaceResolution = new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:08:00Z' }, { next: () => `no-workspace-event-${noWorkspaceEvent++}` }, noWorkspaceTransactions)
    await noWorkspaceResolution.resolve({ teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'no-workspace-resolution', observationOperationId: 'scan-recovery', decision: 'failed' }, noWorkspace, new NoWorkspaceSafety())
    await noWorkspaceTransactions.dispose()
    const noWorkspaceClearTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:01Z' }, { next: () => 'no-workspace-clear' }, noWorkspaceClearTransactions).clear({ teamId: TEAM_ID, operationId: 'no-workspace-clear' }, noWorkspace, new Safety())).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    await noWorkspaceClearTransactions.dispose()

    const activeAttempt = new Journal([...unresolvedEvents().slice(0, 10), event(45, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })])
    const activeAttemptTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:02Z' }, { next: () => 'active-attempt-clear' }, activeAttemptTransactions).clear({ teamId: TEAM_ID, operationId: 'active-attempt-clear' }, activeAttempt, new Safety())).rejects.toThrow(/unresolved attempt/)
    await activeAttemptTransactions.dispose()

    const activeVerification = new Journal([
      ...unresolvedEvents().slice(0, 10),
      event(46, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'settled' }),
      event(47, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'verify-run', agentSessionId: 'child-reappears', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-16T00:08:03Z' }),
      event(48, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(49, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('recovery-verification'), verifierSessionId: 'verifier' }),
      event(50, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('recovery-verification'), from: 'pending', to: 'running' }),
      event(51, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const activeVerificationTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:04Z' }, { next: () => 'active-verification-clear' }, activeVerificationTransactions).clear({ teamId: TEAM_ID, operationId: 'active-verification-clear' }, activeVerification, new Safety())).rejects.toThrow(/active verification/)
    await activeVerificationTransactions.dispose()

    const activeLease = await resolvedJournal()
    activeLease.events.push(event(52, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('bound-active-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }))
    const activeLeaseTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:05Z' }, { next: () => 'active-lease-clear' }, activeLeaseTransactions).clear({ teamId: TEAM_ID, operationId: 'active-lease-clear' }, activeLease, new Safety())).rejects.toThrow(/active lease/)
    let boundLeaseEvent = 0
    const boundCleared = await new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:05Z' }, { next: () => `bound-lease-clear-event-${boundLeaseEvent++}` }, activeLeaseTransactions).clear({
      teamId: TEAM_ID, operationId: 'bound-lease-clear', releaseOrphanedLeases: true,
    }, activeLease, new Safety())
    expect(boundCleared.fileLeases['bound-active-lease']?.status).toBe('released')
    await activeLeaseTransactions.dispose()

    const orphanLeaseTransactions = new DurableJournalCoordinator()
    let orphanLeaseEvent = 0
    const orphanLease = await resolvedJournal()
    orphanLease.events.push(
      event(53, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('already-released-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      event(54, { type: 'yuqi/file-lease-released', leaseId: FileLeaseId('already-released-lease'), taskId: TASK_ID, reason: 'already settled' }),
      event(55, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('legacy-active-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
    )
    const orphanCleared = await new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:05Z' }, { next: () => `orphan-lease-clear-${orphanLeaseEvent++}` }, orphanLeaseTransactions).clear({
      teamId: TEAM_ID, operationId: 'orphan-lease-clear', releaseOrphanedLeases: true,
    }, orphanLease, new Safety())
    expect(orphanCleared.team.status).toBe('paused')
    expect(orphanCleared.fileLeases['legacy-active-lease']?.status).toBe('released')
    expect(orphanCleared.fileLeases['already-released-lease']?.status).toBe('released')
    await orphanLeaseTransactions.dispose()

    const unknownBudget = new Journal([
      event(60, { type: 'yuqi/team-created', title: 'Unknown budget', objective: 'hold' }),
      event(61, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(62, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('unknown-budget-policy'), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
      event(63, { type: 'yuqi/task-created', contract: contract() }),
      event(64, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'pending', to: 'ready' }),
      event(65, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'ready', to: 'running' }),
      event(66, { type: 'yuqi/workspace-provisioning-started', workspace: WORKSPACE }),
      event(67, { type: 'yuqi/workspace-provisioned', workspaceId: WORKSPACE_ID }),
      event(68, { type: 'yuqi/budget-reservation-acquired', reservationId: 'unknown-budget', taskId: TASK_ID, attemptId: ATTEMPT_ID, tokenReserve: 10 }),
      event(69, { type: 'yuqi/attempt-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, ordinal: 1, modelProvider: 'p', modelId: 'deepseek-v4' }),
      event(70, { type: 'yuqi/attempt-admitted', taskId: TASK_ID, attemptId: ATTEMPT_ID, agentSessionId: 'budget-child', messageId: 'budget-msg' }),
      event(71, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'dispatching', to: 'running' }),
      event(72, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }),
      event(73, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'budget-run', agentSessionId: 'budget-child', provider: 'p', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-16T00:08:06Z' }),
      event(74, { type: 'yuqi/budget-reservation-settled', reservationId: 'unknown-budget', taskId: TASK_ID, attemptId: ATTEMPT_ID, status: 'unknown' }),
      event(75, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }),
      event(76, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ])
    const unknownBudgetTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:08:07Z' }, { next: () => 'unknown-budget-clear' }, unknownBudgetTransactions).clear({ teamId: TEAM_ID, operationId: 'unknown-budget-clear' }, unknownBudget, new Safety())).rejects.toThrow(/unresolved token reservation/)
    await unknownBudgetTransactions.dispose()
  })

  it('fails closed for a foreign active lease during manual resolution', async () => {
    const foreignAttempt = AttemptId('foreign-attempt')
    const journal = new Journal([
      ...unresolvedEvents().slice(0, 7),
      event(20, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('foreign-lease'), taskId: TASK_ID, attemptId: foreignAttempt, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      ...unresolvedEvents().slice(7),
    ])
    const transactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:05:00Z' }, { next: () => 'foreign-resolution' }, transactions).resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'foreign-resolution', observationOperationId: 'scan-recovery', decision: 'failed',
    }, journal, new Safety())).rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    await transactions.dispose()
  })

  it('releases only the exact attempt-bound lease and rejects a legacy unbound lease', async () => {
    const boundJournal = new Journal([
      ...unresolvedEvents().slice(0, 11),
      event(21, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('exact-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      ...unresolvedEvents().slice(11),
    ])
    const transactions = new DurableJournalCoordinator()
    const resolved = await new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:06:00Z' }, { next: (() => { let i = 0; return () => `exact-${i++}` })() }, transactions).resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'exact-resolution', observationOperationId: 'scan-recovery', decision: 'failed',
    }, boundJournal, new Safety())
    expect(resolved.fileLeases['exact-lease']?.status).toBe('released')
    await transactions.dispose()

    const legacyJournal = new Journal([
      ...unresolvedEvents().slice(0, 11),
      event(22, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('legacy-lease'), taskId: TASK_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      ...unresolvedEvents().slice(11),
    ])
    const legacyTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:07:00Z' }, { next: () => 'legacy-resolution' }, legacyTransactions).resolve({
      teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'legacy-resolution', observationOperationId: 'scan-recovery', decision: 'failed',
    }, legacyJournal, new Safety())).rejects.toMatchObject({ code: 'RESOLUTION_NOT_ALLOWED' })
    await legacyTransactions.dispose()
  })

  it('rejects missing, forged, mismatched, and stale resolution proofs before append', async () => {
    const request = { teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'bad-proof', observationOperationId: 'scan-recovery', decision: 'failed' as const }
    for (const mode of ['none', 'principal'] as const) {
      const journal = new Journal(unresolvedEvents())
      const transactions = new DurableJournalCoordinator()
      await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:00Z' }, { next: (() => { let i = 0; return () => `bad-${mode}-${i++}` })() }, transactions).resolve({ ...request, operationId: `bad-${mode}` }, journal, new BadResolutionSafety(mode))).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
      expect(journal.events).toHaveLength(unresolvedEvents().length)
      await transactions.dispose()
    }

    const boundJournal = new Journal([
      ...unresolvedEvents().slice(0, 11),
      event(91, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('proof-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      ...unresolvedEvents().slice(11),
    ])
    const leaseTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:01Z' }, { next: () => 'bad-lease-event' }, leaseTransactions).resolve({ ...request, operationId: 'bad-lease' }, boundJournal, new BadResolutionSafety('lease'))).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    await leaseTransactions.dispose()

    const noWorkspace = new Journal(unresolvedEvents().filter(item => item.type !== 'yuqi/workspace-provisioning-started' && item.type !== 'yuqi/workspace-provisioned'))
    const workspaceTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:02Z' }, { next: () => 'bad-workspace-event' }, workspaceTransactions).resolve({ ...request, operationId: 'bad-workspace' }, noWorkspace, new BadResolutionSafety('workspace'))).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    await workspaceTransactions.dispose()

    const staleCauseTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:02Z' }, { next: () => 'stale-cause-event' }, staleCauseTransactions).resolve({ ...request, operationId: 'stale-cause' }, new Journal(unresolvedEvents()), {
      async assertQuiescent() { throw new YuqiOrchestratorError('RESOLUTION_STALE', 'host observed a newer journal') },
    })).rejects.toMatchObject({ code: 'RESOLUTION_STALE' })
    await staleCauseTransactions.dispose()

    const durableWorkspaceTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:02Z' }, { next: () => 'bad-durable-workspace-event' }, durableWorkspaceTransactions).resolve({ ...request, operationId: 'bad-durable-workspace' }, new Journal(unresolvedEvents()), new BadResolutionSafety('workspace'))).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    await durableWorkspaceTransactions.dispose()

    const staleJournal = new Journal(unresolvedEvents())
    class StaleSafety extends Safety {
      async assertQuiescent(request: Parameters<AttemptResolutionSafetyPort['assertQuiescent']>[0]): Promise<AttemptResolutionProof> {
        const proof = await super.assertQuiescent(request)
        staleJournal.events.push(event(92, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('stale-control'), action: 'pause' }))
        return proof
      }
    }
    const staleTransactions = new DurableJournalCoordinator()
    await expect(new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:09:03Z' }, { next: () => 'stale-resolution-event' }, staleTransactions).resolve({ ...request, operationId: 'stale-resolution' }, staleJournal, new StaleSafety())).rejects.toMatchObject({ code: 'RESOLUTION_STALE' })
    await staleTransactions.dispose()
  })

  it('replay rejects proof operation conflicts, stale observations, foreign leases, and workspace drift', () => {
    const conflictBase = [...unresolvedEvents(), event(100, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('direct-proof-100'), action: 'pause' })]
    expect(() => replayTeamEvents([...conflictBase, resolutionProofEvent(117, {}, 'direct-proof-100')])).toThrow(/already used for another command/)
    const wrongTask = TaskId('wrong-proof-task')
    const wrongTaskBase = [...unresolvedEvents(), event(101, { type: 'yuqi/task-created', contract: { ...contract(wrongTask), fileScope: ['docs/**'] } })]
    expect(() => replayTeamEvents([...wrongTaskBase, event(102, { type: 'yuqi/attempt-resolution-proof-recorded', operationId: ControlOperationId('wrong-task-proof'), observationOperationId: ControlOperationId('scan-recovery'), taskId: wrongTask, attemptId: ATTEMPT_ID, decision: 'failed', proof: { principal: { kind: 'controller-session', sessionId: 'host-controller' }, observationState: 'missing', childQuiescent: true, localInFlight: false, gitVerified: true, workspace: { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID }, leaseIds: [] } })])).toThrow(/does not belong to task/)
    const failedBase = [...unresolvedEvents(), event(103, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'unknown', to: 'failed' }), event(104, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' })]
    expect(() => replayTeamEvents([...failedBase, resolutionProofEvent(105)])).toThrow(/not in a resolvable reconciliation state/)
    expect(() => replayTeamEvents([...unresolvedEvents(), event(106, { type: 'yuqi/attempt-resolution-proof-recorded', operationId: ControlOperationId('stale-proof'), observationOperationId: ControlOperationId('old-scan'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed', proof: { principal: { kind: 'controller-session', sessionId: 'host-controller' }, observationState: 'missing', childQuiescent: true, localInFlight: false, gitVerified: true, workspace: { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID }, leaseIds: [] } } as never)])).toThrow(/latest reconciliation observation/)
    expect(() => replayTeamEvents([...unresolvedEvents(), event(108, { type: 'yuqi/attempt-resolution-proof-recorded', operationId: ControlOperationId('state-proof'), observationOperationId: ControlOperationId('scan-recovery'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed', proof: { principal: { kind: 'controller-session', sessionId: 'host-controller' }, observationState: 'durable', childQuiescent: true, localInFlight: false, gitVerified: true, workspace: { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID }, leaseIds: [] } } as never)])).toThrow(/does not match the latest observation/)
    const foreignLeaseBase = [...unresolvedEvents().slice(0, 11), event(109, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('proof-foreign'), taskId: TASK_ID, attemptId: AttemptId('proof-foreign-attempt'), mode: 'write', fileScope: ['src/**'], status: 'active' } }), ...unresolvedEvents().slice(11)]
    expect(() => replayTeamEvents([...foreignLeaseBase, resolutionProofEvent(110)])).toThrow(/foreign active lease/)
    const boundLeaseBase = [...unresolvedEvents().slice(0, 11), event(111, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('proof-bound'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } }), ...unresolvedEvents().slice(11)]
    expect(() => replayTeamEvents([...boundLeaseBase, resolutionProofEvent(112)])).toThrow(/exact releasable leases/)
    expect(() => replayTeamEvents([...boundLeaseBase, event(118, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('proof-duplicate-binding'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } })])).toThrow(/already has an active file lease/)
    expect(() => replayTeamEvents([...boundLeaseBase, event(119, { type: 'yuqi/file-lease-released', leaseId: FileLeaseId('proof-bound'), taskId: TASK_ID })])).toThrow(/not bound to the supplied attempt/)
    expect(() => replayTeamEvents([...unresolvedEvents(), resolutionProofEvent(113, { workspace: { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID, baselineRef: 'drifted' } })])).toThrow(/resolution proof workspace is not the durable Team workspace/)
    const proofOnce = resolutionProofEvent(114)
    const proofAgain = resolutionProofEvent(115, {}, 'direct-proof-114')
    const proofConflict = resolutionProofEvent(116, { principal: { kind: 'controller-session', sessionId: 'other-controller' } }, 'direct-proof-114')
    expect(replayTeamEvents([...unresolvedEvents(), proofOnce, proofAgain]).attemptResolutionProofs['direct-proof-114']).toBeDefined()
    expect(() => replayTeamEvents([...unresolvedEvents(), proofOnce, proofConflict])).toThrow(/reused with different content/)
    const noWorkspaceProof = resolutionProofEvent(117, { workspace: undefined }, 'no-workspace-proof')
    const noWorkspaceProofAgain = resolutionProofEvent(1171, { workspace: undefined }, 'no-workspace-proof')
    expect(replayTeamEvents([...unresolvedEvents(), noWorkspaceProof, noWorkspaceProofAgain]).attemptResolutionProofs['no-workspace-proof']).toBeDefined()
    expect(() => replayTeamEvents([
      ...unresolvedEvents(), noWorkspaceProof,
      event(118, { type: 'yuqi/attempt-resolution-requested', operationId: ControlOperationId('missing-proof-resolution'), observationOperationId: ControlOperationId('scan-recovery'), taskId: TASK_ID, attemptId: ATTEMPT_ID, decision: 'failed', proofOperationId: ControlOperationId('missing-proof') }),
    ])).toThrow(/does not reference its durable proof/)
  })

  it('replay enforces every recovery-cleared gate and proof identity', async () => {
    const clear = recoveryClearEvent(120)
    const failedGapEvidence = [...unresolvedEvents().slice(0, 10), event(1190, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }), event(1191, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }), event(1192, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })]
    expect(() => replayTeamEvents([...failedGapEvidence, clear])).toThrow(/durable reconciliation gap/)
    const activeAttempt = [...unresolvedEvents().slice(0, 10), event(121, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })]
    expect(() => replayTeamEvents([...activeAttempt, clear])).toThrow(/still active/)
    const activeVerification = [
      ...unresolvedEvents().slice(0, 10),
      event(122, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'settled' }),
      event(123, { type: 'yuqi/attempt-evidence-recorded', taskId: TASK_ID, attemptId: ATTEMPT_ID, runId: 'proof-verify', agentSessionId: 'child-reappears', provider: 'p', stopReason: 'completed', hasAssistantOutput: true, settledAt: '2026-08-16T00:10:00Z' }),
      event(124, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'verifying' }),
      event(125, { type: 'yuqi/verification-created', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('proof-verification'), verifierSessionId: 'verifier' }),
      event(126, { type: 'yuqi/verification-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, verificationId: VerificationId('proof-verification'), from: 'pending', to: 'running' }),
      event(127, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' }),
    ]
    expect(() => replayTeamEvents([...activeVerification, clear])).toThrow(/verification .* still active/)
    const resolved = await resolvedJournal()
    const leaseJournal = new Journal([...resolved.read(), event(128, { type: 'yuqi/file-lease-acquired', lease: { leaseId: FileLeaseId('direct-active-lease'), taskId: TASK_ID, attemptId: ATTEMPT_ID, mode: 'write', fileScope: ['src/**'], status: 'active' } })])
    expect(() => replayTeamEvents([...leaseJournal.read(), clear])).toThrow(/file lease .* still active/)
    const failedEvidence = [...unresolvedEvents().slice(0, 10), event(129, { type: 'yuqi/attempt-status-changed', taskId: TASK_ID, attemptId: ATTEMPT_ID, from: 'running', to: 'failed' }), event(130, { type: 'yuqi/task-status-changed', taskId: TASK_ID, from: 'running', to: 'failed' }), event(131, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation' })]
    expect(() => replayTeamEvents([...failedEvidence, clear])).toThrow(/durable reconciliation gap/)
    const failedJournal = new Journal(failedEvidence)
    const failedTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:01Z' }, { next: () => 'failed-gap-clear' }, failedTransactions).clear({ teamId: TEAM_ID, operationId: 'failed-gap-clear' }, failedJournal, new Safety())).rejects.toThrow(/durable reconciliation gap/)
    await failedTransactions.dispose()

    const activeReservation = [
      ...unresolvedEvents().slice(0, 7),
      event(1310, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId('active-clear-policy'), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
      event(1311, { type: 'yuqi/budget-reservation-acquired', reservationId: 'active-clear-reservation', taskId: TASK_ID, attemptId: ATTEMPT_ID, tokenReserve: 10 }),
      ...unresolvedEvents().slice(7),
    ]
    const activeReservationJournal = new Journal(activeReservation)
    const activeReservationTransactions = new DurableJournalCoordinator()
    let activeReservationEvent = 0
    await new AttemptResolutionCoordinator({ nowIso: () => '2026-08-16T00:10:01Z' }, { next: () => `active-reservation-resolution-${activeReservationEvent++}` }, activeReservationTransactions).resolve({ teamId: TEAM_ID, taskId: TASK_ID, attemptId: ATTEMPT_ID, operationId: 'active-reservation-resolution', observationOperationId: 'scan-recovery', decision: 'failed' }, activeReservationJournal, new Safety())
    expect(() => replayTeamEvents([...activeReservationJournal.read(), recoveryClearEvent(1312)])).toThrow(/budget reservation .* unresolved/)
    await activeReservationTransactions.dispose()
    const needsWorkspace = new Journal([...resolved.read(), event(132, { type: 'yuqi/workspace-reconciliation-required', workspaceId: WORKSPACE_ID, reason: 'drift' })])
    expect(() => replayTeamEvents([...needsWorkspace.read(), clear])).toThrow(/workspace .* not durably ready/)
    expect(() => replayTeamEvents([...resolved.read(), event(1320, { type: 'yuqi/workspace-recovery-verified', workspace: { ...WORKSPACE, workspaceId: WORKSPACE_ID, status: 'ready' } })])).toThrow(/does not require recovery verification/)
    expect(() => replayTeamEvents([
      ...needsWorkspace.read(),
      event(1321, { type: 'yuqi/workspace-recovery-verified', workspace: { ...WORKSPACE, workspaceId: WORKSPACE_ID, status: 'ready', project: { ...WORKSPACE.project, baselineRef: 'drifted' } } }),
    ])).toThrow(/does not match durable identity/)
    const mismatch = recoveryClearEvent(133)
    ;(mismatch as never as { proof: { workspace: { baselineRef: string } } }).proof.workspace.baselineRef = 'drifted'
    expect(() => replayTeamEvents([...resolved.read(), mismatch])).toThrow(/recovery proof does not match/)
    const firstClear = recoveryClearEvent(134)
    const paused = replayTeamEvents([...resolved.read(), firstClear])
    expect(() => replayTeamEvents([...resolved.read(), firstClear, recoveryClearEvent(135, 'paused', 'different-clear')])).toThrow(/while paused/)

    const wrongTeamTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:02Z' }, { next: () => 'wrong-team-clear' }, wrongTeamTransactions).clear({ teamId: TeamId('wrong-team'), operationId: 'wrong-team-clear' }, resolved, new Safety())).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await wrongTeamTransactions.dispose()
    const controlConflict = new Journal([...resolved.read(), event(136, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('control-conflict-clear'), action: 'pause' })])
    const conflictTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:03Z' }, { next: () => 'control-conflict-event' }, conflictTransactions).clear({ teamId: TEAM_ID, operationId: 'control-conflict-clear' }, controlConflict, new Safety())).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await conflictTransactions.dispose()
    const failingSafetyTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:04Z' }, { next: () => 'safety-failure-event' }, failingSafetyTransactions).clear({ teamId: TEAM_ID, operationId: 'safety-failure' }, resolved, { async assertRecoveryClear() { throw new Error('child reappeared') } })).rejects.toThrow(/could not prove Team recovery is safe/)
    await failingSafetyTransactions.dispose()
    const mismatchSafetyTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:05Z' }, { next: () => 'proof-mismatch-event' }, mismatchSafetyTransactions).clear({ teamId: TEAM_ID, operationId: 'proof-mismatch' }, resolved, { async assertRecoveryClear() { return { principal: { kind: 'controller-session' as const, sessionId: 'host-controller' }, childQuiescent: true as const, localInFlight: false as const, gitVerified: true as const, workspace: { ...new Safety().proofWorkspace, workspaceId: WORKSPACE_ID, baselineRef: 'drifted' } } } })).rejects.toThrow(/did not match the durable workspace/)
    await mismatchSafetyTransactions.dispose()

    const raceJournal = await resolvedJournal()
    class RaceSafety extends Safety {
      async assertRecoveryClear(request: Parameters<RecoveryClearSafetyPort['assertRecoveryClear']>[0]): Promise<RecoveryClearProof> {
        raceJournal.events.push(recoveryClearEvent(137, 'paused', 'race-clear'))
        return super.assertRecoveryClear(request)
      }
    }
    const raceTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:06Z' }, { next: () => 'race-event' }, raceTransactions).clear({ teamId: TEAM_ID, operationId: 'race-clear' }, raceJournal, new RaceSafety())).resolves.toMatchObject({ team: { status: 'paused' } })
    await raceTransactions.dispose()
    const staleJournal = await resolvedJournal()
    class StaleClearSafety extends Safety {
      async assertRecoveryClear(request: Parameters<RecoveryClearSafetyPort['assertRecoveryClear']>[0]): Promise<RecoveryClearProof> {
        staleJournal.events.push(event(138, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('stale-clear-control'), action: 'pause' }))
        return super.assertRecoveryClear(request)
      }
    }
    const staleTransactions = new DurableJournalCoordinator()
    await expect(new RecoveryClearCoordinator({ nowIso: () => '2026-08-16T00:10:07Z' }, { next: () => 'stale-clear-event' }, staleTransactions).clear({ teamId: TEAM_ID, operationId: 'stale-clear' }, staleJournal, new StaleClearSafety())).rejects.toMatchObject({ code: 'RECONCILIATION_STALE' })
    await staleTransactions.dispose()
  })
})
