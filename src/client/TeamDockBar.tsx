import { useEffect, useRef, useState } from 'react'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { createRequestId, teamCommandLine, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { useYuqiLocale } from './client-locale.ts'
import { localeLanguageTag } from './i18n.ts'
import { teamStatusMeta } from './status.ts'
import { presentDuration, presentTeamUsage } from './usage-presentation.ts'
import { teamHasDispatchableWork, teamTaskActionTarget } from './team-execution-actions.ts'
import { TeamPauseControl } from './TeamPauseControl.tsx'

export interface TeamDockBarProps {
  readonly summary: TeamConsoleSummary
  readonly nativeAttentionCount?: number
  readonly command?: YuqiCommand | undefined
  readonly nowMs: number
  readonly expanded: boolean
  readonly onOpen: () => void
  readonly onHide: () => void
  readonly hideLabel: string
  readonly hideTitle: string
  readonly hideText: string
}

/**
 * Pause is directly available here and shares admission with the details.
 * Continue retains the existing plan, ownership and recovery gates.
 */
export function TeamDockBar({ summary, nativeAttentionCount = 0, command, nowMs, expanded, onOpen, onHide, hideLabel, hideTitle, hideText }: TeamDockBarProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const { team, controllerSessionId } = summary
  const usage = presentTeamUsage(summary.usage, locale)
  const duration = presentDuration(team.duration, nowMs, locale)
  const manualOwnershipHeld = summary.tasks.some(task => task.manualControl?.ownership?.state === 'human-owned')
  const canStart = team.planConfirmationPending === true && team.status === 'paused'
    && team.userDecisionCount === 0 && nativeAttentionCount === 0 && !team.cancellationRequested && !manualOwnershipHeld
  const hasDispatchableWork = teamHasDispatchableWork(summary)
  const canContinue = !team.planConfirmationPending && team.status === 'paused' && hasDispatchableWork
    && team.userDecisionCount === 0 && nativeAttentionCount === 0 && !team.cancellationRequested && !manualOwnershipHeld
  const canResume = canStart || canContinue
  const taskActionTarget = teamTaskActionTarget(summary)
  const identity = `${team.id}\u0000${controllerSessionId ?? ''}\u0000${team.status}\u0000${team.planConfirmationPending}\u0000${team.userDecisionCount}\u0000${team.cancellationRequested}\u0000${manualOwnershipHeld}\u0000${nativeAttentionCount}\u0000${hasDispatchableWork}\u0000${taskActionTarget?.taskId ?? ''}`
  const projectionRef = useRef({ identity, generation: 0 })
  if (projectionRef.current.identity !== identity) projectionRef.current = { identity, generation: projectionRef.current.generation + 1 }
  const projection = projectionRef.current
  const operationRef = useRef<typeof projection | null>(null)
  const mountedRef = useRef(true)
  const [busy, setBusy] = useState(false)
  const [waitingForProjection, setWaitingForProjection] = useState(false)
  const [feedback, setFeedback] = useState<{ readonly kind: 'error' | 'notice'; readonly text: string } | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  useEffect(() => {
    operationRef.current = null
    setBusy(false)
    setWaitingForProjection(false)
    setFeedback(null)
  }, [identity])
  useEffect(() => {
    if (!waitingForProjection) return undefined
    const timer = window.setTimeout(() => {
      setWaitingForProjection(false)
      setFeedback({ kind: 'error', text: en
        ? 'Start request has no durable state update yet. Refresh Team state before retrying.'
        : '启动请求尚未出现持久化状态更新。请刷新 Team 状态后再确认是否需要重试。' })
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [en, waitingForProjection])

  async function start(): Promise<void> {
    const submittedFor = projection
    if (!canResume || command === undefined || controllerSessionId === undefined || busy || waitingForProjection || operationRef.current === submittedFor) return
    operationRef.current = submittedFor
    setBusy(true)
    setFeedback(null)
    const requestId = createRequestId()
    try {
      const accepted = await command(teamCommandLine('resume', team.id, controllerSessionId, requestId), { teamId: team.id, controllerSessionId })
      if (!mountedRef.current || projectionRef.current !== submittedFor) return
      if (accepted) {
        setWaitingForProjection(true)
      } else {
        setFeedback({ kind: 'error', text: en
          ? `Start was rejected: Team ${team.id}, request ${requestId}. Check the connection and retry.`
          : `启动未受理：Team ${team.id}，请求 ${requestId}。请检查连接后重试。` })
      }
    } catch (cause) {
      if (!mountedRef.current || projectionRef.current !== submittedFor) return
      setFeedback({ kind: 'error', text: cause instanceof YuqiCommandOutcomeError ? cause.message : (en
        ? `Start transport failed: Team ${team.id}, request ${requestId}. Refresh Team state before retrying.`
        : `启动传输失败：Team ${team.id}，请求 ${requestId}。请刷新 Team 状态后再重试。`) })
    } finally {
      if (operationRef.current === submittedFor) operationRef.current = null
      if (mountedRef.current && projectionRef.current === submittedFor) setBusy(false)
    }
  }

  const hasStarted = team.status !== 'draft' && !team.planConfirmationPending
  const hasUnverifiedExecution = summary.tasks.some(task => task.attemptStatus === 'unknown')
  const recordedRunning = team.status === 'running' && !team.planConfirmationPending && !team.cancellationRequested
    && !hasUnverifiedExecution && summary.tasks.some(task => task.status === 'running' && task.attemptStatus === 'running')
  const status = waitingForProjection
    ? { label: en ? 'Starting…' : '正在启动…', tone: 'active' as const }
    : team.planConfirmationPending ? undefined : teamStatusMeta(team.status, locale)
  const statusFeedback = team.status === 'needs_reconciliation'
    ? (team.cancellationRequested
      ? (en ? 'The stop request is recorded, but Host still needs to verify the execution state. Open tasks to recheck; do not resume.' : '停止请求已记录，但执行状态仍需 Host 核对。请查看任务重新核对，不要继续执行。')
      : team.runningTaskCount > 0 || hasUnverifiedExecution
        ? (en ? 'The execution state needs a safe check. Open tasks to review the recorded facts.' : '执行状态需要安全核对，请查看任务检查已记录事实。')
        : (en ? 'Execution has stopped, but the previous result needs a safe check. Open tasks to review it.' : '执行已停止，但上次结果仍需安全核对。请查看任务检查记录。'))
    : team.status === 'cancelling'
        ? (en ? 'Cancellation is in progress; wait for the durable Team state.' : '取消正在进行，请等待持久化 Team 状态更新。')
        : team.status === 'failed'
          ? (en ? 'Team execution failed. Open tasks for the recorded details and recovery options.' : 'Team 执行失败，请查看任务了解已记录详情和恢复选项。')
          : canStart && (command === undefined || controllerSessionId === undefined)
            ? (en ? 'This conversation is view-only and cannot start the bound Team.' : '当前会话仅支持查看，暂不能启动已绑定 Team。')
            : undefined
  return (
    <section className="yuqi-team-summary yuqi-team-dock-summary" lang={localeLanguageTag(locale)} aria-label={en ? 'Yuqi Team status and actions' : 'Yuqi Team 状态与操作'}>
      <div className="yuqi-team-dock-main">
        <div className="yuqi-team-summary-content">
          <span className="yuqi-team-summary-heading"><strong>{en ? 'Team execution' : '团队执行'}</strong>{status === undefined ? null : <span className={`yuqi-status yuqi-status-${status.tone}`}>
            {recordedRunning ? <span className="yuqi-execution-spinner" role="img" aria-label={en ? 'Recorded execution in progress; not a live heartbeat' : '记录显示执行中，非实时存活检测'} /> : null}{hasUnverifiedExecution && team.status === 'running' ? (en ? 'Execution unverified' : '执行状态待核验') : status.label}</span>}</span>
          <span className="yuqi-team-summary-metrics">
            {hasStarted ? <span className="yuqi-team-metric">{team.completedTaskCount}/{summary.tasks.length} {en ? 'completed' : '已完成'}</span> : <span className="yuqi-team-metric">{summary.tasks.length} {en ? 'tasks' : '项任务'}</span>}
            {hasStarted && (team.status === 'running' || team.status === 'pausing') && !hasUnverifiedExecution && team.runningTaskCount > 0 ? <span className="yuqi-team-metric">{team.runningTaskCount} {en ? 'running' : '执行中'}</span> : null}
            {hasStarted && team.waitingTaskCount > 0 ? <span className="yuqi-team-metric">{team.waitingTaskCount} {en ? 'waiting' : '等待'}</span> : null}
            {team.userDecisionCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-attention">{team.userDecisionCount} {en ? 'need decision' : '需用户决策'}</span> : null}
            {team.controllerActionCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-controller">{team.controllerActionCount} {en ? 'awaiting controller' : '待主控处理'}</span> : null}
            {hasStarted && (summary.usage.state === 'partial' || summary.usage.state === 'known') ? <span className="yuqi-team-usage" title={`${usage.totalLabel} · ${usage.detailLabel}`}>{usage.compactLabel}</span> : null}
            {hasStarted && duration.stateLabel !== (en ? 'Unavailable' : '不可用') ? <span className="yuqi-team-duration">{en ? `Time ${duration.label}` : `耗时 ${duration.label}`}</span> : null}
          </span>
        </div>
        <div className="yuqi-team-dock-actions">
          {!team.planConfirmationPending ? <TeamPauseControl teamId={team.id} controllerSessionId={controllerSessionId} status={team.status} cancellationRequested={team.cancellationRequested} command={command} hideResumeButton /> : null}
          <button type="button" className="yuqi-dock-view-action" {...(team.userDecisionCount + nativeAttentionCount > 0 ? {} : { 'aria-controls': 'yuqi-team-panel', 'aria-expanded': expanded })} aria-label={team.userDecisionCount + nativeAttentionCount > 0
            ? (en ? 'View Team questions' : '查看 Team 待处理问题')
            : !canResume && team.status === 'paused' && taskActionTarget !== undefined
              ? (taskActionTarget.status === 'failed' ? (en ? 'Handle failed task' : '处理失败任务') : (en ? 'View pending issue' : '查看待处理'))
              : (en ? 'Open Yuqi Team task panel' : '打开 Yuqi Team 任务面板')} onClick={onOpen}>{team.userDecisionCount + nativeAttentionCount > 0
                ? (en ? 'View questions' : '查看问题')
                : !canResume && team.status === 'paused' && taskActionTarget !== undefined
                  ? (taskActionTarget.status === 'failed' ? (en ? 'Handle failed task' : '处理失败任务') : (en ? 'View pending issue' : '查看待处理'))
                  : (en ? 'View tasks' : '查看任务')}</button>
          {canResume ? <button type="button" className="yuqi-primary-action yuqi-dock-start" disabled={command === undefined || controllerSessionId === undefined || busy || waitingForProjection}
            title={command === undefined || controllerSessionId === undefined ? (en ? 'This conversation cannot control the bound Team' : '当前会话暂不支持已绑定 Team 的命令') : undefined}
            onClick={() => void start()}>{canStart ? (en ? 'Start' : '开始执行') : (en ? 'Continue' : '继续')}</button> : null}
          <button type="button" className="yuqi-team-hide" aria-label={hideLabel} title={hideTitle} onClick={onHide}>{hideText}</button>
        </div>
      </div>
      {team.userDecisionCount + nativeAttentionCount > 0 ? <div className="yuqi-dock-attention" role="status">
        <span aria-hidden="true" className="yuqi-dock-attention-dot" />
        <div><strong>{en ? `${team.userDecisionCount + nativeAttentionCount} item${team.userDecisionCount + nativeAttentionCount === 1 ? '' : 's'} need your confirmation` : `有 ${team.userDecisionCount + nativeAttentionCount} 项需要你确认`}</strong>
          <small>{summary.attention.find(item => item.owner === 'user')?.message ?? (team.planConfirmationPending ? (en ? 'Review the task plan before execution starts.' : '请在执行前检查任务计划。') : (en ? 'Open the questions to review the recorded reason.' : '打开问题查看已记录的原因。'))}</small></div>
      </div> : null}
      {team.planConfirmationPending && !canStart ? <p className="yuqi-dock-feedback" role="status">{team.userDecisionCount + nativeAttentionCount > 0
        ? (en ? 'A user decision is required before this Team can start.' : '需先处理用户待决策，才能启动 Team。')
        : manualOwnershipHeld ? (en ? 'A task is under manual control. Return it before starting.' : '有任务正在人工接管中，请交还后再启动。')
        : team.cancellationRequested ? (en ? 'Cancellation is recorded; this Team cannot be started.' : '取消意图已记录，不能启动此 Team。')
        : (en ? 'Team state is not ready to start. Open tasks for recovery details.' : '当前 Team 状态不可启动，请查看任务了解恢复详情。')}</p> : null}
      {statusFeedback === undefined ? null : <p className="yuqi-dock-feedback" role="status">{statusFeedback}</p>}
      {feedback === null ? null : <p className={`yuqi-dock-feedback yuqi-command-${feedback.kind === 'error' ? 'error' : 'notice'}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.text}</p>}
    </section>
  )
}
