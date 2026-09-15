import { sessionPreset } from './session-preset.ts'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostClientApi } from './host-client-api.ts'
import { getYuqiLocale } from './client-locale.ts'
import { canHandoff, validHandoffContext, type CreateTeamHandoff } from './team-handoff.ts'
import type { SidecarStore } from './sidecar-store.ts'

/** Syntax only for absolute Windows drive paths; never infer filesystem aliases. */
function directorySpelling(value: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(value)) return value
  const slashed = value.replace(/\\/g, '/')
  const normalized = slashed[0]!.toUpperCase() + slashed.slice(1)
  // Keep the drive-root slash: F:/ must not become the drive-relative F:.
  return normalized.slice(0, 3) + normalized.slice(3).replace(/\/+$/, '')
}

/** Wait for the public list, not an invented local Session row. Never sends a prompt. */
export async function openHandoffTarget(ctx: ClientContext, target: string): Promise<boolean> {
  const id = target as SessionId
  const present = () => ctx.sessions.list.getSnapshot().byId[id] !== undefined
  if (!present()) {
    const ready = await new Promise<boolean>(resolve => {
      let done = false
      let unsubscribe = () => {}
      const finish = (value: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsubscribe()
        resolve(value)
      }
      const timer = setTimeout(() => finish(false), 5_000)
      unsubscribe = ctx.sessions.list.subscribe(() => { if (present()) finish(true) })
      if (done) unsubscribe()
      else if (present()) finish(true)
    })
    if (!ready) return false
  }
  try { ctx.sessions.open(id); return true } catch { return false }
}

/** Existing conversations are immutable: hand off only user-confirmed text to a new preset. */
export function createTeamHandoffAdapter(ctx: ClientContext, api: Pick<HostClientApi, 'workspace' | 'sessions'>, sidecar?: SidecarStore): CreateTeamHandoff {
  return async request => {
    const en = getYuqiLocale() === 'en'
    // Sidebar ownership is the Host registry's sessionIds account, not cwd or
    // the currently selected/recent workspace. Refresh before reading source
    // eligibility so a reconnect/loading snapshot cannot silently lose ownership.
    let workspaces
    try {
      const listed = await api.workspace.list({})
      if (!listed.result.ok) throw new Error(listed.result.error.message)
      workspaces = listed.result.value.items
    } catch {
      return { kind: 'rejected', retryable: true, message: en
        ? 'Workspace ownership could not be verified. No Team conversation was created; retry after reconnecting.'
        : '无法核实工作区归属，未创建团队会话；请连接恢复后重试。' }
    }
    const source = ctx.sessions.list.getSnapshot().byId[request.sourceSessionId as SessionId]
    if (sidecar?.getSnapshot().unavailable?.has(request.sourceSessionId)) return { kind: 'rejected', retryable: true, message: en ? 'This conversation log is unavailable. Restore it before handing off.' : '此会话记录不可用，请恢复记录后再转为团队任务。' }
    if (sidecar !== undefined && sidecar.getSnapshot().status !== 'ready') return { kind: 'rejected', retryable: true, message: en ? 'Team data unavailable; refresh and retry.' : 'Team 数据不可用，请刷新后重试。' }
    const summary = sidecar === undefined ? source?.projectionValues?.yuqiTeam : sidecar.summary(request.sourceSessionId)
    if (source === undefined || !canHandoff({
      sessionId: request.sourceSessionId, cwd: source.cwd ?? '',
      parentSessionId: source.origin === 'subagent' ? source.parentId : undefined, agentPreset: sessionPreset(source),
      isTeam: summary != null || source.origin === 'subagent',
      isIdle: !source.running,
    }) || !validHandoffContext(request.context) || request.sourceSessionId === request.targetSessionId) {
      return { kind: 'rejected', retryable: true, message: en
        ? 'The source is no longer an idle ordinary conversation, or the handoff text is invalid.'
        : '原对话已不再是空闲普通对话，或交接内容不完整。' }
    }
    const id = request.targetSessionId as SessionId
    const owners = workspaces.filter(workspace => workspace.sessionIds.includes(request.sourceSessionId as SessionId))
    if (owners.length > 1) {
      return { kind: 'rejected', retryable: true, message: en
        ? 'The source has conflicting workspace ownership. No Team conversation was created.'
        : '原会话的工作区归属冲突，未创建团队会话。' }
    }
    // workspaceId creation replaces cwd with workspace.path. The public API
    // cannot attach an arbitrary cwd afterwards; even internal attach requires
    // exact canonical-directory equality. Do not infer realpath aliases here.
    if (owners[0] !== undefined && directorySpelling(owners[0].path) !== directorySpelling(source.cwd!)) {
      return { kind: 'rejected', retryable: true, message: en
        ? 'The conversation directory differs from its workspace root. This Host cannot preserve both the directory and workspace ownership; no Team conversation was created.'
        : '原会话目录与所属工作区根目录不一致。当前 Host 无法同时保留该目录与项目归属，未创建团队会话。' }
    }
    // The Host resolves the canonical directory and durably attaches on this
    // create path. Passing cwd as well is invalid; never fall back after failure.
    const location = owners[0] === undefined ? { cwd: source.cwd! } : { workspaceId: owners[0].workspaceId }
    // create is idempotent for this ID; prompt is not. The caller persists the ID before this call.
    const created = await api.sessions.create({ sessionId: id, ...location, agentPreset: 'yuqi-team' })
    if (!created.result.ok) {
      const error = created.result.error
      const definitelyNotCreated = ['agent-preset-not-found', 'agent-preset-invalid', 'invalid-params'].includes(error.code)
      return { kind: definitelyNotCreated ? 'rejected' : 'unknown',
        retryable: definitelyNotCreated, sessionId: id, message: error.message }
    }
    if (created.result.value.sessionId !== id || created.result.value.agentPreset !== 'yuqi-team') {
      return { kind: 'unknown', sessionId: id, message: en
        ? 'The Host did not confirm the requested Team conversation identity and preset. No prompt was sent.'
        : 'Host 未确认请求的团队会话标识与模式，未发送任务消息。' }
    }
    const text = en
      ? `Use Team mode to carry out the following task. Keep the original conversation unchanged.\n\nTask goal:\n${request.context.goal}\n\nUser-confirmed context:\n${request.context.summary || '(none)'}`
      : `请使用团队模式执行以下任务，保留原对话不变。\n\n任务目标：\n${request.context.goal}\n\n用户确认的上下文摘要：\n${request.context.summary || '（无）'}`
    try {
      const prompted = await api.sessions.prompt({ sessionId: id, mode: 'queue', content: [{ type: 'text', text }] })
      if (!prompted.result.ok) {
        await openHandoffTarget(ctx, id)
        return { kind: 'created', sessionId: id, message: prompted.result.error.message }
      }
    } catch {
      await openHandoffTarget(ctx, id)
      return { kind: 'unknown', sessionId: id, message: en
        ? 'The conversation was created, but message delivery is unknown. Inspect it before resending.'
        : '会话已创建，但消息投递结果未知，请检查目标会话，不要重复发送。' }
    }
    const opened = await openHandoffTarget(ctx, id)
    return { kind: opened ? 'opened' : 'created', sessionId: id, message: en
      ? 'The task message was accepted. This does not mean the Team task has completed.'
      : '任务消息已受理；这不代表团队任务已经完成。' }
  }
}
