/** Host-owned cold start orchestration for one fresh Yuqi Team controller. */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MAX_TEAM_TASKS, teamTaskContractSchema, type TeamTaskContract } from '../../domain/task-contract.ts'
import type { ProjectIdentity, TeamWorkspace } from '../../domain/workspace.ts'
import type { ProvisionTeamWorkspaceRequest, InspectGitProjectRequest } from '../../application/workspace-ports.ts'
import { YuqiOrchestratorError, type YuqiOrchestratorErrorCode } from '../../application/errors.ts'
import { validateAndOrderTaskContracts } from '../../application/bootstrap-team.ts'
import { fileScopePatternSchema } from '../../domain/file-scope.ts'
import { parseDirectWriteStrategy, type DirectWriteStrategy } from '../../domain/execution-policy.ts'
import {
  FilesystemStartTeamRecoveryStore,
  type StartTeamRecoveryHandle,
  type StartTeamRecoveryPhase,
  type StartTeamRecoveryStore,
} from './start-recovery-manifest.ts'
import { providerScopeSchema, teamModelPolicySchema, type ModelRoutingPolicy } from '../../domain/model-route.ts'
import { normalizeReviewPolicy, type ReviewPolicy } from '../../domain/review-policy.ts'
import { DEFAULT_TEAM_LOCALE, teamLocaleSchema, type TeamLocale } from '../../domain/locale.ts'
import { assertTeamConcurrency } from '../../application/team-settings.ts'

export * from './start-recovery-manifest.ts'

/** Caller-owned start input. Team/workspace/controller identities are Host-owned. */
export interface StartTeamRequest<ControllerModel = AgentOptions> {
  readonly maxConcurrency?: number
  readonly title: string
  readonly objective: string
  /** Language for Host-authored user-visible Team text. */
  readonly locale?: TeamLocale
  readonly tasks: readonly TeamTaskContract[]
  readonly projectCwd: string
  readonly controllerModel: ControllerModel
  /** Product callers pass the saved mode explicitly; generic callers retain Git compatibility. */
  readonly workspaceMode?: 'git-worktree' | 'direct'
  /** Snapshotted into the durable Team; defaults to planned-scope-parallel. */
  readonly directWriteStrategy?: DirectWriteStrategy
  /** Reviewer behavior copied once into the durable Team-created event. */
  readonly reviewPolicy?: Partial<ReviewPolicy>
  /** Start durably paused until the user approves the initial task graph. */
  readonly requirePlanConfirmation?: boolean
  /** Immutable structured model policy copied into the Team-created event. */
  readonly modelRouting?: ModelRoutingPolicy
  /** Host-owned invoking Session lineage for native Harness navigation. */
  readonly controllerParentSessionId?: string
  /** Native Agent preset inherited by this Team's workers. */
  readonly childPresetId?: string
  /** Explicit managed root; no implicit current-directory or home fallback exists. */
  readonly managedRoot?: string
  /** Alternative Host configuration spelling for callers that keep Host roots in options. */
  readonly options?: {
    readonly hostRoot?: string
  }
  readonly signal?: AbortSignal
}

/** Host-generated stable identifiers used to derive the branch and worktree target. */
export interface StartTeamIdentityPort {
  nextTeamId(): string
  nextWorkspaceId(): string
}

/** Physical Git operation. This runs before a controller or durable Team journal exists. */
export type StartTeamPhysicalWorkspacePort = Pick<
  {
    inspect(request: InspectGitProjectRequest): Promise<ProjectIdentity>
    provision(request: ProvisionTeamWorkspaceRequest): Promise<TeamWorkspace>
  },
  'inspect' | 'provision'
>

/** The controller launch result that the coordinator is responsible for disposing on later failure. */
export interface StartTeamControllerLaunch<Controller> {
  readonly sessionId: string
  readonly controller: Controller
  dispose(): Promise<void>
}

/** Explicit Host ownership of a live controller and its idempotent release capability. */
export interface StartTeamControllerOwner<Controller> {
  readonly controller: Controller
  dispose(): Promise<void>
}

/** Adapter around the public Harness controller launcher. */
export interface StartTeamControllerPort<Controller, ControllerModel = AgentOptions> {
  launch(request: {
    readonly workspace: TeamWorkspace
    readonly controllerModel: ControllerModel
    readonly parentSessionId?: string
    readonly childPresetId?: string
    readonly signal?: AbortSignal
  }): Promise<StartTeamControllerLaunch<Controller>>
}

/** Adapter around the durable Team bootstrap coordinator bound to the fresh controller journal. */
export interface StartTeamBootstrapPort<Controller, BootstrapResult = unknown> {
  bootstrap(request: {
    readonly maxConcurrency?: number
    readonly controller: Controller
    readonly controllerModel: AgentOptions
    readonly teamId: string
    readonly title: string
    readonly objective: string
    readonly locale: TeamLocale
    readonly tasks: readonly TeamTaskContract[]
    readonly directWriteStrategy?: DirectWriteStrategy
    readonly reviewPolicy: ReviewPolicy
    readonly requirePlanConfirmation?: boolean
    readonly modelRouting?: ModelRoutingPolicy
    readonly signal?: AbortSignal
  }): Promise<BootstrapResult>
}

/** Adapter around durable workspace intent/confirmation bound to the fresh controller journal. */
export interface StartTeamDurableWorkspacePort<Controller> {
  provision(request: {
    readonly controller: Controller
    readonly teamId: string
    readonly workspaceId: string
    readonly identity: ProjectIdentity
    readonly managedRoot: string
    readonly worktreePath: string
    readonly branchName: string
    readonly signal?: AbortSignal
  }): Promise<TeamWorkspace>
}

/** Result containing only Host-proven identities and the fresh controller handle. */
export interface StartedTeam<Controller, BootstrapResult> {
  readonly teamId: string
  readonly sessionId: string
  readonly controller: Controller
  readonly workspace: TeamWorkspace
  readonly bootstrap: BootstrapResult
  /** Exact ownership capability for the fresh live controller. */
  dispose(): Promise<void>
}

/**
 * Inspects the current project, creates the physical worktree, launches a fresh
 * controller, bootstraps its journal, then durably confirms the same workspace.
 * No failure path removes the physical worktree or branch.
 */
export class StartTeamCoordinator<Controller, ControllerModel = AgentOptions, BootstrapResult = unknown> {
  readonly #physical: StartTeamPhysicalWorkspacePort
  readonly #launcher: StartTeamControllerPort<Controller, ControllerModel>
  readonly #bootstrap: StartTeamBootstrapPort<Controller, BootstrapResult>
  readonly #durableWorkspace: StartTeamDurableWorkspacePort<Controller>
  readonly #identities: StartTeamIdentityPort
  readonly #recovery: StartTeamRecoveryStore

  constructor(
    physical: StartTeamPhysicalWorkspacePort,
    launcher: StartTeamControllerPort<Controller, ControllerModel>,
    bootstrap: StartTeamBootstrapPort<Controller, BootstrapResult>,
    durableWorkspace: StartTeamDurableWorkspacePort<Controller>,
    identities: StartTeamIdentityPort = new RandomStartTeamIdentityPort(),
    recovery: StartTeamRecoveryStore = new FilesystemStartTeamRecoveryStore(),
  ) {
    this.#physical = physical
    this.#launcher = launcher
    this.#bootstrap = bootstrap
    this.#durableWorkspace = durableWorkspace
    this.#identities = identities
    this.#recovery = recovery
  }

  async start(request: StartTeamRequest<ControllerModel>): Promise<StartedTeam<Controller, BootstrapResult>> {
    const input = validateStartInput(request)
    assertNotAborted(input.signal)

    let identity: ProjectIdentity
    try {
      identity = await this.#physical.inspect({
        projectRoot: input.projectCwd,
        protectedRoots: [],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (cause) {
      // Workspace adapters already expose bounded public messages. Preserve
      // those actionable reasons (for example a dirty Git repository) instead
      // of replacing them with the unhelpful "could not inspect" wrapper.
      if (cause instanceof YuqiOrchestratorError) throw cause
      throw safeFailure(input.workspaceMode === 'direct' ? 'UNSAFE_WORKSPACE_PATH' : 'GIT_PROJECT_UNSUPPORTED',
        input.workspaceMode === 'direct' ? 'The Host could not inspect the selected project directory' : 'The Host could not inspect the current Git project', cause)
    }

    const tasks = input.workspaceMode === 'direct'
      ? normalizeTasksWithoutBaseline(input.tasks)
      : normalizeTasks(input.tasks, identity.baselineRef)
    const generated = generateWorkspaceFacts(this.#identities, input.managedRoot, input.projectCwd, input.workspaceMode)
    assertNotAborted(input.signal)

    let recovery: StartTeamRecoveryHandle | undefined
    if (input.workspaceMode === 'git-worktree') {
      try {
        recovery = await this.#recovery.create({
          teamId: generated.teamId,
          workspaceId: generated.workspaceId,
          identity,
          managedRoot: generated.managedRoot,
          worktreePath: generated.worktreePath,
          branchName: generated.branchName,
        })
      } catch (cause) {
        throw safeFailure('INTENT_PERSISTENCE_FAILED', 'The Host could not persist exact recovery ownership before workspace creation', cause)
      }
    }

    let physicalWorkspace: TeamWorkspace
    try {
      physicalWorkspace = await this.#physical.provision({
        identity,
        workspaceId: generated.workspaceId,
        managedRoot: generated.managedRoot,
        worktreePath: generated.worktreePath,
        branchName: generated.branchName,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (cause) {
      throw safeFailure('WORKSPACE_REQUIRES_RECONCILIATION',
        input.workspaceMode === 'direct' ? 'The selected project directory could not be prepared as a direct Team workspace' : recoveryMessage('Physical Team workspace provisioning did not reach a proven ready state', recovery), cause)
    }
    recovery = await advanceRecovery(this.#recovery, recovery, 'workspace-provisioned', 'Physical workspace creation completed but its recovery manifest could not advance')
    assertPhysicalWorkspace(physicalWorkspace, identity, generated, input.workspaceMode)

    assertNotAborted(input.signal)
    recovery = await advanceRecovery(this.#recovery, recovery, 'controller-launching', 'Controller launch intent could not be persisted before its external side effect')
    let launch: StartTeamControllerLaunch<Controller>
    try {
      launch = await this.#launcher.launch({
        workspace: physicalWorkspace,
        controllerModel: input.controllerModel,
        ...(input.controllerParentSessionId === undefined ? {} : { parentSessionId: input.controllerParentSessionId }),
        ...(input.childPresetId === undefined ? {} : { childPresetId: input.childPresetId }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (cause) {
      throw safeFailure('CONTROLLER_REQUIRES_RECONCILIATION', recoveryMessage('The fresh Team controller could not be launched; the physical workspace was retained', recovery), cause)
    }

    const owner = ownController(launch)
    try {
      recovery = await advanceRecovery(this.#recovery, recovery, 'controller-launched', 'The controller launched but its recovery manifest could not advance', launch.sessionId)
    } catch (cause) {
      await disposeAfterFailure(owner)
      recovery = await advanceRecovery(this.#recovery, recovery, 'workspace-provisioned', 'The controller was disposed but cleanup eligibility could not be restored')
      throw cause
    }

    let bootstrap: BootstrapResult
    try {
      assertNotAborted(input.signal)
      bootstrap = await this.#bootstrap.bootstrap({
        ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
        controller: owner.controller,
        controllerModel: input.controllerModel as AgentOptions,
        teamId: generated.teamId,
        title: input.title,
        objective: input.objective,
        locale: input.locale,
        tasks,
        directWriteStrategy: input.directWriteStrategy,
        reviewPolicy: input.reviewPolicy,
        ...(input.requirePlanConfirmation === true ? { requirePlanConfirmation: true } : {}),
        ...(input.modelRouting === undefined ? {} : { modelRouting: input.modelRouting }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (cause) {
      await disposeAfterFailure(owner)
      recovery = await markFailedRecovery(this.#recovery, recovery, 'bootstrap-failed', launch.sessionId)
      if (isHostSessionIncompatibility(cause)) {
        throw safeFailure(
          'HOST_SESSION_INCOMPATIBLE',
          recoveryMessage('The Host Session event envelope is incompatible; no durable Team state was created. Update the Host before retrying', recovery),
          cause,
        )
      }
      if (cause instanceof YuqiOrchestratorError && cause.code !== 'INTENT_PERSISTENCE_FAILED') throw cause
      throw safeFailure('CONTROLLER_REQUIRES_RECONCILIATION', recoveryMessage('Team bootstrap failed after controller launch; durable Team state is unknown, so the controller was disposed and the workspace was retained', recovery), cause)
    }

    try {
      recovery = await advanceRecovery(this.#recovery, recovery, 'team-bootstrapped', 'Team bootstrap completed but its recovery manifest could not advance', launch.sessionId)
      recovery = await advanceRecovery(this.#recovery, recovery, 'durable-confirming', 'Durable confirmation could not enter its recovery phase', launch.sessionId)
    } catch (cause) {
      await disposeAfterFailure(owner)
      throw cause
    }

    let durableWorkspace: TeamWorkspace
    try {
      assertNotAborted(input.signal)
      durableWorkspace = await this.#durableWorkspace.provision({
        controller: owner.controller,
        teamId: generated.teamId,
        workspaceId: generated.workspaceId,
        identity,
        managedRoot: path.dirname(physicalWorkspace.worktreePath),
        worktreePath: physicalWorkspace.worktreePath,
        branchName: physicalWorkspace.branchName,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (cause) {
      await disposeAfterFailure(owner)
      recovery = await markFailedRecovery(this.#recovery, recovery, 'confirmation-failed', launch.sessionId)
      throw safeFailure('CONTROLLER_REQUIRES_RECONCILIATION', recoveryMessage('Durable workspace confirmation failed; the controller was disposed and the workspace was retained', recovery), cause)
    }
    if (!sameWorkspace(durableWorkspace, physicalWorkspace)) {
      await disposeAfterFailure(owner)
      recovery = await markFailedRecovery(this.#recovery, recovery, 'confirmation-failed', launch.sessionId)
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', recoveryMessage('Durable workspace confirmation did not match the physical workspace', recovery))
    }

    try {
      recovery = await advanceRecovery(this.#recovery, recovery, 'completed', 'Durable workspace confirmation completed but recovery ownership could not close', launch.sessionId)
    } catch (cause) {
      await disposeAfterFailure(owner)
      throw cause
    }

    return Object.freeze({
      teamId: generated.teamId,
      sessionId: launch.sessionId,
      controller: owner.controller,
      workspace: durableWorkspace,
      bootstrap,
      dispose: owner.dispose,
    })
  }
}

/** Default Host identity source. Callers cannot choose Team/workspace/session ids. */
export class RandomStartTeamIdentityPort implements StartTeamIdentityPort {
  nextTeamId(): string { return `yuqi-team-${randomUUID()}` }
  nextWorkspaceId(): string { return `yuqi-workspace-${randomUUID()}` }
}

interface ValidatedStartInput<ControllerModel> {
  readonly maxConcurrency?: number
  readonly title: string
  readonly objective: string
  readonly locale: TeamLocale
  readonly tasks: readonly TeamTaskContract[]
  readonly projectCwd: string
  readonly controllerModel: ControllerModel
  readonly workspaceMode: 'git-worktree' | 'direct'
  readonly directWriteStrategy: DirectWriteStrategy
  readonly reviewPolicy: ReviewPolicy
  readonly requirePlanConfirmation?: boolean
  readonly modelRouting?: ModelRoutingPolicy
  readonly controllerParentSessionId?: string
  readonly childPresetId?: string
  readonly managedRoot: string
  readonly signal?: AbortSignal
}

interface GeneratedWorkspaceFacts {
  readonly teamId: string
  readonly workspaceId: string
  readonly managedRoot: string
  readonly worktreePath: string
  readonly branchName: string
}

/** Reuse complete input validation before reserving an external follow-up operation. */
export function validateStartTeamRequest<ControllerModel>(request: StartTeamRequest<ControllerModel>): void {
  validateStartInput(request)
}

function validateStartInput<ControllerModel>(request: StartTeamRequest<ControllerModel>): ValidatedStartInput<ControllerModel> {
  if (request.maxConcurrency !== undefined) assertTeamConcurrency(request.maxConcurrency)
  const title = nonEmpty(request.title, 'title')
  const objective = nonEmpty(request.objective, 'objective')
  const projectCwd = nonEmpty(request.projectCwd, 'projectCwd')
  let locale: TeamLocale
  try {
    locale = teamLocaleSchema.parse(request.locale ?? DEFAULT_TEAM_LOCALE)
  } catch (cause) {
    throw safeFailure('INVALID_BATCH', 'Team locale must be zh or en', cause)
  }
  // Generic coordinator keeps its legacy Git default for non-product callers.
  // The Host service and user-facing Team tool always pass the saved mode.
  const workspaceMode = request.workspaceMode ?? 'git-worktree'
  if (workspaceMode !== 'git-worktree' && workspaceMode !== 'direct') {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'workspaceMode must be direct or git-worktree')
  }
  if (request.controllerModel === undefined || request.controllerModel === null) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'controllerModel is required')
  }
  let modelRouting: ModelRoutingPolicy | undefined
  try {
    modelRouting = request.modelRouting === undefined ? undefined : {
      providerScope: providerScopeSchema.parse(request.modelRouting.providerScope),
      teamPolicy: teamModelPolicySchema.parse(request.modelRouting.teamPolicy),
    }
  } catch (cause) {
    throw safeFailure('INVALID_BATCH', 'Team model routing policy is invalid', cause)
  }
  const directRoot = optionalNonEmpty(request.managedRoot, 'managedRoot')
  const optionRoot = optionalNonEmpty(request.options?.hostRoot, 'options.hostRoot')
  if (directRoot !== undefined && optionRoot !== undefined && path.resolve(directRoot) !== path.resolve(optionRoot)) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'managedRoot and options.hostRoot must identify the same Host root')
  }
  const managedRoot = directRoot ?? optionRoot ?? (workspaceMode === 'direct' ? path.dirname(path.resolve(projectCwd)) : undefined)
  if (managedRoot === undefined || !path.isAbsolute(managedRoot)) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'An absolute managedRoot or options.hostRoot is required')
  }
  if (!Array.isArray(request.tasks) || request.tasks.length === 0 || request.tasks.length > MAX_TEAM_TASKS) {
    throw new YuqiOrchestratorError('INVALID_BATCH', `Team start requires 1-${MAX_TEAM_TASKS} task contracts`)
  }
  const tasks = validateAndOrderTaskContracts(normalizeTasksWithoutBaseline(request.tasks))
  for (const task of tasks) {
    for (const pattern of task.fileScope) {
      const parsed = fileScopePatternSchema.safeParse(pattern)
      if (!parsed.success) {
        throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${task.taskId} has invalid fileScope pattern ${pattern}`)
      }
    }
  }
  return {
    title,
    objective,
    locale,
    projectCwd,
    workspaceMode,
    directWriteStrategy: parseDirectWriteStrategy(request.directWriteStrategy),
    reviewPolicy: normalizeReviewPolicy(request.reviewPolicy),
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    ...(request.requirePlanConfirmation === true ? { requirePlanConfirmation: true } : {}),
    ...(modelRouting === undefined ? {} : { modelRouting }),
    managedRoot: path.resolve(managedRoot),
    controllerModel: request.controllerModel,
    ...(request.childPresetId === undefined ? {} : { childPresetId: nonEmpty(request.childPresetId, 'childPresetId') }),
    ...(request.controllerParentSessionId === undefined
      ? {}
      : { controllerParentSessionId: nonEmpty(request.controllerParentSessionId, 'controllerParentSessionId') }),
    tasks,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  }
}

function normalizeTasks(tasks: readonly TeamTaskContract[], baselineRef: string): readonly TeamTaskContract[] {
  try {
    return Object.freeze(tasks.map(task => {
      const parsed = teamTaskContractSchema.parse(task)
      return Object.freeze(teamTaskContractSchema.parse({ ...parsed, baselineRef }))
    }))
  } catch (cause) {
    throw safeFailure('INVALID_BATCH', 'One or more task contracts are invalid for the inspected project baseline', cause)
  }
}

function normalizeTasksWithoutBaseline(tasks: readonly TeamTaskContract[]): readonly TeamTaskContract[] {
  try {
    return Object.freeze(tasks.map(task => Object.freeze(teamTaskContractSchema.parse(task))))
  } catch (cause) {
    throw safeFailure('INVALID_BATCH', 'One or more task contracts are invalid', cause)
  }
}

function generateWorkspaceFacts(ids: StartTeamIdentityPort, managedRoot: string, projectCwd: string, workspaceMode: 'git-worktree' | 'direct'): GeneratedWorkspaceFacts {
  const teamId = safeIdentity(ids.nextTeamId(), 'Team')
  const workspaceId = safeIdentity(ids.nextWorkspaceId(), 'workspace')
  const branchName = workspaceMode === 'direct' ? 'direct' : `yuqi/${teamId}`
  const worktreePath = workspaceMode === 'direct' ? path.resolve(projectCwd) : path.resolve(managedRoot, workspaceId)
  return { teamId, workspaceId, managedRoot, worktreePath, branchName }
}

function assertPhysicalWorkspace(workspace: TeamWorkspace, identity: ProjectIdentity, generated: GeneratedWorkspaceFacts, workspaceMode: 'git-worktree' | 'direct'): void {
  if (workspace.status !== 'ready'
    || workspace.workspaceId !== generated.workspaceId
    || workspace.branchName !== generated.branchName
    || !samePath(workspace.worktreePath, generated.worktreePath)
    || (workspaceMode === 'direct'
      ? !samePath(workspace.project.projectRoot, identity.projectRoot)
      : !sameProjectIdentity(workspace.project, identity))) {
    throw new YuqiOrchestratorError('WORKSPACE_REQUIRES_RECONCILIATION', 'Physical workspace facts did not match the Host-generated durable identity')
  }
}

function sameWorkspace(left: TeamWorkspace, right: TeamWorkspace): boolean {
  const leftDirect = isDirectProject(left.project)
  const rightDirect = isDirectProject(right.project)
  return left.status === 'ready'
    && right.status === 'ready'
    && left.workspaceId === right.workspaceId
    && samePath(left.worktreePath, right.worktreePath)
    && left.branchName === right.branchName
    && (leftDirect && rightDirect
      ? samePath(left.project.projectRoot, right.project.projectRoot)
      : !leftDirect && !rightDirect && sameProjectIdentity(left.project, right.project))
}

function isDirectProject(value: unknown): value is { readonly mode: 'direct'; readonly projectRoot: string } {
  return typeof value === 'object' && value !== null && (value as { readonly mode?: unknown }).mode === 'direct'
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return samePath(left.projectRoot, right.projectRoot)
    && samePath(left.repositoryRoot, right.repositoryRoot)
    && samePath(left.gitCommonDirectory, right.gitCommonDirectory)
    && left.baselineRef === right.baselineRef
    && samePath(left.volumeRoot, right.volumeRoot)
    && left.protectedRoots.length === right.protectedRoots.length
    && left.protectedRoots.every((root, index) => samePath(root, right.protectedRoots[index]!))
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function ownController<Controller>(launch: StartTeamControllerLaunch<Controller>): StartTeamControllerOwner<Controller> {
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (disposal === undefined) {
      const attempt = Promise.resolve().then(() => launch.dispose())
      disposal = attempt
      void attempt.catch(() => {
        if (disposal === attempt) disposal = undefined
      })
    }
    return disposal
  }
  return Object.freeze({ controller: launch.controller, dispose })
}

async function disposeAfterFailure<Controller>(owner: StartTeamControllerOwner<Controller>): Promise<void> {
  try {
    await owner.dispose()
  } catch (cause) {
    throw safeFailure('CONTROLLER_REQUIRES_RECONCILIATION', 'The fresh Team controller could not be disposed safely; reconciliation is required', cause)
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Team start was cancelled before the next Host side effect')
}

function safeIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new YuqiOrchestratorError('INVALID_BATCH', `The Host could not mint a safe ${label} identity`)
  }
  return value
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new YuqiOrchestratorError('INVALID_BATCH', `${label} is required`)
  return value.trim()
}

function optionalNonEmpty(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined
  return nonEmpty(value, label)
}

function safeFailure(code: YuqiOrchestratorErrorCode, message: string, cause: unknown): YuqiOrchestratorError {
  return new YuqiOrchestratorError(code, message, { cause })
}

function isHostSessionIncompatibility(cause: unknown): boolean {
  return (cause instanceof YuqiOrchestratorError && cause.code === 'HOST_SESSION_INCOMPATIBLE')
    || (cause instanceof Error && cause.message.includes('Current Harness does not support ignorable downstream Session events'))
}

async function advanceRecovery(
  store: StartTeamRecoveryStore,
  handle: StartTeamRecoveryHandle | undefined,
  phase: StartTeamRecoveryPhase,
  failureMessage: string,
  controllerSessionId?: string,
): Promise<StartTeamRecoveryHandle | undefined> {
  if (handle === undefined) return undefined
  try {
    return await store.advance(handle, phase, controllerSessionId)
  } catch (cause) {
    throw safeFailure('CONTROLLER_REQUIRES_RECONCILIATION', recoveryMessage(failureMessage, handle), cause)
  }
}

async function markFailedRecovery(
  store: StartTeamRecoveryStore,
  handle: StartTeamRecoveryHandle | undefined,
  phase: Extract<StartTeamRecoveryPhase, 'bootstrap-failed' | 'confirmation-failed'>,
  controllerSessionId: string,
): Promise<StartTeamRecoveryHandle | undefined> {
  if (handle === undefined) return undefined
  try {
    return await store.advance(handle, phase, controllerSessionId)
  } catch {
    // Preserve the prior enumerable manifest. Its non-failure phase keeps
    // cleanup fail-closed instead of guessing that controller disposal won.
    return handle
  }
}

function recoveryMessage(message: string, handle: StartTeamRecoveryHandle | undefined): string {
  return handle === undefined ? message : `${message}; recovery handle ${handle.recoveryId}`
}
