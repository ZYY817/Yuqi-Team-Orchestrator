import type { TeamConsoleProjectSummary, TeamConsoleProjectSummaryItem } from '../domain/team-console-contract.ts'
import type { YuqiLocale } from './client-locale.ts'
import type { YuqiCommand } from './command-actions.ts'
import { ProjectKnowledgeActions, ProjectKnowledgeRefresh } from './ProjectKnowledgeActions.tsx'

export interface ProjectSummarySectionProps {
  readonly summary: TeamConsoleProjectSummary | undefined
  readonly locale: YuqiLocale
  readonly teamId: string
  readonly controllerSessionId: string | undefined
  readonly command: YuqiCommand | undefined
}

export function ProjectSummarySection({ summary, locale, teamId, controllerSessionId, command }: ProjectSummarySectionProps) {
  const en = locale === 'en'
  const controls = { teamId, controllerSessionId, command, en }
  return (
    <section key={`${teamId}:${controllerSessionId ?? ''}`} className="yuqi-activity-card yuqi-project-summary-section" aria-label={en ? 'Project overview' : '项目总览'}>
      <header className="yuqi-summary-header">
        <h3>{en ? 'Project overview' : '项目总览'}</h3>
        <div className="yuqi-summary-refresh-wrapper">
          <ProjectKnowledgeRefresh {...controls} />
        </div>
      </header>
      {hasSummaryContent(summary) ? <ProjectKnowledgeActions {...controls} topic="all" /> : null}
      <p className="yuqi-plan-explanation yuqi-summary-storage-note">
        {en
          ? 'Refresh reads the execution workspace index and updates the panel. Cleanup is saved to that index only; it does not delete the project or source files, or retract context already sent to Agents.'
          : '刷新只读取执行工作区索引并更新面板；清理会保存到该索引，不删除项目或源码，也不撤回已发给代理的上下文。'}
      </p>
      <div className="yuqi-summary-body">
        {!hasSummaryContent(summary) ? (
          <div className="yuqi-summary-empty-box" role="status">
            <p className="yuqi-insight-empty">
              {en
                ? 'No project overview recorded yet.'
                : '暂无项目总览记录。'}
            </p>
          </div>
        ) : (
          <div className="yuqi-summary-content">
            {summary.overallProgress.trim() ? <div className="yuqi-summary-block">
              <strong>{en ? 'Overall progress' : '总体进度'}</strong>
              <p>{summary.overallProgress}</p>
              <ProjectKnowledgeActions {...controls} topic="overallProgress" />
            </div> : null}
            <SummaryItemList label={en ? 'Architecture decisions' : '架构决定'} items={summary.architectureDecisions} controls={controls} topic="architectureDecisions" />
            <SummaryItemList label={en ? 'Conventions and explicit preferences' : '约定与明确偏好'} items={summary.conventions} controls={controls} topic="conventions" />
            <SummaryItemList label={en ? 'Pitfalls and remedies' : '踩坑与解决方法'} items={summary.pitfalls} controls={controls} topic="pitfalls" />
            {summary.documentLinks.length > 0 ? (
              <div className="yuqi-summary-block">
                <strong>{en ? 'Documentation links' : '文档链接'}</strong>
                <ProjectKnowledgeActions {...controls} topic="documentLinks" />
                <ul className="yuqi-insight-links">
                  {summary.documentLinks.map(link => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>)}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}

function hasSummaryContent(summary: TeamConsoleProjectSummary | undefined): summary is TeamConsoleProjectSummary {
  return summary !== undefined && (
    summary.overallProgress.trim().length > 0 ||
    summary.architectureDecisions.length > 0 ||
    summary.conventions.length > 0 ||
    summary.pitfalls.length > 0 ||
    summary.documentLinks.length > 0
  )
}

function SummaryItemList({ label, items, controls, topic }: { readonly label: string; readonly items: readonly TeamConsoleProjectSummaryItem[]; readonly controls: { teamId: string; controllerSessionId: string | undefined; command: YuqiCommand | undefined; en: boolean }; readonly topic: 'architectureDecisions' | 'pitfalls' | 'conventions' }) {
  if (items.length === 0) return null
  return (
    <div className="yuqi-summary-block">
      <strong>{label}</strong>
      <ProjectKnowledgeActions {...controls} topic={topic} />
      <ul className="yuqi-insight-list">
        {items.map(item => <li key={item.id}><span>{item.text}</span>{item.links.length === 0 ? null : <small>{item.links.join(' · ')}</small>}<ProjectKnowledgeActions {...controls} topic={topic} itemId={item.id} /></li>)}
      </ul>
    </div>
  )
}
