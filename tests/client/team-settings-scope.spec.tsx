// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamSettingsButton } from '../../src/client/TeamSettingsButton.tsx'
import { bindTeamSettingsScope, type TeamSettingsScopeContext } from '../../src/client/team-settings-scope.ts'
import { DEFAULT_TEAM_SETTINGS } from '../../src/domain/team-settings-contract.ts'
import type { TeamSettingsScopeView } from '../../src/domain/team-settings-scope.ts'

afterEach(cleanup)
function fixture() {
  let current: string | undefined = 'a'
  let byId: Record<string, { displayTitle: string }> = { a: { displayTitle: '项目发布检查' }, b: { displayTitle: 'Second conversation' } }
  const listeners = new Set<() => void>()
  const views = new Map<string, TeamSettingsScopeView>()
  const call = vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
    const request = payload as { level: TeamSettingsScopeView['level']; sessionId?: string; overrides?: object }
    const key = `${request.level}:${request.sessionId ?? ''}`
    const previous = views.get(key)
    const overrides = endpoint === 'write' ? request.overrides! : previous?.overrides ?? {}
    const view: TeamSettingsScopeView = { level: request.level, ...(request.sessionId ? { sessionId: request.sessionId, projectId: 'p', projectTitle: 'Project' } : {}),
      value: { ...DEFAULT_TEAM_SETTINGS, ...overrides }, inherited: DEFAULT_TEAM_SETTINGS, overrides,
      sources: Object.fromEntries(Object.keys(DEFAULT_TEAM_SETTINGS).map(field => [field, Object.hasOwn(overrides, field) ? request.level : 'global'])) as TeamSettingsScopeView['sources'],
      revision: (previous?.revision ?? 0) + (endpoint === 'write' ? 1 : 0), globalRevision: 0, binding: key, writable: true }
    views.set(key, view)
    return { ok: true as const, value: view }
  })
  const context: TeamSettingsScopeContext = { rpc: { call }, sessions: {
    getSnapshot: () => ({ current, byId }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } }
  return { context, call, views, rename: (id: string, displayTitle: string) => { byId = { ...byId, [id]: { displayTitle } }; for (const listener of listeners) listener() }, switchSession: (id: string) => { current = id; for (const listener of listeners) listener() } }
}
const loadOptions = async () => ({ presets: [{ id: 'standard', name: 'Standard' }], providerGroups: [], failures: [], routable: false })
function show(host: ReturnType<typeof fixture>, optionsLoader = loadOptions) {
  const fallback = { getSnapshot: () => ({ status: 'ready' as const, value: DEFAULT_TEAM_SETTINGS, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }), subscribe: () => () => {}, set: async () => {}, unset: async () => {} }
  return render(<TeamSettingsButton sessionId={'' as never} teamSettings={fallback} scopeContext={host.context} loadOptions={optionsLoader} embedded />)
}

describe('Scoped Team settings UI', () => {
  it('shows live conversation titles and keeps renaming separate from settings identity', async () => {
    document.documentElement.lang = 'zh'
    const host = fixture()
    show(host)
    await screen.findByLabelText('并发保护上限')
    fireEvent.change(screen.getByLabelText('设置范围'), { target: { value: 'session' } })
    const conversationLabel = (title: string) => (_: string, el: Element | null) => el?.tagName === 'SPAN' && el.textContent === `会话：${title}`
    expect(await screen.findByText(conversationLabel('项目发布检查'))).toBeInTheDocument()
    act(() => host.rename('a', '新标题 Original title'))
    expect(screen.getByText(conversationLabel('新标题 Original title'))).toBeInTheDocument()
    expect(screen.getByText('a', { selector: 'code' })).toBeInTheDocument()
    expect(host.call.mock.calls.filter(call => call[1] === 'write')).toHaveLength(0)
    act(() => host.switchSession('b'))
    expect(await screen.findByText(conversationLabel('Second conversation'))).toBeInTheDocument()
    act(() => host.rename('b', 'b'))
    expect(screen.getByText(conversationLabel('未命名会话'))).toBeInTheDocument()
  })
  it('localizes exact builtin metadata in English without renaming authored presets', async () => {
    document.documentElement.lang = 'en'
    show(fixture(), async () => ({ ...(await loadOptions()), presets: [
      { id: 'standard', name: '标准模式' }, { id: 'minimal', name: '极简模式' },
      { id: 'code', name: 'PTC 模式' }, { id: 'cordis', name: '创造模式' },
      { id: 'my-standard', name: '我的标准模式' },
    ] }))
    expect(await screen.findByRole('option', { name: 'Standard mode' })).toBeInTheDocument()
    for (const name of ['Minimal mode', 'PTC mode', 'Creator mode', '我的标准模式']) expect(screen.getByRole('option', { name })).toBeInTheDocument()
  })

  it('preserves a customized name even when the id matches a builtin', async () => {
    document.documentElement.lang = 'en'
    show(fixture(), async () => ({ ...(await loadOptions()), presets: [{ id: 'standard', name: '团队专属模式' }] }))
    expect(await screen.findByRole('option', { name: '团队专属模式' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Standard mode' })).not.toBeInTheDocument()
  })
  it('explains old-Host read errors without retaining a loading indicator', async () => {
    const host = fixture()
    host.call.mockRejectedValueOnce(new Error('transport 405'))
    show(host)
    expect(await screen.findByRole('alert')).toHaveTextContent('设置读取或恢复失败，请重试')
    expect(screen.queryByText(/正在读取设置/)).not.toBeInTheDocument()
    expect(screen.getByText('Error: transport 405')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByLabelText('并发保护上限')).toBeInTheDocument()
  })
  it('renders real form, atomically saves only changed settings, shows source and restores inheritance', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const host = fixture()
    show(host)
    await screen.findByLabelText('并发保护上限')
    fireEvent.change(screen.getByLabelText('设置范围'), { target: { value: 'project' } })
    await waitFor(() => expect(screen.getByText(/项目: Project/)).toBeInTheDocument())
    const input = screen.getByLabelText('并发保护上限')
    fireEvent.change(input, { target: { value: '7' } })
    await waitFor(() => expect(screen.getByLabelText('设置范围')).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(host.views.get('project:a')?.value.maxConcurrency).toBe(7))
    const writes = host.call.mock.calls.filter(call => call[1] === 'write')
    expect(writes).toHaveLength(1)
    expect((writes[0]![2] as { overrides: object }).overrides).toEqual({ maxConcurrency: 7 })
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复上一级继承' })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('并发保护上限'), { target: { value: '9' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复上一级继承' })).toBeDisabled())
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复上一级继承' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '恢复上一级继承' }))
    await waitFor(() => expect(host.views.get('project:a')?.overrides).toEqual({}))
    confirm.mockRestore()
  })

  it('discards old-session drafts on navigation and never sends them to the new session', async () => {
    const host = fixture()
    show(host)
    await screen.findByLabelText('并发保护上限')
    fireEvent.change(screen.getByLabelText('设置范围'), { target: { value: 'session' } })
    await waitFor(() => expect(host.views.has('session:a')).toBe(true))
    await screen.findByLabelText('并发保护上限')
    expect(screen.getByText('a', { selector: 'code' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('并发保护上限'), { target: { value: '2' } })
    act(() => host.switchSession('b'))
    await waitFor(() => expect(screen.getByLabelText('并发保护上限')).toHaveValue(100))
    expect(screen.getByText('b', { selector: 'code' })).toBeInTheDocument()
    expect(screen.queryByText('a', { selector: 'code' })).not.toBeInTheDocument()
    expect(host.call.mock.calls.filter(call => call[1] === 'write')).toHaveLength(0)
  })

  it('keeps an in-flight save bound to its original identity', async () => {
    const host = fixture()
    const initial = await host.call('', 'read', { level: 'session', sessionId: 'a' })
    const bound = bindTeamSettingsScope(host.context, initial.value)
    host.switchSession('b')
    await bound.save({ ...initial.value.value, maxConcurrency: 5 })
    expect(host.views.get('session:a')?.value.maxConcurrency).toBe(5)
    expect(host.views.has('session:b')).toBe(false)
  })

  it('switches settings level directly via the segmented buttons', async () => {
    document.documentElement.lang = 'zh'
    const host = fixture()
    show(host)
    await screen.findByLabelText('并发保护上限')
    const globalBtn = screen.getByRole('button', { name: '全局默认' })
    const projectBtn = screen.getByRole('button', { name: '当前项目' })
    const sessionBtn = screen.getByRole('button', { name: '当前会话' })
    expect(globalBtn).toHaveAttribute('aria-pressed', 'true')
    expect(projectBtn).toHaveAttribute('aria-pressed', 'false')
    expect(sessionBtn).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(projectBtn)
    await waitFor(() => expect(projectBtn).toHaveAttribute('aria-pressed', 'true'))
    expect(globalBtn).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(/项目: Project/)).toBeInTheDocument()

    fireEvent.click(sessionBtn)
    await waitFor(() => expect(sessionBtn).toHaveAttribute('aria-pressed', 'true'))
    expect(projectBtn).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '会话：项目发布检查')).toBeInTheDocument()
  })
})

