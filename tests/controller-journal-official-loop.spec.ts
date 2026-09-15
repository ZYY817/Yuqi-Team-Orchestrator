/** Opt-in in-memory probe against an already installed official Host. No model/network calls. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installControllerJournalGuard } from '../src/host/harness/controller-launcher.ts'

const officialRoot = process.env.YUQI_OFFICIAL_HOST_ROOT
describe.skipIf(!officialRoot)('official AgentLoop journal controller boundary', () => {
  it('settles native wakeups without a model step or busy loop and leaves another Agent executable', async () => {
    const requireOfficial = createRequire(path.join(officialRoot!, 'package.json'))
    const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(requireOfficial.resolve(name)).href)
    const [{ Context }, { SessionStore }, { AgentRegistry }, { SessionProjectionRegistry }, { SystemPrompt }, { AgentLoop }] = await Promise.all([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-agent-loop',
    ].map(load))
    const ctx = new Context()
    const stream = vi.fn(async function* () { /* Successful empty response; no external model. */ })
    const prepareCall = vi.fn(async (config: unknown) => ({ config, stream }))
    const handles: { dispose(): Promise<void> }[] = []
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
      ctx.provide('llm', { prepareCall, stream })
      ctx.provide('tools', {})
      await ctx.plugin(AgentLoop, { agents: [] })
      const controller = await ctx.agents.create({ sessionId: 'yuqi-journal-probe', agentOptions: { provider: 'probe', model: 'probe' },
        setup: (agentCtx: never) => installControllerJournalGuard(agentCtx, 'yuqi-journal-probe') })
      handles.push(controller)
      for (let index = 0; index < 2; index++) {
        controller.agent.send({ id: `report-${index}`, role: 'user', content: [{ type: 'text', text: 'Worker completed; do not execute another task.' }],
          source: { kind: 'subagent-report', form: 'relay', senderSessionId: 'worker-probe' } }, 'next-step', true)
        await controller.agent.whenIdle()
        expect(controller.agent.status).toBe('idle')
      }
      const events = controller.agent.session.snapshotEvents()
      expect(events.filter((event: { type: string }) => event.type === 'turn/start')).toHaveLength(2)
      expect(events.filter((event: { type: string }) => event.type === 'step/start')).toHaveLength(0)
      expect(events.filter((event: { type: string }) => event.type === 'turn/end').map((event: { data: { reason: { kind: string } } }) => event.data.reason.kind)).toEqual(['blocked', 'blocked'])
      expect(prepareCall).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
      expect(controller.agent.inbox.hasPending).toBe(false)
      const worker = await ctx.agents.create({ sessionId: 'worker-probe', agentOptions: { provider: 'probe', model: 'probe' },
        setup: (agentCtx: never) => installControllerJournalGuard(agentCtx, 'yuqi-journal-probe') })
      handles.push(worker)
      worker.agent.followup({ id: 'worker-input', role: 'user', content: [{ type: 'text', text: 'Complete the bounded probe.' }], source: { kind: 'human' } })
      await worker.agent.whenIdle()
      expect(prepareCall).toHaveBeenCalledOnce()
      expect(stream).toHaveBeenCalledOnce()
      expect(worker.agent.status).toBe('idle')
      expect(worker.agent.session.snapshotEvents().filter((event: { type: string }) => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
    } finally {
      for (const handle of handles.reverse()) await handle.dispose()
      await ctx.fiber.dispose()
    }
  }, 10_000)
})
