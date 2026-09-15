import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  HarnessSessionJournal,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_DETACHED_EVENT,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_PARENT_REPORT_CHECKPOINT_EVENT,
  TEAM_SESSION_EVENT,
  appendYuqiSessionEvent,
  applyTeamBridgeActivation,
  assertYuqiSessionEventCompatibility,
  buildTeamProjectionBridge,
  emptyTeamBridgeActivationState,
  parseTeamParentBindingData,
  parseTeamParentDetachedData,
  parseTeamProjectionBridgeData,
  parseTeamSessionEventData,
  readActiveTeamParentBinding,
  readLatestTeamParentReportCheckpoint,
  readTeamEventsFromSession,
  readTeamProjectionEvents,
  readTeamProjectionEventsForController,
  registerProcessSessionEventType,
  selectActiveTeamProjectionBridge,
  syncTeamProjectionToParent,
} from '../src/host/harness/session-journal.ts'
import { reportedChangedFilesFrom } from '../src/host/harness/continuable-child.ts'
import {
  HarnessTeamRunnerSupervisor,
  HarnessTeamRunCyclePort,
  type HarnessTeamRunServicePort,
  type HarnessTeamRunnerRegistration,
} from '../src/host/harness/run-cycle.ts'
import {
  StartTeamCoordinator,
  type StartTeamBootstrapPort,
  type StartTeamControllerPort,
  type StartTeamDurableWorkspacePort,
  type StartTeamIdentityPort,
  type StartTeamPhysicalWorkspacePort,
  type StartTeamRecoveryHandle,
  type StartTeamRecoveryStore,
} from '../src/host/harness/start-team.ts'
import { AttemptId, TaskId, TeamId, WorkspaceId, YuqiOrchestratorError, replayTeamEvents } from '../src/index.ts'
import type { TeamEvent, TeamEventJournal, TeamProjection, TeamTaskContract } from '../src/index.ts'
import type { ProjectIdentity, TeamWorkspace } from '../src/domain/workspace.ts'
import {
  DirectWorkspaceOwnershipGuard,
  type DirectWorkspaceSessionPersistence,
} from '../src/host/harness/direct-workspace-ownership.ts'
import { installTeamSettingsWebApi } from '../src/host/harness/team-settings-web-api.ts'
import type { TeamSchedulePlan } from '../src/application/schedule-team.ts'
import type { RunTeamLoopResult } from '../src/application/run-team-loop.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

function controllerSession(id: string, parentSession?: string): Session {
  return Session.create(SessionId(id), [], {
    version: 0,
    id: SessionId(id),
    createdAt: 0,
    cwd: process.cwd(),
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  })
}

function appendTeamFacts(session: Session, facts = completeTeamEvents()): void {
  for (const fact of facts) appendYuqiSessionEvent(session, TEAM_SESSION_EVENT, { event: fact })
}

function bridge(controllerSessionId: string, overrides: Record<string, unknown> = {}) {
  const events = completeTeamEvents()
  return {
    controllerSessionId,
    sourceEventCount: events.length,
    events,
    ...overrides,
  }
}

describe('Host Session journal public branch coverage', () => {
  it('parses valid single, batch, optional bridge and parent payloads and rejects malformed data', () => {
    const facts = completeTeamEvents()
    expect(parseTeamSessionEventData({ event: facts[0] })).toEqual([facts[0]])
    expect(parseTeamSessionEventData({ events: facts })).toEqual(facts)
    expect(parseTeamSessionEventData({ events: [{ type: 'invalid' }] })).toBeUndefined()

    expect(parseTeamProjectionBridgeData(bridge('controller-basic'))).toMatchObject({ controllerSessionId: 'controller-basic' })
    expect(parseTeamProjectionBridgeData(bridge('controller-options', {
      bindingGeneration: 2,
      activationOrdinal: '0000000002-0002',
      activationGeneration: 4,
      bridgeRevision: 3,
    }))).toMatchObject({ bindingGeneration: 2, activationOrdinal: '0000000002-0002', activationGeneration: 4, bridgeRevision: 3 })
    expect(parseTeamProjectionBridgeData({ ...bridge('controller-bad'), events: [] })).toBeUndefined()
    expect(parseTeamProjectionBridgeData({ nope: true })).toBeUndefined()

    const binding = {
      parentSessionId: 'parent-new', previousParentSessionId: 'parent-old', generation: 2,
      operationId: 'bind-2', boundAt: '2026-08-31T00:00:00.000Z',
    }
    expect(parseTeamParentBindingData(binding)).toEqual(binding)
    expect(parseTeamParentBindingData({ ...binding, previousParentSessionId: undefined })).not.toHaveProperty('previousParentSessionId')
    expect(parseTeamParentBindingData({ generation: -1 })).toBeUndefined()
    expect(parseTeamParentDetachedData({ controllerSessionId: 'controller', bindingGeneration: 2 })).toEqual({ controllerSessionId: 'controller', bindingGeneration: 2 })
    expect(parseTeamParentDetachedData(null)).toBeUndefined()
  })

  it('uses explicit binding, skips corrupt binding, and falls back to the immutable legacy parent', () => {
    const explicit = controllerSession('controller-explicit', 'legacy-parent')
    appendYuqiSessionEvent(explicit, TEAM_PARENT_BINDING_EVENT, { invalid: true })
    appendYuqiSessionEvent(explicit, TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'current-parent', previousParentSessionId: 'legacy-parent', generation: 3,
      operationId: 'bind-current', boundAt: '2026-08-31T00:00:00.000Z',
    })
    expect(readActiveTeamParentBinding(explicit)).toMatchObject({ parentSessionId: 'current-parent', generation: 3 })

    const legacy = controllerSession('controller-legacy', 'legacy-parent')
    expect(readActiveTeamParentBinding(legacy)).toMatchObject({ parentSessionId: 'legacy-parent', generation: 0, operationId: 'legacy-header-binding' })
    expect(readActiveTeamParentBinding(controllerSession('controller-orphan'))).toBeUndefined()
  })

  it('fails closed on a corrupt Team stream and builds a complete valid bridge', () => {
    const valid = controllerSession('controller-valid')
    appendTeamFacts(valid)
    expect(readTeamEventsFromSession(valid)).toHaveLength(completeTeamEvents().length)
    expect(buildTeamProjectionBridge(valid)).toMatchObject({ controllerSessionId: 'controller-valid', sourceEventCount: completeTeamEvents().length })
    expect(readTeamProjectionEvents(valid)).toHaveLength(completeTeamEvents().length)

    const empty = controllerSession('controller-empty')
    expect(buildTeamProjectionBridge(empty)).toBeUndefined()
    const corrupt = controllerSession('controller-corrupt')
    appendYuqiSessionEvent(corrupt, TEAM_SESSION_EVENT, { event: { type: 'not-a-team-event' } })
    expect(readTeamEventsFromSession(corrupt)).toEqual([])
    expect(buildTeamProjectionBridge(corrupt)).toBeUndefined()
  })

  it('selects one active bridge by generation, ordinal, revision and detachment', () => {
    let state = emptyTeamBridgeActivationState()
    state = applyTeamBridgeActivation(state, bridge('a', { activationGeneration: 1, activationOrdinal: '0000000001-0001', bridgeRevision: 1 }))
    state = applyTeamBridgeActivation(state, bridge('a', { activationGeneration: 1, activationOrdinal: '0000000001-0001', bridgeRevision: 2 }))
    expect(state.activeBridge).toMatchObject({ controllerSessionId: 'a', bridgeRevision: 2 })

    const conflict = applyTeamBridgeActivation(state, bridge('b', { activationGeneration: 1, activationOrdinal: '0000000003-0003' }))
    expect(conflict).toBe(state)
    const older = applyTeamBridgeActivation(state, bridge('b', { activationGeneration: 2, activationOrdinal: '0000000000-0000' }))
    expect(older.activeBridge?.controllerSessionId).toBe('a')
    const newer = applyTeamBridgeActivation(older, bridge('b', { activationGeneration: 2, activationOrdinal: '0000000002-0002' }))
    expect(newer.activeBridge?.controllerSessionId).toBe('b')

    const events: SessionEvent[] = []
    const parent = controllerSession('parent-select')
    events.push(appendYuqiSessionEvent(parent, TEAM_PARENT_PROJECTION_EVENT, bridge('a', { bindingGeneration: 1, activationGeneration: 1 })))
    events.push(appendYuqiSessionEvent(parent, TEAM_PARENT_PROJECTION_EVENT, { invalid: true }))
    events.push(appendYuqiSessionEvent(parent, TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'a', bindingGeneration: 0 }))
    expect(selectActiveTeamProjectionBridge(events)?.controllerSessionId).toBe('a')
    events.push(appendYuqiSessionEvent(parent, TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'a', bindingGeneration: 1 }))
    expect(selectActiveTeamProjectionBridge(events)).toBeUndefined()
  })

  it('reads exact controller cuts and honours newer detachment tombstones', () => {
    const parent = controllerSession('parent-exact')
    appendYuqiSessionEvent(parent, TEAM_PARENT_PROJECTION_EVENT, bridge('controller-a', { bindingGeneration: 2, bridgeRevision: 1 }))
    expect(readTeamProjectionEventsForController(parent, 'missing')).toBeUndefined()
    expect(readTeamProjectionEventsForController(parent, 'controller-a')).toHaveLength(completeTeamEvents().length)
    appendYuqiSessionEvent(parent, TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'controller-a', bindingGeneration: 1 })
    expect(readTeamProjectionEventsForController(parent, 'controller-a')).toHaveLength(completeTeamEvents().length)
    appendYuqiSessionEvent(parent, TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'controller-a', bindingGeneration: 2 })
    expect(readTeamProjectionEventsForController(parent, 'controller-a')).toBeUndefined()
  })

  it('syncs a controller bridge once, retries its flush, and fails closed for unavailable parents', async () => {
    const parent = controllerSession('parent-sync')
    const controller = controllerSession('controller-sync')
    appendTeamFacts(controller)
    appendYuqiSessionEvent(controller, TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: 'parent-sync', generation: 1, operationId: 'bind-sync', boundAt: '2026-08-31T00:00:00.000Z',
    })
    const flush = vi.fn(async () => true)
    const store = { get: (id: Session['id']) => String(id) === 'parent-sync' ? parent : undefined, flush }
    await expect(syncTeamProjectionToParent(controller, store)).resolves.toBe(true)
    await expect(syncTeamProjectionToParent(controller, store)).resolves.toBe(true)
    expect(parent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)
    expect(flush).toHaveBeenCalledTimes(2)

    await expect(syncTeamProjectionToParent(controllerSession('orphan'), store)).resolves.toBe(false)
    await expect(syncTeamProjectionToParent(controller, { flush })).resolves.toBe(false)
    await expect(syncTeamProjectionToParent(controller, { flush, get: () => undefined })).resolves.toBe(false)
    await expect(syncTeamProjectionToParent(controller, { ...store, flush: async () => { throw new Error('disk') } })).resolves.toBe(false)
  })

  it('marks downstream events ignorable, verifies native append/replay, and keeps process registration idempotent', () => {
    const session = controllerSession('event-envelope')
    const appended = appendYuqiSessionEvent(session, TEAM_SESSION_EVENT, { event: completeTeamEvents()[0] })
    expect(appended).toMatchObject({ type: TEAM_SESSION_EVENT })
    expect(() => assertYuqiSessionEventCompatibility(session)).not.toThrow()

    const runtime = session.constructor as unknown as { prototype: { append: Function } }
    const originalAppend = runtime.prototype.append
    try {
      // A capability marker is not part of the production contract. Exercise
      // the real failure mode by making native append drop ignorable metadata;
      // the compatibility probe must reject it before any live Session write.
      Object.defineProperty(runtime.prototype, 'append', {
        configurable: true,
        value: function (this: Session, type: string, data: unknown) {
          return originalAppend.call(this, type, data)
        },
      })
      expect(() => assertYuqiSessionEventCompatibility(session)).toThrow(/does not support ignorable/)
    } finally {
      Object.defineProperty(runtime.prototype, 'append', { configurable: true, value: originalAppend })
    }

    const key = Symbol.for('@deepseek-ai/dsh-session/downstream-event-types/v1')
    const globals = globalThis as typeof globalThis & Record<symbol, unknown>
    delete globals[key]
    expect(registerProcessSessionEventType('yuqi/test-a')()).toBeUndefined()
    expect(globals[key]).toBeInstanceOf(Set)
    expect(registerProcessSessionEventType('yuqi/test-b')()).toBeUndefined()
    expect([...(globals[key] as Set<string>)]).toEqual(['yuqi/test-a', 'yuqi/test-b'])
  })

  it('selects the latest valid report checkpoint and rejects conflicting durable identities', async () => {
    const session = controllerSession('checkpoint-controller')
    const sessions = { flush: vi.fn(async () => true) }
    const journal = new HarnessSessionJournal(session, sessions)
    session.append(TEAM_PARENT_REPORT_CHECKPOINT_EVENT, { invalid: true } as never)
    session.append(TEAM_PARENT_REPORT_CHECKPOINT_EVENT, {
      controllerSessionId: 'other-controller', parentSessionId: 'parent', bindingGeneration: 1,
      sourceEventCount: 99, messageId: 'other-message', deliveredAt: '2026-09-01T00:00:00.000Z',
    })
    const first = {
      controllerSessionId: 'checkpoint-controller', parentSessionId: 'parent', bindingGeneration: 1,
      sourceEventCount: 2, messageId: 'message-2', deliveredAt: '2026-09-01T00:00:00.000Z',
    }
    const latest = { ...first, sourceEventCount: 3, messageId: 'message-3' }
    session.append(TEAM_PARENT_REPORT_CHECKPOINT_EVENT, first)
    session.append(TEAM_PARENT_REPORT_CHECKPOINT_EVENT, latest)
    expect(readLatestTeamParentReportCheckpoint(session, 'parent', 1)).toMatchObject(latest)
    await expect(journal.commitParentReportCheckpoint({ ...latest, controllerSessionId: 'foreign' })).rejects.toThrow(/does not belong/u)
    await expect(journal.commitParentReportCheckpoint(latest)).resolves.toBeUndefined()
    await expect(journal.commitParentReportCheckpoint({ ...latest, messageId: 'conflicting-message' })).rejects.toThrow(/conflicting message identities/u)
  })

})

describe('Host child report parser residual branch coverage', () => {
  it('ignores non-text blocks, non-array JSON, and non-string entries', () => {
    expect(reportedChangedFilesFrom([{ type: 'image', image_url: 'data:image/png;base64,' } as never])).toEqual({})
    expect(reportedChangedFilesFrom([{ type: 'text', text: 'YUQI_CHANGED_FILES: {"file":"a.ts"}' }])).toEqual({})
    expect(reportedChangedFilesFrom([{ type: 'text', text: 'YUQI_CHANGED_FILES: [1,null,"src/a.ts"]' }]))
      .toEqual({ reportedChangedFiles: ['src/a.ts'] })
  })
})

function runnerResult(status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'): RunTeamLoopResult {
  return {
    projection: { team: { id: 'runner-team', status } },
    reason: status === 'completed' ? 'completed' : status === 'paused' ? 'paused' : status === 'running' ? 'quiescent' : 'failed',
    disposition: status === 'completed' ? 'completed' : 'recoverable',
    cycles: 1,
  } as RunTeamLoopResult
}

const runnerController = { options: { provider: 'provider-a' } } as Agent

describe('Host runner lifecycle public branch coverage', () => {
  it('rejects incompatible duplicate registrations and all operations after disposal', async () => {
    const supervisor = new HarnessTeamRunnerSupervisor()
    const first: HarnessTeamRunnerRegistration = {
      journalKey: 'duplicate', teamId: 'runner-team', controller: runnerController, maxConcurrency: 1,
      async run() { return runnerResult('paused') },
    }
    await supervisor.run(first)
    expect(() => supervisor.run({ ...first, teamId: 'other-team' })).toThrow(/different run semantics/)
    await Promise.all(supervisor.dispose())
    expect(() => supervisor.run(first)).toThrow(/disposed/)
    expect(supervisor.wake('missing')).toBeUndefined()
    expect(supervisor.interrupt('missing')).toBe(false)
    expect(supervisor.release('missing')).toBeUndefined()
  })

  it('coalesces run/wake/join, interrupts an active operation, and releases without a disposer', async () => {
    const supervisor = new HarnessTeamRunnerSupervisor()
    let resolve!: (value: RunTeamLoopResult) => void
    const registration: HarnessTeamRunnerRegistration = {
      journalKey: 'coalesce', teamId: 'runner-team', controller: runnerController, maxConcurrency: 1,
      run(signal) {
        return new Promise(done => {
          resolve = done
          signal.addEventListener('abort', () => done(runnerResult('paused')), { once: true })
        })
      },
    }
    const run = supervisor.run(registration)
    expect(supervisor.run(registration)).toBe(run)
    expect(supervisor.wake('coalesce')).toBe(run)
    expect(supervisor.interrupt('coalesce', 'test')).toBe(true)
    await expect(run).resolves.toMatchObject({ reason: 'paused' })
    resolve(runnerResult('paused'))
    expect(supervisor.release('coalesce', 'done', false)).toBeUndefined()
    expect(supervisor.has('coalesce')).toBe(false)
  })

  it('retries a transient controller disposal and makes release idempotent', async () => {
    const supervisor = new HarnessTeamRunnerSupervisor()
    const dispose = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(undefined)
    const registration: HarnessTeamRunnerRegistration = {
      journalKey: 'dispose-retry', teamId: 'runner-team', controller: runnerController, maxConcurrency: 1,
      async run() { return runnerResult('paused') }, disposeController: dispose,
    }
    await supervisor.run(registration)
    await expect(supervisor.release('dispose-retry', 'first', true)).rejects.toThrow('transient')
    await expect(supervisor.release('dispose-retry', 'second', true)).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(supervisor.release('dispose-retry')).toBeUndefined()
  })

  it('waits for a wake lease before shutdown and rejects wake after release', async () => {
    const supervisor = new HarnessTeamRunnerSupervisor()
    const dispose = vi.fn(async () => {})
    const registration: HarnessTeamRunnerRegistration = {
      journalKey: 'lease', teamId: 'runner-team', controller: runnerController, maxConcurrency: 1,
      async run() { return runnerResult('paused') }, disposeController: dispose,
    }
    await supervisor.run(registration)
    const lease = supervisor.acquireWakeLease('lease')!
    expect(supervisor.acquireWakeLease('missing')).toBeUndefined()
    const shutdown = supervisor.dispose()[0]!
    expect(lease.wake()).toBeDefined()
    lease.release()
    lease.release()
    expect(lease.wake()).toBeUndefined()
    await shutdown
    expect(dispose).toHaveBeenCalledOnce()
  })
})

class MemoryJournal implements TeamEventJournal {
  readonly key = 'host-branch-memory'
  readonly events: TeamEvent[]
  constructor(events: readonly TeamEvent[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function runningJournal(): MemoryJournal {
  const workspace = {
    workspaceId: WorkspaceId('workspace-host-branch'),
    project: {
      projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
      baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
    },
    worktreePath: 'F:\\managed\\host-branch', branchName: 'yuqi/host-branch', status: 'provisioning' as const,
  }
  return new MemoryJournal([
    ...completeTeamEvents().slice(0, 4),
    event(90, { type: 'yuqi/workspace-provisioning-started', workspace }),
    event(91, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
  ])
}

function runnablePlan(overrides: Partial<TeamSchedulePlan> = {}): TeamSchedulePlan {
  return {
    status: 'runnable', activeTaskIds: [], readyTaskIds: [TaskId('task-1')], blockedTaskIds: [], newlyBlockedTaskIds: [],
    unblockedTaskIds: [], dispatchTaskIds: [TaskId('task-1')], availableSlots: 1,
    sourceLastEventAt: '2026-08-15T00:00:05.000Z', sourceLastEventId: 'event-5',
    ...overrides,
  }
}

function runService(overrides: Partial<HarnessTeamRunServicePort> = {}): HarnessTeamRunServicePort {
  return {
    async executeGatedBatch() { return { handles: [] } },
    async beginVerification() {},
    async collectVerificationEvidence() { return { verificationVerdictOperations: {} } as TeamProjection },
    evidenceCapabilities() { return [] },
    ...overrides,
  }
}

const identities = {
  attemptId: () => 'attempt-host-branch', leaseId: () => 'lease-host-branch',
  verificationId: () => 'verification-host-branch', operationId: () => 'verdict-host-branch',
}

describe('Host run-cycle public error and fallback branches', () => {
  it('rejects mismatched teams, missing workspaces, tasks, providers, models and identities', async () => {
    const signal = new AbortController().signal
    const base = { teamId: TeamId('team-1'), journal: runningJournal(), plan: runnablePlan(), signal }
    const port = new HarnessTeamRunCyclePort(runService(), { controller: runnerController, identities })
    await expect(port.executeBatch({ ...base, teamId: TeamId('wrong-team') })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const noWorkspace = new MemoryJournal(completeTeamEvents().slice(0, 3))
    await expect(port.executeBatch({ ...base, journal: noWorkspace })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })

    await expect(port.executeBatch({ ...base, plan: runnablePlan({ dispatchTaskIds: [TaskId('missing')] }) })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    const noProvider = new HarnessTeamRunCyclePort(runService(), { controller: { options: {} } as Agent, identities })
    await expect(noProvider.executeBatch(base)).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })

    const badIds = new HarnessTeamRunCyclePort(runService(), { controller: runnerController, identities: { ...identities, attemptId: () => '' } })
    await expect(badIds.executeBatch(base)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
  })

  it('requires public routing/wait/schedule/completion capabilities and propagates cancellation', async () => {
    const signal = new AbortController().signal
    const structuredFacts = completeTeamEvents().slice(0, 5).map(fact => fact.type === 'yuqi/team-created'
      ? { ...fact, modelRouting: { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'inherit' } } }
      : fact)
    const ready = runningJournal().events
    const structured = new MemoryJournal([
      ...structuredFacts.slice(0, 3) as TeamEvent[],
      ...ready.slice(4),
    ])
    const port = new HarnessTeamRunCyclePort(runService(), { controller: runnerController, identities })
    await expect(port.executeBatch({ teamId: TeamId('team-1'), journal: structured, plan: runnablePlan(), signal })).rejects.toMatchObject({ code: 'FIXED_MODEL_UNAVAILABLE' })
    await expect(port.waitForProgress({ teamId: TeamId('team-1'), journal: structured, activeTaskIds: [], signal })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await expect(port.persistScheduleState({ teamId: TeamId('team-1'), journal: structured, plan: runnablePlan(), taskTransitions: [], requiresReconciliation: false, signal })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await expect(port.coordinateCompletion({ teamId: TeamId('team-1'), journal: structured, signal })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(port.waitForProgress({ teamId: TeamId('team-1'), journal: structured, activeTaskIds: [], signal: aborted.signal })).rejects.toThrow()
    await expect(port.persistScheduleState({ teamId: TeamId('team-1'), journal: structured, plan: runnablePlan(), taskTransitions: [], requiresReconciliation: false, signal: aborted.signal })).rejects.toThrow()
    await expect(port.coordinateCompletion({ teamId: TeamId('team-1'), journal: structured, signal: aborted.signal })).rejects.toThrow()
  })

  it('accepts an empty dispatch and rejects incomplete or unresolved admissions', async () => {
    const signal = new AbortController().signal
    const journal = runningJournal()
    const empty = new HarnessTeamRunCyclePort(runService(), { controller: runnerController, identities })
    await expect(empty.executeBatch({ teamId: TeamId('team-1'), journal, plan: runnablePlan({ dispatchTaskIds: [] }), signal })).resolves.toBeUndefined()

    const incomplete = new HarnessTeamRunCyclePort(runService({ async executeGatedBatch() { return { handles: [] } } }), { controller: runnerController, identities })
    await expect(incomplete.executeBatch({ teamId: TeamId('team-1'), journal, plan: runnablePlan(), signal })).rejects.toMatchObject({ code: 'INVALID_BATCH' })

    const rejection = new Error('admission unknown')
    const unresolved = new HarnessTeamRunCyclePort(runService({
      async executeGatedBatch() {
        return { handles: [{ taskId: 'task-1', attemptId: 'attempt-host-branch', admission: Promise.reject(rejection), settled: Promise.resolve() }] }
      },
    }), { controller: runnerController, identities })
    await expect(unresolved.executeBatch({ teamId: TeamId('team-1'), journal, plan: runnablePlan(), signal })).rejects.toBe(rejection)
  })
})

const gitIdentity: ProjectIdentity = {
  projectRoot: 'F:\\project', repositoryRoot: 'F:\\project', gitCommonDirectory: 'F:\\project\\.git',
  baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
}

const startTask: TeamTaskContract = {
  ...contract(TaskId('start-task')),
  baselineRef: 'caller-ref',
}

function startWorkspace(root: string, overrides: Partial<TeamWorkspace> = {}): TeamWorkspace {
  return {
    workspaceId: WorkspaceId('workspace-start'), project: gitIdentity,
    worktreePath: path.resolve(root, 'workspace-start'), branchName: 'yuqi/team-start', status: 'ready',
    ...overrides,
  }
}

function startRequest(root: string) {
  return {
    title: 'Branch Team', objective: 'Cover public Host start branches', tasks: [startTask], projectCwd: 'F:\\project',
    controllerModel: { model: 'controller-model' }, controllerParentSessionId: 'parent', childPresetId: 'worker', managedRoot: root,
  }
}

function recoveryStore(failPhase?: string): StartTeamRecoveryStore {
  let current: StartTeamRecoveryHandle | undefined
  return {
    async create(plan) {
      current = {
        schemaVersion: 1, recoveryId: plan.teamId, ownerProof: '00000000-0000-4000-8000-000000000001', phase: 'planned',
        teamId: plan.teamId, workspaceId: plan.workspaceId, projectRoot: plan.identity.projectRoot,
        repositoryRoot: plan.identity.repositoryRoot, gitCommonDirectory: plan.identity.gitCommonDirectory,
        baselineRef: plan.identity.baselineRef, managedRoot: plan.managedRoot, worktreePath: plan.worktreePath,
        branchName: plan.branchName, createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
      }
      return current
    },
    async advance(handle, phase, controllerSessionId) {
      if (phase === failPhase) throw new Error(`fail ${phase}`)
      current = { ...handle, phase, updatedAt: '2026-08-31T00:00:01.000Z', ...(controllerSessionId === undefined ? {} : { controllerSessionId }) }
      return current
    },
    async list() { return current === undefined ? [] : [current] },
  }
}

function startCoordinator(root: string, failures: { physical?: Error; launch?: Error; bootstrap?: Error; durable?: Error; dispose?: Error; recoveryPhase?: string } = {}) {
  const workspace = startWorkspace(root)
  const calls: string[] = []
  const physical: StartTeamPhysicalWorkspacePort = {
    async inspect() { calls.push('inspect'); return gitIdentity },
    async provision() { calls.push('physical'); if (failures.physical) throw failures.physical; return workspace },
  }
  const launcher: StartTeamControllerPort<{ id: string }, { model: string }> = {
    async launch() {
      calls.push('launch')
      if (failures.launch) throw failures.launch
      return { sessionId: 'controller-start', controller: { id: 'controller-start' }, async dispose() { calls.push('dispose'); if (failures.dispose) throw failures.dispose } }
    },
  }
  const bootstrap: StartTeamBootstrapPort<{ id: string }, { status: string }> = {
    async bootstrap() { calls.push('bootstrap'); if (failures.bootstrap) throw failures.bootstrap; return { status: 'running' } },
  }
  const durable: StartTeamDurableWorkspacePort<{ id: string }> = {
    async provision() { calls.push('durable'); if (failures.durable) throw failures.durable; return workspace },
  }
  const ids: StartTeamIdentityPort = { nextTeamId: () => 'team-start', nextWorkspaceId: () => 'workspace-start' }
  return { coordinator: new StartTeamCoordinator(physical, launcher, bootstrap, durable, ids, recoveryStore(failures.recoveryPhase)), calls, workspace }
}

describe('Host start-team public validation and recovery branches', () => {
  it.each([
    ['preserved', undefined, new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'bounded workspace reason'), 'UNSAFE_WORKSPACE_PATH'],
    ['git', undefined, new Error('raw git failure'), 'GIT_PROJECT_UNSUPPORTED'],
    ['direct', 'direct', new Error('raw directory failure'), 'UNSAFE_WORKSPACE_PATH'],
  ] as const)('maps the %s inspection failure without creating a workspace', async (_label, workspaceMode, failure, code) => {
    const physical: StartTeamPhysicalWorkspacePort = {
      async inspect() { throw failure },
      async provision() { throw new Error('unreachable') },
    }
    const coordinator = new StartTeamCoordinator(
      physical,
      { async launch() { throw new Error('unreachable') } },
      { async bootstrap() { throw new Error('unreachable') } },
      { async provision() { throw new Error('unreachable') } },
      { nextTeamId: () => 'team-inspect', nextWorkspaceId: () => 'workspace-inspect' },
      recoveryStore(),
    )
    await expect(coordinator.start({
      ...startRequest(path.resolve('F:\\managed-inspection')),
      ...(workspaceMode === undefined ? {} : { workspaceMode }),
    } as never)).rejects.toMatchObject({ code })
  })

  it('rejects unsafe generated Team and workspace identities', async () => {
    const root = path.resolve('F:\\managed-unsafe-identities')
    const workspace = startWorkspace(root)
    const coordinator = new StartTeamCoordinator(
      { async inspect() { return gitIdentity }, async provision() { return workspace } },
      { async launch() { throw new Error('unreachable') } },
      { async bootstrap() { throw new Error('unreachable') } },
      { async provision() { return workspace } },
      { nextTeamId: () => '', nextWorkspaceId: () => 'bad workspace id' },
      recoveryStore(),
    )
    await expect(coordinator.start(startRequest(root))).rejects.toMatchObject({ code: 'INVALID_BATCH' })
  })

  it.each([
    ['blank title', (base: ReturnType<typeof startRequest>) => ({ ...base, title: ' ' })],
    ['blank objective', (base: ReturnType<typeof startRequest>) => ({ ...base, objective: '' })],
    ['blank cwd', (base: ReturnType<typeof startRequest>) => ({ ...base, projectCwd: '' })],
    ['null model', (base: ReturnType<typeof startRequest>) => ({ ...base, controllerModel: null })],
    ['relative root', (base: ReturnType<typeof startRequest>) => ({ ...base, managedRoot: 'relative' })],
    ['blank preset', (base: ReturnType<typeof startRequest>) => ({ ...base, childPresetId: ' ' })],
    ['blank parent', (base: ReturnType<typeof startRequest>) => ({ ...base, controllerParentSessionId: '' })],
    ['bad routing', (base: ReturnType<typeof startRequest>) => ({ ...base, modelRouting: { providerScope: { kind: 'bad' }, teamPolicy: { kind: 'inherit' } } })],
  ] as const)('rejects %s before a Host side effect', async (_name, mutate) => {
    const root = path.resolve('F:\\managed-start-invalid')
    const setup = startCoordinator(root)
    await expect(setup.coordinator.start(mutate(startRequest(root)) as never)).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    expect(setup.calls).toEqual([])
  })

  it.each([
    ['physical', { physical: new Error('physical') }, 'WORKSPACE_REQUIRES_RECONCILIATION'],
    ['launch', { launch: new Error('launch') }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
    ['bootstrap', { bootstrap: new Error('bootstrap') }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
    ['durable', { durable: new Error('durable') }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
    ['dispose', { bootstrap: new Error('bootstrap'), dispose: new Error('dispose') }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
    ['recovery launch', { recoveryPhase: 'controller-launched' }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
    ['recovery complete', { recoveryPhase: 'completed' }, 'CONTROLLER_REQUIRES_RECONCILIATION'],
  ] as const)('fails closed at the %s lifecycle boundary', async (_name, failures, code) => {
    const root = path.resolve(`F:\\managed-start-${_name}`)
    const setup = startCoordinator(root, failures)
    await expect(setup.coordinator.start(startRequest(root))).rejects.toMatchObject({ code })
  })

  it('honours cancellation before inspection and after workspace creation', async () => {
    const root = path.resolve('F:\\managed-start-abort')
    const before = startCoordinator(root)
    const aborted = new AbortController()
    aborted.abort()
    await expect(before.coordinator.start({ ...startRequest(root), signal: aborted.signal })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    expect(before.calls).toEqual([])

    const during = startCoordinator(root)
    const signal = new AbortController()
    const physical = (during.coordinator as unknown) as { start(value: ReturnType<typeof startRequest> & { signal: AbortSignal }): Promise<unknown> }
    signal.abort()
    await expect(physical.start({ ...startRequest(root), signal: signal.signal })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })

  it('rejects a mismatched physical workspace and a mismatched durable confirmation', async () => {
    const root = path.resolve('F:\\managed-start-mismatch')
    const workspace = startWorkspace(root)
    const ids: StartTeamIdentityPort = { nextTeamId: () => 'team-start', nextWorkspaceId: () => 'workspace-start' }
    const launcher: StartTeamControllerPort<{ id: string }, { model: string }> = {
      async launch() { return { sessionId: 'controller', controller: { id: 'controller' }, async dispose() {} } },
    }
    const bootstrap: StartTeamBootstrapPort<{ id: string }, { status: string }> = { async bootstrap() { return { status: 'running' } } }

    const badPhysical = new StartTeamCoordinator(
      { async inspect() { return gitIdentity }, async provision() { return { ...workspace, branchName: 'wrong' } } },
      launcher, bootstrap, { async provision() { return workspace } }, ids, recoveryStore(),
    )
    await expect(badPhysical.start(startRequest(root))).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRES_RECONCILIATION' })

    const badDurable = new StartTeamCoordinator(
      { async inspect() { return gitIdentity }, async provision() { return workspace } },
      launcher, bootstrap, { async provision() { return { ...workspace, branchName: 'wrong' } } }, ids, recoveryStore(),
    )
    await expect(badDurable.start(startRequest(root))).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  })
})

function directOwnerSession(
  id: string,
  projectRoot: string,
  options: { readonly direct?: boolean; readonly protectedRoots?: readonly string[] } = {},
): Session {
  const taskId = TaskId(`owner-${id}`)
  const workspaceId = WorkspaceId(`workspace-${id}`)
  const session = controllerSession(id)
  appendYuqiSessionEvent(session, TEAM_SESSION_EVENT, {
    events: [
      event(8_000, { type: 'yuqi/team-created', title: `Owner ${id}`, objective: 'Exercise ownership branches' }),
      event(8_001, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(8_002, { type: 'yuqi/task-created', contract: { ...contract(taskId), authorityMode: 'write-authorized' } }),
      event(8_003, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: {
          workspaceId,
          project: options.direct === false
            ? gitIdentity
            : { mode: 'direct', projectRoot, volumeRoot: path.parse(projectRoot).root, protectedRoots: options.protectedRoots ?? [] },
          worktreePath: projectRoot,
          branchName: options.direct === false ? 'yuqi/other' : 'direct',
          status: 'provisioning',
        } as never,
      }),
      event(8_004, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ],
  })
  return session
}

describe('Host direct ownership defensive branch coverage', () => {
  it('ignores mismatched, corrupt, and non-direct persisted histories while preserving signal-aware inspection', async () => {
    const projectRoot = path.resolve('F:\\coverage-direct-project')
    const requestedIdentity = { mode: 'direct' as const, projectRoot, volumeRoot: 'F:\\', protectedRoots: [] }
    const mismatched = directOwnerSession('stored-mismatch', projectRoot)
    const corrupt = directOwnerSession('stored-corrupt', projectRoot)
    const nonDirect = directOwnerSession('stored-git', projectRoot, { direct: false })
    const headers = [mismatched.header, corrupt.header, nonDirect.header]
    const persistence: DirectWorkspaceSessionPersistence = {
      async list() { return headers },
      async inspect(id) {
        if (String(id) === 'stored-mismatch') return { meta: { ...mismatched.header, id: SessionId('different-id') }, events: mismatched.events }
        if (String(id) === 'stored-corrupt') return { meta: { ...corrupt.header, version: -1 } as SessionHeader, events: corrupt.events }
        return { meta: nonDirect.header, events: nonDirect.events }
      },
    }
    const inspect = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return requestedIdentity
    })
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: { inspect } as never,
      sessions: { list: () => [] } as never,
      persistence,
      platform: 'win32',
    })
    const signal = new AbortController().signal
    await expect(ownership.withWriterAdmission({ projectRoot, signal }, async identity => identity.projectRoot))
      .resolves.toBe(projectRoot)
    expect(inspect).toHaveBeenCalled()
  })

  it('serializes three same-key admissions and keeps a failed operation from retaining the lock', async () => {
    const projectRoot = path.resolve('F:\\coverage-direct-lock')
    const identity = { mode: 'direct' as const, projectRoot, volumeRoot: 'F:\\', protectedRoots: [] }
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: { inspect: vi.fn(async () => identity) } as never,
      sessions: { list: () => [] } as never,
      persistence: { async list() { return [] }, async inspect() { throw new Error('unused') } },
      platform: 'win32',
    })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    const first = ownership.withWriterAdmission({ projectRoot }, async () => { order.push('first'); await held })
    const second = ownership.withWriterAdmission({ projectRoot }, async () => { order.push('second'); throw new Error('expected operation failure') })
    const third = ownership.withWriterAdmission({ projectRoot }, async () => { order.push('third'); return 'ok' })
    await vi.waitFor(() => expect(order).toEqual(['first']))
    release()
    await first
    await expect(second).rejects.toThrow('expected operation failure')
    await expect(third).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('ignores an unrelated historical writer whose canonical workspace can no longer be inspected', async () => {
    const projectRoot = path.resolve('F:\\coverage-direct-requested')
    const historicalRoot = path.resolve('F:\\coverage-direct-unavailable')
    const historical = directOwnerSession('uninspectable-owner', historicalRoot)
    const inspect = vi.fn(async ({ projectRoot: candidate }: { projectRoot: string }) => {
      if (candidate === historicalRoot) throw new Error('historical realpath unavailable')
      return { mode: 'direct' as const, projectRoot, volumeRoot: 'F:\\', protectedRoots: [] }
    })
    const ownership = new DirectWorkspaceOwnershipGuard({
      workspaces: { inspect } as never,
      sessions: { list: () => [historical] } as never,
      persistence: { async list() { return [] }, async inspect() { throw new Error('unused') } },
      platform: 'win32',
    })
    await expect(ownership.withWriterAdmission({ projectRoot }, async () => 'admitted')).resolves.toBe('admitted')
    expect(inspect).toHaveBeenCalledTimes(2)
  })
})

describe('Host Team settings bridge residual branch coverage', () => {
  it('normalizes an absent secrets list and rejects a successful write whose namespace disappears', async () => {
    const official = {
      describe: vi.fn(async (request: { rpcId: string }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: { writable: true, hasDocument: false, namespaces: [] } },
      })),
      openDocument: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn(),
    }
    const apiProxy = { settings: official }
    let available = true
    const settings = {
      describe: vi.fn(() => available ? [{
        ns: 'yuqi-team-orchestrator', schema: {}, value: {}, applies: 'live' as const, revision: 1,
      }] : []),
      update: vi.fn(async () => { available = false }),
      replace: vi.fn(), mutate: vi.fn(),
    }
    const ctx = { get: () => apiProxy, settings, effect: vi.fn() } as unknown as Context
    installTeamSettingsWebApi(ctx)
    await expect(apiProxy.settings.describe({ rpcId: 'describe' } as never)).resolves.toMatchObject({
      result: { ok: true, value: { namespaces: [{ secrets: [] }] } },
    })
    await expect(apiProxy.settings.update({
      rpcId: 'update', payload: { ns: 'yuqi-team-orchestrator', patch: {} },
    } as never)).resolves.toMatchObject({
      result: { ok: false, error: { code: 'settings-rejected', message: expect.stringContaining('is unavailable') } },
    })
  })
})
