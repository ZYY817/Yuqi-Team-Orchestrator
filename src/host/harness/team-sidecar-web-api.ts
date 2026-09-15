import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  TEAM_SIDECAR_CHANNEL, TEAM_SIDECAR_MAX_RESPONSE_BYTES, TEAM_SIDECAR_PAGE_SIZE,
  teamSidecarSnapshotRequestSchema, teamSidecarSnapshotSchema,
  type TeamSidecarReader,
} from '../../domain/team-sidecar-web-contract.ts'
import { classifyHostCompatibilityFailure, logHostDiagnostic } from './host-compatibility-diagnostics.ts'

export type SidecarReadStage = 'initialize' | 'catalog' | 'cursor' | 'native-load' | 'native-persistence' | 'native-restore' | 'native-bind' | 'sidecar-bind' | 'session-facts' | 'serialization'
const readerStages = new WeakMap<Error, SidecarReadStage>()
/** Attach diagnostic context without changing the error or its failure policy. */
export function markSidecarReadFailure(error: unknown, stage: SidecarReadStage): void {
  if (error instanceof Error && !readerStages.has(error)) readerStages.set(error, stage)
}

/** Install only the plugin-owned, read-only channel on an injected Connection.
 * Native Session authority and existing domain lifecycle belong to the reader.
 */
export function installTeamSidecarWebApi(
  ctx: Context,
  reader: TeamSidecarReader,
  recoverTarget?: (teamId: string, controllerSessionId: string, signal: AbortSignal) => Promise<void>,
  resolveParent?: (teamId: string, controllerSessionId: string, signal: AbortSignal) => Promise<string>,
): void {
  const connection = (ctx.get('connection' as never) ?? (ctx as unknown as { connection?: HostConnectionHandle }).connection) as HostConnectionHandle | undefined
  if (typeof connection?.rpc?.handle !== 'function') throw new Error('Host Connection RPC is required')
  const reject = (code: string, message: string) => ({ ok: false as const, error: code === 'bad-request'
    ? { code: 'bad-request' as const, message, details: { issues: [] } }
    : { code: code === 'cancelled' ? 'cancelled' as const : 'internal' as const,
      message: `[sidecar:${code}] ${message}`, details: {} } })
  const dispose = connection.rpc.handle(TEAM_SIDECAR_CHANNEL, async (endpoint, payload, signal) => {
    if (endpoint === 'resolve-parent') {
      if (resolveParent === undefined || !isRecoveryTarget(payload)) return reject('bad-request', 'Invalid Team parent target')
      try {
        const parentSessionId = await resolveParent(payload.teamId, payload.controllerSessionId, signal)
        return { ok: true, value: { parentSessionId } }
      } catch (cause) {
        if (!signal.aborted) logHostDiagnostic(ctx, 'host-compatibility-failure', 'sidecar-resolve-parent', classifyHostCompatibilityFailure(cause), 'warn')
        return reject(signal.aborted ? 'cancelled' : 'read-failed', 'Could not resolve Team parent')
      }
    }
    if (endpoint === 'recover-target') {
      if (recoverTarget === undefined || !isRecoveryTarget(payload)) return reject('bad-request', 'Invalid Team recovery target')
      try { await recoverTarget(payload.teamId, payload.controllerSessionId, signal); return { ok: true, value: { accepted: true } } }
      catch (cause) {
        if (!signal.aborted) {
          logHostDiagnostic(ctx, 'host-compatibility-failure', 'sidecar-recover-target', classifyHostCompatibilityFailure(cause), 'warn')
        }
        return reject(signal.aborted ? 'cancelled' : 'read-failed', 'Could not recover Team target')
      }
    }
    if (endpoint !== 'snapshot') return reject('not-found', 'Unknown sidecar endpoint')
    const request = teamSidecarSnapshotRequestSchema.safeParse(payload)
    if (!request.success) return reject('bad-request', 'Invalid sidecar snapshot request')
    if (signal.aborted) return reject('cancelled', 'Sidecar snapshot cancelled')
    try {
      const { sessionIds, cursor } = request.data
      let raw: unknown
      try {
        raw = await reader(sessionIds, {
          limit: TEAM_SIDECAR_PAGE_SIZE, signal, ...(cursor === undefined ? {} : { cursor }),
        })
      } catch (cause) {
        logSidecarFailure(ctx, 'reader', cause, { requestedSessionCount: sessionIds?.length ?? 0, hasCursor: cursor !== undefined })
        throw cause
      }
      signal.throwIfAborted()
      const checked = teamSidecarSnapshotSchema.safeParse(raw)
      if (!checked.success) {
        logSidecarFailure(ctx, 'response-schema', checked.error, { requestedSessionCount: sessionIds?.length ?? 0 })
        return reject('invalid-state', 'Invalid sidecar snapshot')
      }
      const value = checked.data
      if (sessionIds !== undefined && value.sessions.some(session => !sessionIds.includes(session.sessionId))) {
        logSidecarFailure(ctx, 'response-identity', undefined, { requestedSessionCount: sessionIds.length, returnedSessionCount: value.sessions.length })
        return reject('invalid-state', 'Sidecar snapshot contains an unrequested session')
      }
      if (value.nextCursor !== undefined && value.nextCursor === cursor) {
        logSidecarFailure(ctx, 'response-cursor', undefined, { hasCursor: true })
        return reject('invalid-state', 'Sidecar cursor did not advance')
      }
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > TEAM_SIDECAR_MAX_RESPONSE_BYTES) {
        logSidecarFailure(ctx, 'response-size', undefined, { returnedSessionCount: value.sessions.length })
        return reject('response-too-large', 'Sidecar snapshot exceeds response limit; request fewer sessions')
      }
      return { ok: true, value }
    } catch (cause) {
      // Reader errors can contain file paths or credentials. Never serialize them.
      if (signal.aborted) logSidecarFailure(ctx, 'cancelled', cause, {})
      return signal.aborted ? reject('cancelled', 'Sidecar snapshot cancelled')
        : reject('read-failed', 'Could not read sidecar snapshot')
    }
  }, { authority: 'loopback' })
  ctx.effect(() => dispose, 'yuqiTeamOrchestrator.sidecarWebApi')
}

function isRecoveryTarget(value: unknown): value is { teamId: string; controllerSessionId: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as Record<string, unknown>).teamId === 'string'
    && typeof (value as Record<string, unknown>).controllerSessionId === 'string'
    && Object.keys(value as object).length === 2
}

const readerFailureSignatures: Readonly<Record<string, string>> = {
  'Yuqi sidecar is closed': 'sidecar-closed',
  'Sidecar repository is disposed': 'repository-disposed',
  'Invalid sidecar revision/envelope count': 'sidecar-revision',
  'Invalid sidecar SessionEvent envelope': 'sidecar-envelope',
  'Invalid sidecar session key': 'sidecar-key',
  'Yuqi sidecar native identity mismatch': 'native-identity',
  'Persisted Session identity mismatch': 'persisted-identity',
  'Restored Session does not preserve its persisted identity and event prefix': 'restored-event-prefix',
  'Host cannot preserve the persisted Session fork boundary': 'restored-fork-boundary',
  'Yuqi Session has conflicting native and sidecar facts': 'native-sidecar-conflict',
  'Cannot bind sidecar: Session contains legacy yuqi/ facts; migration is not supported': 'legacy-bind',
  'Session is already bound to another sidecar repository': 'repository-rebind',
  'Session is not bound to an active sidecar repository': 'repository-unbound',
  'session header isSeeded must be a boolean': 'raw-header-isSeeded',
  'Invalid sidecar cursor': 'invalid-cursor',
}
const readerFailureSites = [
  ['restorePersistedSession', 'restore-native'],
  ['readStoredEvents', 'read-stored-facts'],
  ['readYuqiSessionEvents', 'read-session-facts'],
  ['SidecarRepository.bind', 'bind-sidecar'],
  ['loadPersistedControllerSession', 'load-native'],
  ['ensureSidecarReady', 'initialize'],
  ['readSidecarSnapshot', 'snapshot'],
] as const

function logSidecarFailure(ctx: Context, phase: 'reader' | 'response-schema' | 'response-identity' | 'response-cursor' | 'response-size' | 'cancelled', cause: unknown, details: Record<string, number | boolean>): void {
  const error = cause instanceof Error ? cause : undefined
  // Only fixed categories cross this diagnostic boundary. Even error.name and
  // error.code may originate in provider/storage payloads and contain secrets.
  const name = error?.name === 'Error' || error?.name === 'SessionPersistenceCorruptionError' || error?.name === 'SessionFormatUnsupportedError' || error?.name === 'SessionPersistenceNotFoundError'
    ? error.name : 'unknown'
  const nativeHeader = error?.name === 'SessionPersistenceCorruptionError'
    && /^stored session "[^"]+" failed validation: Error: session header isSeeded must be a boolean$/u.test(error.message)
  const serializedHeader = error !== undefined
    && /^SessionPersistenceCorruptionError: stored session "[^"]+" failed validation: Error: session header isSeeded must be a boolean$/u.test(error.message)
  const headerValidation = nativeHeader ? 'native-isSeeded' : serializedHeader ? 'serialized-isSeeded' : 'other'
  const reason = error !== undefined && Object.hasOwn(readerFailureSignatures, error.message)
    ? readerFailureSignatures[error.message]! : 'unclassified'
  // Match only stack frames, never the first line containing the raw message.
  // Emit a fixed site label, not function names, paths, line numbers or frames.
  const frames = error?.stack?.split('\n').slice(1).filter(line => /^\s+at /u.test(line)).join('\n') ?? ''
  const site = readerFailureSites.find(([marker]) => frames.includes(marker))?.[1] ?? 'unknown'
  const stage = error === undefined ? 'unknown' : readerStages.get(error) ?? 'unknown'
  const safeDetails = Object.entries(details).filter(([, value]) => typeof value === 'number' || typeof value === 'boolean')
  const suffix = safeDetails.map(([key, value]) => ` ${key}=${String(value)}`).join('')
  const message = `[yuqi-team] sidecar rpc failed phase=${phase} errorKind=${name} headerValidation=${headerValidation} reason=${reason} site=${site} stage=${stage}${suffix}`
  ctx.logger.warn(message)
  // The official web Host logger may not forward plugin warnings to stderr.
  // Keep this bounded fallback visible to local diagnosis after a restart.
  console.warn(message)
}
