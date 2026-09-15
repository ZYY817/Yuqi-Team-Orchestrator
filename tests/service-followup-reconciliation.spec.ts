import { Session, SessionId } from '@deepseek-ai/dsh-session'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { YuqiTeamOrchestratorService, type HarnessStartTeamRequest } from '../src/host/harness/service.ts'
import { DurableJournalCoordinator } from '../src/application/durable-journal.ts'
import { JournalGate } from '../src/application/journal-gate.ts'
import { StartFollowupTeamCoordinator } from '../src/application/start-followup-team.ts'
import type { TeamEvent } from '../src/domain/events.ts'
import { parseTeamEvent, replayTeamEvents } from '../src/domain/projection.ts'
import { TeamId } from '../src/domain/ids.ts'
import { SidecarRepository } from '../src/host/storage/session-sidecar.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { commitYuqiSessionEvent, HarnessSessionJournal, readActiveTeamParentBinding, readTeamEventsFromSession,
  TEAM_PARENT_BINDING_EVENT, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import type { PersistedSessionSnapshot } from '../src/host/harness/session-restore.ts'
import { JournalProgressWake } from '../src/host/harness/journal-progress-wake.ts'
import { completeTeamEvents, event, TEAM_ID } from './fixtures.ts'

class Table implements OwnedEventTable {
  readonly records = new Map<string, OwnedEventRecord>()
  get(key: string) { return this.records.get(key) }
  entries() { return this.records.entries() }
  async put(key: string, value: OwnedEventRecord) { this.records.set(key, structuredClone(value)) }
  async update(key: string, transform: (value: OwnedEventRecord) => OwnedEventRecord) {
    const current = this.records.get(key)
    if (current === undefined) throw new Error('Missing stored record')
    const next = transform(structuredClone(current))
    await this.put(key, next)
    return structuredClone(next)
  }
}
const repositories: SidecarRepository[] = []
afterEach(async () => {
  // Let deferred parent-projection syncs settle before disposal poisons bindings.
  await new Promise(resolve => setTimeout(resolve, 0))
  for (const repository of repositories.splice(0)) repository.dispose()
})

function withWorkspace(events: readonly TeamEvent[], cwd: string): TeamEvent[] {
  const first = events[0]!
  const workspaceId = `workspace-${first.teamId}`
  const workspace = { workspaceId, project: { mode: 'direct', projectRoot: cwd,
    volumeRoot: path.parse(cwd).root, protectedRoots: [] }, worktreePath: cwd, branchName: 'direct', status: 'provisioning' }
  return [first,
    { type: 'yuqi/workspace-provisioning-started', workspace },
    { type: 'yuqi/workspace-provisioned', workspaceId },
    ...events.slice(1),
  ].map((value, index) => {
    return parseTeamEvent({ ...value, schemaVersion: 1, teamId: first.teamId,
      eventId: `${first.teamId}-fixture-${index}`, occurredAt: new Date(Date.UTC(2026, 8, 7, 0, 0, index)).toISOString() })
  })
}

async function fixture() {
  const cwd = process.cwd()
  const table = new Table()
  const repository = new SidecarRepository(table)
  repositories.push(repository)
  const persisted = new Map<string, PersistedSessionSnapshot>()
  const live = new Map<string, Session>()
  const nativeSession = (id: string, parentSessionId?: string, directory = cwd) => {
    const base = Session.create(SessionId(id))
    const session = Session.create(base.id, [], { ...base.header, cwd: directory,
      ...(parentSessionId === undefined ? {} : { parentSession: SessionId(parentSessionId) }) })
    expect(String(session.id)).toBe(id)
    expect(session.header.cwd).toBe(directory)
    if (parentSessionId !== undefined) expect(String(session.header.parentSession)).toBe(parentSessionId)
    persisted.set(id, { meta: session.header, events: [] })
    live.set(id, session)
    repository.bind(session)
    return session
  }
  // Parent's cwd intentionally differs: only the execution workspace must match.
  const parent = nativeSession('parent', undefined, path.dirname(cwd))
  const sourceSession = nativeSession('source-controller', String(parent.id))
  const bindParent = async (session: Session) => {
    await commitYuqiSessionEvent(session, TEAM_PARENT_BINDING_EVENT, { parentSessionId: String(parent.id),
      generation: 1, operationId: `bind-${session.id}`, boundAt: '2026-09-07T00:00:00Z' })
    expect(readActiveTeamParentBinding(session)).toMatchObject({ parentSessionId: String(parent.id), generation: 1 })
  }
  await bindParent(sourceSession)
  const events = withWorkspace(completeTeamEvents(), cwd)
  expect(replayTeamEvents(events).workspace?.status).toBe('ready')
  await commitYuqiSessionEvent(sourceSession, TEAM_SESSION_EVENT, { events })
  const sessions = { get: (id: SessionId) => live.get(String(id)), flush: async () => true }
  const journal = new HarnessSessionJournal(sourceSession, sessions)
  const transactions = new DurableJournalCoordinator()
  const clock = { nowIso: () => '2026-09-07T00:01:00Z' }
  let serial = 0
  const ids = { next: () => `host-followup-${++serial}` }
  const source = { teamId: TEAM_ID, controllerSessionId: String(sourceSession.id), operationId: 'followup', requestDigest: 'a'.repeat(64) }
  await expect(new StartFollowupTeamCoordinator(clock, ids, transactions).start({ ...source, parentSessionId: String(parent.id) }, journal,
    async () => { throw new Error('Unknown native creation') })).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
  // journal.commit scheduled a deferred parent-projection bridge sync
  // (setTimeout in scheduleTeamProjectionToParent). Let it publish the parent's
  // sidecar record now so enumeration fingerprints a stable inventory, exactly
  // as a cold persisted world looks after that background write has settled.
  await new Promise(resolve => setTimeout(resolve, 0))
  const list = vi.fn(async (): Promise<readonly Session['header'][]> => [...persisted.values()].map(value => value.meta))
  const load = vi.fn(async (id: SessionId): Promise<PersistedSessionSnapshot | undefined> => {
    const value = persisted.get(String(id))
    return value === undefined ? undefined : structuredClone(value)
  })
  const unexpectedNativeWrite = vi.fn(async () => { throw new Error('Reconciliation must not write native sessions') })
  const open = vi.fn(async () => { throw new Error('Existing sidecar must not be reopened') })
  const get = vi.fn((name: string) => {
    if (name === 'sessions') return sessions
    if (name === 'storageDomain') return { open }
    throw new Error(`Fixture has not configured Host capability ${name}`)
  })
  // Exercise real startFollowupTeam -> prepareFollowupTeam -> scan -> coordinator.
  // Real readiness/bind/journal/projection/scan. The already-open repository and
  // resolved readiness promise model initialization without constructor jobs.
  const service: YuqiTeamOrchestratorService = Object.create(YuqiTeamOrchestratorService.prototype)
  const prepareTeam = vi.fn(async () => { throw new Error('Must not create') })
  const wake = vi.fn(() => { throw new Error('Must not launch') })
  const shutdown = new AbortController()
  for (const [name, value] of Object.entries({
    ctx: { get,
      // ensureSidecarReady probes optional capabilities through the reflection
      // store; model it over the same capability surface as ctx.get.
      reflect: { get: (name: string) => get(name) },
      sessionPersistence: { list, load, create: unexpectedNativeWrite, append: unexpectedNativeWrite } },
    teamStartGate: new JournalGate(), teamStartShutdown: shutdown, transactions,
    sidecar: repository, sidecarReady: Promise.resolve(), sidecarSessions: new Map(live),
    journalProgressWake: new JournalProgressWake(), disposed: false,
    progressClock: clock, progressEventIds: ids,
    prepareTeam, wakeTeamRunner: wake,
  })) Object.defineProperty(service, name, { value, configurable: true })
  const request: HarnessStartTeamRequest = { title: 'Follow-up', objective: 'Continue', tasks: [],
    projectCwd: process.cwd(), controllerModel: { provider: 'deepseek' }, controllerParentSessionId: String(parent.id) }
  const addTarget = async (id = 'target-controller') => {
    const target = nativeSession(id, String(parent.id))
    await bindParent(target)
    const sourceEvents = readTeamEventsFromSession(sourceSession)
    const intentIndex = sourceEvents.findIndex(value => value.type === 'yuqi/team-followup-requested')
    const teamId = TeamId(`team-${id}`)
    const targetEvents = withWorkspace([
      event(1, { type: 'yuqi/team-created', title: 'Follow-up', objective: 'Continue', continuedFrom: {
        sourceTeamId: TEAM_ID, sourceControllerSessionId: String(sourceSession.id), operationId: source.operationId,
        sourceEventId: String(sourceEvents[intentIndex - 1]!.eventId),
      } }, teamId),
      event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }, teamId),
    ], cwd)
    expect(replayTeamEvents(targetEvents).workspace?.status).toBe('ready')
    await commitYuqiSessionEvent(target, TEAM_SESSION_EVENT, { events: targetEvents })
    live.delete(id) // Discovery must restore native persistence, not pick a live target cache.
    return { session: target, teamId }
  }
  return { service, source, request, list, load, get events() { return readTeamEventsFromSession(sourceSession) },
    transactions, journal, prepareTeam, wake, shutdown, addTarget, persisted, repository, get, open, unexpectedNativeWrite }
}

describe('Host automatic pending follow-up reconciliation', () => {
  it('finds one cold persisted sidecar target and commits only its source link without creating or launching', async () => {
    const h = await fixture()
    const target = await h.addTarget()
    const nativeBefore = structuredClone([...h.persisted])
    const targetBefore = h.repository.readStoredEvents(String(target.session.id))
    const result = await h.service.startFollowupTeam(h.request, h.source)
    expect(result).toEqual({ kind: 'existing', teamId: target.teamId, controllerSessionId: String(target.session.id) })
    // Both complete inventories, plus actual native loads for the parent,
    // source and cold target, must happen before uniqueness is trusted.
    expect(h.list).toHaveBeenCalledTimes(2)
    for (const id of ['parent', 'source-controller', String(target.session.id)]) {
      expect(h.load).toHaveBeenCalledWith(SessionId(id))
    }
    expect(h.events.at(-1)).toMatchObject({ type: 'yuqi/team-followup-created', operationId: h.source.operationId,
      targetTeamId: target.teamId, targetControllerSessionId: String(target.session.id) })
    expect(h.events.filter(value => value.type === 'yuqi/team-followup-created')).toHaveLength(1)
    expect(h.repository.readStoredEvents(String(target.session.id))).toEqual(targetBefore)
    expect([...h.persisted]).toEqual(nativeBefore)
    expect(h.unexpectedNativeWrite).not.toHaveBeenCalled()
    expect(h.get).toHaveBeenCalledWith('storageDomain')
    expect(h.get).toHaveBeenCalledWith('sessions')
    expect(h.open).not.toHaveBeenCalled()
    expect(h.prepareTeam).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
    // A repeat must use the real newly persisted link, not rescan/recreate.
    expect(await h.service.startFollowupTeam(h.request, h.source)).toEqual(result)
    expect(h.list).toHaveBeenCalledTimes(2)
    expect(h.events.filter(value => value.type === 'yuqi/team-followup-created')).toHaveLength(1)
  })
  it('keeps pending when a full scan proves multiple otherwise valid targets', async () => {
    const h = await fixture()
    await h.addTarget('target-one')
    await h.addTarget('target-two')
    const before = [...h.events]
    await expect(h.service.startFollowupTeam(h.request, h.source)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(h.list).toHaveBeenCalledTimes(2)
    expect(h.events).toEqual(before)
    expect(h.prepareTeam).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
    expect(h.unexpectedNativeWrite).not.toHaveBeenCalled()
  })
  it('retains pending when a complete native and sidecar inventory contains no target', async () => {
    const h = await fixture()
    const before = [...h.events]
    await expect(h.service.startFollowupTeam(h.request, h.source)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(h.list).toHaveBeenCalledTimes(2)
    expect(h.load).toHaveBeenCalledWith(SessionId('source-controller'))
    expect(h.events).toEqual(before)
    expect(h.prepareTeam).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
  })
  it('returns an already reconciled identity without enumeration, creation or runner wake', async () => {
    const h = await fixture()
    await new StartFollowupTeamCoordinator({ nowIso: () => '2026-09-07T00:01:00Z' },
      { next: () => 'host-confirmed-target' }, h.transactions).reconcile({
      teamId: TEAM_ID, operationId: h.source.operationId, sourceControllerSessionId: h.journal.key,
      parentSessionId: 'parent',
    }, h.journal, async () => [{ teamId: 'target', controllerSessionId: 'target-controller',
      sourceTeamId: TEAM_ID, sourceControllerSessionId: h.journal.key, operationId: h.source.operationId,
      parentSessionId: 'parent' }])
    expect(await h.service.startFollowupTeam(h.request, h.source)).toEqual({
      kind: 'existing', teamId: 'target', controllerSessionId: 'target-controller',
    })
    expect(h.list).not.toHaveBeenCalled()
    expect(h.prepareTeam).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
  })
  it('scans on pending and preserves intent without creating or waking on incomplete inventory', async () => {
    const h = await fixture()
    h.list.mockResolvedValue([])
    const before = [...h.events]
    await expect(h.service.startFollowupTeam(h.request, h.source)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(h.list).toHaveBeenCalledOnce()
    expect(h.events).toEqual(before)
    expect(h.prepareTeam).not.toHaveBeenCalled()
    expect(h.wake).not.toHaveBeenCalled()
  })
  it('cannot bypass same-process journal poison by scanning again', async () => {
    const h = await fixture()
    h.transactions.poison(h.journal.key)
    await expect(h.service.startFollowupTeam(h.request, h.source)).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    expect(h.list).not.toHaveBeenCalled()
    expect(h.prepareTeam).not.toHaveBeenCalled()
  })
  it('rejects changed payload before scanning', async () => {
    const h = await fixture()
    await expect(h.service.startFollowupTeam(h.request, { ...h.source, requestDigest: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    expect(h.list).not.toHaveBeenCalled()
  })
  it('abandons an unresponsive public list on shutdown, retaining pending', async () => {
    const h = await fixture()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    h.list.mockImplementation(() => { entered(); return new Promise(() => {}) })
    const result = h.service.startFollowupTeam(h.request, h.source)
    const rejected = expect(result).rejects.toMatchObject({ code: 'CONTROLLER_REQUIRES_RECONCILIATION' })
    await started
    h.shutdown.abort(new Error('Shutdown'))
    await rejected
    expect(h.events.at(-1)?.type).toBe('yuqi/team-followup-requested')
    expect(h.prepareTeam).not.toHaveBeenCalled()
  })
})
