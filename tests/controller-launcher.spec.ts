import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { controllerActivationOrdinal, HarnessTeamControllerLauncher, installControllerJournalGuard, traceControllerResume } from '../src/host/harness/controller-launcher.ts'
import type { AgentCreationPort, AgentPresetMountPort } from '../src/host/harness/controller-launcher.ts'
import { teamWorkspaceSchema } from '../src/domain/workspace.ts'

it('reports a pending resume stage and preserves its exact rejection without private details', async () => {
  const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    let reject!: (reason: unknown) => void
    const failure = new Error('private session and path')
    const pending = traceControllerResume('native-load', () => new Promise((_resolve, fail) => { reject = fail }))
    expect(stderr.mock.calls).toEqual([['[yuqi-team] controller-resume stage=native-load outcome=begin']])
    reject(failure)
    await expect(pending).rejects.toBe(failure)
    expect(stderr.mock.calls).toEqual([
      ['[yuqi-team] controller-resume stage=native-load outcome=begin'],
      ['[yuqi-team] controller-resume stage=native-load outcome=failed'],
    ])
  } finally { stderr.mockRestore() }
})

function workspace(worktreePath: string, status: 'ready' | 'needs_reconciliation' = 'ready') {
  return teamWorkspaceSchema.parse({
    workspaceId: 'workspace-1',
    project: {
      projectRoot: path.dirname(worktreePath), repositoryRoot: path.dirname(worktreePath),
      gitCommonDirectory: path.join(path.dirname(worktreePath), '.git'), baselineRef: 'commit-1',
      volumeRoot: path.parse(worktreePath).root, protectedRoots: [],
    },
    worktreePath, branchName: 'yuqi/team', status,
  })
}

function controllerContext() {
  const register = vi.fn()
  const on = vi.fn()
  const service = {}
  return {
    register,
    on,
    ctx: {
      on,
      get: vi.fn(() => service),
      inject: vi.fn((_dependencies: readonly string[], callback: (ctx: unknown) => void) => {
        callback({ commands: { register } })
      }),
      agents: { get: vi.fn() },
    } as never,
  }
}

describe('Harness Team controller launcher', () => {
  it('rejects only the exact journal controller step and preserves child/entry steps', async () => {
    const context = controllerContext()
    installControllerJournalGuard(context.ctx, 'yuqi-team-controller')
    expect(context.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    const listener = context.on.mock.calls[0]![1]
    const next = vi.fn(async () => ({ kind: 'enter', messages: [] }))
    await expect(listener({ agent: { id: 'yuqi-team-controller' } }, next)).resolves.toEqual({ kind: 'reject' })
    expect(next).not.toHaveBeenCalled()
    await expect(listener({ agent: { id: 'child-1' } }, next)).resolves.toEqual({ kind: 'enter', messages: [] })
    await expect(listener({ agent: { id: 'ordinary-parent' } }, next)).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(next).toHaveBeenCalledTimes(2)
  })
  it('mints distinct sortable activation ordinals for controllers created in the same millisecond', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-ordinal-'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      const agents: AgentCreationPort = { async create() { return { agent: {} as never, async dispose() {} } } }
      const presets: AgentPresetMountPort = { async resolve() { return { id: 'standard' } }, async mount() {} }
      const launcher = new HarnessTeamControllerLauncher(agents, presets)
      const first = await launcher.launch({ workspace: workspace(root), controllerModel: {} })
      const second = await launcher.launch({ workspace: workspace(root), controllerModel: {} })
      const firstOrdinal = controllerActivationOrdinal(first.sessionId)
      const secondOrdinal = controllerActivationOrdinal(second.sessionId)
      expect(firstOrdinal).toMatch(/^[0-9a-z]{10}-0000$/u)
      expect(secondOrdinal).toMatch(/^[0-9a-z]{10}-0001$/u)
      expect(secondOrdinal! > firstOrdinal!).toBe(true)
      expect(controllerActivationOrdinal('legacy-controller')).toBeUndefined()
    } finally {
      now.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates a projection-linked controller without exposing it as a native subagent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-'))
    try {
      let options: unknown
      let mounted = ''
      const commandContext = controllerContext()
      const handle = { agent: {} as never, async dispose() {} }
      const agents: AgentCreationPort = { async create(value) { options = value; await value.setup?.(commandContext.ctx); return handle } }
      const presets: AgentPresetMountPort = {
        async resolve() { return { id: 'standard' } },
        async mount(_ctx, id) { mounted = id ?? '' },
      }
      const result = await new HarnessTeamControllerLauncher(agents, presets, 'standard', () => 'controller-1')
        .launch({ workspace: workspace(root), controllerModel: { provider: 'deepseek', model: 'deepseek-v4' }, parentSessionId: 'entry-1' })

      expect(result).toEqual({ sessionId: 'controller-1', handle })
      expect(options).toMatchObject({
        sessionId: 'controller-1', meta: { cwd: root, agentPreset: 'standard', parentSession: 'entry-1' },
        agentOptions: { provider: 'deepseek', model: 'deepseek-v4' },
      })
      expect((options as { readonly meta: Record<string, unknown> }).meta).not.toHaveProperty('origin')
      expect(mounted).toBe('standard')
      expect(commandContext.register).toHaveBeenCalledOnce()
      expect(commandContext.register.mock.calls[0]![0]).toMatchObject({ name: 'yuqi' })
      expect(commandContext.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('launches the controller in the selected nested project inside its worktree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-nested-'))
    const sourceRoot = path.join(root, 'source')
    const worktreeRoot = path.join(root, 'worktree')
    await mkdir(path.join(sourceRoot, 'website'), { recursive: true })
    await mkdir(path.join(worktreeRoot, 'website'), { recursive: true })
    let options: { readonly meta?: { readonly cwd?: string } } | undefined
    const agents: AgentCreationPort = {
      async create(value) {
        options = value
        return { agent: {} as never, async dispose() {} }
      },
    }
    const presets: AgentPresetMountPort = { async resolve() { return { id: 'standard' } }, async mount() {} }
    const nestedWorkspace = teamWorkspaceSchema.parse({
      workspaceId: 'workspace-nested',
      project: {
        projectRoot: path.join(sourceRoot, 'website'), repositoryRoot: sourceRoot,
        gitCommonDirectory: path.join(sourceRoot, '.git'), baselineRef: 'commit-1',
        volumeRoot: path.parse(root).root, protectedRoots: [],
      },
      worktreePath: worktreeRoot, branchName: 'yuqi/nested', status: 'ready',
    })
    try {
      await new HarnessTeamControllerLauncher(agents, presets).launch({ workspace: nestedWorkspace, controllerModel: {} })
      expect(options?.meta?.cwd).toBe(path.join(worktreeRoot, 'website'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('mounts the requested child preset and rejects recursive Yuqi composition', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-preset-'))
    const resolved: string[] = []
    let mounted = ''
    let created = 0
    const agents: AgentCreationPort = {
      async create(options) {
        created += 1
        await options.setup?.(controllerContext().ctx)
        return { agent: {} as never, async dispose() {} }
      },
    }
    const presets: AgentPresetMountPort = {
      async resolve(id) { resolved.push(id ?? ''); return { id: id ?? '' } },
      async mount(_ctx, id) { mounted = id ?? '' },
    }
    try {
      await new HarnessTeamControllerLauncher(agents, presets).launch({
        workspace: workspace(root), controllerModel: {}, childPresetId: 'ptc',
      })
      expect(resolved).toEqual(['ptc'])
      expect(mounted).toBe('ptc')
      await expect(new HarnessTeamControllerLauncher(agents, presets).launch({
        workspace: workspace(root), controllerModel: {}, childPresetId: 'yuqi-team',
      })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      expect(created).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an unsafe parent session identity before agent creation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-'))
    let creates = 0
    const agents: AgentCreationPort = { async create() { creates += 1; throw new Error('not reached') } }
    const presets: AgentPresetMountPort = { async resolve() { return { id: 'standard' } }, async mount() {} }
    try {
      await expect(new HarnessTeamControllerLauncher(agents, presets).launch({
        workspace: workspace(root), controllerModel: {}, parentSessionId: '../bad',
      })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      expect(creates).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('fails before agent creation for an unready workspace or unusable preset', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-'))
    let creates = 0
    const agents: AgentCreationPort = { async create() { creates += 1; throw new Error('not reached') } }
    try {
      const presets: AgentPresetMountPort = { async resolve() { return { id: 'standard', broken: 'bad yaml' } }, async mount() {} }
      const launcher = new HarnessTeamControllerLauncher(agents, presets)
      await expect(launcher.launch({ workspace: workspace(root, 'needs_reconciliation'), controllerModel: {} }))
        .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      await expect(launcher.launch({ workspace: workspace(root), controllerModel: {} }))
        .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      expect(creates).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a worktree symlink alias before mounting or creating', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-'))
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(target)
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    let touched = false
    const agents: AgentCreationPort = { async create() { touched = true; throw new Error('not reached') } }
    const presets: AgentPresetMountPort = { async resolve() { touched = true; return { id: 'standard' } }, async mount() {} }
    try {
      await expect(new HarnessTeamControllerLauncher(agents, presets).launch({ workspace: workspace(alias), controllerModel: {} }))
        .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
      expect(touched).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a missing worktree and an unsafe minted controller identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-invalid-'))
    const missing = path.join(root, 'missing')
    let creates = 0
    const agents: AgentCreationPort = { async create() { creates += 1; throw new Error('not reached') } }
    const presets: AgentPresetMountPort = { async resolve() { return { id: 'standard' } }, async mount() {} }
    try {
      await expect(new HarnessTeamControllerLauncher(agents, presets).launch({ workspace: workspace(missing), controllerModel: {} }))
        .rejects.toMatchObject({ code: 'UNSAFE_WORKSPACE_PATH' })
      await expect(new HarnessTeamControllerLauncher(agents, presets, 'standard', () => '../unsafe').launch({
        workspace: workspace(root), controllerModel: {},
      })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
      expect(creates).toBe(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not expose the preset value as an Agent setup commit and respects a pre-aborted launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-launch-'))
    let setupResult: unknown = Symbol('not-called')
    const agents: AgentCreationPort = {
      async create(options) {
        setupResult = await options.setup?.(controllerContext().ctx)
        return { agent: {} as never, async dispose() {} }
      },
    }
    const presets: AgentPresetMountPort = {
      async resolve() { return { id: 'standard' } },
      async mount() { return { id: 'standard' } },
    }
    try {
      const launcher = new HarnessTeamControllerLauncher(agents, presets, 'standard', () => 'controller-commit')
      await launcher.launch({ workspace: workspace(root), controllerModel: {} })
      expect(setupResult).toBeUndefined()
      await launcher.launch({ workspace: workspace(root), controllerModel: {}, signal: new AbortController().signal })
      const aborted = AbortSignal.abort(new Error('stop'))
      await expect(launcher.launch({ workspace: workspace(root), controllerModel: {}, signal: aborted })).rejects.toThrow('stop')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('resumes a persisted controller with the standard preset and controller command', async () => {
    const commandContext = controllerContext()
    const handle = { agent: {} as never, async dispose() {} }
    let options: unknown
    let mounted = ''
    const agents: AgentCreationPort = {
      async create() { throw new Error('not used') },
      async resume(value) {
        options = value
        await value.setup?.(commandContext.ctx)
        return handle
      },
    }
    const presets: AgentPresetMountPort = {
      async resolve(id) { return { id: id ?? '' } },
      async mount(_ctx, id) { mounted = id ?? '' },
    }

    const result = await new HarnessTeamControllerLauncher(agents, presets)
      .resume('yuqi-team-existing')

    expect(result).toEqual({ sessionId: 'yuqi-team-existing', handle })
    expect(options).toMatchObject({ resumeSessionId: 'yuqi-team-existing' })
    expect(mounted).toBe('standard')
    expect(commandContext.register).toHaveBeenCalledOnce()
    expect(commandContext.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function), { prepend: true })

    await new HarnessTeamControllerLauncher(agents, presets)
      .resume('yuqi-team-existing-with-signal', 'standard', new AbortController().signal)
    expect(options).toMatchObject({ resumeSessionId: 'yuqi-team-existing-with-signal', signal: expect.any(AbortSignal) })

    await expect(new HarnessTeamControllerLauncher(agents, presets).resume('yuqi-team-existing', 'yuqi-team'))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })

  it('fails closed when controller resume is unavailable, unsafe, aborted, or has a broken preset', async () => {
    const unavailable: AgentCreationPort = { async create() { throw new Error('not used') } }
    const validPresets: AgentPresetMountPort = { async resolve() { return { id: 'standard' } }, async mount() {} }
    const unavailableLauncher = new HarnessTeamControllerLauncher(unavailable, validPresets)
    await expect(unavailableLauncher.resume('yuqi-team-existing'))
      .rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })

    const agents: AgentCreationPort = {
      async create() { throw new Error('not used') },
      async resume() { throw new Error('must not resume') },
    }
    const launcher = new HarnessTeamControllerLauncher(agents, validPresets)
    await expect(launcher.resume('../unsafe')).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    await expect(launcher.resume('yuqi-team-existing', AbortSignal.abort(new Error('stop')))).rejects.toThrow('stop')

    const brokenPresets: AgentPresetMountPort = { async resolve() { return { id: 'standard', broken: 'missing' } }, async mount() {} }
    await expect(new HarnessTeamControllerLauncher(agents, brokenPresets).resume('yuqi-team-existing'))
      .rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })
})
