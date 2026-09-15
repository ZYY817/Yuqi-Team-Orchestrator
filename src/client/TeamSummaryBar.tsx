import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { teamDisplayStatus } from './status.ts'
import { presentDuration, presentTeamUsage } from './usage-presentation.ts'
import { useYuqiLocale } from './client-locale.ts'
import { labelValue, localeLanguageTag } from './i18n.ts'

export interface TeamSummaryBarProps {
  readonly summary: TeamConsoleSummary
  readonly expanded: boolean
  readonly onOpen: () => void
  readonly onHide: () => void
  readonly hideLabel: string
  readonly hideTitle: string
  readonly hideText: string
  readonly toggleText: string
  readonly nowMs: number
}

export function TeamSummaryBar({ summary, expanded, onOpen, onHide, hideLabel, hideTitle, hideText, toggleText, nowMs }: TeamSummaryBarProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const status = teamDisplayStatus(summary.team, locale)
  const total = summary.tasks.length
  const usage = presentTeamUsage(summary.usage, locale)
  const duration = presentDuration(summary.team.duration, nowMs, locale)
  const hasStarted = summary.team.status !== 'draft' && !summary.team.planConfirmationPending
  const hasUsage = summary.usage.state === 'partial' || summary.usage.state === 'known'
  const hasDuration = duration.stateLabel !== (en ? 'Unavailable' : '不可用')
  return (
    <section className="yuqi-team-summary" lang={localeLanguageTag(locale)}>
      <button
        type="button"
        className="yuqi-team-summary-button"
        aria-expanded={expanded}
        aria-controls="yuqi-team-panel"
        aria-label={en ? `${expanded ? 'Close' : 'Open'} Yuqi Team task panel` : `${expanded ? '关闭' : '打开'} Yuqi Team 任务面板`}
        aria-live="polite"
        onClick={onOpen}
      >
        <span className="yuqi-team-summary-content">
          <span className="yuqi-team-summary-heading">
            <strong>{en ? 'Team execution' : '团队执行'}</strong>
            <span className={`yuqi-status yuqi-status-${status.tone}`}>
              {status.label}
            </span>
          </span>
          <span className="yuqi-team-summary-metrics">
            {hasStarted ? <span className="yuqi-team-metric yuqi-team-metric-completed">{summary.team.completedTaskCount}/{total} {en ? 'completed' : '已完成'}</span> : <span className="yuqi-team-metric">{total} {en ? 'tasks' : '项任务'}</span>}
            {hasStarted && summary.team.runningTaskCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-running">{summary.team.runningTaskCount} {en ? 'running' : '执行中'}</span> : null}
            {hasStarted && summary.team.waitingTaskCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-waiting">{summary.team.waitingTaskCount} {en ? 'waiting' : '等待'}</span> : null}
            {summary.team.userDecisionCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-attention">{summary.team.userDecisionCount} {en ? 'need confirmation' : '需要用户确认'}</span> : null}
            {summary.team.controllerActionCount > 0 ? <span className="yuqi-team-metric yuqi-team-metric-controller">{summary.team.controllerActionCount} {en ? 'awaiting controller' : '待主控处理'}</span> : null}
            {hasStarted && hasUsage ? <span className="yuqi-team-usage" aria-label={labelValue(en ? 'Team tokens' : '团队 Token', usage.totalLabel, locale)}>{usage.compactLabel}</span> : null}
            {hasStarted && hasDuration ? <span className="yuqi-team-duration">{labelValue(en ? 'Duration' : '耗时', duration.label, locale)}</span> : null}
          </span>
        </span>
        <span className="yuqi-team-summary-action" aria-hidden="true">{toggleText}</span>
      </button>
      <button type="button" className="yuqi-team-hide" aria-label={hideLabel} title={hideTitle} onClick={onHide}>{hideText}</button>
    </section>
  )
}
