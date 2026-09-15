import { useEffect, useId, useRef, useState } from 'react'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { createRequestId, primaryTeamAction, recoverAndContinueCommandLine, teamActionLabel, teamCommandLine, type YuqiCommand } from './command-actions.ts'
import { useYuqiLocale } from './client-locale.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { TeamPauseControl } from './TeamPauseControl.tsx'

export interface TeamControlsProps {
  readonly teamId: string
  readonly controllerSessionId?: string | undefined
  readonly status: TeamConsoleSummary['team']['status']
  readonly userDecisionCount?: number | undefined
  readonly planConfirmationPending?: boolean | undefined
  readonly cancellationRequested?: boolean | undefined
  readonly manualOwnershipHeld?: boolean | undefined
  readonly hasDispatchableWork?: boolean | undefined
  readonly compact?: boolean | undefined
  readonly hidePause?: boolean | undefined
  readonly command?: YuqiCommand | undefined
  readonly disablePlanConfirmation?: (() => Promise<boolean>) | undefined
}

/** Small command surface; durable projection remains the only source of state. */
export function TeamControls({
  teamId, controllerSessionId, status, userDecisionCount, planConfirmationPending = false,
  cancellationRequested = false,
  manualOwnershipHeld = false,
  hasDispatchableWork = true,
  compact = false, hidePause = false, command, disablePlanConfirmation,
}: TeamControlsProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const guidanceId = useId()
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preferenceSaved, setPreferenceSaved] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{
    readonly message: string
    readonly teamId: string
    readonly controllerSessionId: string
    readonly status: TeamConsoleSummary['team']['status']
    readonly requestId: string
    readonly waitForStateChange: boolean
  } | null>(null)
  const projectionIdentity = `${teamId}\u0000${controllerSessionId ?? ''}\u0000${status}\u0000${cancellationRequested}\u0000${planConfirmationPending}\u0000${userDecisionCount ?? 0}\u0000${manualOwnershipHeld}`
  const projectionIdentityRef = useRef({ identity: projectionIdentity })
  if (projectionIdentityRef.current.identity !== projectionIdentity) projectionIdentityRef.current = { identity: projectionIdentity }
  const operationRef = useRef<object | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  // Recovery must not override an already persisted cancellation intent.
  const canRecover = status === 'needs_reconciliation' && !cancellationRequested && !manualOwnershipHeld
  const canRecheckStop = status === 'needs_reconciliation' && cancellationRequested
  const hasUserDecision = (userDecisionCount ?? 0) > 0
  const primary = status === 'pausing' || status === 'needs_reconciliation' || hasUserDecision || cancellationRequested || manualOwnershipHeld
    || (status === 'paused' && !planConfirmationPending && !hasDispatchableWork)
    ? undefined
    : primaryTeamAction(status)
  const showStartChoice = planConfirmationPending && primary === 'resume'
  const awaitingStart = showStartChoice && notice !== null
  const canCancel = !cancellationRequested && (status === 'running' || status === 'pausing' || status === 'paused' || status === 'needs_reconciliation')
  const terminalNotice = status === 'cancelled' ? (en ? 'The Team is cancelled; no further cancellation is needed.' : 'Team 已取消，无需再次取消。') : undefined
  const transitionNotice = cancellationRequested || status === 'cancelling'
    ? (en ? 'Cancellation requested. New tasks will not start; waiting to confirm all execution has stopped.' : '已请求取消，不再启动新任务；正在等待确认所有执行已停止。')
    : status === 'pausing' ? (en ? 'Pause is already in progress; wait for the durable Team state before retrying.' : 'Team 正在暂停中，请等待持久化状态更新后再操作。') : undefined

  useEffect(() => {
    if (notice === null) return undefined
    if (notice.teamId !== teamId || notice.controllerSessionId !== controllerSessionId || notice.status !== status) {
      setNotice(null)
      return undefined
    }
    // Reconciliation can successfully record observations without changing Team status.
    if (!notice.waitForStateChange) return undefined
    const timer = window.setTimeout(() => {
      setNotice(null)
      setError(en ? `Request ${notice.requestId} has no durable state update yet. Refresh Team state before retrying.` : `请求 ${notice.requestId} 尚未出现持久化状态更新。请刷新 Team 状态后确认是否需要重试。`)
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [controllerSessionId, en, notice, status, teamId])

  useEffect(() => {
    setBusy(false)
    setSaving(false)
    setPreferenceSaved(false)
    setError(null)
    setNotice(null)
    setConfirmCancel(false)
  }, [projectionIdentity])

  async function submit(action: 'pause' | 'resume' | 'cancel' | 'reconcile' | 'recover-continue', allowBusy = false): Promise<boolean> {
    const submittedFor = projectionIdentityRef.current
    if (command === undefined || controllerSessionId === undefined || (!allowBusy && (busy || operationRef.current === submittedFor))
      || (action === 'resume' && awaitingStart)
      || (manualOwnershipHeld && (action === 'resume' || action === 'recover-continue'))) return false
    operationRef.current = submittedFor
    setBusy(true)
    setError(null)
    setNotice(null)
    const requestId = createRequestId()
    try {
      const line = action === 'recover-continue'
        ? recoverAndContinueCommandLine(requestId)
        : teamCommandLine(action, teamId, controllerSessionId, requestId)
      const accepted = await command(line, { teamId, controllerSessionId })
      if (!mountedRef.current || projectionIdentityRef.current !== submittedFor) return false
      if (accepted) {
        setConfirmCancel(false)
        setNotice({
          message: action === 'reconcile'
            ? (en ? 'Stop check finished. The current Team state is shown here; if it still needs reconciliation, see the main conversation for the remaining reason. No tasks were resumed.' : '停止核对已完成，请以当前团队状态为准；如果仍待核对，请查看主控中的具体原因。本次不会恢复执行。')
            : action === 'recover-continue'
            ? (en ? 'Controller recovery submitted. Interrupted work will be safely rechecked; only recoverable work can be redispatched. If no work is dispatchable, the Team remains paused for a task decision.' : '主控恢复已提交：将安全核对中断现场，只有可恢复工作才会重派；若没有可派发工作，团队会保持暂停，等待任务决策。')
            : action === 'resume'
              ? (en ? 'Continue request submitted. The Team runs only when dispatchable work is available; otherwise it remains paused and requires a task decision.' : '继续请求已提交。只有存在可派发工作时团队才会运行；否则会保持暂停，等待任务决策。')
              : (en ? 'Request submitted; waiting for a durable state update.' : '请求已提交，等待持久化状态更新。'),
          teamId, controllerSessionId, status, requestId, waitForStateChange: action !== 'reconcile',
        })
      }
      else setError(action === 'recover-continue'
        ? (en ? `Controller recovery rejected: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}.` : `主控恢复未受理：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。`)
        : (en ? `Operation rejected: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}. Check the connection and retry.` : `操作未受理：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。请检查连接后重试。`))
      return accepted
    } catch (cause) {
      if (!mountedRef.current || projectionIdentityRef.current !== submittedFor) return false
      setError(cause instanceof YuqiCommandOutcomeError ? cause.message : action === 'recover-continue'
        ? (en ? `Controller recovery transport failed: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}. Refresh state before retrying.` : `主控恢复传输失败：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。请刷新状态后再重试。`)
        : (en ? `Operation transport failed: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}.` : `操作传输失败：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。`))
      return false
    } finally {
      if (operationRef.current === submittedFor) operationRef.current = null
      if (mountedRef.current && projectionIdentityRef.current === submittedFor) setBusy(false)
    }
  }

  async function startNowAndRemember(): Promise<void> {
    const submittedFor = projectionIdentityRef.current
    if (disablePlanConfirmation === undefined || command === undefined || controllerSessionId === undefined
      || !showStartChoice || busy || awaitingStart || operationRef.current === submittedFor) return
    operationRef.current = submittedFor
    setBusy(true)
    setSaving(true)
    setError(null)
    setNotice(null)
    setPreferenceSaved(false)
    let saved = false
    try {
      saved = await disablePlanConfirmation()
    } catch {
      saved = false
    }
    if (!mountedRef.current || projectionIdentityRef.current !== submittedFor) {
      if (operationRef.current === submittedFor) operationRef.current = null
      return
    }
    setSaving(false)
    if (!saved) {
      operationRef.current = null
      setBusy(false)
      setError(en ? 'Could not save “Always start automatically”. This Team has not started; retry or choose “Confirm plan & start”.' : '无法保存“以后免确认直接启动”；本次 Team 尚未启动，请重试或选择“确认任务图并开始”。')
      return
    }
    setPreferenceSaved(true)
    await submit('resume', true)
  }

  const manualNotice = manualOwnershipHeld && status !== 'cancelled'
    ? (en ? 'A task is under manual control. Open its details and hand it back before continuing the Team.' : '有任务正在人工接管中。请展开该任务详情并交还，再继续团队。') : undefined
  if (hidePause && primary === undefined && !canRecover && !canRecheckStop && !canCancel && transitionNotice === undefined && terminalNotice === undefined && manualNotice === undefined && command !== undefined && error === null) return null

  return (
    <div className={`yuqi-team-controls${compact ? ' yuqi-team-controls-compact' : ''}${showStartChoice ? ' yuqi-start-choice' : ''}`} aria-label={planConfirmationPending ? (en ? 'Choose how to start' : '启动方式待选择') : (en ? 'Team controls' : '团队操作')}>
      {manualNotice === undefined ? null : <p role="status">{manualNotice}</p>}
      {showStartChoice ? (
        <div className="yuqi-plan-confirmation-copy" id={guidanceId}>
          <span className="yuqi-start-capsule">{en ? 'Plan verification pending' : '待核对任务图'}</span>
          <strong>{en ? 'Task execution plan generated' : '已生成任务执行图，请核对分工与依赖'}</strong>
          <span>{en ? 'Review the task cards below. Click “Confirm plan & start” to execute, or choose “Always start automatically” to bypass future confirmation.' : '请核对下方任务分工与依赖关系；确认无误后点击“确认任务图并开始”，也可选择“以后免确认直接启动”。'}</span>
        </div>
      ) : null}
      <div className="yuqi-team-control-actions">
        {!hidePause && !planConfirmationPending ? <TeamPauseControl teamId={teamId} controllerSessionId={controllerSessionId} status={status} cancellationRequested={cancellationRequested} command={command} /> : null}
        {canRecheckStop ? <button type="button" className="yuqi-secondary-action" disabled={command === undefined || controllerSessionId === undefined || busy}
          onClick={() => void submit('reconcile')}>{busy ? (en ? 'Checking…' : '核对中…') : (en ? 'Recheck stop status' : '重新核对停止结果')}</button> : null}
        {primary === undefined || primary === 'pause' ? null : (
          <button
            type="button"
            className="yuqi-primary-action"
            aria-describedby={showStartChoice ? guidanceId : undefined}
            disabled={command === undefined || controllerSessionId === undefined || busy || awaitingStart}
            title={command === undefined || controllerSessionId === undefined ? (en ? 'This conversation cannot control the bound Team' : '当前会话暂不支持已绑定 Team 的命令') : undefined}
            onClick={() => void submit(primary)}
          >
            {busy ? (saving ? (en ? 'Saving preference…' : '保存偏好中…') : (en ? 'Submitting…' : '提交中…')) : planConfirmationPending && primary === 'resume' ? (en ? 'Confirm plan & start' : '确认任务图并开始') : teamActionLabel(primary, locale)}
          </button>
        )}
        {showStartChoice ? (
          <button type="button" className="yuqi-secondary-action"
            aria-describedby={guidanceId}
            disabled={disablePlanConfirmation === undefined || command === undefined || controllerSessionId === undefined || busy || awaitingStart}
            title={disablePlanConfirmation === undefined ? (en ? 'This connection cannot save Team settings' : '当前连接暂不支持保存 Team 设置') : undefined}
            onClick={() => void startNowAndRemember()}>
            {busy ? (saving ? (en ? 'Saving…' : '保存中…') : (en ? 'Starting this Team…' : '正在启动本次…')) : (en ? 'Always start automatically' : '以后免确认直接启动')}
          </button>
        ) : null}
        {canRecover ? (
          <button
            type="button"
            className="yuqi-primary-action"
            disabled={command === undefined || controllerSessionId === undefined || busy}
            title={en ? 'The main controller safely checks interrupted work, redispatches recoverable tasks, and continues the Team.' : '由主控安全核对中断现场，可恢复时自动重派任务并继续团队。'}
            onClick={() => void submit('recover-continue')}
          >
            {busy ? (en ? 'Recovering…' : '恢复中…') : (en ? 'Recover and continue' : '恢复并继续')}
          </button>
        ) : null}
        {canCancel ? (
          <button
            type="button"
            className="yuqi-secondary-action yuqi-danger-text"
            disabled={command === undefined || controllerSessionId === undefined || busy}
            title={command === undefined || controllerSessionId === undefined ? (en ? 'This conversation cannot control the bound Team' : '当前会话暂不支持已绑定 Team 的命令') : undefined}
            onClick={() => {
              setConfirmCancel(true)
              setError(null)
              setNotice(null)
            }}
          >
            {en ? 'Cancel Team' : '取消团队'}
          </button>
        ) : null}
      </div>
      {confirmCancel && canCancel ? (
        <div className="yuqi-cancel-confirm" role="alertdialog" aria-label={en ? 'Confirm Team cancellation' : '确认取消团队'}>
          <span>{en ? 'Cancel the entire Team? Running and waiting tasks stop; completed records are preserved.' : '确认取消整个 Team？正在运行和等待中的任务都会停止，已完成记录会保留。'}</span>
          <div>
            <button type="button" className="yuqi-danger-action" disabled={busy} onClick={() => void submit('cancel')}>{en ? 'Confirm cancellation' : '确认取消团队'}</button>
            <button type="button" className="yuqi-menu-action" disabled={busy} onClick={() => setConfirmCancel(false)}>{en ? 'Keep Team' : '暂不取消'}</button>
          </div>
        </div>
      ) : null}
      {command === undefined || controllerSessionId === undefined ? <span className="yuqi-command-unavailable" role="status">{en ? 'This conversation is view-only' : '当前会话仅支持查看，暂不可操作'}</span> : null}
      {terminalNotice === undefined ? null : <span className="yuqi-command-unavailable" role="status">{terminalNotice}</span>}
      {transitionNotice === undefined ? null : <span className="yuqi-command-unavailable" role="status">{transitionNotice}</span>}
      {canRecheckStop ? <p className="yuqi-command-unavailable">{en ? 'The cancellation is saved, but the Host has not confirmed every child has stopped. Rechecking reads execution status; it does not resume the Team. Archiving remains unavailable until stopping is confirmed.' : '取消请求已保存，但 Host 尚未确认所有子代理都已停止。重新核对只检查执行状态，不会恢复团队；确认停止前暂不能归档。'}</p> : null}
      {notice === null ? null : <span className="yuqi-command-notice" role="status">{notice.message}</span>}
      {preferenceSaved ? <span className="yuqi-command-notice" role="status">{en ? 'Automatic start preference saved for future Teams. This Team still needs a confirmed state update; if starting fails or is uncertain, check its state before retrying. The saved preference is not rolled back.' : '已保存后续 Team 自动启动偏好。本次是否启动仍以状态更新为准；若启动失败或结果不明，请先核对状态再重试。已保存的偏好不会因此回滚。'}</span> : null}
      {error === null ? null : <span className="yuqi-command-error" role="alert">{error}</span>}
    </div>
  )
}
