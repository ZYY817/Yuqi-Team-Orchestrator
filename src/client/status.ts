import type { TeamConsoleSummary, TeamConsoleTask } from '../domain/team-console-contract.ts'
import { formatTaskStatus, formatTeamStatus, type YuqiLocale } from './i18n.ts'

export type StatusTone = 'neutral' | 'active' | 'warning' | 'danger' | 'success' | 'unknown'

export interface StatusMeta {
  readonly label: string
  readonly glyph: string
  readonly tone: StatusTone
}

export function teamStatusMeta(status: TeamConsoleSummary['team']['status'], locale: YuqiLocale = 'zh'): StatusMeta {
  const en = locale === 'en'
  if (status === 'running') return { label: en ? 'Running' : '运行中', glyph: '●', tone: 'active' }
  if (status === 'pausing') return { label: en ? 'Pausing' : '暂停中', glyph: '⏸', tone: 'warning' }
  if (status === 'paused') return { label: en ? 'Paused' : '已暂停', glyph: '⏸', tone: 'warning' }
  if (status === 'cancelling') return { label: en ? 'Cancelling' : '取消中', glyph: '⊘', tone: 'warning' }
  if (status === 'cancelled') return { label: en ? 'Cancelled' : '已取消', glyph: '⊘', tone: 'neutral' }
  if (status === 'completed') return { label: en ? 'Completed' : '已完成', glyph: '✓', tone: 'success' }
  if (status === 'failed') return { label: en ? 'Failed' : '失败', glyph: '!', tone: 'danger' }
  if (status === 'needs_reconciliation') return { label: en ? 'Safety check needed' : '待安全核对', glyph: '!', tone: 'danger' }
  return { label: formatTeamStatus(status, locale), glyph: '○', tone: status === 'draft' ? 'neutral' : 'unknown' }
}

export function teamDisplayStatus(team: TeamConsoleSummary['team'], locale: YuqiLocale = 'zh'): StatusMeta {
  if (team.planConfirmationPending) return { label: locale === 'en' ? 'Task graph confirmation' : '待确认任务图', glyph: '?', tone: 'warning' }
  return teamStatusMeta(team.status, locale)
}

export function taskStatusMeta(task: TeamConsoleTask, locale: YuqiLocale = 'zh', teamStatus?: TeamConsoleSummary['team']['status'] | string): StatusMeta {
  const en = locale === 'en'
  if (task.attemptStatus === 'unknown') return { label: en ? 'Result unverified' : '结果待核验', glyph: '?', tone: 'unknown' }
  if (task.status === 'running' || task.status === 'verifying') {
    return { label: task.status === 'verifying' ? (en ? 'Verifying' : '验证中') : (en ? 'Running' : '运行中'), glyph: '●', tone: 'active' }
  }
  if (task.status === 'completed') return { label: en ? 'Completed' : '已完成', glyph: '✓', tone: 'success' }
  if (task.status === 'failed') return { label: en ? 'Failed' : '失败', glyph: '!', tone: 'danger' }
  if (task.status === 'blocked') {
    // durablyBlocked (failed/cancelled dependency) and worker-reported blocks
    // stay honest as Blocked; only pause-interrupted work shows as Paused.
    const isPaused = (teamStatus === 'paused' || teamStatus === 'pausing')
      && task.durablyBlocked !== true
      && (task.taskOutcome === undefined || task.taskOutcome.status === 'missing')
    if (isPaused) {
      return { label: en ? 'Paused' : '已暂停', glyph: '⏸', tone: 'warning' }
    }
    return { label: en ? 'Blocked' : '阻塞', glyph: '!', tone: 'danger' }
  }
  if (task.status === 'cancelled') return { label: en ? 'Cancelled' : '已取消', glyph: '⊘', tone: 'neutral' }
  return { label: formatTaskStatus(task.status, locale), glyph: '○', tone: task.status === 'ready' || task.status === 'pending' ? 'neutral' : 'unknown' }
}

export function taskNeedsAttention(task: TeamConsoleTask, teamStatus?: TeamConsoleSummary['team']['status'] | string): boolean {
  // Mirrors attentionForTask: while the Team is paused only pause interruptions
  // (missing/absent outcome, auto-retried on Continue) leave attention;
  // 'reported' and 'invalid' outcomes stay blocked after resume.
  if (task.status === 'blocked' && (teamStatus === 'paused' || teamStatus === 'pausing')
    && (task.taskOutcome === undefined || task.taskOutcome.status === 'missing')) return false
  return task.status === 'failed' || task.status === 'blocked' || task.attemptStatus === 'unknown'
}
