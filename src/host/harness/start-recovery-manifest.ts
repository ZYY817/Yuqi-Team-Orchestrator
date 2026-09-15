/** Host-owned, exact-identity recovery handles for pre-durable Team starts. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ProjectIdentity } from '../../domain/workspace.ts'
import { assertSafeGitWorkspaceDestination } from '../git/git-workspace.ts'

const execFileAsync = promisify(execFile)
const MANIFEST_DIRECTORY = '.yuqi-start-recovery'
const GIT_TIMEOUT_MS = 15_000
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024

const recoveryPhaseSchema = z.enum([
  'planned',
  'workspace-provisioned',
  'controller-launching',
  'controller-launched',
  'bootstrap-failed',
  'team-bootstrapped',
  'durable-confirming',
  'confirmation-failed',
  'completed',
  'cleaned',
])
export type StartTeamRecoveryPhase = z.infer<typeof recoveryPhaseSchema>

const recoveryManifestSchema = z.object({
  schemaVersion: z.literal(1),
  recoveryId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
  ownerProof: z.string().uuid(),
  phase: recoveryPhaseSchema,
  teamId: z.string().min(1).max(128),
  workspaceId: z.string().min(1).max(128),
  projectRoot: z.string().min(1),
  repositoryRoot: z.string().min(1),
  gitCommonDirectory: z.string().min(1),
  baselineRef: z.string().min(1),
  managedRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  branchName: z.string().regex(/^yuqi\/[A-Za-z0-9._-]{1,128}$/u),
  controllerSessionId: z.string().min(1).max(128).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict()

export type StartTeamRecoveryHandle = Readonly<z.infer<typeof recoveryManifestSchema>>

export interface StartTeamRecoveryPlan {
  readonly teamId: string
  readonly workspaceId: string
  readonly identity: ProjectIdentity
  readonly managedRoot: string
  readonly worktreePath: string
  readonly branchName: string
}

export interface StartTeamRecoveryStore {
  create(plan: StartTeamRecoveryPlan): Promise<StartTeamRecoveryHandle>
  advance(handle: StartTeamRecoveryHandle, phase: StartTeamRecoveryPhase, controllerSessionId?: string): Promise<StartTeamRecoveryHandle>
  list(managedRoot: string): Promise<readonly StartTeamRecoveryHandle[]>
}

export type StartTeamRecoveryReconciliation =
  | { readonly status: 'cleanup-ready'; readonly handle: StartTeamRecoveryHandle; readonly residue: 'none' | 'branch' | 'worktree-and-branch' }
  | { readonly status: 'manual'; readonly handle: StartTeamRecoveryHandle; readonly reason: string }

/**
 * The manifest is written before `git worktree add`. Cleanup never uses names,
 * prefixes, or directory scans as ownership proof: every Git fact must match
 * the exact Host-minted manifest and the worktree must still be clean.
 */
export class FilesystemStartTeamRecoveryStore implements StartTeamRecoveryStore {
  readonly #gitExecutable: string
  readonly #trustedOwners = new Map<string, StartTeamRecoveryHandle>()

  constructor(gitExecutable = 'git') {
    this.#gitExecutable = gitExecutable
  }

  async create(plan: StartTeamRecoveryPlan): Promise<StartTeamRecoveryHandle> {
    assertSafeManifestTarget(plan)
    // User-chosen roots must be proved before even the recovery manifest writes there.
    await assertSafeGitWorkspaceDestination(plan.identity, plan.managedRoot, plan.worktreePath)
    const now = new Date().toISOString()
    const handle = recoveryManifestSchema.parse({
      schemaVersion: 1,
      recoveryId: plan.teamId,
      ownerProof: randomUUID(),
      phase: 'planned',
      teamId: plan.teamId,
      workspaceId: plan.workspaceId,
      projectRoot: path.resolve(plan.identity.projectRoot),
      repositoryRoot: path.resolve(plan.identity.repositoryRoot),
      gitCommonDirectory: path.resolve(plan.identity.gitCommonDirectory),
      baselineRef: plan.identity.baselineRef,
      managedRoot: path.resolve(plan.managedRoot),
      worktreePath: path.resolve(plan.worktreePath),
      branchName: plan.branchName,
      createdAt: now,
      updatedAt: now,
    })
    await this.#write(handle, true)
    this.#trustedOwners.set(manifestPath(handle), Object.freeze(handle))
    return Object.freeze(handle)
  }

  async advance(
    handle: StartTeamRecoveryHandle,
    phase: StartTeamRecoveryPhase,
    controllerSessionId?: string,
  ): Promise<StartTeamRecoveryHandle> {
    const current = await this.#readExact(handle)
    if (!allowedRecoveryTransition(current.phase, phase)) {
      throw new Error(`Recovery phase cannot transition from ${current.phase} to ${phase}`)
    }
    const updated = recoveryManifestSchema.parse({
      ...current,
      phase,
      ...(controllerSessionId === undefined
        ? (current.controllerSessionId === undefined ? {} : { controllerSessionId: current.controllerSessionId })
        : { controllerSessionId }),
      updatedAt: new Date().toISOString(),
    })
    await this.#write(updated, false)
    this.#trustedOwners.set(manifestPath(updated), Object.freeze(updated))
    return Object.freeze(updated)
  }

  async list(managedRoot: string): Promise<readonly StartTeamRecoveryHandle[]> {
    const directory = manifestDirectory(managedRoot)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return []
    }
    const handles: StartTeamRecoveryHandle[] = []
    for (const name of names) {
      if (!/^[A-Za-z0-9._-]{1,128}\.json$/u.test(name)) continue
      try {
        const candidate = path.resolve(directory, name)
        if (!samePath(await realpath(candidate), candidate) || !samePath(await realpath(directory), directory)) continue
        const parsed = recoveryManifestSchema.parse(JSON.parse(await readFile(candidate, 'utf8')))
        if (!safeStoredManifestTarget(parsed, managedRoot) || !samePath(manifestPath(parsed), candidate)) continue
        if (parsed.phase !== 'completed' && parsed.phase !== 'cleaned') handles.push(Object.freeze(parsed))
      } catch {
        // A corrupt file is not a cleanup capability. Leave it untouched.
      }
    }
    return Object.freeze(handles)
  }

  async reconcile(handle: StartTeamRecoveryHandle): Promise<StartTeamRecoveryReconciliation> {
    const current = await this.#readExact(handle)
    if (!cleanupEligiblePhase(current.phase)) {
      return { status: 'manual', handle: current, reason: `Recovery phase ${current.phase} is not cleanup-eligible` }
    }
    const proof = await this.#gitProof(current)
    if (proof.status === 'manual') return { status: 'manual', handle: current, reason: proof.reason }
    return { status: 'cleanup-ready', handle: current, residue: proof.residue }
  }

  async cleanup(handle: StartTeamRecoveryHandle): Promise<StartTeamRecoveryHandle> {
    const reconciliation = await this.reconcile(handle)
    if (reconciliation.status !== 'cleanup-ready') throw new Error(reconciliation.reason)
    const current = reconciliation.handle
    // Re-run the proof immediately before mutation. Git's non-force remove and
    // branch -d add their own dirty/unmerged race barriers.
    const proof = await this.#gitProof(current)
    if (proof.status === 'manual') throw new Error(proof.reason)
    if (proof.residue === 'worktree-and-branch') {
      await this.#git(['-C', current.repositoryRoot, 'worktree', 'remove', current.worktreePath], [0])
    }
    if (proof.residue !== 'none') {
      await this.#git(['-C', current.repositoryRoot, 'branch', '-d', current.branchName], [0])
    }
    const after = await this.#gitProof(current)
    if (after.status === 'manual' || after.residue !== 'none') throw new Error('Cleanup postcondition could not prove the exact residue absent')
    return this.advance(current, 'cleaned')
  }

  async #gitProof(handle: StartTeamRecoveryHandle): Promise<
    | { readonly status: 'ready'; readonly residue: 'none' | 'branch' | 'worktree-and-branch' }
    | { readonly status: 'manual'; readonly reason: string }
  > {
    const registrations = parseWorktreeList((await this.#git([
      '-C', handle.repositoryRoot, 'worktree', 'list', '--porcelain', '-z',
    ], [0])).stdout)
    const registration = registrations.find(entry => samePath(entry.worktreePath, handle.worktreePath))
    const branchRef = `refs/heads/${handle.branchName}`
    const branch = await this.#git(['-C', handle.repositoryRoot, 'show-ref', '--verify', '--quiet', branchRef], [0, 1])
    const branchExists = branch.exitCode === 0
    const branchHead = branchExists
      ? (await this.#git(['-C', handle.repositoryRoot, 'rev-parse', '--verify', branchRef], [0])).stdout.trim()
      : undefined
    if (branchHead !== undefined && branchHead !== handle.baselineRef) {
      return { status: 'manual', reason: 'The owned branch no longer points at the recorded baseline' }
    }

    if (registration === undefined) {
      if (await exists(handle.worktreePath)) return { status: 'manual', reason: 'The recorded path exists without the exact Git worktree registration' }
      return { status: 'ready', residue: branchExists ? 'branch' : 'none' }
    }
    if (registration.head !== handle.baselineRef || registration.branch !== `refs/heads/${handle.branchName}` || !branchExists) {
      return { status: 'manual', reason: 'Git registration does not match the exact owner manifest' }
    }
    let resolved: string
    try { resolved = path.resolve(await realpath(handle.worktreePath)) } catch { return { status: 'manual', reason: 'The registered worktree path cannot be resolved' } }
    if (!samePath(resolved, handle.worktreePath)) return { status: 'manual', reason: 'The worktree path resolves through an alias' }
    const status = await this.#git(['-C', handle.worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], [0])
    if (status.stdout.length !== 0) return { status: 'manual', reason: 'The owned worktree contains changes and cannot be cleaned automatically' }
    return { status: 'ready', residue: 'worktree-and-branch' }
  }

  async #readExact(handle: StartTeamRecoveryHandle): Promise<StartTeamRecoveryHandle> {
    const expected = recoveryManifestSchema.parse(handle)
    const target = manifestPath(expected)
    const trusted = this.#trustedOwners.get(target)
    if (trusted === undefined || !sameRecoveryManifest(trusted, expected)) {
      throw new Error('Recovery owner proof is not trusted by this Host process')
    }
    const directory = manifestDirectory(expected.managedRoot)
    const targetStat = await lstat(target)
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1
      || !samePath(await realpath(target), target) || !samePath(await realpath(directory), directory)) {
      throw new Error('Recovery manifest path identity is no longer exact')
    }
    const stored = recoveryManifestSchema.parse(JSON.parse(await readFile(target, 'utf8')))
    if (!sameRecoveryManifest(stored, trusted)) {
      throw new Error('Recovery owner proof does not match the stored manifest')
    }
    return Object.freeze(stored)
  }

  async #write(handle: StartTeamRecoveryHandle, exclusive: boolean): Promise<void> {
    const directory = manifestDirectory(handle.managedRoot)
    await mkdir(directory, { recursive: true })
    const target = manifestPath(handle)
    if (exclusive) {
      await writeFile(target, `${JSON.stringify(handle)}\n`, { encoding: 'utf8', flag: 'wx' })
      return
    }
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(handle)}\n`, { encoding: 'utf8', flag: 'wx' })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async #git(argv: readonly string[], allowedExitCodes: readonly number[]): Promise<{ readonly stdout: string; readonly exitCode: number }> {
    try {
      const result = await execFileAsync(this.#gitExecutable, argv, {
        encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES, windowsHide: true,
      })
      return { stdout: result.stdout, exitCode: 0 }
    } catch (cause) {
      const failure = cause as Error & { readonly code?: number | string; readonly exitCode?: number | string; readonly stdout?: string }
      const rawExitCode = failure.exitCode ?? failure.code
      const exitCode = typeof rawExitCode === 'number'
        ? rawExitCode
        : typeof rawExitCode === 'string' && /^\d+$/u.test(rawExitCode)
          ? Number(rawExitCode)
          : undefined
      if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) {
        return { stdout: failure.stdout ?? '', exitCode }
      }
      throw new Error('Recovery Git proof failed')
    }
  }
}

interface WorktreeRegistration {
  readonly worktreePath: string
  readonly head?: string
  readonly branch?: string
}

function parseWorktreeList(value: string): readonly WorktreeRegistration[] {
  const records: WorktreeRegistration[] = []
  let current: { worktreePath?: string; head?: string; branch?: string } = {}
  const flush = () => {
    if (current.worktreePath !== undefined) records.push({
      worktreePath: current.worktreePath,
      ...(current.head === undefined ? {} : { head: current.head }),
      ...(current.branch === undefined ? {} : { branch: current.branch }),
    })
    current = {}
  }
  for (const field of value.split(/\0|\r?\n/u)) {
    if (field.startsWith('worktree ')) {
      flush()
      current.worktreePath = field.slice('worktree '.length)
    } else if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch ')) current.branch = field.slice('branch '.length)
  }
  flush()
  return records
}

function cleanupEligiblePhase(phase: StartTeamRecoveryPhase): boolean {
  return phase === 'planned' || phase === 'workspace-provisioned'
    || phase === 'bootstrap-failed' || phase === 'confirmation-failed'
}

const ALLOWED_RECOVERY_TRANSITIONS: Readonly<Record<StartTeamRecoveryPhase, readonly StartTeamRecoveryPhase[]>> = {
  planned: ['workspace-provisioned', 'cleaned'],
  'workspace-provisioned': ['controller-launching', 'cleaned'],
  'controller-launching': ['controller-launched', 'workspace-provisioned'],
  'controller-launched': ['bootstrap-failed', 'team-bootstrapped'],
  'bootstrap-failed': ['cleaned'],
  'team-bootstrapped': ['durable-confirming'],
  'durable-confirming': ['confirmation-failed', 'completed'],
  'confirmation-failed': ['cleaned'],
  completed: [],
  cleaned: [],
}

function allowedRecoveryTransition(from: StartTeamRecoveryPhase, to: StartTeamRecoveryPhase): boolean {
  return ALLOWED_RECOVERY_TRANSITIONS[from].includes(to)
}

function sameRecoveryManifest(left: StartTeamRecoveryHandle, right: StartTeamRecoveryHandle): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.recoveryId === right.recoveryId
    && left.ownerProof === right.ownerProof
    && left.phase === right.phase
    && left.teamId === right.teamId
    && left.workspaceId === right.workspaceId
    && samePath(left.projectRoot, right.projectRoot)
    && samePath(left.repositoryRoot, right.repositoryRoot)
    && samePath(left.gitCommonDirectory, right.gitCommonDirectory)
    && left.baselineRef === right.baselineRef
    && samePath(left.managedRoot, right.managedRoot)
    && samePath(left.worktreePath, right.worktreePath)
    && left.branchName === right.branchName
    && left.controllerSessionId === right.controllerSessionId
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
}

function safeStoredManifestTarget(handle: StartTeamRecoveryHandle, requestedManagedRoot: string): boolean {
  const managedRoot = path.resolve(requestedManagedRoot)
  const target = path.resolve(handle.worktreePath)
  return samePath(handle.managedRoot, managedRoot)
    && path.isAbsolute(handle.projectRoot)
    && path.isAbsolute(handle.repositoryRoot)
    && path.isAbsolute(handle.gitCommonDirectory)
    && samePath(path.dirname(target), managedRoot)
    && !pathsOverlap(target, handle.repositoryRoot)
    && !pathsOverlap(target, handle.gitCommonDirectory)
}

function manifestDirectory(managedRoot: string): string {
  return path.resolve(managedRoot, MANIFEST_DIRECTORY)
}

function manifestPath(handle: Pick<StartTeamRecoveryHandle, 'managedRoot' | 'recoveryId'>): string {
  return path.resolve(manifestDirectory(handle.managedRoot), `${handle.recoveryId}.json`)
}

function assertSafeManifestTarget(plan: StartTeamRecoveryPlan): void {
  const managedRoot = path.resolve(plan.managedRoot)
  const target = path.resolve(plan.worktreePath)
  if (!samePath(path.dirname(target), managedRoot)
    || !samePath(path.parse(target).root, plan.identity.volumeRoot)
    || pathsOverlap(target, plan.identity.repositoryRoot)
    || pathsOverlap(target, plan.identity.gitCommonDirectory)
    || plan.identity.protectedRoots.some(root => samePath(target, root) || isInside(target, root))) {
    throw new Error('Recovery manifest target is outside the proven managed workspace boundary')
  }
}

async function exists(input: string): Promise<boolean> {
  try { await lstat(input); return true } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return samePath(left, right) || isInside(left, right) || isInside(right, left)
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
