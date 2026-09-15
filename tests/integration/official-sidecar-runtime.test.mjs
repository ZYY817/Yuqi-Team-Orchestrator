import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ownedEventDomainSpec } from '../../src/host/storage/owned-event-store.ts'
import { SidecarRepository, readSidecarEvents } from '../../src/host/storage/session-sidecar.ts'
import {
  HarnessSessionJournal, readTeamProjectionEvents, readLatestReviewResult,
  selectActiveTeamProjectionBridge, syncTeamProjectionToParent,
  TEAM_SESSION_EVENT, REVIEW_SESSION_EVENT, TEAM_PARENT_PROJECTION_EVENT,
} from '../../src/host/harness/session-journal.ts'
import { HarnessReviewJournal } from '../../src/host/harness/review-journal.ts'
import { TeamBootstrapCoordinator } from '../../src/application/bootstrap-team.ts'
import { DurableJournalCoordinator } from '../../src/application/durable-journal.ts'
import { replayTeamEvents } from '../../src/domain/projection.ts'
import { reviewResultSchema, REVIEW_TRIGGERS } from '../../src/domain/review-policy.ts'

// Run with Node 24: node --experimental-transform-types --test <this file>.
// Missing/mismatched official installations FAIL rather than silently skip.
test('runtime sidecar journals cold-replay with exact official Sessions and no native Yuqi events', async t => {
  assert.ok(process.env.YUQI_OFFICIAL_TEST_ROOT, 'YUQI_OFFICIAL_TEST_ROOT is required')
  const officialRoot = resolve(process.env.YUQI_OFFICIAL_TEST_ROOT)
  const requireOfficial = createRequire(join(officialRoot, 'package.json'))
  const packages = [
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-storage',
    '@deepseek-ai/dsh-storage-json', '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/dsh-session',
  ]
  for (const name of packages) {
    const entry = requireOfficial.resolve(name)
    const inside = relative(join(officialRoot, 'node_modules'), entry)
    assert.ok(!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`),
      `${name} resolved outside the official installation: ${entry}`)
    const metadata = requireOfficial(`${name}/package.json`)
    assert.equal(metadata.version, name === '@deepseek-ai/cordis' ? '4.0.2' : '0.1.2-rc.1')
    t.diagnostic(`${name}@${metadata.version}: ${entry}`)
  }
  const load = name => import(pathToFileURL(requireOfficial.resolve(name)).href)
  const [{ Context }, { Storage }, { JsonStorageBackend }, { DomainFacility, defineDomain }, { Session }] =
    await Promise.all(packages.map(load))
  const spec = defineDomain(ownedEventDomainSpec)
  const root = await mkdtemp(join(tmpdir(), 'yuqi-official-sidecar-runtime-'))
  const closers = []
  const transactions = new DurableJournalCoordinator()

  async function open() {
    const ctx = new Context()
    const backend = new JsonStorageBackend(root)
    let facility, repository, unregister
    let closing
    const close = () => closing ??= (async () => {
      repository?.dispose()
      try { await facility?.closeAll() }
      finally {
        unregister?.()
        try { await backend.close() }
        finally { await ctx.fiber.dispose() }
      }
    })()
    closers.push(close)
    await ctx.plugin(Storage)
    unregister = ctx.storage.backend.register('json', backend)
    facility = new DomainFacility(ctx, { backend: 'json' })
    const domain = await facility.open(spec)
    repository = new SidecarRepository(domain.table('sessions'))
    return { ctx, backend, facility, domain, repository, close }
  }

  // Lookup adapter only: both values are real official Sessions. Any legacy
  // native flush fallback is a failure; durable writes belong to the Domain.
  function sessionsFor(parent, controller) {
    const live = new Map([[parent.id, parent], [controller.id, controller]])
    return {
      get: id => live.get(id),
      flush: async () => { assert.fail('Sidecar runtime must not flush a Yuqi native event') },
    }
  }
  function nativeSnapshot(session) {
    assert.equal(Object.hasOwn(session, 'events'), false)
    const events = session.snapshotEvents()
    assert.ok(events.length > 0, 'Use a nonempty native log, not a vacuous pollution check')
    assert.ok(events.every(event => !event.type.startsWith('yuqi/')))
    return JSON.parse(JSON.stringify({ header: session.header, events }))
  }
  function newSession(id, parentSession) {
    const header = { ...Session.create(id).header, cwd: root,
      ...(parentSession === undefined ? {} : { parentSession }) }
    // Official create adds its native session/end-seed marker for this seed.
    return Session.create(id, [], header)
  }

  try {
    const first = await open()
    const parent = newSession('official-sidecar-parent')
    const controller = newSession('official-sidecar-controller', parent.id)
    const nativeBefore = [nativeSnapshot(parent), nativeSnapshot(controller)]
    first.repository.bind(parent)
    first.repository.bind(controller)
    const sessions = sessionsFor(parent, controller)
    const journal = new HarnessSessionJournal(controller, sessions)
    const reviews = new HarnessReviewJournal(controller, sessions)
    let seq = 0
    const coordinator = new TeamBootstrapCoordinator(
      { nowIso: () => '2026-09-06T00:00:00Z' }, { next: () => `runtime-${seq++}` }, transactions,
    )
    const request = {
      metadata: { teamId: 'runtime-team', title: 'Runtime sidecar', objective: 'Real cold replay' },
      requirePlanConfirmation: true,
      tasks: [{ taskId: 'one', revision: 1, goal: 'Read one file', scope: ['one.txt'], nonGoals: ['write'],
        dependencies: [], fileScope: ['one.txt'], modelRole: 'worker', modelId: 'fixture-model',
        acceptanceCriteria: ['Return text'], authorityMode: 'read-only', inputDigest: 'one', baselineRef: 'initial' }],
    }
    const projection = await coordinator.bootstrap(request, journal)
    assert.equal(projection.team.status, 'paused')
    const facts = journal.read()
    assert.ok(facts.length > 1)
    assert.equal(readSidecarEvents(controller)[0].type, TEAM_SESSION_EVENT)
    assert.deepEqual(readTeamProjectionEvents(parent), facts, 'Bootstrap must actually publish its parent bridge')

    const review = reviewResultSchema.parse({
      reviewId: 'runtime-review', trigger: REVIEW_TRIGGERS[0], reviewerSessionId: 'official-reviewer',
      decision: 'pass', findings: [], unverified: [],
    })
    await reviews.commit(review)
    assert.deepEqual(reviews.read(), [review])
    assert.deepEqual(readLatestReviewResult(controller), review)
    const bridge = selectActiveTeamProjectionBridge(readSidecarEvents(parent))
    assert.ok(bridge)
    assert.equal(bridge.controllerSessionId, controller.id)
    assert.deepEqual(bridge.events, facts)
    assert.deepEqual(bridge.review, review, 'Review commit must refresh the actual parent bridge')
    assert.deepEqual([nativeSnapshot(parent), nativeSnapshot(controller)], nativeBefore)

    const savedSidecars = [readSidecarEvents(parent), readSidecarEvents(controller)]
    assert.ok(savedSidecars[0].some(event => event.type === TEAM_PARENT_PROJECTION_EVENT))
    assert.ok(savedSidecars[1].some(event => event.type === REVIEW_SESSION_EVENT))
    const file = join(root, `${spec.name}.json`)
    const bytes = await readFile(file, 'utf8')
    assert.equal(Object.keys(JSON.parse(bytes).tables.sessions).length, 2)
    // Test fixture snapshot, NOT a substitute SessionPersistence backend.
    const nativeFile = join(root, 'native-sessions.json')
    await writeFile(nativeFile, JSON.stringify(nativeBefore), 'utf8')
    first.repository.dispose()
    assert.throws(() => readSidecarEvents(controller), /disposed/)
    await assert.rejects(reviews.commit(review), /disposed/)
    assert.deepEqual([nativeSnapshot(parent), nativeSnapshot(controller)], nativeBefore)
    await first.close()

    const second = await open()
    assert.notEqual(second.backend, first.backend)
    assert.notEqual(second.domain, first.domain)
    const savedNative = JSON.parse(await readFile(nativeFile, 'utf8'))
    const restored = savedNative.map(({ header, events }) => Session.create(header.id, events, header))
    assert.notEqual(restored[0], parent)
    assert.notEqual(restored[1], controller)
    assert.deepEqual(restored.map(nativeSnapshot), nativeBefore)
    for (const session of restored) second.repository.bind(session)
    assert.deepEqual(second.repository.listSessionIds().sort(), [parent.id, controller.id].sort())
    assert.deepEqual(restored.map(readSidecarEvents), savedSidecars, 'Every envelope must survive cold open')
    const restoredSessions = sessionsFor(...restored)
    const restoredJournal = new HarnessSessionJournal(restored[1], restoredSessions)
    const restoredReviews = new HarnessReviewJournal(restored[1], restoredSessions)
    assert.deepEqual(restoredJournal.read(), facts)
    assert.deepEqual(replayTeamEvents(restoredJournal.read()), projection)
    assert.deepEqual(restoredReviews.read(), [review])
    assert.deepEqual(readTeamProjectionEvents(restored[0]), facts)
    assert.deepEqual(selectActiveTeamProjectionBridge(readSidecarEvents(restored[0])), bridge)
    assert.equal(await syncTeamProjectionToParent(restored[1], restoredSessions), true)
    assert.equal(await readFile(file, 'utf8'), bytes, 'Unchanged restored bridge must not append another cut')
    assert.deepEqual(restored.map(nativeSnapshot), nativeBefore)
    t.diagnostic(`Cold replay: ${facts.length} Team facts; parent/controller sidecar envelopes ${savedSidecars.map(x => x.length).join('/')}; native logs unchanged`)
  } finally {
    await transactions.dispose()
    try { for (const close of closers.reverse()) await close() }
    finally {
      // Delete only this test's exact mkdtemp directory, after validating scope.
      assert.equal(resolve(root, '..'), resolve(tmpdir()))
      assert.ok(root.startsWith(join(tmpdir(), 'yuqi-official-sidecar-runtime-')))
      await rm(root, { recursive: true, force: true })
    }
  }
})
