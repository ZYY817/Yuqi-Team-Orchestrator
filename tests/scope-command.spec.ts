import type { Agent } from '@deepseek-ai/dsh-agent'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { executeYuqiCommand, type YuqiCommandService } from '../src/host/harness/commands.ts'
import { TEAM_SESSION_EVENT, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT } from '../src/host/harness/session-journal.ts'
import { replayTeamEvents } from '../src/domain/projection.ts'
import { YuqiOrchestratorError } from '../src/application/errors.ts'
import { completeTeamEvents, event } from './fixtures.ts'

function setup() {
  const facts = [...completeTeamEvents().slice(0, 4),
    event(90, { type: 'yuqi/team-status-changed', from: 'running', to: 'pausing' }),
    event(91, { type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused' }),
  ]
  const controllerSession = Session.create(SessionId('scope-controller'))
  const parent = Session.create(SessionId('scope-parent'))
  for (const fact of facts) controllerSession.append(TEAM_SESSION_EVENT, { event: fact })
  controllerSession.append(TEAM_PARENT_BINDING_EVENT, { parentSessionId: String(parent.id), generation: 1, operationId: 'bind-scope', boundAt: '2026-09-06T00:00:00Z' })
  parent.append(TEAM_PARENT_PROJECTION_EVENT, { controllerSessionId: String(controllerSession.id), sourceEventCount: facts.length, events: facts })
  const controller = { id: controllerSession.id, session: controllerSession } as Agent
  const setTaskFileScope = vi.fn(async () => replayTeamEvents(facts))
  const resumeTeam = vi.fn()
  const service = { setTaskFileScope, resumeTeam } as unknown as YuqiCommandService
  const resolve = vi.fn(async () => controller)
  const payload = Buffer.from(JSON.stringify(['src/**', '公共 文件.ts'])).toString('base64url')
  const line = `/yuqi scope task-1 ${payload} team-1 scope-controller scope-request`
  const run = (input = line, session = parent) => executeYuqiCommand({
    rawInput: input.replace(/^\/yuqi\s/u, ''), agent: { id: session.id, session } as Agent,
    commandId: CommandId('scope-command'), attachments: [], signal: new AbortController().signal,
  }, service, resolve)
  return { run, line, resolve, controller, parent, setTaskFileScope, resumeTeam, service }
}

describe('strictly bound scope command', () => {
  it('decodes the complete UTF-8 scope and delegates once without resume', async () => {
    const h = setup()
    await expect(h.run()).resolves.toMatchObject({ kind: 'success', text: expect.stringContaining('未新增权限或发送继续请求') })
    expect(h.setTaskFileScope).toHaveBeenCalledWith({ controller: h.controller, teamId: 'team-1', taskId: 'task-1', fileScope: ['src/**', '公共 文件.ts'], operationId: 'ui-v1:scope-request' })
    expect(h.resumeTeam).not.toHaveBeenCalled()
  })

  it.each(['short', 'wrong-team', 'wrong-controller', 'request', 'rebound', 'unavailable'])('rejects %s identity without mutation', async kind => {
    const h = setup()
    let line = h.line
    if (kind === 'short') line = h.line.split(' ').slice(0, 4).join(' ')
    if (kind === 'wrong-team') line = line.replace('team-1', 'team-other')
    if (kind === 'wrong-controller') line = line.replace('scope-controller', 'unbound-controller')
    if (kind === 'request') line = line.replace('scope-request', 'bad/request')
    if (kind === 'rebound') h.controller.session.append(TEAM_PARENT_BINDING_EVENT, { parentSessionId: 'new-parent', generation: 2, operationId: 'rebind', boundAt: '2026-09-06T00:01:00Z' })
    if (kind === 'unavailable') h.resolve.mockResolvedValue(undefined as never)
    await expect(h.run(line)).resolves.toMatchObject({ kind: 'error' })
    expect(h.setTaskFileScope).not.toHaveBeenCalled()
  })

  it.each(['bad-json', '{}', '[]', '["../escape"]', '["C:/escape"]', '[42]'])('rejects invalid payload %s', async value => {
    const h = setup()
    const tokens = h.line.split(' ')
    tokens[3] = Buffer.from(value).toString('base64url')
    await expect(h.run(tokens.join(' '))).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('INVALID_BATCH') })
    expect(h.setTaskFileScope).not.toHaveBeenCalled()
  })

  it('surfaces service safety errors and unsupported Hosts', async () => {
    const h = setup()
    h.setTaskFileScope.mockRejectedValue(new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', 'Execution is still active'))
    await expect(h.run()).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('CONTROL_NOT_ALLOWED') })
    delete h.service.setTaskFileScope
    await expect(h.run()).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('未启用任务范围编辑') })
    expect(h.resumeTeam).not.toHaveBeenCalled()
  })
})
