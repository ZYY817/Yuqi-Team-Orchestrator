/** Controller-scoped serialized transactions with fail-closed durability poisoning. */

import type { TeamEvent } from '../domain/events.ts'
import type { TeamEventJournal } from './ports.ts'
import type { YuqiOrchestratorErrorCode } from './errors.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { JournalGate } from './journal-gate.ts'

export interface JournalTransaction {
  read(): readonly unknown[]
  commit(
    events: readonly TeamEvent[],
    failureCode: YuqiOrchestratorErrorCode,
    failureMessage: string,
  ): Promise<void>
}

/** One shared serialization and poison boundary for intent, admission, and settlement. */
export class DurableJournalCoordinator {
  readonly #gate = new JournalGate()
  readonly #poisoned = new Set<string>()

  run<Result>(
    journal: TeamEventJournal,
    operation: (transaction: JournalTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.#gate.run(journal.key, async () => {
      if (this.#poisoned.has(journal.key)) throw reconciliationError()
      const transaction: JournalTransaction = {
        read: () => journal.read(),
        commit: async (events, failureCode, failureMessage) => {
          try {
            await journal.commit(events)
          } catch (cause) {
            this.#poisoned.add(journal.key)
            throw new YuqiOrchestratorError(failureCode, failureMessage, { cause })
          }
        },
      }
      return operation(transaction)
    })
  }

  /** Mark a Controller uncertain after an external side effect cannot be reconciled. */
  poison(journalKey: string): void {
    this.#poisoned.add(journalKey)
  }

  dispose(): Promise<void> {
    return this.#gate.dispose()
  }
}

function reconciliationError(): YuqiOrchestratorError {
  return new YuqiOrchestratorError(
    'CONTROLLER_REQUIRES_RECONCILIATION',
    'This controller has an uncertain Yuqi durability result',
  )
}
