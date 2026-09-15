import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { createElement } from 'react'
import { FileAuditSessionsContext, FileAuditHistoryContext, type FileAuditHistoryLoader } from './TaskFileAudit.tsx'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { YuqiTeamDock, type YuqiTeamActions, type YuqiTeamDockProps } from './YuqiTeamDock.tsx'
import { TeamSettingsButton, type TeamSettingsButtonInjected } from './TeamSettingsButton.tsx'
import { yuqiNativeDecisionStyles, yuqiTeamStyles } from './styles.ts'
import type { YuqiCommandTarget } from './command-actions.ts'
import type { TeamSettings } from '../domain/team-settings-contract.ts'
import { YUQI_TEAM_PRESET_ID } from './TeamSettingsButton.tsx'
import { type NativeInteractionDetail } from './GlobalTeamAttention.tsx'
import { TeamSessionNavigator, type TeamSessionNavigatorInjected } from './TeamSessionNavigator.tsx'
import { TeamCenter, type TeamCenterInjected } from './TeamCenter.tsx'
import { TeamPresetGuard, type TeamPresetGuardInjected } from './TeamPresetGuard.tsx'
import { requestTeamPanelOpen } from './team-panel-events.ts'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { setChildSessionArchived } from './team-ui-preferences.ts'
import { waitForCommandDelivery, waitForCommandOutcome, YuqiCommandOutcomeError, commandAdmissionError, resolveCommandOutcomeSource } from './command-outcome.ts'
import { TeamHandoffSlot, type TeamHandoffInjected } from './TeamHandoffSlot.tsx'
import { createTeamHandoffAdapter, openHandoffTarget } from './team-handoff-adapter.ts'
import { createSidecarStore } from './sidecar-store.ts'
import { SidecarStatus } from './SidecarStatus.tsx'
import { TeamInstructionHistory } from './TeamInstructionHistory.tsx'
import { hasInstructionDeliveryEvidence } from './instruction-delivery-evidence.ts'
import { FileAuditSidecarContext } from './TaskFileAudit.tsx'
import { hostClientApi } from './host-client-api.ts'
import { getYuqiLocale } from './client-locale.ts'
import { createTeamContinuationAdapter, TeamContinuationContext } from './team-continuation.ts'
import { resolveTeamParentWithFallback } from './team-parent-session.ts'
import { sessionPreset } from './session-preset.ts'
import { CLIENT_BASE_SERVICES, withClientServiceScope } from './client-service-scope.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean }
    }
    /** Root-scoped additive surface declared by the application shell. */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
  }
}

const TEAM_SETTINGS_NAMESPACE = 'yuqi-team-orchestrator'

export const inject = CLIENT_BASE_SERVICES

export function apply(ctx: ClientContext): void {
  withClientServiceScope(ctx, installClient)
}

function installClient(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'yuqi-team-orchestrator'
    style.textContent = `${yuqiTeamStyles}\n${yuqiNativeDecisionStyles}`
    document.head.append(style)
    return () => style.remove()
  }, 'yuqi-team-orchestrator: styles')

  const teamSettings = ctx.settingsScope.bind<TeamSettings>({ namespace: TEAM_SETTINGS_NAMESPACE })
  const api = hostClientApi(ctx)
  const sidecar = createSidecarStore((ctx.get('connection') as unknown as ConnectionHandle).rpc, ctx.sessions)
  const sendContinuation = createTeamContinuationAdapter(api, {
    ready: () => sidecar.getSnapshot().status === 'ready', summary: id => sidecar.summary(id),
    resolveParent: (controllerId, teamId) => resolveTeamParentWithFallback(ctx.sessions, controllerId, teamId,
      () => sidecar.resolveParent(teamId, controllerId)),
    openParent: id => { ctx.sessions.open(id as SessionId) },
  }, { getItem: key => sessionStorage.getItem(key), setItem: (key, value) => sessionStorage.setItem(key, value), removeItem: key => sessionStorage.removeItem(key) })
  ctx.effect(() => { void sidecar.refresh(); return sidecar.dispose }, 'yuqi-team-orchestrator: sidecar')
  const teamScopeContext = { rpc: (ctx.get('connection') as unknown as ConnectionHandle).rpc, sessions: ctx.sessions.list }
  const loadFileAuditHistory: FileAuditHistoryLoader = async (id, beforeSeq, signal) => {
    const sessionId = id as SessionId
    const address = ctx.sessions.subagentAddress(sessionId)
    const page = { maxMessages: 50, ...(beforeSeq === undefined ? {} : { beforeSeq }) }
    const response = address === undefined
      ? await api.sessions.history({ sessionId, ...page }, signal)
      : await api.subagents.history({ ...address, ...page }, signal)
    if (!response.result.ok) throw new Error('File audit history unavailable')
    return response.result.value
  }
  const AuditedTeamDock = (props: YuqiTeamDockProps) => createElement(FileAuditSessionsContext.Provider,
    { value: ctx.sessions }, createElement(FileAuditHistoryContext.Provider,
      { value: loadFileAuditHistory }, createElement(FileAuditSidecarContext.Provider,
        { value: sidecar }, createElement(TeamContinuationContext.Provider, { value: sendContinuation }, createElement(YuqiTeamDock, props)))))


  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'yuqi-team-handoff',
    order: 20,
    inject: (): TeamHandoffInjected => ({
      catalog: sidecar.catalog,
      dataReady: () => sidecar.getSnapshot().status === 'ready',
      createHandoff: createTeamHandoffAdapter(ctx, api, sidecar),
      openTarget: sessionId => openHandoffTarget(ctx, sessionId),
    }),
  }, TeamHandoffSlot))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'yuqi-team-session-navigator',
    order: 21,
    inject: (): TeamSessionNavigatorInjected => ({
      catalog: sidecar.catalog,
      openChild: (controllerSessionId, childSessionId, diagnostic) => openTeamChild(ctx, controllerSessionId, childSessionId, diagnostic),
      openMain: sessionId => openTeamCenterSession(ctx, sessionId),
      archiveChild: (teamId, childSessionId) => archiveTeamChild(ctx, teamId, childSessionId),
    }),
  }, TeamSessionNavigator))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'yuqi-team',
    order: 15,
    inject: (sessionId: SessionId): YuqiTeamActions => ({
      recoverTarget: (teamId, controllerSessionId) => sidecar.recoverTarget(teamId, controllerSessionId),
      teamProjection: {
        getSnapshot: () => sidecar.summary(sessionId),
        subscribe: listener => {
          let legacy = () => {}
          let legacyActive = false
          const bindLegacy = () => {
            const state = sidecar.getSnapshot()
            const allowed = state.status === 'ready' && (state.mode === 'legacy' || state.legacy.has(sessionId))
            if (allowed === legacyActive) return
            legacy()
            legacyActive = allowed
            legacy = allowed ? dynamicTeamProjection(ctx, sessionId).subscribe(listener) : () => {}
          }
          bindLegacy()
          const off = sidecar.subscribe(() => { bindLegacy(); listener() })
          return () => { off(); legacy() }
        },
      },
      nativeAttention: {
        getSnapshot: () => {
          const summary = sidecar.summary(sessionId)
          const controllerId = summary?.controllerSessionId
          if (controllerId === undefined) return 0
          return sidecar.catalog.getSnapshot().ids.reduce((count, id) => {
            const row = sidecar.catalog.getSnapshot().byId[id]
            if (row?.pendingInteraction === undefined || (id !== sessionId && String(row.id) !== controllerId && String(row.parentId ?? '') !== controllerId)) return count
            return count + 1
          }, 0)
        },
        subscribe: listener => {
          const offCatalog = sidecar.catalog.subscribe(listener)
          const offSessions = ctx.sessions.list.subscribe(listener)
          return () => { offCatalog(); offSessions() }
        },
      },
      loadModels: async () => {
        const response = await api.sessions.models({ sessionId })
        if (!response.result.ok) throw new Error(response.result.error.message)
        return response.result.value.groups.flatMap(group => group.models.map(model => ({
          id: model.id,
          name: model.name,
          providerId: group.id,
          providerName: group.name,
        })))
      },
      disablePlanConfirmation: async () => {
        try {
          await teamSettings.set('requirePlanConfirmation', false)
          return teamSettings.getSnapshot()?.value?.requirePlanConfirmation === false
        } catch {
          return false
        }
      },
      onOpenChild: (controllerSessionId, childSessionId) => openTeamChild(ctx, controllerSessionId, childSessionId),
      onArchiveChild: (teamId, childSessionId) => archiveTeamChild(ctx, teamId, childSessionId),
      onArchiveController: async controllerSessionId => {
        try {
          await ctx.workspaces.archiveSession(controllerSessionId as SessionId)
          return true
        } catch {
          return false
        }
      },
      command: async (line, target) => {
        let deliveryStarted = false
        let preflightStage: Parameters<typeof commandAdmissionError>[0] = 'binding-read-failed'
        try {
          const session = ctx.sessions.binding(sessionId)?.session
          if (session === undefined) throw commandAdmissionError('session-unavailable')
          preflightStage = 'sidecar-read-failed'
          if (sidecar.getSnapshot().status !== 'ready') throw commandAdmissionError('sidecar-not-ready')
          preflightStage = 'identity-read-failed'
          const boundLine = bindPanelCommand(line, target, sidecar.summary(sessionId))
          if (boundLine === undefined) throw commandAdmissionError('target-mismatch')
          preflightStage = 'snapshot-read-failed'
          const outcomeSource = resolveCommandOutcomeSource(ctx.get('uiConversation' as never), String(sessionId), session)
          const snapshot = outcomeSource.getSnapshot()
          const previousCommandIds = new Set(snapshot.nodes
            .filter(node => node.kind === 'command')
            .map(node => node.commandId)
            .filter((id): id is string => typeof id === 'string'))
          deliveryStarted = true
          const result = await waitForCommandDelivery(session.command(boundLine))
          if (!result.ok) throw commandAdmissionError('rpc-error')
          if (!result.value.matched) throw commandAdmissionError('unmatched')
          // The public conversation view contains command/run + command/done.
          // Wait for this exact request instead of mistaking RPC matching for success.
          const succeeded = boundLine.startsWith('/yuqi ') ? await waitForCommandOutcome(outcomeSource, boundLine, { previousCommandIds }) : true
          void sidecar.refresh(true)
          return succeeded
        } catch (cause) {
          if (cause instanceof YuqiCommandOutcomeError) throw cause
          // A transport exception does not establish negative admission for
          // any command, including start/resume/cancel, not only messages.
          throw commandAdmissionError(deliveryStarted ? 'delivery-unknown' : preflightStage)
        }
      },
    }),
  }, AuditedTeamDock))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'yuqi-team-preset-guard',
    order: 29,
    inject: (): TeamPresetGuardInjected => ({
      presetId: YUQI_TEAM_PRESET_ID,
      presetName: 'yuqi团队',
      sessions: {
        // useSyncExternalStore requires referentially stable snapshots between
        // notifications. The native list already has the required fields;
        // wrapping it in a new object on every read causes React error #185.
        getSnapshot: ctx.sessions.list.getSnapshot as TeamPresetGuardInjected['sessions']['getSnapshot'],
        subscribe: listener => ctx.sessions.list.subscribe(listener),
      },
    }),
  }, TeamPresetGuard))

  const settingsProps = teamSettingsProps()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'yuqi-team-center',
    order: 31,
    inject: (): TeamCenterInjected => ({
      sessions: sidecar.catalog,
      teamData: sidecar,
      getNativeInteractions: sessionId => nativeInteractionsFor(ctx, sessionId),
      subscribeNativeInteractions: (sessionId, listener) => ctx.sessions.binding(sessionId)?.session.subscribe(listener) ?? (() => undefined),
      attachToCurrent: async (summary, currentSessionId) => {
        const catalog = sidecar.catalog.getSnapshot()
        const current = catalog.byId[currentSessionId]
        const source = catalog.ids.map(id => catalog.byId[id]).find(row => {
          const latest = row?.projectionValues?.yuqiTeam
          return latest?.team.id === summary.team.id && latest.controllerSessionId === summary.controllerSessionId
        })
        const normalize = (path: string | undefined) => path?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
        if (sidecar.getSnapshot().status !== 'ready' || catalog.current !== currentSessionId
          || !current || current.parentId !== undefined || sessionPreset(current) !== YUQI_TEAM_PRESET_ID
          || !source || source.id === currentSessionId || !current.cwd || normalize(current.cwd) !== normalize(source.cwd)
          || summary.controllerSessionId === undefined) return false
        const session = ctx.sessions.binding(currentSessionId)?.session
        if (!session) return false
        const requestId = `attach-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const line = `/yuqi attach ${summary.team.id} ${summary.controllerSessionId} ${requestId}`
        const outcomeSource = resolveCommandOutcomeSource(ctx.get('uiConversation' as never), String(currentSessionId), session)
        const previousCommandIds = new Set(outcomeSource.getSnapshot().nodes.filter(node => node.kind === 'command').map(node => node.commandId).filter((id): id is string => typeof id === 'string'))
        try {
          const result = await waitForCommandDelivery(session.command(line))
          if (!result.ok) throw commandAdmissionError('rpc-error')
          if (!result.value.matched) throw commandAdmissionError('unmatched')
          const succeeded = await waitForCommandOutcome(outcomeSource, line, { previousCommandIds })
          void sidecar.refresh(true)
          return succeeded
        } catch (cause) {
          if (cause instanceof YuqiCommandOutcomeError) throw cause
          throw commandAdmissionError('delivery-unknown')
        }
      },
      openMain: sessionId => openTeamCenterSession(ctx, sessionId),
      openChild: (controllerSessionId, childSessionId) => openTeamChild(ctx, controllerSessionId, childSessionId),
      archiveChild: (teamId, childSessionId) => archiveTeamChild(ctx, teamId, childSessionId),
      wrapHistory: panel => createElement(FileAuditSessionsContext.Provider, { value: ctx.sessions },
        createElement(FileAuditHistoryContext.Provider, { value: loadFileAuditHistory },
          createElement(FileAuditSidecarContext.Provider, { value: sidecar }, createElement(TeamContinuationContext.Provider, { value: sendContinuation }, panel)))),
      renderSettings: onDraftStateChange => createElement(TeamSettingsButton, {
        ...settingsProps, embedded: true, onDraftStateChange,
      }),
    }),
  }, TeamCenter))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'yuqi-team-sidecar-status', order: 28,
    inject: () => ({ store: sidecar }),
  }, SidecarStatus))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'yuqi-instruction-history', order: 14,
    inject: (sessionId: SessionId) => ({ sessionId: String(sessionId), store: sidecar,
      openChild: (controllerId: string, childId: string) => openTeamChild(ctx, controllerId, childId, true),
      checkDelivery: async (controllerId: string, childId: string, messageId: string) => {
        const address = await freshTeamChildAddress(ctx, controllerId as SessionId, childId as SessionId)
        if (address === undefined) throw new Error('Child conversation address unavailable')
        const response = await api.subagents.history({ ...address, maxMessages: 50 }, new AbortController().signal)
        if (!response.result.ok) throw new Error('Child history unavailable')
        return hasInstructionDeliveryEvidence(response.result.value.events.map(entry => entry.event), messageId)
      },
    }),
  }, TeamInstructionHistory))

  // Settings use the existing scope and catalog loader inside the management
  // surface; there is only one form and one settings event subscriber.
  function teamSettingsProps(): TeamSettingsButtonInjected & { readonly sessionId: SessionId } {
    return {
      teamSettings,
      scopeContext: teamScopeContext,
      // loadOptions resolves the live Session at open time. The prop remains a
      // harmless placeholder so the stable root host does not capture a stale
      // conversation identity across navigation.
      sessionId: '' as SessionId,
      loadOptions: async (requestedSessionId: string) => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const presetRequest = api.agentPresets.list({})
        const candidateSessionIds = requestedSessionId !== '' ? [requestedSessionId as SessionId] : [...new Set([
          ...(snapshot.current === undefined ? [] : [snapshot.current]),
          ...snapshot.ids,
        ])]
        let modelResponse: Awaited<ReturnType<typeof api.sessions.models>> | undefined
        let modelError: Error | undefined
        let catalogSessionId: string | undefined
        // Global settings must not be held hostage by one stale or
        // forward-incompatible conversation. Try another visible Session
        // before declaring the whole model catalog unavailable.
        for (const candidateSessionId of candidateSessionIds) {
          try {
            const response = await api.sessions.models({ sessionId: candidateSessionId })
            if (response.result.ok) {
              modelResponse = response
              catalogSessionId = candidateSessionId
              break
            }
            modelError = new Error(response.result.error.message)
          } catch (error) {
            modelError = error instanceof Error ? error : new Error(String(error))
          }
        }
        const presetResponse = await presetRequest
        if (!presetResponse.result.ok) throw new Error(presetResponse.result.error.message)
        if (candidateSessionIds.length > 0 && modelResponse === undefined) throw modelError ?? new Error('model catalog unavailable')
        return {
          presets: presetResponse.result.value.presets
            .filter(preset => preset.broken === undefined && preset.id !== YUQI_TEAM_PRESET_ID)
            .map(preset => ({ id: preset.id, name: preset.name, description: preset.description })),
          providerGroups: modelResponse?.result.ok === true
            ? modelResponse.result.value.groups.map(group => ({
              id: group.id,
              name: group.name,
              models: group.models.map(model => ({ id: model.id, name: model.name })),
            }))
            : [],
          failures: modelResponse?.result.ok === true ? modelResponse.result.value.failures : [],
          routable: modelResponse?.result.ok === true ? modelResponse.result.value.routable : false,
          currentRoute: modelResponse?.result.ok === true && catalogSessionId === (requestedSessionId || snapshot.current)
            ? { modelProvider: modelResponse.result.value.current.provider, modelId: modelResponse.result.value.current.model }
            : undefined,
        }
      },
    }
  }
}

const nativeInteractionCaches = new WeakMap<object, Map<string, { readonly source: readonly unknown[]; readonly details: readonly NativeInteractionDetail[] }>>()

function nativeInteractionsFor(ctx: ClientContext, sessionId: SessionId): readonly NativeInteractionDetail[] {
  const pending = ctx.sessions.binding(sessionId)?.session.getSnapshot().pending ?? []
  let cache = nativeInteractionCaches.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    nativeInteractionCaches.set(ctx, cache)
  }
  const cached = cache.get(String(sessionId))
  if (cached?.source === pending) return cached.details
  const details: readonly NativeInteractionDetail[] = pending.map(wait => {
    if (wait.kind === 'approval') return {
      key: wait.key,
      kind: 'approval' as const,
      toolName: wait.payload.toolName,
      ...(wait.payload.reason === undefined ? {} : { reason: wait.payload.reason }),
      respond: async (answer: Parameters<NativeInteractionDetail['respond']>[0]) => {
        if (answer !== 'allowed-once' && answer !== 'rejected') return { accepted: false as const, reason: 'bad-response' as const }
        try {
          return await wait.respond({
            ok: true,
            value: { sessionId: wait.sessionId, approvalId: wait.payload.approvalId, outcome: answer },
          })
        } catch {
          return { accepted: false as const, reason: 'transport-error' as const }
        }
      },
    }
    const planQuestion = wait.payload.questions.length === 1 && wait.payload.questions[0]?.intent?.kind === 'plan-review'
      ? wait.payload.questions[0]
      : undefined
    return {
      key: wait.key,
      kind: planQuestion === undefined ? 'question' as const : 'plan-review' as const,
      questions: wait.payload.questions,
      ...(planQuestion === undefined ? {} : { approveLabel: planQuestion.intent!.approve }),
      respond: async (answer: Parameters<NativeInteractionDetail['respond']>[0]) => {
        if (typeof answer === 'string') return { accepted: false as const, reason: 'bad-response' as const }
        try {
          return await wait.respond({ ok: true, value: { sessionId: wait.sessionId, answer } })
        } catch {
          return { accepted: false as const, reason: 'transport-error' as const }
        }
      },
    }
  })
  cache.set(String(sessionId), { source: pending, details })
  return details
}

async function archiveTeamChild(ctx: ClientContext, teamId: string, childSessionId: string): Promise<boolean> {
  try {
    await ctx.workspaces.archiveSession(childSessionId as SessionId)
    setChildSessionArchived(teamId, childSessionId, true)
    return true
  } catch {
    return false
  }
}


/** Management history may point to a hidden controller, not a root conversation. */
export async function openTeamCenterSession(ctx: Pick<ClientContext, 'sessions'>, sessionId: SessionId): Promise<boolean> {
  const navigation = beginTeamNavigation(ctx.sessions)
  try {
    const row = ctx.sessions.list.getSnapshot().byId[sessionId]
    const address = ctx.sessions.subagentAddress(sessionId)
    // A legacy public root may itself be the controller; identity equality
    // does not establish a child transport.
    const child = row?.parentId !== undefined || String(sessionId).startsWith('yuqi-team-') || address !== undefined
    if (child) {
      const parentId = row?.parentId ?? address?.parentSessionId
      if (parentId === undefined) return false
      const freshAddress = await freshTeamChildAddress(ctx, parentId, sessionId)
      if (freshAddress === undefined || !isCurrentTeamNavigation(ctx.sessions, navigation)) return false
      const current = ctx.sessions.list.getSnapshot().byId[sessionId]
      if (current?.parentId !== row?.parentId) return false
      ctx.sessions.openSubagent(freshAddress)
    } else {
      if (!isCurrentTeamNavigation(ctx.sessions, navigation)) return false
      ctx.sessions.open(sessionId)
    }
    return true
  } catch {
    return false
  }
}

class TeamChildNavigationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'YuqiTeamChildNavigationError'
  }
}

export async function openTeamChild(ctx: ClientContext, controllerSessionId: string | undefined, childSessionId: string, diagnostic = false): Promise<boolean> {
  const navigation = beginTeamNavigation(ctx.sessions)
  try {
    if (controllerSessionId === undefined) throw new TeamChildNavigationError('controller-missing', '未找到 Team 控制器身份，无法定位此子代理会话。')
    const id = childSessionId as SessionId
    const address = await freshTeamChildAddress(ctx, controllerSessionId as SessionId, id)
    if (!isCurrentTeamNavigation(ctx.sessions, navigation)) return false
    ctx.sessions.openSubagent(address)
    return true
  } catch (error) {
    if (diagnostic) {
      if (error instanceof TeamChildNavigationError) throw error
      throw new TeamChildNavigationError('open-failed', 'Host 未能打开该子代理会话；请刷新 Team 状态后重试。')
    }
    return false
  }
}

/** Resolve native direct-parent authority before navigation, reusing ready catalogs.
 * Retained addresses only exist after navigation; they are not a prerequisite
 * for opening durable transcripts after restart. Failed refreshes retain old
 * entries, so only a ready catalog can provide a newly discovered address.
 */
async function freshTeamChildAddress(ctx: Pick<ClientContext, 'sessions'>, parentSessionId: SessionId, childSessionId: SessionId) {
  const retained = ctx.sessions.subagentAddress(childSessionId)
  if (retained !== undefined) {
    if (retained.parentSessionId !== parentSessionId) throw new TeamChildNavigationError('parent-mismatch', '子代理地址与当前 Team 控制器不匹配，已阻止跳转。')
    const mode: unknown = retained.mode // Older native catalogs may omit this field.
    if (mode === 'one-shot' || mode === 'continuable') return retained
    if (mode !== undefined) throw new TeamChildNavigationError('mode-unsupported', '该子代理会话不支持当前的导航方式。')
  }
  const cached = readyTeamChildAddress(ctx, parentSessionId, childSessionId)
  if (cached !== undefined) return cached
  const deadline = Date.now() + 15_000
  // A Team controller is itself commonly a hidden child of the user's public
  // conversation. DSH does not expose that controller's child catalog until
  // its direct parent catalog has materialized the controller address. Do not
  // synthesize either address: refresh and verify the exact direct edge first.
  await materializeNativeParent(ctx, parentSessionId, deadline)
  // Bound the navigation wait, not the shared catalog RPC. A late response may
  // update the catalog but must never navigate after this request has failed.
  // DSH coalesces concurrent catalog reads. Once one has exceeded this
  // navigation request's deadline, re-awaiting that same unresolved promise
  // would make every retry wait another 15 seconds. Keep the timeout local,
  // and let a later catalog notification/cache be the authority instead.
  await refreshNativeChildCatalog(ctx, parentSessionId, deadline, '子代理目录')
  const refreshed = ctx.sessions.subagentAddress(childSessionId)
  if (refreshed !== undefined) {
    if (refreshed.parentSessionId !== parentSessionId) throw new TeamChildNavigationError('parent-mismatch', '刷新后的子代理地址与当前 Team 控制器不匹配，已阻止跳转。')
    const mode: unknown = refreshed.mode
    if (mode === 'one-shot' || mode === 'continuable') return refreshed
    if (mode !== undefined) throw new TeamChildNavigationError('mode-unsupported', '该子代理会话不支持当前的导航方式。')
  }
  const ready = readyTeamChildAddress(ctx, parentSessionId, childSessionId)
  if (ready !== undefined) return ready
  throw childCatalogNavigationError(ctx, parentSessionId, childSessionId)
}

/** Materialize a hidden controller from its exact native direct parent before reading its children. */
async function materializeNativeParent(ctx: Pick<ClientContext, 'sessions'>, parentSessionId: SessionId, deadline: number): Promise<void> {
  if (ctx.sessions.subagentAddress(parentSessionId) !== undefined) return
  const row = ctx.sessions.list.getSnapshot().byId[parentSessionId]
  const directParentId = row?.parentId
  if (directParentId === undefined) return // The Team controller is a public root.
  await refreshNativeChildCatalog(ctx, directParentId, deadline, '控制器父会话目录')
  const controller = ctx.sessions.subagentAddress(parentSessionId)
  // When DSH registers the controller as a native subagent, verify its edge and mode.
  // When the controller was created without origin: 'subagent' (as by controller-launcher),
  // it is a standalone session rather than a subagent of the user conversation, so controller
  // is undefined; child navigation proceeds directly using the controller's own subagent catalog.
  if (controller !== undefined) {
    if (controller.parentSessionId !== directParentId) throw new TeamChildNavigationError('controller-parent-mismatch', '控制器地址与其父会话目录不匹配，已阻止跳转。')
    if (controller.mode !== 'one-shot' && controller.mode !== 'continuable') throw new TeamChildNavigationError('mode-unsupported', 'Team 控制器不支持当前的导航方式。')
  }
}

async function refreshNativeChildCatalog(ctx: Pick<ClientContext, 'sessions'>, parentSessionId: SessionId, deadline: number, label: string): Promise<void> {
  if (hasTimedOutCatalogRefresh(ctx.sessions, parentSessionId)) throw new TeamChildNavigationError('catalog-pending', `${label}仍在刷新中，请稍后重试。`)
  let refresh: Promise<unknown>
  try {
    refresh = ctx.sessions.refreshSubagents(parentSessionId)
  } catch {
    throw new TeamChildNavigationError('catalog-refresh-failed', `${label}刷新失败，暂不能定位子代理。`)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      refresh.then(() => 'ready' as const, () => 'failed' as const),
      new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())) }),
    ])
    if (outcome === 'failed') throw new TeamChildNavigationError('catalog-refresh-failed', `${label}刷新失败，暂不能定位子代理。`)
    if (outcome === 'timeout') {
      rememberTimedOutCatalogRefresh(ctx.sessions, parentSessionId, refresh)
      throw new TeamChildNavigationError('catalog-timeout', `${label}刷新超时，暂不能定位子代理。`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function childCatalogNavigationError(ctx: Pick<ClientContext, 'sessions'>, parentSessionId: SessionId, childSessionId: SessionId): TeamChildNavigationError {
  const catalog = ctx.sessions.list.getSnapshot().subagentsByParent?.[parentSessionId]
  if (catalog?.error != null) return new TeamChildNavigationError('catalog-refresh-failed', '子代理目录刷新失败，暂不能定位子代理。')
  if (catalog?.state !== 'ready') return new TeamChildNavigationError('catalog-not-ready', '子代理目录尚未就绪，暂不能定位子代理。')
  const matches = catalog.entries.filter(entry => entry.id === childSessionId)
  if (matches.length === 0) return new TeamChildNavigationError('child-not-found', '该子代理尚未出现在 Team 控制器目录中。')
  if (matches.length !== 1) return new TeamChildNavigationError('child-ambiguous', '子代理目录存在重复记录，已阻止跳转。')
  const entry = matches[0]!
  if (entry.kind !== 'child') return new TeamChildNavigationError('child-invalid', '子代理目录返回了无效记录，已阻止跳转。')
  if (entry.mode !== 'one-shot' && entry.mode !== 'continuable') return new TeamChildNavigationError('mode-unsupported', '该子代理会话不支持当前的导航方式。')
  const parent = ctx.sessions.list.getSnapshot().byId[childSessionId]?.parentId
  return parent !== undefined && parent !== parentSessionId
    ? new TeamChildNavigationError('parent-mismatch', '子代理地址与当前 Team 控制器不匹配，已阻止跳转。')
    : new TeamChildNavigationError('catalog-not-ready', '子代理目录尚未提供可导航地址。')
}

const timedOutCatalogRefreshes = new WeakMap<object, Map<string, Promise<unknown>>>()
const teamNavigationIntents = new WeakMap<object, symbol>()

function hasTimedOutCatalogRefresh(sessions: object, parentSessionId: SessionId): boolean {
  return timedOutCatalogRefreshes.get(sessions)?.has(String(parentSessionId)) === true
}

function rememberTimedOutCatalogRefresh(sessions: object, parentSessionId: SessionId, refresh: Promise<unknown>): void {
  let timedOut = timedOutCatalogRefreshes.get(sessions)
  if (timedOut === undefined) {
    timedOut = new Map()
    timedOutCatalogRefreshes.set(sessions, timedOut)
  }
  const key = String(parentSessionId)
  timedOut.set(key, refresh)
  void refresh.then(
    () => { if (timedOut?.get(key) === refresh) timedOut.delete(key) },
    () => { if (timedOut?.get(key) === refresh) timedOut.delete(key) },
  )
}

function beginTeamNavigation(sessions: object): symbol {
  const intent = Symbol('yuqi-team-navigation')
  teamNavigationIntents.set(sessions, intent)
  return intent
}

function isCurrentTeamNavigation(sessions: object, intent: symbol): boolean {
  return teamNavigationIntents.get(sessions) === intent
}

function readyTeamChildAddress(ctx: Pick<ClientContext, 'sessions'>, parentSessionId: SessionId, childSessionId: SessionId) {
  const snapshot = ctx.sessions.list.getSnapshot()
  const catalog = snapshot.subagentsByParent?.[parentSessionId]
  if (catalog?.state !== 'ready' || catalog.error != null) return undefined
  const matches = catalog.entries.filter(entry => entry.id === childSessionId)
  const entry = matches.length === 1 ? matches[0] : undefined
  if (entry?.kind !== 'child' || (entry.mode !== 'one-shot' && entry.mode !== 'continuable')) return undefined
  const parent = snapshot.byId[childSessionId]?.parentId
  if (parent !== undefined && parent !== parentSessionId) return undefined
  // parentAvailable concerns live prompting, not durable transcript reads.
  return { parentSessionId, childSessionId, mode: entry.mode }
}

interface DynamicProjectionContext {
  readonly sessions: ClientContext['sessions']
}

/** Subscribe across both binding creation and projection changes. */
function dynamicTeamProjection(ctx: DynamicProjectionContext, sessionId: SessionId): {
  readonly getSnapshot: () => TeamConsoleSummary | null | undefined
  readonly subscribe: (listener: () => void) => () => void
} {
  const resolve = () => {
    // The native input dock may retain the previous custom projection for one
    // render while a fresh/ordinary conversation becomes current. Session
    // identity and its committed preset are the authority: no Yuqi preset,
    // no Team projection, even if the slot baseline is temporarily stale.
    const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
    // A preset only grants Team capability; it is not evidence that this exact
    // Session owns a Team. Requiring the list projection prevents a fresh Yuqi
    // blank session from rendering the input slot's retained previous Team.
    if (summary?.projectionValues?.yuqiTeam == null) return undefined
    return ctx.sessions.binding(sessionId)?.session.projections.faceOf('yuqiTeam') as {
      getSnapshot(): TeamConsoleSummary | null | undefined
      subscribe(listener: () => void): () => void
    } | undefined
  }
  return {
    getSnapshot: () => resolve()?.getSnapshot(),
    subscribe: (listener: () => void) => {
      let current = resolve()
      let unsubscribeProjection = current?.subscribe(listener) ?? (() => undefined)
      const list = Reflect.get(ctx.sessions, 'list') as { subscribe?: (listener: () => void) => () => void } | undefined
      const unsubscribeList = list?.subscribe?.(() => {
        const next = resolve()
        if (next === current) return
        unsubscribeProjection()
        current = next
        unsubscribeProjection = current?.subscribe(listener) ?? (() => undefined)
        listener()
      }) ?? (() => undefined)
      return () => {
        unsubscribeList()
        unsubscribeProjection()
      }
    },
  }
}

function bindPanelCommand(line: string, target: YuqiCommandTarget | undefined, summary: unknown): string | undefined {
  if (target === undefined) return line
  const identity = currentTeamIdentity(summary)
  if (identity === undefined || identity.controllerSessionId !== target.controllerSessionId) return undefined
  if (target.teamId !== undefined && identity.teamId !== target.teamId) return undefined

  const tokens = line.trim().split(/\s+/u)
  if (tokens.length === 4 && tokens[0] === '/yuqi' && (tokens[1] === 'retry' || tokens[1] === 'stop')) {
    const [, , taskId, requestId] = tokens
    if (taskId === undefined || requestId === undefined) return undefined
    return `/yuqi ${tokens[1]} ${taskId} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 5 && tokens[0] === '/yuqi' && tokens[1] === 'message') {
    const [, , taskId, payload, requestId] = tokens
    if (taskId === undefined || payload === undefined || requestId === undefined) return undefined
    return `/yuqi message ${taskId} ${payload} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 5 && tokens[0] === '/yuqi' && tokens[1] === 'model') {
    const [, , taskId, modelId, requestId] = tokens
    if (taskId === undefined || modelId === undefined || requestId === undefined) return undefined
    return `/yuqi model ${taskId} ${modelId} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 6 && tokens[0] === '/yuqi' && tokens[1] === 'model') {
    const [, , taskId, providerId, modelId, requestId] = tokens
    if (taskId === undefined || providerId === undefined || modelId === undefined || requestId === undefined) return undefined
    return `/yuqi model ${taskId} ${providerId} ${modelId} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 5 && tokens[0] === '/yuqi' && tokens[1] === 'authority') {
    const taskId = tokens[2]!
    const authorityMode = tokens[3]!
    const requestId = tokens[4]!
    return `/yuqi authority ${taskId} ${authorityMode} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 6 && tokens[0] === '/yuqi' && tokens[1] === 'resolve') {
    const [, , taskId, attemptId, decision, requestId] = tokens
    if (taskId === undefined || attemptId === undefined || (decision !== 'failed' && decision !== 'cancelled') || requestId === undefined) return undefined
    return `/yuqi resolve ${taskId} ${attemptId} ${decision} ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  if (tokens.length === 3 && tokens[0] === '/yuqi' && tokens[1] === 'recover-continue') {
    const requestId = tokens[2]
    if (requestId === undefined) return undefined
    return `/yuqi recover-continue ${identity.teamId} ${identity.controllerSessionId} ${requestId}`
  }
  return line
}

function currentTeamIdentity(value: unknown): { readonly teamId: string; readonly controllerSessionId: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const controllerSessionId = Reflect.get(value, 'controllerSessionId')
  const team = Reflect.get(value, 'team')
  const teamId = typeof team === 'object' && team !== null ? Reflect.get(team, 'id') : undefined
  if (typeof teamId !== 'string' || typeof controllerSessionId !== 'string') return undefined
  return { teamId, controllerSessionId }
}
