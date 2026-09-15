// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HistoryEntry } from '@deepseek-ai/dsh-client-connection/client'
import type { CallId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import { FileAuditHistoryContext, FileAuditSessionsContext, FileAuditSidecarContext, TaskFileAudit, type FileAuditHistoryLoader } from '../../src/client/TaskFileAudit.tsx'
import type { SidecarState, SidecarStore } from '../../src/client/sidecar-store.ts'

vi.mock('../../src/client/client-locale.ts', () => ({ useYuqiLocale: () => 'zh' }))

const navigationGuards: ReturnType<typeof vi.fn>[] = []

it('groups activity records by file and switches the selected record without navigation', () => {
  const snapshot = { openState: 'open', hasMore: false, nodes: [9, 12].map(seq => ({ kind: 'tool-result', seq, callId: `call-${seq}`, isError: false,
    call: { name: 'write', argsRaw: '{"file_path":"same.ts"}' }, meta: { diffs: [{ path: 'same.ts', oldText: `before-${seq}`, newText: `after-${seq}` }] },
  })) }
  const list = {}
  const subscribe = () => () => undefined
  const sessions = { list: { subscribe, getSnapshot: () => list }, binding: () => ({ session: { subscribe, getSnapshot: () => snapshot } }) } as unknown as ClientContext['sessions']
  render(<FileAuditSessionsContext.Provider value={sessions}><TaskFileAudit variant="activity" sessionId="child-a" /></FileAuditSessionsContext.Provider>)
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getAllByRole('button')).toHaveLength(1)
  const select = screen.getByRole('combobox', { name: '选择记录' })
  const options = within(select).getAllByRole('option') as HTMLOptionElement[]
  expect(options).toHaveLength(2)
  fireEvent.change(select, { target: { value: options[1]!.value } })
  expect(select).toHaveValue(options[1]!.value)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  for (const navigate of navigationGuards.splice(0)) expect(navigate).not.toHaveBeenCalled()
})

it('keeps unavailable history and self-report visible without claiming a filesystem audit', () => {
  render(<TaskFileAudit sessionId="child-a" reported={['reported.ts']} />)
  expect(screen.getByRole('status')).toHaveTextContent('当前 Host 连接未提供后台历史读取能力。')
  expect(screen.queryByText(/打开子会话/)).not.toBeInTheDocument()
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText(/模型自报；未独立核验/)).toBeVisible()
  expect(screen.getByText(/尚未采集目录差异/)).toBeVisible()
})

it('uses one accurate activity empty state when an authoritative projection confirms the task has not started', () => {
  render(<TaskFileAudit variant="activity" executionState="not-started" />)
  expect(screen.getByRole('status')).toHaveTextContent('任务尚未开始')
  expect(screen.queryByText('文件变更证据')).not.toBeInTheDocument()
  expect(screen.queryByText(/当前 Host 连接未提供后台历史读取能力/)).not.toBeInTheDocument()
  expect(screen.queryByText(/未检测到文件变动/)).not.toBeInTheDocument()
  expect(screen.queryByText(/网络请求与图片记录/)).not.toBeInTheDocument()
})

it('keeps the activity empty state incomplete when older history has not been loaded', async () => {
  const loader = vi.fn<FileAuditHistoryLoader>().mockResolvedValue({ events: [callEntry(9, 'unpaired.ts')], hasMore: true })
  await act(async () => { render(<FileAuditHistoryContext.Provider value={loader}><TaskFileAudit variant="activity" sessionId="child-a" /></FileAuditHistoryContext.Provider>) })
  expect(screen.getByRole('status')).toHaveTextContent('仍有更早记录未加载')
  expect(screen.getByRole('button', { name: '加载更早记录' })).toBeEnabled()
  expect(screen.queryByText(/未检测到文件变动/)).not.toBeInTheDocument()
})

it('does not infer a missing child session means an activity task did not execute', () => {
  render(<TaskFileAudit variant="activity" executionState="unknown" hasAttempt />)
  expect(screen.getByRole('status')).toHaveTextContent('已有尝试记录，但缺少子会话记录')
  expect(screen.queryByText(/任务尚未开始/)).not.toBeInTheDocument()
})

it('shows traceable result metadata with incomplete-history disclosure', () => {
  const snapshot = { openState: 'open', hasMore: true, nodes: [{ kind: 'tool-result', seq: 9, callId: 'call-a', isError: false,
    call: { name: 'write', argsRaw: '{"file_path":"outside/scope.ts"}' },
    meta: { diffs: [{ path: 'outside/scope.ts', oldText: 'old', newText: 'new' }] },
  }] }
  const list = {}
  const subscribe = () => () => undefined
  const sessions = { list: { subscribe, getSnapshot: () => list }, binding: () => ({ session: { subscribe, getSnapshot: () => snapshot } }) } as unknown as ClientContext['sessions']
  render(<FileAuditSessionsContext.Provider value={sessions}><TaskFileAudit sessionId="child-a" /></FileAuditSessionsContext.Provider>)
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText(/工具结果：内容差异/)).toBeVisible()
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('outside/scope.ts')).toBeVisible()
  expect(screen.getByText(/event #9/)).toBeVisible()
  expect(screen.getByText(/更早历史未加载/)).toBeVisible()
})

it('does not render stale tool evidence after a history error', () => {
  const snapshot = { openState: 'error', hasMore: false, nodes: [] }
  const list = {}
  const subscribe = () => () => undefined
  const sessions = { list: { subscribe, getSnapshot: () => list }, binding: () => ({ session: { subscribe, getSnapshot: () => snapshot } }) } as unknown as ClientContext['sessions']
  render(<FileAuditSessionsContext.Provider value={sessions}><TaskFileAudit sessionId="child-a" /></FileAuditSessionsContext.Provider>)
  expect(screen.getByRole('status')).toHaveTextContent('当前 Host 连接未提供后台历史读取能力。')
  expect(screen.queryByText(/打开子会话/)).not.toBeInTheDocument()
  expect(screen.queryByText(/工具结果：内容差异/)).not.toBeInTheDocument()
})

type HistoryPage = Awaited<ReturnType<FileAuditHistoryLoader>>

function deferredPage() {
  let resolve!: (page: HistoryPage) => void
  let reject!: (error: Error) => void
  const promise = new Promise<HistoryPage>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Official history event shapes, not pre-paired UI nodes. In particular the
// result block uses toolCallId; metadata alone must not manufacture a call.
function callEntry(seq: number, file: string, callId = 'call-a'): HistoryEntry {
  return { event: { type: 'tool/call', seq, time: 0, data: {
    turn: 1, step: 1, callId: callId as CallId, name: 'write', arguments: JSON.stringify({ file_path: file }),
  } } }
}

function resultEntry(seq: number, file: string, callId = 'call-a'): HistoryEntry {
  return { event: { type: 'tool/result', seq, time: 0, surfaceOp: 'append', data: {
    turn: 1, step: 1,
    message: { id: `message-${seq}` as MessageId, role: 'user', source: { kind: 'tool', callId: callId as CallId },
      content: [{ type: 'tool-result', toolCallId: callId as CallId, isError: false, content: [] }] },
    meta: { diffs: [{ path: file, oldText: 'before', newText: 'after' }] },
  } } }
}

function completePage(file: string): HistoryPage {
  return { events: [callEntry(8, file), resultEntry(9, file)], hasMore: false }
}

function panelFixture(loader: FileAuditHistoryLoader) {
  const list = { current: 'controller', ids: [], byId: {} }
  const open = vi.fn()
  const openSubagent = vi.fn()
  navigationGuards.push(open, openSubagent)
  // The child is deliberately unbound: background evidence must not depend on
  // navigating to it or on a previously opened conversation snapshot.
  const sessions = { list: { subscribe: () => () => undefined, getSnapshot: () => list },
    binding: vi.fn(() => undefined), open, openSubagent } as unknown as ClientContext['sessions']
  return function Panel({ sessionId = 'child-a', expanded = true }: { sessionId?: string; expanded?: boolean }) {
    return <FileAuditSessionsContext.Provider value={sessions}>
      <FileAuditHistoryContext.Provider value={loader}>
        {expanded ? <TaskFileAudit sessionId={sessionId} /> : null}
      </FileAuditHistoryContext.Provider>
    </FileAuditSessionsContext.Provider>
  }
}

it('loads automatically on expansion with an unbound child and keeps the controller selected', async () => {
  const pending = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>().mockReturnValue(pending.promise)
  const Panel = panelFixture(loader)
  // TaskRow owns its expansion policy; this harness exercises the audit
  // component mount boundary without changing or mocking TaskRow itself.
  function ExpandablePanel() {
    const [expanded, setExpanded] = useState(false)
    return <><button onClick={() => setExpanded(value => !value)}>展开证据</button><Panel expanded={expanded} /></>
  }
  render(<ExpandablePanel />)
  expect(loader).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '展开证据' }))
  expect(loader).toHaveBeenCalledExactlyOnceWith('child-a', undefined, expect.any(AbortSignal))
  expect(screen.getByRole('status')).toHaveTextContent('正在本面板后台加载证据')
  expect(screen.getByRole('button', { name: '刷新文件修改记录' })).toBeDisabled()
  await act(async () => { pending.resolve(completePage('automatic.ts')) })
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('automatic.ts')).toBeVisible()
  expect(screen.getByText(/这是读取时快照/)).toBeVisible()
  expect(screen.queryByText(/打开子会话/)).not.toBeInTheDocument()
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '刷新文件修改记录' })).toBeEnabled()
})

it('pairs a result with its call only after the earlier page is loaded', async () => {
  const loader = vi.fn<FileAuditHistoryLoader>()
    .mockResolvedValueOnce({ events: [resultEntry(9, 'cross-page.ts')], hasMore: true })
    .mockResolvedValueOnce({ events: [callEntry(8, 'cross-page.ts')], hasMore: false })
  const Panel = panelFixture(loader)
  await act(async () => { render(<Panel />) })
  expect(screen.queryByText('cross-page.ts')).not.toBeInTheDocument()
  expect(screen.getByText(/更早历史未加载/)).toBeVisible()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })) })
  expect(loader).toHaveBeenNthCalledWith(2, 'child-a', 9, expect.any(AbortSignal))
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getAllByText('cross-page.ts')).toHaveLength(1)
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText(/工具结果：内容差异/)).toBeVisible()
  expect(within(screen.getByRole('region', { name: '所选文件证据' })).getByText('child-a')).toBeVisible()
  expect(within(screen.getByRole('region', { name: '所选文件证据' })).getByText('call-a')).toBeVisible()
  expect(within(screen.getByRole('region', { name: '所选文件证据' })).getByText('9')).toBeVisible()
  expect(screen.queryByRole('button', { name: '加载更早记录' })).not.toBeInTheDocument()
  expect(screen.queryByText(/更早历史未加载/)).not.toBeInTheDocument()
  expect(screen.getByText(/缺少记录不代表没有修改/)).toBeVisible()
})

it('aborts the old target and discards its late response after switching children', async () => {
  const oldPage = deferredPage()
  const newPage = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>().mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(newPage.promise)
  const Panel = panelFixture(loader)
  const view = render(<Panel sessionId="child-a" />)
  const oldSignal = loader.mock.calls[0]![2]
  view.rerender(<Panel sessionId="child-b" />)
  expect(oldSignal.aborted).toBe(true)
  expect(loader).toHaveBeenNthCalledWith(2, 'child-b', undefined, expect.any(AbortSignal))
  await act(async () => { newPage.resolve(completePage('child-b.ts')) })
  await act(async () => { oldPage.resolve(completePage('child-a.ts')) })
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('child-b.ts')).toBeVisible()
  expect(within(screen.getByRole('region', { name: '所选文件证据' })).getByText('child-b')).toBeVisible()
  expect(within(screen.getByRole('region', { name: '所选文件证据' })).getByText('9')).toBeVisible()
  expect(screen.queryByText('child-a.ts')).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('times out at 30 seconds, aborts, and retries here without accepting the timed-out result', async () => {
  vi.useFakeTimers()
  const oldPage = deferredPage()
  const retry = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>().mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(retry.promise)
  const Panel = panelFixture(loader)
  render(<Panel />)
  const oldSignal = loader.mock.calls[0]![2]
  act(() => { vi.advanceTimersByTime(29_999) })
  expect(oldSignal.aborted).toBe(false)
  act(() => { vi.advanceTimersByTime(1) })
  expect(oldSignal.aborted).toBe(true)
  expect(screen.getByRole('status')).toHaveTextContent('历史加载失败或超时')
  expect(screen.getByRole('button', { name: '刷新文件修改记录' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '刷新文件修改记录' }))
  expect(loader).toHaveBeenCalledTimes(2)
  expect(loader.mock.calls[1]![2]).not.toBe(oldSignal)
  expect(loader.mock.calls[1]![2].aborted).toBe(false)
  await act(async () => { oldPage.resolve(completePage('timed-out.ts')) })
  expect(screen.queryByText('timed-out.ts')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('正在本面板后台加载证据')
  await act(async () => { retry.resolve(completePage('retried.ts')) })
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('retried.ts')).toBeVisible()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels an earlier-page read, retains existing evidence, and retries that page', async () => {
  vi.useFakeTimers()
  const older = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>()
    .mockResolvedValueOnce({ ...completePage('retained.ts'), hasMore: true })
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce({ events: [callEntry(2, 'earlier.ts', 'call-old'), resultEntry(3, 'earlier.ts', 'call-old')], hasMore: false })
  const Panel = panelFixture(loader)
  await act(async () => { render(<Panel />) })
  fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }))
  const signal = loader.mock.calls[1]![2]
  fireEvent.click(screen.getByRole('button', { name: '取消加载' }))
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(screen.getByRole('status')).toHaveTextContent('已取消加载')
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('retained.ts')).toBeVisible()
  await act(async () => { older.resolve({ events: [callEntry(2, 'cancelled.ts'), resultEntry(3, 'cancelled.ts')], hasMore: false }) })
  expect(screen.queryByText('cancelled.ts')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('已取消加载')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '加载更早记录' })) })
  expect(loader).toHaveBeenNthCalledWith(3, 'child-a', 8, expect.any(AbortSignal))
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('earlier.ts')).toBeVisible()
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('retained.ts')).toBeVisible()
  expect(vi.getTimerCount()).toBe(0)
})

it('shows a rejected request as retryable in this panel without leaking error details', async () => {
  const pending = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(completePage('recovered.ts'))
  const Panel = panelFixture(loader)
  render(<Panel />)
  await act(async () => { pending.reject(new Error('private transport diagnostic')) })
  expect(screen.getByRole('status')).toHaveTextContent('可在此点击“刷新文件修改记录”重试')
  expect(screen.queryByText(/private transport diagnostic/)).not.toBeInTheDocument()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新文件修改记录' })) })
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('recovered.ts')).toBeVisible()
  expect(loader).toHaveBeenCalledTimes(2)
})

it('keeps retained activity records visibly incomplete after a refresh failure', async () => {
  const loader = vi.fn<FileAuditHistoryLoader>().mockResolvedValueOnce(completePage('retained-error.ts')).mockRejectedValueOnce(new Error('private transport diagnostic'))
  await act(async () => { render(<FileAuditHistoryContext.Provider value={loader}><TaskFileAudit variant="activity" sessionId="child-a" /></FileAuditHistoryContext.Provider>) })
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('retained-error.ts')).toBeVisible()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新文件修改记录' })) })
  expect(screen.getByRole('status')).toHaveTextContent('保留的文件证据可能不完整')
})

it('uses the activity file refresh to surface sidecar loading and retryable failure', async () => {
  const listeners = new Set<() => void>()
  let snapshot: SidecarState = { status: 'ready', mode: 'sidecar', legacy: new Set(), summaries: new Map(), events: new Map() }
  const publish = () => { for (const listener of listeners) listener() }
  const refresh = vi.fn(async () => {
    snapshot = { status: 'loading', legacy: new Set(), summaries: new Map(), events: new Map() }
    publish()
  })
  const sidecar = { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, getSnapshot: () => snapshot, refresh } as unknown as SidecarStore
  const loader = vi.fn<FileAuditHistoryLoader>().mockResolvedValue(completePage('refreshes-sidecar.ts'))
  await act(async () => { render(<FileAuditSidecarContext.Provider value={sidecar}><FileAuditHistoryContext.Provider value={loader}>
    <TaskFileAudit variant="activity" sessionId="child-a" />
  </FileAuditHistoryContext.Provider></FileAuditSidecarContext.Provider>) })
  fireEvent.click(screen.getByRole('button', { name: '刷新文件修改记录' }))
  expect(refresh).toHaveBeenCalledWith()
  expect(screen.getAllByRole('status').some(status => status.textContent?.includes('正在刷新工作区快照记录'))).toBe(true)
  act(() => {
    snapshot = { status: 'error', error: 'safe failure', legacy: new Set(), summaries: new Map(), events: new Map() }
    publish()
  })
  expect(screen.getAllByRole('status').some(status => status.textContent?.includes('无法读取工作区快照记录'))).toBe(true)
})

it('offers only the workspace retry when activity history reads are unavailable', () => {
  const refresh = vi.fn()
  const snapshot: SidecarState = { status: 'ready', mode: 'sidecar', legacy: new Set(), summaries: new Map(), events: new Map() }
  const sidecar = { subscribe: () => () => undefined, getSnapshot: () => snapshot, refresh } as unknown as SidecarStore
  render(<FileAuditSidecarContext.Provider value={sidecar}><TaskFileAudit variant="activity" sessionId="child-a" reported={['reported.ts']} /></FileAuditSidecarContext.Provider>)
  fireEvent.click(screen.getByRole('button', { name: '刷新工作区快照' }))
  expect(refresh).toHaveBeenCalledWith()
  expect(screen.queryByRole('button', { name: '刷新文件修改记录' })).not.toBeInTheDocument()
})

it('aborts and clears the timeout on collapse, then reloads on re-expansion', async () => {
  vi.useFakeTimers()
  const oldPage = deferredPage()
  const loader = vi.fn<FileAuditHistoryLoader>().mockReturnValueOnce(oldPage.promise).mockResolvedValueOnce(completePage('reopened.ts'))
  const Panel = panelFixture(loader)
  const view = render(<Panel />)
  const signal = loader.mock.calls[0]![2]
  view.rerender(<Panel expanded={false} />)
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => { oldPage.resolve(completePage('unmounted.ts')) })
  expect(screen.queryByText('unmounted.ts')).not.toBeInTheDocument()
  await act(async () => { view.rerender(<Panel />) })
  expect(loader).toHaveBeenCalledTimes(2)
  expect(within(screen.getByRole('list', { name: '文件证据记录' })).getByText('reopened.ts')).toBeVisible()
  expect(screen.queryByText('unmounted.ts')).not.toBeInTheDocument()
  expect(vi.getTimerCount()).toBe(0)
})
