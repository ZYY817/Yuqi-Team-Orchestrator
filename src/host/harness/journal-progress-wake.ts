/** Cancels observation only; never owns a worker or runner cancellation signal. */
export class JournalProgressWake {
  private readonly listeners = new Map<string, Set<() => void>>()

  committed(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  async wait(key: string, signal: AbortSignal, shouldWake: () => boolean,
    observe: (signal: AbortSignal) => Promise<void>): Promise<void> {
    signal.throwIfAborted()
    const observation = new AbortController()
    const wake = new Error('Journal has schedulable progress')
    let checkFailure: unknown
    const check = () => {
      try { if (shouldWake()) observation.abort(wake) }
      catch (cause) { checkFailure = cause; observation.abort(cause) }
    }
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    this.listeners.set(key, listeners)
    listeners.add(check)
    const onAbort = () => observation.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Subscribe first, then re-read: a commit before subscription is not lost.
      signal.throwIfAborted()
      check()
      if (checkFailure !== undefined) throw checkFailure
      if (!observation.signal.aborted) {
        try { await observe(observation.signal) }
        catch (cause) {
          signal.throwIfAborted()
          if (checkFailure !== undefined) throw checkFailure
          // Do not hide a real observation/reconciliation failure racing a wake.
          if (observation.signal.reason !== wake || (cause !== wake && !isObservationCancellation(cause))) throw cause
        }
      }
      signal.throwIfAborted()
      if (checkFailure !== undefined) throw checkFailure
    } finally {
      signal.removeEventListener('abort', onAbort)
      listeners.delete(check)
      if (listeners.size === 0) this.listeners.delete(key)
    }
  }
}

/** The observation signal is intentionally aborted to wake the scheduler. A
 * public child-list read reports that abort as its own typed cancellation
 * error; treat only that cancellation form as the expected wake edge. */
function isObservationCancellation(cause: unknown): boolean {
  if (cause === undefined || cause === null || typeof cause !== 'object') return false
  if (cause instanceof Error && cause.name === 'AbortError') return true
  return 'code' in cause && (cause as { readonly code?: unknown }).code === 'CANCELLED'
}
