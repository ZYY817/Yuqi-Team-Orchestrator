/** Public Harness child adapter for one bounded, read-only reviewer run. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { buildReviewerPrompt, parseReviewerOutput, type ReviewRequest, type ReviewResult } from '../../application/reviewer.ts'
import type { FixedModelPolicy } from '../../application/fixed-model.ts'
import { resolveFixedModelFromPort } from '../../application/fixed-model.ts'
import type { GitWorkspacePort, ModelCatalogPort } from '../../application/workspace-ports.ts'
import type { TeamWorkspace } from '../../domain/workspace.ts'
import { HarnessContinuableChildPort } from './continuable-child.ts'
import { readLastAssistantOutput } from './session-assistant-output.ts'
import { workspaceProjectRoot } from '../workspace-project-root.ts'

const REVIEW_TIMEOUT_MS = 120_000
export const REVIEW_STOP_TIMEOUT_MS = 5_000
const REVIEWER_READ_ONLY_TOOLS = Object.freeze(['read', 'glob', 'grep', 'read_image', 'web_search'])

export interface HarnessReviewerRequest extends ReviewRequest {
  readonly controller: Agent
  readonly workspace: TeamWorkspace
  readonly modelPolicy: FixedModelPolicy
  readonly signal?: AbortSignal
}

export class HarnessReviewAgent {
  readonly #ctx: Context
  readonly #git: GitWorkspacePort
  readonly #models: ModelCatalogPort
  readonly #getAgent: ((id: SessionId) => Agent | undefined) | undefined
  readonly #runs = new Map<string, { stop(): Promise<void> }>()
  readonly #settled = new Map<string, Map<string, string | undefined>>()
  readonly #onStopped: ((controllerId: string, reviewId: string) => void) | undefined

  constructor(ctx: Context, git: GitWorkspacePort, models: ModelCatalogPort, getAgent?: (id: SessionId) => Agent | undefined,
    onStopped?: (controllerId: string, reviewId: string) => void) {
    this.#ctx = ctx
    this.#git = git
    this.#models = models
    this.#getAgent = getAgent
    this.#onStopped = onStopped
  }

  assertNoUnsettled(controllerId: string): void {
    if (this.#runs.has(controllerId)) throw reviewUncertain('A reviewer is still active, admitting, or not confirmed stopped')
  }

  hasSettled(controllerId: string, reviewId: string): boolean {
    return this.#settled.get(controllerId)?.has(reviewId) === true
  }

  settledChildId(controllerId: string, reviewId: string): string | undefined {
    return this.#settled.get(controllerId)?.get(reviewId)
  }

  forgetSettled(controllerId: string, reviewId: string): void {
    const settled = this.#settled.get(controllerId)
    settled?.delete(reviewId)
    if (settled?.size === 0) this.#settled.delete(controllerId)
  }

  /** Resolves only after exact-child cancellation and public quiescence proof. */
  async cancelForController(controllerId: string): Promise<void> {
    const run = this.#runs.get(controllerId)
    if (run !== undefined) await boundedStop(run.stop())
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.#runs.keys()].map(id => this.cancelForController(id)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  async run(request: HarnessReviewerRequest): Promise<ReviewResult> {
    request.signal?.throwIfAborted()
    const key = String(request.controller.id)
    this.assertNoUnsettled(key)
    if (request.workspace.status !== 'ready') throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Reviewer requires a ready Team workspace')
    const abort = new AbortController()
    let interrupted: unknown
    let rejectInterrupted!: (reason: unknown) => void
    const interruption = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject })
    // Install the rejection observer before an already-aborted/custom signal fires.
    void interruption.catch(() => undefined)
    const interrupt = (reason: unknown) => {
      if (abort.signal.aborted) return
      interrupted = reason
      abort.abort(reason)
      rejectInterrupted(reason)
    }
    let admittedDone!: () => void
    const admission = new Promise<void>(resolve => { admittedDone = resolve })
    let childSessionId: string | undefined
    let finished: SubagentRunEndInfo | undefined
    let confirmTerminal!: () => void
    const terminal = new Promise<void>(resolve => { confirmTerminal = resolve })
    let stopping: Promise<void> | undefined
    let released = false
    let dispose = () => {}
    const release = () => {
      if (released) return
      released = true
      dispose()
      const settled = this.#settled.get(key) ?? new Map<string, string | undefined>()
      settled.set(request.reviewId, childSessionId)
      if (settled.size > 64) settled.delete(settled.keys().next().value!)
      this.#settled.set(key, settled)
      if (this.#settled.size > 256) this.#settled.delete(this.#settled.keys().next().value!)
      if (this.#runs.get(key) === owned) this.#runs.delete(key)
      if (abort.signal.aborted) this.#onStopped?.(key, request.reviewId)
    }
    const getAgent = this.#getAgent ?? ((id: SessionId) => request.controller.ctx.get('agents')?.get(id))
    const child = new HarnessContinuableChildPort(this.#ctx, request.controller, this.#git, getAgent)
    const stop = (): Promise<void> => {
      interrupt(new Error('reviewer stopped'))
      if (released) return Promise.resolve()
      if (stopping !== undefined) return stopping
      const operation = (async () => {
        await admission
        if (childSessionId !== undefined) {
          const exactChild = getAgent(childSessionId as SessionId)
          // cancel clears this child's inbox; its acknowledgement alone is not proof.
          await boundedStop(child.cancel(childSessionId))
          if (finished === undefined && exactChild !== undefined && exactChild !== request.controller
            && exactChild.session.header.parentSession === request.controller.id && typeof exactChild.whenIdle === 'function') {
            await boundedStop(Promise.race([exactChild.whenIdle(), terminal]))
            release()
            return
          }
          const deadline = Date.now() + REVIEW_STOP_TIMEOUT_MS
          while (finished === undefined) {
            const list = this.#ctx.subagents.listChildren
            if (typeof list === 'function') {
              const entries = await boundedStop(list.call(this.#ctx.subagents, request.controller.id, AbortSignal.timeout(REVIEW_STOP_TIMEOUT_MS)))
              const exact = entries.find(entry => entry.kind === 'child' && String(entry.id) === childSessionId)
              if (!entries.some(entry => entry.kind === 'diagnostic')
                && (exact === undefined || (exact.kind === 'child' && exact.mode === 'continuable' && exact.activity === 'inactive'))) break
            }
            if (Date.now() >= deadline) throw reviewUncertain(`Reviewer ${childSessionId} stop is not confirmed`)
            await new Promise<void>(resolve => setTimeout(resolve, 25))
          }
        }
        release()
      })()
      stopping = operation
      void operation.catch(() => { if (stopping === operation) stopping = undefined })
      return operation
    }
    const owned = { stop }
    this.#runs.set(key, owned)
    const onAbort = () => interrupt(request.signal?.reason ?? new Error('reviewer aborted'))
    request.signal?.addEventListener('abort', onAbort, { once: true })
    if (request.signal?.aborted) onAbort()
    const timer = setTimeout(() => interrupt(new Error('reviewer timeout')), REVIEW_TIMEOUT_MS)
    const work = (async (): Promise<ReviewResult> => {
    const fixed = await resolveFixedModelFromPort('verifier', request.modelPolicy, this.#models, abort.signal)
    abort.signal.throwIfAborted()
    const controllerSandboxMode = this.#ctx.sandboxPolicy.resolve({ session: request.controller.session }).mode
    const boundary = {
      cwd: workspaceProjectRoot(request.workspace),
      sandboxMode: controllerSandboxMode,
      workspace: request.workspace,
      allowedDirtyScopes: ['**'],
    }
    const pendingEnds = new Map<string, SubagentRunEndInfo>()
    let resolveEnd!: (value: SubagentRunEndInfo) => void
    const end = new Promise<SubagentRunEndInfo>(resolve => { resolveEnd = resolve })
    dispose = request.controller.ctx.on('subagent/end', info => {
      const id = String(info.id)
      if (childSessionId === undefined) {
        pendingEnds.set(id, info)
      } else if (id === childSessionId) {
        finished = info
        confirmTerminal()
        resolveEnd(info)
        if (abort.signal.aborted) void stop().catch(() => undefined)
      }
    })
      const admitted = await child.start({
        subagentProvider: fixed.subagentProvider,
        label: `Yuqi reviewer: ${request.trigger}`,
        prompt: localizedReviewerPrompt(request),
        modelProvider: fixed.modelProvider,
        modelId: fixed.modelId,
        maxDepth: 1,
        toolFilter: { allow: REVIEWER_READ_ONLY_TOOLS },
        signal: abort.signal,
        executionBoundary: boundary,
      })
      childSessionId = admitted.childSessionId
      const early = pendingEnds.get(childSessionId)
      pendingEnds.clear()
      if (early !== undefined) { finished = early; confirmTerminal(); resolveEnd(early) }
      admittedDone()
      // A provider may accept a prompt despite cancellation racing admission.
      if (abort.signal.aborted) { await stop(); abort.signal.throwIfAborted() }
      const ended = await Promise.race([end, interruption])
      const output = await readLastAssistantOutput(this.#ctx, childSessionId, Number.MAX_SAFE_INTEGER, abort.signal)
      abort.signal.throwIfAborted()
      if (output === undefined || ended.stopReason !== 'completed') {
        return inconclusive(request, childSessionId, request.projection.team.locale === 'en'
          ? `The reviewer child did not produce verifiable completed output (${ended.stopReason}).`
          : `审查子 Agent 未产生可验证的完成输出（${ended.stopReason}）。`)
      }
      const result = parseReviewerOutput(output.text, request, childSessionId)
      if (request.projection.team.locale === 'en'
        && result.decision === 'inconclusive'
        && result.unverified.length === 1
        && result.unverified[0] === '审查 Agent 输出无法按结构化契约解析；不能视为通过。') {
        return { ...result, unverified: ['The reviewer output could not be parsed under the structured contract and cannot be treated as a pass.'] }
      }
      return result
    })()
    // Even a late rejection must discharge admission ownership, never go unhandled.
    void work.then(admittedDone, admittedDone)
    try {
      const result = await Promise.race([work, interruption])
      abort.signal.throwIfAborted()
      release()
      return result
    } catch (cause) {
      if (childSessionId === undefined && !abort.signal.aborted) {
        await admission
        release()
      } else if (abort.signal.aborted || finished === undefined) {
        try { await boundedStop(stop()) }
        catch (failure) { throw reviewUncertain(`Reviewer cleanup is unconfirmed: ${safeFailure(failure)}`, failure) }
      } else release()
      if (request.signal?.aborted) throw request.signal.reason ?? cause
      this.#ctx.logger.warn(`[yuqi-team] reviewer ${request.reviewId} could not complete: ${safeFailure(cause)}`)
      return inconclusive(request, childSessionId ?? 'unknown-reviewer', request.projection.team.locale === 'en'
        ? `Reviewer dispatch, recovery, or output reading failed and cannot be treated as a pass. Cause: ${safeFailure(interrupted ?? cause)}`
        : `审查 Agent 调度、恢复或输出读取失败；不能视为通过。原因：${safeFailure(interrupted ?? cause)}`)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }

}

function localizedReviewerPrompt(request: ReviewRequest): ContentBlock[] {
  const prompt = buildReviewerPrompt(request)
  const languageInstruction = request.projection.team.locale === 'en'
    ? 'Write finding impact, recommendations, and unverified explanations in English. Preserve user-authored content, paths, identifiers, logs, and quoted evidence verbatim; do not auto-translate them.'
    : '请用中文撰写 finding 的 impact、recommendation 和 unverified 说明。用户自由内容、路径、标识符、日志和引用证据保持原文，不要自动翻译。'
  return prompt.map(block => block.type === 'text'
    ? { ...block, text: `${block.text}\n${languageInstruction}` }
    : block)
}

function safeFailure(cause: unknown): string {
  if (!(cause instanceof Error)) return 'unknown error'
  const code = 'code' in cause && typeof cause.code === 'string' ? `${cause.code}: ` : ''
  return `${code}${cause.message}`
}

function reviewUncertain(message: string, cause?: unknown): YuqiOrchestratorError {
  return new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', message, { cause })
}

async function boundedStop<T>(operation: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(reviewUncertain('Timed out confirming reviewer cleanup')), REVIEW_STOP_TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
}

function inconclusive(request: ReviewRequest, reviewerSessionId: string, reason: string): ReviewResult {
  return {
    reviewId: request.reviewId,
    trigger: request.trigger,
    reviewerSessionId,
    decision: 'inconclusive',
    findings: [],
    unverified: [reason],
  }
}
