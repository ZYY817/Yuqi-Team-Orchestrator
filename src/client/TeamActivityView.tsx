import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { TeamConsoleSummary, TeamConsoleTask } from '../domain/team-console-contract.ts'
import { useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { localeLanguageTag } from './i18n.ts'
import { taskStatusMeta } from './status.ts'
import { TaskFileAudit } from './TaskFileAudit.tsx'
import { TeamUsageSummary } from './TeamUsageSummary.tsx'
import { formatCompactTokens, formatTokens, presentTaskUsage, presentTeamUsage } from './usage-presentation.ts'
import { ProjectSummarySection } from './ProjectSummarySection.tsx'
import type { YuqiCommand } from './command-actions.ts'

export interface TeamActivityViewProps {
  readonly summary: TeamConsoleSummary
  /** The parent switches to the task list and locates this task. */
  readonly onSelectTask?: (taskId: string) => void
  readonly nowMs?: number
  readonly command?: YuqiCommand | undefined
}

export function TeamActivityView({ summary, onSelectTask, nowMs = Date.now(), command }: TeamActivityViewProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  // The route is derived only from durable task dependencies and task state;
  // it is not a schedule or an estimated execution timeline.
  const [view, setView] = useState<'runs' | 'dependencies' | 'files' | 'summary' | 'usage'>('dependencies')
  const [graphFullscreen, setGraphFullscreen] = useState(false)
  const [fileTaskId, setFileTaskId] = useState<string>()
  const fileTask = summary.tasks.find(task => task.taskId === fileTaskId) ?? summary.tasks[0]
  const graph = useMemo(() => dependencyGraph(summary.tasks), [summary.tasks])
  const routeOffsets = useMemo(() => dependencyRouteOffsets(graph.layers), [graph.layers])
  const graphCanvas = useRef<HTMLDivElement>(null)
  const graphViewport = useRef<HTMLDivElement>(null)
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 })
  const panRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number }>()
  useEffect(() => {
    if (!graphFullscreen) return undefined
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    graphViewport.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setGraphFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [graphFullscreen])
  function beginGraphPan(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (event.button !== 0 || event.isPrimary === false || target.closest('button, summary, .yuqi-route-node-details')) return
    const viewport = graphViewport.current
    if (viewport === null) return
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: graphPan.x, originY: graphPan.y }
    viewport.setPointerCapture?.(event.pointerId)
    viewport.classList.add('is-panning')
  }
  function moveGraphPan(event: ReactPointerEvent<HTMLDivElement>) {
    const pan = panRef.current
    const viewport = graphViewport.current
    if (pan === undefined || viewport === null || pan.pointerId !== event.pointerId) return
    setGraphPan({ x: pan.originX + event.clientX - pan.x, y: pan.originY + event.clientY - pan.y })
  }
  function endGraphPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId !== event.pointerId) return
    graphViewport.current?.classList.remove('is-panning')
    panRef.current = undefined
  }
  const node = (task: TeamConsoleTask, showStatus = true) => {
    const status = taskStatusMeta(task, locale, summary.team.status)
    return <div className="yuqi-insight-block">
      <button type="button" className="yuqi-secondary-action" disabled={!onSelectTask}
        style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start', minHeight: 44, width: '100%' }}
        aria-label={en ? `Locate task ${task.taskId}: ${task.goal}` : `定位任务 ${task.taskId}：${task.goal}`}
        onClick={() => onSelectTask?.(task.taskId)}>{task.taskId} · {task.goal}</button>
      {showStatus ? <span className={`yuqi-status yuqi-status-${status.tone}`}>{status.label}</span> : null}
    </div>
  }
  return <section className="yuqi-activity-aligned" lang={localeLanguageTag(locale)} aria-label={en ? 'Team activity' : '团队活动'} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <nav className="yuqi-filters" aria-label={en ? 'Activity views' : '活动视图'}>
      <button type="button" aria-pressed={view === 'dependencies'} className={view === 'dependencies' ? 'yuqi-filter-active' : undefined} onClick={() => setView('dependencies')}>{en ? 'Task route' : '任务路线图'}</button>
      <button type="button" aria-pressed={view === 'runs'} className={view === 'runs' ? 'yuqi-filter-active' : undefined} onClick={() => setView('runs')}>{en ? 'Run records' : '运行记录'}</button>
      <button type="button" aria-pressed={view === 'files'} className={view === 'files' ? 'yuqi-filter-active' : undefined} onClick={() => setView('files')}>{en ? 'Files & evidence' : '文件与证据'}</button>
      <button type="button" aria-pressed={view === 'usage'} className={view === 'usage' ? 'yuqi-filter-active' : undefined} onClick={() => setView('usage')}>{en ? 'Usage' : '用量统计'}</button>
      <button type="button" aria-pressed={view === 'summary'} className={view === 'summary' ? 'yuqi-filter-active' : undefined} onClick={() => setView('summary')}>{en ? 'Project summary' : '项目总览'}</button>
    </nav>
    <div className="yuqi-activity-content">{view === 'summary' ? (
      <ProjectSummarySection summary={summary.projectSummary} locale={locale} teamId={summary.team.id} controllerSessionId={summary.controllerSessionId} command={command} />
    ) : view === 'files' ? <section className="yuqi-activity-files">
      <label className="yuqi-settings-field"><span>{en ? 'Task evidence' : '选择要查看证据的任务'}</span>
        <select value={fileTask?.taskId ?? ''} title={fileTask?.goal} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} disabled={summary.tasks.length === 0} onChange={event => setFileTaskId(event.currentTarget.value)}>
          {summary.tasks.map(task => <option key={task.taskId} value={task.taskId}>{task.taskId} · {task.goal}</option>)}
        </select>
      </label>
      {fileTask ? <TaskFileAudit key={fileTask.taskId} sessionId={fileTask.childSessionId} reported={fileTask.reportedChangedFiles}
        variant="activity" executionState={isClearlyNotStarted(fileTask, summary) ? 'not-started' : 'unknown'} hasAttempt={hasExecutionRecord(fileTask, summary)} />
        : <p className="yuqi-empty">{en ? 'No task evidence yet.' : '暂无任务证据。'}</p>}
    </section> : view === 'usage' ? <section className="yuqi-activity-usage-section">
      {hasAnyUsageRecord(summary) ? <><div className="yuqi-activity-heading"><h3>{en ? 'Recorded usage' : '已记录用量'}</h3></div>
        <TeamUsageSummary usage={summary.usage} duration={summary.team.duration} nowMs={nowMs} />
        <UsageTable summary={summary} locale={locale} onSelectTask={onSelectTask} /></>
        : <p className="yuqi-empty">{en ? 'No usage has been recorded yet.' : '任务尚未产生用量记录。'}</p>}
    </section>
      : summary.tasks.length === 0 ? <p className="yuqi-empty">{en ? 'No tasks yet.' : '暂无任务。'}</p>
      : view === 'dependencies' ? <>
        <p className="yuqi-route-summary"><span>{en ? 'Real task dependencies and current states; no schedule is inferred.' : '展示真实任务依赖与当前状态，不推断工期。'}</span><strong>{en ? `${summary.tasks.length} tasks` : `${summary.tasks.length} 个任务`}</strong></p>
        {summary.tasks.length === 1 && summary.tasks[0]!.dependencyCount === 0 && (summary.tasks[0]!.dependencies?.length ?? 0) === 0
          ? <p className="yuqi-route-empty-copy">{en ? 'This Team has one independent task.' : '当前团队只有一个独立任务，没有前置依赖。'}</p> : null}
        <div className={`yuqi-route-viewer${graphFullscreen ? ' is-fullscreen' : ''}`}>
          <div className="yuqi-route-toolbar">
            <span>{en ? 'Drag blank canvas to pan' : '拖动空白画布可平移'}</span>
            <button type="button" className="yuqi-secondary-action" aria-pressed={graphFullscreen}
              onClick={() => setGraphFullscreen(value => !value)}>{graphFullscreen ? (en ? 'Exit full screen' : '退出全屏') : (en ? 'View full screen' : '全屏查看')}</button>
          </div>
        <div ref={graphViewport} className="yuqi-activity-graph yuqi-task-route" role="region" aria-label={en ? 'Task route based on dependencies' : '基于依赖关系的任务路线图'} tabIndex={0}
          onPointerDown={beginGraphPan} onPointerMove={moveGraphPan} onPointerUp={endGraphPan} onPointerCancel={endGraphPan} onLostPointerCapture={endGraphPan}>
          <div className="yuqi-activity-graph-canvas" ref={graphCanvas} style={{ transform: `translate(${graphPan.x}px, ${graphPan.y}px)` }}>
          <DependencyConnections canvas={graphCanvas} tasks={summary.tasks} />
          {graph.layers.map((tasks, index) => <details className="yuqi-insight-section yuqi-activity-layer" open key={index}>
            <summary>{index === 0 ? (en ? 'No prerequisites' : '无前置任务') : (en ? `After prerequisites · stage ${index + 1}` : `等待前置任务完成 · 第 ${index + 1} 阶段`)}</summary>
            <ul className="yuqi-insight-list">
              {tasks.map((task, taskIndex) => <li className="yuqi-activity-graph-node" data-task-id={task.taskId} key={task.taskId}
                style={{ marginTop: routeNodeMargin(routeOffsets, task.taskId, taskIndex === 0 ? undefined : tasks[taskIndex - 1]!.taskId) }}>
                <RouteNode task={task} locale={locale} teamStatus={summary.team.status} onSelectTask={onSelectTask} /></li>)}
            </ul>
          </details>)}
          {graph.unplaced.length > 0 ? <details className="yuqi-insight-section" open>
            <summary>{en ? 'Unresolved dependencies' : '无法分层的任务'}</summary>
            <ul className="yuqi-insight-list">
              {graph.unplaced.map(task => <li key={task.taskId}>
                {node(task)}<DependencyLabels task={task} locale={locale} />
                {graph.cycles.has(task.taskId) ? <p className="yuqi-command-error">{en ? 'Dependency cycle: this task belongs to a cycle.' : '依赖环：此任务位于环内。'}</p> : null}
                {(graph.missing.get(task.taskId) ?? []).map(id => <p className="yuqi-command-error" key={id}>{en ? `Missing prerequisite node: ${id}` : `缺失前置节点：${id}`}</p>)}
                {graph.incomplete.has(task.taskId) ? <p className="yuqi-command-unavailable">{en ? 'Dependency details are incomplete in this projection.' : '当前投影未提供完整依赖明细。'}</p> : null}
                {!graph.cycles.has(task.taskId) && !graph.missing.has(task.taskId) && !graph.incomplete.has(task.taskId)
                  ? <p className="yuqi-command-unavailable">{en ? 'Depends on unresolved tasks; not necessarily part of a cycle.' : '依赖尚未解析的任务，本节点不一定在环内。'}</p> : null}
              </li>)}
            </ul>
          </details> : null}
          </div>
        </div>
        </div>
      </> : <RunRecords summary={summary} locale={locale} onSelectTask={onSelectTask} onViewFiles={taskId => { setFileTaskId(taskId); setView('files') }} />}
    </div>
  </section>
}

/** Geometry follows the rendered nodes, so wrapping and disclosures do not detach edges. */
function DependencyConnections({ canvas, tasks }: { readonly canvas: RefObject<HTMLDivElement | null>; readonly tasks: readonly TeamConsoleTask[] }) {
  const markerId = useId()
  const [edges, setEdges] = useState<readonly { id: string; path: string }[]>([])
  useEffect(() => {
    const root = canvas.current
    if (!root) return
    const measure = () => {
      const bounds = root.getBoundingClientRect()
      const nodes = new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-task-id]')).filter(node => node.getClientRects().length > 0).map(node => [node.dataset.taskId, node.getBoundingClientRect()]))
      const next = tasks.flatMap(task => {
        const target = nodes.get(task.taskId)
        if (!target) return []
        return [...new Set(task.dependencies?.map(item => item.taskId) ?? [])].flatMap(id => {
          const source = nodes.get(id)
          if (!source) return []
          const x1 = source.right - bounds.left, y1 = source.top + source.height / 2 - bounds.top
          const x2 = target.left - bounds.left, y2 = target.top + target.height / 2 - bounds.top
          const dx = Math.max(32, (x2 - x1) * 0.45)
          return [{ id: JSON.stringify([id, task.taskId]), path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}` }]
        })
      })
      setEdges(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(root)
    root.querySelectorAll<HTMLElement>('[data-task-id]').forEach(node => observer?.observe(node))
    root.addEventListener('toggle', measure, true)
    return () => { observer?.disconnect(); root.removeEventListener('toggle', measure, true) }
  }, [canvas, tasks])
  return <svg className="yuqi-activity-edges" aria-hidden="true" focusable="false">
    <defs>
      <marker id={markerId} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
        <path d="M 0 0.5 L 5 3 L 0 5.5 Z" fill="currentColor" />
      </marker>
    </defs>
    {edges.map(edge => <path key={edge.id} d={edge.path} fill="none" stroke="currentColor" strokeWidth="1.5" markerEnd={`url(#${markerId})`} />)}
  </svg>
}

function RecordedStart({ summary, task, en }: { readonly summary: TeamConsoleSummary; readonly task: TeamConsoleTask; readonly en: boolean }) {
  const entry = summary.timeline?.find(item => item.taskId === task.taskId && item.attemptId === task.attemptId && item.kind === 'attempt-started')
  const at = entry ? Date.parse(entry.at) : NaN
  return Number.isFinite(at) ? <time dateTime={entry!.at}>{new Date(at).toISOString()}</time> : <>{en ? 'No reliable time data available.' : '暂无可靠时间。'}</>
}

function UsageTable({ summary, locale, onSelectTask }: { readonly summary: TeamConsoleSummary; readonly locale: YuqiLocale; readonly onSelectTask: TeamActivityViewProps['onSelectTask'] }) {
  const en = locale === 'en'
  const unavailable = '—'
  const columns = (usage: TeamConsoleTask['usage'] | TeamConsoleSummary['usage'] | undefined) => {
    const known = usage && 'totalTokens' in usage ? usage : undefined
    // Input includes the separately reported cache reads/writes; total stays provider-reported.
    const cell = (value: number | undefined) => {
      if (!known || value === undefined) return <td>{unavailable}</td>
      const exact = formatTokens(value, locale)
      return <td title={exact} aria-label={exact}>{formatCompactTokens(value, 'en')}</td>
    }
    return <>{cell(known ? known.uncachedInputTokens + known.cacheReadTokens + known.cacheWriteTokens : undefined)}{cell(known?.outputTokens)}{cell(known?.totalTokens)}</>
  }
  const headings = <tr><th scope="col">{en ? 'Task / attempt' : '任务／尝试'}</th><th scope="col">{en ? 'Model' : '模型'}</th><th scope="col">{en ? 'Input' : '输入'}</th><th scope="col">{en ? 'Output' : '输出'}</th><th scope="col">{en ? 'Total' : '总量'}</th></tr>
  return <>
    <p className="yuqi-plan-explanation">{en ? 'Task rows show the latest attempt only. Input includes cache reads and writes. Historical attempt usage is not supplied; unknown is not zero. Team totals include all recorded attempts, so task rows need not sum to the Team total.' : '任务行仅显示最新尝试；输入包含缓存读取与写入。历史尝试用量未提供，未知不代表零。团队总量包含所有已记录尝试，不应将任务行之和视作团队总量。'}</p>
    <div className="yuqi-activity-table-scroll" role="region" aria-label={en ? 'Token usage' : 'Token 用量'} tabIndex={0}>
      <table className="yuqi-activity-usage-table"><caption>{en ? 'Latest attempt usage by task' : '各任务最新尝试用量'}</caption><thead>{headings}</thead>
        {summary.tasks.map(task => <tbody key={task.taskId}><tr>
          <th scope="row"><button type="button" className="yuqi-child-link" disabled={!onSelectTask} onClick={() => onSelectTask?.(task.taskId)}>{task.goal}</button><small>{task.taskId} · {presentTaskUsage(task.usage, locale).tokenLabel}</small></th>
          <td>{actualModel(task) ?? unavailable}</td>{columns(task.usage)}
        </tr>{task.attemptId || (task.routeHistory?.length ?? 0) > 0 ? <tr><td colSpan={5}><details><summary>{en ? `Attempt details (${displayAttemptCount(task)})` : `尝试明细（${displayAttemptCount(task)}）`}</summary>
          <table><caption>{en ? 'Reported attempt routes; only the current attempt has usage' : '已上报尝试路由；仅当前尝试有用量数据'}</caption><thead>{headings}</thead><tbody>
            {[...(task.routeHistory ?? [])].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal).map(attempt => <tr key={attempt.attemptId}>
              <th scope="row">{en ? `Attempt ${attempt.attemptOrdinal}` : `第 ${attempt.attemptOrdinal} 次尝试`}<small>{attempt.attemptId}</small></th>
              <td>{attempt.providerId} / {attempt.modelId}</td>{columns(attempt.attemptId === task.attemptId ? task.usage : undefined)}
            </tr>)}
            {task.attemptId && !task.routeHistory?.some(attempt => attempt.attemptId === task.attemptId) ? <tr><th scope="row">{en ? 'Current attempt' : '当前尝试'}<small>{task.attemptId}</small></th><td>{actualModel(task) ?? unavailable}</td>{columns(task.usage)}</tr> : null}
          </tbody></table>
          {!task.routeHistory?.length ? <p>{en ? 'Attempt route details were not supplied; this does not establish whether the task has run.' : '未提供尝试路由明细，不能据此判断任务是否运行过。'}</p> : null}
        </details></td></tr> : null}</tbody>)}
        <tfoot><tr><th scope="row">{en ? 'Team recorded total' : '团队已记录总量'}</th><td>{presentTeamUsage(summary.usage, locale).stateLabel}</td>{columns(summary.usage)}</tr></tfoot>
      </table>
    </div>
  </>
}

function RunRecords({ summary, locale, onSelectTask, onViewFiles }: {
  readonly summary: TeamConsoleSummary
  readonly locale: YuqiLocale
  readonly onSelectTask: TeamActivityViewProps['onSelectTask']
  readonly onViewFiles: (taskId: string) => void
}) {
  const en = locale === 'en'
  return <section className="yuqi-activity-run-records">
    <div className="yuqi-activity-heading"><h3>{en ? 'Run records' : '运行记录'}</h3></div>
    <p className="yuqi-plan-explanation">{en ? 'Actual models come from recorded attempt routes. A model request is only a preference before assignment.' : '实际模型来自已记录的尝试路由；模型请求只是分配前的偏好。'}</p>
    <div className="yuqi-activity-table-scroll" role="region" aria-label={en ? 'Run records by task' : '按任务查看运行记录'} tabIndex={0}>
      <table className="yuqi-activity-run-table"><thead><tr><th>{en ? 'Task' : '任务'}</th><th>{en ? 'Status' : '状态'}</th><th>{en ? 'Actual model' : '实际模型'}</th><th>{en ? 'Attempts' : '尝试'}</th></tr></thead><tbody>
        {summary.tasks.map(task => {
          const recorded = hasExecutionRecord(task, summary)
          const actual = actualModel(task)
          const status = runStatusMeta(task, locale, recorded, summary.team.status)
          if (!recorded) return <tr key={task.taskId} className="yuqi-activity-run-static-row">
            <th scope="row"><strong>{task.taskId}</strong><span title={task.goal}>{task.goal}</span></th>
            <td><span className={`yuqi-status yuqi-status-${status.tone}`}>{status.label}</span></td>
            <td>{isClearlyNotStarted(task, summary) ? (en ? 'Not assigned' : '尚未分配') : (en ? 'Not reported' : '未上报')}</td><td>—</td>
          </tr>
          return <tr key={task.taskId} className="yuqi-activity-run-row"><td colSpan={4}>
            <details className="yuqi-activity-run-disclosure">
              <summary aria-label={en ? `Execution details for ${task.taskId}` : `${task.taskId} 执行明细`}><span className="yuqi-activity-run-summary-grid"><span><strong>{task.taskId}</strong><span title={task.goal}>{task.goal}</span></span>
                <span className={`yuqi-status yuqi-status-${status.tone}`}>{status.label}</span>
                <span>{actual ?? (en ? 'Not reported' : '未上报')}</span><span>{displayAttemptCount(task)}</span></span></summary>
              <div className="yuqi-activity-run-detail">
                <dl className="yuqi-activity-metadata">
                  <dt>{en ? 'Model request' : '模型请求'}</dt><dd>{modelRequestLabel(task, locale)}</dd>
                  <dt>{en ? 'Actual model' : '实际模型'}</dt><dd>{actual ?? (en ? 'Not reported' : '未上报')}</dd>
                  <dt>{en ? 'Current attempt' : '当前尝试'}</dt><dd>{task.attemptOrdinal ?? '—'} · {attemptState(task.attemptStatus, locale)}</dd>
                  <dt>{en ? 'Started at (UTC)' : '开始时间（UTC）'}</dt><dd><RecordedStart summary={summary} task={task} en={en} /></dd>
                  <dt>{en ? 'Evidence' : '执行证据'}</dt><dd>{task.evidenceRecorded ? (en ? 'Recorded (not a verification verdict)' : '已记录（不代表验证通过）') : (en ? 'Not reported' : '未上报')}</dd>
                  <dt>{en ? 'Verification' : '验证状态'}</dt><dd>{task.verificationStatus ?? (en ? 'Not reported' : '未上报')}</dd>
                </dl>
                {(task.routeHistory?.length ?? 0) > 0 ? <ol className="yuqi-activity-attempt-list">{[...task.routeHistory!].sort((a, b) => a.attemptOrdinal - b.attemptOrdinal).map(route => <li key={route.attemptId}>
                  <strong>{en ? `Attempt ${route.attemptOrdinal}` : `第 ${route.attemptOrdinal} 次尝试`}</strong><span>{route.providerId} / {route.modelId}</span><small>{route.attemptId}</small>
                  <span>{route.attemptId === task.attemptId ? attemptState(task.attemptStatus, locale) : (en ? 'Historical status not supplied' : '未提供历史状态')}</span>
                </li>)}</ol> : <p className="yuqi-command-unavailable">{en ? 'Attempt route details were not supplied; this does not mean the task did not run.' : '未提供尝试路由明细，不能据此判断任务没有运行。'}</p>}
                <div className="yuqi-activity-run-actions"><button type="button" className="yuqi-secondary-action" disabled={!onSelectTask} onClick={() => onSelectTask?.(task.taskId)}>{en ? 'Locate task' : '定位任务'}</button>
                  <button type="button" className="yuqi-secondary-action" onClick={() => onViewFiles(task.taskId)}>{en ? 'View file evidence' : '查看文件证据'}</button></div>
              </div>
            </details>
          </td></tr>
        })}
      </tbody></table>
    </div>
  </section>
}

function DependencyLabels({ task, locale }: { readonly task: TeamConsoleTask; readonly locale: YuqiLocale }) {
  const en = locale === 'en'
  const ids = [...new Set(task.dependencies?.map(dependency => dependency.taskId) ?? [])]
  return <p>{ids.length > 0
    ? (en ? `Depends on: ${ids.join(', ')}` : `前置任务：${ids.join('、')}`)
    : task.dependencyCount > 0 ? (en ? 'Prerequisites not reported' : '前置任务未上报')
      : (en ? 'No prerequisites' : '无前置任务')}</p>
}

function RouteNode({ task, locale, teamStatus, onSelectTask }: { readonly task: TeamConsoleTask; readonly locale: YuqiLocale; readonly teamStatus: TeamConsoleSummary['team']['status']; readonly onSelectTask: TeamActivityViewProps['onSelectTask'] }) {
  const en = locale === 'en'
  const status = taskStatusMeta(task, locale, teamStatus)
  return <div className="yuqi-route-node-shell">
    <button type="button" className="yuqi-route-node-select" disabled={!onSelectTask}
        aria-label={en ? `Locate task ${task.taskId}: ${task.goal}` : `定位任务 ${task.taskId}：${task.goal}`}
        onClick={() => onSelectTask?.(task.taskId)}>
        <span className="yuqi-route-node-id">{task.taskId}</span><strong title={task.goal}>{task.goal}</strong>
    </button>
    <span className="yuqi-route-node-status">
      <span className={`yuqi-status yuqi-status-${status.tone}`}>{status.label}</span>
    </span>
    {task.nextAction.trim() === '' ? null : <details className="yuqi-route-node-details"><summary>{en ? 'Task details' : '任务详情'}</summary>
      <div><p title={task.goal}>{task.goal}</p><p className="yuqi-route-node-action"><span>{en ? 'Next' : '下一步'}</span>{task.nextAction}</p></div>
    </details>}
  </div>
}

function attemptState(status: string | undefined, locale: YuqiLocale): string {
  if (status === undefined) return locale === 'en' ? 'Not reported' : '未上报'
  const labels: Record<NonNullable<TeamConsoleTask['attemptStatus']>, readonly [string, string]> = {
    dispatching: ['派发中', 'Dispatching'], running: ['运行中', 'Running'], settled: ['执行结束', 'Settled'],
    verification_failed: ['验证失败', 'Verification failed'], completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'], cancelled: ['已取消', 'Cancelled'], unknown: ['结果待核验', 'Result unverified'],
  }
  return labels[status as NonNullable<TeamConsoleTask['attemptStatus']>]?.[locale === 'en' ? 1 : 0] ?? status
}

function actualModel(task: TeamConsoleTask): string | undefined {
  if (task.route) return `${task.route.providerId} / ${task.route.modelId}`
  const current = task.routeHistory?.find(route => route.attemptId === task.attemptId)
  return current ? `${current.providerId} / ${current.modelId}` : undefined
}

function runStatusMeta(task: TeamConsoleTask, locale: YuqiLocale, recorded: boolean, teamStatus: TeamConsoleSummary['team']['status']) {
  const status = taskStatusMeta(task, locale, teamStatus)
  if (recorded && task.status === 'pending') return { ...status, label: locale === 'en' ? 'Waiting to run again' : '等待再次执行' }
  return status
}

function displayAttemptCount(task: TeamConsoleTask): number | '—' {
  if (task.attemptCount > 0) return task.attemptCount
  if ((task.routeHistory?.length ?? 0) > 0) return task.routeHistory!.length
  return '—'
}

function modelRequestLabel(task: TeamConsoleTask, locale: YuqiLocale): string {
  const en = locale === 'en'
  const request = task.modelRequest
  if (!request) return en ? 'Not reported' : '未上报'
  if (request.kind === 'default') return en ? 'Follow Team default' : '跟随团队默认设置'
  if (request.kind === 'tier') return en ? `Automatic tier: ${request.tier}` : `自动档位：${request.tier}`
  if (request.kind === 'exact') return `${request.model.modelProvider} / ${request.model.modelId}`
  return request.modelId
}

function hasExecutionRecord(task: TeamConsoleTask, summary?: TeamConsoleSummary): boolean {
  return task.attemptCount > 0 || task.attemptId !== undefined || task.attemptStatus !== undefined
    || task.route !== undefined || (task.routeHistory?.length ?? 0) > 0 || task.usage.state !== 'pending'
    || task.evidenceRecorded || task.childSessionId !== undefined || (task.reportedChangedFiles?.length ?? 0) > 0
    || summary?.timeline?.some(entry => entry.taskId === task.taskId) === true
}

function isClearlyNotStarted(task: TeamConsoleTask, summary: TeamConsoleSummary): boolean {
  return (task.status === 'pending' || task.status === 'ready') && task.attemptCount === 0 && !hasExecutionRecord(task, summary)
}

function hasAnyUsageRecord(summary: TeamConsoleSummary): boolean {
  return summary.usage.state !== 'pending' || summary.tasks.some(task => task.usage.state !== 'pending')
}

const routeNodePitch = 112
const routeNodeFootprint = 96

/** Align descendants to the centre of their known prerequisite group without task-specific rules. */
function dependencyRouteOffsets(layers: readonly (readonly TeamConsoleTask[])[]): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>()
  layers.forEach((layer, layerIndex) => {
    let prior = -routeNodePitch
    layer.forEach((task, taskIndex) => {
      const dependencyOffsets = [...new Set(task.dependencies?.map(dependency => dependency.taskId) ?? [])]
        .map(taskId => offsets.get(taskId)).filter((offset): offset is number => offset !== undefined)
      const desired = layerIndex === 0
        ? taskIndex * routeNodePitch
        : dependencyOffsets.length > 0
          ? dependencyOffsets.reduce((total, offset) => total + offset, 0) / dependencyOffsets.length
          : taskIndex * routeNodePitch
      const offset = Math.max(desired, prior + routeNodePitch)
      offsets.set(task.taskId, offset)
      prior = offset
    })
  })
  return offsets
}

function routeNodeMargin(offsets: ReadonlyMap<string, number>, taskId: string, priorTaskId: string | undefined): number {
  const offset = offsets.get(taskId) ?? 0
  if (priorTaskId === undefined) return offset
  return Math.max(0, offset - (offsets.get(priorTaskId) ?? 0) - routeNodeFootprint)
}

function dependencyGraph(tasks: readonly TeamConsoleTask[]) {
  const byId = new Map(tasks.map(task => [task.taskId, task]))
  const dependencies = new Map(tasks.map(task => [task.taskId, [...new Set(task.dependencies?.map(item => item.taskId) ?? [])]]))
  const missing = new Map<string, string[]>()
  const incomplete = new Set<string>()
  const dependents = new Map<string, string[]>()
  const remaining = new Map<string, number>()
  for (const task of tasks) {
    const ids = dependencies.get(task.taskId)!
    const absent = ids.filter(id => !byId.has(id))
    if (absent.length > 0) missing.set(task.taskId, absent)
    if (task.dependencyCount > ids.length) incomplete.add(task.taskId)
    remaining.set(task.taskId, ids.length)
    for (const id of ids) {
      const children = dependents.get(id) ?? []
      children.push(task.taskId)
      dependents.set(id, children)
    }
  }
  const layers: TeamConsoleTask[][] = []
  const placed = new Set<string>()
  let ready = tasks.filter(task => remaining.get(task.taskId) === 0 && !incomplete.has(task.taskId))
  while (ready.length > 0) {
    layers.push(ready)
    const next: TeamConsoleTask[] = []
    for (const task of ready) {
      placed.add(task.taskId)
      for (const id of dependents.get(task.taskId) ?? []) {
        const count = remaining.get(id)! - 1
        remaining.set(id, count)
        if (count === 0 && !incomplete.has(id)) next.push(byId.get(id)!)
      }
    }
    ready = next
  }

  // Strongly connected components distinguish actual cycles from downstream
  // tasks left over by topological layering (including self-dependencies).
  const cycles = new Set<string>()
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  let sequence = 0
  function visit(id: string): void {
    indices.set(id, sequence)
    low.set(id, sequence++)
    stack.push(id)
    active.add(id)
    for (const dependency of dependencies.get(id)!) {
      if (!byId.has(dependency)) continue
      if (!indices.has(dependency)) {
        visit(dependency)
        low.set(id, Math.min(low.get(id)!, low.get(dependency)!))
      } else if (active.has(dependency)) low.set(id, Math.min(low.get(id)!, indices.get(dependency)!))
    }
    if (low.get(id) !== indices.get(id)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      active.delete(member)
      component.push(member)
    } while (member !== id)
    if (component.length > 1 || dependencies.get(id)!.includes(id)) {
      for (const node of component) cycles.add(node)
    }
  }
  for (const task of tasks) if (!indices.has(task.taskId)) visit(task.taskId)
  return { layers, unplaced: tasks.filter(task => !placed.has(task.taskId)), cycles, missing, incomplete, dependents }
}
