import { useEffect, useRef, useState } from 'react'
import type { TeamConsoleTask, TeamConsoleSummary } from '../domain/team-console-contract.ts'
import type { TeamAuthorityMode } from '../domain/team-settings-contract.ts'
import { isModelConfigurableTaskStatus } from '../domain/states.ts'
import { taskStatusMeta } from './status.ts'
import { authorityCommandLine, createRequestId, modelCommandLine, retryCommandLine, stopCommandLine, type YuqiCommand } from './command-actions.ts'
import { formatTokens, presentDuration, presentTaskUsage } from './usage-presentation.ts'
import { useTeamUiPreference } from './team-ui-preferences.ts'
import { TaskFileAudit } from './TaskFileAudit.tsx'
import { TaskFileScopeControl } from './TaskFileScopeControl.tsx'
import { ManualTaskControl } from './ManualTaskControl.tsx'
import { FailedTaskContext } from './FailedTaskContext.tsx'
import { useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { formatAuthorityMode, formatModelRouteBasis, formatModelRouteFallbackReason, formatModelRouteTier, formatVerificationStatus, labelValue, localeLanguageTag } from './i18n.ts'

export function formatTaskModelDisplay(model: string | undefined, locale: YuqiLocale): string {
  const en = locale === 'en'
  if (!model || model.trim() === '') return en ? 'Not configured' : '未配置'
  if (model.startsWith('tier:')) {
    return en ? 'Assigned when execution starts' : '执行时分配模型'
  }
  return model
}

export interface TaskModelOption {
  readonly id: string
  readonly name: string
  readonly providerId?: string | undefined
  readonly providerName?: string | undefined
}

export interface TaskRowProps {
  readonly index: number
  readonly teamId: string
  readonly teamStatus?: TeamConsoleSummary['team']['status']
  readonly cancellationRequested?: boolean
  readonly task: TeamConsoleTask
  readonly controllerSessionId?: string
  readonly onOpenChild: (controllerSessionId: string | undefined, childSessionId: string) => Promise<boolean>
  readonly onArchiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
  readonly command?: YuqiCommand
  readonly nowMs: number
  readonly models?: readonly TaskModelOption[]
  readonly initiallyExpanded?: boolean
  readonly workbenchDetail?: boolean
  readonly onLocateRevisionSource?: (() => void) | undefined
  readonly onShowRecovery?: (() => void) | undefined
}

export function TaskRow({ index, teamId, task, teamStatus, cancellationRequested = false, controllerSessionId, onOpenChild, onArchiveChild, command, nowMs, models, initiallyExpanded = false, workbenchDetail = false, onLocateRevisionSource, onShowRecovery }: TaskRowProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [openError, setOpenError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retryPendingRef = useRef(false)
  const [retryLocked, setRetryLocked] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [retryNotice, setRetryNotice] = useState<string | null>(null)
  const [modelDraft, setModelDraft] = useState(() => selectedModelKey(task, models))
  const [modelBusy, setModelBusy] = useState(false)
  const [authorityDraft, setAuthorityDraft] = useState<TeamAuthorityMode>(task.authorityMode ?? 'write-authorized')
  const [authorityBusy, setAuthorityBusy] = useState(false)
  const [authorityError, setAuthorityError] = useState<string | null>(null)
  const [authorityNotice, setAuthorityNotice] = useState<string | null>(null)
  const [stopConfirm, setStopConfirm] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopFeedback, setStopFeedback] = useState<{ readonly kind: 'notice' | 'error'; readonly text: string } | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  const retryIdentity = `${teamId}\u0000${controllerSessionId ?? ''}\u0000${task.taskId}\u0000${task.attemptOrdinal ?? 0}\u0000${task.attemptCount}\u0000${task.status}\u0000${task.model}\u0000${task.authorityMode ?? 'write-authorized'}\u0000${teamStatus ?? task.manualControl?.teamStatus ?? ''}\u0000${cancellationRequested}`
  const retryIdentityRef = useRef(retryIdentity)
  const effectiveTeamStatus = teamStatus ?? task.manualControl?.teamStatus
  const status = taskStatusMeta(task, locale, effectiveTeamStatus)
  const usage = presentTaskUsage(task.usage, locale)
  const duration = presentDuration(task.duration, nowMs, locale)
  const manuallyHeld = task.manualControl?.ownership?.state === 'human-owned'
  const taskControlBlocked = cancellationRequested || effectiveTeamStatus === 'cancelled' || effectiveTeamStatus === 'completed' || effectiveTeamStatus === 'failed' || effectiveTeamStatus === 'cancelling' || effectiveTeamStatus === 'needs_reconciliation'
  const ownsManualTask = manuallyHeld && task.manualControl?.ownership?.taskId === task.taskId && task.manualControl.teamStatus !== 'cancelled'
  const retryBlockedReason = cancellationRequested ? (en ? 'Stop has been requested.' : '已请求停止，不能重试。')
    : manuallyHeld ? (en ? 'Return manual ownership before retrying.' : '人工持有任务，需要先交还控制权。')
    : effectiveTeamStatus !== 'running' && effectiveTeamStatus !== 'paused' ? (en ? `Team state ${effectiveTeamStatus ?? 'unknown'} does not permit retry. Resolve recovery or the Team decision first.` : `团队状态为 ${effectiveTeamStatus ?? '未知'}，不允许重试；请先处理恢复或团队决策。`)
    : task.attemptStatus === 'unknown' || task.attemptStatus === 'running' || task.attemptStatus === 'dispatching' ? (en ? 'The last attempt has not settled; controller verification is required.' : '上次执行尚未收尾或结果未知，需要主控核对。')
    : command === undefined || controllerSessionId === undefined ? (en ? 'The exact Team controller is unavailable; this view cannot submit commands.' : '当前缺少准确的 Team 主控连接，仅可查看。') : undefined
  const canRetry = retryBlockedReason === undefined && (task.status === 'failed' || task.status === 'cancelled')
  const preference = useTeamUiPreference(teamId)
  const childArchived = task.childSessionId !== undefined && preference.archivedChildIds.includes(task.childSessionId)
  const childTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
  const canStopChild = !taskControlBlocked && task.childSessionId !== undefined && task.status === 'running'
  const dependency = dependencyDescription(task, locale)
  const hasExecutionRecord = task.attemptCount > 0 || task.attemptId !== undefined || task.route !== undefined
    || (task.routeHistory?.length ?? 0) > 0 || task.evidenceRecorded || (task.reportedChangedFiles?.length ?? 0) > 0
  const isPlannedTask = task.attemptOrdinal === undefined && task.childSessionId === undefined && !hasExecutionRecord
  const taskDomId = task.taskId.replaceAll(/[^A-Za-z0-9_-]/gu, '-')
  const detailsId = `yuqi-task-details-${taskDomId}`
  const scopeHelpId = `yuqi-task-scope-help-${taskDomId}`
  const stopDescriptionId = `yuqi-task-stop-description-${taskDomId}`

  useEffect(() => {
    setRetryLocked(false)
  }, [retryIdentity])

  useEffect(() => {
    retryIdentityRef.current = retryIdentity
    setRetrying(false)
    setRetryError(null)
    setRetryNotice(null)
    setOpenError(null)
    setModelDraft(selectedModelKey(task, models))
    setModelBusy(false)
    setAuthorityDraft(task.authorityMode ?? 'write-authorized')
    setAuthorityBusy(false)
    setAuthorityError(null)
    setAuthorityNotice(null)
    setStopConfirm(false)
    setStopping(false)
    setStopFeedback(null)
    setArchiving(false)
    setArchiveError(null)
  }, [retryIdentity, models])

  async function archiveChild() {
    if (task.childSessionId === undefined || onArchiveChild === undefined || childArchived || archiving) return
    setArchiving(true)
    setArchiveError(null)
    try {
      const archived = await onArchiveChild(teamId, task.childSessionId)
      if (!archived) setArchiveError(en ? 'Archiving failed. The child conversation is unchanged.' : '归档失败，子代理会话未发生变化。')
    } catch {
      setArchiveError(en ? 'Archiving failed. The child conversation is unchanged.' : '归档失败，子代理会话未发生变化。')
    } finally {
      setArchiving(false)
    }
  }

  useEffect(() => {
    if (retryNotice === null) return undefined
    const timer = window.setTimeout(() => {
      setRetryNotice(null)
      setRetryError(en ? 'The retry has no durable state update yet. Refresh to confirm.' : '重试请求尚未出现持久化状态更新，请刷新后确认。')
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [en, retryNotice])

  useEffect(() => {
    if (authorityNotice === null) return undefined
    const timer = window.setTimeout(() => {
      setAuthorityNotice(null)
      setAuthorityError(en ? 'The permission change has no durable state update yet. Refresh to confirm.' : '权限切换请求尚未出现持久化状态更新，请刷新后确认。')
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [authorityNotice, en])

  useEffect(() => {
    if (stopFeedback?.kind !== 'notice') return undefined
    const timer = window.setTimeout(() => {
      setStopFeedback({ kind: 'error', text: en ? 'The stop request has no durable state update yet. Refresh to confirm.' : '停止请求尚未出现持久化状态更新，请刷新后确认。' })
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [en, stopFeedback])

  async function retry() {
    if (!canRetry || retryPendingRef.current || retryLocked || retryNotice !== null) return
    if (command === undefined || controllerSessionId === undefined || retrying) return
    retryPendingRef.current = true
    setRetrying(true)
    setRetryError(null)
    setRetryNotice(null)
    const requestId = createRequestId()
    const submittedFor = retryIdentity
    try {
      const accepted = await command(retryCommandLine(task.taskId, requestId), { teamId, controllerSessionId })
      if (retryIdentityRef.current !== submittedFor) return
      if (accepted) { setRetryLocked(true); setRetryNotice(en ? 'Retry submitted; waiting for a durable state update.' : '重试请求已提交，等待持久化状态更新。') }
      else setRetryError(en ? 'Command rejected. Check the connection and retry.' : '命令未受理，请检查连接后重试。')
    } catch (cause) {
      if (retryIdentityRef.current !== submittedFor) return
      if (!(cause instanceof YuqiCommandOutcomeError) || cause.disposition === 'unknown') setRetryLocked(true)
      setRetryError(cause instanceof YuqiCommandOutcomeError ? cause.message : en ? 'Command transport failed and the result is unknown. Refresh the state.' : '命令传输失败，结果未知；请刷新状态。')
    } finally {
      retryPendingRef.current = false
      if (retryIdentityRef.current === submittedFor) setRetrying(false)
    }
  }
  async function openChild(childSessionId: string) {
    const submittedFor = retryIdentity
    try {
      const opened = await onOpenChild(controllerSessionId, childSessionId)
      if (retryIdentityRef.current !== submittedFor) return
      setOpenError(opened ? null : (en ? 'The child Agent conversation address is not ready. Refresh shortly.' : '子代理会话地址尚未就绪，请稍后刷新。'))
    } catch {
      if (retryIdentityRef.current !== submittedFor) return
      setOpenError(en ? 'Failed to open the child Agent conversation. Refresh shortly.' : '子代理会话打开失败，请稍后刷新。')
    }
  }
  async function changeModel() {
    if (taskControlBlocked) return
    const selected = modelOptionFromKey(modelDraft, models)
    if (command === undefined || controllerSessionId === undefined || modelBusy || selected === undefined || modelDraft === selectedModelKey(task, models)) return
    setModelBusy(true)
    setRetryError(null)
    setRetryNotice(null)
    const submittedFor = retryIdentity
    try {
      const requestId = createRequestId()
      const line = selected.providerId === undefined
        ? modelCommandLine(task.taskId, selected.id, requestId)
        : `/yuqi model ${task.taskId} ${selected.providerId} ${selected.id} ${requestId}`
      const accepted = await command(line, { teamId, controllerSessionId })
      if (retryIdentityRef.current !== submittedFor) return
      if (accepted) setRetryNotice(task.status === 'running' ? (en ? 'Model change submitted: the current attempt will stop safely and restart with the new model.' : '换模请求已提交：当前 attempt 将安全停止并用新模型重启。') : (en ? 'Task model submitted; waiting for a durable state update.' : '任务模型已提交，等待持久化状态更新。'))
      else setRetryError(en ? 'Model change rejected. Check Team state and connection.' : '模型切换未受理，请检查 Team 状态与连接。')
    } catch (cause) {
      if (retryIdentityRef.current === submittedFor) setRetryError(cause instanceof YuqiCommandOutcomeError ? cause.message : en ? 'Model change transport failed and the result is unknown. Refresh the state.' : '模型切换传输失败，结果未知；请刷新状态。')
    } finally {
      if (retryIdentityRef.current === submittedFor) setModelBusy(false)
    }
  }
  async function changeAuthority() {
    if (taskControlBlocked) return
    if (command === undefined || controllerSessionId === undefined || authorityBusy || authorityDraft === task.authorityMode) return
    setAuthorityBusy(true)
    setAuthorityError(null)
    setAuthorityNotice(null)
    const submittedFor = retryIdentity
    try {
      const accepted = await command(authorityCommandLine(task.taskId, authorityDraft, createRequestId()), { teamId, controllerSessionId })
      if (retryIdentityRef.current !== submittedFor) return
      if (accepted) setAuthorityNotice(task.status === 'running' ? (en ? 'Permission change submitted: the current attempt will stop safely and restart.' : '权限切换已提交：当前 attempt 将安全停止并重启。') : (en ? 'Task permission submitted; waiting for a durable state update.' : '任务权限已提交，等待持久化状态更新。'))
      else setAuthorityError(en ? 'Permission change rejected. A read-only direct Team cannot be upgraded to write or Full access.' : '权限切换未受理；只读直连 Team 不能升级为写入或 Full access。')
    } catch (cause) {
      if (retryIdentityRef.current === submittedFor) setAuthorityError(cause instanceof YuqiCommandOutcomeError ? cause.message : en ? 'Permission change transport failed and the result is unknown. Refresh the state.' : '权限切换传输失败，结果未知；请刷新状态。')
    } finally {
      if (retryIdentityRef.current === submittedFor) setAuthorityBusy(false)
    }
  }
  async function stopChild() {
    if (command === undefined || controllerSessionId === undefined || !canStopChild || stopping) return
    setStopping(true)
    setStopFeedback(null)
    const submittedFor = retryIdentity
    try {
      const accepted = await command(stopCommandLine(task.taskId, createRequestId()), { teamId, controllerSessionId })
      if (retryIdentityRef.current !== submittedFor) return
      setStopConfirm(false)
      setStopFeedback(accepted
        ? { kind: 'notice', text: en ? 'Stop submitted. The child Agent will end safely and other runnable tasks will continue.' : '停止请求已提交；当前子代理会安全结束，其他可运行任务随后继续调度。' }
        : { kind: 'error', text: en ? 'Stop rejected. Check Team state and connection.' : '停止请求未受理，请检查 Team 状态与连接。' })
    } catch (cause) {
      if (retryIdentityRef.current === submittedFor) {
        setStopFeedback({ kind: 'error', text: cause instanceof YuqiCommandOutcomeError ? cause.message : en ? 'Stop transport failed and the result is unknown. Refresh the state.' : '停止请求传输失败，结果未知；请刷新状态。' })
      }
    } finally {
      if (retryIdentityRef.current === submittedFor) setStopping(false)
    }
  }
  const taskConfiguration = <fieldset disabled={taskControlBlocked} className="yuqi-task-configuration" style={{ minWidth: 0 }} aria-label={en ? 'Task configuration' : '任务配置'}>
    <legend>{en ? 'Task model, permissions and file scope' : '任务模型、权限与文件范围'}</legend>
    <TaskFileScopeControl key={JSON.stringify([teamId, controllerSessionId, task.taskId])} task={task} teamId={teamId}
      controllerSessionId={controllerSessionId} teamStatus={effectiveTeamStatus} cancellationRequested={cancellationRequested} command={command} />
    {taskControlBlocked ? <p>{en ? 'This Team has ended, is stopping, or needs reconciliation. Task configuration and retries are unavailable; records remain readable.' : '团队已结束、正在停止或等待核对，不能修改任务配置或重试；仍可查看记录。'}</p> : null}
          {!manuallyHeld && isModelConfigurableTaskStatus(task.status) && models !== undefined ? (
            <div className="yuqi-task-model-control">
              <label htmlFor={`yuqi-task-model-${task.taskId}`}><span className="yuqi-detail-label">{en ? 'Task model' : '任务模型'}</span>
                <select id={`yuqi-task-model-${task.taskId}`} value={modelDraft} disabled={modelBusy || models.length === 0}
                  onChange={event => setModelDraft(event.currentTarget.value)}>
                  {models.length === 0 ? <option value="">{en ? 'No models available' : '暂无可用模型'}</option> : models.map(model => <option key={modelKey(model)} value={modelKey(model)}>{modelOptionLabel(model)}</option>)}
                </select>
              </label>
              <button type="button" className="yuqi-child-link" disabled={modelBusy || modelDraft === selectedModelKey(task, models) || command === undefined || controllerSessionId === undefined}
                onClick={() => void changeModel()}>{modelBusy ? (en ? 'Switching…' : '切换中…') : task.status === 'running' ? (en ? 'Stop and restart with model' : '停止并换模重启') : task.status === 'failed' || task.status === 'cancelled' ? (en ? 'Apply model and retry' : '应用模型并重试') : (en ? 'Apply model' : '应用模型')}</button>
              {retryNotice === null ? null : <span className="yuqi-command-notice" role="status">{retryNotice}</span>}
              {retryError === null ? null : <span className="yuqi-inline-error" role="alert">{retryError}</span>}
            </div>
          ) : null}
          {!manuallyHeld && isModelConfigurableTaskStatus(task.status) ? (
            <div className="yuqi-task-model-control">
              <label htmlFor={`yuqi-task-authority-${task.taskId}`}><span className="yuqi-detail-label">{en ? 'Task permission' : '任务权限'}</span>
                <select id={`yuqi-task-authority-${task.taskId}`} value={authorityDraft} disabled={authorityBusy}
                  onChange={event => setAuthorityDraft(event.currentTarget.value as TeamAuthorityMode)}>
                  <option value="read-only">{formatAuthorityMode('read-only', locale)}</option>
                  <option value="write-authorized">{formatAuthorityMode('write-authorized', locale)}</option>
                  <option value="full-access">{formatAuthorityMode('full-access', locale)}</option>
                </select>
              </label>
              <button type="button" className="yuqi-child-link" disabled={authorityBusy || authorityDraft === task.authorityMode || command === undefined}
                onClick={() => void changeAuthority()}>{authorityBusy ? (en ? 'Switching…' : '切换中…') : task.status === 'running' ? (en ? 'Stop and switch permission' : '停止并切换权限') : (en ? 'Apply permission' : '应用权限')}</button>
              {authorityNotice === null ? null : <span className="yuqi-command-notice" role="status">{authorityNotice}</span>}
              {authorityError === null ? null : <span className="yuqi-inline-error" role="alert">{authorityError}</span>}
            </div>
          ) : null}
  </fieldset>
  return (
    <article className={workbenchDetail ? 'yuqi-task-detail-v2' : 'yuqi-task-row'} data-yuqi-task-id={task.taskId} tabIndex={-1} aria-label={task.goal} lang={localeLanguageTag(locale)}>
      {workbenchDetail ? <>
        <h3 className="yuqi-task-inspector-title" title={task.goal}>{task.goal.split(/[：:]/u)[0]!.length > 48 ? `${task.goal.slice(0,48)}…` : task.goal.split(/[：:]/u)[0]}</h3>
        <span className={`yuqi-status yuqi-status-${status.tone}`}>{isPlannedTask ? (en ? 'Not started' : '未开始') : status.label}</span>
        <p className="yuqi-task-description">{task.goal}</p>
        <section className="yuqi-detail-progress"><h4>{en ? 'Current progress' : '当前进展'}</h4><p className="yuqi-inspector-next">{task.nextAction}</p>
          {task.status === 'failed' ? <div className="yuqi-failure-actions">
            <button type="button" className="yuqi-secondary-action" disabled={!canRetry || retrying || retryLocked || retryNotice !== null} onClick={() => void retry()}>{retrying ? (en ? 'Submitting…' : '提交中…') : (en ? 'Retry task' : '重试任务')}</button>
            {retryBlockedReason ? <p>{retryBlockedReason}</p> : <p>{en ? 'The host checks attempts, budget, leases and safety gates before retrying. Prior evidence is preserved.' : '提交后仍由 Host 核验尝试次数、预算、文件租约与安全门禁；保留历史证据。'}</p>}
            {onShowRecovery ? <button type="button" className="yuqi-secondary-action" onClick={onShowRecovery}>{en ? 'View Team recovery actions' : '查看团队恢复处理'}</button> : null}
            {retryNotice ? <p role="status">{retryNotice}</p> : null}
            {retryLocked && !retryNotice && !retryError ? <p role="status">{en ? 'The previous request was accepted or its result is unknown. Check the durable task state before another submission.' : '上次请求已受理或结果未知；请核对任务持久化状态后再操作，避免重复提交。'}</p> : null}
            {retryError ? <p role="alert">{retryError}</p> : null}
            <FailedTaskContext key={retryIdentity} task={task} teamId={teamId} controllerSessionId={controllerSessionId} teamStatus={effectiveTeamStatus} reason={retryError ?? retryBlockedReason} en={en} />
          </div> : null}
        </section>
        {task.revisionSource === undefined ? null : <div className="yuqi-task-revision-source">
          <p>{en ? 'Source task: ' : '来源任务：'}<code>{task.revisionSource.taskId}</code></p>
          <p><strong>{task.revisionSource.rootTaskId !== undefined && task.revisionSource.taskId !== task.revisionSource.rootTaskId
            ? (en ? 'Downstream re-verification' : '下游复验') : (en ? 'Linked revision' : '关联修改')}</strong>
            {task.revisionSource.rootTaskId === undefined ? null : <> · {en ? 'Root source: ' : '根来源任务：'}<code>{task.revisionSource.rootTaskId}</code></>}</p>
          {onLocateRevisionSource === undefined ? <span>{en ? 'Source task is not in this loaded Team; no navigation is available.' : '当前 Team 未加载来源任务，无法定位。'}</span>
            : <button type="button" className="yuqi-secondary-action" onClick={onLocateRevisionSource}>{en ? 'Locate source task' : '定位来源任务'}</button>}
        </div>}
         <dl className="yuqi-task-properties">
          <div><dt>{en ? 'Model' : '模型'}</dt><dd>{formatTaskModelDisplay(task.model, locale)}</dd></div>
          <div><dt>{en ? 'Permission' : '权限'}</dt><dd>{formatAuthorityMode(task.authorityMode, locale)}</dd></div>
          {task.dependencies && task.dependencies.length > 0 ? (
            <div><dt>{en ? 'Prerequisites' : '前置依赖'}</dt><dd>{task.dependencies.map(d => d.taskId).join(', ')}</dd></div>
          ) : null}
         </dl>
        <details className="yuqi-task-scope-disclosure">
          <summary>{en ? 'File scope and execution settings' : '文件范围与执行设置'}</summary>
          <dl className="yuqi-task-properties">
          <div><dt>{en ? 'Workspace root' : '工作区根目录'}</dt><dd>{task.manualControl?.workspacePath ?? (en ? 'Not available' : '暂无')}</dd></div>
          <div><dt>{en ? 'File scope' : '文件范围'}</dt><dd>{task.fileScope.length === 0 ? (en ? 'Not declared' : '未声明') : <ul className="yuqi-file-scope-tags">{task.fileScope.map((f, i) => <li key={i}><code>{f}</code></li>)}</ul>}</dd></div>
         </dl>
        {!manuallyHeld && (isModelConfigurableTaskStatus(task.status) || task.status === 'blocked') ? (
          taskConfiguration
        ) : null}
        </details>
      </> : null}
      <details className="yuqi-task-technical" open={workbenchDetail ? manuallyHeld || undefined : true}>
      <summary hidden={!workbenchDetail}>{en ? 'Technical records and manual takeover' : '技术记录与人工接管'}</summary>
      {workbenchDetail ? <ManualTaskControl teamId={teamId} controllerSessionId={controllerSessionId} task={task} command={command} /> : null}
      <div className="yuqi-task-heading">
        <button
          type="button"
          className="yuqi-task-summary"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(value => !value)}
        >
          <span className="yuqi-task-index">{index + 1}</span>
          <span className={`yuqi-status yuqi-status-${status.tone}`}><span aria-hidden="true">{isPlannedTask ? '◇' : status.glyph}</span>{isPlannedTask ? (en ? 'Task plan' : '任务计划') : status.label}</span>
          <strong className="yuqi-task-title">{task.goal}</strong>
          <span className="yuqi-task-more">{en ? 'Details' : '详情'} {expanded ? '⌃' : '⌄'}</span>
        </button>
        {canStopChild ? (
          <button type="button" className="yuqi-task-quick-archive yuqi-task-quick-stop"
            aria-label={en ? `Stop child Agent: ${task.goal}` : `停止子代理：${task.goal}`}
            onClick={() => { setExpanded(true); setStopConfirm(true); setStopFeedback(null) }}>
            {en ? 'Stop' : '停止'}
          </button>
        ) : task.childSessionId === undefined ? null : (
          <button type="button" className="yuqi-task-quick-archive" disabled={childArchived || !childTerminal || onArchiveChild === undefined || archiving}
            title={!childTerminal ? (en ? 'Cannot archive at this stage' : '当前阶段不能归档') : childArchived ? (en ? 'Child Agent conversation is archived' : '子代理会话已归档') : (en ? 'Archive child Agent conversation' : '归档子代理会话')}
            aria-label={en ? `Archive child Agent: ${task.goal}` : `归档子代理：${task.goal}`}
            onClick={() => { void archiveChild() }}>
            {childArchived ? (en ? 'Archived' : '已归档') : archiving ? (en ? 'Archiving…' : '归档中…') : (en ? 'Archive' : '归档')}
          </button>
        )}
      </div>
      {isPlannedTask ? <p className="yuqi-task-plan-note">{en ? 'No child Agent conversation has been created; this is a scheduling plan.' : '尚未创建子代理会话；这只是调度计划。'}</p> : null}
      <div className="yuqi-task-meta">
        <span>{labelValue(en ? 'Role' : '角色', task.modelRole, locale)}</span>
        <span>{labelValue(en ? 'Model' : '模型', formatTaskModelDisplay(task.model, locale), locale)}</span>
        <span>{labelValue(en ? 'Permission' : '权限', formatAuthorityMode(task.authorityMode, locale), locale)}</span>
        <span title={dependency.title}>{dependency.label}</span>
        <span>{task.attemptOrdinal === undefined ? (en ? 'Conversation: not created' : '会话：尚未创建') : labelValue(en ? 'Attempt' : '尝试', `${task.attemptOrdinal}/${task.attemptCount}`, locale)}</span>
        <span className="yuqi-task-token">{usage.tokenLabel}</span>
        <span>{labelValue(en ? 'Duration' : '耗时', duration.label, locale)}</span>
      </div>
      <p className="yuqi-task-next">{labelValue(en ? 'Next' : '下一步', task.nextAction, locale)}</p>
      {task.manualControl?.ownership?.state === 'human-owned' && task.manualControl.teamStatus !== 'cancelled'
        ? <p className="yuqi-task-next">{en ? 'Team held for manual work. Open task details to view or return ownership.' : 'Team 正由人工接管；展开任务详情查看或交还。'}</p> : null}
      {expanded ? (
        <div className="yuqi-task-details" id={detailsId}>
          {!workbenchDetail && !manuallyHeld && (isModelConfigurableTaskStatus(task.status) || task.status === 'blocked') ? taskConfiguration : null}
          {workbenchDetail ? null : <ManualTaskControl teamId={teamId} controllerSessionId={controllerSessionId} task={task} command={command} />}
          <div className="yuqi-detail-line">
            <span className="yuqi-detail-label">{en ? 'Planned change scope' : '计划改动范围'}</span>
            <code>{task.fileScope.length === 0 ? (en ? 'Not declared' : '未声明') : task.fileScope.join(', ')}</code>
            <span className="yuqi-info-wrap">
              <button type="button" className="yuqi-info-button" aria-label={en ? 'Explain planned change scope' : '解释计划改动范围'} aria-describedby={scopeHelpId}>i</button>
              <span className="yuqi-info-tooltip" id={scopeHelpId} role="tooltip">{en ? 'The controller uses this planned scope for parallel scheduling and conflict prediction. It does not limit the files a child Agent may need. File evidence below distinguishes tool results from agent reports; workspace differences alone do not identify their author.' : '这是主控用于并行调度和冲突预判的计划范围，不限制子代理完成任务所需的文件。下方文件证据区分工具结果与模型自报；仅凭工作区差异无法确定修改者。'}</span>
            </span>
          </div>
          <TaskFileAudit sessionId={task.childSessionId} reported={task.reportedChangedFiles}
            executionState={isPlannedTask ? 'not-started' : 'unknown'} hasAttempt={hasExecutionRecord} />
          <div className="yuqi-detail-line">
            <span className="yuqi-detail-label">{en ? 'Evidence status' : '证据状态'}</span>
            <span>{task.evidenceRecorded ? (en ? 'Child Agent settlement evidence recorded' : '已记录子代理结算证据') : (en ? 'Settlement evidence not recorded' : '尚未记录结算证据')}</span>
          </div>
          {task.route === undefined ? null : (
            <div className="yuqi-detail-line">
              <span className="yuqi-detail-label">{en ? 'Actual route' : '实际路由'}</span>
              <code>{task.route.providerId} / {task.route.modelId}</code>
            </div>
          )}
          {task.route?.basis === undefined ? null : (
            <div className="yuqi-detail-line">
              <span className="yuqi-detail-label">{en ? 'Route basis' : '路由依据'}</span>
              <span>{formatModelRouteBasis(task.route.basis, locale)}</span>
            </div>
          )}
          {task.route?.requestedTier === undefined ? null : (
            <div className="yuqi-detail-line">
              <span className="yuqi-detail-label">{en ? 'Requested tier' : '请求等级'}</span>
              <span>{formatModelRouteTier(task.route.requestedTier, locale)}</span>
            </div>
          )}
          {task.route?.fallbackReason === undefined ? null : (
            <div className="yuqi-detail-line">
              <span className="yuqi-detail-label">{en ? 'Fallback' : '回退'}</span>
              <span>{formatModelRouteFallbackReason(task.route.fallbackReason, locale)}</span>
            </div>
          )}
          <div className="yuqi-detail-line yuqi-task-usage">
            <span className="yuqi-detail-label">{en ? 'Token usage' : 'Token 用量'}</span>
            {task.usage.state === 'known' ? (
              <span className="yuqi-task-usage-values">
                <strong>{en ? 'Total' : '总计'} {formatTokens(task.usage.totalTokens, locale)} Token</strong>
                <span>{en ? 'Input' : '输入'} {formatTokens(task.usage.uncachedInputTokens, locale)}</span>
                <span>{en ? 'Output' : '输出'} {formatTokens(task.usage.outputTokens, locale)}</span>
                <span>{en ? 'Cache read' : '缓存读'} {formatTokens(task.usage.cacheReadTokens, locale)}</span>
                <span>{en ? 'Cache write' : '缓存写'} {formatTokens(task.usage.cacheWriteTokens, locale)}</span>
              </span>
            ) : (
              <span>{usage.detailLabel}</span>
            )}
          </div>
          <div className="yuqi-detail-line">
            <span className="yuqi-detail-label">{en ? 'Duration' : '耗时'}</span>
            <span>{duration.label}</span>
          </div>
          {task.verificationStatus === undefined ? null : (
            <div className="yuqi-detail-line">
              <span className="yuqi-detail-label">{en ? 'Verification status' : '验证状态'}</span>
              <span>{formatVerificationStatus(task.verificationStatus, locale)}</span>
            </div>
          )}
          {canRetry && !(workbenchDetail && task.status === 'failed') ? (
            <div className="yuqi-task-command">
              <button
                type="button"
                className="yuqi-child-link"
                disabled={command === undefined || controllerSessionId === undefined || retrying || retryLocked || retryNotice !== null}
                title={command === undefined || controllerSessionId === undefined ? (en ? 'This conversation cannot control the bound Team' : '当前会话暂不支持已绑定 Team 的命令') : undefined}
                onClick={() => void retry()}
              >
                {retrying ? (en ? 'Submitting…' : '提交中…') : (en ? 'Retry task' : '重试任务')}
              </button>
              {command === undefined || controllerSessionId === undefined ? <span className="yuqi-command-unavailable">{en ? 'This conversation is view-only' : '当前会话仅支持查看'}</span> : null}
              {retryNotice === null ? null : <span className="yuqi-command-notice" role="status">{retryNotice}</span>}
              {retryError === null ? null : <span className="yuqi-inline-error" role="alert">{retryError}</span>}
            </div>
          ) : null}
          {task.attemptStatus === 'unknown' && task.attemptId !== undefined ? (
            <div className="yuqi-task-command">
              <span className="yuqi-command-unavailable">{en ? 'This task result is not yet confirmed. Its recorded evidence is preserved for controller review; you do not need to open the child Agent or mark it failed.' : '该任务结果尚未确认；现场记录已保留，需主控核对。无需进入子代理对话或人工判定失败。'}</span>
            </div>
          ) : null}
          {stopConfirm ? (
            <div className="yuqi-task-stop-confirm" role="alertdialog" aria-label={en ? `Confirm stopping child Agent: ${task.goal}` : `确认停止子代理：${task.goal}`} aria-describedby={stopDescriptionId}>
              <span id={stopDescriptionId}>{en ? 'Stopping marks this task cancelled. It does not cancel the Team, and other runnable tasks continue.' : '停止后当前任务会记为已取消；不会取消整个 Team，其他可运行任务会继续。'}</span>
              <button type="button" className="yuqi-child-link yuqi-danger-link" disabled={stopping || command === undefined || controllerSessionId === undefined} onClick={() => void stopChild()}>
                {stopping ? (en ? 'Stopping…' : '停止中…') : (en ? 'Confirm stop' : '确认停止')}
              </button>
              <button type="button" className="yuqi-child-link" disabled={stopping} onClick={() => setStopConfirm(false)}>{en ? 'Keep running' : '暂不停止'}</button>
            </div>
          ) : null}
          {stopFeedback === null ? null : (
            <span className={stopFeedback.kind === 'error' ? 'yuqi-inline-error' : 'yuqi-command-notice'} role={stopFeedback.kind === 'error' ? 'alert' : 'status'}>{stopFeedback.text}</span>
          )}
          {task.childSessionId === undefined ? null : (
            <div className="yuqi-task-command">
              <button type="button" className="yuqi-child-link" disabled={task.status === 'cancelled'} title={task.status === 'cancelled' ? (en ? 'Cancelled; read the retained record in this panel.' : '已取消，请在当前面板查看保留记录。') : undefined} onClick={() => void openChild(task.childSessionId!)}>
                {en ? 'Open child Agent conversation ↗' : '打开子代理会话 ↗'}
              </button>
              <button type="button" className="yuqi-child-link" disabled={childArchived || !childTerminal || onArchiveChild === undefined || archiving}
                title={!childTerminal ? (en ? 'A running child Agent cannot be archived' : '运行中的子代理不能归档') : undefined}
                onClick={() => { void archiveChild() }}>
                {childArchived ? (en ? 'Child Agent conversation archived' : '子代理会话已归档') : archiving ? (en ? 'Archiving…' : '归档中…') : (en ? 'Archive child Agent conversation' : '归档子代理会话')}
              </button>
              {archiveError === null ? null : <span className="yuqi-command-error" role="alert">{archiveError}</span>}
            </div>
          )}
          {workbenchDetail || openError === null ? null : <p className="yuqi-inline-error" role="alert">{openError}</p>}
        </div>
      ) : null}
      </details>
      {workbenchDetail ? <div className="yuqi-detail-child-action">
        <button type="button" className="yuqi-child-link yuqi-inspector-open-child" disabled={task.childSessionId === undefined || task.status === 'cancelled'} onClick={() => task.childSessionId === undefined ? undefined : void openChild(task.childSessionId)}>{en ? 'View child conversation' : '查看子代理对话'}</button>
        {task.status === 'cancelled' ? <p className="yuqi-command-unavailable">{en ? 'Cancelled. Retained records are available above.' : '任务已取消，可在上方查看保留记录。'}</p> : task.childSessionId === undefined ? <p className="yuqi-command-unavailable">{en ? 'A conversation will be available when this task starts.' : '任务开始后可查看子代理对话。'}</p> : null}
        {openError === null ? null : <p className="yuqi-inline-error" role="alert">{openError}</p>}
      </div> : null}
    </article>
  )
}

function modelKey(model: TaskModelOption): string {
  return model.providerId === undefined ? model.id : JSON.stringify([model.providerId, model.id])
}

function modelOptionFromKey(value: string, models: readonly TaskModelOption[] | undefined): TaskModelOption | undefined {
  return models?.find(model => modelKey(model) === value)
}

function selectedModelKey(task: TeamConsoleTask, models: readonly TaskModelOption[] | undefined): string {
  if (task.route !== undefined) {
    const exact = models?.find(model => model.providerId === task.route?.providerId && model.id === task.route?.modelId)
    if (exact !== undefined) return modelKey(exact)
  }
  const exact = models?.find(model => model.id === task.model || (model.providerId !== undefined && `${model.providerId}/${model.id}` === task.model))
  return exact === undefined ? '' : modelKey(exact)
}

function modelOptionLabel(model: TaskModelOption): string {
  const provider = model.providerName ?? model.providerId
  return provider === undefined ? `${model.name} · ${model.id}` : `${provider} · ${model.name} · ${model.id}`
}

function dependencyDescription(task: TeamConsoleTask, locale: YuqiLocale): { readonly label: string; readonly title: string } {
  const en = locale === 'en'
  if (task.dependencies !== undefined && task.dependencies.length > 0) {
    return {
      label: en ? `Waiting for: ${task.dependencies.map(dependency => `${dependency.index === undefined ? dependency.taskId : `Task ${dependency.index}`} “${shortGoal(dependency.goal)}”`).join(', ')}` : `需等待：${task.dependencies.map(dependency => `${dependency.index === undefined ? dependency.taskId : `任务 ${dependency.index}`}「${shortGoal(dependency.goal)}」`).join('、')}`,
      title: en ? `Dispatched after prerequisites finish: ${task.dependencies.map(dependency => dependency.goal).join('; ')}` : `前置任务完成后才会调度：${task.dependencies.map(dependency => dependency.goal).join('；')}`,
    }
  }
  if (task.dependencyCount > 0) return { label: en ? `Prerequisites: ${task.dependencyCount}` : `前置任务：${task.dependencyCount} 项`, title: en ? `${task.dependencyCount} prerequisite(s) must finish first` : `需要先完成 ${task.dependencyCount} 个前置任务` }
  return { label: en ? 'Prerequisites: none' : '前置任务：无', title: en ? 'No prerequisites; this task can be scheduled independently' : '没有前置任务，可独立调度' }
}

function shortGoal(goal: string): string {
  return goal.length > 24 ? `${goal.slice(0, 24)}…` : goal
}
