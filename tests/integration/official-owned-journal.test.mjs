import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { OwnedEventStore, ownedEventDomainSpec } from '../../src/host/storage/owned-event-store.ts'
import { OwnedTeamJournal } from '../../src/host/storage/owned-team-journal.ts'
import { TeamBootstrapCoordinator } from '../../src/application/bootstrap-team.ts'
import { DurableJournalCoordinator } from '../../src/application/durable-journal.ts'
import { replayTeamEvents } from '../../src/domain/projection.ts'

// Explicit isolated official installation; never resolve the repository's older Host.
const officialRoot = process.env.YUQI_OFFICIAL_TEST_ROOT
test('official storage persists an application Team across a fresh backend/domain', { skip: !officialRoot }, async () => {
  const requireOfficial = createRequire(join(resolve(officialRoot), 'package.json'))
  const load = name => import(pathToFileURL(requireOfficial.resolve(name)).href)
  const [{ Context }, { Storage }, { JsonStorageBackend }, { DomainFacility, defineDomain }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-storage'),
    load('@deepseek-ai/dsh-storage-json'), load('@deepseek-ai/dsh-storage-domain'),
  ])
  const spec = defineDomain(ownedEventDomainSpec)
  const root = await mkdtemp(join(tmpdir(), 'yuqi-official-owned-journal-'))
  const opened = []
  async function open() {
    const ctx = new Context()
    const fiber = await ctx.plugin(Storage)
    const backend = new JsonStorageBackend(root)
    const unregister = ctx.storage.backend.register('json', backend)
    const facility = new DomainFacility(ctx, { backend: 'json' })
    const domain = await facility.open(spec)
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await domain.close()
      unregister()
      await backend.close()
      await fiber.dispose()
    }
    opened.push(close)
    return { domain, close, journal: new OwnedTeamJournal(new OwnedEventStore({
      table: domain.table('sessions'), controllerSessionId: 'official-controller',
    })) }
  }
  const transactions = new DurableJournalCoordinator()
  try {
    let seq = 0
    const coordinator = new TeamBootstrapCoordinator(
      { nowIso: () => '2026-09-06T00:00:00Z' }, { next: () => `owned-${seq++}` }, transactions,
    )
    const request = { metadata: { teamId: 'official-team', title: 'Official storage', objective: 'Cold replay' },
      requirePlanConfirmation: true,
      tasks: [{ taskId: 'one', revision: 1, goal: 'Read one file', scope: ['one.txt'], nonGoals: ['write'],
        dependencies: [], fileScope: ['one.txt'], modelRole: 'worker', modelId: 'fixture-model',
        acceptanceCriteria: ['Return text'], authorityMode: 'read-only', inputDigest: 'one', baselineRef: 'initial' }] }
    const first = await open()
    const state = await coordinator.bootstrap(request, first.journal)
    assert.equal(state.team.status, 'paused')
    const facts = first.journal.read()
    const bytes = await readFile(join(root, `${spec.name}.json`), 'utf8')
    assert.equal(JSON.parse(bytes).unit.name, spec.name)
    await first.close()
    const second = await open()
    assert.deepEqual(second.journal.read(), facts)
    assert.equal(replayTeamEvents(second.journal.read()).team.status, 'paused')
    await coordinator.bootstrap(request, second.journal)
    assert.deepEqual(second.journal.read(), facts, 'Retry must not create a second Team')
    assert.equal(await readFile(join(root, `${spec.name}.json`), 'utf8'), bytes)
    await assert.rejects(second.journal.commit([{ ...facts[0], eventId: 'invalid-new-event', teamId: 'wrong-team' }]))
    assert.deepEqual(second.journal.read(), facts, 'Invalid Team facts must not change storage')
  } finally {
    await transactions.dispose()
    for (const close of opened.reverse()) await close()
    // This exact mkdtemp directory belongs solely to this test.
    await rm(root, { recursive: true, force: true })
  }
})
