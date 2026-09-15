/** Read-only recovery classification through the public Harness child listing. */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AttemptResolutionProof, AttemptResolutionSafetyPort, AttemptRuntimeObservation, AttemptRuntimeObservationPort, AttemptRuntimeRef, RecoveryClearProof, RecoveryClearSafetyPort } from '../../application/ports.ts'
import type { GitWorkspacePort } from '../../application/workspace-ports.ts'
import type { DirectProjectIdentity, TeamWorkspace } from '../../domain/workspace.ts'

export interface LocalAttemptActivityPort {
  hasActiveAttempt(journalKey: string, attemptId: string): boolean
}

export class HarnessAttemptRuntimeObservationPort implements AttemptRuntimeObservationPort {
  readonly #ctx: Context

  constructor(ctx: Context) { this.#ctx = ctx }

  async observe(request: {
    readonly parentSessionId: string
    readonly attempts: readonly AttemptRuntimeRef[]
    readonly signal?: AbortSignal
  }): Promise<readonly AttemptRuntimeObservation[]> {
    let entries: Awaited<ReturnType<Context['subagents']['listChildren']>>
    try {
      entries = await this.#ctx.subagents.listChildren(SessionId(request.parentSessionId), request.signal)
    } catch {
      return request.attempts.map(attempt => ({ ...attempt, state: 'unavailable', reason: 'Harness child listing is unavailable' }))
    }
    const byId = new Map(entries.map(entry => [String(entry.id), entry]))
    return request.attempts.map(attempt => attempt.childSessionId === undefined
      ? recoverUnadmittedAttempt(attempt, entries)
      : classifyAttempt(attempt, byId.get(attempt.childSessionId)))
  }
}

/** Re-proves the limited quiescent facts the public Harness API exposes before manual resolution. */
export class HarnessAttemptResolutionSafetyPort implements AttemptResolutionSafetyPort, RecoveryClearSafetyPort {
  readonly #ctx: Context
  readonly #parentSessionId: string
  readonly #localActivity: LocalAttemptActivityPort
  readonly #git: GitWorkspacePort | undefined

  constructor(ctx: Context, parentSessionId: string, localActivity: LocalAttemptActivityPort, git?: GitWorkspacePort) {
    this.#ctx = ctx
    this.#parentSessionId = parentSessionId
    this.#localActivity = localActivity
    this.#git = git
  }

  async assertQuiescent(request: {
    readonly journalKey: string
    readonly teamId?: string
    readonly attemptId: string
    readonly childSessionId?: string
    readonly observation: AttemptRuntimeObservation
    readonly workspace?: TeamWorkspace
    readonly leaseIds?: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<AttemptResolutionProof> {
    if (request.workspace === undefined && this.#git !== undefined) throw new Error('Host Git verification requires a durable workspace identity')
    this.#assertLocallyQuiescent(request.journalKey, request.attemptId)
    const entries = await this.#ctx.subagents.listChildren(SessionId(this.#parentSessionId), request.signal)
    this.#assertLocallyQuiescent(request.journalKey, request.attemptId)
    if (entries.some(entry => entry.kind === 'diagnostic')) throw new Error('Harness child listing contains a diagnostic record')
    // Resolution is about proving that the child is quiescent and that this is
    // still the exact durable Team worktree. A Team worktree is expected to be
    // dirty: completed siblings and the interrupted attempt may both have
    // useful edits. Rejecting every dirty path here makes recovery impossible
    // precisely when there is work worth preserving.
    const gitWorkspace = await this.#verifyWorkspace(request.workspace, request.signal, ['**'])
    if (request.workspace !== undefined && gitWorkspace === undefined) throw new Error('Host Git verification is unavailable')
    if (request.observation.state === 'durable') {
      const entry = entries.find(candidate => String(candidate.id) === request.childSessionId)
      if (entry?.kind !== 'child' || entry.mode !== 'continuable' || entry.activity !== 'inactive') throw new Error('Harness cannot prove the child is inactive and continuable')
    } else if (request.observation.state === 'missing') {
      if (request.childSessionId !== undefined && entries.some(entry => String(entry.id) === request.childSessionId)) throw new Error('Harness child is present again')
    } else if (request.observation.state === 'not-admitted') {
      if (request.childSessionId !== undefined || entries.some(entry => entry.kind === 'child')) throw new Error('Harness cannot independently prove an unadmitted child is absent')
    } else {
      throw new Error('Harness cannot independently prove this observation is quiescent')
    }
    const secondEntries = await this.#ctx.subagents.listChildren(SessionId(this.#parentSessionId), request.signal)
    if (secondEntries.some(entry => entry.kind === 'diagnostic')) throw new Error('Harness child listing became diagnostic during proof')
    if (request.observation.state === 'durable') {
      const entry = secondEntries.find(candidate => String(candidate.id) === request.childSessionId)
      if (entry?.kind !== 'child' || entry.mode !== 'continuable' || entry.activity !== 'inactive') throw new Error('Harness child reappeared or became active')
    } else if (request.childSessionId !== undefined && secondEntries.some(entry => String(entry.id) === request.childSessionId)) {
      throw new Error('Harness child reappeared during proof')
    }
    this.#assertLocallyQuiescent(request.journalKey, request.attemptId)
    return {
      principal: { kind: 'controller-session', sessionId: this.#parentSessionId },
      observationState: request.observation.state,
      childQuiescent: true,
      localInFlight: false,
      gitVerified: true,
      ...(gitWorkspace === undefined ? {} : { workspace: toWorkspaceProof(gitWorkspace) }),
      leaseIds: [...request.leaseIds ?? []],
    }
  }

  async assertRecoveryClear(request: {
    readonly journalKey: string
    readonly teamId: string
    readonly workspace: TeamWorkspace
    readonly attemptIds: readonly string[]
    readonly attempts?: readonly { readonly attemptId: string; readonly childSessionId?: string }[]
    readonly retainDirtyWorkspace?: boolean
    readonly signal?: AbortSignal
  }): Promise<RecoveryClearProof> {
    const attempts: readonly { readonly attemptId: string; readonly childSessionId?: string }[] = request.attempts ?? request.attemptIds.map(attemptId => ({ attemptId }))
    const allowedChildIds = new Set(attempts.flatMap(attempt => attempt.childSessionId === undefined ? [] : [attempt.childSessionId]))
    for (const attemptId of request.attemptIds) this.#assertLocallyQuiescent(request.journalKey, attemptId)
    const entries = await this.#ctx.subagents.listChildren(SessionId(this.#parentSessionId), request.signal)
    assertRecoveryChildren(entries, allowedChildIds, 'initial')
    for (const attemptId of request.attemptIds) this.#assertLocallyQuiescent(request.journalKey, attemptId)
    const verified = await this.#verifyWorkspace(
      request.workspace,
      request.signal,
      request.retainDirtyWorkspace === true ? ['**'] : [],
    )
    if (verified === undefined) throw new Error('Host Git verification is unavailable')
    const secondEntries = await this.#ctx.subagents.listChildren(SessionId(this.#parentSessionId), request.signal)
    assertRecoveryChildren(secondEntries, allowedChildIds, 'second')
    for (const attemptId of request.attemptIds) this.#assertLocallyQuiescent(request.journalKey, attemptId)
    return {
      principal: { kind: 'controller-session', sessionId: this.#parentSessionId },
      childQuiescent: true,
      localInFlight: false,
      gitVerified: true,
      workspace: toWorkspaceProof(verified),
    }
  }

  async #verifyWorkspace(
    workspace: TeamWorkspace | undefined,
    signal?: AbortSignal,
    allowedDirtyScopes: readonly string[] = [],
  ): Promise<TeamWorkspace | undefined> {
    if (workspace === undefined) return undefined
    if (this.#git === undefined) throw new Error('Host Git verification is unavailable')
    const verified = await this.#git.verify({ workspace, allowedDirtyScopes, ...(signal === undefined ? {} : { signal }) })
    if (verified === undefined) return undefined
    if (verified.status !== 'ready' || !sameWorkspaceIdentity(verified, workspace)) throw new Error('Host Git verification did not match the durable workspace')
    return verified
  }

  #assertLocallyQuiescent(journalKey: string, attemptId: string): void {
    if (this.#localActivity.hasActiveAttempt(journalKey, attemptId)) {
      throw new Error('Yuqi still has an in-flight admission or settlement for this attempt')
    }
  }
}

type HarnessChildEntry = Awaited<ReturnType<Context['subagents']['listChildren']>>[number]

/**
 * The public child list has no generation token in the current API. Keep the proof
 * fail-closed by requiring every visible child to be an exact durable binding
 * of this Team and by checking the list twice. The remaining append race is a
 * P2 limitation until Harness exposes an atomic generation/lock primitive.
 */
function assertRecoveryChildren(entries: readonly HarnessChildEntry[], allowedChildIds: ReadonlySet<string>, phase: 'initial' | 'second'): void {
  for (const entry of entries) {
    if (entry.kind === 'diagnostic') throw new Error(`Harness child listing became diagnostic during ${phase} recovery proof`)
    const childId = String(entry.id)
    if (!allowedChildIds.has(childId)) throw new Error(`Harness found a foreign child during ${phase} recovery proof`)
    if (entry.mode !== 'continuable' || entry.activity !== 'inactive') {
      throw new Error(`Harness found an active or non-continuable recovery child during ${phase} proof`)
    }
  }
}

function toWorkspaceProof(workspace: TeamWorkspace) {
  const direct = workspace.project as unknown as DirectProjectIdentity
  if (direct.mode === 'direct') {
    return {
      mode: 'direct' as const,
      workspaceId: String(workspace.workspaceId),
      projectRoot: direct.projectRoot,
      volumeRoot: direct.volumeRoot,
      protectedRoots: [...direct.protectedRoots],
      worktreePath: workspace.worktreePath,
      branchName: workspace.branchName,
    }
  }
  return {
    mode: 'git' as const,
    workspaceId: String(workspace.workspaceId),
    projectRoot: workspace.project.projectRoot,
    repositoryRoot: workspace.project.repositoryRoot,
    gitCommonDirectory: workspace.project.gitCommonDirectory,
    baselineRef: workspace.project.baselineRef,
    volumeRoot: workspace.project.volumeRoot,
    protectedRoots: [...workspace.project.protectedRoots],
    worktreePath: workspace.worktreePath,
    branchName: workspace.branchName,
  }
}

function sameWorkspaceIdentity(left: TeamWorkspace, right: TeamWorkspace): boolean {
  const leftDirect = left.project as unknown as DirectProjectIdentity
  const rightDirect = right.project as unknown as DirectProjectIdentity
  const common = left.workspaceId === right.workspaceId
    && left.project.projectRoot === right.project.projectRoot
    && left.project.volumeRoot === right.project.volumeRoot
    && JSON.stringify(left.project.protectedRoots) === JSON.stringify(right.project.protectedRoots)
    && left.worktreePath === right.worktreePath
    && left.branchName === right.branchName
  if (!common) return false
  if (leftDirect.mode === 'direct' || rightDirect.mode === 'direct') {
    return leftDirect.mode === 'direct' && rightDirect.mode === 'direct'
  }
  return left.project.repositoryRoot === right.project.repositoryRoot
    && left.project.gitCommonDirectory === right.project.gitCommonDirectory
    && left.project.baselineRef === right.project.baselineRef
}

function recoverUnadmittedAttempt(
  attempt: AttemptRuntimeRef,
  entries: readonly Awaited<ReturnType<Context['subagents']['listChildren']>>[number][],
): AttemptRuntimeObservation {
  if (attempt.recoveryToken === undefined) return { ...attempt, state: 'not-admitted' }
  const prefix = `yuqi:v1:${attempt.recoveryToken}:`
  const matches = entries.filter((entry): entry is Extract<typeof entries[number], { readonly kind: 'child' }> =>
    entry.kind === 'child' && typeof entry.label === 'string' && entry.label.startsWith(prefix))
  if (matches.length === 0) return { ...attempt, state: 'not-admitted' }
  if (matches.length !== 1) return { ...attempt, state: 'diagnostic', reason: 'Harness found multiple children for one recovery token' }
  const match = matches[0]!
  if (match.mode !== 'continuable') return { ...attempt, state: 'diagnostic', reason: 'Recovered child is not continuable' }
  return {
    ...attempt,
    childSessionId: String(match.id),
    state: match.activity === 'running' ? 'live' : 'durable',
    recoveredChild: true,
  }
}

function classifyAttempt(
  attempt: AttemptRuntimeRef,
  entry: Awaited<ReturnType<Context['subagents']['listChildren']>>[number] | undefined,
): AttemptRuntimeObservation {
  if (entry === undefined) return { ...attempt, state: 'missing', reason: 'Harness has no direct-child record for this Session' }
  if (entry.kind === 'diagnostic') return { ...attempt, state: 'diagnostic', reason: `Harness child record is ${entry.reason}` }
  if (entry.mode !== 'continuable') return { ...attempt, state: 'diagnostic', reason: 'Harness child is not continuable' }
  return { ...attempt, state: entry.activity === 'running' ? 'live' : 'durable' }
}
