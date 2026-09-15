import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createHash } from 'node:crypto'
import { TEAM_SETTINGS_NAMESPACE, TEAM_SETTINGS_SCHEMA, assertChildPresetId, assertTeamConcurrency, normalizeTeamReviewPolicy } from '../../application/team-settings.ts'
import { DEFAULT_TEAM_SETTINGS, type TeamSettings } from '../../domain/team-settings-contract.ts'
import { TEAM_SETTINGS_SCOPE_CHANNEL, type TeamSettingsScopeRequest, type TeamSettingsScopeView, type TeamSettingsScopeWrite } from '../../domain/team-settings-scope.ts'

// Leave runtime namespace validation to the public settings provider.
const namespace = 'yuqi-team-settings-scopes' as SettingsNamespace
export const MAX_TEAM_SETTINGS_SCOPE_RECORDS = 1000
interface RecordEntry { key: string; overrides: Partial<TeamSettings> }
interface Document { records: RecordEntry[] }
const schema = z.object({ records: z.array(z.object({ key: z.string(), overrides: z.any() })).default([]) }) as unknown as z<Document>
interface WorkspaceRegistry {
  list(): readonly { readonly id: string; readonly title: string; readonly sessionIds: readonly string[] }[]
}
const fields = new Set(Object.keys(DEFAULT_TEAM_SETTINGS))

/** Reject dangerous keys at every depth before any schema or merge processes input. */
export function assertSafeTeamSettingsData(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error('Settings nesting exceeds limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || value === null) throw new Error('Settings must contain JSON values')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Settings require plain objects')
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe settings key')
    assertSafeTeamSettingsData((value as Record<string, unknown>)[key], depth + 1)
  }
}
function overrides(value: unknown): Partial<TeamSettings> {
  assertSafeTeamSettingsData(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected settings object')
  if (Object.keys(value).some(key => !fields.has(key))) throw new Error('Unknown Team setting')
  const checked = TEAM_SETTINGS_SCHEMA({ ...DEFAULT_TEAM_SETTINGS, ...value })
  assertTeamConcurrency(checked.maxConcurrency)
  assertChildPresetId(checked.childPresetId)
  normalizeTeamReviewPolicy(checked)
  return structuredClone(value) as Partial<TeamSettings>
}
function keyFor(projectId: string, sessionId?: string): string {
  return createHash('sha256').update(JSON.stringify([projectId, sessionId ?? null])).digest('hex')
}

/** Dedicated plugin: install after settings and Host workspaceRegistry are available. */
export function installTeamSettingsScopes(ctx: Context, scopes = new TeamSettingsScopes(ctx)): TeamSettingsScopes {
  const connection = (ctx.get('connection' as never) ?? (ctx as unknown as { connection?: HostConnectionHandle }).connection) as unknown as HostConnectionHandle
  if (typeof connection?.rpc?.handle !== 'function') throw new Error('Host Connection RPC is required')
  const dispose = connection.rpc.handle(TEAM_SETTINGS_SCOPE_CHANNEL, async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      assertSafeTeamSettingsData(payload)
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid request')
      const request = payload as TeamSettingsScopeWrite
      const allowed = endpoint === 'read' ? ['level', 'sessionId'] : ['level', 'sessionId', 'overrides', 'revision', 'globalRevision', 'binding']
      if (Object.keys(payload).some(key => !allowed.includes(key))) throw new Error('Unexpected request field')
      if (endpoint === 'read') return { ok: true, value: scopes.read(request) }
      if (endpoint === 'write') return { ok: true, value: await scopes.write(request) }
      throw new Error('Unknown settings endpoint')
    } catch (error) {
      return { ok: false, error: { code: 'settings-rejected', message: error instanceof Error ? error.message : 'Settings rejected', details: { ns: String(namespace) } } }
    }
  }, { authority: 'loopback' })
  ctx.effect(() => dispose, 'yuqiTeamOrchestrator.settingsScopes')
  return scopes
}

export class TeamSettingsScopes {
  constructor(private readonly ctx: Context) {
    ctx.settings.register(namespace, schema, { validate: document => {
      if (document.records.length > MAX_TEAM_SETTINGS_SCOPE_RECORDS) throw new Error(`At most ${MAX_TEAM_SETTINGS_SCOPE_RECORDS} Team settings scope records are allowed; restore unused overrides first`)
      const keys = new Set<string>()
      for (const record of document.records) {
        if (!/^[a-f0-9]{64}$/.test(record.key) || keys.has(record.key)) throw new Error('Invalid scope record')
        keys.add(record.key)
        overrides(record.overrides)
      }
    } })
  }

  private identity(request: TeamSettingsScopeRequest) {
    if (!['global', 'project', 'session'].includes(request.level)) throw new Error('Invalid settings scope')
    if (request.level === 'global') {
      if (request.sessionId !== undefined) throw new Error('Global settings have no session selector')
      return undefined
    }
    if (typeof request.sessionId !== 'string' || request.sessionId.length === 0 || request.sessionId.length > 200) throw new Error('A current Host session is required')
    const registry = this.ctx.get('workspaceRegistry' as never) as unknown as WorkspaceRegistry
    if (typeof registry?.list !== 'function') throw new Error('Host workspace identity binding unavailable')
    // Native sessionIds are header/canonical-cwd validated, including cold sessions.
    const matches = registry.list().filter(workspace => workspace.sessionIds.includes(request.sessionId!))
    if (matches.length !== 1) throw new Error('Session has no unique Host project binding')
    return { projectId: String(matches[0]!.id), projectTitle: matches[0]!.title, sessionId: request.sessionId }
  }

  read(request: TeamSettingsScopeRequest): TeamSettingsScopeView {
    const identity = this.identity(request)
    const descriptors = this.ctx.settings.describe({ redactSecrets: true })
    const global = descriptors.find(item => item.ns === TEAM_SETTINGS_NAMESPACE)
    const scoped = descriptors.find(item => item.ns === namespace)
    if (!global || !scoped) throw new Error('Team settings unavailable')
    const records = (scoped.value as Document).records
    const globalValue = structuredClone(global.value) as TeamSettings
    const project = identity ? records.find(row => row.key === keyFor(identity.projectId))?.overrides ?? {} : {}
    const session = identity ? records.find(row => row.key === keyFor(identity.projectId, identity.sessionId))?.overrides ?? {} : {}
    const selected = request.level === 'global' ? (global.user ?? {}) as Partial<TeamSettings> : request.level === 'project' ? project : session
    const inherited = request.level === 'global' ? { ...DEFAULT_TEAM_SETTINGS, ...global.base as object }
      : request.level === 'project' ? globalValue : { ...globalValue, ...project }
    const value = request.level === 'global' ? globalValue : { ...inherited, ...selected }
    const sources = Object.fromEntries([...fields].map(field => [field,
      request.level === 'session' && Object.hasOwn(session, field) ? 'session'
        : request.level !== 'global' && Object.hasOwn(project, field) ? 'project' : 'global'])) as TeamSettingsScopeView['sources']
    return structuredClone({ level: request.level, ...identity, value, inherited, overrides: selected, sources,
      revision: request.level === 'global' ? global.revision : scoped.revision, globalRevision: global.revision,
      binding: identity ? keyFor(identity.projectId, identity.sessionId) : 'global', writable: this.ctx.settings.writable })
  }

  async write(request: TeamSettingsScopeWrite): Promise<TeamSettingsScopeView> {
    const current = this.read(request)
    if (request.binding !== current.binding) throw new Error('Session project binding changed; reload before saving')
    if (!Number.isSafeInteger(request.revision) || !Number.isSafeInteger(request.globalRevision)
      || current.revision !== request.revision || current.globalRevision !== request.globalRevision) throw new Error('Settings changed; reload before saving')
    const selected = overrides(request.overrides)
    if (request.level === 'global') await this.ctx.settings.replace(TEAM_SETTINGS_NAMESPACE, selected, request.revision)
    else {
      const document = this.ctx.settings.get(namespace) as Document
      const key = keyFor(current.projectId!, request.level === 'session' ? current.sessionId : undefined)
      const records = document.records.filter(record => record.key !== key)
      if (Object.keys(selected).length > 0) records.push({ key, overrides: selected })
      await this.ctx.settings.replace(namespace, { records }, request.revision)
    }
    return this.read(request)
  }

  /** Call exactly once at admission with the actual Agent session id. */
  resolve(sessionId: string): TeamSettings {
    const registry = this.ctx.get('workspaceRegistry' as never) as unknown as WorkspaceRegistry | undefined
    const matches = typeof registry?.list === 'function' ? registry.list().filter(item => item.sessionIds.includes(sessionId)) : []
    if (matches.length === 1) return this.read({ level: 'session', sessionId }).value
    if (matches.length > 1) throw new Error('Session has ambiguous Host project binding')
    // Legacy ungrouped entry sessions can still start with global defaults.
    // If scoped data exists, losing identity cannot silently erase its effect.
    const document = this.ctx.settings.get(namespace) as Document
    if (document.records.length > 0) throw new Error('Cannot resolve existing Team overrides without the entry parent session project binding')
    return this.read({ level: 'global' }).value
  }
}
