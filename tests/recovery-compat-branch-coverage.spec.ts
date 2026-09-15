import type { Agent } from '@deepseek-ai/dsh-agent'
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import { AttemptId, TaskId, WorkspaceId } from '../src/index.ts'
import type { TeamSchedulePlan } from '../src/application/schedule-team.ts'
import {
  archiveTerminalYuqiControllers,
} from '../src/host/harness/controller-archive.ts'
import {
  HarnessTeamRunCyclePort,
  type HarnessTeamRunServicePort,
} from '../src/host/harness/run-cycle.ts'
import {
  FilesystemStartTeamRecoveryStore,
  type StartTeamRecoveryPlan,
} from '../src/host/harness/start-recovery-manifest.ts'
import { TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, contract, event, TEAM_ID } from './fixtures.ts'

const childProcessMock = vi.hoisted(() => {
  const outcomes: Array<
    | { readonly stdout?: string }
    | { readonly error: { readonly code?: number | string; readonly exitCode?: number | string; readonly stdout?: string } }
  > = []
  const promisified = vi.fn(async () => {
    const outcome = outcomes.shift()
    if (outcome === undefined) throw new Error('Unexpected fake Git invocation')
    if ('error' in outcome) throw Object.assign(new Error('fake Git exit'), outcome.error)
    return { stdout: outcome.stdout ?? '', stderr: '' }
  })
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: promisified })
  return { execFile, outcomes, promisified }
})

vi.mock('node:child_process', () => ({ execFile: childProcessMock.execFile }))

type GitOutcome =
  | { readonly stdout?: string }
  | { readonly error: { readonly code?: number | string; readonly exitCode?: number | string; readonly stdout?: string } }

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  childProcessMock.execFile.mockReset()
  childProcessMock.promisified.mockClear()
  childProcessMock.outcomes.length = 0
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function queueGit(...outcomes: GitOutcome[]): void {
  childProcessMock.outcomes.push(...outcomes)
}

async function recoveryFixture(name: string): Promise<{
  readonly root: string
  readonly plan: StartTeamRecoveryPlan
  readonly manifestPath: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), `yuqi-compat-${name}-`))
  temporaryRoots.push(root)
  const projectRoot = path.join(root, 'repository')
  const managedRoot = path.join(root, 'managed')
  await mkdir(projectRoot)
  const plan: StartTeamRecoveryPlan = {
    teamId: `team-${name}`,
    workspaceId: `workspace-${name}`,
    identity: {
      projectRoot,
      repositoryRoot: projectRoot,
      gitCommonDirectory: path.join(projectRoot, '.git'),
      baselineRef: 'baseline-commit',
      volumeRoot: path.parse(root).root,
      protectedRoots: [],
    },
    managedRoot,
    worktreePath: path.join(managedRoot, `workspace-${name}`),
    branchName: `yuqi/${name}`,
  }
  return {
    root,
    plan,
    manifestPath: path.join(managedRoot, '.yuqi-start-recovery', `team-${name}.json`),
  }
}

function readyWithoutResidue(exitCode: number | string = 1): GitOutcome[] {
  return [{ stdout: '' }, { error: { exitCode } }]
}

describe('start recovery compatibility branches', () => {
  it('rejects exact and nested protected recovery targets', async () => {
    const fixture = await recoveryFixture('protected')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    await expect(store.create({
      ...fixture.plan,
      identity: { ...fixture.plan.identity, protectedRoots: [fixture.plan.worktreePath] },
    })).rejects.toThrow(/outside the proven managed workspace boundary/u)
    await expect(store.create({
      ...fixture.plan,
      identity: { ...fixture.plan.identity, protectedRoots: [fixture.plan.managedRoot] },
    })).rejects.toThrow(/outside the proven managed workspace boundary/u)
  })

  it('ignores a validly shaped manifest whose stored target escapes the requested root', async () => {
    const fixture = await recoveryFixture('stored-target')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    const stored = JSON.parse(await readFile(fixture.manifestPath, 'utf8')) as Record<string, unknown>
    stored.worktreePath = path.join(fixture.root, 'other-managed', 'workspace-stored-target')
    await writeFile(fixture.manifestPath, `${JSON.stringify(stored)}\n`, 'utf8')
    await expect(store.list(fixture.plan.managedRoot)).resolves.toEqual([])
    expect(handle.phase).toBe('planned')
  })

  it('rejects a manifest with a second hardlink before consulting Git', async () => {
    const fixture = await recoveryFixture('hardlink')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    await link(fixture.manifestPath, `${fixture.manifestPath}.linked`)
    await expect(store.reconcile(handle)).rejects.toThrow(/path identity is no longer exact/u)
    expect(childProcessMock.execFile).not.toHaveBeenCalled()
  })

  it('accepts a numeric-string allowed Git exit and defaults missing stdout', async () => {
    const fixture = await recoveryFixture('string-exit')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    queueGit(...readyWithoutResidue('1'))
    await expect(store.reconcile(handle)).resolves.toMatchObject({ status: 'cleanup-ready', residue: 'none' })
  })

  it('rejects a Git failure whose exit identity is not numeric', async () => {
    const fixture = await recoveryFixture('unknown-exit')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    queueGit({ stdout: '' }, { error: { code: 'ENOENT' } })
    await expect(store.reconcile(handle)).rejects.toThrow(/Recovery Git proof failed/u)
  })

  it('parses a worktree record without optional HEAD and branch fields fail-closed', async () => {
    const fixture = await recoveryFixture('partial-record')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    queueGit(
      { stdout: `worktree ${fixture.plan.worktreePath}\0` },
      { error: { exitCode: 1, stdout: '' } },
    )
    await expect(store.reconcile(handle)).resolves.toMatchObject({
      status: 'manual',
      reason: expect.stringMatching(/registration does not match/u),
    })
  })

  it('stops when the immediate pre-cleanup proof changes to manual', async () => {
    const fixture = await recoveryFixture('pre-cleanup-race')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    queueGit(
      ...readyWithoutResidue(),
      { stdout: '' },
      { stdout: '' },
      { stdout: 'different-commit\n' },
    )
    await expect(store.cleanup(handle)).rejects.toThrow(/no longer points/u)
  })

  it('enforces the cleanup postcondition after two clean proofs', async () => {
    const fixture = await recoveryFixture('post-cleanup-race')
    const store = new FilesystemStartTeamRecoveryStore('fake-git')
    const handle = await store.create(fixture.plan)
    queueGit(
      ...readyWithoutResidue(),
      ...readyWithoutResidue(),
      { stdout: '' },
      { stdout: '' },
      { stdout: 'different-commit\n' },
    )
    await expect(store.cleanup(handle)).rejects.toThrow(/postcondition could not prove/u)
  })
})

class Journal implements TeamEventJournal {
  readonly key = 'recovery-compat-journal'
  readonly events: TeamEvent[]
  constructor(events: readonly TeamEvent[]) { this.events = [...events] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

const taskId = TaskId('task-1')
const attemptId = AttemptId('attempt-compat')
const workspaceId = WorkspaceId('workspace-compat')
const controller = { options: { provider: 'deepseek' } } as Agent
const identities = {
  attemptId: () => attemptId,
  leaseId: () => 'lease-compat',
  verificationId: () => 'verification-compat',
  operationId: () => 'verdict-compat',
}

function runnableJournal(taskContract = contract()): Journal {
  const workspace = {
    workspaceId,
    project: {
      projectRoot: 'F:\\repo', repositoryRoot: 'F:\\repo', gitCommonDirectory: 'F:\\repo\\.git',
      baselineRef: 'commit-1', volumeRoot: 'F:\\', protectedRoots: [],
    },
    worktreePath: 'F:\\managed\\compat', branchName: 'yuqi/compat', status: 'provisioning' as const,
  }
  return new Journal([
    ...completeTeamEvents().slice(0, 2),
    event(30, { type: 'yuqi/task-created', contract: taskContract }),
    event(31, { type: 'yuqi/workspace-provisioning-started', workspace }),
    event(32, { type: 'yuqi/workspace-provisioned', workspaceId }),
  ])
}

const plan: TeamSchedulePlan = {
  status: 'runnable',
  activeTaskIds: [], readyTaskIds: [taskId], blockedTaskIds: [], newlyBlockedTaskIds: [], unblockedTaskIds: [],
  dispatchTaskIds: [taskId], availableSlots: 1,
  sourceLastEventAt: '2026-08-15T00:00:32Z', sourceLastEventId: 'event-32',
}

function runService(overrides: Partial<HarnessTeamRunServicePort>): HarnessTeamRunServicePort {
  return {
    async executeGatedBatch() { return { handles: [] } },
    async beginVerification() {},
    async collectVerificationEvidence() { return {} as never },
    evidenceCapabilities() { return [] },
    ...overrides,
  }
}

function batchRequest(journal: Journal) {
  return { teamId: TEAM_ID, journal, plan, signal: new AbortController().signal }
}

describe('run-cycle residual compatibility branches', () => {
  it('rejects a legacy durable task without a model id', async () => {
    const structuredContract = { ...contract(), modelRequest: { kind: 'default' as const } }
    delete structuredContract.modelId
    const source = runnableJournal(structuredContract)
    source.events[0] = event(1, {
      type: 'yuqi/team-created', title: 'Yuqi Team', objective: 'Build the plugin',
      controllerModel: { provider: 'deepseek', model: 'controller-model' },
      modelRouting: { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'inherit' } },
    })
    const port = new HarnessTeamRunCyclePort(runService({
      async resolveTaskModelRoute() {
        return {
          route: { modelProvider: 'deepseek', modelId: '' }, routeBasis: 'controller-inherit',
          catalogEvidence: [],
        }
      },
    }), { controller, identities })
    await expect(port.executeBatch(batchRequest(source))).rejects.toMatchObject({ code: 'FIXED_MODEL_INVALID' })
  })

  it('accepts a rejected admission after durable cancelled attempt and task facts', async () => {
    const source = runnableJournal()
    const admission = Promise.resolve().then(async () => {
      await source.commit([
        event(33, { type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready' }),
        event(34, { type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running' }),
        event(35, { type: 'yuqi/attempt-created', taskId, attemptId, ordinal: 1, modelProvider: 'deepseek', modelId: 'deepseek-v4' }),
        event(36, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'cancelled', reason: 'cancelled before admission' }),
        event(37, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: 'cancelled', reason: 'cancelled before admission' }),
      ])
      throw new Error('admission cancelled')
    })
    const port = new HarnessTeamRunCyclePort(runService({
      async executeGatedBatch() {
        return { handles: [{ taskId, attemptId, admission, settled: Promise.resolve() }] }
      },
    }), { controller, identities })
    await expect(port.executeBatch(batchRequest(source))).resolves.toBeUndefined()
  })

  it('fails closed if the Host handle disappears across the admission await', async () => {
    const source = runnableJournal()
    const handles: Array<{
      taskId: string
      attemptId: string
      admission: Promise<unknown>
      settled: Promise<unknown>
    }> = []
    const admission = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        handles.length = 0
        reject(new Error('lost handle'))
      }, 0)
    })
    handles.push({ taskId, attemptId, admission, settled: Promise.resolve() })
    const port = new HarnessTeamRunCyclePort(runService({
      async executeGatedBatch() { return { handles } },
    }), { controller, identities })
    await expect(port.executeBatch(batchRequest(source))).rejects.toThrow(/lost handle/u)
  })
})

describe('controller archive malformed compatibility envelopes', () => {
  it('retains malformed, null, empty-array, and non-array Team event envelopes', async () => {
    const archiveSession = vi.fn(async () => undefined)
    await expect(archiveTerminalYuqiControllers(
      { archiveSession },
      {
        async list() { return [{ id: 'yuqi-team-malformed', parentSession: 'parent' }] },
        async inspect() {
          return { events: [
            { type: 'other', data: null },
            { type: TEAM_SESSION_EVENT, data: null },
            { type: TEAM_SESSION_EVENT, data: { events: [] } },
            { type: TEAM_SESSION_EVENT, data: { events: 'not-an-array' } },
          ] }
        },
      },
      { get: () => undefined },
    )).resolves.toEqual([])
    expect(archiveSession).not.toHaveBeenCalled()
  })
})
