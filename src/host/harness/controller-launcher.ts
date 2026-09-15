/** Create a fresh top-level Yuqi controller inside an already verified Team worktree. */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { teamWorkspaceSchema } from '../../domain/workspace.ts'
import type { TeamWorkspace } from '../../domain/workspace.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { registerYuqiControllerCommand } from './commands.ts'
import { workspaceProjectRoot } from '../workspace-project-root.ts'

let lastControllerEpochMs = 0
let controllerSequence = 0

/** Fixed diagnostics distinguish unresolved Host awaits without logging IDs,
 * paths, model options or errors. The work and rejection remain unchanged. */
export async function traceControllerResume<T>(
  stage: 'native-load' | 'launcher' | 'preset-resolve' | 'agent-resume' | 'preset-mount',
  work: () => Promise<T>,
): Promise<T> {
  console.warn(`[yuqi-team] controller-resume stage=${stage} outcome=begin`)
  try {
    const result = await work()
    console.warn(`[yuqi-team] controller-resume stage=${stage} outcome=end`)
    return result
  } catch (cause) {
    console.warn(`[yuqi-team] controller-resume stage=${stage} outcome=failed`)
    throw cause
  }
}

function nextSortableControllerSessionId(): string {
  const observed = Date.now()
  const epochMs = Math.max(observed, lastControllerEpochMs)
  controllerSequence = epochMs === lastControllerEpochMs ? controllerSequence + 1 : 0
  lastControllerEpochMs = epochMs
  return `yuqi-team-${epochMs.toString(36).padStart(10, '0')}-${controllerSequence.toString(36).padStart(4, '0')}-${randomUUID()}`
}

/** Immutable creation ordinal embedded in controllers minted by this Host. */
export function controllerActivationOrdinal(sessionId: string): string | undefined {
  const match = /^yuqi-team-([0-9a-z]{10})-([0-9a-z]{4})-[0-9a-f-]{36}$/u.exec(sessionId)
  return match === null ? undefined : `${match[1]}-${match[2]}`
}

export interface AgentCreationPort {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume?(options: ResumeAgentOptions): Promise<AgentHandle>
}

export interface AgentPresetMountPort {
  resolve(id?: string): Promise<{ readonly id: string; readonly broken?: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

export interface LaunchTeamControllerRequest {
  readonly workspace: TeamWorkspace
  readonly controllerModel: AgentOptions
  /** Invoking user session, used only for native Harness navigation lineage. */
  readonly parentSessionId?: string
  /** Preset inherited by the controller's native continuable children. */
  readonly childPresetId?: string
  readonly signal?: AbortSignal
}

export interface TeamControllerLaunch {
  readonly sessionId: string
  readonly handle: AgentHandle
}

/** The isolated controller is a journal and native child owner, never a second
 * autonomous model. Native child reports can wake it, so enforce this at the
 * public pre-step boundary, before model requests or tools. The exact identity
 * check preserves ordinary entry sessions and inherited child compositions.
 */
export function installControllerJournalGuard(agentCtx: Context, controllerSessionId: string): void {
  agentCtx.on('agent/pre-step', async ({ agent }, next) => String(agent.id) === controllerSessionId
    ? { kind: 'reject' }
    : next(), { prepend: true })
}

/** Uses only public AgentRegistry and AgentPresets capabilities. */
export class HarnessTeamControllerLauncher {
  readonly #agents: AgentCreationPort
  readonly #presets: AgentPresetMountPort
  readonly #presetId: string
  readonly #nextSessionId: () => string

  constructor(
    agents: AgentCreationPort,
    presets: AgentPresetMountPort,
    // The entry session uses the Yuqi preset, but the isolated controller must
    // run on Harness's native coding composition so its children inherit the
    // complete, version-matched Agent tool surface.
    presetId = 'standard',
    nextSessionId: () => string = nextSortableControllerSessionId,
  ) {
    this.#agents = agents
    this.#presets = presets
    this.#presetId = presetId
    this.#nextSessionId = nextSessionId
  }

  async launch(request: LaunchTeamControllerRequest): Promise<TeamControllerLaunch> {
    request.signal?.throwIfAborted()
    const workspace = teamWorkspaceSchema.parse(request.workspace)
    if (workspace.status !== 'ready') {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'A Yuqi controller requires a durable ready Team workspace')
    }
    let cwd: string
    try {
      cwd = path.resolve(await realpath(workspaceProjectRoot(workspace)))
    } catch (cause) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The Team worktree does not exist or cannot be resolved', { cause })
    }
    if (!samePath(cwd, workspaceProjectRoot(workspace))) {
      throw new YuqiOrchestratorError('UNSAFE_WORKSPACE_PATH', 'The selected Team project cannot be launched through a path alias')
    }
    const presetId = request.childPresetId ?? this.#presetId
    if (presetId === 'yuqi-team') {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The Yuqi Team preset cannot be nested inside itself')
    }
    const preset = await this.#presets.resolve(presetId)
    if (preset.id !== presetId || preset.broken !== undefined) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The Harness controller preset is missing or unusable')
    }
    const sessionId = this.#nextSessionId()
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(sessionId)) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The Host could not mint a safe Team controller identity')
    }
    const parentSession = request.parentSessionId === undefined
      ? undefined
      : safeSessionId(request.parentSessionId, 'parent controller')
    const handle = await this.#agents.create({
      sessionId: SessionId(sessionId),
      meta: {
        cwd,
        agentPreset: preset.id,
        ...(parentSession === undefined ? {} : {
          parentSession: SessionId(parentSession),
          // Preserve the parent link for the read-only Team projection, but do
          // not classify the controller as a native subagent. Harness lists
          // only origin:'subagent' sessions in the normal child directory;
          // marking this orchestration journal that way creates a fake worker
          // row (and a misleading corrupt-session error on failed bootstrap).
          // Direct task workers are still created by the native subagent
          // service and keep their real origin classification.
        }),
      },
      agentOptions: request.controllerModel,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      setup: async agentCtx => {
        await this.#presets.mount(agentCtx, preset.id)
        installControllerJournalGuard(agentCtx, sessionId)
        // Add only the controller-local /yuqi surface after mounting standard.
        // The model-facing yuqi_team_start tool remains confined to the Yuqi
        // entry preset and is never registered in ordinary standard sessions.
        registerYuqiControllerCommand(agentCtx)
      },
    })
    return Object.freeze({ sessionId, handle })
  }

  /** Rehydrate a persisted Team controller for control/reconciliation after Host restart. */
  async resume(
    sessionId: string,
    presetOrSignal: string | AbortSignal = this.#presetId,
    signal?: AbortSignal,
    agentOptions?: AgentOptions,
  ): Promise<TeamControllerLaunch> {
    const presetId = typeof presetOrSignal === 'string' ? presetOrSignal : this.#presetId
    const resumeSignal = typeof presetOrSignal === 'string' ? signal : presetOrSignal
    resumeSignal?.throwIfAborted()
    if (this.#agents.resume === undefined) {
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Harness Agent resume is unavailable')
    }
    const safeId = safeSessionId(sessionId, 'Team controller')
    if (presetId === 'yuqi-team') {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The Yuqi Team preset cannot be nested inside itself')
    }
    const preset = await traceControllerResume('preset-resolve', () => this.#presets.resolve(presetId))
    if (preset.id !== presetId || preset.broken !== undefined) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The Harness controller preset is missing or unusable')
    }
    const handle = await traceControllerResume('agent-resume', () => this.#agents.resume!({
      resumeSessionId: SessionId(safeId),
      ...(agentOptions === undefined ? {} : { agentOptions }),
      ...(resumeSignal === undefined ? {} : { signal: resumeSignal }),
      setup: async agentCtx => {
        await traceControllerResume('preset-mount', () => this.#presets.mount(agentCtx, preset.id))
        installControllerJournalGuard(agentCtx, safeId)
        registerYuqiControllerCommand(agentCtx)
      },
    }))
    return Object.freeze({ sessionId: safeId, handle })
  }
}

function safeSessionId(value: string, label: string): string {
  const normalized = value.trim()
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(normalized)) {
    throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `The Host received an invalid ${label} session identity`)
  }
  return normalized
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
