import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { createRequestId } from './command-actions.ts'
import { useYuqiLocale } from './client-locale.ts'
import { controllerRecoverySummary, TeamContinuationContext, type ContinuationRejectionReason } from './team-continuation.ts'

function recoveryRejectionText(reason: ContinuationRejectionReason | undefined, en: boolean): string {
  const text: Record<ContinuationRejectionReason, readonly [string, string]> = {
    'request-invalid': ['恢复请求格式无效；未发送。', 'The recovery request was invalid and was not sent.'],
    'request-conflict': ['此请求编号已对应不同内容；未发送。', 'This request ID is already bound to different content and was not sent.'],
    'receipt-unavailable': ['本地回执保护不可用；未发送。', 'Local receipt protection is unavailable; nothing was sent.'],
    'sidecar-unavailable': ['最新 Team 数据暂不可用；请刷新后重试。', 'Latest Team data is unavailable; refresh and try again.'],
    'target-changed': ['Team 绑定或状态已更新；请刷新后重新检查。', 'The Team binding or status changed; refresh and check again.'],
    'recovery-not-required': ['当前 Team 不再需要主控恢复；请刷新确认。', 'This Team no longer requires controller recovery; refresh to confirm.'],
    'recovery-summary-stale': ['待处理任务状态已变化；请刷新后重新检查。', 'The affected task state changed; refresh and check again.'],
    'parent-unavailable': ['原主控会话暂不可用；未发送请求。', 'The bound controller conversation is unavailable; nothing was sent.'],
  }
  return text[reason ?? 'target-changed'][en ? 1 : 0]
}

export function TeamControllerRecovery({ summary }: { readonly summary: TeamConsoleSummary }) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const send = useContext(TeamContinuationContext)
  const source = { sourceTeamId: summary.team.id, sourceControllerSessionId: summary.controllerSessionId ?? '' }
  const recoveryNeeded = summary.team.status === 'paused' && !summary.team.cancellationRequested
    && (summary.team.resumeDisposition === 'decision-required' || (summary.team.resumeDisposition === undefined
      && summary.tasks.some(task => task.status === 'failed' || task.status === 'blocked' || task.attemptStatus === 'unknown')))
  const context = useMemo(() => controllerRecoverySummary(summary), [summary])
  const requestRef = useRef<{ context: string; id: string }>()
  const [busy, setBusy] = useState(false)
  const [openedPending, setOpenedPending] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'notice' | 'error'; text: string }>()
  const contextKey = `${source.sourceTeamId}\u0000${source.sourceControllerSessionId}\u0000${locale}\u0000${context}`
  const [accepted, setAccepted] = useState<{ key: string; id: string }>()
  const [acceptedFresh, setAcceptedFresh] = useState(false)
  const [checkedKey, setCheckedKey] = useState<string>()
  const activeKeyRef = useRef(contextKey)
  activeKeyRef.current = contextKey
  const acceptedId = accepted?.key === contextKey ? accepted.id : undefined
  const checkingReceipt = checkedKey !== contextKey
  const pendingId = summary.controllerSessionId === undefined ? undefined : send?.pending?.(source)
  useEffect(() => {
    let current = true
    setFeedback(undefined)
    setOpenedPending(false)
    setBusy(false)
    setAcceptedFresh(false)
    const check = async () => {
      try {
        const id = await send?.acceptedRecovery?.({ intent: 'recovery', ...source, message: context, locale })
        if (!current) return
        setAccepted(id === undefined ? undefined : { key: contextKey, id })
        setCheckedKey(contextKey)
      } catch {
        if (!current) return
        setAccepted(undefined)
        setCheckedKey(contextKey)
        setFeedback({ kind: 'error', text: en ? 'Could not verify the previous recovery receipt. You can try again safely.' : '无法核对之前的恢复回执；现在可以安全重试。' })
      }
    }
    void check()
    return () => { current = false }
  }, [context, contextKey, locale, send, source.sourceControllerSessionId, source.sourceTeamId])
  if (!recoveryNeeded) return null

  async function submit() {
    if (busy || checkingReceipt || acceptedId !== undefined || send === undefined || summary.controllerSessionId === undefined || pendingId !== undefined) return
    const operationKey = contextKey
    if (requestRef.current?.context !== context) requestRef.current = { context, id: createRequestId() }
    const requestId = requestRef.current.id
    setBusy(true)
    setFeedback(undefined)
    try {
      const outcome = await send({ intent: 'recovery', ...source, requestId, message: context, locale })
      if (outcome === 'accepted') {
        let acceptedReceipt: string | undefined
        try { acceptedReceipt = await send.acceptedRecovery?.({ intent: 'recovery', ...source, message: context, locale }) } catch { acceptedReceipt = undefined }
        if (activeKeyRef.current !== operationKey) return
        setAccepted({ key: contextKey, id: acceptedReceipt ?? requestId })
        setAcceptedFresh(true)
        setCheckedKey(contextKey)
        requestRef.current = undefined
        const opened = await send.openController?.(source) === true
        if (activeKeyRef.current !== operationKey) return
        setFeedback(opened ? undefined : { kind: 'error', text: en
          ? 'The request was queued, but the controller conversation could not be opened automatically.'
          : '请求已排队，但暂时无法自动打开原主控对话。' })
      } else if (outcome === 'unknown') {
        if (activeKeyRef.current !== operationKey) return
        setFeedback({ kind: 'error', text: en ? 'Delivery is uncertain. Open the controller conversation and check this exact request before trying again.' : '投递结果不确定。请打开主控对话核对这条请求，确认前不要重复发送。' })
      } else {
        if (activeKeyRef.current !== operationKey) return
        setFeedback({ kind: 'error', text: recoveryRejectionText(send.rejectionReason?.({ ...source, requestId }), en) })
      }
    } catch {
      if (activeKeyRef.current === operationKey) setFeedback({ kind: 'error', text: en ? 'Delivery is uncertain. Check the controller conversation before trying again.' : '投递结果不确定，请先核对主控对话，勿重复发送。' })
    } finally { if (activeKeyRef.current === operationKey) setBusy(false) }
  }

  async function openPending() {
    if (pendingId === undefined || busy || send === undefined) return
    setBusy(true)
    const operationKey = contextKey
    try {
      const opened = await send.openPending?.(source, pendingId) === true
      if (activeKeyRef.current !== operationKey) return
      setOpenedPending(opened)
      setFeedback(opened ? undefined : { kind: 'error', text: en ? 'The verified controller conversation could not be opened.' : '无法打开已核验的主控对话。' })
    } catch {
      if (activeKeyRef.current === operationKey) { setOpenedPending(false); setFeedback({ kind: 'error', text: en ? 'The verified controller conversation could not be opened.' : '无法打开已核验的主控对话。' }) }
    } finally { if (activeKeyRef.current === operationKey) setBusy(false) }
  }

  async function confirmPending() {
    if (pendingId === undefined || !openedPending || busy || send === undefined) return
    setBusy(true)
    const operationKey = contextKey
    try {
      const confirmed = await send.confirmReceived?.(source, pendingId) === true
      if (activeKeyRef.current !== operationKey) return
      if (confirmed) {
        setAccepted({ key: contextKey, id: pendingId })
        setCheckedKey(contextKey)
        setFeedback({ kind: 'notice', text: en ? 'Marked received after your check; the request was not resent.' : '已按你的核对标记为收到，没有重发请求。' })
      } else setFeedback({ kind: 'error', text: en ? 'The receipt could not be verified; duplicate-send protection remains active.' : '无法核实回执，防重复发送保护仍然生效。' })
    } catch {
      if (activeKeyRef.current === operationKey) setFeedback({ kind: 'error', text: en ? 'The receipt could not be verified; duplicate-send protection remains active.' : '无法核实回执，防重复发送保护仍然生效。' })
    } finally { if (activeKeyRef.current === operationKey) setBusy(false) }
  }

  async function openAccepted() {
    if (busy || send === undefined) return
    setBusy(true)
    const operationKey = contextKey
    try {
      const opened = await send.openController?.(source) === true
      if (activeKeyRef.current === operationKey && !opened) setFeedback({ kind: 'error', text: en ? 'The verified controller conversation could not be opened.' : '无法打开已核验的主控对话。' })
    } catch {
      if (activeKeyRef.current === operationKey) setFeedback({ kind: 'error', text: en ? 'The verified controller conversation could not be opened.' : '无法打开已核验的主控对话。' })
    } finally { if (activeKeyRef.current === operationKey) setBusy(false) }
  }

  const failed = summary.tasks.filter(task => task.status === 'failed').length
  const blocked = summary.tasks.filter(task => task.status === 'blocked').length
  const affected = summary.tasks.filter(task => task.status === 'failed' || task.status === 'blocked' || task.attemptStatus === 'unknown')
  return <section className="yuqi-controller-recovery" aria-label={en ? 'Controller recovery' : '主控恢复处理'}>
    <div><strong>{en ? 'Let the controller handle recovery' : '交给主控统一检查并继续'}</strong>
      <p>{en ? `${failed} failed, ${blocked} blocked. There is no work that can continue directly; the controller must resolve these records first.` : `${failed} 个失败、${blocked} 个阻塞，当前没有可直接继续的工作；需由主控先处理这些记录。`}</p>
      <details><summary>{en ? `View affected tasks (${affected.length})` : `查看待处理任务（${affected.length}）`}</summary><ul>{affected.map(task => <li key={task.taskId}><strong>{task.taskId} · {task.goal}</strong><span>{task.attemptStatus === 'unknown' ? (en ? 'Result needs checking' : '结果待核对') : task.status === 'failed' ? (en ? 'Failed' : '失败') : (en ? 'Waiting on a blocker' : '等待阻塞解除')}</span><small>{task.nextAction}</small></li>)}</ul></details></div>
    {pendingId !== undefined ? <div className="yuqi-controller-recovery-pending"><p>{en ? 'A message to the controller has an uncertain receipt: ' : '有一条发往主控的消息回执尚未确认：'}<code>{pendingId}</code></p>
        <button type="button" className="yuqi-secondary-action" disabled={busy} onClick={() => void openPending()}>{en ? 'Open controller and check' : '打开主控并核对'}</button>
        <button type="button" className="yuqi-secondary-action" disabled={busy || !openedPending} onClick={() => void confirmPending()}>{en ? 'I found this request' : '已找到这条请求'}</button></div>
      : acceptedId !== undefined ? <div className="yuqi-controller-recovery-accepted" role="status"><span>{acceptedFresh
        ? (en ? 'This request was queued for the controller; do not send it again.' : '恢复请求已排队，请勿重复发送。')
        : (en ? 'This recovery request was submitted. Check the controller conversation for its result; do not send it again.' : '恢复请求已提交，请在主控查看结果；请勿重复发送。')}</span><code>{acceptedId}</code>
        <button type="button" className="yuqi-secondary-action" disabled={busy} onClick={() => void openAccepted()}>{en ? 'Open controller conversation' : '打开主控对话'}</button></div>
      : <button type="button" className="yuqi-primary-action" disabled={busy || checkingReceipt || send === undefined || summary.controllerSessionId === undefined} onClick={() => void submit()}>{busy ? (en ? 'Sending…' : '正在发送…') : checkingReceipt ? (en ? 'Checking…' : '正在核对…') : (en ? 'Ask controller to inspect and continue' : '交给主控检查并继续')}</button>}
      <details className="yuqi-recovery-explanation"><summary>{en ? 'How this action works' : '处理方式说明'}</summary><small>{acceptedFresh
        ? (en ? 'One team-level request was queued for the bound controller. It will diagnose the recorded facts, dispatch only necessary follow-up work, and report back; this UI does not retry tasks or change Team state by itself.' : '已向绑定主控排队一条团队级请求。主控会统一诊断已记录事实、仅分派必要后续工作并汇报结果；界面不会自行重试任务，也不会直接改变 Team 状态。')
        : acceptedId !== undefined ? (en ? 'This is a submitted recovery request. Check the bound controller for the result; this UI does not infer queue or execution state.' : '这是已提交的恢复请求，请在绑定主控查看结果；界面不会推断其仍在排队或正在执行。')
        : (en ? 'This sends one request for all affected tasks to the controller. It does not restart tasks by itself.' : '此操作会把待处理任务汇总发送给主控，不会直接重新执行任务。')}</small></details>
    {send !== undefined && summary.controllerSessionId !== undefined ? null : <small className="yuqi-command-unavailable">{en ? 'This connection is view-only and cannot send a recovery request to the controller.' : '当前连接仅支持查看，无法向主控发送恢复请求。'}</small>}
    {feedback === undefined ? null : <p className={feedback.kind === 'error' ? 'yuqi-command-error' : 'yuqi-command-notice'} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
  </section>
}
