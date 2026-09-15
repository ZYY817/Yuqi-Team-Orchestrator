/** Shared one-listener routing for a Controller's direct child settlement events. */

import { YuqiOrchestratorError } from './errors.ts'
import type { ChildEnd } from './ports.ts'

const DEFAULT_MAX_EARLY_ENDS = 128

export interface ChildEndSource {
  onEnd(listener: (event: ChildEnd) => void): () => void
}

export interface PendingChildAdmission {
  admit(childSessionId: string, listener: (event: ChildEnd) => void): void
  cancel(): void
}

/** Demultiplexes child ends and buffers only while an admission is unresolved. */
export class SettlementRouter {
  readonly #disposeSource: () => void
  readonly #listeners = new Map<string, (event: ChildEnd) => void>()
  readonly #earlyEnds = new Map<string, ChildEnd>()
  readonly #maxEarlyEnds: number
  #pendingAdmissions = 0
  #overflowed = false
  #disposed = false

  constructor(source: ChildEndSource, maxEarlyEnds = DEFAULT_MAX_EARLY_ENDS) {
    if (!Number.isInteger(maxEarlyEnds) || maxEarlyEnds < 1) throw new RangeError('maxEarlyEnds must be a positive integer')
    this.#maxEarlyEnds = maxEarlyEnds
    this.#disposeSource = source.onEnd(end => { this.#route(end) })
  }

  openAdmission(): PendingChildAdmission {
    if (this.#disposed) throw disposedError()
    this.#pendingAdmissions += 1
    let open = true
    const close = (clearEarlyWhenIdle: boolean): void => {
      if (!open) throw new YuqiOrchestratorError('INVALID_BATCH', 'This child admission claim is already closed')
      open = false
      this.#pendingAdmissions -= 1
      if (clearEarlyWhenIdle && this.#pendingAdmissions === 0 && this.#listeners.size === 0) this.#earlyEnds.clear()
    }
    return Object.freeze({
      admit: (childSessionId: string, listener: (event: ChildEnd) => void): void => {
        if (this.#disposed) throw disposedError()
        close(false)
        if (this.#overflowed) throw new YuqiOrchestratorError('EARLY_END_OVERFLOW', 'The early child settlement buffer overflowed; reconciliation is required')
        if (this.#listeners.has(childSessionId)) {
          throw new YuqiOrchestratorError('CHILD_ID_COLLISION', `Child ${childSessionId} is already routed`)
        }
        const early = this.#earlyEnds.get(childSessionId)
        this.#earlyEnds.delete(childSessionId)
        if (early === undefined) this.#listeners.set(childSessionId, listener)
        else listener(early)
      },
      cancel: () => { close(true) },
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#disposeSource()
    this.#listeners.clear()
    this.#earlyEnds.clear()
  }

  #route(end: ChildEnd): void {
    if (this.#disposed) return
    const listener = this.#listeners.get(end.childSessionId)
    if (listener !== undefined) {
      this.#listeners.delete(end.childSessionId)
      listener(end)
      if (this.#pendingAdmissions === 0 && this.#listeners.size === 0) this.#earlyEnds.clear()
      return
    }
    if (this.#pendingAdmissions === 0 || this.#earlyEnds.has(end.childSessionId)) return
    if (this.#earlyEnds.size >= this.#maxEarlyEnds) {
      this.#overflowed = true
      this.#earlyEnds.clear()
      return
    }
    this.#earlyEnds.set(end.childSessionId, end)
  }
}

function disposedError(): YuqiOrchestratorError {
  return new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi settlement router is disposed')
}
