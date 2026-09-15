import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import { deriveFileChangeAudit, readFileContentChange } from './file-change-audit.ts'
import { useYuqiLocale } from './client-locale.ts'
import { NativeToolEvidence } from './NativeToolEvidence.tsx'
import { WorkspaceChangeEvidence } from './WorkspaceChangeEvidence.tsx'
import type { SidecarStore } from './sidecar-store.ts'

export const FileAuditSessionsContext = createContext<ClientContext['sessions'] | undefined>(undefined)
export const FileAuditSidecarContext = createContext<SidecarStore | undefined>(undefined)
export type FileAuditHistoryLoader = (id: string, beforeSeq: number | undefined, signal: AbortSignal) => Promise<{ events: HistoryEntry[]; hasMore: boolean }>
export const FileAuditHistoryContext = createContext<FileAuditHistoryLoader | undefined>(undefined)
const noSubscribe = () => () => undefined
const noSnapshot = () => undefined
const noNodes: readonly unknown[] = []

/** Pair only calls and results actually present in the loaded official history pages. */
function historyNodes(entries: readonly HistoryEntry[]): readonly unknown[] {
  const calls = new Map<string, { name: string; argsRaw: string }>()
  const nodes: unknown[] = []
  for (const { event } of entries) {
    if (String(event.type) === 'yuqi/workspace-change-snapshot') nodes.push({ kind: 'workspace-change-snapshot', seq: event.seq, data: event.data })
    if (event.type === 'tool/call') calls.set(event.data.callId, { name: event.data.name, argsRaw: event.data.arguments })
    if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      nodes.push({ kind: 'tool-result', seq: event.seq, callId: block.toolCallId, isError: block.isError === true,
        call: calls.get(block.toolCallId) ?? null, meta: event.data.meta, error: event.data.error, content: block.content })
    }
  }
  return nodes
}

interface HistoryState {
  id: string | undefined
  events: HistoryEntry[]
  hasMore: boolean
  loaded: boolean
  status: 'idle' | 'loading' | 'error' | 'cancelled'
}

/** Expanded details own cancellable history reads, without selecting or activating the child. */
export function TaskFileAudit({ sessionId, reported, variant = 'task-row', executionState = 'unknown', hasAttempt = false }: {
  readonly sessionId?: string | undefined
  readonly reported?: readonly string[] | undefined
  /** Activity callers must supply this from their authoritative task projection. */
  readonly variant?: 'task-row' | 'activity'
  readonly executionState?: 'not-started' | 'unknown'
  readonly hasAttempt?: boolean
}) {
  const en = useYuqiLocale() === 'en'
  const sessions = useContext(FileAuditSessionsContext)
  const loadHistory = useContext(FileAuditHistoryContext)
  const sidecar = useContext(FileAuditSidecarContext)
  const sidecarState = useSyncExternalStore(sidecar?.subscribe ?? noSubscribe, sidecar?.getSnapshot ?? noSnapshot, noSnapshot)
  const legacySnapshots = sidecar === undefined || sidecarState?.status === 'ready'
    && (sidecarState.mode === 'legacy' || sidecarState.legacy.has(sessionId ?? ''))
  const [history, setHistory] = useState<HistoryState>({ id: sessionId, events: [], hasMore: false, loaded: false, status: 'idle' })
  const [selectedKey, setSelectedKey] = useState<string>()
  const historyRef = useRef(history)
  historyRef.current = history
  const request = useRef<AbortController | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const stop = useCallback(() => {
    const active = request.current
    request.current = undefined
    active?.abort()
    clearTimeout(timer.current)
  }, [])
  const load = useCallback(async (older: boolean) => {
    if (sessionId === undefined || loadHistory === undefined) return
    stop()
    const previous = historyRef.current.id === sessionId ? historyRef.current : undefined
    // A refresh replaces neither already recorded evidence nor a readable
    // older page while the new page is in flight. If it fails, callers can
    // still distinguish retained records from a complete refreshed history.
    const base = previous?.events ?? []
    const beforeSeq = older ? base[0]?.event.seq : undefined
    if (older && beforeSeq === undefined) return
    const controller = new AbortController()
    request.current = controller
    setHistory({ id: sessionId, events: base, hasMore: previous?.hasMore === true,
      loaded: previous?.loaded === true, status: 'loading' })
    timer.current = setTimeout(() => {
      if (request.current !== controller) return
      stop()
      setHistory(value => ({ ...value, status: 'error' }))
    }, 30_000)
    try {
      const page = await loadHistory(sessionId, beforeSeq, controller.signal)
      if (request.current !== controller || controller.signal.aborted) return
      if (page.hasMore && page.events.length === 0) throw new Error('History cursor did not advance')
      if (beforeSeq !== undefined && page.events.some(({ event }) => event.seq >= beforeSeq)) throw new Error('History pages overlap')
      const entries = new Map([...page.events, ...base].map(entry => [entry.event.seq, entry]))
      const events = [...entries.values()].sort((a, b) => a.event.seq - b.event.seq)
      setHistory({ id: sessionId, events, hasMore: page.hasMore, loaded: true, status: 'idle' })
    } catch {
      if (request.current === controller) setHistory(value => ({ ...value, status: 'error' }))
    } finally {
      if (request.current === controller) {
        request.current = undefined
        clearTimeout(timer.current)
      }
    }
  }, [sessionId, loadHistory, stop])
  useEffect(() => {
    void load(false)
    return stop
  }, [load, stop])
  useSyncExternalStore(sessions?.list.subscribe ?? noSubscribe, sessions?.list.getSnapshot ?? noSnapshot, noSnapshot)
  const session = sessionId === undefined ? undefined : sessions?.binding(sessionId as SessionId)?.session
  const subscribe = useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => undefined), [session])
  const getSnapshot = useCallback(() => session?.getSnapshot(), [session])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, noSnapshot)
  const current = history.id === sessionId ? history : undefined
  const fetchedNodes = useMemo(() => historyNodes(current?.events ?? []), [current?.events])
  const nodes = loadHistory !== undefined ? fetchedNodes : snapshot?.openState === 'open' && !snapshot.removed ? snapshot.nodes : noNodes
  const records = useMemo(() => deriveFileChangeAudit(sessionId, nodes, reported), [sessionId, nodes, reported])
  const recordKey = (record: (typeof records)[number]) => JSON.stringify([record.source, record.sessionId, record.eventSeq, record.path])
  const selected = records.find(record => recordKey(record) === selectedKey) ?? records[0]
  const fileGroups = useMemo(() => {
    const groups = new Map<string, typeof records[number][]>()
    for (const record of records) groups.set(record.path, [...(groups.get(record.path) ?? []), record])
    return [...groups.entries()]
  }, [records])
  const selectedFileRecords = records.filter(record => record.path === selected?.path)
  const contentChange = useMemo(() => selected === undefined ? undefined : readFileContentChange(selected, nodes), [selected, nodes])
  const activity = variant === 'activity'
  const MetadataContainer = activity ? 'details' : 'div'
  const refreshSnapshots = useCallback(() => { void sidecar?.refresh(true) }, [sidecar])
  const refreshActivityEvidence = useCallback(() => {
    if (loadHistory !== undefined && sessionId !== undefined) void load(false)
    // This explicit action deliberately surfaces Sidecar loading/failure state.
    void sidecar?.refresh()
  }, [load, loadHistory, sessionId, sidecar])
  const unavailable = en ? 'Not acquired' : '未获取'
  const labels = {
    'tool-result-diff': en ? 'Tool result: changed content' : '工具结果：内容差异',
    'successful-write-call': en ? 'Write succeeded; content change unconfirmed' : '写工具成功；内容变化未确认',
    'agent-report': en ? 'Agent report; not independently verified' : '模型自报；未独立核验',
  }
  const activityMissingState = sessionId === undefined
    ? executionState === 'not-started'
      ? (en ? 'This task has not started yet. File and tool evidence will appear after execution records exist.' : '任务尚未开始；执行记录产生后将在此显示文件与工具证据。')
      : (hasAttempt
          ? (en ? 'This task has an attempt record, but its child-session record is unavailable. File evidence cannot be read from this view.' : '此任务已有尝试记录，但缺少子会话记录；此视图无法读取文件证据。')
          : (en ? 'No child-session record is available for this task. This alone does not establish whether it has run.' : '此任务缺少子会话记录；仅凭这一点不能判断是否已执行。'))
    : undefined
  if (!activity && sessionId === undefined) {
    return <div className="yuqi-detail-line yuqi-file-audit-aligned yuqi-file-audit-empty" style={{ display: 'block', minWidth: 0 }} role="status">
      <strong>{executionState === 'not-started' ? (en ? 'Evidence will appear after execution starts' : '执行开始后显示证据') : (en ? 'Child-session evidence is unavailable' : '子会话证据不可用')}</strong>
      <p>{executionState === 'not-started'
        ? (en ? 'No child Agent conversation or execution evidence exists for this task plan yet.' : '当前仍是任务计划，尚无子代理会话或执行证据。')
        : hasAttempt
          ? (en ? 'An execution record exists, but no child-session record is available in this view. This does not mean the task produced no files.' : '已有执行记录，但此视图缺少子会话记录；这不代表任务没有产生文件。')
          : (en ? 'No child-session record is available. This alone does not establish whether the task ran or changed files.' : '缺少子会话记录；仅凭这一点不能判断任务是否运行或修改过文件。')}</p>
    </div>
  }
  if (activity && executionState === 'not-started' && activityMissingState !== undefined) {
    return <div className="yuqi-detail-line yuqi-file-audit-aligned yuqi-activity-file-audit" style={{ display: 'block', minWidth: 0 }}>
      <section className="yuqi-activity-file-empty" role="status"><strong>{en ? 'Task has not started' : '任务尚未开始'}</strong>
        <p>{en ? 'File and tool evidence will appear after execution records exist.' : '执行记录产生后将在此显示文件与工具证据。'}</p>
      </section>
    </div>
  }
  const activitySidecarRetryLabel = en ? 'Refresh workspace snapshots' : '刷新工作区快照'
  return <div className={`yuqi-detail-line yuqi-file-audit-aligned${activity ? ' yuqi-activity-file-audit' : ''}`} style={{ display: 'block', minWidth: 0 }}>
    <span className="yuqi-detail-label">{en ? 'File change evidence' : '文件变更证据'}</span>
    <p>{en
      ? 'Recorded file modifications and snapshot differences for this task. Older runs without directory snapshots cannot be reconstructed.'
      : '记录此任务执行期间由写文件/编辑工具产生的文件证据；旧任务如尚未采集目录差异，不能事后倒推。'}</p>
    {activity && activityMissingState !== undefined ? <section className="yuqi-activity-file-empty" role="status"><p>{activityMissingState}</p></section> : null}
    {sessionId === undefined ? (!activity ? <p>{en ? 'No child session yet.' : '尚未创建子会话。'}</p> : null)
      : loadHistory === undefined ? (!activity ? <p role="status">{en ? 'Background history loading is unavailable in this Host connection.' : '当前 Host 连接未提供后台历史读取能力。'}</p>
        : <div className="yuqi-activity-file-actions"><p role="status">{en ? 'Background history loading is unavailable in this Host connection.' : '当前 Host 连接未提供后台历史读取能力。'}</p>
          {sidecar !== undefined ? <button type="button" className="yuqi-secondary-action" onClick={refreshActivityEvidence}>{activitySidecarRetryLabel}</button> : null}
        </div>)
      : <div className={activity ? 'yuqi-activity-file-actions' : undefined}>
        <button type="button" className="yuqi-secondary-action" disabled={current?.status === 'loading'} onClick={activity ? refreshActivityEvidence : () => { void load(false) }}>{en ? 'Refresh file records' : '刷新文件修改记录'}</button>
        <p>{en ? 'Reads recorded child-session tool results; does not rerun the task or modify files.' : '读取子代理会话中已记录的工具结果；不会重新执行任务，也不会修改文件。'}</p>
        {current?.hasMore ? <button type="button" disabled={current.status === 'loading'} onClick={() => { void load(true) }}>{en ? 'Load earlier records' : '加载更早记录'}</button> : null}
        {current?.status === 'loading' ? <button type="button" onClick={() => { stop(); setHistory(value => ({ ...value, status: 'cancelled' })) }}>{en ? 'Cancel loading' : '取消加载'}</button> : null}
        {current?.status === 'loading' ? <p role="status">{en ? 'Loading evidence in this panel…' : '正在本面板后台加载证据…'}</p> : null}
        {current?.status === 'error' && (!activity || records.length > 0) ? <p role="status">{en ? 'History loading failed or timed out. Retained file evidence may be incomplete; use Refresh file records to retry here.' : '历史加载失败或超时，保留的文件证据可能不完整；可在此点击“刷新文件修改记录”重试。'}</p> : null}
        {current?.status === 'cancelled' && (!activity || records.length > 0) ? <p role="status">{en ? 'Loading cancelled; retained file evidence may be incomplete.' : '已取消加载；保留的文件证据可能不完整。'}</p> : null}
      </div>}
    {activity && sessionId !== undefined && records.length === 0 && current?.status !== 'loading' ? <section className="yuqi-activity-file-empty" role="status">
      <p>{loadHistory === undefined
        ? (en ? 'Background history reads are unavailable in this Host connection. This does not establish whether files changed.' : '当前 Host 连接未提供后台历史读取能力；这不能说明文件是否改动。')
        : current?.status === 'error'
        ? (en ? 'Recorded evidence could not be loaded. Retry reads existing records only; it does not inspect the workspace or rerun the task.' : '无法加载已记录的证据。重试只会读取已有记录，不会扫描工作区或重新执行任务。')
        : current?.status === 'cancelled'
          ? (en ? 'Evidence loading was cancelled. Retained records may be incomplete.' : '证据加载已取消；保留的记录可能不完整。')
        : current?.loaded
          ? (current.hasMore
              ? (en ? 'No attributable file evidence is present in the loaded page. Earlier records remain unloaded, so this does not prove that no files changed.' : '已加载页中没有可归因的文件证据，仍有更早记录未加载；这不代表没有文件改动。')
              : (en ? 'No attributable file evidence is present in the loaded records. This does not prove that no files changed.' : '已加载记录中没有可归因的文件证据；这不代表没有文件改动。'))
          : (en ? 'File evidence has not been loaded for this task. Refresh reads existing records only.' : '尚未加载此任务的文件证据；刷新只会读取已有记录。')}</p>
    </section> : null}
    {!activity ? <p>{en
      ? 'Showing loaded evidence records for this task; missing records do not prove no changes.'
      : '展示当前会话已加载的文件证据；缺少记录不代表没有修改。'}{(loadHistory !== undefined ? current?.hasMore : snapshot?.hasMore) ? (en ? ' Older history remains unloaded.' : ' 仍有更早历史未加载。') : ''}{current?.loaded ? (en ? ' Snapshot only; refresh to include newer events.' : ' 这是读取时快照；新事件需刷新后纳入。') : ''}</p>
    : null}
    {records.length === 0 ? (!activity ? <p className="yuqi-empty">{en ? 'No attributable file evidence in the available records.' : '当前记录中没有可归因的文件证据。'}</p> : null) : <div className="yuqi-audit-browser">
      <ul className="yuqi-audit-file-list" aria-label={en ? 'File evidence records' : '文件证据记录'} tabIndex={0}>
        {(activity ? fileGroups.map(([, group]) => group[0]!) : records).map(record => <li key={activity ? record.path : recordKey(record)}>
          <button type="button" className="yuqi-secondary-action" aria-pressed={activity ? record.path === selected?.path : recordKey(record) === (selected && recordKey(selected))} onClick={() => setSelectedKey(recordKey(record))}>
            <code>{record.path}</code><span>{labels[record.source]}</span>
            {activity ? <small>{records.filter(item => item.path === record.path).length} {en ? 'records' : '条记录'}</small> : null}
            {record.eventSeq === undefined ? null : <small>{record.tool} · event #{record.eventSeq}</small>}
          </button>
        </li>)}
      </ul>
      {selected ? <section className="yuqi-audit-evidence" aria-label={en ? 'Selected file evidence' : '所选文件证据'}>
        <h4><code>{selected.path}</code></h4>
        {activity ? <label className="yuqi-audit-record-select">{en ? 'Record' : '选择记录'}<select value={recordKey(selected)} onChange={event => setSelectedKey(event.currentTarget.value)}>
          {selectedFileRecords.map(record => <option key={recordKey(record)} value={recordKey(record)}>{record.eventSeq === undefined ? (en ? 'Reported' : '自报记录') : `#${record.eventSeq}`} · {labels[record.source]}</option>)}
        </select></label> : null}
        <span className="yuqi-audit-source">{labels[selected.source]}</span>
        {contentChange === undefined ? <p>{en ? 'No displayable before/after content in this record. Common secret files are not previewed.' : '此记录没有可展示的修改前后正文；常见敏感文件不提供正文预览。'}</p>
          : <details className="yuqi-file-content-diff"><summary>{en ? 'View recorded content change' : '查看已记录的内容变更'} · {contentChange.segmentCount} {en ? 'fragments' : '个片段'}</summary>
            <p>{en ? 'Result-time change fragments, not complete files or current disk contents. An absent side does not prove the file was created or deleted.' : '工具结果中的变更片段，不是完整文件，也不是当前磁盘内容。某侧片段缺失不代表整个文件被新增或删除。'}</p>
            {contentChange.truncated ? <p role="status">{en ? 'Preview limited to 12,000 characters per side and 200 fragments.' : '每侧总计最多预览 12,000 个字符、最多 200 个片段。'} {contentChange.omittedSegmentCount ? (en ? `Omitted fragments: ${contentChange.omittedSegmentCount}` : `省略片段：${contentChange.omittedSegmentCount}`) : ''}</p> : null}
            {contentChange.segments.map(segment => <section key={segment.diffIndex} className="yuqi-diff-segment">
              <h5>{en ? 'Fragment' : '片段'} {segment.diffIndex + 1}</h5>
              <div className="yuqi-diff-side-by-side">
                <div className="yuqi-diff-pane yuqi-diff-before">
                  <strong>{en ? 'Before' : '修改前'}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{segment.before === null ? (en ? '(side not provided)' : '（未提供该侧片段）') : segment.before || (en ? '(empty)' : '（空）')}</pre>
                </div>
                <div className="yuqi-diff-pane yuqi-diff-after">
                  <strong>{en ? 'After' : '修改后'}</strong>
                  <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{segment.after === null ? (en ? '(side not provided)' : '（未提供该侧片段）') : segment.after || (en ? '(empty)' : '（空）')}</pre>
                </div>
              </div>
            </section>)}
          </details>}
        <MetadataContainer className="yuqi-audit-record-metadata">{activity ? <summary>{en ? 'Source and record details' : '来源与记录详情'}</summary> : null}<dl className="yuqi-audit-metadata">
          <dt>{en ? 'Evidence source' : '审计来源'}</dt><dd>{selected.source === 'agent-report' ? (en ? 'Agent report (not Host tool evidence)' : '模型报告（非 Host 工具证据）') : (en ? 'Host tool result' : 'Host 工具结果')} · {selected.source}</dd>
          <dt>{en ? 'Child session' : '子会话'}</dt><dd>{selected.sessionId ?? unavailable}</dd>
          <dt>{en ? 'Event sequence' : '事件序号'}</dt><dd>{selected.eventSeq ?? unavailable}</dd>
          <dt>{en ? 'Tool' : '工具'}</dt><dd>{selected.tool ?? unavailable}</dd>
          <dt>{en ? 'Call ID' : '调用 ID'}</dt><dd>{selected.callId ?? unavailable}</dd>
          <dt>{en ? 'Attempt attribution' : '尝试归属'}</dt><dd>{en ? 'Not acquired; session history may span attempts' : '未获取；会话历史可能跨越多次尝试'}</dd>
        </dl></MetadataContainer>
      </section> : null}
    </div>}
    {activity && sidecar !== undefined && sidecarState?.status === 'loading' ? <p role="status">{en ? 'Refreshing workspace snapshot records…' : '正在刷新工作区快照记录…'}</p> : null}
    {activity && sidecar !== undefined && sidecarState?.status === 'error' ? <p role="status">{en ? `Workspace snapshot records could not be read. Click “${loadHistory === undefined ? activitySidecarRetryLabel : 'Refresh file records'}” to retry; file evidence above is retained.` : `无法读取工作区快照记录；点击“${loadHistory === undefined ? activitySidecarRetryLabel : '刷新文件修改记录'}”重试，上方文件证据已保留。`}</p> : null}
    {activity && sidecar !== undefined && sidecarState?.status === 'cancelled' ? <p role="status">{en ? `Workspace snapshot loading was cancelled. Click “${loadHistory === undefined ? activitySidecarRetryLabel : 'Refresh file records'}” to retry.` : `工作区快照加载已取消；点击“${loadHistory === undefined ? activitySidecarRetryLabel : '刷新文件修改记录'}”重试。`}</p> : null}
    <NativeToolEvidence nodes={nodes} en={en} variant={variant} />
    {!activity && sidecar !== undefined ? <button type="button" className="yuqi-secondary-action" onClick={refreshSnapshots}>{en ? 'Refresh workspace snapshots' : '刷新工作区快照'}</button> : null}
    {!activity && sidecar !== undefined && sidecarState?.status !== 'ready' ? <p role="status">{en ? 'Workspace snapshot data unavailable; refresh Team data to retry.' : '工作区快照数据不可用，请刷新 Team 数据重试。'}</p> : null}
    <WorkspaceChangeEvidence nodes={legacySnapshots ? nodes : noNodes} sidecarEvents={sidecarState?.events.get(sessionId ?? '')} sessionId={sessionId} en={en} variant={variant} onRefresh={sidecar === undefined ? undefined : activity ? refreshActivityEvidence : refreshSnapshots} />
  </div>
}
