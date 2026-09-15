import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { TeamCatalogFace } from './sidecar-store.ts'
const noSubscribe = () => () => {}
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TeamConsoleSummary, TeamConsoleTask } from '../domain/team-console-contract.ts'
import { findTeamRootSessionId } from './TeamReturnButton.tsx'
import { useTeamUiPreference } from './team-ui-preferences.ts'
import { useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { defineLocalizedCopy, formatTaskStatus, formatTeamStatus, labelValue, localeLanguageTag } from './i18n.ts'
import { presentTaskUsage } from './usage-presentation.ts'

export interface TeamSessionNavigatorInjected {
  readonly catalog?: TeamCatalogFace
  readonly openChild: (controllerSessionId: string | undefined, childSessionId: string, diagnostic?: boolean) => Promise<boolean>
  readonly openMain: (sessionId: SessionId) => boolean | Promise<boolean>
  readonly archiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
}

export type TeamSessionNavigatorProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamSessionNavigatorInjected

/** Supported header-level child tree; the native workspace sidebar has no row-extension slot. */
export function TeamSessionNavigator({ sessionId, useSessions, catalog, openChild, openMain, archiveChild }: TeamSessionNavigatorProps) {
  const native = useSessions(state => state)
  const state = useSyncExternalStore(catalog?.subscribe ?? noSubscribe, catalog?.getSnapshot ?? (() => native), () => native)
  const rootSessionId = (() => {
    const direct = state.byId[sessionId]?.projectionValues?.yuqiTeam
    return direct == null ? findTeamRootSessionId(sessionId, state.byId) : sessionId
  })()
  const summary = rootSessionId === undefined
    ? undefined
    : state.byId[rootSessionId]?.projectionValues?.yuqiTeam as TeamConsoleSummary | null | undefined
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 60, maxHeight: 520 })
  const [openingId, setOpeningId] = useState<string>()
  const operationRef = useRef(0)
  const [failedId, setFailedId] = useState<string>()
  const [failureReason, setFailureReason] = useState<string>()
  const [archiveFailedId, setArchiveFailedId] = useState<string>()
  const [archivingId, setArchivingId] = useState<string>()
  const [hoveredTask, setHoveredTask] = useState<TeamConsoleTask | 'controller' | undefined>()
  const locale = useYuqiLocale()
  const copy = COPY[locale]
  const children = summary?.tasks.filter(task => task.childSessionId !== undefined) ?? []
  const preference = useTeamUiPreference(summary?.team.id)
  const archived = new Set(preference.archivedChildIds)
  const currentTask = children.find(task => task.childSessionId === String(sessionId))
  const visibleChildren = children.filter(task => !archived.has(task.childSessionId!))
  const archivedChildren = children.filter(task => archived.has(task.childSessionId!))

  useEffect(() => {
    if (!open) return undefined
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(480, window.innerWidth - 24)
      const top = Math.min(rect.bottom + 8, window.innerHeight - 100)
      const centerLeft = rect.left + rect.width / 2 - width / 2
      let left: number
      if (centerLeft >= 16 && centerLeft + width <= window.innerWidth - 16) {
        left = centerLeft
      } else if (rect.left + width <= window.innerWidth - 16) {
        left = Math.max(16, rect.left)
      } else if (rect.right - width >= 16) {
        left = rect.right - width
      } else {
        left = Math.max(12, window.innerWidth - width - 12)
      }
      setPosition({ left, top, maxHeight: Math.max(80, window.innerHeight - top - 12) })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    const focusOutside = (event: FocusEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('.yuqi-session-open') ?? [])
        if (buttons.length === 0) return
        const activeEl = document.activeElement
        const currentIndex = buttons.indexOf(activeEl as HTMLButtonElement)
        event.preventDefault()
        if (event.key === 'ArrowDown') {
          const next = currentIndex < buttons.length - 1 ? currentIndex + 1 : 0
          buttons[next]?.focus()
        } else {
          const prev = currentIndex > 0 ? currentIndex - 1 : buttons.length - 1
          buttons[prev]?.focus()
        }
      }
    }
    place()
    menuRef.current?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focusOutside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', focusOutside)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  if (summary === undefined || summary === null || rootSessionId === undefined || children.length === 0) return null

  const openController = async () => {
    const operation = operationRef.current + 1
    operationRef.current = operation
    setOpeningId(rootSessionId)
    setFailedId(undefined)
    setFailureReason(undefined)
    try {
      const opened = await openMain(rootSessionId)
      if (operationRef.current !== operation) return
      if (opened) setOpen(false)
      else setFailedId(rootSessionId)
    } catch {
      if (operationRef.current === operation) setFailedId(rootSessionId)
    } finally {
      if (operationRef.current === operation) setOpeningId(undefined)
    }
  }

  const openTask = (task: TeamConsoleTask) => {
    const childId = task.childSessionId!
    const operation = operationRef.current + 1
    operationRef.current = operation
    setOpeningId(childId)
    setFailedId(undefined)
    setFailureReason(undefined)
    void openChild(summary.controllerSessionId, childId, true).then(ok => {
      if (operationRef.current !== operation) return
      if (ok) setOpen(false)
      else setFailedId(childId)
    }).catch(error => {
      if (operationRef.current === operation) {
        setFailureReason(error instanceof Error && error.name === 'YuqiTeamChildNavigationError' ? error.message : copy.openFailed)
        setFailedId(childId)
      }
    }).finally(() => {
      if (operationRef.current === operation) setOpeningId(undefined)
    })
  }

  const archiveTask = async (task: TeamConsoleTask) => {
    const childId = task.childSessionId!
    if (archiveChild === undefined || archived.has(childId) || archivingId !== undefined) return
    setArchivingId(childId)
    setFailedId(undefined)
    setArchiveFailedId(undefined)
    const accepted = await archiveChild(summary.team.id, childId).catch(() => false)
    setArchivingId(undefined)
    if (!accepted) {
      setArchiveFailedId(childId)
      return
    }
    if (childId === String(sessionId)) {
      await openController()
    }
  }

  const runningTasksCount = children.filter(task => task.status === 'running').length

  const activeModel = (() => {
    if (currentTask) return currentTask.model.split('/').pop()?.toUpperCase() ?? currentTask.model
    if (String(sessionId) === String(rootSessionId)) return 'ORCHESTRATOR'
    return visibleChildren[0]?.model.split('/').pop()?.toUpperCase() ?? 'DEEPSEEK'
  })()

  const displayedModel = (() => {
    if (hoveredTask === 'controller') return 'ORCHESTRATOR'
    if (hoveredTask) {
      return hoveredTask.model.split('/').pop()?.toUpperCase() ?? hoveredTask.model
    }
    return activeModel
  })()

  return (
    <div className="yuqi-session-navigator" lang={localeLanguageTag(locale)}>
      <button
        ref={triggerRef}
        type="button"
        className="yuqi-header-settings-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="yuqi-session-navigation-dialog"
        onClick={() => { setFailedId(undefined); setOpen(value => !value) }}
      >
        {summary.team.status === 'running' ? <span aria-hidden="true" className="yuqi-status-success" style={{ marginRight: 5 }}>●</span> : null}
        {currentTask === undefined ? copy.sessions(children.length) : copy.current(children.indexOf(currentTask) + 1, children.length)}
      </button>
      {open ? createPortal(
        <div ref={menuRef} tabIndex={-1} lang={localeLanguageTag(locale)} style={{ position: 'fixed', right: 'auto', ...position, zIndex: 1400 }} className="yuqi-session-menu" id="yuqi-session-navigation-dialog" role="dialog" aria-label={copy.dialogLabel}>
          <header className="yuqi-session-menu-header">
            <div className="yuqi-session-menu-title-wrap">
              <svg className="yuqi-session-header-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="10" cy="4" r="2.5" />
                <circle cx="4.5" cy="15" r="2" />
                <circle cx="15.5" cy="15" r="2" />
                <path d="M10 6.5V11m0 0L6.1 13.8M10 11l3.9 2.8" />
              </svg>
              <strong title={summary.team.title}>{summary.team.title}</strong>
            </div>
            <div className="yuqi-session-menu-header-meta">
              <span className="yuqi-session-running-count">{copy.runningCount(runningTasksCount)}</span>
              <kbd className="yuqi-session-kbd">ESC</kbd>
            </div>
          </header>
          <div className="yuqi-session-list" onPointerLeave={() => setHoveredTask(undefined)}>
            <div className="yuqi-session-group-header">
              <span>{copy.orchestratorGroup}</span>
            </div>
            <SessionRow
              active={String(sessionId) === String(rootSessionId)}
              disabled={openingId === rootSessionId}
              index="M"
              title={copy.main}
              detail={summary.team.objective}
              meta={`${formatTeamStatus(summary.team.status, locale)} · ${summary.tasks.length} ${copy.tasks}`}
              opening={openingId === rootSessionId}
              copy={copy}
              onOpen={() => { void openController() }}
              onHoverChange={hovering => setHoveredTask(hovering ? 'controller' : undefined)}
            />
            <div className="yuqi-session-group-header">
              <span>{copy.subagentsGroup(visibleChildren.length)}</span>
              <span className="yuqi-session-group-sub" title={copy.modelBadgeHint}>{displayedModel}</span>
            </div>
            {visibleChildren.map((task) => (
              <ChildRow key={`${summary.team.id}:${task.taskId}:${task.childSessionId}`} task={task}
                index={children.indexOf(task) + 1} active={task.childSessionId === String(sessionId)} locale={locale}
                opening={openingId === task.childSessionId} disabled={openingId === task.childSessionId}
                onOpen={() => openTask(task)} onArchive={() => { void archiveTask(task) }} archiveDisabled={archiveChild === undefined || archivingId !== undefined}
                onHoverChange={hovering => setHoveredTask(hovering ? task : undefined)} />
            ))}
            {archivedChildren.length === 0 ? null : (
              <details className="yuqi-archived-sessions">
                <summary>{copy.archived(archivedChildren.length)}</summary>
                {archivedChildren.map(task => (
                  <ChildRow key={`${summary.team.id}:archived:${task.taskId}:${task.childSessionId}`} task={task}
                    index={children.indexOf(task) + 1} active={task.childSessionId === String(sessionId)} locale={locale}
                    opening={openingId === task.childSessionId} disabled={openingId === task.childSessionId} archived archiveDisabled
                    onOpen={() => openTask(task)}
                    onArchive={() => undefined}
                    onHoverChange={hovering => setHoveredTask(hovering ? task : undefined)} />
                ))}
              </details>
            )}
            {failedId === undefined ? null : <p role="alert">{failedId === rootSessionId ? copy.openMainFailed : failureReason ?? copy.openFailed}<span> {copy.openFailureNote}</span></p>}
            {archiveFailedId === undefined ? null : <p role="alert">{copy.archiveFailed}</p>}
          </div>
          <footer className="yuqi-session-footer">
            <div className="yuqi-session-footer-shortcuts">
              <span>{copy.footerNav}</span>
              <span>·</span>
              <span>{copy.footerSwitch}</span>
              <span>·</span>
              <span>{copy.footerDirect}</span>
            </div>
            <div className="yuqi-session-footer-count">
              {copy.activeSessionCount(children.length + 1)}
            </div>
          </footer>
        </div>
      , document.body) : null}
    </div>
  )
}

function ChildRow({ task, index, active, locale, opening, disabled, archived = false, archiveDisabled = false, onOpen, onArchive, onHoverChange }: {
  readonly task: TeamConsoleTask
  readonly index: number
  readonly active: boolean
  readonly locale: YuqiLocale
  readonly opening: boolean
  readonly disabled: boolean
  readonly archived?: boolean
  readonly archiveDisabled?: boolean
  readonly onOpen: () => void
  readonly onArchive: () => void
  readonly onHoverChange?: (hovered: boolean) => void
}) {
  const copy = COPY[locale]
  const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
  const detailId = `yuqi-session-detail-${task.taskId.replaceAll(/[^A-Za-z0-9_-]/gu, '-')}`
  const usage = task.usage === undefined ? undefined : presentTaskUsage(task.usage, locale)
  const tooltip = useTooltipPosition()
  const displayIndex = String(index).padStart(2, '0')
  const cleanModel = task.model.split('/').pop() ?? task.model

  return (
    <div
      className={`yuqi-session-row${active ? ' yuqi-session-row-active' : ''}`}
      onPointerEnter={event => { tooltip.place(event.currentTarget); onHoverChange?.(true) }}
      onPointerLeave={() => { onHoverChange?.(false) }}
      onFocus={event => { tooltip.place(event.currentTarget); onHoverChange?.(true) }}
      onBlur={() => { onHoverChange?.(false) }}
    >
      <button type="button" className="yuqi-session-open" disabled={disabled || active || task.status === 'cancelled'} aria-describedby={detailId} title={task.status === 'cancelled' ? (locale === 'en' ? 'Cancelled task: view retained records in the Team panel or controller.' : '已取消任务：请在团队面板或主控查看保留记录。') : undefined} onClick={onOpen}>
        <div className="yuqi-session-open-left">
          <span className="yuqi-session-index">{displayIndex}</span>
          <div className="yuqi-session-info">
            <strong className="yuqi-session-title">{task.goal}</strong>
            <small className="yuqi-session-sub">
              {task.status === 'running' ? <span aria-hidden="true" className="yuqi-session-dot" /> : null}
              <span>{formatTaskStatus(task.status, locale)}</span>
              <span className="yuqi-session-sub-dot">·</span>
              <span className="yuqi-session-model">{cleanModel}</span>
            </small>
          </div>
        </div>
        <div className="yuqi-session-open-right">
          {task.status === 'cancelled' ? (
            <span className="yuqi-session-hint">{locale === 'en' ? 'Record only' : '仅保留'}</span>
          ) : active ? (
            <span className="yuqi-session-badge-current">{copy.currentSession}</span>
          ) : opening ? (
            <span className="yuqi-session-hint">{copy.opening}</span>
          ) : (
            <span className="yuqi-session-action-hint">{copy.enterHint}</span>
          )}
        </div>
      </button>
      {terminal ? (
        <button type="button" className="yuqi-session-archive" disabled={archiveDisabled || archived}
          title={archived ? copy.archivedState : copy.archive}
          aria-label={labelValue(copy.archive, task.goal, locale)} onClick={onArchive}>
          {archived ? copy.archivedState : copy.archive}
        </button>
      ) : null}
      <div className="yuqi-session-detail" style={tooltip.style} id={detailId} role="tooltip">
        <strong>{task.goal}</strong>
        <span>{labelValue(copy.taskId, task.taskId, locale)}</span>
        <span>{labelValue(copy.role, task.modelRole, locale)}</span>
        <span>{labelValue(copy.status, formatTaskStatus(task.status, locale), locale)}</span>
        <span>{labelValue(copy.model, task.model, locale)}</span>
        <span>{labelValue(copy.usage, usage?.detailLabel ?? (locale === 'en' ? 'No data' : '暂无数据'), locale)}</span>
      </div>
    </div>
  )
}

function SessionRow({ active, disabled, index, title, detail, meta, opening, copy, onOpen, onHoverChange }: {
  readonly active: boolean
  readonly disabled: boolean
  readonly index: string
  readonly title: string
  readonly detail: string
  readonly meta: string
  readonly opening: boolean
  readonly copy: (typeof COPY)[YuqiLocale]
  readonly onOpen: () => void
  readonly onHoverChange?: (hovered: boolean) => void
}) {
  const tooltip = useTooltipPosition()
  return (
    <div
      className={`yuqi-session-row${active ? ' yuqi-session-row-active' : ''}`}
      onPointerEnter={event => { tooltip.place(event.currentTarget); onHoverChange?.(true) }}
      onPointerLeave={() => { onHoverChange?.(false) }}
      onFocus={event => { tooltip.place(event.currentTarget); onHoverChange?.(true) }}
      onBlur={() => { onHoverChange?.(false) }}
    >
      <button type="button" className="yuqi-session-open" disabled={active || disabled} aria-describedby={`${index}-session-detail`} onClick={onOpen}>
        <div className="yuqi-session-open-left">
          <span className="yuqi-session-index yuqi-session-index-master">{index}</span>
          <div className="yuqi-session-info">
            <strong className="yuqi-session-title">{title}</strong>
            <small className="yuqi-session-sub">{meta}</small>
          </div>
        </div>
        <div className="yuqi-session-open-right">
          {active ? (
            <span className="yuqi-session-badge-current">{copy.currentSession}</span>
          ) : opening ? (
            <span className="yuqi-session-hint">{copy.opening}</span>
          ) : (
            <span className="yuqi-session-action-hint">{copy.enterHint}</span>
          )}
        </div>
      </button>
      <div className="yuqi-session-detail" style={tooltip.style} id={`${index}-session-detail`} role="tooltip"><strong>{title}</strong><span>{detail}</span></div>
    </div>
  )
}

function useTooltipPosition() {
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  return { style, place: (row: HTMLElement) => {
    const rect = row.getBoundingClientRect()
    const width = Math.min(340, window.innerWidth - 24)
    const rightRoom = window.innerWidth - rect.right - 12
    const left = rightRoom >= width + 8 ? rect.right + 8 : rect.left >= width + 20 ? rect.left - width - 8 : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const top = Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 260))
    setStyle({ position: 'fixed', visibility: 'visible', left, top, right: 'auto', width, maxHeight: Math.max(80, window.innerHeight - top - 12), overflow: 'auto', margin: 0, zIndex: 1401 })
  } }
}

const COPY = defineLocalizedCopy({
  zh: {
    openMainFailed: '主控会话地址暂不可用或导航失败，请刷新会话目录后重试。',
    sessions: (count: number) => `子代理会话 ${count}`,
    current: (index: number, count: number) => `子代理 ${index}/${count}`,
    dialogLabel: 'Team 会话导航', switchHint: '切换主控或子代理会话', main: 'Team 主控会话', tasks: '个任务', open: '打开', opening: '打开中…', currentSession: '当前',
    orchestratorGroup: '主控编排',
    subagentsGroup: (count: number) => `子代理节点 (${count})`,
    modelBadgeHint: '当前或光标所指会话的模型',
    runningCount: (count: number) => `${count} 运行中`,
    enterHint: '切入 ↵',
    footerNav: '↑↓ 选择',
    footerSwitch: '↵ 切换',
    footerDirect: '点击直达',
    activeSessionCount: (count: number) => `共 ${count} 个活跃会话`,
    archived: (count: number) => `已归档 ${count}`, archive: '归档', archivedState: '已归档', activeArchiveBlocked: '运行中的子代理不能归档',
    openFailed: '该子代理会话目录暂未就绪；这不表示任务已停止。请刷新 Team 状态后重试。', openFailureNote: '导航失败不证明任务停止；状态仅来自当前记录，请刷新 Team 状态。', archiveFailed: '归档失败，子代理会话未发生变化。', taskId: '任务 ID', role: '角色', status: '状态', model: '模型', usage: '用量',
  },
  en: {
    openMainFailed: 'The controller address is unavailable or navigation failed. Refresh the session catalog and retry.',
    sessions: (count: number) => `Child sessions ${count}`,
    current: (index: number, count: number) => `Child ${index}/${count}`,
    dialogLabel: 'Team session navigation', switchHint: 'Switch between the controller and child sessions', main: 'Team controller session', tasks: 'tasks', open: 'Open', opening: 'Opening…', currentSession: 'Current',
    orchestratorGroup: 'Orchestrator',
    subagentsGroup: (count: number) => `Child agents (${count})`,
    modelBadgeHint: 'Model of current or focused session',
    runningCount: (count: number) => `${count} running`,
    enterHint: 'Enter ↵',
    footerNav: '↑↓ Select',
    footerSwitch: '↵ Switch',
    footerDirect: 'Click to jump',
    activeSessionCount: (count: number) => `${count} active sessions`,
    archived: (count: number) => `Archived ${count}`, archive: 'Archive', archivedState: 'Archived', activeArchiveBlocked: 'A running child cannot be archived',
    openFailed: 'The child-session catalog is not ready; this does not mean the task stopped. Refresh the Team state and retry.', openFailureNote: 'A navigation failure does not prove the task stopped; status is only the current record. Refresh the Team state.', archiveFailed: 'Archiving failed. The child conversation is unchanged.', taskId: 'Task ID', role: 'Role', status: 'Status', model: 'Model', usage: 'Usage',
  },
})
