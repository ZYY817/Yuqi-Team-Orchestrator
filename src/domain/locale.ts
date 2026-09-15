/** Durable locale for Host-authored, user-visible Team text. */

import { z } from 'zod'

export const TEAM_LOCALES = ['zh', 'en'] as const
export const teamLocaleSchema = z.enum(TEAM_LOCALES)
export type TeamLocale = z.output<typeof teamLocaleSchema>

/** Legacy Team logs predate locale and used Chinese Host copy. */
export const DEFAULT_TEAM_LOCALE: TeamLocale = 'zh'
