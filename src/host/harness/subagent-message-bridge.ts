/** Harness 0.1.5 message bridge for controller-originated task instructions. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Attribution accepted by the legacy continuable-child follow-up API. */
interface LegacyCoordinatorMessageSource {
  readonly kind: 'coordinator'
  readonly form: 'relay'
  readonly senderSessionId: SessionId
}

/** The public 0.1.5 subagent message operation used by the deployed Harness. */
interface SubagentMessageRuntime {
  sendMessage(
    sender: Agent,
    targetId: SessionId,
    content: ContentBlock[],
    options: { readonly signal: AbortSignal },
  ): Promise<MessageId>
}

/** The pre-0.1.5 continuable-child follow-up operation. */
interface LegacySubagentFollowupRuntime {
  followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: { readonly source: LegacyCoordinatorMessageSource; readonly signal: AbortSignal },
  ): Promise<MessageId>
}

/** Fail explicitly when a Host exposes neither supported message operation. */
export class SubagentMessageBridgeError extends Error {
  constructor() {
    super('Harness subagent runtime exposes neither sendMessage() nor followup()')
    this.name = 'SubagentMessageBridgeError'
  }
}

/**
 * Deliver one controller-originated instruction to its direct continuable child.
 * Harness derives the durable agent-message provenance from the exact sender.
 * @param runtime - the current Harness subagent service.
 * @param controller - the exact live Team controller and message sender.
 * @param childSessionId - the direct continuable child receiving the instruction.
 * @param content - instruction content for the child.
 * @param legacySource - durable coordinator attribution required by pre-0.1.5 Harness releases.
 * @param signal - cancellation before Harness accepts the instruction.
 * @returns the accepted Harness message id.
 */
export function sendControllerTaskMessage(
  runtime: unknown,
  controller: Agent,
  childSessionId: SessionId,
  content: ContentBlock[],
  legacySource: LegacyCoordinatorMessageSource,
  signal: AbortSignal,
): Promise<MessageId> {
  if (typeof (runtime as Partial<SubagentMessageRuntime>).sendMessage === 'function') {
    return (runtime as SubagentMessageRuntime).sendMessage(controller, childSessionId, content, { signal })
  }
  if (typeof (runtime as Partial<LegacySubagentFollowupRuntime>).followup === 'function') {
    return (runtime as LegacySubagentFollowupRuntime).followup(
      controller, childSessionId, content, { source: legacySource, signal },
    )
  }
  throw new SubagentMessageBridgeError()
}
