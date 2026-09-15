import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import type { YuqiCommand } from './command-actions.ts'
import { useYuqiLocale } from './client-locale.ts'
import { formatAttentionMessage } from './i18n.ts'

export interface TeamAttentionActionsProps {
  readonly summary: TeamConsoleSummary
  readonly command?: YuqiCommand
  /** The same team-level review decision is already actionable in the panel. */
  readonly reviewDecisionVisible?: boolean
}

/**
 * Show only genuinely user-owned decisions in the main-controller surface.
 * Runtime failures, interrupted attempts, retries, and dependency scheduling
 * belong to the controller recovery loop and must never ask the user to infer
 * an internal child-agent outcome.
 */
export function TeamAttentionActions({ summary, reviewDecisionVisible = false }: TeamAttentionActionsProps) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const decisions = summary.attention.filter(item => item.owner === 'user'
    && !(reviewDecisionVisible && item.taskId === summary.team.id && item.code === 'verification-inconclusive'))
  if (decisions.length === 0) return null

  return (
    <section className="yuqi-controller-decisions" aria-label={en ? 'Controller decisions' : '主控待处理事项'}>
      <header>
        <strong>{en ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'} needed` : `需要你决定 ${decisions.length} 项`}</strong>
        <span>{en ? 'Only permission, plan, and product trade-offs appear here. The controller handles child Agent failures automatically.' : '这里只显示权限、计划或产品取舍；子代理异常由主控自动处理，不需要进入子代理对话。'}</span>
      </header>
      {decisions.map(item => {
        const taskIndex = summary.tasks.findIndex(task => task.taskId === item.taskId)
        const task = taskIndex < 0 ? undefined : summary.tasks[taskIndex]
        const taskLabel = task === undefined ? summary.team.title : en ? `Task ${taskIndex + 1} “${task.goal}”` : `任务 ${taskIndex + 1}「${task.goal}」`
        return (
          <article key={`${item.taskId}:${item.code}`}>
            <strong title={task?.goal}>{taskLabel}</strong>
            <p>{formatAttentionMessage(item, locale)}</p>
            <p className="yuqi-controller-recommendation">{en ? 'Reply with your decision in this controller conversation. The controller forwards it to the relevant child Agent and continues scheduling.' : '请直接在当前主对话回复你的决定；主控会转交给对应子代理并继续调度。'}</p>
          </article>
        )
      })}
    </section>
  )
}
