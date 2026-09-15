import { useRef, useState } from 'react'
import { createRequestId, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'

/** Explicit, scoped cleanup; never deletes project files or Team recovery history. */
export function ProjectKnowledgeActions({ teamId, controllerSessionId, topic, itemId, command, en }: {
  readonly teamId: string
  readonly controllerSessionId: string | undefined
  readonly topic: 'architectureDecisions' | 'pitfalls' | 'conventions' | 'documentLinks' | 'overallProgress' | 'all'
  readonly itemId?: string
  readonly command: YuqiCommand | undefined
  readonly en: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [feedback, setFeedback] = useState('')
  const scope = topic === 'all' ? (en ? 'all project overview memory' : '整个项目总览记忆（所有分类、总体进度和文档链接）')
    : `${({ architectureDecisions: en ? 'Architecture decisions' : '架构决定', pitfalls: en ? 'Pitfalls and remedies' : '踩坑与解决方法', conventions: en ? 'Conventions and preferences' : '约定与明确偏好', documentLinks: en ? 'Documentation links' : '文档链接', overallProgress: en ? 'Overall progress' : '总体进度' })[topic]}${itemId === undefined ? '' : ` / ${itemId}`}`
  const execute = async () => {
    if (!confirming || busyRef.current || command === undefined || controllerSessionId === undefined) return
    busyRef.current = true
    setBusy(true)
    setFeedback('')
    try {
      const action = itemId === undefined ? `knowledge-clear ${topic} confirm` : `knowledge-delete ${topic} ${itemId}`
      const ok = await command(`/yuqi ${action} ${teamId} ${controllerSessionId} ${createRequestId()}`, { teamId, controllerSessionId })
      if (!ok) throw new Error('not accepted')
      setFeedback(en ? 'Saved. Use Refresh project memory to check the latest index before repeating cleanup.' : '已保存。可点击“刷新项目记忆”核对最新索引，不要重复清理。')
      setConfirming(false)
    } catch (error) {
      setFeedback(error instanceof YuqiCommandOutcomeError ? error.message : (en ? 'Cleanup was not confirmed. Refresh the records before retrying; project files are not deleted by this action.' : '未确认清理成功，请刷新记录后再试；此操作不会删除项目文件。'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return <div className="yuqi-knowledge-actions">
    <button type="button" className="yuqi-secondary-action" disabled={busy || command === undefined || controllerSessionId === undefined}
      onClick={() => { setConfirming(true); setFeedback('') }}>{topic === 'all' ? (en ? 'Clear all project overview memory' : '清空整个项目总览记忆') : itemId === undefined ? (en ? 'Clear this category' : '清空此类记录') : (en ? 'Delete record' : '删除记录')}</button>
    {confirming ? <div role="group" aria-label={en ? 'Confirm memory cleanup' : '确认清理记忆'}>
      <p><strong>{en ? 'Scope: ' : '清理范围：'}{scope}</strong></p>
      <p>{en ? 'Only these project memory entries will be removed. Source files, linked files and Team recovery logs are kept. This cannot be undone here.' : '仅移除这些项目记忆记录，不删除源码、引用文件或团队恢复日志；此处无法撤销。'}</p>
      <button type="button" className="yuqi-secondary-action" disabled={busy} onClick={() => { void execute() }}>{busy ? (en ? 'Cleaning…' : '正在清理…') : (en ? 'Confirm cleanup' : '确认清理')}</button>
      <button type="button" className="yuqi-secondary-action" disabled={busy} onClick={() => setConfirming(false)}>{en ? 'Keep records' : '保留记录'}</button>
    </div> : null}
    {feedback ? <p role="status">{feedback}</p> : null}
  </div>
}

export function ProjectKnowledgeRefresh({ teamId, controllerSessionId, command, en }: {
  readonly teamId: string; readonly controllerSessionId: string | undefined; readonly command: YuqiCommand | undefined; readonly en: boolean
}) {
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState('')
  async function refresh() {
    if (busyRef.current || command === undefined || controllerSessionId === undefined) return
    busyRef.current = true
    setBusy(true)
    setFeedback('')
    try {
      const ok = await command(`/yuqi knowledge-refresh ${teamId} ${controllerSessionId} ${createRequestId()}`, { teamId, controllerSessionId })
      if (!ok) throw new Error('not confirmed')
      setFeedback(en ? 'Project memory refreshed.' : '项目记忆已刷新。')
    } catch (error) {
      setFeedback(error instanceof YuqiCommandOutcomeError ? error.message : (en ? 'Refresh failed. The displayed snapshot may be outdated; try again.' : '刷新失败，当前展示的快照可能已过时，请重试。'))
    } finally { busyRef.current = false; setBusy(false) }
  }
  return <div className="yuqi-knowledge-actions yuqi-knowledge-refresh-block">
    <div className="yuqi-knowledge-refresh-header">
      <button type="button" className="yuqi-secondary-action" disabled={busy || command === undefined || controllerSessionId === undefined} onClick={() => { void refresh() }}>{busy ? (en ? 'Refreshing…' : '正在刷新…') : (en ? 'Refresh project memory' : '刷新项目记忆')}</button>
      {feedback ? <span role="status" className="yuqi-knowledge-feedback">{feedback}</span> : null}
    </div>
    <p className="yuqi-knowledge-help">{en ? 'Reads the index in this Team’s execution project. Separate worktrees can have separate copies. Deletion affects later reads, not context already sent to an Agent; memory preferences do not change execution settings.' : '读取本团队执行项目中的索引；不同隔离工作区可能各有副本。删除在后续读取时生效，不撤回已发给代理的上下文；记忆中的偏好不会改动执行设置。'}</p>
  </div>
}
