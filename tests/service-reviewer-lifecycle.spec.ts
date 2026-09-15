import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { HarnessModelCatalogPort } from '../src/host/harness/model-catalog.ts'
import { readTeamEventsFromSession, TEAM_SESSION_EVENT } from '../src/host/harness/session-journal.ts'
import { completeTeamEvents, event } from './fixtures.ts'
import { replayTeamEvents, WorkspaceId, type TeamEvent } from '../src/index.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function initialEvents(): readonly TeamEvent[] {
  const workspaceId = WorkspaceId('review-lifecycle-workspace')
  return [
    event(1, { type: 'yuqi/team-created', title: 'Review lifecycle', objective: 'No model execution', reviewPolicy: { mode: 'manual', maxReworkRounds: 0, additionalPrompt: '' } }),
    ...completeTeamEvents().slice(1, 2),
    event(201, { type: 'yuqi/workspace-provisioning-started', workspace: {
      workspaceId, project: { mode: 'direct', projectRoot: process.cwd(), volumeRoot: path.parse(process.cwd()).root, protectedRoots: [] },
      worktreePath: process.cwd(), branchName: 'direct', status: 'provisioning',
    } as never }),
    event(202, { type: 'yuqi/workspace-provisioned', workspaceId }),
    ...completeTeamEvents().slice(2, -1),
  ]
}

function harness(events: readonly TeamEvent[] = initialEvents(), lateAdmission = false, mount = false) {
  const ctx = new Context()
  const id = SessionId(`service-review-${Math.random()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd() })
  for (const item of events) session.append(TEAM_SESSION_EVENT, { event: item })
  const controller = { id, session, options: { provider: 'mock' }, ctx } as unknown as Agent
  const idle = deferred<void>()
  const admission = deferred<void>()
  const childId = SessionId(`review-child-${Math.random()}`)
  const childSession = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd: process.cwd(), parentSession: id })
  const child = { id: childId, session: childSession, cancel: vi.fn(), whenIdle: () => idle.promise } as unknown as Agent
  const agents = new Map([[String(id), controller], [String(childId), child]])
  const sessions = new Map([[String(id), session], [String(childId), childSession]])
  const subagents = {
    startContinuable: vi.fn(async () => {
      if (lateAdmission) await admission.promise
      return { childId, messageId: 'review-message' }
    }),
    interrupt: vi.fn(), listChildren: vi.fn(async () => []),
  }
  const flush = vi.fn(async () => true)
  ctx.provide('sessions', { get: (id: SessionId) => sessions.get(String(id)), flush } as never)
  ctx.provide('sessionPersistence', { load: async (id: SessionId) => {
    const stored = sessions.get(String(id))
    return stored === undefined ? undefined : { meta: stored.header, events: stored.events }
  } } as never)
  ctx.provide('subagents', subagents as never)
  ctx.provide('agents', { get: (id: SessionId) => agents.get(String(id)) } as never)
  ctx.provide('agentPresets', {} as never)
  ctx.provide('llm', {
    listModels: async (provider: string) => [{ provider, id: 'deepseek-v4', name: 'fixture' }],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model, name: 'fixture' }),
  } as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } as never)
  const fiber = mount ? ctx.plugin(YuqiTeamOrchestratorService) : undefined
  const service = mount ? undefined : new YuqiTeamOrchestratorService(ctx)
  const facts = () => readTeamEventsFromSession(session)
  const projection = () => replayTeamEvents(facts())
  const review = (reviewId = 'review-one') => ({ controller, teamId: 'team-1', trigger: 'user-request' as const, reviewId })
  const cancel = { controller, teamId: 'team-1', operationId: 'cancel-review' }
  return { get service() { return service ?? ctx.yuqiTeamOrchestrator }, controller, child, subagents, idle, admission, facts, projection, review, cancel,
    flush, ready: async () => { await fiber }, dispose: async () => { await fiber?.dispose() } }
}

describe('QA-R01 service reviewer admission and terminal gates', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it.each(['cancelTeam', 'abortTeam'] as const)('%s waits for manual reviewer idle and durably closes inconclusive before terminal', async method => {
    vi.useFakeTimers()
    const h = harness()
    const review = h.service.reviewTeam(h.review()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    const cancel = h.service[method](h.cancel)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.projection().team.status).not.toBe('cancelled')
    await expect(h.service.reviewTeam(h.review('duplicate'))).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(h.child.cancel).toHaveBeenCalledOnce()
    h.idle.resolve()
    await expect(cancel).resolves.toMatchObject({ team: { status: 'cancelled' } })
    expect(await review).toBeInstanceOf(Error)
    expect(h.projection().reviews['review-one']?.result?.decision).toBe('inconclusive')
    const reopened = harness(h.facts())
    await expect(reopened.service.cancelTeam(reopened.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
  })

  it('cancel failure blocks terminal, new review, decisions and completion; successful retry closes durably', async () => {
    vi.useFakeTimers()
    const h = harness()
    const review = h.service.reviewTeam(h.review()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    h.subagents.interrupt.mockImplementation(() => { throw new Error('cannot stop reviewer') })
    await expect(h.service.cancelTeam(h.cancel)).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await review
    expect(h.projection().team.status).not.toBe('cancelled')
    expect(h.projection().reviews['review-one']?.result).toBeUndefined()
    await expect(h.service.reviewTeam(h.review('different-review'))).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await expect(h.service.decideReview({ ...h.cancel, reviewId: 'review-one', candidateEventId: 'irrelevant', round: 0, decision: 'waive', reason: 'test' })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await expect(h.service.coordinateCompletion({ ...h.cancel, journal: { key: String(h.controller.id), read: h.facts, commit: async () => {} }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    h.subagents.interrupt.mockReset()
    h.idle.resolve()
    await expect(h.service.cancelTeam(h.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
    expect(h.projection().reviews['review-one']?.result?.decision).toBe('inconclusive')
  })

  it('late admission cleanup persists closure after the failed caller, allowing fresh-service cancellation', async () => {
    vi.useFakeTimers()
    const h = harness(undefined, true)
    const review = h.service.reviewTeam(h.review()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    const cancel = h.service.cancelTeam(h.cancel).catch(error => error)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await cancel).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await review
    h.admission.resolve()
    h.idle.resolve()
    await vi.waitFor(() => expect(h.projection().reviews['review-one']?.result?.decision).toBe('inconclusive'), { timeout: 10_000 })
    const reopened = harness(h.facts())
    await expect(reopened.service.cancelTeam(reopened.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
    expect(h.subagents.startContinuable).toHaveBeenCalledOnce()
  })

  it('persists preparation failure as inconclusive so restart does not permanently lock cancellation', async () => {
    const h = harness()
    vi.spyOn(HarnessModelCatalogPort.prototype, 'inspectAutomaticRoutes').mockRejectedValueOnce(new Error('catalog preparation failed'))
    await expect(h.service.reviewTeam(h.review())).rejects.toThrow('catalog preparation failed')
    expect(h.subagents.startContinuable).not.toHaveBeenCalled()
    expect(h.projection().reviews['review-one']?.result?.decision).toBe('inconclusive')
    expect(h.projection().reviews['review-one']?.result?.unverified[0]).toContain('此记录不代表审查通过')
    const reopened = harness(h.facts())
    await expect(reopened.service.cancelTeam(reopened.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
  })

  it.each(['zh', 'en'] as const)('persists independent-review preparation failure as inconclusive, not pass (%s)', async locale => {
    const base = initialEvents()
    const h = harness([event(1, { type: 'yuqi/team-created', title: 'Independent review', objective: 'Fail safely', locale,
      reviewPolicy: { mode: 'manual', maxReworkRounds: 0, additionalPrompt: '' } }), ...base.slice(1)])
    vi.spyOn(HarnessModelCatalogPort.prototype, 'inspectAutomaticRoutes').mockRejectedValueOnce(new Error('independent route unavailable'))
    await expect(h.service.reviewTeam({ ...h.review(), independentReviewerRequired: true })).rejects.toThrow('independent route unavailable')
    const review = h.projection().reviews['review-one']!
    expect(review.independentReviewerRequired).toBe(true)
    expect(review.result).toMatchObject({ decision: 'inconclusive', reviewerSessionId: 'not-admitted:review-one', findings: [] })
    expect(review.result?.unverified[0]).toContain(locale === 'en' ? 'not a review pass' : '不代表审查通过')
    expect(review.phase).toBe('awaiting-controller')
    const reopened = harness(h.facts())
    await expect(reopened.service.cancelTeam(reopened.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
  })

  it('cold unresolved requested review has no fabricated stop proof and cannot be retried with a new id', async () => {
    const events = initialEvents()
    const candidateEventId = replayTeamEvents(events).completionCandidateEventId!
    const h = harness([...events, event(203, { type: 'yuqi/review-requested', reviewId: 'cold-review', trigger: 'user-request', candidateEventId, round: 0 })])
    await expect(h.service.reviewTeam(h.review('new-review'))).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await expect(h.service.cancelTeam(h.cancel)).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(h.subagents.startContinuable).not.toHaveBeenCalled()
    expect(h.projection().reviews['cold-review']?.result).toBeUndefined()
    expect(h.projection().team.status).not.toBe('cancelled')
  })

  it('public plugin disposal waits for durable close, not just reviewer idle', async () => {
    vi.useFakeTimers()
    const h = harness(undefined, false, true)
    await h.ready()
    const review = h.service.reviewTeam(h.review()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    const durable = deferred<boolean>()
    h.flush.mockImplementation(() => durable.promise)
    let disposed = false
    const disposal = h.dispose().then(() => { disposed = true })
    h.idle.resolve()
    await vi.advanceTimersByTimeAsync(50)
    expect(h.child.cancel).toHaveBeenCalled()
    expect(disposed).toBe(false)
    durable.resolve(true)
    await disposal
    await review
    expect(h.projection().reviews['review-one']?.result?.decision).toBe('inconclusive')
    const reopened = harness(h.facts())
    await expect(reopened.service.cancelTeam(reopened.cancel)).resolves.toMatchObject({ team: { status: 'cancelled' } })
  })
})
