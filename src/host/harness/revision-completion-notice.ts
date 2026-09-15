import type { TeamEvent } from '../../domain/events.ts'

/** The checkpoint must be re-flushed before its cut can suppress a notice. */
export async function hasNewRevisionCompletion(
  checkpoint: { readonly sourceEventCount: number } | undefined,
  reflushCheckpoint: () => Promise<void>,
  read: () => { readonly events: readonly TeamEvent[]; readonly isCompletedRevision: (taskId: string) => boolean },
): Promise<boolean> {
  if (checkpoint !== undefined) await reflushCheckpoint()
  // Re-read after the durability await, rather than trusting a stale task state.
  const current = read()
  const cut = checkpoint?.sourceEventCount ?? 0
  if (!Number.isSafeInteger(cut) || cut < 0 || cut > current.events.length) throw new Error('Invalid parent notification checkpoint cut')
  return current.events.slice(cut).some(event => event.type === 'yuqi/task-status-changed'
    && event.to === 'completed' && current.isCompletedRevision(String(event.taskId)))
}
