const OPEN_EVENT = 'yuqi-team-orchestrator:open-team-settings'

export type TeamManagementPage = 'settings' | 'teams' | 'attention'

export function requestTeamSettingsOpen(page: TeamManagementPage = 'settings'): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { page } }))
}

export function subscribeTeamSettingsOpen(listener: (page: TeamManagementPage) => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onOpen = (event: Event) => {
    const page = event instanceof CustomEvent ? event.detail?.page : undefined
    listener(page === 'teams' || page === 'attention' ? page : 'settings')
  }
  window.addEventListener(OPEN_EVENT, onOpen)
  return () => window.removeEventListener(OPEN_EVENT, onOpen)
}
