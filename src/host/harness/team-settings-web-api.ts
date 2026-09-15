import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { TEAM_SETTINGS_NAMESPACE } from '../../application/team-settings.ts'
import { assertSafeTeamSettingsData } from './team-settings-scope.ts'

interface RpcRequest<P> {
  readonly rpcId: string
  readonly payload: P
}

interface RpcResponse<T> {
  readonly rpcId: string
  readonly result: { readonly ok: true; readonly value: T } | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }
}

interface SettingsNamespaceView {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly base?: unknown
  readonly user?: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
}

interface SettingsWebApi {
  describe(request: RpcRequest<object>): Promise<RpcResponse<{
    readonly writable: boolean
    readonly hasDocument: boolean
    readonly namespaces: readonly SettingsNamespaceView[]
  }>>
  openDocument(request: RpcRequest<object>, signal: AbortSignal): Promise<RpcResponse<{ readonly opened: true }>>
  update(request: RpcRequest<{ readonly ns: string; readonly patch: object; readonly expectedRevision?: number }>): Promise<RpcResponse<SettingsNamespaceView>>
  replace(request: RpcRequest<{ readonly ns: string; readonly section: object; readonly expectedRevision?: number }>): Promise<RpcResponse<SettingsNamespaceView>>
  mutate(request: RpcRequest<{ readonly ns: string; readonly ops: readonly SettingsPathOp[]; readonly expectedRevision?: number }>): Promise<RpcResponse<SettingsNamespaceView>>
}

interface ApiProxyWithSettings {
  settings: SettingsWebApi
}

/**
 * Bridge this plugin's registered namespace through Harness versions whose
 * settings API still filters third-party namespaces through a fixed allowlist.
 */
export function installTeamSettingsWebApi(ctx: Context): void {
  const apiProxy = ctx.get('apiProxy' as never) as ApiProxyWithSettings | undefined
  if (apiProxy === undefined) return
  const original = apiProxy.settings
  const namespace = String(TEAM_SETTINGS_NAMESPACE)

  const view = (): SettingsNamespaceView | undefined => {
    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find(candidate => String(candidate.ns) === namespace)
    if (descriptor === undefined) return undefined
    return {
      ns: namespace,
      schema: descriptor.schema,
      value: descriptor.value,
      ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
      ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
      applies: descriptor.applies,
      secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
      revision: descriptor.revision,
    }
  }

  const write = async (
    request: RpcRequest<{ readonly ns: string; readonly expectedRevision?: number }>,
    operation: () => Promise<void>,
  ): Promise<RpcResponse<SettingsNamespaceView>> => {
    try {
      assertSafeTeamSettingsData(request.payload)
      const ops = (request.payload as { readonly ops?: readonly SettingsPathOp[] }).ops
      if (ops?.some(op => op.path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key)))) throw new Error('Unsafe settings path')
      await operation()
      const current = view()
      if (current === undefined) throw new Error(`settings namespace "${namespace}" is unavailable`)
      return { rpcId: request.rpcId, result: { ok: true, value: current } }
    } catch (error) {
      const conflict = error as { readonly code?: unknown; readonly expected?: unknown; readonly actual?: unknown }
      const isConflict = conflict.code === 'SETTINGS_CONFLICT'
      return {
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: isConflict ? 'settings-conflict' : 'settings-rejected',
            message: error instanceof Error ? error.message : String(error),
            details: isConflict
              ? { ns: namespace, expected: conflict.expected, actual: conflict.actual }
              : { ns: namespace },
          },
        },
      }
    }
  }

  const bridged: SettingsWebApi = {
    ...original,
    async describe(request) {
      const response = await original.describe(request)
      if (!response.result.ok) return response
      const own = view()
      if (own === undefined || response.result.value.namespaces.some(candidate => candidate.ns === namespace)) return response
      return {
        rpcId: response.rpcId,
        result: { ok: true, value: { ...response.result.value, namespaces: [...response.result.value.namespaces, own] } },
      }
    },
    update(request) {
      if (request.payload.ns !== namespace) return original.update(request)
      return write(request, () => ctx.settings.update(TEAM_SETTINGS_NAMESPACE, request.payload.patch, request.payload.expectedRevision))
    },
    replace(request) {
      if (request.payload.ns !== namespace) return original.replace(request)
      return write(request, () => ctx.settings.replace(TEAM_SETTINGS_NAMESPACE, request.payload.section, request.payload.expectedRevision))
    },
    mutate(request) {
      if (request.payload.ns !== namespace) return original.mutate(request)
      return write(request, () => ctx.settings.mutate(TEAM_SETTINGS_NAMESPACE, request.payload.ops, request.payload.expectedRevision))
    },
  }

  apiProxy.settings = bridged
  ctx.effect(() => () => {
    if (apiProxy.settings === bridged) apiProxy.settings = original
  }, 'yuqiTeamOrchestrator.settingsWebApi')
}
