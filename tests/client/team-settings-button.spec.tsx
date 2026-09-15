// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamSettingsButton, type TeamAgentOptions } from '../../src/client/TeamSettingsButton.tsx'
import { requestTeamSettingsOpen } from '../../src/client/team-settings-events.ts'
import { DEFAULT_TEAM_SETTINGS, type TeamSettings } from '../../src/domain/team-settings-contract.ts'

const availableOptions: TeamAgentOptions = {
  presets: [{ id: 'standard', name: 'Standard' }],
  providerGroups: [
    { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
    { id: 'other', name: 'Other', models: [{ id: 'other-model', name: 'Other Model' }] },
  ],
  failures: [],
  routable: true,
  currentRoute: { modelProvider: 'deepseek', modelId: 'deepseek-v4' },
}

function settingsScope({
  value = DEFAULT_TEAM_SETTINGS,
  failAt,
  stale = false,
}: {
  readonly value?: TeamSettings
  readonly failAt?: number
  readonly stale?: boolean
} = {}) {
  let current = value
  let revision = 1
  const listeners = new Set<() => void>()
  const snapshot = () => ({
    status: 'ready' as const,
    value: current,
    base: DEFAULT_TEAM_SETTINGS,
    user: {},
    revision,
    writable: true,
    mode: 'host' as const,
  })
  const set = vi.fn(async (field: keyof TeamSettings, next: TeamSettings[keyof TeamSettings]) => {
    if (set.mock.calls.length === failAt) throw new Error('settings transport failed')
    if (stale) return
    current = { ...current, [field]: next }
    revision++
    for (const listener of listeners) listener()
  })
  return {
    scope: {
      getSnapshot: snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
    },
    set,
  }
}

function renderSettings(
  scope: ReturnType<typeof settingsScope>['scope'],
  loadOptions: () => Promise<TeamAgentOptions> = async () => availableOptions,
) {
  const props = { sessionId: 'session-1', teamSettings: scope, loadOptions } as unknown as ComponentProps<typeof TeamSettingsButton>
  render(<TeamSettingsButton {...props} />)
  act(() => requestTeamSettingsOpen())
}

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

describe('TeamSettingsButton', () => {
  it('identifies the actual current Provider and lists only catalog or preserved choices', async () => {
    const harness = settingsScope()
    renderSettings(harness.scope)
    expect(await screen.findByRole('option', { name: '仅主控供应商 · DeepSeek (deepseek)' })).toBeInTheDocument()
    expect(screen.getByText('当前会话供应商: DeepSeek (deepseek)')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('允许的供应商'), { target: { value: 'controller-plus-allowlist' } })
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /DeepSeek/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Other/ })).not.toBeChecked()
    expect(harness.set).not.toHaveBeenCalled()
  })

  it('keeps unavailable selected Providers visible without enabling new unavailable choices', async () => {
    const harness = settingsScope({ value: { ...DEFAULT_TEAM_SETTINGS, modelRouting: {
      providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['old'] }, teamPolicy: { kind: 'inherit' },
    } } })
    renderSettings(harness.scope, async () => ({ ...availableOptions, failures: [{ id: 'failed', name: '故障供应商', message: 'unavailable' }] }))
    expect(await screen.findByRole('checkbox', { name: /故障供应商/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /old/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /old/ })).toBeEnabled()
    expect(harness.set).not.toHaveBeenCalled()
  })

  it('does not claim a resolved catalog or current Provider with no session models', async () => {
    renderSettings(settingsScope().scope, async () => ({ presets: availableOptions.presets, providerGroups: [], failures: [], routable: false }))
    expect(await screen.findByText(/当前会话供应商尚未取得/)).toBeInTheDocument()
    expect(screen.queryByText('模型目录可解析')).not.toBeInTheDocument()
    expect(screen.getByText(/当前没有可读取的供应商目录/)).toBeInTheDocument()
  })
  it('fails closed when a legacy settings subscription loses its snapshot', async () => {
    const harness = settingsScope()
    let available = true
    let notify = () => {}
    renderSettings({
      ...harness.scope,
      getSnapshot: () => available ? harness.scope.getSnapshot() : undefined,
      subscribe: listener => { notify = listener; return () => { notify = () => {} } },
    } as ReturnType<typeof settingsScope>['scope'])
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    act(() => { available = false; notify() })
    expect(screen.getByRole('alert')).toHaveTextContent('当前连接不支持保存团队设置')
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(harness.set).not.toHaveBeenCalled()
  })

  it('keeps a legacy save open when the persisted snapshot does not confirm the edited value', async () => {
    const harness = settingsScope({ stale: true })
    renderSettings(harness.scope)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    fireEvent.change(screen.getByRole('spinbutton', { name: /并发保护上限/ }), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('设置只保存了一部分')
    expect(screen.getByRole('dialog', { name: '团队设置' })).toBeInTheDocument()
    expect(harness.set).toHaveBeenCalledWith('maxConcurrency', 8)
  })
  it('validates, saves and reloads the custom isolation parent without losing it in direct mode', async () => {
    const harness = settingsScope()
    renderSettings(harness.scope)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox', { name: /^工作方式/ }), { target: { value: 'git-worktree' } })
    const root = screen.getByRole('textbox', { name: /^隔离工作区父目录/ })
    fireEvent.change(root, { target: { value: '../relative' } })
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('绝对目录路径')
    fireEvent.change(root, { target: { value: 'F:\\Team Workspaces' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(harness.set).toHaveBeenCalledWith('gitWorkspaceRoot', 'F:\\Team Workspaces'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    act(() => requestTeamSettingsOpen())
    expect(await screen.findByRole('textbox', { name: /^隔离工作区父目录/ })).toHaveValue('F:\\Team Workspaces')
    fireEvent.change(screen.getByRole('combobox', { name: /^工作方式/ }), { target: { value: 'direct' } })
    expect(screen.queryByRole('textbox', { name: /^隔离工作区父目录/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /^工作方式/ }), { target: { value: 'git-worktree' } })
    expect(screen.getByRole('textbox', { name: /^隔离工作区父目录/ })).toHaveValue('F:\\Team Workspaces')
  })
  it('offers an optional review checklist without overwriting user criteria', async () => {
    renderSettings(settingsScope().scope)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    fireEvent.click(screen.getByRole('radio', { name: '自动审查' }))
    const insert = screen.getByRole('button', { name: '填入通用检查模板（仅空白时）' })
    fireEvent.click(insert)
    expect((screen.getByRole('textbox', { name: /审查重点与关注要点/ }) as HTMLTextAreaElement).value).toContain('不得声称未执行的测试')
    expect(insert).toBeDisabled()
  })
  it('traps focus in the dialog and restores the invoking focus after dismissal', async () => {
    document.documentElement.lang = 'en'
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    renderSettings(settingsScope().scope)

    const close = screen.getByRole('button', { name: 'Close Team settings' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    const save = screen.getByRole('button', { name: 'Save' })
    expect(close).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(save).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(close).toHaveFocus()
    screen.getByRole('spinbutton', { name: /Concurrency safety ceiling/u }).focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Team settings' })).not.toBeInTheDocument()
    expect(before).toHaveFocus()
    before.remove()
  })

  it.each([
    ['before any field changes', 1, 'The save failed before any setting changed'],
    ['after a partial write', 2, 'Only part of the settings were saved'],
  ] as const)('keeps the dialog open when saving fails %s', async (_case, failAt, message) => {
    document.documentElement.lang = 'en'
    const harness = settingsScope({ failAt })
    renderSettings(harness.scope)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('dialog', { name: 'Team settings' })).toBeInTheDocument()
    expect(harness.set).toHaveBeenCalledTimes(failAt)
  })

  it('fails closed for invalid exact routes and invalid reviewer budgets', async () => {
    document.documentElement.lang = 'en'
    const invalidRoute = {
      ...DEFAULT_TEAM_SETTINGS,
      modelRouting: {
        providerScope: { kind: 'controller-only' as const },
        teamPolicy: { kind: 'fixed' as const, model: { modelProvider: 'other', modelId: 'other-model' } },
      },
    }
    renderSettings(settingsScope({ value: invalidRoute }).scope)

    expect(await screen.findByRole('alert')).toHaveTextContent('Choose an exact Provider / Model inside the scope')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByRole('combobox', { name: /^Model routing policy/u }), { target: { value: 'inherit' } })
    expect(screen.queryByText(/Choose an exact Provider \/ Model inside the scope/u)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('spinbutton', { name: /Maximum automatic rework rounds/u }), { target: { value: '4' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Rework rounds must be an integer from 0 to 3')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('announces provider and preset catalog loading in both locales', async () => {
    const pendingOptions = () => new Promise<TeamAgentOptions>(() => undefined)
    document.documentElement.lang = 'en'
    renderSettings(settingsScope().scope, pendingOptions)
    expect(await screen.findByText('Loading installed presets and models…')).toBeInTheDocument()
    cleanup()

    document.documentElement.lang = 'zh-CN'
    renderSettings(settingsScope().scope, pendingOptions)
    expect(await screen.findByText('正在读取已安装模式和模型…')).toBeInTheDocument()
  })

  it('preserves individual Provider failures and fails closed when option loading rejects', async () => {
    document.documentElement.lang = 'en'
    const providerFailure = {
      ...availableOptions,
      failures: [{ id: 'offline', name: 'Offline Provider', message: 'catalog unavailable' }],
    }
    const first = settingsScope()
    renderSettings(first.scope, async () => providerFailure)
    expect(await screen.findByRole('status')).toHaveTextContent('Offline Provider')
    expect(screen.getByRole('status')).toHaveTextContent('Existing configuration was not cleared')

    cleanup()
    const second = settingsScope()
    renderSettings(second.scope, async () => { throw new Error('provider discovery failed') })
    expect(await screen.findByRole('alert')).toHaveTextContent('Installed presets or models could not be loaded')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(second.set).not.toHaveBeenCalled()
  })

  it('switches between Fixed and Automatic without retaining the other policy controls', async () => {
    document.documentElement.lang = 'en'
    renderSettings(settingsScope().scope)
    const policy = screen.getByRole('combobox', { name: /^Model routing policy/u })
    await waitFor(() => expect(policy).toBeEnabled())

    expect(screen.getByRole('group', { name: 'Tiered Model Matching' })).toBeInTheDocument()
    fireEvent.change(policy, { target: { value: 'fixed' } })
    expect(screen.queryByRole('group', { name: 'Tiered Model Matching' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Fixed exact route/u })).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))

    fireEvent.change(policy, { target: { value: 'automatic' } })
    expect(screen.queryByRole('combobox', { name: /^Fixed exact route/u })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /^Quick tasks/u })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: /^Standard tasks/u })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: /^Critical tasks/u })).toHaveValue('')
  })

  it('defaults to Automatic and saves the structured routing policy before legacy mirrors', async () => {
    document.documentElement.lang = 'en'
    const harness = settingsScope()
    renderSettings(harness.scope)
    const policy = await screen.findByRole('combobox', { name: /^Model routing policy/u })
    expect(policy).toHaveValue('automatic')
    expect(screen.getByText(/An exact task route wins/u)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Team settings' })).not.toBeInTheDocument())
    expect(harness.set.mock.calls.slice(0, 3).map(call => call[0])).toEqual(['maxConcurrency', 'childPresetId', 'modelRouting'])
    expect(harness.set).toHaveBeenCalledWith('modelRouting', DEFAULT_TEAM_SETTINGS.modelRouting)
  })

  it('migrates legacy fixed and automatic routes only after the Provider catalog is known', async () => {
    document.documentElement.lang = 'en'
    const { modelRouting: _routing, ...legacyDefaults } = DEFAULT_TEAM_SETTINGS
    const fixed = settingsScope({ value: {
      ...legacyDefaults,
      childModelPolicy: 'fixed',
      childModelId: 'deepseek-v4',
    } })
    renderSettings(fixed.scope)
    expect(await screen.findByRole('combobox', { name: /^Fixed exact route/u })).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))

    cleanup()
    const automatic = settingsScope({ value: {
      ...legacyDefaults,
      childModelPolicy: 'automatic',
      quickModelId: 'deepseek-v4',
      standardModelId: '',
      criticalModelId: 'deepseek-v4',
    } })
    renderSettings(automatic.scope)
    expect(await screen.findByRole('combobox', { name: /^Quick tasks/u })).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))
    expect(screen.getByRole('combobox', { name: /^Standard tasks/u })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: /^Critical tasks/u })).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))
  })

  it('manages allowlisted, unavailable, and unroutable Providers without clearing configured routes', async () => {
    document.documentElement.lang = 'en'
    const value: TeamSettings = {
      ...DEFAULT_TEAM_SETTINGS,
      modelRouting: {
        providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['missing', 'other'] },
        teamPolicy: { kind: 'automatic', tierCandidates: {
          quick: [{ modelProvider: 'missing', modelId: 'legacy-model' }, { modelProvider: 'other', modelId: 'other-model' }],
          standard: [], critical: [],
        } },
      },
    }
    renderSettings(settingsScope({ value }).scope, async () => ({
      ...availableOptions,
      routable: false,
      currentRoute: { modelProvider: 'controller-missing', modelId: 'current' },
      failures: [{ id: 'offline', name: 'Offline', message: 'down' }],
    }))
    expect(await screen.findByText('The current session Provider route is unavailable; existing directory-based settings are preserved.')).toBeInTheDocument()
    expect(screen.getAllByText('missing').length).toBeGreaterThan(0)
    expect(screen.getAllByText('controller-missing').length).toBeGreaterThan(0)
    expect(screen.getByRole('combobox', { name: /^Quick tasks \(2\)/u })).toHaveValue(JSON.stringify(['missing', 'legacy-model']))

    const other = screen.getByRole('checkbox', { name: /Other/u })
    fireEvent.click(other)
    expect(other).not.toBeChecked()
    fireEvent.click(other)
    expect(other).toBeChecked()
    fireEvent.change(screen.getByRole('combobox', { name: /^Quick tasks/u }), { target: { value: '' } })
    expect(screen.getByRole('combobox', { name: /^Quick tasks/u })).toHaveValue('')
  })

  it('ignores late option results after the settings dialog has closed', async () => {
    document.documentElement.lang = 'en'
    let resolveOptions!: (value: TeamAgentOptions) => void
    const options = new Promise<TeamAgentOptions>(resolve => { resolveOptions = resolve })
    renderSettings(settingsScope().scope, () => options)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    resolveOptions(availableOptions)
    await act(async () => { await options })
    expect(screen.queryByRole('dialog', { name: 'Team settings' })).not.toBeInTheDocument()
  })

  it('ignores a late option rejection after the settings dialog has closed', async () => {
    document.documentElement.lang = 'en'
    let rejectOptions!: (reason: Error) => void
    const options = new Promise<TeamAgentOptions>((_resolve, reject) => { rejectOptions = reject })
    renderSettings(settingsScope().scope, () => options)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    rejectOptions(new Error('late provider failure'))
    await act(async () => { await options.catch(() => undefined) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Team settings' })).not.toBeInTheDocument()
  })

  it('handles an empty focusable dialog and a non-HTMLElement invoking focus', async () => {
    document.documentElement.lang = 'en'
    const original = HTMLElement.prototype.querySelectorAll
    vi.spyOn(HTMLElement.prototype, 'querySelectorAll').mockImplementation(function (this: HTMLElement, selectors: string) {
      if (this.dataset.yuqiTeamSettingsDialog === 'true' && selectors.includes('button:not(:disabled)')) {
        return [] as unknown as NodeListOf<Element>
      }
      return original.call(this, selectors)
    })
    vi.stubGlobal('HTMLElement', class NonDomElement {})
    renderSettings(settingsScope().scope)
    vi.unstubAllGlobals()
    expect(() => fireEvent.keyDown(window, { key: 'Tab' })).not.toThrow()
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Team settings' })).toBeInTheDocument())
  })

  it('falls back to ids for unnamed presets and safely rejects every malformed route tuple', async () => {
    document.documentElement.lang = 'en'
    renderSettings(settingsScope().scope, async () => ({
      ...availableOptions,
      presets: [{ id: 'unnamed' }],
    }))
    expect(await screen.findByRole('option', { name: 'unnamed' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: /^Model routing policy/u }), { target: { value: 'fixed' } })
    const route = screen.getByRole('combobox', { name: /^Fixed exact route/u })
    const original = route.getAttribute('value') ?? (route as HTMLSelectElement).value
    for (const malformed of ['{}', '[]', '["provider"]', '[1,"model"]', '["provider",1]', '["provider","model","extra"]']) {
      const option = document.createElement('option')
      option.value = malformed
      option.textContent = malformed
      route.append(option)
      fireEvent.change(route, { target: { value: malformed } })
      expect(route).toHaveValue(original)
      option.remove()
    }
    fireEvent.change(route, { target: { value: JSON.stringify(['deepseek', 'deepseek-v4']) } })
    expect(route).toHaveValue(JSON.stringify(['deepseek', 'deepseek-v4']))
  })

  it('does not save when an invalid form is invoked programmatically', async () => {
    document.documentElement.lang = 'en'
    const harness = settingsScope()
    renderSettings(harness.scope)
    const concurrency = screen.getByRole('spinbutton', { name: /Concurrency safety ceiling/u })
    fireEvent.change(concurrency, { target: { value: '0' } })
    const save = screen.getByRole('button', { name: 'Save' })
    save.removeAttribute('disabled')
    fireEvent.click(save)
    expect(harness.set).not.toHaveBeenCalled()
  })

  it('ignores a stale tier callback after switching away from Automatic', async () => {
    document.documentElement.lang = 'en'
    renderSettings(settingsScope().scope)
    const policy = await screen.findByRole('combobox', { name: /^Model routing policy/u })
    const quick = screen.getByRole('combobox', { name: /^Quick tasks/u })
    fireEvent.change(policy, { target: { value: 'inherit' } })
    const option = document.createElement('option')
    option.value = JSON.stringify(['deepseek', 'deepseek-v4'])
    quick.append(option)
    fireEvent.change(quick, { target: { value: option.value } })
    expect(policy).toHaveValue('inherit')
  })

  it('creates an unresolved fixed route when the Provider directory has no current route', async () => {
    document.documentElement.lang = 'en'
    renderSettings(settingsScope().scope, async () => ({ ...availableOptions, currentRoute: undefined }))
    const policy = await screen.findByRole('combobox', { name: /^Model routing policy/u })
    fireEvent.change(policy, { target: { value: 'fixed' } })
    expect(screen.getByRole('combobox', { name: /^Fixed exact route/u })).toHaveValue(JSON.stringify(['', '']))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('preserves a configured unavailable fixed route and safely ignores malformed select values', async () => {
    document.documentElement.lang = 'en'
    const configured: TeamSettings = {
      ...DEFAULT_TEAM_SETTINGS,
      modelRouting: {
        providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['legacy'] },
        teamPolicy: { kind: 'fixed', model: { modelProvider: 'legacy', modelId: 'old-model' } },
      },
    }
    renderSettings(settingsScope({ value: configured }).scope)
    const route = await screen.findByRole('combobox', { name: /^Fixed exact route/u })
    expect(route).toHaveValue(JSON.stringify(['legacy', 'old-model']))
    expect(screen.getByRole('option', { name: /old-model.*historical configuration preserved; directory unavailable for verification/u })).toBeInTheDocument()
    fireEvent.change(route, { target: { value: '{bad json' } })
    fireEvent.change(route, { target: { value: JSON.stringify(['', 'model']) } })
    expect(screen.getByRole('combobox', { name: /^Fixed exact route/u })).toHaveValue(JSON.stringify(['legacy', 'old-model']))
  })
})
