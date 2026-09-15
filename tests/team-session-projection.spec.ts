import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { createTeamSessionProjection, registerTeamSessionProjection } from '../src/host/harness/team-projection.ts'
import { HarnessReviewJournal } from '../src/host/harness/review-journal.ts'
import {
  buildTeamProjectionBridge,
  HarnessSessionJournal,
  PROJECT_SUMMARY_SESSION_EVENT,
  readLatestProjectSummary,
  readLatestReviewResult,
  readTeamEventsFromSession,
  readTeamProjectionEvents,
  REVIEW_SESSION_EVENT,
  syncTeamProjectionToParent,
  TEAM_PARENT_PROJECTION_EVENT,
  TEAM_PARENT_BINDING_EVENT,
  TEAM_PARENT_DETACHED_EVENT,
  readActiveTeamParentBinding,
  parseTeamParentBindingData,
  parseTeamParentDetachedData,
  TEAM_SESSION_EVENT,
} from '../src/host/harness/session-journal.ts'
import { completeTeamEvents } from './fixtures.ts'
import { TeamEventId } from '../src/domain/ids.ts'

describe('Yuqi Team Session projection', () => {
  it('publishes yuqiTeam through the current Harness wire projection contract', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(createTeamSessionProjection())
    const session = ctx.sessions.create()
    session.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })

    expect(ctx.sessionProjections.snapshot(session).values.yuqiTeam).toMatchObject({
      team: { status: 'completed', completedTaskCount: 1 },
    })

    const definition = createTeamSessionProjection()
    let state = definition.init()
    for (const event of session.events) state = definition.apply(state, event)
    const modernView = definition.view(state)
    expect(definition.schema.parse(modernView)).toMatchObject({
      team: { status: 'completed', completedTaskCount: 1 },
    })
  })

  it('registers through the optional Harness projection capability', async () => {
    const ctx = new Context()
    const register = vi.fn()
    const parentId = SessionId('projection-registration-parent')
    const controllerId = SessionId('projection-registration-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    const unrelated = Session.create(SessionId('projection-registration-unrelated'), [], {
      version: 0, id: SessionId('projection-registration-unrelated'), createdAt: 0, parentSession: SessionId('another-parent'),
    })
    const corrupt = Session.create(SessionId('projection-registration-corrupt'), [], {
      version: 0, id: SessionId('projection-registration-corrupt'), createdAt: 0, parentSession: parentId,
    })
    corrupt.append(TEAM_SESSION_EVENT, null as never)
    controller.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    ctx.provide('sessionProjections', { register } as never)
    ctx.provide('sessions', {
      list: () => [controller, unrelated, corrupt],
      get: (id: SessionId) => id === parentId ? parent : undefined,
      flush: async () => true,
    } as never)
    registerTeamSessionProjection(ctx)
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    ctx.emit('session/created', parent)
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    expect(register.mock.calls[0]?.[0]).toMatchObject({ key: 'yuqiTeam', stateVersion: 5 })
  })

  it('does not affect a headless Host when projection capability is absent', () => {
    const ctx = new Context()
    expect(() => registerTeamSessionProjection(ctx)).not.toThrow()
  })

  it('reconciles a durable rebind when only its previous parent restores later', async () => {
    const ctx = new Context()
    const register = vi.fn()
    const oldParentId = SessionId('projection-registration-old-parent')
    const newParentId = SessionId('projection-registration-new-parent')
    const controllerId = SessionId('projection-registration-rebind-controller')
    const oldParent = Session.create(oldParentId)
    const newParent = Session.create(newParentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: oldParentId })
    controller.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    controller.append(TEAM_PARENT_BINDING_EVENT, {
      parentSessionId: String(newParentId), previousParentSessionId: String(oldParentId), generation: 1,
      operationId: 'ui-v1:registration-rebind', boundAt: '2026-08-16T00:00:00.000Z',
    })
    let oldParentAvailable = false
    ctx.provide('sessionProjections', { register } as never)
    ctx.provide('sessions', {
      list: () => [controller, newParent, ...(oldParentAvailable ? [oldParent] : [])],
      get: (id: SessionId) => id === newParentId ? newParent : id === oldParentId && oldParentAvailable ? oldParent : undefined,
      flush: async () => true,
    } as never)
    registerTeamSessionProjection(ctx)
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(newParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1))

    oldParentAvailable = true
    ctx.emit('session/created', oldParent)
    await vi.waitFor(() => expect(oldParent.events.some(event => event.type === TEAM_PARENT_DETACHED_EVENT)).toBe(true))
    await vi.waitFor(() => expect(newParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1))
  })

  it('stays null for unrelated events and folds Team facts into the Client summary', () => {
    const definition = createTeamSessionProjection()
    let state = definition.init()
    const unrelated = Session.create(SessionId('projection-unrelated'))
    unrelated.append('turn/start', { turn: 0 })
    state = definition.apply(state, unrelated.events[0]!)
    expect(definition.wire!.view(state)).toBeNull()

    const session = Session.create(SessionId('projection-team'))
    for (const item of completeTeamEvents()) session.append(TEAM_SESSION_EVENT, { event: item })
    for (const item of session.events) state = definition.apply(state, item)
    const view = definition.wire!.view(state)
    expect(view).toMatchObject({ team: { status: 'completed', completedTaskCount: 1 }, usage: { state: 'unavailable' } })
    expect(definition.wire!.viewSchema.parse(view)).toEqual(view)

    const batchSession = Session.create(SessionId('projection-team-batch'))
    batchSession.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    let batchState = definition.init()
    for (const item of batchSession.events) batchState = definition.apply(batchState, item)
    expect(definition.wire!.view(batchState)).toMatchObject({ team: { status: 'completed', completedTaskCount: 1 } })
  })

  it('validates projection fold state and contains invalid incremental transitions', () => {
    const definition = createTeamSessionProjection()
    expect(definition.stateSchema.safeParse(undefined).success).toBe(true)
    expect(definition.stateSchema.safeParse(null).success).toBe(false)
    expect(definition.stateSchema.safeParse(42).success).toBe(false)
    expect(definition.stateSchema.safeParse({ sourceEventCount: 0 }).success).toBe(true)
    expect(definition.stateSchema.safeParse({ sourceEventCount: 1, projection: {} }).success).toBe(false)

    const complete = Session.create(SessionId('projection-invalid-transition'))
    complete.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    complete.append(TEAM_SESSION_EVENT, { event: { ...completeTeamEvents()[0]!, eventId: TeamEventId('duplicate-team-created') } })
    const settled = definition.apply(definition.init(), complete.events[0]!)
    expect(definition.apply(settled, complete.events[1]!)).toBe(settled)

    const detached = Session.create(SessionId('projection-crafted-detach'))
    detached.append(TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'crafted-controller', bindingGeneration: 1 })
    const crafted = { controllerSessionId: 'crafted-controller', sourceEventCount: 0 }
    expect(definition.wire!.view(definition.apply(crafted as never, detached.events[0]!))).toBeNull()
  })

  it('bridges the controller cut to the parent and rebuilds the full UI projection after reload', async () => {
    const parentId = SessionId('projection-parent')
    const controllerId = SessionId('projection-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    const sessions = {
      get: (id: SessionId) => id === parentId ? parent : id === controllerId ? controller : undefined,
      flush: async () => true,
    }
    const journal = new HarnessSessionJournal(controller, sessions)
    await journal.commit(completeTeamEvents())
    const projectSummary = {
      schemaVersion: 1 as const, overallProgress: '已完成持久化接线', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: ['./README.md'],
      updatedAt: '2026-08-16T00:00:00.000Z',
    }
    await journal.commitProjectSummary(projectSummary)
    await new HarnessReviewJournal(controller, sessions).commit({
      reviewId: 'review-parent-bridge', trigger: 'user-request', reviewerSessionId: 'reviewer-1', decision: 'changes_required',
      findings: [{ severity: 'medium', evidence: ['tests/team-session-projection.spec.ts'], impact: '需要补充刷新验证', recommendation: '保留冷读回归' }],
      unverified: ['真实浏览器重启'],
    })

    await vi.waitFor(() => expect(parent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1))
    expect(parent.events.some(event => event.type === TEAM_SESSION_EVENT)).toBe(false)
    expect(parent.events.some(event => event.type === REVIEW_SESSION_EVENT)).toBe(false)

    const fold = (session: Session) => {
      const definition = createTeamSessionProjection()
      let state = definition.init()
      for (const event of session.events) state = definition.apply(state, event)
      return definition.wire!.view(state)
    }
    const view = fold(parent)
    expect(view).toMatchObject({
      team: { status: 'completed', completedTaskCount: 1 },
      projectSummary: { overallProgress: '已完成持久化接线' },
      review: { decision: 'changes_required', trigger: 'user-request' },
    })
    expect(view?.tasks).toHaveLength(1)

    const reloaded = Session.create(parentId, [...parent.events], parent.header)
    expect(fold(reloaded)).toEqual(view)
  })

  it('durably rebinds one controller, removes the old parent projection, and restores the new parent cut', async () => {
    const oldParentId = SessionId('projection-rebind-old')
    const newParentId = SessionId('projection-rebind-new')
    const controllerId = SessionId('projection-rebind-controller')
    const oldParent = Session.create(oldParentId)
    const newParent = Session.create(newParentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: oldParentId })
    const sessions = {
      get: (id: SessionId) => id === oldParentId ? oldParent : id === newParentId ? newParent : id === controllerId ? controller : undefined,
      flush: async () => true,
    }
    const journal = new HarnessSessionJournal(controller, sessions)
    await journal.commit(completeTeamEvents())
    await vi.waitFor(() => expect(readTeamProjectionEvents(oldParent)).toHaveLength(completeTeamEvents().length))

    const binding = await journal.rebindParent(String(newParentId), 'ui-v1:rebind-test')
    expect(binding).toMatchObject({ parentSessionId: String(newParentId), previousParentSessionId: String(oldParentId), generation: 1 })
    expect(readActiveTeamParentBinding(controller)).toEqual(binding)
    expect(oldParent.events.at(-1)?.type).toBe(TEAM_PARENT_DETACHED_EVENT)
    expect(readTeamProjectionEvents(oldParent)).toEqual([])
    expect(readTeamProjectionEvents(newParent)).toHaveLength(completeTeamEvents().length)

    const definition = createTeamSessionProjection()
    const fold = (session: Session) => session.events.reduce((state, item) => definition.apply(state, item), definition.init())
    expect(definition.wire!.view(fold(oldParent))).toBeNull()
    expect(definition.wire!.view(fold(newParent))?.team.id).toBe('team-1')
    await expect(journal.rebindParent(String(newParentId), 'ui-v1:rebind-test')).resolves.toEqual(binding)
    await expect(journal.rebindParent('projection-rebind-conflict', 'ui-v1:rebind-test')).rejects.toThrow('conflicts')
    await expect(journal.rebindParent(String(newParentId), 'ui-v1:same-target-new-operation')).resolves.toEqual(binding)
  })

  it('does not let a queued background cut revive the previous parent after an explicit rebind', async () => {
    vi.useFakeTimers()
    const oldParentId = SessionId('projection-queued-old')
    const newParentId = SessionId('projection-queued-new')
    const controllerId = SessionId('projection-queued-controller')
    const oldParent = Session.create(oldParentId), newParent = Session.create(newParentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: oldParentId })
    const sessions = {
      get: (id: SessionId) => id === oldParentId ? oldParent : id === newParentId ? newParent : undefined,
      flush: async () => true,
    }
    const journal = new HarnessSessionJournal(controller, sessions)
    await journal.commit(completeTeamEvents())
    await journal.rebindParent(String(newParentId), 'ui-v1:queued-rebind')
    await vi.runOnlyPendingTimersAsync()

    expect(readTeamProjectionEvents(oldParent)).toEqual([])
    expect(oldParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(0)
    expect(newParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)
    expect(readTeamProjectionEvents(newParent)).toHaveLength(completeTeamEvents().length)
  })

  it('validates parent-binding envelopes and ignores stale detach tombstones', () => {
    expect(parseTeamParentBindingData(null)).toBeUndefined()
    expect(parseTeamParentBindingData({ parentSessionId: 'parent', generation: 1, operationId: 'op', boundAt: 'bad' })).toBeUndefined()
    expect(parseTeamParentDetachedData({ controllerSessionId: '', bindingGeneration: 1 })).toBeUndefined()
    expect(readActiveTeamParentBinding(Session.create(SessionId('binding-none')))).toBeUndefined()

    const parent = Session.create(SessionId('binding-detach-parent'))
    const events = completeTeamEvents().slice(0, 8)
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'binding-controller', bindingGeneration: 2,
      activationGeneration: 1, bridgeRevision: 1, sourceEventCount: events.length, events,
    })
    parent.append(TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'binding-controller', bindingGeneration: 1 })
    expect(readTeamProjectionEvents(parent)).toHaveLength(events.length)
    parent.append(TEAM_PARENT_DETACHED_EVENT, { controllerSessionId: 'binding-controller', bindingGeneration: 2 })
    expect(readTeamProjectionEvents(parent)).toEqual([])

    const definition = createTeamSessionProjection()
    let state = definition.init()
    state = definition.apply(state, parent.events[0]!)
    const before = definition.wire!.view(state)
    state = definition.apply(state, parent.events[1]!)
    expect(definition.wire!.view(state)).toEqual(before)
    state = definition.apply(state, parent.events[2]!)
    expect(definition.wire!.view(state)).toBeNull()
  })

  it('binds a legacy-unparented controller without fabricating an old parent', async () => {
    const controller = Session.create(SessionId('binding-fresh-controller'))
    controller.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    const parentId = SessionId('binding-fresh-parent')
    const parent = Session.create(parentId)
    const sessions = { get: (id: SessionId) => id === parentId ? parent : undefined, flush: async () => true }
    const binding = await new HarnessSessionJournal(controller, sessions).rebindParent(String(parentId), 'ui-v1:fresh-binding')
    expect(binding.previousParentSessionId).toBeUndefined()
    expect(parent.events.some(item => item.type === TEAM_PARENT_DETACHED_EVENT)).toBe(false)
    expect(readTeamProjectionEvents(parent)).toHaveLength(completeTeamEvents().length)
  })

  it('keeps the newer controller active when an older controller publishes its first bridge late', async () => {
    const parentId = SessionId('projection-delayed-old-parent')
    const oldId = SessionId('yuqi-team-0000000001-0000-00000000-0000-4000-8000-000000000001')
    const newId = SessionId('yuqi-team-0000000002-0000-00000000-0000-4000-8000-000000000002')
    const parent = Session.create(parentId)
    const oldController = Session.create(oldId, [], { version: 0, id: oldId, createdAt: 0, parentSession: parentId })
    const newController = Session.create(newId, [], { version: 0, id: newId, createdAt: 0, parentSession: parentId })
    const oldEvents = completeTeamEvents().slice(0, 8)
    const newEvents = oldEvents.map((item, index) => ({ ...item, eventId: `delayed-new-${index}`, teamId: 'team-new' }))
    oldController.append(TEAM_SESSION_EVENT, { events: oldEvents })
    newController.append(TEAM_SESSION_EVENT, { events: newEvents as never })
    const sessions = {
      get: (id: SessionId) => id === parentId ? parent : undefined,
      flush: async () => true,
    }

    expect(await syncTeamProjectionToParent(newController, sessions)).toBe(true)
    expect(await syncTeamProjectionToParent(oldController, sessions)).toBe(true)
    const bridges = parent.events.map(event => event.data as { activationOrdinal?: string })
    expect(bridges.map(bridge => bridge.activationOrdinal)).toEqual(['0000000002-0000', '0000000001-0000'])
    expect(readTeamProjectionEvents(parent)[0]?.teamId).toBe('team-new')

    const definition = createTeamSessionProjection()
    let state = definition.init()
    for (const entry of parent.events) state = definition.apply(state, entry)
    expect(definition.wire!.view(state)?.team.id).toBe('team-new')
  })

  it('keeps the controller commit durable when parent flush fails and retries on the next source commit', async () => {
    const parentId = SessionId('projection-retry-parent')
    const controllerId = SessionId('projection-retry-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    let parentFlushes = 0
    const sessions = {
      get: (id: SessionId) => id === parentId ? parent : undefined,
      flush: async (session: Session) => session === parent ? ++parentFlushes > 1 : true,
    }
    const journal = new HarnessSessionJournal(controller, sessions)
    await expect(journal.commit(completeTeamEvents())).resolves.toBeUndefined()
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    await expect(journal.commit([completeTeamEvents()[0]!])).resolves.toBeUndefined()
    await vi.waitFor(() => expect(parent.events).toHaveLength(2))

    const definition = createTeamSessionProjection()
    let state = definition.init()
    for (const event of parent.events) state = definition.apply(state, event)
    expect(definition.wire!.view(state)).toMatchObject({ team: { status: 'completed', completedTaskCount: 1 } })
  })

  it('reflushes an identical in-memory bridge after failure without requiring another Team commit', async () => {
    const parentId = SessionId('projection-reflush-parent')
    const controllerId = SessionId('projection-reflush-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    let parentFlushes = 0
    const sessions = {
      get: (id: SessionId) => id === parentId ? parent : undefined,
      flush: async (session: Session) => session !== parent || ++parentFlushes > 1,
    }

    await expect(new HarnessSessionJournal(controller, sessions).commit(completeTeamEvents())).resolves.toBeUndefined()
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    expect(parentFlushes).toBe(1)

    await expect(syncTeamProjectionToParent(controller, sessions)).resolves.toBe(true)
    expect(parentFlushes).toBe(2)
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
  })

  it('idempotently republishes a missing bridge when controller and parent restore without a new Team commit', async () => {
    const parentId = SessionId('projection-cold-retry-parent')
    const controllerId = SessionId('projection-cold-retry-controller')
    const liveParent = Session.create(parentId)
    const liveController = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    liveController.append(TEAM_SESSION_EVENT, { events: completeTeamEvents() })
    liveParent.append(TEAM_PARENT_PROJECTION_EVENT, buildTeamProjectionBridge(liveController)!)

    const restoredParent = Session.create(parentId, [], liveParent.header)
    const restoredController = Session.create(controllerId, [...liveController.events], liveController.header)
    let flushes = 0
    const restoredSessions = {
      get: (id: SessionId) => id === parentId ? restoredParent : id === controllerId ? restoredController : undefined,
      flush: async () => { flushes += 1; return true },
    }

    await expect(syncTeamProjectionToParent(restoredController, restoredSessions)).resolves.toBe(true)
    await expect(syncTeamProjectionToParent(restoredController, restoredSessions)).resolves.toBe(true)
    expect(restoredParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)
    expect(flushes).toBe(2)
    expect(readTeamProjectionEvents(restoredParent)).toHaveLength(completeTeamEvents().length)
  })

  it('resumes a half-finished rebind from its durable controller binding', async () => {
    const oldParentId = SessionId('projection-rebind-retry-old')
    const newParentId = SessionId('projection-rebind-retry-new')
    const controllerId = SessionId('projection-rebind-retry-controller')
    const oldParent = Session.create(oldParentId)
    const newParent = Session.create(newParentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: oldParentId })
    let oldParentAvailable = true
    let oldParentDetachFlushes = 0
    const sessions = {
      get: (id: SessionId) => id === oldParentId
        ? oldParentAvailable ? oldParent : undefined
        : id === newParentId ? newParent : id === controllerId ? controller : undefined,
      flush: async (session: Session) => session !== oldParent
        || session.events.at(-1)?.type !== TEAM_PARENT_DETACHED_EVENT
        || ++oldParentDetachFlushes > 1,
    }
    const journal = new HarnessSessionJournal(controller, sessions)
    await journal.commit(completeTeamEvents())

    const binding = await journal.rebindParent(String(newParentId), 'ui-v1:retry-rebind')
    expect(readActiveTeamParentBinding(controller)).toEqual(binding)
    expect(oldParent.events.filter(event => event.type === TEAM_PARENT_DETACHED_EVENT)).toHaveLength(1)
    expect(newParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)

    oldParentAvailable = false
    await expect(journal.rebindParent(String(newParentId), 'ui-v1:retry-rebind')).resolves.toEqual(binding)
    expect(newParent.events.filter(event => event.type === TEAM_PARENT_PROJECTION_EVENT)).toHaveLength(1)

    oldParentAvailable = true
    await expect(journal.rebindParent(String(newParentId), 'ui-v1:retry-rebind')).resolves.toEqual(binding)
    expect(oldParentDetachFlushes).toBe(2)
    expect(oldParent.events.filter(event => event.type === TEAM_PARENT_DETACHED_EVENT)).toHaveLength(1)
    expect(readTeamProjectionEvents(oldParent)).toEqual([])
    expect(readTeamProjectionEvents(newParent)).toHaveLength(completeTeamEvents().length)
  })

  it('handles direct summary/review index events and rejects stale or malformed bridge cuts', () => {
    const definition = createTeamSessionProjection()
    const session = Session.create(SessionId('projection-direct-index'))
    const projectSummary = {
      schemaVersion: 1 as const, overallProgress: '直接索引', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [],
      updatedAt: '2026-08-16T00:00:00.000Z',
    }
    const review = {
      reviewId: 'review-direct', trigger: 'user-request' as const, reviewerSessionId: 'reviewer-direct', decision: 'pass' as const,
      findings: [], unverified: [],
    }
    session.append(PROJECT_SUMMARY_SESSION_EVENT, { summary: projectSummary })
    session.append(REVIEW_SESSION_EVENT, { result: review })
    session.append(TEAM_SESSION_EVENT, { events: [] })
    for (const event of completeTeamEvents()) session.append(TEAM_SESSION_EVENT, { event })
    let state = definition.init()
    for (const event of session.events) state = definition.apply(state, event)
    expect(definition.wire!.view(state)).toMatchObject({ projectSummary: { overallProgress: '直接索引' }, review: { decision: 'pass' } })
    expect(readLatestProjectSummary(session)).toEqual(projectSummary)
    expect(readLatestReviewResult(session)).toEqual(review)
    const invalidIndex = Session.create(SessionId('projection-invalid-index'))
    invalidIndex.append(PROJECT_SUMMARY_SESSION_EVENT, { summary: projectSummary })
    invalidIndex.append(PROJECT_SUMMARY_SESSION_EVENT, { summary: { ...projectSummary, overallProgress: 42 as never } })
    invalidIndex.append(REVIEW_SESSION_EVENT, { result: review })
    invalidIndex.append(REVIEW_SESSION_EVENT, { result: { ...review, decision: 'bad' as never } })
    expect(readLatestProjectSummary(invalidIndex)).toEqual(projectSummary)
    expect(readLatestReviewResult(invalidIndex)).toEqual(review)
    const reviewOnly = Session.create(SessionId('projection-review-only'))
    reviewOnly.append(REVIEW_SESSION_EVENT, { result: review })
    expect(definition.wire!.view(definition.apply(definition.init(), reviewOnly.events[0]!))).toBeNull()

    const runningEvents = completeTeamEvents().slice(0, 8)
    const bridge = (id: string, controllerSessionId: string, sourceEventCount: number, events: readonly unknown[], activationGeneration = 1, bridgeRevision = sourceEventCount) => {
      const carrier = Session.create(SessionId(id))
      carrier.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId, activationGeneration, bridgeRevision, sourceEventCount, events: events as never })
      return carrier.events[0]!
    }
    let bridged = definition.apply(definition.init(), bridge('bridge-running', 'controller-a', runningEvents.length, runningEvents))
    const duplicate = definition.apply(bridged, bridge('bridge-duplicate', 'controller-a', runningEvents.length, runningEvents))
    expect(definition.wire!.view(duplicate)).toMatchObject({ team: { status: 'running' } })
    expect(definition.apply(duplicate, bridge('bridge-old', 'controller-a', runningEvents.length - 1, runningEvents))).toBe(duplicate)
    expect(definition.apply(duplicate, bridge('bridge-invalid-count', 'controller-a', 0, runningEvents))).toBe(duplicate)
    expect(definition.apply(duplicate, bridge('bridge-invalid-id', '', runningEvents.length, runningEvents))).toBe(duplicate)
    expect(definition.apply(duplicate, bridge('bridge-invalid-events', 'controller-a', runningEvents.length, []))).toBe(duplicate)
    expect(definition.apply(duplicate, bridge('bridge-stale-controller', 'controller-b', runningEvents.length, runningEvents))).toBe(duplicate)

    const completed = definition.apply(duplicate, bridge('bridge-completed', 'controller-a', completeTeamEvents().length, completeTeamEvents()))
    expect(definition.wire!.view(completed)).toMatchObject({ team: { status: 'completed' } })
    const enrichedCarrier = Session.create(SessionId('bridge-enriched'))
    enrichedCarrier.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-enriched', sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
      projectSummary, review,
    })
    const enriched = definition.apply(definition.init(), enrichedCarrier.events[0]!)
    const directAfterBridge = Session.create(SessionId('direct-after-bridge'))
    directAfterBridge.append(TEAM_SESSION_EVENT, { event: completeTeamEvents()[0]! })
    expect(definition.wire!.view(definition.apply(enriched, directAfterBridge.events[0]!))).toMatchObject({ projectSummary, review })
    bridged = completed
    // An older controller may publish after the active Team reaches a
    // terminal state; bridge arrival order must not resurrect it in the UI.
    expect(definition.apply(bridged, bridge('bridge-terminal-controller', 'controller-c', completeTeamEvents().length, completeTeamEvents()))).toBe(bridged)
  })

  it('uses one monotonic activation selector for UI, commands, and exact identity cuts', () => {
    const parent = Session.create(SessionId('projection-generation-parent'))
    const firstEvents = completeTeamEvents().slice(0, 8)
    const secondEvents = completeTeamEvents().slice(0, 8).map((item, index) => ({
      ...item,
      eventId: `second-event-${index + 1}`,
      teamId: 'team-2',
    }))
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-first', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: firstEvents.length, events: firstEvents,
    })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-second', activationGeneration: 2, bridgeRevision: 1,
      sourceEventCount: secondEvents.length, events: secondEvents as never,
    })
    // The first Team has the same startedAt and later publishes more facts.
    // Its lower activation generation must remain inactive everywhere.
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-first', activationGeneration: 1, bridgeRevision: 2,
      sourceEventCount: completeTeamEvents().length, events: completeTeamEvents(),
    })
    // Replaying an older second-controller cut must not roll it back.
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'controller-second', activationGeneration: 2, bridgeRevision: 1,
      sourceEventCount: secondEvents.length, events: secondEvents as never,
    })

    const definition = createTeamSessionProjection()
    let state = definition.init()
    for (const entry of parent.events) state = definition.apply(state, entry)
    expect(definition.wire!.view(state)?.team.id).toBe('team-2')
    expect(readTeamProjectionEvents(parent)[0]?.teamId).toBe('team-2')
    expect(readTeamProjectionEvents(parent).map(item => item.eventId)).toEqual(secondEvents.map(item => item.eventId))
  })

  it('keeps legacy arrival generations subordinate to explicit activation ordinals', () => {
    const parent = Session.create(SessionId('projection-ordinal-legacy-parent'))
    const eventsFor = (teamId: string, prefix: string) => completeTeamEvents().slice(0, 8).map((item, index) => ({
      ...item, teamId, eventId: `${prefix}-${index}`,
    }))
    const legacy = eventsFor('team-legacy', 'legacy')
    const active = eventsFor('team-explicit', 'explicit')
    const delayedLegacy = eventsFor('team-delayed-legacy', 'delayed')
    const olderExplicit = eventsFor('team-older-explicit', 'older')
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'legacy-controller', activationGeneration: 50, bridgeRevision: 1,
      sourceEventCount: legacy.length, events: legacy as never,
    })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'explicit-controller', activationOrdinal: '0000000002-0000', activationGeneration: 1, bridgeRevision: 1,
      sourceEventCount: active.length, events: active as never,
    })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'delayed-legacy-controller', activationGeneration: 100, bridgeRevision: 1,
      sourceEventCount: delayedLegacy.length, events: delayedLegacy as never,
    })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'older-explicit-controller', activationOrdinal: '0000000001-0000', activationGeneration: 101, bridgeRevision: 1,
      sourceEventCount: olderExplicit.length, events: olderExplicit as never,
    })
    parent.append(TEAM_PARENT_PROJECTION_EVENT, {
      controllerSessionId: 'explicit-controller', activationOrdinal: '0000000002-0000', activationGeneration: 1, bridgeRevision: 2,
      sourceEventCount: active.length, events: active as never,
    })

    expect(readTeamProjectionEvents(parent)[0]?.teamId).toBe('team-explicit')
    const definition = createTeamSessionProjection()
    let state = definition.init()
    for (const entry of parent.events) state = definition.apply(state, entry)
    expect(definition.wire!.view(state)?.team.id).toBe('team-explicit')
  })

  it('uses the latest parent bridge for commands and keeps bridge sync fail-soft when the public parent is unavailable', async () => {
    const parentId = SessionId('projection-helper-parent')
    const controllerId = SessionId('projection-helper-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    const direct = Session.create(SessionId('projection-helper-direct'))
    for (const event of completeTeamEvents()) direct.append(TEAM_SESSION_EVENT, { event })
    expect(readTeamProjectionEvents(direct)).toHaveLength(completeTeamEvents().length)
    expect(buildTeamProjectionBridge(Session.create(SessionId('projection-helper-empty')))).toBeUndefined()
    await expect(syncTeamProjectionToParent(Session.create(SessionId('projection-no-parent')), { flush: async () => true })).resolves.toBe(false)
    await expect(syncTeamProjectionToParent(controller, { flush: async () => true })).resolves.toBe(false)
    await expect(syncTeamProjectionToParent(controller, { get: () => undefined, flush: async () => true })).resolves.toBe(false)
    const emptyController = Session.create(SessionId('projection-helper-empty-controller'), [], { version: 0, id: SessionId('projection-helper-empty-controller'), createdAt: 0, parentSession: parentId })
    await expect(syncTeamProjectionToParent(emptyController, { get: () => parent, flush: async () => true })).resolves.toBe(false)
    const throwing = {
      get: () => parent,
      flush: async (session: Session) => { if (session === parent) throw new Error('parent unavailable'); return true },
    }
    const journal = new HarnessSessionJournal(controller, throwing)
    await journal.commit(completeTeamEvents())
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    expect(readTeamProjectionEvents(parent)).toHaveLength(completeTeamEvents().length)
    const summary = {
      schemaVersion: 1 as const, overallProgress: '失败刷盘', architectureDecisions: [], pitfalls: [], conventions: [], documentLinks: [],
      updatedAt: '2026-08-16T00:00:00.000Z',
    }
    const noSummaryDurability = new HarnessSessionJournal(controller, { flush: async () => false })
    await expect(noSummaryDurability.commitProjectSummary(summary)).rejects.toThrow('project summary journal')
  })

  it('does not append the same parent bridge twice after a durable source commit', async () => {
    const parentId = SessionId('projection-dedup-parent')
    const controllerId = SessionId('projection-dedup-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    const sessions = { get: (id: SessionId) => id === parentId ? parent : undefined, flush: async () => true }
    await new HarnessSessionJournal(controller, sessions).commit(completeTeamEvents())
    await vi.waitFor(() => expect(parent.events).toHaveLength(1))
    const before = parent.events.length

    await expect(syncTeamProjectionToParent(controller, sessions)).resolves.toBe(true)
    expect(parent.events).toHaveLength(before)
  })

  it('isolates malformed persistent envelopes and Team facts without rejecting bridge synchronization', async () => {
    const parentId = SessionId('projection-corrupt-parent')
    const controllerId = SessionId('projection-corrupt-controller')
    const parent = Session.create(parentId)
    const controller = Session.create(controllerId, [], { version: 0, id: controllerId, createdAt: 0, parentSession: parentId })
    controller.append(TEAM_SESSION_EVENT, { event: completeTeamEvents()[0]! })
    controller.append(TEAM_SESSION_EVENT, null as never)

    expect(() => readTeamEventsFromSession(controller)).not.toThrow()
    expect(readTeamEventsFromSession(controller)).toEqual([])
    expect(buildTeamProjectionBridge(controller)).toBeUndefined()
    await expect(syncTeamProjectionToParent(controller, {
      get: id => id === parentId ? parent : undefined,
      flush: async () => true,
    })).resolves.toBe(false)
    expect(parent.events).toEqual([])

    const invalidFact = Session.create(SessionId('projection-corrupt-fact'))
    invalidFact.append(TEAM_SESSION_EVENT, { event: { ...completeTeamEvents()[0]!, teamId: '' } as never })
    expect(readTeamEventsFromSession(invalidFact)).toEqual([])
    const invalidSequence = Session.create(SessionId('projection-corrupt-sequence'))
    invalidSequence.append(TEAM_SESSION_EVENT, { event: completeTeamEvents()[1]! })
    expect(readTeamEventsFromSession(invalidSequence)).toEqual([])

    const definition = createTeamSessionProjection()
    const valid = Session.create(SessionId('projection-before-corruption'))
    valid.append(TEAM_SESSION_EVENT, { events: completeTeamEvents().slice(0, 8) })
    const before = definition.apply(definition.init(), valid.events[0]!)
    expect(definition.apply(before, controller.events[1]!)).toStrictEqual(before)

    const corruptBridge = Session.create(SessionId('projection-corrupt-bridge'))
    corruptBridge.append(TEAM_PARENT_PROJECTION_EVENT, null as never)
    expect(readTeamProjectionEvents(corruptBridge)).toEqual([])
    expect(definition.apply(before, corruptBridge.events[0]!)).toBe(before)

    const corruptIndexes = Session.create(SessionId('projection-corrupt-indexes'))
    corruptIndexes.append(PROJECT_SUMMARY_SESSION_EVENT, null as never)
    corruptIndexes.append(REVIEW_SESSION_EVENT, null as never)
    expect(readLatestProjectSummary(corruptIndexes)).toBeUndefined()
    expect(readLatestReviewResult(corruptIndexes)).toBeUndefined()
    expect(() => corruptIndexes.events.reduce((state, item) => definition.apply(state, item), definition.init())).not.toThrow()
  })
})
