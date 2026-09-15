import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ProviderModelRef } from '../../domain/model-route.ts'
import { harnessSessionAccess } from './session-store-adapter.ts'

export interface SafeModelCallFailure { readonly code: string; readonly status: number }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object'
  ? value as Record<string, unknown> : {}

/** Complete native child log, not assistant text or a generic end/error string. */
export function inspectModelCallFailure(input: {
  readonly meta: unknown; readonly events: readonly unknown[]
}, childId: string, parentId: string, model: ProviderModelRef): SafeModelCallFailure | undefined {
  const meta = record(input.meta)
  if (meta.id !== childId || meta.parentSession !== parentId || input.events.length > 20_000) return undefined
  const seed = meta.seedLength ?? 0
  if (!Number.isSafeInteger(seed) || (seed as number) < 0) return undefined
  if (input.events.some(event => !Number.isSafeInteger(record(event).seq))) return undefined
  const events = input.events.map(record).filter(event => (event.seq as number) >= (seed as number))
  if (events.length === 0 || events[0]!.seq !== seed) return undefined
  let starts = 0, steps = 0, inboxMessages = 0, matchedRoute = false
  let failure: SafeModelCallFailure | undefined, ended = false
  for (const [index, event] of events.entries()) {
    if (event.seq !== (seed as number) + index) return undefined
    const data = record(event.data)
    if (ended && event.type !== 'session/end-seed') return undefined
    if (event.type === 'tool/call' || event.type === 'tool/result' || event.type === 'assistant/message'
      || event.type === 'command/run' || event.type === 'command/done') return undefined
    if (event.type === 'turn/start') { if (++starts !== 1 || data.turn !== 1) return undefined }
    if (event.type === 'step/start') { if (++steps !== 1 || data.turn !== 1 || data.step !== 1) return undefined }
    if (event.type === 'agent/inbox/spliced') {
      if (!Array.isArray(data.inserted)) return undefined
      inboxMessages += data.inserted.length
      if (inboxMessages > 1) return undefined
    }
    if (event.type === 'request/context') {
      if (data.provider !== model.modelProvider || data.model !== model.modelId) return undefined
      matchedRoute = true
    }
    if (event.type === 'assistant/chunk') {
      if (starts !== 1 || steps !== 1 || !matchedRoute || data.turn !== 1 || data.step !== 1) return undefined
      const chunk = record(data.chunk)
      if (chunk.type === 'usage') {
        if (record(chunk.usage).outputTokens !== 0) return undefined
      } else if (chunk.type === 'finish') {
        const reason = record(chunk.reason), facts = record(reason.failure)
        // Only explicit provider HTTP failure facts. UNKNOWN/local errors, aborts,
        // tool deltas, block starts, text and reasoning all fail closed.
        if (reason.kind !== 'error' || typeof facts.code !== 'string' || !facts.code
          || facts.code === 'UNKNOWN' || facts.code.length > 128 || typeof facts.status !== 'number'
          || ![401, 403, 404, 408, 429, 500, 502, 503, 504].includes(facts.status)) return undefined
        failure = { code: facts.code, status: facts.status }
      } else return undefined
    }
    if (event.type === 'turn/end') {
      const reason = record(data.reason), facts = record(reason.error)
      if (ended || !failure || data.turn !== 1 || reason.kind !== 'error'
        || facts.code !== failure.code || facts.status !== failure.status) return undefined
      ended = true
    }
  }
  return starts === 1 && steps === 1 && matchedRoute && ended ? failure : undefined
}

/** Flush/read the exact child only; unavailable/incomplete persistence never authorizes retry. */
export async function readModelCallFailure(ctx: Context, childId: string, parentId: string, model: ProviderModelRef): Promise<SafeModelCallFailure | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const sessions = harnessSessionAccess(ctx), id = SessionId(childId)
        const live = sessions.get?.(id)
        if (live) {
          if (!sessions.flush) return undefined
          await sessions.flush(live)
        }
        const loaded = await ctx.sessionPersistence.load(id)
        return loaded === undefined ? undefined : inspectModelCallFailure(loaded, childId, parentId, model)
      })(),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 2_000) }),
    ])
  } catch { return undefined } finally { clearTimeout(timer) }
}
