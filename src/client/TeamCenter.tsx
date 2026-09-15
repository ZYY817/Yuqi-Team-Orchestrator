import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { taskStatusMeta, teamDisplayStatus } from './status.ts'
import { restoreTeamDock, setTeamArchived, useAllTeamUiPreferences, useTeamUiPreference } from './team-ui-preferences.ts'
import { setYuqiLocale, useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { requestTeamSettingsOpen, subscribeTeamSettingsOpen } from './team-settings-events.ts'
import { formatAttentionMessage, localeLanguageTag } from './i18n.ts'
import { sessionPreset } from './session-preset.ts'
import { NativeInteractionDetails, interactionReminderKey, interactionTarget, isTeamRuntimeSession, type GlobalTeamAttentionInjected } from './GlobalTeamAttention.tsx'
import { OPEN_TEAM_ATTENTION_EVENT, requestTeamPanelOpen } from './team-panel-events.ts'
import { TeamPanel } from './TeamPanel.tsx'
import {
  attentionDecisionKey,
  dismissDecisionReminder,
  dismissAttentionReminder,
  isDecisionDismissed,
  undismissDecisionReminder,
  useDismissedReminderKeys,
} from './attention-reminder-preferences.ts'

interface SessionRow {
  readonly id: SessionId
  readonly displayTitle: string
  readonly parentId?: SessionId
  readonly agentPreset?: string
  readonly cwd?: string
  readonly pendingInteraction?: 'approval' | 'question' | 'plan-review'
  readonly projectionValues?: { readonly yuqiTeam?: TeamConsoleSummary | null }
}

interface SessionListSnapshot {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<SessionId, SessionRow>>
  readonly current?: SessionId | undefined
}

type TeamDataStatus = 'loading' | 'ready' | 'error' | 'cancelled'

interface TeamDataSnapshot {
  readonly status: TeamDataStatus
  readonly error?: string
  readonly unavailable?: ReadonlySet<string>
}

interface TeamDataSource {
  getSnapshot(): TeamDataSnapshot
  subscribe(listener: () => void): () => void
  refresh?(): Promise<void>
}

const READY_TEAM_DATA_SNAPSHOT: TeamDataSnapshot = { status: 'ready' }
const READY_TEAM_DATA: TeamDataSource = {
  getSnapshot: () => READY_TEAM_DATA_SNAPSHOT,
  subscribe: () => () => undefined,
}

export interface TeamCenterInjected {
  /** Official sidebar footer owner state; omitted in standalone component tests. */
  readonly wide?: boolean
  readonly sessions: { getSnapshot(): SessionListSnapshot; subscribe(listener: () => void): () => void }
  /** The catalog is empty while the sidecar is unavailable. Keep its state so the UI never labels unknown data as zero. */
  readonly teamData?: TeamDataSource
  readonly openMain: (sessionId: SessionId) => boolean | Promise<boolean>
  readonly openChild: (controllerSessionId: string | undefined, childSessionId: string) => Promise<boolean>
  readonly archiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
  /** Supplies read-only evidence loaders without attaching or navigating a Session. */
  readonly wrapHistory?: (panel: ReactNode) => ReactNode
  readonly renderSettings?: (onDraftStateChange: (dirty: boolean, saving: boolean) => void) => ReactNode
  readonly getNativeInteractions?: GlobalTeamAttentionInjected['getNativeInteractions']
  readonly subscribeNativeInteractions?: GlobalTeamAttentionInjected['subscribeNativeInteractions']
  /** Existing cross-conversation binding command; it reports only durable success. */
  readonly attachToCurrent?: (summary: TeamConsoleSummary, currentSessionId: SessionId) => Promise<boolean>
}

/** Lightweight management surface that stays separate from the native workspace tree. */
export function TeamCenter({ wide = true, sessions, teamData: injectedTeamData, openMain, openChild, archiveChild, wrapHistory, renderSettings, getNativeInteractions, subscribeNativeInteractions, attachToCurrent }: TeamCenterInjected) {
  const locale = useYuqiLocale()
  const copy = CENTER_COPY[locale]
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const teamData = injectedTeamData ?? READY_TEAM_DATA
  const teamDataSnapshot = useSyncExternalStore(teamData.subscribe, teamData.getSnapshot, teamData.getSnapshot)
  const teamDataComplete = teamDataSnapshot.status === 'ready' && (teamDataSnapshot.unavailable?.size ?? 0) === 0
  const preferences = useAllTeamUiPreferences()
  const dismissedReminderKeys = useDismissedReminderKeys()
  const [open, setOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [attachingTeamId, setAttachingTeamId] = useState<string>()
  const [quickError, setQuickError] = useState<string>()
  const quickTriggerRef = useRef<HTMLButtonElement>(null)
  const quickMenuRef = useRef<HTMLElement>(null)
  const [quickPosition, setQuickPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const attachOperation = useRef<object>()
  useEffect(() => () => { attachOperation.current = undefined }, [])
  useEffect(() => {
    attachOperation.current = undefined
    setAttachingTeamId(undefined)
    setQuickError(undefined)
    setQuickOpen(false)
  }, [snapshot.current])
  const [, refreshNative] = useState(0)
  useEffect(() => {
    const unsubscribes = snapshot.ids.filter(id => snapshot.byId[id]?.pendingInteraction)
      .map(id => subscribeNativeInteractions?.(id, () => refreshNative(value => value + 1)))
    return () => unsubscribes.forEach(unsubscribe => unsubscribe?.())
  }, [snapshot, subscribeNativeInteractions])
  const [historySummary, setHistorySummary] = useState<TeamConsoleSummary>()
  useEffect(() => {
    setHistorySummary(previous => previous === undefined ? previous : Object.values(snapshot.byId)
      .map(row => row?.projectionValues?.yuqiTeam)
      .find(summary => summary?.team.id === previous.team.id && summary.controllerSessionId === previous.controllerSessionId) ?? undefined)
  }, [snapshot])
  const closeHistory = useCallback(() => setHistorySummary(undefined), [])
  // The installed management surface starts with defaults. The fallback used
  // by older Hosts has no embedded settings form, so it opens the usable Team
  // list instead of presenting a dead settings page.
  const [tab, setTab] = useState<'settings' | 'teams' | 'attention'>(() => renderSettings ? 'settings' : 'teams')
  const [teamFilter, setTeamFilter] = useState<'active' | 'history' | 'archived'>('active')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(20)
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([])
  const [attentionFilter, setAttentionFilter] = useState<'pending' | 'read'>('pending')
  const draftState = useRef({ dirty: false, saving: false })
  const openingMain = useRef(false)
  const onDraftStateChange = useCallback((dirty: boolean, saving: boolean) => { draftState.current = { dirty, saving } }, [])
  const requestClose = useCallback(() => {
    if (draftState.current.saving) return false
    if (draftState.current.dirty && !window.confirm(locale === 'en' ? 'Discard unsaved settings and close?' : '设置尚未保存，确定放弃修改并关闭？')) return false
    draftState.current = { dirty: false, saving: false }
    setOpen(false)
    return true
  }, [locale])
  useEffect(() => subscribeTeamSettingsOpen(page => { if (renderSettings) { setTab(page); setOpen(true) } }), [renderSettings])
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  const teams = useMemo(() => {
    const unique = new Map<string, { row: SessionRow; summary: TeamConsoleSummary }>()
    for (const id of snapshot.ids) {
      const row = snapshot.byId[id]
      const summary = row?.projectionValues?.yuqiTeam
      if (row === undefined || summary == null) continue
      const existing = unique.get(summary.team.id)
      if (existing === undefined || (isHiddenController(existing.row, existing.summary) && !isHiddenController(row, summary))) {
        unique.set(summary.team.id, { row, summary })
      }
    }
    return [...unique.values()]
  }, [snapshot])
  useEffect(() => {
    const openAttention = (event: Event) => {
      const teamId = (event as CustomEvent<{ teamId?: unknown }>).detail?.teamId
      if (typeof teamId !== 'string' || !teams.some(item => item.summary.team.id === teamId)) return
      setQuickOpen(false)
      setAttentionFilter('pending')
      setTab('attention')
      setOpen(true)
    }
    window.addEventListener(OPEN_TEAM_ATTENTION_EVENT, openAttention)
    return () => window.removeEventListener(OPEN_TEAM_ATTENTION_EVENT, openAttention)
  }, [teams])
  const activeTeams = teams.filter(item => preferences[item.summary.team.id]?.teamArchived !== true)
  const archivedTeams = teams.filter(item => preferences[item.summary.team.id]?.teamArchived === true)
  const filteredTeams = (teamFilter === 'archived' ? archivedTeams : activeTeams.filter(item => isTerminalTeam(item.summary) === (teamFilter === 'history')))
    .filter(item => `${item.summary.team.title} ${item.summary.team.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const visibleTeams = filteredTeams.slice(0, limit)
  const attentionTeams = activeTeams.filter(item => !isTerminalTeam(item.summary) && userDecisionCount(item.summary) > 0)
  const nativeDecisions = snapshot.ids.flatMap(id => {
    const row = snapshot.byId[id]
    if (!row?.pendingInteraction) return []
    const ownSummary = row.projectionValues?.yuqiTeam
    if (!isTeamRuntimeSession(row) && ownSummary == null) return []
    const target = ownSummary == null ? interactionTarget(snapshot, row, locale) : { row, summary: ownSummary }
    if (target && preferences[target.summary.team.id]?.teamArchived) return []
    const interactions = getNativeInteractions?.(id) ?? []
    if (target && isTerminalTeam(target.summary) && interactions.length === 0) return []
    return [{ row, target, interactions, key: interactionReminderKey(row, interactions) }]
  })
  const allDecisions = useMemo(() => attentionTeams.flatMap(({ row, summary }) =>
    userDecisions(summary, locale).map(decision => ({ row, summary, decision })),
  ), [attentionTeams, locale])
  const activeDecisions = useMemo(() => allDecisions.filter(({ summary, decision }) =>
    !isDecisionDismissed(dismissedReminderKeys, summary.team.id, decision.key),
  ), [allDecisions, dismissedReminderKeys])
  const readDecisions = useMemo(() => allDecisions.filter(({ summary, decision }) =>
    isDecisionDismissed(dismissedReminderKeys, summary.team.id, decision.key),
  ), [allDecisions, dismissedReminderKeys])
  const activeNativeDecisions = nativeDecisions.filter(item => !dismissedReminderKeys.has(item.key))
  const readNativeDecisions = nativeDecisions.filter(item => dismissedReminderKeys.has(item.key))
  const attention = activeDecisions.length + activeNativeDecisions.length
  // Only an explicit read action changes the badge; closing a surface does not.
  const badgeAttention = activeDecisions.length + activeNativeDecisions.length
  const currentTeamId = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]?.projectionValues?.yuqiTeam?.team.id
  const quickDecisions = activeDecisions.filter(({ summary }) => summary.team.id !== currentTeamId)
  const quickNativeDecisions = activeNativeDecisions.filter(({ target }) => target === undefined || target.summary.team.id !== currentTeamId)
  const quickCount = quickDecisions.length + quickNativeDecisions.length
  const currentRow = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]
  const canAttach = (row: SessionRow, summary: TeamConsoleSummary) => attachToCurrent !== undefined && summary.controllerSessionId !== undefined && currentRow !== undefined
    && currentRow.parentId === undefined && sessionPreset(currentRow) === 'yuqi-team' && currentRow.id !== row.id && samePath(currentRow.cwd, row.cwd)
  const attach = (row: SessionRow, summary: TeamConsoleSummary) => {
    if (attachOperation.current || !canAttach(row, summary) || snapshot.current === undefined || attachToCurrent === undefined) return
    const operation = {}
    attachOperation.current = operation
    setQuickError(undefined); setAttachingTeamId(summary.team.id)
    void attachToCurrent(summary, snapshot.current).then(attached => {
      if (attachOperation.current !== operation) return
      if (!attached) setQuickError(locale === 'en' ? 'The Team could not be attached. Check the connection and retry.' : 'Team 未能切换到当前对话，请检查连接后重试。')
      else setQuickOpen(false)
    }, () => {
      if (attachOperation.current === operation) setQuickError(locale === 'en' ? 'The attachment result is unconfirmed. Refresh Team state before retrying.' : '尚未确认切换结果，请刷新 Team 状态后再重试。')
    }).finally(() => {
      if (attachOperation.current !== operation) return
      attachOperation.current = undefined
      setAttachingTeamId(undefined)
    })
  }
  const selectedTeams = filteredTeams.filter(({ summary }) => selectedIds.includes(summary.team.id))
  const changeTeamFilter = (value: typeof teamFilter) => { setTeamFilter(value); setLimit(20); setSelecting(false); setSelectedIds([]) }
  const navigateMain = async (row: SessionRow, summary?: TeamConsoleSummary) => {
    if (openingMain.current || draftState.current.saving) return
    if (draftState.current.dirty && !window.confirm(locale === 'en' ? 'Leave and discard unsaved settings?' : '离开并放弃未保存的设置？')) return
    openingMain.current = true
    setError(undefined)
    const unavailable = () => {
      const latest = sessions.getSnapshot().byId[row.id]?.projectionValues?.yuqiTeam
      const targetSummary = (latest != null && latest.team.id === summary?.team.id) ? latest : summary
      // A retained terminal Team may be inspected locally as read-only history.
      // An active Team must instead report failed navigation: opening a local
      // panel would falsely imply that its controller transcript was reached.
      if (targetSummary !== undefined && isTerminalTeam(targetSummary)) {
        setHistorySummary(targetSummary)
        return
      }
      setError(copy.openMainFailed)
      setQuickError(copy.openMainFailed)
    }
    try {
      if (!await openMain(row.id)) { unavailable(); return }
      draftState.current = { dirty: false, saving: false }
      setOpen(false)
      setQuickOpen(false)
      if (summary !== undefined) requestTeamPanelOpen(summary.team.id)
    } catch {
      unavailable()
    } finally {
      openingMain.current = false
    }
  }
  const viewTeam = (row: SessionRow, summary: TeamConsoleSummary) => { void navigateMain(row, summary) }
  const showAttention = () => {
    setQuickOpen(false)
    setAttentionFilter('pending')
    setTab('attention')
    setOpen(true)
  }
  useEffect(() => { if (open) setQuickOpen(false) }, [open])
  useLayoutEffect(() => {
    if (!quickOpen) return
    const place = () => {
      const anchor = quickTriggerRef.current?.getBoundingClientRect()
      const menu = quickMenuRef.current
      if (!anchor || !menu) return
      const width = Math.min(360, window.innerWidth - 16)
      const maxHeight = Math.max(80, Math.min(440, window.innerHeight - 16))
      const height = Math.min(menu.scrollHeight, maxHeight)
      const left = anchor.right + 8 + width <= window.innerWidth - 8 ? anchor.right + 8 : Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
      const top = Math.max(8, Math.min(anchor.bottom - height, window.innerHeight - height - 8))
      setQuickPosition({ inset: 'auto', left, top, width, maxHeight, visibility: 'visible' })
    }
    place()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (quickMenuRef.current) observer?.observe(quickMenuRef.current)
    if (quickTriggerRef.current) observer?.observe(quickTriggerRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [quickOpen, quickCount, wide])
  useEffect(() => {
    if (!open || historySummary !== undefined) return undefined
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab' || dialog === null) return
      event.stopImmediatePropagation()
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
        if (element.closest('[hidden]')) return false
        for (let parent = element.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
        }
        return true
      })
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus()
    }
  }, [open, historySummary, requestClose])

  const openSettings = () => {
    if (renderSettings) { setTab('settings'); return }
    setError(undefined)
    setOpen(false)
    requestTeamSettingsOpen()
    window.setTimeout(() => {
      if (document.querySelector('[data-yuqi-team-settings-dialog="true"]') !== null) return
      setOpen(true)
      setError(copy.settingsUnavailable)
    }, 0)
  }

  const openChildWithFeedback = async (controllerSessionId: string | undefined, childSessionId: string) => {
    setError(undefined)
    try {
      if (draftState.current.saving) return
      if (draftState.current.dirty && !window.confirm(locale === 'en' ? 'Leave and discard unsaved settings?' : '离开并放弃未保存的设置？')) return
      if (await openChild(controllerSessionId, childSessionId)) { draftState.current = { dirty: false, saving: false }; setOpen(false) }
      else setError(copy.openChildRejected)
    } catch {
      setError(copy.openChildFailed)
    }
  }
  useEffect(() => {
    if (!quickOpen) return undefined
    quickMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    // Hosts may restore focus to the clicked footer action after React effects.
    const focusFrame = window.requestAnimationFrame?.(() => quickMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const buttons = [...(quickMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        if (!quickMenuRef.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus() }
        else if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus() }
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      setQuickOpen(false)
      quickTriggerRef.current?.focus()
    }
    window.addEventListener('keydown', close, true)
    return () => { window.removeEventListener('keydown', close, true); if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame) }
  }, [quickOpen])
  useEffect(() => {
    if (!quickOpen) return undefined
    const closeOutside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || quickMenuRef.current?.contains(target) || quickTriggerRef.current?.contains(target)) return
      setQuickOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside, true)
    return () => window.removeEventListener('pointerdown', closeOutside, true)
  }, [quickOpen])
  return (
    <>
      <div className="yuqi-team-center-entry" data-collapsed={!wide}>
      <button type="button" className="yuqi-team-center-trigger" data-collapsed={!wide}
        title={badgeAttention > 0 ? copy.openWithAttention(badgeAttention) : copy.trigger}
        aria-expanded={open}
        aria-label={badgeAttention > 0 ? copy.openWithAttention(badgeAttention) : copy.open}
        onClick={() => setOpen(true)}>
        <span className="yuqi-team-center-icon" aria-hidden="true"><TeamIcon /></span><span className="yuqi-team-center-trigger-label">{copy.trigger}</span>{badgeAttention > 0 && quickCount === 0 ? <b title={copy.attentionCount(badgeAttention)}>{badgeAttention}</b> : null}
      </button>
      {quickCount > 0 || quickOpen ? <button ref={quickTriggerRef} type="button" className="yuqi-team-attention-launch" title={locale === 'en' ? `View pending ${quickCount}` : `查看待办 ${quickCount}`} aria-label={locale === 'en' ? `View pending ${quickCount}` : `查看待办 ${quickCount}`} aria-haspopup="dialog" aria-expanded={quickOpen} aria-controls={quickOpen ? 'yuqi-team-attention-menu' : undefined} onClick={() => setQuickOpen(value => !value)}>{quickCount}<span aria-hidden="true"> ›</span></button> : null}
      </div>
      {quickOpen ? createPortal(<section ref={quickMenuRef} style={quickPosition} id="yuqi-team-attention-menu" className="yuqi-team-attention-menu" role="dialog" aria-label={locale === 'en' ? 'Other Team items needing attention' : '其他团队待处理事项'}>
        <header><strong>{locale === 'en' ? `Pending items · ${quickCount}` : `待处理事项 · ${quickCount}`}</strong><button type="button" className="yuqi-close-button" aria-label={locale === 'en' ? 'Close pending items' : '关闭待处理事项'} onClick={() => { setQuickOpen(false); quickTriggerRef.current?.focus() }}>×</button></header>
        {!teamDataComplete ? <p role="status">{locale === 'en' ? 'Some Team data is unavailable; this list may be incomplete.' : '部分团队数据暂不可用，待办列表可能不完整。'}</p> : null}
        {quickCount === 0 ? <p>{locale === 'en' ? 'No other Team needs your input.' : '其他团队当前没有需要你处理的事项。'}</p> : <ol>
          {quickNativeDecisions.map(({ row, target, key }) => <li key={key}><div><strong>{target?.summary.team.title || row.displayTitle || 'Yuqi Team'}</strong><small>{row.pendingInteraction === 'approval' ? (locale === 'en' ? 'Permission request' : '权限请求') : row.pendingInteraction === 'plan-review' ? (locale === 'en' ? 'Plan review' : '计划待确认') : (locale === 'en' ? 'Your response is needed' : '需要你的回答')}</small></div><button type="button" className="yuqi-primary-action" onClick={showAttention}>{locale === 'en' ? 'View question' : '查看问题'}</button></li>)}
          {quickDecisions.map(({ row, summary, decision }) => <li key={`${summary.team.id}:${decision.key}`}><div><strong>{summary.team.title || 'Yuqi Team'}</strong><small>{decision.message}</small></div><span className="yuqi-team-attention-menu-actions"><button type="button" className="yuqi-primary-action" onClick={() => decision.key === 'plan-confirmation' ? viewTeam(row, summary) : showAttention()}>{decision.key === 'plan-confirmation' ? (locale === 'en' ? 'View tasks' : '查看任务') : (locale === 'en' ? 'View question' : '查看问题')}</button>{canAttach(row, summary) ? <button type="button" className="yuqi-secondary-action" disabled={attachingTeamId !== undefined} onClick={() => attach(row, summary)}>{attachingTeamId === summary.team.id ? (locale === 'en' ? 'Switching…' : '切换中…') : (locale === 'en' ? 'Attach here' : '切换到当前对话')}</button> : null}</span></li>)}
        </ol>}
        {quickError === undefined ? null : <p className="yuqi-inline-error" role="alert">{quickError}</p>}
        <footer><button type="button" className="yuqi-secondary-action" onClick={showAttention}>{locale === 'en' ? 'Open Team management' : '打开团队管理'}</button></footer>
      </section>, document.body) : null}
      {historySummary !== undefined && typeof document !== 'undefined' ? createPortal(
        <div className="yuqi-settings-layer yuqi-management-layer" lang={localeLanguageTag(locale)}>
          <button type="button" className="yuqi-settings-backdrop" aria-label={locale === 'en' ? 'Close Team panel (click backdrop)' : '关闭团队面板（点击背景）'} onClick={closeHistory} />
          {wrapHistory ? wrapHistory(<TeamPanel summary={historySummary} historyView onClose={closeHistory} onOpenChild={openChild} nowMs={Date.now()} />)
            : <TeamPanel summary={historySummary} historyView onClose={closeHistory} onOpenChild={openChild} nowMs={Date.now()} />}
        </div>,
        document.body,
      ) : null}
      {open && historySummary === undefined && typeof document !== 'undefined' ? createPortal(
        <div className="yuqi-settings-layer yuqi-management-layer">
          <button type="button" className="yuqi-settings-backdrop" aria-label={copy.closeCenter} onClick={requestClose} />
          <section ref={dialogRef} className="yuqi-team-center yuqi-management" lang={localeLanguageTag(locale)} role="dialog" aria-modal="true" aria-label={copy.title}>
            <nav className="yuqi-settings-nav" aria-label={locale === 'en' ? 'Management pages' : '管理页面'}>
              <div className="yuqi-settings-nav-title">{copy.title}</div>
              <div className="yuqi-settings-nav-list">
                <button
                  type="button"
                  className={`yuqi-settings-nav-cell ${tab === 'settings' ? 'active' : ''}`}
                  aria-current={tab === 'settings' ? 'true' : undefined}
                  onClick={() => setTab('settings')}
                >
                  <SettingsNavIcon />
                  <span className="yuqi-settings-nav-label">{copy.teamDefaults}</span>
                </button>
                <button
                  type="button"
                  className={`yuqi-settings-nav-cell ${tab === 'teams' ? 'active' : ''}`}
                  aria-current={tab === 'teams' ? 'true' : undefined}
                  onClick={() => setTab('teams')}
                >
                  <TasksNavIcon />
                  <span className="yuqi-settings-nav-label">{locale === 'en' ? 'Teams' : '团队任务'}</span>
                </button>
                <button
                  type="button"
                  className={`yuqi-settings-nav-cell ${tab === 'attention' ? 'active' : ''}`}
                  aria-current={tab === 'attention' ? 'true' : undefined}
                  onClick={() => setTab('attention')}
                >
                  <AttentionNavIcon />
                  <span className="yuqi-settings-nav-label">{locale === 'en' ? 'Needs attention' : '待处理事项'}</span>
                  {teamDataComplete && attention > 0 ? <span className="yuqi-count-badge">{attention}</span> : null}
                  {!teamDataComplete ? <span aria-label={locale === 'en' ? 'Count unavailable' : '数量暂不可用'}>—</span> : null}
                </button>
              </div>
            </nav>
            <div className="yuqi-settings-content">
              <header className="yuqi-settings-header">
                <div className="yuqi-management-header-actions">
                  <div className="yuqi-locale-switch" role="group" aria-label={copy.language}>
                    {(['zh', 'en'] as const).map(value => <button key={value} type="button" aria-pressed={locale === value} onClick={() => setYuqiLocale(value)}>{value === 'zh' ? '中文' : 'English'}</button>)}
                  </div>
                  <button type="button" className="yuqi-close-button" aria-label={copy.close} onClick={requestClose}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M14.1168 13.197L13.197 14.1167L1.8833 2.80303L2.80309 1.88324L14.1168 13.197Z" fill="currentColor" />
                      <path d="M13.197 1.88326L14.1168 2.80305L2.80309 14.1168L1.8833 13.197L13.197 1.88326Z" fill="currentColor" />
                    </svg>
                  </button>
                </div>
              </header>
              <div className="yuqi-settings-options">
                <div id="yuqi-center-settings" className="yuqi-management-settings" hidden={tab !== 'settings'}>
                  <p className="yuqi-defaults-intro">{locale === 'en' ? 'These defaults apply to new Teams, not tasks already running.' : '以下设置仅影响新建团队，不改变正在运行的任务。'}</p>
                  <div className="yuqi-management-settings-content">
                    {renderSettings ? renderSettings(onDraftStateChange) : <button type="button" className="yuqi-secondary-action" onClick={openSettings}>{copy.teamDefaults}</button>}
                  </div>
                </div>
                <div className="yuqi-team-center-list" hidden={tab === 'settings'}>
                  {error === undefined ? null : <p className="yuqi-inline-error" role="alert">{error}</p>}
                  <div id="yuqi-center-attention" hidden={tab !== 'attention'}>
                  {teamDataSnapshot.status !== 'ready' ? <TeamDataAvailability locale={locale} state={teamDataSnapshot} {...(teamData.refresh === undefined ? {} : { refresh: teamData.refresh })} /> : <>
                  {!teamDataComplete ? <TeamDataAvailability locale={locale} state={teamDataSnapshot} {...(teamData.refresh === undefined ? {} : { refresh: teamData.refresh })} /> : null}
                  <p className="yuqi-management-help">{locale === 'en' ? 'Decisions that need your input are collected here.' : '这里集中显示需要你决定的事项。'}</p>
                  <div className="yuqi-management-toolbar">
                    <div className="yuqi-toolbar-status-slot">
                      <div className="yuqi-segmented" role="group" aria-label={locale === 'en' ? 'Reminder status' : '提醒状态'}>
                        <button type="button" aria-pressed={attentionFilter === 'pending'} onClick={() => setAttentionFilter('pending')}>{locale === 'en' ? 'Pending' : '待决定'} {attention > 0 ? <span className="yuqi-count-badge">{attention}</span> : null}</button>
                        <button type="button" aria-pressed={attentionFilter === 'read'} onClick={() => setAttentionFilter('read')}>{locale === 'en' ? 'Read' : '已读'} {readDecisions.length + readNativeDecisions.length > 0 ? <span className="yuqi-count-badge">{readDecisions.length + readNativeDecisions.length}</span> : null}</button>
                      </div>
                    </div>
                    <div className="yuqi-toolbar-actions-slot">
                      {attention > 0 ? <button type="button" className="yuqi-text-action" onClick={() => {
                        activeDecisions.forEach(({ summary, decision }) => dismissDecisionReminder(summary.team.id, decision.key))
                        activeNativeDecisions.forEach(item => dismissAttentionReminder(item.key))
                      }}>{locale === 'en' ? 'Mark all as read' : '标记全部已读'}</button> : null}
                    </div>
                  </div>
                  <section className="yuqi-team-center-attention yuqi-attention-grid" aria-label={copy.decisionsRegion}>
                    <ol>
                      {(attentionFilter === 'pending' ? activeNativeDecisions : readNativeDecisions).map(({ row, target, interactions, key }) => <li key={key} className="yuqi-decision-card">
                        <div className="yuqi-decision-context"><small>{row.pendingInteraction === 'approval' ? (locale === 'en' ? 'Permission needed' : '需要你授权') : (locale === 'en' ? 'Your answer is needed' : '需要你回答')}</small><strong title={target?.summary.team.title ?? row.displayTitle}>{target?.summary.team.title || (locale === 'en' ? 'Team waiting conversation' : 'Team 待响应会话')}</strong><p>{target?.taskLabel ?? row.displayTitle}</p></div>
                        <div className="yuqi-decision-body"><NativeInteractionDetails row={row} initial={interactions} locale={locale} getNativeInteractions={getNativeInteractions} subscribeNativeInteractions={subscribeNativeInteractions} /></div>
                        <div className="yuqi-team-center-decision-actions"><button type="button" className="yuqi-secondary-action" onClick={() => { if (target) void navigateMain(target.row); else void openMain(row.id) }}>{target ? copy.openController : (locale === 'en' ? 'Open waiting conversation' : '打开待响应会话')}</button>{attentionFilter === 'pending' ? <button type="button" className="yuqi-text-action" onClick={() => dismissAttentionReminder(key)}>{copy.markAsRead}</button> : null}</div>
                      </li>)}
                    {(attentionFilter === 'pending' ? activeDecisions : readDecisions).map(({ row, summary, decision }) => {
                      const task = decision.taskId === undefined ? undefined : summary.tasks.find(candidate => candidate.taskId === decision.taskId)
                      return <li key={`${summary.team.id}:${decision.key}`} className="yuqi-decision-card">
                        <div className="yuqi-decision-context"><small>{decision.label}</small><strong title={summary.team.title}>{summary.team.title}</strong>{task ? <p title={task.goal}>{task.goal}</p> : null}</div>
                        <div className="yuqi-decision-body"><p>{decision.message}</p><small>{copy.decisionsHelp}</small></div>
                        <div className="yuqi-team-center-decision-actions">
                          <button type="button" className="yuqi-primary-action" onClick={() => viewTeam(row, summary)}>{locale === 'en' ? 'View decision' : '查看并处理'}</button>
                          <button type="button" className="yuqi-secondary-action" onClick={() => { void navigateMain(row) }}>{copy.openController}</button>
                          <button type="button" className="yuqi-text-action" onClick={() => attentionFilter === 'pending' ? dismissDecisionReminder(summary.team.id, decision.key) : undismissDecisionReminder(summary.team.id, decision.key)}>{attentionFilter === 'pending' ? copy.markAsRead : copy.markAsUnread}</button>
                        </div>
                      </li>
                    })}</ol>
                  </section>
                  {teamDataComplete && (attentionFilter === 'pending' ? attention === 0 : readDecisions.length + readNativeDecisions.length === 0) ? <p className="yuqi-team-center-empty">{attentionFilter === 'pending' ? copy.noDecisions : (locale === 'en' ? 'No read reminders.' : '暂无已读事项。')}</p> : null}
                  </>}
                  </div>
                  <div id="yuqi-center-teams" hidden={tab !== 'teams'}>
                  {teamDataSnapshot.status !== 'ready' ? <TeamDataAvailability locale={locale} state={teamDataSnapshot} {...(teamData.refresh === undefined ? {} : { refresh: teamData.refresh })} /> : <>
                  {!teamDataComplete ? <TeamDataAvailability locale={locale} state={teamDataSnapshot} {...(teamData.refresh === undefined ? {} : { refresh: teamData.refresh })} /> : null}
                  <div className="yuqi-management-toolbar">
                    <div className="yuqi-toolbar-status-slot">
                      <div className="yuqi-segmented" role="group" aria-label={locale === 'en' ? 'Team status' : '团队状态'}>
                        {(['active', 'history', 'archived'] as const).map(value => <button key={value} type="button" aria-pressed={teamFilter === value} onClick={() => changeTeamFilter(value)}>{value === 'active' ? (locale === 'en' ? 'Active' : '进行中') : value === 'history' ? (locale === 'en' ? 'History' : '历史记录') : (locale === 'en' ? 'Archived' : '已归档')} <span className="yuqi-count-badge">{value === 'archived' ? archivedTeams.length : activeTeams.filter(item => isTerminalTeam(item.summary) === (value === 'history')).length}</span></button>)}
                      </div>
                    </div>
                    <div className="yuqi-toolbar-search-slot">
                      <input type="search" value={search} aria-label={locale === 'en' ? 'Search Teams' : '搜索团队'} placeholder={locale === 'en' ? 'Search name or Team ID' : '搜索团队名称或 ID'} onChange={event => { setSearch(event.currentTarget.value); setLimit(20) }} />
                    </div>
                    <div className="yuqi-toolbar-actions-slot">
                      {visibleTeams.length > 0 ? <button type="button" className="yuqi-secondary-action yuqi-history-select" aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelectedIds([]) }}>{locale === 'en' ? 'Select records' : (selecting ? '退出多选' : '多选团队')}</button> : null}
                      {selecting && visibleTeams.length > 0 ? <button type="button" className="yuqi-text-action yuqi-select-all-btn" onClick={() => {
                        if (selectedIds.length === visibleTeams.length) {
                          setSelectedIds([])
                        } else {
                          setSelectedIds(visibleTeams.map(item => item.summary.team.id))
                        }
                      }}>
                        {selectedIds.length === visibleTeams.length
                          ? (locale === 'en' ? 'Deselect all' : '取消全选')
                          : (locale === 'en' ? 'Select all' : '全选')}
                      </button> : null}
                    </div>
                  </div>
                  {teamDataComplete && visibleTeams.length === 0 ? <p className="yuqi-team-center-empty">{locale === 'en' ? 'No Teams match this filter.' : '当前筛选下没有团队。'}</p> : null}
                  <div className={teamFilter === 'active' ? 'yuqi-team-card-grid' : 'yuqi-team-history-list'}>
                  {visibleTeams.map(({ row, summary }) => <TeamCenterItem key={`${row.id}:${summary.team.id}`} row={row} summary={summary}
                    compact={teamFilter !== 'active'} selecting={selecting} selected={selectedIds.includes(summary.team.id)}
                    toggleSelected={() => setSelectedIds(ids => ids.includes(summary.team.id) ? ids.filter(id => id !== summary.team.id) : [...ids, summary.team.id])}
                    viewTeam={() => viewTeam(row, summary)}
                    {...(archiveChild === undefined ? {} : { archiveChild })}
                    openMain={() => { void navigateMain(row) }} openChild={childSessionId => {
                      void openChildWithFeedback(summary.controllerSessionId, childSessionId)
                    }} locale={locale} />)}
                  </div>
                  {visibleTeams.length < filteredTeams.length ? <button type="button" className="yuqi-secondary-action" onClick={() => setLimit(value => value + 20)}>{locale === 'en' ? 'Show 20 more' : '再显示 20 个'}</button> : null}
                  {teamFilter === 'active' && visibleTeams.length > 0 ? <p className="yuqi-center-running-note">{locale === 'en' ? 'Closing this window does not stop Teams.' : '关闭窗口不会停止团队。'}</p> : null}
                  </>}
                  </div>
                </div>
              </div>
              {tab === 'settings' ? null : <footer className="yuqi-settings-footer yuqi-center-footer">
                <span role="status">{!teamDataComplete ? (locale === 'en' ? 'Team data is unavailable, so counts are unknown.' : '团队数据暂不可用，当前数量未知。') : tab === 'attention' ? (locale === 'en' ? 'Read only dismisses a reminder; it does not resolve the request.' : '标记已读只关闭提醒，不代表已处理。') : selecting ? (locale === 'en' ? `${selectedTeams.length} selected · ${teamFilter === 'archived' ? 'Restoring brings records back.' : 'Archiving does not delete conversations or files.'}` : `已选择 ${selectedTeams.length} 项 · ${teamFilter === 'archived' ? '恢复后将重新显示在进行中或历史列表中。' : '归档不会删除对话或文件，可在“已归档”恢复。'}`) : (locale === 'en' ? `${filteredTeams.length} Teams · showing ${visibleTeams.length}` : `共 ${filteredTeams.length} 个团队 · 当前显示 ${visibleTeams.length} 个`)}</span>
                {tab === 'teams' && selecting ? <><button type="button" className="yuqi-secondary-action" onClick={() => { setSelecting(false); setSelectedIds([]) }}>{locale === 'en' ? 'Cancel selection' : '取消选择'}</button><button type="button" className="yuqi-primary-action" disabled={selectedTeams.length === 0} onClick={() => {
                  if (teamFilter === 'archived') {
                    if (!window.confirm(locale === 'en' ? `Restore ${selectedTeams.length} selected records?` : `恢复所选 ${selectedTeams.length} 项记录？`)) return
                    selectedTeams.forEach(({ summary }) => setTeamArchived(summary.team.id, false)); setSelectedIds([]); setSelecting(false)
                  } else {
                    const archivableTeams = selectedTeams.filter(({ summary }) => {
                      return summary.team.status === 'paused' || summary.team.status === 'completed'
                        || summary.team.status === 'failed' || summary.team.status === 'cancelled'
                    })
                    if (archivableTeams.length === 0) {
                      window.alert(locale === 'en' ? 'Selected Teams are still running tasks and cannot be archived.' : '所选团队仍在执行任务中，暂不能归档。请先暂停或取消团队。')
                      return
                    }
                    const confirmMsg = archivableTeams.length < selectedTeams.length
                      ? (locale === 'en'
                          ? `${selectedTeams.length - archivableTeams.length} running Team(s) cannot be archived. Archive remaining ${archivableTeams.length} record(s)?`
                          : `所选中有 ${selectedTeams.length - archivableTeams.length} 个团队仍在运行中无法归档。确认归档其余 ${archivableTeams.length} 项记录？`)
                      : (locale === 'en'
                          ? `Archive ${selectedTeams.length} selected records? No conversations or files will be deleted.`
                          : `归档所选 ${selectedTeams.length} 项记录？不会删除对话或文件，可在“已归档”恢复。`)
                    if (!window.confirm(confirmMsg)) return
                    archivableTeams.forEach(({ summary }) => setTeamArchived(summary.team.id, true)); setSelectedIds([]); setSelecting(false)
                  }
                }}>{teamFilter === 'archived' ? (locale === 'en' ? 'Restore selected records' : '恢复所选记录') : (locale === 'en' ? 'Archive selected records' : '归档所选记录')}</button></> : <button type="button" className="yuqi-secondary-action" onClick={requestClose}>{copy.close}</button>}
              </footer>}
            </div>
          </section>
        </div>, document.body) : null}
    </>
  )
}

function TeamDataAvailability({ locale, state, refresh }: { readonly locale: YuqiLocale; readonly state: TeamDataSnapshot; readonly refresh?: () => Promise<void> }) {
  const en = locale === 'en'
  const partial = state.status === 'ready'
  const loading = state.status === 'loading'
  const title = loading ? (en ? 'Loading Team data' : '正在读取团队数据')
    : partial ? (en ? 'Some Team data is unavailable' : '部分团队数据不可用')
      : state.status === 'cancelled' ? (en ? 'Team loading was cancelled' : '团队数据读取已取消')
        : (en ? 'Team data could not be loaded' : '无法读取团队数据')
  const message = loading ? (en ? 'Counts and history will appear when the current request finishes.' : '请求完成后才会显示数量和历史记录。')
    : partial ? (en ? `${state.unavailable?.size ?? 0} conversation record(s) could not be read. Counts and lists may be incomplete.` : `${state.unavailable?.size ?? 0} 个会话记录无法读取，数量和列表可能不完整。`)
      : (en ? 'The Team history and pending items cannot be confirmed yet. Retry after the local Host is available.' : '当前无法确认团队历史和待处理事项；请在本地 Host 可用后重试。')
  return <section className={`yuqi-settings-state yuqi-team-data-state ${loading ? 'yuqi-settings-state-loading' : 'yuqi-settings-state-error'}`}
    role={loading ? 'status' : 'alert'} aria-live="polite">
    <span className="yuqi-settings-state-icon" aria-hidden="true">{loading ? <span className="yuqi-settings-spinner" /> : '!'}</span>
    <div><h3>{title}</h3><p>{message}</p>
      {state.error ? <details><summary>{en ? 'Technical reason' : '查看原因'}</summary><pre>{state.error}</pre></details> : null}
      {!loading && refresh ? <button type="button" className="yuqi-secondary-action" onClick={() => { void refresh() }}>{en ? 'Retry loading' : '重新读取'}</button> : null}
    </div>
  </section>
}

function isTerminalTeam(summary: TeamConsoleSummary): boolean {
  return summary.team.status === 'completed' || summary.team.status === 'failed' || summary.team.status === 'cancelled'
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return !!left && !!right && left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function isHiddenController(row: SessionRow, summary: TeamConsoleSummary): boolean {
  return (summary.controllerSessionId !== undefined && String(row.id) === summary.controllerSessionId) || String(row.id).startsWith('yuqi-team-')
}

function SettingsNavIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
}

function TasksNavIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
}

function AttentionNavIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </svg>
}

/** Lucide UsersRound (ISC), kept inline so the plugin adds no icon dependency. */
function TeamIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 21a8 8 0 0 0-16 0" />
    <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    <circle cx="10" cy="8" r="5" />
  </svg>
}

function TeamCenterItem({ row, summary, openMain, openChild, archiveChild, locale, compact, selecting, selected, toggleSelected, viewTeam }: {
  readonly row: SessionRow
  readonly summary: TeamConsoleSummary
  readonly openMain: () => void
  readonly openChild: (childSessionId: string) => void
  readonly archiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
  readonly locale: YuqiLocale
  readonly compact: boolean
  readonly selecting: boolean
  readonly selected: boolean
  readonly toggleSelected: () => void
  readonly viewTeam: () => void
}) {
  void row
  const copy = CENTER_COPY[locale]
  const preference = useTeamUiPreference(summary.team.id)
  const [archiveError, setArchiveError] = useState(false)
  const [archiving, setArchiving] = useState<string>()
  const [childrenOpen, setChildrenOpen] = useState(false)
  const childIds = summary.tasks.flatMap(task => task.childSessionId === undefined ? [] : [task.childSessionId])
  const archivedCount = childIds.filter(id => preference.archivedChildIds.includes(id)).length
  const archivable = summary.team.status === 'paused' || summary.team.status === 'completed'
    || summary.team.status === 'failed' || summary.team.status === 'cancelled'
  const displayStatus = teamDisplayStatus(summary.team, locale)
  const decisionCount = userDecisionCount(summary)
  const allChildrenFinished = summary.tasks.length > 0 && (
    summary.tasks.every(t => ['completed', 'failed', 'cancelled'].includes(t.status))
    || (childIds.length > 0 && archivedCount === childIds.length)
  )
  const shouldHighlightArchive = archivable && !preference.teamArchived && (summary.team.runningTaskCount === 0 && summary.team.waitingTaskCount === 0 || allChildrenFinished)
  return (
    <article className={`yuqi-team-card${compact ? ' yuqi-team-card-compact' : ''}`}>
      <header>
        <div className="yuqi-card-title-group">
          {selecting ? <input className="yuqi-history-checkbox" type="checkbox" checked={selected} onChange={toggleSelected} aria-label={locale === 'en' ? `Select ${summary.team.title}` : `选择 ${summary.team.title}`} /> : null}
          <strong title={summary.team.title}>{summary.team.title}</strong>
        </div>
        <span className="yuqi-card-status-group">
          <span className={`yuqi-card-status yuqi-status-${displayStatus.tone}`}>{displayStatus.label}</span>
          <small>{locale === 'en' ? 'Completed' : '已完成'} {summary.team.completedTaskCount}/{summary.tasks.length}{decisionCount > 0 ? ` · ${copy.pendingDecisions(decisionCount)}` : ''}{archivedCount > 0 ? ` · ${copy.archivedCount(archivedCount)}` : ''}</small>
        </span>
      </header>
      {!compact && summary.tasks.length > 0 ? <progress className="yuqi-team-card-progress" max={summary.tasks.length}
        value={Math.max(0, Math.min(summary.team.completedTaskCount, summary.tasks.length))}
        aria-label={locale === 'en' ? 'Completed tasks' : '已完成任务'} /> : null}
      {!compact ? <><p className="yuqi-card-current">{locale === 'en' ? `${summary.team.runningTaskCount} running · ${summary.team.waitingTaskCount} waiting` : `当前：${summary.team.runningTaskCount} 个执行中 · ${summary.team.waitingTaskCount} 个等待`}</p><ul className="yuqi-card-task-preview">{summary.tasks.slice(0, 3).map(task => <li key={task.taskId} title={task.goal}><span title={task.goal}>{task.goal}</span><small className={`yuqi-status-${taskStatusMeta(task, locale, summary.team.status).tone}`}>{taskStatusMeta(task, locale, summary.team.status).label}</small></li>)}</ul></> : null}
      <div className="yuqi-task-command">
        <button type="button" className="yuqi-secondary-action yuqi-card-view" onClick={viewTeam}>{compact ? (locale === 'en' ? 'View record' : '查看记录') : (locale === 'en' ? 'View tasks' : '查看任务')}</button>
        {!compact ? <button type="button" className="yuqi-secondary-action" onClick={openMain}>{locale === 'en' ? 'Open controller' : '打开主控'}</button> : null}
        <div className="yuqi-card-direct-actions">
        {compact ? <button type="button" className="yuqi-child-link" onClick={openMain}>{copy.openController}</button> : null}
        <button type="button" className={`yuqi-child-link${shouldHighlightArchive ? ' yuqi-archive-highlight' : ''}`} disabled={!preference.teamArchived && !archivable}
          title={!preference.teamArchived && !archivable ? copy.cannotArchiveTeam : undefined}
          onClick={() => setTeamArchived(summary.team.id, !preference.teamArchived)}>
          {preference.teamArchived ? copy.restoreTeam : copy.archiveTeam}
        </button>
        {preference.dockDismissed || preference.dockHidden || (childIds.length > 0 && archivedCount === childIds.length && !preference.dockRestored)
          ? <button type="button" className="yuqi-child-link" onClick={() => restoreTeamDock(summary.team.id)}>{copy.restoreCard}</button> : null}
        </div>
      </div>
      {!preference.teamArchived && !archivable ? <p className="yuqi-card-action-hint">{summary.team.cancellationRequested ? (locale === 'en' ? 'Cancellation is saved; stopping is not yet confirmed, so archiving is unavailable.' : '取消请求已保存，尚未确认全部停止，暂不能归档。') : copy.cannotArchiveTeam} {locale === 'en' ? 'Open tasks to inspect recovery or cancellation controls.' : '请打开任务查看核对或取消操作及原因。'}</p> : null}
      {!preference.teamArchived && archivable && shouldHighlightArchive ? <p className="yuqi-card-action-hint yuqi-card-action-ready">{locale === 'en' ? 'All child tasks are finished or archived. You can archive this Team.' : '全部子任务已处理或归档，可归档此团队。'}</p> : null}
      {archiveError ? <p role="alert" className="yuqi-inline-error">{locale === 'en' ? 'The child conversation could not be archived. Try again.' : '子代理对话归档未成功，请重试。'}</p> : null}
      <details className="yuqi-card-children" open={childrenOpen} onToggle={event => setChildrenOpen(event.currentTarget.open)}><summary>{locale === 'en' ? `Child tasks (${summary.tasks.length})` : `子代理任务（${summary.tasks.length}）`}</summary>
      {childrenOpen ? <ol>{summary.tasks.map(task => {
        const childId = task.childSessionId
        const archived = childId !== undefined && preference.archivedChildIds.includes(childId)
        const terminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
        const taskStatus = taskStatusMeta(task, locale, summary.team.status)
        return <li key={task.taskId}>
          <span className="yuqi-team-center-task-copy"><strong title={task.goal}>{task.goal}</strong><small>{taskStatus.label} · {task.model}{archived ? ` · ${copy.archived}` : ''}</small></span>
          {childId === undefined ? <em className="yuqi-team-center-task-state">{copy.noChildSession}</em> : <span className="yuqi-task-command yuqi-team-center-task-actions">
            {task.status === 'cancelled' ? <span>{locale === 'en' ? 'Cancelled · view Team record' : '已取消 · 请查看团队记录'}</span> : <button type="button" onClick={() => openChild(childId)}>{copy.openChild}</button>}
            <button type="button" disabled={archived || !terminal || archiveChild === undefined || archiving !== undefined}
              title={!archived && !terminal ? copy.cannotArchiveChild : undefined}
              onClick={() => {
                if (!archiveChild || archiving !== undefined) return
                setArchiving(childId); setArchiveError(false)
                void archiveChild(summary.team.id, childId).then(ok => setArchiveError(!ok), () => setArchiveError(true)).finally(() => setArchiving(undefined))
              }}>{archiving === childId ? (locale === 'en' ? 'Archiving…' : '正在归档…') : archived ? copy.archived : copy.archive}</button>
          </span>}
        </li>
      })}</ol> : null}
      </details>
    </article>
  )
}

function userDecisionCount(summary: TeamConsoleSummary): number {
  return summary.attention.filter(item => item.owner === 'user').length + (summary.team.planConfirmationPending ? 1 : 0)
}

function userDecisions(summary: TeamConsoleSummary, locale: YuqiLocale): readonly {
  readonly key: string
  readonly taskId?: string
  readonly label: string
  readonly message: string
}[] {
  const copy = CENTER_COPY[locale]
  const decisions: { key: string; taskId?: string; label: string; message: string }[] = summary.attention.filter(item => item.owner === 'user').map(item => {
    // The shared identity includes the attempt and original question text.
    return ({
    key: attentionDecisionKey(summary, item),
    taskId: item.taskId,
    label: item.code === 'verification-inconclusive' ? copy.confirmVerification : copy.decisionNeeded,
    message: formatAttentionMessage(item, locale),
    })
  })
  if (summary.team.planConfirmationPending) decisions.unshift({
    key: 'plan-confirmation',
    label: copy.confirmPlan,
    message: copy.confirmPlanMessage,
  })
  return decisions
}

const CENTER_COPY = {
  zh: {
    openMainFailed: '无法打开该团队会话：Host 未保留可用地址或导航失败。请刷新会话目录后重试；当前记录已保留。',
    trigger: '团队设置', open: '打开 Team 管理中心', openWithAttention: (count: number) => `打开 Team 管理中心，${count} 项需要你决定`,
    attentionCount: (count: number) => `${count} 项需要你决定`, closeCenter: '关闭 Team 管理中心', title: 'Team 管理中心',
    description: '统一管理全局设置、主控任务与子代理会话；这里不会替换官方项目树。', close: '关闭',
    globalSettings: '全局设置', globalSettingsHelp: '界面语言立即作用于 UI；Team 默认设置只影响新建 Team。', language: '界面语言（立即生效）', teamDefaults: '团队默认设置',
    decisionsRegion: '需要你决定的事项', decisionsTitle: (count: number) => `需要你决定 ${count} 项`, decisionsHelp: '所有决定都在主控对话处理，不需要进入子代理。',
    handleInController: '进入主控处理', noDecisions: '当前没有需要你确认的事项。运行异常、重试和依赖调度由主控自动处理。',
    noActiveWithArchive: '暂无活动 Team；可从下方恢复已归档 Team。', noTeams: '暂无 Team。创建团队后，主控、任务和子代理会显示在这里。',
    archivedTeams: (count: number) => `已归档 Team ${count}`, pendingDecisions: (count: number) => `${count} 项待你决定`, archivedCount: (count: number) => `已归档 ${count}`,
    openController: '打开主控对话', cannotArchiveTeam: '运行中的 Team 不能归档；请先暂停或取消', restoreTeam: '恢复 Team', archiveTeam: '归档 Team 与主控入口',
    restoreCard: '恢复 Team 卡片', restoreAllChildren: '恢复全部子代理', archived: '已归档', noChildSession: '尚未创建会话', openChild: '打开子代理',
    cannotArchiveChild: '运行中的子代理不能归档', restore: '恢复', archive: '归档', confirmVerification: '需要确认验收结果', decisionNeeded: '需要你的决定',
    confirmPlan: '需要确认任务计划', confirmPlanMessage: 'Team 尚未开始执行。请在主控对话检查任务、模型与权限，然后确认继续或提出调整。',
    markAsRead: '标为已读', markAsUnread: '重新标为待处理', readDecisions: (count: number) => `已标为已读的决定（${count}）`,
    settingsUnavailable: '团队设置暂时无法打开：当前页面没有可用的全局设置宿主，请切换到主对话后重试。', openChildRejected: '子代理会话未能打开，请刷新会话列表后重试。', openChildFailed: '打开子代理会话失败，请检查连接后重试。',
  },
  en: {
    openMainFailed: 'Could not open this Team conversation: the Host has no retained address or navigation failed. Refresh the session catalog and retry; this record remains available.',
    trigger: 'Team settings', open: 'Open Team management', openWithAttention: (count: number) => `Open Team management, ${count} decision${count === 1 ? '' : 's'} needed`,
    attentionCount: (count: number) => `${count} decision${count === 1 ? '' : 's'} needed`, closeCenter: 'Close Team management', title: 'Team Management Center',
    description: 'Manage global defaults, controller tasks, and child Agent conversations without replacing the native project tree.', close: 'Close',
    globalSettings: 'Global settings', globalSettingsHelp: 'Interface language updates the UI immediately; Team defaults affect only newly created Teams.', language: 'Interface language (immediate)', teamDefaults: 'Team defaults',
    decisionsRegion: 'Decisions needed', decisionsTitle: (count: number) => `${count} decision${count === 1 ? '' : 's'} needed`, decisionsHelp: 'Handle every decision in the controller conversation; you do not need to open a child Agent.',
    handleInController: 'Handle in controller', noDecisions: 'No decisions need your attention. The controller handles runtime recovery, retries, and dependency scheduling.',
    noActiveWithArchive: 'No active Teams. Archived Teams can be restored below.', noTeams: 'No Teams yet. Controllers, tasks, and child Agents will appear here after you create one.',
    archivedTeams: (count: number) => `Archived Teams ${count}`, pendingDecisions: (count: number) => `${count} decision${count === 1 ? '' : 's'} pending`, archivedCount: (count: number) => `${count} archived`,
    openController: 'Open controller', cannotArchiveTeam: 'A running Team cannot be archived. Pause or cancel it first.', restoreTeam: 'Restore Team', archiveTeam: 'Archive Team and controller entry',
    restoreCard: 'Restore Team card', restoreAllChildren: 'Restore all child Agents', archived: 'Archived', noChildSession: 'Conversation not created', openChild: 'Open child Agent',
    cannotArchiveChild: 'A running child Agent cannot be archived', restore: 'Restore', archive: 'Archive', confirmVerification: 'Confirm verification result', decisionNeeded: 'Decision needed',
    confirmPlan: 'Confirm task graph', confirmPlanMessage: 'The Team has not started. Review tasks, models, and permissions in the controller conversation, then continue or request changes.',
    markAsRead: 'Mark as read', markAsUnread: 'Mark as pending', readDecisions: (count: number) => `Read decisions (${count})`,
    settingsUnavailable: 'Team settings could not open because no global settings host is available on this page. Switch to a main conversation and retry.', openChildRejected: 'The child Agent conversation could not be opened. Refresh the session list and retry.', openChildFailed: 'Opening the child Agent conversation failed. Check the connection and retry.',
  },
} as const
