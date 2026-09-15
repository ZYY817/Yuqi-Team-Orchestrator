import type { TeamSettings } from './team-settings-contract.ts'

export const TEAM_SETTINGS_SCOPE_CHANNEL = '/yuqi-team-settings'
export type TeamSettingsLevel = 'global' | 'project' | 'session'
export interface TeamSettingsScopeView {
  readonly level: TeamSettingsLevel
  readonly sessionId?: string
  readonly projectId?: string
  readonly projectTitle?: string
  readonly value: TeamSettings
  readonly inherited: TeamSettings
  readonly overrides: Partial<TeamSettings>
  readonly sources: Readonly<Record<keyof TeamSettings, TeamSettingsLevel>>
  readonly revision: number
  readonly globalRevision: number
  /** Host-derived identity fence; a moved session must be re-read before writing. */
  readonly binding: string
  readonly writable: boolean
}
export interface TeamSettingsScopeRequest {
  readonly level: TeamSettingsLevel
  readonly sessionId?: string
}
export interface TeamSettingsScopeWrite extends TeamSettingsScopeRequest {
  readonly overrides: Partial<TeamSettings>
  readonly revision: number
  readonly globalRevision: number
  readonly binding: string
}
