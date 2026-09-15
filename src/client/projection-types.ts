import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    yuqiTeam: TeamConsoleSummary | null
  }
}
