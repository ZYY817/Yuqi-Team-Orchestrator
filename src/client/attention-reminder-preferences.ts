import { useSyncExternalStore } from 'react'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'

const STORAGE_KEY = 'yuqi-team-orchestrator:dismissed-reminders:v1'
const CHANGE_EVENT = 'yuqi-team-orchestrator:dismissed-reminders'
const MAX_KEYS = 100

const emptyKeys: ReadonlySet<string> = Object.freeze(new Set<string>())
let memoryKeys: ReadonlySet<string> = emptyKeys
let cachedRaw: string | null | undefined
let cachedKeys: ReadonlySet<string> = emptyKeys
let storageWriteFailed = false

function readDismissedReminderKeys(): ReadonlySet<string> {
  if (typeof window === 'undefined') return memoryKeys
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      try { raw = window.localStorage.getItem(STORAGE_KEY) } catch {}
    }
  } catch {
    // Only trust memory after this document itself failed to persist a write.
    // A first-read failure must not resurrect a reminder dismissed in an
    // earlier test/document lifetime.
    return storageWriteFailed ? memoryKeys : emptyKeys
  }
  if (storageWriteFailed && raw === null) return memoryKeys
  if (raw === cachedRaw) return cachedKeys
  cachedRaw = raw
  if (raw === null) {
    memoryKeys = emptyKeys
    cachedKeys = emptyKeys
    return cachedKeys
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    cachedKeys = Object.freeze(new Set(Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string').slice(-MAX_KEYS)
      : []))
  } catch {
    cachedKeys = emptyKeys
  }
  memoryKeys = cachedKeys
  return cachedKeys
}

function writeDismissedReminderKeys(keys: ReadonlySet<string>): void {
  const next = Object.freeze(new Set([...keys].slice(-MAX_KEYS)))
  memoryKeys = next
  cachedKeys = next
  storageWriteFailed = false
  try {
    const raw = JSON.stringify([...next])
    window.sessionStorage.setItem(STORAGE_KEY, raw)
    try { window.localStorage.setItem(STORAGE_KEY, raw) } catch {}
    cachedRaw = raw
  } catch {
    cachedRaw = undefined
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onChange = () => {
    if (!storageWriteFailed) cachedRaw = undefined
    listener()
  }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function dismissAttentionReminder(key: string): void {
  writeDismissedReminderKeys(new Set(readDismissedReminderKeys()).add(key))
}

export function decisionReminderKey(teamId: string, decisionKey: string): string {
  return `decision:${teamId}:${decisionKey}`
}

/** A new attempt or a changed question must not inherit an older acknowledgement. */
export function attentionDecisionKey(summary: TeamConsoleSummary, item: TeamConsoleSummary['attention'][number]): string {
  const attemptId = summary.tasks.find(task => task.taskId === item.taskId)?.attemptId
  return `${item.taskId}:${item.code}:${attemptId === undefined ? '' : `${attemptId}:`}${item.message}`
}

export function dismissDecisionReminder(teamId: string, decisionKey: string): void {
  writeDismissedReminderKeys(new Set(readDismissedReminderKeys()).add(decisionReminderKey(teamId, decisionKey)))
}

export function undismissDecisionReminder(teamId: string, decisionKey: string): void {
  const next = new Set(readDismissedReminderKeys())
  next.delete(decisionReminderKey(teamId, decisionKey))
  next.delete(`team-read:${teamId}`)
  writeDismissedReminderKeys(next)
}

export function markTeamDecisionsAsRead(summary: TeamConsoleSummary): void {
  const current = new Set(readDismissedReminderKeys())
  for (const item of summary.attention) {
    if (item.owner === 'user') {
      // The message is the only public version-bearing fact for durable
      // attention.  Do not collapse a later same-task/same-code decision.
      current.add(decisionReminderKey(summary.team.id, attentionDecisionKey(summary, item)))
    }
  }
  if (summary.team.planConfirmationPending) {
    current.add(decisionReminderKey(summary.team.id, 'plan-confirmation'))
  }
  writeDismissedReminderKeys(current)
}

export function isDecisionDismissed(
  dismissedKeys: ReadonlySet<string>,
  teamId: string,
  decisionKey: string,
  teamReminder?: string,
): boolean {
  if (dismissedKeys.has(decisionReminderKey(teamId, decisionKey))) return true
  // Older clients wrote `team-read:<teamId>`.  That key was too broad: a
  // future decision for the same Team could be hidden forever.  Intentionally
  // ignore it so existing users see newly-derived (and previously hidden)
  // decisions; only a stable decision key can acknowledge a reminder now.
  if (teamReminder !== undefined && dismissedKeys.has(teamReminder)) return true
  return false
}

export function useDismissedReminderKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readDismissedReminderKeys, () => emptyKeys)
}

export function teamReminderKey(summary: TeamConsoleSummary): string {
  const decisions = summary.attention
    .filter(item => item.owner === 'user')
    .map(item => `${item.taskId}:${item.code}:${item.message}`)
    .sort()
    .join('|')
  return `team:${summary.team.id}:${decisions}`
}
