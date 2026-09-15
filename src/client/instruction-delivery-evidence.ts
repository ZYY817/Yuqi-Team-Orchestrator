/** Exact persisted user-message identity only; inbox acceptance and later
 * assistant output are not proof of consumption or a causally linked reply. */
export function hasInstructionDeliveryEvidence(events: readonly { type: string; data: unknown }[], messageId: string): boolean {
  return events.some(event => {
    if (event.type !== 'user/message' || typeof event.data !== 'object' || event.data === null) return false
    const data = event.data as { id?: unknown; message?: { id?: unknown } }
    return data.id === messageId || data.message?.id === messageId
  })
}
