import { Context } from '@deepseek-ai/cordis'
import { snapshotOnlySession } from './snapshot-session-fixture.ts'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createMessage, freezeMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { snapshotSubagentDescriptor, SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import {
  AttemptId,
  ControlOperationId,
  FileLeaseId,
  HarnessModelCatalogPort,
  HarnessAttemptRuntimeObservationPort,
  HarnessAttemptResolutionSafetyPort,
  HarnessSessionJournal,
  NodeGitWorkspacePort,
  planTeamSchedule,
  replayTeamEvents,
  SubprocessEvidenceCollector,
  unsupportedVerificationCheck,
  TEAM_SESSION_EVENT,
  TeamEventId,
  TaskId,
  YuqiTeamOrchestratorService,
  VerificationId,
  WorkspaceId,
} from '../src/index.ts'
import { CHILD_EXECUTION_TIMEOUT_MS, HarnessContinuableChildPort, hasEffectiveAssistantOutput, reportedChangedFilesFrom } from '../src/host/harness/continuable-child.ts'
import { hasOnlyLocallyManagedActiveAttempts } from '../src/host/harness/service.ts'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import { readActiveTeamParentBinding, readTeamEventsFromSession, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT, TEAM_PARENT_REPORT_CHECKPOINT_EVENT } from '../src/host/harness/session-journal.ts'
import type { ChildEnd } from '../src/index.ts'
import { completeTeamEvents, contract, event } from './fixtures.ts'

const run = promisify(execFile)

interface FakeControllerHarness {
  readonly agent: Agent
  readonly host: Context
  readonly starts: unknown[]
  readonly interrupts: string[]
  readonly messages: unknown[]
  failInterrupt(error: Error | undefined): void
  registerSession(session: Session): void
  end(event?: Partial<ChildEnd> & { id?: ReturnType<typeof SessionId>; lastAssistantMessage?: ContentBlock[] }, carrier?: Agent): void
}

async function realGatedWorkspace(label: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `yuqi-gated-${label}-`))
  const repository = path.join(root, 'repository')
  await mkdir(repository)
  const git = async (...args: string[]) => (await run('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim()
  await git('init')
  await git('config', 'user.name', 'Yuqi Test')
  await git('config', 'user.email', 'yuqi@example.invalid')
  await writeFile(path.join(repository, 'README.md'), '# gated workspace\n', 'utf8')
  await git('add', 'README.md')
  await git('commit', '-m', 'initial')
  const adapter = new NodeGitWorkspacePort()
  const identity = await adapter.inspect({ projectRoot: repository, protectedRoots: [] })
  const managedRoot = path.join(root, 'managed')
  const worktreePath = path.join(managedRoot, 'team')
  const workspace = await adapter.provision({
    identity, workspaceId: `workspace-${label}`, managedRoot, worktreePath, branchName: `yuqi/${label}`,
  })
  return { root, workspace }
}

function fakeController(
  session = Session.create(SessionId('controller-1')),
  host = new Context(),
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only',
  options: { readonly agentsRegistry?: 'default' | 'custom' } = {},
): FakeControllerHarness {
  const starts: unknown[] = []
  const interrupts: string[] = []
  const messages: unknown[] = []
  let interruptFailure: Error | undefined
  const sessions = new Map<string, Session>([[String(session.id), session]])
  const subagents = {
    async startContinuable(spec: unknown) {
      starts.push(spec)
      const ordinal = starts.length
      return { childId: `child-${ordinal}`, messageId: `message-${ordinal}` }
    },
    interrupt(childSessionId: unknown) {
      interrupts.push(String(childSessionId))
      if (interruptFailure !== undefined) throw interruptFailure
    },
    async sendMessage(sender: Agent, childSessionId: unknown, content: unknown, options: unknown) {
      messages.push({ sender, childSessionId: String(childSessionId), content, options })
      return MessageId(`send-message-${messages.length}`)
    },
    async listChildren() {
      return starts.map((start, index) => ({
        kind: 'child' as const,
        id: SessionId(`child-${index + 1}`),
        activity: 'running' as const,
        hasChildren: false,
        mode: 'continuable' as const,
        label: String((start as { label?: unknown }).label ?? `child-${index + 1}`),
      }))
    },
  }
  host.provide('subagents', subagents as never)
  if (host.get('sessions') === undefined) host.provide('sessions', {
    flush: async () => true,
    get(id: ReturnType<typeof SessionId>) { return sessions.get(String(id)) },
    list() { return [...sessions.values()] },
  } as never)
  if (host.get('sessionPersistence') === undefined) host.provide('sessionPersistence', {
    async load(id: ReturnType<typeof SessionId>) {
      const stored = sessions.get(String(id))
      return stored === undefined ? undefined : { meta: stored.header, events: [...stored.events] }
    },
    async inspect(id: ReturnType<typeof SessionId>) {
      const stored = sessions.get(String(id))
      if (stored === undefined) throw new Error(`missing Session ${String(id)}`)
      return { meta: stored.header, events: [...stored.events] }
    },
    async list() { return [...sessions.values()].map(stored => stored.header) },
    async create() {},
    async append() {},
    async readFrom(id: ReturnType<typeof SessionId>, fromSeq: number) {
      return { events: [...(sessions.get(String(id))?.events.slice(fromSeq) ?? [])] }
    },
  } as never)
  if (host.get('llm') === undefined) host.provide('llm', {
    async listModels(provider: string) { return [{ provider, id: 'deepseek-v4', name: 'DeepSeek V4' }] },
    async resolveModelInfo(provider: string, model: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      return { provider, id: model, name: `${provider}/${model}` }
    },
  } as never)
  if (host.get('sandboxPolicy') === undefined) host.provide('sandboxPolicy', {
    resolve({ session: current }: { session?: Session } = {}) {
      return { mode: sandboxMode, workspaceRoot: current?.header.cwd ?? process.cwd() }
    },
  } as never)
  // Satisfy the declared Cordis dependency while preserving the ordinary
  // legacy-journal fixtures. Sidecar-specific tests install a real `open` API.
  if (host.get('storageDomain' as never) === undefined) host.provide('storageDomain' as never, {} as never)
  const controller = {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    ctx: host,
    inject: vi.fn(),
  } as unknown as Agent
  // Custom lifecycle fixtures install their own registry exactly once below.
  if (options.agentsRegistry !== 'custom' && host.get('agents') === undefined) host.provide('agents', {
    get(id: ReturnType<typeof SessionId>) { return id === controller.id ? controller : undefined },
  } as never)
  return {
    agent: controller,
    host,
    starts,
    interrupts,
    messages,
    failInterrupt(error) { interruptFailure = error },
    registerSession(child) { sessions.set(String(child.id), child) },
    end(event = {}, carrier = controller) {
      const info = {
        runId: SubagentRunId('run-1'),
        provider: 'in-process',
        id: SessionId('child-1'),
        local: true,
        stopReason: 'completed',
        ...event,
      }
      const emitScoped = host.emit as unknown as (target: object, name: string, payload: object) => void
      emitScoped(scopeTarget(host.subagents, carrier), 'subagent/end', info)
    },
  }
}

function installStartTeamControllerFactory(ctx: Context, harness: FakeControllerHarness): {
  readonly creates: CreateAgentOptions[]
  readonly mountedPresetIds: string[]
  readonly disposeCount: () => number
} {
  const creates: CreateAgentOptions[] = []
  const mountedPresetIds: string[] = []
  let disposals = 0
  installFakeSubprocess(ctx)
  ctx.provide('agentPresets', {
    async resolve(id?: string) { return { id: id ?? 'yuqi-team' } },
    async mount(_agentCtx: Context, id?: string) { mountedPresetIds.push(id ?? '') },
  } as never)
  ctx.provide('agents', {
    async create(options: CreateAgentOptions): Promise<AgentHandle> {
      creates.push(options)
      const agentCtx = new Context()
      const session = Session.create(options.sessionId, [], {
        version: 0,
        id: options.sessionId,
        createdAt: 0,
        cwd: options.meta?.cwd ?? process.cwd(),
      })
      harness.registerSession(session)
      const controller = {
        id: options.sessionId,
        session,
        options: options.agentOptions ?? {},
        status: 'idle',
        ctx: agentCtx,
      } as unknown as Agent
      await options.setup?.(agentCtx)
      return {
        agent: controller,
        async dispose() { disposals += 1 },
      }
    },
  } as never)
  return { creates, mountedPresetIds, disposeCount: () => disposals }
}

function installFakeSubprocess(ctx: Context): void {
  ctx.provide('subprocess' as never, {
    spawn: vi.fn(() => ({
      collected: {
        stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: vi.fn(async () => true),
    })),
  } as never)
}

function seedRunningTeam(session: Session): void {
  for (const event of completeTeamEvents().slice(0, 5)) session.append(TEAM_SESSION_EVENT, { event })
}

function activeBuildVerificationEvents() {
  return completeTeamEvents().slice(0, 13).map(item => item.type === 'yuqi/task-created'
    ? event(3, { type: 'yuqi/task-created', contract: {
        ...item.contract,
        verificationChecks: [{
          checkId: 'build', kind: 'build', commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
          stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
        }],
      } })
    : item)
}

function installPendingEvidenceCollector(service: YuqiTeamOrchestratorService) {
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let release!: () => void
  const pending = new Promise<{ readonly kind: 'unavailable'; readonly reason: string }>(resolve => {
    release = () => resolve({ kind: 'unavailable', reason: 'late collector settlement' })
  })
  ;(service as unknown as { evidenceCollector: {
    capabilities(): readonly { readonly kind: 'build'; readonly available: true; readonly reason: string }[]
    collect(): typeof pending
  } }).evidenceCollector = {
    capabilities: () => [{ kind: 'build', available: true, reason: 'pending test collector' }],
    collect: () => {
      markEntered()
      return pending
    },
  }
  return { entered, release }
}

describe('Harness adapters', () => {
  it('rejects an incompatible live parent before allocating a Team workspace or controller', async () => {
    const ctx = new Context()
    const parent = Session.create(SessionId('incompatible-host-parent'))
    Object.defineProperty(parent, 'constructor', { value: { supportsIgnorableEventEnvelope: false } })
    fakeController(parent, ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const launch = vi.spyOn(ctx.yuqiTeamOrchestrator, 'launchTeamController')
    try {
      await expect(ctx.yuqiTeamOrchestrator.startTeam({
        title: 'Compatibility preflight', objective: 'No workspace allocation',
        tasks: [contract(TaskId('compatibility-task'))],
        projectCwd: path.join(os.tmpdir(), 'yuqi-missing-compatibility-project'),
        controllerParentSessionId: String(parent.id),
        controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
      })).rejects.toMatchObject({ code: 'HOST_SESSION_INCOMPATIBLE' })
      expect(launch).not.toHaveBeenCalled()
      expect(parent.events).toHaveLength(0)
    } finally {
      launch.mockRestore()
      await fiber.dispose()
    }
  })

  it('classifies live, durable, missing, diagnostic, unsupported-mode, and unavailable recovery facts', async () => {
    const ctx = new Context()
    ctx.provide('subagents', {
      async listChildren() {
        return [
          { kind: 'child', id: SessionId('live-child'), activity: 'running', hasChildren: false, mode: 'continuable', label: 'live' },
          { kind: 'child', id: SessionId('durable-child'), activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'durable' },
          { kind: 'child', id: SessionId('one-shot-child'), activity: 'inactive', hasChildren: false, mode: 'one-shot' },
          { kind: 'diagnostic', id: SessionId('broken-child'), reason: 'corrupt' },
        ]
      },
    } as never)
    const observer = new HarnessAttemptRuntimeObservationPort(ctx)
    await expect(observer.observe({ parentSessionId: 'controller', attempts: [
      { taskId: 't0', attemptId: 'a0' },
      { taskId: 't1', attemptId: 'a1', childSessionId: 'live-child' },
      { taskId: 't2', attemptId: 'a2', childSessionId: 'durable-child' },
      { taskId: 't3', attemptId: 'a3', childSessionId: 'missing-child' },
      { taskId: 't4', attemptId: 'a4', childSessionId: 'broken-child' },
      { taskId: 't5', attemptId: 'a5', childSessionId: 'one-shot-child' },
    ] })).resolves.toEqual([
      { taskId: 't0', attemptId: 'a0', state: 'not-admitted' },
      { taskId: 't1', attemptId: 'a1', childSessionId: 'live-child', state: 'live' },
      { taskId: 't2', attemptId: 'a2', childSessionId: 'durable-child', state: 'durable' },
      { taskId: 't3', attemptId: 'a3', childSessionId: 'missing-child', state: 'missing', reason: 'Harness has no direct-child record for this Session' },
      { taskId: 't4', attemptId: 'a4', childSessionId: 'broken-child', state: 'diagnostic', reason: 'Harness child record is corrupt' },
      { taskId: 't5', attemptId: 'a5', childSessionId: 'one-shot-child', state: 'diagnostic', reason: 'Harness child is not continuable' },
    ])

    const unavailable = new Context()
    unavailable.provide('subagents', { async listChildren() { throw new Error('offline') } } as never)
    await expect(new HarnessAttemptRuntimeObservationPort(unavailable).observe({
      parentSessionId: 'controller', attempts: [{ taskId: 't', attemptId: 'a', childSessionId: 'child' }],
    })).resolves.toEqual([{ taskId: 't', attemptId: 'a', childSessionId: 'child', state: 'unavailable', reason: 'Harness child listing is unavailable' }])
  })

  it('recovers only one exact pre-admission child label and keeps ambiguous labels isolated', async () => {
    const ctx = new Context()
    ctx.provide('subagents', {
      async listChildren() {
        return [
          { kind: 'child' as const, id: SessionId('recovered-child'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const, label: 'yuqi:v1:recovery_token:work' },
          { kind: 'child' as const, id: SessionId('unrelated-child'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const, label: 'yuqi:v1:other_token:work' },
        ]
      },
    } as never)
    const observer = new HarnessAttemptRuntimeObservationPort(ctx)
    await expect(observer.observe({ parentSessionId: 'controller', attempts: [{ taskId: 'task', attemptId: 'attempt', recoveryToken: 'recovery_token' }] }))
      .resolves.toEqual([{ taskId: 'task', attemptId: 'attempt', recoveryToken: 'recovery_token', childSessionId: 'recovered-child', state: 'durable', recoveredChild: true }])

    const ambiguous = new Context()
    ambiguous.provide('subagents', {
      async listChildren() {
        return [
          { kind: 'child' as const, id: SessionId('recovered-child-a'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const, label: 'yuqi:v1:recovery_token:one' },
          { kind: 'child' as const, id: SessionId('recovered-child-b'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const, label: 'yuqi:v1:recovery_token:two' },
        ]
      },
    } as never)
    await expect(new HarnessAttemptRuntimeObservationPort(ambiguous).observe({ parentSessionId: 'controller', attempts: [{ taskId: 'task', attemptId: 'attempt', recoveryToken: 'recovery_token' }] }))
      .resolves.toEqual([{ taskId: 'task', attemptId: 'attempt', recoveryToken: 'recovery_token', state: 'diagnostic', reason: 'Harness found multiple children for one recovery token' }])

    const edgeCases = new Context()
    edgeCases.provide('subagents', {
      async listChildren() {
        return [
          { kind: 'child' as const, id: SessionId('one-shot'), activity: 'inactive' as const, hasChildren: false, mode: 'one-shot' as const, label: 'yuqi:v1:one_shot:work' },
          { kind: 'child' as const, id: SessionId('running'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const, label: 'yuqi:v1:running_token:work' },
        ]
      },
    } as never)
    await expect(new HarnessAttemptRuntimeObservationPort(edgeCases).observe({ parentSessionId: 'controller', attempts: [
      { taskId: 'missing-task', attemptId: 'missing-attempt', recoveryToken: 'no_match' },
      { taskId: 'one-shot-task', attemptId: 'one-shot-attempt', recoveryToken: 'one_shot' },
      { taskId: 'running-task', attemptId: 'running-attempt', recoveryToken: 'running_token' },
    ] })).resolves.toEqual([
      { taskId: 'missing-task', attemptId: 'missing-attempt', recoveryToken: 'no_match', state: 'not-admitted' },
      { taskId: 'one-shot-task', attemptId: 'one-shot-attempt', recoveryToken: 'one_shot', state: 'diagnostic', reason: 'Recovered child is not continuable' },
      { taskId: 'running-task', attemptId: 'running-attempt', recoveryToken: 'running_token', childSessionId: 'running', state: 'live', recoveredChild: true },
    ])
  })

  it('proves only durable or missing child facts before a manual resolution', async () => {
    const workspace = {
      workspaceId: WorkspaceId('adapter-proof-workspace'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\adapter-proof', branchName: 'yuqi/adapter-proof', status: 'ready' as const,
    }
    const ctx = new Context()
    ctx.provide('subagents', { async listChildren() { return [
      { kind: 'child' as const, id: SessionId('inactive-child'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const },
    ] } } as never)
    const local = { hasActiveAttempt: () => false }
    const base = { journalKey: 'controller', attemptId: 'a' }
    const safety = new HarnessAttemptResolutionSafetyPort(ctx, 'controller', local)
    await expect(safety.assertQuiescent({ ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'inactive-child', state: 'durable' }, childSessionId: 'inactive-child' })).resolves.toMatchObject({ observationState: 'durable', childQuiescent: true, gitVerified: true })
    await expect(safety.assertQuiescent({ ...base, observation: { taskId: 't', attemptId: 'a', state: 'durable' } })).rejects.toThrow(/inactive and continuable/)
    await expect(safety.assertQuiescent({ ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'missing-child', state: 'missing' }, childSessionId: 'missing-child' })).resolves.toMatchObject({ observationState: 'missing', childQuiescent: true })
    await expect(safety.assertQuiescent({ ...base, observation: { taskId: 't', attemptId: 'a', state: 'not-admitted' } })).rejects.toThrow(/cannot independently prove/)
    await expect(safety.assertQuiescent({ ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'inactive-child', state: 'missing' }, childSessionId: 'inactive-child' })).rejects.toThrow(/present again/)

    const noChild = new Context()
    noChild.provide('subagents', { async listChildren() { return [] } } as never)
    const verifiedGit = { async verify(request: { readonly workspace: typeof workspace; readonly signal?: AbortSignal }) { return request.workspace } }
    await expect(new HarnessAttemptResolutionSafetyPort(noChild, 'controller', local, verifiedGit as never).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', state: 'missing' }, workspace, leaseIds: [], signal: new AbortController().signal,
    })).resolves.toMatchObject({ workspace: { workspaceId: String(workspace.workspaceId) } })
    const directWorkspace = {
      workspaceId: WorkspaceId('adapter-direct-proof'),
      project: { mode: 'direct' as const, projectRoot: 'F:\\project', volumeRoot: 'F:\\', protectedRoots: [] },
      worktreePath: 'F:\\project', branchName: 'direct', status: 'ready' as const,
    }
    const verifiedDirect = { async verify(request: { readonly workspace: typeof directWorkspace }) { return request.workspace } }
    await expect(new HarnessAttemptResolutionSafetyPort(noChild, 'controller', local, verifiedDirect as never).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', state: 'missing' }, workspace: directWorkspace as never, leaseIds: [],
    })).resolves.toMatchObject({ workspace: { mode: 'direct', workspaceId: String(directWorkspace.workspaceId), projectRoot: 'F:\\project' } })
    await expect(new HarnessAttemptResolutionSafetyPort(noChild, 'controller', local, { async verify() { return undefined } } as never).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', state: 'missing' }, workspace, leaseIds: [],
    })).rejects.toThrow(/Git verification is unavailable/)

    const unsafe = new Context()
    unsafe.provide('subagents', { async listChildren() { return [
      { kind: 'diagnostic' as const, id: SessionId('broken-child'), reason: 'corrupt' as const },
    ] } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(unsafe, 'controller', local).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'broken-child', state: 'durable' }, childSessionId: 'broken-child',
    })).rejects.toThrow(/diagnostic/)

    const running = new Context()
    running.provide('subagents', { async listChildren() { return [
      { kind: 'child' as const, id: SessionId('running-child'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const },
    ] } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(running, 'controller', local).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'running-child', state: 'durable' }, childSessionId: 'running-child',
    })).rejects.toThrow(/inactive and continuable/)

    await expect(new HarnessAttemptResolutionSafetyPort(ctx, 'controller', {
      hasActiveAttempt: () => true,
    }).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'inactive-child', state: 'durable' }, childSessionId: 'inactive-child',
    })).rejects.toThrow(/in-flight admission or settlement/)

    let localChecks = 0
    await expect(new HarnessAttemptResolutionSafetyPort(ctx, 'controller', {
      hasActiveAttempt: () => ++localChecks === 3,
    }).assertQuiescent({
      ...base, observation: { taskId: 't', attemptId: 'a', childSessionId: 'inactive-child', state: 'durable' }, childSessionId: 'inactive-child',
    })).rejects.toThrow(/in-flight admission or settlement/)
  })

  it('rechecks child state and proves recovery clearance only with public Git facts', async () => {
    const workspace = {
      workspaceId: WorkspaceId('adapter-recovery-workspace'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\adapter-recovery', branchName: 'yuqi/adapter-recovery', status: 'ready' as const,
    }
    const verifiedDirtyScopes: (readonly string[])[] = []
    const git = { async verify(request: { readonly workspace: typeof workspace; readonly allowedDirtyScopes: readonly string[] }) {
      verifiedDirtyScopes.push(request.allowedDirtyScopes)
      return request.workspace
    } }
    let listCalls = 0
    const changing = new Context()
    changing.provide('subagents', { async listChildren() {
      listCalls += 1
      return listCalls === 1
        ? [{ kind: 'child' as const, id: SessionId('child'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }]
        : [{ kind: 'child' as const, id: SessionId('child'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(changing, 'controller', { hasActiveAttempt: () => false }, git as never).assertQuiescent({
      journalKey: 'controller', attemptId: 'a', childSessionId: 'child', observation: { taskId: 't', attemptId: 'a', childSessionId: 'child', state: 'durable' }, workspace, leaseIds: [],
    })).rejects.toThrow(/reappeared or became active/)

    let missingCalls = 0
    const reappearedMissing = new Context()
    reappearedMissing.provide('subagents', { async listChildren() {
      missingCalls += 1
      return missingCalls === 1 ? [] : [{ kind: 'child' as const, id: SessionId('missing'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(reappearedMissing, 'controller', { hasActiveAttempt: () => false }).assertQuiescent({
      journalKey: 'controller', attemptId: 'a', childSessionId: 'missing', observation: { taskId: 't', attemptId: 'a', childSessionId: 'missing', state: 'missing' }, leaseIds: [],
    })).rejects.toThrow(/reappeared during proof/)

    let diagnosticCalls = 0
    const diagnosticSecond = new Context()
    diagnosticSecond.provide('subagents', { async listChildren() {
      diagnosticCalls += 1
      return diagnosticCalls === 1 ? [] : [{ kind: 'diagnostic' as const, id: SessionId('later-diagnostic'), reason: 'corrupt' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(diagnosticSecond, 'controller', { hasActiveAttempt: () => false }).assertQuiescent({
      journalKey: 'controller', attemptId: 'a', childSessionId: 'missing', observation: { taskId: 't', attemptId: 'a', childSessionId: 'missing', state: 'missing' }, leaseIds: [],
    })).rejects.toThrow(/became diagnostic/)

    const empty = new Context()
    empty.provide('subagents', { async listChildren() { return [] } } as never)
    const emptySafety = new HarnessAttemptResolutionSafetyPort(empty, 'controller', { hasActiveAttempt: () => false })
    await expect(emptySafety.assertQuiescent({ journalKey: 'controller', attemptId: 'a', observation: { taskId: 't', attemptId: 'a', state: 'not-admitted' }, leaseIds: [] })).resolves.toMatchObject({ observationState: 'not-admitted' })
    await expect(emptySafety.assertQuiescent({ journalKey: 'controller', attemptId: 'a', observation: { taskId: 't', attemptId: 'a', state: 'live' }, leaseIds: [] })).rejects.toThrow(/quiescent/)
    await expect(emptySafety.assertQuiescent({ journalKey: 'controller', attemptId: 'a', observation: { taskId: 't', attemptId: 'a', state: 'missing' }, workspace, leaseIds: [] })).rejects.toThrow(/Git verification is unavailable/)

    const recoveryCtx = new Context()
    recoveryCtx.provide('subagents', { async listChildren() { return [{ kind: 'child' as const, id: SessionId('inactive'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }] } } as never)
    const recoverySafety = new HarnessAttemptResolutionSafetyPort(recoveryCtx, 'controller', { hasActiveAttempt: () => false }, git as never)
    await expect(recoverySafety.assertQuiescent({
      journalKey: 'controller', attemptId: 'a', childSessionId: 'inactive',
      observation: { taskId: 't', attemptId: 'a', childSessionId: 'inactive', state: 'durable' }, workspace, leaseIds: [],
    })).resolves.toMatchObject({ childQuiescent: true, gitVerified: true })
    expect(verifiedDirtyScopes.at(-1)).toEqual(['**'])
    await expect(recoverySafety.assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: ['a'], attempts: [{ attemptId: 'a', childSessionId: 'inactive' }], signal: new AbortController().signal })).resolves.toMatchObject({ childQuiescent: true, gitVerified: true, workspace: { branchName: 'yuqi/adapter-recovery' } })
    expect(verifiedDirtyScopes.at(-1)).toEqual([])
    await expect(recoverySafety.assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: ['a'], attempts: [{ attemptId: 'a', childSessionId: 'inactive' }], retainDirtyWorkspace: true })).resolves.toMatchObject({ childQuiescent: true, gitVerified: true })
    expect(verifiedDirtyScopes.at(-1)).toEqual(['**'])

    const diagnosticRecovery = new Context()
    diagnosticRecovery.provide('subagents', { async listChildren() { return [{ kind: 'diagnostic' as const, id: SessionId('recovery-diagnostic'), reason: 'corrupt' as const }] } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(diagnosticRecovery, 'controller', { hasActiveAttempt: () => false }, git as never).assertRecoveryClear({
      journalKey: 'controller', teamId: 'team', workspace, attemptIds: [], attempts: [],
    })).rejects.toThrow(/became diagnostic during initial recovery proof/)

    const running = new Context()
    running.provide('subagents', { async listChildren() { return [{ kind: 'child' as const, id: SessionId('running'), activity: 'running' as const, hasChildren: false, mode: 'continuable' as const }] } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(running, 'controller', { hasActiveAttempt: () => false }, git as never).assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: [], attempts: [{ attemptId: 'running', childSessionId: 'running' }] })).rejects.toThrow(/active or diagnostic|active or non-continuable/)
    await expect(new HarnessAttemptResolutionSafetyPort(recoveryCtx, 'controller', { hasActiveAttempt: () => false }, { async verify() { throw new Error('git drift') } } as never).assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: [], attempts: [{ attemptId: 'a', childSessionId: 'inactive' }] })).rejects.toThrow(/git drift/)
    await expect(new HarnessAttemptResolutionSafetyPort(recoveryCtx, 'controller', { hasActiveAttempt: () => false }, { async verify() { return { ...workspace, branchName: 'wrong-branch' } } } as never).assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: [], attempts: [{ attemptId: 'a', childSessionId: 'inactive' }] })).rejects.toThrow(/did not match/)
    await expect(new HarnessAttemptResolutionSafetyPort(recoveryCtx, 'controller', { hasActiveAttempt: () => false }, { async verify() { return undefined } } as never).assertRecoveryClear({ journalKey: 'controller', teamId: 'team', workspace, attemptIds: [], attempts: [{ attemptId: 'a', childSessionId: 'inactive' }] })).rejects.toThrow(/Git verification is unavailable/)
    await expect(new HarnessAttemptResolutionSafetyPort(recoveryCtx, 'controller', { hasActiveAttempt: () => false }, git as never).assertQuiescent({ journalKey: 'controller', attemptId: 'a', observation: { taskId: 't', attemptId: 'a', state: 'not-admitted' }, leaseIds: [], workspace })).rejects.toThrow(/unadmitted/)
  })

  it('fails recovery clearance closed when a child changes or local activity appears after the second listing', async () => {
    const workspace = {
      workspaceId: WorkspaceId('recovery-race-workspace'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\recovery-race', branchName: 'yuqi/recovery-race', status: 'ready' as const,
    }
    const git = { async verify(request: { readonly workspace: typeof workspace }) { return request.workspace } }
    let listingCalls = 0
    const changing = new Context()
    changing.provide('subagents', { async listChildren() {
      listingCalls += 1
      return [{ kind: 'child' as const, id: SessionId('child'), activity: listingCalls === 1 ? 'inactive' as const : 'running' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(changing, 'controller', { hasActiveAttempt: () => false }, git as never).assertRecoveryClear({
      journalKey: 'controller', teamId: 'team', workspace, attemptIds: ['attempt'], attempts: [{ attemptId: 'attempt', childSessionId: 'child' }],
    })).rejects.toThrow(/active or non-continuable/)

    const foreign = new Context()
    foreign.provide('subagents', { async listChildren() {
      return [{ kind: 'child' as const, id: SessionId('recovered-child'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(foreign, 'controller', { hasActiveAttempt: () => false }, git as never).assertRecoveryClear({
      journalKey: 'controller', teamId: 'team', workspace, attemptIds: ['attempt'], attempts: [{ attemptId: 'attempt', childSessionId: 'expected-child' }],
    })).rejects.toThrow(/foreign child/)

    let localChecks = 0
    const stable = new Context()
    stable.provide('subagents', { async listChildren() {
      return [{ kind: 'child' as const, id: SessionId('stable-child'), activity: 'inactive' as const, hasChildren: false, mode: 'continuable' as const }]
    } } as never)
    await expect(new HarnessAttemptResolutionSafetyPort(stable, 'controller', {
      hasActiveAttempt: () => ++localChecks === 3,
    }, git as never).assertRecoveryClear({
      journalKey: 'controller', teamId: 'team', workspace, attemptIds: ['attempt'], attempts: [{ attemptId: 'attempt', childSessionId: 'stable-child' }],
    })).rejects.toThrow(/in-flight admission or settlement/)
  })

  it('exposes durable Team pause and resume commands through the Cordis service', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-controls')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) {
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    }
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const paused = await ctx.yuqiTeamOrchestrator.pauseTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'service-pause',
    })
    expect(paused.team.status).toBe('paused')
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    const resumed = await ctx.yuqiTeamOrchestrator.resumeTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'service-resume',
    })
    expect(resumed.team.status).toBe('running')
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).controlOperations)
      .toMatchObject({ 'service-pause': { action: 'pause' }, 'service-resume': { action: 'resume' } })
    await vi.waitFor(() => expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).team.status)
      .toBe('needs_reconciliation'))
    await fiber.dispose()

    const cancelContext = new Context()
    const cancelHarness = fakeController(Session.create(SessionId('controller-controls-cancel')), cancelContext)
    for (const item of completeTeamEvents().slice(0, 2)) cancelHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const cancelFiber = await cancelContext.plugin(YuqiTeamOrchestratorService)
    await expect(cancelContext.yuqiTeamOrchestrator.cancelTeam({
      controller: cancelHarness.agent, teamId: 'team-1', operationId: 'invalid-timeout', timeoutMs: 9,
    })).rejects.toThrow(RangeError)
    expect(replayTeamEvents(new HarnessSessionJournal(cancelHarness.agent.session, cancelContext.sessions).read()).controlOperations['invalid-timeout'])
      .toBeUndefined()
    const cancelled = await cancelContext.yuqiTeamOrchestrator.cancelTeam({
      controller: cancelHarness.agent, teamId: 'team-1', operationId: 'service-cancel',
    })
    expect(cancelled.team.status).toBe('cancelled')
    await cancelFiber.dispose()
  })

  it('resolves live and cold Team controllers without duplicate resume work', async () => {
    const ctx = new Context()
    const resolverHarness = fakeController(Session.create(SessionId('controller-resolver-host')), ctx, 'read-only', { agentsRegistry: 'custom' })
    const persistedId = SessionId('yuqi-team-persisted-route')
    const persistedSession = Session.create(persistedId)
    for (const item of [
      event(1970, {
        type: 'yuqi/team-created', title: 'Persisted route', objective: 'Recover exact route',
        controllerModel: { provider: 'persisted-provider', model: 'persisted-model', maxTokens: 16384 },
      } as never),
      event(1971, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
    ]) persistedSession.append(TEAM_SESSION_EVENT, { event: item })
    ;(ctx.sessionPersistence as unknown as {
      load(id: SessionId): Promise<{ readonly meta: Session['header']; readonly events: Session['events'] } | undefined>
    }).load = async id => id === persistedId
      ? { meta: persistedSession.header, events: persistedSession.events }
      : undefined
    const live = { id: SessionId('yuqi-team-live') } as unknown as Agent
    const resumed = { id: SessionId('yuqi-team-cold') } as unknown as Agent
    let resumeCalls = 0
    const resumedOptions: unknown[] = []
    let releasePending!: () => void
    const pendingGate = new Promise<void>(resolve => { releasePending = resolve })
    ctx.provide('agentPresets', {
      async resolve() { return { id: 'standard' } },
      async mount() {},
    } as never)
    ctx.provide('agents', {
      get(id: SessionId) { return id === live.id ? live : undefined },
      async create() { throw new Error('not used') },
      async resume(options: { readonly resumeSessionId: SessionId; readonly agentOptions?: AgentOptions; readonly setup?: (ctx: Context) => Promise<unknown> }) {
        resumeCalls += 1
        resumedOptions.push(options.agentOptions)
        if (String(options.resumeSessionId) === 'yuqi-team-pending') await pendingGate
        if (String(options.resumeSessionId) === 'yuqi-team-broken') throw new Error('persisted session unavailable')
        await options.setup?.(new Context())
        const agent = String(options.resumeSessionId) === 'yuqi-team-cold'
          ? resumed
          : { id: options.resumeSessionId } as unknown as Agent
        return { agent, async dispose() {} }
      },
    } as never)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('invalid')).resolves.toBeUndefined()
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-live')).resolves.toBe(live)
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-no-route')).resolves.toBeUndefined()
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-invalid-token-route', {
      provider: 'deepseek', maxTokens: 0,
    })).resolves.toBeUndefined()
    const fallbackModel = { provider: 'deepseek', model: 'deepseek-v4', maxTokens: 8192 }
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-cold', fallbackModel)).resolves.toBe(resumed)
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-cold', fallbackModel)).resolves.toBe(resumed)
    expect(resumeCalls).toBe(1)
    expect(resumedOptions).toEqual([fallbackModel])

    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-provider-only', { provider: 'deepseek' }))
      .resolves.toMatchObject({ id: SessionId('yuqi-team-provider-only') })
    expect(resumeCalls).toBe(2)

    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-blank-model', {
      provider: 'deepseek', model: '   ', maxTokens: 4096,
    })).resolves.toMatchObject({ id: SessionId('yuqi-team-blank-model') })
    expect(resumeCalls).toBe(3)

    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController(String(persistedId), fallbackModel))
      .resolves.toMatchObject({ id: persistedId })
    expect(resumeCalls).toBe(4)

    const firstPending = ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-pending', fallbackModel)
    const secondPending = ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-pending', fallbackModel)
    releasePending()
    expect(await firstPending).toBe(await secondPending)
    expect(resumeCalls).toBe(5)
    await expect(ctx.yuqiTeamOrchestrator.resolveTeamController('yuqi-team-broken', fallbackModel)).resolves.toBeUndefined()
    expect(resumeCalls).toBe(6)
    expect(resumedOptions).toEqual([
      fallbackModel,
      { provider: 'deepseek' },
      { provider: 'deepseek', maxTokens: 4096 },
      { provider: 'persisted-provider', model: 'persisted-model', maxTokens: 16384 },
      fallbackModel,
      fallbackModel,
    ])
    await fiber.dispose()
  })

  it('wakes the retained service runner after durable resume and retry commands', async () => {
    const resumeContext = new Context()
    const resumeHarness = fakeController(Session.create(SessionId('controller-runner-resume')), resumeContext)
    for (const item of completeTeamEvents().slice(0, 2)) resumeHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const resumeFiber = await resumeContext.plugin(YuqiTeamOrchestratorService)
    await resumeContext.yuqiTeamOrchestrator.pauseTeam({
      controller: resumeHarness.agent, teamId: 'team-1', operationId: 'runner-pause',
    })
    const resumeRuns = vi.spyOn((resumeContext.yuqiTeamOrchestrator as unknown as {
      teamRuns: { run(request: { journal: HarnessSessionJournal }): Promise<unknown> }
    }).teamRuns, 'run').mockImplementation(async request => {
      const projection = replayTeamEvents(request.journal.read())
      return {
        projection,
        reason: projection.team.status === 'paused' ? 'paused' : 'no-progress',
        disposition: 'recoverable',
        cycles: 1,
      }
    })
    await resumeContext.yuqiTeamOrchestrator.runTeam({
      controller: resumeHarness.agent, teamId: 'team-1', maxConcurrency: 1, maxCycles: 2,
      disposeController: vi.fn(async () => {}),
    })
    expect(resumeRuns).toHaveBeenCalledOnce()
    await resumeContext.yuqiTeamOrchestrator.resumeTeam({
      controller: resumeHarness.agent, teamId: 'team-1', operationId: 'runner-resume',
    })
    expect(resumeRuns).toHaveBeenCalledTimes(2)
    await resumeFiber.dispose()

    const retryContext = new Context()
    const retryHarness = fakeController(Session.create(SessionId('controller-runner-retry')), retryContext)
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(1980, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(1981, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'runner-retry-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:31:00Z' }),
      event(1982, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) retryHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const retryFiber = await retryContext.plugin(YuqiTeamOrchestratorService)
    const retryRuns = vi.spyOn((retryContext.yuqiTeamOrchestrator as unknown as {
      teamRuns: { run(request: { journal: HarnessSessionJournal }): Promise<unknown> }
    }).teamRuns, 'run').mockImplementation(async request => ({
      projection: replayTeamEvents(request.journal.read()), reason: 'no-progress', disposition: 'recoverable', cycles: 1,
    }))
    await retryContext.yuqiTeamOrchestrator.runTeam({
      controller: retryHarness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    expect(retryRuns).toHaveBeenCalledOnce()
    await retryContext.yuqiTeamOrchestrator.retryTask({
      controller: retryHarness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'runner-retry',
    })
    expect(retryRuns).toHaveBeenCalledTimes(2)
    await retryFiber.dispose()
  })

  it('durably exposes a rejected background resume instead of leaving a false running Team', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-runner-visible-failure')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.pauseTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'visible-failure-pause',
    })
    const runs = vi.spyOn((ctx.yuqiTeamOrchestrator as unknown as {
      teamRuns: { run(request: { journal: HarnessSessionJournal }): Promise<unknown> }
    }).teamRuns, 'run')
    runs.mockImplementationOnce(async request => ({
      projection: replayTeamEvents(request.journal.read()), reason: 'paused', disposition: 'recoverable', cycles: 0,
    })).mockRejectedValueOnce(new Error('synthetic resumed runner failure'))
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
    })

    await ctx.yuqiTeamOrchestrator.resumeTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'visible-failure-resume',
    })
    await vi.waitFor(() => {
      const projection = replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
      expect(projection.team.status).toBe('needs_reconciliation')
    })
    await fiber.dispose()
  })

  it('replans one retry-invalidated background schedule instead of reconciling its stale predecessor', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-runner-stale-retry')), ctx)
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(1990, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(1991, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'stale-retry-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:32:00Z' }),
      event(1992, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      teamRunnerSupervisor: {
        register(registration: { journalKey: string; teamId: string; controller: Agent; maxConcurrency: number; run(signal: AbortSignal): Promise<unknown> }): void
        wake(journalKey: string): Promise<unknown> | undefined
        acquireWakeLease(journalKey: string): { wake(): Promise<unknown> | undefined; release(): void } | undefined
      }
      wakeTeamRunner(journal: HarnessSessionJournal, teamId: string, reason: string): void
      markBackgroundRunnerFailure(journal: HarnessSessionJournal, teamId: string, action: string, cause: unknown): Promise<void>
    }
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const projection = replayTeamEvents(journal.read())
    service.teamRunnerSupervisor.register({
      journalKey: journal.key,
      teamId: 'team-1',
      controller: harness.agent,
      maxConcurrency: 1,
      run: async () => ({ projection, reason: 'max-cycles', disposition: 'yielded', cycles: 1 }),
    })
    const stalePredecessorWake = vi.fn(() => Promise.reject(new YuqiOrchestratorError('STALE_SCHEDULE', 'obsolete predecessor plan')))
    const releaseWakeLease = vi.fn()
    vi.spyOn(service.teamRunnerSupervisor, 'acquireWakeLease').mockReturnValue({ wake: stalePredecessorWake, release: releaseWakeLease })
    const wake = vi.spyOn(service.teamRunnerSupervisor, 'wake')
      .mockReturnValue(Promise.resolve({ projection, reason: 'max-cycles', disposition: 'yielded', cycles: 1 }))
    const markFailure = vi.spyOn(service, 'markBackgroundRunnerFailure')

    const retried = await ctx.yuqiTeamOrchestrator.retryTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stale-schedule-retry',
    })

    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1))
    expect(retried.tasks['task-1']?.status).toBe('ready')
    expect(stalePredecessorWake).toHaveBeenCalledOnce()
    expect(releaseWakeLease).toHaveBeenCalledOnce()
    expect(markFailure).not.toHaveBeenCalled()
    expect(replayTeamEvents(journal.read()).team.status).toBe('running')
    await fiber.dispose()
  })

  it('coalesces duplicate wake observers for one stale runner failure into one replan', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-runner-shared-stale')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      teamRunnerSupervisor: {
        register(registration: { journalKey: string; teamId: string; controller: Agent; maxConcurrency: number; run(signal: AbortSignal): Promise<unknown> }): void
        wake(journalKey: string): Promise<unknown> | undefined
      }
      wakeTeamRunner(journal: HarnessSessionJournal, teamId: string, reason: string): void
      markBackgroundRunnerFailure(journal: HarnessSessionJournal, teamId: string, action: string, cause: unknown): Promise<void>
    }
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const projection = replayTeamEvents(journal.read())
    service.teamRunnerSupervisor.register({
      journalKey: journal.key, teamId: 'team-1', controller: harness.agent, maxConcurrency: 1,
      run: async () => ({ projection, reason: 'max-cycles', disposition: 'yielded', cycles: 1 }),
    })
    const stale = Promise.reject(new YuqiOrchestratorError('STALE_SCHEDULE', 'shared obsolete plan'))
    const wake = vi.spyOn(service.teamRunnerSupervisor, 'wake')
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(Promise.resolve({ projection, reason: 'max-cycles', disposition: 'yielded', cycles: 1 }))
    const markFailure = vi.spyOn(service, 'markBackgroundRunnerFailure')

    service.wakeTeamRunner(journal, 'team-1', 'retry-a')
    service.wakeTeamRunner(journal, 'team-1', 'retry-b')

    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(3))
    expect(markFailure).not.toHaveBeenCalled()
    expect(replayTeamEvents(journal.read()).team.status).toBe('running')
    await fiber.dispose()
  })

  it('reconciles a second stale failure in one runner lifecycle instead of repeatedly replanning', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-runner-bounded-stale')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      teamRunnerSupervisor: {
        register(registration: { journalKey: string; teamId: string; controller: Agent; maxConcurrency: number; run(signal: AbortSignal): Promise<unknown> }): void
        wake(journalKey: string): Promise<unknown> | undefined
      }
      wakeTeamRunner(journal: HarnessSessionJournal, teamId: string, reason: string): void
      markBackgroundRunnerFailure(journal: HarnessSessionJournal, teamId: string, action: string, cause: unknown): Promise<void>
    }
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const projection = replayTeamEvents(journal.read())
    service.teamRunnerSupervisor.register({
      journalKey: journal.key, teamId: 'team-1', controller: harness.agent, maxConcurrency: 1,
      run: async () => ({ projection, reason: 'max-cycles', disposition: 'yielded', cycles: 1 }),
    })
    const wake = vi.spyOn(service.teamRunnerSupervisor, 'wake')
      .mockReturnValueOnce(Promise.reject(new YuqiOrchestratorError('STALE_SCHEDULE', 'first obsolete plan')))
      .mockReturnValueOnce(Promise.reject(new YuqiOrchestratorError('STALE_SCHEDULE', 'second obsolete plan')))
    const markFailure = vi.spyOn(service, 'markBackgroundRunnerFailure')

    service.wakeTeamRunner(journal, 'team-1', 'retry')

    await vi.waitFor(() => expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation'))
    expect(wake).toHaveBeenCalledTimes(2)
    expect(markFailure).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('holds runner ownership while a durable resume flush races Host shutdown', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('controller-runner-resume-shutdown-race'))
    let deferFlush = false
    let enterFlush!: () => void
    const flushEntered = new Promise<void>(resolve => { enterFlush = resolve })
    let releaseFlush!: () => void
    const flushReleased = new Promise<void>(resolve => { releaseFlush = resolve })
    ctx.provide('sessions', {
      get: (id: SessionId) => id === session.id ? session : undefined,
      async flush() {
        if (deferFlush) {
          enterFlush()
          await flushReleased
        }
        return true
      },
    } as never)
    const harness = fakeController(session, ctx)
    for (const item of completeTeamEvents().slice(0, 2)) session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.pauseTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'race-pause',
    })
    const runs = vi.spyOn((ctx.yuqiTeamOrchestrator as unknown as {
      teamRuns: { run(request: { journal: HarnessSessionJournal }): Promise<unknown> }
    }).teamRuns, 'run').mockImplementation(async request => {
      const projection = replayTeamEvents(request.journal.read())
      return { projection, reason: projection.team.status === 'paused' ? 'paused' : 'no-progress', disposition: 'recoverable', cycles: 1 }
    })
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1, disposeController: vi.fn(async () => {}),
    })
    deferFlush = true
    const resumed = ctx.yuqiTeamOrchestrator.resumeTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'race-resume',
    })
    await flushEntered
    let shutdownSettled = false
    const shutdown = fiber.dispose().then(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)

    releaseFlush()
    await expect(resumed).resolves.toMatchObject({ team: { status: 'running' } })
    expect(runs).toHaveBeenCalledTimes(2)
    await expect(shutdown).resolves.toBeUndefined()
  })

  it('restores a recovered paused runner after restart but still rejects unsafe cold retry', async () => {
    const resumeSession = Session.create(SessionId('controller-cold-resume'))
    const firstResumeContext = new Context()
    const firstResumeHarness = fakeController(resumeSession, firstResumeContext)
    for (const item of completeTeamEvents().slice(0, 2)) firstResumeHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const firstResumeFiber = await firstResumeContext.plugin(YuqiTeamOrchestratorService)
    await firstResumeContext.yuqiTeamOrchestrator.pauseTeam({
      controller: firstResumeHarness.agent, teamId: 'team-1', operationId: 'cold-pause',
    })
    await firstResumeFiber.dispose()

    const coldResumeContext = new Context()
    const coldResumeHarness = fakeController(resumeSession, coldResumeContext)
    const coldResumeFiber = await coldResumeContext.plugin(YuqiTeamOrchestratorService)
    const resumeJournal = new HarnessSessionJournal(resumeSession, coldResumeContext.sessions)
    const beforeResume = resumeJournal.read().length
    await expect(coldResumeContext.yuqiTeamOrchestrator.resumeTeam({
      controller: coldResumeHarness.agent, teamId: 'team-1', operationId: 'cold-resume-without-owner',
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(resumeJournal.read()).toHaveLength(beforeResume)
    const recoveredDispose = vi.fn(async () => {})
    const coldService = coldResumeContext.yuqiTeamOrchestrator as unknown as {
      recoveredControllers: Map<string, AgentHandle>
      teamRuns: { run(request: { journal: HarnessSessionJournal }): Promise<unknown> }
      teamRunnerSupervisor: { register(registration: unknown): void }
    }
    coldService.recoveredControllers.set(String(coldResumeHarness.agent.id), {
      agent: fakeController(Session.create(SessionId('wrong-recovered-controller'))).agent,
      dispose: vi.fn(async () => {}),
    })
    await expect(coldResumeContext.yuqiTeamOrchestrator.resumeTeam({
      controller: coldResumeHarness.agent, teamId: 'team-1', operationId: 'cold-resume-wrong-owner',
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const recoveredHandle: AgentHandle = {
      agent: coldResumeHarness.agent,
      dispose: recoveredDispose,
    }
    coldService.recoveredControllers.set(String(coldResumeHarness.agent.id), recoveredHandle)
    vi.spyOn(coldService.teamRunnerSupervisor, 'register').mockImplementationOnce(() => {
      throw new Error('synthetic runner bind failure')
    })
    await expect(coldResumeContext.yuqiTeamOrchestrator.resumeTeam({
      controller: coldResumeHarness.agent, teamId: 'team-1', operationId: 'cold-resume-bind-failure',
    })).rejects.toThrow('synthetic runner bind failure')
    expect(coldService.recoveredControllers.get(String(coldResumeHarness.agent.id))).toBe(recoveredHandle)
    const resumedRuns = vi.spyOn(coldService.teamRuns, 'run').mockImplementation(async request => {
      const projection = replayTeamEvents(request.journal.read())
      return {
        projection,
        reason: projection.team.status === 'paused' ? 'paused' : 'no-progress',
        disposition: 'recoverable',
        cycles: 1,
      }
    })
    await expect(coldResumeContext.yuqiTeamOrchestrator.resumeTeam({
      controller: coldResumeHarness.agent, teamId: 'team-1', operationId: 'cold-resume',
    })).resolves.toMatchObject({ team: { status: 'running' } })
    await vi.waitFor(() => expect(resumedRuns).toHaveBeenCalledOnce())
    expect(resumeJournal.read().length).toBeGreaterThan(beforeResume)
    const afterResume = replayTeamEvents(resumeJournal.read())
    expect(afterResume.team.status).toBe('needs_reconciliation')
    expect(afterResume.controlOperations['cold-resume']).toMatchObject({ action: 'resume' })
    await coldResumeFiber.dispose()
    expect(recoveredDispose).toHaveBeenCalledOnce()

    const retrySession = Session.create(SessionId('controller-cold-retry'))
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(1983, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(1984, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'cold-retry-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:32:00Z' }),
      event(1985, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) retrySession.append(TEAM_SESSION_EVENT, { event: item })
    const firstRetryContext = new Context()
    const firstRetryHarness = fakeController(retrySession, firstRetryContext)
    const firstRetryFiber = await firstRetryContext.plugin(YuqiTeamOrchestratorService)
    await firstRetryFiber.dispose()

    const coldRetryContext = new Context()
    const coldRetryHarness = fakeController(retrySession, coldRetryContext)
    const coldRetryFiber = await coldRetryContext.plugin(YuqiTeamOrchestratorService)
    const retryJournal = new HarnessSessionJournal(retrySession, coldRetryContext.sessions)
    const beforeRetry = retryJournal.read().length
    await expect(coldRetryContext.yuqiTeamOrchestrator.retryTask({
      controller: coldRetryHarness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'cold-retry',
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(retryJournal.read()).toHaveLength(beforeRetry)
    const afterRetry = replayTeamEvents(retryJournal.read())
    expect(afterRetry.team.status).toBe('running')
    expect(afterRetry.tasks['task-1']?.status).toBe('failed')
    expect(afterRetry.taskRetryOperations['cold-retry']).toBeUndefined()
    await coldRetryFiber.dispose()
  })

  it('cold-recovers a completed no-check child with atomic lease and Team completion', async () => {
    const parentSession = Session.create(SessionId('controller-cold-no-check'))
    const childSession = Session.create(SessionId('cold-no-check-child'))
    childSession.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'in-process', label: 'cold worker' }))
    childSession.append('turn/start', { turn: 1 })
    childSession.append('user/message', freezeMessage({
      id: MessageId('cold-no-check-message'), role: 'user', content: [{ type: 'text', text: 'finish cold work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    childSession.append('assistant/message', {
      turn: 1, step: 0,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'in-process', model: 'deepseek-v4' } }),
      usage: { inputTokens: 4, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    childSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const workspaceId = WorkspaceId('workspace-cold-no-check')
    const taskId = TaskId('cold-no-check-task')
    const attemptId = AttemptId('cold-no-check-attempt')
    const leaseId = FileLeaseId('cold-no-check-lease')
    for (const item of [
      event(2100, { type: 'yuqi/team-created', title: 'Cold recovery', objective: 'Complete without verification' }),
      event(2101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(2102, { type: 'yuqi/task-created', contract: contract(taskId) }),
      event(2103, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId,
        project: { projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git', baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [] },
        worktreePath: 'F:\\managed\\cold-no-check', branchName: 'yuqi/cold-no-check', status: 'provisioning',
      } }),
      event(2104, { type: 'yuqi/workspace-provisioned', workspaceId }),
      event(2105, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
      event(2106, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
      event(2107, { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(2108, { type: 'yuqi/file-lease-acquired', lease: { leaseId, taskId, attemptId, mode: 'write', fileScope: ['src/**'], status: 'active' } }),
      event(2109, { type: 'yuqi/attempt-admitted', taskId, attemptId, agentSessionId: String(childSession.id), messageId: 'cold-no-check-message' }),
      event(2110, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running' }),
    ]) parentSession.append(TEAM_SESSION_EVENT, { event: item })

    const firstContext = new Context()
    fakeController(parentSession, firstContext)
    const firstFiber = await firstContext.plugin(YuqiTeamOrchestratorService)
    await firstFiber.dispose()

    const coldContext = new Context()
    coldContext.provide('sessionPersistence', {
      async load(id: SessionId) {
        return String(id) === String(childSession.id) ? { meta: childSession.header, events: childSession.events } : undefined
      },
    } as never)
    const coldHarness = fakeController(parentSession, coldContext)
    ;(coldContext.subagents as unknown as { listChildren(): Promise<unknown[]> }).listChildren = async () => [{
      kind: 'child', id: childSession.id, activity: 'inactive', hasChildren: false, mode: 'continuable',
    }]
    const coldFiber = await coldContext.plugin(YuqiTeamOrchestratorService)
    const result = await coldContext.yuqiTeamOrchestrator.runTeam({
      controller: coldHarness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    const projection = replayTeamEvents(new HarnessSessionJournal(parentSession, coldContext.sessions).read())
    expect(result).toMatchObject({ reason: 'completed', disposition: 'completed' })
    expect(projection.attempts[String(attemptId)]?.status).toBe('completed')
    expect(projection.tasks[String(taskId)]?.status).toBe('completed')
    expect(projection.fileLeases[String(leaseId)]?.status).toBe('released')
    expect(projection.verifications).toEqual({})
    expect(projection.team.status).toBe('completed')
    await coldFiber.dispose()
  })

  it('cold scanner settles an exact inactive terminal child before reconciliation without replaying it', async () => {
    const controllerSession = Session.create(SessionId('yuqi-team-cold-terminal-scan'))
    for (const item of completeTeamEvents().slice(0, 8)) controllerSession.append(TEAM_SESSION_EVENT, { event: item })
    const child = Session.create(SessionId('session-worker-1'))
    child.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'continuable', provider: 'in-process', label: 'cold' }))
    child.append('turn/start', { turn: 1 })
    child.append('user/message', freezeMessage({
      id: MessageId('message-1'), role: 'user', content: [{ type: 'text', text: 'work' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.append('assistant/message', {
      turn: 1, step: 0,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'in-process', model: 'deepseek-v4' } }),
      usage: { inputTokens: 7, outputTokens: 3 },
    }, { surfaceOp: 'append' })
    child.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const ctx = new Context()
    const harness = fakeController(controllerSession, ctx)
    harness.registerSession(child)
    ;(ctx.subagents as unknown as { listChildren(): Promise<unknown[]> }).listChildren = async () => [{
      kind: 'child', id: child.id, activity: 'inactive', hasChildren: false, mode: 'continuable',
    }]
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const journal = new HarnessSessionJournal(controllerSession, ctx.sessions)
    await vi.waitFor(() => expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.evidence).toMatchObject({
      runId: 'recovered:session-worker-1:1', usage: { uncachedInputTokens: 7, outputTokens: 3 },
    }))
    const projection = replayTeamEvents(journal.read())
    expect(projection.attempts['attempt-1']?.status).toBe('completed')
    expect(projection.team.status).toBe('completed')
    expect(projection.reconciliationOperations).toEqual({})
    const before = journal.read().length
    ;(ctx.yuqiTeamOrchestrator as unknown as { scheduleColdRecovery(session: Session): void }).scheduleColdRecovery(controllerSession)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(journal.read()).toHaveLength(before)
    await fiber.dispose()
  })

  it('distinguishes only current Host-owned active attempts from empty, mixed, and unowned sets', () => {
    const projection = replayTeamEvents(completeTeamEvents().slice(0, 8))
    const local = { hasActiveAttempt: vi.fn((_journalKey: string, attemptId: string) => attemptId === 'attempt-1') }
    expect(hasOnlyLocallyManagedActiveAttempts(projection, 'controller', local)).toBe(true)
    expect(local.hasActiveAttempt).toHaveBeenCalledWith('controller', 'attempt-1')

    expect(hasOnlyLocallyManagedActiveAttempts(projection, 'controller', { hasActiveAttempt: () => false })).toBe(false)
    expect(hasOnlyLocallyManagedActiveAttempts(replayTeamEvents(completeTeamEvents()), 'controller', local)).toBe(false)
  })

  it('uses the actual cold-scanner path to correct only a locally owned startup gate', async () => {
    const controllerSession = Session.create(SessionId('yuqi-team-service-owned-cold-gate'))
    const ctx = new Context()
    fakeController(controllerSession, ctx)
    const service = new YuqiTeamOrchestratorService(ctx) as unknown as {
      batchExecutor: { hasActiveAttempt(journalKey: string, attemptId: string): boolean }
      scheduleColdRecovery(session: Session): void
    }
    vi.spyOn(service.batchExecutor, 'hasActiveAttempt').mockImplementation(
      (_journalKey, attemptId) => attemptId === 'attempt-1',
    )
    for (const fact of [
      ...completeTeamEvents().slice(0, 8),
      event(901, {
        type: 'yuqi/reconciliation-observed', operationId: ControlOperationId('startup-reconcile:service-owned'),
        observations: [{ taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), childSessionId: 'session-worker-1', state: 'live' }],
      }),
      event(902, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'reconciliation operation startup-reconcile:service-owned' }),
    ]) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    const journal = new HarnessSessionJournal(controllerSession, ctx.sessions)

    service.scheduleColdRecovery(controllerSession)
    await vi.waitFor(() => expect(replayTeamEvents(journal.read()).team.status).toBe('running'))
    expect(replayTeamEvents(journal.read()).attempts['attempt-1']?.status).toBe('running')
    await (service as unknown as { disposeHost(): Promise<void> }).disposeHost()
  })

  it('exposes durable Team bootstrap and verification start through the Cordis service', async () => {
    const bootstrapContext = new Context()
    installFakeSubprocess(bootstrapContext)
    const bootstrapHarness = fakeController(Session.create(SessionId('controller-bootstrap')), bootstrapContext)
    const bootstrapFiber = await bootstrapContext.plugin(YuqiTeamOrchestratorService)
    const bootstrapTask = { ...contract(TaskId('host-task')), baselineRef: 'host-baseline', verificationChecks: [{
      checkId: 'build', kind: 'build' as const, commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
      stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
    }] }
    const bootstrapped = await bootstrapContext.yuqiTeamOrchestrator.bootstrapTeam({
      controller: bootstrapHarness.agent,
      metadata: { teamId: 'team-bootstrap-host', title: 'Host bootstrap', objective: 'Create the runnable graph' },
      tasks: [bootstrapTask],
    })
    expect(bootstrapped.team.status).toBe('running')
    expect(bootstrapped.taskIds).toEqual([TaskId('host-task')])
    expect(new HarnessSessionJournal(bootstrapHarness.agent.session, bootstrapContext.sessions).read())
      .toHaveLength(3)
    await expect(bootstrapContext.yuqiTeamOrchestrator.bootstrapTeam({
      controller: bootstrapHarness.agent,
      metadata: { teamId: 'team-bootstrap-host', title: 'Host bootstrap', objective: 'Create the runnable graph' },
      tasks: [bootstrapTask],
    })).resolves.toMatchObject({ team: { status: 'running' } })
    await expect(bootstrapContext.yuqiTeamOrchestrator.bootstrapTeam({
      controller: bootstrapHarness.agent,
      metadata: { teamId: 'team-bootstrap-host', title: 'Host bootstrap', objective: 'Create the runnable graph' },
      tasks: [bootstrapTask, { ...contract(TaskId('other-host-task')), baselineRef: 'other-host-baseline', verificationChecks: bootstrapTask.verificationChecks }],
    })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(bootstrapContext.yuqiTeamOrchestrator.bootstrapTeam({
      controller: bootstrapHarness.agent,
      metadata: { teamId: 'other-bootstrap-team', title: 'Host bootstrap', objective: 'Create the runnable graph' },
      tasks: [bootstrapTask],
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await bootstrapFiber.dispose()

    const verificationContext = new Context()
    const verificationHarness = fakeController(Session.create(SessionId('controller-begin-verification')), verificationContext)
    for (const item of completeTeamEvents().slice(0, 11)) {
      verificationHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    }
    const verificationFiber = await verificationContext.plugin(YuqiTeamOrchestratorService)
    const verifying = await verificationContext.yuqiTeamOrchestrator.beginVerification({
      controller: verificationHarness.agent,
      teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      verificationId: 'host-verification', verifierSessionId: 'host-verifier',
    })
    expect(verifying.verifications['host-verification']).toMatchObject({ status: 'running', verifierSessionId: 'host-verifier' })
    await expect(verificationContext.yuqiTeamOrchestrator.beginVerification({
      controller: verificationHarness.agent,
      teamId: 'wrong-team', taskId: 'task-1', attemptId: 'attempt-1',
      verificationId: 'wrong-team-verification', verifierSessionId: 'host-verifier',
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(verificationContext.yuqiTeamOrchestrator.beginVerification({
      controller: verificationHarness.agent,
      teamId: 'team-1', taskId: 'task-1', attemptId: 'missing-attempt',
      verificationId: 'missing-attempt-verification', verifierSessionId: 'host-verifier',
    })).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
    const emptyVerificationContext = new Context()
    const emptyVerificationHarness = fakeController(Session.create(SessionId('controller-empty-verifier')), emptyVerificationContext)
    for (const item of completeTeamEvents().slice(0, 11)) emptyVerificationHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const emptyVerificationFiber = await emptyVerificationContext.plugin(YuqiTeamOrchestratorService)
    await expect(emptyVerificationContext.yuqiTeamOrchestrator.beginVerification({
      controller: emptyVerificationHarness.agent,
      teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      verificationId: 'empty-verifier-verification', verifierSessionId: '   ',
    })).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
    await emptyVerificationFiber.dispose()
    await verificationFiber.dispose()
  })

  it('keeps verification configuration permissive while still rejecting an unsafe project path', async () => {
    const missingCapabilityContext = new Context()
    const missingCapabilityHarness = fakeController(Session.create(SessionId('controller-start-no-subprocess')), missingCapabilityContext)
    const missingCapabilityFiber = await missingCapabilityContext.plugin(YuqiTeamOrchestratorService)
    const validCheck = {
      checkId: 'build', kind: 'build' as const, commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
      stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
    }
    await expect(missingCapabilityContext.yuqiTeamOrchestrator.startTeam({
      title: 'Missing Host capability', objective: 'Fail before physical start', tasks: [{ ...contract(TaskId('missing-host-task')), verificationChecks: [validCheck] }],
      projectCwd: path.join(os.tmpdir(), 'yuqi-missing-project'), managedRoot: path.join(os.tmpdir(), 'yuqi-missing-managed'),
      controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
    })).rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
    expect(missingCapabilityHarness.starts).toHaveLength(0)
    await missingCapabilityFiber.dispose()

    const missingChecksContext = new Context()
    installFakeSubprocess(missingChecksContext)
    const missingChecksHarness = fakeController(Session.create(SessionId('controller-run-no-checks')), missingChecksContext)
    for (const item of completeTeamEvents().slice(0, 3)) missingChecksHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const missingChecksFiber = await missingChecksContext.plugin(YuqiTeamOrchestratorService)
    await expect(missingChecksContext.yuqiTeamOrchestrator.runTeam({
      controller: missingChecksHarness.agent, teamId: 'team-1', maxConcurrency: 1,
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    expect(missingChecksHarness.starts).toHaveLength(0)
    await missingChecksFiber.dispose()

    const bootstrapContext = new Context()
    installFakeSubprocess(bootstrapContext)
    const bootstrapHarness = fakeController(Session.create(SessionId('controller-bootstrap-no-checks')), bootstrapContext)
    const bootstrapFiber = await bootstrapContext.plugin(YuqiTeamOrchestratorService)
    await expect(bootstrapContext.yuqiTeamOrchestrator.bootstrapTeam({
      controller: bootstrapHarness.agent,
      metadata: { teamId: 'team-bootstrap-no-checks', title: 'Rejected bootstrap', objective: 'No durable checks' },
      tasks: [contract(TaskId('bootstrap-no-checks'))],
    })).resolves.toMatchObject({ team: { status: 'running' } })
    expect(new HarnessSessionJournal(bootstrapHarness.agent.session, bootstrapContext.sessions).read()).toHaveLength(3)
    await bootstrapFiber.dispose()
  })

  it('exposes only fail-closed Host evidence capabilities and durably records unavailable collection', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-evidence-service')), ctx)
    for (const item of completeTeamEvents().slice(0, 13)) {
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    }
    installFakeSubprocess(ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    expect(ctx.yuqiTeamOrchestrator.evidenceCapabilities()).toEqual([
      expect.objectContaining({ kind: 'build', available: true }),
      expect.objectContaining({ kind: 'test', available: true, reason: 'Host Vitest JSON subprocess collector is available' }),
      expect.objectContaining({ kind: 'interface', available: true }),
      expect.objectContaining({ kind: 'screenshot', available: true }),
    ])
    const collected = await ctx.yuqiTeamOrchestrator.collectVerificationEvidence({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-1',
      operationId: 'service-evidence-collection', requirements: [{ checkId: 'build', kind: 'build' }], rework: { currentAttempt: 1, maxAttempts: 2 },
    })
    expect(collected.verifications['verification-1']?.verdict?.disposition).toBe('inconclusive')
    expect(collected.verifications['verification-1']?.status).toBe('waived')
    await fiber.dispose()
  })

  it.each(['pause', 'cancel'] as const)(
    'keeps durable %s bounded while a Host evidence collector remains pending',
    async action => {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId(`controller-pending-collector-${action}`)), ctx)
      for (const item of activeBuildVerificationEvents()) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const collector = installPendingEvidenceCollector(ctx.yuqiTeamOrchestrator)
      const runner = ctx.yuqiTeamOrchestrator.runTeam({
        controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
      })
      await collector.entered

      let controlSettled = false
      const control = (action === 'pause'
        ? ctx.yuqiTeamOrchestrator.pauseTeam({
            controller: harness.agent, teamId: 'team-1', operationId: 'pending-collector-pause',
          })
        : ctx.yuqiTeamOrchestrator.cancelTeam({
            controller: harness.agent, teamId: 'team-1', operationId: 'pending-collector-cancel',
          })).then(projection => { controlSettled = true; return projection })
      for (let index = 0; index < 20 && !controlSettled; index += 1) await Promise.resolve()
      const settledBeforeCollector = controlSettled
      if (!controlSettled) collector.release()
      const transition = await control
      const stopped = await runner
      collector.release()

      expect(settledBeforeCollector).toBe(true)
      expect(transition.team.status).not.toBe('needs_reconciliation')
      expect(stopped.reason).toBe(action === 'pause' ? 'paused' : 'cancelled')
      const projection = replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
      expect(projection.team.status).toBe(action === 'pause' ? 'paused' : 'cancelled')
      expect(projection.verifications['verification-1']?.verdict?.collectionStatus).toBe('aborted')
      await fiber.dispose()
    },
  )

  it('disposes the service without waiting for a pending Host evidence collector', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-pending-collector-dispose')), ctx)
    for (const item of activeBuildVerificationEvents()) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const collector = installPendingEvidenceCollector(ctx.yuqiTeamOrchestrator)
    const runner = ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    await collector.entered

    let disposeSettled = false
    const closing = fiber.dispose().then(() => { disposeSettled = true })
    let settledBeforeCollector = true
    try {
      await vi.waitFor(() => expect(disposeSettled).toBe(true), { timeout: 250, interval: 1 })
    } catch {
      settledBeforeCollector = false
    }
    if (!disposeSettled) collector.release()
    await closing
    collector.release()
    await Promise.allSettled([runner])
    expect(settledBeforeCollector).toBe(true)
  })

  it('retries the same controller owner after a transient Host shutdown disposal failure', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-shutdown-disposal-retry')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.pauseTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'shutdown-disposal-pause',
    })
    const disposeController = vi.fn()
      .mockRejectedValueOnce(new Error('transient shutdown disposal'))
      .mockResolvedValueOnce(undefined)
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1, disposeController,
    })

    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(disposeController).toHaveBeenCalledTimes(2)
  })

  it('bounds and reports a stuck controller disposal during Host shutdown', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-shutdown-disposal-timeout')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.pauseTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'shutdown-disposal-timeout-pause',
    })
    let releaseDisposal!: () => void
    const pendingDisposal = new Promise<void>(resolve => { releaseDisposal = resolve })
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
      disposeController: () => pendingDisposal,
    })
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => undefined)
    const service = ctx.yuqiTeamOrchestrator as unknown as { disposeTeamRunnerOwnership(): Promise<void> }

    vi.useFakeTimers()
    try {
      const closing = service.disposeTeamRunnerOwnership()
      await vi.advanceTimersByTimeAsync(5_000)
      await closing
    } finally {
      vi.useRealTimers()
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Host shutdown timed out after 5000ms'))

    releaseDisposal()
    await pendingDisposal
    await Promise.resolve()
    await fiber.dispose()
    error.mockRestore()
  })

  it('keeps service guards fail-closed for mismatched Teams, incomplete Harness services, and runtime shapes', async () => {
    const mismatchContext = new Context()
    const mismatchHarness = fakeController(Session.create(SessionId('controller-service-guards')), mismatchContext)
    for (const item of completeTeamEvents()) mismatchHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const mismatchFiber = await mismatchContext.plugin(YuqiTeamOrchestratorService)
    await expect(mismatchContext.yuqiTeamOrchestrator.runTeam({
      controller: mismatchHarness.agent, teamId: 'not-this-team', maxConcurrency: 1,
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    expect(() => mismatchContext.yuqiTeamOrchestrator.launchTeamController({
      workspace: {} as never, controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
    })).toThrow(/Agent creation or Agent Presets are unavailable/u)
    await mismatchFiber.dispose()

    const malformedRuntime = new Context()
    malformedRuntime.provide('subprocess' as never, {} as never)
    fakeController(Session.create(SessionId('controller-malformed-runtime')), malformedRuntime)
    const malformedFiber = await malformedRuntime.plugin(YuqiTeamOrchestratorService)
    expect(malformedRuntime.yuqiTeamOrchestrator.evidenceCapabilities()).toEqual([
      expect.objectContaining({ kind: 'build', available: false }),
      expect.objectContaining({ kind: 'test', available: false }),
      expect.objectContaining({ kind: 'interface', available: false }),
      expect.objectContaining({ kind: 'screenshot', available: false }),
    ])
    await malformedFiber.dispose()
  })

  it('rejects cancellation timeout values on both numeric bounds before durable control', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-cancel-bounds')), ctx)
    for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'too-large-timeout', timeoutMs: 300_001,
    })).rejects.toThrow(RangeError)
    await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'fractional-timeout', timeoutMs: 10.5,
    })).rejects.toThrow(RangeError)
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).controlOperations)
      .not.toHaveProperty('too-large-timeout')
    await fiber.dispose()
  })

  it.each([
    { label: 'known usage', usage: { uncachedInputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 }, expected: 'known' as const },
    { label: 'unknown usage', usage: undefined, expected: 'unknown' as const },
  ])('settles an admitted child token reservation as $label', async ({ usage, expected }) => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId(`controller-budget-${expected}`)), ctx)
    const taskId = TaskId(`budget-task-${expected}`)
    const attemptId = AttemptId(`budget-attempt-${expected}`)
    const reservationId = `budget-reservation-${expected}`
    for (const item of [
      event(2000, { type: 'yuqi/team-created', title: 'Budget settlement', objective: 'Settle child budget' }),
      event(2001, { type: 'yuqi/budget-policy-set', operationId: ControlOperationId(`budget-policy-${expected}`), revision: 1, tokenLimit: 100, alerts: [], stopBehavior: 'block-new' }),
      event(2002, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(2003, { type: 'yuqi/task-created', contract: contract(taskId) }),
      event(2004, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
      event(2005, { type: 'yuqi/budget-reservation-acquired', reservationId, taskId, attemptId, tokenReserve: 25 }),
      event(2006, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
      event(2007, { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(2008, { type: 'yuqi/attempt-admitted', taskId, attemptId, agentSessionId: 'budget-child', messageId: 'budget-message' }),
      event(2009, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      settleObservedAttempt(request: {
        teamId: string; taskId: string; attemptId: string; journal: HarnessSessionJournal;
        end: { runId: string; provider: string; childSessionId: string; stopReason: 'completed'; hasAssistantOutput: boolean; usage?: typeof usage }
      }): Promise<void>
    }
    await service.settleObservedAttempt({
      teamId: 'team-1', taskId: String(taskId), attemptId: String(attemptId), journal,
      end: { runId: `budget-run-${expected}`, provider: 'minimax', childSessionId: 'budget-child', stopReason: 'completed', hasAssistantOutput: true, ...(usage === undefined ? {} : { usage }) },
    })
    const projection = replayTeamEvents(journal.read())
    expect(projection.budgetReservations[reservationId]).toMatchObject({ status: expected })
    if (usage === undefined) expect(projection.budgetReservations[reservationId]).toMatchObject({ reason: 'admitted child ended without usage' })
    else expect(projection.budgetReservations[reservationId]).toMatchObject({ usage: { totalTokens: 21 } })
    expect(projection.attempts[String(attemptId)]?.status).toBe('completed')
    expect(projection.tasks[String(taskId)]?.status).toBe('completed')
    // Unknown token usage is a durable reconciliation gap: the task result is
    // preserved, but the Team must not claim terminal completion until usage
    // accounting is reconciled.
    expect(projection.team.status).toBe(expected === 'known' ? 'completed' : 'running')
    await fiber.dispose()
  })

  it('collects a durable fixed-command build through the public Host subprocess seam', async () => {
    const ctx = new Context()
    ctx.provide('subprocess' as never, {
      spawn: vi.fn(() => ({
        collected: {
          stdout: { readFrom: () => ({ text: 'build ok', nextOffset: 8, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      })),
    } as never)
    const harness = fakeController(Session.create(SessionId('controller-evidence-subprocess')), ctx)
    const source = completeTeamEvents().slice(0, 13).map(item => {
      const { schemaVersion: _schemaVersion, eventId: _eventId, teamId: _teamId, occurredAt: _occurredAt, ...body } = item
      return body
    })
    source[2] = {
      type: 'yuqi/task-created',
      contract: {
        ...contract(),
        verificationChecks: [{
          checkId: 'build', kind: 'build', commandRef: 'pnpm-build',
          timeoutMs: 10_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024,
        }],
      },
    }
    source.splice(3, 0,
      { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: WorkspaceId('workspace-evidence-subprocess'),
        project: {
          projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: path.join(process.cwd(), '.git'),
          baselineRef: 'commit-1', volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
        },
        worktreePath: process.cwd(), branchName: 'yuqi/evidence', status: 'provisioning',
      } },
      { type: 'yuqi/workspace-provisioned', workspaceId: WorkspaceId('workspace-evidence-subprocess') },
    )
    source.forEach((body, index) => harness.agent.session.append(TEAM_SESSION_EVENT, { event: event(index + 1, body as never) }))
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    expect(ctx.yuqiTeamOrchestrator.evidenceCapabilities()).toContainEqual(
      expect.objectContaining({ kind: 'build', available: true }),
    )
    const projection = await ctx.yuqiTeamOrchestrator.collectVerificationEvidence({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-1',
      operationId: 'service-subprocess-build', requirements: [{ checkId: 'ignored-caller-value', kind: 'screenshot' }],
      rework: { currentAttempt: 1, maxAttempts: 2 },
    })
    expect(projection.tasks['task-1']?.status).toBe('completed')
    expect(projection.verifications['verification-1']?.verdict).toMatchObject({ disposition: 'passed' })
    await fiber.dispose()
  })

  it('fails closed when durable active attempts have no live cancellation binding', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-cancel-restart')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) {
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    }
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'restart-cancel',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).team.status)
      .toBe('needs_reconciliation')
    await fiber.dispose()
  })

  it('replays a crash-window cancel through runtime control and records cold binding uncertainty', async () => {
    const session = Session.create(SessionId('controller-cancel-crash-window'))
    for (const item of completeTeamEvents().slice(0, 8)) session.append(TEAM_SESSION_EVENT, { event: item })

    const firstContext = new Context()
    const firstHarness = fakeController(session, firstContext)
    const firstFiber = await firstContext.plugin(YuqiTeamOrchestratorService)
    const firstJournal = new HarnessSessionJournal(session, firstContext.sessions)
    const firstService = firstContext.yuqiTeamOrchestrator as unknown as {
      teamControls: {
        cancelWithDisposition(
          request: { readonly teamId: string; readonly operationId: string },
          journal: HarnessSessionJournal,
        ): Promise<{ readonly projection: ReturnType<typeof replayTeamEvents>; readonly disposition: 'created' | 'replayed' }>
      }
    }
    await expect(firstService.teamControls.cancelWithDisposition({
      teamId: 'team-1', operationId: 'cancel-crash-window',
    }, firstJournal)).resolves.toMatchObject({ disposition: 'created', projection: { team: { status: 'cancelling' } } })
    await firstFiber.dispose()

    const coldContext = new Context()
    const coldHarness = fakeController(session, coldContext)
    const coldFiber = await coldContext.plugin(YuqiTeamOrchestratorService)
    await expect(coldContext.yuqiTeamOrchestrator.cancelTeam({
      controller: coldHarness.agent, teamId: 'team-1', operationId: 'cancel-crash-window', timeoutMs: 10,
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    const events = new HarnessSessionJournal(session, coldContext.sessions).read() as readonly { readonly type?: string; readonly operationId?: string }[]
    expect(events.filter(item => item.type === 'yuqi/team-control-requested' && item.operationId === 'cancel-crash-window')).toHaveLength(1)
    expect(replayTeamEvents(events).team.status).toBe('needs_reconciliation')
    await coldFiber.dispose()
  })

  it('does not treat a local cancellation wait as success without durable terminal accounting', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-cancel-unaccounted-settlement')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const runtime = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: {
        cancelActiveAndWait(): Promise<{ readonly activeCount: number; readonly outcome: 'settled' }>
      }
    }
    runtime.batchExecutor.cancelActiveAndWait = async () => ({ activeCount: 1, outcome: 'settled' })

    await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'cancel-unaccounted-settlement',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).team.status)
      .toBe('needs_reconciliation')
    await fiber.dispose()
  })

  it('keeps cancellation pending when an exact local child is slow to stop', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-cancel-slow-local')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const runtime = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: {
        cancelActiveAndWait(): Promise<{ readonly activeCount: number; readonly outcome: 'timeout' }>
        hasActiveAttempt(journalKey: string, attemptId: string): boolean
      }
    }
    runtime.batchExecutor.cancelActiveAndWait = async () => ({ activeCount: 1, outcome: 'timeout' })
    runtime.batchExecutor.hasActiveAttempt = () => true

    await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'cancel-slow-local', timeoutMs: 10,
    })).resolves.toMatchObject({ team: { status: 'cancelling' } })
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).team.status)
      .toBe('cancelling')
    await fiber.dispose()
  })

  it.each(['missing-binding', 'interrupt-error', 'uncertainty-mark'] as const)(
    'returns durable cancellation when terminal accounting wins the %s race',
    async mode => {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId(`controller-cancel-race-${mode}`)), ctx)
      for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const internals = ctx.yuqiTeamOrchestrator as unknown as {
        batchExecutor: { cancelActiveAndWait(journalKey: string, timeoutMs: number): Promise<{ activeCount: number; outcome: 'failed' }> }
        teamControls: { markCancellationUncertain(teamId: string, journal: HarnessSessionJournal, reason: string): Promise<ReturnType<typeof replayTeamEvents>> }
      }
      const appendTerminalFacts = () => {
        for (const item of [
          event(905, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
          event(906, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
          event(907, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
        ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      }
      const batch = internals.batchExecutor
      batch.cancelActiveAndWait = async () => {
        if (mode !== 'uncertainty-mark') appendTerminalFacts()
        if (mode === 'interrupt-error') throw new Error('interrupt lost after terminal persistence')
        return { activeCount: 0, outcome: 'failed' }
      }
      if (mode === 'uncertainty-mark') {
        internals.teamControls.markCancellationUncertain = async () => {
          appendTerminalFacts()
          return replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
        }
      }
      await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
        controller: harness.agent, teamId: 'team-1', operationId: `cancel-race-${mode}`,
      })).resolves.toMatchObject({ team: { status: 'cancelled' } })
      await fiber.dispose()
    },
  )

  it('queues a durable task retry through the Cordis service without replacing evidence', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-retry-service')), ctx)
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(980, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(981, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'retry-service-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:30:00Z' }),
      event(982, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    const retried = await ctx.yuqiTeamOrchestrator.retryTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'service-retry',
    })
    expect(retried.tasks['task-1']?.status).toBe('ready')
    expect(retried.attempts['attempt-1']?.evidence?.runId).toBe('retry-service-run')
    expect(retried.taskRetryOperations['service-retry']?.taskId).toBe('task-1')
    await fiber.dispose()
  })

  it('delivers a later instruction to the exact running child FIFO inbox only', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-task-message')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', message: '继续视觉升级，并保留现有布局。', signal: new AbortController().signal,
    })).resolves.toEqual({ childSessionId: 'session-worker-1', messageId: 'send-message-1' })
    expect(harness.messages).toEqual([expect.objectContaining({
      sender: harness.agent,
      childSessionId: 'session-worker-1',
      content: [{ type: 'text', text: '继续视觉升级，并保留现有布局。' }],
      options: expect.objectContaining({ signal: expect.any(AbortSignal) }),
    })])
    // The tool result and the durable instruction receipt already confirm
    // delivery; the relay must not echo back into the controller conversation.
    expect(harness.agent.inject).not.toHaveBeenCalled()
    await expect(ctx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: harness.agent, teamId: 'team-1', taskId: 'missing', message: 'x', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    for (const message of ['', 'x'.repeat(16_385)]) {
      await expect(ctx.yuqiTeamOrchestrator.sendTaskMessage({
        controller: harness.agent, teamId: 'team-1', taskId: 'task-1', message, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    }
    await fiber.dispose()
  })

  it('suppresses intermediate settled cuts and delivers one final parent report when the Team completes', async () => {
    const ctx = new Context()
    const controllerSession = Session.create(SessionId('controller-parent-update'))
    const harness = fakeController(controllerSession, ctx, 'read-only', { agentsRegistry: 'custom' })
    const parentSession = Session.create(SessionId('main-parent-update'))
    harness.registerSession(parentSession)
    const send = vi.fn()
    const parent = {
      id: parentSession.id,
      session: parentSession,
      options: {},
      status: 'idle',
      ctx,
      send,
    } as unknown as Agent
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parent.id), generation: 1, operationId: 'bind-parent-update', boundAt: '2026-08-30T00:00:00Z',
    })
    for (const item of [
      event(2100, { type: 'yuqi/team-created', title: 'Parallel parent update', objective: 'Report two workers together' }),
      event(2101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(2102, { type: 'yuqi/task-created', contract: contract(TaskId('task-1')) }),
      event(2103, { type: 'yuqi/task-created', contract: contract(TaskId('task-2')) }),
      event(2104, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'pending', to: 'ready' }),
      event(2105, { type: 'yuqi/task-status-changed', taskId: TaskId('task-2'), from: 'pending', to: 'ready' }),
      event(2106, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'ready', to: 'running' }),
      event(2107, { type: 'yuqi/attempt-created', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(2108, { type: 'yuqi/attempt-admitted', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), agentSessionId: 'session-worker-1', messageId: 'message-1' }),
      event(2109, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'dispatching', to: 'running' }),
      event(2110, { type: 'yuqi/task-status-changed', taskId: TaskId('task-2'), from: 'ready', to: 'running' }),
      event(2111, { type: 'yuqi/attempt-created', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(2112, { type: 'yuqi/attempt-admitted', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), agentSessionId: 'session-worker-2', messageId: 'message-2' }),
      event(2113, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-2'), attemptId: AttemptId('attempt-2'), from: 'dispatching', to: 'running' }),
    ]) controllerSession.append(TEAM_SESSION_EVENT, { event: item })
    ctx.provide('agents', {
      get(id: SessionId) { return String(id) === String(parent.id) ? parent : String(id) === String(harness.agent.id) ? harness.agent : undefined },
    } as never)
    ctx.provide('agentPresets' as never, {
      resolve: async (id = 'standard') => ({ id }),
      mount: async () => undefined,
    } as never)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      settleObservedAttempt(request: {
        teamId: string; taskId: string; attemptId: string; journal: HarnessSessionJournal;
        end: { runId: string; provider: string; childSessionId: string; stopReason: 'completed'; hasAssistantOutput: boolean }
      }): Promise<void>
    }
    await service.settleObservedAttempt({
      teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      journal: new HarnessSessionJournal(controllerSession, ctx.sessions),
      end: { runId: 'parent-update-run', provider: 'in-process', childSessionId: 'session-worker-1', stopReason: 'completed', hasAssistantOutput: true },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(send).not.toHaveBeenCalled()
    await service.settleObservedAttempt({
      teamId: 'team-1', taskId: 'task-2', attemptId: 'attempt-2',
      journal: new HarnessSessionJournal(controllerSession, ctx.sessions),
      end: { runId: 'parent-update-run-2', provider: 'in-process', childSessionId: 'session-worker-2', stopReason: 'completed', hasAssistantOutput: true },
    })
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      role: 'user',
      content: [expect.objectContaining({ text: expect.stringMatching(/teamStatus=completed[\s\S]*task-1[\s\S]*task-2/u) })],
      source: expect.objectContaining({ kind: 'plugin', form: 'notice' }),
    }), 'next-turn', true)
    await fiber.dispose()
  })

  it('replays a pending durable report when the bound parent Agent is created later', async () => {
    const ctx = new Context()
    const controllerSession = Session.create(SessionId('controller-parent-recovery'))
    const harness = fakeController(controllerSession, ctx, 'read-only', { agentsRegistry: 'custom' })
    const parentSession = Session.create(SessionId('main-parent-recovery'))
    harness.registerSession(parentSession)
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parentSession.id), generation: 1,
      operationId: 'bind-parent-recovery', boundAt: '2026-09-01T00:00:00Z',
    })
    for (const item of completeTeamEvents()) controllerSession.append(TEAM_SESSION_EVENT, { event: item })
    const send = vi.fn()
    const parent = {
      id: parentSession.id, session: parentSession, options: {}, status: 'idle', ctx, send,
    } as unknown as Agent
    const live = new Map<string, Agent>([[String(harness.agent.id), harness.agent]])
    ctx.provide('agents', {
      get: (id: SessionId) => live.get(String(id)),
      list: () => [...live.values()],
    } as never)
    ctx.provide('agentPresets' as never, {
      resolve: async (id = 'standard') => ({ id }), mount: async () => undefined,
    } as never)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(send).not.toHaveBeenCalled()

    live.set(String(parent.id), parent)
    ctx.emit('agent/created', { agent: parent })
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    await fiber.dispose()
  })

  it('resolves a coalesced parent report delay during service disposal', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-parent-dispose-delay')), ctx)
      for (const item of completeTeamEvents().slice(0, 2)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const service = ctx.yuqiTeamOrchestrator as unknown as {
        scheduleParentReportDelivery(controllerSessionId: string): void
        parentReportDeliveryTails: Map<string, Promise<{ readonly generation: number; readonly pending: boolean }>>
        parentReportDeliveryDelayTimers: Map<string, ReturnType<typeof setTimeout>>
        parentReportDeliveryDelayResolvers: Map<string, () => void>
      }
      service.scheduleParentReportDelivery(String(harness.agent.id))
      const delivery = service.parentReportDeliveryTails.get(String(harness.agent.id))
      expect(delivery).toBeDefined()

      await fiber.dispose()
      await expect(delivery!).resolves.toMatchObject({ pending: false })
      expect(service.parentReportDeliveryTails.size).toBe(0)
      expect(service.parentReportDeliveryDelayTimers.size).toBe(0)
      expect(service.parentReportDeliveryDelayResolvers.size).toBe(0)
      service.scheduleParentReportDelivery(String(harness.agent.id))
      expect(service.parentReportDeliveryTails.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not bypass Team or task lifecycle gates when sending a child message', async () => {
    const readyCtx = new Context()
    const readyHarness = fakeController(Session.create(SessionId('controller-ready-message')), readyCtx)
    for (const item of completeTeamEvents().slice(0, 4)) readyHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const readyFiber = await readyCtx.plugin(YuqiTeamOrchestratorService)
    await expect(readyCtx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: readyHarness.agent, teamId: 'team-1', taskId: 'task-1', message: 'x', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await readyFiber.dispose()

    const unadmittedCtx = new Context()
    const unadmittedHarness = fakeController(Session.create(SessionId('controller-unadmitted-message')), unadmittedCtx)
    for (const item of completeTeamEvents().slice(0, 6)) unadmittedHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const unadmittedFiber = await unadmittedCtx.plugin(YuqiTeamOrchestratorService)
    await expect(unadmittedCtx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: unadmittedHarness.agent, teamId: 'team-1', taskId: 'task-1', message: 'x', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await unadmittedFiber.dispose()

    const pausedCtx = new Context()
    const pausedHarness = fakeController(Session.create(SessionId('controller-paused-message')), pausedCtx)
    for (const item of [
      ...completeTeamEvents().slice(0, 4),
      event(986, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(987, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ]) pausedHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const pausedFiber = await pausedCtx.plugin(YuqiTeamOrchestratorService)
    await expect(pausedCtx.yuqiTeamOrchestrator.sendTaskMessage({
      controller: pausedHarness.agent, teamId: 'team-1', taskId: 'task-1', message: 'x', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await pausedFiber.dispose()
  })

  it('revises a ready task model durably without creating an attempt', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-model-service')), ctx)
    for (const item of completeTeamEvents().slice(0, 4)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const changed = await ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'model-ready',
    })
    expect(changed.tasks['task-1']?.contract).toMatchObject({ revision: 2, modelRequest: { kind: 'legacy', modelId: 'deepseek-v4-pro' } })
    expect(changed.tasks['task-1']?.attemptIds).toEqual([])
    const unchanged = await ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'model-same',
    })
    expect(unchanged.tasks['task-1']?.contract).toMatchObject({ revision: 2, modelRequest: { kind: 'legacy', modelId: 'deepseek-v4-pro' } })
    await expect(ctx.yuqiTeamOrchestrator.setTaskModel({ controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: '', operationId: 'empty' }))
      .rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await expect(ctx.yuqiTeamOrchestrator.setTaskModel({ controller: harness.agent, teamId: 'team-1', taskId: 'missing', modelId: 'deepseek-v4', operationId: 'missing-task' }))
      .rejects.toMatchObject({ code: 'INVALID_BATCH' })
    await fiber.dispose()
  })

  it('revises a ready task permission durably and permits direct-workspace escalation', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-authority-service')), ctx)
    const authorityRoot = process.cwd()
    const authorityWorkspaceId = WorkspaceId('workspace-authority-service')
    for (const item of [
      ...completeTeamEvents().slice(0, 3),
      event(1900, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId: authorityWorkspaceId,
        project: { mode: 'direct', projectRoot: authorityRoot, volumeRoot: path.parse(authorityRoot).root, protectedRoots: [] } as never,
        worktreePath: authorityRoot, branchName: 'direct', status: 'provisioning',
      } }),
      event(1901, { type: 'yuqi/workspace-provisioned', workspaceId: authorityWorkspaceId }),
      completeTeamEvents()[3]!,
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const changed = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'authority-ready',
    })
    expect(changed.tasks['task-1']?.contract).toMatchObject({ revision: 2, authorityMode: 'read-only' })
    expect(changed.tasks['task-1']?.attemptIds).toEqual([])
    const unchanged = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'authority-same',
    })
    expect(unchanged.tasks['task-1']?.contract).toMatchObject({ revision: 2, authorityMode: 'read-only' })
    await expect(ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'missing', authorityMode: 'read-only', operationId: 'authority-missing',
    })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    const escalated = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'full-access', operationId: 'unsafe-escalation',
    })
    expect(escalated.tasks['task-1']?.contract).toMatchObject({ revision: 3, authorityMode: 'full-access' })
    await fiber.dispose()
  })

  it('retries a failed task and persists its replacement permission', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-failed-authority-service')), ctx)
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(1983, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(1984, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'failed-authority-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:35:00Z' }),
      event(1985, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.runTeam({ controller: harness.agent, teamId: 'team-1', maxConcurrency: 1 })
    const changed = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'authority-failed',
    })
    expect(changed.tasks['task-1']).toMatchObject({ status: 'ready', contract: { revision: 2, authorityMode: 'read-only' } })
    expect(changed.taskRetryOperations['authority-failed:retry']?.taskId).toBe('task-1')
    await fiber.dispose()
  })

  it('safely restarts a running task when its permission changes', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-running-authority')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(journalKey: string, attemptId: string, timeoutMs: number): Promise<{ activeCount: number; outcome: 'settled' }> }
      teamRunnerSupervisor: { canWake(journalKey: string): boolean; acquireWakeLease(journalKey: string): { wake(): Promise<unknown>; release(): void } }
    }
    internals.teamRunnerSupervisor.canWake = () => true
    internals.teamRunnerSupervisor.acquireWakeLease = () => ({ wake: async () => ({}), release: () => undefined })
    internals.batchExecutor.cancelAttemptAndWait = async (_journalKey, attemptId, timeoutMs) => {
      expect(attemptId).toBe('attempt-1')
      expect(timeoutMs).toBe(15_000)
      for (const item of [
        event(1990, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(1991, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'authority-switch-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:40:00Z' }),
        event(1992, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      setTimeout(() => harness.agent.session.append(TEAM_SESSION_EVENT, {
        event: event(1993, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
      }), 10)
      return { activeCount: 1, outcome: 'settled' }
    }
    const changed = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'running-authority',
    })
    expect(changed.team.status).toBe('running')
    expect(changed.tasks['task-1']).toMatchObject({ status: 'ready', contract: { revision: 2, authorityMode: 'read-only' } })
    expect(changed.attempts['attempt-1']?.evidence?.stopReason).toBe('aborted')
    await fiber.dispose()
  })

  it('durably stops only one running child and keeps the Team running', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-stop-one-task')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(journalKey: string, attemptId: string, timeoutMs: number): Promise<{ activeCount: number; outcome: 'settled' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async (_journalKey, attemptId, timeoutMs) => {
      expect(attemptId).toBe('attempt-1')
      expect(timeoutMs).toBe(15_000)
      const beforeInterrupt = replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
      expect(beforeInterrupt.team.status).toBe('running')
      expect(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'yuqi/task-stop-requested', operationId: 'stop-one', taskId: 'task-1' })]))
      for (const item of [
        event(1986, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(1987, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'stop-one-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:39:00Z' }),
        event(1988, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      return { activeCount: 1, outcome: 'settled' }
    }
    const changed = await ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-one',
    })
    expect(changed.team.status).toBe('running')
    expect(changed.tasks['task-1']?.status).toBe('cancelled')
    expect(changed.attempts['attempt-1']?.evidence?.stopReason).toBe('aborted')
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-one',
    })).resolves.toMatchObject({ team: { status: 'running' }, tasks: { 'task-1': { status: 'cancelled' } } })
    await fiber.dispose()
  })

  it('fails closed when a durable single-task stop has no confirmed child outcome', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-stop-one-timeout')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'timed_out' }> }
    }
    let calls = 0
    internals.batchExecutor.cancelAttemptAndWait = async () => {
      calls++
      if (calls === 1) return { activeCount: 1, outcome: 'timed_out' }
      for (const item of [
        event(1981, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(1982, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'stop-replay-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:38:00Z' }),
        event(1983, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      return { activeCount: 1, outcome: 'settled' } as never
    }
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-timeout',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'yuqi/task-stop-requested', operationId: 'stop-timeout' })]))
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-timeout',
    })).resolves.toMatchObject({ tasks: { 'task-1': { status: 'cancelled' } } })
    expect(calls).toBe(2)
    await fiber.dispose()
  })

  it('rejects invalid single-task stop targets before touching a child runtime', async () => {
    const cases = [
      { id: 'missing-task', events: completeTeamEvents().slice(0, 8), taskId: 'missing', code: 'INVALID_BATCH' },
      { id: 'missing-attempt', events: completeTeamEvents().slice(0, 5), taskId: 'task-1', code: 'CONTROL_NOT_ALLOWED' },
    ] as const
    for (const item of cases) {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId(`controller-stop-${item.id}`)), ctx)
      for (const fact of item.events) harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      await expect(ctx.yuqiTeamOrchestrator.stopTask({
        controller: harness.agent, teamId: 'team-1', taskId: item.taskId, operationId: `stop-${item.id}`,
      })).rejects.toMatchObject({ code: item.code })
      await fiber.dispose()
    }
  })

  it('rejects a reused stop operation target and a settlement without durable cancellation', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-stop-conflicts')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'settled' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async () => ({ activeCount: 1, outcome: 'settled' })
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-settled-gap',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'different-task', operationId: 'stop-settled-gap',
    })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await fiber.dispose()
  })

  it('does not interrupt a child when a concurrent durable transaction already ended the task', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-stop-race-ended')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const current = replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
    const cancelAttemptAndWait = vi.fn()
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      transactions: { run(): Promise<typeof current> }
      batchExecutor: { cancelAttemptAndWait: typeof cancelAttemptAndWait }
    }
    internals.transactions.run = async () => ({
      ...current,
      tasks: { ...current.tasks, 'task-1': { ...current.tasks['task-1']!, status: 'cancelled' } },
    })
    internals.batchExecutor.cancelAttemptAndWait = cancelAttemptAndWait
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: 'stop-race-ended',
    })).resolves.toMatchObject({ tasks: { 'task-1': { status: 'cancelled' } } })
    expect(cancelAttemptAndWait).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('treats a late stop click on a %s task as an idempotent no-op', async status => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId(`controller-stop-late-${status}`)), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const terminalTaskStatus = status === 'completed' ? 'completed' : status
    const terminalAttemptStatus = status === 'completed' ? 'settled' : status
    const stopReason = status === 'completed' ? 'completed' : status === 'failed' ? 'error' : 'aborted'
    harness.agent.session.append(TEAM_SESSION_EVENT, { event: event(2100, {
      type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: terminalAttemptStatus,
    }) })
    harness.agent.session.append(TEAM_SESSION_EVENT, { event: event(2101, {
      type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: `late-stop-${status}`,
      agentSessionId: 'session-worker-1', provider: 'in-process', stopReason, hasAssistantOutput: false,
      settledAt: '2026-08-15T15:41:00Z',
    }) })
    harness.agent.session.append(TEAM_SESSION_EVENT, { event: event(2102, {
      type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: terminalTaskStatus,
    }) })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as { batchExecutor: { cancelAttemptAndWait: ReturnType<typeof vi.fn> } }
    internals.batchExecutor.cancelAttemptAndWait = vi.fn()
    await expect(ctx.yuqiTeamOrchestrator.stopTask({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', operationId: `stop-late-${status}`,
    })).resolves.toMatchObject({ team: { status: 'running' }, tasks: { 'task-1': { status } } })
    expect(internals.batchExecutor.cancelAttemptAndWait).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('fails closed when a running task cannot be durably stopped for a permission switch', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-authority-stop-timeout')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'timed_out' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async () => ({ activeCount: 1, outcome: 'timed_out' })
    await expect(ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'authority-stop-timeout',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await fiber.dispose()
  })

  it('fails closed when the Team leaves pausing unexpectedly during a permission switch', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-authority-pause-terminal')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'settled' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async () => {
      for (const item of [
        event(1994, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(1995, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'authority-terminal-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:41:00Z' }),
        event(1996, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
        event(1997, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'needs_reconciliation', reason: 'Host ownership changed while pausing' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      return { activeCount: 0, outcome: 'settled' }
    }
    await expect(ctx.yuqiTeamOrchestrator.setTaskAuthority({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', authorityMode: 'read-only', operationId: 'authority-pause-terminal',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await fiber.dispose()
  })

  it('retries a failed task and persists the selected replacement model as one operation', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-failed-model-service')), ctx)
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(983, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'failed' }),
      event(984, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'failed-model-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'error', hasAssistantOutput: false, settledAt: '2026-08-15T15:35:00Z' }),
      event(985, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'failed' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
    })
    const changed = await ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'model-failed',
    })
    expect(changed.tasks['task-1']).toMatchObject({ status: 'ready', contract: { revision: 2, modelRequest: { kind: 'legacy', modelId: 'deepseek-v4-pro' } } })
    expect(changed.attempts['attempt-1']?.evidence?.runId).toBe('failed-model-run')
    expect(changed.taskRetryOperations['model-failed:retry']?.taskId).toBe('task-1')
    await fiber.dispose()
  })

  it('safely restarts a running task when its model changes', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-running-model')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(journalKey: string, attemptId: string, timeoutMs: number): Promise<{ activeCount: number; outcome: 'settled' }> }
      teamRunnerSupervisor: { canWake(journalKey: string): boolean; acquireWakeLease(journalKey: string): { wake(): Promise<unknown>; release(): void } }
    }
    internals.teamRunnerSupervisor.canWake = () => true
    internals.teamRunnerSupervisor.acquireWakeLease = () => ({ wake: async () => ({}), release: () => undefined })
    internals.batchExecutor.cancelAttemptAndWait = async (_journalKey, attemptId, timeoutMs) => {
      expect(attemptId).toBe('attempt-1')
      expect(timeoutMs).toBe(15_000)
      for (const item of [
        event(990, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(991, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'switch-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:40:00Z' }),
        event(992, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      setTimeout(() => harness.agent.session.append(TEAM_SESSION_EVENT, {
        event: event(993, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
      }), 10)
      return { activeCount: 1, outcome: 'settled' }
    }
    const changed = await ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'running-model',
    })
    expect(changed.team.status).toBe('running')
    expect(changed.tasks['task-1']).toMatchObject({ status: 'ready', contract: { revision: 2, modelRequest: { kind: 'legacy', modelId: 'deepseek-v4-pro' } } })
    expect(changed.attempts['attempt-1']?.evidence?.stopReason).toBe('aborted')
    await fiber.dispose()
  })

  it('fails closed when a running task cannot be durably stopped for a model switch', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-model-stop-timeout')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'timed_out' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async () => ({ activeCount: 1, outcome: 'timed_out' })

    await expect(ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'model-stop-timeout',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await fiber.dispose()
  })

  it('fails closed when the Team leaves pausing through an unexpected terminal state during a model switch', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-model-pause-terminal')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const internals = ctx.yuqiTeamOrchestrator as unknown as {
      batchExecutor: { cancelAttemptAndWait(): Promise<{ activeCount: number; outcome: 'settled' }> }
    }
    internals.batchExecutor.cancelAttemptAndWait = async () => {
      for (const item of [
        event(994, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
        event(995, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'switch-terminal-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:41:00Z' }),
        event(996, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
        event(997, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'needs_reconciliation', reason: 'Host ownership changed while pausing' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      return { activeCount: 0, outcome: 'settled' }
    }

    await expect(ctx.yuqiTeamOrchestrator.setTaskModel({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'deepseek-v4-pro', operationId: 'model-pause-terminal',
    })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await fiber.dispose()
  })

  it('records restart reconciliation through the public Harness child listing', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-reconcile-service')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) {
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    }
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const reconciled = await ctx.yuqiTeamOrchestrator.reconcileTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'service-reconcile',
    })
    expect(reconciled.team.status).toBe('needs_reconciliation')
    expect(reconciled.attempts['attempt-1']?.status).toBe('unknown')
    expect(reconciled.reconciliationOperations['service-reconcile']?.observations[0])
      .toMatchObject({ childSessionId: 'session-worker-1', state: 'missing' })
    await expect(ctx.yuqiTeamOrchestrator.resolveAttempt({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      operationId: 'bad$id', observationOperationId: 'service-reconcile', decision: 'failed',
    })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(ctx.yuqiTeamOrchestrator.clearTeamRecovery({
      controller: harness.agent, teamId: 'team-1', operationId: 'bad$id',
    })).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(ctx.yuqiTeamOrchestrator.resolveAttempt({
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      operationId: 'service-resolution', observationOperationId: 'service-reconcile', decision: 'failed',
    })).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
    expect(replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read()).attempts['attempt-1']?.status).toBe('unknown')
    await fiber.dispose()
  })

  it('automatically fails a persisted active controller closed after Host restart', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('yuqi-team-cold-startup-scan'))
    for (const item of completeTeamEvents().slice(0, 8)) {
      session.append(TEAM_SESSION_EVENT, { event: item })
    }
    const sessions = new Map([[String(session.id), session]])
    ctx.provide('sessions', {
      list: () => [...sessions.values()],
      get: (id: SessionId) => sessions.get(String(id)),
      flush: async () => true,
    } as never)
    const harness = fakeController(session, ctx)

    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await vi.waitFor(() => {
      const projection = replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read())
      expect(projection.team.status).toBe('needs_reconciliation')
      expect(projection.attempts['attempt-1']?.status).toBe('unknown')
    })
    await fiber.dispose()
  })

  it('automatically closes a safely missing child to paused when the controller cannot be rehydrated', async () => {
    const fixture = await realGatedWorkspace('automatic-cold-safe-recovery')
    try {
      const ctx = new Context()
      const session = Session.create(SessionId('yuqi-team-automatic-cold-safe-recovery'), [], {
        version: 0, id: SessionId('yuqi-team-automatic-cold-safe-recovery'), createdAt: 0,
        cwd: fixture.workspace.worktreePath,
      })
      const harness = fakeController(session, ctx, 'workspace-write')
      for (const item of [
        ...completeTeamEvents().slice(0, 8),
        event(9_460, { type: 'yuqi/workspace-provisioning-started', workspace: { ...fixture.workspace, status: 'provisioning' } }),
        event(9_461, { type: 'yuqi/workspace-provisioned', workspaceId: fixture.workspace.workspaceId }),
      ]) session.append(TEAM_SESSION_EVENT, { event: item })
      const beforeAttempts = completeTeamEvents().slice(0, 8).filter(item => item.type === 'yuqi/attempt-created').length
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

      await vi.waitFor(() => {
        const projection = replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read())
        expect(projection.team.status).toBe('paused')
        expect(projection.attempts['attempt-1']?.status).toBe('failed')
        expect(projection.tasks['task-1']?.status).toBe('failed')
      }, { timeout: 15_000 })
      const after = replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read())
      expect(Object.values(after.attempts).filter(attempt => attempt.taskId === 'task-1')).toHaveLength(beforeAttempts)
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 20_000)

  it('repairs a quiescent cancelled task as paused after Host restart instead of requiring reconciliation', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('yuqi-team-cold-cancelled-settlement'))
    for (const item of [
      ...completeTeamEvents().slice(0, 8),
      event(1980, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
      event(1981, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'cold-cancelled-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:50:00Z' }),
      event(1982, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
    ]) session.append(TEAM_SESSION_EVENT, { event: item })
    const sessions = new Map([[String(session.id), session]])
    ctx.provide('sessions', {
      list: () => [...sessions.values()],
      get: (id: SessionId) => sessions.get(String(id)),
      flush: async () => true,
    } as never)
    fakeController(session, ctx)

    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await vi.waitFor(() => {
      expect(replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read()).team.status).toBe('paused')
    })
    await fiber.dispose()
  })

  it('pauses a cold 5-plus-2 terminal dependency graph without replaying its blocked pending tasks', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('yuqi-team-cold-five-plus-two'))
    const terminalTaskIds = Array.from({ length: 5 }, (_, index) => TaskId(`terminal-${index + 1}`))
    const pendingTaskIds = [TaskId('dependent-1'), TaskId('dependent-2')]
    const facts = [
      event(2100, { type: 'yuqi/team-created', title: 'Five plus two', objective: 'Preserve dependency-blocked pending tasks' }),
      event(2101, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      ...terminalTaskIds.map((taskId, index) => event(2102 + index, { type: 'yuqi/task-created', contract: contract(taskId) })),
      ...terminalTaskIds.flatMap((taskId, index) => [
        event(2110 + index * 3, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
        event(2111 + index * 3, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
        event(2112 + index * 3, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'failed', reason: 'terminal task failed' }),
      ]),
      event(2130, { type: 'yuqi/task-created', contract: contract(pendingTaskIds[0]!, 1, [terminalTaskIds[0]!]) }),
      event(2131, { type: 'yuqi/task-created', contract: contract(pendingTaskIds[1]!, 1, [terminalTaskIds[1]!]) }),
      event(2132, { type: 'yuqi/task-status-changed', taskId: pendingTaskIds[0]!, from: 'pending', to: 'blocked', reason: 'terminal prerequisite failed' }),
      event(2133, { type: 'yuqi/task-status-changed', taskId: pendingTaskIds[1]!, from: 'pending', to: 'blocked', reason: 'terminal prerequisite failed' }),
    ]
    for (const fact of facts) session.append(TEAM_SESSION_EVENT, { event: fact })
    const harness = fakeController(session, ctx)

    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await vi.waitFor(() => {
      const projection = replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read())
      expect(projection.team.status).toBe('paused')
      expect(terminalTaskIds.map(id => projection.tasks[id]?.status)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed'])
      expect(pendingTaskIds.map(id => projection.tasks[id]?.status)).toEqual(['blocked', 'blocked'])
    })
    await ctx.yuqiTeamOrchestrator.runTeam({
      controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
      disposeController: vi.fn(async () => {}),
    })
    // Continue is rejected before persistence because pending descendants are
    // dependency-blocked and do not constitute executable work.
    const beforeContinues = new HarnessSessionJournal(session, ctx.sessions).read().length
    await expect(ctx.yuqiTeamOrchestrator.resumeTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'five-plus-two-continue-1',
    })).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    await expect(ctx.yuqiTeamOrchestrator.resumeTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'five-plus-two-continue-2',
    })).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
    const journalAfterContinues = new HarnessSessionJournal(session, ctx.sessions).read()
    expect(journalAfterContinues).toHaveLength(beforeContinues)
    const afterContinues = replayTeamEvents(journalAfterContinues)
    expect(afterContinues.team.status).toBe('paused')
    expect(pendingTaskIds.map(id => afterContinues.tasks[id]?.status)).toEqual(['blocked', 'blocked'])
    await fiber.dispose()
  })

  it('downgrades a legacy settled outcome recovery loop to paused without auto-resuming it', async () => {
    const ctx = new Context()
    const cwd = process.cwd()
    const legacySessionId = SessionId('controller-legacy-settled-outcome')
    const harness = fakeController(Session.create(legacySessionId, [], { version: 0, id: legacySessionId, createdAt: 0, cwd }), ctx)
    const workspaceId = WorkspaceId('workspace-legacy-settled-outcome')
    for (const item of [
      event(1980, { type: 'yuqi/team-created', title: 'Legacy settled outcome', objective: 'Recover a cancelled task' }),
      event(1981, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(1982, { type: 'yuqi/task-created', contract: { ...contract(), authorityMode: 'read-only' } }),
      event(1983, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId, project: { mode: 'direct', projectRoot: cwd, volumeRoot: path.parse(cwd).root, protectedRoots: [] } as never,
        worktreePath: cwd, branchName: 'direct', status: 'provisioning',
      } }),
      event(1984, { type: 'yuqi/workspace-provisioned', workspaceId }),
      event(1985, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'pending', to: 'ready' }),
      event(1986, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'ready', to: 'running' }),
      event(1987, { type: 'yuqi/attempt-created', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
      event(1988, { type: 'yuqi/attempt-admitted', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), agentSessionId: 'session-worker-1', messageId: 'legacy-message' }),
      event(1989, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'dispatching', to: 'running' }),
      event(1990, { type: 'yuqi/attempt-status-changed', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), from: 'running', to: 'cancelled' }),
      event(1991, { type: 'yuqi/attempt-evidence-recorded', taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'), runId: 'legacy-cancelled-run', agentSessionId: 'session-worker-1', provider: 'in-process', stopReason: 'aborted', hasAssistantOutput: false, settledAt: '2026-08-15T15:55:00Z' }),
      event(1992, { type: 'yuqi/task-status-changed', taskId: TaskId('task-1'), from: 'running', to: 'cancelled' }),
      event(1993, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'legacy no-progress classification' }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    const recovered = await ctx.yuqiTeamOrchestrator.recoverAndContinueTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'legacy-outcome-recovery',
    })
    expect(recovered.team.status).toBe('paused')
    expect(recovered.tasks['task-1']?.status).toBe('cancelled')
    await fiber.dispose()
  })

  it('awaits an exact stale recovery target, converges concurrent clicks to paused, and never dispatches', async () => {
    const ctx = new Context()
    const cwd = process.cwd()
    const controllerId = SessionId('yuqi-team-targeted-stale-recovery')
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
    const harness = fakeController(controllerSession, ctx, 'workspace-write')
    const parent = Session.create(SessionId('parent-targeted-stale-recovery'))
    harness.registerSession(parent)
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parent.id), generation: 1, operationId: 'bind-targeted-recovery', boundAt: '2026-09-13T00:00:00Z',
    })
    const workspaceId = WorkspaceId('workspace-targeted-stale-recovery')
    const facts = [
      ...completeTeamEvents().slice(0, 16),
      event(9460, { type: 'yuqi/workspace-provisioning-started', workspace: {
        workspaceId,
        project: { mode: 'direct', projectRoot: cwd, volumeRoot: path.parse(cwd).root, protectedRoots: [] } as never,
        worktreePath: cwd, branchName: 'direct', status: 'provisioning',
      } }),
      event(9461, { type: 'yuqi/workspace-provisioned', workspaceId }),
      event(9462, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'legacy no-progress classification' }),
    ]
    for (const fact of facts) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), bindingGeneration: 1, activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: facts.length, events: facts,
    })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      recoverColdTarget(teamId: string, controllerSessionId: string, signal: AbortSignal): Promise<void>
      scheduleColdRecovery(session: Session, allowControllerResume?: boolean): void
      scheduleParentReportDelivery(controllerSessionId: string): void
      controllerAgents: { get(id: SessionId): Agent | undefined }
      parentReportSuppressions: Map<string, unknown>
    }
    const parentSend = vi.fn()
    const parentAgent = { id: parent.id, session: parent, status: 'idle', send: parentSend } as unknown as Agent
    service.controllerAgents = {
      get: id => String(id) === String(controllerId) ? harness.agent
        : String(id) === String(parent.id) ? parentAgent : undefined,
    }
    const delivery = vi.spyOn(service, 'scheduleParentReportDelivery')
    service.scheduleParentReportDelivery(String(controllerId))

    vi.spyOn(ctx.subagents, 'listChildren').mockResolvedValueOnce([{
      kind: 'child', id: SessionId('foreign-live-child'), mode: 'continuable',
      activity: 'running', hasChildren: false, label: 'foreign-live-child',
    }])
    await expect(service.recoverColdTarget('team-1', String(controllerId), new AbortController().signal))
      .rejects.toMatchObject({ code: 'RECONCILIATION_NOT_ALLOWED' })
    expect(replayTeamEvents(new HarnessSessionJournal(controllerSession, ctx.sessions).read()).team.status).toBe('needs_reconciliation')

    await Promise.all([
      service.recoverColdTarget('team-1', String(controllerId), new AbortController().signal),
      service.recoverColdTarget('team-1', String(controllerId), new AbortController().signal),
    ])
    const recovered = replayTeamEvents(new HarnessSessionJournal(controllerSession, ctx.sessions).read())
    expect(recovered.team.status).toBe('paused')
    expect(Object.values(recovered.recoveryClearOperations).filter(operation => operation.id.startsWith('target-recover:'))).toHaveLength(1)
    expect(Object.values(recovered.attempts)).toHaveLength(1)
    expect(harness.starts).toHaveLength(0)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(delivery).toHaveBeenCalledTimes(1)
    expect(parentSend).not.toHaveBeenCalled()
    expect(controllerSession.events.filter(item => item.type === TEAM_PARENT_REPORT_CHECKPOINT_EVENT)).toHaveLength(0)
    // Simulate a Host restart losing the in-memory cut fence. The durable
    // target-recovery operation itself must still keep this passive view cut
    // from waking the parent.
    service.parentReportSuppressions.clear()
    service.scheduleParentReportDelivery(String(controllerId))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(parentSend).not.toHaveBeenCalled()
    expect(controllerSession.events.filter(item => item.type === TEAM_PARENT_REPORT_CHECKPOINT_EVENT)).toHaveLength(0)

    const eventCount = readTeamEventsFromSession(controllerSession).length
    await service.recoverColdTarget('team-1', String(controllerId), new AbortController().signal)
    expect(readTeamEventsFromSession(controllerSession)).toHaveLength(eventCount)
    expect(delivery).toHaveBeenCalledTimes(2)
    expect(parentSend).not.toHaveBeenCalled()

    for (const fact of [
      event(9463, { type: 'yuqi/team-control-requested', operationId: ControlOperationId('post-recovery-terminal'), action: 'cancel' }),
      event(9464, { type: 'yuqi/team-status-changed', from: 'paused', to: 'cancelling' }),
      event(9465, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    service.scheduleParentReportDelivery(String(controllerId))
    await vi.waitFor(() => { expect(parentSend).toHaveBeenCalledOnce() })
    expect(controllerSession.events.filter(item => item.type === TEAM_PARENT_REPORT_CHECKPOINT_EVENT)).toHaveLength(1)

    const runningId = SessionId('yuqi-team-targeted-running-recovery')
    const running = Session.create(runningId)
    const runningParent = Session.create(SessionId('parent-targeted-running-recovery'))
    harness.registerSession(running)
    harness.registerSession(runningParent)
    running.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(runningParent.id), generation: 1, operationId: 'bind-targeted-running', boundAt: '2026-09-13T00:00:01Z',
    })
    const runningFacts = completeTeamEvents().slice(0, 8)
    for (const fact of runningFacts) running.append(TEAM_SESSION_EVENT, { event: fact })
    runningParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(runningId), bindingGeneration: 1, activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: runningFacts.length, events: runningFacts,
    })
    const coldScan = vi.spyOn(service, 'scheduleColdRecovery').mockImplementation(() => undefined)
    await service.recoverColdTarget('team-1', String(runningId), new AbortController().signal)
    expect(coldScan).toHaveBeenCalledWith(running, false)
    expect(readTeamEventsFromSession(running)).toHaveLength(runningFacts.length)
    await fiber.dispose()
  })

  it('resolves a cold recovery parent from the live Agent registry when the Session store omits that parent', async () => {
    const ctx = new Context()
    const controllerId = SessionId('yuqi-team-parent-registry-only')
    const controllerSession = Session.create(controllerId)
    const harness = fakeController(controllerSession, ctx)
    const parent = Session.create(SessionId('parent-registry-only'))
    const facts = completeTeamEvents()
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(parent.id), generation: 1, operationId: 'bind-parent-registry-only', boundAt: '2026-09-13T00:00:00Z',
    })
    for (const fact of facts) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: String(controllerId), bindingGeneration: 1, activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: facts.length, events: facts,
    })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      resolveColdTargetParent(teamId: string, controllerSessionId: string, signal: AbortSignal): Promise<string>
      controllerAgents: { get(id: SessionId): Agent | undefined }
    }
    const parentAgent = { id: parent.id, session: parent, status: 'idle', send: vi.fn() } as unknown as Agent
    service.controllerAgents = {
      get: id => String(id) === String(controllerId) ? harness.agent
        : String(id) === String(parent.id) ? parentAgent : undefined,
    }

    await expect(service.resolveColdTargetParent('team-1', String(controllerId), new AbortController().signal))
      .resolves.toBe(String(parent.id))
    await fiber.dispose()
  })

  it('recovers dormant running Teams by waking runnable work or exposing an unrunnable graph', async () => {
    const stalledContext = new Context()
    const stalledHarness = fakeController(Session.create(SessionId('yuqi-team-dormant-stalled')), stalledContext)
    for (const item of completeTeamEvents().slice(0, 2)) stalledHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const stalledFiber = await stalledContext.plugin(YuqiTeamOrchestratorService)
    const stalledService = stalledContext.yuqiTeamOrchestrator as unknown as {
      recoverDormantRunningTeam(controller: Agent, journal: HarnessSessionJournal, teamId: string): Promise<void>
      recoverDormantProjection(request: { controllerSessionId: string; teamId: string }): Promise<ReturnType<typeof replayTeamEvents> | undefined>
      markBackgroundRunnerFailure(journal: HarnessSessionJournal, teamId: string, action: string, cause: unknown): Promise<void>
      recoverColdControllerState(controller: Agent): void
    }
    const stalledJournal = new HarnessSessionJournal(stalledHarness.agent.session, stalledContext.sessions)
    expect((await stalledService.recoverDormantProjection({
      controllerSessionId: String(stalledHarness.agent.id), teamId: 'team-1',
    }))?.team.status).toBe('needs_reconciliation')
    expect((await stalledService.recoverDormantProjection({
      controllerSessionId: String(stalledHarness.agent.id), teamId: 'team-1',
    }))?.team.status).toBe('needs_reconciliation')
    await expect(stalledService.recoverDormantProjection({ controllerSessionId: 'missing-controller', teamId: 'team-1' }))
      .resolves.toBeUndefined()
    delete (stalledContext.sessionPersistence as unknown as { load?: unknown }).load
    await expect(stalledService.recoverDormantProjection({ controllerSessionId: 'missing-without-loader', teamId: 'team-1' }))
      .resolves.toBeUndefined()
    expect(replayTeamEvents(stalledJournal.read()).team.status).toBe('needs_reconciliation')
    await stalledService.recoverDormantRunningTeam(stalledHarness.agent, stalledJournal, 'team-1')
    await stalledService.markBackgroundRunnerFailure(stalledJournal, 'team-1', 'replayed failure', new Error('ignored'))
    stalledService.recoverColdControllerState(fakeController(Session.create(SessionId('not-a-team-session'))).agent)
    const completedSession = Session.create(SessionId('not-a-team-completed'))
    for (const item of completeTeamEvents()) completedSession.append(TEAM_SESSION_EVENT, { event: item })
    stalledService.recoverColdControllerState(fakeController(completedSession).agent)
    const activeSession = Session.create(SessionId('not-a-team-active'))
    for (const item of completeTeamEvents().slice(0, 8)) activeSession.append(TEAM_SESSION_EVENT, { event: item })
    stalledService.recoverColdControllerState(fakeController(activeSession).agent)
    const dormantSession = Session.create(SessionId('yuqi-team-direct-cold-recovery'))
    for (const item of completeTeamEvents().slice(0, 4)) dormantSession.append(TEAM_SESSION_EVENT, { event: item })
    const dormantHarness = fakeController(dormantSession)
    const coldRecovery = vi.spyOn(stalledService, 'recoverDormantRunningTeam').mockResolvedValue(undefined)
    stalledService.recoverColdControllerState(dormantHarness.agent)
    expect(coldRecovery).toHaveBeenCalledWith(dormantHarness.agent, expect.any(HarnessSessionJournal), 'team-1')
    await stalledFiber.dispose()

    const runnableContext = new Context()
    const runnableHarness = fakeController(Session.create(SessionId('yuqi-team-dormant-runnable')), runnableContext)
    for (const item of completeTeamEvents().slice(0, 4)) runnableHarness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const runnableFiber = await runnableContext.plugin(YuqiTeamOrchestratorService)
    const dispose = vi.fn(async () => {})
    const runnableService = runnableContext.yuqiTeamOrchestrator as unknown as {
      recoveredControllers: Map<string, AgentHandle>
      recoverDormantRunningTeam(controller: Agent, journal: HarnessSessionJournal, teamId: string): Promise<void>
    }
    runnableService.recoveredControllers.set(String(runnableHarness.agent.id), { agent: runnableHarness.agent, dispose })
    const runnableJournal = new HarnessSessionJournal(runnableHarness.agent.session, runnableContext.sessions)
    await runnableService.recoverDormantRunningTeam(runnableHarness.agent, runnableJournal, 'team-1')
    await runnableService.recoverDormantRunningTeam(runnableHarness.agent, runnableJournal, 'team-1')
    await vi.waitFor(() => expect(replayTeamEvents(runnableJournal.read()).team.status).toBe('needs_reconciliation'))
    await runnableFiber.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('repairs a persisted cancelled Team that still has a schedulable task', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('yuqi-team-cancelled-task-repair'))
    for (const item of [
      ...completeTeamEvents().slice(0, 4),
      event(1986, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(1987, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]) session.append(TEAM_SESSION_EVENT, { event: item })
    const sessions = new Map([[String(session.id), session]])
    ctx.provide('sessions', {
      list: () => [...sessions.values()],
      get: (id: SessionId) => sessions.get(String(id)),
      flush: async () => true,
    } as never)
    fakeController(session, ctx)

    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await vi.waitFor(() => {
      const projection = replayTeamEvents(new HarnessSessionJournal(session, ctx.sessions).read())
      expect(projection.team.status).toBe('cancelled')
      expect(projection.tasks['task-1']?.status).toBe('cancelled')
    })
    await fiber.dispose()
  })

  it('discovers hidden controllers from parent bridges only when recovery or terminal repair is required', async () => {
    const ctx = new Context()
    fakeController(Session.create(SessionId('bridge-scan-host')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      scanColdRecoverySession(session: Session): void
      scheduleColdRecoveryDiscovery(controllerSessionId: string): void
    }
    const discover = vi.spyOn(service, 'scheduleColdRecoveryDiscovery').mockImplementation(() => undefined)

    service.scanColdRecoverySession(Session.create(SessionId('bridge-none')))
    const cancelledReady = [
      ...completeTeamEvents().slice(0, 4),
      event(1988, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
      event(1989, { type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled' }),
    ]
    const repairParent = Session.create(SessionId('bridge-repair-parent'))
    repairParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-repair', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: cancelledReady.length, events: cancelledReady,
    })
    service.scanColdRecoverySession(repairParent)

    const activeParent = Session.create(SessionId('bridge-active-parent'))
    const active = completeTeamEvents().slice(0, 8)
    activeParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-active', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: active.length, events: active,
    })
    service.scanColdRecoverySession(activeParent)

    const pausedParent = Session.create(SessionId('bridge-paused-parent'))
    const paused = [
      ...completeTeamEvents().slice(0, 4),
      event(1992, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
      event(1993, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
    ]
    pausedParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-paused', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: paused.length, events: paused,
    })
    service.scanColdRecoverySession(pausedParent)

    const pausingActiveParent = Session.create(SessionId('bridge-pausing-active-parent'))
    const pausingActive = [
      ...completeTeamEvents().slice(0, 8),
      event(1994, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    ]
    pausingActiveParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-pausing-active', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: pausingActive.length, events: pausingActive,
    })
    service.scanColdRecoverySession(pausingActiveParent)

    const cancellingActiveParent = Session.create(SessionId('bridge-cancelling-active-parent'))
    const cancellingActive = [
      ...completeTeamEvents().slice(0, 8),
      event(1995, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }),
    ]
    cancellingActiveParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-cancelling-active', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: cancellingActive.length, events: cancellingActive,
    })
    service.scanColdRecoverySession(cancellingActiveParent)

    const invalidParent = Session.create(SessionId('bridge-invalid-parent'))
    invalidParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-invalid', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: 0, events: [],
    })
    service.scanColdRecoverySession(invalidParent)

    const dormantParent = Session.create(SessionId('bridge-dormant-parent'))
    const dormant = completeTeamEvents().slice(0, 4)
    dormantParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-dormant', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: dormant.length, events: dormant,
    })
    service.scanColdRecoverySession(dormantParent)

    const terminalParent = Session.create(SessionId('bridge-terminal-parent'))
    terminalParent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'yuqi-team-hidden-terminal', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    })
    service.scanColdRecoverySession(terminalParent)

    expect(discover.mock.calls.map(call => call[0])).toEqual([
      'yuqi-team-hidden-repair', 'yuqi-team-hidden-active', 'yuqi-team-hidden-pausing-active',
      'yuqi-team-hidden-cancelling-active', 'yuqi-team-hidden-dormant',
    ])
    await fiber.dispose()
  })

  it('deduplicates hidden-controller recovery discovery and clears failed lookups', async () => {
    const ctx = new Context()
    const durableSessions = new Map<string, { meta: Session['header']; events: Session['events'] }>()
    ctx.provide('sessionPersistence', {
      async load(id: SessionId) { return durableSessions.get(String(id)) },
      async list() { return [...durableSessions.values()].map(item => item.meta) },
      async create(meta: Session['header']) { durableSessions.set(String(meta.id), { meta, events: [] }) },
      async append(id: SessionId, events: Session['events']) {
        const current = durableSessions.get(String(id))!
        durableSessions.set(String(id), { ...current, events: [...current.events, ...events] })
      },
      async readFrom(id: SessionId, fromSeq: number) {
        return { events: durableSessions.get(String(id))?.events.slice(fromSeq) ?? [] }
      },
    } as never)
    const harness = fakeController(Session.create(SessionId('bridge-discovery-host')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      coldRecoveryScans: Set<string>
      coldRecoveryDiscoveries: Set<string>
      resolveTeamController(controllerSessionId: string): Promise<Agent | undefined>
      recoverDormantProjection(request: { controllerSessionId: string; teamId: string }): Promise<ReturnType<typeof replayTeamEvents> | undefined>
      scheduleColdRecovery(session: Session): void
      scheduleColdRecoveryDiscovery(controllerSessionId: string): void
    }
    const resolve = vi.spyOn(service, 'resolveTeamController')
    const schedule = vi.spyOn(service, 'scheduleColdRecovery').mockImplementation(() => undefined)

    service.coldRecoveryScans.add('yuqi-team-already-scanned')
    service.scheduleColdRecoveryDiscovery('yuqi-team-already-scanned')
    expect(resolve).not.toHaveBeenCalled()

    resolve.mockResolvedValueOnce(undefined)
    service.scheduleColdRecoveryDiscovery('yuqi-team-missing')
    service.scheduleColdRecoveryDiscovery('yuqi-team-missing')
    await vi.waitFor(() => expect(service.coldRecoveryDiscoveries.has('yuqi-team-missing')).toBe(false))
    expect(resolve).toHaveBeenCalledTimes(1)

    const activePersisted = Session.create(SessionId('yuqi-team-active-no-resume'))
    for (const item of completeTeamEvents().slice(0, 8)) activePersisted.append(TEAM_SESSION_EVENT, { event: item })
    durableSessions.set(String(activePersisted.id), { meta: activePersisted.header, events: activePersisted.events })
    const resolveCallsBeforeActive = resolve.mock.calls.length
    service.scheduleColdRecoveryDiscovery(String(activePersisted.id))
    await vi.waitFor(() => expect(service.coldRecoveryDiscoveries.has(String(activePersisted.id))).toBe(false))
    expect(resolve).toHaveBeenCalledTimes(resolveCallsBeforeActive)
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ id: activePersisted.id }), false)

    const legacyDormant = Session.create(SessionId('yuqi-team-legacy-dormant'))
    for (const item of completeTeamEvents().slice(0, 4)) legacyDormant.append(TEAM_SESSION_EVENT, { event: item })
    harness.registerSession(legacyDormant)
    resolve.mockResolvedValueOnce(undefined)
    service.scheduleColdRecoveryDiscovery(String(legacyDormant.id))
    await vi.waitFor(() => {
      const projection = replayTeamEvents(new HarnessSessionJournal(legacyDormant, ctx.sessions).read())
      expect(projection.team.status).toBe('needs_reconciliation')
    })

    const persistedDormant = Session.create(SessionId('yuqi-team-persisted-dormant'))
    for (const item of completeTeamEvents().slice(0, 4)) persistedDormant.append(TEAM_SESSION_EVENT, { event: item })
    durableSessions.set(String(persistedDormant.id), { meta: persistedDormant.header, events: persistedDormant.events })
    resolve.mockResolvedValueOnce(undefined)
    service.scheduleColdRecoveryDiscovery(String(persistedDormant.id))
    await vi.waitFor(() => {
      const stored = durableSessions.get(String(persistedDormant.id))!
      const hydrated = Session.create(persistedDormant.id, [...stored.events], stored.meta)
      expect(replayTeamEvents(readTeamEventsFromSession(hydrated)).team.status).toBe('needs_reconciliation')
    })
    expect((await service.recoverDormantProjection({
      controllerSessionId: String(persistedDormant.id), teamId: 'team-1',
    }))?.team.status).toBe('needs_reconciliation')

    const legacyInvalid = Session.create(SessionId('yuqi-team-legacy-invalid'))
    harness.registerSession(legacyInvalid)
    resolve.mockResolvedValueOnce(undefined)
    service.scheduleColdRecoveryDiscovery(String(legacyInvalid.id))
    await vi.waitFor(() => expect(service.coldRecoveryDiscoveries.has(String(legacyInvalid.id))).toBe(false))

    resolve.mockResolvedValueOnce(harness.agent)
    service.scheduleColdRecoveryDiscovery('yuqi-team-found')
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(harness.agent.session))

    resolve.mockRejectedValueOnce(new Error('lookup failed'))
    service.scheduleColdRecoveryDiscovery('yuqi-team-failed')
    await vi.waitFor(() => expect(service.coldRecoveryDiscoveries.has('yuqi-team-failed')).toBe(false))
    expect(resolve).toHaveBeenCalledTimes(6)
    await fiber.dispose()
  })

  it('resolves and clears a reconciled attempt through the service with a verified workspace', async () => {
    const fixture = await realGatedWorkspace('service-recovery-success')
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-service-recovery-success'), [], {
        version: 0, id: SessionId('controller-service-recovery-success'), createdAt: 0,
        cwd: fixture.workspace.worktreePath,
      }), ctx, 'workspace-write')
      const dependentTaskIds = [TaskId('service-recovery-dependent-1'), TaskId('service-recovery-dependent-2')]
      for (const item of [
        ...completeTeamEvents().slice(0, 3),
        event(986, { type: 'yuqi/task-created', contract: contract(dependentTaskIds[0]!, 1, [TaskId('task-1')]) }),
        event(987, { type: 'yuqi/task-created', contract: contract(dependentTaskIds[1]!, 1, [TaskId('task-1')]) }),
        ...completeTeamEvents().slice(3, 8),
        event(990, { type: 'yuqi/workspace-provisioning-started', workspace: { ...fixture.workspace, status: 'provisioning' } }),
        event(991, { type: 'yuqi/workspace-provisioned', workspaceId: fixture.workspace.workspaceId }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const reconciled = await ctx.yuqiTeamOrchestrator.reconcileTeam({ controller: harness.agent, teamId: 'team-1', operationId: 'service-recovery-scan' })
      expect(reconciled.team.status).toBe('needs_reconciliation')
      const resolved = await ctx.yuqiTeamOrchestrator.resolveAttempt({
        controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
        operationId: 'service-recovery-resolution', observationOperationId: 'service-recovery-scan', decision: 'failed',
      })
      expect(resolved.attempts['attempt-1']?.status).toBe('failed')
      await ctx.yuqiTeamOrchestrator.runTeam({
        controller: harness.agent, teamId: 'team-1', maxConcurrency: 1,
        disposeController: vi.fn(async () => {}),
      })
      const recoveryJournal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
      const beforeClear = recoveryJournal.read().length
      await expect(ctx.yuqiTeamOrchestrator.clearTeamRecovery({
        controller: harness.agent, teamId: 'team-1', operationId: 'service-recovery-clear', target: 'running',
      })).rejects.toMatchObject({ code: 'CONTROL_NOT_ALLOWED' })
      expect(recoveryJournal.read()).toHaveLength(beforeClear)
      const afterRejectedClear = replayTeamEvents(recoveryJournal.read())
      expect(afterRejectedClear.team.status).toBe('needs_reconciliation')
      expect(dependentTaskIds.map(taskId => afterRejectedClear.tasks[taskId]?.status)).toEqual(['pending', 'pending'])
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('routes workspace-only reconciliation through the Host recovery gate instead of unresolved-attempt reconciliation', async () => {
    const fixture = await realGatedWorkspace('workspace-only-recovery')
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-workspace-only-recovery'), [], {
        version: 0, id: SessionId('controller-workspace-only-recovery'), createdAt: 0,
        cwd: fixture.workspace.worktreePath,
      }), ctx, 'workspace-write')
      for (const item of [
        ...completeTeamEvents().slice(0, 16),
        event(980, { type: 'yuqi/workspace-provisioning-started', workspace: { ...fixture.workspace, status: 'provisioning' } }),
        event(981, { type: 'yuqi/workspace-provisioned', workspaceId: fixture.workspace.workspaceId }),
        event(982, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'Workspace scope could not be proven' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

      const recovered = await ctx.yuqiTeamOrchestrator.reconcileTeam({
        controller: harness.agent, teamId: 'team-1', operationId: 'workspace-only-recover',
      })
      expect(recovered.team.status).toBe('paused')
      expect(recovered.recoveryClearOperations['workspace-only-recover']).toMatchObject({ target: 'paused' })
      expect(recovered.reconciliationOperations['workspace-only-recover']).toBeUndefined()
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('clears a controller-less quiescent journal to paused without invoking Host verification', async () => {
    const ctx = new Context()
    const controllerSession = Session.create(SessionId('controller-durable-clear'))
    const harness = fakeController(controllerSession, ctx, 'workspace-write')
    const parentSessionId = 'parent-durable-clear'
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId, generation: 1, operationId: 'bind-durable-clear', boundAt: '2026-08-30T00:00:00Z',
    })
    const workspace = {
      workspaceId: WorkspaceId('workspace-durable-clear'),
      project: {
        projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: 'F:\\managed\\durable-clear', branchName: 'yuqi/durable-clear', status: 'provisioning' as const,
    }
    for (const item of [
      ...completeTeamEvents().slice(0, 16),
      event(983, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(984, { type: 'yuqi/workspace-provisioned', workspaceId: workspace.workspaceId }),
      event(985, { type: 'yuqi/team-status-changed', from: 'running', to: 'needs_reconciliation', reason: 'controller unavailable' }),
    ]) controllerSession.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    const recovered = await ctx.yuqiTeamOrchestrator.controlDormantTeam({
      controllerSessionId: String(harness.agent.id), parentSessionId, teamId: 'team-1',
      operationId: 'durable-clear', action: 'reconcile',
    })
    expect(recovered?.team.status).toBe('paused')
    expect(recovered?.recoveryClearOperations['durable-clear']).toMatchObject({ basis: 'durable-journal', target: 'paused' })
    await expect(ctx.yuqiTeamOrchestrator.controlDormantTeam({
      controllerSessionId: String(harness.agent.id), parentSessionId: 'wrong-parent', teamId: 'team-1',
      operationId: 'wrong-parent-clear', action: 'reconcile',
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await fiber.dispose()
  })

  it('uses the public Harness LLM directory for advisory lists and exact fixed routes', async () => {
    const harness = fakeController()
    const catalog = new HarnessModelCatalogPort(harness.host)
    await expect(catalog.listModels('deepseek')).resolves.toEqual([
      { modelProvider: 'deepseek', modelId: 'deepseek-v4', available: true, displayName: 'DeepSeek V4' },
    ])
    await expect(catalog.resolveModel('private-gateway', 'unlisted-but-resolvable')).resolves.toEqual({
      modelProvider: 'private-gateway', modelId: 'unlisted-but-resolvable', available: true,
      displayName: 'private-gateway/unlisted-but-resolvable',
    })
    const aborted = new AbortController(); aborted.abort(new Error('cancelled'))
    await expect(catalog.listModels('deepseek', aborted.signal)).rejects.toThrow('cancelled')
  })

  it('resolves fixed models through the Cordis service without treating advisory lists as a whitelist', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-model')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    await expect(ctx.yuqiTeamOrchestrator.resolveFixedModel({
      role: 'worker',
      policy: {
        task: { subagentProvider: 'default', modelProvider: 'private-gateway', modelId: 'unlisted-but-resolvable', role: 'worker' },
        harnessDefault: { subagentProvider: 'default', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
      },
    })).resolves.toMatchObject({ modelProvider: 'private-gateway', modelId: 'unlisted-but-resolvable' })
    expect(harness.starts).toHaveLength(0)
    await fiber.dispose()
  })

  it('provisions and durably reuses a real Team worktree through the Cordis service', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-service-workspace-'))
    try {
      const repository = path.join(root, 'repository')
      await mkdir(repository)
      const git = async (...args: string[]) => (await run('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim()
      await git('init')
      await git('config', 'user.name', 'Yuqi Test')
      await git('config', 'user.email', 'yuqi@example.invalid')
      await writeFile(path.join(repository, 'README.md'), '# service workspace\n', 'utf8')
      await git('add', 'README.md')
      await git('commit', '-m', 'initial')
      const identity = await new NodeGitWorkspacePort().inspect({ projectRoot: repository, protectedRoots: [] })

      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-workspace-service')), ctx)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      for (const item of [
        event(880, { type: 'yuqi/team-created', title: 'Workspace service', objective: 'Create a real worktree' }),
        event(881, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const managedRoot = path.join(root, 'managed')
      const worktreePath = path.join(managedRoot, 'team')
      const request = {
        controller: harness.agent,
        teamId: 'team-1',
        workspaceId: 'workspace-service',
        identity,
        managedRoot,
        worktreePath,
        branchName: 'yuqi/service-workspace',
      }
      const created = await ctx.yuqiTeamOrchestrator.provisionWorkspace({ ...request, signal: new AbortController().signal })
      await expect(ctx.yuqiTeamOrchestrator.provisionWorkspace(request)).resolves.toEqual(created)
      expect(await git('-C', worktreePath, 'status', '--porcelain')).toBe('')
      const projection = replayTeamEvents(new HarnessSessionJournal(harness.agent.session, ctx.sessions).read())
      expect(projection.workspace).toMatchObject({ workspaceId: 'workspace-service', status: 'ready' })
      await fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('composes public startTeam through physical workspace, controller setup, bootstrap, and durable confirmation', async () => {
    const fixture = await realGatedWorkspace('start-team-public')
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-start-team-public')), ctx, 'read-only', { agentsRegistry: 'custom' })
      const controllerFactory = installStartTeamControllerFactory(ctx, harness)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

      const started = await ctx.yuqiTeamOrchestrator.startTeam({
        title: 'Public start Team',
        objective: 'Prove the Host composition boundary',
        tasks: [{ ...contract(TaskId('start-team-task')), verificationChecks: [{
          checkId: 'build', kind: 'build', commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
          stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
        }] }],
        projectCwd: fixture.workspace.project.projectRoot,
        managedRoot: path.join(fixture.root, 'start-managed'),
        workspaceMode: 'git-worktree',
        controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback' },
      })

      expect(started.sessionId).toBe(String(controllerFactory.creates[0]?.sessionId))
      expect(controllerFactory.creates[0]).toMatchObject({
        meta: { cwd: started.workspace.worktreePath, agentPreset: 'standard' },
        agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
      })
      expect(controllerFactory.mountedPresetIds).toEqual(['standard'])
      expect(started.bootstrap.team.status).toBe('running')
      const projection = replayTeamEvents(new HarnessSessionJournal(started.controller.session, ctx.sessions).read())
      expect(projection.team).toMatchObject({
        id: started.teamId,
        status: 'running',
        controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: 'inspect migrations and rollback' },
      })
      expect(projection.tasks['start-team-task']?.status).toBe('pending')
      expect(projection.workspace).toMatchObject({ workspaceId: String(started.workspace.workspaceId), status: 'ready' })
      expect(started.workspace.worktreePath).not.toBe(fixture.workspace.project.projectRoot)
      expect(started.workspace.branchName).toMatch(/^yuqi\//u)
      expect(started.workspace.project).not.toHaveProperty('mode', 'direct')
      expect(controllerFactory.disposeCount()).toBe(0)
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('rejects an invalid task graph before launching a controller', async () => {
    const fixture = await realGatedWorkspace('start-team-dispose')
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-start-team-dispose')), ctx, 'read-only', { agentsRegistry: 'custom' })
      const controllerFactory = installStartTeamControllerFactory(ctx, harness)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

      await expect(ctx.yuqiTeamOrchestrator.startTeam({
        title: 'Public start disposal',
        objective: 'Dispose a launched controller on durable bootstrap failure',
        tasks: [contract(TaskId('duplicate-task')), contract(TaskId('duplicate-task'))].map(item => ({
          ...item,
          verificationChecks: [{
            checkId: 'build', kind: 'build' as const, commandRef: 'pnpm-typecheck', timeoutMs: 120_000,
            stdoutMaxBytes: 64_000, stderrMaxBytes: 64_000,
          }],
        })),
        projectCwd: fixture.workspace.project.projectRoot,
        managedRoot: path.join(fixture.root, 'dispose-managed'),
        controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
      })).rejects.toMatchObject({ code: 'INVALID_BATCH' })

      expect(controllerFactory.creates).toHaveLength(0)
      expect(controllerFactory.mountedPresetIds).toEqual([])
      expect(controllerFactory.disposeCount()).toBe(0)
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 30_000)

  it('stores only durably committed Team events in the controller Session journal', async () => {
    const session = Session.create(SessionId('journal-controller'))
    session.append('todo/write', { todos: [] })
    const flushes: Session[] = []
    const journal = new HarnessSessionJournal(session, { flush: async current => { flushes.push(current); return true } })
    await journal.commit([completeTeamEvents()[0]!])

    expect(journal.key).toBe('journal-controller')
    expect(journal.read()).toEqual([completeTeamEvents()[0]])
    expect(session.events.at(-1)).toMatchObject({ type: TEAM_SESSION_EVENT, data: { event: completeTeamEvents()[0] } })
    expect(flushes).toEqual([session])
  })

  it('rejects a commit when no durability listener participates or flush fails', async () => {
    const noListenerSession = Session.create(SessionId('journal-no-listener'))
    const noListener = new HarnessSessionJournal(noListenerSession, { flush: async () => false })
    await expect(noListener.commit([completeTeamEvents()[0]!])).rejects.toThrow('no durability listener')

    const failedSession = Session.create(SessionId('journal-flush-failed'))
    const failed = new HarnessSessionJournal(failedSession, { flush: async () => { throw new Error('disk full') } })
    await expect(failed.commit([completeTeamEvents()[0]!])).rejects.toThrow('disk full')
  })

  it('uses public persistence when a scoped preset session has no flush listener', async () => {
    const session = Session.create(SessionId('journal-direct-persistence'))
    const stored: SessionEvent[] = []
    let created = false
    const persistence = {
      create: async () => { created = true },
      list: async () => created ? [session.header] : [],
      readFrom: async () => {
        if (!created) throw new Error('not materialized')
        return { events: [...stored] }
      },
      append: async (_id: typeof session.id, events: readonly SessionEvent[]) => { stored.push(...events) },
    }
    const journal = new HarnessSessionJournal(session, { flush: async () => false }, persistence)

    await journal.commit([completeTeamEvents()[0]!])

    expect(created).toBe(true)
    expect(stored).toEqual(session.events)
    expect(journal.read()).toEqual([completeTeamEvents()[0]])

    await journal.commit([completeTeamEvents()[1]!])
    expect(journal.read()).toEqual(completeTeamEvents().slice(0, 2))
    expect(stored).toEqual(session.events)
  })

  it('rejects persistence histories that cannot prove the live Session prefix or tail', async () => {
    const prefixSession = Session.create(SessionId('journal-persistence-prefix-mismatch'))
    prefixSession.append('todo/write', { todos: [] })
    const prefixPersistence = {
      create: async () => undefined,
      list: async () => [prefixSession.header],
      readFrom: async () => ({ events: [{ ...prefixSession.events[0]!, type: 'corrupt/event' } as never] }),
      append: async () => undefined,
    }
    const prefixJournal = new HarnessSessionJournal(prefixSession, { flush: async () => false }, prefixPersistence)
    await expect(prefixJournal.commit([completeTeamEvents()[0]!])).rejects.toThrow('history does not match')

    const tailSession = Session.create(SessionId('journal-persistence-tail-mismatch'))
    const tailPersistence = {
      create: async () => undefined,
      list: async () => [tailSession.header],
      readFrom: async () => ({ events: [] as SessionEvent[] }),
      append: async () => undefined,
    }
    const tailJournal = new HarnessSessionJournal(tailSession, { flush: async () => false }, tailPersistence)
    await expect(tailJournal.commit([completeTeamEvents()[0]!])).rejects.toThrow('could not prove')
  })

  it('validates a Team batch as one Session append and leaves no partial reservation on append failure', async () => {
    const session = Session.create(SessionId('journal-atomic-batch'))
    const journal = new HarnessSessionJournal(session, { flush: async () => true })
    const valid = completeTeamEvents()[0]!
    const invalid = { ...valid, occurredAt: 1n } as unknown as typeof valid
    await expect(journal.commit([valid, invalid])).rejects.toThrow()
    expect(journal.read()).toEqual([])
    expect(session.events.filter(entry => entry.type === TEAM_SESSION_EVENT)).toHaveLength(0)
    const restarted = new HarnessSessionJournal(session, { flush: async () => true })
    expect(restarted.read()).toEqual([])
  })

  it('flushes an empty Team batch without appending a phantom event', async () => {
    const session = Session.create(SessionId('journal-empty-batch'))
    const journal = new HarnessSessionJournal(session, { flush: async () => true })
    await journal.commit([])
    expect(journal.read()).toEqual([])
    expect(session.events.filter(entry => entry.type === TEAM_SESSION_EVENT)).toHaveLength(0)
  })

  it('contains a public Session append failure as one failed batch across restart', async () => {
    const session = Session.create(SessionId('journal-append-failure'))
    const journal = new HarnessSessionJournal(session, { flush: async () => true })
    const append = vi.spyOn(session, 'append').mockImplementation((() => { throw new Error('append failed') }) as never)
    await expect(journal.commit(completeTeamEvents().slice(0, 4))).rejects.toThrow('append failed')
    expect(append).toHaveBeenCalledOnce()
    expect(session.events.filter(entry => entry.type === TEAM_SESSION_EVENT)).toHaveLength(0)
    append.mockRestore()
    expect(new HarnessSessionJournal(session, { flush: async () => true }).read()).toEqual([])
  })

  it('maps the public Harness continuable API and terminal event without copying output', async () => {
    const harness = fakeController()
    const port = new HarnessContinuableChildPort(harness.host, harness.agent, new NodeGitWorkspacePort())
    const ends: ChildEnd[] = []
    const dispose = port.onEnd(end => void ends.push(end))
    const signal = new AbortController().signal

    await expect(port.start({
      subagentProvider: 'in-process',
      label: 'yuqi:attempt-1:work',
      prompt: [{ type: 'text', text: 'work' }],
      modelProvider: 'deepseek',
      modelId: 'deepseek-v4',
      maxDepth: 1,
      signal,
    })).resolves.toEqual({ childSessionId: 'child-1', messageId: 'message-1' })
    expect(harness.starts[0]).toMatchObject({
      provider: 'in-process',
      label: 'yuqi:attempt-1:work',
      request: { agentOptions: { provider: 'deepseek', model: 'deepseek-v4' }, maxDepth: 1 },
      signal,
    })
    port.interrupt('child-1')
    expect(harness.interrupts).toEqual(['child-1'])

    const unrelated = { ...harness.agent, id: SessionId('unrelated') } as Agent
    harness.end({ runId: 'ignored' }, unrelated)
    harness.end({ lastAssistantMessage: [] })
    harness.end({ runId: 'run-2', lastAssistantMessage: [{ type: 'text', text: 'secret output stays in child Session' }] })
    await vi.waitFor(() => expect(ends).toHaveLength(3))
    expect(ends).toEqual([
      expect.objectContaining({ runId: 'ignored', hasAssistantOutput: false }),
      expect.objectContaining({ runId: 'run-1', hasAssistantOutput: false }),
      expect.objectContaining({ runId: 'run-2', hasAssistantOutput: true }),
    ])
    dispose()
    harness.end({ runId: 'disposed' })
    expect(ends).toHaveLength(3)
  })

  it('extracts only normalized repository-relative files from the child controller report', () => {
    expect(reportedChangedFilesFrom([{ type: 'text', text: '完成。\nYUQI_CHANGED_FILES: ["src/a.ts", "src\\b.ts", "../escape", "C:\\\\outside"]' }])).toEqual({
      reportedChangedFiles: ['src/a.ts', 'src/b.ts'],
    })
    expect(reportedChangedFilesFrom([{ type: 'text', text: 'YUQI_CHANGED_FILES: []' }])).toEqual({ reportedChangedFiles: [] })
    expect(reportedChangedFilesFrom([{ type: 'text', text: 'ordinary report' }])).toEqual({})
  })

  it('treats only trimmed assistant text as effective child output', () => {
    expect(hasEffectiveAssistantOutput(undefined)).toBe(false)
    expect(hasEffectiveAssistantOutput([])).toBe(false)
    expect(hasEffectiveAssistantOutput([{ type: 'reasoning', text: 'internal only' }, { type: 'text', text: '  \n\t' }])).toBe(false)
    expect(hasEffectiveAssistantOutput([{ type: 'text', text: '  final report  ' }])).toBe(true)
  })

  it('does not abort a healthy multi-step child at the former two-minute deadline and retains a bounded safety deadline', async () => {
    vi.useFakeTimers()
    try {
      const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const harness = fakeController()
      const port = new HarnessContinuableChildPort(harness.host, harness.agent, new NodeGitWorkspacePort())
      await port.start({
        subagentProvider: 'in-process', label: 'yuqi:timeout',
        prompt: [{ type: 'text', text: 'bounded work' }],
        modelProvider: 'deepseek', modelId: 'deepseek-v4', maxDepth: 1,
        signal: new AbortController().signal,
      })

      expect(harness.interrupts).toEqual([])
      expect(CHILD_EXECUTION_TIMEOUT_MS).toBe(30 * 60_000)
      const timeoutCall = timeoutSpy.mock.calls.find(call => call[1] === CHILD_EXECUTION_TIMEOUT_MS)
      expect(timeoutCall).toBeDefined()
      ;(timeoutCall![0] as () => void)()
      expect(harness.interrupts).toEqual(['child-1'])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['legacy', 'snapshot'] as const)('collects %s reported child usage without treating an absent report as zero', async capability => {
    const harness = fakeController()
    const child = Session.create(SessionId('child-1'))
    child.append('assistant/message', {
      turn: 0,
      step: 0,
      message: createMessage({
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 },
    }, { surfaceOp: 'append' })
    harness.registerSession(capability === 'snapshot' ? snapshotOnlySession(child) : child)
    const port = new HarnessContinuableChildPort(harness.host, harness.agent, new NodeGitWorkspacePort())
    const ends: ChildEnd[] = []
    port.onEnd(end => void ends.push(end))

    harness.end()
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]?.usage).toEqual({
      uncachedInputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    })

    harness.end({ id: SessionId('child-without-session'), runId: 'unknown-usage' })
    await vi.waitFor(() => expect(ends).toHaveLength(2))
    expect(ends[1]).not.toHaveProperty('usage')
  })

  it('reuses native assistant usage events for cumulative live updates', async () => {
    const harness = fakeController()
    const child = Session.create(SessionId('child-live-usage'))
    harness.registerSession(child)
    const port = new HarnessContinuableChildPort(harness.host, harness.agent, new NodeGitWorkspacePort())
    const observed: Array<{ childSessionId: string; usage: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } }> = []
    const ends: ChildEnd[] = []
    const dispose = port.onUsage(usage => void observed.push(usage))
    port.onEnd(end => void ends.push(end))

    const first = child.append('assistant/message', {
      turn: 0, step: 0,
      message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 },
    }, { surfaceOp: 'append' })
    harness.host.emit('session/event', child, first)
    await vi.waitFor(() => expect(observed).toHaveLength(1))
    expect(observed[0]).toEqual({
      childSessionId: 'child-live-usage',
      usage: { uncachedInputTokens: 11, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 },
    })

    const second = child.append('assistant/message', {
      turn: 0, step: 1,
      message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      usage: { inputTokens: 7, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    harness.host.emit('session/event', child, second)
    await vi.waitFor(() => expect(observed).toHaveLength(2))
    expect(observed[1]?.usage).toEqual({
      uncachedInputTokens: 18, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 2,
    })
    harness.end({ id: SessionId('child-live-usage'), runId: 'live-usage-end' })
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]?.usage).toEqual({
      uncachedInputTokens: 18, outputTokens: 5, cacheReadTokens: 5, cacheWriteTokens: 2,
    })
    dispose()
  })

  it('loads durable child usage after disposal and excludes copied seed usage', async () => {
    const child = Session.create(SessionId('child-1'))
    for (const [step, inputTokens] of [[0, 100], [1, 7]] as const) {
      child.append('assistant/message', {
        turn: 0,
        step,
        message: createMessage({ role: 'assistant', content: [], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
        usage: { inputTokens, outputTokens: step + 1 },
      }, { surfaceOp: 'append' })
    }
    const ctx = new Context()
    ctx.provide('sessionPersistence', {
      load: async () => ({ meta: { ...child.header, seedLength: 1 }, events: child.events }),
    } as never)
    const harness = fakeController(Session.create(SessionId('controller-persisted-usage')), ctx)
    const ends: ChildEnd[] = []
    new HarnessContinuableChildPort(ctx, harness.agent, new NodeGitWorkspacePort()).onEnd(end => void ends.push(end))

    harness.end()
    await vi.waitFor(() => expect(ends).toHaveLength(1))
    expect(ends[0]?.usage).toEqual({ uncachedInputTokens: 7, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('keeps settlement observable when durable usage loading fails or times out', async () => {
    const failed = new Context()
    failed.provide('sessionPersistence', { load: async () => { throw new Error('offline') } } as never)
    const failedHarness = fakeController(Session.create(SessionId('controller-failed-usage')), failed)
    const failedEnds: ChildEnd[] = []
    new HarnessContinuableChildPort(failed, failedHarness.agent, new NodeGitWorkspacePort()).onEnd(end => void failedEnds.push(end))
    failedHarness.end()
    await vi.waitFor(() => expect(failedEnds).toHaveLength(1))
    expect(failedEnds[0]).not.toHaveProperty('usage')

    vi.useFakeTimers()
    try {
      const stalled = new Context()
      stalled.provide('sessionPersistence', { load: () => new Promise(() => {}) } as never)
      const stalledHarness = fakeController(Session.create(SessionId('controller-stalled-usage')), stalled)
      const stalledEnds: ChildEnd[] = []
      new HarnessContinuableChildPort(stalled, stalledHarness.agent, new NodeGitWorkspacePort()).onEnd(end => void stalledEnds.push(end))
      stalledHarness.end()
      await vi.advanceTimersByTimeAsync(2_000)
      await Promise.resolve()
      expect(stalledEnds).toHaveLength(1)
      expect(stalledEnds[0]).not.toHaveProperty('usage')
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses a delayed usage delivery after the observer is disposed', async () => {
    let resolveLoad!: (inspection: { meta: Session['header']; events: Session['events'] }) => void
    const child = Session.create(SessionId('child-1'))
    const ctx = new Context()
    ctx.provide('sessionPersistence', {
      load: () => new Promise(resolve => { resolveLoad = resolve }),
    } as never)
    const harness = fakeController(Session.create(SessionId('controller-disposed-usage')), ctx)
    const ends: ChildEnd[] = []
    const dispose = new HarnessContinuableChildPort(ctx, harness.agent, new NodeGitWorkspacePort()).onEnd(end => void ends.push(end))
    harness.end()
    dispose()
    resolveLoad({ meta: child.header, events: child.events })
    await Promise.resolve()
    await Promise.resolve()
    expect(ends).toEqual([])
  })

  it('maps a full-access task to the exact danger-full-access child boundary', async () => {
    const fixture = await realGatedWorkspace('full-access')
    try {
      const ctx = new Context()
      const controllerId = SessionId('controller-full-access')
      const cwd = fixture.workspace.worktreePath
      const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
      const harness = fakeController(session, ctx, 'danger-full-access')
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const workspaceId = WorkspaceId('workspace-full-access')
      for (const item of [
        event(910, { type: 'yuqi/team-created', title: 'Full access', objective: 'Prove explicit full access' }),
        event(911, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(912, { type: 'yuqi/task-created', contract: { ...contract('full-task' as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'] } }),
        event(913, { type: 'yuqi/workspace-provisioning-started', workspace: {
          workspaceId, project: fixture.workspace.project, worktreePath: cwd, branchName: fixture.workspace.branchName, status: 'provisioning',
        } }),
        event(914, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const revised = await ctx.yuqiTeamOrchestrator.setTaskAuthority({
        controller: harness.agent, teamId: 'team-1', taskId: 'full-task', authorityMode: 'full-access', operationId: 'authority-full',
      })
      expect(revised.tasks['full-task']?.contract).toMatchObject({ revision: 2, authorityMode: 'full-access' })
      const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
      const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 })
      const signal = new AbortController().signal
      const modelPolicy = {
        task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
        harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
      }
      const result = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd, plan, maxConcurrency: 1,
        children: [{ taskId: 'full-task', attemptId: 'full-attempt', leaseId: 'full-lease', modelPolicy, label: 'full', prompt: [{ type: 'text', text: 'full' }], signal }],
      })
      await result.handles[0]!.admission
      expect(harness.starts).toHaveLength(1)
      harness.end({ id: SessionId('child-1'), runId: 'full-run' })
      await result.handles[0]!.settled
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('executes and cancels a workspace/model/lease-gated batch through the public Harness boundary', async () => {
    const fixture = await realGatedWorkspace('gated-host')
    try {
    const ctx = new Context()
    const controllerId = SessionId('controller-gated-batch')
    const cwd = fixture.workspace.worktreePath
    const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
    const harness = fakeController(session, ctx, 'workspace-write', { agentsRegistry: 'custom' })
    // Exercise the service's real optional capability binding, not a property
    // on the uninjected base Context. Cancellation must resolve this exact owner.
    ctx.provide('agents', {
      get(id: SessionId) { return id === controllerId ? harness.agent : undefined },
    } as never)
    ctx.provide('agentPresets' as never, {
      async resolve() { return { id: 'standard' } },
      async mount() {},
    } as never)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const workspaceId = WorkspaceId('workspace-gated-host')
    const left = 'gated-host-left'; const right = 'gated-host-right'; const finalTask = 'gated-host-final'
    for (const item of [
      event(920, { type: 'yuqi/team-created', title: 'Gated host', objective: 'Prove every execution boundary' }),
      event(921, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(922, { type: 'yuqi/task-created', contract: { ...contract(left as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'] } }),
      event(923, { type: 'yuqi/task-created', contract: { ...contract(right as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['tests/**'] } }),
      event(9231, { type: 'yuqi/task-created', contract: { ...contract(finalTask as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['docs/**'] } }),
      event(924, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: {
          workspaceId,
          project: fixture.workspace.project,
          worktreePath: cwd, branchName: fixture.workspace.branchName, status: 'provisioning',
        },
      }),
      event(925, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 })
    const signal = new AbortController().signal
    const modelPolicy = {
      task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
      harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
    }
    const request = {
      controller: harness.agent,
      teamId: 'team-1',
      workspaceId,
      worktreePath: cwd,
      plan,
      maxConcurrency: 2,
      children: [
        { taskId: left, attemptId: 'gated-attempt-left', leaseId: 'gated-lease-left', modelPolicy, label: 'left', prompt: [{ type: 'text' as const, text: 'left' }], signal },
        { taskId: right, attemptId: 'gated-attempt-right', leaseId: 'gated-lease-right', modelPolicy, label: 'right', prompt: [{ type: 'text' as const, text: 'right' }], signal },
      ],
    }
    const result = await ctx.yuqiTeamOrchestrator.executeGatedBatch(request)
    await Promise.all(result.handles.map(handle => handle.admission))
    expect(harness.starts).toHaveLength(2)
    expect(harness.starts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        request: expect.not.objectContaining({ toolFilter: expect.anything() }),
      }),
    ]))
    harness.end({ id: SessionId('child-2'), runId: 'gated-run-right', lastAssistantMessage: [{ type: 'text', text: 'right completed' }] })
    harness.end({ id: SessionId('child-1'), runId: 'gated-run-left', lastAssistantMessage: [{ type: 'text', text: 'left completed' }] })
    await Promise.all(result.handles.map(handle => handle.settled))
    const projection = replayTeamEvents(journal.read())
    // These contracts intentionally omit verificationChecks. A completed
    // child therefore settles the task and releases its lease instead of
    // leaving an unfinishable verifying state behind.
    expect(projection.fileLeases['gated-lease-left']?.status).toBe('released')
    expect(projection.fileLeases['gated-lease-right']?.status).toBe('released')
    expect(projection.tasks[left]?.status).toBe('completed')
    expect(projection.tasks[right]?.status).toBe('completed')

    // Successful child output remains dirty after its lease is released. The
    // next DAG layer must accept only those durably declared Team-owned paths.
    await mkdir(path.join(cwd, 'src'), { recursive: true })
    await mkdir(path.join(cwd, 'tests'), { recursive: true })
    await writeFile(path.join(cwd, 'src', 'left-output.css'), 'left', 'utf8')
    await writeFile(path.join(cwd, 'tests', 'right-output.ts'), 'right', 'utf8')

    const finalPlan = planTeamSchedule(projection, { maxConcurrency: 1 })
    const finalResult = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
      ...request,
      plan: finalPlan,
      maxConcurrency: 1,
      children: [{
        taskId: finalTask, attemptId: 'gated-attempt-final', leaseId: 'gated-lease-final',
        modelPolicy, label: 'final', prompt: [{ type: 'text' as const, text: 'final' }], signal,
      }],
    })
    await finalResult.handles[0]!.admission
    const cancellation = ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'gated-cancel', timeoutMs: 1_000,
    })
    await vi.waitFor(() => expect(harness.interrupts).toEqual(['child-3']))
    const replayedCancellation = ctx.yuqiTeamOrchestrator.cancelTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'gated-cancel', timeoutMs: 1_000,
    })
    await vi.waitFor(() => expect(harness.interrupts).toEqual(['child-3', 'child-3']))
    harness.end({ id: SessionId('child-3'), runId: 'gated-run-final', stopReason: 'aborted' })
    await finalResult.handles[0]!.settled
    await expect(replayedCancellation).resolves.toMatchObject({ team: { status: 'cancelled' } })
    await expect(cancellation).resolves.toMatchObject({ team: { status: 'cancelled' } })
    expect(replayTeamEvents(journal.read()).team.status).toBe('cancelled')
    await expect(ctx.yuqiTeamOrchestrator.executeGatedBatch(request)).rejects.toMatchObject({ code: 'SCHEDULE_NOT_RUNNABLE' })
    // The final writer was admitted before cancellation. Its actual write set
    // may exceed fileScope (a scheduling hint), and an aborted child may not
    // produce a final changed-file report. The dedicated Team worktree remains
    // recoverable; terminal Team state still prevents another batch.
    await writeFile(path.join(cwd, 'drift.txt'), 'partial child output', 'utf8')
    await expect(ctx.yuqiTeamOrchestrator.executeGatedBatch(request))
      .rejects.toMatchObject({ code: 'SCHEDULE_NOT_RUNNABLE' })
    expect(replayTeamEvents(journal.read()).workspace?.status).toBe('ready')
    await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 45_000)

  it('keeps cancellation pending when Harness accepts an interrupt and terminal fact arrives later', async () => {
    const fixture = await realGatedWorkspace('cancel-terminal-timeout')
    try {
      const ctx = new Context()
      const controllerId = SessionId('controller-cancel-terminal-timeout')
      const cwd = fixture.workspace.worktreePath
      const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
      const harness = fakeController(session, ctx, 'workspace-write', { agentsRegistry: 'custom' })
      // Activate the optional registry binding used to resolve cancellation authority.
      ctx.provide('agents', {
        get(id: SessionId) { return id === controllerId ? harness.agent : undefined },
      } as never)
      ctx.provide('agentPresets' as never, {
        async resolve() { return { id: 'standard' } },
        async mount() {},
      } as never)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const taskId = 'cancel-timeout-task'
      const workspaceId = WorkspaceId('workspace-cancel-timeout')
      for (const item of [
        event(960, { type: 'yuqi/team-created', title: 'Cancel timeout', objective: 'Require a durable terminal fact' }),
        event(961, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(962, { type: 'yuqi/task-created', contract: { ...contract(taskId as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'] } }),
        event(963, { type: 'yuqi/workspace-provisioning-started', workspace: {
          workspaceId, project: fixture.workspace.project, worktreePath: cwd,
          branchName: fixture.workspace.branchName, status: 'provisioning',
        } }),
        event(964, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
      const signal = new AbortController().signal
      const result = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd,
        plan: planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 }), maxConcurrency: 1,
        children: [{
          taskId, attemptId: 'cancel-timeout-attempt', leaseId: 'cancel-timeout-lease',
          modelPolicy: {
            task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
            harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
          },
          label: 'cancel-timeout', prompt: [{ type: 'text', text: 'cancel me' }], signal,
        }],
      })
      await result.handles[0]!.admission
      await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
        controller: harness.agent, teamId: 'team-1', operationId: 'cancel-timeout-operation', timeoutMs: 10,
      })).resolves.toMatchObject({ team: { status: 'cancelling' } })
      expect(harness.interrupts).toEqual(['child-1'])
      expect(replayTeamEvents(journal.read()).team.status).toBe('cancelling')
      harness.end({ id: SessionId('child-1'), stopReason: 'aborted' })
      await result.handles[0]!.settled
      expect(replayTeamEvents(journal.read()).team.status).toBe('cancelled')
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('records reconciliation when Harness rejects an admitted child interrupt', async () => {
    const fixture = await realGatedWorkspace('cancel-interrupt-error')
    try {
      const ctx = new Context()
      const controllerId = SessionId('controller-cancel-interrupt-error')
      const cwd = fixture.workspace.worktreePath
      const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
      const harness = fakeController(session, ctx, 'workspace-write')
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const taskId = 'cancel-host-task'
      const workspaceId = WorkspaceId('workspace-cancel-host')
      for (const item of [
        event(970, { type: 'yuqi/team-created', title: 'Cancel host', objective: 'Fail closed on interrupt rejection' }),
        event(971, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(972, { type: 'yuqi/task-created', contract: { ...contract(taskId as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'] } }),
        event(973, { type: 'yuqi/workspace-provisioning-started', workspace: {
          workspaceId, project: fixture.workspace.project, worktreePath: cwd,
          branchName: fixture.workspace.branchName, status: 'provisioning',
        } }),
        event(974, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
      const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
      const signal = new AbortController().signal
      const result = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent,
        teamId: 'team-1', workspaceId, worktreePath: cwd,
        plan: planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 }),
        maxConcurrency: 1,
        children: [{
          taskId, attemptId: 'cancel-host-attempt', leaseId: 'cancel-host-lease',
          modelPolicy: {
            task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
            harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
          },
          label: 'cancel-host', prompt: [{ type: 'text', text: 'cancel me' }], signal,
        }],
      })
      await result.handles[0]!.admission
      harness.failInterrupt(new Error('interrupt rejected'))
      await expect(ctx.yuqiTeamOrchestrator.cancelTeam({
        controller: harness.agent, teamId: 'team-1', operationId: 'cancel-host-operation',
      })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
      expect(harness.interrupts).toEqual(['child-1'])
      expect(replayTeamEvents(journal.read()).team.status).toBe('needs_reconciliation')
      harness.failInterrupt(undefined)
      harness.end({ id: SessionId('child-1'), stopReason: 'aborted' })
      await result.handles[0]!.settled
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('rejects missing tasks and mixed authority before model resolution or durable intent', async () => {
    const ctx = new Context()
    const controllerId = SessionId('controller-gated-rejection')
    const cwd = process.cwd()
    const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
    const harness = fakeController(session, ctx, 'workspace-write')
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const workspaceId = WorkspaceId('workspace-gated-rejection')
    const writeTask = 'gated-write'; const readTask = 'gated-read'
    for (const item of [
      event(930, { type: 'yuqi/team-created', title: 'Reject gated batch', objective: 'Fail before side effects' }),
      event(931, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(932, { type: 'yuqi/task-created', contract: { ...contract(writeTask as never), fileScope: ['src/**'] } }),
      event(933, { type: 'yuqi/task-created', contract: { ...contract(readTask as never), authorityMode: 'read-only', fileScope: ['docs/**'] } }),
      event(934, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: {
          workspaceId,
          project: { projectRoot: cwd, repositoryRoot: cwd, gitCommonDirectory: `${cwd}\\.git`, baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: ['F:\\'] },
          worktreePath: cwd, branchName: 'yuqi/rejection', status: 'provisioning',
        },
      }),
      event(935, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 2 })
    const signal = new AbortController().signal
    const modelPolicy = {
      harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
    }
    const base = { controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd, plan, maxConcurrency: 2 }
    await expect(ctx.yuqiTeamOrchestrator.executeGatedBatch({
      ...base,
      children: [{ taskId: 'missing', attemptId: 'missing-attempt', leaseId: 'missing-lease', modelPolicy, label: 'missing', prompt: [], signal }],
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await expect(ctx.yuqiTeamOrchestrator.executeGatedBatch({
      ...base,
      children: [
        { taskId: writeTask, attemptId: 'write-attempt', leaseId: 'write-lease', modelPolicy, label: 'write', prompt: [], signal },
        { taskId: readTask, attemptId: 'read-attempt', leaseId: 'read-lease', modelPolicy, label: 'read', prompt: [], signal },
      ],
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    expect(harness.starts).toHaveLength(0)
    expect(journal.read()).toHaveLength(6)
    await fiber.dispose()
  })

  it('revalidates Git after model resolution and blocks drift before child admission', async () => {
    const fixture = await realGatedWorkspace('gated-race')
    try {
      const ctx = new Context()
      let release!: () => void
      const barrier = new Promise<void>(resolve => { release = resolve })
      let markEntered!: () => void
      const entered = new Promise<void>(resolve => { markEntered = resolve })
      ctx.provide('llm', {
        async listModels(provider: string) { return [{ provider, id: 'deepseek-v4', name: 'DeepSeek V4' }] },
        async resolveModelInfo(provider: string, model: string) {
          markEntered()
          await barrier
          return { provider, id: model, name: `${provider}/${model}` }
        },
      } as never)
      const cwd = fixture.workspace.worktreePath
      const controllerId = SessionId('controller-gated-race')
      const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
      const harness = fakeController(session, ctx, 'workspace-write')
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const workspaceId = WorkspaceId('workspace-gated-race')
      const taskId = 'gated-race-task'
      for (const item of [
        event(960, { type: 'yuqi/team-created', title: 'Race gate', objective: 'Block post-verify drift' }),
        event(961, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(962, { type: 'yuqi/task-created', contract: { ...contract(taskId as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'] } }),
        event(963, { type: 'yuqi/workspace-provisioning-started', workspace: {
          workspaceId, project: fixture.workspace.project, worktreePath: cwd,
          branchName: fixture.workspace.branchName, status: 'provisioning',
        } }),
        event(964, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ]) session.append(TEAM_SESSION_EVENT, { event: item })
      const journal = new HarnessSessionJournal(session, ctx.sessions)
      const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 })
      const executing = ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd, plan, maxConcurrency: 1,
        children: [{
          taskId, attemptId: 'gated-race-attempt', leaseId: 'gated-race-lease', label: 'race', prompt: [],
          signal: new AbortController().signal,
          modelPolicy: {
            task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
            harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' },
          },
        }],
      })
      await entered
      await writeFile(path.join(cwd, 'outside.txt'), 'drift after initial verification', 'utf8')
      release()
      const result = await executing
      await expect(result.handles[0]!.admission).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
      await expect(result.handles[0]!.settled).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
      expect(harness.starts).toHaveLength(0)
      const projection = replayTeamEvents(journal.read())
      expect(projection.tasks[taskId]?.status).toBe('failed')
      expect(projection.fileLeases['gated-race-lease']?.status).toBe('released')
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('runs an all-read-only gated batch under an exact read-only sandbox', async () => {
    const fixture = await realGatedWorkspace('gated-read')
    try {
    const ctx = new Context()
    const controllerId = SessionId('controller-gated-read')
    const cwd = fixture.workspace.worktreePath
    const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
    const harness = fakeController(session, ctx, 'read-only')
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const workspaceId = WorkspaceId('workspace-gated-read')
    const taskId = 'gated-read-only'
    for (const item of [
      event(940, { type: 'yuqi/team-created', title: 'Read gated batch', objective: 'Read safely' }),
      event(941, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(942, { type: 'yuqi/task-created', contract: { ...contract(taskId as never), baselineRef: fixture.workspace.project.baselineRef, authorityMode: 'read-only', fileScope: ['docs/**'] } }),
      event(943, {
        type: 'yuqi/workspace-provisioning-started',
        workspace: {
          workspaceId,
          project: fixture.workspace.project,
          worktreePath: cwd, branchName: fixture.workspace.branchName, status: 'provisioning',
        },
      }),
      event(944, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const plan = planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 })
    const signal = new AbortController().signal
    const result = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
      controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd, plan, maxConcurrency: 1,
      children: [{
        taskId, attemptId: 'read-attempt', leaseId: 'read-lease', label: 'read', prompt: [], signal,
        tokenReserve: 1,
        modelPolicy: { harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' } },
      }],
    })
    await result.handles[0]!.admission
    harness.end({ id: SessionId('child-1'), runId: 'read-run' })
    await result.handles[0]!.settled
    expect(replayTeamEvents(journal.read()).fileLeases['read-lease']?.mode).toBe('read')
    await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('exposes fail-closed progress, abort, and project-summary service boundaries', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-service-boundaries')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)

    await expect(ctx.yuqiTeamOrchestrator.waitForProgress({
      journal, activeTaskIds: ['task-1'], signal: new AbortController().signal,
    } as never)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    await expect(Promise.resolve().then(() => ctx.yuqiTeamOrchestrator.collectVerificationEvidence({
      controller: harness.agent, teamId: 'wrong-team', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-1',
      operationId: 'service-evidence-mismatch', requirements: [{ checkId: 'build', kind: 'build' }],
    } as never))).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const aborted = await ctx.yuqiTeamOrchestrator.abortTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'service-abort-boundary',
    })
    expect(aborted.team.status).toBe('needs_reconciliation')

    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-service-summary-'))
    await expect(ctx.yuqiTeamOrchestrator.readProjectSummary(root)).resolves.toMatchObject({ schemaVersion: 1 })
    await expect(ctx.yuqiTeamOrchestrator.updateProjectSummary(root, { overallProgress: '已通过 Host service' }))
      .resolves.toMatchObject({ overallProgress: '已通过 Host service' })
    const eventsBeforePublication = journal.read()
    await expect(ctx.yuqiTeamOrchestrator.recordProjectSummary({
      controller: harness.agent,
      summary: {
        schemaVersion: 1, overallProgress: '已记录', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [],
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    expect(journal.read()).toEqual(eventsBeforePublication)
    await expect(ctx.yuqiTeamOrchestrator.readProjectSummary(root))
      .resolves.toMatchObject({ overallProgress: '已通过 Host service' })
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('marks tool abort uncertain when the public Harness rejects child interruption', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-abort-uncertain')), ctx)
    for (const item of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const runtime = ctx.yuqiTeamOrchestrator as unknown as { batchExecutor: { cancelActive: (journalKey: string) => void } }
    runtime.batchExecutor.cancelActive = () => { throw new Error('interrupt rejected') }

    const result = await ctx.yuqiTeamOrchestrator.abortTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'service-abort-uncertain',
    })
    expect(result.team.status).toBe('needs_reconciliation')
    await fiber.dispose()
  })

  it('runs the public reviewer boundary after a durable workspace is ready', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-review-boundary')), ctx)
    const workspaceId = WorkspaceId('workspace-review-boundary')
    const workspace = {
      workspaceId,
      project: {
        projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: `${process.cwd()}\\.git`,
        baselineRef: 'baseline', volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
      },
      worktreePath: process.cwd(), branchName: 'yuqi/review-boundary', status: 'provisioning' as const,
    }
    const source = completeTeamEvents()
    for (const item of [
      ...source.slice(0, 3),
      event(1800, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(1801, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ...source.slice(3),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    ;(harness.agent as unknown as { options: { provider: string } }).options = { provider: 'mock' }
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      reviewer: { run(request: { readonly reviewId: string; readonly trigger: string }): Promise<unknown> }
    }
    service.reviewer.run = async (request) => {
      return {
        reviewId: request.reviewId, trigger: request.trigger, reviewerSessionId: 'reviewer-boundary',
        decision: 'pass', findings: [], unverified: [],
      }
    }
    const result = await ctx.yuqiTeamOrchestrator.reviewTeam({ controller: harness.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'review-boundary' })
    expect(result).toMatchObject({ status: 'completed', result: { reviewId: 'review-boundary', decision: 'pass' } })
    await expect(ctx.yuqiTeamOrchestrator.reviewTeam({ controller: harness.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'review-boundary' }))
      .resolves.toMatchObject({ status: 'completed', result: { reviewId: 'review-boundary' } })
    await fiber.dispose()
  })

  it('persists a plan checkpoint before any worker admission without requiring a completion candidate', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-plan-checkpoint')), ctx)
    const workspaceId = WorkspaceId('workspace-plan-checkpoint')
    const workspace = {
      workspaceId,
      project: {
        projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: `${process.cwd()}\\.git`,
        baselineRef: 'baseline', volumeRoot: path.parse(process.cwd()).root, protectedRoots: [],
      },
      worktreePath: process.cwd(), branchName: 'yuqi/plan-checkpoint', status: 'provisioning' as const,
    }
    const source = completeTeamEvents()
    for (const item of [
      event(1810, {
        type: 'yuqi/team-created', title: 'Plan checkpoint', objective: 'Review before dispatch',
        controllerModel: { provider: 'mock', model: 'controller-model' },
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      } as never),
      source[1]!, source[2]!,
      event(1811, { type: 'yuqi/workspace-provisioning-started', workspace }),
      event(1812, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: item })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    ;(harness.agent as unknown as { options: { provider: string; model: string } }).options = { provider: 'mock', model: 'controller-model' }
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      reviewer: { run(request: { readonly reviewId: string; readonly trigger: string }): Promise<unknown> }
    }
    service.reviewer.run = async (request) => {
      return {
        reviewId: request.reviewId, trigger: request.trigger, reviewerSessionId: 'reviewer-plan',
        decision: 'pass', findings: [], unverified: [],
      }
    }
    await expect(ctx.yuqiTeamOrchestrator.reviewTeam({
      controller: harness.agent, teamId: 'team-1', trigger: 'plan-confirmation', reviewId: 'review-plan',
      candidateEventId: 'event-1810', round: 0, checkpointSubject: 'team-plan',
      checkpointAnchor: { eventId: 'event-1810' },
      automaticReworkBudget: { checkpointLimit: 2, teamLimit: 6 }, independentReviewerRequired: true,
    } as never)).resolves.toMatchObject({ status: 'completed', result: { decision: 'pass' } })
    const projection = replayTeamEvents(readTeamEventsFromSession(harness.agent.session))
    expect(projection.reviews['review-plan']).toMatchObject({
      checkpointSubject: 'team-plan', checkpointAnchor: { eventId: 'event-1810' },
      result: { decision: 'pass' },
    })
    expect(projection.team.status).toBe('running')
    await fiber.dispose()
  })

  it('replans after a durable plan review before admitting the first worker', async () => {
    const fixture = await realGatedWorkspace('plan-review-replan')
    try {
      const ctx = new Context()
      const controllerId = SessionId('controller-plan-review-replan')
      const cwd = fixture.workspace.worktreePath
      const session = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd })
      const harness = fakeController(session, ctx, 'workspace-write')
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const workspaceId = WorkspaceId('workspace-plan-review-replan')
      const taskId = 'plan-review-task'
      for (const item of [
        event(1820, {
          type: 'yuqi/team-created', title: 'Plan review replan', objective: 'Review then dispatch',
          controllerModel: { provider: 'mock', model: 'controller-model' },
          reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
        } as never),
        event(1821, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
        event(1822, { type: 'yuqi/task-created', contract: {
          ...contract(taskId as never), baselineRef: fixture.workspace.project.baselineRef, fileScope: ['src/**'],
        } }),
        event(1823, { type: 'yuqi/workspace-provisioning-started', workspace: {
          workspaceId, project: fixture.workspace.project, worktreePath: cwd,
          branchName: fixture.workspace.branchName, status: 'provisioning',
        } }),
        event(1824, { type: 'yuqi/workspace-provisioned', workspaceId }),
      ]) session.append(TEAM_SESSION_EVENT, { event: item })
      ;(harness.agent as unknown as { options: { provider: string; model: string } }).options = {
        provider: 'mock', model: 'controller-model',
      }
      const service = ctx.yuqiTeamOrchestrator as unknown as {
        reviewer: { run(request: { readonly reviewId: string; readonly trigger: string }): Promise<unknown> }
      }
      service.reviewer.run = async (request) => {
        return {
          reviewId: request.reviewId, trigger: request.trigger, reviewerSessionId: 'reviewer-plan-replan',
          decision: 'pass', findings: [], unverified: [],
        }
      }
      const journal = new HarnessSessionJournal(session, ctx.sessions)
      expect(replayTeamEvents(journal.read())).toMatchObject({
        team: { reviewPolicy: { mode: 'quality-gate' } }, reviewIds: [],
      })
      const signal = new AbortController().signal
      const child = {
        taskId, attemptId: 'plan-review-attempt', leaseId: 'plan-review-lease', label: 'plan-review',
        prompt: [{ type: 'text' as const, text: 'execute after review' }], signal,
        modelPolicy: {
          task: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
          harnessDefault: { subagentProvider: 'in-process', modelProvider: 'deepseek', modelId: 'deepseek-v4', role: 'worker' as const },
        },
      }
      const first = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd,
        plan: planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 }),
        maxConcurrency: 1, children: [child],
      })
      expect(replayTeamEvents(journal.read()).reviewIds.length).toBeGreaterThan(0)
      expect(first.handles).toHaveLength(1)
      await expect(first.handles[0]!.admission).resolves.toBeUndefined()
      await expect(first.handles[0]!.settled).resolves.toBeUndefined()
      expect(harness.starts).toHaveLength(0)
      expect(replayTeamEvents(journal.read()).reviews).toEqual(expect.objectContaining({
        'review:team-1:plan-confirmation:0:event-1820': expect.objectContaining({ result: expect.objectContaining({ decision: 'pass' }) }),
      }))

      const second = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
        controller: harness.agent, teamId: 'team-1', workspaceId, worktreePath: cwd,
        plan: planTeamSchedule(replayTeamEvents(journal.read()), { maxConcurrency: 1 }),
        maxConcurrency: 1, children: [child],
      })
      expect(second.handles).toHaveLength(1)
      await second.handles[0]!.admission
      expect(harness.starts).toHaveLength(1)
      harness.end({ id: SessionId('child-1'), runId: 'plan-review-run' })
      await second.handles[0]!.settled
      await fiber.dispose()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps malformed subprocess outcomes and requirement selection fail-closed', async () => {
    const workspace = {
      workspaceId: WorkspaceId('collector-edge-workspace'),
      project: {
        projectRoot: process.cwd(), repositoryRoot: process.cwd(), gitCommonDirectory: `${process.cwd()}\\.git`,
        baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
      },
      worktreePath: process.cwd(), branchName: 'yuqi/collector-edge', status: 'ready' as const,
    }
    const buildTask = {
      ...contract(TaskId('collector-edge-task')),
      verificationChecks: [{ checkId: 'build', kind: 'build' as const, commandRef: 'pnpm-build', timeoutMs: 100, stdoutMaxBytes: 8, stderrMaxBytes: 8 }],
    }
    const failed = new SubprocessEvidenceCollector({
      async run() { return { outcome: 'failed' as const, exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array() } },
    })
    await expect(failed.collect({ task: buildTask, workspace })).resolves.toMatchObject({ kind: 'failed', code: 'SUBPROCESS_FAILED' })

    const noRun = new SubprocessEvidenceCollector({
      async run() { throw new Error('must not run') },
    })
    await expect(noRun.collect({ task: buildTask, workspace, requirementIds: ['build', 'build'] })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_VERIFICATION_REQUIREMENTS' })
    await expect(noRun.collect({ task: buildTask, workspace, requirementIds: ['missing'] })).resolves.toMatchObject({ kind: 'failed', code: 'VERIFICATION_CHECK_NOT_DURABLE' })
    await expect(noRun.collect({ task: buildTask, workspace, requirementIds: [] })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_VERIFICATION_REQUIREMENTS' })

    await expect(new SubprocessEvidenceCollector({
      async run() { return { outcome: 'aborted' as const, exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array() } },
    }).collect({ task: buildTask, workspace })).resolves.toMatchObject({ kind: 'aborted' })
    const preAborted = new AbortController()
    preAborted.abort()
    await expect(noRun.collect({ task: buildTask, workspace, signal: preAborted.signal })).resolves.toMatchObject({ kind: 'aborted' })
    expect(unsupportedVerificationCheck({ ...buildTask.verificationChecks[0]!, kind: 'interface' } as never))
      .toContain('cannot execute evidence kind interface')
  })

})
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

describe('Harness service recovery branch regression', () => {
  type Projection = ReturnType<typeof replayTeamEvents>

  function recoveryProjection(
    teamStatus: string,
    tasks: Record<string, { status: string; attemptIds: string[] }>,
    attempts: Record<string, { status: string }>,
    observations: Record<string, { operationId?: string; state?: string }> = {},
  ): Projection {
    const reconciliationOperations: Record<string, { observations: Array<{ attemptId: string; state: string }> }> = {}
    const latestReconciliationOperationIds: Record<string, string> = {}
    for (const [attemptId, observation] of Object.entries(observations)) {
      if (observation.operationId === undefined) continue
      latestReconciliationOperationIds[attemptId] = observation.operationId
      reconciliationOperations[observation.operationId] = {
        observations: observation.state === undefined ? [] : [{ attemptId, state: observation.state }],
      }
    }
    return {
      team: { id: 'team-1', status: teamStatus },
      taskIds: Object.keys(tasks),
      tasks: Object.fromEntries(Object.entries(tasks).map(([taskId, task]) => [taskId, {
        contract: { taskId, goal: `Recover ${taskId}` },
        ...task,
      }])),
      attempts,
      latestReconciliationOperationIds,
      reconciliationOperations,
    } as unknown as Projection
  }

  it('keeps recovery closed for every unresolved Host-observation shape', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-recovery-unresolved-matrix')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      projectionForTeam(journal: unknown, teamId: string): Projection
      reconcileTeam(request: unknown): Promise<Projection>
      recoverAndContinueTeam(request: { controller: Agent; teamId: string; operationId: string }): Promise<Projection>
    }
    const unresolved = recoveryProjection('needs_reconciliation', {
      'never-started': { status: 'pending', attemptIds: [] },
      settled: { status: 'completed', attemptIds: ['settled-attempt'] },
      'missing-operation': { status: 'running', attemptIds: ['missing-operation-attempt'] },
      'missing-observation': { status: 'running', attemptIds: ['missing-observation-attempt'] },
      'unsafe-observation': { status: 'running', attemptIds: ['unsafe-observation-attempt'] },
    }, {
      'settled-attempt': { status: 'completed' },
      'missing-operation-attempt': { status: 'unknown' },
      'missing-observation-attempt': { status: 'unknown' },
      'unsafe-observation-attempt': { status: 'unknown' },
    }, {
      'missing-observation-attempt': { operationId: 'observation-without-attempt' },
      'unsafe-observation-attempt': { operationId: 'unsafe-observation', state: 'live' },
    })
    vi.spyOn(service, 'projectionForTeam').mockReturnValue(unresolved)
    vi.spyOn(service, 'reconcileTeam').mockResolvedValue(unresolved)

    await expect(service.recoverAndContinueTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'unresolved-matrix',
    })).resolves.toBe(unresolved)
    await fiber.dispose()
  })

  it('performs one fresh reconciliation before automatic recovery instead of waiting for a second command', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-recovery-fresh-observation')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      projectionForTeam(journal: unknown, teamId: string): Projection
      reconcileTeam(request: unknown): Promise<Projection>
      resolveAttempt(request: unknown): Promise<Projection>
      clearTeamRecovery(request: unknown): Promise<Projection>
      retryTask(request: unknown): Promise<Projection>
      resumeTeam(request: unknown): Promise<Projection>
      recoverAndContinueTeam(request: { controller: Agent; teamId: string; operationId: string }): Promise<Projection>
    }
    const initial = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'running', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'unknown' } })
    const observed = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'running', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'unknown' } }, {
      'interrupted-attempt': { operationId: 'fresh-observation', state: 'missing' },
    })
    const resolved = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'failed', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const cleared = recoveryProjection('paused', {
      interrupted: { status: 'failed', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const retried = recoveryProjection('paused', {
      interrupted: { status: 'ready', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const resumed = recoveryProjection('running', {
      interrupted: { status: 'ready', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    vi.spyOn(service, 'projectionForTeam').mockReturnValue(initial)
    const reconcile = vi.spyOn(service, 'reconcileTeam').mockResolvedValue(observed)
    vi.spyOn(service, 'resolveAttempt').mockResolvedValue(resolved)
    vi.spyOn(service, 'clearTeamRecovery').mockResolvedValue(cleared)
    vi.spyOn(service, 'retryTask').mockResolvedValue(retried)
    vi.spyOn(service, 'resumeTeam').mockResolvedValue(resumed)

    await expect(service.recoverAndContinueTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'fresh-observation',
    })).resolves.toBe(resumed)
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-1', operationId: expect.stringContaining('fresh-observation'),
    }))
    await fiber.dispose()
  })

  it('resolves, clears, retries, and resumes a safely observed interrupted task', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-recovery-complete-matrix')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      projectionForTeam(journal: unknown, teamId: string): Projection
      resolveAttempt(request: unknown): Promise<Projection>
      clearTeamRecovery(request: unknown): Promise<Projection>
      retryTask(request: unknown): Promise<Projection>
      resumeTeam(request: unknown): Promise<Projection>
      recoverAndContinueTeam(request: { controller: Agent; teamId: string; operationId: string; signal?: AbortSignal }): Promise<Projection>
    }
    const initial = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'running', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'unknown' } }, {
      'interrupted-attempt': { operationId: 'durable-observation', state: 'durable' },
    })
    const resolved = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'failed', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const cleared = recoveryProjection('paused', {
      interrupted: { status: 'failed', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const retried = recoveryProjection('paused', {
      interrupted: { status: 'ready', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const resumed = recoveryProjection('running', {
      interrupted: { status: 'ready', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    vi.spyOn(service, 'projectionForTeam').mockReturnValue(initial)
    const resolveAttempt = vi.spyOn(service, 'resolveAttempt').mockResolvedValue(resolved)
    const clearRecovery = vi.spyOn(service, 'clearTeamRecovery').mockResolvedValue(cleared)
    const retryTask = vi.spyOn(service, 'retryTask').mockResolvedValue(retried)
    const resumeTeam = vi.spyOn(service, 'resumeTeam').mockResolvedValue(resumed)
    const signal = new AbortController().signal

    await expect(service.recoverAndContinueTeam({
      controller: harness.agent, teamId: 'team-1', operationId: 'complete-matrix', signal,
    })).resolves.toBe(resumed)
    expect(resolveAttempt).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'interrupted', attemptId: 'interrupted-attempt', decision: 'failed',
      observationOperationId: 'durable-observation', signal,
    }))
    expect(clearRecovery).toHaveBeenCalledWith(expect.objectContaining({ target: 'paused', signal }))
    expect(retryTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'interrupted' }))
    expect(resumeTeam).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team-1' }))
    await fiber.dispose()
  })

  it('skips a retry when resolution already made the task non-terminal and preserves a legacy terminal pause', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-recovery-skip-matrix')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      projectionForTeam(journal: unknown, teamId: string): Projection
      resolveAttempt(request: unknown): Promise<Projection>
      clearTeamRecovery(request: unknown): Promise<Projection>
      retryTask(request: unknown): Promise<Projection>
      resumeTeam(request: unknown): Promise<Projection>
      recoverAndContinueTeam(request: { controller: Agent; teamId: string; operationId: string }): Promise<Projection>
    }
    const initial = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'running', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'unknown' } }, {
      'interrupted-attempt': { operationId: 'missing-observation', state: 'missing' },
    })
    const resolved = recoveryProjection('needs_reconciliation', {
      interrupted: { status: 'pending', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const paused = recoveryProjection('paused', {
      interrupted: { status: 'pending', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const running = recoveryProjection('running', {
      interrupted: { status: 'pending', attemptIds: ['interrupted-attempt'] },
    }, { 'interrupted-attempt': { status: 'failed' } })
    const projectionForTeam = vi.spyOn(service, 'projectionForTeam').mockReturnValue(initial)
    vi.spyOn(service, 'resolveAttempt').mockResolvedValue(resolved)
    vi.spyOn(service, 'clearTeamRecovery').mockResolvedValue(paused)
    const retryTask = vi.spyOn(service, 'retryTask').mockResolvedValue(paused)
    vi.spyOn(service, 'resumeTeam').mockResolvedValue(running)

    await expect(service.recoverAndContinueTeam({ controller: harness.agent, teamId: 'team-1', operationId: 'skip-matrix' }))
      .resolves.toBe(running)
    expect(retryTask).not.toHaveBeenCalled()

    const legacy = recoveryProjection('paused', {
      failed: { status: 'blocked', attemptIds: ['failed-attempt'] },
    }, { 'failed-attempt': { status: 'failed' } })
    projectionForTeam.mockReturnValue(legacy)
    await expect(service.recoverAndContinueTeam({ controller: harness.agent, teamId: 'team-1', operationId: 'legacy-matrix' }))
      .resolves.toBe(legacy)
    await fiber.dispose()
  })

  it.each(['blocked', 'missing', 'invalid', 'empty'] as const)('does not recover %s task reports as completed', async kind => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId(`controller-outcome-${kind}`)), ctx)
    for (const fact of completeTeamEvents().slice(0, 8)) {
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact.type === 'yuqi/attempt-created' ? { ...fact, taskOutcomeVersion: 1 } : fact })
    }
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as { settleObservedAttempt(request: unknown): Promise<void> }
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    const taskOutcome = kind === 'blocked'
      ? { status: 'reported', outcome: { version: 1, kind: 'blocked', summary: 'Need input', nextAction: 'Ask controller' } }
      : kind === 'empty' ? { status: 'reported', outcome: { version: 1, kind: 'completed', summary: 'claimed done' } } : { status: kind }
    await service.settleObservedAttempt({ journal, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      end: { childSessionId: 'session-worker-1', runId: `run-${kind}`, provider: 'in-process', stopReason: 'completed', hasAssistantOutput: kind !== 'empty', taskOutcome },
    })
    const projection = replayTeamEvents(journal.read())
    expect(projection.tasks['task-1']?.status).toBe(kind === 'empty' ? 'failed' : 'blocked')
    expect(projection.team.status).toBe('paused')
    expect(projection.attempts['attempt-1']?.evidence?.taskOutcome).toEqual(taskOutcome)
    await fiber.dispose()
  })

  it('settles recovered error, abort, mismatch, and already-evidenced child outcomes truthfully', async () => {
    async function settleCase(label: string, stopReason: 'error' | 'aborted', withLease: boolean) {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId(`controller-settlement-${label}`)), ctx)
      const facts = [...completeTeamEvents().slice(0, 6)]
      if (withLease) facts.push(event(22, {
        type: 'yuqi/file-lease-acquired',
        lease: {
          leaseId: FileLeaseId(`lease-${label}`), taskId: TaskId('task-1'), attemptId: AttemptId('attempt-1'),
          mode: 'write', fileScope: ['src/**'], status: 'active',
        },
      }))
      facts.push(...completeTeamEvents().slice(6, 8))
      for (const fact of facts) harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const service = ctx.yuqiTeamOrchestrator as unknown as {
        settleObservedAttempt(request: unknown): Promise<void>
      }
      const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
      expect(journal.read()).toHaveLength(withLease ? 9 : 8)
      await service.settleObservedAttempt({
        journal, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
        end: {
          childSessionId: 'session-worker-1', runId: `run-${label}`, provider: 'in-process', stopReason,
          hasAssistantOutput: false, settledAt: '2026-08-30T00:00:00Z', reportedChangedFiles: ['src/changed.ts'],
          usage: { uncachedInputTokens: 2, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 7 },
        },
      })
      const projection = replayTeamEvents(journal.read())
      expect(projection.tasks['task-1']?.status).toBe(stopReason === 'aborted' ? 'cancelled' : 'failed')
      expect(projection.team.status).toBe('paused')
      if (withLease) expect(projection.fileLeases[`lease-${label}`]?.status).toBe('released')
      await fiber.dispose()
    }

    await settleCase('error', 'error', false)
    await settleCase('aborted', 'aborted', false)

    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-settlement-guards')), ctx)
    for (const fact of completeTeamEvents().slice(0, 8)) harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator as unknown as { settleObservedAttempt(request: unknown): Promise<void> }
    const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)
    await expect(service.settleObservedAttempt({
      journal, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      end: { childSessionId: 'wrong-child', runId: 'wrong-run', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true },
    })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const completed = new Context()
    const completedHarness = fakeController(Session.create(SessionId('controller-settlement-completed')), completed)
    for (const fact of completeTeamEvents().slice(0, 10)) completedHarness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    const completedFiber = await completed.plugin(YuqiTeamOrchestratorService)
    const completedService = completed.yuqiTeamOrchestrator as unknown as { settleObservedAttempt(request: unknown): Promise<void> }
    await expect(completedService.settleObservedAttempt({
      journal: new HarnessSessionJournal(completedHarness.agent.session, completed.sessions),
      teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      end: { childSessionId: 'session-worker-1', runId: 'duplicate-run', provider: 'in-process', stopReason: 'completed', hasAssistantOutput: true },
    })).resolves.toBeUndefined()
    await completedFiber.dispose()
    await fiber.dispose()
  })

  it('admits direct projects without Git and rejects only a competing writable Team on the same path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-direct-service-'))
    try {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId('controller-direct-service')), ctx, 'read-only', { agentsRegistry: 'custom' })
      const controllerFactory = installStartTeamControllerFactory(ctx, harness)
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const started = await ctx.yuqiTeamOrchestrator.startTeam({
        title: 'Direct service Team', objective: 'Work without a Git prerequisite',
        tasks: [{ ...contract(TaskId('direct-task')), baselineRef: 'caller-baseline' }],
        projectCwd: root, controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
      })
      expect(started.workspace).toMatchObject({
        project: { mode: 'direct', projectRoot: expect.any(String) }, worktreePath: expect.any(String), branchName: 'direct', status: 'ready',
      })
      expect(started.workspace.worktreePath).toBe(started.workspace.project.projectRoot)
      expect(replayTeamEvents(new HarnessSessionJournal(started.controller.session, ctx.sessions).read()).tasks['direct-task']?.contract.baselineRef)
        .toBe('caller-baseline')
      expect(controllerFactory.creates).toHaveLength(1)
      await expect(ctx.yuqiTeamOrchestrator.startTeam({
        title: 'Competing Direct writer', objective: 'Must not share one writable directory',
        tasks: [{ ...contract(TaskId('competing-direct-task')), baselineRef: 'caller-baseline' }],
        projectCwd: root, controllerModel: { provider: 'deepseek', model: 'deepseek-v4' },
      })).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' })
      expect(controllerFactory.creates).toHaveLength(1)
      await fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('wakes automatic verification retries only while the Team remains running', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-automatic-retry-wake')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const running = recoveryProjection('running', {
      'task-1': { status: 'verifying', attemptIds: ['attempt-1'] },
    }, { 'attempt-1': { status: 'completed' } })
    const paused = recoveryProjection('paused', {
      'task-1': { status: 'verifying', attemptIds: ['attempt-1'] },
    }, { 'attempt-1': { status: 'completed' } })
    const release = vi.fn()
    const service = ctx.yuqiTeamOrchestrator as unknown as {
      automaticRetries: { retry(request: unknown, journal: unknown): Promise<Projection> }
      projectionForTeam(journal: unknown, teamId: string): Projection
      acquireRunnerWakeLease(key: string, reason: string): { wake(): unknown; release(): void }
      wakeTeamRunner(journal: unknown, teamId: string, reason: string, lease?: unknown): void
      retryFailedVerification(request: {
        controller: Agent; teamId: string; taskId: string; attemptId: string;
        verificationId: string; verdictOperationId: string;
      }): Promise<Projection>
    }
    const projectionForTeam = vi.spyOn(service, 'projectionForTeam').mockReturnValue(running)
    const acquire = vi.spyOn(service, 'acquireRunnerWakeLease').mockReturnValue({ wake: vi.fn(), release })
    const wake = vi.spyOn(service, 'wakeTeamRunner').mockImplementation(() => undefined)
    const retry = vi.spyOn(service.automaticRetries, 'retry').mockResolvedValue(running)
    const request = {
      controller: harness.agent, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
      verificationId: 'verification-1', verdictOperationId: 'verdict-operation-1',
    }

    await expect(service.retryFailedVerification(request)).resolves.toBe(running)
    expect(acquire).toHaveBeenCalledOnce()
    expect(wake).toHaveBeenCalledWith(expect.anything(), 'team-1', 'automatic retry', expect.anything())
    expect(release).toHaveBeenCalledOnce()

    projectionForTeam.mockReturnValue(paused)
    retry.mockResolvedValue(paused)
    acquire.mockClear()
    wake.mockClear()
    release.mockClear()
    await expect(service.retryFailedVerification(request)).resolves.toBe(paused)
    expect(acquire).not.toHaveBeenCalled()
    expect(wake).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('settles the final child into paused or cancelled during an in-flight control operation', async () => {
    async function settleControl(target: 'pausing' | 'cancelling') {
      const ctx = new Context()
      const harness = fakeController(Session.create(SessionId(`controller-settle-${target}`)), ctx)
      for (const fact of completeTeamEvents().slice(0, 8)) {
        harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
      }
      harness.agent.session.append(TEAM_SESSION_EVENT, { event: event(54, {
        type: 'yuqi/team-status-changed', from: 'running', to: target,
      }) })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const service = ctx.yuqiTeamOrchestrator as unknown as { settleObservedAttempt(request: unknown): Promise<void> }
      const journal = new HarnessSessionJournal(harness.agent.session, ctx.sessions)

      await service.settleObservedAttempt({
        journal, teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1',
        end: {
          childSessionId: 'session-worker-1', runId: `run-${target}`, provider: 'in-process',
          stopReason: target === 'cancelling' ? 'aborted' : 'error', hasAssistantOutput: false,
          settledAt: '2026-08-30T00:00:00Z',
        },
      })
      const projection = replayTeamEvents(journal.read())
      expect(projection.team.status).toBe(target === 'cancelling' ? 'cancelled' : 'paused')
      expect(projection.tasks['task-1']?.status).toBe(target === 'cancelling' ? 'cancelled' : 'failed')
      await fiber.dispose()
    }

    await settleControl('pausing')
    await settleControl('cancelling')
  })
})

describe('Harness service public routing and dormant controller branches', () => {
  async function routedService(
    label: string,
    modelRequest: { readonly kind: string; readonly [key: string]: unknown },
    teamPolicy: { readonly kind: string; readonly [key: string]: unknown },
    resolvable: readonly string[],
  ) {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId(`controller-route-${label}`)), ctx)
    const task = { ...contract() } as Record<string, unknown>
    delete task.modelId
    task.modelRequest = modelRequest
    for (const fact of [
      event(61, {
        type: 'yuqi/team-created', title: `Route ${label}`, objective: 'Resolve through the public Host service',
        controllerModel: { provider: 'controller-provider', model: 'controller-model' },
        modelRouting: {
          providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] },
          teamPolicy,
        },
      } as never),
      event(62, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(63, { type: 'yuqi/task-created', contract: task } as never),
    ]) harness.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    ;(ctx.llm as unknown as {
      resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ provider: string; id: string; name: string }>
    }).resolveModelInfo = async (provider, model, signal) => {
      signal?.throwIfAborted()
      if (!resolvable.includes(`${provider}/${model}`)) throw new Error('catalog miss')
      return { provider, id: model, name: `${provider}/${model}` }
    }
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    return { ctx, harness, fiber }
  }

  it('resolves exact, automatic, controller-inherited, and exhausted-catalog routes with durable evidence', async () => {
    const exact = await routedService(
      'exact',
      { kind: 'exact', model: { modelProvider: 'external-provider', modelId: 'exact-model' } },
      { kind: 'inherit' },
      ['controller-provider/controller-model', 'external-provider/exact-model'],
    )
    await expect(exact.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: exact.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'external-provider', modelId: 'exact-model' }, routeBasis: 'task-exact',
      catalogEvidence: expect.arrayContaining([
        { model: { modelProvider: 'external-provider', modelId: 'exact-model' }, metadataResolved: true, routable: true },
      ]),
    })
    await exact.fiber.dispose()

    const automatic = await routedService(
      'automatic',
      { kind: 'tier', tier: 'critical' },
      { kind: 'automatic', tierCandidates: {
        quick: [], standard: [], critical: [
          { modelProvider: 'controller-provider', modelId: 'missing-model' },
          { modelProvider: 'controller-provider', modelId: 'selected-model' },
        ],
      } },
      ['controller-provider/controller-model', 'controller-provider/selected-model'],
    )
    await expect(automatic.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: automatic.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'selected-model' },
      routeBasis: 'automatic', requestedTier: 'critical',
      catalogEvidence: expect.arrayContaining([
        { model: { modelProvider: 'controller-provider', modelId: 'missing-model' }, metadataResolved: false, routable: false },
      ]),
    })
    await automatic.fiber.dispose()

    const automaticDefault = await routedService(
      'automatic-default',
      { kind: 'default' },
      { kind: 'automatic', tierCandidates: {
        quick: [], standard: [{ modelProvider: 'controller-provider', modelId: 'standard-model' }], critical: [],
      } },
      ['controller-provider/controller-model', 'controller-provider/standard-model'],
    )
    await expect(automaticDefault.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: automaticDefault.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'standard-model' },
      routeBasis: 'automatic', requestedTier: 'standard',
    })
    await automaticDefault.fiber.dispose()

    const inherited = await routedService(
      'inherited', { kind: 'default' }, { kind: 'inherit' }, ['controller-provider/controller-model'],
    )
    await expect(inherited.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: inherited.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'controller-model' },
      routeBasis: 'controller-inherit', fallbackReason: 'task-default-controller-inherit',
    })
    await inherited.fiber.dispose()

    const exhausted = await routedService(
      'exhausted',
      { kind: 'tier', tier: 'quick' },
      { kind: 'automatic', tierCandidates: {
        quick: [{ modelProvider: 'external-provider', modelId: 'missing-model' }], standard: [], critical: [],
      } },
      ['controller-provider/controller-model'],
    )
    await expect(exhausted.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: exhausted.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({
      route: { modelProvider: 'controller-provider', modelId: 'controller-model' },
      routeBasis: 'controller-inherit', requestedTier: 'quick', fallbackReason: 'automatic-candidates-exhausted',
      catalogEvidence: expect.arrayContaining([
        { model: { modelProvider: 'controller-provider', modelId: 'controller-model' }, metadataResolved: true, routable: true },
      ]),
    })
    await exhausted.fiber.dispose()
  })

  it('wraps deterministic catalog route failures at the service boundary and preserves their cause', async () => {
    const missing = await routedService(
      'missing-exact',
      { kind: 'exact', model: { modelProvider: 'external-provider', modelId: 'missing-model' } },
      { kind: 'inherit' },
      ['controller-provider/controller-model'],
    )
    await expect(missing.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: missing.harness.agent, teamId: 'team-1', taskId: 'task-1',
    })).rejects.toMatchObject({ code: 'FIXED_MODEL_UNAVAILABLE', cause: { code: 'TASK_MODEL_UNRESOLVED' } })
    await expect(missing.ctx.yuqiTeamOrchestrator.resolveTaskModelRoute({
      controller: missing.harness.agent, teamId: 'team-1', taskId: 'missing-task',
    })).rejects.toMatchObject({ code: 'INVALID_BATCH' })
    await missing.fiber.dispose()
  })

  function bindDormantSession(session: Session, parentSessionId: string): void {
    session.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId, generation: 1, operationId: `bind-${String(session.id)}`, boundAt: '2026-08-31T00:00:00Z',
    })
  }

  it('returns undefined for missing dormant sessions and rejects both actions for a stale parent binding', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('controller-dormant-binding'))
    const harness = fakeController(session, ctx)
    bindDormantSession(session, 'active-parent')
    for (const fact of completeTeamEvents().slice(0, 4)) session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    for (const action of ['cancel', 'reconcile'] as const) {
      await expect(ctx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: 'missing-dormant-controller', parentSessionId: 'active-parent', teamId: 'team-1',
        operationId: `missing-${action}`, action,
      })).resolves.toBeUndefined()
      await expect(ctx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: String(harness.agent.id), parentSessionId: 'stale-parent', teamId: 'team-1',
        operationId: `mismatch-${action}`, action,
      })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    }
    await fiber.dispose()
  })

  it('cancels a dormant Team directly and closes a cancelling Team with zero unresolved attempts', async () => {
    async function cancelCase(label: string, alreadyCancelling: boolean) {
      const ctx = new Context()
      const session = Session.create(SessionId(`controller-dormant-cancel-${label}`))
      const harness = fakeController(session, ctx)
      const parentSessionId = `parent-${label}`
      bindDormantSession(session, parentSessionId)
      for (const fact of completeTeamEvents().slice(0, 4)) session.append(TEAM_SESSION_EVENT, { event: fact })
      if (alreadyCancelling) session.append(TEAM_SESSION_EVENT, { event: event(64, { type: 'yuqi/team-status-changed', from: 'running', to: 'cancelling' }) })
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      const result = await ctx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: String(harness.agent.id), parentSessionId, teamId: 'team-1',
        operationId: `dormant-${label}`, action: alreadyCancelling ? 'reconcile' : 'cancel',
      })
      expect(result).toMatchObject({ team: { status: 'cancelled' }, tasks: { 'task-1': { status: 'cancelled' } } })
      expect(Object.values(result?.attempts ?? {})).toHaveLength(0)
      await fiber.dispose()
    }

    await cancelCase('direct', false)
    await cancelCase('zero-unresolved', true)
  })

  it('settles a quiescent running dormant Team through the public reconcile path', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('controller-dormant-quiescent'))
    const harness = fakeController(session, ctx)
    const parentSessionId = 'parent-dormant-quiescent'
    bindDormantSession(session, parentSessionId)
    for (const fact of completeTeamEvents().slice(0, -1)) session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    const result = await ctx.yuqiTeamOrchestrator.controlDormantTeam({
      controllerSessionId: String(harness.agent.id), parentSessionId, teamId: 'team-1',
      operationId: 'dormant-quiescent-reconcile', action: 'reconcile',
    })
    expect(result).toMatchObject({ team: { status: 'completed' }, tasks: { 'task-1': { status: 'completed' } } })
    expect(Object.values(result?.attempts ?? {}).every(attempt => !['dispatching', 'running', 'unknown'].includes(attempt.status))).toBe(true)
    await fiber.dispose()
  })

  it.each(['proven', 'unsafe', 'live', 'no-cancel'] as const)('reconciles cancellation without restarting children: %s', async kind => {
    const ctx = new Context()
    const session = Session.create(SessionId(`controller-stop-${kind}`))
    const harness = fakeController(session, ctx)
    bindDormantSession(session, 'parent-stop')
    for (const fact of completeTeamEvents().slice(0, 8)) session.append(TEAM_SESSION_EVENT, { event: fact })
    vi.spyOn(ctx.subagents, 'listChildren').mockResolvedValue([{
      kind: 'child', id: SessionId('session-worker-1'), mode: 'continuable',
      activity: kind === 'live' ? 'running' : 'inactive', hasChildren: false, label: 'worker',
    }])
    const proof = vi.spyOn(HarnessAttemptResolutionSafetyPort.prototype, 'assertQuiescent').mockImplementation(async request => {
      if (kind === 'unsafe') throw new Error('child became active during proof')
      return {
        principal: { kind: 'controller-session', sessionId: String(session.id) },
        observationState: 'durable', childQuiescent: true, localInFlight: false,
        gitVerified: true, leaseIds: [...request.leaseIds ?? []],
      }
    })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    try {
      if (kind !== 'no-cancel') await ctx.yuqiTeamOrchestrator.controlDormantTeam({
        controllerSessionId: String(session.id), parentSessionId: 'parent-stop', teamId: 'team-1',
        action: 'cancel', operationId: 'stop-intent',
      })
      const request = {
        controllerSessionId: String(session.id), parentSessionId: 'parent-stop', teamId: 'team-1',
        action: 'reconcile' as const, operationId: 'stop-scan',
      }
      if (kind === 'unsafe') {
        await expect(ctx.yuqiTeamOrchestrator.controlDormantTeam(request)).rejects.toMatchObject({ code: 'RESOLUTION_UNSAFE' })
      } else {
        const result = await ctx.yuqiTeamOrchestrator.controlDormantTeam(request)
        expect(result?.team.status).toBe(kind === 'proven' ? 'cancelled' : 'needs_reconciliation')
        if (kind === 'proven') {
          expect(result?.attempts['attempt-1']?.status).toBe('cancelled')
          expect(result?.tasks['task-1']?.status).toBe('cancelled')
        } else expect(proof).not.toHaveBeenCalled()
      }
      expect(harness.starts).toHaveLength(0)
    } finally {
      proof.mockRestore()
      await fiber.dispose()
    }
  })
})

describe('Harness review and rework controller service branches', () => {
  it('skips reviewer dispatch at simple, active-attempt, and no-candidate boundaries', async () => {
    const simpleContext = new Context()
    const simple = fakeController(Session.create(SessionId('controller-review-simple-skip')), simpleContext)
    for (const fact of completeTeamEvents()) simple.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    const simpleFiber = await simpleContext.plugin(YuqiTeamOrchestratorService)
    await expect(simpleContext.yuqiTeamOrchestrator.reviewTeam({
      controller: simple.agent, teamId: 'team-1', trigger: 'pre-completion', reviewId: 'simple-skip',
    })).resolves.toMatchObject({ status: 'skipped', reviewId: 'simple-skip', reason: expect.stringContaining('简单单任务') })
    await simpleFiber.dispose()

    const activeContext = new Context()
    const active = fakeController(Session.create(SessionId('controller-review-active-skip')), activeContext)
    for (const fact of completeTeamEvents().slice(0, 8)) active.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    const activeFiber = await activeContext.plugin(YuqiTeamOrchestratorService)
    await expect(activeContext.yuqiTeamOrchestrator.reviewTeam({
      controller: active.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'active-skip',
    })).resolves.toMatchObject({ status: 'skipped', reviewId: 'active-skip', reason: expect.stringContaining('活动中的子 Agent') })
    await activeFiber.dispose()

    const pendingContext = new Context()
    const pending = fakeController(Session.create(SessionId('controller-review-pending-skip')), pendingContext)
    for (const fact of completeTeamEvents().slice(0, 4)) pending.agent.session.append(TEAM_SESSION_EVENT, { event: fact })
    const pendingFiber = await pendingContext.plugin(YuqiTeamOrchestratorService)
    await expect(pendingContext.yuqiTeamOrchestrator.reviewTeam({
      controller: pending.agent, teamId: 'team-1', trigger: 'user-request', reviewId: 'pending-skip',
    })).resolves.toMatchObject({ status: 'skipped', reviewId: 'pending-skip', reason: expect.stringContaining('durable completion candidate') })
    await pendingFiber.dispose()
  })

  it('creates one bounded review-rework task from a durable failed quality-gate verdict', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('controller-review-rework-service'))
    const harness = fakeController(session, ctx)
    const source = completeTeamEvents()
    for (const fact of [
      event(71, {
        type: 'yuqi/team-created', title: 'Review rework service', objective: 'Create bounded rework',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...source.slice(1, -1),
      event(72, { type: 'yuqi/review-requested', reviewId: 'service-rework-review', trigger: 'quality-gate', candidateEventId: TeamEventId('event-16'), round: 0 }),
      event(73, {
        type: 'yuqi/review-result-recorded', reviewId: 'service-rework-review', candidateEventId: TeamEventId('event-16'),
        reviewerSessionId: 'reviewer-service-rework', decision: 'changes_required',
        findings: [{ severity: 'high', evidence: ['src/service.ts:1'], impact: 'Public branch is uncovered', recommendation: 'Add regression coverage' }],
        unverified: [],
      }),
    ]) session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const journal = new HarnessSessionJournal(session, ctx.sessions)

    await ctx.yuqiTeamOrchestrator.coordinateCompletion({
      controller: harness.agent, teamId: 'team-1', journal, signal: new AbortController().signal,
    })
    await ctx.yuqiTeamOrchestrator.coordinateCompletion({
      controller: harness.agent, teamId: 'team-1', journal, signal: new AbortController().signal,
    })
    const projection = replayTeamEvents(journal.read())
    const reworkTasks = projection.taskIds.filter(taskId => projection.tasks[taskId]?.contract.kind === 'review-rework')
    expect(reworkTasks).toEqual(['review-rework:service-rework-review:1'])
    expect(projection.tasks[reworkTasks[0]!]?.contract).toMatchObject({
      reviewRework: { sourceReviewId: 'service-rework-review', round: 1 },
      acceptanceCriteria: ['Add regression coverage'],
    })
    await fiber.dispose()
  })

  it.each(['fail', 'cancel'] as const)('persists terminal %s review decisions through the service', async decision => {
    const ctx = new Context()
    const session = Session.create(SessionId(`controller-review-decision-${decision}`))
    const harness = fakeController(session, ctx)
    const source = completeTeamEvents()
    for (const fact of [
      event(81, {
        type: 'yuqi/team-created', title: 'Review decision', objective: 'Persist terminal decision',
        reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' },
      }),
      ...source.slice(1, -1),
      event(82, { type: 'yuqi/review-requested', reviewId: `review-${decision}`, trigger: 'quality-gate', candidateEventId: TeamEventId('event-16'), round: 0 }),
      event(83, {
        type: 'yuqi/review-result-recorded', reviewId: `review-${decision}`, candidateEventId: TeamEventId('event-16'),
        reviewerSessionId: 'reviewer-terminal', decision: 'inconclusive', findings: [], unverified: ['user decision required'],
      }),
    ]) session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)

    const request = {
      controller: harness.agent, teamId: 'team-1', operationId: `decision-${decision}`,
      reviewId: `review-${decision}`, candidateEventId: TeamEventId('event-16'), round: 0, decision,
    } as const
    const result = await ctx.yuqiTeamOrchestrator.decideReview(request)
    expect(result.team.status).toBe(decision === 'cancel' ? 'cancelled' : 'failed')
    expect(result.reviewUserDecisionOperations[`decision-${decision}`]).toMatchObject({ decision })
    await fiber.dispose()
  })
})

describe('Harness service second-pass public branch matrix', () => {
  it('materializes schedule transitions and rejects every stale public schedule shape', async () => {
    const ctx = new Context()
    const harness = fakeController(Session.create(SessionId('controller-schedule-public-matrix')), ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator

    const scheduleSession = Session.create(SessionId('schedule-public-matrix'))
    for (const fact of [
      event(31, { type: 'yuqi/team-created', title: 'Schedule matrix', objective: 'Cover public schedule states' }),
      event(32, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
      event(33, { type: 'yuqi/task-created', contract: contract(TaskId('pending-task')) }),
      event(34, { type: 'yuqi/task-created', contract: contract(TaskId('blocked-task')) }),
      event(35, { type: 'yuqi/task-status-changed', taskId: TaskId('blocked-task'), from: 'pending', to: 'blocked', reason: 'old block' }),
    ]) scheduleSession.append(TEAM_SESSION_EVENT, { event: fact })
    const journal = new HarnessSessionJournal(scheduleSession, ctx.sessions)
    const cut = replayTeamEvents(journal.read())
    const plan = {
      status: 'runnable' as const,
      activeTaskIds: [], readyTaskIds: [], blockedTaskIds: [TaskId('pending-task')],
      newlyBlockedTaskIds: [TaskId('pending-task')], unblockedTaskIds: [TaskId('blocked-task')],
      dispatchTaskIds: [], availableSlots: 1,
      sourceLastEventAt: cut.lastEventAt, sourceLastEventId: cut.lastEventId,
    }
    const signal = new AbortController().signal

    await expect(service.persistScheduleState({
      teamId: 'wrong-team', journal, plan, taskTransitions: [], requiresReconciliation: false, signal,
    })).rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(service.persistScheduleState({
      teamId: 'team-1', journal, plan: { ...plan, sourceLastEventId: 'stale' }, taskTransitions: [], requiresReconciliation: false, signal,
    })).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })
    await expect(service.persistScheduleState({
      teamId: 'team-1', journal, plan,
      taskTransitions: [{ taskId: 'missing-task', from: 'pending', to: 'blocked', reason: 'missing' }],
      requiresReconciliation: false, signal,
    })).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })
    await expect(service.persistScheduleState({
      teamId: 'team-1', journal, plan,
        taskTransitions: [{ taskId: 'blocked-task', from: 'pending', to: 'ready', reason: 'wrong source' } as never],
      requiresReconciliation: false, signal,
    })).rejects.toMatchObject({ code: 'STALE_SCHEDULE' })

    await expect(service.persistScheduleState({
      teamId: 'team-1', journal, plan,
      taskTransitions: [
        { taskId: 'pending-task', from: 'pending', to: 'blocked', reason: 'dependency failed' },
        { taskId: 'blocked-task', from: 'blocked', to: 'pending', reason: 'dependency cleared' },
      ],
      requiresReconciliation: false, signal,
    })).resolves.toBeUndefined()
    const transitioned = replayTeamEvents(journal.read())
    expect(transitioned.tasks['pending-task']?.status).toBe('blocked')
    expect(transitioned.tasks['blocked-task']?.status).toBe('pending')

    await fiber.dispose()
  })

  it('rebinds through durable public persistence and rejects invalid parent destinations', async () => {
    const cwd = path.resolve(process.cwd())
    const oldParentId = SessionId('rebind-public-old')
    const controllerId = SessionId('rebind-public-controller')
    const destinationId = SessionId('rebind-public-destination')
    const oldParent = Session.create(oldParentId, [], { version: 0, id: oldParentId, createdAt: 0, cwd })
    const controllerSession = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, cwd, parentSession: oldParentId })
    const destinationSession = Session.create(destinationId, [], { version: 0, id: destinationId, createdAt: 0, cwd })
    for (const fact of completeTeamEvents()) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
    controllerSession.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(oldParentId), generation: 1, operationId: 'rebind-seed', boundAt: '2026-08-31T00:00:00Z',
    })
    const sessions = new Map([[String(oldParentId), oldParent], [String(controllerId), controllerSession], [String(destinationId), destinationSession]])
    const durable = new Map<string, { meta: Session['header']; events: readonly SessionEvent[] }>([
      [String(oldParentId), { meta: oldParent.header, events: oldParent.events }],
      [String(controllerId), { meta: controllerSession.header, events: controllerSession.events }],
    ])
    const ctx = new Context()
    ctx.provide('sessions', { get: (id: SessionId) => sessions.get(String(id)), flush: async () => true } as never)
    ctx.provide('sessionPersistence', {
      list: async () => [...durable.values()].map(value => value.meta),
      create: async (meta: Session['header']) => { durable.set(String(meta.id), { meta, events: [] }) },
      append: async (id: Session['id'], events: readonly SessionEvent[]) => {
        const current = durable.get(String(id))!
        durable.set(String(id), { ...current, events: [...current.events, ...events] })
      },
      readFrom: async (id: Session['id'], from: number) => ({ events: durable.get(String(id))!.events.slice(from) }),
    } as never)
    fakeController(controllerSession, ctx)
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const controller = { id: controllerId, session: controllerSession, options: {}, ctx } as unknown as Agent
    const destination = { id: destinationId, session: destinationSession, options: {}, ctx } as unknown as Agent

    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'wrong-team', parent: destination, operationId: 'rebind-wrong-team' }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'team-1', parent: controller, operationId: 'rebind-self' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    const nestedId = SessionId('rebind-public-nested')
    const nestedSession = Session.create(nestedId, [], { version: 0, id: nestedId, createdAt: 0, cwd, parentSession: destinationId })
    const nested = { id: nestedId, session: nestedSession, options: {}, ctx } as unknown as Agent
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'team-1', parent: nested, operationId: 'rebind-nested' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    const otherId = SessionId('rebind-public-other')
    const otherSession = Session.create(otherId, [], { version: 0, id: otherId, createdAt: 0, cwd: path.parse(cwd).root })
    const other = { id: otherId, session: otherSession, options: {}, ctx } as unknown as Agent
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'team-1', parent: other, operationId: 'rebind-other-project' }))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })

    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'team-1', parent: destination, operationId: 'rebind-public-success' }))
      .resolves.toBeUndefined()
    expect(readActiveTeamParentBinding(controllerSession)?.parentSessionId).toBe(String(destinationId))
    expect(durable.get(String(destinationId))?.events).toHaveLength(1)
    await expect(ctx.yuqiTeamOrchestrator.rebindTeam({ controller, teamId: 'team-1', parent: destination, operationId: 'rebind-public-existing' }))
      .resolves.toBeUndefined()
    await fiber.dispose()
  })

  it('projects every bounded public task-report shape and validates request cancellation', async () => {
    async function reports(label: string, facts: readonly ReturnType<typeof event>[], childOutput?: string) {
      const ctx = new Context()
      const session = Session.create(SessionId(`reports-${label}`))
      const harness = fakeController(session, ctx)
      for (const fact of facts) session.append(TEAM_SESSION_EVENT, { event: fact })
      if (childOutput !== undefined) {
        const child = Session.create(SessionId('session-worker-1'))
        child.append('assistant/message', {
          turn: 1, step: 1, message: createMessage({
            role: 'assistant', content: [{ type: 'text', text: childOutput }],
            source: { kind: 'model', provider: 'in-process', model: 'deepseek-v4' },
          }),
        }, { surfaceOp: 'append' })
        harness.registerSession(child)
      }
      const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
      return { ctx, harness, fiber }
    }

    const pending = await reports('pending', completeTeamEvents().slice(0, 3))
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({ controller: pending.harness.agent, teamId: 'team-1' }))
      .resolves.toEqual([{ taskId: 'task-1', status: 'pending' }])
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({ controller: pending.harness.agent, teamId: 'wrong-team' }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })
    const aborted = new AbortController(); aborted.abort()
    await expect(pending.ctx.yuqiTeamOrchestrator.readTeamTaskReports({ controller: pending.harness.agent, teamId: 'team-1', signal: aborted.signal }))
      .rejects.toThrow()
    await pending.fiber.dispose()

    const running = await reports('running', completeTeamEvents().slice(0, 8), 'bounded child report')
    await expect(running.ctx.yuqiTeamOrchestrator.readTeamTaskReports({ controller: running.harness.agent, teamId: 'team-1' }))
      .resolves.toEqual([expect.objectContaining({ taskId: 'task-1', status: 'running', agentSessionId: 'session-worker-1', output: 'bounded child report', truncated: false })])
    await running.fiber.dispose()

  })

  it('covers public model, message, review, and bootstrap validation fallbacks', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('controller-public-validation-matrix'))
    const harness = fakeController(session, ctx)
    for (const fact of completeTeamEvents().slice(0, 4)) session.append(TEAM_SESSION_EVENT, { event: fact })
    const fiber = await ctx.plugin(YuqiTeamOrchestratorService)
    const service = ctx.yuqiTeamOrchestrator

    await expect(service.setTaskModel({ controller: harness.agent, teamId: 'team-1', taskId: 'task-1', modelId: 'model', providerId: ' ', operationId: 'model-empty-provider' }))
      .rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
    await expect(service.sendTaskMessage({ controller: harness.agent, teamId: 'team-1', taskId: 'task-1', message: 'hello', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'RETRY_NOT_ALLOWED' })
    await expect(service.sendTaskMessage({ controller: harness.agent, teamId: 'team-1', taskId: 'task-1', message: 'x'.repeat(16_385), signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'INVALID_BATCH' })
    await expect(service.reviewTeam({ controller: harness.agent, teamId: 'wrong-team', trigger: 'user-request' }))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const legacySession = Session.create(SessionId('controller-legacy-route-public'))
    harness.registerSession(legacySession)
    const legacyHarness = { agent: { ...harness.agent, id: legacySession.id, session: legacySession, ctx } as unknown as Agent }
    for (const fact of completeTeamEvents().slice(0, 4)) legacySession.append(TEAM_SESSION_EVENT, { event: fact })
    await expect(service.resolveTaskModelRoute({ controller: legacyHarness.agent, teamId: 'team-1', taskId: 'task-1' })).resolves.toBeUndefined()

    const bootstrapSession = Session.create(SessionId('controller-bootstrap-options-public'))
    harness.registerSession(bootstrapSession)
    const bootstrapHarness = { agent: { ...harness.agent, id: bootstrapSession.id, session: bootstrapSession, ctx } as unknown as Agent }
    await expect(service.bootstrapTeam({
      controller: bootstrapHarness.agent, teamId: 'bootstrap-options-team', title: 'Bootstrap options', objective: 'Cover optional public facts',
      controllerModel: { provider: 'deepseek', model: 'deepseek-v4' }, directWriteStrategy: 'planned-scope-parallel',
      reviewPolicy: { mode: 'off', maxReworkRounds: 0, additionalPrompt: '' },
      modelRouting: { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'inherit' } },
      tasks: [contract(TaskId('bootstrap-options-task'))],
    } as never)).resolves.toBeDefined()
    await fiber.dispose()
  })
})
