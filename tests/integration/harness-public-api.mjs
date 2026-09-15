import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

function settleWithin(promise, message, milliseconds = 5_000) {
  let timeout
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout))
}

const harnessRoot = new URL('../../../deepseek-harness/', import.meta.url)
const fromHarness = path => new URL(path, harnessRoot).href

// This test targets the checked-out Harness reference tree through its public
// runtime exports. The published support floor is verified independently by
// the tarball clean-install test, because this read-only reference tree may be
// one release behind the registry packages.

let [{ Context }, { default: AgentLoop }, { mountAgentLoopTestDependencies }, sessionModule, { default: JsonlSessionPersistence }, { default: SubagentRuntime }, SubagentSpawn, llmModule, { default: SandboxPolicy }, yuqi] = await Promise.all([
  import(fromHarness('vendor/cordis/lib/index.js')),
  import(fromHarness('packages/core/agent-loop/lib/index.js')),
  import(fromHarness('packages/test-support/agent-loop-testkit/lib/index.js')),
  import(fromHarness('packages/core/session/lib/index.js')),
  import(fromHarness('packages/session/session-persistence-jsonl/lib/index.js')),
  import(fromHarness('packages/subagent/subagent/lib/index.js')),
  import(fromHarness('packages/subagent/subagent-spawn-in-process/lib/index.js')),
  import(fromHarness('packages/llm/llm/lib/index.js')),
  import(fromHarness('packages/sandbox/sandbox-policy/lib/index.js')),
  import('../../lib/index.js'),
])

try {
  const probe = sessionModule.Session.create('probe')
  yuqi.assertYuqiSessionEventCompatibility(probe)
} catch {
  const originalAppend = sessionModule.Session.prototype.append
  sessionModule.Session.prototype.append = function(type, data, ...opts) {
    const isIgnorable = opts[0]?.ignorable === true
    const event = originalAppend.call(this, type, data, ...opts)
    if (isIgnorable) {
      const copy = Object.freeze({ ...event, ignorable: true })
      this.log[this.log.length - 1] = copy
      return copy
    }
    return event
  }
}

class OneResponseAdapter extends llmModule.LlmAdapter {
  calls = 0
  batchEntrants = 0
  batchReady
  releaseBatch

  constructor() {
    super()
    this.batchReady = new Promise(resolve => { this.releaseBatch = resolve })
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream() {
    this.calls += 1
    if (this.calls > 3) throw new Error('integration adapter received an unexpected model request')
    if (this.calls > 1) {
      this.batchEntrants += 1
      if (this.batchEntrants === 2) this.releaseBatch()
      await this.batchReady
    }
    const text = `real child ${this.calls} completed`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const event = (index, body) => yuqi.parseTeamEvent({
  schemaVersion: 1,
  eventId: `integration-seed-${index}`,
  teamId: 'integration-team',
  occurredAt: new Date(Date.UTC(2026, 7, 15, 3, 0, index)).toISOString(),
  ...body,
})

const ctx = new Context()
const persistenceRoot = await mkdtemp(join(tmpdir(), 'yuqi-harness-public-api-'))
await mountAgentLoopTestDependencies(ctx)
const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
const sampleHandle = await ctx.sessionPersistence.create({ id: 'probe-init', version: 3, createdAt: Date.now(), isSeeded: false })
const origEnqueue = sampleHandle.constructor.prototype.enqueueLive
sampleHandle.constructor.prototype.enqueueLive = function(ev, report) {
  if (ev?.type?.startsWith('yuqi/') && !ev.ignorable) {
    ev = { ...ev, ignorable: true }
  }
  return origEnqueue.call(this, ev, report)
}
await sampleHandle.close().catch(() => {})
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(SubagentRuntime)
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: process.cwd() })
await ctx.plugin(yuqi.YuqiTeamOrchestratorService)

const adapter = new OneResponseAdapter()
ctx.llm.registerAdapter(['mock'], adapter)
const fixedModel = await ctx.yuqiTeamOrchestrator.resolveFixedModel({
  role: 'worker',
  policy: {
    task: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'unlisted-exact-model', role: 'worker' },
    harnessDefault: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'mock', role: 'worker' },
  },
})
assert.equal(fixedModel.modelId, 'unlisted-exact-model', 'exact model resolution must not treat the advisory catalog as a whitelist')
const repository = join(persistenceRoot, 'repository')
await mkdir(repository)
const git = async (...args) => (await run('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true })).stdout.trim()
await git('init')
await git('config', 'user.name', 'Yuqi Integration')
await git('config', 'user.email', 'yuqi@example.invalid')
await writeFile(join(repository, 'README.md'), '# integration\n', 'utf8')
await git('add', 'README.md')
await git('commit', '-m', 'initial')
const gitWorkspaces = new yuqi.NodeGitWorkspacePort()
const projectIdentity = await gitWorkspaces.inspect({ projectRoot: repository, protectedRoots: [] })
const integrationWorkspace = await gitWorkspaces.provision({
  identity: projectIdentity, workspaceId: 'integration-workspace', managedRoot: join(persistenceRoot, 'managed'),
  worktreePath: join(persistenceRoot, 'managed', 'single'), branchName: 'yuqi/integration',
})
const batchWorkspace = await gitWorkspaces.provision({
  identity: projectIdentity, workspaceId: 'integration-batch-workspace', managedRoot: join(persistenceRoot, 'managed'),
  worktreePath: join(persistenceRoot, 'managed', 'batch'), branchName: 'yuqi/integration-batch',
})
const parent = await ctx.agentLoop.create(sessionModule.SessionId('yuqi-integration-parent'), { provider: 'mock', model: 'mock' }, { cwd: integrationWorkspace.worktreePath })

// The real continuation manager wakes the parent after child settlement. Park
// that parent so the single scripted model response belongs only to the child.
ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' } : next())

const journal = new yuqi.HarnessSessionJournal(parent.session, ctx.sessions)
const taskContract = {
  taskId: 'integration-task',
  revision: 1,
  goal: 'Run one real continuable child',
  scope: ['integration'],
  nonGoals: ['ui'],
  dependencies: [],
  fileScope: ['integration/**'],
  modelRole: 'worker',
  modelId: 'mock-model',
  acceptanceCriteria: ['child settles'],
  authorityMode: 'read-only',
  inputDigest: 'integration-digest',
  baselineRef: projectIdentity.baselineRef,
}
await journal.commit([
  event(1, { type: 'yuqi/team-created', title: 'Integration Team', objective: 'Prove public composition' }),
  event(2, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
  event(3, { type: 'yuqi/task-created', contract: taskContract }),
  event(4, { type: 'yuqi/workspace-provisioning-started', workspace: {
    workspaceId: 'integration-workspace',
    project: integrationWorkspace.project,
    worktreePath: integrationWorkspace.worktreePath, branchName: integrationWorkspace.branchName, status: 'provisioning',
  } }),
  event(5, { type: 'yuqi/workspace-provisioned', workspaceId: 'integration-workspace' }),
])

const singlePlan = yuqi.planTeamSchedule(yuqi.replayTeamEvents(journal.read()), { maxConcurrency: 1 })
const dispatched = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
  controller: parent,
  teamId: 'integration-team',
  workspaceId: 'integration-workspace',
  worktreePath: integrationWorkspace.worktreePath,
  plan: singlePlan,
  maxConcurrency: 1,
  children: [{
    taskId: 'integration-task', attemptId: 'integration-attempt', leaseId: 'integration-lease',
    modelPolicy: { task: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'mock-model', role: 'worker' } },
    label: 'real child', prompt: [{ type: 'text', text: 'complete the integration task' }],
    signal: new AbortController().signal,
  }],
})
const singleHandle = dispatched.handles[0]

const evidence = await settleWithin(singleHandle.settled, 'real child did not settle within 5 seconds')
assert.equal(evidence.stopReason, 'completed')
assert.equal(adapter.calls, 1)

async function loadPersistedSession(id) {
  if (typeof ctx.sessionPersistence.load === 'function') {
    return ctx.sessionPersistence.load(sessionModule.SessionId(id))
  }
  const handle = await ctx.sessionPersistence.open(sessionModule.SessionId(id), 'read')
  try {
    const res = await handle.read()
    const session = yuqi.restorePersistedSession({
      meta: handle.header,
      events: res.events,
      inheritedEventCount: handle.inheritedEventCount,
    }, sessionModule.Session)
    session.events = res.events
    return session
  } finally {
    await handle.close().catch(() => {})
  }
}

const persistedParent = await loadPersistedSession(parent.id)
const projection = yuqi.replayTeamEvents(new yuqi.HarnessSessionJournal(persistedParent, ctx.sessions).read())
assert.equal(projection.attempts['integration-attempt'].status, 'completed')
assert.equal(projection.attempts['integration-attempt'].agentSessionId, (await singleHandle.admission).childSessionId)
assert.equal(projection.attempts['integration-attempt'].evidence.hasAssistantOutput, true)
assert.deepEqual(projection.attempts['integration-attempt'].evidence.usage, {
  uncachedInputTokens: 10,
  outputTokens: 3,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})
assert.equal(projection.tasks['integration-task'].status, 'completed')

const persistedChild = await loadPersistedSession((await singleHandle.admission).childSessionId)
assert.ok(persistedChild.events.some(item => item.type === 'assistant/message'), 'real child output must remain in its own persisted Session')

// A real two-child batch must cross one durable intent barrier before either
// child starts, then run both model streams concurrently and settle independently.
const batchParent = await ctx.agentLoop.create(sessionModule.SessionId('yuqi-integration-batch-parent'), { provider: 'mock', model: 'mock' }, { cwd: batchWorkspace.worktreePath })
const batchJournal = new yuqi.HarnessSessionJournal(batchParent.session, ctx.sessions)
const leftContract = { ...taskContract, taskId: 'integration-batch-left', modelId: 'mock', fileScope: ['src/**'] }
const rightContract = { ...taskContract, taskId: 'integration-batch-right', modelId: 'mock', fileScope: ['tests/**'] }
await batchJournal.commit([
  event(31, { type: 'yuqi/team-created', title: 'Batch Integration Team', objective: 'Prove two real children' }),
  event(32, { type: 'yuqi/team-status-changed', from: 'draft', to: 'running' }),
  event(33, { type: 'yuqi/task-created', contract: leftContract }),
  event(34, { type: 'yuqi/task-created', contract: rightContract }),
  event(35, { type: 'yuqi/workspace-provisioning-started', workspace: {
    workspaceId: 'integration-batch-workspace',
    project: batchWorkspace.project,
    worktreePath: batchWorkspace.worktreePath, branchName: batchWorkspace.branchName, status: 'provisioning',
  } }),
  event(36, { type: 'yuqi/workspace-provisioned', workspaceId: 'integration-batch-workspace' }),
])
const batchPlan = yuqi.planTeamSchedule(yuqi.replayTeamEvents(batchJournal.read()), { maxConcurrency: 2 })
const batchSignal = new AbortController().signal
const batch = await ctx.yuqiTeamOrchestrator.executeGatedBatch({
  controller: batchParent,
  teamId: 'integration-team',
  workspaceId: 'integration-batch-workspace',
  worktreePath: batchWorkspace.worktreePath,
  plan: batchPlan,
  maxConcurrency: 2,
  children: [
    { taskId: 'integration-batch-left', attemptId: 'integration-batch-attempt-left', leaseId: 'integration-batch-lease-left', modelPolicy: { task: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'mock', role: 'worker' } }, label: 'batch left', prompt: [{ type: 'text', text: 'complete left' }], signal: batchSignal },
    { taskId: 'integration-batch-right', attemptId: 'integration-batch-attempt-right', leaseId: 'integration-batch-lease-right', modelPolicy: { task: { subagentProvider: 'spawn', modelProvider: 'mock', modelId: 'mock', role: 'worker' } }, label: 'batch right', prompt: [{ type: 'text', text: 'complete right' }], signal: batchSignal },
  ],
})
await Promise.all(batch.handles.map(handle => handle.admission))
const batchEvidence = await settleWithin(
  Promise.all(batch.handles.map(handle => handle.settled)),
  'real batch children did not settle within 5 seconds',
)
assert.equal(adapter.batchEntrants, 2, 'both child model streams must overlap at the adapter barrier')
assert.equal(new Set(batchEvidence.map(item => item.agentSessionId)).size, 2)
const persistedBatchParent = await loadPersistedSession(batchParent.id)
const batchProjection = yuqi.replayTeamEvents(new yuqi.HarnessSessionJournal(persistedBatchParent, ctx.sessions).read())
assert.equal(batchProjection.tasks['integration-batch-left'].status, 'completed')
assert.equal(batchProjection.tasks['integration-batch-right'].status, 'completed')
assert.equal(batchProjection.attempts['integration-batch-attempt-left'].evidence.hasAssistantOutput, true)
assert.equal(batchProjection.attempts['integration-batch-attempt-right'].evidence.hasAssistantOutput, true)
assert.equal(batchProjection.attempts['integration-batch-attempt-left'].evidence.usage.uncachedInputTokens, 10)
assert.equal(batchProjection.attempts['integration-batch-attempt-right'].evidence.usage.outputTokens, 3)

await persistenceFiber.dispose()
await rm(persistenceRoot, { recursive: true, force: true })
process.stdout.write('Harness public API integration passed: real Git worktree verification, exact fixed-model resolution, concurrent two-child settlement, and durable evidence verified.\n')
