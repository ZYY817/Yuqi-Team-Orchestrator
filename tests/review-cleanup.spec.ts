import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessReviewAgent, REVIEW_STOP_TIMEOUT_MS } from '../src/host/harness/review-agent.ts'
import type { TeamWorkspace } from '../src/domain/workspace.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { completeTeamEvents } from './fixtures.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const roots: string[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  // Only empty directories created by this fixture; never recurse into a workspace.
  for (const root of roots.splice(0)) await rmdir(root)
})

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'yuqi-review-cleanup-'))
  roots.push(cwd)
  const ctx = new Context()
  const parentId = SessionId('cleanup-parent')
  const childId = SessionId('cleanup-child')
  const parentSession = Session.create(parentId, [], { version: 0, id: parentId, createdAt: 0, cwd })
  const childSession = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd, parentSession: parentId })
  childSession.append('assistant/message', { turn: 0, step: 0,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '{"decision":"pass","findings":[],"unverified":[]}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  const controller = { id: parentId, session: parentSession, ctx, options: { provider: 'mock' } } as unknown as Agent
  const idle = deferred<void>()
  const admission = deferred<void>()
  const started = deferred<void>()
  const cancel = vi.fn()
  const whenIdle = vi.fn(() => idle.promise)
  const child = { id: childId, session: childSession, cancel, whenIdle } as unknown as Agent
  const siblingCancel = vi.fn()
  const sibling = { id: SessionId('sibling'), session: { header: { parentSession: parentId } }, cancel: siblingCancel } as unknown as Agent
  const agents = new Map<string, Agent>([[parentId, controller], [childId, child], [sibling.id, sibling]])
  const sessions = new Map<string, Session>([[parentId, parentSession], [childId, childSession]])
  const subagents = {
    startContinuable: vi.fn(async () => { started.resolve(); await admission.promise; return { childId, messageId: 'review-message' } }),
    interrupt: vi.fn(),
  }
  const persistence = { load: vi.fn(async () => ({ meta: childSession.header, events: childSession.events })) }
  ctx.provide('subagents', subagents as never)
  ctx.provide('sessions', { get: (id: SessionId) => sessions.get(id), flush: async () => true } as never)
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: cwd }) } as never)
  const workspace: TeamWorkspace = { workspaceId: 'cleanup-workspace' as TeamWorkspace['workspaceId'],
    project: { projectRoot: cwd, repositoryRoot: cwd, gitCommonDirectory: cwd, baselineRef: 'baseline', volumeRoot: cwd, protectedRoots: [] },
    worktreePath: cwd, branchName: 'yuqi/review', status: 'ready' }
  const stopped = vi.fn()
  const reviewer = new HarnessReviewAgent(ctx, { verify: async () => workspace } as never,
    { resolveModel: async (modelProvider, modelId) => ({ modelProvider, modelId, available: true }), listModels: async () => [] },
    id => agents.get(id), stopped)
  const abort = new AbortController()
  const request = { reviewId: 'cleanup-review', teamId: 'team-1', trigger: 'user-request' as const,
    projection: replayTeamEvents(completeTeamEvents()), controller, workspace, signal: abort.signal,
    modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'mock', role: 'verifier' as const } } }
  const end = () => (ctx.emit as unknown as (target: object, name: string, info: object) => void)(scopeTarget(subagents, controller), 'subagent/end', {
    id: childId, runId: SubagentRunId('cleanup-run'), provider: 'spawn', local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: '{"decision":"pass","findings":[],"unverified":[]}' }],
  })
  return { reviewer, request, abort, admission, started, idle, cancel, whenIdle, siblingCancel, subagents,
    controller, childId, sessions, persistence, childSession, stopped, end }
}

describe('independent reviewer cleanup boundaries', () => {
  it('at 120 seconds cancels only the reviewer and retains admission gate until whenIdle proves quiescence', async () => {
    const f = await fixture()
    f.admission.resolve()
    const result = f.reviewer.run(f.request)
    let completed = false
    void result.then(() => { completed = true }, () => { completed = true })
    await f.started.promise
    await vi.advanceTimersByTimeAsync(119_999)
    expect(f.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' })
    expect(f.subagents.interrupt).toHaveBeenCalledExactlyOnceWith(f.childId, { kind: 'ancestor', agent: f.controller })
    expect(f.whenIdle).toHaveBeenCalledOnce()
    expect(f.siblingCancel).not.toHaveBeenCalled()
    expect(completed).toBe(false)
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).toThrow()
    f.idle.resolve()
    await expect(result).resolves.toMatchObject({ decision: 'inconclusive' })
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).not.toThrow()
    expect(f.stopped).toHaveBeenCalledExactlyOnceWith(String(f.controller.id), f.request.reviewId)
  })

  it('cleans a late child even after pending admission abort exceeded the bounded stop deadline', async () => {
    const f = await fixture()
    const result = f.reviewer.run(f.request).catch(error => error)
    await f.started.promise
    f.abort.abort(new Error('caller abort during admission'))
    await vi.advanceTimersByTimeAsync(REVIEW_STOP_TIMEOUT_MS + 1)
    expect(await result).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(f.cancel).not.toHaveBeenCalled()
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).toThrow()
    f.admission.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.whenIdle).toHaveBeenCalledOnce()
    f.idle.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).not.toThrow()
    expect(f.reviewer.settledChildId(String(f.controller.id), f.request.reviewId)).toBe(f.childId)
    expect(f.siblingCancel).not.toHaveBeenCalled()
  })

  it('retains the gate on native child.cancel failure and releases only after a successful retry and idle', async () => {
    const f = await fixture()
    f.admission.resolve()
    f.cancel.mockImplementation(() => { throw new Error('child inbox cancellation failed') })
    const result = f.reviewer.run(f.request).catch(error => error)
    await f.started.promise
    await vi.advanceTimersByTimeAsync(0)
    f.abort.abort(new Error('stop now'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await result).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).toThrow()
    expect(f.whenIdle).not.toHaveBeenCalled()
    f.cancel.mockImplementation(() => undefined)
    const retry = f.reviewer.cancelForController(String(f.controller.id))
    await vi.advanceTimersByTimeAsync(0)
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).toThrow()
    expect(f.whenIdle).toHaveBeenCalledOnce()
    f.idle.resolve()
    await retry
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).not.toThrow()
    expect(f.cancel).toHaveBeenCalledTimes(2)
  })

  it('natural completion delivers pass without extra cancel or a later 30-minute interrupt', async () => {
    const f = await fixture()
    f.admission.resolve()
    const result = f.reviewer.run(f.request)
    await f.started.promise
    await vi.advanceTimersByTimeAsync(0)
    f.end()
    await expect(result).resolves.toMatchObject({ decision: 'pass' })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.whenIdle).not.toHaveBeenCalled()
    expect(f.subagents.interrupt).not.toHaveBeenCalled()
    expect(() => f.reviewer.assertNoUnsettled(String(f.controller.id))).not.toThrow()
  })

  it('cannot publish a pass read from persistence after caller cancellation', async () => {
    const f = await fixture()
    const output = deferred<Awaited<ReturnType<typeof f.persistence.load>>>()
    const reading = deferred<void>()
    f.persistence.load.mockImplementation(() => { reading.resolve(); return output.promise })
    f.admission.resolve()
    const reason = new Error('abort during output read')
    const result = f.reviewer.run(f.request).catch(error => error)
    await f.started.promise
    await vi.advanceTimersByTimeAsync(0)
    f.sessions.delete(f.childId)
    f.end()
    await reading.promise
    f.abort.abort(reason)
    output.resolve({ meta: f.childSession.header, events: f.childSession.events })
    expect(await result).toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.reviewer.hasSettled(String(f.controller.id), f.request.reviewId)).toBe(true)
    expect(f.stopped).toHaveBeenCalledOnce()
  })
})
