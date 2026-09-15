import { z } from 'zod'

export const TEAM_SIDECAR_CHANNEL = '/yuqi-team-sidecar'
export const TEAM_SIDECAR_PAGE_SIZE = 200
// Complete maximum 16 MiB owned record plus session/RPC envelope headroom.
// This does not increase the authoritative store or per-batch limits.
export const TEAM_SIDECAR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024 + 64 * 1024

const sessionIdSchema = z.string().min(1).max(2048)
const cursorSchema = z.string().min(1).max(20480)

/** Plugin SessionEvent envelopes, not native history or Host projections.
 * Payload vocabulary stays forward-compatible; reducers validate event data.
 */
export const teamSidecarEventSchema = z.strictObject({
  type: z.string().regex(/^yuqi\/.+$/u),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  time: z.number().finite(),
  ignorable: z.literal(true),
  data: z.json(),
})

export const teamSidecarSnapshotRequestSchema = z.strictObject({
  sessionIds: z.array(sessionIdSchema).max(TEAM_SIDECAR_PAGE_SIZE)
    .refine(ids => new Set(ids).size === ids.length, 'Duplicate session IDs').optional(),
  cursor: cursorSchema.optional(),
})

export const teamSidecarSnapshotSchema = z.strictObject({
  mode: z.enum(['sidecar', 'legacy']),
  sessions: z.array(z.strictObject({
    sessionId: sessionIdSchema,
    source: z.enum(['legacy', 'sidecar', 'unavailable']),
    events: z.array(teamSidecarEventSchema).refine(
      events => events.every((event, index) => event.seq === index + 1),
      'Expected complete sidecar event sequence starting at 1',
    ),
  }).refine(record => record.source === 'sidecar' || record.events.length === 0,
    'Legacy and unavailable records must not export events')).max(TEAM_SIDECAR_PAGE_SIZE).refine(
    sessions => new Set(sessions.map(session => session.sessionId)).size === sessions.length,
    'Duplicate session records',
  ),
  nextCursor: cursorSchema.optional(),
}).refine(value => value.mode !== 'legacy' || (value.sessions.length === 0 && value.nextCursor === undefined),
  'Legacy mode cannot contain sidecar records or a cursor')

export type TeamSidecarSnapshotRequest = z.infer<typeof teamSidecarSnapshotRequestSchema>
export type TeamSidecarSnapshot = z.infer<typeof teamSidecarSnapshotSchema>
export type TeamSidecarEvent = z.infer<typeof teamSidecarEventSchema>

/** Cursor is reader-owned and bound to the exact sessionIds selection. Enumerate
 * deterministically (e.g. session ID keyset); no global point-in-time guarantee.
 * A page may be empty while nextCursor advances past ineligible native identities.
 * Keep each session's complete event stream in one page; never truncate facts.
 */
export interface TeamSidecarReadOptions {
  readonly cursor?: string
  readonly limit: number
  readonly signal: AbortSignal
}

/** Service must resolve actual native Sessions, verify their exact identities,
 * bind the existing sidecar, then read plugin events. Never open a domain here.
 * Missing/ineligible identities may be omitted; loading/binding/read failures
 * must reject, except a recognized corrupt native log may return an explicit
 * source:'unavailable', events:[] record. This never authorizes session actions.
 * Only plugin data approved for the client may leave this boundary:
 * no native history, settings, credentials, or secrets in event payloads.
 * The optional second argument preserves one-argument reader compatibility;
 * unbounded enumeration must implement paging, not materialize all records.
 * Return legacy ONLY when the runtime facility is absent, never when readiness,
 * native identity verification, binding or reads fail. Await readiness first.
 * Mixed legacy native sessions must be explicitly verified and returned with
 * source:'legacy', events:[]; never treat an omitted/failed record as legacy.
 */
export type TeamSidecarReader = (
  sessionIds?: readonly string[],
  options?: TeamSidecarReadOptions,
) => Promise<{
  readonly mode: 'sidecar' | 'legacy'
  readonly sessions: readonly { readonly sessionId: string; readonly source: 'legacy' | 'sidecar' | 'unavailable'; readonly events: readonly unknown[] }[]
  readonly nextCursor?: string
}>
