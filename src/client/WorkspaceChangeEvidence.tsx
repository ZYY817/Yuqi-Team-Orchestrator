import { useMemo } from 'react'
import type { TeamSidecarEvent } from '../domain/team-sidecar-web-contract.ts'

interface SnapshotChange { path: string; kind: 'added' | 'modified' | 'deleted'; before?: { sha256: string; size: number }; after?: { sha256: string; size: number } }
interface SnapshotEvidence { seq: number; runId: string; beforeCapturedAt: string; afterCapturedAt: string; partial: boolean; reasons: string[]; changes: SnapshotChange[] }
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const fingerprint = (value: unknown) => {
  const f = object(value)
  return f !== undefined && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(f.sha256)
    && Number.isSafeInteger(f.size) && Number(f.size) >= 0
}
function collectionReason(reason: string, en: boolean): string {
  const labels: Record<string, readonly [string, string]> = {
    cancelled: ['采集已取消', 'Collection cancelled'], 'depth-limit': ['目录层级达到上限', 'Directory depth limit'],
    'entry-limit': ['目录项数量达到上限', 'Directory entry limit'], excluded: ['已排除构建或缓存内容', 'Build or cache entries excluded'],
    'sensitive-excluded': ['已排除敏感文件', 'Sensitive files excluded'], 'path-excluded': ['已排除不支持的路径', 'Unsupported paths excluded'],
    'symlink-excluded': ['已排除符号链接', 'Symbolic links excluded'], 'special-file-excluded': ['已排除特殊文件或硬链接', 'Special files or hard links excluded'],
    'file-limit': ['文件数量达到上限', 'File count limit'], 'file-size-limit': ['部分文件超过大小上限', 'Per-file size limit'],
    'total-size-limit': ['总读取大小达到上限', 'Total size limit'], 'unreadable-or-unstable': ['部分文件无法读取或在采集时发生变化', 'Unreadable or changing files'],
    'resource-limit': ['采集资源达到上限', 'Collection resource limit'], timeout: ['采集超时', 'Collection timed out'],
    'workspace-mismatch': ['前后工作区不一致', 'Workspace mismatch'], 'unconfirmed-absence': ['无法确认部分文件是否新增或删除', 'Some additions or deletions could not be confirmed'],
    'change-limit': ['变更数量达到上限', 'Change count limit'],
  }
  if (reason.startsWith('excluded-directory:')) return `${en ? 'Excluded directory' : '已排除目录'}: ${reason.slice('excluded-directory:'.length)}`
  return labels[reason]?.[en ? 1 : 0] ?? `${en ? 'Other collection limit' : '其他采集限制'} (${reason})`
}
/** Parse only our Host event, never assistant/tool text; reject malformed partial records. */
export function workspaceChangeEvidence(nodes: readonly unknown[], sessionId: string | undefined): SnapshotEvidence[] {
  const records = new Map<number, SnapshotEvidence>()
  if (!sessionId) return []
  for (const raw of nodes) {
    const node = object(raw)
    const data = object(node?.data)
    if (node?.kind !== 'workspace-change-snapshot' || !Number.isSafeInteger(node.seq) || Number(node.seq) < 0
      || data?.version !== 1 || data.childSessionId !== sessionId || data.scope !== 'workspace' || data.attribution !== 'unavailable'
      || typeof data.runId !== 'string' || data.runId.length > 256 || typeof data.partial !== 'boolean'
      || typeof data.beforeCapturedAt !== 'string' || !Number.isFinite(Date.parse(data.beforeCapturedAt))
      || typeof data.afterCapturedAt !== 'string' || !Number.isFinite(Date.parse(data.afterCapturedAt))
      || !Array.isArray(data.reasons) || data.reasons.length > 32 || !data.reasons.every(reason => typeof reason === 'string' && reason.length <= 80)
      || !Array.isArray(data.changes) || data.changes.length > 512) continue
    const valid = data.changes.every(rawChange => {
      const c = object(rawChange)
      if (typeof c?.path !== 'string' || c.path.length > 1024 || !c.path || /[\\:\u0000-\u001f\u007f]/u.test(c.path)
        || c.path.startsWith('/') || c.path.split('/').some(part => part === '..' || !part)) return false
      return c.kind === 'added' ? c.before === undefined && fingerprint(c.after)
        : c.kind === 'deleted' ? c.after === undefined && fingerprint(c.before)
          : c.kind === 'modified' && fingerprint(c.before) && fingerprint(c.after)
    })
    if (!valid) continue
    records.set(Number(node.seq), { seq: Number(node.seq), runId: data.runId, beforeCapturedAt: data.beforeCapturedAt,
      afterCapturedAt: data.afterCapturedAt, partial: data.partial, reasons: data.reasons as string[], changes: data.changes as SnapshotChange[] })
  }
  return [...records.values()].sort((a, b) => b.seq - a.seq)
}

export function WorkspaceChangeEvidence({ nodes, sidecarEvents, sessionId, en, variant = 'task-row', onRefresh }: { readonly nodes: readonly unknown[]; readonly sidecarEvents?: readonly TeamSidecarEvent[] | undefined; readonly sessionId: string | undefined; readonly en: boolean; readonly variant?: 'task-row' | 'activity'; readonly onRefresh?: (() => void) | undefined }) {
  // The adapter below is private to this snapshot parser, never fed into native history/tool evidence.
  const records = useMemo(() => workspaceChangeEvidence(sidecarEvents === undefined ? nodes : sidecarEvents
    .filter(event => event.type === 'yuqi/workspace-change-snapshot')
    .map(event => ({ kind: 'workspace-change-snapshot', seq: event.seq, data: event.data })), sessionId), [nodes, sidecarEvents, sessionId])
  const snapshot = (record: SnapshotEvidence) => <details key={record.seq} open><summary>{en ? 'Snapshot' : '快照'} · {sidecarEvents === undefined ? 'Host event' : 'Sidecar event'} #{record.seq} · {record.partial ? (en ? 'Partial coverage' : '部分覆盖') : (en ? 'Within scan limits' : '扫描限额内完成')}</summary>
    <p>{record.beforeCapturedAt} → {record.afterCapturedAt}</p>
    <p>{en ? 'Attribution: unconfirmed' : '修改者归属：未确认'}</p>
    {record.reasons.length ? <p>{en ? 'Collection limits' : '采集限制'}: {record.reasons.map(reason => collectionReason(reason, en)).join(en ? '; ' : '；')}</p> : null}
    {record.changes.length === 0 ? <p>{en ? 'No file differences found.' : '未发现文件变动。'}</p>
      : <ul>{record.changes.map(change => <li key={change.path}>
        <strong>{({ added: en ? 'Added' : '新增', modified: en ? 'Modified' : '修改', deleted: en ? 'Deleted' : '删除' })[change.kind]}</strong> · <code>{change.path}</code>
        <p>{en ? 'Bytes' : '字节'}: {change.before?.size ?? '—'} → {change.after?.size ?? '—'}</p>
        <details><summary>{en ? 'File fingerprints' : '文件指纹'}</summary><code style={{ overflowWrap: 'anywhere' }}>{change.before?.sha256 ?? '—'} → {change.after?.sha256 ?? '—'}</code></details>
      </li>)}</ul>}
  </details>
  if (variant === 'activity') {
    if (records.length === 0) return null
    return <section className="yuqi-activity-workspace-evidence" aria-label={en ? 'Workspace change snapshots' : '工作区文件改动快照'}>
      <div className="yuqi-activity-evidence-heading"><h4>{en ? 'Workspace file change snapshots' : '工作区文件改动快照'}</h4>
        {onRefresh ? <button type="button" className="yuqi-secondary-action" onClick={onRefresh}>{en ? 'Refresh workspace snapshots' : '刷新工作区快照'}</button> : null}
      </div>
      <p>{en ? 'Snapshots are separate from tool evidence and do not establish who made a change.' : '快照与工具证据分开显示，不能据此确认修改者。'}</p>
      {records.map(snapshot)}
    </section>
  }
  return <section className="yuqi-insight-section" aria-label={en ? 'Workspace change snapshots' : '工作区文件改动快照'}>
    <h4>{en ? 'Workspace File Changes' : '工作区文件改动快照'}</h4>
    <p>{en ? 'Tracks file additions, modifications, and deletions in the workspace during execution.' : '对比任务执行前后的工作区文件，记录文件新增、修改与删除。'}</p>
    {records.length === 0 ? <p>{en ? 'No file changes detected during execution.' : '本次执行未检测到文件变动。'}</p>
      : records.map(snapshot)}
  </section>
}
