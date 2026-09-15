// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { apply as applyPlugin, openTeamCenterSession } from '../../src/client/index.ts'
import { createRequestId, primaryTeamAction, retryCommandLine, stopCommandLine, teamActionLabel, teamCommandLine } from '../../src/client/command-actions.ts'
import { yuqiNativeDecisionStyles, yuqiTeamStyles } from '../../src/client/styles.ts'
import { replayTeamEvents } from '../../src/domain/projection.ts'
import { summarizeTeamForConsole } from '../../src/application/team-console-summary.ts'
import { completeTeamEvents } from '../fixtures.ts'
import { requestTeamSettingsOpen } from '../../src/client/team-settings-events.ts'
import type { ModelRoutingPolicy } from '../../src/domain/model-route.ts'
import type { ReviewPolicy } from '../../src/domain/review-policy.ts'
import { DEFAULT_TEAM_SETTINGS } from '../../src/domain/team-settings-contract.ts'
import { TEAM_SETTINGS_SCOPE_CHANNEL, type TeamSettingsScopeRequest, type TeamSettingsScopeView, type TeamSettingsScopeWrite } from '../../src/domain/team-settings-scope.ts'
import { TEAM_SIDECAR_CHANNEL } from '../../src/domain/team-sidecar-web-contract.ts'

const pluginDisposers: Array<() => void> = []
async function apply(ctx: ClientContext) {
  await act(async () => { applyPlugin(ctx); await Promise.resolve(); await Promise.resolve() })
}
afterEach(() => {
  for (const dispose of pluginDisposers.splice(0)) dispose()
  cleanup()
  document.querySelectorAll('style[data-plugin="yuqi-team-orchestrator"]').forEach(style => style.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

function stableRead<T>(read: () => T): () => T {
  let previous: T
  let serialized: string | undefined
  return () => { const next = read(); const json = JSON.stringify(next); if (json !== serialized) { previous = next; serialized = json }; return previous! }
}

function clientContext(snapshot: unknown = { team: { id: 'team-1' }, controllerSessionId: 'controller-1' }, projectionFailure = false, pending: readonly unknown[] = [], routingOverride?: ModelRoutingPolicy) {
  const styleDisposers: Array<() => void> = []
  const injections: Array<() => () => void> = []
  const headerInjections: Array<() => () => void> = []
  const openSubagent = vi.fn()
  const openSession = vi.fn()
  const refreshSubagents = vi.fn(async () => undefined)
  const subagentAddress = vi.fn((id: string) => id === 'child-1' ? { parentSessionId: 'team-1', childSessionId: id } : undefined)
  const command = vi.fn(async (line: string) => ({
    ok: line !== '/fail',
    value: { matched: line === '/matched' || line.startsWith('/yuqi retry ') || line.startsWith('/yuqi stop ') || line.startsWith('/yuqi message ') || line.startsWith('/yuqi model ') || line.startsWith('/yuqi authority ') || line.startsWith('/yuqi resolve ') || line.startsWith('/yuqi recover-continue ') || line.startsWith('/yuqi attach ') },
  }))
  const archiveSession = vi.fn(async () => undefined)
  const sessionPresets: Record<string, string> = { 'team-1': 'yuqi-team', 'fresh-session': 'standard' }
  const sessionTeamProjections: Record<string, unknown> = { 'team-1': snapshot }
  let currentSessionId = 'team-1'
  const sessionListListeners = new Set<() => void>()
  const sessionListDisposers: Array<ReturnType<typeof vi.fn>> = []
  const settingsListeners = new Set<() => void>()
  let teamSettingsValue = {
    maxConcurrency: 4,
    childPresetId: 'standard',
    childModelId: '',
    childModelPolicy: 'inherit' as 'inherit' | 'fixed' | 'automatic',
    quickModelId: '',
    standardModelId: '',
    criticalModelId: '',
    modelRouting: routingOverride,
    requirePlanConfirmation: true,
    defaultAuthorityMode: 'write-authorized' as 'read-only' | 'write-authorized' | 'full-access',
    defaultWorkspaceMode: 'direct' as 'direct' | 'git-worktree',
    reviewPolicy: { mode: 'manual', maxReworkRounds: 2, additionalPrompt: '' } as ReviewPolicy,
  }
  let teamSettingsSnapshot = {
    status: 'ready' as const,
    value: teamSettingsValue,
    base: {
      maxConcurrency: 4,
      childPresetId: 'standard',
      childModelId: '',
      childModelPolicy: 'inherit' as const,
      quickModelId: '',
      standardModelId: '',
      criticalModelId: '',
      requirePlanConfirmation: true,
      defaultAuthorityMode: 'write-authorized' as const,
      defaultWorkspaceMode: 'direct' as const,
      reviewPolicy: { mode: 'manual' as const, maxReworkRounds: 2, additionalPrompt: '' },
    },
    user: {},
    revision: 1,
    writable: true,
    mode: 'host' as const,
  }
  const teamSettings = {
    getSnapshot: () => teamSettingsSnapshot,
    subscribe: (listener: () => void) => {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    },
    set: vi.fn(async (field: string, value: unknown) => {
      if (field === 'maxConcurrency' && typeof value === 'number') {
        teamSettingsValue = { ...teamSettingsValue, maxConcurrency: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'childPresetId' && typeof value === 'string') {
        teamSettingsValue = { ...teamSettingsValue, childPresetId: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'childModelId' && typeof value === 'string') {
        teamSettingsValue = { ...teamSettingsValue, childModelId: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'childModelPolicy' && (value === 'inherit' || value === 'fixed' || value === 'automatic')) {
        teamSettingsValue = { ...teamSettingsValue, childModelPolicy: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'quickModelId' && typeof value === 'string') {
        teamSettingsValue = { ...teamSettingsValue, quickModelId: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'standardModelId' && typeof value === 'string') {
        teamSettingsValue = { ...teamSettingsValue, standardModelId: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'criticalModelId' && typeof value === 'string') {
        teamSettingsValue = { ...teamSettingsValue, criticalModelId: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'modelRouting' && value !== undefined) {
        teamSettingsValue = { ...teamSettingsValue, modelRouting: value as ModelRoutingPolicy }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'requirePlanConfirmation' && typeof value === 'boolean') {
        teamSettingsValue = { ...teamSettingsValue, requirePlanConfirmation: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'defaultAuthorityMode' && (value === 'read-only' || value === 'write-authorized' || value === 'full-access')) {
        teamSettingsValue = { ...teamSettingsValue, defaultAuthorityMode: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'defaultWorkspaceMode' && (value === 'direct' || value === 'git-worktree')) {
        teamSettingsValue = { ...teamSettingsValue, defaultWorkspaceMode: value }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      if (field === 'reviewPolicy' && typeof value === 'object' && value !== null) {
        teamSettingsValue = { ...teamSettingsValue, reviewPolicy: value as ReviewPolicy }
        teamSettingsSnapshot = { ...teamSettingsSnapshot, value: teamSettingsValue, revision: teamSettingsSnapshot.revision + 1 }
      }
      for (const listener of settingsListeners) listener()
    }),
  }
  const settingsScope = { bind: vi.fn(() => teamSettings) }
  let scopedView: TeamSettingsScopeView = {
    level: 'global', value: { ...DEFAULT_TEAM_SETTINGS, maxConcurrency: 4, ...(routingOverride === undefined ? {} : { modelRouting: routingOverride }) }, inherited: DEFAULT_TEAM_SETTINGS,
    overrides: {}, sources: Object.fromEntries(Object.keys(DEFAULT_TEAM_SETTINGS).map(key => [key, 'global'])) as TeamSettingsScopeView['sources'],
    revision: 1, globalRevision: 1, binding: 'fixture-global', writable: true,
  }
  const settingsRead = vi.fn(async (request: TeamSettingsScopeRequest = { level: 'global' }) => ({
    ok: true, value: { ...scopedView, ...request },
  }))
  const settingsWrite = vi.fn(async (request: TeamSettingsScopeWrite) => {
    expect(request.level).toBe('global')
    expect(request.sessionId).toBeUndefined()
    expect(request.binding).toBe(scopedView.binding)
    expect(request.revision).toBe(scopedView.revision)
    expect(request.globalRevision).toBe(scopedView.globalRevision)
    scopedView = { ...scopedView, overrides: request.overrides, value: { ...scopedView.inherited, ...request.overrides },
      revision: scopedView.revision + 1, globalRevision: scopedView.globalRevision + 1 }
    return { ok: true, value: scopedView }
  })
  const connection = { rpc: { call: vi.fn(async (channel: unknown, method: unknown, request: unknown, signal?: unknown): Promise<unknown> => {
    if (channel === TEAM_SIDECAR_CHANNEL && method === 'snapshot') {
      expect(signal).toBeInstanceOf(AbortSignal)
      return { ok: true, value: { mode: 'legacy', sessions: [] } }
    }
    if (channel === TEAM_SETTINGS_SCOPE_CHANNEL && method === 'read') {
      const scope = request as TeamSettingsScopeRequest
      expect(['global', 'project', 'session']).toContain(scope.level)
      expect(request).toEqual(scope.level === 'global' ? { level: 'global' } : { level: scope.level, sessionId: currentSessionId })
      return settingsRead(scope)
    }
    if (channel === TEAM_SETTINGS_SCOPE_CHANNEL && method === 'write') return settingsWrite(request as TeamSettingsScopeWrite)
    throw new Error(`Unexpected fixture RPC: ${String(channel)} ${String(method)}`)
  }) }, api: {
    agentPresets: {
      list: vi.fn(async () => ({ result: { ok: true, value: { presets: [
      { id: 'standard', trust: 'system', isDefault: true, name: '标准模式' },
      { id: 'minimal', trust: 'system', isDefault: false, name: '极简模式' },
      { id: 'yuqi-team', trust: 'user', isDefault: false, name: 'Yuqi Team' },
      { id: 'broken-preset', trust: 'user', isDefault: false, name: '损坏模式', broken: { message: 'bad' } },
      ], authorable: true, hasDocument: true } } })),
      select: vi.fn(async () => ({ result: { ok: true, value: { agentPreset: 'yuqi-team' } } })),
    },
    sessions: { models: vi.fn(async () => ({ result: { ok: true, value: {
      current: { provider: 'deepseek', model: 'deepseek-v4' }, routable: true,
      groups: [
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
        { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other model' }] },
      ], failures: [],
    } } })) },
  } }
  const projectionDisposer = vi.fn()
  const projectionSubscribe = vi.fn(() => projectionDisposer)
  const boundProjection = { getSnapshot: () => snapshot, subscribe: projectionSubscribe }
  const boundSession = {
    command,
    getSnapshot: stableRead(() => ({ pending, nodes: command.mock.calls.map(([line], index) => ({
      // Stable per admitted command, including historical nodes across snapshots.
      commandId: CommandId(`client-fixture-command-${index + 1}`),
      kind: 'command', name: line.slice(1).split(/\s/u)[0], args: line.includes(' ') ? line.slice(line.indexOf(' ')) : '', outcome: { kind: 'success' },
    })) })),
    subscribe: vi.fn(() => () => undefined),
    projections: { faceOf: () => {
      if (projectionFailure) throw new Error('projection unavailable')
      return boundProjection
    } },
  }
  const binding = vi.fn((id: string) => id === 'team-1' ? { session: boundSession } : undefined)
  const register = vi.fn((
    _definition: {
      readonly id: string
      readonly inject: {
        (): unknown
        (sessionId: string): unknown
      }
      readonly [key: string]: unknown
    },
    _component: unknown,
  ) => vi.fn())

  const context = {
    get: vi.fn((name: string) => name === 'connection' ? connection : undefined),
    effect: vi.fn((effect: () => (() => void) | void) => {
      const disposer = effect()
      if (disposer !== undefined) { styleDisposers.push(disposer); pluginDisposers.push(disposer) }
      return disposer
    }),
    slots: {
      inject: vi.fn((_name: string, callback: () => () => void) => {
        if (_name === 'conversation.session.header.actions') headerInjections.push(callback)
        else injections.push(callback)
        return vi.fn()
      }),
      register,
    },
    sessions: {
      open: openSession, openSubagent, subagentAddress, refreshSubagents, binding,
      noteAgentPreset: vi.fn((id: string, preset: string) => { sessionPresets[id] = preset }),
      list: {
        getSnapshot: stableRead(() => ({
          ids: Object.keys(sessionPresets),
          current: currentSessionId,
          byId: Object.fromEntries(Object.entries(sessionPresets).map(([id, agentPreset]) => [id, {
            id, agentPreset, cwd: 'F:/project', blank: id === 'fresh-session',
            ...(sessionTeamProjections[id] === undefined ? {} : { projectionValues: { yuqiTeam: sessionTeamProjections[id] } }),
          }])),
          subagentsByParent: {
            'team-1': { state: 'ready', error: null, parentAvailable: true, entries: [{ kind: 'child', id: 'child-1', mode: 'continuable' }] },
          },
        })),
        subscribe: (listener: () => void) => {
          sessionListListeners.add(listener)
          const dispose = vi.fn(() => { sessionListListeners.delete(listener) })
          sessionListDisposers.push(dispose)
          return dispose
        },
      },
    },
    workspaces: { archiveSession },
    settingsScope,
  } as unknown as ClientContext

  return {
    context, styleDisposers, injections, headerInjections, openSession, openSubagent, refreshSubagents, subagentAddress, binding,
    command, archiveSession, register, settingsScope, teamSettings, settingsRead, settingsWrite, connection, projectionSubscribe, projectionDisposer, sessionListDisposers,
    setSessionPreset(id: string, preset: string) { sessionPresets[id] = preset },
    setSessionTeamProjection(id: string, value: unknown) { sessionTeamProjections[id] = value },
    setCurrentSession(id: string) { currentSessionId = id },
    emitSessionList() { for (const listener of sessionListListeners) listener() },
  }
}

async function mountManagement(harness: ReturnType<typeof clientContext>) {
  await apply(harness.context)
  for (const inject of harness.injections) inject()
  const registration = harness.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team-center')!
  const Center = registration[1] as ComponentType<Record<string, unknown>>
  return render(createElement(Center, (registration[0] as { inject: () => Record<string, unknown> }).inject()))
}

async function settingsReady() {
  await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
}

describe('client plugin entry', () => {
  it('injects sidecar into dock, catalog, navigator, handoff and command binding without native projection access', async () => {
    const h = clientContext(undefined, true)
    const events = completeTeamEvents()
    h.connection.rpc.call.mockResolvedValue({ ok: true, value: { mode: 'sidecar', sessions: [{
      sessionId: 'team-1', source: 'sidecar', events: [{ type: 'yuqi/team-projection-bridge', seq: 1, time: 1, ignorable: true,
        data: JSON.parse(JSON.stringify({ controllerSessionId: 'controller-sidecar', sourceEventCount: events.length, events })) }],
    }] } })
    await apply(h.context)
    for (const inject of [...h.injections, ...h.headerInjections]) inject()
    const dock = h.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team')![0].inject('team-1') as {
      teamProjection: { getSnapshot(): { controllerSessionId: string }; subscribe(fn: () => void): () => void }
      command(line: string, target: { controllerSessionId: string }): Promise<boolean>
    }
    const off = dock.teamProjection.subscribe(() => {})
    expect(dock.teamProjection.getSnapshot().controllerSessionId).toBe('controller-sidecar')
    expect(h.projectionSubscribe).not.toHaveBeenCalled()
    await expect(dock.command('/yuqi retry task-1 request-1', { controllerSessionId: 'controller-sidecar' })).resolves.toBe(true)
    expect(h.command).toHaveBeenCalledWith('/yuqi retry task-1 team-1 controller-sidecar request-1')
    const center = h.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team-center')![0].inject() as { sessions: { getSnapshot(): { byId: Record<string, { projectionValues: unknown }> } } }
    expect(center.sessions.getSnapshot().byId['team-1']?.projectionValues).toMatchObject({ yuqiTeam: { controllerSessionId: 'controller-sidecar' } })
    const navigator = h.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team-session-navigator')![0].inject() as { catalog: unknown }
    const handoff = h.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team-handoff')![0].inject() as { catalog: unknown }
    expect(navigator.catalog).toBe(center.sessions)
    expect(handoff.catalog).toBe(center.sessions)
    h.connection.rpc.call.mockRejectedValue(new Error('offline'))
    const status = h.register.mock.calls.find(([definition]) => definition.id === 'yuqi-team-sidecar-status')![0].inject() as { store: { refresh(): Promise<void> } }
    await status.store.refresh()
    await expect(dock.command('/yuqi retry task-1 request-2', { controllerSessionId: 'controller-sidecar' })).rejects.toMatchObject({ disposition: 'rejected' })
    expect(dock.teamProjection.getSnapshot()).toBeUndefined()
    off()
  })
  it('installs the plugin stylesheet and removes it through the effect disposer', async () => {
    const { context, styleDisposers } = clientContext()

    await apply(context)

    const style = document.querySelector('style[data-plugin="yuqi-team-orchestrator"]')
    expect(style).toBeInTheDocument()
    expect(style?.textContent).toBe(`${yuqiTeamStyles}\n${yuqiNativeDecisionStyles}`)
    expect(styleDisposers).toHaveLength(2)

    styleDisposers[0]!()
    expect(document.querySelector('style[data-plugin="yuqi-team-orchestrator"]')).not.toBeInTheDocument()
  })

  it('registers the dock lazily, binds retry identity, and reports command admission without claiming completion', async () => {
    const { context, injections, openSubagent, refreshSubagents, subagentAddress, command, archiveSession, connection, register } = clientContext()

    await apply(context)
    expect(injections).toHaveLength(5)
    expect(register).not.toHaveBeenCalled()

    const disposer = injections[0]!()
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]![0]).toMatchObject({
      name: 'conversation.input.dock', id: 'yuqi-team', order: 15,
    })
    expect(typeof register.mock.calls[0]![1]).toBe('function')

    const options = register.mock.calls[0]![0] as { inject: (sessionId: string) => {
      onOpenChild: (controllerId: string | undefined, id: string) => Promise<boolean>
      onArchiveChild: (teamId: string, childSessionId: string) => Promise<boolean>
      onArchiveController: (controllerId: string) => Promise<boolean>
      command: (line: string, target?: { readonly teamId?: string; readonly controllerSessionId: string }) => Promise<boolean>
      loadModels: () => Promise<readonly { id: string; name: string }[]>
    } }
    const actions = options.inject('team-1')
    await expect(actions.loadModels()).resolves.toEqual([
      { id: 'deepseek-v4', name: 'DeepSeek V4', providerId: 'deepseek', providerName: 'DeepSeek' },
      { id: 'other-model', name: 'Other model', providerId: 'other', providerName: 'Other' },
    ])
    connection.api.sessions.models.mockResolvedValueOnce({ result: { ok: true, value: {
      current: { provider: 'deepseek', model: 'deepseek/deepseek-v4' }, routable: true,
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }], failures: [],
    } } } as never)
    await expect(actions.loadModels()).resolves.toEqual([{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', providerId: 'deepseek', providerName: 'DeepSeek' }])
    await expect(actions.onArchiveController('controller-1')).resolves.toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('controller-1')
    await expect(actions.onArchiveChild('team-1', 'child-1')).resolves.toBe(true)
    expect(archiveSession).toHaveBeenCalledWith('child-1')
    archiveSession.mockRejectedValueOnce(new Error('archive unavailable'))
    await expect(actions.onArchiveController('controller-1')).resolves.toBe(false)
    expect((actions as Record<string, { getSnapshot?: unknown }>).teamProjection?.getSnapshot).toBeTypeOf('function')
    await expect(actions.onOpenChild('team-1', 'child-1')).resolves.toBe(true)
    expect(refreshSubagents).not.toHaveBeenCalled()
    expect(openSubagent).toHaveBeenCalledWith({ parentSessionId: 'team-1', childSessionId: 'child-1', mode: 'continuable' })
    await expect(actions.onOpenChild('team-1', 'missing')).resolves.toBe(false)

    // Restart clears visited addresses; the refreshed native catalog still
    // authorizes its exact child transcript, including transport mode.
    subagentAddress.mockReturnValueOnce(undefined)
    const opensBeforeStaleCatalog = openSubagent.mock.calls.length
    await expect(actions.onOpenChild('team-1', 'child-1')).resolves.toBe(true)
    expect(openSubagent).toHaveBeenCalledTimes(opensBeforeStaleCatalog + 1)

    // matched=true is slash-command admission only. The UI renders it as
    // submitted/waiting for durable state, never business completion.
    await expect(actions.command('/matched')).resolves.toBe(true)
    await expect(actions.command('/unmatched')).rejects.toMatchObject({ disposition: 'rejected' })
    await expect(actions.command('/fail')).rejects.toMatchObject({ disposition: 'unknown' })
    expect(command).toHaveBeenCalledWith('/matched')
    await expect(actions.command('/yuqi retry task-1 request-1', { controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi retry task-1 team-1 controller-1 request-1')
    await expect(actions.command('/yuqi stop task-1 request-stop', { controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi stop task-1 team-1 controller-1 request-stop')
    await expect(actions.command('/yuqi message all 5rWL6K-V request-message', { controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi message all 5rWL6K-V team-1 controller-1 request-message')
    await expect(actions.command('/yuqi resolve task-1 attempt-1 cancelled request-3', { teamId: 'team-1', controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi resolve task-1 attempt-1 cancelled team-1 controller-1 request-3')
    await expect(actions.command('/yuqi model task-1 deepseek-v4-pro request-4', { teamId: 'team-1', controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi model task-1 deepseek-v4-pro team-1 controller-1 request-4')
    await expect(actions.command('/yuqi model task-1 other other-model request-route', { teamId: 'team-1', controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi model task-1 other other-model team-1 controller-1 request-route')
    await expect(actions.command('/yuqi authority task-1 full-access request-5', { teamId: 'team-1', controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi authority task-1 full-access team-1 controller-1 request-5')
    await expect(actions.command('/yuqi recover-continue request-recover', { teamId: 'team-1', controllerSessionId: 'controller-1' })).resolves.toBe(true)
    expect(command).toHaveBeenCalledWith('/yuqi recover-continue team-1 controller-1 request-recover')
    const callsBeforeInvalid = command.mock.calls.length
    await expect(actions.command('/yuqi resolve task-1 attempt-1 completed request-invalid', { teamId: 'team-1', controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })
    expect(command).toHaveBeenCalledTimes(callsBeforeInvalid)
    const callsBeforeMismatch = command.mock.calls.length
    await expect(actions.command('/yuqi retry task-1 request-2', { controllerSessionId: 'stale-controller' })).rejects.toMatchObject({ disposition: 'rejected' })
    await expect(actions.command('/yuqi retry task-1 request-2', { teamId: 'other-team', controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })
    expect(command).toHaveBeenCalledTimes(callsBeforeMismatch)

    command.mockRejectedValueOnce(new Error('transport unavailable'))
    await expect(actions.command('/matched')).rejects.toMatchObject({ disposition: 'unknown' })

    command.mockRejectedValueOnce(new Error('message transport unavailable'))
    await expect(actions.command('/yuqi message all 5rWL6K-V request-message-unknown', { controllerSessionId: 'controller-1' }))
      .rejects.toMatchObject({ disposition: 'unknown' })

    connection.api.sessions.models.mockResolvedValueOnce({ result: { ok: false, error: { message: 'models unavailable' } } } as never)
    await expect(actions.loadModels()).rejects.toThrow('models unavailable')
    connection.api.sessions.models.mockRejectedValueOnce(new Error('models transport unavailable'))
    await expect(actions.loadModels()).rejects.toThrow('models transport unavailable')

    const noSessionActions = options.inject('missing-session')
    await expect(noSessionActions.command('/matched')).rejects.toMatchObject({ disposition: 'rejected' })
    disposer()
  })

  it('registers a plugin-owned guard around the official preset picker', async () => {
    const harness = clientContext()
    harness.setCurrentSession('fresh-session')
    await apply(harness.context)
    const dispose = harness.injections[1]!()
    const [definition, Component] = harness.register.mock.calls[0]!
    expect(definition).toMatchObject({ name: 'shell.overlay', id: 'yuqi-team-preset-guard', order: 29 })
    const actions = (definition as { inject: () => {
      presetId: string
      sessions: { getSnapshot(): { byId: Record<string, { agentPreset: string }> } }
    } }).inject()
    expect(actions.presetId).toBe('yuqi-team')
    expect(actions.sessions.getSnapshot).toBe(harness.context.sessions.list.getSnapshot)
    expect(actions.sessions.getSnapshot().byId['fresh-session']?.agentPreset).toBe('standard')
    expect(harness.connection.api.agentPresets.select).not.toHaveBeenCalled()
    expect(Component).toBeTypeOf('function')
    dispose()
  })

  it('registers the lightweight Team center and exposes exact main/child navigation', async () => {
    const harness = clientContext()
    await apply(harness.context)
    const dispose = harness.injections[2]!()
    const [definition, Component] = harness.register.mock.calls[0]!
    expect(definition).toMatchObject({ name: 'sidebar.footer.action', id: 'yuqi-team-center', order: 31 })
    const actions = (definition as { inject: () => {
      sessions: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
      openMain(id: string): void
      openChild(controller: string | undefined, child: string): Promise<boolean>
    } }).inject()
    expect(actions.sessions.getSnapshot()).toBeDefined()
    const unsubscribe = actions.sessions.subscribe(() => undefined)
    actions.openMain('team-1')
    expect(harness.openSession).toHaveBeenCalledWith('team-1')
    await expect(actions.openChild('team-1', 'child-1')).resolves.toBe(true)
    expect(Component).toBeTypeOf('function')
    unsubscribe()
    dispose()
  })

  it('routes native decisions and attachment through the sidebar without the old floating overlay', async () => {
    const respond = vi.fn(async () => ({ accepted: true as const }))
    const harness = clientContext(undefined, false, [{
      key: 'a:approval-1', kind: 'approval', sessionId: 'team-1',
      payload: { approvalId: 'approval-1', toolName: 'write_file', reason: '需要写文件' }, respond,
    }])
    const currentBinding = harness.binding('team-1')
    harness.binding.mockImplementation(id => id === 'team-1' || id === 'fresh-session' ? currentBinding : undefined)
    harness.setCurrentSession('fresh-session')
    harness.setSessionPreset('fresh-session', 'yuqi-team')
    await apply(harness.context)
    const dispose = harness.injections[2]!()
    const [definition, Component] = harness.register.mock.calls[0]!
    expect(definition).toMatchObject({ name: 'sidebar.footer.action', id: 'yuqi-team-center', order: 31 })
    const actions = (definition as { inject: () => {
      openMain: (id: string) => boolean | Promise<boolean>
      openChild: (controller: string, child: string) => Promise<boolean>
      attachToCurrent: (summary: { team: { id: string }; controllerSessionId?: string }, id: string) => Promise<boolean>
      getNativeInteractions: (id: string) => readonly { respond(answer: string): Promise<{ accepted: boolean }> }[]
      subscribeNativeInteractions: (id: string, listener: () => void) => () => void
    } }).inject()
    await actions.openChild('team-1', 'child-1')
    expect(harness.openSubagent).toHaveBeenCalledWith({ parentSessionId: 'team-1', childSessionId: 'child-1', mode: 'continuable' })
    await actions.openMain('fresh-session')
    expect(harness.openSession).toHaveBeenCalledWith('fresh-session')
    await expect(actions.attachToCurrent({ team: { id: 'team-1' }, controllerSessionId: 'controller-1' }, 'fresh-session')).resolves.toBe(true)
    expect(harness.command).toHaveBeenLastCalledWith(expect.stringMatching(/^\/yuqi attach team-1 controller-1 attach-/u))
    await expect(actions.attachToCurrent({ team: { id: 'team-1' } }, 'team-1')).resolves.toBe(false)
    const interactions = actions.getNativeInteractions('team-1')
    expect(interactions).toHaveLength(1)
    await expect(interactions[0]!.respond('allowed-once')).resolves.toEqual({ accepted: true })
    expect(respond).toHaveBeenCalledWith({ ok: true, value: { sessionId: 'team-1', approvalId: 'approval-1', outcome: 'allowed-once' } })
    const unsubscribePending = actions.subscribeNativeInteractions('team-1', () => undefined)
    unsubscribePending()
    expect(Component).toBeTypeOf('function')
    dispose()
  })

  it.each(['success', 'error'] as const)('waits for durable attach %s rather than treating matched as success', async kind => {
    const harness = clientContext()
    const currentBinding = harness.binding('team-1')
    harness.binding.mockImplementation(id => id === 'team-1' || id === 'fresh-session' ? currentBinding : undefined)
    harness.setCurrentSession('fresh-session')
    harness.setSessionPreset('fresh-session', 'yuqi-team')
    await apply(harness.context)
    harness.injections[2]!()
    const actions = (harness.register.mock.calls[0]![0] as { inject: () => {
      attachToCurrent: (summary: { team: { id: string }; controllerSessionId: string }, id: string) => Promise<boolean>
    } }).inject()
    const session = harness.context.sessions.binding('team-1' as never)!.session
    let nodes: unknown[] = []
    let notify: (() => void) | undefined
    const read = vi.spyOn(session, 'getSnapshot').mockImplementation(() => ({ nodes }) as never)
    const subscribe = vi.spyOn(session, 'subscribe').mockImplementation(listener => { notify = listener; return () => {} })
    let settled = false
    const result = actions.attachToCurrent({ team: { id: 'team-1' }, controllerSessionId: 'controller-1' }, 'fresh-session')
    void result.then(() => { settled = true }, () => { settled = true })
    await waitFor(() => expect(notify).toBeTypeOf('function'))
    expect(settled).toBe(false)
    const line = harness.command.mock.calls.at(-1)![0]
    nodes = [{ kind: 'command', commandId: 'attach-command', name: 'yuqi', args: line.slice('/yuqi '.length), outcome: { kind, text: 'attach rejected' } }]
    notify!()
    if (kind === 'success') await expect(result).resolves.toBe(true)
    else await expect(result).rejects.toMatchObject({ disposition: 'rejected', message: 'attach rejected' })
    read.mockRestore()
    subscribe.mockRestore()
  })

  it('opens embedded settings through the management tab without a duplicate overlay or header', async () => {
    const h = clientContext(null)
    await mountManagement(h)
    h.headerInjections.forEach(inject => inject())
    expect(h.register.mock.calls.filter(([definition]) => definition.name === 'conversation.session.header.actions')
      .map(([definition]) => definition.id)).toEqual(['yuqi-team-handoff', 'yuqi-team-session-navigator'])
    expect(h.register.mock.calls.some(([definition]) => definition.id === 'yuqi-team-settings')).toBe(false)
    expect(h.register.mock.calls.some(([definition]) => definition.id === 'yuqi-team-sidecar-status')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: '团队任务' }))
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '团队默认设置' }))
    await settingsReady()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeInTheDocument()
    expect(h.settingsRead).toHaveBeenCalledTimes(1)
  })

  it('atomically saves edited global defaults and keeps the embedded form open', async () => {
    const h = clientContext(null)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    expect(screen.queryByRole('option', { name: 'Yuqi Team' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: '损坏模式' })).not.toBeInTheDocument()
    const policy = screen.getByRole('combobox', { name: /默认模型策略/ })
    expect(policy).toHaveValue('automatic')
    fireEvent.change(policy, { target: { value: 'fixed' } })
    expect(screen.getByRole('combobox', { name: /固定默认模型/ })).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))
    fireEvent.change(policy, { target: { value: 'inherit' } })
    fireEvent.click(screen.getByRole('switch', { name: /启动前确认任务图/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /^子代理权限/ }), { target: { value: 'full-access' } })
    fireEvent.change(screen.getByRole('combobox', { name: /^工作方式/ }), { target: { value: 'git-worktree' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: /并发保护上限/ }), { target: { value: '16' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存，仅影响之后启动的 Team。')
    expect(h.settingsWrite).toHaveBeenCalledTimes(1)
    expect(h.settingsWrite.mock.calls[0]![0]).toMatchObject({ level: 'global', overrides: {
      maxConcurrency: 16, modelRouting: { teamPolicy: { kind: 'inherit' } },
      requirePlanConfirmation: false, defaultAuthorityMode: 'full-access', defaultWorkspaceMode: 'git-worktree',
    } })
    expect(h.settingsWrite.mock.calls[0]![0].overrides).not.toHaveProperty('reviewPolicy')
    expect(h.teamSettings.set).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton', { name: /并发保护上限/ })).toHaveValue(16)
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    expect(screen.getByRole('spinbutton', { name: /并发保护上限/ })).toHaveValue(16)
  })

  it('saves the opt-in review policy without replacing untouched model routing', async () => {
    const h = clientContext(null)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    expect(screen.getByRole('radio', { name: '手动审查' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: '自动审查' }))
    fireEvent.change(screen.getByRole('spinbutton', { name: /最多返工次数/ }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('textbox', { name: /审查重点与关注要点/ }), { target: { value: '  检查迁移与回滚  ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存，仅影响之后启动的 Team。')
    expect(h.settingsWrite.mock.calls[0]![0].overrides).toEqual({
      reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 3, additionalPrompt: '检查迁移与回滚' },
    })
    expect(h.teamSettings.set).not.toHaveBeenCalled()
  })

  it('preserves Provider failures and saves an exact allowlisted routing policy', async () => {
    const h = clientContext(null)
    const modelResponse = await h.connection.api.sessions.models()
    h.connection.api.sessions.models.mockClear()
    h.connection.api.sessions.models.mockResolvedValue({
      result: { ok: true, value: { ...modelResponse.result.value,
        failures: [{ id: 'offline', name: 'Offline Provider', message: 'catalog unavailable' }],
      } },
    } as never)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    expect(screen.getByRole('status')).toHaveTextContent('已有配置不会被清除')
    expect(screen.getByRole('status')).toHaveTextContent('Offline Provider')
    fireEvent.change(screen.getByRole('combobox', { name: '允许的供应商' }), { target: { value: 'controller-plus-allowlist' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }))
    fireEvent.change(screen.getByRole('combobox', { name: /快速任务/ }), { target: { value: JSON.stringify(['other', 'other-model']) } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('已保存，仅影响之后启动的 Team。')
    expect(h.settingsWrite.mock.calls[0]![0].overrides.modelRouting).toEqual({
      providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['other'] },
      teamPolicy: { kind: 'automatic', tierCandidates: {
        quick: [{ modelProvider: 'other', modelId: 'other-model' }], standard: [], critical: [],
      } },
    })
  })

  it('explains preserved routes that are missing from the current model directory', async () => {
    const h = clientContext(null, false, [], {
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'automatic', tierCandidates: {
        quick: [{ modelProvider: 'deepseek', modelId: 'historical-model' }], standard: [], critical: [],
      } },
    })
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()

    expect(screen.getByRole('option', { name: /已保留历史配置；当前目录无法读取\/验证/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('保留的历史 Provider / Model')
    expect(screen.getByRole('status')).toHaveTextContent('Provider 范围限制')
    expect(screen.getAllByRole('option', { name: '跟随主控模型（默认）' })).toHaveLength(3)
  })

  it.each(['preset', 'model'] as const)('reports %s discovery failure without writing settings', async catalog => {
    const h = clientContext(null)
    const failure = { result: { ok: false, error: { message: 'catalog unavailable' } } } as never
    if (catalog === 'preset') h.connection.api.agentPresets.list.mockResolvedValue(failure)
    else h.connection.api.sessions.models.mockResolvedValue(failure)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取已安装模式或模型')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(h.settingsWrite).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('loads options from another visible Session when the current model catalog is stale', async () => {
    const h = clientContext(null)
    h.connection.api.sessions.models.mockResolvedValueOnce({ result: { ok: false, error: { message: 'stale current session' } } } as never)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await waitFor(() => expect(h.connection.api.sessions.models).toHaveBeenNthCalledWith(2, { sessionId: 'fresh-session' }))
    await settingsReady()
    expect(h.connection.api.sessions.models).toHaveBeenNthCalledWith(1, { sessionId: 'team-1' })
    expect(screen.getByText(/当前会话供应商尚未取得/)).toBeInTheDocument()
    expect(screen.queryByText('当前会话供应商: DeepSeek (deepseek)')).not.toBeInTheDocument()
  })

  it.each(['project', 'session'] as const)('keeps %s option loading on the exact Session and restores fallback only after switching to global', async level => {
    const h = clientContext(null)
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    h.connection.api.sessions.models.mockClear()
    h.settingsRead.mockClear()
    h.connection.api.sessions.models.mockResolvedValueOnce({ result: { ok: false, error: { message: 'exact session unavailable' } } } as never)
    fireEvent.change(screen.getByRole('combobox', { name: '设置范围' }), { target: { value: level } })
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取已安装模式或模型')
    expect(h.settingsRead).toHaveBeenCalledExactlyOnceWith({ level, sessionId: 'team-1' })
    expect(h.connection.api.sessions.models).toHaveBeenCalledExactlyOnceWith({ sessionId: 'team-1' })
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(h.settingsWrite).not.toHaveBeenCalled()

    h.connection.api.sessions.models.mockClear()
    h.settingsRead.mockClear()
    h.connection.api.sessions.models.mockResolvedValueOnce({ result: { ok: false, error: { message: 'stale current session' } } } as never)
    fireEvent.change(screen.getByRole('combobox', { name: '设置范围' }), { target: { value: 'global' } })
    await settingsReady()
    expect(h.settingsRead).toHaveBeenCalledExactlyOnceWith({ level: 'global' })
    expect(h.connection.api.sessions.models).toHaveBeenCalledTimes(2)
    expect(h.connection.api.sessions.models).toHaveBeenNthCalledWith(1, { sessionId: 'team-1' })
    expect(h.connection.api.sessions.models).toHaveBeenNthCalledWith(2, { sessionId: 'fresh-session' })
  })

  it('validates the form and preserves the draft when atomic settings write fails', async () => {
    const h = clientContext(null)
    h.settingsWrite.mockRejectedValueOnce(new Error('revision conflict'))
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    const input = screen.getByRole('spinbutton', { name: /并发保护上限/ })
    fireEvent.change(input, { target: { value: '1.5' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/请输入 1 到 \d+ 的整数/)
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(h.settingsWrite).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
    expect(input).toHaveValue(8)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(h.teamSettings.set).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))
    await waitFor(() => expect(screen.getByRole('spinbutton', { name: /并发保护上限/ })).toHaveValue(4))
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('fails closed when scoped settings are unavailable and supports dismissal', async () => {
    const h = clientContext(null)
    h.settingsRead.mockRejectedValueOnce(new Error('settings transport unavailable'))
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings transport unavailable')
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    expect(h.settingsWrite).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a pending read bounded by dialog disposal and ignores its late result', async () => {
    const h = clientContext(null)
    const response = await h.settingsRead()
    h.settingsRead.mockClear()
    let resolve!: (value: typeof response) => void
    h.settingsRead.mockReturnValueOnce(new Promise(done => { resolve = done }))
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    await act(async () => { resolve(response) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(h.settingsWrite).not.toHaveBeenCalled()
  })

  it('prevents dismissal during an atomic save, then releases the dialog after completion', async () => {
    const h = clientContext(null)
    const persist = h.settingsWrite.getMockImplementation()!
    let finish!: () => void
    h.settingsWrite.mockImplementationOnce(request => new Promise(resolve => {
      finish = () => { void persist(request).then(resolve) }
    }))
    await mountManagement(h)
    act(() => requestTeamSettingsOpen())
    await settingsReady()
    fireEvent.change(screen.getByRole('spinbutton', { name: /并发保护上限/ }), { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => { finish() })
    await screen.findByText('已保存，仅影响之后启动的 Team。')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('uses exact Session projection evidence instead of treating the Yuqi preset as a Team binding', async () => {
    const harness = clientContext()
    await apply(harness.context)
    harness.injections[0]!()
    const definition = harness.register.mock.calls[0]![0] as { inject: (sessionId: string) => {
      teamProjection: { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }
    } }
    const projection = definition.inject('team-1').teamProjection
    const listener = vi.fn()
    const unsubscribe = projection.subscribe(listener)
    expect(projection.getSnapshot()).toBeDefined()
    harness.emitSessionList()
    expect(listener).toHaveBeenCalled()
    harness.setSessionPreset('team-1', 'standard')
    harness.emitSessionList()
    expect(projection.getSnapshot()).toBeDefined()
    expect(listener).toHaveBeenCalled()
    harness.setSessionPreset('team-1', 'yuqi-team')
    harness.setSessionTeamProjection('team-1', undefined)
    harness.emitSessionList()
    expect(projection.getSnapshot()).toBeUndefined()
    expect(listener).toHaveBeenCalled()
    expect(harness.projectionDisposer).toHaveBeenCalledOnce()
    expect(harness.sessionListDisposers).toHaveLength(2)
    unsubscribe()
    expect(harness.sessionListDisposers[1]).toHaveBeenCalledOnce()
    expect(harness.projectionDisposer).toHaveBeenCalledOnce()
  })

  it('integrates Session admission through the registered dock and controls', async () => {
    const summary = summarizeTeamForConsole(replayTeamEvents(completeTeamEvents().slice(0, 8)), { controllerSessionId: 'controller-1' })
    const harness = clientContext(summary)
    harness.command.mockImplementation(async (line: string) => ({ ok: true, value: { matched: line.startsWith('/yuqi pause ') } }))
    await apply(harness.context)
    harness.injections[0]!()
    const definition = harness.register.mock.calls[0]![0] as { inject: (sessionId: string) => Record<string, unknown> }
    const Dock = harness.register.mock.calls[0]![1] as ComponentType<Record<string, unknown>>
    const actions = definition.inject('team-1')
    render(createElement(Dock, {
      ...actions,
      // This fixture models command admission, not the optional recovery RPC.
      recoverTarget: undefined,
      sessionId: 'team-1',
      useSessions: (select: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) => select({
        byId: { 'team-1': { agentPreset: 'yuqi-team' } },
      }),
      useProjection: () => summary,
    }))
    fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))

    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('正在暂停（等待执行收尾）')).toHaveAttribute('role', 'status'))
    expect(harness.command).toHaveBeenCalledOnce()
    expect(harness.command.mock.calls[0]![0]).toMatch(/^\/yuqi pause team-1 controller-1 /u)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('leaves native conversation actions untouched until a Team action is explicitly invoked', async () => {
    const { context, injections, openSubagent, refreshSubagents, subagentAddress, binding, command, register } = clientContext()

    await apply(context)

    // Mounting the optional dock must not inspect, send to, stop, or otherwise
    // interact with the native Session. It only contributes a passive slot.
    expect(register).not.toHaveBeenCalled()
    expect(binding).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(refreshSubagents).not.toHaveBeenCalled()
    expect(subagentAddress).not.toHaveBeenCalled()
    expect(openSubagent).not.toHaveBeenCalled()

    injections[0]!()
    expect(register).toHaveBeenCalledOnce()
    expect(binding).not.toHaveBeenCalled()
    expect(command).not.toHaveBeenCalled()
    expect(refreshSubagents).not.toHaveBeenCalled()
    expect(subagentAddress).not.toHaveBeenCalled()
    expect(openSubagent).not.toHaveBeenCalled()
  })

  it('never renders a retained Team projection in an ordinary or fresh conversation', async () => {
    const summary = summarizeTeamForConsole(replayTeamEvents(completeTeamEvents().slice(0, 8)), { controllerSessionId: 'controller-1' })
    const harness = clientContext(summary)
    await apply(harness.context)
    harness.injections[0]!()
    const definition = harness.register.mock.calls[0]![0] as { inject: (sessionId: string) => Record<string, unknown> }
    const Dock = harness.register.mock.calls[0]![1] as ComponentType<Record<string, unknown>>
    const actions = definition.inject('fresh-session')

    render(createElement(Dock, {
      ...actions,
      sessionId: 'fresh-session',
      useSessions: (select: (state: { byId: Record<string, { agentPreset: string }> }) => unknown) => select({
        byId: { 'fresh-session': { agentPreset: 'standard' } },
      }),
      // Reproduce the native slot's one-render stale baseline explicitly.
      useProjection: () => summary,
    }))

    expect(screen.queryByRole('button', { name: '打开 Yuqi Team 任务面板' })).not.toBeInTheDocument()
  })


  it.each([
    ['ready', null, [{ kind: 'child', id: 'cold-child', mode: 'continuable' }], undefined, true],
    ['ready', null, [{ kind: 'child', id: 'cold-child', mode: 'one-shot' }], undefined, true],
    ['error', { message: 'refresh failed' }, [{ kind: 'child', id: 'cold-child', mode: 'continuable' }], undefined, false],
    ['loading', null, [{ kind: 'child', id: 'cold-child', mode: 'continuable' }], undefined, false],
    ['ready', null, [{ kind: 'diagnostic', id: 'cold-child', reason: 'corrupt' }], undefined, false],
    ['ready', null, [{ kind: 'child', id: 'other', mode: 'continuable' }], undefined, false],
    ['ready', null, [{ kind: 'child', id: 'cold-child', mode: 'invalid' }], undefined, false],
    ['ready', null, [{ kind: 'child', id: 'cold-child', mode: 'continuable' }], 'different-parent', false],
    ['ready', null, [{ kind: 'child', id: 'cold-child', mode: 'continuable' }, { kind: 'child', id: 'cold-child', mode: 'continuable' }], undefined, false],
  ])('validates fresh official child catalog (%s, %j, %j)', async (state, error, entries, changedParent, accepted) => {
    const h = clientContext()
    const before = h.context.sessions.list.getSnapshot()
    const read = vi.spyOn(h.context.sessions.list, 'getSnapshot')
    const make = (parentId: unknown) => ({ ...before,
      byId: { ...before.byId, 'cold-child': { id: 'cold-child', parentId } },
      subagentsByParent: { 'team-1': { state, error, entries, parentAvailable: false } },
    }) as Record<string, unknown>
    read.mockReturnValue({ ...make('team-1'), subagentsByParent: {} } as never)
    h.refreshSubagents.mockImplementationOnce(async () => { read.mockReturnValue(make(changedParent ?? 'team-1') as never) })
    h.subagentAddress.mockReturnValue(undefined)
    await expect(openTeamCenterSession(h.context, 'cold-child' as never)).resolves.toBe(accepted)
    expect(h.refreshSubagents).toHaveBeenCalledWith('team-1')
    expect(h.openSession).not.toHaveBeenCalled()
    if (accepted) expect(h.openSubagent).toHaveBeenCalledWith({ parentSessionId: 'team-1', childSessionId: 'cold-child', mode: 'mode' in entries[0]! ? entries[0]!.mode : undefined })
    else expect(h.openSubagent).not.toHaveBeenCalled()
  })

  it('contains navigation failures and reports command transport uncertainty to the panel', async () => {
    const childFailure = clientContext()
    const childFailureSnapshot = childFailure.context.sessions.list.getSnapshot()
    vi.spyOn(childFailure.context.sessions.list, 'getSnapshot').mockReturnValue({ ...childFailureSnapshot, subagentsByParent: {} })
    childFailure.refreshSubagents.mockRejectedValueOnce(new Error('controller unavailable'))
    await apply(childFailure.context)
    const childOptions = childFailure.register.mock.calls.length === 0
      ? (childFailure.injections[0]!(), childFailure.register.mock.calls[0]![0])
      : childFailure.register.mock.calls[0]![0]
    const childActions = (childOptions as { inject: (sessionId: string) => { onOpenChild: (controllerId: string, childId: string) => Promise<boolean> } }).inject('team-1')
    await expect(childActions.onOpenChild('team-1', 'child-1')).resolves.toBe(false)

    const commandFailure = clientContext()
    commandFailure.command.mockRejectedValueOnce(new Error('command bridge unavailable'))
    await apply(commandFailure.context)
    commandFailure.injections[0]!()
    const commandOptions = commandFailure.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string) => Promise<boolean> } }
    await expect(commandOptions.inject('team-1').command('/yuqi cancel team-1 controller-1 request-1')).rejects.toMatchObject({ disposition: 'unknown', message: expect.stringContaining('[command:delivery-unknown]') })
  })

  it('identifies malformed official snapshots before sending any command', async () => {
    const harness = clientContext()
    await apply(harness.context)
    harness.injections[0]!()
    const options = harness.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string) => Promise<boolean> } }
    const session = harness.context.sessions.binding('team-1' as never)!.session
    const read = vi.spyOn(session, 'getSnapshot')
    read.mockReturnValueOnce({} as never)
    await expect(options.inject('team-1').command('/yuqi resume team-1 controller-1 request-1'))
      .rejects.toMatchObject({ disposition: 'rejected', message: expect.stringContaining('[command:snapshot-shape-invalid]') })
    read.mockImplementationOnce(() => { throw new Error('private transport content') })
    await expect(options.inject('team-1').command('/yuqi resume team-1 controller-1 request-2'))
      .rejects.toMatchObject({ disposition: 'rejected', message: expect.stringContaining('[command:snapshot-read-failed]') })
    expect(harness.command).not.toHaveBeenCalled()
    read.mockRestore()
  })

  it('fails closed for missing controller identity, stale Team identity, and malformed projections', async () => {
    const harness = clientContext()
    await apply(harness.context)
    harness.injections[0]!()
    const options = harness.register.mock.calls[0]![0] as { inject: (sessionId: string) => {
      onOpenChild: (controllerId: string | undefined, id: string) => Promise<boolean>
      command: (line: string, target?: { readonly teamId?: string; readonly controllerSessionId: string }) => Promise<boolean>
    } }
    const actions = options.inject('team-1')
    await expect(actions.onOpenChild(undefined, 'child-1')).resolves.toBe(false)
    await expect(actions.command('/yuqi cancel team-1 controller-1 request-1', { teamId: 'stale-team', controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })
    await expect(actions.command('/yuqi cancel team-1 controller-1 request-1', { teamId: 'team-1', controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })
    expect(harness.command).toHaveBeenCalledWith('/yuqi cancel team-1 controller-1 request-1')

    const malformed = clientContext(null)
    await apply(malformed.context)
    malformed.injections[0]!()
    const malformedOptions = malformed.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string, target: { readonly controllerSessionId: string }) => Promise<boolean> } }
    await expect(malformedOptions.inject('team-1').command('/yuqi cancel team-1 controller-1 request-2', { controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })

    const invalidIdentity = clientContext({ team: { id: 42 }, controllerSessionId: 'controller-1' })
    await apply(invalidIdentity.context)
    invalidIdentity.injections[0]!()
    const invalidOptions = invalidIdentity.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string, target: { readonly controllerSessionId: string }) => Promise<boolean> } }
    await expect(invalidOptions.inject('team-1').command('/yuqi cancel team-1 controller-1 request-3', { controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })

    const throwingProjection = clientContext(undefined, true)
    await apply(throwingProjection.context)
    throwingProjection.injections[0]!()
    const throwingOptions = throwingProjection.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string, target: { readonly controllerSessionId: string }) => Promise<boolean> } }
    await expect(throwingOptions.inject('team-1').command('/yuqi cancel team-1 controller-1 request-4', { controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })

    const primitiveTeam = clientContext({ team: 'not-a-team-object', controllerSessionId: 'controller-1' })
    await apply(primitiveTeam.context)
    primitiveTeam.injections[0]!()
    const primitiveOptions = primitiveTeam.register.mock.calls[0]![0] as { inject: (sessionId: string) => { command: (line: string, target: { readonly controllerSessionId: string }) => Promise<boolean> } }
    await expect(primitiveOptions.inject('team-1').command('/yuqi cancel team-1 controller-1 request-5', { controllerSessionId: 'controller-1' })).rejects.toMatchObject({ disposition: 'rejected' })
  })
})

describe('command builders', () => {
  it('creates UUID-shaped request ids when the platform crypto API provides randomUUID', async () => {
    const id = createRequestId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
  })

  it('creates RFC 4122-shaped request ids when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.set([0, 1, 2, 3, 4, 5, 255, 7, 255, 9, 10, 11, 12, 13, 14, 15])
        return bytes
      },
    })
    expect(createRequestId()).toBe('00010203-0405-4f07-bf09-0a0b0c0d0e0f')
  })

  it('keeps a usable local request id when Web Crypto is absent', async () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Date, 'now').mockReturnValue(1234)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(createRequestId()).toMatch(/^yuqi-ya-[0-9a-z]+$/u)
  })

  it('preserves task/request identifiers exactly, including empty and whitespace values', async () => {
    expect(teamCommandLine('pause', 'team-1', 'controller-1', '')).toBe('/yuqi pause team-1 controller-1 ')
    expect(retryCommandLine(' task/1 ', 'req id')).toBe('/yuqi retry  task/1  req id')
    expect(stopCommandLine('task-1', 'request-1')).toBe('/yuqi stop task-1 request-1')
  })

  it('maps the primary action and label for every externally visible team state', async () => {
    expect(primaryTeamAction('running')).toBe('pause')
    expect(primaryTeamAction('pausing')).toBe('pause')
    expect(primaryTeamAction('paused')).toBe('resume')
    expect(primaryTeamAction('needs_reconciliation')).toBe('reconcile')
    expect(primaryTeamAction('completed')).toBeUndefined()
    expect(teamActionLabel('pause')).toBe('暂停')
    expect(teamActionLabel('resume')).toBe('继续')
    expect(teamActionLabel('reconcile')).toBe('重新检查')
    expect(teamActionLabel('cancel')).toBe('取消')
    expect(teamActionLabel('pause', 'en')).toBe('Pause')
    expect(teamActionLabel('resume', 'en')).toBe('Continue')
    expect(teamActionLabel('reconcile', 'en')).toBe('Recheck')
    expect(teamActionLabel('cancel', 'en')).toBe('Cancel')
  })
})
