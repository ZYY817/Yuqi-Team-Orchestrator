/** Safe, narrow Git worktree adapter for the Developer Preview. */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  GitWorkspacePort,
  InspectGitProjectRequest,
  ProvisionTeamWorkspaceRequest,
  VerifyTeamWorkspaceRequest,
} from '../../application/workspace-ports.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import type { ProjectIdentity, TeamWorkspace } from '../../domain/workspace.ts'
import { projectIdentitySchema, teamWorkspaceSchema } from '../../domain/workspace.ts'
import { fileScopeMatchesPath } from '../../domain/file-scope.ts'
import { repositoryRelativeScopes } from '../workspace-project-root.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const RISKY_CORE_CONFIG = '^(core\\.fsmonitor|core\\.hooksPath)$'
const RISKY_LOCAL_FILTER_CONFIG = '^filter\\..*\\.(clean|smudge|process)$'

interface GitResult {
  readonly stdout: string
  readonly exitCode: number
}

interface ExecFileFailure extends Error {
  readonly code?: number | string
}

interface WorktreeRegistration {
  readonly path: string
  readonly head?: string
  readonly branch?: string
}

interface ActiveProvision {
  readonly signature: string
  readonly promise: Promise<TeamWorkspace>
}

/** Uses only `git` argument arrays; no shell command string is constructed. */
export class NodeGitWorkspacePort implements GitWorkspacePort {
  readonly #gitExecutable: string
  readonly #timeoutMs: number
  readonly #disabledHooksPath = path.join(tmpdir(), `yuqi-disabled-hooks-${randomUUID()}`)
  readonly #provisions = new Map<string, ActiveProvision>()
  readonly #workspaceOwners = new Map<string, string>()

  constructor(gitExecutable = 'git', timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer')
    this.#gitExecutable = gitExecutable
    this.#timeoutMs = timeoutMs
  }

  async inspect(request: InspectGitProjectRequest): Promise<ProjectIdentity> {
    const requestedRoot = await existingRealPath(request.projectRoot, 'projectRoot')
    const inside = await this.#git(['-C', requestedRoot, 'rev-parse', '--is-inside-work-tree'], request.signal)
    if (inside.stdout.trim() !== 'true') throw unsupported('The selected path is not a Git worktree')

    const repositoryRoot = await existingRealPath(
      (await this.#git(['-C', requestedRoot, 'rev-parse', '--show-toplevel'], request.signal)).stdout.trim(),
      'repositoryRoot',
    )
    if (!samePath(requestedRoot, repositoryRoot) && !isInside(repositoryRoot, requestedRoot)) {
      throw unsupported('The selected project directory must be inside the resolved Git repository')
    }

    const superproject = (await this.#git(['-C', repositoryRoot, 'rev-parse', '--show-superproject-working-tree'], request.signal)).stdout.trim()
    if (superproject !== '') throw unsupported('Submodules and superprojects are not supported in Developer Preview')
    const stagedEntries = (await this.#git(['-C', repositoryRoot, 'ls-files', '--stage', '-z'], request.signal)).stdout
    if (stagedEntries.split('\0').some(entry => entry.startsWith('160000 '))) {
      throw unsupported('Repositories containing submodules are not supported in Developer Preview')
    }

    await this.#assertNoExternalGitExecution(repositoryRoot, request.signal)

    const branch = await this.#git(['-C', repositoryRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], request.signal, [0, 1])
    if (branch.exitCode !== 0 || branch.stdout.trim() === '') throw unsupported('Detached HEAD is not supported in Developer Preview')

    const status = await this.#git(['-C', repositoryRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], request.signal)
    if (status.stdout.length > 0) {
      const dirtyPaths = parsePorcelainPaths(status.stdout)
      const visible = dirtyPaths.slice(0, 5).join(', ')
      const remainder = dirtyPaths.length > 5 ? ` (+${dirtyPaths.length - 5} more)` : ''
      throw unsupported(`Git isolation requires a clean repository. Commit, archive, or remove these changes first: ${visible}${remainder}. Current-project mode does not require Git cleanup`)
    }

    const baselineRef = (await this.#git(['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'], request.signal)).stdout.trim()
    const commonOutput = (await this.#git(['-C', repositoryRoot, 'rev-parse', '--git-common-dir'], request.signal)).stdout.trim()
    const commonCandidate = path.isAbsolute(commonOutput) ? commonOutput : path.resolve(repositoryRoot, commonOutput)
    const gitCommonDirectory = await existingRealPath(commonCandidate, 'gitCommonDirectory')
    const protectedRoots = await Promise.all(request.protectedRoots.map(root => normalizedPath(root)))
    const identity = projectIdentitySchema.parse({
      projectRoot: requestedRoot,
      repositoryRoot,
      gitCommonDirectory,
      baselineRef,
      volumeRoot: path.parse(repositoryRoot).root,
      protectedRoots,
    })
    Object.freeze(identity.protectedRoots)
    return Object.freeze(identity)
  }

  provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace> {
    const key = provisionResourceKey(request)
    const signature = provisionSignature(request)
    const owner = this.#workspaceOwners.get(key)
    if (owner !== undefined && owner !== signature) {
      return Promise.reject(new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'The managed worktree is already owned with another identity, baseline, branch, or workspace'))
    }
    const active = this.#provisions.get(key)
    if (active !== undefined) {
      if (active.signature !== signature) {
        return Promise.reject(new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'Another request is already provisioning this physical worktree target'))
      }
      return active.promise
    }

    const pending = this.#provision(request).then(result => {
      this.#workspaceOwners.set(key, signature)
      return result
    }).finally(() => {
      /* v8 ignore else -- A resource key is never replaced while its singleflight promise is active. */
      if (this.#provisions.get(key)?.promise === pending) this.#provisions.delete(key)
    })
    this.#provisions.set(key, { signature, promise: pending })
    return pending
  }

  /** Re-prove an existing durable workspace without creating, repairing, or deleting anything. */
  async verify(request: VerifyTeamWorkspaceRequest): Promise<TeamWorkspace> {
    const workspace = teamWorkspaceSchema.parse(request.workspace)
    if (workspace.status !== 'ready') {
      throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'Only a durable ready workspace can be verified for execution')
    }
    const provisionRequest = {
      identity: workspace.project,
      workspaceId: workspace.workspaceId,
      managedRoot: path.dirname(workspace.worktreePath),
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    const target = path.resolve(workspace.worktreePath)
    const key = provisionResourceKey(provisionRequest)
    const signature = provisionSignature(provisionRequest)
    const owner = this.#workspaceOwners.get(key)
    if (owner !== undefined && owner !== signature) {
      throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'The verified worktree is already owned by another workspace identity')
    }
    const claimed = owner === undefined
    if (claimed) this.#workspaceOwners.set(key, signature)
    try {
      // A single inspection already proves identity, registration, HEAD, branch and
      // dirty-scope facts from one verification pass. Repeating the whole pass is
      // not atomic and doubles Git subprocess pressure when several agents start.
      return await this.#inspectExisting(provisionRequest, workspace.project, target, request.allowedDirtyScopes)
    } catch (cause) {
      if (claimed && this.#workspaceOwners.get(key) === signature) this.#workspaceOwners.delete(key)
      throw cause
    }
  }

  async #provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace> {
    const identity = projectIdentitySchema.parse(request.identity)
    const managedRoot = path.resolve(request.managedRoot)
    const target = path.resolve(request.worktreePath)
    assertPortableTarget(target)
    assertSafeTarget(identity, managedRoot, target)
    await this.#git(['-C', identity.repositoryRoot, 'check-ref-format', '--branch', request.branchName], request.signal)

    // Reuse is verified from durable Git facts and does not require the source worktree to remain clean.
    if (await pathExists(target)) return this.#inspectExisting(request, identity, target)

    const current = await this.inspect({
      projectRoot: identity.projectRoot,
      protectedRoots: identity.protectedRoots,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (!sameIdentity(identity, current)) {
      throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'The Git project identity or baseline changed before worktree creation')
    }

    const branch = await this.#git(
      ['-C', identity.repositoryRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${request.branchName}`],
      request.signal,
      [0, 1],
    )
    if (branch.exitCode === 0) throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', `Branch ${request.branchName} already exists without the expected worktree`)

    const registeredRoots = await this.#registeredWorktrees(identity.repositoryRoot, request.signal)
    if (registeredRoots.some(item => pathsOverlap(target, item.path))) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The requested worktree overlaps an existing registered Git worktree')
    }
    await assertSafeManagedRootBeforeCreate(identity, managedRoot, target)
    await mkdir(managedRoot, { recursive: true })
    const realManagedRoot = await existingRealPath(managedRoot, 'managedRoot')
    /* v8 ignore next -- Post-mkdir TOCTOU defense; preflight already rejects stable aliases. */
    if (!samePath(realManagedRoot, path.dirname(target))) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The worktree must be a direct child of the real managed root')
    }
    assertSafeTarget(identity, realManagedRoot, target)

    try {
      await this.#git([
        '-C', identity.repositoryRoot, 'worktree', 'add', '-b', request.branchName, target, identity.baselineRef,
      ], request.signal)
    } catch {
      await this.#probeAfterUncertainMutation(identity.repositoryRoot)
      throw reconciliationRequired('Git worktree creation did not reach a provably complete state')
    }

    try {
      const sourceAfter = await this.inspect({
        projectRoot: identity.projectRoot,
        protectedRoots: identity.protectedRoots,
      })
      /* v8 ignore next -- A clean concurrent commit is timing-dependent; mismatch still fails closed below. */
      if (!sameIdentity(identity, sourceAfter)) throw new Error('source postcondition changed')
      return await this.#inspectExisting(request, identity, target)
    /* v8 ignore start -- Requires a clean concurrent commit or target mutation between Git add and postcondition inspection. */
    } catch {
      throw reconciliationRequired('Git worktree creation completed but its postconditions could not be proven')
    }
    /* v8 ignore stop */
  }

  async #inspectExisting(
    request: ProvisionTeamWorkspaceRequest,
    identity: ProjectIdentity,
    target: string,
    allowedDirtyScopes: readonly string[] = [],
  ): Promise<TeamWorkspace> {
    const realManagedRoot = await existingRealPath(request.managedRoot, 'managedRoot')
    const realTarget = await existingRealPath(target, 'worktreePath')
    if (!samePath(target, realTarget)) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'An existing worktree target cannot be a symbolic-link or junction alias')
    }
    assertSafeTarget(identity, realManagedRoot, realTarget)
    await this.#assertNoExternalGitExecution(realTarget, request.signal)

    const topLevel = await existingRealPath(
      (await this.#git(['-C', realTarget, 'rev-parse', '--show-toplevel'], request.signal)).stdout.trim(),
      'worktreeTopLevel',
    )
    const commonOutput = (await this.#git(['-C', realTarget, 'rev-parse', '--git-common-dir'], request.signal)).stdout.trim()
    const commonCandidate = path.isAbsolute(commonOutput) ? commonOutput : path.resolve(realTarget, commonOutput)
    const commonDirectory = await existingRealPath(commonCandidate, 'worktreeGitCommonDirectory')
    const baseline = (await this.#git(['-C', realTarget, 'rev-parse', '--verify', 'HEAD'], request.signal)).stdout.trim()
    const branch = await this.#git(['-C', realTarget, 'symbolic-ref', '--quiet', '--short', 'HEAD'], request.signal, [0, 1])
    const status = await this.#git(['-C', realTarget, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], request.signal)
    const dirtyPaths = parsePorcelainPaths(status.stdout)
    const repositoryScopes = repositoryRelativeScopes(identity, allowedDirtyScopes)
    const dirtyPathsAllowed = dirtyPaths.every(dirtyPath => repositoryScopes.some(scope => fileScopeMatchesPath(scope, dirtyPath)))
    const registrations = await this.#registeredWorktrees(identity.repositoryRoot, request.signal)
    const registered = registrations.some(item => samePath(item.path, realTarget)
      && item.head === identity.baselineRef
      && item.branch === `refs/heads/${request.branchName}`)
    const overlapsAnotherWorktree = registrations.some(item => !samePath(item.path, realTarget)
      && pathsOverlap(realTarget, item.path))

    if (!samePath(realTarget, topLevel)
      || !samePath(commonDirectory, identity.gitCommonDirectory)
      || baseline !== identity.baselineRef
      || branch.exitCode !== 0
      || branch.stdout.trim() !== request.branchName
      || !dirtyPathsAllowed
      || !registered
      || overlapsAnotherWorktree) {
      throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'An existing worktree does not match the requested Git registration, branch, baseline, or clean state')
    }
    return Object.freeze(teamWorkspaceSchema.parse({
      workspaceId: request.workspaceId,
      project: identity,
      worktreePath: realTarget,
      branchName: request.branchName,
      status: 'ready',
    }))
  }

  async #probeAfterUncertainMutation(repositoryRoot: string): Promise<void> {
    try {
      await this.#git(['-C', repositoryRoot, 'worktree', 'list', '--porcelain', '-z'])
    } catch {
      // This probe is deliberately read-only. Failure preserves the explicit reconciliation state.
    }
  }

  async #registeredWorktrees(repositoryRoot: string, signal?: AbortSignal): Promise<readonly WorktreeRegistration[]> {
    const parsed = parseWorktreeRegistrations((await this.#git([
      '-C', repositoryRoot, 'worktree', 'list', '--porcelain', '-z',
    ], signal)).stdout)
    return Promise.all(parsed.map(async item => ({ ...item, path: await normalizedPath(item.path) })))
  }

  async #assertNoExternalGitExecution(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    const riskyCoreConfig = await this.#git(
      ['-C', repositoryRoot, 'config', '--get-regexp', RISKY_CORE_CONFIG], signal, [0, 1], false,
    )
    const riskyLocalFilter = await this.#git(
      ['-C', repositoryRoot, 'config', '--local', '--get-regexp', RISKY_LOCAL_FILTER_CONFIG], signal, [0, 1], false,
    )
    if ((riskyCoreConfig.exitCode === 0 && riskyCoreConfig.stdout.trim() !== '')
      || (riskyLocalFilter.exitCode === 0 && riskyLocalFilter.stdout.trim() !== '')) {
      throw unsupported('Git hooks, fsmonitor, and external clean/smudge/process filters are not supported in Developer Preview')
    }

    const trackedFiles = (await this.#git(['-C', repositoryRoot, 'ls-files', '-z'], signal)).stdout
    if (trackedFiles === '') return
    const indexFlags = (await this.#git(['-C', repositoryRoot, 'ls-files', '-v', '-z'], signal)).stdout.split('\0')
    if (indexFlags.some(entry => entry !== '' && !entry.startsWith('H '))) {
      throw unsupported('Git assume-unchanged, skip-worktree, sparse, and nonstandard index flags are not supported in Developer Preview')
    }
    await this.#assertNoFilterAttributes(repositoryRoot, trackedFiles, signal, false)
    await this.#assertNoFilterAttributes(repositoryRoot, trackedFiles, signal, true)
  }

  async #assertNoFilterAttributes(
    repositoryRoot: string,
    trackedFiles: string,
    signal: AbortSignal | undefined,
    cached: boolean,
  ): Promise<void> {
    const filterAttributes = (await this.#git([
      '-C', repositoryRoot, 'check-attr', ...(cached ? ['--cached'] : []), '-z', 'filter', '--stdin',
    ], signal, [0], true, trackedFiles)).stdout.split('\0')
    for (let index = 2; index < filterAttributes.length; index += 3) {
      const value = filterAttributes[index]
      if (value !== undefined && value !== 'unspecified' && value !== 'unset') {
        throw unsupported('Tracked files with Git filter attributes are not supported in Developer Preview')
      }
    }
  }

  #git(
    args: readonly string[],
    signal?: AbortSignal,
    allowedExitCodes: readonly number[] = [0],
    controlled = true,
    input?: string,
  ): Promise<GitResult> {
    const invocation = controlled ? ['-c', `core.hooksPath=${this.#disabledHooksPath}`, ...args] : [...args]
    return new Promise((resolve, reject) => {
      const child = execFile(this.#gitExecutable, invocation, {
        encoding: 'utf8', windowsHide: true, timeout: this.#timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        ...(signal === undefined ? {} : { signal }),
      }, (error, stdout) => {
        const failure = error as ExecFileFailure | null
        const exitCode = typeof failure?.code === 'number' ? failure.code : failure === null ? 0 : -1
        if (failure === null || allowedExitCodes.includes(exitCode)) {
          resolve({ stdout: String(stdout), exitCode })
          return
        }
        reject(new YuqiOrchestratorError('GIT_COMMAND_FAILED', safeGitMessage(args)))
      })
      if (input !== undefined) child.stdin?.end(input)
    })
  }
}

function parsePorcelainPaths(output: string): readonly string[] {
  if (output === '') return []
  const records = output.split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record === '') continue
    /* v8 ignore next -- Git porcelain -z guarantees the XY-space-path record shape. */
    if (record.length < 4 || record[2] !== ' ') throw unsupported('Git status returned an unsupported porcelain record')
    paths.push(record.slice(3))
    if (record[0] === 'R' || record[0] === 'C' || record[1] === 'R' || record[1] === 'C') {
      const source = records[index + 1]
      /* v8 ignore next -- Git porcelain -z guarantees the second rename path record. */
      if (source === undefined || source === '') throw unsupported('Git status returned an incomplete rename record')
      paths.push(source)
      index += 1
    }
  }
  return paths
}

function unsupported(message: string): YuqiOrchestratorError {
  return new YuqiOrchestratorError('GIT_PROJECT_UNSUPPORTED', message)
}

function reconciliationRequired(message: string): YuqiOrchestratorError {
  return new YuqiOrchestratorError('WORKSPACE_REQUIRES_RECONCILIATION', message)
}

function safeGitMessage(args: readonly string[]): string {
  return args.includes('worktree') ? 'Git worktree operation failed' : 'Git inspection failed'
}

async function existingRealPath(input: string, name: string): Promise<string> {
  try {
    await access(input, fsConstants.F_OK)
    return path.resolve(await realpath(input))
  } catch (cause) {
    throw new YuqiOrchestratorError('GIT_PROJECT_UNSUPPORTED', `${name} does not exist or cannot be resolved`, { cause })
  }
}

async function normalizedPath(input: string): Promise<string> {
  try {
    return path.resolve(await realpath(input))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(input)
    throw new YuqiOrchestratorError('GIT_PROJECT_UNSUPPORTED', 'A safety path exists but its real location cannot be proven')
  }
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await lstat(input)
    return true
  } catch (cause) {
    /* v8 ignore else -- Non-ENOENT lstat failures require host ACL/device fault injection and must propagate unchanged. */
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    /* v8 ignore next -- Preserve the original host filesystem error. */
    throw cause
  }
}

export async function assertSafeGitWorkspaceDestination(identity: ProjectIdentity, managedRoot: string, target: string): Promise<void> {
  if (!path.isAbsolute(managedRoot) || !path.isAbsolute(target)) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'An absolute isolation directory is required')
  }
  assertSafeTarget(identity, path.resolve(managedRoot), path.resolve(target))
  await assertSafeManagedRootBeforeCreate(identity, path.resolve(managedRoot), path.resolve(target))
}

async function assertSafeManagedRootBeforeCreate(
  identity: ProjectIdentity,
  managedRoot: string,
  target: string,
): Promise<void> {
  let existingAncestor = managedRoot
  while (!await pathExists(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    /* v8 ignore next -- Every supported local absolute path has an existing volume root. */
    if (samePath(parent, existingAncestor)) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'No safe existing ancestor was found for managedRoot')
    }
    existingAncestor = parent
  }
  const ancestorStat = await lstat(existingAncestor)
  if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The existing managedRoot ancestor must be a real directory')
  }
  const realAncestor = await existingRealPath(existingAncestor, 'managedRootAncestor')
  if (!samePath(existingAncestor, realAncestor)) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The managedRoot ancestor resolves through a link or reparse point')
  }
  const prospectiveManagedRoot = path.resolve(realAncestor, path.relative(existingAncestor, managedRoot))
  const prospectiveTarget = path.resolve(prospectiveManagedRoot, path.basename(target))
  /* v8 ignore next -- Defensive invariant after an equal real/lexical ancestor. */
  if (!samePath(prospectiveManagedRoot, managedRoot) || !samePath(prospectiveTarget, target)) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The prospective worktree path does not preserve its lexical boundary')
  }
  assertSafeTarget(identity, prospectiveManagedRoot, prospectiveTarget)
}

function provisionResourceKey(request: ProvisionTeamWorkspaceRequest): string {
  return pathKey(request.worktreePath)
}

function provisionSignature(request: ProvisionTeamWorkspaceRequest): string {
  return JSON.stringify([
    request.workspaceId,
    pathKey(request.identity.gitCommonDirectory),
    request.identity.baselineRef,
    pathKey(request.managedRoot),
    pathKey(request.worktreePath),
    request.branchName,
  ])
}

function pathKey(input: string): string {
  const resolved = path.resolve(input)
  /* v8 ignore next -- Windows resource identities are case-insensitive. */
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function parseWorktreeRegistrations(output: string): readonly WorktreeRegistration[] {
  const registrations: WorktreeRegistration[] = []
  let current: { path?: string; head?: string; branch?: string } = {}
  const flush = (): void => {
    if (current.path !== undefined) registrations.push({
      path: current.path,
      /* v8 ignore next -- Git porcelain registrations always include HEAD. */
      ...(current.head === undefined ? {} : { head: current.head }),
      /* v8 ignore next -- The requested ready worktree is never detached; detached unrelated entries are tolerated. */
      ...(current.branch === undefined ? {} : { branch: current.branch }),
    })
    current = {}
  }
  for (const field of output.split('\0')) {
    if (field === '') {
      flush()
    } else if (field.startsWith('worktree ')) {
      /* v8 ignore next -- Valid porcelain separates worktree records with NUL. */
      if (current.path !== undefined) flush()
      current.path = field.slice('worktree '.length)
    } else if (field.startsWith('HEAD ')) {
      current.head = field.slice('HEAD '.length)
    /* v8 ignore next -- Other valid porcelain markers are intentionally ignored. */
    } else if (field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length)
    }
  }
  flush()
  return registrations
}

function assertPortableTarget(target: string): void {
  if (target.includes('\0')) throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The worktree path contains an invalid character')
  /* v8 ignore next -- Windows validation is exercised on Windows; other CI platforms take this return. */
  if (process.platform !== 'win32') return
  const segments = path.resolve(target).slice(path.parse(target).root.length).split(path.sep).filter(Boolean)
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
  if (segments.some(segment => /[\x00-\x1F<>:"|?*]/.test(segment) || /[. ]$/.test(segment) || reserved.test(segment))) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The worktree path is not valid on Windows')
  }
}

function assertSafeTarget(identity: ProjectIdentity, managedRoot: string, target: string): void {
  if (!samePath(path.dirname(target), managedRoot) || samePath(target, managedRoot)) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The worktree must be one direct child below managedRoot')
  }
  const targetVolume = path.parse(target).root
  const isUncPath = process.platform === 'win32' && targetVolume.startsWith('\\\\')
  if (!samePath(targetVolume, identity.volumeRoot)
    || isUncPath
    || samePath(managedRoot, identity.volumeRoot)
    || pathsOverlap(target, identity.repositoryRoot)
    || pathsOverlap(target, identity.gitCommonDirectory)
    || identity.protectedRoots.some(root => samePath(target, root) || isInside(target, root))) {
    throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The requested worktree overlaps a protected project or filesystem root')
  }
}

function sameIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return samePath(left.projectRoot, right.projectRoot)
    && samePath(left.repositoryRoot, right.repositoryRoot)
    && samePath(left.gitCommonDirectory, right.gitCommonDirectory)
    && left.baselineRef === right.baselineRef
}

function pathsOverlap(left: string, right: string): boolean {
  return samePath(left, right) || isInside(left, right) || isInside(right, left)
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left)
  const normalizedRight = path.resolve(right)
  /* v8 ignore next 3 -- CI executes one platform branch; Windows requires case folding while POSIX must preserve case. */
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}
