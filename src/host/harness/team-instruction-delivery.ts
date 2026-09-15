import { readTeamInstructions, type TeamInstruction } from '../../domain/team-instruction.ts'

/** Persist intent before calling the non-idempotent Host. An interrupted intent
 * is uncertain, never permission to replay an external side effect. */
export async function deliverTeamInstruction(request: {
  record: TeamInstruction
  read: () => readonly { type: string; data: unknown }[]
  persist: (record: TeamInstruction) => Promise<void>
  confirmPersisted?: () => Promise<void>
  send: (taskId: string) => Promise<{ childSessionId: string; messageId: string }>
  rejected: (cause: unknown) => boolean
}): Promise<TeamInstruction> {
  const previous = readTeamInstructions(request.read()).find(row => row.operationId === request.record.operationId)
  if (previous) {
    if (previous.text !== request.record.text || previous.target !== request.record.target
      || previous.teamId !== request.record.teamId || previous.authorSessionId !== request.record.authorSessionId) {
      throw new Error('Instruction request identity conflicts with its persisted content')
    }
    // A legacy native append can be visible before flush succeeds. Reconfirm
    // durability without appending another message or calling the Host again.
    await request.confirmPersisted?.()
    return { ...previous, recipients: previous.recipients.map(row => row.status === 'sending'
      ? { ...row, status: 'unknown', detail: 'Previous delivery has no durable receipt; it was not resent.' } : row) }
  }
  let record = request.record
  await request.persist(record)
  // Keep the exact captured recipient set. Partial failure never expands or replays it.
  for (const [index, recipient] of record.recipients.entries()) {
    let result: TeamInstruction['recipients'][number]
    try {
      const accepted = await request.send(recipient.taskId)
      result = { ...recipient, ...accepted, status: 'accepted' }
    } catch (cause) {
      result = { ...recipient, status: request.rejected(cause) ? 'failed' : 'unknown',
        detail: cause instanceof Error ? cause.message.slice(0, 600) : 'Host delivery outcome unavailable' }
    }
    record = { ...record, recipients: record.recipients.map((row, i) => i === index ? result : row) }
    await request.persist(record)
  }
  return record
}
