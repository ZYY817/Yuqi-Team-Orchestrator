import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { sendControllerTaskMessage, SubagentMessageBridgeError } from '../src/host/harness/subagent-message-bridge.ts'

const controller = { id: SessionId('controller') } as Agent
const child = SessionId('child')
const content = [{ type: 'text' as const, text: 'continue' }]

describe('sendControllerTaskMessage', () => {
  it('prefers the current Harness sendMessage API when both message operations exist', async () => {
    const signal = new AbortController().signal
    const sendMessage = vi.fn(async () => MessageId('current-message'))
    const followup = vi.fn(async () => MessageId('legacy-message'))

    await expect(sendControllerTaskMessage(
      { sendMessage, followup }, controller, child, content,
      { kind: 'coordinator', form: 'relay', senderSessionId: controller.id }, signal,
    )).resolves.toBe('current-message')

    expect(sendMessage).toHaveBeenCalledWith(controller, child, content, { signal })
    expect(followup).not.toHaveBeenCalled()
  })

  it('uses legacy followup only when sendMessage is absent and keeps coordinator attribution', async () => {
    const signal = new AbortController().signal
    const source = { kind: 'coordinator' as const, form: 'relay' as const, senderSessionId: controller.id }
    const followup = vi.fn(async () => MessageId('legacy-message'))

    await expect(sendControllerTaskMessage({ followup }, controller, child, content, source, signal))
      .resolves.toBe('legacy-message')

    expect(followup).toHaveBeenCalledWith(controller, child, content, { source, signal })
  })

  it('fails explicitly when the Host exposes neither supported message operation', () => {
    expect(() => sendControllerTaskMessage(
      {}, controller, child, content,
      { kind: 'coordinator', form: 'relay', senderSessionId: controller.id }, new AbortController().signal,
    )).toThrow(SubagentMessageBridgeError)
  })
})
