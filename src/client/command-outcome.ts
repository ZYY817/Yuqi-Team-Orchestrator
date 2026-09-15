/** Read the public command lifecycle; RPC `matched` is not a business result. */
import { getYuqiLocale } from './client-locale.ts'

interface CommandSnapshotNode {
  readonly kind: string
  readonly commandId?: string | null
  readonly name?: string | null
  readonly args?: string | null
  readonly outcome?: { readonly kind: 'success' | 'error'; readonly text?: string } | null
}

export interface CommandOutcomeSource {
  getSnapshot(): { readonly nodes: readonly CommandSnapshotNode[] }
  subscribe(listener: () => void): () => void
}

export interface CommandOutcomeWaitOptions {
  readonly timeoutMs?: number
  /** Command ids already visible before admission; used when Host omits args. */
  readonly previousCommandIds?: ReadonlySet<string>
}

export class YuqiCommandOutcomeError extends Error {
  constructor(readonly disposition: 'rejected' | 'unknown', message: string) {
    super(message)
    this.name = 'YuqiCommandOutcomeError'
  }
}

/**
 * The native command bridge may have already handed a command to the Host
 * while its conversation turn is waiting for an unrelated user response.
 * Never leave a control permanently disabled in that state: report an
 * unknown delivery after a bounded wait, so the durable Team state can be
 * refreshed before anybody retries the action.
 */
export function waitForCommandDelivery<T>(delivery: Promise<T>, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(commandAdmissionError('delivery-unknown'))
    }, timeoutMs)
    void delivery.then(
      value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Fixed diagnostics only: never expose command payloads or raw transport errors. */
export function commandAdmissionError(stage: 'session-unavailable' | 'sidecar-not-ready' | 'target-mismatch' | 'preflight-failed' | 'binding-read-failed' | 'sidecar-read-failed' | 'identity-read-failed' | 'snapshot-read-failed' | 'snapshot-shape-invalid' | 'rpc-error' | 'unmatched' | 'delivery-unknown'): YuqiCommandOutcomeError {
  const unknown = stage === 'rpc-error' || stage === 'delivery-unknown'
  const reasons = {
    'session-unavailable': ['当前会话连接不可用', 'The conversation binding is unavailable'],
    'sidecar-not-ready': ['团队数据尚未就绪', 'Team data is not ready'],
    'target-mismatch': ['按钮目标与当前团队身份不匹配，或命令参数无效', 'The target identity or command arguments do not match the current Team'],
    'preflight-failed': ['操作前状态检查失败', 'The preflight state check failed'],
    'binding-read-failed': ['读取当前会话连接失败', 'Reading the conversation binding failed'],
    'sidecar-read-failed': ['读取团队加载状态失败', 'Reading Team loading state failed'],
    'identity-read-failed': ['读取或核对团队身份失败', 'Reading or checking Team identity failed'],
    'snapshot-read-failed': ['读取官方会话快照失败', 'Reading the official conversation snapshot failed'],
    'snapshot-shape-invalid': ['官方会话快照未提供预期的命令节点列表', 'The official conversation snapshot did not provide the expected command node list'],
    'rpc-error': ['命令接口返回错误，是否执行尚未确认', 'The command API returned an error; execution is unconfirmed'],
    unmatched: ['当前会话未识别这条团队命令', 'The conversation did not recognize this Team command'],
    'delivery-unknown': ['命令投递或结果读取中断，是否执行尚未确认', 'Command delivery or result observation was interrupted; execution is unconfirmed'],
  } as const
  const en = getYuqiLocale() === 'en'
  return new YuqiCommandOutcomeError(unknown ? 'unknown' : 'rejected', `[command:${stage}] ${reasons[stage][en ? 1 : 0]}${unknown
    ? (en ? '. Check the main conversation and refresh Team state before retrying.' : '。请查看主对话并刷新团队状态，不要重复提交。')
    : (en ? '. No command was admitted; refresh Team state and check the conversation.' : '。本次未受理，请刷新团队状态并核对当前会话。')}`)
}

/** Official rc.1 separates Session lifecycle from Conversation target records.
 * Read and subscribe to the Chat target; older unified runtimes keep the same
 * records on Session. Neither branch substitutes missing records with [].
 */
export function resolveCommandOutcomeSource(uiConversation: unknown, sessionId: string, legacySession: CommandOutcomeSource): CommandOutcomeSource {
  const validNodes = (nodes: unknown): nodes is readonly CommandSnapshotNode[] => Array.isArray(nodes)
    && nodes.every(node => typeof node === 'object' && node !== null && typeof node.kind === 'string')
  if (uiConversation === undefined) {
    return {
      getSnapshot: () => {
        const snapshot = legacySession.getSnapshot()
        if (!validNodes(snapshot?.nodes)) throw commandAdmissionError('snapshot-shape-invalid')
        return snapshot
      },
      subscribe: listener => legacySession.subscribe(listener),
    }
  }
  // Structural boundary for the public UiConversation/ConversationBinding
  // contract, so installing this plugin does not replace Host-owned packages.
  const service = uiConversation as { binding(id: string): {
    activate(target: string): void
    target(target: string): { getSnapshot(): { readonly legacy?: { readonly nodes?: unknown } } | undefined; subscribe(listener: () => void): () => void }
  } }
  const binding = service.binding(sessionId)
  binding.activate('chat')
  const target = binding.target('chat')
  return {
    getSnapshot: () => {
      const nodes = target.getSnapshot()?.legacy?.nodes
      if (!validNodes(nodes)) throw commandAdmissionError('snapshot-shape-invalid')
      return { nodes }
    },
    subscribe: listener => target.subscribe(listener),
  }
}

/** Exact bound arguments include a unique request id; no title/task heuristic. */
export function waitForCommandOutcome(
  source: CommandOutcomeSource,
  line: string,
  timeoutOrOptions: number | CommandOutcomeWaitOptions = 15_000,
): Promise<boolean> {
  const match = /^\/([^\s]+)([\s\S]*)$/u.exec(line)
  if (match === null) return Promise.resolve(false)
  const name = match[1]!
  const args = match[2]!.trim()
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions
  const timeoutMs = options.timeoutMs ?? 15_000
  const previousCommandIds = options.previousCommandIds
  return new Promise((resolve, reject) => {
    let done = false
    let unsubscribe: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (done) return
      done = true
      unsubscribe?.()
      if (timer !== undefined) clearTimeout(timer)
      if (error === undefined) resolve(true)
      else reject(error)
    }
    const check = () => {
      try {
        const commands = source.getSnapshot().nodes.filter(candidate => candidate.kind === 'command'
          && candidate.name === name
          && (previousCommandIds === undefined
            || (candidate.commandId !== undefined
              && candidate.commandId !== null
              && !previousCommandIds.has(candidate.commandId))
            || (previousCommandIds.size === 0
              && (candidate.commandId === undefined || candidate.commandId === null))))
        // Some Hosts intentionally omit command args from the public event
        // envelope. The commandId is the lifecycle key; when the API exposes
        // only admission, the before/after delta must contain exactly one
        // candidate. Never choose between concurrent same-name commands.
        const exact = commands.filter(candidate => candidate.args?.trim() === args)
        const node = exact.length === 1 ? exact[0]
          : exact.length === 0 && commands.length === 1
            && (commands[0]!.args === undefined || commands[0]!.args === null) ? commands[0]
            : undefined
        if (node?.outcome == null) return
        if (node.outcome.kind === 'success') {
          if (name === 'yuqi' && /^knowledge-(?:delete|clear|refresh)\s/u.test(args)) {
            const refreshing = args.startsWith('knowledge-refresh ')
            let result: { saved?: unknown; panelSynced?: unknown } | undefined
            try { result = JSON.parse(node.outcome.text ?? '') as typeof result } catch { /* Require the cleanup result contract. */ }
            if (result?.saved !== !refreshing || result.panelSynced !== true) {
              finish(new YuqiCommandOutcomeError('unknown', result?.saved === true
                ? (getYuqiLocale() === 'en' ? 'Memory was saved, but the panel did not synchronize. Use Refresh project memory; do not repeat cleanup.' : '项目记忆已保存，但面板未同步。请点击“刷新项目记忆”，不要重复清理。')
                : (getYuqiLocale() === 'en' ? 'The memory operation result is unconfirmed. Refresh the records before retrying.' : '尚未确认记忆操作结果，请刷新记录后再决定是否重试。')))
              return
            }
          }
          finish()
        }
        else finish(new YuqiCommandOutcomeError(name === 'yuqi' && args.startsWith('message ')
          && node.outcome.text?.startsWith('Yuqi MESSAGE_DELIVERY_UNCERTAIN:') ? 'unknown' : 'rejected', node.outcome.text
          ?? (getYuqiLocale() === 'en' ? 'The Host rejected this operation.' : 'Host 拒绝了本次操作。')))
      } catch {
        finish(new YuqiCommandOutcomeError('unknown', getYuqiLocale() === 'en'
          ? 'Could not read the operation result. Check the main conversation before retrying.'
          : '无法读取操作结果，请先查看主对话和团队状态，不要重复提交。'))
      }
    }
    unsubscribe = source.subscribe(check)
    if (done) unsubscribe()
    else {
      timer = setTimeout(() => finish(new YuqiCommandOutcomeError('unknown', getYuqiLocale() === 'en'
        ? 'Request sent, but its result is not confirmed yet. Check the main conversation and refresh Team state before retrying.'
        : '请求已发送，但尚未确认处理结果。请查看主对话并刷新团队状态，不要重复提交。')), timeoutMs)
      check()
    }
  })
}
