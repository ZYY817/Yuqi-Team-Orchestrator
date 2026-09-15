import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { apply } from '../src/agent/index.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { TEAM_SETTINGS_NAMESPACE, TEAM_SETTINGS_SCHEMA } from '../src/application/team-settings.ts'
import { DEFAULT_TEAM_SETTINGS } from '../src/domain/team-settings-contract.ts'
import { installTeamSettingsScopes, MAX_TEAM_SETTINGS_SCOPE_RECORDS } from '../src/host/harness/team-settings-scope.ts'
import type { TeamSettingsScopeView } from '../src/domain/team-settings-scope.ts'

class StoredSettings extends SettingsProvider {
  readonly writable = true
  documentCopy: Record<string, unknown> = {}
  fail = false
  protected async load() { return this.documentCopy }
  protected async persist(ns: string, section: Record<string, unknown>) {
    if (this.fail) throw new Error('Disk failed')
    this.documentCopy = { ...this.documentCopy, [ns]: structuredClone(section) }
  }
  restore(document: Record<string, unknown>) { this.publish(document) }
}
function fixture(document?: Record<string, unknown>, withRegistry = true) {
  const settings = new StoredSettings(new Context())
  settings.register(TEAM_SETTINGS_NAMESPACE, TEAM_SETTINGS_SCHEMA)
  if (document) settings.restore(document)
  let handler: Parameters<HostConnectionHandle['rpc']['handle']>[1]
  let authority: unknown
  const registry = { list: () => [
    { id: 'project-a', title: 'A', sessionIds: ['a1', 'a2'] },
    { id: 'project-b', title: 'B', sessionIds: ['b1'] },
  ] }
  const ctx = { settings, get: (name: string) => name === 'workspaceRegistry' ? (withRegistry ? registry : undefined) : {
    rpc: { handle: (_channel: string, next: typeof handler, options: unknown) => { handler = next; authority = options; return async () => {} } },
  }, effect: () => {} } as unknown as Context
  const scopes = installTeamSettingsScopes(ctx)
  const rpc = (endpoint: string, payload: unknown) => handler(endpoint, payload, new AbortController().signal)
  return { settings, scopes, rpc, registry, authority: () => authority }
}
function write(view: TeamSettingsScopeView, overrides: object) {
  return { level: view.level, ...(view.level === 'global' ? {} : { sessionId: view.sessionId }), overrides,
    revision: view.revision, globalRevision: view.globalRevision, binding: view.binding }
}

describe('Host Team settings scope RPC', () => {
  it('registers and resolves in the actual service without a Web Connection', async () => {
    const context = new Context()
    const settings = new StoredSettings(new Context())
    context.provide('settings', settings as never)
    context.provide('sessions', { get: () => undefined, list: () => [], flush: async () => true } as never)
    context.provide('subagents', {} as never)
    context.provide('sessionPersistence', { list: async () => [] } as never)
    context.provide('llm', {} as never)
    context.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } as never)
    const service = new YuqiTeamOrchestratorService(context)
    await vi.waitFor(() => expect(settings.describe().map(item => String(item.ns))).toContain('yuqi-team-settings-scopes'))
    await settings.update(TEAM_SETTINGS_NAMESPACE, { maxConcurrency: 6 })
    expect(service.teamDefaults('unbound-cli-entry').maxConcurrency).toBe(6)
    expect(context.get('connection' as never)).toBeUndefined()
  })

  it('bounds stored records and frees a slot by restoring inheritance', async () => {
    const host = fixture()
    const ns = settingsNamespace('yuqi-team-settings-scopes')
    const records = Array.from({ length: MAX_TEAM_SETTINGS_SCOPE_RECORDS }, (_, index) => ({ key: index.toString(16).padStart(64, '0'), overrides: { maxConcurrency: 2 } }))
    await host.settings.replace(ns, { records })
    expect((await host.rpc('write', write(host.scopes.read({ level: 'session', sessionId: 'a1' }), { maxConcurrency: 3 }))).ok).toBe(false)
    await host.settings.replace(ns, { records: records.slice(1) })
    expect((await host.rpc('write', write(host.scopes.read({ level: 'session', sessionId: 'a1' }), { maxConcurrency: 3 }))).ok).toBe(true)
    await host.rpc('write', write(host.scopes.read({ level: 'session', sessionId: 'a1' }), {}))
    expect((host.settings.get(ns) as { records: unknown[] }).records).toHaveLength(MAX_TEAM_SETTINGS_SCOPE_RECORDS - 1)
  })

  it('refuses a save after the Host moves the selected session into another project', async () => {
    const host = fixture()
    const prior = host.scopes.read({ level: 'project', sessionId: 'a1' })
    host.registry.list = () => [{ id: 'project-b', title: 'B', sessionIds: ['a1'] }]
    expect((await host.rpc('write', write(prior, { maxConcurrency: 2 }))).ok).toBe(false)
    expect(host.scopes.resolve('a1').maxConcurrency).toBe(100)
  })

  it.each([true, false])('actual tool admission preserves global fallback and parent scope (registry=%s)', async withRegistry => {
    const host = fixture(undefined, withRegistry)
    const root = new Context()
    let tool: ToolDefinition | undefined
    await host.settings.update(TEAM_SETTINGS_NAMESPACE, { requirePlanConfirmation: false, maxConcurrency: 3 })
    const startTeam = vi.fn(async () => ({ teamId: 'team', sessionId: 'new-controller', controller: {}, dispose: async () => {} }))
    const runTeam = vi.fn(async () => ({ projection: { team: { id: 'team', status: 'completed' }, taskIds: ['t'] }, reason: 'completed' }))
    const teamDefaults = vi.fn((id: string) => host.scopes.resolve(id))
    root.provide('tools', { register: (definition: ToolDefinition) => { if (definition.name === 'yuqi_team_start') tool = definition } } as never)
    root.provide('yuqiTeamOrchestrator', { teamDefaults, startTeam, runTeam, maxConcurrencyLimit: () => 3 } as never)
    const scope = createScope(root, {})
    apply(scope.ctx)
    const input = { title: 'scope', objective: 'Check actual admission', tasks: [{ taskId: 't', revision: 1, modelRole: 'worker', goal: 'Check', fileScope: ['src/**'] }] }
    const execute = (id: string, parentSession?: string) => tool!.execute(input, {
      agent: { id, options: { provider: 'deepseek', model: 'model' }, session: {
        id, events: [], header: { cwd: 'F:\\project', createdAt: new Date().toISOString(), ...(parentSession ? { parentSession } : {}) },
      } }, signal: new AbortController().signal,
    } as unknown as ToolRunContext)
    try {
      await expect(execute('temporary-entry')).resolves.toMatchObject({ status: 'completed' })
      expect(teamDefaults).toHaveBeenLastCalledWith('temporary-entry')
      expect(runTeam).toHaveBeenLastCalledWith(expect.objectContaining({ maxConcurrency: 3 }))
      if (withRegistry) {
        const reviewPolicy = { mode: 'off', maxReworkRounds: 0, additionalPrompt: '' }
        await host.rpc('write', write(host.scopes.read({ level: 'session', sessionId: 'a1' }), {
          childPresetId: 'parent-preset', maxConcurrency: 10, defaultAuthorityMode: 'read-only', reviewPolicy,
        }))
        await expect(execute('independent-controller', 'a1')).resolves.toMatchObject({ status: 'completed' })
        expect(teamDefaults).toHaveBeenLastCalledWith('a1')
        expect(startTeam).toHaveBeenLastCalledWith(expect.objectContaining({ childPresetId: 'parent-preset', reviewPolicy, maxConcurrency: 10,
          tasks: [expect.objectContaining({ authorityMode: 'read-only' })] }))
        expect(runTeam).toHaveBeenLastCalledWith(expect.objectContaining({ maxConcurrency: 10 }))
        await expect(execute('unknown-entry')).rejects.toThrow('Cannot resolve existing Team overrides')
        const noRegistry = fixture(host.settings.documentCopy, false)
        expect(() => noRegistry.scopes.resolve('a1')).toThrow('Cannot resolve existing Team overrides')
      } else {
        expect((await host.rpc('read', { level: 'project', sessionId: 'a1' })).ok).toBe(false)
      }
    } finally { await scope.dispose() }
  })

  it('inherits, overrides, restores and survives provider reload with isolated sessions/projects', async () => {
    const host = fixture()
    expect(host.authority()).toEqual({ authority: 'loopback' })
    const project = () => host.scopes.read({ level: 'project', sessionId: 'a1' })
    await host.rpc('write', write(host.scopes.read({ level: 'global' }), { maxConcurrency: 8 }))
    expect(project().value.maxConcurrency).toBe(8)
    await host.rpc('write', write(project(), { maxConcurrency: 3 }))
    expect(host.scopes.resolve('a2').maxConcurrency).toBe(3)
    expect(host.scopes.resolve('b1').maxConcurrency).toBe(8)
    const session = () => host.scopes.read({ level: 'session', sessionId: 'a1' })
    expect((await host.rpc('write', write(session(), { maxConcurrency: 2 }))).ok).toBe(true)
    expect(session().sources.maxConcurrency).toBe('session')
    expect(host.scopes.resolve('a2').maxConcurrency).toBe(3)
    const admitted = host.scopes.resolve('a1')
    const restarted = fixture(host.settings.documentCopy)
    expect(restarted.scopes.resolve('a1').maxConcurrency).toBe(2)
    await host.rpc('write', write(session(), {}))
    expect(session().value.maxConcurrency).toBe(3)
    expect(session().sources.maxConcurrency).toBe('project')
    await host.rpc('write', write(project(), {}))
    expect(session().value.maxConcurrency).toBe(8)
    expect(admitted.maxConcurrency).toBe(2)
  })

  it('rejects identity injection, unknown sessions, prototype keys, invalid values and stale writes', async () => {
    const host = fixture()
    const session = host.scopes.read({ level: 'session', sessionId: 'a1' })
    for (const payload of [
      { level: 'session', sessionId: 'unknown' }, { level: 'session', sessionId: 'a1', projectId: 'project-b' },
      { level: 'project', sessionId: '__proto__' }, { level: 'session', sessionId: 'a1', path: 'F:/injected' },
    ]) expect((await host.rpc('read', payload)).ok).toBe(false)
    for (const override of [JSON.parse('{"__proto__":{"polluted":true}}'),
      { modelRouting: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') },
      { maxConcurrency: 101 }, { maxConcurrency: '5' }, { childPresetId: 'yuqi-team' }, { unknown: true },
    ]) expect((await host.rpc('write', write(session, override))).ok).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((await host.rpc('write', write(session, { maxConcurrency: 4 }))).ok).toBe(true)
    expect((await host.rpc('write', write(session, { maxConcurrency: 9 }))).ok).toBe(false)
    expect(host.scopes.resolve('a1').maxConcurrency).toBe(4)
  })

  it('rejects parent revision changes and persistence failures without partial commit', async () => {
    const host = fixture()
    const session = host.scopes.read({ level: 'session', sessionId: 'a1' })
    await host.rpc('write', write(host.scopes.read({ level: 'global' }), { maxConcurrency: 6 }))
    expect((await host.rpc('write', write(session, { maxConcurrency: 1 }))).ok).toBe(false)
    host.settings.fail = true
    expect((await host.rpc('write', write(host.scopes.read({ level: 'session', sessionId: 'a1' }), {
      maxConcurrency: 1, reviewPolicy: DEFAULT_TEAM_SETTINGS.reviewPolicy,
    }))).ok).toBe(false)
    expect(host.scopes.resolve('a1').maxConcurrency).toBe(6)
  })
})
