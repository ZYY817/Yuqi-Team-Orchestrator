// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { TeamSettingsButton, type TeamAgentOptions } from '../../src/client/TeamSettingsButton.tsx'
import { TeamPanel } from '../../src/client/TeamPanel.tsx'
import { requestTeamSettingsOpen } from '../../src/client/team-settings-events.ts'
import { DEFAULT_TEAM_SETTINGS } from '../../src/domain/team-settings-contract.ts'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import { yuqiTeamStyles } from '../../src/client/styles.ts'

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); document.documentElement.lang = ''; vi.restoreAllMocks() })

function team(id: string, status: TeamConsoleSummary['team']['status'] = 'running'): TeamConsoleSummary {
  return { team: { id, title: `Team ${id}`, objective: 'Layout regression', status,
    completedTaskCount: status === 'completed' ? 1 : 0, runningTaskCount: 0, waitingTaskCount: 1,
    attentionTaskCount: 0, userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'unavailable' } },
    tasks: [{ taskId: `${id}-task`, goal: `Goal ${id}`, status: 'pending', modelRole: 'worker', model: 'model', authorityMode: 'read-only',
      dependencyCount: 0, fileScope: ['a.txt', 'b.txt'], attemptCount: 0, evidenceRecorded: false,
      usage: { state: 'pending', label: 'Token：暂无数据' }, duration: { state: 'unavailable' }, nextAction: '等待调度。' }],
    attention: [], usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' } }
}

const catalog: TeamAgentOptions = { presets: [{ id: 'standard', name: 'Standard' }], providerGroups: [], failures: [], routable: false }

function mountCenter(teams: TeamConsoleSummary[] = []) {
  localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
  let value = DEFAULT_TEAM_SETTINGS
  const listeners = new Set<() => void>()
  const scope = { getSnapshot: () => ({ status: 'ready', value, writable: true }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: vi.fn(async (field: keyof typeof value, next: unknown) => { value = { ...value, [field]: next }; listeners.forEach(fn => fn()) }) }
  const loadOptions = vi.fn(async () => catalog)
  const snapshot = { ids: teams.map(item => item.team.id as SessionId), byId: Object.fromEntries(teams.map(item => [item.team.id, {
    id: item.team.id as SessionId, displayTitle: item.team.title, projectionValues: { yuqiTeam: item },
  }])) }
  const sessions = { getSnapshot: () => snapshot, subscribe: () => () => undefined }
  const settingsProps = { sessionId: 'main', teamSettings: scope, loadOptions } as unknown as ComponentProps<typeof TeamSettingsButton>
  const openMain = vi.fn()
  render(<TeamCenter sessions={sessions} openMain={openMain} openChild={async () => false}
    renderSettings={onDraftStateChange => <TeamSettingsButton {...settingsProps} embedded onDraftStateChange={onDraftStateChange} />} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open Team management' }))
  return { scope, loadOptions, openMain }
}

describe('Management layout integration', () => {
  it('changes the single model-policy select without saving early', async () => {
    const { scope } = mountCenter()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    const policy = screen.getByRole('combobox', { name: /Model routing policy/ })
    fireEvent.change(policy, { target: { value: 'inherit' } })
    expect(policy).toHaveValue('inherit')
    fireEvent.change(policy, { target: { value: 'fixed' } })
    expect(policy).toHaveValue('fixed')
    fireEvent.change(policy, { target: { value: 'automatic' } })
    expect(policy).toHaveValue('automatic')
    expect(scope.set).not.toHaveBeenCalled()
  })

  it('keeps the management close layer anchored without requiring pixel assertions', () => {
    expect(yuqiTeamStyles).toMatch(/\.yuqi-settings-layer\{position:fixed;inset:0;/u)
    expect(yuqiTeamStyles).toMatch(/\.yuqi-management \.yuqi-close-button\{[^}]*width:28px[^}]*height:28px/u)
  })
  it('opens defaults first and retains unsaved form state across tabs and locale changes', async () => {
    const { loadOptions, scope } = mountCenter([team('one')])
    const concurrency = await screen.findByRole('spinbutton', { name: /Concurrency safety ceiling/ })
    await waitFor(() => expect(loadOptions).toHaveBeenCalledOnce())
    fireEvent.change(concurrency, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Search Teams' })).toBeInTheDocument()
    act(() => requestTeamSettingsOpen())
    expect(screen.getByRole('spinbutton', { name: /Concurrency safety ceiling/ })).toHaveValue(7)
    fireEvent.click(screen.getByRole('button', { name: '中文' }))
    expect(screen.getByRole('spinbutton', { name: '并发保护上限' })).toHaveValue(7)
    expect(scope.set).not.toHaveBeenCalled()
    expect(loadOptions).toHaveBeenCalledOnce()
  })

  it('does not discard a draft when closing is declined; save uses the existing settings scope', async () => {
    const { scope } = mountCenter()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled())
    fireEvent.change(screen.getByRole('spinbutton', { name: /Concurrency safety ceiling/ }), { target: { value: '6' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('Saved. Applies to new Teams.')).toBeInTheDocument())
    expect(scope.set).toHaveBeenCalledWith('maxConcurrency', 6)
    expect(screen.getByRole('spinbutton', { name: /Concurrency safety ceiling/ })).toHaveValue(6)
  })

  it('paginates many Teams, searches all matching records and keeps finished Teams out of Active', () => {
    mountCenter([...Array.from({ length: 25 }, (_, i) => team(String(i))), team('done', 'completed')])
    fireEvent.click(screen.getByRole('button', { name: 'Teams' }))
    expect(screen.getAllByRole('article')).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'Show 20 more' }))
    expect(screen.getAllByRole('article')).toHaveLength(25)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Team 24' } })
    expect(screen.getAllByRole('article')).toHaveLength(1)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /History/ }))
    expect(screen.getByRole('button', { name: /History/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('article')).toHaveTextContent('Team done')
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const selectRecords = screen.getByRole('button', { name: 'Select records' })
    expect(selectRecords.closest('.yuqi-management-toolbar')).not.toBeNull()
    fireEvent.click(selectRecords)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Team done' }))
    expect(screen.getByRole('button', { name: 'Archive selected records' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Archive selected records' }))
    fireEvent.click(screen.getByRole('button', { name: /Archived/ }))
    expect(screen.getByRole('button', { name: /Archived/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('article')).toHaveTextContent('Team done')
    expect(screen.getByRole('button', { name: 'Restore Team' })).toBeInTheDocument()
    // Verify multi-select is also available in Archived tab to batch restore
    const selectArchived = screen.getByRole('button', { name: 'Select records' })
    expect(selectArchived).toBeInTheDocument()
    fireEvent.click(selectArchived)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Team done' }))
    const restoreBtn = screen.getByRole('button', { name: 'Restore selected records' })
    expect(restoreBtn).toBeEnabled()
    fireEvent.click(restoreBtn)
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('shows task plans without a child session and navigates activity back to their existing controls', () => {
    localStorage.setItem('yuqi-team-orchestrator.locale.v1', 'en')
    const summary = team('plan')
    render(<TeamPanel summary={summary} onClose={() => undefined} onOpenChild={async () => true} nowMs={0} />)
    expect(screen.getByRole('button', { name: /Goal plan.*plan-task/i })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Progress & evidence' }))
    fireEvent.click(screen.getByRole('button', { name: /^(Task route|Dependencies)$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Locate task plan-task: Goal plan' }))
    expect(screen.getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('searchbox')).toHaveValue('')
  })
})
