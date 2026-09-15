import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useYuqiLocale } from './client-locale.ts'
import { localeLanguageTag } from './i18n.ts'
import { subscribeTeamSettingsOpen } from './team-settings-events.ts'
import { bindTeamSettingsScope, readTeamSettingsScope, type TeamSettingsScopeContext } from './team-settings-scope.ts'
import type { TeamSettingsLevel, TeamSettingsScopeView } from '../domain/team-settings-scope.ts'
import {
  DEFAULT_TEAM_CONCURRENCY,
  DEFAULT_CHILD_PRESET_ID,
  DEFAULT_EXPERIMENTAL_MODEL_ROUTING,
  DEFAULT_TEAM_WORKSPACE_MODE,
  GIT_WORKSPACE_ROOT_PATTERN,
  MAX_TEAM_CONCURRENCY,
  MIN_TEAM_CONCURRENCY,
  type TeamSettings,
  type ChildModelPolicy,
  type TeamAuthorityMode,
  type TeamWorkspaceMode,
} from '../domain/team-settings-contract.ts'
import type { ModelRouteTaskTier, ModelRoutingPolicy, ProviderModelRef, ProviderScope, TeamModelPolicy } from '../domain/model-route.ts'
import {
  DEFAULT_REVIEW_POLICY,
  DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
  MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH,
  MAX_REWORK_ROUNDS,
  DEFAULT_REVIEW_CHECKLIST_PROMPT_ZH,
  DEFAULT_REVIEW_CHECKLIST_PROMPT_EN,
  type ReviewPolicy,
} from '../domain/review-policy.ts'

/** The user-preset id shipped by this package. Other conversations stay untouched. */
export const YUQI_TEAM_PRESET_ID = 'yuqi-team'

export interface TeamSettingsButtonInjected {
  readonly teamSettings: SettingsScope<TeamSettings>
  readonly loadOptions: (sessionId: string) => Promise<TeamAgentOptions>
  readonly scopeContext?: TeamSettingsScopeContext
}

export interface TeamModelOption {
  readonly id: string
  readonly name: string
}

export interface TeamProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly TeamModelOption[]
}

export interface TeamProviderFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

export interface TeamAgentOptions {
  readonly presets: readonly { readonly id: string; readonly name?: string | undefined; readonly description?: string | undefined }[]
  readonly providerGroups: readonly TeamProviderGroup[]
  readonly failures: readonly TeamProviderFailure[]
  readonly routable: boolean
  readonly currentRoute?: ProviderModelRef | undefined
}

export type TeamSettingsButtonProps =
  Pick<PropsRuntime<'conversation.session.header.actions'>, 'sessionId'> & TeamSettingsButtonInjected & {
    readonly embedded?: boolean
    readonly onDraftStateChange?: (dirty: boolean, saving: boolean) => void
  }

const absentSettings = {
  status: 'unavailable' as const,
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory' as const,
}

const SCOPE_FIELD_NAMES: Record<'zh' | 'en', Record<keyof TeamSettings, string>> = {
  zh: { maxConcurrency: '并发保护上限', childPresetId: '子代理模式', childModelId: '默认模型', childModelPolicy: '模型策略',
    quickModelId: '快速任务模型', standardModelId: '标准任务模型', criticalModelId: '关键任务模型', modelRouting: '模型路由',
    requirePlanConfirmation: '启动前确认', defaultAuthorityMode: '默认权限', defaultWorkspaceMode: '执行工作区', gitWorkspaceRoot: 'Git 隔离目录', reviewPolicy: '审查策略' },
  en: { maxConcurrency: 'Concurrency ceiling', childPresetId: 'Child Agent preset', childModelId: 'Default model', childModelPolicy: 'Model policy',
    quickModelId: 'Quick task model', standardModelId: 'Standard task model', criticalModelId: 'Critical task model', modelRouting: 'Model routing',
    requirePlanConfirmation: 'Confirm before starting', defaultAuthorityMode: 'Default permission', defaultWorkspaceMode: 'Execution workspace', gitWorkspaceRoot: 'Git isolation directory', reviewPolicy: 'Review policy' },
}

// Exact shipped ids and metadata only; customized names (even on these ids) stay authored.
const BUILTIN_PRESET_NAMES = new Map([
  ['standard', { zh: '标准模式', en: 'Standard mode' }],
  ['minimal', { zh: '极简模式', en: 'Minimal mode' }],
  ['ptc', { zh: 'PTC 模式', en: 'PTC mode' }],
  ['code', { zh: 'PTC 模式', en: 'PTC mode' }],
  ['cordis', { zh: '创造模式', en: 'Creator mode' }],
])

function presetOptionName(option: { readonly id: string; readonly name?: string | undefined }, locale: 'zh' | 'en'): string {
  const builtin = BUILTIN_PRESET_NAMES.get(option.id)
  if (locale === 'en' && builtin && (option.name === undefined || option.name === builtin.zh || option.name === builtin.en)) return builtin.en
  return option.name ?? option.id
}

/** Global Team defaults hosted from Team management. */
export function TeamSettingsButton(props: TeamSettingsButtonProps) {
  return props.scopeContext ? <ScopedTeamSettingsButton {...props} scopeContext={props.scopeContext} /> : <TeamSettingsForm {...props} />
}

function ScopedTeamSettingsButton({ scopeContext, ...props }: TeamSettingsButtonProps & { scopeContext: TeamSettingsScopeContext }) {
  const locale = useYuqiLocale()
  const [sessionSnapshot, setSessionSnapshot] = useState(() => scopeContext.sessions.getSnapshot())
  const sessionId = sessionSnapshot.current
  const [level, setLevel] = useState<TeamSettingsLevel>('global')
  const [view, setView] = useState<TeamSettingsScopeView>()
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { setNotice('') }, [level, sessionId])
  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => { setNotice('') }, 3500)
    return () => { window.clearTimeout(timer) }
  }, [notice])
  useEffect(() => scopeContext.sessions.subscribe(() => {
    setSessionSnapshot(scopeContext.sessions.getSnapshot())
  }), [scopeContext])
  const identity = `${level}:${sessionId ?? ''}:${version}`
  const identityRef = useRef(identity)
  identityRef.current = identity
  const [loadedIdentity, setLoadedIdentity] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setError(''); setView(undefined); setDirty(false); setSaving(false); setRestoring(false)
    props.onDraftStateChange?.(false, false)
    if (level !== 'global' && !sessionId) return () => controller.abort()
    void readTeamSettingsScope(scopeContext, { level, ...(level === 'global' ? {} : { sessionId: sessionId! }) }, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setView(value); setLoadedIdentity(identity)
    }, reason => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [scopeContext, identity])
  const binding = useMemo(() => view ? bindTeamSettingsScope(scopeContext, view) : undefined, [scopeContext, view])
  const active = loadedIdentity === identity && binding && view
  const names = locale === 'en' ? { global: 'Global', project: 'Project', session: 'Session' } : { global: '全局', project: '项目', session: '会话' }
  const scopeOptions: Array<{ level: TeamSettingsLevel; label: string }> = [
    { level: 'global', label: locale === 'en' ? 'Global' : '全局默认' },
    { level: 'project', label: locale === 'en' ? 'Project' : '当前项目' },
    { level: 'session', label: locale === 'en' ? 'Session' : '当前会话' },
  ]
  const isWaitingForSession = level !== 'global' && !sessionId
  return <div className="yuqi-settings-scope">
    <section className="yuqi-settings-scope-card" aria-label={locale === 'en' ? 'Settings scope & level' : '设置层级与作用范围'}>
      <div className="yuqi-scope-row-primary">
        <div className="yuqi-scope-picker-wrap">
          <label htmlFor="yuqi-scope-level-select" className="yuqi-scope-label"><span>{locale === 'en' ? 'Scope' : '编辑层级'}</span></label>
          <div className="yuqi-level-segmented" role="group" aria-label={locale === 'en' ? 'Edit level' : '编辑层级'}>
            {scopeOptions.map(opt => (
              <button
                key={opt.level}
                type="button"
                className="yuqi-level-btn"
                aria-pressed={level === opt.level}
                disabled={dirty || saving || restoring || (opt.level !== 'global' && !sessionId)}
                onClick={() => setLevel(opt.level)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <select
            id="yuqi-scope-level-select"
            aria-label={locale === 'en' ? 'Settings scope' : '设置范围'}
            value={level}
            disabled={dirty || saving || restoring}
            onChange={event => setLevel(event.target.value as TeamSettingsLevel)}
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              border: 0,
              opacity: 0,
              pointerEvents: 'none',
            }}
            tabIndex={-1}
          >
            <option value="global">{names.global}</option>
            <option value="project" disabled={!sessionId}>{names.project}</option>
            <option value="session" disabled={!sessionId}>{names.session}</option>
          </select>
        </div>
        {active ? (
          <div className="yuqi-scope-actions-wrap">
            <button
              type="button"
              className="yuqi-scope-action-btn"
              disabled={dirty || saving || restoring || !view.writable || Object.keys(view.overrides).length === 0}
              onClick={() => {
                const message = view.level === 'global'
                  ? (locale === 'en' ? 'Clear all saved global Team defaults? Future Teams will use the plugin’s initial defaults. Existing Teams will not change.' : '确认清除所有已保存的全局 Team 默认设置吗？之后新建的 Team 将使用插件初始默认值，已有团队不会变化。')
                  : (locale === 'en' ? 'Remove all settings saved at this level? It will use the level above again. Existing Teams will not change.' : '确认移除本级单独保存的全部设置吗？之后将重新使用上一级设置，已有团队不会变化。')
                if (typeof window !== 'undefined' && !window.confirm(message)) return
                setRestoring(true)
                void binding.restore().then(() => { if (identityRef.current === identity) { setNotice(locale === 'en' ? 'Inheritance restored.' : '已恢复继承。'); setVersion(value => value + 1) } }, reason => { if (identityRef.current === identity) setError(String(reason)) }).finally(() => { if (identityRef.current === identity) setRestoring(false) })
              }}
            >
              {view.level === 'global' ? (locale === 'en' ? 'Clear saved defaults' : '清除已保存默认') : (locale === 'en' ? 'Restore inheritance' : '恢复上一级继承')}
            </button>
            <button
              type="button"
              className="yuqi-scope-action-ghost"
              disabled={saving || restoring}
              onClick={() => setVersion(value => value + 1)}
            >
              {locale === 'en' ? 'Reload' : '重新读取'}
            </button>
          </div>
        ) : null}
      </div>

      {active ? (
        <div className="yuqi-scope-row-secondary">
          <div className="yuqi-scope-status-badge">
            <span className={Object.keys(view.overrides).length === 0 ? 'yuqi-status-dot dot-inherited' : 'yuqi-status-dot dot-overridden'} />
            <strong>{Object.keys(view.overrides).length === 0 ? (locale === 'en' ? 'Using inherited values' : '当前使用继承设置') : (locale === 'en' ? 'Saved overrides active' : '已保存独立覆盖')}</strong>
          </div>
          <p className="yuqi-scope-desc">
            {view.projectTitle ? `${names.project}: ${view.projectTitle} · ` : ''}
            {Object.keys(view.overrides).length === 0 ? (locale === 'en' ? 'Values come from the level above. Edit and save to create an override here.' : '当前值来自上一级；编辑并保存后才会在本级形成独立覆盖。') : (locale === 'en' ? 'This level has saved values that take precedence over the level above.' : '本级已保存独立配置，生效时优先于上一级。')}
          </p>
          {view.level === 'session' && (
            <div className="yuqi-scope-session-row">
              <span><strong>{locale === 'en' ? 'Conversation: ' : '会话：'}</strong>{sessionSnapshot.byId?.[view.sessionId!]?.displayTitle?.trim() && sessionSnapshot.byId[view.sessionId!]?.displayTitle !== view.sessionId ? sessionSnapshot.byId[view.sessionId!]!.displayTitle : (locale === 'en' ? 'Untitled conversation' : '未命名会话')}</span>
              <code>{view.sessionId}</code>
            </div>
          )}
          {notice ? <span className="yuqi-settings-scope-notice" role="status">{notice}</span> : null}
        </div>
      ) : null}

      {active && view.level !== 'global' && (
        <details className="yuqi-settings-sources">
          <summary><span>{locale === 'en' ? 'Why does this setting have this value? (advanced)' : '为什么当前值是这样？（高级排查）'}</span><small>{locale === 'en' ? 'Inspect whether Project or Conversation settings override Global.' : '排查项目或会话是否覆盖了全局设置。'}</small></summary>
          <dl>{Object.entries(view.sources).map(([field, source]) => <div key={field}><dt>{SCOPE_FIELD_NAMES[locale][field as keyof TeamSettings]}</dt><dd>{names[source]}</dd></div>)}</dl>
        </details>
      )}
    </section>
    {isWaitingForSession ? <SettingsStatePanel kind="context" locale={locale} /> : null}
    {active ? <>
      <fieldset disabled={restoring} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <TeamSettingsForm key={identity} {...props} sessionId={(level === 'global' ? '' : sessionId ?? '') as TeamSettingsButtonProps['sessionId']} teamSettings={binding.scope}
        atomicSave={async (settings, changedFields) => { await binding.save(settings, changedFields); if (identityRef.current === identity) { setNotice(locale === 'en' ? 'Settings saved for future Teams.' : '已保存，仅影响之后启动的 Team。'); setVersion(value => value + 1) } }}
        onDraftStateChange={(changed, pending) => { if (identityRef.current !== identity) return; setDirty(changed); setSaving(pending); props.onDraftStateChange?.(changed, pending) }} />
      </fieldset>
    </> : error || isWaitingForSession ? null : <SettingsStatePanel kind="loading" locale={locale} />}
    {error && <SettingsStatePanel kind="error" locale={locale} error={error} onRetry={() => setVersion(value => value + 1)} />}
  </div>
}

function SettingsStatePanel({ kind, locale, error, onRetry }: { readonly kind: 'loading' | 'context' | 'error'; readonly locale: 'zh' | 'en'; readonly error?: string; readonly onRetry?: () => void }) {
  const copy = locale === 'en'
    ? { loading: ['Loading Team settings', 'Syncing defaults and the model catalog.'], context: ['Select a conversation', 'Choose a conversation to edit Project or Conversation settings.'], error: ['Unable to load Team settings', 'The settings could not be loaded. Try again when the local Host is available.'], reason: 'Original error', retry: 'Retry loading' }
    : { loading: ['正在读取团队设置', '正在同步默认设置与模型目录，请稍候。'], context: ['请选择一个会话', '选择会话后，才能编辑项目或会话设置。'], error: ['无法读取团队设置', '设置读取或恢复失败，请重试；本地 Host 可用后可重新尝试。'], reason: '原始原因', retry: '重试' }
  const [title, description] = copy[kind]
  return <section className={`yuqi-settings-state yuqi-settings-state-${kind}`} role={kind === 'error' ? 'alert' : 'status'} aria-live="polite">
    <span className="yuqi-settings-state-icon" aria-hidden="true">{kind === 'loading' ? <span className="yuqi-settings-spinner" /> : kind === 'error' ? '!' : 'i'}</span>
    <div><h3>{title}</h3><p>{description}</p>
      {error ? <details><summary>{copy.reason}</summary><pre>{error}</pre></details> : null}
      {onRetry ? <button type="button" className="yuqi-primary-action" onClick={onRetry}>{copy.retry}</button> : null}
    </div>
  </section>
}

function TeamSettingsForm({ sessionId, teamSettings, loadOptions, embedded = false, onDraftStateChange, atomicSave }: TeamSettingsButtonProps & { readonly atomicSave?: (settings: TeamSettings, changedFields: readonly (keyof TeamSettings)[]) => Promise<void> }) {
  const locale = useYuqiLocale()
  const copy = SETTINGS_COPY[locale]
  const [settings, setSettings] = useState(() => teamSettings.getSnapshot() ?? absentSettings)
  const [open, setOpen] = useState(embedded)
  const [resetVersion, setResetVersion] = useState(0)
  const [saved, setSaved] = useState(false)
  const [draft, setDraft] = useState(String(settings.value?.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY))
  const [presetDraft, setPresetDraft] = useState(settings.value?.childPresetId ?? DEFAULT_CHILD_PRESET_ID)
  const [routingDraft, setRoutingDraft] = useState<ModelRoutingPolicy>(() => routingFromSettings(settings.value))
  const [planConfirmationDraft, setPlanConfirmationDraft] = useState(settings.value?.requirePlanConfirmation ?? true)
  const [authorityDraft, setAuthorityDraft] = useState<TeamAuthorityMode>(settings.value?.defaultAuthorityMode ?? 'write-authorized')
  const [workspaceModeDraft, setWorkspaceModeDraft] = useState<TeamWorkspaceMode>(settings.value?.defaultWorkspaceMode ?? DEFAULT_TEAM_WORKSPACE_MODE)
  const [workspaceRootDraft, setWorkspaceRootDraft] = useState(settings.value?.gitWorkspaceRoot ?? '')
  const [reviewDraft, setReviewDraft] = useState<ReviewPolicy>(() => settings.value?.reviewPolicy ?? DEFAULT_REVIEW_POLICY)
  const [options, setOptions] = useState<TeamAgentOptions>()
  const [optionsError, setOptionsError] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error' | 'partial'>('idle')
  const saveStateRef = useRef(saveState)
  const dialogRef = useRef<HTMLElement>(null)
  saveStateRef.current = saveState
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const draftKey = JSON.stringify([draft, presetDraft, routingDraft, planConfirmationDraft, authorityDraft, workspaceModeDraft, reviewDraft, workspaceRootDraft])
  const [baseline, setBaseline] = useState(draftKey)
  const dirty = draftKey !== baseline
  const routingDraftRef = useRef(routingDraft)
  routingDraftRef.current = routingDraft
  useEffect(() => { onDraftStateChange?.(dirty, saveState === 'saving') }, [dirty, saveState, onDraftStateChange])

  const parsed = Number(draft)
  const workspaceRootValid = GIT_WORKSPACE_ROOT_PATTERN.test(workspaceRootDraft.trim())
  const valid = Number.isInteger(parsed) && parsed >= MIN_TEAM_CONCURRENCY && parsed <= MAX_TEAM_CONCURRENCY
  const currentProvider = options?.currentRoute?.modelProvider
  const currentProviderName = options?.providerGroups.find(group => group.id === currentProvider)?.name
    ?? options?.failures.find(failure => failure.id === currentProvider)?.name ?? currentProvider
  const currentProviderLabel = currentProviderName === undefined ? undefined
    : currentProviderName === currentProvider ? currentProviderName : `${currentProviderName} (${currentProvider})`
  const allowedProviders = useMemo(() => providerIdsForScope(routingDraft.providerScope, currentProvider), [currentProvider, routingDraft.providerScope])
  const providerAllowlist = routingDraft.providerScope.kind === 'controller-plus-allowlist' ? routingDraft.providerScope.providerAllowlist : []
  const routeValid = routingDraft.teamPolicy.kind === 'inherit'
    || (routingDraft.teamPolicy.kind === 'automatic'
      ? Object.values(routingDraft.teamPolicy.tierCandidates).every(candidates => candidates.every(candidate => allowedProviders.has(candidate.modelProvider)))
      : (routingDraft.teamPolicy.model.modelProvider.trim() !== ''
      && routingDraft.teamPolicy.model.modelId.trim() !== ''
      && allowedProviders.has(routingDraft.teamPolicy.model.modelProvider)))
  const reviewValid = Number.isInteger(reviewDraft.maxReworkRounds)
    && reviewDraft.maxReworkRounds >= 0
    && reviewDraft.maxReworkRounds <= MAX_REWORK_ROUNDS
    && reviewDraft.additionalPrompt.length <= MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH

  useEffect(() => {
    setSettings(teamSettings.getSnapshot() ?? absentSettings)
    return teamSettings.subscribe(() => setSettings(teamSettings.getSnapshot() ?? absentSettings))
  }, [teamSettings])
  useEffect(() => {
    if (!open) return
    const settings = settingsRef.current
    const configuredValue = settings.value?.maxConcurrency ?? DEFAULT_TEAM_CONCURRENCY
    const initialRouting = routingFromSettings(settings.value)
    const baseValues = [String(configuredValue), settings.value?.childPresetId ?? DEFAULT_CHILD_PRESET_ID,
      initialRouting, settings.value?.requirePlanConfirmation ?? true, settings.value?.defaultAuthorityMode ?? 'write-authorized',
      settings.value?.defaultWorkspaceMode ?? DEFAULT_TEAM_WORKSPACE_MODE, settings.value?.reviewPolicy ?? DEFAULT_REVIEW_POLICY, settings.value?.gitWorkspaceRoot ?? '']
    setBaseline(JSON.stringify(baseValues))
    setDraft(String(configuredValue))
    setPresetDraft(settings.value?.childPresetId ?? DEFAULT_CHILD_PRESET_ID)
    setRoutingDraft(routingFromSettings(settings.value))
    setPlanConfirmationDraft(settings.value?.requirePlanConfirmation ?? true)
    setAuthorityDraft(settings.value?.defaultAuthorityMode ?? 'write-authorized')
    setWorkspaceModeDraft(settings.value?.defaultWorkspaceMode ?? DEFAULT_TEAM_WORKSPACE_MODE)
    setWorkspaceRootDraft(settings.value?.gitWorkspaceRoot ?? '')
    setReviewDraft(settings.value?.reviewPolicy ?? DEFAULT_REVIEW_POLICY)
    setOptions(undefined)
    setOptionsError(false)
    let active = true
    void loadOptions(String(sessionId)).then(loaded => {
      if (!active) return
      setOptions(loaded)
      // Editing an unrelated field must not block legacy route resolution.
      // Only preserve a route that the user actually changed while loading.
      if (JSON.stringify(routingDraftRef.current) === JSON.stringify(initialRouting)) {
        const resolved = routingFromSettings(settings.value, loaded.currentRoute?.modelProvider)
        setRoutingDraft(resolved)
        setBaseline(JSON.stringify(baseValues.map((value, index) => index === 2 ? resolved : value)))
      }
    }, () => { if (active) setOptionsError(true) })
    return () => { active = false }
  }, [loadOptions, open, sessionId, resetVersion, settings.status])
  useLayoutEffect(() => {
    if (!open || embedded) return undefined
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const dialog = dialogRef.current
    // Closed disclosures must not put their hidden controls in the Tab loop;
    // summaries themselves remain reachable so all technical help can open.
    const focusableElements = () => [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? [])]
      .filter(element => !element.closest('details:not([open])'))
    focusableElements()[0]?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (saveStateRef.current === 'saving') return
        event.preventDefault()
        setOpen(false)
        return
      }
      if (event.key !== 'Tab' || dialog === null) return
      const focusable = focusableElements()
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [open, embedded])
  useEffect(() => embedded ? undefined : subscribeTeamSettingsOpen(() => {
    setSaveState('idle')
    setOpen(true)
  }), [embedded])

  const save = async () => {
    if (saveStateRef.current === 'saving' || !valid || !routeValid || !reviewValid || !workspaceRootValid || !settings.writable || settings.status !== 'ready') return
    saveStateRef.current = 'saving'
    setSaveState('saving')
    let savedFields = 0
    const legacy = legacyFieldsForRouting(routingDraft)
    if (atomicSave) {
      try {
        const initialFields = JSON.parse(baseline) as unknown[]
        const currentFields = JSON.parse(draftKey) as unknown[]
        const fieldGroups: (keyof TeamSettings)[][] = [['maxConcurrency'], ['childPresetId'],
          ['modelRouting', 'childModelId', 'childModelPolicy', 'quickModelId', 'standardModelId', 'criticalModelId'],
          ['requirePlanConfirmation'], ['defaultAuthorityMode'], ['defaultWorkspaceMode'], ['reviewPolicy'], ['gitWorkspaceRoot']]
        const changedFields = fieldGroups.flatMap((fields, index) => JSON.stringify(initialFields[index]) === JSON.stringify(currentFields[index]) ? [] : fields)
        await atomicSave({ maxConcurrency: parsed, childPresetId: presetDraft, ...legacy, modelRouting: routingDraft,
          requirePlanConfirmation: planConfirmationDraft, defaultAuthorityMode: authorityDraft,
          defaultWorkspaceMode: workspaceModeDraft, gitWorkspaceRoot: workspaceRootDraft.trim(),
          reviewPolicy: { ...reviewDraft, additionalPrompt: reviewDraft.additionalPrompt.trim() } }, changedFields)
        setSaveState('idle'); setBaseline(draftKey); setSaved(true)
        if (!embedded) setOpen(false)
      } catch { setSaveState('error') }
      return
    }
    try {
      await teamSettings.set('maxConcurrency', parsed)
      savedFields++
      await teamSettings.set('childPresetId', presetDraft)
      savedFields++
      // Structured routing is one authoritative settings value. Legacy mirrors
      // are written afterwards only for older Hosts.
      await teamSettings.set('modelRouting', routingDraft)
      savedFields++
      await teamSettings.set('childModelId', legacy.childModelId)
      savedFields++
      await teamSettings.set('childModelPolicy', legacy.childModelPolicy)
      savedFields++
      await teamSettings.set('quickModelId', legacy.quickModelId)
      savedFields++
      await teamSettings.set('standardModelId', legacy.standardModelId)
      savedFields++
      await teamSettings.set('criticalModelId', legacy.criticalModelId)
      savedFields++
      await teamSettings.set('requirePlanConfirmation', planConfirmationDraft)
      savedFields++
      await teamSettings.set('defaultAuthorityMode', authorityDraft)
      savedFields++
      await teamSettings.set('defaultWorkspaceMode', workspaceModeDraft)
      savedFields++
      await teamSettings.set('gitWorkspaceRoot', workspaceRootDraft.trim())
      savedFields++
      // One settings write owns the complete policy. A mode change can never
      // become visible without its matching budget and prompt.
      await teamSettings.set('reviewPolicy', {
        ...reviewDraft,
        additionalPrompt: reviewDraft.additionalPrompt.trim(),
      })
      try { localStorage.setItem('yuqi_team_review_prompt', reviewDraft.additionalPrompt.trim()) } catch {}
      savedFields++
    } catch {
      setSaveState(savedFields > 0 ? 'partial' : 'error')
      return
    }
    const settled = teamSettings.getSnapshot()
    if (settled.value?.maxConcurrency !== parsed
      || settled.value?.childPresetId !== presetDraft
      || settled.value?.childModelId !== legacy.childModelId
      || settled.value?.childModelPolicy !== legacy.childModelPolicy
      || settled.value?.quickModelId !== legacy.quickModelId
      || settled.value?.standardModelId !== legacy.standardModelId
      || settled.value?.criticalModelId !== legacy.criticalModelId
      || !sameRoutingPolicy(settled.value?.modelRouting, routingDraft)
      || (settled.value?.requirePlanConfirmation ?? planConfirmationDraft) !== planConfirmationDraft
      || (settled.value?.defaultAuthorityMode ?? authorityDraft) !== authorityDraft
      || (settled.value?.defaultWorkspaceMode ?? workspaceModeDraft) !== workspaceModeDraft
      || (settled.value?.gitWorkspaceRoot ?? '') !== workspaceRootDraft.trim()
      || !sameReviewPolicy(settled.value?.reviewPolicy, reviewDraft)) {
      setSaveState('partial')
      return
    }
    setSaveState('idle')
    setBaseline(draftKey)
    setSaved(true)
    if (!embedded) setOpen(false)
  }

  const content = <>
            <div className="yuqi-settings-body yuqi-defaults-grid yuqi-settings-aligned" onChangeCapture={() => setSaved(false)}>
              <p className="yuqi-settings-introduction">{locale === 'en' ? 'Start with execution settings. Adjust the other sections only as needed. Save applies these defaults to new Teams only.' : '先确认「基本执行」。模型、审查和权限按需调整，不确定时可保留当前值。保存后仅作为新建团队的默认设置。'}</p>
              <section className="yuqi-settings-group yuqi-settings-execution-group">
                <h3>{locale === 'en' ? 'Execution' : '基本执行'}</h3>
              <label className="yuqi-settings-field" htmlFor="yuqi-team-max-concurrency">
                <span>{copy.concurrency}</span>
                <input
                  id="yuqi-team-max-concurrency"
                  type="number"
                  inputMode="numeric"
                  min={MIN_TEAM_CONCURRENCY}
                  max={MAX_TEAM_CONCURRENCY}
                  step={1}
                  aria-label={copy.concurrency}
                  value={draft}
                  disabled={saveState === 'saving' || settings.status !== 'ready' || !settings.writable}
                  onChange={event => { setDraft(event.currentTarget.value); setSaveState('idle') }}
                />
                <small>{locale === 'en' ? `Up to ${MAX_TEAM_CONCURRENCY} independent, ready tasks. Dependencies still apply.` : `最多 ${MAX_TEAM_CONCURRENCY} 个就绪且互不冲突的任务并行；依赖关系仍然生效。`}</small>
              </label>
              <label className="yuqi-settings-field" htmlFor="yuqi-team-child-preset">
                <span>{locale === 'en' ? 'Child Agent preset' : '子代理模式'}</span>
                <select
                  id="yuqi-team-child-preset"
                  value={presetDraft}
                  disabled={saveState === 'saving' || options === undefined}
                  onChange={event => { setPresetDraft(event.currentTarget.value); setSaveState('idle') }}
                >
                  {options?.presets.map(option => (
                    <option key={option.id} value={option.id}>{presetOptionName(option, locale)}</option>
                  )) ?? <option value={presetDraft}>{presetDraft}</option>}
                </select>
              </label>
              <label className="yuqi-settings-field yuqi-settings-switch" htmlFor="yuqi-team-plan-confirmation">
                <span>{copy.confirmPlan}</span>
                <input id="yuqi-team-plan-confirmation" type="checkbox" role="switch" aria-describedby="yuqi-team-plan-confirmation-help" checked={planConfirmationDraft}
                  disabled={saveState === 'saving'} onChange={event => setPlanConfirmationDraft(event.currentTarget.checked)} />
                <small id="yuqi-team-plan-confirmation-help">{locale === 'en' ? 'Review the task plan before starting.' : '先查看任务安排，再决定是否开始。'}</small>
              </label>
              <details className="yuqi-settings-help"><summary>{locale === 'en' ? 'Execution details' : '执行说明'}</summary><p>{copy.concurrencyHelp(MIN_TEAM_CONCURRENCY, MAX_TEAM_CONCURRENCY)}</p><p>{copy.presetHelp}</p><p>{copy.confirmPlanHelp}</p></details>
              </section>
              <section className="yuqi-settings-group yuqi-settings-model-group">
                <h3>{locale === 'en' ? 'Model selection' : '模型选择'}</h3>
              <label className="yuqi-settings-field" htmlFor="yuqi-team-model-policy">
                <span>{copy.modelPolicy}</span>
                <select id="yuqi-team-model-policy" value={routingDraft.teamPolicy.kind} disabled={saveState === 'saving'} onChange={event => {
                  const kind = event.currentTarget.value as 'inherit' | 'fixed' | 'automatic'
                  setRoutingDraft(current => ({ ...current, teamPolicy: policyOfKind(kind, current.teamPolicy, options?.currentRoute) }))
                  setSaveState('idle')
                }}>
                  <option value="automatic">{copy.automatic}</option>
                  <option value="inherit">{copy.inherit}</option>
                  <option value="fixed">{copy.fixed}</option>
                </select>
                <small>{routingDraft.teamPolicy.kind === 'automatic'
                  ? (locale === 'en' ? 'Experimental: select models by task tier.' : '实验性功能：按任务等级选择模型。')
                  : routingDraft.teamPolicy.kind === 'fixed' ? copy.fixedModelHelp : (locale === 'en' ? 'Use the controller’s model route.' : '子代理沿用主控的模型配置。')}</small>
              </label>
              <label className="yuqi-settings-field" htmlFor="yuqi-provider-scope">
                <span>{copy.providerScope}</span>
                <select id="yuqi-provider-scope" aria-label={copy.providerScope} value={routingDraft.providerScope.kind} disabled={saveState === 'saving'}
                  onChange={event => {
                    const kind = event.currentTarget.value
                    setRoutingDraft(current => ({ ...current, providerScope: kind === 'controller-only'
                      ? { kind: 'controller-only' }
                      : { kind: 'controller-plus-allowlist', providerAllowlist: current.providerScope.kind === 'controller-plus-allowlist' ? current.providerScope.providerAllowlist : [] } }))
                    setSaveState('idle')
                  }}>
                  <option value="controller-only">{copy.controllerOnly}{currentProviderLabel ? ` · ${currentProviderLabel}` : ''}</option>
                  <option value="controller-plus-allowlist">{copy.providerAllowlist}</option>
                </select>
                <small aria-live="polite">{optionsError ? copy.providerDirectoryFailed : options === undefined ? (locale === 'en' ? 'Loading Provider names…' : '正在读取供应商名称…')
                  : currentProviderLabel ? `${copy.currentProvider}: ${currentProviderLabel}` : copy.currentProviderUnknown}</small>
              </label>
                {routingDraft.providerScope.kind !== 'controller-plus-allowlist' ? null : (
                  <fieldset className="yuqi-settings-provider-list">
                    <legend>{copy.providerAllowlist}</legend>
                    {options && providerChoices(options, providerAllowlist, currentProvider).length === 0 ? <p>{copy.noProviders}</p> : null}
                    {providerChoices(options, providerAllowlist, currentProvider).map(provider => (
                      <label key={provider.id}>
                        <input type="checkbox" checked={provider.id === currentProvider || providerAllowlist.includes(provider.id)} disabled={saveState === 'saving' || options === undefined || provider.id === currentProvider || (provider.failed && !providerAllowlist.includes(provider.id))}
                          onChange={event => {
                            const checked = event.currentTarget.checked
                            setRoutingDraft(current => ({ ...current, providerScope: updateProviderAllowlist(current.providerScope, provider.id, checked) }))
                            setSaveState('idle')
                          }} />
                        <span>{provider.name}<small><code>{provider.id}</code>{provider.failed ? ` · ${copy.catalogFailure}` : ''}</small></span>
                      </label>
                    ))}
                  </fieldset>
                )}
              {options?.failures.map(failure => (
                <p key={failure.id} className="yuqi-settings-provider-failure" role="status">
                  <strong>{failure.name}</strong>（<code>{failure.id}</code>）：{copy.providerFailurePreserved}
                </p>
              ))}
              {routingDraft.teamPolicy.kind !== 'fixed' ? null : <label className="yuqi-settings-field" htmlFor="yuqi-team-child-model">
                <span>{copy.fixedModel}</span>
                <RouteSelect id="yuqi-team-child-model" value={routingDraft.teamPolicy.model} options={options} allowedProviders={allowedProviders}
                  disabled={saveState === 'saving'} emptyLabel={copy.selectExactModel} unavailableLabel={copy.configuredUnavailable} unavailableHelp={copy.configuredUnavailableHelp}
                  onChange={model => { if (model !== undefined) setRoutingDraft(current => ({ ...current, teamPolicy: { kind: 'fixed', model } })); setSaveState('idle') }} />
                <small>{copy.fixedModelHelp}</small>
              </label>}
              {routingDraft.teamPolicy.kind !== 'automatic' ? null : (
                <fieldset className="yuqi-settings-model-tiers">
                  <legend>{copy.modelMapping}</legend>
                  {(['quick', 'standard', 'critical'] as const).map(tier => (
                    <ModelTierSelect key={tier} tier={tier} label={copy[tier]} emptyLabel={copy.followController}
                      candidates={routingDraft.teamPolicy.kind === 'automatic' ? routingDraft.teamPolicy.tierCandidates[tier] : []}
                      options={options} allowedProviders={allowedProviders} disabled={saveState === 'saving'} unavailableLabel={copy.configuredUnavailable} unavailableHelp={copy.configuredUnavailableHelp}
                      onChange={model => {
                        setRoutingDraft(current => current.teamPolicy.kind !== 'automatic' ? current : ({ ...current, teamPolicy: {
                          ...current.teamPolicy,
                          tierCandidates: {
                            ...current.teamPolicy.tierCandidates,
                            [tier]: model === undefined ? [] : [model, ...current.teamPolicy.tierCandidates[tier].slice(1)],
                          },
                        } }))
                        setSaveState('idle')
                      }} />
                  ))}
                </fieldset>
              )}
              <details className="yuqi-settings-catalog-note">
                <summary>{locale === 'en' ? 'Routing & catalog details' : '路由与模型目录说明'}</summary>
                <span>{copy.modelPolicyHelp}</span><span>{copy.modelMappingHelp}</span>
                <span>{copy.controllerOnlyHelp}</span><span>{copy.providerAllowlistHelp}</span>
                {options ? <strong>{options.providerGroups.length === 0 ? copy.noProviders : copy.catalogResolved}</strong> : null}<span>{copy.credentialsUnverified}</span>
                {optionsError || options?.currentRoute === undefined ? null : <span>{options.routable ? copy.currentRouteRoutable : copy.currentRouteUnroutable}</span>}
              </details>
              </section>
              <section className="yuqi-settings-group yuqi-settings-review-group">
                <h3>{locale === 'en' ? 'Review & correction' : '审查与纠错'}</h3>
              <fieldset className="yuqi-settings-review-policy">
                <legend>{copy.reviewPolicy}</legend>
                <div className="yuqi-review-mode-choices">
                {(['off', 'manual', 'quality-gate'] as const).map(mode => (
                  <label key={mode} className={reviewDraft.mode === mode ? 'selected' : ''}>
                    <input type="radio" name="yuqi-review-policy" value={mode} checked={reviewDraft.mode === mode}
                      disabled={saveState === 'saving'} onChange={() => { setReviewDraft(current => ({ ...current, mode })); setSaveState('idle') }} />
                    <span>
                      <strong>{copy.reviewMode[mode]}</strong>
                    </span>
                  </label>
                ))}
                </div>
                <p>{reviewDraft.mode === 'quality-gate'
                  ? (locale === 'en' ? 'Experimental: reviews at key checkpoints consume additional model tokens.' : '实验性：在关键节点运行独立审查；审查会消耗额外模型 Token。')
                  : copy.reviewModeHelp[reviewDraft.mode]}</p>
                <label className="yuqi-settings-field yuqi-review-rework-field" htmlFor="yuqi-review-max-rework">
                  <span>{locale === 'en' ? 'Maximum automatic rework rounds' : '最多返工次数'}</span>
                  <span className="yuqi-review-rework-control"><input id="yuqi-review-max-rework" type="number" inputMode="numeric" min={0} max={MAX_REWORK_ROUNDS} step={1}
                    value={reviewDraft.maxReworkRounds} disabled={saveState === 'saving' || reviewDraft.mode === 'off'}
                    onChange={event => { const value = Number(event.currentTarget.value); setReviewDraft(current => ({ ...current, maxReworkRounds: value })); setSaveState('idle') }} /><em>{locale === 'en' ? 'rounds' : '轮'}</em></span>
                  <small>{reviewDraft.mode === 'off'
                    ? (locale === 'en' ? 'Enable Manual or Automatic review before changing this limit.' : '开启「手动审查」或「自动审查」后，才可修改此上限。')
                    : (locale === 'en' ? `When a review finds an issue, the controller may arrange up to ${reviewDraft.maxReworkRounds} additional rework round${reviewDraft.maxReworkRounds === 1 ? '' : 's'}.` : `审查发现问题时，主控最多可额外安排 ${reviewDraft.maxReworkRounds} 轮返工。`)}</small>
                </label>
                <div className="yuqi-review-tip" role="note">
                  <span className="yuqi-review-tip-icon" aria-hidden="true">💡</span>
                  <p>{locale === 'en'
                    ? 'How it works: An independent AI reviewer checks task goals, code changes, and evidence to catch omissions before reporting back to the controller.'
                    : '运作机制：由独立的审查 AI 复核任务方案与交付结果，排查逻辑遗漏与潜在风险并向主控反馈。'}</p>
                </div>
                <details className="yuqi-settings-help" open><summary>{copy.additionalPrompt}</summary>
                <label className="yuqi-settings-field" htmlFor="yuqi-review-additional-prompt">
                  <span>{copy.additionalPrompt}</span>
                  <textarea id="yuqi-review-additional-prompt" rows={4} maxLength={MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH}
                    value={reviewDraft.additionalPrompt} disabled={saveState === 'saving' || reviewDraft.mode === 'off'}
                    onChange={event => { const value = event.currentTarget.value; setReviewDraft(current => ({ ...current, additionalPrompt: value })); setSaveState('idle') }} />
                  <small>{copy.additionalPromptHelp(reviewDraft.additionalPrompt.length, MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH)}</small>
                </label>
                <button type="button" className="yuqi-secondary-action" disabled={saveState === 'saving' || reviewDraft.mode === 'off' || reviewDraft.additionalPrompt.trim().length > 0}
                  onClick={() => { const prompt = locale === 'en' ? DEFAULT_REVIEW_CHECKLIST_PROMPT_EN : DEFAULT_REVIEW_CHECKLIST_PROMPT_ZH; setReviewDraft(current => ({ ...current, additionalPrompt: prompt })); setSaveState('idle'); try { localStorage.setItem('yuqi_team_review_prompt', prompt) } catch {} }}>{locale === 'en' ? 'Insert general checklist (empty field only)' : '填入通用检查模板（仅空白时）'}</button>
                </details>
                <details className="yuqi-settings-help"><summary>{locale === 'en' ? 'Review rules & limits' : '审查规则与限制'}</summary>
                  <p>{copy.experimental}</p><p>{copy.reviewModeHelp[reviewDraft.mode]}</p><p>{copy.maxReworkHelp(MAX_REWORK_ROUNDS)}</p>
                  <p>{copy.reviewPolicyHelp}</p><p>{copy.reviewTriggers}</p><p>{copy.teamReworkLimit(DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS)}</p>
                </details>
              </fieldset>
              </section>
              <section className="yuqi-settings-group yuqi-settings-access-group">
                <h3>{locale === 'en' ? 'Permissions & workspace' : '权限与工作区'}</h3>
                <label className="yuqi-settings-field" htmlFor="yuqi-team-default-authority">
                  <span>{locale === 'en' ? 'Child permissions' : '子代理权限'}</span>
                  <select id="yuqi-team-default-authority" value={authorityDraft} disabled={saveState === 'saving'}
                    onChange={event => { setAuthorityDraft(event.currentTarget.value as TeamAuthorityMode); setSaveState('idle') }}>
                    <option value="read-only">{copy.readOnly}</option>
                    <option value="write-authorized">{copy.workspaceWrite}</option>
                    <option value="full-access">{copy.fullAccess}</option>
                  </select>
                  <small>{authorityDraft === 'read-only' ? (locale === 'en' ? 'Inspect without modifying files.' : '查看文件，不修改内容。')
                    : authorityDraft === 'write-authorized' ? (locale === 'en' ? 'Allow changes in the current workspace.' : '允许修改当前工作区中的文件。')
                    : (locale === 'en' ? 'Broader access; use with care.' : '更广泛的访问权限，请谨慎使用。')}</small>
                </label>
                <label className="yuqi-settings-field" htmlFor="yuqi-team-workspace-mode">
                  <span>{locale === 'en' ? 'Workspace' : '工作方式'}</span>
                  <select id="yuqi-team-workspace-mode" value={workspaceModeDraft} disabled={saveState === 'saving'}
                    onChange={event => { setWorkspaceModeDraft(event.currentTarget.value as TeamWorkspaceMode); setSaveState('idle') }}>
                    <option value="direct">{copy.directWorkspace}</option>
                    <option value="git-worktree">{copy.gitWorkspace}</option>
                  </select>
                  <small>{workspaceModeDraft === 'direct' ? (locale === 'en' ? 'Agents edit files in your current project directly. No Git required; changes affect this project.' : '子代理直接修改当前项目里的文件，无需 Git；改动会影响当前项目。')
                    : (locale === 'en' ? 'Work in a separate Git directory and branch. Requires a clean repository; review and integrate changes afterward.' : '在独立的 Git 工作目录和分支中工作。需要干净的 Git 仓库；完成后需检查并整合改动。')}</small>
                </label>
                {workspaceModeDraft === 'git-worktree' ? <label className="yuqi-settings-field" htmlFor="yuqi-git-workspace-root">
                  <span>{locale === 'en' ? 'Isolation parent directory' : '隔离工作区父目录'}</span>
                  <input id="yuqi-git-workspace-root" type="text" value={workspaceRootDraft}
                    aria-invalid={!workspaceRootValid}
                    placeholder={locale === 'en' ? 'Leave empty for automatic location' : '留空使用自动位置'}
                    disabled={saveState === 'saving' || settings.status !== 'ready' || !settings.writable}
                    onChange={event => { setWorkspaceRootDraft(event.currentTarget.value); setSaveState('idle') }} />
                  <small>{locale === 'en' ? 'Enter an absolute folder path on the Host machine, on the same drive as the repository and outside it. Each new Team gets a separate subfolder; existing Teams are not moved. The folder is created when a Team starts; path and write access are checked then.' : '填写运行 Host 的电脑上的绝对目录路径，须与仓库同盘且位于仓库外。每个新团队会创建独立子目录，不迁移已有团队。启动团队时才创建目录，并检查路径和写入权限。'}</small>
                </label> : null}
                <details className="yuqi-settings-help"><summary>{locale === 'en' ? 'Advanced details' : '高级说明'}</summary>
                  <p>{copy.authorityHelp}</p><p>{copy.workspaceHelp}</p>
                </details>
              </section>
              <div className="yuqi-settings-feedback">
              {!workspaceRootValid ? <p className="yuqi-settings-error" role="alert">{locale === 'en' ? 'Enter an absolute folder path (for example F:\\Team Workspaces), not a drive root, network path or relative path; or leave it empty.' : '请填写绝对目录路径（例如 F:\\Team Workspaces），不能使用盘符根目录、网络路径或相对路径；也可以留空。'}</p> : null}
              {options === undefined && !optionsError ? <p className="yuqi-settings-note" aria-live="polite">{copy.optionsLoading}</p> : null}
              {optionsError ? <p className="yuqi-settings-error" role="alert">{copy.optionsError}</p> : null}
              {settings.status === 'loading' ? <p className="yuqi-settings-note" role="status">{copy.loading}</p> : null}
              {settings.status === 'unavailable' || !settings.writable ? <p className="yuqi-settings-error" role="alert">{copy.unavailable}</p> : null}
              {!valid && settings.status === 'ready' ? <p className="yuqi-settings-error" role="alert">{copy.invalidConcurrency(MIN_TEAM_CONCURRENCY, MAX_TEAM_CONCURRENCY)}</p> : null}
              {!routeValid && settings.status === 'ready' ? <p className="yuqi-settings-error" role="alert">{copy.invalidRoute}</p> : null}
              {!reviewValid && settings.status === 'ready' ? <p className="yuqi-settings-error" role="alert">{copy.invalidReview(MAX_REWORK_ROUNDS, MAX_REVIEW_ADDITIONAL_PROMPT_LENGTH)}</p> : null}
              {saveState === 'error' ? <p className="yuqi-settings-error" role="alert">{copy.saveError}</p> : null}
              {saveState === 'partial' ? <p className="yuqi-settings-error" role="alert">{copy.partialSaveError}</p> : null}
              </div>
            </div>
            <footer className="yuqi-settings-footer">
              <span aria-live="polite">{saved && !dirty ? (locale === 'en' ? 'Saved. Applies to new Teams.' : '已保存，对新建团队生效。') : dirty ? (locale === 'en' ? 'Unsaved changes' : '有未保存的修改') : (locale === 'en' ? 'Defaults apply to new Teams only.' : '默认设置仅影响新建团队。')}</span>
              <button type="button" className="yuqi-secondary-action" onClick={() => {
                if (embedded) { setResetVersion(value => value + 1); setSaveState('idle'); setSaved(false) }
                else setOpen(false)
              }} disabled={saveState === 'saving' || (embedded && !dirty)}>{embedded ? (locale === 'en' ? 'Discard changes' : '放弃修改') : copy.cancel}</button>
              <button type="button" className="yuqi-primary-action" onClick={() => { void save() }} disabled={!valid || !routeValid || !reviewValid || !workspaceRootValid || optionsError || options === undefined || saveState === 'saving' || settings.status !== 'ready' || !settings.writable}>
                {saveState === 'saving' ? copy.saving : copy.save}
              </button>
            </footer>
    </>
  if (embedded) return <div className="yuqi-settings-embedded" data-yuqi-team-settings-dialog="true">{content}</div>
  return open && typeof document !== 'undefined' ? createPortal(
    <div className="yuqi-settings-layer">
      <button type="button" className="yuqi-settings-backdrop" aria-label={copy.closeBackdrop} disabled={saveState === 'saving'} onClick={() => setOpen(false)} />
      <section ref={dialogRef} className="yuqi-settings-dialog yuqi-settings-wide" lang={localeLanguageTag(locale)} data-yuqi-team-settings-dialog="true" role="dialog" aria-modal="true" aria-labelledby="yuqi-team-settings-title">
        <header className="yuqi-settings-header"><div><h2 id="yuqi-team-settings-title">{copy.title}</h2><p>{copy.description}</p></div>
          <button type="button" className="yuqi-close-button" aria-label={copy.close} disabled={saveState === 'saving'} onClick={() => setOpen(false)}>×</button></header>
        {content}
      </section>
    </div>, document.body) : null
}

function ModelTierSelect({ tier, label, emptyLabel, candidates, options, allowedProviders, disabled, unavailableLabel, unavailableHelp, onChange }: {
  readonly tier: ModelRouteTaskTier
  readonly label: string
  readonly emptyLabel: string
  readonly candidates: readonly ProviderModelRef[]
  readonly options: TeamAgentOptions | undefined
  readonly allowedProviders: ReadonlySet<string>
  readonly disabled: boolean
  readonly unavailableLabel: string
  readonly unavailableHelp: string
  readonly onChange: (value: ProviderModelRef | undefined) => void
}) {
  const value = candidates[0]
  return (
    <label htmlFor={`yuqi-team-${tier}-model`}>
      <span>{label}{candidates.length > 1 ? ` (${candidates.length})` : ''}</span>
      <RouteSelect id={`yuqi-team-${tier}-model`} value={value} options={options} allowedProviders={allowedProviders}
        disabled={disabled} emptyLabel={emptyLabel} unavailableLabel={unavailableLabel} unavailableHelp={unavailableHelp} onChange={onChange} />
    </label>
  )
}

function RouteSelect({ id, value, options, allowedProviders, disabled, emptyLabel, unavailableLabel, unavailableHelp, onChange }: {
  readonly id: string
  readonly value: ProviderModelRef | undefined
  readonly options: TeamAgentOptions | undefined
  readonly allowedProviders: ReadonlySet<string>
  readonly disabled: boolean
  readonly emptyLabel: string
  readonly unavailableLabel: string
  readonly unavailableHelp: string
  readonly onChange: (value: ProviderModelRef | undefined) => void
}) {
  const selectedKey = value === undefined ? '' : routeKey(value)
  const selectedInCatalog = options?.providerGroups.some(group => group.id === value?.modelProvider
    && group.models.some(model => model.id === value.modelId)) ?? false
  return (
    <>
      <select id={id} value={selectedKey} disabled={disabled || options === undefined}
        onChange={event => onChange(event.currentTarget.value === '' ? undefined : routeFromKey(event.currentTarget.value))}>
        <option value="">{emptyLabel}</option>
        {value === undefined || selectedInCatalog ? null : <option value={selectedKey}>{value.modelProvider} / {value.modelId} · {unavailableLabel}</option>}
        {options?.providerGroups.map(group => {
          const include = allowedProviders.has(group.id) || group.id === value?.modelProvider
          return !include ? null : (
            <optgroup key={group.id} label={`${group.name} · ${group.id}`}>
              {group.models.map(model => (
                <option key={routeKey({ modelProvider: group.id, modelId: model.id })} value={routeKey({ modelProvider: group.id, modelId: model.id })}>
                  {model.name} · {model.id}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      {value !== undefined && options !== undefined && !selectedInCatalog ? <small className="yuqi-settings-route-warning" role="status">{unavailableHelp}</small> : null}
    </>
  )
}

function routeKey(route: ProviderModelRef): string {
  return JSON.stringify([route.modelProvider, route.modelId])
}

function routeFromKey(value: string): ProviderModelRef | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return undefined
    if (parsed[0].trim() === '' || parsed[1].trim() === '') return undefined
    return { modelProvider: parsed[0], modelId: parsed[1] }
  } catch {
    return undefined
  }
}

function routingFromSettings(settings: TeamSettings | undefined, controllerProvider?: string): ModelRoutingPolicy {
  if (settings?.modelRouting !== undefined) return settings.modelRouting
  const provider = controllerProvider?.trim() ?? ''
  if (settings?.childModelPolicy === 'fixed' && settings.childModelId.trim() !== '' && provider !== '') {
    return { providerScope: { kind: 'controller-only' }, teamPolicy: { kind: 'fixed', model: { modelProvider: provider, modelId: settings.childModelId } } }
  }
  const legacyCandidates = (value: string | undefined): readonly ProviderModelRef[] => value?.trim() === '' || value === undefined || provider === ''
    ? []
    : [{ modelProvider: provider, modelId: value }]
  if (settings?.childModelPolicy === 'automatic' || settings?.quickModelId || settings?.standardModelId || settings?.criticalModelId) {
    return {
      providerScope: { kind: 'controller-only' },
      teamPolicy: { kind: 'automatic', tierCandidates: {
        quick: legacyCandidates(settings?.quickModelId),
        standard: legacyCandidates(settings?.standardModelId),
        critical: legacyCandidates(settings?.criticalModelId),
      } },
    }
  }
  return DEFAULT_EXPERIMENTAL_MODEL_ROUTING
}

function policyOfKind(kind: ChildModelPolicy, current: TeamModelPolicy, controller: ProviderModelRef | undefined): TeamModelPolicy {
  if (kind === current.kind) return current
  if (kind === 'inherit') return { kind: 'inherit' }
  if (kind === 'automatic') return { kind: 'automatic', tierCandidates: { quick: [], standard: [], critical: [] } }
  return { kind: 'fixed', model: controller ?? { modelProvider: '', modelId: '' } }
}

function providerIdsForScope(scope: ProviderScope, controllerProvider: string | undefined): ReadonlySet<string> {
  const providers = new Set<string>()
  if (controllerProvider !== undefined && controllerProvider !== '') providers.add(controllerProvider)
  if (scope.kind === 'controller-plus-allowlist') for (const provider of scope.providerAllowlist) providers.add(provider)
  return providers
}

function updateProviderAllowlist(scope: ProviderScope, provider: string, checked: boolean): ProviderScope {
  const current = scope.kind === 'controller-plus-allowlist' ? scope.providerAllowlist : []
  return { kind: 'controller-plus-allowlist', providerAllowlist: checked
    ? [...new Set([...current, provider])]
    : current.filter(item => item !== provider) }
}

function providerChoices(options: TeamAgentOptions | undefined, configured: readonly string[], controllerProvider: string | undefined) {
  const byId = new Map<string, { readonly id: string; readonly name: string; readonly failed: boolean }>()
  for (const group of options?.providerGroups ?? []) byId.set(group.id, { id: group.id, name: group.name, failed: false })
  for (const failure of options?.failures ?? []) byId.set(failure.id, { id: failure.id, name: failure.name, failed: true })
  for (const id of configured) if (!byId.has(id)) byId.set(id, { id, name: id, failed: true })
  if (controllerProvider !== undefined && !byId.has(controllerProvider)) byId.set(controllerProvider, { id: controllerProvider, name: controllerProvider, failed: true })
  return [...byId.values()]
}

function legacyFieldsForRouting(routing: ModelRoutingPolicy): Pick<TeamSettings, 'childModelPolicy' | 'childModelId' | 'quickModelId' | 'standardModelId' | 'criticalModelId'> {
  const policy = routing.teamPolicy
  return {
    childModelPolicy: policy.kind,
    childModelId: policy.kind === 'fixed' ? policy.model.modelId : '',
    quickModelId: policy.kind === 'automatic' ? policy.tierCandidates.quick[0]?.modelId ?? '' : '',
    standardModelId: policy.kind === 'automatic' ? policy.tierCandidates.standard[0]?.modelId ?? '' : '',
    criticalModelId: policy.kind === 'automatic' ? policy.tierCandidates.critical[0]?.modelId ?? '' : '',
  }
}

function sameRoutingPolicy(left: ModelRoutingPolicy | undefined, right: ModelRoutingPolicy): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function sameReviewPolicy(left: ReviewPolicy | undefined, right: ReviewPolicy): boolean {
  const expected = { ...right, additionalPrompt: right.additionalPrompt.trim() }
  return left !== undefined && JSON.stringify(left) === JSON.stringify(expected)
}

const SETTINGS_COPY = {
  zh: {
    trigger: '团队设置', closeBackdrop: '关闭团队设置（点击背景）', title: '团队设置',
    description: '设置后续 Team 的并发、子代理模式、默认模型、权限与执行工作区。', close: '关闭团队设置',
    concurrency: '并发保护上限',
    concurrencyHelp: (min: number, max: number) => `范围 ${min}–${max}，默认 ${max}（自动跑满）：有多少个已就绪、互不依赖且不冲突的任务，就同时启动多少个。只有你主动降低此值时才会限流，主控模型无权改小。`,
    preset: '默认子代理模式', presetHelp: '来自 Harness 已安装的 Agent presets；自定义 preset 也会列出。一个 Team 的 worker 共享该模式，避免运行中工具契约不一致。',
     modelPolicy: '默认模型策略 / 模型路由策略', automatic: '自动（Automatic，实验性，按任务等级）', inherit: '跟随主控（Inherit）', fixed: '固定（Fixed，精确模型）',
    modelPolicyHelp: '策略保存精确的 Provider 与 Model；任务级精确路由优先。运行中换模会安全停止当前 attempt，再用新路由重启并保留已有证据。',
    currentProvider: '当前会话供应商', currentProviderUnknown: '当前会话供应商尚未取得；请选择会话后重新读取。下列目录不代表当前会话路由。', providerDirectoryFailed: '供应商目录读取失败，已有配置保留。', noProviders: '当前没有可读取的供应商目录；请先在官方模型设置中配置供应商。',
    providerScope: '允许的供应商', controllerOnly: '仅主控供应商', controllerOnlyHelp: 'Automatic 默认不会离开主控会话当前 Provider。',
    providerAllowlist: '主控及指定供应商', providerAllowlistHelp: '只有你明确勾选的其他 Provider 才能进入候选。',
    catalogResolved: '模型目录可解析', credentialsUnverified: '目录信息不代表凭证已配置、有效或获授权；实际调用前凭证仍未验证。',
    currentRouteRoutable: '当前会话 Provider 路由可用。', currentRouteUnroutable: '当前会话 Provider 路由不可用；目录中的已有配置仍会保留。',
    catalogFailure: '目录读取失败', providerFailurePreserved: '该 Provider 的目录读取失败；已有配置不会被清除。',
    fixedModel: '固定默认模型 / 精确路由', followController: '跟随主控模型（默认）', selectExactModel: '选择 Provider / Model', configuredUnavailable: '已保留历史配置；当前目录无法读取/验证', configuredUnavailableHelp: '这是保留的历史 Provider / Model，不代表当前已验证可调用。要选择其他模型，需满足 Provider 范围限制且目录可读取；不能通过手输 ID 绕过验证。',
    fixedModelHelp: '同时保存精确 Provider 与 Model；Provider 必须在上方范围内。',
    modelMapping: '按任务分级匹配模型', modelMappingHelp: '为不同难度的任务指定专属模型。未单独指定时，默认使用当前主控对话的模型。',
    quick: '快速任务', standard: '标准任务', critical: '关键任务', confirmPlan: '启动前确认任务图',
     confirmPlanHelp: '新 Team 先暂停，允许逐任务选择模型；点击“开始本次”后才开始消耗子代理 Token。',
    authority: '默认子代理权限', readOnly: '只读', workspaceWrite: '工作区写入', fullAccess: '完全访问', authorityHelp: '任务可单独覆盖。不同权限不会混入同一批次；同权限且无依赖、文件范围不冲突的任务仍会并行。',
    workspace: '执行工作区', directWorkspace: '当前项目（默认）', gitWorkspace: 'Git 隔离工作区',
    workspaceHelp: '当前项目不要求 Git，并直接修改现有文件；只有需要独立分支、隔离或回滚时才选择 Git，且仓库必须干净。',
    reviewPolicy: '关键节点自动审查', reviewPolicyHelp: '该策略原子保存并只复制到之后新建的 Team；不会改变正在运行的 Team。',
    reviewTriggers: '自动触发点：Team 计划、关键任务交接、连续失败升级、Team 完成。',
    reviewMode: { off: '不审查', manual: '手动审查', 'quality-gate': '自动审查' },
    reviewModeHelp: { off: '不创建审查代理，不额外消耗审查 Token。', manual: '仅在你主动请求时启动独立审查；执行审查会消耗额外模型 Token。', 'quality-gate': '在计划、关键交接、连续失败和完成节点运行独立审查。发现问题时可在设定轮数内返工；实际执行的审查和返工都会消耗额外模型 Token。' },
    experimental: '实验性 · 需主动启用', maxRework: '最多自动返工轮数（每 checkpoint）', maxReworkHelp: (max: number) => `范围 0–${max}，默认 2；0 表示只审查、不自动返工。达到上限后转交主控或用户决定。`,
    teamReworkLimit: (max: number) => `Team 自动纠错总上限：${max} 次；各 checkpoint 共用此预算。`,
    additionalPrompt: '审查重点与关注要点（选填）', additionalPromptHelp: (length: number, max: number) => `${length}/${max}；可填入本次任务需重点检查的要点（如边界异常、取消与恢复等）。留空时执行内置通用审查标准。`,
    invalidReview: (max: number, promptMax: number) => `返工轮数必须是 0 到 ${max} 的整数，补充要求不得超过 ${promptMax} 字符。`,
     optionsError: '无法读取已安装模式或模型，未保存配置。', optionsLoading: '正在读取已安装模式和模型…', loading: '正在读取团队设置…', unavailable: '当前连接不支持保存团队设置。',
    invalidConcurrency: (min: number, max: number) => `请输入 ${min} 到 ${max} 的整数。`, invalidRoute: '请选择范围内的精确 Provider / Model；已有但超出范围的路由不会被静默清除。', saveError: '保存失败，设置没有改变；请检查连接后重试。', partialSaveError: '设置只保存了一部分，或无法确认全部字段；已成功写入的内容可能仍然生效。请重新检查当前值后重试。',
    cancel: '取消', save: '保存', saving: '保存中…',
  },
  en: {
    trigger: 'Team settings', closeBackdrop: 'Close Team settings (click backdrop)', title: 'Team settings',
    description: 'Configure defaults for future Teams: concurrency, child Agent preset, model, permissions, and workspace.', close: 'Close Team settings',
    concurrency: 'Concurrency safety ceiling',
    concurrencyHelp: (min: number, max: number) => `Range ${min}–${max}; the default is ${max} (run all ready work). Every ready, independent, non-conflicting task starts together. Only an explicit user override may lower this ceiling; the controller model cannot.`,
    preset: 'Default child Agent preset', presetHelp: 'Uses installed Harness Agent presets, including custom presets. Workers in one Team share the preset to keep tool contracts consistent.',
    modelPolicy: 'Model routing policy', automatic: 'Automatic (match by task tier)', inherit: 'Inherit controller route', fixed: 'Fixed exact model',
    modelPolicyHelp: 'The policy stores an exact Provider and Model. An exact task route wins. Changing a running task safely ends its attempt, preserves evidence, and restarts on the new route.',
    currentProvider: 'Current conversation Provider', currentProviderUnknown: 'The current conversation Provider is unknown. Select a conversation and reload; this directory does not identify its route.', providerDirectoryFailed: 'Provider directory could not be loaded. Existing settings are preserved.', noProviders: 'No readable Provider directory. Configure Providers in the official model settings first.',
    providerScope: 'Provider scope', controllerOnly: 'Controller Provider only (default)', controllerOnlyHelp: 'Automatic routing does not leave the controller session’s current Provider by default.',
    providerAllowlist: 'Controller Provider + allowlist', providerAllowlistHelp: 'Only Providers you explicitly select may enter the candidate list.',
    catalogResolved: 'Model directory resolved', credentialsUnverified: 'Directory metadata does not prove that credentials are configured, valid, or authorized; credentials remain unverified until a live call.',
    currentRouteRoutable: 'The current session Provider route is available.', currentRouteUnroutable: 'The current session Provider route is unavailable; existing directory-based settings are preserved.',
    catalogFailure: 'directory lookup failed', providerFailurePreserved: 'This Provider directory failed to load. Existing configuration was not cleared.',
    fixedModel: 'Fixed exact route', followController: 'Follow controller model (default)', selectExactModel: 'Select Provider / Model', configuredUnavailable: 'historical configuration preserved; directory unavailable for verification', configuredUnavailableHelp: 'This is a preserved Provider / Model from an earlier configuration; it is not verified as callable now. To choose another model, the Provider must be inside the selected scope and its directory must be readable; typing an ID cannot bypass verification.',
    fixedModelHelp: 'Stores the exact Provider and Model. The Provider must be inside the scope above.',
    modelMapping: 'Tiered Model Matching', modelMappingHelp: 'Assign dedicated models by task difficulty. Defaults to the current conversation model when unassigned.',
    quick: 'Quick tasks', standard: 'Standard tasks', critical: 'Critical tasks', confirmPlan: 'Confirm task graph before starting',
    confirmPlanHelp: 'New Teams pause before dispatch so you can review each task and model. Child Agent tokens are used only after you continue.',
    authority: 'Default child Agent permission', readOnly: 'Read only', workspaceWrite: 'Workspace write', fullAccess: 'Full access', authorityHelp: 'Tasks may override this value. Different permissions run in separate batches; independent tasks with the same permission can still run concurrently.',
    workspace: 'Execution workspace', directWorkspace: 'Current project (default)', gitWorkspace: 'Isolated Git worktree',
    workspaceHelp: 'Current project mode does not require Git and edits existing files directly. Choose Git only for an independent branch, isolation, or rollback; the repository must be clean.',
    reviewPolicy: 'Automatic review at key checkpoints', reviewPolicyHelp: 'This policy is saved atomically and copied only into future Teams. It does not change a Team already in progress.',
    reviewTriggers: 'Automatic triggers: Team plan, critical task handoff, consecutive failure escalation, and Team completion.',
    reviewMode: { off: 'No review', manual: 'Manual review', 'quality-gate': 'Automatic review' },
    reviewModeHelp: { off: 'Do not create a reviewer or spend review tokens.', manual: 'Run a review only when requested. Executed reviews consume additional model tokens.', 'quality-gate': 'Review the plan, critical handoffs, consecutive failures, and completion. Findings can trigger rework within the configured limit. Executed reviews and rework consume additional model tokens.' },
    experimental: 'Experimental · opt-in', maxRework: 'Maximum automatic rework rounds per checkpoint', maxReworkHelp: (max: number) => `Range 0–${max}; default 2. Zero means review only, with no automatic rework. At the limit, ownership returns to the controller or user.`,
    teamReworkLimit: (max: number) => `Team-wide automatic correction limit: ${max}; every checkpoint shares this budget.`,
    additionalPrompt: 'Additional reviewer prompt', additionalPromptHelp: (length: number, max: number) => `${length}/${max}; sent alongside the fixed review contract.`,
    invalidReview: (max: number, promptMax: number) => `Rework rounds must be an integer from 0 to ${max}, and the additional prompt must not exceed ${promptMax} characters.`,
     optionsError: 'Installed presets or models could not be loaded. Nothing was saved.', optionsLoading: 'Loading installed presets and models…', loading: 'Loading Team settings…', unavailable: 'This connection cannot save Team settings.',
    invalidConcurrency: (min: number, max: number) => `Enter an integer from ${min} to ${max}.`, invalidRoute: 'Choose an exact Provider / Model inside the scope. Existing out-of-scope routes were not silently cleared.', saveError: 'The save failed before any setting changed. Check the connection and retry.', partialSaveError: 'Only part of the settings were saved, or not every field could be confirmed. Successfully written values may still be active; review the current values before retrying.',
    cancel: 'Cancel', save: 'Save', saving: 'Saving…',
  },
} as const
