import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'

export type HostCompatibilityFailureStage =
  | 'storage-domain-open'
  | 'sidecar-session-bind'
  | 'team-bootstrap'

export type HostCompatibilityFailureCategory =
  | 'session-envelope-incompatible'
  | 'session-format-unsupported'
  | 'session-persistence-corrupt'
  | 'session-persistence-not-found'
  | 'sidecar-record-invalid'
  | 'sidecar-native-conflict'
  | 'capability-unavailable'
  | 'response-invalid'
  | 'operation-timeout'
  | 'operation-failed'
  | 'non-error-throw'

export interface HostCompatibilityReport {
  readonly event: 'host-compatibility-report'
  readonly schemaVersion: 1
  readonly assessment: 'capabilities-only'
  readonly unknownVersionCompatibility: 'not-asserted'
  readonly session: {
    readonly create: boolean
    readonly append: boolean
    readonly store: { readonly get: boolean; readonly list: boolean; readonly flush: boolean }
  }
  readonly persistence: {
    readonly list: boolean
    readonly inspect: boolean
    readonly open: boolean
    readonly load: boolean
    readonly readFrom: boolean
    readonly ensureMaterialized: boolean
    readonly create: boolean
  }
  readonly storage: {
    readonly domainOpen: boolean
    readonly journalPreference: 'sidecar-if-open-succeeds' | 'native-session-requires-envelope-check'
  }
}

/**
 * Inspect only public service/function shapes. This must not create a Session,
 * open storage, enumerate data, or otherwise use a capability as its probe.
 */
export function inspectHostCompatibility(ctx: Context): HostCompatibilityReport {
  const sessions = safeService(ctx, 'sessions')
  const persistence = safeObject(() => ctx.sessionPersistence)
  const storageDomain = safeStorageDomain(ctx)
  const sessionPrototype = Session.prototype as unknown as Record<string, unknown>
  return Object.freeze({
    event: 'host-compatibility-report',
    schemaVersion: 1,
    assessment: 'capabilities-only',
    unknownVersionCompatibility: 'not-asserted',
    session: Object.freeze({
      create: typeof Session.create === 'function',
      append: typeof sessionPrototype.append === 'function',
      store: Object.freeze({
        get: hasFunction(sessions, 'get'),
        list: hasFunction(sessions, 'list'),
        flush: hasFunction(sessions, 'flush'),
      }),
    }),
    persistence: Object.freeze({
      list: hasFunction(persistence, 'list'),
      inspect: hasFunction(persistence, 'inspect'),
      open: hasFunction(persistence, 'open'),
      load: hasFunction(persistence, 'load'),
      readFrom: hasFunction(persistence, 'readFrom'),
      ensureMaterialized: hasFunction(persistence, 'ensureMaterialized'),
      create: hasFunction(persistence, 'create'),
    }),
    storage: Object.freeze({
      domainOpen: hasFunction(storageDomain, 'open'),
      journalPreference: hasFunction(storageDomain, 'open')
        ? 'sidecar-if-open-succeeds' : 'native-session-requires-envelope-check',
    }),
  })
}

export function logHostCompatibilityReport(ctx: Context): void {
  try { ctx.logger?.info?.(`[yuqi-team] ${JSON.stringify(inspectHostCompatibility(ctx))}`) } catch { /* Diagnostics never gate service startup. */ }
}

export type HostDiagnosticCategory = HostCompatibilityFailureCategory

/** Shared bounded emitter for adapters that have already classified their local operation. */
export function logHostDiagnostic(
  ctx: Pick<Context, 'logger'>,
  event: 'host-compatibility-failure' | 'session-read-failure',
  stage: string,
  category: HostDiagnosticCategory,
  level: 'warn' | 'error' = 'error',
): void {
  const message = `[yuqi-team] ${JSON.stringify({ event, schemaVersion: 1, stage, category })}`
  try { ctx.logger?.[level]?.(message) } catch { /* A broken logger must not alter Host behavior. */ }
}

/** Log fixed diagnostic facts only; provider messages, codes, stacks and paths stay private. */
export function logHostCompatibilityFailure(
  ctx: Context,
  stage: HostCompatibilityFailureStage,
  cause: unknown,
): void {
  logHostDiagnostic(ctx, 'host-compatibility-failure', stage, classifyHostCompatibilityFailure(cause))
}

export function classifyHostCompatibilityFailure(
  cause: unknown,
  fallback: HostCompatibilityFailureCategory = isError(cause) ? 'operation-failed' : 'non-error-throw',
): HostCompatibilityFailureCategory {
  const seen = new Set<unknown>()
  let current = cause
  for (let depth = 0; depth < 6 && isError(current) && !seen.has(current); depth += 1) {
    seen.add(current)
    const code = safeOwnString(current, 'code')
    if (code === 'HOST_SESSION_INCOMPATIBLE') return 'session-envelope-incompatible'
    const name = safeString(current, 'name')
    const message = safeString(current, 'message')
    if (name === 'SessionFormatUnsupportedError') return 'session-format-unsupported'
    if (name === 'SessionPersistenceCorruptionError') return 'session-persistence-corrupt'
    if (name === 'SessionPersistenceNotFoundError') return 'session-persistence-not-found'
    if (message === 'Invalid sidecar revision/envelope count'
      || message === 'Invalid sidecar SessionEvent envelope'
      || message === 'Invalid sidecar session key') return 'sidecar-record-invalid'
    if (message === 'Yuqi Session has conflicting native and sidecar facts'
      || message === 'Yuqi sidecar native identity mismatch'
      || message === 'Session is already bound to another sidecar repository') return 'sidecar-native-conflict'
    if (message === 'Native Session enumeration is unavailable'
      || message === 'Harness SessionStore.flush is unavailable'
      || message === 'Host settings requires public settings.installSection or installSettingsSection') {
      return 'capability-unavailable'
    }
    current = safeProperty(current, 'cause')
  }
  return fallback
}

function safeService(ctx: Context, name: string): object | undefined {
  return safeObject(() => ctx.get(name as never))
}

function safeStorageDomain(ctx: Context): object | undefined {
  return safeObject(() => ctx.reflect?.get?.('storageDomain', false)
    ?? ctx.root?.reflect?.get?.('storageDomain', false))
}

function safeObject(read: () => unknown): object | undefined {
  try {
    const value = read()
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

function hasFunction(value: object | undefined, key: string): boolean {
  return value !== undefined && typeof Reflect.get(value, key) === 'function'
}

function safeOwnString(value: object, key: string): string | undefined {
  try {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined
    return safeString(value, key)
  } catch {
    return undefined
  }
}

function safeString(value: object, key: string): string | undefined {
  const candidate = safeProperty(value, key)
  return typeof candidate === 'string' ? candidate : undefined
}

function safeProperty(value: object, key: string): unknown {
  try { return Reflect.get(value, key) } catch { return undefined }
}

function isError(value: unknown): value is Error {
  try { return value instanceof Error } catch { return false }
}
