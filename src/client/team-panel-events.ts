export const OPEN_TEAM_PANEL_EVENT = 'yuqi-team-orchestrator:open-team-panel'
export const OPEN_TEAM_ATTENTION_EVENT = 'yuqi-team-orchestrator:open-team-attention'
let pendingPanel: { teamId: string; at: number } | undefined

export function requestTeamPanelOpen(teamId: string): void {
  pendingPanel = { teamId, at: Date.now() }
  window.dispatchEvent(new CustomEvent(OPEN_TEAM_PANEL_EVENT, { detail: { teamId } }))
}

/** Opens the management list which owns live native interaction callbacks. */
export function requestTeamAttentionOpen(teamId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_TEAM_ATTENTION_EVENT, { detail: { teamId } }))
}

export function isTeamAttentionOpenRequest(event: Event, teamId: string): boolean {
  return isTeamPanelOpenRequest(event, teamId)
}

/** Retain one UI navigation request while the selected conversation mounts. */
export function consumeTeamPanelOpen(teamId: string): boolean {
  if (pendingPanel === undefined) return false
  if (Date.now() - pendingPanel.at > 10000) { pendingPanel = undefined; return false }
  if (pendingPanel.teamId !== teamId) return false
  pendingPanel = undefined
  return true
}

export function isTeamPanelOpenRequest(event: Event, teamId: string): boolean {
  if (!(event instanceof CustomEvent)) return false
  const detail = event.detail as { readonly teamId?: unknown } | undefined
  return detail?.teamId === teamId
}
