// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { TeamSettingsButton, type TeamAgentOptions } from '../../src/client/TeamSettingsButton.tsx'
import { centerAlignmentStyles } from '../../src/client/center-alignment-styles.ts'
import { settingsAlignmentStyles } from '../../src/client/settings-alignment-styles.ts'
import { DEFAULT_TEAM_SETTINGS } from '../../src/domain/team-settings-contract.ts'
import type { TeamSettingsScopeContext } from '../../src/client/team-settings-scope.ts'

afterEach(cleanup)

const sessionSnapshot = { current: undefined as string | undefined }
const sessionListSnapshot = { ids: [], byId: {} }
const sessions = { getSnapshot: () => sessionListSnapshot, subscribe: () => () => undefined }
const catalog: TeamAgentOptions = { presets: [{ id: 'standard', name: 'Standard' }], providerGroups: [], failures: [], routable: false }

function scopedSettings() {
  const view = {
    level: 'global' as const,
    value: DEFAULT_TEAM_SETTINGS,
    inherited: DEFAULT_TEAM_SETTINGS,
    overrides: {},
    sources: Object.fromEntries(Object.keys(DEFAULT_TEAM_SETTINGS).map(field => [field, 'global'])) as Record<keyof typeof DEFAULT_TEAM_SETTINGS, 'global'>,
    revision: 0,
    globalRevision: 0,
    binding: 'global',
    writable: true,
  }
  const context = { sessions: { getSnapshot: () => sessionSnapshot, subscribe: () => () => undefined }, rpc: {
    call: vi.fn(async () => ({ ok: true as const, value: view })),
  } } as unknown as TeamSettingsScopeContext
  const fallback = { getSnapshot: () => ({ status: 'ready' as const, value: DEFAULT_TEAM_SETTINGS, base: {}, user: {}, revision: 0, writable: true, mode: 'host' as const }), subscribe: () => () => undefined, set: async () => {}, unset: async () => {} }
  return { context, fallback }
}

function openRealScopedSettings() {
  const { context, fallback } = scopedSettings()
  const settingsProps = { sessionId: '' as never, teamSettings: fallback, loadOptions: async () => catalog, scopeContext: context, embedded: true } as ComponentProps<typeof TeamSettingsButton>
  render(<TeamCenter sessions={sessions} openMain={() => true} openChild={async () => false}
    renderSettings={onDraftStateChange => <TeamSettingsButton {...settingsProps} onDraftStateChange={onDraftStateChange} />} />)
  fireEvent.click(screen.getByRole('button', { name: /打开 Team 管理中心|Open Team management/ }))
}

describe('management settings layout contract', () => {
  it('keeps the real scoped DOM inside a scroll shell with a reachable form footer', async () => {
    openRealScopedSettings()
    await waitFor(() => expect(screen.getByLabelText('设置范围')).toBeInTheDocument())
    const scope = document.querySelector('.yuqi-management-settings-content > .yuqi-settings-scope')
    expect(scope).toBeInTheDocument()
    expect(scope?.querySelector(':scope > fieldset > .yuqi-settings-embedded > .yuqi-settings-body')).toBeInTheDocument()
    expect(scope?.querySelector(':scope > fieldset > .yuqi-settings-embedded > .yuqi-settings-footer')).toBeInTheDocument()
    const scopeActions = scope?.querySelector(':scope > .yuqi-settings-scope-card .yuqi-scope-actions-wrap')
    expect(scopeActions).toBeInTheDocument()
    expect([...scopeActions!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['清除已保存默认', '重新读取'])
    expect(scope?.querySelector(':scope > button')).not.toBeInTheDocument()
    expect(scope?.querySelector(':scope > .yuqi-settings-sources')).not.toBeInTheDocument()
  })

  it('scrolls the settings body while keeping the form footer pinned by flex layout', () => {
    expect(centerAlignmentStyles).toMatch(/\.yuqi-management-settings-content\{[^}]*min-height:0[^}]*overflow:hidden/u)
    expect(centerAlignmentStyles).toMatch(/\.yuqi-management-settings-content>\.yuqi-settings-scope>fieldset>\.yuqi-settings-embedded>\.yuqi-settings-body\{[^}]*min-height:0[^}]*overflow-y:auto/u)
    expect(centerAlignmentStyles).toMatch(/\.yuqi-management-settings-content>\.yuqi-settings-scope>fieldset>\.yuqi-settings-embedded>\.yuqi-settings-footer\{[^}]*position:relative[^}]*flex:none/u)
    expect(centerAlignmentStyles).toMatch(/\.yuqi-management-settings-content>\.yuqi-settings-scope>fieldset\{[^}]*margin:0/u)
    expect(settingsAlignmentStyles).toMatch(/\.yuqi-settings-aligned\.yuqi-defaults-grid\{grid-template-columns:minmax\(0,1fr\)/u)
  })

  it('centers the loading state horizontally and vertically with flex column layout', () => {
    expect(centerAlignmentStyles).toMatch(/\.yuqi-settings-state-loading\{[^}]*display:flex[^}]*flex-direction:column[^}]*align-items:center[^}]*justify-content:center[^}]*text-align:center/u)
    expect(centerAlignmentStyles).toMatch(/\.yuqi-settings-state-loading\s*\.yuqi-settings-state-icon\{margin:0 auto\}/u)
    expect(centerAlignmentStyles).toMatch(/#yuqi-center-teams,#yuqi-center-attention\{[^}]*display:flex[^}]*flex-direction:column[^}]*flex:1 1 auto[^}]*min-height:100%[^}]*\}/u)
  })
})
