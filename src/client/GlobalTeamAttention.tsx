import { sessionPreset } from './session-preset.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { attentionDecisionKey, isDecisionDismissed, dismissAttentionReminder, markTeamDecisionsAsRead, teamReminderKey, useDismissedReminderKeys } from './attention-reminder-preferences.ts'
import { useYuqiLocale, type YuqiLocale } from './client-locale.ts'
import { useAllTeamUiPreferences } from './team-ui-preferences.ts'
import { formatAttentionMessage, labelValue, localeLanguageTag } from './i18n.ts'

interface SessionRow {
  readonly id: SessionId
  readonly displayTitle: string
  readonly agentPreset?: string
  readonly cwd?: string
  readonly parentId?: SessionId
  readonly pendingInteraction?: 'approval' | 'question' | 'plan-review'
  readonly projectionValues?: { readonly yuqiTeam?: TeamConsoleSummary | null }
}

interface SessionListSnapshot {
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Record<SessionId, SessionRow>>
  readonly current?: SessionId | undefined
}

interface InteractionReminder {
  readonly row: SessionRow
  readonly interactions: readonly NativeInteractionDetail[]
  readonly target?: {
    readonly row: SessionRow
    readonly summary: TeamConsoleSummary
    readonly taskLabel?: string
  }
}

export interface GlobalTeamAttentionInjected {
  readonly sessions: {
    getSnapshot(): SessionListSnapshot
    subscribe(listener: () => void): () => void
  }
  readonly openSession: (sessionId: SessionId) => void
  readonly openCurrentTeam?: (summary: TeamConsoleSummary) => void
  readonly attachToCurrent: (summary: TeamConsoleSummary, currentSessionId: SessionId) => Promise<boolean>
  /** Full live interaction details retained by the native Session runtime. */
  readonly getNativeInteractions?: (sessionId: SessionId) => readonly NativeInteractionDetail[]
  readonly subscribeNativeInteractions?: (sessionId: SessionId, listener: () => void) => () => void
}

export interface NativeQuestionDetail {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

export type NativeInteractionAnswer = 'allowed-once' | 'rejected' | {
  readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
}

export type NativeInteractionReceipt = { readonly accepted: true } | {
  readonly accepted: false
  readonly reason: 'not-pending' | 'bad-response' | 'transport-error'
}

export interface NativeInteractionDetail {
  readonly key: string
  readonly kind: 'approval' | 'question' | 'plan-review'
  readonly toolName?: string
  readonly reason?: string
  readonly questions?: readonly NativeQuestionDetail[]
  readonly approveLabel?: string
  readonly respond: (answer: NativeInteractionAnswer) => Promise<NativeInteractionReceipt>
}

export function GlobalTeamAttention({ sessions, openSession, openCurrentTeam, attachToCurrent, getNativeInteractions, subscribeNativeInteractions }: GlobalTeamAttentionInjected) {
  const locale = useYuqiLocale()
  const en = locale === 'en'
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getSnapshot)
  const [busyController, setBusyController] = useState<string>()
  const [attachError, setAttachError] = useState<{ readonly controllerId: string; readonly message: string }>()
  const dismissedReminderKeys = useDismissedReminderKeys()
  const preferences = useAllTeamUiPreferences()
  const reminders = useMemo(() => {
    const byController = new Map<string, { readonly row: SessionRow; readonly summary: TeamConsoleSummary }>()
    for (const sessionId of snapshot.ids) {
      const row = snapshot.byId[sessionId]
      const summary = row?.projectionValues?.yuqiTeam
      if (row === undefined || summary === undefined || summary === null || userDecisionCount(summary) === 0) continue
      const key = summary.team.id
      const existing = byController.get(key)
      // The controller and its active parent both expose the same projection.
      // Prefer the public parent row so opening the reminder returns users to
      // their real conversation instead of duplicating a hidden controller.
      if (existing === undefined || (isHiddenController(existing.row, existing.summary) && !isHiddenController(row, summary))) {
        byController.set(key, { row, summary })
      }
    }
    return [...byController.values()].sort((left, right) => reminderPriority(right.summary) - reminderPriority(left.summary))
  }, [snapshot])
  const interactionReminders = useMemo<readonly InteractionReminder[]>(() => snapshot.ids.flatMap(sessionId => {
    const row = snapshot.byId[sessionId]
    if (row?.pendingInteraction === undefined || !isTeamRuntimeSession(row)) return []
    const target = interactionTarget(snapshot, row, locale)
    return [{ row, interactions: getNativeInteractions?.(row.id) ?? [], ...(target === undefined ? {} : { target }) }]
  }).sort((left, right) => interactionPriority(right.row.pendingInteraction!) - interactionPriority(left.row.pendingInteraction!)), [snapshot, locale, getNativeInteractions])
  const visibleReminders = reminders.filter(({ summary }) => !isTerminalTeam(summary)
    && preferences[summary.team.id]?.teamArchived !== true
    && !dismissedReminderKeys.has(teamReminderKey(summary))
    && ((summary.team.planConfirmationPending && !isDecisionDismissed(dismissedReminderKeys, summary.team.id, 'plan-confirmation'))
      || summary.attention.some(item => item.owner === 'user' && !isDecisionDismissed(dismissedReminderKeys, summary.team.id, attentionDecisionKey(summary, item)))))
  const visibleInteractionReminders = interactionReminders.filter(({ row, target, interactions }) => (interactions.length > 0 || target === undefined || preferences[target.summary.team.id]?.teamArchived !== true)
    && (interactions.length > 0 || target === undefined || !isTerminalTeam(target.summary))
    && !dismissedReminderKeys.has(interactionReminderKey(row, interactions)))
  if (visibleReminders.length === 0 && visibleInteractionReminders.length === 0) return null

  const current = snapshot.current === undefined ? undefined : snapshot.byId[snapshot.current]
  return (
    <aside className="yuqi-global-attention" lang={localeLanguageTag(locale)} aria-label={en ? 'Yuqi Team global attention' : 'Yuqi Team 全局待确认提醒'} aria-live="polite">
      {visibleReminders.map(({ row, summary }) => {
        const controllerId = summary.controllerSessionId
        const alreadyOpen = snapshot.current === row.id
        const canAttach = controllerId !== undefined && current !== undefined && current.parentId === undefined
          && sessionPreset(current) === 'yuqi-team'
          && current.id !== row.id && samePath(current.cwd, row.cwd)
        return (
          <section className="yuqi-global-attention-card" key={`${row.id}:${summary.team.id}`}>
            <div className="yuqi-global-attention-heading">
              <div><strong>{summary.team.title || 'Yuqi Team'} {en ? 'needs confirmation' : '需要确认'}</strong><small>{row.displayTitle}</small></div>
            </div>
            <ul>
              {summary.attention.filter(item => item.owner === 'user').map(item => (
                <li key={`${item.taskId}:${item.code}`}><strong>{labelValue(item.taskId, '', locale)}</strong>{formatAttentionMessage(item, locale)}</li>
              ))}
            </ul>
            <div className="yuqi-global-attention-actions">
              <button type="button" onClick={() => {
                if (alreadyOpen && openCurrentTeam !== undefined) openCurrentTeam(summary)
                else openSession(row.id)
              }}>
                {alreadyOpen ? (en ? 'View controller decisions' : '查看主控处理项') : (en ? 'Open controller' : '进入主控处理')}
              </button>
              {canAttach ? (
                <button
                  type="button"
                  disabled={busyController === controllerId}
                  onClick={() => {
                    setAttachError(undefined)
                    setBusyController(controllerId)
                    void attachToCurrent(summary, current.id).then(attached => {
                      if (!attached) setAttachError({ controllerId, message: en ? 'The Team could not be attached to this conversation. Check the connection and retry.' : 'Team 未能切换到当前对话，请检查连接后重试。' })
                    }, cause => {
                      setAttachError({ controllerId, message: cause instanceof YuqiCommandOutcomeError ? cause.message
                        : en ? 'The attachment result is unconfirmed. Refresh Team state before retrying.' : '尚未确认切换 Team 的结果，请刷新团队状态后再决定是否重试。' })
                    }).finally(() => setBusyController(undefined))
                  }}
                >{busyController === controllerId ? (en ? 'Switching…' : '切换中…') : (en ? 'Attach to current conversation' : '切换到当前对话')}</button>
              ) : null}
              <button
                type="button"
                className="yuqi-global-attention-mark-read"
                aria-label={en ? `Mark ${summary.team.title || 'Yuqi Team'} decisions as read` : `将 ${summary.team.title || 'Yuqi Team'} 决定标为已读`}
                onClick={() => markTeamDecisionsAsRead(summary)}
              >{en ? 'Mark as read' : '标为已读'}</button>
              <button
                type="button"
                className="yuqi-global-attention-dismiss"
                aria-label={en ? `Dismiss ${summary.team.title || 'Yuqi Team'} reminder` : `关闭 ${summary.team.title || 'Yuqi Team'} 提醒`}
                onClick={() => dismissAttentionReminder(teamReminderKey(summary))}
              >{en ? 'Dismiss' : '关闭'}</button>
            </div>
            {attachError !== undefined && attachError.controllerId === controllerId ? <p className="yuqi-global-attention-error" role="alert">{attachError.message}</p> : null}
          </section>
        )
      })}
      {visibleInteractionReminders.map(({ row, target, interactions }) => (
        <section className="yuqi-global-attention-card" key={`interaction:${row.id}`}>
          <div className="yuqi-global-attention-heading">
            <div><strong>{target === undefined ? (en ? 'Team conversation awaits your response' : 'Team 会话等待用户响应') : `${target.summary.team.title || 'Yuqi Team'} ${en ? 'needs attention' : '需要处理'}`}</strong><small>{target?.taskLabel ?? row.displayTitle}</small></div>
          </div>
          <p className="yuqi-global-attention-native">{interactionLabel(row.pendingInteraction!, locale)}{target === undefined ? '' : (en ? ' Handle it in the controller conversation; do not open the child Agent.' : ' 请在主控对话统一处理，无需进入子代理。')}</p>
          <NativeInteractionDetails row={row} initial={interactions} locale={locale} getNativeInteractions={getNativeInteractions} subscribeNativeInteractions={subscribeNativeInteractions} />
          <div className="yuqi-global-attention-actions">
            <button type="button" onClick={() => {
              if (target === undefined) openSession(row.id)
              else if (snapshot.current === target.row.id && openCurrentTeam !== undefined) openCurrentTeam(target.summary)
              else openSession(target.row.id)
            }}>{target === undefined ? (en ? 'Open waiting conversation' : '打开待响应会话') : (en ? 'Open controller' : '进入主控处理')}</button>
            <button
              type="button"
              className="yuqi-global-attention-dismiss"
              aria-label={en ? `Dismiss ${row.displayTitle} reminder` : `关闭 ${row.displayTitle} 提醒`}
              onClick={() => dismissAttentionReminder(interactionReminderKey(row, interactions))}
            >{en ? 'Dismiss' : '关闭'}</button>
          </div>
        </section>
      ))}
    </aside>
  )

}

export function NativeInteractionDetails({ row, initial, locale, getNativeInteractions, subscribeNativeInteractions }: {
  readonly row: SessionRow
  readonly initial: readonly NativeInteractionDetail[]
  readonly locale: YuqiLocale
  readonly getNativeInteractions?: GlobalTeamAttentionInjected['getNativeInteractions']
  readonly subscribeNativeInteractions?: GlobalTeamAttentionInjected['subscribeNativeInteractions']
}) {
  if (getNativeInteractions === undefined || subscribeNativeInteractions === undefined) {
    return initial.map(interaction => <NativeInteractionDecision key={interaction.key} interaction={interaction} locale={locale} />)
  }
  return <SubscribedNativeInteractionDetails row={row} locale={locale} getNativeInteractions={getNativeInteractions} subscribeNativeInteractions={subscribeNativeInteractions} />
}

function SubscribedNativeInteractionDetails({ row, locale, getNativeInteractions, subscribeNativeInteractions }: {
  readonly row: SessionRow
  readonly locale: YuqiLocale
  readonly getNativeInteractions: NonNullable<GlobalTeamAttentionInjected['getNativeInteractions']>
  readonly subscribeNativeInteractions: NonNullable<GlobalTeamAttentionInjected['subscribeNativeInteractions']>
}) {
  const subscribe = useCallback((listener: () => void) => subscribeNativeInteractions?.(row.id, listener) ?? (() => undefined), [row.id, subscribeNativeInteractions])
  const getSnapshot = useCallback(() => getNativeInteractions(row.id), [row.id, getNativeInteractions])
  const interactions = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return interactions.map(interaction => <NativeInteractionDecision key={interaction.key} interaction={interaction} locale={locale} />)
}

export function interactionReminderKey(row: SessionRow, interactions: readonly NativeInteractionDetail[]): string {
  return `interaction:${row.id}:${interactions.map(item => item.key).join(',') || row.pendingInteraction || ''}`
}

function NativeInteractionDecision({ interaction, locale }: { readonly interaction: NativeInteractionDetail; readonly locale: YuqiLocale }) {
  const en = locale === 'en'
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<Exclude<NativeInteractionReceipt, { readonly accepted: true }>['reason']>()
  const [answers, setAnswers] = useState<Record<string, { readonly selected: readonly string[]; readonly custom?: string }>>({})
  const submit = (answer: NativeInteractionAnswer) => {
    setBusy(true)
    setError(undefined)
    void interaction.respond(answer).then(receipt => {
      if (receipt.accepted) setDone(true)
      else setError(receipt.reason)
    }, () => setError('transport-error')).finally(() => setBusy(false))
  }
  if (done) return <p className="yuqi-global-attention-success" role="status">{en ? 'Response submitted. Waiting for the Agent to continue.' : '已提交，正在等待子代理继续。'}</p>
  if (interaction.kind === 'approval') return (
    <div className="yuqi-global-attention-decision">
      <strong>{interaction.toolName ?? (en ? 'Permission request' : '权限请求')}</strong>
      {interaction.reason === undefined ? null : <p>{interaction.reason}</p>}
      <div className="yuqi-global-attention-decision-actions">
        <button type="button" disabled={busy} onClick={() => submit('allowed-once')}>{en ? 'Allow once' : '仅本次允许'}</button>
        <button type="button" disabled={busy} onClick={() => submit('rejected')}>{en ? 'Reject' : '拒绝'}</button>
      </div>
      {error === undefined ? null : <p role="alert">{interactionError(error, locale)}</p>}
    </div>
  )
  const questions = interaction.questions ?? []
  if (interaction.kind === 'plan-review') {
    const question = questions[0]
    const approveLabel = interaction.approveLabel
    const rejectLabel = question?.options?.find(option => option.label !== approveLabel)?.label
    const feedback = question === undefined ? '' : (answers[question.id]?.custom ?? '')
    return <div className="yuqi-global-attention-decision">
      <strong>{question?.header ?? (en ? 'Review execution plan' : '审阅执行计划')}</strong>
      {question === undefined
        ? <p role="status">{en ? 'The review plan is not available yet. Refresh the waiting conversation before responding.' : '审阅计划暂不可用，请刷新待响应会话后再回复。'}</p>
        : <p>{question.question}</p>}
      {question?.detail === undefined ? null : <p className="yuqi-global-attention-detail">{question.detail}</p>}
      {question === undefined ? null : <label><span>{en ? 'Revision feedback (optional)' : '修改意见（可选）'}</span><input type="text" value={feedback} onChange={event => setAnswers({ [question.id]: { selected: [], custom: event.target.value } })} /></label>}
      <div className="yuqi-global-attention-decision-actions">
        <button type="button" disabled={busy || question === undefined || approveLabel === undefined} onClick={() => question !== undefined && approveLabel !== undefined && submit({ answers: [{ id: question.id, selected: [approveLabel] }] })}>{en ? 'Approve plan' : '批准计划'}</button>
        <button type="button" disabled={busy || question === undefined || (feedback.trim() === '' && rejectLabel === undefined)} onClick={() => question !== undefined && submit({ answers: [{ id: question.id, selected: feedback.trim() === '' && rejectLabel !== undefined ? [rejectLabel] : [], ...(feedback.trim() === '' ? {} : { custom: feedback.trim() }) }] })}>{en ? 'Request changes' : '要求修改'}</button>
      </div>
      {error === undefined ? null : <p role="alert">{interactionError(error, locale)}</p>}
    </div>
  }
  const complete = questions.length > 0 && questions.every(question => {
    const answer = answers[question.id]
    return (answer?.selected.length ?? 0) > 0 || (answer?.custom?.trim().length ?? 0) > 0
  })
  return (
    <form className="yuqi-global-attention-decision" onSubmit={event => {
      event.preventDefault()
      if (!complete) return
      submit({ answers: questions.map(question => ({ id: question.id, selected: answers[question.id]?.selected ?? [], ...(answers[question.id]?.custom?.trim() ? { custom: answers[question.id]!.custom!.trim() } : {}) })) })
    }}>
      {questions.length === 0
        ? <p role="status">{en ? 'No questions are available yet. Refresh the waiting conversation before responding.' : '暂时没有可回答的问题，请刷新待响应会话后再回复。'}</p>
        : null}
      {questions.map(question => {
        const answer = answers[question.id] ?? { selected: [] }
        return <fieldset key={question.id}>
          <legend>{question.header ?? question.question}</legend>
          {question.header === undefined ? null : <p>{question.question}</p>}
          {question.detail === undefined ? null : <p className="yuqi-global-attention-detail">{question.detail}</p>}
          {(question.options ?? []).map(option => <label key={option.label}>
            <input
              type={question.multiSelect ? 'checkbox' : 'radio'}
              name={`yuqi-native-${interaction.key}-${question.id}`}
              checked={answer.selected.includes(option.label)}
              onChange={() => setAnswers(current => {
                const previous = current[question.id]?.selected ?? []
                const selected = question.multiSelect
                  ? (previous.includes(option.label) ? previous.filter(value => value !== option.label) : [...previous, option.label])
                  : [option.label]
                const custom = question.multiSelect ? current[question.id]?.custom : undefined
                return { ...current, [question.id]: { selected, ...(custom === undefined ? {} : { custom }) } }
              })}
            />
            <span>{option.label}{option.description === undefined ? null : <small>{option.description}</small>}</span>
          </label>)}
          <label>
            <span>{en ? 'Other' : '其他'}</span>
            <input type="text" value={answer.custom ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: { selected: question.multiSelect ? (current[question.id]?.selected ?? []) : [], custom: event.target.value } }))} />
          </label>
        </fieldset>
      })}
      <button type="submit" disabled={busy || !complete}>{busy ? (en ? 'Submitting…' : '提交中…') : (en ? 'Submit to Agent' : '提交给子代理')}</button>
      {error === undefined ? null : <p role="alert">{interactionError(error, locale)}</p>}
    </form>
  )
}

function interactionError(reason: Exclude<NativeInteractionReceipt, { readonly accepted: true }>['reason'], locale: YuqiLocale): string {
  if (reason === 'not-pending') return locale === 'en' ? 'This request was already handled. Wait for the status to refresh.' : '该请求已被处理，请等待状态刷新。'
  if (reason === 'bad-response') return locale === 'en' ? 'The answer format was rejected. Check every required answer and retry.' : '回答格式被拒绝，请检查每个必答项后重试。'
  return locale === 'en' ? 'The response could not be delivered. Check the connection and retry.' : '响应未能送达，请检查连接后重试。'
}

export function isTeamRuntimeSession(row: Pick<SessionRow, 'id' | 'parentId'>): boolean {
  return String(row.id).startsWith('yuqi-team-') || String(row.parentId ?? '').startsWith('yuqi-team-')
}

function isControllerRow(row: SessionRow): boolean {
  return String(row.id).startsWith('yuqi-team-')
}

function isHiddenController(row: SessionRow, summary: TeamConsoleSummary): boolean {
  return (summary.controllerSessionId !== undefined && String(row.id) === summary.controllerSessionId) || isControllerRow(row)
}

function userDecisionCount(summary: TeamConsoleSummary): number {
  return summary.attention.filter(item => item.owner === 'user').length + (summary.team.planConfirmationPending ? 1 : 0)
}

function isTerminalTeam(summary: TeamConsoleSummary): boolean {
  return summary.team.status === 'completed' || summary.team.status === 'failed' || summary.team.status === 'cancelled'
}

export function interactionTarget(snapshot: SessionListSnapshot, interaction: SessionRow, locale: YuqiLocale): InteractionReminder['target'] {
  const controllerId = isControllerRow(interaction) ? String(interaction.id) : String(interaction.parentId ?? '')
  if (!controllerId.startsWith('yuqi-team-')) return undefined
  const candidates = snapshot.ids.flatMap(sessionId => {
    const row = snapshot.byId[sessionId]
    const summary = row?.projectionValues?.yuqiTeam
    return row === undefined || summary === undefined || summary === null || summary.controllerSessionId !== controllerId
      ? []
      : [{ row, summary }]
  })
  const owner = candidates.find(candidate => !isControllerRow(candidate.row)) ?? candidates[0]
  if (owner === undefined) return undefined
  const task = owner.summary.tasks.find(candidate => candidate.childSessionId === interaction.id)
  const index = task === undefined ? -1 : owner.summary.tasks.indexOf(task)
  return {
    ...owner,
    ...(task === undefined ? {} : { taskLabel: locale === 'en' ? `Task ${index + 1} “${task.goal}”` : `任务 ${index + 1}「${task.goal}」` }),
  }
}

function interactionLabel(value: NonNullable<SessionRow['pendingInteraction']>, locale: YuqiLocale): string {
  if (value === 'approval') return locale === 'en' ? 'This action needs a user decision about permissions or risk.' : '该操作涉及权限或风险确认，必须由用户决定。'
  if (value === 'plan-review') return locale === 'en' ? 'The execution plan is waiting for user review.' : '执行计划正在等待用户审阅。'
  return locale === 'en' ? 'A child Agent asked a question it cannot safely decide alone and is waiting for your response.' : '子代理提出了无法自行安全决定的问题，正在等待用户回复。'
}

function interactionPriority(value: NonNullable<SessionRow['pendingInteraction']>): number {
  if (value === 'approval') return 3
  if (value === 'question') return 2
  return 1
}

function reminderPriority(summary: TeamConsoleSummary): number {
  const priorities: Record<TeamConsoleSummary['attention'][number]['code'], number> = {
    'attempt-outcome-unknown': 4,
    'verification-inconclusive': 3,
    'dependency-blocked': 2,
    'task-blocked': 2,
    'task-failed': 1,
  }
  return Math.max(0, ...summary.attention.filter(item => item.owner === 'user').map(item => priorities[item.code]))
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  const normalize = (value: string) => value.replace(/[\\/]+$/u, '').replaceAll('\\', '/').toLowerCase()
  return normalize(left) === normalize(right)
}
