/** Client-safe declaration of the Yuqi Session projection key. */

import type { TeamConsoleSummary } from './team-console-summary.ts'

export {}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Current Team summary for one controller Session, or null before a Team exists. */
    yuqiTeam: TeamConsoleSummary | null
  }

  interface SessionProjectionStateMap {
    /** Host-only fold state. Its concrete shape stays private to the plugin. */
    yuqiTeam: unknown
  }
}
