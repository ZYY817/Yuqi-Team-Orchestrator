/** Human control surface over the same durable Team command path as the Host service. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { workspaceProjectRoot } from '../workspace-project-root.ts'
import type { TeamProjection } from '../../domain/projection.ts'
import { replayTeamEvents } from '../../domain/projection.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import { readActiveTeamParentBinding, readTeamEventsFromSession, readTeamProjectionEvents, readTeamProjectionEventsForController } from './session-journal.ts'
import { projectSummaryRemoveItemSchema, projectSummaryClearTopicSchema, renderProjectSummaryMarkdown, type ProjectSummary, type ProjectSummaryPatch } from '../../application/project-summary.ts'
import type { ReviewOutcome, ReviewTrigger } from '../../application/reviewer.ts'
import type { ReviewUserDecision } from '../../domain/review-policy.ts'
import { TEAM_AUTHORITY_MODES, type TeamAuthorityMode } from '../../domain/team-settings-contract.ts'
import { fileScopePatternSchema } from '../../domain/file-scope.ts'
import type { TeamLocale } from '../../domain/locale.ts'
import type { TeamInstruction } from '../../domain/team-instruction.ts'

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u
const MAX_COMMAND_INPUT_LENGTH = 24_576
const MAX_TASK_MESSAGE_LENGTH = 16_384
type CommandIdentity = readonly [teamId: string, controllerSessionId: string, requestId: string]

export interface YuqiCommandService {
  sendTeamInstruction?(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly authorSessionId: string; readonly target: string; readonly message: string; readonly signal: AbortSignal }): Promise<TeamInstruction>
  resolveTeamController?(controllerSessionId: string, fallbackModel?: Agent['options']): Promise<Agent | undefined>
  recoverDormantProjection?(request: { readonly controllerSessionId: string; readonly teamId: string }): Promise<TeamProjection | undefined>
  controlDormantTeam?(request: {
    readonly controllerSessionId: string
    readonly parentSessionId: string
    readonly teamId: string
    readonly operationId: string
    readonly action: 'cancel' | 'reconcile'
    readonly signal?: AbortSignal
  }): Promise<TeamProjection | undefined>
  pauseTeam(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly immediate?: boolean }): Promise<TeamProjection>
  resumeTeam(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string }): Promise<TeamProjection>
  cancelTeam(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string }): Promise<TeamProjection>
  retryTask(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string }): Promise<TeamProjection>
  stopTask?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string }): Promise<TeamProjection>
  acquireManualTask?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string }): Promise<TeamProjection>
  returnManualTask?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string; readonly acquisitionId: string; readonly summary: string }): Promise<TeamProjection>
  setTaskModel?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly providerId: string; readonly modelId: string; readonly operationId: string }): Promise<TeamProjection>
  setTaskAuthority?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly authorityMode: TeamAuthorityMode; readonly operationId: string }): Promise<TeamProjection>
  setTaskFileScope?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly fileScope: readonly string[]; readonly operationId: string }): Promise<TeamProjection>
  sendTaskMessage?(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly message: string; readonly signal: AbortSignal }): Promise<{ readonly childSessionId: string; readonly messageId: string }>
  reconcileTeam(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly signal?: AbortSignal }): Promise<TeamProjection>
  clearTeamRecovery?(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly target?: 'paused' | 'running'; readonly signal?: AbortSignal }): Promise<TeamProjection>
  recoverAndContinueTeam?(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly signal?: AbortSignal }): Promise<TeamProjection>
  resolveAttempt(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly attemptId: string
    readonly operationId: string
    readonly observationOperationId: string
    readonly decision: 'failed' | 'cancelled'
    readonly signal?: AbortSignal
  }): Promise<TeamProjection>
  readProjectSummary?(projectRoot: string): Promise<ProjectSummary>
  updateProjectSummary?(projectRoot: string, patch: ProjectSummaryPatch): Promise<ProjectSummary>
  recordProjectSummary?(request: { readonly controller: Agent; readonly summary: ProjectSummary }): Promise<void>
  reviewTeam?(request: { readonly controller: Agent; readonly teamId: string; readonly trigger: ReviewTrigger; readonly reviewId?: string; readonly additionalCriteria?: string; readonly signal?: AbortSignal }): Promise<ReviewOutcome>
  decideReview?(request: { readonly controller: Agent; readonly teamId: string; readonly operationId: string; readonly reviewId: string; readonly candidateEventId: string; readonly round: number; readonly decision: ReviewUserDecision; readonly reason?: string }): Promise<TeamProjection>
  rebindTeam?(request: { readonly controller: Agent; readonly teamId: string; readonly parent: Agent; readonly operationId: string }): Promise<void>
}

/** Register only when Harness composes its optional human-command registry. */
export function registerYuqiCommand(ctx: Context, service: YuqiCommandService): void {
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register(createYuqiCommandDefinition(service, (controllerSessionId, fallbackModel) =>
      service.resolveTeamController?.(controllerSessionId, fallbackModel) ?? ctx.agents.get(SessionId(controllerSessionId))))
  })
}

/** Register /yuqi only inside an isolated Team-controller scope. */
export function registerYuqiControllerCommand(ctx: Context): void {
  ctx.inject(['commands', 'yuqiTeamOrchestrator'], commandCtx => {
    const service = ctx.get('yuqiTeamOrchestrator' as never) as YuqiCommandService | undefined
    if (service === undefined) return
    commandCtx.commands.register(createYuqiCommandDefinition(service, (controllerSessionId, fallbackModel) =>
      service.resolveTeamController?.(controllerSessionId, fallbackModel) ?? ctx.agents.get(SessionId(controllerSessionId))))
  })
}

export type YuqiControllerResolver = (
  controllerSessionId: string,
  fallbackModel?: Agent['options'],
) => Agent | undefined | Promise<Agent | undefined>

/** Exported for a contract test without creating a second execution path. */
export function createYuqiCommandDefinition(service: YuqiCommandService, resolveController?: YuqiControllerResolver): CommandDefinition {
  return {
    name: 'yuqi',
    description: '查看或控制当前 Yuqi Team / View or control the current Yuqi Team',
    input: { hint: '[summary|knowledge-refresh|knowledge-delete|knowledge-clear|review|review-decision|attach|pause|resume|cancel|retry|stop|message|model|authority|scope|reconcile|recover|recover-continue|resolve] …' },
    recordInput: false,
    handler: invocation => executeYuqiCommand(invocation, service, resolveController),
  }
}

export async function executeYuqiCommand(invocation: CommandInvocation, service: YuqiCommandService, resolveController?: YuqiControllerResolver): Promise<CommandResult> {
  const fallbackLocale = commandLocale(invocation.agent)
  if (typeof invocation.rawInput !== 'string' || invocation.rawInput.length > MAX_COMMAND_INPUT_LENGTH) return usage(fallbackLocale)
  const args = invocation.rawInput.trim().split(/\s+/u).filter(Boolean)
  const action = args.shift()
  if (action === 'attach') return executeAttachCommand(args, invocation, service, resolveController)
  let projection: TeamProjection
  try {
    projection = projectionFor(invocation.agent)
  } catch {
    return { kind: 'error', text: localized(fallbackLocale, '当前会话没有可用的 Yuqi Team。', 'The current session has no available Yuqi Team.') }
  }
  const locale = projection.team.locale
  if (action === undefined) return { kind: 'success', text: summary(projection) }

  try {
    if (action === 'knowledge-refresh') return await executeKnowledgeRefresh(args, invocation, service, projection, resolveController)
    if (action === 'knowledge-delete' || action === 'knowledge-clear') return await executeKnowledgeCommand(action, args, invocation, service, projection, resolveController)
    if (action === 'summary') return await executeSummaryCommand(args, invocation, service, projection)
    if (action === 'review') return await executeReviewCommand(args, invocation, service, projection, resolveController)
    if (action === 'review-decision') return await executeReviewDecisionCommand(args, invocation, service, projection, resolveController)
    if (action === 'pause' || action === 'resume' || action === 'cancel' || action === 'reconcile') {
      const immediateIndex = args.indexOf('--immediate')
      const immediate = immediateIndex !== -1
      if (immediate) args.splice(immediateIndex, 1)
      if (action === 'reconcile' && args.length === 3 && service.controlDormantTeam === undefined && service.recoverDormantProjection !== undefined) {
        const [teamId, controllerSessionId] = args
        const bound = controllerSessionId === undefined ? undefined : readTeamProjectionEventsForController(invocation.agent.session, controllerSessionId)
        if (teamId !== undefined && controllerSessionId !== undefined && bound !== undefined
          && replayTeamEvents(bound).team.id === teamId) {
          const recovered = await service.recoverDormantProjection({ controllerSessionId, teamId })
          if (recovered?.team.status === 'needs_reconciliation') {
            return { kind: 'success', text: localized(locale,
              `已发现无活动子代理的停滞 Team ${teamId}；状态已转为需处理。`,
              `Found stalled Team ${teamId} with no active child agents; it now requires attention.`) }
          }
        }
      }
      if ((action === 'cancel' || action === 'reconcile') && args.length === 3 && service.controlDormantTeam !== undefined) {
        const dormant = await executeControllerlessControl(action, args, invocation, service, resolveController)
        if (dormant !== undefined) return dormant
      }
      const target = await controlCommandTarget(invocation.agent, projection, args, invocation, resolveController)
      const next = action === 'pause'
        ? await service.pauseTeam({ controller: target.controller, teamId: target.projection.team.id, operationId: target.operationId, immediate })
        : action === 'resume'
          ? await service.resumeTeam({ controller: target.controller, teamId: target.projection.team.id, operationId: target.operationId })
          : action === 'cancel'
            ? await service.cancelTeam({ controller: target.controller, teamId: target.projection.team.id, operationId: target.operationId })
            : await service.reconcileTeam({ controller: target.controller, teamId: target.projection.team.id, operationId: target.operationId, signal: invocation.signal })
      if (action === 'resume' && next.team.status !== 'running' && next.team.status !== 'completed') {
        return { kind: 'error', text: localized(locale,
          `继续未受理：Team 当前仍为 ${next.team.status}。请刷新；若无可派发工作，请先处理失败、阻塞任务或待决审查。`,
          `Continue was not accepted: the Team remains ${next.team.status}. Refresh the Team; if no work is dispatchable, resolve failed/blocked tasks or the pending review decision first.`) }
      }
      if (action === 'resume' && next.team.status === 'running' && next.controlOperations[target.operationId] === undefined) {
        return { kind: 'success', text: localized(locale, 'Team 已在运行，无需再次启动；未重复唤醒或创建操作。请以此当前状态为准。', 'Team is already running; no repeated wake or operation was created. Use this current state.') }
      }
      return { kind: 'success', text: localized(locale,
        `${actionAcknowledgement(action, locale)} Team ${target.projection.team.id}；controller ${String(target.controller.id)}；操作 ${target.operationId}。`,
        `${actionAcknowledgement(action, locale)} Team ${target.projection.team.id}; controller ${String(target.controller.id)}; operation ${target.operationId}.`) }
    }
    if (action === 'recover') {
      const parsed = parseRecoverArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.clearTeamRecovery === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用安全恢复校验。', 'This Host does not support safe recovery verification.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      const next = await service.clearTeamRecovery({
        controller: target.controller, teamId: target.projection.team.id,
        ...(parsed.recoveryTarget === undefined ? {} : { target: parsed.recoveryTarget }),
        operationId: target.operationId, signal: invocation.signal,
      })
      if (parsed.recoveryTarget === 'running' && next.team.status !== 'running' && next.team.status !== 'completed') {
        return { kind: 'error', text: localized(locale,
          `恢复已核验，但 Team 当前仍为 ${next.team.status}，未继续调度。请刷新并先处理失败、阻塞任务或待决审查。`,
          `Recovery was verified, but the Team remains ${next.team.status} and scheduling did not continue. Refresh and resolve failed/blocked tasks or the pending review decision first.`) }
      }
      return { kind: 'success', text: parsed.recoveryTarget === 'running'
        ? localized(locale, '恢复校验已持久化；团队已显式恢复运行。', 'Recovery verification was persisted; the Team explicitly resumed running.')
        : localized(locale, '恢复校验已持久化；团队已安全停在 paused。', 'Recovery verification was persisted; the Team is safely paused.') }
    }
    if (action === 'recover-continue') {
      const parsed = parseRecoverContinueArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.recoverAndContinueTeam === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用主控自动恢复。', 'This Host does not support automatic controller recovery.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      const current = await service.recoverAndContinueTeam({
        controller: target.controller,
        teamId: target.projection.team.id,
        operationId: target.operationId,
        signal: invocation.signal,
      })
      // A command that promises to continue must not be reported as successful
      // merely because reconciliation ran. In particular, a live attempt that
      // the Host cannot safely identify must stay closed in reconciliation;
      // treating that as success makes the Client wait for a state transition
      // that is neither safe nor guaranteed to occur.
      if (current.team.status !== 'running' && current.team.status !== 'completed') {
        return {
          kind: 'error',
          text: current.team.status === 'needs_reconciliation'
            ? localized(locale,
              '恢复尚未完成：仍有执行状态无法安全确认，已保留现场，未恢复团队调度。主控需核对具体未结算任务；请勿连续点击恢复。',
              'Recovery is incomplete: some execution state cannot be safely confirmed. Evidence was preserved and Team scheduling has not resumed. The controller must check the unresolved task; do not repeatedly request recovery.')
            : localized(locale,
              `主控恢复已检查现场，但 Team 当前为 ${current.team.status}，未继续调度。请刷新并先处理失败、阻塞任务或待决审查。`,
              `The controller checked recovery, but the Team is ${current.team.status} and scheduling did not continue. Refresh and resolve failed/blocked tasks or the pending review decision first.`),
        }
      }
      return {
        kind: 'success',
        text: current.team.status === 'completed'
          ? localized(locale, '主控恢复已完成核对；Team 已完成，无需继续调度。', 'The controller completed recovery checks; the Team is already completed, so no further scheduling is needed.')
          : localized(locale, '主控已保留现场、重派可恢复的中断任务，并继续团队调度。', 'The controller preserved the workspace, redispatched recoverable interrupted tasks, and continued Team scheduling.'),
      }
    }
    if (action === 'retry') {
      const parsed = parseRetryArgs(args)
      if (parsed === undefined) return usage(locale)
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      let next = await service.retryTask({
        controller: target.controller,
        teamId: target.projection.team.id,
        taskId: parsed.taskId,
        operationId: target.operationId,
      })
      // The Task panel is a complete recovery action, not a half-command.
      // Retrying a paused Team only makes the task ready; without the matching
      // resume no runner can create the replacement attempt. Use one derived,
      // stable operation identity so an uncertain Client replay stays
      // idempotent across both durable steps.
      if (next.team.status === 'paused') {
        next = await service.resumeTeam({
          controller: target.controller,
          teamId: target.projection.team.id,
          operationId: `${target.operationId}:resume`,
        })
      }
      if (next.team.status !== 'running' && next.team.status !== 'completed') {
        return { kind: 'error', text: localized(locale,
          `重试意图已保留，但 Team 当前为 ${next.team.status}，未继续调度。请刷新后由主控核对状态，不要重复提交。`,
          `The retry intent was preserved, but the Team is ${next.team.status} and scheduling did not continue. Refresh and let the controller reconcile the state; do not submit the operation again.`) }
      }
      return { kind: 'success', text: localized(locale,
        '重试意图已持久化，团队调度已恢复；历史 attempt 保留，请以面板中的新 attempt 为准。',
        'The retry intent was persisted and Team scheduling resumed. Prior attempts remain preserved; use the new attempt in the Team panel as the source of truth.') }
    }
    if (action === 'manual-acquire' || action === 'manual-return') {
      const parsed = action === 'manual-acquire' ? parseRetryArgs(args) : parseMessageArgs(args)
      if (parsed === undefined) return { kind: 'error', text: localized(locale, '接管命令参数无效，请刷新任务后重试。', 'Invalid manual ownership command; refresh the task before retrying.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      if (action === 'manual-acquire') {
        if (service.acquireManualTask === undefined) return { kind: 'error', text: localized(locale, '当前 Host 不支持人工接管。', 'This Host does not support manual takeover.') }
        const next = await service.acquireManualTask({ controller: target.controller, teamId: target.projection.team.id, taskId: parsed.taskId, operationId: target.operationId })
        const held = next.team.manualOwnership
        return { kind: 'success', text: localized(locale,
          held?.state === 'human-owned' ? '人工接管已持久化；整个 Team 暂停，请仅在任务面板显示的工作区操作。' : '该接管请求已经处理；请以最新所有权状态为准。',
          held?.state === 'human-owned' ? 'Manual ownership persisted; the entire Team remains paused. Work only in the workspace shown in the task panel.' : 'This takeover request was already handled; use the latest ownership state.') }
      }
      if (service.returnManualTask === undefined || !('payload' in parsed) || typeof parsed.payload !== 'string') return { kind: 'error', text: localized(locale, '当前 Host 不支持交还。', 'This Host does not support returning ownership.') }
      const value: unknown = JSON.parse(decodeTaskMessage(parsed.payload))
      if (typeof value !== 'object' || value === null || !('acquisitionId' in value) || typeof value.acquisitionId !== 'string'
        || !('summary' in value) || typeof value.summary !== 'string' || value.summary.trim() === '' || value.summary.length > 4000) {
        return { kind: 'error', text: localized(locale, '交还需要有效接管身份和修改摘要。', 'Returning ownership requires a valid acquisition identity and change summary.') }
      }
      const acquisitionId: string = value.acquisitionId
      const summary: string = value.summary
      const next = await service.returnManualTask({ controller: target.controller, teamId: target.projection.team.id, taskId: parsed.taskId, operationId: target.operationId, acquisitionId, summary })
      if (next.team.manualOwnership?.state === 'human-owned') return { kind: 'success', text: localized(locale, '该交还请求已经处理；当前仍有人工持有，请刷新核对最新接管身份。', 'This return request was already handled; manual ownership is still active. Refresh to check the current acquisition identity.') }
      return { kind: 'success', text: localized(locale,
        next.team.status === 'cancelled' ? '已交还；Team 保持已取消，不会恢复执行。' : '已交还；Team 保持暂停。任务及尝试历史保留，继续或重试需显式操作。',
        next.team.status === 'cancelled' ? 'Ownership returned; the Team remains cancelled and will not resume.' : 'Ownership returned; the Team remains paused. Task and attempt history is preserved; continue or retry explicitly.') }
    }
    if (action === 'stop') {
      const parsed = parseRetryArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.stopTask === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用单个子代理停止。', 'This Host does not support stopping an individual child agent.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      await service.stopTask({
        controller: target.controller,
        teamId: target.projection.team.id,
        taskId: parsed.taskId,
        operationId: target.operationId,
      })
      return { kind: 'success', text: localized(locale, `任务 ${parsed.taskId} 的停止请求已持久化；其他独立任务不受影响。`, `The stop request for task ${parsed.taskId} was persisted; other independent tasks are unaffected.`) }
    }
    if (action === 'message') {
      const parsed = parseMessageArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.sendTaskMessage === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用主控消息转发。', 'This Host does not support controller message forwarding.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      const message = decodeTaskMessage(parsed.payload)
      if (service.sendTeamInstruction !== undefined) {
        let receipt: TeamInstruction
        try {
          receipt = await service.sendTeamInstruction({ controller: target.controller, teamId: target.projection.team.id,
            operationId: target.operationId, authorSessionId: String(invocation.agent.id), target: parsed.taskId, message, signal: invocation.signal })
        } catch {
          return { kind: 'error', text: localized(locale,
            `Yuqi MESSAGE_DELIVERY_UNCERTAIN: 消息回执保存或读取未完成，不能认定未投递。请核对请求 ${target.operationId}，不要重发。`,
            `Yuqi MESSAGE_DELIVERY_UNCERTAIN: The receipt could not be saved or read. Non-delivery is not established. Check request ${target.operationId}; do not resend.`) }
        }
        const accepted = receipt.recipients.filter(row => row.status === 'accepted').length
        return { kind: 'success',
          text: localized(locale,
            `补充要求：${message}\n接口受理 ${accepted}/${receipt.recipients.length}；这不代表已处理或已回复。请查看对话中的团队消息记录与对应子对话。请求：${receipt.operationId}`,
            `Instruction: ${message}\nAPI accepted ${accepted}/${receipt.recipients.length}; this does not establish processing or a reply. See Team messages and the target conversations. Request: ${receipt.operationId}`) }
      }
      const taskIds = parsed.taskId === 'all'
        ? Object.values(target.projection.tasks).filter(task => task.status === 'running').map(task => task.contract.taskId)
        : [parsed.taskId]
      if (taskIds.length === 0) return { kind: 'error', text: localized(locale, '当前没有运行中的子代理可接收补充要求。', 'No running child agent can receive additional instructions.') }
      const delivered: string[] = []
      const rejected: string[] = []
      for (const taskId of taskIds) {
        try {
          await service.sendTaskMessage({ controller: target.controller, teamId: target.projection.team.id, taskId, message, signal: invocation.signal })
          delivered.push(taskId)
        } catch {
          rejected.push(taskId)
        }
      }
      if (delivered.length === 0) return { kind: 'error', text: localized(locale, '补充要求未送达；目标任务可能已经结束。', 'The additional instructions were not delivered; the target tasks may have ended.') }
      return { kind: 'success', text: rejected.length === 0
        ? localized(locale, `补充要求已由主控转发给 ${delivered.length} 个运行中的子代理。`, `The controller forwarded the additional instructions to ${delivered.length} running child agent(s).`)
        : localized(locale, `补充要求已送达 ${delivered.length} 个子代理；${rejected.length} 个任务已结束或不可接收。`, `The additional instructions reached ${delivered.length} child agent(s); ${rejected.length} task(s) ended or could not receive them.`) }
    }
    if (action === 'model') {
      const parsed = parseModelArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.setTaskModel === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用任务模型切换。', 'This Host does not support task model switching.') }
      let target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      const controllerProvider = durableCommandProvider(target.projection, target.controller)
      const ambiguousIsStructured = parsed.ambiguous === true && isConfiguredRouteProvider(parsed.providerId!, controllerProvider, target.projection)
      if (parsed.ambiguous === true && !ambiguousIsStructured) {
        target = { ...target, operationId: operationIdFor(parsed.modelId, invocation) }
      }
      const providerId = parsed.providerId === undefined || (parsed.ambiguous === true && !ambiguousIsStructured)
        ? controllerProvider
        : parsed.providerId
      if (providerId === undefined || providerId === '') return { kind: 'error', text: localized(locale, '当前 controller 没有可绑定旧式 modelId 的 provider。', 'The current controller has no provider to bind the legacy modelId.') }
      await service.setTaskModel({
        controller: target.controller,
        teamId: target.projection.team.id,
        taskId: parsed.taskId,
        providerId,
        modelId: parsed.ambiguous === true && !ambiguousIsStructured ? parsed.providerId! : parsed.modelId,
        operationId: target.operationId,
      })
      return { kind: 'success', text: localized(locale, `任务 ${parsed.taskId} 的模型切换已持久化；运行中任务会以新 attempt 安全重启。`, `The model change for task ${parsed.taskId} was persisted; a running task will restart safely with a new attempt.`) }
    }
    if (action === 'scope') {
      const parsed = parseMessageArgs(args)
      // Even controller-local scope edits require the complete rendered identity.
      if (parsed?.identity === undefined) return { kind: 'error', text: '/yuqi scope <taskId> <base64url-json-array> <teamId> <controllerSessionId> <requestId>' }
      if (service.setTaskFileScope === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用任务范围编辑。', 'This Host does not support task scope editing.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, undefined)
      let value: unknown
      try { value = JSON.parse(decodeTaskMessage(parsed.payload)) } catch {
        throw new YuqiOrchestratorError('INVALID_BATCH', 'fileScope payload must be a base64url-encoded JSON array')
      }
      const fileScope = fileScopePatternSchema.array().min(1).max(512).safeParse(value)
      if (!fileScope.success) throw new YuqiOrchestratorError('INVALID_BATCH', 'fileScope requires 1 to 512 project-relative paths/globs')
      await service.setTaskFileScope({ controller: target.controller, teamId: target.projection.team.id,
        taskId: parsed.taskId, fileScope: fileScope.data, operationId: target.operationId })
      return { kind: 'success', text: localized(locale,
        `任务 ${parsed.taskId} 的范围请求已持久化；未新增权限或发送继续请求，请以最新任务范围为准。`,
        `Task ${parsed.taskId} scope request persisted; no permissions were granted and no resume was requested. Use the latest task scope.`) }
    }
    if (action === 'authority') {
      const parsed = parseAuthorityArgs(args)
      if (parsed === undefined) return usage(locale)
      if (service.setTaskAuthority === undefined) return { kind: 'error', text: localized(locale, '当前 Host 未启用任务权限切换。', 'This Host does not support task authority switching.') }
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      await service.setTaskAuthority({
        controller: target.controller,
        teamId: target.projection.team.id,
        taskId: parsed.taskId,
        authorityMode: parsed.authorityMode,
        operationId: target.operationId,
      })
      return { kind: 'success', text: localized(locale, `任务 ${parsed.taskId} 的权限已切换为 ${parsed.authorityMode}；运行中任务会安全重启。`, `Task ${parsed.taskId} authority changed to ${parsed.authorityMode}; a running task will restart safely.`) }
    }
    if (action === 'resolve') {
      const parsed = parseResolveArgs(args)
      if (parsed === undefined) return usage(locale)
      const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
      const observationOperationId = target.projection.latestReconciliationOperationIds[parsed.attemptId]
      if (observationOperationId === undefined) return { kind: 'error', text: localized(locale, '该 attempt 没有可用于人工裁决的最新恢复观察。', 'This attempt has no recent recovery observation available for a manual decision.') }
      await service.resolveAttempt({
        controller: target.controller,
        teamId: target.projection.team.id,
        taskId: parsed.taskId,
        attemptId: parsed.attemptId,
        decision: parsed.decision,
        operationId: target.operationId,
        observationOperationId,
        signal: invocation.signal,
      })
      return { kind: 'success', text: localized(locale, '人工失败/取消结论已持久化；Yuqi 不会把它推断为成功。', 'The manual failed/cancelled decision was persisted; Yuqi will not infer success.') }
    }
    return usage(locale)
  } catch (cause) {
    if (cause instanceof YuqiOrchestratorError) {
      console.error(`[yuqi-team] command ${action} failed (${cause.code}): ${cause.message}`)
      return { kind: 'error', text: commandError(cause, locale) }
    }
    console.error(`[yuqi-team] command ${action} failed (UNEXPECTED_ERROR): ${cause instanceof Error ? cause.message : 'unknown error'}`)
    if (cause instanceof Error && cause.message.startsWith('Project summary')) return { kind: 'error', text: localized(locale,
      `Yuqi UNEXPECTED_ERROR: 项目摘要操作失败；请检查摘要容量及是否包含疑似凭据。原始诊断：${cause.message}`,
      `Yuqi UNEXPECTED_ERROR: ${cause.message}`) }
    return { kind: 'error', text: localized(locale, 'Yuqi UNEXPECTED_ERROR: 操作未受理；请查看目标 Team/controller 后重试。', 'Yuqi UNEXPECTED_ERROR: The operation was not accepted. Check the target Team/controller and retry.') }
  }
}

async function executeKnowledgeRefresh(
  args: string[], invocation: CommandInvocation, service: YuqiCommandService,
  projection: TeamProjection, resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  const locale = projection.team.locale
  if (args.length !== 3 || !args.every(value => REQUEST_ID.test(value))) {
    return { kind: 'error', text: '/yuqi knowledge-refresh <teamId> <controllerSessionId> <requestId>' }
  }
  if (service.readProjectSummary === undefined || service.recordProjectSummary === undefined) {
    return { kind: 'error', text: localized(locale, '当前 Host 未启用项目记忆读取及面板同步；未执行刷新。', 'This Host does not support project knowledge reading and panel synchronization; refresh was not performed.') }
  }
  const target = String(invocation.agent.id) === args[1]
    ? await commandTarget(invocation.agent, projection, invocation, resolveController, undefined, args[2])
    : await commandTarget(invocation.agent, projection, invocation, resolveController, args as unknown as CommandIdentity, undefined)
  const current = replayTeamEvents(readTeamEventsFromSession(target.controller.session))
  if (String(target.controller.id) !== args[1] || current.team.id !== args[0] || current.workspace?.status !== 'ready') {
    throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Project knowledge refresh requires the exact bound Team controller with a ready workspace')
  }
  invocation.signal.throwIfAborted()
  const stored = await service.readProjectSummary(workspaceProjectRoot(current.workspace))
  invocation.signal.throwIfAborted()
  // The service owns rereading the latest disk content and serialized publication.
  // Refresh never invokes the index mutation API.
  await service.recordProjectSummary({ controller: target.controller, summary: stored })
  return { kind: 'success', text: JSON.stringify({
    saved: false, panelSynced: true, teamId: current.team.id, controllerSessionId: String(target.controller.id),
    message: localized(locale, '项目记忆面板已刷新；未修改磁盘索引。', 'Project knowledge panel refreshed; the disk index was not modified.'),
  }) }
}

// Include panel recording in the queue so an older save cannot project after a newer one.
const knowledgeCommands = new WeakMap<YuqiCommandService, Map<string, Promise<void>>>()

async function executeKnowledgeCommand(
  action: 'knowledge-delete' | 'knowledge-clear', args: string[], invocation: CommandInvocation,
  service: YuqiCommandService, projection: TeamProjection, resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  const key = args[3] ?? ''
  const queue = knowledgeCommands.get(service) ?? new Map<string, Promise<void>>()
  knowledgeCommands.set(service, queue)
  const previous = queue.get(key) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  queue.set(key, pending)
  await previous
  try {
    // Resolve identity and workspace after waiting, never trust a pre-queue snapshot.
    return await executeKnowledgeMutation(action, args, invocation, service, projection, resolveController)
  } finally {
    release()
    if (queue.get(key) === pending) queue.delete(key)
  }
}

async function executeKnowledgeMutation(
  action: 'knowledge-delete' | 'knowledge-clear', args: string[], invocation: CommandInvocation,
  service: YuqiCommandService, projection: TeamProjection, resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  const locale = projection.team.locale
  // Both commands require the rendered identity, including controller-local callers.
  const parsed = action === 'knowledge-delete'
    ? projectSummaryRemoveItemSchema.safeParse({ topic: args[0], id: args[1] })
    : projectSummaryClearTopicSchema.safeParse({ topic: args[0], confirmed: args[1] === 'confirm' })
  if (args.length !== 5 || !parsed.success) return knowledgeUsage(locale)
  if (service.updateProjectSummary === undefined || service.recordProjectSummary === undefined) {
    return { kind: 'error', text: localized(locale, '当前 Host 未启用项目记忆更新及面板记录能力；未执行操作。', 'This Host does not support project knowledge updates and panel recording; no operation was performed.') }
  }
  if (!REQUEST_ID.test(args[2]!) || !REQUEST_ID.test(args[3]!)) return knowledgeUsage(locale)
  const target = String(invocation.agent.id) === args[3]
    ? await commandTarget(invocation.agent, projection, invocation, resolveController, undefined, args[4])
    : await commandTarget(invocation.agent, projection, invocation, resolveController, args.slice(2) as unknown as CommandIdentity, undefined)
  const current = replayTeamEvents(readTeamEventsFromSession(target.controller.session))
  if (String(invocation.agent.id) !== args[3]
    && readTeamProjectionEventsForController(invocation.agent.session, args[3]!) === undefined) {
    throw new YuqiOrchestratorError('TEAM_MISMATCH', `已展示的 Team ${args[2]} 不再绑定 controller ${args[3]}`)
  }
  if (String(target.controller.id) !== args[3] || current.team.id !== args[2] || current.workspace?.status !== 'ready') {
    return { kind: 'error', text: localized(locale, 'Yuqi EXECUTION_GATE_REJECTED: 项目记忆操作需要精确绑定且工作区已就绪的 Team 主控。', 'Yuqi EXECUTION_GATE_REJECTED: Project knowledge requires the exact bound Team controller with a ready workspace.') }
  }
  const root = workspaceProjectRoot(current.workspace)
  const patch: ProjectSummaryPatch = 'id' in parsed.data ? { removeItem: parsed.data } : { clearTopic: parsed.data }
  invocation.signal.throwIfAborted()
  const stored = await service.updateProjectSummary(root, patch)
  let panelSynced = true
  try { await service.recordProjectSummary({ controller: target.controller, summary: stored }) }
  catch { panelSynced = false }
  // A projection failure does not undo the file mutation. Report partial success truthfully.
  return { kind: 'success', text: JSON.stringify({
    saved: true, panelSynced, teamId: current.team.id, controllerSessionId: String(target.controller.id),
    message: panelSynced
      ? localized(locale, '项目记忆已更新；仅处理指定分类/条目，未删除会话、源码或关联文档。', 'Project knowledge updated; only the selected category/item was affected. Sessions, source files, and linked documents were not deleted.')
      : localized(locale, '项目记忆已保存，但面板同步失败；请刷新核对，不要将旧面板内容视为未保存。', 'Project knowledge was saved, but panel synchronization failed. Refresh to verify; stale panel content does not mean the save failed.'),
  }) }
}

function knowledgeUsage(locale: TeamLocale): CommandResult {
  return { kind: 'error', text: localized(locale,
    '用法：/yuqi knowledge-delete <architectureDecisions|pitfalls|conventions> <itemId> <teamId> <controllerSessionId> <requestId>；/yuqi knowledge-clear <architectureDecisions|pitfalls|conventions|documentLinks|overallProgress|all> confirm <teamId> <controllerSessionId> <requestId>。仅在用户确认清空该范围后传 confirm（all 为整个项目总览记忆）；不接受文件路径。',
    'Usage: /yuqi knowledge-delete <architectureDecisions|pitfalls|conventions> <itemId> <teamId> <controllerSessionId> <requestId>; /yuqi knowledge-clear <architectureDecisions|pitfalls|conventions|documentLinks|overallProgress|all> confirm <teamId> <controllerSessionId> <requestId>. Supply confirm only after the user confirms clearing that scope (all means the entire project overview memory); file paths are not accepted.') }
}

async function executeReviewDecisionCommand(
  args: string[],
  invocation: CommandInvocation,
  service: YuqiCommandService,
  projection: TeamProjection,
  resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  const parsed = parseReviewDecisionArgs(args)
  if (parsed === undefined) return usage(projection.team.locale)
  if (service.decideReview === undefined) return { kind: 'error', text: localized(projection.team.locale, '当前 Host 未启用 review user decision。', 'This Host does not support review user decisions.') }
  const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, parsed.requestId)
  const next = await service.decideReview({
    controller: target.controller, teamId: target.projection.team.id, operationId: target.operationId,
    reviewId: parsed.reviewId, candidateEventId: parsed.candidateEventId, round: parsed.round,
    decision: parsed.decision, ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
  })
  return { kind: 'success', text: localized(projection.team.locale,
    `Review decision ${parsed.decision} 已持久化；Team ${next.team.id} 当前为 ${next.team.status}。`,
    `Review decision ${parsed.decision} was persisted; Team ${next.team.id} is now ${next.team.status}.`) }
}

async function executeControllerlessControl(
  action: 'cancel' | 'reconcile',
  args: readonly string[],
  invocation: CommandInvocation,
  service: YuqiCommandService,
  resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult | undefined> {
  const [teamId, controllerSessionId, requestId] = args
  if (teamId === undefined || controllerSessionId === undefined || requestId === undefined
    || !REQUEST_ID.test(teamId) || !REQUEST_ID.test(controllerSessionId)) return undefined
  const events = readTeamProjectionEventsForController(invocation.agent.session, controllerSessionId)
  if (events === undefined) return undefined
  const projection = replayTeamEvents(events)
  const locale = projection.team.locale
  if (projection.team.id !== teamId) return undefined
  const controller = await resolveController?.(controllerSessionId, invocation.agent.options)
  if (controller !== undefined) return undefined
  const current = await service.controlDormantTeam?.({
    controllerSessionId,
    parentSessionId: String(invocation.agent.id),
    teamId,
    operationId: operationIdFor(requestId, invocation),
    action,
    signal: invocation.signal,
  })
  if (current === undefined) {
    return { kind: 'error', text: localized(locale, `Team ${teamId} 的 durable controller journal 当前不可用；未执行操作。`, `Team ${teamId}'s durable controller journal is unavailable; no operation was performed.`) }
  }
  if (action === 'cancel') {
    return current.team.status === 'cancelled'
      ? { kind: 'success', text: localized(locale, `Team ${teamId} 已从 durable journal 安全收敛为 cancelled。`, `Team ${teamId} safely converged to cancelled from its durable journal.`) }
      : { kind: 'success', text: localized(locale, `Team ${teamId} 的取消意图已持久化，但运行结果仍未知；请执行 reconcile，不要重复取消。`, `Team ${teamId}'s cancellation intent was persisted, but the runtime result is unknown. Run reconcile; do not cancel again.`) }
  }
  if (current.team.status === 'paused') {
    return { kind: 'success', text: localized(locale, `Team ${teamId} 已确认无未决运行时状态，并从 durable journal 安全清理到 paused；恢复运行仍需精确 controller。`, `Team ${teamId} has no unresolved runtime state and was safely cleared to paused from its durable journal; resuming still requires the exact controller.`) }
  }
  if (current.team.status === 'needs_reconciliation') {
    return { kind: 'success', text: localized(locale, `Team ${teamId} 的 reconciliation 已持久化；未知运行结果保持封闭，未派发、未消息、未验证。`, `Team ${teamId}'s reconciliation was persisted; unknown runtime results remain closed with no dispatch, messaging, or verification.`) }
  }
  return { kind: 'success', text: localized(locale, `Team ${teamId} 的 durable 状态已检查；当前为 ${current.team.status}，未执行运行时操作。`, `Team ${teamId}'s durable state was checked; it is ${current.team.status}, and no runtime operation was performed.`) }
}

async function executeAttachCommand(
  args: string[],
  invocation: CommandInvocation,
  service: YuqiCommandService,
  resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  let locale = commandLocale(invocation.agent)
  if (args.length !== 3 || service.rebindTeam === undefined) return usage(locale)
  const [teamId, controllerSessionId, requestId] = args
  if (teamId === undefined || controllerSessionId === undefined || requestId === undefined
    || !REQUEST_ID.test(teamId) || !REQUEST_ID.test(controllerSessionId) || !REQUEST_ID.test(requestId)) return usage(locale)
  try {
    const controller = await resolveController?.(controllerSessionId)
    if (controller === undefined) return { kind: 'error', text: localized(locale, `Team ${teamId} 的 controller ${controllerSessionId} 当前不可用；未切换。`, `Controller ${controllerSessionId} for Team ${teamId} is unavailable; no switch was made.`) }
    const projection = replayTeamEvents(readTeamEventsFromSession(controller.session))
    locale = projection.team.locale
    if (projection.team.id !== teamId) return { kind: 'error', text: localized(projection.team.locale, `controller ${controllerSessionId} 不属于 Team ${teamId}。`, `controller ${controllerSessionId} does not belong to Team ${teamId}.`) }
    await service.rebindTeam({ controller, teamId, parent: invocation.agent, operationId: operationIdFor(requestId, invocation) })
    return { kind: 'success', text: localized(projection.team.locale, `Team ${teamId} 已切换到当前主控对话；旧对话已失去控制权。`, `Team ${teamId} was moved to the current main conversation; the previous conversation no longer controls it.`) }
  } catch (cause) {
    if (cause instanceof YuqiOrchestratorError) return { kind: 'error', text: commandError(cause, locale) }
    return { kind: 'error', text: localized(locale, 'Yuqi UNEXPECTED_ERROR: 主控对话切换未完成。', 'Yuqi UNEXPECTED_ERROR: The controller conversation switch did not complete.') }
  }
}

async function executeSummaryCommand(
  args: string[],
  invocation: CommandInvocation,
  service: YuqiCommandService,
  projection: TeamProjection,
): Promise<CommandResult> {
  const projectRoot = projection.workspace?.status === 'ready'
    ? workspaceProjectRoot(projection.workspace)
    : invocation.agent.session.header.cwd
  if (projectRoot === undefined || !isAbsolutePath(projectRoot)) return { kind: 'error', text: localized(projection.team.locale, '当前会话没有可用的项目工作目录。', 'The current session has no usable project working directory.') }
  if (service.readProjectSummary === undefined || service.updateProjectSummary === undefined) return { kind: 'error', text: localized(projection.team.locale, '当前 Host 未启用项目摘要文件能力。', 'This Host does not support the project summary file.') }
  const subcommand = args.shift()
  if (subcommand === 'markdown' && args.length === 0) {
    return { kind: 'success', text: renderProjectSummaryMarkdown(await service.readProjectSummary(projectRoot)) }
  }
  if (subcommand === undefined || subcommand === 'read') {
    if (args.length > 0) return usage(projection.team.locale)
    const stored = await service.readProjectSummary(projectRoot)
    await service.recordProjectSummary?.({ controller: invocation.agent, summary: stored })
    return { kind: 'success', text: JSON.stringify({ runtime: runtimeSummary(projection), project: stored }) }
  }
  if (subcommand === 'progress' && args.length > 0) {
    const updated = await service.updateProjectSummary(projectRoot, { overallProgress: args.join(' ') })
    await service.recordProjectSummary?.({ controller: invocation.agent, summary: updated })
    return { kind: 'success', text: JSON.stringify(updated) }
  }
  if (subcommand === 'link' && args.length === 1) {
    const updated = await service.updateProjectSummary(projectRoot, { appendDocumentLink: args[0]! })
    await service.recordProjectSummary?.({ controller: invocation.agent, summary: updated })
    return { kind: 'success', text: JSON.stringify(updated) }
  }
  if (subcommand === 'add' && args.length >= 3) {
    const topic = args.shift()
    const id = args.shift()
    const text = args.join(' ')
    if (topic !== 'architectureDecisions' && topic !== 'pitfalls' && topic !== 'conventions') return usage(projection.team.locale)
    const item = { id: id!, text, links: [] as string[] }
    const updated = await service.updateProjectSummary(projectRoot, { upsertItem: { topic, item } })
    await service.recordProjectSummary?.({ controller: invocation.agent, summary: updated })
    return { kind: 'success', text: JSON.stringify(updated) }
  }
  return usage(projection.team.locale)
}

async function executeReviewCommand(
  args: string[],
  invocation: CommandInvocation,
  service: YuqiCommandService,
  projection: TeamProjection,
  resolveController: YuqiControllerResolver | undefined,
): Promise<CommandResult> {
  const parsed = parseReviewArgs(args)
  if (parsed === undefined) return usage(projection.team.locale)
  if (service.reviewTeam === undefined) return { kind: 'error', text: localized(projection.team.locale, '当前 Host 未启用 reviewer 能力。', 'This Host does not support reviewer runs.') }
  const target = await commandTarget(invocation.agent, projection, invocation, resolveController, parsed.identity, undefined)
  const outcome = await service.reviewTeam({
    controller: target.controller,
    teamId: target.projection.team.id,
    trigger: parsed.trigger,
    ...(parsed.additionalCriteria === undefined ? {} : { additionalCriteria: parsed.additionalCriteria }),
    ...(parsed.reviewId === undefined && parsed.identity === undefined
      ? {}
      : { reviewId: parsed.reviewId ?? target.operationId }),
    signal: invocation.signal,
  })
  return { kind: 'success', text: JSON.stringify(localizedReviewOutcome(outcome, projection.team.locale)) }
}

function projectionFor(agent: Agent): TeamProjection {
  return replayTeamEvents(readTeamProjectionEvents(agent.session))
}

async function controlCommandTarget(
  invocationAgent: Agent,
  currentProjection: TeamProjection,
  args: string[],
  invocation: CommandInvocation,
  resolveController: YuqiControllerResolver | undefined,
): Promise<{ readonly controller: Agent; readonly projection: TeamProjection; readonly operationId: string }> {
  if (args.length <= 1) return commandTarget(invocationAgent, currentProjection, invocation, resolveController, undefined, args[0])
  if (args.length !== 3) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Team 控制命令必须携带 teamId、controllerSessionId 与 requestId')
  return commandTarget(invocationAgent, currentProjection, invocation, resolveController, args as unknown as CommandIdentity, undefined)
}

async function commandTarget(
  invocationAgent: Agent,
  currentProjection: TeamProjection,
  invocation: CommandInvocation,
  resolveController: YuqiControllerResolver | undefined,
  identity: CommandIdentity | undefined,
  requestId: string | undefined,
): Promise<{ readonly controller: Agent; readonly projection: TeamProjection; readonly operationId: string }> {
  // Short forms are controller-local only. A parent projection is a read-only
  // bridge until the Client supplies the exact rendered identity triplet.
  if (identity === undefined) {
    const directEvents = readTeamEventsFromSession(invocationAgent.session)
    if (directEvents.length === 0) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', '父会话必须携带 teamId、controllerSessionId 与 requestId；未执行操作')
    }
    const directProjection = replayTeamEvents(directEvents)
    if (directProjection.team.id !== currentProjection.team.id) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `当前 controller 属于 Team ${directProjection.team.id}，不是 ${currentProjection.team.id}`)
    }
    return { controller: invocationAgent, projection: directProjection, operationId: operationIdFor(requestId, invocation) }
  }
  const [expectedTeamId, controllerSessionId, boundRequestId] = identity
  if (expectedTeamId === undefined || controllerSessionId === undefined || !REQUEST_ID.test(expectedTeamId) || !REQUEST_ID.test(controllerSessionId)) {
    throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Team 或 controller 标识格式无效')
  }
  const events = readTeamProjectionEventsForController(invocationAgent.session, controllerSessionId)
  if (events === undefined) throw new YuqiOrchestratorError('TEAM_MISMATCH', `已展示的 Team ${expectedTeamId} 不再绑定 controller ${controllerSessionId}`)
  const projection = replayTeamEvents(events)
  if (projection.team.id !== expectedTeamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `controller ${controllerSessionId} 当前属于 Team ${projection.team.id}，不是 ${expectedTeamId}`)
  const controller = await resolveController?.(controllerSessionId, invocationAgent.options)
  if (controller === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Team ${expectedTeamId} 的 controller ${controllerSessionId} 当前不可用；未执行操作`)
  const activeParent = readActiveTeamParentBinding(controller.session)?.parentSessionId
  if (activeParent !== undefined && activeParent !== String(invocationAgent.id)) {
    throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${expectedTeamId} 已切换到其他主控对话；当前对话只保留历史记录`)
  }
  return { controller, projection, operationId: operationIdFor(boundRequestId, invocation) }
}

function parseRetryArgs(args: readonly string[]): { readonly taskId: string; readonly identity?: CommandIdentity; readonly requestId?: string } | undefined {
  if (args.length === 1 || args.length === 2) return { taskId: args[0]!, ...(args[1] === undefined ? {} : { requestId: args[1] }) }
  if (args.length === 4) return { taskId: args[0]!, identity: args.slice(1) as unknown as CommandIdentity }
  return undefined
}

function parseMessageArgs(args: readonly string[]): { readonly taskId: string; readonly payload: string; readonly identity?: CommandIdentity; readonly requestId?: string } | undefined {
  if (args.length === 2 || args.length === 3) {
    return { taskId: args[0]!, payload: args[1]!, ...(args[2] === undefined ? {} : { requestId: args[2] }) }
  }
  if (args.length === 5) return { taskId: args[0]!, payload: args[1]!, identity: args.slice(2) as unknown as CommandIdentity }
  return undefined
}

function decodeTaskMessage(payload: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(payload)) throw new YuqiOrchestratorError('INVALID_BATCH', '补充要求编码无效')
  const message = Buffer.from(payload, 'base64url').toString('utf8').trim()
  if (message === '' || message.length > MAX_TASK_MESSAGE_LENGTH) throw new YuqiOrchestratorError('INVALID_BATCH', '补充要求必须包含 1 到 16384 个字符')
  return message
}

function parseModelArgs(args: readonly string[]): {
  readonly taskId: string
  readonly providerId?: string
  readonly modelId: string
  readonly identity?: CommandIdentity
  readonly requestId?: string
  readonly ambiguous?: boolean
} | undefined {
  if (args.length === 2) return { taskId: args[0]!, modelId: args[1]! }
  if (args.length === 3 || args.length === 4) {
    return {
      taskId: args[0]!, providerId: args[1]!, modelId: args[2]!,
      ...(args.length === 3 ? { ambiguous: true } : { requestId: args[3]! }),
    }
  }
  if (args.length === 5) return { taskId: args[0]!, modelId: args[1]!, identity: args.slice(2) as unknown as CommandIdentity }
  if (args.length === 6) return { taskId: args[0]!, providerId: args[1]!, modelId: args[2]!, identity: args.slice(3) as unknown as CommandIdentity }
  return undefined
}

function parseAuthorityArgs(args: readonly string[]): {
  readonly taskId: string
  readonly authorityMode: TeamAuthorityMode
  readonly identity?: CommandIdentity
  readonly requestId?: string
} | undefined {
  if (!TEAM_AUTHORITY_MODES.includes(args[1] as TeamAuthorityMode)) return undefined
  const authorityMode = args[1] as TeamAuthorityMode
  if (args.length === 2 || args.length === 3) {
    return { taskId: args[0]!, authorityMode, ...(args[2] === undefined ? {} : { requestId: args[2] }) }
  }
  if (args.length === 5) return { taskId: args[0]!, authorityMode, identity: args.slice(2) as unknown as CommandIdentity }
  return undefined
}

function parseRecoverArgs(args: readonly string[]): {
  readonly recoveryTarget?: 'paused' | 'running'
  readonly identity?: CommandIdentity
  readonly requestId?: string
} | undefined {
  if (args.length === 0) return {}
  if (args.length <= 2) {
    if (args[0] !== 'paused' && args[0] !== 'running') return undefined
    return { recoveryTarget: args[0], ...(args[1] === undefined ? {} : { requestId: args[1] }) }
  }
  if (args.length === 3) return { identity: args as unknown as CommandIdentity }
  if (args.length === 4 && (args[0] === 'paused' || args[0] === 'running')) {
    return { recoveryTarget: args[0], identity: args.slice(1) as unknown as CommandIdentity }
  }
  return undefined
}

function parseRecoverContinueArgs(args: readonly string[]): {
  readonly identity?: CommandIdentity
  readonly requestId?: string
} | undefined {
  if (args.length === 0) return {}
  if (args.length === 1) return { requestId: args[0]! }
  if (args.length === 3) return { identity: args as unknown as CommandIdentity }
  return undefined
}

function parseResolveArgs(args: readonly string[]): {
  readonly taskId: string
  readonly attemptId: string
  readonly decision: 'failed' | 'cancelled'
  readonly identity?: CommandIdentity
  readonly requestId?: string
} | undefined {
  if ((args.length !== 3 && args.length !== 4 && args.length !== 6) || (args[2] !== 'failed' && args[2] !== 'cancelled')) return undefined
  if (args.length === 6) {
    return { taskId: args[0]!, attemptId: args[1]!, decision: args[2], identity: args.slice(3) as unknown as CommandIdentity }
  }
  return {
    taskId: args[0]!, attemptId: args[1]!, decision: args[2],
    ...(args[3] === undefined ? {} : { requestId: args[3] }),
  }
}

function parseReviewArgs(args: readonly string[]): {
  readonly trigger: ReviewTrigger
  readonly reviewId?: string
  readonly identity?: CommandIdentity
  readonly additionalCriteria?: string
} | undefined {
  if (args.length === 0) return { trigger: 'user-request' }
  if (!isReviewTrigger(args[0])) return undefined
  if (args.length === 1 || args.length === 2) return { trigger: args[0], ...(args[1] === undefined ? {} : { reviewId: args[1] }) }
  if (args.length === 4) return { trigger: args[0], identity: args.slice(1) as unknown as CommandIdentity }
  if (args.length === 5) {
    if (!args[1]!.startsWith('focus:')) return { trigger: args[0], reviewId: args[1]!, identity: args.slice(2) as unknown as CommandIdentity }
    const additionalCriteria = decodeReviewCriteria(args[1]!.slice('focus:'.length))
    return { trigger: args[0], additionalCriteria, identity: args.slice(2) as unknown as CommandIdentity }
  }
  return undefined
}

function decodeReviewCriteria(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', '审查关注点编码无效')
  const criteria = Buffer.from(value, 'base64url').toString('utf8').trim()
  if (criteria === '' || criteria.length > 4_000) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', '审查关注点必须包含 1 到 4000 个字符')
  return criteria
}

function parseReviewDecisionArgs(args: readonly string[]): {
  readonly decision: ReviewUserDecision
  readonly reviewId: string
  readonly candidateEventId: string
  readonly round: number
  readonly reason?: string
  readonly identity?: CommandIdentity
  readonly requestId?: string
} | undefined {
  if (args.length !== 6 && args.length !== 8) return undefined
  const [decision, reviewId, candidateEventId, roundText, encodedReason] = args
  if (!isReviewUserDecision(decision) || reviewId === undefined || candidateEventId === undefined || roundText === undefined || encodedReason === undefined) return undefined
  const round = Number(roundText)
  if (!Number.isInteger(round) || round < 0 || round > 3) return undefined
  const reason = encodedReason === '-' ? undefined : decodeReviewReason(encodedReason)
  if (decision === 'waive' && reason === undefined) return undefined
  return args.length === 8
    ? { decision, reviewId, candidateEventId, round, ...(reason === undefined ? {} : { reason }), identity: args.slice(5) as unknown as CommandIdentity }
    : { decision, reviewId, candidateEventId, round, ...(reason === undefined ? {} : { reason }), requestId: args[5]! }
}

function decodeReviewReason(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Review reason 编码无效')
  const reason = Buffer.from(value, 'base64url').toString('utf8').trim()
  if (reason === '' || reason.length > 2_000) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Review reason 必须包含 1 到 2000 个字符')
  return reason
}

function isReviewUserDecision(value: string | undefined): value is ReviewUserDecision {
  return value === 'retry_review' || value === 'authorize_final_rework' || value === 'waive' || value === 'fail' || value === 'cancel'
}

function operationIdFor(value: string | undefined, invocation: CommandInvocation): string {
  const requestId = value ?? String(invocation.commandId)
  if (!REQUEST_ID.test(requestId)) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'requestId 格式无效')
  return `ui-v1:${requestId}`
}

function durableCommandProvider(projection: TeamProjection, controller: Agent): string | undefined {
  return controller.options?.provider?.trim()
    || projection.team.controllerModel?.provider
    || Object.values(projection.attempts).at(-1)?.modelProvider
}

function isConfiguredRouteProvider(candidate: string, controllerProvider: string | undefined, projection: TeamProjection): boolean {
  if (candidate === controllerProvider) return true
  const scope = projection.team.modelRouting?.providerScope
  return scope?.kind === 'controller-plus-allowlist' && scope.providerAllowlist.includes(candidate)
}

function actionAcknowledgement(action: 'pause' | 'resume' | 'cancel' | 'reconcile', locale: TeamLocale): string {
  if (action === 'pause') return localized(locale, '暂停请求已持久化；已运行的子 Agent 会按安全生命周期收尾。', 'The pause request was persisted; running child agents will finish according to the safe lifecycle.')
  if (action === 'resume') return localized(locale, '继续请求已持久化；调度器会重新检查安全门禁。', 'The resume request was persisted; the scheduler will recheck safety gates.')
  if (action === 'cancel') return localized(locale, '取消请求已持久化；请以团队面板的终态或需对账状态为准。', 'The cancellation request was persisted; use the terminal or reconciliation-required state in the Team panel as the source of truth.')
  return localized(locale, '恢复观察已持久化；任何未知结果仍保持“需确认”。', 'The recovery observation was persisted; every unknown result remains unconfirmed.')
}

function summary(projection: TeamProjection): string {
  return runtimeSummary(projection)
}

function runtimeSummary(projection: TeamProjection): string {
  const tasks = Object.values(projection.tasks)
  const completed = tasks.filter(task => task.status === 'completed').length
  const active = tasks.filter(task => task.status === 'running' || task.status === 'verifying').length
  return localized(projection.team.locale,
    `Yuqi Team：${projection.team.title}\n状态：${projection.team.status}\n任务：${completed}/${tasks.length} 已完成，${active} 进行中`,
    `Yuqi Team: ${projection.team.title}\nStatus: ${projection.team.status}\nTasks: ${completed}/${tasks.length} completed, ${active} active`)
}

function usage(locale: TeamLocale = 'zh'): CommandResult {
  return {
    kind: 'error',
    text: `${knowledgeUsage(locale).text}\n/yuqi knowledge-refresh <teamId> <controllerSessionId> <requestId>\n/yuqi scope <taskId> <base64url-json-array> <teamId> <controllerSessionId> <requestId>\n${localized(locale,
      '用法：/yuqi attach <teamId> <controllerSessionId> <requestId>；/yuqi summary […]；controller 内可用 /yuqi review [trigger] [reviewId]（无参数默认 user-request）、/yuqi review-decision <retry_review|authorize_final_rework|waive|fail|cancel> <reviewId> <candidateEventId> <round> <base64urlReason|-> <requestId>、/yuqi [pause|resume|cancel|reconcile] [requestId]、/yuqi recover [paused|running] [requestId]、/yuqi recover-continue [requestId]、/yuqi retry <taskId> [requestId]、/yuqi stop <taskId> [requestId]、/yuqi message <taskId|all> <payload> [requestId]、/yuqi model <taskId> <providerId> <modelId> [requestId]（旧两参绑定 controller provider）、/yuqi authority <taskId> <read-only|write-authorized|full-access> [requestId]、/yuqi resolve <taskId> <attemptId> <failed|cancelled> [requestId]；父面板命令必须额外携带 teamId、controllerSessionId 与 requestId',
      'Usage: /yuqi attach <teamId> <controllerSessionId> <requestId>; /yuqi summary […]; in a controller use /yuqi review [trigger] [reviewId] (defaults to user-request), /yuqi review-decision <retry_review|authorize_final_rework|waive|fail|cancel> <reviewId> <candidateEventId> <round> <base64urlReason|-> <requestId>, /yuqi [pause|resume|cancel|reconcile] [requestId], /yuqi recover [paused|running] [requestId], /yuqi recover-continue [requestId], /yuqi retry <taskId> [requestId], /yuqi stop <taskId> [requestId], /yuqi message <taskId|all> <payload> [requestId], /yuqi model <taskId> <providerId> <modelId> [requestId] (legacy two-argument form uses the controller provider), /yuqi authority <taskId> <read-only|write-authorized|full-access> [requestId], or /yuqi resolve <taskId> <attemptId> <failed|cancelled> [requestId]. Parent-panel commands must also include teamId, controllerSessionId, and requestId.')}`,
  }
}

function localized(locale: TeamLocale, zh: string, en: string): string {
  return locale === 'en' ? en : zh
}

/** Read presentation context only; this never resolves or changes controller ownership. */
function commandLocale(agent: Agent): TeamLocale {
  try { return projectionFor(agent).team.locale === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}

function commandError(cause: YuqiOrchestratorError, locale: TeamLocale): string {
  // Existing Chinese diagnostics already explain ordinary validation failures.
  if (locale !== 'en' && /[\u3400-\u9fff]/u.test(cause.message)
    && !['CONTROL_RUNTIME_UNCERTAIN', 'RETRY_NOT_ALLOWED', 'FIXED_MODEL_INVALID', 'FIXED_MODEL_UNAVAILABLE'].includes(cause.code)) {
    return `Yuqi ${cause.code}: ${cause.message}`
  }
  const messages: Readonly<Record<string, readonly [string, string]>> = {
    CONTROL_RUNTIME_UNCERTAIN: ['运行结果未知；请刷新后执行 reconcile 核对，不要重复提交操作。', 'The runtime result is unknown. Refresh and run reconcile; do not submit the operation again.'],
    RETRY_NOT_ALLOWED: ['当前不允许重试；请让主控检查任务状态、重试门禁和预算。若为模型失败，可选择其他可用模型后由主控判断是否重试。', 'Retry is not currently allowed. Ask the controller to check task state, retry gates, and budget. For a model failure, another available model may be selected before the controller decides whether to retry.'],
    FIXED_MODEL_INVALID: ['指定模型无效；请告知主控，或选择其他可用的 provider/model。重试仍受现有门禁和预算限制。', 'The selected model is invalid. Inform the controller or select another available provider/model. Existing retry gates and budget still apply.'],
    FIXED_MODEL_UNAVAILABLE: ['指定模型不可用；请告知主控，或选择其他可用的 provider/model。重试仍受现有门禁和预算限制。', 'The selected model is unavailable. Inform the controller or select another available provider/model. Existing retry gates and budget still apply.'],
    TEAM_MISMATCH: ['Team 与主控绑定不匹配；请刷新并在当前绑定的主控对话操作。', 'The Team/controller binding does not match. Refresh and use the currently bound controller conversation.'],
    CONTROL_OPERATION_CONFLICT: ['命令参数或操作身份冲突；请检查参数、requestId 和当前状态。', 'Command arguments or operation identity conflict. Check the arguments, requestId, and current state.'],
    EXECUTION_GATE_REJECTED: ['执行门禁拒绝操作；请检查完整 Team/controller 身份及当前状态。', 'The execution gate rejected the operation. Check the full Team/controller identity and current state.'],
    BUDGET_BLOCKED: ['预算门禁阻止继续执行；请让主控检查预算后再决定下一步。', 'The budget gate blocked execution. Ask the controller to check the budget before proceeding.'],
  }
  const detail: Readonly<Record<string, string>> = {
    'requestId 格式无效': 'Invalid requestId format.',
    'Team 控制命令必须携带 teamId、controllerSessionId 与 requestId': 'Team control commands require teamId, controllerSessionId, and requestId.',
    '父会话必须携带 teamId、controllerSessionId 与 requestId；未执行操作': 'Parent-session commands require teamId, controllerSessionId, and requestId; no operation was performed.',
    'Team 或 controller 标识格式无效': 'Invalid Team or controller identifier format.',
    '补充要求编码无效': 'Invalid additional-instructions encoding.',
    '补充要求必须包含 1 到 16384 个字符': 'Additional instructions must contain 1 to 16384 characters.',
    'Review reason 编码无效': 'Invalid review reason encoding.',
    'Review reason 必须包含 1 到 2000 个字符': 'The review reason must contain 1 to 2000 characters.',
  }
  const copy = messages[cause.code] ?? ['操作未受理；请让主控检查当前状态及原始诊断后决定下一步。', 'The operation was rejected. Ask the controller to check the current state and diagnostics before proceeding.']
  const explanation = localized(locale, copy[0], copy[1])
  const diagnostic = locale === 'en' ? detail[cause.message] ?? cause.message
    .replace(/^当前 controller 属于 Team (.+)，不是 (.+)$/u, 'The current controller belongs to Team $1, not $2.')
    .replace(/^已展示的 Team (.+) 不再绑定 controller (.+)$/u, 'Displayed Team $1 is no longer bound to controller $2.')
    .replace(/^controller (.+) 当前属于 Team (.+)，不是 (.+)$/u, 'Controller $1 currently belongs to Team $2, not $3.')
    .replace(/^Team (.+) 的 controller (.+) 当前不可用；未执行操作$/u, 'Controller $2 for Team $1 is unavailable; no operation was performed.')
    .replace(/^Team (.+) 已切换到其他主控对话；当前对话只保留历史记录$/u, 'Team $1 moved to another controller conversation; this conversation retains history only.') : cause.message
  return `Yuqi ${cause.code}: ${explanation} ${localized(locale, '原始诊断：', 'Diagnostic: ')}${diagnostic}`
}

function localizedReviewOutcome(outcome: ReviewOutcome, locale: TeamLocale): ReviewOutcome {
  if (locale !== 'en' || outcome.status !== 'skipped') return outcome
  const reason = outcome.reason === '简单单任务不强制消耗 reviewer Token'
    ? 'A simple single-task Team does not require reviewer token usage.'
    : outcome.reason === '当前没有两次可核验的连续失败'
      ? 'There are not two verifiable consecutive failures.'
      : outcome.reason === '存在活动中的子 Agent；审查延迟到安全边界'
        ? 'Active child agents are present; review is deferred to a safe boundary.'
        : outcome.reason === 'Team 尚未形成可审查的 durable completion candidate'
          ? 'The Team does not yet have a reviewable durable completion candidate.'
          : outcome.reason
  return { ...outcome, reason }
}

function isReviewTrigger(value: string | undefined): value is ReviewTrigger {
  return value === 'plan-confirmation' || value === 'public-contract-change' || value === 'pre-completion'
    || value === 'consecutive-failure' || value === 'user-request'
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('/')
}
