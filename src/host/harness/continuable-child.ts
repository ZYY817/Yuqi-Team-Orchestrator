/** Harness continuable-subagent adapter for one exact controller Agent. */

import { readSessionEvents } from './session-events.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import type { ChildControlPort, ChildEnd, ChildExecutionBoundary, ChildStartRequest, ChildTokenUsage, ChildUsage, ContinuableChildPort } from '../../application/ports.ts'
import type { GitWorkspacePort } from '../../application/workspace-ports.ts'
import { harnessSessionAccess } from './session-store-adapter.ts'
import { parseTaskOutcomeReport } from '../../domain/task-outcome.ts'
import { appendCompatibleYuqiSessionEvent } from './session-compatibility.ts'
import { appendSidecarEvent, hasSidecarSession } from '../storage/session-sidecar.ts'
import { boundedSnapshotOperation, captureWorkspaceSnapshot, compareWorkspaceSnapshots, WORKSPACE_CHANGE_SNAPSHOT_EVENT, type WorkspaceSnapshot } from '../workspace-change-snapshot.ts'

const SNAPSHOT_SETTLE_TIMEOUT_MS = 4_000
interface SnapshotAttempt {
  readonly before: WorkspaceSnapshot
  readonly ready: Promise<void>
  readonly admit: () => void
  readonly cleanup: () => void
  childSessionId?: string
  session?: Session
  finished?: Promise<void>
}

/**
 * Keep a bounded final safety valve without treating normal, multi-step coding
 * work as stalled. Two minutes is shorter than a healthy build/edit/review turn
 * and used to abort productive children before they could settle durably.
 */
export const CHILD_EXECUTION_TIMEOUT_MS = 30 * 60_000

/** Delegates only through the controller's public, scoped subagent service. */
export class HarnessContinuableChildPort implements ContinuableChildPort<ContentBlock[]>, ChildControlPort {
  readonly #ctx: Context
  readonly #controller: Agent
  readonly #git: GitWorkspacePort
  readonly #getAgent: ((id: SessionId) => Agent | undefined) | undefined
  readonly #executionTimers = new Map<string, () => void>()
  readonly #observedUsage = new Map<string, ChildTokenUsage>()
  readonly #snapshots = new Set<SnapshotAttempt>()
  #snapshotPreparations = 0

  constructor(ctx: Context, controller: Agent, git: GitWorkspacePort, getAgent?: (id: SessionId) => Agent | undefined) {
    this.#ctx = ctx
    this.#controller = controller
    this.#git = git
    this.#getAgent = getAgent
  }

  async start(request: ChildStartRequest<ContentBlock[]>) {
    if (request.executionBoundary !== undefined) {
      await this.#git.verify({
        workspace: request.executionBoundary.workspace,
        allowedDirtyScopes: request.executionBoundary.allowedDirtyScopes,
        signal: request.signal,
      })
      await verifyHarnessExecutionBoundary(this.#ctx, this.#controller, request.executionBoundary)
    }
    const snapshot = await this.#prepareSnapshot(request)
    // Timer ownership must not depend on an application onEnd subscription.
    // Native end can arrive synchronously before admission exposes the child id.
    let childSessionId: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const earlyEnds = new Set<string>()
    const disposeEnd = this.#controller.ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      if (childSessionId === undefined) earlyEnds.add(String(info.id))
      else if (childSessionId === String(info.id)) this.#clearExecutionTimer(childSessionId)
    })
    const cleanupTimer = () => {
      clearTimeout(timer)
      disposeEnd()
      earlyEnds.clear()
    }
    let admitted: Awaited<ReturnType<Context['subagents']['startContinuable']>>
    try {
      request.signal.throwIfAborted()
      admitted = await this.#ctx.subagents.startContinuable({
        provider: request.subagentProvider,
        label: request.label,
        request: {
          prompt: request.prompt,
          parent: this.#controller,
          agentOptions: { provider: request.modelProvider, model: request.modelId },
          maxDepth: request.maxDepth,
          ...(request.toolFilter === undefined ? {} : { toolFilter: request.toolFilter }),
          // The controller runs on Harness's native standard preset, so children
          // inherit its full coding tool surface. Yuqi's start tool exists only
          // on the separate entry preset and therefore cannot recurse here.
        },
        signal: request.signal,
      })
    } catch (error) {
      cleanupTimer()
      snapshot?.cleanup()
      throw error
    }
    childSessionId = String(admitted.childId)
    if (snapshot !== undefined) {
      snapshot.childSessionId = childSessionId
      // Keep the actual Session object: the live store can release it at end.
      try {
        const session = this.#getAgent?.(admitted.childId)?.session ?? harnessSessionAccess(this.#ctx).get?.(admitted.childId)
        if (session !== undefined) snapshot.session = session
      } catch { /* Optional evidence only. */ }
      snapshot.admit()
    }
    const id = childSessionId
    if (earlyEnds.has(id)) {
      cleanupTimer()
      return { childSessionId: id, messageId: String(admitted.messageId) }
    }
    earlyEnds.clear()
    timer = setTimeout(() => {
      this.#clearExecutionTimer(id)
      try {
        this.#ctx.subagents.interrupt(SessionId(id), { kind: 'ancestor', agent: this.#controller })
      } catch {
        // The durable settlement/reconciliation path owns the final outcome.
        // A timeout interrupt must not create an unhandled timer rejection.
      }
    }, CHILD_EXECUTION_TIMEOUT_MS)
    timer.unref?.()
    this.#executionTimers.set(id, cleanupTimer)
    return { childSessionId, messageId: String(admitted.messageId) }
  }

  onEnd(listener: (event: ChildEnd) => void): () => void {
    // Session ids are globally unique in the host. The application layer owns
    // child-id matching, so this untagged observer remains correct across an
    // out-of-tree plugin's separate package-resolution realm.
    let active = true
    const dispose = this.#controller.ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
      this.#clearExecutionTimer(String(info.id))
      const childSessionId = String(info.id)
      const observedUsage = this.#observedUsage.get(childSessionId)
      this.#observedUsage.delete(childSessionId)
      void Promise.all([
        observedUsage === undefined ? childSessionUsage(this.#ctx, childSessionId) : Promise.resolve(observedUsage),
        this.#snapshotEnd(info),
      ]).then(([usage]) => {
        if (!active) return
        listener({
        runId: String(info.runId),
        provider: info.provider,
        childSessionId: String(info.id),
        stopReason: info.stopReason,
        hasAssistantOutput: hasEffectiveAssistantOutput(info.lastAssistantMessage),
        ...taskOutcomeFrom(info.lastAssistantMessage),
        ...reportedChangedFilesFrom(info.lastAssistantMessage),
        ...(usage === undefined ? {} : { usage }),
        })
      })
    })
    return () => {
      active = false
      dispose()
    }
  }

  onUsage(listener: (event: ChildUsage) => void): () => void {
    let active = true
    // executeGatedBatch subscribes once per active attempt. Keep each
    // subscription's accumulator local so the same root-bus event is not
    // multiplied by the number of concurrent attempts. The shared map stores
    // only the latest absolute snapshot for onEnd.
    const subscriptionUsage = new Map<string, ChildTokenUsage>()
    // Child Sessions live under their own agent scopes. A plugin/controller
    // scope does not receive sibling Session events in the real Harness even
    // though the test host's flat context does. Observe from the root bus so
    // live child usage is captured before the terminal event arrives.
    const dispose = this.#ctx.root.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message' || event.data.usage === undefined) return
      const childSessionId = String(session.id)
      const previous = subscriptionUsage.get(childSessionId) ?? {
        uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      }
      const usage = {
        uncachedInputTokens: previous.uncachedInputTokens + event.data.usage.inputTokens,
        outputTokens: previous.outputTokens + event.data.usage.outputTokens,
        cacheReadTokens: previous.cacheReadTokens + (event.data.usage.cacheReadTokens ?? 0),
        cacheWriteTokens: previous.cacheWriteTokens + (event.data.usage.cacheWriteTokens ?? 0),
      }
      subscriptionUsage.set(childSessionId, usage)
      this.#observedUsage.set(childSessionId, usage)
      if (active) listener({ childSessionId, usage })
    })
    return () => {
      active = false
      dispose()
    }
  }

  interrupt(childSessionId: string): void {
    this.#clearExecutionTimer(childSessionId)
    this.#ctx.subagents.interrupt(SessionId(childSessionId), { kind: 'ancestor', agent: this.#controller })
  }

  /** Optional observation must never reject admission or invent a child result. */
  async #prepareSnapshot(request: ChildStartRequest<ContentBlock[]>): Promise<SnapshotAttempt | undefined> {
    const cwd = request.executionBoundary?.cwd ?? this.#controller.session.header.cwd
    if (cwd === undefined || request.signal.aborted || this.#snapshots.size + this.#snapshotPreparations >= 16) return undefined
    this.#snapshotPreparations++
    let cleanupOnFailure: (() => void) | undefined
    try {
      const before = await captureWorkspaceSnapshot(cwd, {}, request.signal)
      if (request.signal.aborted) return undefined
      let admit!: () => void
      const ready = new Promise<void>(resolve => { admit = resolve })
      let dispose = () => {}
      let expiry: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        this.#snapshots.delete(state)
        try { dispose() } catch { /* Evidence cleanup cannot affect the task. */ }
        clearTimeout(expiry)
        request.signal.removeEventListener('abort', cleanup)
        admit()
      }
      const state: SnapshotAttempt = { before, ready, admit, cleanup }
      cleanupOnFailure = cleanup
      this.#snapshots.add(state)
      // Observe independently of application subscriptions, including fast end
      // events emitted before the startContinuable promise returns admission.
      dispose = this.#controller.ctx.on('subagent/end', info => { void this.#snapshotEnd(info, state) })
      expiry = setTimeout(cleanup, CHILD_EXECUTION_TIMEOUT_MS + SNAPSHOT_SETTLE_TIMEOUT_MS)
      expiry.unref?.()
      request.signal.addEventListener('abort', cleanup, { once: true })
      return state
    } catch { cleanupOnFailure?.(); return undefined }
    finally { this.#snapshotPreparations-- }
  }

  async #snapshotEnd(info: SubagentRunEndInfo, only?: SnapshotAttempt): Promise<void> {
    const candidates = (only === undefined ? [...this.#snapshots] : [only])
      .filter(state => state.childSessionId === undefined || state.childSessionId === String(info.id))
    await boundedSnapshotOperation(async signal => {
      await Promise.all(candidates.map(async state => {
        await state.ready
        if (signal.aborted || !this.#snapshots.has(state) || state.childSessionId !== String(info.id)) return
        state.finished ??= this.#recordSnapshot(state, info).finally(state.cleanup)
        await state.finished
      }))
    }, SNAPSHOT_SETTLE_TIMEOUT_MS + 100)
  }

  async #recordSnapshot(state: SnapshotAttempt, info: SubagentRunEndInfo): Promise<void> {
    await boundedSnapshotOperation(async signal => {
      // Optional evidence only: an invalid store response resolves no session
      // and therefore writes nothing, exactly like an unavailable child.
      let session: Session | undefined
      try {
        session = state.session ?? this.#getAgent?.(info.id)?.session ?? harnessSessionAccess(this.#ctx).get?.(info.id)
      } catch { /* Observation must never break terminal delivery. */ }
      if (session === undefined || String(session.id) !== String(info.id)
        || session.header.parentSession !== this.#controller.id || session.header.cwd === undefined
        || !sameHostPath(session.header.cwd, state.before.root)) return
      const after = await captureWorkspaceSnapshot(state.before.root, state.before.limits, signal)
      if (signal.aborted) return
      const data = compareWorkspaceSnapshots(state.before, after, String(info.id), String(info.runId))
      if (hasSidecarSession(session)) {
        await appendSidecarEvent(session, WORKSPACE_CHANGE_SNAPSHOT_EVENT, data)
        return
      }
      appendCompatibleYuqiSessionEvent(session, WORKSPACE_CHANGE_SNAPSHOT_EVENT, data)
      const access = harnessSessionAccess(this.#ctx)
      try { if (await access.flush?.(session)) return } catch { /* A detached child may need the public persistence fallback. */ }
      if (signal.aborted) return
      // Never reconstruct a competing Session or fabricate its history. Append
      // only a matching tail of the exact real child through the public API.
      const stored = (await this.#ctx.sessionPersistence.readFrom(session.id, 0, signal)).events
      if (signal.aborted) return
      const live = [...readSessionEvents(session)]
      if (stored.length > live.length || !stored.every((event, index) => JSON.stringify(event) === JSON.stringify(live[index]))) return
      const tail = live.slice(stored.length)
      if (tail.length > 0) await this.#ctx.sessionPersistence.append(session.id, tail)
    }, SNAPSHOT_SETTLE_TIMEOUT_MS)
  }

  /**
   * Team cancellation first performs the normal ancestor-authorized interrupt,
   * then releases only this exact direct child through native lifecycle APIs.
   * No synthetic end event is emitted and no controller-wide admission is
   * drained. The selected-child API is used when supplied by a newer Host;
   * otherwise the public Agent.cancel() fallback clears only that child's
   * inbox, with a child-rooted descendant drain when available.
   */
  async cancel(childSessionId: string): Promise<void> {
    // Cancellation may drain a child without another end notification. Release
    // optional evidence state; absence of a snapshot is never a clean-workspace claim.
    for (const state of this.#snapshots) {
      if (state.childSessionId === childSessionId) state.cleanup()
    }
    this.interrupt(childSessionId)
    const id = SessionId(childSessionId)
    // The service's base Cordis scope intentionally does not inject agents.
    // Resolve through its already-injected controller capability instead.
    const controller = this.#getAgent?.(this.#controller.id)
    const child = this.#getAgent?.(id)
    if (controller !== this.#controller) {
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Cannot safely cancel child ${childSessionId}: live parent authority or direct-child identity is unavailable`)
    }

    const subagents = this.#ctx.subagents as Context['subagents'] & {
      readonly drainContinuableChildren?: (parent: Agent, childIds: readonly SessionId[]) => Promise<void>
      readonly drainContinuableDescendants?: (parents: readonly Agent[]) => Promise<void>
    }
    if (typeof subagents.drainContinuableChildren === 'function') {
      await subagents.drainContinuableChildren(this.#controller, [id])
      return
    }

    // A naturally completed child may have left the live registry between
    // the interrupt and this lookup. Its real terminal event still owns settlement.
    if (child === undefined) return
    if (child === this.#controller || child.session.header.parentSession !== this.#controller.id) {
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Cannot safely cancel child ${childSessionId}: direct-child identity is unavailable`)
    }

    // Capture descendant teardown authority before clearing the inbox: clearing
    // the last accepted message can let the Host release this child immediately.
    const descendants = typeof subagents.drainContinuableDescendants === 'function'
      ? subagents.drainContinuableDescendants([child])
      : Promise.resolve()
    child.cancel({ kind: 'parent' })
    await descendants
  }

  #clearExecutionTimer(childSessionId: string): void {
    const timer = this.#executionTimers.get(childSessionId)
    if (timer === undefined) return
    this.#executionTimers.delete(childSessionId)
    timer()
  }
}

/** Parse the explicit machine-readable footer requested by the Team prompt. */
export function taskOutcomeFrom(content: readonly ContentBlock[] | undefined) {
  return { taskOutcome: parseTaskOutcomeReport(content?.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '') }
}

/** Parse the explicit machine-readable footer requested by the Team prompt. */
export function reportedChangedFilesFrom(content: readonly ContentBlock[] | undefined): { readonly reportedChangedFiles?: readonly string[] } {
  if (content === undefined) return {}
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const match = /(?:^|\n)YUQI_CHANGED_FILES:\s*(\[[^\r\n]*\])/u.exec(text)
  if (match?.[1] === undefined) return {}
  let parsed: unknown
  try { parsed = JSON.parse(match[1]) } catch { return {} }
  if (!Array.isArray(parsed)) return {}
  const files = [...new Set(parsed.flatMap(value => {
    if (typeof value !== 'string') return []
    // Some child models emit Windows paths with a single JSON backslash
    // (for example "src\\b.ts"). JSON decodes \b/\f/\n/\r/\t as control
    // characters, so normalize those path separators as well.
    const normalized = value.trim()
      .replaceAll('\b', '/b').replaceAll('\f', '/f').replaceAll('\n', '/n').replaceAll('\r', '/r').replaceAll('\t', '/t')
      .replaceAll('\\', '/')
    if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return []
    const segments = normalized.split('/')
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return []
    return [normalized]
  }))].slice(0, 512)
  return { reportedChangedFiles: Object.freeze(files) }
}

/** Whitespace-only text and non-text blocks are not a usable child report. */
export function hasEffectiveAssistantOutput(content: readonly ContentBlock[] | undefined): boolean {
  return content?.some(block => block.type === 'text' && block.text.trim() !== '') ?? false
}

/** Sum only the child's live events; a copied parent seed must never inflate Team usage. */
const USAGE_LOAD_TIMEOUT_MS = 2_000

async function childSessionUsage(ctx: Context, childSessionId: string): Promise<ChildTokenUsage | undefined> {
  const id = SessionId(childSessionId)
  // Optional observation only: an invalid store response is treated like an
  // unavailable live Session so the persisted-log fallback still applies.
  let live: Session | undefined
  try {
    live = harnessSessionAccess(ctx).get?.(id)
  } catch { /* Observation must never break terminal delivery. */ }
  let source = live === undefined ? undefined : { meta: live.header, events: readSessionEvents(live) }
  if (source === undefined) {
    let timer!: ReturnType<typeof setTimeout>
    try {
      source = await Promise.race([
        ctx.sessionPersistence.load(id),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), USAGE_LOAD_TIMEOUT_MS) }),
      ])
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  if (source === undefined) return undefined
  const firstChildSeq = source.meta.seedLength ?? 0
  let reported = false
  const total = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
  for (const event of source.events) {
    if (event.seq < firstChildSeq || event.type !== 'assistant/message' || event.data.usage === undefined) continue
    reported = true
    total.uncachedInputTokens += event.data.usage.inputTokens
    total.outputTokens += event.data.usage.outputTokens
    total.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0
    total.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0
  }
  return reported ? total : undefined
}

/** Prove the immutable cwd and current effective sandbox before durable dispatch intent. */
export async function verifyHarnessExecutionBoundary(
  ctx: Context,
  controller: Agent,
  boundary: Pick<ChildExecutionBoundary, 'cwd' | 'sandboxMode'>,
): Promise<void> {
  const controllerCwd = controller.session.header.cwd
  if (controllerCwd === undefined) throw executionGateError()
  let expected: string
  let actual: string
  try {
    const policy = ctx.sandboxPolicy.resolve({ session: controller.session })
    const resolved = await Promise.all([
      realpath(boundary.cwd),
      realpath(controllerCwd),
    ])
    expected = resolved[0]
    actual = resolved[1]
    if (!sameHostPath(expected, actual) || policy.mode !== boundary.sandboxMode) throw executionGateError()
    // Cold-restored controllers can legitimately resolve a mode-only policy.
    // When a root is present it must still match exactly; otherwise the exact,
    // real-pathed immutable Session cwd remains the execution root proof.
    if (typeof policy.workspaceRoot === 'string') {
      const policyRoot = await realpath(policy.workspaceRoot)
      if (!sameHostPath(expected, policyRoot)) throw executionGateError()
    }
  } catch (cause) {
    if (cause instanceof YuqiOrchestratorError) throw cause
    throw executionGateError()
  }
}

function sameHostPath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  /* v8 ignore next -- Windows paths are case-insensitive; POSIX paths are not. */
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function executionGateError(): YuqiOrchestratorError {
  return new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The child runtime does not match the durable Team workspace and sandbox boundary')
}
