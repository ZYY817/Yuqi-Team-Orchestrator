// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getYuqiLocale, setYuqiLocale, useYuqiLocale } from '../../src/client/client-locale.ts'

function LocaleProbe() {
  const locale = useYuqiLocale()
  return <output aria-label="active locale">{locale}</output>
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  setYuqiLocale('zh')
  localStorage.clear()
})

describe('client locale preference', () => {
  it('falls back to the Host language and persists an explicit user choice', () => {
    document.documentElement.lang = 'en-US'
    render(<LocaleProbe />)
    expect(screen.getByLabelText('active locale')).toHaveTextContent('en')

    act(() => setYuqiLocale('zh'))
    expect(screen.getByLabelText('active locale')).toHaveTextContent('zh')
    expect(localStorage.getItem('yuqi-team-orchestrator.locale.v1')).toBe('zh')
  })

  it('keeps the selected locale in memory when Host storage is unavailable', () => {
    document.documentElement.lang = 'zh-CN'
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    render(<LocaleProbe />)

    act(() => setYuqiLocale('en'))
    expect(screen.getByLabelText('active locale')).toHaveTextContent('en')
  })

  it('falls back through an explicit surface, document language, navigator languages, then Chinese', () => {
    const surface = document.createElement('section')
    surface.lang = 'en-GB'
    expect(getYuqiLocale(surface)).toBe('en')

    surface.removeAttribute('lang')
    document.documentElement.lang = 'zh-Hans'
    expect(getYuqiLocale(surface)).toBe('zh')

    document.documentElement.lang = ''
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR', 'en-US'])
    expect(getYuqiLocale()).toBe('en')

    vi.restoreAllMocks()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
    expect(getYuqiLocale()).toBe('zh')

    vi.restoreAllMocks()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(undefined as unknown as readonly string[])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    expect(getYuqiLocale()).toBe('en')
  })
})
