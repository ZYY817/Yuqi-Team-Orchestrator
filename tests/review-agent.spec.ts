import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessReviewAgent } from '../src/host/harness/review-agent.ts'
import { replayTeamEvents } from '../src/index.ts'
import { completeTeamEvents } from './fixtures.ts'
import type { TeamProjection } from '../src/domain/projection.ts'
import type { TeamWorkspace } from '../src/domain/workspace.ts'

function setup(output: string, persistedOnly = false) {
  const cwd = process.cwd()
  const controllerId = SessionId(`review-controller-${Math.random()}`)
  const controllerSession = Session.create(controllerId, [], {
    version: 0, id: controllerId, createdAt: 0, cwd,
  })
  const sessions = new Map<string, Session>([[String(controllerSession.id), controllerSession]])
  const persisted = new Map<string, Session>()
  const context = new Context()
  const agents = new Map<string, Agent>()
  const subagents = {
    interrupt: vi.fn(),
    listChildren: vi.fn(async () => []),
    async startContinuable() {
      const childId = SessionId(`review-child-${Math.random()}`)
      const child = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd })
      child.append('assistant/message', {
        turn: 0,
        step: 0,
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: output }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      persisted.set(String(childId), child)
      if (!persistedOnly) sessions.set(String(childId), child)
      queueMicrotask(() => {
        const emit = context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(subagents, controller), 'subagent/end', {
          runId: SubagentRunId('review-run'), provider: 'mock', id: childId, local: true,
          stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: output }],
        })
      })
      return { childId, messageId: 'review-message' }
    },
  }
  context.provide('subagents', subagents as never)
  context.provide('agents', { get: (id: SessionId) => agents.get(String(id)) } as never)
  context.provide('sessions', {
    get(id: SessionId) { return sessions.get(String(id)) },
    flush: async () => true,
  } as never)
  context.provide('sessionPersistence', { load: async (id: SessionId) => {
    const session = persisted.get(String(id)) ?? sessions.get(String(id))
    if (session === undefined) throw new Error('missing session')
    return { meta: session.header, events: session.events }
  } } as never)
  context.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: cwd }) } as never)
  const controller = { id: controllerSession.id, session: controllerSession, options: { provider: 'mock' }, ctx: context } as unknown as Agent
  agents.set(String(controller.id), controller)
  const workspace: TeamWorkspace = {
    workspaceId: 'workspace-review' as TeamWorkspace['workspaceId'],
    project: { projectRoot: cwd, repositoryRoot: cwd, gitCommonDirectory: cwd, baselineRef: 'baseline', volumeRoot: cwd, protectedRoots: [] },
    worktreePath: cwd,
    branchName: 'yuqi/review',
    status: 'ready',
  }
  const projection = { ...replayTeamEvents(completeTeamEvents()), workspace } as TeamProjection
  const agent = new HarnessReviewAgent(
    context,
    { async verify() { return workspace } } as never,
    { async resolveModel(modelProvider: string, modelId: string) { return { modelProvider, modelId, available: true } }, async listModels() { return [] } },
  )
  return { agent, controller, projection, workspace, context, subagents, sessions, agents }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function controlledReview(lateAdmission = false) {
  const harness = setup('{"decision":"pass","findings":[],"unverified":[]}')
  const id = SessionId('controlled-review-child')
  const idle = deferred<void>()
  const admission = deferred<void>()
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd: process.cwd(), parentSession: harness.controller.id })
  session.append('assistant/message', { turn: 0, step: 0,
    message: createMessage({ role: 'assistant', content: [{ type: 'text', text: '{"decision":"pass","findings":[],"unverified":[]}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  const child = { id, session, cancel: vi.fn(), whenIdle: vi.fn(() => idle.promise) } as unknown as Agent
  harness.agents.set(String(id), child)
  harness.sessions.set(String(id), session)
  harness.subagents.startContinuable = vi.fn(async () => {
    if (lateAdmission) await admission.promise
    return { childId: id, messageId: 'controlled-message' }
  })
  const end = (stopReason = 'completed', childId = id) => {
    const emit = harness.context.emit as unknown as (target: object, name: string, payload: object) => void
    emit(scopeTarget(harness.subagents, harness.controller), 'subagent/end', {
      runId: SubagentRunId('controlled-review-run'), provider: 'mock', id: childId, local: true, stopReason,
      lastAssistantMessage: [{ type: 'text', text: 'result' }],
    })
  }
  const request = (signal?: AbortSignal, reviewId = 'controlled-review') => ({
    reviewId, teamId: String(harness.projection.team.id), trigger: 'user-request' as const,
    projection: harness.projection, controller: harness.controller, workspace: harness.workspace,
    ...(signal === undefined ? {} : { signal }),
    modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' as const } },
  })
  return { ...harness, id, child, idle, admission, end, request }
}

describe('QA-R01 exact reviewer lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('times out, cancels only the exact child, and waits for idle before returning inconclusive', async () => {
    vi.useFakeTimers()
    const h = controlledReview()
    const outcome = h.agent.run(h.request())
    let done = false
    void outcome.then(() => { done = true })
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.subagents.interrupt).toHaveBeenCalledWith(h.id, { kind: 'ancestor', agent: h.controller })
    expect(h.child.cancel).toHaveBeenCalledOnce()
    expect(done).toBe(false)
    await expect(h.agent.run(h.request(undefined, 'second-review'))).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    h.idle.resolve()
    await expect(outcome).resolves.toMatchObject({ decision: 'inconclusive' })
    expect(() => h.agent.assertNoUnsettled(String(h.controller.id))).not.toThrow()
  })

  it('handles real external abort during late admission without leaking or accepting the late pass', async () => {
    vi.useFakeTimers()
    const h = controlledReview(true)
    const abort = new AbortController()
    const reason = new Error('external stop')
    const outcome = h.agent.run(h.request(abort.signal)).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    abort.abort(reason)
    await vi.advanceTimersByTimeAsync(10)
    expect(h.subagents.interrupt).not.toHaveBeenCalled()
    await expect(h.agent.run(h.request(undefined, 'new-id'))).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    h.admission.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.child.cancel).toHaveBeenCalledOnce()
    h.end()
    h.idle.resolve()
    expect(await outcome).toBe(reason)
  })

  it('keeps uncertain ownership on cancel failure; explicit retry can release it after proof', async () => {
    vi.useFakeTimers()
    const h = controlledReview()
    const outcome = h.agent.run(h.request()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    h.subagents.interrupt.mockImplementation(() => { throw new Error('interrupt denied') })
    await expect(h.agent.cancelForController(String(h.controller.id))).rejects.toThrow('interrupt denied')
    expect(await outcome).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await expect(h.agent.run(h.request())).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    h.subagents.interrupt.mockReset()
    h.idle.resolve()
    await h.agent.cancelForController(String(h.controller.id))
    expect(() => h.agent.assertNoUnsettled(String(h.controller.id))).not.toThrow()
  })

  it('does not treat cancel acknowledgement or an unrelated end as stop proof', async () => {
    vi.useFakeTimers()
    const h = controlledReview()
    const outcome = h.agent.run(h.request()).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    const cancelled = h.agent.cancelForController(String(h.controller.id)).catch(error => error)
    h.end('completed', SessionId('other-child'))
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await cancelled).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(await outcome).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(() => h.agent.assertNoUnsettled(String(h.controller.id))).toThrow()
    h.idle.resolve()
    await h.agent.cancelForController(String(h.controller.id))
  })

  it('cleans admission arriving after the caller has received an uncertain failure', async () => {
    vi.useFakeTimers()
    const h = controlledReview(true)
    const abort = new AbortController()
    const outcome = h.agent.run(h.request(abort.signal)).catch(error => error)
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    abort.abort()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await outcome).toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    h.admission.resolve()
    h.idle.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.child.cancel).toHaveBeenCalledOnce()
    expect(() => h.agent.assertNoUnsettled(String(h.controller.id))).not.toThrow()
  })

  it('accepts normal completion without cancelling and rejects a concurrent same review', async () => {
    const h = controlledReview()
    const outcome = h.agent.run(h.request())
    await expect(h.agent.run(h.request())).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    await vi.waitFor(() => expect(h.subagents.startContinuable).toHaveBeenCalledOnce(), { timeout: 10_000 })
    h.end()
    await expect(outcome).resolves.toMatchObject({ decision: 'pass' })
    expect(h.subagents.interrupt).not.toHaveBeenCalled()
    expect(h.child.cancel).not.toHaveBeenCalled()
  })
})

describe('Harness reviewer child', () => {
  it('keeps a safe admission failure reason in an inconclusive result', async () => {
    const harness = setup('{}')
    harness.subagents.startContinuable = async () => { throw new Error('review admission unavailable') }
    await expect(harness.agent.run({
      reviewId: 'review-admission-failure', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ decision: 'inconclusive', unverified: [expect.stringContaining('review admission unavailable')] })

    const nonError = setup('{}')
    nonError.subagents.startContinuable = async () => { throw 'opaque admission failure' }
    await expect(nonError.agent.run({
      reviewId: 'review-non-error-failure', teamId: String(nonError.projection.team.id), trigger: 'user-request', projection: nonError.projection,
      controller: nonError.controller, workspace: nonError.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ decision: 'inconclusive', unverified: [expect.stringContaining('unknown error')] })
  })

  it('uses English for Host-authored reviewer failure text on an English Team', async () => {
    const harness = setup('{}')
    harness.subagents.startContinuable = async () => { throw new Error('review admission unavailable') }
    const projection = { ...harness.projection, team: { ...harness.projection.team, locale: 'en' as const } }
    await expect(harness.agent.run({
      reviewId: 'review-english-failure', teamId: String(projection.team.id), trigger: 'user-request', projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({
      decision: 'inconclusive',
      unverified: [expect.stringContaining('Reviewer dispatch, recovery, or output reading failed')],
    })
  })

  it('localizes the structured-output parse failure for an English Team', async () => {
    const harness = setup('not json')
    const projection = { ...harness.projection, team: { ...harness.projection.team, locale: 'en' as const } }
    await expect(harness.agent.run({
      reviewId: 'review-english-parse', teamId: String(projection.team.id), trigger: 'user-request', projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({
      decision: 'inconclusive',
      unverified: ['The reviewer output could not be parsed under the structured contract and cannot be treated as a pass.'],
    })
  })

  it('rejects a reviewer whose durable workspace is not ready', async () => {
    const harness = setup('{}')
    await expect(harness.agent.run({
      reviewId: 'review-not-ready', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: { ...harness.workspace, status: 'provisioning' },
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })

  it('dispatches a read-only direct child and fails closed when pass still reports unverified work', async () => {
    const harness = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: ['未运行完整发布演练'] }))
    const result = await harness.agent.run({
      reviewId: 'review-pass', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })
    expect(result).toMatchObject({ reviewId: 'review-pass', decision: 'inconclusive' })
  })

  it('turns a non-JSON child result into inconclusive instead of pass', async () => {
    const harness = setup('looks good')
    const result = await harness.agent.run({
      reviewId: 'review-invalid', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })
    expect(result.decision).toBe('inconclusive')
  })

  it('can recover the reviewer output from public Session persistence and rejects an empty output', async () => {
    const persisted = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }), true)
    await expect(persisted.agent.run({
      reviewId: 'review-persisted', teamId: String(persisted.projection.team.id), trigger: 'user-request', projection: persisted.projection,
      controller: persisted.controller, workspace: persisted.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-persisted', decision: 'pass' })
    const empty = setup('')
    await expect(empty.agent.run({
      reviewId: 'review-empty', teamId: String(empty.projection.team.id), trigger: 'user-request', projection: empty.projection,
      controller: empty.controller, workspace: empty.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-empty', decision: 'inconclusive' })
  })

  it('fails closed when the reviewer Session cannot be recovered', async () => {
    const missing = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
    const persistence = missing.context.get('sessionPersistence') as unknown as { load: (id: SessionId) => Promise<undefined> }
    persistence.load = async () => undefined
    missing.subagents.startContinuable = async () => {
      const childId = SessionId('review-missing-output')
      queueMicrotask(() => {
        const emit = missing.context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(missing.subagents, missing.controller), 'subagent/end', {
          runId: SubagentRunId('review-missing-run'), provider: 'mock', id: childId, local: true,
          stopReason: 'completed', lastAssistantMessage: [],
        })
      })
      return { childId, messageId: 'missing-output-message' }
    }
    await expect(missing.agent.run({
      reviewId: 'review-missing-output', teamId: String(missing.projection.team.id), trigger: 'user-request', projection: missing.projection,
      controller: missing.controller, workspace: missing.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-missing-output', decision: 'inconclusive' })

    const loadFailure = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
    const failingPersistence = loadFailure.context.get('sessionPersistence') as unknown as { load: (id: SessionId) => Promise<never> }
    failingPersistence.load = async () => { throw new Error('session store unavailable') }
    loadFailure.subagents.startContinuable = async () => {
      const childId = SessionId('review-load-failure')
      queueMicrotask(() => {
        const emit = loadFailure.context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(loadFailure.subagents, loadFailure.controller), 'subagent/end', {
          runId: SubagentRunId('review-load-failure-run'), provider: 'mock', id: childId, local: true,
          stopReason: 'completed', lastAssistantMessage: [],
        })
      })
      return { childId, messageId: 'load-failure-message' }
    }
    await expect(loadFailure.agent.run({
      reviewId: 'review-load-failure', teamId: String(loadFailure.projection.team.id), trigger: 'user-request', projection: loadFailure.projection,
      controller: loadFailure.controller, workspace: loadFailure.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-load-failure', decision: 'inconclusive' })

    const noLoader = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
    const noLoaderPersistence = noLoader.context.get('sessionPersistence') as unknown as { load?: unknown }
    delete noLoaderPersistence.load
    noLoader.subagents.startContinuable = async () => {
      const childId = SessionId('review-no-loader')
      queueMicrotask(() => {
        const emit = noLoader.context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(noLoader.subagents, noLoader.controller), 'subagent/end', {
          runId: SubagentRunId('review-no-loader-run'), provider: 'mock', id: childId, local: true,
          stopReason: 'completed', lastAssistantMessage: [],
        })
      })
      return { childId, messageId: 'no-loader-message' }
    }
    await expect(noLoader.agent.run({
      reviewId: 'review-no-loader', teamId: String(noLoader.projection.team.id), trigger: 'user-request', projection: noLoader.projection,
      controller: noLoader.controller, workspace: noLoader.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-no-loader', decision: 'inconclusive' })

    const stopped = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
    stopped.subagents.startContinuable = async () => {
      const childId = SessionId('review-stopped-child')
      const child = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd: process.cwd() })
      child.append('assistant/message', {
        turn: 0, step: 0,
        message: createMessage({ role: 'assistant', content: [{ type: 'unknown' } as never, { type: 'text', text: '{"decision":"pass"}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      stopped.sessions.set(String(childId), child)
      queueMicrotask(() => {
        const emit = stopped.context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(stopped.subagents, stopped.controller), 'subagent/end', {
          runId: SubagentRunId('review-stopped-run'), provider: 'mock', id: childId, local: true,
          stopReason: 'error', lastAssistantMessage: [{ type: 'text', text: 'ignored' }],
        })
      })
      return { childId, messageId: 'stopped-message' }
    }
    await expect(stopped.agent.run({
      reviewId: 'review-stopped', teamId: String(stopped.projection.team.id), trigger: 'user-request', projection: stopped.projection,
      controller: stopped.controller, workspace: stopped.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-stopped', decision: 'inconclusive' })

    const fallbackSignal = setup('{}')
    fallbackSignal.subagents.startContinuable = async () => {
      const childId = SessionId('review-fallback-signal')
      const emit = fallbackSignal.context.emit as unknown as (target: object, name: string, payload: object) => void
      emit(scopeTarget(fallbackSignal.subagents, fallbackSignal.controller), 'subagent/end', {
        runId: SubagentRunId('review-fallback-run'), provider: 'mock', id: childId, local: true,
        stopReason: 'completed', lastAssistantMessage: [],
      })
      return { childId, messageId: 'fallback' }
    }
    const signal = {
      aborted: false, reason: undefined,
      throwIfAborted() {},
      addEventListener(_name: string, listener: () => void) { listener() },
      removeEventListener() {},
    } as unknown as AbortSignal
    await expect(fallbackSignal.agent.run({
      reviewId: 'review-fallback-signal', teamId: String(fallbackSignal.projection.team.id), trigger: 'user-request', projection: fallbackSignal.projection,
      controller: fallbackSignal.controller, workspace: fallbackSignal.workspace, signal,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-fallback-signal', decision: 'inconclusive' })

    const outputFailure = setup('{}')
    const sessionStore = outputFailure.context.get('sessions') as unknown as { get: (id: SessionId) => Session | undefined }
    sessionStore.get = () => { throw new Error('session lookup unavailable') }
    await expect(outputFailure.agent.run({
      reviewId: 'review-dispatch-failure', teamId: String(outputFailure.projection.team.id), trigger: 'user-request', projection: outputFailure.projection,
      controller: outputFailure.controller, workspace: outputFailure.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-dispatch-failure', decision: 'inconclusive' })
  })

  it('accepts a matching end event that arrives after child admission', async () => {
    const harness = setup(JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
    const childId = SessionId('review-late-child')
    const child = Session.create(childId, [], { version: 0, id: childId, createdAt: 0, cwd: process.cwd() })
    child.append('assistant/message', {
      turn: 0, step: 0,
      message: createMessage({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ decision: 'pass', findings: [], unverified: [] }) }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    harness.sessions.set(String(childId), child)
    harness.subagents.startContinuable = async () => {
      setTimeout(() => {
        const emit = harness.context.emit as unknown as (target: object, name: string, payload: object) => void
        emit(scopeTarget(harness.subagents, harness.controller), 'subagent/end', {
          runId: SubagentRunId('review-late-run'), provider: 'mock', id: childId, local: true, stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: 'late result' }],
        })
      }, 0)
      return { childId, messageId: 'late-message' }
    }

    await expect(harness.agent.run({
      reviewId: 'review-late-end', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: harness.workspace,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })).resolves.toMatchObject({ reviewId: 'review-late-end', decision: 'pass' })
  })

  it('propagates caller cancellation while waiting for the reviewer end event', async () => {
    const harness = setup('{}')
    harness.subagents.startContinuable = async () => ({ childId: SessionId('review-never-ends'), messageId: 'never' })
    const reason: Error = new Error('review cancelled')
    const signal = {
      aborted: false,
      reason,
      throwIfAborted(this: { aborted: boolean; reason: Error }) { if (this.aborted) throw this.reason },
      addEventListener(this: { aborted: boolean }, _name: string, listener: () => void) { this.aborted = true; listener() },
      removeEventListener() {},
    } as unknown as AbortSignal
    const running = harness.agent.run({
      reviewId: 'review-aborted', teamId: String(harness.projection.team.id), trigger: 'user-request', projection: harness.projection,
      controller: harness.controller, workspace: harness.workspace, signal,
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'deepseek-v4', role: 'verifier' } },
    })
    await expect(running).rejects.toBe(reason)
  })
})
