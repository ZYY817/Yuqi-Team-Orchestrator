import { useEffect, useId, useRef, useState } from 'react'
import type { TeamConsoleTask } from '../domain/team-console-contract.ts'
import { createRequestId, manualReturnCommandLine, teamCommandLine, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { useYuqiLocale } from './client-locale.ts'

/** A projection-confirmed ownership transfer, not a shortcut to child chat. */
export function ManualTaskControl({ teamId, controllerSessionId, task, command }: {
  readonly teamId: string
  readonly controllerSessionId: string | undefined
  readonly task: TeamConsoleTask
  readonly command: YuqiCommand | undefined
}) {
  const en = useYuqiLocale() === 'en'
  const descriptionId = useId()
  const state = task.manualControl
  const ownership = state?.ownership
  const humanOwned = ownership?.state === 'human-owned'
  const mine = humanOwned && ownership.taskId === task.taskId
  const key = `${teamId}:${controllerSessionId}:${task.taskId}:${state?.teamStatus}:${ownership?.acquisitionId}:${ownership?.state}:${state?.canAcquire}`
  const identity = useRef({ key })
  if (identity.current.key !== key) identity.current = { key }
  const pending = useRef<object | null>(null)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { setBusy(false); setFeedback(null); setConfirmed(false); setSummary('') }, [key])
  if (state === undefined) return null
  if (state.teamStatus === 'cancelled') return ownership?.taskId === task.taskId
    ? <p>{en ? 'Team cancelled; scheduling has ended. Manual ownership history is retained; no return action is required.' : 'Team 已取消，调度已终止。人工接管历史保留，无需再交还。'}</p>
    : null
  if (!mine && (['completed', 'cancelled', 'failed'].includes(state.teamStatus) || task.status === 'completed')) return null
  const unavailable = command === undefined || controllerSessionId === undefined || busy

  async function submit(action: 'pause' | 'acquire' | 'return') {
    const token = identity.current
    if (command === undefined || controllerSessionId === undefined || busy || pending.current === token) return
    if (action === 'acquire' && (!state?.canAcquire || !confirmed)) return
    if (action === 'return' && (!mine || !confirmed || summary.trim() === '')) return
    pending.current = token
    setBusy(true)
    setFeedback(null)
    const requestId = createRequestId()
    const line = action === 'pause' ? teamCommandLine('pause', teamId, controllerSessionId, requestId)
      : action === 'acquire' ? `/yuqi manual-acquire ${task.taskId} ${teamId} ${controllerSessionId} ${requestId}`
        : manualReturnCommandLine(task.taskId, teamId, controllerSessionId, ownership!.acquisitionId, summary, requestId)
    try {
      const accepted = await command(line, { teamId, controllerSessionId })
      if (!mounted.current || identity.current !== token) return
      setFeedback(accepted
        ? (en ? 'Request accepted; wait for the ownership or Team state to update. If unchanged, refresh the page and check the main conversation. Do not repeat it.' : '请求已受理；请等待所有权或 Team 状态更新。若一直未更新，请刷新页面并核对主对话，不要重复提交。')
        : (en ? 'Request rejected. Refresh the Team state before retrying; ownership has not been confirmed.' : '请求未受理；请刷新 Team 状态后重试，不能据此确认所有权。'))
      if (!accepted) setBusy(false)
    } catch (error) {
      if (!mounted.current || identity.current !== token) return
      if (error instanceof YuqiCommandOutcomeError && error.disposition === 'rejected') {
        setFeedback(`${en ? 'Request rejected: ' : '请求被拒绝：'}${error.message}`)
        setBusy(false)
        return
      }
      setFeedback(en ? 'Result unknown. Refresh before acting; do not assume ownership changed. Your summary is retained.' : '结果未知，请刷新后确认；不要假定所有权已改变。摘要已保留。')
      // Unknown outcomes remain locked until a fresh projection/remount.
    } finally {
      if (pending.current === token) pending.current = null
    }
  }

  return <section className={`yuqi-task-command yuqi-manual-control${mine ? ' yuqi-manual-return' : ''}`} aria-label={en ? 'Manual task ownership' : '人工接管任务'} aria-busy={busy}>
    <h3>{mine ? (en ? 'Return task to controller' : '交还任务给主控') : (en ? 'Manual takeover' : '人工接管')}</h3>
    <p className="yuqi-manual-lead">{mine ? (en ? 'Describe what you changed and what still needs to be done.' : '人工修改完成后，说明改了什么以及还需要做什么。') : (en ? 'Pause the entire Team and wait for execution to settle before confirming takeover.' : '先暂停整个团队，当前执行收尾后才能确认接管。')}</p>
    <details className="yuqi-manual-safety"><summary>{en ? 'Takeover rules and stopping guidance' : '接管约束与停止说明'}</summary>
    <p id={descriptionId}>{en
      ? 'Manual takeover pauses the entire Team. First request pause and wait for all execution to settle; then confirm takeover. Do not edit before “Human-owned” is shown. Returning ownership keeps the Team paused and does not mark the task complete.'
      : '人工接管会暂停整个 Team。先请求暂停并等待执行停止，再确认接管；显示“人工持有”前不要编辑。交还后保持暂停，不会将任务标为完成。'}</p>
    <p>{en ? 'A pending native question can delay pause indefinitely. Pause requested does not mean takeover. Use the existing stop/cancel controls where available; cancellation ends this Team instead of granting ownership.' : '待处理的原生提问可能使暂停一直等待。请求暂停不等于已接管；可使用现有停止／取消入口（若可用）。取消会终止此 Team，不会授予接管。'}</p>
    </details>
    {state.workspacePath === undefined ? null : <div className="yuqi-manual-workspace"><span>{en ? 'Workspace root' : '工作区根目录'}</span><code>{state.workspacePath}</code><small>{en ? 'Not necessarily the task subproject directory; follow the task file scope.' : '不一定是任务子项目目录，请遵循任务文件范围。'}</small></div>}
    {humanOwned && !mine ? <p role="status">{en ? 'Another task is human-owned. Return it before continuing this Team.' : '另一任务由人工持有，请先交还再继续 Team。'}</p>
      : mine ? <>
        <strong role="status">{state.teamStatus === 'paused'
          ? (en ? 'Human-owned — entire Team paused' : '人工持有——整个 Team 已暂停')
          : (en ? 'Human-owned — Team state is changing; return is unavailable.' : '人工持有——Team 状态正在变化，暂不可交还。')}</strong>
        <label className="yuqi-manual-summary">{en ? 'Changes and remaining work (required)' : '修改及剩余事项（必填）'}
          <textarea rows={5} maxLength={4000} value={summary} disabled={busy} onChange={event => setSummary(event.currentTarget.value)} /></label>
        <small className="yuqi-manual-counter">{summary.length}/4000</small>
        <label className="yuqi-manual-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)} />{en ? 'I have stopped manual edits and want to return ownership.' : '我已停止人工编辑，确认交还所有权。'}</label>
        <button className="yuqi-child-link yuqi-manual-return-submit" type="button" aria-describedby={descriptionId} disabled={unavailable || state.teamStatus !== 'paused' || !confirmed || summary.trim() === ''} onClick={() => void submit('return')}>{en ? 'Return to controller' : '交还主控'}</button>
        <p className="yuqi-manual-return-note">{en ? 'The Team stays paused after return. This does not mean the task has passed acceptance.' : '交还后团队仍保持暂停，不代表任务已验收通过。'}</p>
      </> : state.teamStatus === 'running' ? <button className="yuqi-child-link" type="button" aria-describedby={descriptionId} disabled={unavailable} onClick={() => void submit('pause')}>{en ? 'Pause entire Team for takeover' : '暂停整个 Team 以接管'}</button>
        : state.canAcquire ? <>
          <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked)} />{en ? 'I will edit only this Team workspace; keep the entire Team paused.' : '我仅编辑此 Team 工作区，并保持整个 Team 暂停。'}</label>
          <button className="yuqi-child-link" type="button" aria-describedby={descriptionId} disabled={unavailable || !confirmed} onClick={() => void submit('acquire')}>{en ? 'Confirm manual takeover' : '确认人工接管'}</button>
        </> : <p role="status">{en ? 'Takeover unavailable: wait for confirmed pause, execution settlement and a ready workspace. Resolve recovery first if needed.' : '暂不可接管：请等待确认暂停、执行收尾及工作区就绪；如需恢复检查，请先处理。'}</p>}
    {ownership?.state === 'returned' && ownership.taskId === task.taskId ? <p>{['failed', 'cancelled', 'blocked'].includes(task.status)
      ? (en ? 'Ownership returned; history is preserved. This task needs an explicit retry; continuing the Team alone does not retry it. Retry remains subject to attempt and budget limits. If attempts are exhausted, ask the controller to adjust the task plan or create a new task. Returning ownership is not acceptance or completion.' : '已交还，历史保留。此任务需要显式重试，仅继续 Team 不会重试此任务。重试仍受尝试次数与预算限制；尝试次数已用完时，需要主控调整任务计划或新建任务。交还不代表验收通过或任务完成。')
      : (en ? 'Ownership returned; history is preserved. Continue the paused Team explicitly when ready.' : '已交还，历史保留。准备好后显式继续暂停的 Team。')} {ownership.summary}</p> : null}
    {feedback === null ? null : <p role="status">{feedback}</p>}
  </section>
}
