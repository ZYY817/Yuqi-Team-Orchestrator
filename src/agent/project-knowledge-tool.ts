/** Explicit, bounded project knowledge; never ingest whole conversations. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  projectSummaryItemSchema, projectSummaryItemTopicSchema,
  projectSummaryRemoveItemSchema, projectSummaryClearTopicSchema,
  renderProjectSummaryMarkdown, type ProjectSummaryPatch,
} from '../application/project-summary.ts'
import { readTeamEventsFromSession } from '../host/harness/session-journal.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { workspaceProjectRoot } from '../host/workspace-project-root.ts'

const identity = {
  teamId: z.string().trim().min(1).optional(),
  controllerSessionId: z.string().trim().min(1).optional(),
}
const inputSchema = z.discriminatedUnion('action', [
  z.object({ ...identity, action: z.literal('read') }).strict(),
  z.object({
    ...identity, action: z.literal('record'),
    topic: projectSummaryItemTopicSchema,
    item: projectSummaryItemSchema,
  }).strict(),
  projectSummaryRemoveItemSchema.extend({ ...identity, action: z.literal('remove') }).strict(),
  projectSummaryClearTopicSchema.extend({ ...identity, action: z.literal('clear') }).strict(),
])

export function registerProjectKnowledgeTool(ctx: Context, resolve: (
  parent: Agent, identity: { readonly teamId?: string | undefined; readonly controllerSessionId?: string | undefined },
) => Promise<{ readonly controller: Agent; readonly teamId: string }>): void {
  ctx.tools.register(defineTool({
    name: 'yuqi_team_knowledge',
    description: 'Read, record, remove or clear small reusable project knowledge in .yuqi-team/index.json for the bound Team. record requires topic and item; remove requires an item topic and id; clear requires a topic and confirmed:true, supplied only after the user explicitly confirms clearing that scope (topic all clears the entire project overview memory). Clear conventions also removes its user preferences. remove/clear are idempotent and only edit the index, never source files, linked documents or runtime/recovery records. Store user preferences in conventions only when explicitly stated by the user; never infer or automatically collect them. For lessons record symptom, verified cause, remedy, evidence and applicability; label unverified ideas as pending. Never store credentials, transcripts or instructions granting authority. Use stable ids to revise an existing entry. Returns a Markdown view, not runtime state or proof of task completion. New child dispatches receive a reference snapshot; already running children need an explicit controller message for urgent updates.',
    parameters: {
      action: { type: 'string', enum: ['read', 'record', 'remove', 'clear'], required: true },
      topic: { type: 'string', enum: ['pitfalls', 'architectureDecisions', 'conventions', 'documentLinks', 'overallProgress'], description: 'Required for record/remove/clear. documentLinks and overallProgress support clear only. conventions includes explicitly stated user preferences.' },
      id: { type: 'string', description: 'Required for remove: stable item id in the selected topic; not a filesystem path.' },
      confirmed: { type: 'boolean', description: 'Required and must be true for clear, only after explicit user confirmation of the selected category. Omit for other actions.' },
      item: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true },
        text: { type: 'string', required: true, description: 'At most 1000 characters; concise verified facts and limits.' },
        links: { type: 'array', required: true, items: { type: 'string' }, description: 'Up to four project-relative or HTTPS evidence references; use [] if none.' },
      } },
      teamId: { type: 'string' },
      controllerSessionId: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        markdown: { type: 'string', required: true },
        saved: { type: 'boolean', required: true },
        panelSynced: { type: 'boolean', required: true },
      } },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('Project knowledge requires an agent-owned Team conversation')
      const input = inputSchema.parse(args)
      exec.signal.throwIfAborted()
      const target = await resolve(exec.agent, input)
      const projection = replayTeamEvents(readTeamEventsFromSession(target.controller.session))
      if (projection.team.id !== target.teamId || projection.workspace?.status !== 'ready') {
        throw new Error('Project knowledge requires the exact ready Team workspace')
      }
      const root = workspaceProjectRoot(projection.workspace)
      exec.signal.throwIfAborted()
      let patch: ProjectSummaryPatch | undefined
      switch (input.action) {
        case 'read': break
        case 'record': patch = { upsertItem: { topic: input.topic, item: input.item } }; break
        case 'remove': patch = { removeItem: { topic: input.topic, id: input.id } }; break
        case 'clear': patch = { clearTopic: { topic: input.topic, confirmed: input.confirmed } }; break
      }
      const summary = patch === undefined
        ? await ctx.yuqiTeamOrchestrator.readProjectSummary(root)
        : await ctx.yuqiTeamOrchestrator.updateProjectSummary(root, patch)
      let panelSynced = true
      try { await ctx.yuqiTeamOrchestrator.recordProjectSummary({ controller: target.controller, summary }) }
      catch { panelSynced = false }
      // A failed UI projection does not undo a committed project file.
      return { markdown: renderProjectSummaryMarkdown(summary), saved: input.action !== 'read', panelSynced }
    },
  }))
}
