/** Host-only adapter for the SessionStore hidden by the client Context face. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { logHostDiagnostic } from './host-compatibility-diagnostics.ts'

export type HarnessSessionStore = Pick<SessionStore, 'flush'> & Partial<Pick<SessionStore, 'get'>>
export type HarnessSessionAccess = Partial<Pick<SessionStore, 'flush' | 'get' | 'list'>>

/**
 * The Host and Client packages both augment Cordis's `Context.sessions`.
 * Runtime Host compositions still register SessionStore, so resolve that
 * service at the registry boundary and validate every capability before use.
 */
export function harnessSessionAccess(ctx: Context): HarnessSessionAccess {
  const service: unknown = ctx.get('sessions')
  if (typeof service !== 'object' || service === null) return {}
  const get: unknown = Reflect.get(service, 'get')
  const flush: unknown = Reflect.get(service, 'flush')
  const list: unknown = Reflect.get(service, 'list')
  return {
    ...(typeof get === 'function'
      ? { get: (id: Parameters<SessionStore['get']>[0]) => {
          const result: unknown = Reflect.apply(get, service, [id])
          if (result === undefined) return undefined
          if (!isHarnessSession(result, id)) throw invalidSessionStoreResponse(ctx, 'get')
          return result
        } }
      : {}),
    ...(typeof flush === 'function'
      ? { flush: async (session: Parameters<SessionStore['flush']>[0]) => {
          const result: unknown = await Reflect.apply(flush, service, [session])
          if (typeof result !== 'boolean') throw invalidSessionStoreResponse(ctx, 'flush')
          return result
        } }
      : {}),
    ...(typeof list === 'function'
      ? { list: () => {
          const result: unknown = Reflect.apply(list, service, [])
          if (!Array.isArray(result) || !result.every(item => isHarnessSession(item))) {
            throw invalidSessionStoreResponse(ctx, 'list')
          }
          return result
        } }
      : {}),
  }
}

export function requireHarnessSessionStore(ctx: Context): HarnessSessionStore {
  const sessions = harnessSessionAccess(ctx)
  if (typeof sessions.flush !== 'function') {
    throw new Error('Harness SessionStore.flush is unavailable')
  }
  return sessions as HarnessSessionStore
}

function isHarnessSession(value: unknown, expectedId?: SessionId): value is Session {
  if (typeof value !== 'object' || value === null) return false
  const id = Reflect.get(value, 'id')
  const header = Reflect.get(value, 'header')
  if (typeof id !== 'string' || (expectedId !== undefined && id !== String(expectedId))) return false
  if (typeof header !== 'object' || header === null || Reflect.get(header, 'id') !== id) return false
  // Prefer the public snapshot capability. Newer Host Session facades may
  // deliberately reject reads of the legacy mutable `events` property.
  if (typeof Reflect.get(value, 'snapshotEvents') === 'function') return true
  return Array.isArray(Reflect.get(value, 'events'))
}

function invalidSessionStoreResponse(ctx: Context, capability: 'get' | 'flush' | 'list'): TypeError {
  logHostDiagnostic(ctx, 'session-read-failure', `session-store-${capability}`, 'response-invalid', 'warn')
  return new TypeError(`Harness SessionStore.${capability} returned an invalid response`)
}
