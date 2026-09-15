import type { TeamConsoleDuration, TeamConsoleTaskUsage, TeamConsoleUsage } from '../domain/team-console-contract.ts'
import type { YuqiLocale } from './client-locale.ts'

export interface TeamUsagePresentation {
  readonly totalLabel: string
  readonly stateLabel: string
  readonly detailLabel: string
  readonly compactLabel: string
}

export interface TaskUsagePresentation {
  readonly tokenLabel: string
  readonly detailLabel: string
}

export interface DurationPresentation {
  readonly label: string
  readonly stateLabel: string
}

/**
 * Format numbers for the display only. The durable usage values remain in the
 * Host→Client summary and are never replaced with a client-side total.
 */
export function formatTokens(tokens: number, locale: YuqiLocale = 'zh'): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN').format(tokens)
}

/** Compact display only; exact totals remain available in the usage details. */
export function formatCompactTokens(tokens: number, locale: YuqiLocale = 'zh'): string {
  return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    notation: 'compact', maximumFractionDigits: 1,
  }).format(tokens)
}

export function presentTeamUsage(usage: TeamConsoleUsage, locale: YuqiLocale = 'zh'): TeamUsagePresentation {
  const en = locale === 'en'
  if (usage.state === 'pending') {
    return {
      totalLabel: en ? 'No data' : '暂无数据',
      stateLabel: en ? 'No data' : '暂无数据',
      detailLabel: en ? 'Child Agents have not produced usable token records' : '子代理尚未产生可用的 Token 记录',
      compactLabel: en ? 'Tokens: no data' : 'Token：暂无数据',
    }
  }
  if (usage.state === 'unavailable') {
    return {
      totalLabel: en ? 'Unavailable' : '不可用',
      stateLabel: en ? 'Unavailable' : '不可用',
      detailLabel: en ? 'The provider did not report usage' : '提供方未上报，暂不显示数值',
      compactLabel: en ? 'Tokens: not reported' : 'Token：提供方未上报',
    }
  }
  if (usage.state === 'partial') {
    const reasons: string[] = []
    if (usage.missingAttemptCount > 0) reasons.push(en ? `${usage.missingAttemptCount} attempt(s) not reported` : `${usage.missingAttemptCount} 个 attempt 未上报`)
    if (usage.activeAttemptCount > 0) reasons.push(en ? `${usage.activeAttemptCount} attempt(s) still running` : `${usage.activeAttemptCount} 个 attempt 仍在运行`)
    return {
      totalLabel: `${formatTokens(usage.totalTokens, locale)} Token`,
      stateLabel: en ? 'Partial' : '部分数据',
      detailLabel: reasons.length === 0 ? (en ? 'Team settlement is still in progress' : '团队仍在结算') : reasons.join(en ? '; ' : '；'),
      compactLabel: en ? `${formatCompactTokens(usage.totalTokens, locale)} tokens used (partial)` : `已用 ${formatCompactTokens(usage.totalTokens, locale)} Token（部分记录）`,
    }
  }
  return {
    totalLabel: `${formatTokens(usage.totalTokens, locale)} Token`,
    stateLabel: en ? 'Complete' : '完整',
    detailLabel: en ? 'Every settled attempt has a token record' : '已结算 attempt 均有 Token 记录',
    compactLabel: en ? `${formatCompactTokens(usage.totalTokens, locale)} tokens used` : `已用 ${formatCompactTokens(usage.totalTokens, locale)} Token`,
  }
}

export function presentTaskUsage(usage: TeamConsoleTaskUsage, locale: YuqiLocale = 'zh'): TaskUsagePresentation {
  const en = locale === 'en'
  if (usage.state === 'pending') {
    return { tokenLabel: en ? 'Tokens: no data' : 'Token：暂无数据', detailLabel: en ? 'No usable token data yet' : '尚未产生可用 Token 数据' }
  }
  if (usage.state === 'unavailable') {
    return { tokenLabel: en ? 'Tokens: unavailable' : 'Token：不可用', detailLabel: en ? 'The provider did not report tokens' : '提供方未上报 Token' }
  }
  return usage.state === 'live'
    ? { tokenLabel: en ? `Tokens: ${formatTokens(usage.totalTokens, locale)} (live)` : `Token：${formatTokens(usage.totalTokens, locale)}（运行中）`, detailLabel: en ? `${formatTokens(usage.totalTokens, locale)} tokens accumulated live` : `实时累计 ${formatTokens(usage.totalTokens, locale)} Token` }
    : { tokenLabel: en ? `Tokens: ${formatTokens(usage.totalTokens, locale)}` : `Token：${formatTokens(usage.totalTokens, locale)}`, detailLabel: en ? `${formatTokens(usage.totalTokens, locale)} tokens recorded` : `已记录 ${formatTokens(usage.totalTokens, locale)} Token` }
}

/** Explicit fallback used when durable start/end timestamps are not usable. */
export const unavailableDurationLabel = '暂无可靠数据'

export function presentDuration(duration: TeamConsoleDuration, nowMs: number, locale: YuqiLocale = 'zh'): DurationPresentation {
  const en = locale === 'en'
  if (duration.state === 'unavailable') {
    return { label: en ? 'No reliable data' : unavailableDurationLabel, stateLabel: en ? 'Unavailable' : '不可用' }
  }
  if (duration.state === 'known') {
    return { label: formatDuration(duration.elapsedMs, locale), stateLabel: en ? 'Finished' : '已结束' }
  }
  const activeStartedAts = duration.activeStartedAts ?? [duration.startedAt]
  const activeElapsedMs = activeStartedAts.reduce<number | undefined>((total, startedAt) => {
    if (total === undefined) return undefined
    const startedMs = Date.parse(startedAt)
    if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || nowMs < startedMs) return undefined
    return total + nowMs - startedMs
  }, 0)
  if (activeElapsedMs === undefined) {
    return { label: en ? 'No reliable data' : unavailableDurationLabel, stateLabel: en ? 'Unavailable' : '不可用' }
  }
  const prefix = duration.activeStartedAts === undefined ? (en ? 'Running' : '运行中') : (en ? 'Combined execution' : '累计执行')
  return { label: `${prefix} ${formatDuration((duration.elapsedMs ?? 0) + activeElapsedMs, locale)}`, stateLabel: en ? 'Running' : '运行中' }
}

function formatDuration(milliseconds: number, locale: YuqiLocale): string {
  const en = locale === 'en'
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return en ? 'No reliable data' : unavailableDurationLabel
  const totalSeconds = Math.floor(milliseconds / 1000)
  if (totalSeconds < 60) return en ? `${totalSeconds}s` : `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return en ? (seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`) : (seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`)
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return en ? (remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`) : (remainingMinutes === 0 ? `${hours} 小时` : `${hours} 小时 ${remainingMinutes} 分钟`)
}
