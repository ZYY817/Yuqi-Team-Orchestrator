/** Serialized durability boundary for one prepared Team batch intent. */

import { replayTeamEvents } from '../domain/projection.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { prepareTeamBatchIntent } from './prepare-team-batch.ts'
import type { PreparedTeamBatch, PrepareTeamBatchRequest } from './prepare-team-batch.ts'

/** Owns plan revalidation and intent persistence for all Controller journals. */
export class TeamBatchIntentCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions = new DurableJournalCoordinator()) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  commit(request: PrepareTeamBatchRequest, journal: TeamEventJournal): Promise<PreparedTeamBatch> {
    return this.#transactions.run(journal, async (transaction) => {
      const projection = replayTeamEvents(transaction.read())
      const prepared = prepareTeamBatchIntent(projection, request, this.#clock, this.#eventIds)
      await transaction.commit(
        prepared.events,
        'INTENT_PERSISTENCE_FAILED',
        'Yuqi could not durably persist the Team batch dispatch intent',
      )
      return prepared
    })
  }

  dispose(): Promise<void> {
    return this.#transactions.dispose()
  }
}
