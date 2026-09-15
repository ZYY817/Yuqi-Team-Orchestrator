// @vitest-environment jsdom

import { createElement, type ComponentProps } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { findTeamRootSessionId, TeamReturnButton } from '../../src/client/TeamReturnButton.tsx'

const id = (value: string) => value as SessionId

describe('Team child return routing', () => {
  afterEach(() => cleanup())
  it('routes both a worker and its hidden controller to the visible Team root', () => {
    const byId = {
      root: { id: id('root'), agentPreset: 'yuqi-team' },
      controller: { id: id('controller'), parentId: id('root') },
      worker: { id: id('worker'), parentId: id('controller') },
    }
    expect(findTeamRootSessionId(id('worker'), byId)).toBe('root')
    expect(findTeamRootSessionId(id('controller'), byId)).toBe('root')
  })

  it('routes an archived-controller worker from the parent durable Team projection', () => {
    const byId = {
      root: {
        id: id('root'),
        agentPreset: 'yuqi-team',
        projectionValues: { yuqiTeam: { tasks: [{ childSessionId: 'worker' }] } },
      },
      worker: { id: id('worker'), parentId: id('archived-controller') },
    }
    expect(findTeamRootSessionId(id('worker'), byId)).toBe('root')
  })

  it('does not hijack ordinary subagents, roots, broken ancestry, or cycles', () => {
    expect(findTeamRootSessionId(id('child'), {
      root: { id: id('root'), agentPreset: 'standard' }, child: { id: id('child'), parentId: id('root') },
    })).toBeUndefined()
    expect(findTeamRootSessionId(id('root'), {
      root: { id: id('root'), agentPreset: 'yuqi-team' },
    })).toBeUndefined()
    expect(findTeamRootSessionId(id('orphan'), {
      orphan: { id: id('orphan'), parentId: id('missing') },
    })).toBeUndefined()
    expect(findTeamRootSessionId(id('a'), {
      a: { id: id('a'), parentId: id('b') }, b: { id: id('b'), parentId: id('a') },
    })).toBeUndefined()
  })

  it('renders the return action only for a routed Team child', () => {
    const openSession = vi.fn()
    const routed = { root: { id: id('root'), agentPreset: 'yuqi-team' }, worker: { id: id('worker'), parentId: id('root') } }
    const { rerender } = render(createElement(TeamReturnButton, {
      sessionId: id('worker'),
      useSessions: (select: (state: unknown) => unknown) => select({ byId: routed }),
      openSession,
    } as unknown as ComponentProps<typeof TeamReturnButton>))
    fireEvent.click(screen.getByRole('button', { name: '返回 Team 主对话' }))
    expect(openSession).toHaveBeenCalledWith('root')
    rerender(createElement(TeamReturnButton, {
      sessionId: id('ordinary'),
      useSessions: (select: (state: unknown) => unknown) => select({ byId: {} }),
      openSession,
    } as unknown as ComponentProps<typeof TeamReturnButton>))
    expect(screen.queryByRole('button', { name: '返回 Team 主对话' })).not.toBeInTheDocument()
  })

  it('renders the English return action from the Host locale', () => {
    document.documentElement.lang = 'en'
    const openSession = vi.fn()
    const routed = { root: { id: id('root'), agentPreset: 'yuqi-team' }, worker: { id: id('worker'), parentId: id('root') } }
    render(createElement(TeamReturnButton, {
      sessionId: id('worker'),
      useSessions: (select: (state: unknown) => unknown) => select({ byId: routed }),
      openSession,
    } as unknown as ComponentProps<typeof TeamReturnButton>))

    fireEvent.click(screen.getByRole('button', { name: 'Back to Team controller' }))
    expect(openSession).toHaveBeenCalledWith('root')
  })
})
