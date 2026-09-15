// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamConsoleSummary } from '../../src/domain/team-console-contract.ts'
import type { TeamProjection } from '../../src/domain/projection.ts'
import type { TeamEvent } from '../../src/domain/events.ts'
import type { TeamEventJournal, Clock, EventIdSource } from '../../src/application/ports.ts'
import { TeamCenter } from '../../src/client/TeamCenter.tsx'
import { isTeamPanelOpenRequest, OPEN_TEAM_PANEL_EVENT, requestTeamPanelOpen } from '../../src/client/team-panel-events.ts'
import { decideQualityGate } from '../../src/application/quality-gate.ts'
import { resolveModelRoute } from '../../src/application/model-routing.ts'
import { TeamBootstrapCoordinator } from '../../src/application/bootstrap-team.ts'
import { BeginVerificationCoordinator } from '../../src/application/begin-verification.ts'
import { AutomaticTaskRetryCoordinator } from '../../src/application/verification-retry.ts'
import { DurableJournalCoordinator } from '../../src/application/durable-journal.ts'
import { TaskRetryCoordinator } from '../../src/application/retry-task.ts'
import { completeTeamEvents, contract, event } from '../fixtures.ts'

const UI_STORAGE_KEY = 'yuqi-team-orchestrator.ui.v1'
const LOCALE_STORAGE_KEY = 'yuqi-team-orchestrator.locale.v1'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  vi.doUnmock('react')
})

describe('final client branch gaps', () => {
  it('uses the SSR fallbacks when browser globals do not exist', async () => {
    vi.resetModules()
    vi.doMock('react', async importOriginal => {
      const actual = await importOriginal<typeof import('react')>()
      return {
        ...actual,
        useSyncExternalStore: (
          subscribe: (listener: () => void) => () => void,
          getSnapshot: () => unknown,
          getServerSnapshot: () => unknown,
        ) => {
          subscribe(() => undefined)()
          getSnapshot()
          return getServerSnapshot()
        },
      }
    })
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('document', undefined)

    const locale = await import('../../src/client/client-locale.ts')
    expect(locale.useYuqiLocale()).toBe('zh')
    expect(() => locale.setYuqiLocale('en')).not.toThrow()

    const preferences = await import('../../src/client/team-ui-preferences.ts')
    expect(preferences.useTeamUiPreference('ssr-team')).toEqual({
      dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: [],
    })
    preferences.setTeamDockHidden('ssr-team', true)
    expect(preferences.useAllTeamUiPreferences()['ssr-team']?.dockHidden).toBe(true)
  })

  it('dispatches a typed panel request and rejects an ordinary Event', () => {
    const listener = vi.fn()
    window.addEventListener(OPEN_TEAM_PANEL_EVENT, listener)
    requestTeamPanelOpen('team-panel')
    expect(listener).toHaveBeenCalledOnce()
    expect(isTeamPanelOpenRequest(listener.mock.calls[0]![0], 'team-panel')).toBe(true)
    expect(isTeamPanelOpenRequest(new Event(OPEN_TEAM_PANEL_EVENT), 'team-panel')).toBe(false)
    window.removeEventListener(OPEN_TEAM_PANEL_EVENT, listener)
  })

  it('filters invalid snapshots, closes a focus loop in both directions, and accepts an available settings host', () => {
    const snapshot = {
      ids: ['missing' as SessionId, 'null-summary' as SessionId, 'main' as SessionId],
      byId: {
        ['null-summary' as SessionId]: { id: 'null-summary' as SessionId, displayTitle: 'empty', projectionValues: { yuqiTeam: null } },
        ['main' as SessionId]: { id: 'main' as SessionId, displayTitle: 'main', projectionValues: { yuqiTeam: centerSummary } },
      },
    }
    render(<TeamCenter sessions={{ getSnapshot: () => snapshot, subscribe: () => () => undefined }}
      openMain={() => true} openChild={async () => true} />)

    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    const dialog = screen.getByRole('dialog', { name: 'Team 管理中心' })
    expect(within(dialog).getAllByRole('article')).toHaveLength(1)
    expect(within(dialog).getByText('Coverage Team')).toBeVisible()
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(element => {
      if (element.closest('[hidden]')) return false
      for (let parent = element.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
        if (parent instanceof HTMLDetailsElement && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false
      }
      return true
    })
    const first = focusable[0]!
    const last = focusable.at(-1)!
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(first).toHaveFocus()

    const settingsHost = document.createElement('div')
    settingsHost.dataset.yuqiTeamSettingsDialog = 'true'
    document.body.append(settingsHost)
    vi.useFakeTimers()
    fireEvent.click(within(screen.getByRole('navigation', { name: '管理页面' })).getByRole('button', { name: '团队默认设置' }))
    fireEvent.click(within(dialog.querySelector('#yuqi-center-settings')!).getByRole('button', { name: '团队默认设置' }))
    act(() => vi.runAllTimers())
    expect(screen.queryByRole('dialog', { name: 'Team 管理中心' })).not.toBeInTheDocument()
    settingsHost.remove()
  })

  it('handles a temporarily empty focusable list without attempting to wrap focus', () => {
    const original = HTMLElement.prototype.querySelectorAll
    vi.spyOn(HTMLElement.prototype, 'querySelectorAll').mockImplementation(function (this: HTMLElement, selectors: string) {
      if (this.getAttribute('role') === 'dialog' && selectors.includes('button:not(:disabled)')) {
        return [] as unknown as NodeListOf<Element>
      }
      return original.call(this, selectors)
    })
    const empty = { ids: [], byId: {} }
    render(<TeamCenter sessions={{ getSnapshot: () => empty, subscribe: () => () => undefined }}
      openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    expect(() => fireEvent.keyDown(window, { key: 'Tab' })).not.toThrow()
  })

  it('reopens the center with feedback when the settings host is unavailable', () => {
    vi.useFakeTimers()
    const empty = { ids: [], byId: {} }
    render(<TeamCenter sessions={{ getSnapshot: () => empty, subscribe: () => () => undefined }}
      openMain={() => true} openChild={async () => true} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Team 管理中心' }))
    fireEvent.click(screen.getByRole('button', { name: '团队默认设置' }))
    const dialog = screen.getByRole('dialog', { name: 'Team 管理中心' })
    fireEvent.click(within(dialog.querySelector('#yuqi-center-settings')!).getByRole('button', { name: '团队默认设置' }))
    act(() => vi.runAllTimers())
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeVisible()
    fireEvent.click(within(screen.getByRole('navigation', { name: '管理页面' })).getByRole('button', { name: '团队任务' }))
    expect(screen.getByRole('alert')).toHaveTextContent('团队设置暂时无法打开')
  })

  it('opens safely when the previously active element is not an HTMLElement', () => {
    const empty = { ids: [], byId: {} }
    render(<TeamCenter sessions={{ getSnapshot: () => empty, subscribe: () => () => undefined }}
      openMain={() => true} openChild={async () => true} />)
    const trigger = screen.getByRole('button', { name: '打开 Team 管理中心' })
    vi.stubGlobal('HTMLElement', class NonDomElement {})
    fireEvent.click(trigger)
    vi.unstubAllGlobals()
    expect(screen.getByRole('dialog', { name: 'Team 管理中心' })).toBeInTheDocument()
  })
})

describe('final small application-module branch gaps', () => {
  it('covers every remaining bootstrap fact-comparison guard', async () => {
    const draft = new Journal([event(801, { type: 'yuqi/team-created', title: 'Title', objective: 'Objective' })])
    await expect(bootstrapper().bootstrap({ teamId: 'team-1', title: 'Title', objective: 'Objective', tasks: [] }, draft))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })

    const legacy = new Journal([event(802, { type: 'yuqi/team-created', title: 'Title', objective: 'Objective' }), event(803, {
      type: 'yuqi/team-status-changed', from: 'draft', to: 'running', reason: 'legacy bootstrap',
    })])
    await expect(bootstrapper().bootstrap({
      teamId: 'team-1', title: 'Title', objective: 'Objective', reviewPolicy: { mode: 'off' }, tasks: [],
    }, legacy)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })

    const setup = await initializedBootstrap()
    await expect(setup.coordinator.bootstrap({ ...setup.request, directWriteStrategy: 'strict-writer-serial' }, setup.journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(setup.coordinator.bootstrap({ ...setup.request, reviewPolicy: { mode: 'off' } }, setup.journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
    await expect(setup.coordinator.bootstrap({
      ...setup.request,
      modelRouting: {
        providerScope: { kind: 'controller-only' },
        teamPolicy: { kind: 'inherit' },
      },
    }, setup.journal)).rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
  })

  it('takes the uncovered quality-gate fallbacks and rework outcomes', () => {
    expect(decideQualityGate(qualityProjection({ stale: true, reworkStatus: 'ready' })).kind).toBe('await-user')
    expect(decideQualityGate(qualityProjection({ decision: 'authorize_final_rework', reworkStatus: 'ready' })).kind).toBe('verify')
    expect(decideQualityGate(qualityProjection({})).kind).toBe('await-user')
    expect(decideQualityGate(qualityProjection({ result: 'changes_required', reworkStatus: 'ready' })).kind).toBe('verify')
  })

  it('preserves a requested tier while inheriting the controller model', () => {
    const result = resolveModelRoute({
      controllerModel: { modelProvider: 'deepseek', modelId: 'controller' },
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'inherit' },
      taskRequest: { kind: 'tier', tier: 'critical' },
      catalog: [],
    })
    expect(result).toMatchObject({ reason: 'team-inherit-controller', requestedTier: 'critical' })
  })

  it('defends begin-verification against a changing request identity and missing settled evidence', async () => {
    let reads = 0
    const changing = {
      get teamId() { return reads++ === 0 ? 'team-1' : 'foreign-team' },
      taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-new', verifierSessionId: 'verifier',
    }
    await expect(beginner().begin(changing, new Journal(completeTeamEvents().slice(0, 11))))
      .rejects.toMatchObject({ code: 'TEAM_MISMATCH' })

    const noEvidence = [...completeTeamEvents().slice(0, 9), completeTeamEvents()[10]!]
    await expect(beginner().begin({
      teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-new', verifierSessionId: 'verifier',
    }, new Journal(noEvidence))).rejects.toMatchObject({ code: 'VERIFICATION_NOT_ALLOWED' })
  })

  it('rejects reuse of an automatic retry operation for a different task', async () => {
    const journal = new Journal(failedRetrySeed())
    const coordinator = automaticRetry()
    await coordinator.retry(retryRequest(), journal)
    await expect(coordinator.retry({ ...retryRequest(), taskId: 'other-task' }, journal))
      .rejects.toMatchObject({ code: 'CONTROL_OPERATION_CONFLICT' })
  })
})

const centerSummary: TeamConsoleSummary = {
  controllerSessionId: 'controller-1',
  team: {
    id: 'team-center', title: 'Coverage Team', objective: 'Cover branches', status: 'paused',
    completedTaskCount: 0, runningTaskCount: 0, waitingTaskCount: 1, attentionTaskCount: 0,
    userDecisionCount: 0, controllerActionCount: 0, duration: { state: 'known', elapsedMs: 0 },
  },
  tasks: [], attention: [],
  usage: { state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' },
}

class FixedClock implements Clock {
  nowIso(): string { return '2026-08-31T00:00:00Z' }
}

class Ids implements EventIdSource {
  #next = 900
  next(): string { return `final-coverage-${this.#next++}` }
}

class Journal implements TeamEventJournal {
  readonly key = `final-coverage-${Math.random()}`
  readonly events: unknown[]
  constructor(seed: readonly unknown[] = []) { this.events = [...seed] }
  read(): readonly unknown[] { return this.events }
  async commit(events: readonly TeamEvent[]): Promise<void> { this.events.push(...events) }
}

function bootstrapper() {
  return new TeamBootstrapCoordinator(new FixedClock(), new Ids(), new DurableJournalCoordinator())
}

async function initializedBootstrap() {
  const journal = new Journal()
  const coordinator = bootstrapper()
  const request = { teamId: 'team-1', title: 'Title', objective: 'Objective', tasks: [contract()] }
  await coordinator.bootstrap(request, journal)
  return { coordinator, journal, request }
}

function qualityProjection(options: {
  readonly stale?: boolean
  readonly decision?: 'authorize_final_rework'
  readonly result?: 'changes_required'
  readonly reworkStatus?: 'ready' | 'completed'
}): TeamProjection {
  const reviewId = 'review-final'
  const candidateEventId = 'candidate-current'
  const review = {
    id: reviewId,
    trigger: 'quality-gate',
    candidateEventId: options.stale ? 'candidate-stale' : candidateEventId,
    round: 0,
    checkpointSubject: 'team-completion',
    checkpointAnchor: { eventId: options.stale ? 'candidate-stale' : candidateEventId },
    phase: 'reworking',
    independentReviewerRequired: false,
    findingFingerprints: [],
    status: 'completed',
    ...(options.decision === undefined ? {} : { userDecision: { decision: options.decision } }),
    ...(options.result === undefined && !options.stale ? {} : {
      result: { decision: options.result ?? 'changes_required', findings: [] },
    }),
  }
  const hasRework = options.reworkStatus !== undefined
  let statusReads = 0
  const reworkTask = hasRework ? {
    get status() { return statusReads++ === 0 ? 'completed' : options.reworkStatus },
    contract: { taskId: 'rework-task', kind: 'review-rework', reviewRework: { sourceReviewId: reviewId } },
  } : undefined
  return {
    team: { status: 'running', reviewPolicy: { mode: 'quality-gate', maxReworkRounds: 2, additionalPrompt: '' } },
    completionCandidateEventId: candidateEventId,
    reviewIds: [reviewId], reviews: { [reviewId]: review },
    taskIds: hasRework ? ['rework-task'] : [],
    tasks: hasRework ? { ['rework-task']: reworkTask } : {},
    taskRetryOperations: {},
  } as unknown as TeamProjection
}

function beginner() {
  return new BeginVerificationCoordinator(new FixedClock(), new Ids(), new DurableJournalCoordinator())
}

function failedRetrySeed(): readonly TeamEvent[] {
  return [
    ...completeTeamEvents().slice(0, 13),
    event(850, {
      type: 'yuqi/verification-verdict-recorded', operationId: 'verdict-final', taskId: 'task-1',
      attemptId: 'attempt-1', verificationId: 'verification-1', disposition: 'failed',
      requirements: [{ checkId: 'build', kind: 'build' }],
      evidence: [{
        checkId: 'build', capturedAt: '2026-08-31T00:00:00Z', kind: 'build', producer: 'build-runner',
        command: 'pnpm test', exitCode: 1, artifactDigest: 'sha256-final',
      }],
      reasons: [{ checkId: 'build', code: 'build-failed', detail: 'Build exited with code 1' }],
      rework: { action: 'retry', currentAttempt: 1, maxAttempts: 2, nextAttempt: 2, instructions: ['retry'] },
    } as never),
  ]
}

function retryRequest() {
  return {
    teamId: 'team-1', taskId: 'task-1', attemptId: 'attempt-1', verificationId: 'verification-1', verdictOperationId: 'verdict-final',
  }
}

function automaticRetry() {
  const transactions = new DurableJournalCoordinator()
  return new AutomaticTaskRetryCoordinator(new TaskRetryCoordinator(new FixedClock(), new Ids(), transactions))
}
