import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { TeamContinuationContext } from './team-continuation.ts'
import type { TeamConsoleSummary, TeamConsoleTask } from '../domain/team-console-contract.ts'
import { createRequestId, messageCommandLine, type YuqiCommand } from './command-actions.ts'
import { useYuqiLocale } from './client-locale.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { teamStatusMeta } from './status.ts'

type PendingWorkerDelivery = { readonly requestId: string; readonly content: string; readonly target: string }
function workerDeliveryKey(teamId: string, controllerSessionId: string): string { return `yuqi:team-message-pending:v1:${JSON.stringify([teamId, controllerSessionId])}` }
function readPendingWorkerDelivery(teamId: string, controllerSessionId: string): PendingWorkerDelivery | undefined {
  try {
    const raw = localStorage.getItem(workerDeliveryKey(teamId, controllerSessionId))
    if (raw === null) return undefined
    const value = JSON.parse(raw) as Partial<PendingWorkerDelivery>
    return typeof value.requestId === 'string' && typeof value.content === 'string' && typeof value.target === 'string' ? value as PendingWorkerDelivery : undefined
  } catch { return undefined }
}
function writePendingWorkerDelivery(teamId: string, controllerSessionId: string, value: PendingWorkerDelivery | undefined): boolean {
  try {
    const key = workerDeliveryKey(teamId, controllerSessionId)
    if (value === undefined) { localStorage.removeItem(key); return localStorage.getItem(key) === null }
    const serialized = JSON.stringify(value)
    localStorage.setItem(key, serialized)
    return localStorage.getItem(key) === serialized
  } catch { return false }
}

export interface TeamMessageComposerProps {
  readonly teamId: string
  readonly teamStatus: TeamConsoleSummary['team']['status']
  readonly cancellationRequested: boolean
  readonly controllerSessionId?: string
  readonly tasks: readonly TeamConsoleTask[]
  readonly command?: YuqiCommand
  readonly selectedTaskId?: string | undefined
}

export function TeamMessageComposer({ teamId, teamStatus, cancellationRequested, controllerSessionId, tasks, command, selectedTaskId }: TeamMessageComposerProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const statusLabel = teamStatusMeta(teamStatus, locale).label
  const blockedReasonId = useId()
  const runningTasks = useMemo(() => tasks.filter(task => task.status === 'running' && task.childSessionId !== undefined), [tasks])
  const sendContinuation = useContext(TeamContinuationContext)
  const terminal = ['completed', 'failed', 'cancelled'].includes(teamStatus)
  const completedTasks = tasks.filter(task => task.status === 'completed')
  const resolveTarget = (selected?: string) => {
    if (!selected) return 'all'
    if (runningTasks.some(task => task.taskId === selected)) return selected
    if (completedTasks.some(task => task.taskId === selected)) return `completed:${selected}`
    return 'all'
  }
  const [target, setTarget] = useState(() => resolveTarget(selectedTaskId))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const pendingRef = useRef(false)
  const [unknown, setUnknown] = useState(false)
  const [pendingWorkerDelivery, setPendingWorkerDelivery] = useState<PendingWorkerDelivery | undefined>(() => controllerSessionId === undefined ? undefined : readPendingWorkerDelivery(teamId, controllerSessionId))
  const [workerReceiptConfirmed, setWorkerReceiptConfirmed] = useState(false)
  const [includeDependents, setIncludeDependents] = useState(false)
  const [openedReceipt, setOpenedReceipt] = useState<string | undefined>(undefined)
  const [receivedConfirmed, setReceivedConfirmed] = useState(false)
  const requestRef = useRef<{ content: string; target: string; includeDependents: boolean; id: string } | undefined>(undefined)
  const [feedback, setFeedback] = useState<{ readonly kind: 'notice' | 'error'; readonly text: string } | null>(null)
  const identity = `${teamId}\u0000${controllerSessionId ?? ''}`
  const identityRef = useRef({ key: identity })
  if (identityRef.current.key !== identity) identityRef.current = { key: identity }
  const draftSuffix = message !== '' ? (en ? ' Your draft is preserved.' : '；草稿已保留。') : (en ? '' : '。')
  const continuation = terminal || target.startsWith('completed:')
  const pendingIdentity = { sourceTeamId: teamId, sourceControllerSessionId: controllerSessionId ?? '' }
  const pendingRequestId = controllerSessionId === undefined ? undefined : sendContinuation?.pending?.(pendingIdentity)
  const deliveryLocked = unknown || pendingRequestId !== undefined || pendingWorkerDelivery !== undefined
  const receiptWasOpened = pendingRequestId !== undefined && (openedReceipt === pendingRequestId
    || sendContinuation?.wasOpened?.(pendingIdentity, pendingRequestId) === true)
  const blockedReason = cancellationRequested && !terminal
    ? (en ? `Stop has been requested; instructions are disabled.${draftSuffix}` : `已请求停止，暂不可发送补充要求${draftSuffix}`)
    : teamStatus !== 'running' && !(continuation && (terminal || teamStatus === 'paused'))
      ? (en ? `Instructions require a running Team (state: ${statusLabel}).${draftSuffix}` : `仅运行中的团队可接收补充要求（状态：${statusLabel}）${draftSuffix}`)
      : undefined
  const unavailable = (continuation ? sendContinuation === undefined : command === undefined) || controllerSessionId === undefined
  const targetMissing = !continuation && (runningTasks.length === 0 || (target !== 'all' && !runningTasks.some(task => task.taskId === target)))
  const disabled = unavailable || blockedReason !== undefined || targetMissing || busy || deliveryLocked

  useEffect(() => {
    setTarget(resolveTarget(selectedTaskId))
  }, [selectedTaskId])

  useEffect(() => {
    setMessage('')
    setBusy(false)
    setFeedback(null)
    setUnknown(false)
    setIncludeDependents(false)
    setOpenedReceipt(undefined)
    setReceivedConfirmed(false)
    setWorkerReceiptConfirmed(false)
    const restored = controllerSessionId === undefined ? undefined : readPendingWorkerDelivery(teamId, controllerSessionId)
    setPendingWorkerDelivery(restored)
    if (restored !== undefined) {
      setMessage(restored.content)
      setTarget(restored.target)
      setUnknown(true)
    }
    pendingRef.current = false
    requestRef.current = undefined
  }, [teamId, controllerSessionId])

  async function reconcileReceipt(confirm: boolean) {
    if (pendingRequestId === undefined || busy || pendingRef.current || sendContinuation === undefined) return
    if (confirm && (!receiptWasOpened || !receivedConfirmed)) return
    const submittedFor = identityRef.current
    pendingRef.current = true
    setBusy(true)
    try {
      const ok = confirm ? await sendContinuation.confirmReceived?.(pendingIdentity, pendingRequestId)
        : await sendContinuation.openPending?.(pendingIdentity, pendingRequestId)
      if (identityRef.current !== submittedFor) return
      if (!ok) {
        setFeedback({ kind: 'error', text: en ? 'Could not verify the parent or receipt. Delivery remains blocked; no message was resent.' : '无法核实主控对话身份或回执；仍保留投递保护，未重发消息。' })
      } else if (confirm) {
        setUnknown(false)
        setMessage('')
        requestRef.current = undefined
        setOpenedReceipt(undefined)
        setReceivedConfirmed(false)
        setFeedback({ kind: 'notice', text: en ? 'Marked received after your check. The old request will not be resent; this does not confirm tool execution.' : '已按你的核对标记消息收到，不重发旧请求；这不代表工具执行成功。' })
      } else { setOpenedReceipt(pendingRequestId); setReceivedConfirmed(false) }
    } catch {
      if (identityRef.current === submittedFor) setFeedback({ kind: 'error', text: en ? 'Receipt check failed; delivery protection remains in place.' : '回执核对失败，投递保护仍保留。' })
    } finally {
      if (identityRef.current === submittedFor) { pendingRef.current = false; setBusy(false) }
    }
  }

  async function submit() {
    const content = message.trim()
    if (disabled || pendingRef.current || controllerSessionId === undefined || content === '') return
    pendingRef.current = true
    setBusy(true)
    setFeedback(null)
    const submittedFor = identityRef.current
    try {
      if (continuation) {
        if (sendContinuation === undefined) return
        const downstream = !terminal && includeDependents
        if (requestRef.current?.content !== content || requestRef.current.target !== target || requestRef.current.includeDependents !== downstream) {
          requestRef.current = { content, target, includeDependents: downstream, id: createRequestId() }
        }
        const outcome = await sendContinuation({ sourceTeamId: teamId, sourceControllerSessionId: controllerSessionId,
          ...(target.startsWith('completed:') ? { sourceTaskId: target.slice('completed:'.length) } : {}),
          ...(terminal ? {} : { includeDependents: downstream }),
          requestId: requestRef.current.id, message: content, locale })
        if (identityRef.current !== submittedFor) return
        setUnknown(outcome === 'unknown')
        if (outcome === 'accepted') {
          setMessage('')
          requestRef.current = undefined
        }
        setFeedback({ kind: outcome === 'accepted' ? 'notice' : 'error', text: outcome === 'accepted'
          ? (en ? 'Accepted by the controller for planning. No task has been revived or reported complete.' : '主控已受理新要求并将规划后续；未复活原任务，也不代表修改完成。')
          : outcome === 'unknown' ? (en ? 'Delivery unknown. Check the bound main conversation; do not resend from this panel.' : '投递结果未知，请打开绑定主控对话核对；不要在此重复发送。')
            : (en ? 'Not sent. Refresh Team data and check the source before trying again.' : '未发送，请刷新 Team 数据并核对来源后再操作。') })
        return
      }
      if (command === undefined) return
      const requestId = createRequestId()
      const pendingDelivery = { requestId, content, target }
      const existingPending = readPendingWorkerDelivery(teamId, controllerSessionId)
      if (existingPending !== undefined) {
        setPendingWorkerDelivery(existingPending)
        setUnknown(true)
        setMessage(existingPending.content)
        setTarget(existingPending.target)
        setWorkerReceiptConfirmed(false)
        setFeedback({ kind: 'error', text: en ? 'Delivery is unresolved. Check the main conversation before sending again; your draft is preserved.' : '投递结果仍未核实，请先核对主控对话后再操作；草稿已保留。' })
        return
      }
      if (!writePendingWorkerDelivery(teamId, controllerSessionId, pendingDelivery)) {
        setFeedback({ kind: 'error', text: en ? 'Could not save the delivery guard, so the instruction was not sent. Check storage and try again.' : '无法保存投递保护，因此未发送补充要求。请检查存储后重试。' })
        return
      }
      setPendingWorkerDelivery(pendingDelivery)
      const accepted = await command(messageCommandLine(target, content, requestId), { teamId, controllerSessionId })
      if (identityRef.current !== submittedFor) return
      if (accepted) {
        setMessage('')
        setPendingWorkerDelivery(undefined)
        setUnknown(false)
        setWorkerReceiptConfirmed(false)
        writePendingWorkerDelivery(teamId, controllerSessionId, undefined)
        setFeedback({ kind: 'notice', text: en ? 'The request record was saved. Check the team message record in the conversation for each target receipt; interface acceptance does not mean delivery, processing, or a reply.' : '请求记录已保存，请在对话中的团队消息记录核对每个目标的回执；接口受理不代表送达、处理或回复。' })
      } else {
        setPendingWorkerDelivery(undefined)
        setWorkerReceiptConfirmed(false)
        writePendingWorkerDelivery(teamId, controllerSessionId, undefined)
        setFeedback({ kind: 'error', text: en ? 'The instruction was rejected; the task may have just ended. Refresh and retry.' : '补充要求未受理；任务可能刚刚结束，请刷新状态后重试。' })
      }
    } catch (cause) {
      if (identityRef.current !== submittedFor) return
      const uncertain = !(cause instanceof YuqiCommandOutcomeError && cause.disposition === 'rejected')
      setUnknown(uncertain)
      if (!uncertain) {
        setPendingWorkerDelivery(undefined)
        setWorkerReceiptConfirmed(false)
        writePendingWorkerDelivery(teamId, controllerSessionId, undefined)
      }
      setFeedback({ kind: 'error', text: uncertain ? (en ? 'Delivery unknown. Check the main conversation before sending again; your draft is preserved.' : '投递结果未知，请先核对主控对话，勿重复发送；草稿已保留。') : (cause as Error).message })
    } finally {
      if (identityRef.current === submittedFor) { pendingRef.current = false; setBusy(false) }
    }
  }

  return (
    <section className={`yuqi-team-message${disabled && message === '' ? ' yuqi-team-message-muted' : ''}`} aria-label={en ? 'Add Team instruction' : '补充团队要求'}>
      <header>
        <strong>{en ? 'Add instructions / continue changes' : '补充要求／继续修改'}</strong>
        <span>{en ? 'Running workers receive instructions as before. Completed work goes to the bound controller to plan linked revisions or a new follow-up Team; original tasks stay unchanged.' : '运行任务仍接收补充消息；完成任务交给绑定主控规划关联修改，终态团队规划新的后续 Team，不复活原任务。'}</span>
      </header>
      <div className="yuqi-team-message-fields">
        <label>
          <span>{en ? 'Send to' : '发送给'}</span>
          <select aria-label={en ? 'Instruction recipient' : '补充要求接收方'} value={target} disabled={busy || deliveryLocked || (!terminal && (cancellationRequested || !['running', 'paused'].includes(teamStatus)))}
            aria-describedby={blockedReason === undefined ? undefined : blockedReasonId}
            onChange={event => setTarget(event.currentTarget.value)}>
            <option value="all">{terminal ? (en ? 'New follow-up Team' : '新的后续 Team') : (en ? `All running child Agents (${runningTasks.length})` : `全部运行中的子代理（${runningTasks.length}）`)}</option>
            {terminal ? null : runningTasks.map((task, index) => <option key={task.taskId} value={task.taskId}>{en ? `Child Agent ${index + 1}: ${task.goal}` : `子代理 ${index + 1}：${task.goal}`}</option>)}
            {completedTasks.map(task => <option key={`completed:${task.taskId}`} value={`completed:${task.taskId}`}>{en ? 'Continue changes: ' : '继续修改：'}{task.goal}</option>)}
            {target !== 'all' && !target.startsWith('completed:') && !runningTasks.some(task => task.taskId === target)
              ? <option value={target} disabled>{en ? 'Previous worker ended; select a new target' : '原接收任务已结束，请重新选择'}</option> : null}
          </select>
        </label>
        <textarea aria-label={en ? 'Team instruction content' : '补充团队要求内容'} rows={2} maxLength={16_384} value={message}
          placeholder={continuation ? (en ? 'Describe the new requirements for the controller to plan.' : '描述新的要求，由主控规划后续工作。') : (en ? 'Add instructions for running workers.' : '为运行中的任务补充要求。')}
          disabled={disabled} aria-describedby={blockedReason === undefined ? undefined : blockedReasonId}
          onChange={event => setMessage(event.currentTarget.value)} />
        <button type="button" className="yuqi-primary-action" disabled={disabled || message.trim() === ''}
          aria-describedby={blockedReason === undefined ? undefined : blockedReasonId}
          onClick={() => { void submit() }}>{busy ? (en ? 'Sending…' : '发送中…') : (en ? 'Send instruction' : '发送补充要求')}</button>
      </div>
      {pendingRequestId === undefined ? null : <div className="yuqi-continuation-receipt" aria-live="polite">
        <p>{en ? 'Unresolved message request: ' : '待核对的消息请求：'}<code>{pendingRequestId}</code></p>
        <button type="button" className="yuqi-secondary-action" disabled={busy} onClick={() => { void reconcileReceipt(false) }}>{en ? 'Open verified main conversation' : '打开已核验的主控对话'}</button>
        <label><input type="checkbox" disabled={busy || !receiptWasOpened} checked={receivedConfirmed}
          onChange={event => setReceivedConfirmed(event.currentTarget.checked)} />{en ? 'I found this exact requestId and its requirements in the main conversation.' : '我已在主控对话中找到此 requestId 对应的消息及原要求。'}</label>
        <button type="button" className="yuqi-secondary-action" disabled={busy || !receiptWasOpened || !receivedConfirmed} onClick={() => { void reconcileReceipt(true) }}>{en ? 'Confirm received; do not resend' : '确认已收到，不重发'}</button>
        <p>{en ? 'If absent or uncertain, keep this protection and resolve delivery in the main conversation. Absence from loaded history is not proof of non-delivery.' : '未找到或仍不确定时请保留保护，并在主控对话中处理投递问题。已加载历史中未出现，不等于未投递。'}</p>
      </div>}
      {pendingWorkerDelivery === undefined ? null : <div className="yuqi-team-message-receipt" aria-live="polite">
        <p>{en ? 'Unresolved worker message request: ' : '待核对的子代理消息请求：'}<code>{pendingWorkerDelivery.requestId}</code></p>
        <p>{en ? 'Check this exact request in the team message record in the main conversation and the target child conversation. Absence from loaded history is not proof of non-delivery.' : '请在主控对话的团队消息记录和目标子对话中核对此 requestId 对应的请求。已加载历史中未出现，不等于未投递。'}</p>
        <label><input type="checkbox" disabled={busy} checked={workerReceiptConfirmed}
          onChange={event => setWorkerReceiptConfirmed(event.currentTarget.checked)} />{en ? 'I checked this request and will not resend the old message.' : '我已核对该请求，不重发旧消息。'}</label>
        <button type="button" className="yuqi-secondary-action" disabled={busy || !workerReceiptConfirmed}
          onClick={() => {
            if (!workerReceiptConfirmed || pendingWorkerDelivery === undefined || controllerSessionId === undefined) return
            if (!writePendingWorkerDelivery(teamId, controllerSessionId, undefined)) {
              setFeedback({ kind: 'error', text: en ? 'Could not close this review because the delivery guard could not be cleared.' : '无法清除投递保护，本次核对尚未结束。' })
              return
            }
            setPendingWorkerDelivery(undefined)
            setUnknown(false)
            setMessage('')
            setWorkerReceiptConfirmed(false)
            setFeedback({ kind: 'notice', text: en ? 'This review is closed without resending. It does not confirm delivery, processing, or a reply.' : '本次核对已结束，未重发旧消息；这不代表消息已送达、已处理或已有回复。' })
          }}>{en ? 'Close this review' : '结束本次核对'}</button>
      </div>}
      {continuation && !terminal ? <div>
        <label><input type="checkbox" checked={includeDependents} disabled={disabled}
          onChange={event => setIncludeDependents(event.currentTarget.checked)} />{en ? 'Include all completed downstream tasks for re-verification' : '包含全部已完成下游任务进行复验'}</label>
        <p>{en ? 'Off by default. New task calls consume additional tokens. When enabled, downstream copies are created together. Unfinished downstream tasks, active leases, review history or uncertainty can cause rejection. Ask the controller to re-plan; do not blindly retry.' : '默认关闭。新任务调用会额外消耗 Token。开启后统一创建下游复验副本；任一下游未完成、存在活动租约、审查历史或不确定状态时可能被拒绝。请主控重新规划，不要盲目重试。'}</p>
      </div> : null}
      {blockedReason === undefined ? null : <span id={blockedReasonId} className="yuqi-command-unavailable" role="status">{blockedReason}</span>}
      {targetMissing && blockedReason === undefined ? <span role="status">{en ? 'No active recipient selected. Select a completed task to request linked changes.' : '当前没有可用的运行接收方；可选择已完成任务，申请关联修改。'}</span> : null}
      {unavailable ? <span className="yuqi-command-unavailable">{en ? 'This panel is view-only and cannot forward instructions to the controller.' : '当前面板仅支持查看，无法向主控转发要求。'}</span> : null}
      {feedback === null ? null : <span className={feedback.kind === 'error' ? 'yuqi-command-error' : 'yuqi-command-notice'}
        role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</span>}
    </section>
  )
}
