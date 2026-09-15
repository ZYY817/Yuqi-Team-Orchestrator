import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'yuqi-team-orchestrator.ui.v1'
const CHANGE_EVENT = 'yuqi-team-orchestrator:ui-preferences'
const MAX_TEAM_ENTRIES = 100

export interface TeamUiPreference {
  readonly dockHidden: boolean
  readonly dockDismissed: boolean
  readonly teamArchived: boolean
  /** Explicit card restoration overrides automatic hiding by archived children. */
  readonly dockRestored?: boolean
  readonly archivedChildIds: readonly string[]
  /** When set, timeline entries at or before this timestamp are hidden from display. */
  readonly clearedTimelineTimestamp?: number
}

interface StoredTeamUiPreference extends TeamUiPreference {
  readonly updatedAt: number
}

type StoredPreferences = Readonly<Record<string, StoredTeamUiPreference>>

const emptyPreference: TeamUiPreference = Object.freeze({ dockHidden: false, dockDismissed: false, teamArchived: false, archivedChildIds: Object.freeze([]) })
let memoryPreferences: StoredPreferences = Object.freeze({})
let cachedRaw: string | null | undefined
let cachedPreferences: StoredPreferences = memoryPreferences

function readPreferences(): StoredPreferences {
  if (typeof window === 'undefined') return memoryPreferences
  let raw: string | null
  try { raw = window.localStorage.getItem(STORAGE_KEY) } catch { return memoryPreferences }
  if (raw === cachedRaw) return cachedPreferences
  cachedRaw = raw
  if (raw === null) {
    // A usable browser store with no value means the user has no saved UI
    // preferences. The in-memory copy is only a fallback when storage itself
    // is unavailable; reusing it here would resurrect cleared/old Team state.
    cachedPreferences = Object.freeze({})
    return cachedPreferences
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid preferences')
    const valid: Record<string, StoredTeamUiPreference> = {}
    for (const [teamId, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const candidate = value as Partial<StoredTeamUiPreference>
      if (typeof candidate.dockHidden !== 'boolean'
        || (candidate.dockDismissed !== undefined && typeof candidate.dockDismissed !== 'boolean')
        || (candidate.teamArchived !== undefined && typeof candidate.teamArchived !== 'boolean')
        || typeof candidate.updatedAt !== 'number'
        || !Array.isArray(candidate.archivedChildIds)) continue
      valid[teamId] = Object.freeze({
        dockHidden: candidate.dockHidden,
        dockDismissed: candidate.dockDismissed ?? false,
        teamArchived: candidate.teamArchived ?? false,
        ...(typeof candidate.dockRestored === 'boolean' ? { dockRestored: candidate.dockRestored } : {}),
        ...(typeof candidate.clearedTimelineTimestamp === 'number' ? { clearedTimelineTimestamp: candidate.clearedTimelineTimestamp } : {}),
        archivedChildIds: Object.freeze(candidate.archivedChildIds.filter((id): id is string => typeof id === 'string')),
        updatedAt: candidate.updatedAt,
      })
    }
    cachedPreferences = Object.freeze(valid)
  } catch {
    cachedPreferences = memoryPreferences
  }
  return cachedPreferences
}

function writePreferences(next: StoredPreferences): void {
  memoryPreferences = next
  cachedPreferences = next
  try {
    if (typeof window !== 'undefined') {
      const raw = JSON.stringify(next)
      window.localStorage.setItem(STORAGE_KEY, raw)
      cachedRaw = raw
    }
  } catch {
    cachedRaw = undefined
  }
  // Same-tab subscribers must update even when localStorage is blocked (for
  // example by privacy policy). Cross-tab propagation still uses `storage`.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT))
}

function updateTeam(teamId: string, update: (current: TeamUiPreference) => TeamUiPreference): void {
  const all = readPreferences()
  const nextValue = update(all[teamId] ?? emptyPreference)
  const entries = Object.entries({
    ...all,
    [teamId]: Object.freeze({ ...nextValue, archivedChildIds: Object.freeze([...new Set(nextValue.archivedChildIds)]), updatedAt: Date.now() }),
  }).sort((left, right) => right[1].updatedAt - left[1].updatedAt).slice(0, MAX_TEAM_ENTRIES)
  writePreferences(Object.freeze(Object.fromEntries(entries)))
}

export function setTeamDockHidden(teamId: string, hidden: boolean): void {
  updateTeam(teamId, current => ({ ...current, dockHidden: hidden, ...(hidden ? { dockDismissed: false } : {}) }))
}

export function setTeamDockDismissed(teamId: string, dismissed: boolean): void {
  updateTeam(teamId, current => ({ ...current, dockDismissed: dismissed, ...(dismissed ? { dockHidden: false } : {}) }))
}

export function setTeamArchived(teamId: string, archived: boolean): void {
  updateTeam(teamId, current => ({
    ...current,
    teamArchived: archived,
    dockHidden: false,
    dockDismissed: false,
    dockRestored: !archived,
  }))
}

export function restoreTeamDock(teamId: string): void {
  updateTeam(teamId, current => ({ ...current, dockHidden: false, dockDismissed: false, dockRestored: true }))
}

export function setChildSessionArchived(teamId: string, childSessionId: string, archived: boolean): void {
  updateTeam(teamId, current => ({
    ...current,
    ...(archived && !current.archivedChildIds.includes(childSessionId) ? { dockRestored: false } : {}),
    archivedChildIds: archived
      ? [...current.archivedChildIds, childSessionId]
      : current.archivedChildIds.filter(id => id !== childSessionId),
  }))
}

export function setTeamTimelineCleared(teamId: string, timestamp: number | undefined): void {
  updateTeam(teamId, current => {
    const next = { ...current }
    if (timestamp !== undefined) {
      return { ...next, clearedTimelineTimestamp: timestamp }
    }
    delete (next as { clearedTimelineTimestamp?: number }).clearedTimelineTimestamp
    return next
  })
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onChange = () => { cachedRaw = undefined; listener() }
  window.addEventListener(CHANGE_EVENT, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function useTeamUiPreference(teamId: string | undefined): TeamUiPreference {
  return useSyncExternalStore(
    subscribe,
    () => teamId === undefined ? emptyPreference : readPreferences()[teamId] ?? emptyPreference,
    () => emptyPreference,
  )
}

export function useAllTeamUiPreferences(): StoredPreferences {
  return useSyncExternalStore(subscribe, readPreferences, () => memoryPreferences)
}
