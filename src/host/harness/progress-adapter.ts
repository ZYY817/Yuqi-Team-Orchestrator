/** Public Harness progress observation for warm and restarted Team runs. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildEnd, TeamEventJournal } from '../../application/ports.ts'
import type { TeamRunProgressRequest } from '../../application/run-team-loop.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { hasEffectiveAssistantOutput, reportedChangedFilesFrom, taskOutcomeFrom } from './continuable-child.ts'
import { classifyHostCompatibilityFailure, logHostDiagnostic } from './host-compatibility-diagnostics.ts'

export interface HarnessObservedChildEnd extends ChildEnd {
  readonly settledAt?: string
}

type RecoveredTerminalFact = Omit<HarnessObservedChildEnd, 'provider'> & { readonly settledAt: string }

export interface HarnessProgressSettlementRequest {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly journal: TeamEventJournal
  readonly end: HarnessObservedChildEnd
  /** Optional in-transaction ownership guard for cold recovery races. */
  readonly canSettle?: () => boolean
}

export interface HarnessProgressReconciliationRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly signal: AbortSignal
  readonly reason: string
}

export interface HarnessTeamProgressAdapterOptions {
  readonly controller: Agent
  readonly waitForLocalAttempts: (journalKey: string, attemptIds: readonly string[], signal: AbortSignal) => Promise<void>
  /** Preferred rolling-refill seam; compatibility callers may retain the all-attempt wait above. */
  readonly waitForAnyLocalAttempt?: (journalKey: string, attemptIds: readonly string[], signal: AbortSignal) => Promise<void>
  /**
   * True only while this process owns the exact attempt's direct terminal
   * callback. Such a callback carries the authoritative final usage, so the
   * public Host edge must wait for its durable result instead of racing it.
   */
  readonly ownsLocalAttempt?: (journalKey: string, attemptId: string) => boolean
  readonly settleAttempt: (request: HarnessProgressSettlementRequest) => Promise<void>
  /** Return true when the controller completed recovery and scheduling may continue. */
  readonly reconcile?: (request: HarnessProgressReconciliationRequest) => Promise<boolean | void>
  readonly timeoutMs?: number
}

interface ActiveAttempt {
  readonly taskId: string
  readonly attemptId: string
  readonly childSessionId: string
  readonly messageId: string
}

/** Exact durable binding required before recovering a terminal child Session fact. */
export interface HarnessTerminalBinding {
  readonly childSessionId: string
  readonly messageId: string
}

const DEFAULT_PROGRESS_TIMEOUT_MS = 30_000
const MIN_PROGRESS_TIMEOUT_MS = 10
const MAX_PROGRESS_TIMEOUT_MS = 300_000

type SessionReadCapability = 'inspect' | 'open-read' | 'load'
const SESSION_READ_TIMEOUT = Symbol('session-read-timeout')

class HarnessSessionReadResponseError extends Error {
  constructor(readonly capability: SessionReadCapability) {
    super(`Harness Session persistence ${capability} returned an invalid response`)
    this.name = 'HarnessSessionReadResponseError'
  }
}

export class HarnessTeamProgressAdapter {
  readonly #ctx: Context
  readonly #options: HarnessTeamProgressAdapterOptions

  constructor(ctx: Context, options: HarnessTeamProgressAdapterOptions) {
    this.#ctx = ctx
    this.#options = options
  }

  async waitForProgress(request: TeamRunProgressRequest): Promise<void> {
    request.signal.throwIfAborted()
    const active = this.#activeAttempts(request)
    const byChild = new Map(active.map(attempt => [attempt.childSessionId, attempt]))
    const observedEnds = new Map<string, HarnessObservedChildEnd>()
    const settlements = new Map<string, Promise<void>>()
    const pending = new Set(active.map(attempt => attempt.attemptId))
    const initialPendingCount = pending.size
    const done = deferred<void>()
    let failure: unknown
    const localWaitAbort = new AbortController()
    const localWaitSignal = AbortSignal.any([request.signal, localWaitAbort.signal])
    const locallyOwned = new Set(active
      .filter(attempt => this.#options.ownsLocalAttempt?.(request.journal.key, attempt.attemptId) === true)
      .map(attempt => attempt.attemptId))

    const refresh = (): void => {
      const projection = replayTeamEvents(request.journal.read())
      for (const attempt of active) {
        if (projection.attempts[attempt.attemptId]?.evidence !== undefined) pending.delete(attempt.attemptId)
      }
      if (pending.size < initialPendingCount) done.resolve(undefined)
    }

    const settleObserved = (attempt: ActiveAttempt, end: HarnessObservedChildEnd): void => {
      if (settlements.has(attempt.attemptId)) return
      const settlement = this.#options.settleAttempt({
        teamId: request.teamId,
        taskId: attempt.taskId,
        attemptId: attempt.attemptId,
        journal: request.journal,
        end,
      }).then(refresh)
      settlements.set(attempt.attemptId, settlement)
      void settlement.catch(error => {
        failure = error
        done.reject(error)
      })
    }

    const onEnd = (info: SubagentRunEndInfo): void => {
      const childSessionId = String(info.id)
      const attempt = byChild.get(childSessionId)
      if (attempt === undefined) return
      const end: HarnessObservedChildEnd = {
        runId: String(info.runId),
        provider: info.provider,
        childSessionId,
        stopReason: info.stopReason,
        hasAssistantOutput: hasEffectiveAssistantOutput(info.lastAssistantMessage),
        ...taskOutcomeFrom(info.lastAssistantMessage),
        ...reportedChangedFilesFrom(info.lastAssistantMessage),
      }
      observedEnds.set(childSessionId, end)
      // The in-process executor owns this exact attempt and includes its final
      // provider usage in direct settlement. Do not let the public lifecycle
      // edge turn that same completion into an irreversible unknown-usage fact.
      if (locallyOwned.has(attempt.attemptId)) return
      settleObserved(attempt, end)
    }

    const dispose = this.#options.controller.ctx.on('subagent/end', onEnd)
    try {
      if (locallyOwned.size > 0) {
        const waitForLocalProgress = this.#options.waitForAnyLocalAttempt ?? this.#options.waitForLocalAttempts
        void waitForLocalProgress(request.journal.key, [...locallyOwned], localWaitSignal)
          .then(refresh, error => {
            // Local ownership is a direct durable-settlement promise. Do not
            // turn a failed write or lost binding into a public fallback fact.
            failure = error
            done.reject(error)
          })
      }
      const entries = await this.#listWhileWaiting(request.signal, done.promise)
      if (entries === undefined) return
      request.signal.throwIfAborted()
      const entryById = new Map(entries.map(entry => [String(entry.id), entry]))
      const localAttemptIds: string[] = []

      for (const attempt of active) {
        if (locallyOwned.has(attempt.attemptId)) continue
        const entry = entryById.get(attempt.childSessionId)
        if (entry === undefined || entry.kind === 'diagnostic') {
          return await this.#requiresReconciliation(request, `Harness cannot prove the active child ${attempt.childSessionId} exists`)
        }
        if (entry.mode !== 'continuable') {
          return await this.#requiresReconciliation(request, `Harness child ${attempt.childSessionId} is not continuable`)
        }
        if (entry.activity === 'inactive') {
          const recovered = observedEnds.get(attempt.childSessionId) ?? await this.#loadTerminalFact(attempt, request.signal)
          if (recovered === undefined) {
            return await this.#requiresReconciliation(request, `Harness child ${attempt.childSessionId} is inactive without a matching terminal Session fact`)
          }
          settleObserved(attempt, recovered)
        } else if (observedEnds.has(attempt.childSessionId)) {
          settleObserved(attempt, observedEnds.get(attempt.childSessionId)!)
        } else {
          localAttemptIds.push(attempt.attemptId)
        }
      }

      refresh()
      if (pending.size < initialPendingCount) return
      if (localAttemptIds.length > 0) {
        const waitForLocalProgress = this.#options.waitForAnyLocalAttempt ?? this.#options.waitForLocalAttempts
        void waitForLocalProgress(request.journal.key, localAttemptIds, request.signal)
          .then(refresh, error => {
            // This is already a definitive recovery signal. Reject the local
            // wait immediately so the bounded wrapper records reconciliation
            // now instead of silently consuming the error until its timeout.
            if (isReconciliationError(error)) {
              done.reject(error)
              return
            }
            failure = error
            done.reject(error)
          })
      }
      while (pending.size === initialPendingCount) {
        try {
          const outcome = await this.#waitBounded(done.promise, request.signal)
          if (outcome === 'progress') break
        } catch (cause) {
          if (request.signal.aborted) throw cause
          if (cause instanceof YuqiOrchestratorError && cause.code === 'CONTROLLER_REQUIRES_RECONCILIATION') {
            return await this.#requiresReconciliation(request, cause.message)
          }
          throw cause
        }

        // A quiet child is not a failed child. Treat the bound as a heartbeat:
        // re-check exact Host ownership and continue waiting while every child
        // is still present, continuable, and active. Reconciliation is reserved
        // for contradictory or missing runtime facts.
        const refreshedEntries = await this.#listWhileWaiting(request.signal, done.promise)
        if (refreshedEntries === undefined) return
        request.signal.throwIfAborted()
        const refreshedById = new Map(refreshedEntries.map(entry => [String(entry.id), entry]))
        for (const attempt of active) {
          if (!pending.has(attempt.attemptId)) continue
          if (locallyOwned.has(attempt.attemptId)) continue
          const entry = refreshedById.get(attempt.childSessionId)
          if (entry === undefined || entry.kind === 'diagnostic') {
            return await this.#requiresReconciliation(request, `Harness cannot prove the active child ${attempt.childSessionId} exists`)
          }
          if (entry.mode !== 'continuable') {
            return await this.#requiresReconciliation(request, `Harness child ${attempt.childSessionId} is not continuable`)
          }
          if (entry.activity === 'inactive') {
            const recovered = observedEnds.get(attempt.childSessionId) ?? await this.#loadTerminalFact(attempt, request.signal)
            if (recovered === undefined) {
              return await this.#requiresReconciliation(request, `Harness child ${attempt.childSessionId} is inactive without a matching terminal Session fact`)
            }
            settleObserved(attempt, recovered)
          } else if (observedEnds.has(attempt.childSessionId)) {
            settleObserved(attempt, observedEnds.get(attempt.childSessionId)!)
          }
        }
        refresh()
      }
      if (failure !== undefined) throw failure
    } finally {
      // This only ends the adapter's wait subscription. It must not keep a
      // stale executor waiter alive after another attempt advances the run.
      localWaitAbort.abort(new Error('Team progress observation completed'))
      dispose()
    }
  }

  /** A slow catalog read cannot hold up an already persisted child result or cancellation. */
  async #listWhileWaiting(signal: AbortSignal, progress: Promise<void>): Promise<Awaited<ReturnType<Context['subagents']['listChildren']>> | undefined> {
    signal.throwIfAborted()
    const read = new AbortController()
    const readSignal = AbortSignal.any([signal, read.signal])
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(signal.reason ?? new Error('Team progress catalog read aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([
        this.#ctx.subagents.listChildren(SessionId(String(this.#options.controller.id)), readSignal),
        progress.then(() => undefined),
        aborted,
      ])
    } finally {
      signal.removeEventListener('abort', onAbort)
      read.abort()
    }
  }

  #activeAttempts(request: TeamRunProgressRequest): readonly ActiveAttempt[] {
    const projection = replayTeamEvents(request.journal.read())
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    return request.activeTaskIds.map(taskId => {
      const task = projection.tasks[taskId]
      const attemptId = task?.attemptIds.at(-1)
      const attempt = attemptId === undefined ? undefined : projection.attempts[attemptId]
      if (task === undefined || attemptId === undefined || attempt === undefined || attempt.agentSessionId === undefined || attempt.messageId === undefined) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Task ${taskId} has no durable active child binding`)
      }
      return { taskId: String(taskId), attemptId: String(attemptId), childSessionId: attempt.agentSessionId, messageId: attempt.messageId }
    })
  }

  async #loadTerminalFact(attempt: ActiveAttempt, signal: AbortSignal): Promise<HarnessObservedChildEnd | undefined> {
    return loadInactiveTerminalFact(this.#ctx, attempt, signal, this.#timeoutMs())
  }

  async #requiresReconciliation(request: TeamRunProgressRequest, reason: string): Promise<void> {
    request.signal.throwIfAborted()
    try {
      const recovered = await this.#options.reconcile?.({ teamId: request.teamId, journal: request.journal, signal: request.signal, reason })
      if (recovered === true) return
    } catch (cause) {
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', reason, { cause })
    }
    throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', reason)
  }

  async #waitBounded(progress: Promise<void>, signal: AbortSignal): Promise<'progress' | 'heartbeat'> {
    const timeoutMs = this.#timeoutMs()
    signal.throwIfAborted()
    let timer!: ReturnType<typeof setTimeout>
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(signal.reason ?? new Error('Team progress wait aborted'))
    const timeout = new Promise<'heartbeat'>(resolve => {
      timer = setTimeout(() => resolve('heartbeat'), timeoutMs)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([progress.then(() => 'progress' as const), aborted, timeout])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  #timeoutMs(): number {
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_PROGRESS_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_PROGRESS_TIMEOUT_MS || timeoutMs > MAX_PROGRESS_TIMEOUT_MS) {
      throw new RangeError(`timeoutMs must be an integer from ${MIN_PROGRESS_TIMEOUT_MS} to ${MAX_PROGRESS_TIMEOUT_MS}`)
    }
    return timeoutMs
  }
}

/**
 * Reads one exact, already-inactive child Session without waiting for progress.
 * A missing, malformed, or slow native fact is deliberately indistinguishable
 * from no proof to callers; they retain the normal fail-closed reconciliation.
 */
export async function loadInactiveTerminalFact(
  ctx: Context,
  binding: HarnessTerminalBinding,
  signal: AbortSignal,
  timeoutMs = DEFAULT_PROGRESS_TIMEOUT_MS,
): Promise<HarnessObservedChildEnd | undefined> {
  signal.throwIfAborted()
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_PROGRESS_TIMEOUT_MS || timeoutMs > MAX_PROGRESS_TIMEOUT_MS) throw new RangeError(`timeoutMs must be an integer from ${MIN_PROGRESS_TIMEOUT_MS} to ${MAX_PROGRESS_TIMEOUT_MS}`)
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  let timer!: ReturnType<typeof setTimeout>
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(signal.reason ?? new Error('Team progress load aborted'))
  const timeout = new Promise<typeof SESSION_READ_TIMEOUT>(resolve => { timer = setTimeout(() => resolve(SESSION_READ_TIMEOUT), timeoutMs) })
  signal.addEventListener('abort', onAbort, { once: true })
  let closeOpenHandle: (() => Promise<void>) | undefined
  let closePromise: Promise<void> | undefined
  let finished = false
  let capability: SessionReadCapability | undefined
  const close = (): Promise<void> | undefined => {
    if (closeOpenHandle === undefined) return undefined
    closePromise ??= closeOpenHandle()
    return closePromise
  }
  try {
    // Hosts expose either inspect(), read handles, or the legacy load() API.
    // Read the immutable full log without acquiring ownership or resuming a child.
    const reader = persistence as unknown as Record<PropertyKey, unknown>
    const inspect = Reflect.get(reader, 'inspect')
    const open = Reflect.get(reader, 'open')
    const load = Reflect.get(reader, 'load')
    let read: Promise<unknown> | undefined
    if (typeof inspect === 'function') {
      capability = 'inspect'
      read = Promise.resolve(Reflect.apply(inspect, reader, [SessionId(binding.childSessionId), signal]))
    } else if (typeof open === 'function') {
      capability = 'open-read'
      read = (async () => {
        const handle: unknown = await Reflect.apply(open, reader, [SessionId(binding.childSessionId), 'read', { signal }])
        if (!isObject(handle)) throw new HarnessSessionReadResponseError('open-read')
        const closeHandle = Reflect.get(handle, 'close')
        if (typeof closeHandle !== 'function') throw new HarnessSessionReadResponseError('open-read')
        closeOpenHandle = async () => { await Reflect.apply(closeHandle, handle, []) }
        if (finished) {
          await close()
          return undefined
        }
        try {
          signal.throwIfAborted()
          const header = Reflect.get(handle, 'header')
          const readHandle = Reflect.get(handle, 'read')
          if (!isObject(header) || typeof readHandle !== 'function') throw new HarnessSessionReadResponseError('open-read')
          const result: unknown = await Reflect.apply(readHandle, handle, [undefined, undefined, { signal }])
          if (!isObject(result)) throw new HarnessSessionReadResponseError('open-read')
          return { meta: header, events: Reflect.get(result, 'events') }
        } finally { await close() }
      })()
    } else if (typeof load === 'function') {
      capability = 'load'
      read = Promise.resolve(Reflect.apply(load, reader, [SessionId(binding.childSessionId)]))
    }
    if (read === undefined) {
      logHostDiagnostic(ctx, 'session-read-failure', 'session-read-unavailable', 'capability-unavailable', 'warn')
      return undefined
    }
    const selectedCapability = capability
    if (selectedCapability === undefined) return undefined
    const loaded = await Promise.race([read, aborted, timeout])
    if (loaded === SESSION_READ_TIMEOUT) {
      logHostDiagnostic(ctx, 'session-read-failure', `session-read-${selectedCapability}`, 'operation-timeout', 'warn')
      return undefined
    }
    if (loaded === undefined) return undefined
    if (!isSessionInspection(loaded)) throw new HarnessSessionReadResponseError(selectedCapability)
    if (String(loaded.meta.id) !== binding.childSessionId) return undefined
    const projection = replaySessionTerminal(loaded.events, binding)
    if (projection === undefined) return undefined
    const descriptor = foldSubagentDescriptor(loaded.events)
    if (descriptor === undefined || descriptor.mode !== 'continuable' || descriptor.provider.trim() === '') return undefined
    return { ...projection, provider: descriptor.provider }
  } catch (cause) {
    signal.throwIfAborted()
    logHostDiagnostic(
      ctx,
      'session-read-failure',
      `session-read-${capability ?? 'capability-probe'}`,
      cause instanceof HarnessSessionReadResponseError ? 'response-invalid' : classifyHostCompatibilityFailure(cause),
      'warn',
    )
    return undefined
  } finally {
    finished = true
    // `read()` may be indefinitely stalled on a Host transport. Request a
    // single close now rather than retaining the native read handle until its
    // promise happens to resolve later. A delayed `open()` observes `finished`
    // and closes itself before returning any data.
    void close()?.catch(() => undefined)
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionInspection(value: unknown): value is { readonly meta: { readonly id: SessionId }; readonly events: readonly SessionEvent[] } {
  if (!isObject(value)) return false
  const meta = Reflect.get(value, 'meta')
  return isObject(meta) && typeof Reflect.get(meta, 'id') === 'string' && Array.isArray(Reflect.get(value, 'events'))
}

function replaySessionTerminal(events: readonly SessionEvent[], attempt: HarnessTerminalBinding): RecoveredTerminalFact | undefined {
  const messageId = findMessageId(events, attempt)
  if (messageId === undefined) return undefined
  let activeTurn: number | undefined
  let targetTurn: number | undefined
  const usage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let hasUsage = false
  let hasAssistantOutput = false
  let taskOutcome = taskOutcomeFrom(undefined).taskOutcome
  let selectedMessage = false
  let partialText = ''
  let reportedChangedFiles: readonly string[] | undefined
  for (const event of events) {
    if (event.type === 'turn/start') activeTurn = event.data.turn
    if (event.type === 'user/message' && event.data.id === messageId) targetTurn = activeTurn
    if (targetTurn === undefined) continue
    if (activeTurn === targetTurn && event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      partialText += event.data.chunk.text
    }
    if (event.type === 'assistant/message' && activeTurn === targetTurn) {
      // Match Host AssistantOutputFold: usage-only [] messages do not replace
      // the last content message; whitespace text does. Do not scan other turns.
      if (event.data.message.content.length > 0) {
        selectedMessage = true
        hasAssistantOutput = hasEffectiveAssistantOutput(event.data.message.content)
        taskOutcome = taskOutcomeFrom(event.data.message.content).taskOutcome
      }
      reportedChangedFiles = reportedChangedFilesFrom(event.data.message.content).reportedChangedFiles ?? reportedChangedFiles
      if (event.data.usage !== undefined) {
        hasUsage = true
        usage.uncachedInputTokens += event.data.usage.inputTokens
        usage.outputTokens += event.data.usage.outputTokens
        usage.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
        usage.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0
      }
    }
    if (event.type !== 'turn/end' || event.data.turn !== targetTurn) continue
    const settledAt = new Date(event.time)
    if (!Number.isFinite(settledAt.getTime())) return undefined
    if (!selectedMessage) {
      const content = [{ type: 'text' as const, text: partialText }]
      hasAssistantOutput = hasEffectiveAssistantOutput(content)
      taskOutcome = taskOutcomeFrom(content).taskOutcome
    }
    return {
      runId: `recovered:${attempt.childSessionId}:${targetTurn}`,
      childSessionId: attempt.childSessionId,
      stopReason: stopReason(event.data.reason.kind),
      hasAssistantOutput,
      taskOutcome,
      ...(reportedChangedFiles === undefined ? {} : { reportedChangedFiles }),
      ...(hasUsage ? { usage } : {}),
      settledAt: settledAt.toISOString(),
    }
  }
  return undefined
}

function findMessageId(events: readonly SessionEvent[], attempt: HarnessTerminalBinding): string | undefined {
  const message = events.find(event => event.type === 'user/message' && event.data.id === attempt.messageId)
  return message?.type === 'user/message' ? String(message.data.id) : undefined
}

function stopReason(kind: string): string {
  switch (kind) {
    case 'completed': return 'completed'
    case 'aborted':
    case 'interrupted': return 'aborted'
    case 'max-tokens': return 'max-tokens'
    case 'blocked': return 'refusal'
    case 'error': return 'error'
    default: return 'error'
  }
}

function isReconciliationError(cause: unknown): boolean {
  return cause instanceof YuqiOrchestratorError && cause.code === 'CONTROLLER_REQUIRES_RECONCILIATION'
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (reason: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
