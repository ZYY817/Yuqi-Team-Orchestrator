import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { useYuqiLocale } from './client-locale.ts'
import { sessionPreset } from './session-preset.ts'

interface PresetSessionRow {
  readonly id: SessionId
  readonly blank: boolean
  readonly agentPreset?: string
  readonly projectionValues?: object
}

interface PresetSessionSnapshot {
  readonly current?: SessionId
  readonly byId: Readonly<Record<SessionId, PresetSessionRow>>
}

export interface TeamPresetGuardInjected {
  readonly presetId: string
  readonly presetName: string
  readonly sessions: {
    getSnapshot(): PresetSessionSnapshot
    subscribe(listener: () => void): () => void
  }
}

/** Plugin-owned admission guard for the official asynchronous preset picker. */
export function TeamPresetGuard({ presetId, presetName, sessions }: TeamPresetGuardInjected) {
  const en = useYuqiLocale() === 'en'
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const current = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]
  const currentPreset = sessionPreset(current)
  const [waiting, setWaiting] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const deferredSend = useRef<{ sessionId: SessionId; target: HTMLElement; send(): void }>()

  useEffect(() => {
    if (current === undefined || !current.blank) return
    const discardSend = () => {
      deferredSend.current = undefined
      setBlocked(false)
    }
    const pending = () => {
      const live = sessions.getSnapshot()
      const row = live.current === undefined ? undefined : live.byId[live.current]
      return row?.blank === true && sessionPreset(row) !== presetId && hasSelectedPresetChip(presetName)
    }
    const stop = (event: Event) => {
      if (event.type === 'click') {
        const selected = presetMenuChoice(event.target)
        if (selected !== undefined) {
          discardSend()
          queueMicrotask(() => {
            setWaiting(matchesPresetName(selected, presetName))
            setBlocked(false)
          })
          return
        }
      }
      if (!pending()) return
      if (event.type === 'keydown') {
        const keyboard = event as KeyboardEvent
        if (keyboard.key !== 'Enter' || keyboard.shiftKey || keyboard.isComposing || !isComposerTextTarget(keyboard.target)) return
      } else if (event.type === 'click') {
        if (!isComposerSubmitTarget(event.target)) return
      } else if (!isComposerFormTarget(event.target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const target = event.target as HTMLElement
      deferredSend.current = {
        sessionId: current.id,
        target,
        send: () => {
          if (event.type === 'click') target.closest('button')?.click()
          else if (event.type === 'submit') (target as HTMLFormElement).requestSubmit()
          else target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
          }))
        },
      }
      setBlocked(true)
    }
    const onInput = (event: Event) => {
      if (isComposerTextTarget(event.target)) discardSend()
    }
    document.addEventListener('submit', stop, true)
    document.addEventListener('keydown', stop, true)
    document.addEventListener('click', stop, true)
    document.addEventListener('input', onInput, true)
    return () => {
      deferredSend.current = undefined
      document.removeEventListener('submit', stop, true)
      document.removeEventListener('keydown', stop, true)
      document.removeEventListener('click', stop, true)
      document.removeEventListener('input', onInput, true)
    }
  }, [current?.id, current?.blank, presetId, presetName, sessions])

  useEffect(() => {
    if (!current || currentPreset !== presetId) return
    const queued = deferredSend.current
    // Consume before replay: a click may synchronously submit and change Session.
    deferredSend.current = undefined
    setWaiting(false)
    setBlocked(false)
    if (queued?.sessionId === current.id && current.blank && queued.target.isConnected && hasSelectedPresetChip(presetName)) {
      queued.send()
    }
  }, [current?.id, current?.blank, currentPreset, presetId, presetName])

  useEffect(() => {
    if (!waiting && !blocked) return
    const timer = setTimeout(() => {
      // Safety release: avoid deadlocking composer if preset switch timed out or failed on backend
      const queued = deferredSend.current
      deferredSend.current = undefined
      setWaiting(false)
      setBlocked(false)
      if (queued && queued.sessionId === current?.id && current?.blank && queued.target.isConnected) {
        queued.send()
      }
    }, 6000)
    return () => clearTimeout(timer)
  }, [waiting, blocked, current?.id, current?.blank])

  const forceSend = () => {
    const queued = deferredSend.current
    deferredSend.current = undefined
    setWaiting(false)
    setBlocked(false)
    if (queued && queued.sessionId === current?.id && current?.blank && queued.target.isConnected) {
      queued.send()
    } else {
      const form = document.querySelector('form:has(textarea)') as HTMLFormElement | null
      form?.requestSubmit()
    }
  }

  if (current === undefined || !current.blank || (!waiting && !blocked)) return null
  return (
    <div className="yuqi-team-preset-guard" aria-live="polite">
      <small role="status">
        {blocked
          ? (en ? 'Preparing Team mode. Your message will send once ready.' : 'Team 模式准备中，就绪后会自动发送本条消息。')
          : (en ? 'Preparing Team mode. You can send after tools finish loading.' : 'Team 模式准备中，确认工具加载后即可发送。')}
        {' '}
        <button
          type="button"
          onClick={forceSend}
          className="yuqi-guard-force-send"
          style={{
            background: 'none',
            border: 'none',
            color: 'inherit',
            textDecoration: 'underline',
            cursor: 'pointer',
            padding: '0 4px',
            font: 'inherit',
            fontWeight: 600,
          }}
        >
          {en ? 'Send now' : '立即发送'}
        </button>
      </small>
    </div>
  )
}

function matchesPresetName(text: string | undefined | null, presetName: string): boolean {
  if (!text) return false
  const trimmed = text.trim().toLowerCase()
  const target = presetName.trim().toLowerCase()
  return (
    trimmed === target ||
    trimmed.startsWith(target) ||
    trimmed === 'yuqi团队' ||
    trimmed === 'yuqi team' ||
    trimmed === 'yuqi-team' ||
    trimmed.startsWith('yuqi')
  )
}

function presetMenuChoice(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const button = target.closest('button')
  if (button === null) return undefined
  if (button.closest('[role="menu"]') === null && button.getAttribute('role') !== 'menuitem') return undefined
  return button.textContent?.trim()
}

function hasSelectedPresetChip(presetName: string): boolean {
  return [...document.querySelectorAll('button')].some(button => {
    if (button.closest('[role="menu"]') !== null || button.getAttribute('role') === 'menuitem') return false
    return matchesPresetName(button.textContent, presetName)
  })
}

function isComposerTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
}

function isComposerSubmitTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const button = target.closest('button')
  if (button === null) return false
  if (button.type === 'submit' && button.closest('form')?.querySelector('textarea,[contenteditable="true"]') !== null) return true
  const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`
  return /发送消息|send message/iu.test(label)
}

function isComposerFormTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLFormElement
    && target.querySelector('textarea,[contenteditable="true"]') !== null
}
