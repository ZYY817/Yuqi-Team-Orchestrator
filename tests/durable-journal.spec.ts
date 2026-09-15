import { describe, expect, it } from 'vitest'
import { DurableJournalCoordinator } from '../src/index.ts'
import type { TeamEvent, TeamEventJournal } from '../src/index.ts'
import { completeTeamEvents } from './fixtures.ts'

class Journal implements TeamEventJournal {
  readonly key: string
  readonly events: unknown[] = []
  fail = false

  constructor(key = 'controller') { this.key = key }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> {
    this.events.push(...events)
    if (this.fail) throw new Error('flush failed')
  }
}

describe('DurableJournalCoordinator', () => {
  it('serializes read and commit in one transaction', async () => {
    const coordinator = new DurableJournalCoordinator()
    const journal = new Journal()
    const event = completeTeamEvents()[0]!
    const count = await coordinator.run(journal, async (transaction) => {
      expect(transaction.read()).toHaveLength(0)
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'failed')
      return transaction.read().length
    })
    expect(count).toBe(1)
  })

  it('poisons only the failed Controller when a durability barrier rejects', async () => {
    const coordinator = new DurableJournalCoordinator()
    const failed = new Journal('failed')
    const healthy = new Journal('healthy')
    failed.fail = true
    await expect(coordinator.run(failed, transaction => transaction.commit(
      [completeTeamEvents()[0]!], 'ADMISSION_PERSISTENCE_FAILED', 'admission failed',
    ))).rejects.toMatchObject({ code: 'ADMISSION_PERSISTENCE_FAILED' })
    failed.fail = false
    await expect(coordinator.run(failed, async () => undefined)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await expect(coordinator.run(healthy, async () => 'ok')).resolves.toBe('ok')
  })

  it('supports explicit poisoning and idempotent disposal', async () => {
    const coordinator = new DurableJournalCoordinator()
    const journal = new Journal()
    coordinator.poison(journal.key)
    await expect(coordinator.run(journal, async () => undefined)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    const disposal = coordinator.dispose()
    expect(coordinator.dispose()).toBe(disposal)
    await disposal
    await expect(coordinator.run(new Journal('late'), async () => undefined)).rejects.toMatchObject({ code: 'SERVICE_DISPOSED' })
  })
})
