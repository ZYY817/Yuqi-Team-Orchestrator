import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { TEAM_SETTINGS_SCOPE_CHANNEL, type TeamSettingsScopeRequest, type TeamSettingsScopeView } from '../domain/team-settings-scope.ts'
import type { TeamSettings } from '../domain/team-settings-contract.ts'

export interface TeamSettingsScopeContext {
  readonly rpc: ClientConnectionRpc
  /** Use ctx.sessions.list; current is the Host session selection, never a project path. */
  readonly sessions: {
    getSnapshot(): { readonly current?: string | undefined; readonly byId?: Readonly<Record<string, { readonly displayTitle?: string }>> }
    subscribe(listener: () => void): () => void
  }
}

export async function readTeamSettingsScope(context: TeamSettingsScopeContext, request: TeamSettingsScopeRequest, signal?: AbortSignal): Promise<TeamSettingsScopeView> {
  const result = await context.rpc.call(TEAM_SETTINGS_SCOPE_CHANNEL, 'read', request, signal)
  if (!result.ok) throw new Error(result.error.message)
  return result.value as TeamSettingsScopeView
}

/** One immutable identity per form mount; navigation can never retarget an in-flight write. */
export function bindTeamSettingsScope(context: TeamSettingsScopeContext, initial: TeamSettingsScopeView) {
  let view = initial
  const listeners = new Set<() => void>()
  const request: TeamSettingsScopeRequest = { level: initial.level,
    ...(initial.level === 'global' ? {} : { sessionId: initial.sessionId! }) }
  const snapshot = () => ({ status: 'ready' as const, value: view.value, base: view.inherited,
    user: view.overrides, revision: view.revision, writable: view.writable, mode: 'host' as const })
  let current = snapshot()
  let writing = false
  async function replace(overrides: Partial<TeamSettings>) {
    if (writing) throw new Error('A settings save is already pending')
    writing = true
    try {
      const result = await context.rpc.call(TEAM_SETTINGS_SCOPE_CHANNEL, 'write', {
        ...request, overrides, revision: view.revision, globalRevision: view.globalRevision, binding: view.binding,
      })
      if (!result.ok) throw new Error(result.error.message)
      view = result.value as TeamSettingsScopeView
      current = snapshot()
      for (const listener of listeners) listener()
    } finally { writing = false }
  }
  const scope: SettingsScope<TeamSettings> = {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async () => { throw new Error('Scoped settings require an atomic form save') },
    unset: async () => { throw new Error('Use restore inheritance') },
  }
  return { scope, restore: () => replace({}), save: async (settings: TeamSettings, changedFields?: readonly (keyof TeamSettings)[]) => {
    // Preserve explicit same-valued overrides. Only edited fields gain overrides;
    // untouched fields continue following subsequent parent changes.
    const next = { ...view.overrides }
    for (const key of changedFields ?? Object.keys(settings) as (keyof TeamSettings)[]) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(view.value[key])) {
        Object.assign(next, { [key]: settings[key] })
      }
    }
    await replace(next)
  } }
}
