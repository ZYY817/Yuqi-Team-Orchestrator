/** No Host API or conversation-history access belongs in this module. */
export interface TeamHandoffSource {
  readonly sessionId: string
  readonly cwd: string
  readonly parentSessionId?: string | undefined
  readonly agentPreset?: string | undefined
  readonly isTeam: boolean
  readonly isIdle: boolean
}

export interface TeamHandoffContext {
  readonly goal: string
  readonly summary: string
}

export interface TeamHandoffRequest {
  readonly sourceSessionId: string
  /** Generated before the first call; the adapter must use this exact ID. */
  readonly targetSessionId: string
  readonly context: TeamHandoffContext
}

export interface TeamHandoffResult {
  readonly kind: 'opened' | 'created' | 'unknown' | 'rejected'
  readonly sessionId?: string | undefined
  readonly message?: string | undefined
  /** Only rejected: the adapter guarantees NO creation or prompt side effects. */
  readonly retryable?: boolean | undefined
}

/**
 * The adapter rechecks source eligibility/cwd, creates the supplied ID using
 * agentPreset: 'yuqi-team', sends only the explicit context, then opens it.
 * Never select a preset on the old session. `created` does not prove prompt
 * delivery. A thrown error/timeout is unknown, never permission to resend.
 */
export type CreateTeamHandoff = (request: TeamHandoffRequest) => Promise<TeamHandoffResult>

export interface TeamHandoffAttempt {
  readonly targetSessionId: string
  readonly kind: 'pending' | TeamHandoffResult['kind']
  readonly message?: string | undefined
  readonly retryable?: boolean | undefined
}

export const HANDOFF_GOAL_LIMIT = 4_000
export const HANDOFF_SUMMARY_LIMIT = 12_000
const PREFIX = 'yuqi-team-handoff.v1:'
const attempts = new Map<string, TeamHandoffAttempt>()
const listeners = new Set<() => void>()

export function canHandoff(source: TeamHandoffSource): boolean {
  return source.sessionId.trim() !== '' && source.cwd.trim() !== ''
    && source.parentSessionId == null && !source.isTeam
    && source.agentPreset !== 'yuqi-team' && source.isIdle
}

export function validHandoffContext(context: TeamHandoffContext): boolean {
  return context.goal.trim().length > 0 && context.goal.length <= HANDOFF_GOAL_LIMIT
    && context.summary.length <= HANDOFF_SUMMARY_LIMIT
}

export function subscribeHandoff(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Only target identity/status is persisted; user text is never stored here. */
export function getHandoffAttempt(sourceSessionId: string): TeamHandoffAttempt | undefined {
  const cached = attempts.get(sourceSessionId)
  if (cached !== undefined) return cached
  if (typeof window === 'undefined') return undefined
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PREFIX + sourceSessionId) ?? 'null')
    if (value === null || typeof value !== 'object') return undefined
    const target = Reflect.get(value, 'targetSessionId')
    const kind = Reflect.get(value, 'kind')
    if (typeof target !== 'string' || target.trim() === '') return undefined
    const attempt: TeamHandoffAttempt = {
      targetSessionId: target,
      kind: kind === 'opened' || kind === 'created' || kind === 'rejected' ? kind : 'unknown',
      ...(kind === 'rejected' && Reflect.get(value, 'retryable') === true ? { retryable: true } : {}),
    }
    attempts.set(sourceSessionId, attempt)
    return attempt
  } catch {
    return undefined
  }
}

function publish(sourceSessionId: string, attempt: TeamHandoffAttempt): void {
  attempts.set(sourceSessionId, attempt)
  try {
    window.sessionStorage.setItem(PREFIX + sourceSessionId, JSON.stringify({
      targetSessionId: attempt.targetSessionId, kind: attempt.kind,
      ...(attempt.kind === 'rejected' && attempt.retryable === true ? { retryable: true } : {}),
    }))
  } catch { /* The pre-call identity was saved; keep the in-memory outcome. */ }
  for (const listener of listeners) listener()
}

/** No repeat submission except an explicit, side-effect-free rejection. */
export async function submitTeamHandoff(
  source: TeamHandoffSource,
  context: TeamHandoffContext,
  createHandoff: CreateTeamHandoff,
): Promise<TeamHandoffAttempt | undefined> {
  const existing = getHandoffAttempt(source.sessionId)
  if (existing !== undefined && !(existing.kind === 'rejected' && existing.retryable === true)) return existing
  if (!canHandoff(source) || !validHandoffContext(context)) return undefined
  const targetSessionId = existing?.targetSessionId ?? globalThis.crypto.randomUUID()
  const pending: TeamHandoffAttempt = { targetSessionId, kind: 'pending' }
  // Fail closed if a refresh could lose the identity after an uncertain create.
  try {
    window.sessionStorage.setItem(PREFIX + source.sessionId, JSON.stringify(pending))
  } catch {
    const rejected: TeamHandoffAttempt = { targetSessionId, kind: 'rejected', retryable: true }
    publish(source.sessionId, rejected)
    return rejected
  }
  publish(source.sessionId, pending)
  const timer = window.setTimeout(() => {
    publish(source.sessionId, { targetSessionId, kind: 'unknown' })
  }, 15_000)
  try {
    const result = await createHandoff({
      sourceSessionId: source.sessionId, targetSessionId,
      context: { goal: context.goal.trim(), summary: context.summary.trim() },
    })
    const validKind = ['opened', 'created', 'unknown', 'rejected'].includes(result.kind)
    const settled: TeamHandoffAttempt = !validKind || (result.sessionId !== undefined && result.sessionId !== targetSessionId)
      ? { targetSessionId, kind: 'unknown' }
      : { targetSessionId, kind: result.kind, ...(result.message ? { message: result.message } : {}),
        ...(result.kind === 'rejected' && result.retryable === true ? { retryable: true } : {}) }
    publish(source.sessionId, settled)
    return settled
  } catch {
    const unknown: TeamHandoffAttempt = { targetSessionId, kind: 'unknown' }
    publish(source.sessionId, unknown)
    return unknown
  } finally {
    window.clearTimeout(timer)
  }
}
