import { useSyncExternalStore } from 'react'
import type { YuqiLocale } from './i18n.ts'
export type { YuqiLocale } from './i18n.ts'

const STORAGE_KEY = 'yuqi-team-orchestrator.locale.v1'
const CHANGE_EVENT = 'yuqi-team-orchestrator:locale'
let memoryLocale: YuqiLocale | undefined

function storedLocale(): YuqiLocale | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'zh' || value === 'en' ? value : undefined
  } catch {
    return undefined
  }
}

function localeFromLanguage(value: string | null | undefined): YuqiLocale | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh'
  return undefined
}

function hostLocale(surface?: Element | null): YuqiLocale | undefined {
  const fromSurface = localeFromLanguage(surface?.getAttribute('lang'))
  if (fromSurface !== undefined) return fromSurface
  if (typeof document !== 'undefined') {
    const fromDocument = localeFromLanguage(document.documentElement.lang)
    if (fromDocument !== undefined) return fromDocument
  }
  if (typeof navigator !== 'undefined') {
    for (const language of navigator.languages ?? []) {
      const locale = localeFromLanguage(language)
      if (locale !== undefined) return locale
    }
    return localeFromLanguage(navigator.language)
  }
  return undefined
}

export function getYuqiLocale(surface?: Element | null): YuqiLocale {
  const stored = storedLocale() ?? memoryLocale
  if (stored !== undefined) return stored
  return hostLocale(surface) ?? 'zh'
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const observer = typeof document !== 'undefined' && typeof MutationObserver !== 'undefined'
    ? new MutationObserver(listener)
    : undefined
  if (typeof document !== 'undefined') {
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  }
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    observer?.disconnect()
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useYuqiLocale(): YuqiLocale {
  return useSyncExternalStore(subscribe, getYuqiLocale, () => 'zh')
}

export function setYuqiLocale(locale: YuqiLocale): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
    memoryLocale = undefined
  } catch {
    memoryLocale = locale
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}
