/** Per-controller FIFO serialization for journal read/validate/commit transactions. */

import { YuqiOrchestratorError } from './errors.ts'

/**
 * Serializes operations sharing a journal key while allowing different
 * controllers to progress independently.
 */
export class JournalGate {
  readonly #tails = new Map<string, Promise<void>>()
  #disposed = false
  #disposal: Promise<void> | undefined

  run<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    if (this.#disposed) {
      return Promise.reject(new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi journal gate is disposed'))
    }

    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return result
  }

  /** Stop accepting operations and wait for accepted work to settle. */
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal
    this.#disposed = true
    this.#disposal = Promise.all([...this.#tails.values()]).then(() => undefined)
    return this.#disposal
  }
}
