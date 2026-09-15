import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { readLastAssistantOutput } from '../src/host/harness/session-assistant-output.ts'
import { snapshotOnlySession } from './snapshot-session-fixture.ts'

function childSession(id: string, text?: string): Session {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], { version: 0, id: sessionId, createdAt: 0, cwd: process.cwd() })
  if (text !== undefined) {
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'not part of the report' }, { type: 'text', text }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
  }
  return session
}

function context(live?: Session, persisted?: Session, failLoad = false): Context {
  const ctx = new Context()
  ctx.provide('sessions', {
    get(id: SessionId) { return live !== undefined && String(live.id) === String(id) ? live : undefined },
  } as never)
  ctx.provide('sessionPersistence', {
    async load(id: SessionId) {
      if (failLoad || persisted === undefined || String(persisted.id) !== String(id)) throw new Error('missing')
      return { meta: persisted.header, events: persisted.events }
    },
  } as never)
  return ctx
}

describe('bounded child assistant output', () => {
  it.each(['legacy', 'snapshot'] as const)('reads %s live output and marks a bounded truncation without including reasoning', async capability => {
    const original = childSession('live-report', '123456789')
    const child = capability === 'snapshot' ? snapshotOnlySession(original) : original
    await expect(readLastAssistantOutput(context(child), String(child.id), 5)).resolves.toEqual({ text: '12345', truncated: true })
    await expect(readLastAssistantOutput(context(child), String(child.id), 20)).resolves.toEqual({ text: '123456789', truncated: false })
  })

  it('falls back to persisted events and returns undefined for absent output or failed loads', async () => {
    const persisted = childSession('persisted-report', 'durable result')
    await expect(readLastAssistantOutput(context(undefined, persisted), String(persisted.id), 100))
      .resolves.toEqual({ text: 'durable result', truncated: false })
    const empty = childSession('empty-report')
    await expect(readLastAssistantOutput(context(empty), String(empty.id), 100)).resolves.toBeUndefined()
    await expect(readLastAssistantOutput(context(undefined, undefined, true), 'missing-report', 100)).resolves.toBeUndefined()
    const whitespace = childSession('whitespace-report', '  \n\t  ')
    await expect(readLastAssistantOutput(context(whitespace), String(whitespace.id), 100)).resolves.toBeUndefined()
  })
})
