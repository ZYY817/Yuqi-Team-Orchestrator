// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { TeamSummaryBar } from '../../src/client/TeamSummaryBar.tsx'
import { summarizeTeamForConsole } from '../../src/application/team-console-summary.ts'
import { replayTeamEvents } from '../../src/domain/projection.ts'
import { completeTeamEvents } from '../fixtures.ts'

afterEach(() => {
  cleanup()
  document.documentElement.lang = ''
})

describe('TeamSummaryBar', () => {
  it('presents expanded English controller and user-decision metrics', () => {
    document.documentElement.lang = 'en'
    const base = summarizeTeamForConsole(replayTeamEvents(completeTeamEvents().slice(0, 8)))
    const summary = {
      ...base,
      team: { ...base.team, userDecisionCount: 2, controllerActionCount: 1 },
    }
    render(createElement(TeamSummaryBar, {
      summary,
      expanded: true,
      onOpen: () => undefined,
      onHide: () => undefined,
      hideLabel: 'Hide',
      hideTitle: 'Hide',
      hideText: 'Hide',
      toggleText: 'Close',
      nowMs: 0,
    }))

    const button = screen.getByRole('button', { name: 'Close Yuqi Team task panel' })
    expect(button).toHaveTextContent('2 need confirmation')
    expect(button).toHaveTextContent('1 awaiting controller')
  })
})
