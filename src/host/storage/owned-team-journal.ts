import { createHash } from 'node:crypto'
import type { TeamEventJournal } from '../../application/ports.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import type { TeamEvent } from '../../domain/events.ts'
import { OwnedEventStore } from './owned-event-store.ts'

/** Team port for the isolated storage-domain acceptance slice.
 * Not selected by the live Harness service until all readers are switched.
 * Retains only an optimistic revision, never a second copy of Team facts.
 */
export class OwnedTeamJournal implements TeamEventJournal {
  readonly #store: OwnedEventStore
  #revision: number | undefined

  constructor(store: OwnedEventStore) { this.#store = store }

  get key(): string { return this.#store.controllerSessionId }

  read(): readonly unknown[] {
    const snapshot = this.#store.read()
    if (snapshot.events.length > 0) replayTeamEvents(snapshot.events)
    // Once a decision cut is acquired, unrelated projection reads cannot move
    // it forward. A conflicting writer requires a fresh journal/transaction.
    this.#revision ??= snapshot.revision
    return snapshot.events
  }

  async commit(events: readonly TeamEvent[]): Promise<void> {
    if (events.length === 0) return
    if (this.#revision === undefined) throw new Error('Read the Team journal before committing')
    const snapshot = this.#store.read()
    // The store checks exact-operation retries BEFORE revision conflicts.
    // Do not reject a duplicate durable batch merely because its cut is stale.
    replayTeamEvents([...snapshot.events, ...events])
    const operationId = createHash('sha256').update(JSON.stringify(events.map(event => event.eventId))).digest('hex')
    const committed = await this.#store.commit({ expectedRevision: this.#revision, operationId, events })
    // A retry may report a newer revision containing OTHER writers' decisions.
    // Acknowledging our old batch does not authorize those unseen changes.
    if (!committed.replayed) this.#revision = committed.revision
  }
}
