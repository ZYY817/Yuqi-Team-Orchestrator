import type { TeamConsoleDuration, TeamConsoleUsage } from '../domain/team-console-contract.ts'
import { formatCompactTokens, formatTokens, presentDuration, presentTeamUsage } from './usage-presentation.ts'
import { useYuqiLocale } from './client-locale.ts'

export interface TeamUsageSummaryProps {
  readonly usage: TeamConsoleUsage
  readonly duration: TeamConsoleDuration
  readonly nowMs: number
}

export function TeamUsageSummary({ usage, duration, nowMs }: TeamUsageSummaryProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const presentation = presentTeamUsage(usage, locale)
  const durationPresentation = presentDuration(duration, nowMs, locale)
  const known = 'totalTokens' in usage ? usage : undefined
  const inputLabel = known === undefined ? '—' : formatCompactTokens(known.uncachedInputTokens + known.cacheReadTokens + known.cacheWriteTokens, 'en')
  const outputLabel = known === undefined ? '—' : formatCompactTokens(known.outputTokens, 'en')
  return (
    <details className="yuqi-usage-disclosure" open>
      <summary>
        <span>{en ? 'Usage details' : '用量详情'}</span>
        <span>{presentation.totalLabel} · {durationPresentation.label}</span>
      </summary>
      <section className="yuqi-usage-summary" aria-label={en ? 'Team usage summary' : '团队用量摘要'}>
        <div className="yuqi-usage-stats-grid">
          <div className="yuqi-usage-stat-card">
            <span className="yuqi-usage-stat-label">{en ? 'Input' : '输入'}</span>
            <strong className="yuqi-usage-stat-value">{inputLabel}</strong>
            <small className="yuqi-usage-stat-desc">{en ? 'Includes recorded cache reads and writes' : '包含已记录的缓存读写'}</small>
          </div>
          <div className="yuqi-usage-stat-card">
            <span className="yuqi-usage-stat-label">{en ? 'Output' : '输出'}</span>
            <strong className="yuqi-usage-stat-value">{outputLabel}</strong>
            <small className="yuqi-usage-stat-desc">{en ? 'Provider-reported output tokens' : '提供方上报的输出 Token'}</small>
          </div>
          <div className="yuqi-usage-stat-card">
            <span className="yuqi-usage-stat-label">{en ? 'Total' : '总量'}</span>
            <strong className="yuqi-usage-stat-value" title={known === undefined ? undefined : formatTokens(known.totalTokens, locale)}>{known === undefined ? presentation.totalLabel : formatCompactTokens(known.totalTokens, 'en')}</strong>
            <small className="yuqi-usage-stat-desc">{presentation.stateLabel} · {presentation.detailLabel}</small>
          </div>
          <div className="yuqi-usage-stat-card">
            <span className="yuqi-usage-stat-label">{en ? 'Combined execution' : '累计执行'}</span>
            <strong className="yuqi-usage-stat-value">{durationPresentation.label}</strong>
            <small className="yuqi-usage-stat-desc">{en ? 'Execution duration, not user wait time' : '执行耗时，不等同用户等待时间'}</small>
          </div>
        </div>
      </section>
    </details>
  )
}
