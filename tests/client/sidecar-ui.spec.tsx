// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createSidecarStore } from '../../src/client/sidecar-store.ts'
import { YuqiTeamDock } from '../../src/client/YuqiTeamDock.tsx'
import { SidecarStatus } from '../../src/client/SidecarStatus.tsx'
import { FileAuditSidecarContext, FileAuditHistoryContext, TaskFileAudit } from '../../src/client/TaskFileAudit.tsx'
import { completeTeamEvents } from '../fixtures.ts'

const disposers: Array<() => void> = []
afterEach(() => { cleanup(); disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); localStorage.clear(); document.documentElement.lang = 'zh-CN' })
function fixture(events: unknown[] = [{ type: 'yuqi/team-event', seq: 1, time: 1, ignorable: true, data: { events: completeTeamEvents().slice(0, 8) } }]) {
  const response = { ok: true, value: { mode: 'sidecar', sessions: [{ sessionId: 'controller', source: 'sidecar', events: JSON.parse(JSON.stringify(events)) }] } }
  const call = vi.fn(async (..._args: unknown[]): Promise<unknown> => response)
  const native = Object.freeze({ ids: [], byId: {} })
  const sessions = { list: { getSnapshot: () => native, subscribe: () => () => {} }, binding: () => undefined } as unknown as ClientContext['sessions']
  const store = createSidecarStore({ call } as unknown as ClientConnectionRpc, sessions)
  disposers.push(store.dispose)
  return { store, call, response }
}

it('keeps the open real dock panel and unsaved input during slow polling, without reading native Yuqi projection', async () => {
  vi.useFakeTimers()
  const h = fixture()
  await h.store.refresh()
  const nativeProjection = vi.fn(() => { throw new Error('native projection forbidden') })
  const props = { useProjection: nativeProjection, teamProjection: { subscribe: h.store.subscribe, getSnapshot: () => h.store.summary('controller') },
    onOpenChild: async () => true, command: async () => true } as unknown as ComponentProps<typeof YuqiTeamDock>
  render(<YuqiTeamDock {...props} />)
  fireEvent.click(screen.getByRole('button', { name: '打开 Yuqi Team 任务面板' }))
  const draft = screen.getByRole('textbox', { name: '补充团队要求内容' })
  fireEvent.change(draft, { target: { value: 'keep this unsaved instruction' } })
  const panel = screen.getByRole('dialog')
  let resolve!: (value: unknown) => void
  h.call.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(screen.getByRole('dialog')).toBe(panel)
  expect(draft).toHaveValue('keep this unsaved instruction')
  await act(async () => { resolve(h.response); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.getByRole('dialog')).toBe(panel)
  expect(screen.getByRole('textbox', { name: '补充团队要求内容' })).toBe(draft)
  expect(draft).toHaveValue('keep this unsaved instruction')
  expect(nativeProjection).not.toHaveBeenCalled()
})

it.each(['zh-CN', 'en'])('offers an independent retry after failure (%s)', async lang => {
  document.documentElement.lang = lang
  const h = fixture()
  h.call.mockRejectedValueOnce(new Error('offline'))
  await h.store.refresh()
  render(<SidecarStatus store={h.store} />)
  expect(screen.getByRole('status')).not.toHaveAttribute('style')
  expect(screen.getByRole('button', { name: lang === 'en' ? 'Refresh Team data' : '刷新 Team 数据' })).toHaveClass('yuqi-secondary-action')
  expect(screen.getByRole('status')).toHaveTextContent(lang === 'en' ? 'Team data unavailable' : 'Team 数据加载失败')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Refresh Team data' : '刷新 Team 数据' })) })
  expect(h.store.getSnapshot().status).toBe('ready')
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('keeps a dismissed failure compact through background polling, with keyboard reopening and a new notice after recovery', async () => {
  vi.useFakeTimers()
  const h = fixture()
  h.call.mockRejectedValue(new Error('offline'))
  await h.store.refresh()
  render(<SidecarStatus store={h.store} />)
  fireEvent.click(screen.getByRole('button', { name: '收起提示' }))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Team 数据状态：加载失败' })).toHaveFocus()
  expect(h.store.getSnapshot().status).toBe('error')
  expect(h.call).toHaveBeenCalledTimes(1)
  let reject!: (reason: unknown) => void
  h.call.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(screen.getByRole('button', { name: 'Team 数据状态：加载失败' })).toBeInTheDocument()
  await act(async () => { reject(new Error('offline')); await vi.advanceTimersByTimeAsync(0) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Team 数据状态：加载失败' }))
  expect(screen.getByRole('status')).toHaveTextContent('Team 数据加载失败')
  expect(screen.getByRole('button', { name: '收起提示' })).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('button', { name: '收起提示' }), { key: 'Escape' })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  h.call.mockResolvedValueOnce(h.response)
  await act(async () => { await h.store.refresh() })
  expect(screen.queryByRole('button', { name: /Team 数据状态/ })).not.toBeInTheDocument()
  await act(async () => { await h.store.refresh() })
  expect(screen.getByRole('status')).toHaveTextContent('Team 数据加载失败')
})

it('allows loading to be collapsed, reopened and cancelled without restoring stale controls', async () => {
  const h = fixture()
  h.call.mockImplementationOnce(() => new Promise(() => {}))
  render(<SidecarStatus store={h.store} />)
  act(() => { void h.store.refresh() })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Team 数据状态：加载中' }))
  fireEvent.click(screen.getByRole('button', { name: '收起提示' }))
  expect(h.store.getSnapshot().status).toBe('loading')
  fireEvent.click(screen.getByRole('button', { name: 'Team 数据状态：加载中' }))
  fireEvent.click(screen.getByRole('button', { name: '取消加载' }))
  expect(h.store.getSnapshot().status).toBe('cancelled')
  expect(h.store.getSnapshot().summaries.size).toBe(0)
  expect(screen.getByRole('status')).toHaveTextContent('Team 加载已取消')
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新 Team 数据' })) })
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

it('renders sidecar snapshot sequence separately from genuine native history evidence', async () => {
  const h = fixture([{ type: 'yuqi/workspace-change-snapshot', seq: 1, time: 1, ignorable: true, data: {
    version: 1, childSessionId: 'controller', runId: 'run', scope: 'workspace', attribution: 'unavailable', partial: false,
    beforeCapturedAt: '2026-09-06T00:00:00Z', afterCapturedAt: '2026-09-06T00:01:00Z', reasons: [],
    changes: [{ path: 'sidecar-only.txt', kind: 'added', after: { sha256: 'a'.repeat(64), size: 1 } }],
  } }])
  await h.store.refresh()
  const history = vi.fn(async () => ({ events: [], hasMore: false }))
  await act(async () => { render(<FileAuditSidecarContext.Provider value={h.store}>
    <FileAuditHistoryContext.Provider value={history}><TaskFileAudit sessionId="controller" /></FileAuditHistoryContext.Provider>
  </FileAuditSidecarContext.Provider>) })
  expect(screen.getByText(/Sidecar event #1/)).toBeInTheDocument()
  expect(screen.getByText('sidecar-only.txt')).toBeInTheDocument()
  expect(screen.queryByText(/Host event #1/)).not.toBeInTheDocument()
  expect(history).toHaveBeenCalledOnce()
})
