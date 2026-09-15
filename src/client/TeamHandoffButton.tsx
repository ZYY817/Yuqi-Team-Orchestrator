import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useYuqiLocale } from './client-locale.ts'
import {
  canHandoff, getHandoffAttempt, HANDOFF_GOAL_LIMIT, HANDOFF_SUMMARY_LIMIT,
  submitTeamHandoff, subscribeHandoff, validHandoffContext,
  type CreateTeamHandoff, type TeamHandoffSource,
} from './team-handoff.ts'

export interface TeamHandoffButtonProps {
  readonly source: TeamHandoffSource
  /** Omit until the real Host adapter is available: no pretend action. */
  readonly createHandoff?: CreateTeamHandoff | undefined
  /** Navigation only: must never create a session or resend its prompt. */
  readonly openTarget: (sessionId: string) => Promise<boolean>
}

export function TeamHandoffButton(props: TeamHandoffButtonProps) {
  // A source change resets only the draft/dialog; submitted identities live outside React.
  return <HandoffForSource key={props.source.sessionId} {...props} />
}

function HandoffForSource({ source, createHandoff, openTarget }: TeamHandoffButtonProps) {
  const en = useYuqiLocale() === 'en'
  const id = useId()
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [summary, setSummary] = useState('')
  const [localError, setLocalError] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const openInFlight = useRef(false)
  const mounted = useRef(true)
  const trigger = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const attempt = useSyncExternalStore(subscribeHandoff,
    () => getHandoffAttempt(source.sessionId), () => undefined)
  const eligible = canHandoff(source) && createHandoff !== undefined
  const visible = open && eligible
  const retryable = attempt?.kind === 'rejected' && attempt.retryable === true
  const locked = attempt !== undefined && !retryable

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  async function openExistingTarget() {
    if (attempt === undefined || openInFlight.current) return
    openInFlight.current = true
    setOpening(true)
    setOpenFailed(false)
    let timeout: number | undefined
    // The ID is a captured fact; navigation must not reuse changing props.
    try {
      const opened = await Promise.race([
        openTarget(attempt.targetSessionId),
        new Promise<boolean>(resolve => { timeout = window.setTimeout(() => resolve(false), 15_000) }),
      ])
      if (mounted.current) setOpenFailed(!opened)
    } catch {
      if (mounted.current) setOpenFailed(true)
    } finally {
      window.clearTimeout(timeout)
      openInFlight.current = false
      if (mounted.current) setOpening(false)
    }
  }

  useEffect(() => { if (!eligible) setOpen(false) }, [eligible])
  useEffect(() => {
    if (!visible) return
    const panel = dialog.current
    const invoking = trigger.current
    panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
      if (event.key !== 'Tab' || panel === null) return
      const elements = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled)')]
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      // Navigation by the adapter must not steal focus back to the old session.
      if (invoking?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body)) invoking.focus()
    }
  }, [visible])

  if (!eligible) return null
  const messages = en ? {
    pending: 'Handoff submitted. Waiting for the Host result.',
    opened: 'The Host reports that the Team conversation was opened. This does not confirm task execution.',
    created: 'The conversation was created, but opening and prompt delivery are not confirmed. Check the target conversation.',
    unknown: 'The outcome is unknown. Check the target conversation before any further action.',
    rejected: 'The handoff was rejected. Check the Host response and target identity.',
  } : {
    pending: '交接请求已提交，正在等待 Host 结果。',
    opened: 'Host 已报告打开团队会话；这不代表任务已执行。',
    created: '会话已创建，尚未确认打开及任务消息投递，请检查目标会话。',
    unknown: '交接结果未知，请先检查目标会话再决定后续操作。',
    rejected: '交接未受理，请核对 Host 回应及目标会话标识。',
  }
  return <>
    <button ref={trigger} type="button" className="yuqi-secondary-action" aria-haspopup="dialog"
      aria-expanded={visible} aria-controls={visible ? id : undefined} onClick={() => setOpen(true)}>
      {en ? 'Turn into a Team task' : '转为团队任务'}
    </button>
    {!visible ? null : createPortal(<div className="yuqi-settings-layer">
      <button type="button" className="yuqi-settings-backdrop" aria-label={en ? 'Close Team handoff' : '关闭团队交接'} onClick={() => setOpen(false)} />
      <section ref={dialog} id={id} className="yuqi-settings-dialog" lang={en ? 'en' : 'zh-CN'}
        role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}>
        <header className="yuqi-settings-header"><h2 id={`${id}-title`}>{en ? 'Turn into a Team task' : '转为团队任务'}</h2>
          <button type="button" className="yuqi-close-button" aria-label={en ? 'Close' : '关闭'} onClick={() => setOpen(false)}>×</button>
        </header>
        <form onSubmit={event => {
          event.preventDefault()
          if (locked || !canHandoff(source) || !validHandoffContext({ goal, summary })) return
          setLocalError(false)
          void submitTeamHandoff(source, { goal, summary }, createHandoff!).catch(() => setLocalError(true))
        }}>
          <div className="yuqi-settings-body" style={{ maxHeight: '60dvh', overflowY: 'auto', overflowWrap: 'anywhere' }}>
            <p id={`${id}-description`}>{en
              ? 'Keep this conversation and create a new Team conversation in the same project. Only the goal and summary you enter below will be handed over; conversation history is not collected automatically.'
              : '保留原对话，在同一项目新建团队会话。仅交接你在下方填写的目标和摘要，不会自动采集对话历史。'}</p>
            <p>{en ? 'Project: ' : '项目：'}{source.cwd}</p>
            <label className="yuqi-settings-field" htmlFor={`${id}-goal`}><span>{en ? 'Task goal (required)' : '任务目标（必填）'}</span>
              <textarea id={`${id}-goal`} required rows={3} maxLength={HANDOFF_GOAL_LIMIT} readOnly={locked} value={goal} onChange={event => setGoal(event.currentTarget.value)} />
            </label>
            <label className="yuqi-settings-field" htmlFor={`${id}-summary`}><span>{en ? 'Context summary (optional)' : '上下文摘要（可选）'}</span>
              <textarea id={`${id}-summary`} rows={4} maxLength={HANDOFF_SUMMARY_LIMIT} readOnly={locked} value={summary} onChange={event => setSummary(event.currentTarget.value)} />
            </label>
            {attempt === undefined ? null : <div role={attempt.kind === 'unknown' || attempt.kind === 'rejected' ? 'alert' : 'status'}>
              <p>{messages[attempt.kind]}</p>
              {attempt.message ? <p>{attempt.message}</p> : null}
              <p>{en ? 'Target conversation ID: ' : '目标会话 ID：'}<code>{attempt.targetSessionId}</code></p>
              <p>{retryable
                ? (en ? 'No creation or delivery side effects were reported. You may edit and retry with the same target ID.' : '已确认未创建会话或投递消息，可修改后使用同一目标 ID 重试。')
                : (en ? 'This request will not be recreated or resent. Closing this dialog does not cancel the Host operation.' : '此请求不会重复创建或发送。关闭此窗口不会取消 Host 操作。')}</p>
              <button type="button" className="yuqi-secondary-action" disabled={opening} onClick={() => { void openExistingTarget() }}>
                {opening ? (en ? 'Opening…' : '打开中…') : (en ? 'Open target conversation' : '打开目标会话')}
              </button>
              {openFailed ? <p role="alert">{en ? 'Could not open the target conversation. It may not exist or the Host connection may be unavailable. No creation or message was retried.' : '目标会话未能打开，可能尚未创建或 Host 连接不可用；没有重试创建或发送消息。'}</p> : null}
            </div>}
            {localError ? <p role="alert">{en ? 'Unable to prepare the handoff. No new request was confirmed.' : '无法准备交接，尚未确认新请求。'}</p> : null}
          </div>
          <footer className="yuqi-settings-footer">
            <button type="button" className="yuqi-secondary-action" onClick={() => setOpen(false)}>{en ? 'Close' : '关闭'}</button>
            <button type="submit" className="yuqi-primary-action" disabled={locked || !validHandoffContext({ goal, summary })}>
              {retryable ? (en ? 'Retry handoff' : '重试交接') : (en ? 'Create Team conversation' : '确认新建团队会话')}
            </button>
          </footer>
        </form>
      </section>
    </div>, document.body)}
  </>
}
