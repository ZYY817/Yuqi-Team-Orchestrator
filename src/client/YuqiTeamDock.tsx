import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './projection-types.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TeamPanel } from './TeamPanel.tsx'
import { TeamDockBar } from './TeamDockBar.tsx'
import type { YuqiCommand } from './command-actions.ts'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { restoreTeamDock, setTeamDockDismissed, setTeamDockHidden, useTeamUiPreference } from './team-ui-preferences.ts'
import { useYuqiLocale } from './client-locale.ts'
import { consumeTeamPanelOpen, isTeamPanelOpenRequest, OPEN_TEAM_PANEL_EVENT, requestTeamAttentionOpen } from './team-panel-events.ts'
import { localeLanguageTag } from './i18n.ts'
import { teamStatusMeta } from './status.ts'

export interface YuqiTeamActions {
  readonly recoverTarget?: (teamId: string, controllerSessionId: string) => Promise<void>
  readonly nativeAttention?: { getSnapshot(): number; subscribe(listener: () => void): () => void }
  /** Direct Session projection face used when a late-loaded custom key was not present in the slot baseline. */
  readonly teamProjection?: TeamProjectionFace
  readonly onOpenChild: (controllerSessionId: string | undefined, childSessionId: string) => Promise<boolean>
  /** Archive a terminal child through the native workspace registry. */
  readonly onArchiveChild?: (teamId: string, childSessionId: string) => Promise<boolean>
  /** Best-effort native archive after a projection-proven terminal Team. */
  readonly onArchiveController?: (controllerSessionId: string) => Promise<boolean>
  /** Host command bridge; absent means this surface is read-only. */
  readonly command?: YuqiCommand
  readonly loadModels?: () => Promise<readonly { readonly id: string; readonly name: string }[]>
  /** Persist the user's choice to skip plan review for future Teams. */
  readonly disablePlanConfirmation?: () => Promise<boolean>
}

export type YuqiTeamDockProps = PropsRuntime<'conversation.input.dock'> & YuqiTeamActions

interface TeamProjectionFace {
  readonly getSnapshot: () => TeamConsoleSummary | null | undefined
  readonly subscribe: (listener: () => void) => () => void
}

const subscribeAbsent = () => () => undefined
const snapshotAbsent = () => undefined

export function YuqiTeamDock(props: YuqiTeamDockProps) {
  return props.teamProjection === undefined ? <LegacyTeamDock {...props} /> : <TeamDockView {...props} />
}

function LegacyTeamDock(props: YuqiTeamDockProps) {
  const legacySummary = props.useProjection('yuqiTeam')
  return <TeamDockView {...props} legacySummary={legacySummary} />
}

function TeamDockView({ teamProjection, nativeAttention, legacySummary, onOpenChild, onArchiveChild, onArchiveController, command, loadModels, disablePlanConfirmation, recoverTarget }: YuqiTeamDockProps & { readonly legacySummary?: TeamConsoleSummary | null | undefined }) {
  const directSummary = useSyncExternalStore(
    teamProjection === undefined ? subscribeAbsent : listener => teamProjection.subscribe(listener),
    teamProjection === undefined ? snapshotAbsent : () => teamProjection.getSnapshot(),
    snapshotAbsent,
  )
  // The injected direct face is bound to this exact Session. A slot baseline
  // may briefly retain the previous Session's custom projection while the
  // native conversation surface switches, so never use it as a fallback when
  // the exact bound face is available (including its intentional undefined).
  const summary = teamProjection === undefined ? legacySummary : directSummary
  const nativeAttentionCount = useSyncExternalStore(nativeAttention?.subscribe ?? subscribeAbsent, nativeAttention?.getSnapshot ?? snapshotAbsent, snapshotAbsent) ?? 0
  const hasLiveDuration = summary !== undefined && summary !== null && (
    summary.team.duration.state === 'running' || summary.tasks.some(task => task.duration.state === 'running')
  )
  const nowMs = useLiveDurationNow(hasLiveDuration)
  const [open, setOpen] = useState(false)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const archivedControllers = useRef(new Set<string>())
  const [archiveFailed, setArchiveFailed] = useState(false)
  const [models, setModels] = useState<readonly { readonly id: string; readonly name: string }[]>()
  const teamId = summary?.team.id
  const preference = useTeamUiPreference(teamId)
  const childSessionIds = summary?.tasks.flatMap(task => task.childSessionId === undefined ? [] : [task.childSessionId]) ?? []
  const allChildrenArchived = childSessionIds.length > 0
    && childSessionIds.every(childSessionId => preference.archivedChildIds.includes(childSessionId))
  const hiddenByArchivedChildren = allChildrenArchived && preference.dockRestored !== true
  const locale = useYuqiLocale()
  const languageTag = localeLanguageTag(locale)
  const controllerSessionId = summary?.controllerSessionId
  useEffect(() => {
    if (!open || teamId === undefined || controllerSessionId === undefined) return
    let disposed = false
    setRecoveryFailed(false)
    void recoverTarget?.(teamId, controllerSessionId).catch(() => { if (!disposed) setRecoveryFailed(true) })
    return () => { disposed = true }
  }, [open, teamId, controllerSessionId, recoverTarget])
  useEffect(() => {
    if (teamId === undefined) return undefined
    const openRequestedTeam = (event: Event) => {
      if (!isTeamPanelOpenRequest(event, teamId)) return
      consumeTeamPanelOpen(teamId)
      restoreTeamDock(teamId)
      setOpen(true)
    }
    window.addEventListener(OPEN_TEAM_PANEL_EVENT, openRequestedTeam)
    if (consumeTeamPanelOpen(teamId)) { restoreTeamDock(teamId); setOpen(true) }
    return () => window.removeEventListener(OPEN_TEAM_PANEL_EVENT, openRequestedTeam)
  }, [teamId])
  const terminal = summary !== undefined && summary !== null && (
    summary.team.status === 'completed' || summary.team.status === 'failed' || summary.team.status === 'cancelled'
  )
  useEffect(() => {
    setArchiveFailed(false)
    if (!terminal || controllerSessionId === undefined || onArchiveController === undefined
      || archivedControllers.current.has(controllerSessionId)) return
    let cancelled = false
    let timer: number | undefined
    const archive = async () => {
      for (let attempt = 0; attempt < 3 && !cancelled; attempt += 1) {
        if (await onArchiveController(controllerSessionId)) {
          if (!cancelled) archivedControllers.current.add(controllerSessionId)
          return
        }
        if (attempt < 2) await new Promise<void>(resolve => {
          timer = window.setTimeout(resolve, 500 * (attempt + 1))
        })
      }
      if (!cancelled) setArchiveFailed(true)
    }
    void archive()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [teamId, controllerSessionId, onArchiveController, terminal])
  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])
  useEffect(() => {
    if (!open || loadModels === undefined || models !== undefined) return
    void loadModels().then(setModels, () => setModels([]))
  }, [loadModels, models, open])
  useEffect(() => {
    if (preference.teamArchived || preference.dockDismissed || hiddenByArchivedChildren) setOpen(false)
  }, [hiddenByArchivedChildren, preference.dockDismissed, preference.teamArchived])
  if (summary === undefined || summary === null) return null
  if (preference.teamArchived || preference.dockDismissed || hiddenByArchivedChildren) return null
  if (preference.dockHidden) {
    return (
      <div className="yuqi-team-dock yuqi-team-dock-hidden" lang={languageTag}>
        <button type="button" className="yuqi-team-restore" onClick={() => setTeamDockHidden(summary.team.id, false)}>
          <span>{locale === 'en' ? 'Show Team' : '显示 Team'}</span>
          <small>{teamStatusMeta(summary.team.status, locale).label} · {summary.team.completedTaskCount}/{summary.tasks.length}</small>
        </button>
        <button type="button" className="yuqi-team-dismiss-hidden"
          title={locale === 'en' ? 'Remove this card; restore it later from Team management' : '移除这个卡片；之后可从团队管理恢复'}
          onClick={() => {
            setTeamDockHidden(summary.team.id, false)
            setTeamDockDismissed(summary.team.id, true)
          }}>
          {locale === 'en' ? 'Remove' : '移除'}
        </button>
      </div>
    )
  }
  return (
    <>
      <div className="yuqi-team-dock" lang={languageTag} style={open ? { display: 'none' } : undefined}>
        <TeamDockBar summary={summary} nativeAttentionCount={nativeAttentionCount} nowMs={nowMs} expanded={open} command={command} onOpen={() => {
          if (nativeAttentionCount > 0 || summary.team.userDecisionCount > 0) requestTeamAttentionOpen(summary.team.id)
          else setOpen(true)
        }}
          hideLabel={terminal ? (locale === 'en' ? 'Close Team card' : '关闭 Team 卡片') : (locale === 'en' ? 'Minimize Team card' : '最小化 Team 卡片')}
          hideTitle={terminal ? (locale === 'en' ? 'Close this finished Team card' : '关闭这个已结束的 Team 卡片') : (locale === 'en' ? 'Minimize the running Team' : '最小化运行中的 Team')}
          hideText={terminal ? (locale === 'en' ? 'Close' : '关闭') : (locale === 'en' ? 'Hide' : '隐藏')} onHide={() => {
            setOpen(false)
            if (terminal) setTeamDockDismissed(summary.team.id, true)
            else setTeamDockHidden(summary.team.id, true)
          }} />
        {archiveFailed ? <span className="yuqi-command-error" role="alert">{locale === 'en' ? 'The Team ended, but archiving the controller conversation failed. It will retry after refresh.' : 'Team 已结束，但主控会话归档失败；刷新后将重试。'}</span> : null}
      </div>
      {open && typeof document !== 'undefined' ? createPortal(
        <div className="yuqi-settings-layer yuqi-management-layer" lang={languageTag}>
          <button type="button" className="yuqi-settings-backdrop" aria-label={locale === 'en' ? 'Close Team panel (click backdrop)' : '关闭团队面板（点击背景）'} onClick={() => setOpen(false)} />
          <TeamPanel summary={summary} onClose={() => setOpen(false)} onOpenChild={onOpenChild} nowMs={nowMs} recoveryFailed={recoveryFailed}
            {...(onArchiveChild === undefined ? {} : { onArchiveChild })}
            {...(command === undefined ? {} : { command })}
            {...(disablePlanConfirmation === undefined ? {} : { disablePlanConfirmation })}
            {...(models === undefined ? {} : { models })} />
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function useLiveDurationNow(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    if (!enabled) return undefined
    const update = () => setNowMs(Date.now())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return nowMs
}
