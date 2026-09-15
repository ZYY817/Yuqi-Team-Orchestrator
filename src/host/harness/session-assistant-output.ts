/** Bounded, read-only projection of the latest assistant text in a child Session. */

import { readSessionEvents } from './session-events.ts'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { harnessSessionAccess } from './session-store-adapter.ts'

export interface BoundedAssistantOutput {
  readonly text: string
  readonly truncated: boolean
}

export async function readLastAssistantOutput(
  ctx: Context,
  sessionId: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<BoundedAssistantOutput | undefined> {
  signal?.throwIfAborted()
  const id = SessionId(sessionId)
  const live = harnessSessionAccess(ctx).get?.(id)
  const source = live === undefined ? await loadPersisted(ctx, id, signal) : { events: readSessionEvents(live) }
  if (source === undefined) return undefined
  const text = lastAssistantText(source.events)
  if (text === undefined) return undefined
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(0, maxChars), truncated: true }
}

async function loadPersisted(ctx: Context, id: SessionId, signal?: AbortSignal): Promise<{ readonly events: readonly SessionEvent[] } | undefined> {
  signal?.throwIfAborted()
  const persistence = ctx.get('sessionPersistence') as { readonly load?: (sessionId: SessionId) => Promise<{ readonly events: readonly SessionEvent[] }> } | undefined
  if (persistence?.load === undefined) return undefined
  try { return await persistence.load(id) } catch { signal?.throwIfAborted(); return undefined }
}

function lastAssistantText(events: readonly SessionEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'assistant/message') continue
    const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()
    if (text !== '') return text
  }
  return undefined
}
