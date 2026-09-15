import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  TeamConsoleProjectSummary,
  TeamConsoleProjectSummaryItem,
  TeamConsoleReview,
  TeamConsoleReviewCheckpoint,
  TeamConsoleSummary,
  TeamConsoleTask,
} from '../domain/team-console-contract.ts'
import { taskNeedsAttention, taskStatusMeta, teamDisplayStatus } from './status.ts'
import { TaskRow, type TaskModelOption } from './TaskRow.tsx'
import { TeamControls } from './TeamControls.tsx'
import { TeamPauseControl } from './TeamPauseControl.tsx'
import { TeamAttentionActions } from './TeamAttentionActions.tsx'
import { TeamMessageComposer } from './TeamMessageComposer.tsx'
import { TeamActivityView } from './TeamActivityView.tsx'
import { ProjectKnowledgeActions, ProjectKnowledgeRefresh } from './ProjectKnowledgeActions.tsx'
import { createRequestId, reviewCommandLine, teamCommandLine, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { DEFAULT_REVIEW_CHECKLIST_PROMPT_EN, DEFAULT_REVIEW_CHECKLIST_PROMPT_ZH } from '../domain/review-policy.ts'
import { formatAttentionMessage, formatBlockedTaskOutcome, formatReviewIndependence, formatReviewSeverity, formatReviewStatus, formatReviewTrigger, formatTaskStatus, localeLanguageTag } from './i18n.ts'
import { teamHasDispatchableWork, teamTaskActionTarget } from './team-execution-actions.ts'
import { TeamControllerRecovery } from './TeamControllerRecovery.tsx'

type Filter = 'all' | 'created' | 'active' | 'planned' | 'attention' | 'completed'

export interface TeamPanelProps {
  readonly recoveryFailed?: boolean
  readonly historyView?: boolean
  readonly summary: TeamConsoleSummary
  readonly onClose: () => void
  readonly onOpenChild: (controllerSessionId: string | undefined, childSessionId: string) => Promise<boolean>
  readonly onArchiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
  readonly command?: YuqiCommand
  readonly disablePlanConfirmation?: () => Promise<boolean>
  readonly nowMs: number
  readonly models?: readonly TaskModelOption[]
}

function TasksNavIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3" width="11" height="10.5" rx="2" />
      <path d="M5.5 6H10.5M5.5 8.5H10.5M5.5 11H8.5" />
    </svg>
  )
}

function ReviewNavIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function TopologyNavIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M18 9v6M6 18h9" />
    </svg>
  )
}

export function TeamPanel({ summary, onClose, onOpenChild, onArchiveChild, command, disablePlanConfirmation, nowMs, models, recoveryFailed = false, historyView = false }: TeamPanelProps) {
  if (historyView) { command = undefined; onArchiveChild = undefined; disablePlanConfirmation = undefined }
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const filters = panelFilters(locale)
  const emptyFilterMessages = panelEmptyMessages(locale)
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState<'tasks' | 'review' | 'activity'>('tasks')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [locateTask, setLocateTask] = useState<{ teamId: string; taskId: string } | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const gate = qualityGatePresentation(summary, locale)
  const recoveryNeeded = summary.team.status === 'needs_reconciliation'
  const controllerRecoveryNeeded = summary.team.status === 'paused' && !summary.team.cancellationRequested
    && (summary.team.resumeDisposition === 'decision-required' || (summary.team.resumeDisposition === undefined
      && summary.tasks.some(task => task.status === 'failed' || task.status === 'blocked' || task.attemptStatus === 'unknown')))
  const teamStatus = teamDisplayStatus(summary.team, locale)
  const hasDispatchableWork = teamHasDispatchableWork(summary)
  const taskActionTarget = teamTaskActionTarget(summary)
  const counts = useMemo(() => ({
    all: summary.tasks.length,
    created: summary.tasks.filter(taskHasCreatedAgent).length,
    active: summary.tasks.filter(task => taskHasCreatedAgent(task) && (task.status === 'running' || task.status === 'verifying')).length,
    planned: summary.tasks.filter(task => !taskHasCreatedAgent(task)).length,
    attention: summary.tasks.filter(task => taskHasCreatedAgent(task) && taskNeedsAttention(task, summary.team.status)).length,
    completed: summary.tasks.filter(task => taskHasCreatedAgent(task) && task.status === 'completed').length,
  }), [summary])
  const tasks = useMemo(() => summary.tasks.filter(task => matches(filter, task, summary.team.status)
    && `${task.goal} ${task.taskId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())), [filter, search, summary.tasks])
  const selectedTask = tasks.find(task => task.taskId === selectedId) ?? tasks[0]
  useEffect(() => {
    if (tasks.length > 0 && !tasks.some(t => t.taskId === selectedId)) {
      setSelectedId(tasks[0]!.taskId)
    }
  }, [tasks, selectedId])
  function selectActivityTask(taskId: string) {
    const task = summary.tasks.find(item => item.taskId === taskId)
    if (task === undefined) return
    setFilter(taskHasCreatedAgent(task) ? 'created' : 'planned')
    setPage('tasks')
    setSearch('')
    setSelectedId(taskId)
    setLocateTask({ teamId: summary.team.id, taskId })
  }
  function openTaskActionTarget() {
    if (taskActionTarget === undefined) return
    setFilter(taskHasCreatedAgent(taskActionTarget) ? 'created' : 'planned')
    setPage('tasks')
    setSearch('')
    setSelectedId(taskActionTarget.taskId)
    setLocateTask({ teamId: summary.team.id, taskId: taskActionTarget.taskId })
  }
  useEffect(() => {
    if (locateTask === null) return
    if (locateTask.teamId !== summary.team.id) { setLocateTask(null); return }
    const row = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-yuqi-task-id]') ?? [])]
      .find(element => element.dataset.yuqiTaskId === locateTask.taskId)
    if (row === undefined) return
    row.focus({ preventScroll: true })
    row.scrollIntoView?.({ block: 'nearest', behavior: 'auto' })
    setLocateTask(null)
  }, [locateTask, tasks, summary.team.id])
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || panel === null) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
        if (element.closest('[hidden]')) return false
        // Native details hides descendants, which must not become trap endpoints.
        for (let parent = element.parentElement; parent !== null && parent !== panel; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open
            && !parent.querySelector(':scope > summary')?.contains(element)) return false
        }
        return true
      })
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])
  return (
    <aside ref={panelRef} id="yuqi-team-panel" className="yuqi-detail-screen" lang={localeLanguageTag(locale)} role="dialog" aria-modal="true" aria-label={en ? 'Yuqi Team task panel' : 'Yuqi Team 任务面板'}>
      <header className="yuqi-detail-screen-header">
        <div className="yuqi-detail-screen-title">
          <span className="yuqi-detail-screen-kicker">{en ? 'Team tasks' : '团队任务'}</span>
          <h2 title={summary.team.title}>{summary.team.title}</h2>
          <p><span className={`yuqi-status yuqi-status-${teamStatus.tone}`}><span aria-hidden="true">{teamStatus.glyph}</span>{teamStatus.label}</span> · {en ? `${summary.tasks.length} tasks` : `${summary.tasks.length} 个任务`}</p>
        </div>
        <div className="yuqi-detail-screen-actions">
          {!historyView && !summary.team.planConfirmationPending ? <TeamPauseControl teamId={summary.team.id} controllerSessionId={summary.controllerSessionId} status={summary.team.status} cancellationRequested={summary.team.cancellationRequested} command={command} /> : null}
          <button type="button" className="yuqi-secondary-action yuqi-detail-return" onClick={onClose}>{historyView ? (en ? 'Back to history' : '返回历史记录') : (en ? 'Back to conversation' : '返回对话')}</button>
          {!historyView ? <details className="yuqi-detail-more">
            <summary>{en ? 'More' : '更多'}</summary>
            <div className="yuqi-detail-more-menu">
              <TeamControls hidePause teamId={summary.team.id} controllerSessionId={summary.controllerSessionId} status={summary.team.status}
                cancellationRequested={summary.team.cancellationRequested}
                manualOwnershipHeld={summary.tasks.some(task => task.manualControl?.ownership?.state === 'human-owned')}
                hasDispatchableWork={hasDispatchableWork}
                userDecisionCount={summary.team.userDecisionCount} planConfirmationPending={summary.team.planConfirmationPending} command={command}
                disablePlanConfirmation={disablePlanConfirmation} />
              {!controllerRecoveryNeeded && summary.team.status === 'paused' && !summary.team.planConfirmationPending && !hasDispatchableWork && taskActionTarget !== undefined ? (
                <button type="button" className="yuqi-secondary-action yuqi-header-task-action" onClick={openTaskActionTarget}>
                  {taskActionTarget.status === 'failed' ? (en ? 'Handle failed task' : '处理失败任务') : (en ? 'View pending issue' : '查看待处理')}
                </button>
              ) : null}
            </div>
          </details> : null}
          <button type="button" className="yuqi-close-button" aria-label={en ? 'Close Team panel' : '关闭团队面板'} onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor" />
            <path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor" />
          </svg>
          </button>
        </div>
      </header>
      <nav className="yuqi-workbench-tabs" aria-label={en ? 'Team pages' : '团队页面'}>
        <button type="button" className={`yuqi-workbench-tab-btn ${page === 'tasks' ? 'active' : ''}`} aria-pressed={page === 'tasks'} aria-controls="yuqi-panel-tasks" onClick={() => setPage('tasks')}>
          <span>{en ? 'Tasks' : '任务'}</span>
        </button>
        <button type="button" className={`yuqi-workbench-tab-btn ${page === 'review' ? 'active' : ''}`} aria-pressed={page === 'review'} aria-controls="yuqi-panel-review" onClick={() => setPage('review')}>
          <span>{en ? 'Review & decisions' : '审查与确认'}</span>
          {summary.team.userDecisionCount > 0 ? (
            <span className="yuqi-count-badge attention">{summary.team.userDecisionCount}</span>
          ) : null}
        </button>
        <button type="button" className={`yuqi-workbench-tab-btn ${page === 'activity' ? 'active' : ''}`} aria-pressed={page === 'activity'} aria-controls="yuqi-panel-activity" onClick={() => setPage('activity')}>
          <span>{en ? 'Progress & evidence' : '进展与证据'}</span>
        </button>
      </nav>
      <div className="yuqi-detail-notices">
        {!historyView && !summary.team.planConfirmationPending && controllerRecoveryNeeded ? (
          <details className="yuqi-detail-recovery">
            <summary>{en ? 'Some task results need checking before work can continue' : '部分任务结果待核实，暂不能继续执行'} <span>{en ? 'View reason' : '查看原因'}</span></summary>
            <TeamControllerRecovery summary={summary} />
          </details>
        ) : null}
        {recoveryFailed && !recoveryNeeded ? <p className="yuqi-detail-inline-error" role="alert">{en ? 'Could not verify task status. Reopen this panel to retry; tasks have not been restarted.' : '任务状态核对失败。可重新打开面板重试；没有重新执行任务。'}</p> : null}
        {recoveryNeeded && !summary.team.planConfirmationPending ? (
          <div className="yuqi-detail-inline-notice" role={recoveryFailed ? 'alert' : 'status'}>
            {recoveryFailed ? <span className="yuqi-command-error">{en ? 'Could not verify task status. Reopen this panel to retry; tasks have not been restarted.' : '任务状态核对失败。可重新打开面板重试；没有重新执行任务。'}</span> : null}
            <span>{summary.team.cancellationRequested
              ? (en ? 'Stop requested; awaiting confirmation.' : '已请求停止，等待确认。')
              : (en ? 'Task status needs checking; execution has not resumed.' : '任务状态尚待核实，尚未恢复执行。')}</span>
          </div>
        ) : null}
      </div>
      <div className="yuqi-workbench-body" tabIndex={0} role="region" aria-label={en ? 'Team details and tasks' : '团队详情与任务'}>
      <div id="yuqi-panel-review" hidden={page !== 'review'} className="yuqi-workbench-page">
        <div className="yuqi-review-single-column">
              {!gate.active || recoveryNeeded ? null : <QualityGateCard gate={gate} review={summary.review} teamId={summary.team.id} status={summary.team.status} cancellationRequested={summary.team.cancellationRequested === true} locale={locale} {...(summary.controllerSessionId === undefined ? {} : { controllerSessionId: summary.controllerSessionId })} {...(command === undefined ? {} : { command })} />}
              {recoveryNeeded ? null : <TeamAttentionActions summary={summary} reviewDecisionVisible={gate.active} {...(command === undefined ? {} : { command })} />}
              <ReviewResultSection review={summary.review} locale={locale} />
              <ReviewActionSection review={summary.review} teamId={summary.team.id} locale={locale} teamStatus={summary.team.status} tasks={summary.tasks} {...(summary.controllerSessionId === undefined ? {} : { controllerSessionId: summary.controllerSessionId })} {...(command === undefined ? {} : { command })} />
        </div>
      </div>
      <div id="yuqi-panel-activity" className="yuqi-workbench-page" hidden={page !== 'activity'}>
        {page === 'activity' ? <TeamActivityView key={summary.team.id} summary={summary} nowMs={nowMs} onSelectTask={selectActivityTask} command={command} /> : null}
      </div>
      <div id="yuqi-panel-tasks" className="yuqi-workbench-page" hidden={page !== 'tasks'}>
      <div className="yuqi-task-workspace-scroll">
      <div className="yuqi-task-master-detail">
      <nav className="yuqi-task-picker" aria-label={en ? 'Select a task' : '选择任务'}>
        <div className="yuqi-task-picker-heading"><span>{en ? 'Tasks' : '任务'} ({tasks.length})</span>
      <details className="yuqi-workbench-filter-details">
        <summary>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          <span>{en ? 'Filter' : '筛选'}</span>
          {filter !== 'all' || search.trim() ? <span className="yuqi-filter-active-dot" title={en ? 'Filter active' : '筛选生效中'} /> : null}
        </summary>
        <div className="yuqi-filter-drawer-content">
          <label className="yuqi-task-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input type="search" value={search} placeholder={en ? 'Search task name or ID…' : '输入任务名称或 ID 快速过滤…'} onChange={event => setSearch(event.currentTarget.value)} />
          </label>
          <nav className="yuqi-filters" aria-label={en ? 'Task filters' : '任务筛选'}>
            {filters.map(item => (
              <button
                key={item.id}
                type="button"
                className={filter === item.id ? 'yuqi-filter-active' : undefined}
                aria-pressed={filter === item.id}
                onClick={() => setFilter(item.id)}
              >
                {item.label} <span>{counts[item.id]}</span>
              </button>
            ))}
          </nav>
          <div className="yuqi-filter-drawer-hint">
            <span>{en ? `${summary.tasks.length} tasks: ${counts.created} active conversations, ${counts.planned} scheduled plans.` : `共 ${summary.tasks.length} 个任务：${counts.created} 个已创建真实会话，${counts.planned} 个仍是调度计划。`}</span>
          </div>
        </div>
      </details>
        </div>
        {tasks.length === 0 ? (
          <div className="yuqi-task-picker-empty">
            <div className="yuqi-task-picker-empty-icon" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="8" y1="12" x2="16" y2="12" />
              </svg>
            </div>
            <p>{search.trim() ? (en ? 'No matching tasks' : '未找到匹配任务') : (en ? 'No tasks in this category' : '当前分类暂无任务')}</p>
            <small>{search.trim() ? (en ? 'Clear or adjust search keywords' : '请尝试更换/清空关键词或切换分类') : (en ? 'Switch filter above to view other tasks' : '请切换上方筛选分类查看其他任务')}</small>
          </div>
        ) : (
          <div className="yuqi-task-picker-list">
            {tasks.map(task => <button type="button" key={task.taskId} aria-label={`${task.goal} ${task.taskId}`} aria-pressed={selectedTask?.taskId === task.taskId} onClick={() => setSelectedId(task.taskId)}>
              <span className="yuqi-picker-index" aria-hidden="true">{summary.tasks.indexOf(task) + 1}</span><strong title={task.goal}>{taskShortTitle(task.goal)}</strong><span className="yuqi-picker-status">{task.manualControl?.ownership?.state === 'human-owned' && task.manualControl.ownership.taskId === task.taskId && task.manualControl.teamStatus !== 'cancelled' ? (en ? 'Human-owned' : '人工持有') : taskStatusMeta(task, locale, summary.team.status).label}</span>
            </button>)}
          </div>
        )}
      </nav>
      <div className="yuqi-task-list yuqi-detail-task-inspector">
        {filter === 'planned' && tasks.length > 0 ? (
          <p className="yuqi-plan-explanation" role="note">{en ? 'These are task plans, not child Agent conversations. Conversations are created only while the Team is running, dependencies are complete, and concurrency slots are available. Independent tasks with non-conflicting file scopes start in parallel.' : '以下是任务计划，不是子代理对话。只有 Team 运行、前置任务完成且并发槽可用时，系统才会创建对应的子代理会话；无依赖且文件范围不冲突的任务会并行启动。'}</p>
        ) : null}
        {tasks.length === 0 ? <p className="yuqi-empty">{search.trim() ? (en ? 'No matching tasks. Clear the search or change the filter.' : '没有匹配的任务，请清空搜索或切换筛选。') : emptyFilterMessages[filter]}</p> : selectedTask === undefined ? null : [selectedTask].map(task => (
          <TaskRow initiallyExpanded workbenchDetail key={`${summary.team.id}:${summary.controllerSessionId ?? ''}:${task.taskId}:${task.attemptOrdinal ?? 0}`} index={summary.tasks.indexOf(task)} teamId={summary.team.id} task={localizedTask(task, locale, summary.team.status)} onOpenChild={onOpenChild} nowMs={nowMs}
            onLocateRevisionSource={task.revisionSource !== undefined && summary.tasks.some(item => item.taskId === task.revisionSource?.taskId)
              ? () => selectActivityTask(task.revisionSource!.taskId) : undefined}
            teamStatus={summary.team.status} cancellationRequested={summary.team.cancellationRequested === true}
            onShowRecovery={!historyView && (recoveryNeeded || controllerRecoveryNeeded) ? () => {
              const disclosure = panelRef.current?.querySelector<HTMLDetailsElement>(controllerRecoveryNeeded ? '.yuqi-detail-recovery' : '.yuqi-detail-more')
              if (disclosure) { disclosure.open = true; disclosure.scrollIntoView({ block: 'nearest' }); disclosure.querySelector('summary')?.focus() }
            } : undefined}
            {...(onArchiveChild === undefined ? {} : { onArchiveChild })}
            {...(summary.controllerSessionId === undefined ? {} : { controllerSessionId: summary.controllerSessionId })}
            {...(command === undefined ? {} : { command })}
            {...(models === undefined ? {} : { models })} />
        ))}
      {!historyView && !summary.team.planConfirmationPending && (summary.tasks.some(task => task.status === 'running') || summary.tasks.some(task => task.status === 'completed')) ? (
        <details className="yuqi-task-composer-disclosure">
          <summary>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>{en ? 'Add instructions / continue changes' : '补充要求／继续修改'}</span>
          </summary>
          <TeamMessageComposer key={`message:${summary.team.id}:${summary.controllerSessionId ?? ''}`} teamId={summary.team.id} tasks={summary.tasks}
            teamStatus={summary.team.status} cancellationRequested={summary.team.cancellationRequested === true}
            selectedTaskId={selectedTask?.taskId}
            {...(summary.controllerSessionId === undefined ? {} : { controllerSessionId: summary.controllerSessionId })}
            {...(command === undefined ? {} : { command })} />
        </details>
      ) : null}
      </div>
      </div>
      </div>
      </div>
      </div>
    </aside>
  )
}

interface QualityGatePresentation {
  readonly active: boolean
  readonly phase: string
  readonly round?: number
  readonly latestDecision?: TeamConsoleReview['decision']
  readonly hostVerification: 'pending' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'unavailable'
  readonly awaitingUserReason?: string
  readonly exhausted: boolean
  readonly checkpoint?: TeamConsoleReviewCheckpoint
}

function QualityGateCard({ gate, review, teamId, status, cancellationRequested, controllerSessionId, command, locale }: {
  readonly gate: QualityGatePresentation
  readonly review: TeamConsoleReview | undefined
  readonly teamId: string
  readonly status: TeamConsoleSummary['team']['status']
  readonly cancellationRequested: boolean
  readonly controllerSessionId?: string
  readonly command?: YuqiCommand
  readonly locale: YuqiLocale
}) {
  const en = locale === 'en'
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ readonly kind: 'notice' | 'error'; readonly text: string } | null>(null)
  const [waiveReason, setWaiveReason] = useState('')
  const [showWaiver, setShowWaiver] = useState(false)
  const requestScope = useRef(0)
  const decisionTarget = gate.checkpoint ?? (review?.candidateEventId === undefined || review.round === undefined ? undefined : {
    reviewId: review.reviewId, candidateEventId: review.candidateEventId, round: review.round,
  })
  const actionable = !cancellationRequested && (status === 'running' || status === 'paused')
  const needsUser = actionable && (gate.checkpoint?.nextOwner === 'user'
    || (gate.checkpoint === undefined && review?.userDecision === undefined
      && (review?.status === 'awaiting_user' || gate.phase === 'awaiting-user' || gate.phase === 'awaiting_user')))

  useEffect(() => {
    requestScope.current += 1
    setBusy(false)
    setResult(null)
    setWaiveReason('')
    setShowWaiver(false)
    return () => { requestScope.current += 1 }
  }, [gate.phase, gate.round, gate.checkpoint?.reviewId, gate.checkpoint?.candidateEventId, review?.reviewId, review?.candidateEventId, review?.userDecision, status, cancellationRequested, teamId, controllerSessionId, locale])

  async function submitDecision(decision: 'retry_review' | 'waive' | 'fail' | 'cancel') {
    if (command === undefined || controllerSessionId === undefined || busy) return
    if (!needsUser || (decision === 'waive' && waiveReason.trim() === '')) return
    if (decision === 'fail' && status !== 'running') return
    const scope = requestScope.current
    const publishResult = (value: NonNullable<typeof result>) => {
      if (requestScope.current === scope) setResult(value)
    }
    const finishRequest = () => {
      if (requestScope.current === scope) setBusy(false)
    }
    if (decision === 'cancel') {
      if (!window.confirm(en ? 'Cancel this Team and stop further work?' : '确认取消 Team 并停止后续工作？')) return
      setBusy(true)
      setResult(null)
      try {
        const submitted = await command(teamCommandLine('cancel', teamId, controllerSessionId, createRequestId()), { teamId, controllerSessionId })
        publishResult(submitted
          ? { kind: 'notice', text: en ? 'Cancellation request sent. Check the Team status for the outcome; work is not yet confirmed stopped.' : '取消请求已发送，请以团队状态为准；尚未确认执行已停止。' }
          : { kind: 'error', text: en ? 'Cancellation was not confirmed. Check the controller message and Team status.' : '未能确认取消请求，请查看主控消息及团队状态。' })
      } catch (error) {
        publishResult({ kind: 'error', text: error instanceof YuqiCommandOutcomeError ? error.message : en ? 'Cancellation outcome is unknown. Check the Team status before retrying.' : '取消结果尚不明确，请核对团队状态后再操作。' })
      } finally { finishRequest() }
      return
    }
    // Older projections exposed only qualityGate.phase. They cannot safely
    // address a durable review-decision command, but re-review remains a
    // supported compatibility action through the legacy review request.
    if (decisionTarget === undefined) {
      if (decision !== 'retry_review') return
      setBusy(true)
      setResult(null)
      const requestId = createRequestId()
      try {
        const accepted = await command(reviewCommandLine(teamId, controllerSessionId, requestId), { teamId, controllerSessionId })
        publishResult(accepted
          ? { kind: 'notice', text: en ? 'Review request sent, not yet confirmed. Check the controller message and review status.' : '审查请求已发送，尚未确认结果；请查看主控消息和审查状态。' }
          : { kind: 'error', text: en ? 'The controller rejected the review request. Refresh the Team state before retrying.' : '主控未受理审查请求，请刷新 Team 状态后重试。' })
      } catch (error) {
        publishResult({ kind: 'error', text: error instanceof YuqiCommandOutcomeError ? error.message : en ? 'The review request could not reach the controller. The UI did not assume any state change.' : '审查请求未能送达主控；界面不会假定状态已改变。' })
      } finally {
        finishRequest()
      }
      return
    }
    if (decision === 'fail' && !window.confirm(en ? 'Fail this Team because the review checkpoint cannot be accepted?' : '确认因无法接受当前审查节点而将 Team 标记为失败？')) return
    setBusy(true)
    setResult(null)
    const requestId = createRequestId()
    try {
      const accepted = await command(reviewDecisionCommandLine(decision, decisionTarget, teamId, controllerSessionId, waiveReason, requestId), { teamId, controllerSessionId })
      publishResult(accepted
        ? { kind: 'notice', text: en ? 'Decision request sent, not yet confirmed. Check the controller message and review status.' : '决定请求已发送，尚未确认结果；请查看主控消息和审查状态。' }
        : { kind: 'error', text: en ? 'The controller rejected this decision. Refresh the Team state before retrying.' : '主控未受理此决定，请刷新 Team 状态后重试。' })
    } catch (error) {
      publishResult({ kind: 'error', text: error instanceof YuqiCommandOutcomeError ? error.message : en ? 'The decision could not reach the controller. The UI did not assume any state change.' : '决定未能送达主控；界面不会假定状态已改变。' })
    } finally {
      finishRequest()
    }
  }

  return (
    <section className={`yuqi-quality-gate${needsUser ? ' yuqi-quality-gate-attention' : ''}`} aria-label={en ? 'Quality gate control' : '质量门主控'}>
      <header>
        <div><strong>{needsUser ? (en ? 'Recommended handling' : '推荐处理') : (en ? 'Automatic review checkpoint' : '关键节点自动审查')}</strong></div>
        <span className="yuqi-review-decision">{!actionable ? (en ? 'Review history' : '审查记录') : needsUser ? (en ? 'Your decision needed' : '需要你决定') : qualityGatePhaseLabel(gate.phase, locale)}</span>
      </header>
      {!needsUser ? <p className="yuqi-gate-next-step">{en ? 'Review status is shown here. Follow updates in the controller conversation; no child conversation is required.' : '这里显示审查进度，请在主对话查看处理进展，无需进入子代理对话。'}</p> : null}
      <details className="yuqi-gate-details">
      <summary>{en ? 'Review details and rework limits' : '审查详情与返工限制'}</summary>
      <dl>
        <div><dt>{en ? 'Review phase' : '审查阶段'}</dt><dd>{needsUser ? (en ? 'Awaiting user' : '等待用户') : qualityGatePhaseLabel(gate.phase, locale)}</dd></div>
        <div><dt>{en ? 'Checkpoint' : '审查节点'}</dt><dd>{gate.checkpoint === undefined ? '—' : checkpointSubjectLabel(gate.checkpoint.subject, locale)}</dd></div>
        <div><dt>{en ? 'Round' : '轮次'}</dt><dd>{gate.round ?? '—'}</dd></div>
        <div><dt>{en ? 'Independence' : '独立性'}</dt><dd>{gate.checkpoint === undefined ? '—' : formatReviewIndependence(gate.checkpoint.independence, locale)}</dd></div>
        <div><dt>{en ? 'Next owner' : '下一责任方'}</dt><dd>{gate.checkpoint === undefined ? '—' : nextOwnerLabel(gate.checkpoint.nextOwner, locale)}</dd></div>
        <div><dt>{en ? 'Latest decision' : '最新结论'}</dt><dd>{gate.latestDecision === undefined ? (en ? 'None yet' : '尚无') : reviewDecisionLabel(gate.latestDecision, locale)}</dd></div>
        <div><dt>{en ? 'Host verification' : 'Host 验证'}</dt><dd>{hostVerificationLabel(gate.hostVerification, locale)}</dd></div>
      </dl>
      {gate.checkpoint === undefined ? null : <div className="yuqi-insight-block">
        <strong>{en ? 'Automatic rework budget' : '自动纠错预算'}</strong>
        <p>{en
          ? `Checkpoint ${gate.checkpoint.automaticRework.checkpointUsed}/${gate.checkpoint.automaticRework.checkpointLimit} used (${gate.checkpoint.automaticRework.checkpointRemaining} remaining); Team ${gate.checkpoint.automaticRework.teamUsed}/${gate.checkpoint.automaticRework.teamLimit} used (${gate.checkpoint.automaticRework.teamRemaining} remaining).`
          : `本节点已用 ${gate.checkpoint.automaticRework.checkpointUsed}/${gate.checkpoint.automaticRework.checkpointLimit}（剩余 ${gate.checkpoint.automaticRework.checkpointRemaining}）；Team 已用 ${gate.checkpoint.automaticRework.teamUsed}/${gate.checkpoint.automaticRework.teamLimit}（剩余 ${gate.checkpoint.automaticRework.teamRemaining}）。`}</p>
        {gate.checkpoint.automaticRework.history.length === 0 ? <small>{en ? 'No automatic rework has been created.' : '尚未创建自动返工。'}</small> : <ul className="yuqi-insight-list">
          {gate.checkpoint.automaticRework.history.map(item => <li key={`${item.taskId}:${item.round}`}><code>{item.taskId}</code> · {en ? 'round' : '轮次'} {item.round} · {formatTaskStatus(item.status, locale)}</li>)}
        </ul>}
      </div>}
      {gate.awaitingUserReason === undefined ? null : <p className="yuqi-gate-next-step">{gate.awaitingUserReason}</p>}
      </details>
      {needsUser ? (
        <div className="yuqi-quality-gate-resolution" aria-busy={busy}>
          <p><strong>{en ? 'What happened' : '发生了什么'}</strong><span>{gate.exhausted
            ? (en ? 'The reviewer still requires changes after the configured automatic rework budget was used.' : '已用完配置的自动返工轮数，但 reviewer 仍要求修改。')
            : gate.latestDecision === 'inconclusive'
              ? (en ? 'The reviewer could not establish a pass from the available evidence.' : '现有证据不足，reviewer 无法确认通过。')
              : gate.awaitingUserReason}</span></p>
          <p><strong>{en ? 'Next step' : '下一步'}</strong><span>{en ? 'Reply in the controller conversation, or request another review here. You can also stop the Team. Accept risk only if you understand the missing evidence.' : '在主对话回复，或在这里重新审查；也可以取消团队。只有理解缺失证据的影响后，才选择接受风险。'}</span></p>
          <div className="yuqi-task-command">
            <button type="button" className="yuqi-primary-action" disabled={command === undefined || controllerSessionId === undefined || busy} onClick={() => { void submitDecision('retry_review') }}>{busy ? (en ? 'Submitting…' : '提交中…') : decisionTarget === undefined ? (en ? 'Request another review' : '再次请求独立审查') : (en ? 'Re-review' : '重新审查')}</button>
            {status !== 'running' ? null : <button type="button" className="yuqi-secondary-action" disabled={decisionTarget === undefined || command === undefined || controllerSessionId === undefined || busy} onClick={() => { void submitDecision('fail') }}>{en ? 'Fail Team' : '标记失败'}</button>}
            <button type="button" className="yuqi-secondary-action" disabled={command === undefined || controllerSessionId === undefined || busy} onClick={() => { void submitDecision('cancel') }}>{en ? 'Cancel Team' : '取消 Team'}</button>
            <button type="button" className="yuqi-secondary-action" aria-expanded={showWaiver} disabled={decisionTarget === undefined || command === undefined || controllerSessionId === undefined || busy} onClick={() => setShowWaiver(value => !value)}>{en ? 'Accept risk…' : '接受风险…'}</button>
          </div>
          {showWaiver ? <>
          <label className="yuqi-settings-field"><span>{en ? 'Waiver reason (required)' : '豁免原因（必填）'}</span><textarea rows={2} value={waiveReason} disabled={busy} onChange={event => setWaiveReason(event.currentTarget.value)} /></label>
          <button type="button" className="yuqi-secondary-action" disabled={decisionTarget === undefined || command === undefined || controllerSessionId === undefined || busy || waiveReason.trim() === ''} onClick={() => { void submitDecision('waive') }}>{en ? 'Waive with reason' : '填写原因并豁免'}</button>
          </> : null}
          {command === undefined || controllerSessionId === undefined ? <span className="yuqi-command-unavailable">{en ? 'This panel is view-only.' : '当前主控面板仅支持查看。'}</span> : null}
          {result === null ? null : <span className={result.kind === 'error' ? 'yuqi-command-error' : 'yuqi-command-notice'} role={result.kind === 'error' ? 'alert' : 'status'}>{result.text}</span>}
        </div>
      ) : null}
    </section>
  )
}

function qualityGatePresentation(summary: TeamConsoleSummary, locale: YuqiLocale): QualityGatePresentation {
  const raw = recordField(summary, 'qualityGate')
  const reviewRecord = summary.review as Readonly<Record<string, unknown>> | undefined
  const phase = summary.reviewCheckpoint?.phase ?? stringField(raw, 'phase') ?? deriveGatePhase(summary)
  const latestDecision = reviewDecisionField(raw, 'latestDecision') ?? summary.review?.decision
  const awaitingUserReason = stringField(raw, 'awaitingUserReason')
    ?? stringField(raw, 'reason')
    ?? (() => {
      const attention = summary.attention.find(item => item.owner === 'user')
      return attention === undefined ? undefined : formatAttentionMessage(attention, locale)
    })()
    ?? (latestDecision === 'inconclusive' ? summary.review?.unverified.join(locale === 'en' ? '; ' : '；') || undefined : undefined)
  const exhausted = booleanField(raw, 'exhausted')
    ?? (phase.includes('exhaust') || (phase.includes('await') && latestDecision === 'changes_required'))
  const round = summary.reviewCheckpoint?.round ?? numberField(raw, 'round') ?? numberField(reviewRecord, 'round')
  return {
    active: booleanField(raw, 'active') ?? (summary.reviewCheckpoint !== undefined || raw !== undefined || summary.review?.trigger === 'quality-gate' || summary.review?.trigger === 'rework-verification'),
    phase,
    ...(round === undefined ? {} : { round }),
    ...(latestDecision === undefined ? {} : { latestDecision }),
    hostVerification: hostVerificationField(raw) ?? deriveHostVerification(summary.tasks),
    ...(awaitingUserReason === undefined || awaitingUserReason === '' ? {} : { awaitingUserReason }),
    exhausted,
    ...(summary.reviewCheckpoint === undefined ? {} : { checkpoint: summary.reviewCheckpoint }),
  }
}

function reviewDecisionCommandLine(decision: 'retry_review' | 'waive' | 'fail' | 'cancel', checkpoint: Pick<TeamConsoleReviewCheckpoint, 'reviewId' | 'candidateEventId' | 'round'>, teamId: string, controllerSessionId: string, reason: string, requestId: string): string {
  const reasonToken = decision === 'waive' ? encodeCommandToken(reason.trim()) : '-'
  return `/yuqi review-decision ${decision} ${checkpoint.reviewId} ${checkpoint.candidateEventId} ${checkpoint.round} ${reasonToken} ${teamId} ${controllerSessionId} ${requestId}`
}

function encodeCommandToken(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function checkpointSubjectLabel(subject: TeamConsoleReviewCheckpoint['subject'], locale: YuqiLocale): string {
  const labels = locale === 'en'
    ? { 'team-plan': 'Team plan', 'task-attempt': 'Task attempt', 'team-completion': 'Team completion', 'failure-escalation': 'Failure escalation' }
    : { 'team-plan': 'Team 计划', 'task-attempt': '任务尝试', 'team-completion': 'Team 完成', 'failure-escalation': '失败升级' }
  return labels[subject]
}

function nextOwnerLabel(owner: TeamConsoleReviewCheckpoint['nextOwner'], locale: YuqiLocale): string {
  const labels = locale === 'en'
    ? { reviewer: 'Reviewer', controller: 'Controller', user: 'User', none: 'None' }
    : { reviewer: 'Reviewer', controller: '主控', user: '用户', none: '无' }
  return labels[owner]
}

function deriveGatePhase(summary: TeamConsoleSummary): string {
  if (summary.team.status === 'completed') return 'complete'
  if (summary.review?.decision === 'pass') return 'passed'
  if (summary.review?.decision === 'inconclusive' || summary.attention.some(item => item.owner === 'user')) return 'awaiting-user'
  if (summary.review?.decision === 'changes_required') return 'rework'
  if (summary.tasks.some(task => task.status === 'verifying')) return 'host-verification'
  if (summary.tasks.some(task => task.status !== 'completed')) return 'task-execution'
  return 'review-pending'
}

function deriveHostVerification(tasks: readonly TeamConsoleTask[]): QualityGatePresentation['hostVerification'] {
  const statuses = tasks.flatMap(task => task.verificationStatus === undefined ? [] : [task.verificationStatus])
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('running')) return 'running'
  if (statuses.includes('pending')) return 'pending'
  if (statuses.length > 0 && statuses.every(status => status === 'passed')) return 'passed'
  return 'unavailable'
}

function recordField(value: object | undefined, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  const field = Reflect.get(value, key)
  return typeof field === 'object' && field !== null ? field as Readonly<Record<string, unknown>> : undefined
}

function stringField(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' && field.trim() !== '' ? field : undefined
}

function numberField(value: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined {
  const field = value?.[key]
  return typeof field === 'number' && Number.isInteger(field) && field >= 0 ? field : undefined
}

function booleanField(value: Readonly<Record<string, unknown>> | undefined, key: string): boolean | undefined {
  const field = value?.[key]
  return typeof field === 'boolean' ? field : undefined
}

function reviewDecisionField(value: Readonly<Record<string, unknown>> | undefined, key: string): TeamConsoleReview['decision'] | undefined {
  const field = value?.[key]
  return field === 'pass' || field === 'changes_required' || field === 'inconclusive' ? field : undefined
}

function hostVerificationField(value: Readonly<Record<string, unknown>> | undefined): QualityGatePresentation['hostVerification'] | undefined {
  const direct = value?.hostVerification
  const status = typeof direct === 'object' && direct !== null ? Reflect.get(direct, 'status') : direct
  return status === 'pending' || status === 'running' || status === 'passed' || status === 'failed' || status === 'inconclusive' || status === 'unavailable' ? status : undefined
}

function qualityGatePhaseLabel(phase: string, locale: YuqiLocale): string {
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    complete: ['已完成', 'Complete'], passed: ['已通过', 'Passed'], 'awaiting-user': ['等待用户', 'Awaiting user'], awaiting_user: ['等待用户', 'Awaiting user'],
    rework: ['返工中', 'Rework'], reworking: ['返工中', 'Reworking'], reviewing: ['审查中', 'Reviewing'], review: ['审查中', 'Reviewing'], 'review-pending': ['等待审查', 'Review pending'],
    'awaiting-controller': ['等待主控', 'Awaiting controller'], satisfied: ['节点已满足', 'Satisfied'],
    'host-verification': ['Host 验证', 'Host verification'], verify: ['Host 验证', 'Host verification'], 'task-execution': ['任务执行', 'Task execution'], disabled: ['未启用', 'Disabled'], off: ['未启用', 'Disabled'],
  }
  const pair = labels[phase]
  return pair === undefined ? phase : pair[locale === 'en' ? 1 : 0]
}

function hostVerificationLabel(status: QualityGatePresentation['hostVerification'], locale: YuqiLocale): string {
  const labels = {
    pending: ['等待中', 'Pending'], running: ['进行中', 'Running'], passed: ['通过', 'Passed'], failed: ['失败', 'Failed'],
    inconclusive: ['结论不足', 'Inconclusive'], unavailable: ['暂无验证证据', 'No verification evidence'],
  } as const
  return labels[status][locale === 'en' ? 1 : 0]
}

const REVIEW_FOCUS_TEMPLATES = [
  {
    id: 'general',
    featured: true,
    label: '通用全面审查',
    enLabel: 'General Audit',
    text: DEFAULT_REVIEW_CHECKLIST_PROMPT_ZH,
    enText: DEFAULT_REVIEW_CHECKLIST_PROMPT_EN,
  },
  {
    id: 'goal',
    label: '目标与约束核对',
    enLabel: 'Goals & Constraints',
    text: '对照用户目标、明确约束和实际行为审查方案与结果，检查需求遗漏、歧义、重复或冲突规则。',
    enText: 'Review plan and results against user goals and explicit constraints; check for omitted, ambiguous, or conflicting requirements.',
  },
  {
    id: 'root-cause',
    label: '根因与上下游',
    enLabel: 'Root Cause & Effects',
    text: '对重要问题追溯根因，检查完成当前任务所必需的上下游、共享状态和同根因影响，排查回归风险。',
    enText: 'Trace issues to root causes; verify upstream/downstream dependencies, shared state consistency, and regression risks.',
  },
  {
    id: 'edge-rollback',
    label: '边界与异常恢复',
    enLabel: 'Boundary & Rollback',
    text: '核查逻辑一致性、边界输入、异常/取消/恢复逻辑、权限与副作用，标出无退出条件或死循环流程。',
    enText: 'Audit boundary inputs, exception handling, cancel/recovery flows, permissions, side effects, and unhandled loops.',
  },
  {
    id: 'evidence',
    label: '证据真实性核验',
    enLabel: 'Evidence Verification',
    text: '区分已验证事实、合理推断和缺失证据；不得声称未执行的测试或结果；每项发现按优先级、证据、影响、最小修复与验证方式给出。',
    enText: 'Distinguish verified facts from missing evidence. Do not claim unperformed tests. Format findings by priority, evidence, and fix.',
  },
  {
    id: 'file-scope',
    label: '公共文件协作',
    enLabel: 'Shared Files & Scope',
    text: '核对 fileScope 声明范围，排查公共配置、公共类型和接口文件的越界修改风险，防范跨任务协作冲突。',
    enText: 'Audit fileScope compliance; verify changes to shared configs, public types, and contracts to prevent cross-task conflicts.',
  },
  {
    id: 'concurrency',
    label: '并发与连接池',
    enLabel: 'Concurrency & Leaks',
    text: '重点排查多线程/异步并发安全、数据库事务隔离级别、连接池与系统资源句柄释放。',
    enText: 'Audit multithreaded/async concurrency safety, transaction isolation levels, connection pools, and handle leaks.',
  },
  {
    id: 'security',
    label: '安全与权限判定',
    enLabel: 'Security & Auth',
    text: '核查管理员权限判定、输入越权风险、敏感信息保护与底层系统调用的安全性。',
    enText: 'Audit administrator privilege evaluation, authorization checks, credential protection, and system call safety.',
  },
] as const

function ReviewResultSection({ review, locale }: { readonly review: TeamConsoleReview | undefined; readonly locale: YuqiLocale }) {
  const en = locale === 'en'
  return <section className="yuqi-review-result-section">
    <h3>{review === undefined ? (en ? 'Review results' : '审查状态') : (en ? 'Review results' : '最新审查结果')}</h3>
    {review === undefined ? <div className="yuqi-review-empty"><strong>{en ? 'No review results yet' : '暂无审查结果'}</strong><span>{en ? 'No completed review is available for this Team.' : '当前没有可展示的已完成审查。'}</span></div> : <>
      <p className="yuqi-review-result-status">{en ? 'Decision: ' : '结论：'}{reviewDecisionLabel(review.decision, locale)}</p>
      {review.findings.length === 0 ? <p className="yuqi-empty">{en ? 'No structured findings.' : '没有结构化发现项。'}</p> : <div className="yuqi-review-findings-list">{review.findings.map((finding, index) => <article key={index} className="yuqi-review-finding-card"><div className="yuqi-review-finding-header"><span className={`yuqi-severity-tag yuqi-severity-${finding.severity}`}>{formatReviewSeverity(finding.severity, locale)}</span><strong>{finding.impact}</strong></div><p className="yuqi-review-finding-recom">{en ? 'Recommendation: ' : '建议：'}{finding.recommendation}</p>{finding.evidence.length === 0 ? null : <small>{en ? 'Evidence: ' : '证据：'}{finding.evidence.join('；')}</small>}</article>)}</div>}
      {review.unverified.length === 0 ? null : <ul className="yuqi-insight-list">{review.unverified.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    </>}
  </section>
}

function reviewActionBlockedReason(command: YuqiCommand | undefined, controllerSessionId: string | undefined, busy: boolean, teamStatus: TeamConsoleSummary['team']['status'], tasks: readonly TeamConsoleTask[], locale: YuqiLocale): string | undefined {
  const en = locale === 'en'
  if (command === undefined || controllerSessionId === undefined) return en ? 'This conversation is view-only.' : '当前会话仅支持查看，暂不可执行检查。'
  if (busy) return en ? 'Check submission is in progress.' : '检查请求正在提交。'
  if (tasks.some(task => task.attemptStatus === 'dispatching' || task.attemptStatus === 'running')) return en ? 'Active child Agents must reach a safe boundary before checking.' : '存在运行中的子代理，需到达安全边界后才能检查。'
  if (teamStatus === 'cancelled' || teamStatus === 'cancelling' || teamStatus === 'needs_reconciliation') return en ? 'This Team is not safe for reviewer admission.' : '当前 Team 不满足审查启动的安全条件。'
  if (teamStatus !== 'running' && teamStatus !== 'completed') return en ? 'Review is unavailable for the current Team state.' : '当前 Team 状态不支持发起检查。'
  return undefined
}

function ReviewActionSection({ review, teamId, controllerSessionId, command, locale, teamStatus, tasks }: {
  readonly review: TeamConsoleReview | undefined
  readonly teamId: string
  readonly controllerSessionId?: string
  readonly command?: YuqiCommand
  readonly locale: YuqiLocale
  readonly teamStatus: TeamConsoleSummary['team']['status']
  readonly tasks: readonly TeamConsoleTask[]
}) {
  const en = locale === 'en'
  const [busy, setBusy] = useState(false)
  const [focusNotes, setFocusNotes] = useState('')
  const [feedback, setFeedback] = useState<{ readonly kind: 'notice' | 'error'; readonly text: string } | null>(null)
  const requestScopeRef = useRef(0)

  function toggleTemplate(templateText: string) {
    if (!focusNotes.trim()) {
      setFocusNotes(templateText)
    } else if (focusNotes.includes(templateText)) {
      const next = focusNotes
        .replace(templateText, '')
        .replace(/\n\n+/g, '\n')
        .trim()
      setFocusNotes(next)
    } else {
      setFocusNotes(prev => `${prev.trim()}\n${templateText}`)
    }
  }

  useEffect(() => {
    requestScopeRef.current += 1
    setBusy(false)
    setFeedback(null)
  }, [review?.reviewId, teamId, controllerSessionId])

  const blockedReason = reviewActionBlockedReason(command, controllerSessionId, busy, teamStatus, tasks, locale)

  async function requestReview() {
    if (blockedReason !== undefined || command === undefined || controllerSessionId === undefined) return
    const requestScope = requestScopeRef.current
    setBusy(true)
    setFeedback(null)
    const requestId = createRequestId()
    try {
      const accepted = await command(reviewCommandLine(teamId, controllerSessionId, requestId, focusNotes), { teamId, controllerSessionId })
      if (requestScope !== requestScopeRef.current) return
      setFeedback(accepted
        ? { kind: 'notice', text: en ? 'Independent review submitted. Check controller messages and review results here.' : '独立审查请求已发送；最终以消息流和面板结果为准。' }
        : { kind: 'error', text: en ? `Independent review rejected: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}.` : `独立审查未受理：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。` })
    } catch (error) {
      if (requestScope !== requestScopeRef.current) return
      setFeedback({ kind: 'error', text: error instanceof YuqiCommandOutcomeError ? error.message : en ? `Independent review transport failed: Team ${teamId}, controller ${controllerSessionId}, request ${requestId}.` : `独立审查传输失败：Team ${teamId}，controller ${controllerSessionId}，请求 ${requestId}。` })
    } finally {
      if (requestScope === requestScopeRef.current) setBusy(false)
    }
  }

  return (
    <section className="yuqi-review-action-card">
      <div className="yuqi-review-action-header">
        <h3>{en ? 'Independent check' : '独立检查'}</h3>
        <p className="yuqi-plan-explanation">
          {en ? 'Check existing results and propose recommendations without modifying code.' : '检查已有结果并提出建议，不修改代码。'}
        </p>
      </div>
      <div className="yuqi-review-action-body">
        {blockedReason === undefined ? null : <p className="yuqi-review-blocked-reason" role="status">{blockedReason}</p>}
        <details className="yuqi-review-custom-details" open>
          <summary>{en ? 'Custom check content (optional)' : '自定义检查内容（选填）'}</summary>
          <label className="yuqi-settings-field">
            <textarea rows={3} value={focusNotes} maxLength={4_000} disabled={blockedReason !== undefined}
              aria-label={en ? 'Custom check content' : '自定义检查内容'}
              placeholder={en ? 'What should AI focus on checking?' : '你想让 AI 重点检查什么？'} onChange={e => setFocusNotes(e.target.value)} />
            <small>{en ? 'Leave blank to check against task requirements.' : '不填则按任务要求检查。'}</small>
          </label>
        <div className="yuqi-review-template-section">
          <div className="yuqi-review-template-header">
            <span>{en ? 'Quick template suggestions:' : '快捷填入模板：'}</span>
            <div className="yuqi-template-header-actions">
              {focusNotes ? <span className="yuqi-template-count">{focusNotes.length} {en ? 'chars' : '字'}</span> : null}
              {focusNotes ? (
                <button type="button" className="yuqi-template-clear-btn" disabled={blockedReason !== undefined} onClick={() => setFocusNotes('')}>
                  {en ? 'Clear notes' : '清空输入'}
                </button>
              ) : null}
            </div>
          </div>
          <div className="yuqi-review-template-chips">
            {REVIEW_FOCUS_TEMPLATES.map(tpl => {
              const text = en ? tpl.enText : tpl.text
              const isSelected = focusNotes.includes(text)
              const isFeatured = 'featured' in tpl && tpl.featured
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className={`yuqi-template-chip ${isFeatured ? 'featured' : ''} ${isSelected ? 'active' : ''}`}
                  disabled={blockedReason !== undefined}
                  onClick={() => toggleTemplate(text)}
                  title={text}
                >
                  {isSelected ? '✓ ' : ''}{en ? tpl.enLabel : tpl.label}
                </button>
              )
            })}
          </div>
        </div>
        </details>
        <div className="yuqi-review-action-footer">
          <button
            type="button"
            className="yuqi-primary-action"
            disabled={blockedReason !== undefined}
            onClick={() => void requestReview()}
          >
            {busy ? (en ? 'Submitting check…' : '提交检查中…') : (en ? 'Check current results' : '检查当前结果')}
          </button>
          <span className="yuqi-review-token-note">{en ? 'Uses additional model tokens.' : '会额外消耗模型用量。'}</span>
          {feedback === null ? null : (
            <span className={feedback.kind === 'error' ? 'yuqi-command-error' : 'yuqi-command-notice'} role={feedback.kind === 'error' ? 'alert' : 'status'}>
              {feedback.text}
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function reviewDecisionLabel(decision: TeamConsoleReview['decision'], locale: YuqiLocale): string {
  if (decision === 'pass') return locale === 'en' ? 'Pass' : '通过'
  if (decision === 'changes_required') return locale === 'en' ? 'Changes required' : '需要修改'
  return locale === 'en' ? 'Inconclusive' : '结论不足'
}

function usageScopeLabel(scope: TeamConsoleSummary['usage']['scope'], locale: YuqiLocale): string {
  // Keep the wire literal for compatibility, but expose plain Chinese in the UI.
  void scope
  return locale === 'en' ? 'Child Agent usage' : '子代理用量'
}

function panelFilters(locale: YuqiLocale): readonly { readonly id: Filter; readonly label: string }[] {
  const en = locale === 'en'
  return [
    { id: 'all', label: en ? 'All tasks' : '全部任务' },
    { id: 'created', label: en ? 'Created conversations' : '已创建会话' },
    { id: 'active', label: en ? 'Active' : '进行中' },
    { id: 'planned', label: en ? 'Task plans (no conversation)' : '任务计划（未创建会话）' },
    { id: 'attention', label: en ? 'Needs attention' : '问题任务' },
    { id: 'completed', label: en ? 'Completed' : '已完成' },
  ]
}

function panelEmptyMessages(locale: YuqiLocale): Readonly<Record<Filter, string>> {
  if (locale === 'en') return {
    all: 'No tasks yet.',
    created: 'No child Agents have been created. See the task graph under “Task plans”.',
    attention: 'No created conversation is failed, blocked, or awaiting result verification. Follow the recovery guidance above for Team-level issues.',
    planned: 'No task plans are waiting for conversation creation.',
    active: 'No child Agents are running or being verified.',
    completed: 'No child Agent tasks are complete.',
  }
  return {
    all: '暂无任务。',
    created: '尚未创建子代理；可在“任务计划（未创建会话）”查看任务图。',
    attention: '当前没有失败、阻塞或结果待核验的已创建会话；团队级异常请按面板上方的恢复提示处理。',
    planned: '当前没有尚未创建会话的任务计划。',
    active: '当前没有正在运行或验证中的子代理。',
    completed: '当前没有已完成的子代理任务。',
  }
}

function matches(filter: Filter, task: TeamConsoleTask, teamStatus?: TeamConsoleSummary['team']['status']): boolean {
  if (filter === 'all') return true
  if (filter === 'planned') return !taskHasCreatedAgent(task)
  if (filter === 'active') return taskHasCreatedAgent(task) && (task.status === 'running' || task.status === 'verifying')
  if (filter === 'attention') return taskHasCreatedAgent(task) && taskNeedsAttention(task, teamStatus)
  if (filter === 'completed') return taskHasCreatedAgent(task) && task.status === 'completed'
  return taskHasCreatedAgent(task)
}

function taskHasCreatedAgent(task: TeamConsoleTask): boolean {
  return task.attemptOrdinal !== undefined || task.childSessionId !== undefined || task.evidenceRecorded
}

function taskShortTitle(goal: string): string {
  const concise = goal.split(/[:：]/, 1)[0]?.trim() || goal.trim()
  return concise.length > 26 ? `${concise.slice(0, 25)}…` : concise
}

const SYSTEM_COPY_EN: Readonly<Record<string, string>> = {
  '用主控协调子代理完成高质量项目': 'Coordinate child Agents through the controller to deliver a high-quality project',
  '结果尚未确认：现场记录已保留，需主控核对后决定后续处理。': 'The result is not yet confirmed. Recorded evidence is preserved for the controller to review before deciding what happens next.',
  '需人工确认：Host 无法完成所需验证；不会重复消耗 Token。': 'User confirmation is required because the Host could not complete verification. No duplicate tokens will be consumed.',
  '验证中：子代理结束不等于任务完成，正在等待验证证据。': 'Verification is in progress. A finished child Agent does not complete the task until verification evidence is available.',
  '等待处理：依赖任务未成功完成。': 'Waiting because a dependency did not complete successfully.',
  '任务已随团队暂停。点击「继续任务」后将自动恢复执行。': 'Task paused with Team. Execution will resume automatically when continued.',
  '可在安全门禁通过后重试，历史证据会保留。': 'Retry after the safety gate passes; prior evidence will be preserved.',
  '已取消：不会自动重新开始。': 'Cancelled; it will not restart automatically.',
  '已完成。': 'Completed.',
  '正在执行。': 'In progress.',
  '等待调度。': 'Awaiting scheduling.',
}

export function localizedSystemCopy(value: string, locale: YuqiLocale): string {
  if (locale === 'en') return SYSTEM_COPY_EN[value] ?? value
  return Object.entries(SYSTEM_COPY_EN).find(([, english]) => english === value)?.[0] ?? value
}

function localizedTask(task: TeamConsoleTask, locale: YuqiLocale, teamStatus?: string): TeamConsoleTask {
  const nextAction = task.status === 'blocked' && task.taskOutcome !== undefined
    ? formatBlockedTaskOutcome(task.taskOutcome, locale, teamStatus) : localizedSystemCopy(task.nextAction, locale)
  return nextAction === task.nextAction ? task : { ...task, nextAction }
}
