import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import type { TeamAuthorityMode } from '../domain/team-settings-contract.ts'
import type { YuqiLocale } from './client-locale.ts'

export interface YuqiCommandTarget {
  readonly teamId?: string
  readonly controllerSessionId: string
}

/** True follows command completion; durable projection still owns Team/task state.
 * A transport rejection returns false; a known Host error or unknown result may throw.
 */
export type YuqiCommand = (line: string, target?: YuqiCommandTarget) => Promise<boolean>

export type TeamCommandAction = 'pause' | 'resume' | 'cancel' | 'reconcile'

/**
 * Each UI command gets a fresh id so a rejected or retried click cannot be
 * mistaken for the previous request by the host's idempotency layer.
 */
export function createRequestId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()

  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    cryptoApi.getRandomValues(bytes)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  }

  return `yuqi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function teamCommandLine(action: TeamCommandAction, teamId: string, controllerSessionId: string, requestId: string, options?: { immediate?: boolean }): string {
  const flags = options?.immediate ? ' --immediate' : ''
  return `/yuqi ${action} ${teamId} ${controllerSessionId} ${requestId}${flags}`
}

export function retryCommandLine(taskId: string, requestId: string): string {
  return `/yuqi retry ${taskId} ${requestId}`
}

export function stopCommandLine(taskId: string, requestId: string): string {
  return `/yuqi stop ${taskId} ${requestId}`
}

/** Encode free-form UTF-8 text as one slash-command-safe token. */
export function messageCommandLine(taskId: string, message: string, requestId: string): string {
  return `/yuqi message ${taskId} ${encodeCommandPayload(message)} ${requestId}`
}

export function manualReturnCommandLine(taskId: string, teamId: string, controllerSessionId: string, acquisitionId: string, summary: string, requestId: string): string {
  return `/yuqi manual-return ${taskId} ${encodeCommandPayload(JSON.stringify({ acquisitionId, summary: summary.trim() }))} ${teamId} ${controllerSessionId} ${requestId}`
}

/** Scope always carries the rendered identity; never infer a different active Team. */
export function scopeCommandLine(taskId: string, fileScope: readonly string[], teamId: string, controllerSessionId: string, requestId: string): string {
  return `/yuqi scope ${taskId} ${encodeCommandPayload(JSON.stringify(fileScope))} ${teamId} ${controllerSessionId} ${requestId}`
}

function encodeCommandPayload(message: string): string {
  const bytes = new TextEncoder().encode(message)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return payload
}

export function modelCommandLine(taskId: string, modelId: string, requestId: string): string {
  return `/yuqi model ${taskId} ${modelId} ${requestId}`
}

export function authorityCommandLine(taskId: string, authorityMode: TeamAuthorityMode, requestId: string): string {
  return `/yuqi authority ${taskId} ${authorityMode} ${requestId}`
}

export function recoverPausedCommandLine(teamId: string, controllerSessionId: string, requestId: string): string {
  return `/yuqi recover paused ${teamId} ${controllerSessionId} ${requestId}`
}

export function reviewCommandLine(teamId: string, controllerSessionId: string, requestId: string, focusNotes?: string): string {
  const focus = focusNotes?.trim()
  return focus === undefined || focus === ''
    ? `/yuqi review user-request ${teamId} ${controllerSessionId} ${requestId}`
    : `/yuqi review user-request focus:${encodeCommandPayload(focus)} ${teamId} ${controllerSessionId} ${requestId}`
}

export type ResolveDecision = 'failed' | 'cancelled'

export function resolveCommandLine(taskId: string, attemptId: string, decision: ResolveDecision, requestId: string): string {
  return `/yuqi resolve ${taskId} ${attemptId} ${decision} ${requestId}`
}

/** Preserve every interrupted attempt, retry its task, and resume scheduling. */
export function recoverAndContinueCommandLine(requestId: string): string {
  return `/yuqi recover-continue ${requestId}`
}

export function primaryTeamAction(status: TeamConsoleSummary['team']['status']): TeamCommandAction | undefined {
  if (status === 'running' || status === 'pausing') return 'pause'
  if (status === 'paused') return 'resume'
  if (status === 'needs_reconciliation') return 'reconcile'
  return undefined
}

export function teamActionLabel(action: TeamCommandAction, locale: YuqiLocale = 'zh'): string {
  if (action === 'pause') return locale === 'en' ? 'Pause' : '暂停'
  if (action === 'resume') return locale === 'en' ? 'Continue' : '继续'
  if (action === 'reconcile') return locale === 'en' ? 'Recheck' : '重新检查'
  return locale === 'en' ? 'Cancel' : '取消'
}
