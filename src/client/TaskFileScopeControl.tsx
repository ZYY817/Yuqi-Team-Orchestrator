import { useEffect, useId, useRef, useState } from 'react'
import type { TeamConsoleTask, TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { fileScopePatternSchema } from '../domain/file-scope.ts'
import { createRequestId, scopeCommandLine, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError } from './command-outcome.ts'
import { useYuqiLocale } from './client-locale.ts'

/** A contract editor, not a filesystem permission or execution control. */
export function TaskFileScopeControl({ task, teamId, controllerSessionId, teamStatus, cancellationRequested, command }: {
  readonly task: TeamConsoleTask
  readonly teamId: string
  readonly controllerSessionId: string | undefined
  readonly teamStatus: TeamConsoleSummary['team']['status'] | undefined
  readonly cancellationRequested: boolean
  readonly command: YuqiCommand | undefined
}) {
  const en = useYuqiLocale() === 'en'
  const id = useId()
  const saved = JSON.stringify([...new Set(task.fileScope)].sort())
  const [draft, setDraft] = useState(task.fileScope.join('\n'))
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const receipt = useRef<{ scope: string; requestId: string } | undefined>(undefined)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const snapshot = JSON.stringify([teamId, controllerSessionId, task.taskId, saved])
  const latest = useRef(snapshot)
  latest.current = snapshot
  const safe = teamStatus === 'paused' && task.manualControl?.teamStatus === 'paused'
    && task.manualControl.canAcquire && task.manualControl.ownership?.state !== 'human-owned'
    && !cancellationRequested && ['pending', 'ready', 'failed', 'cancelled', 'blocked'].includes(task.status)
  const parsed = fileScopePatternSchema.array().min(1).max(512).safeParse(draft.split(/\r?\n/u).map(line => line.trim()).filter(Boolean))
  const scope = parsed.success ? [...new Set(parsed.data)].sort() : []
  const canonical = JSON.stringify(scope)
  // The existing command payload decoder accepts at most 16384 characters.
  const valid = parsed.success && canonical.length <= 16_384
    && scopeCommandLine(task.taskId, scope, teamId, controllerSessionId ?? '', '0'.repeat(36)).length <= 24_576
  const unavailable = !safe || command === undefined || controllerSessionId === undefined

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    setDraft((JSON.parse(saved) as string[]).join('\n'))
    setWaiting(false)
    setError(null)
    setNotice(receipt.current?.scope === saved
      ? (en ? 'Scope persisted. The Team remains paused; continue explicitly when ready.' : '范围已持久化，Team 保持暂停；准备好后请显式继续。') : null)
    receipt.current = undefined
  }, [snapshot, en, saved])
  useEffect(() => {
    if (!waiting) return
    const timer = window.setTimeout(() => {
      setWaiting(false)
      setNotice(null)
      setError(en ? 'No durable scope update yet. Refresh to confirm, or retry the same request.' : '尚未收到持久化范围更新，请刷新核对，或重试同一请求。')
    }, 15_000)
    return () => window.clearTimeout(timer)
  }, [waiting, en])

  async function submit() {
    if (unavailable || !valid || canonical === saved || waiting || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    const submittedFor = snapshot
    const request = receipt.current?.scope === canonical ? receipt.current : { scope: canonical, requestId: createRequestId() }
    receipt.current = request
    try {
      const accepted = await command!(scopeCommandLine(task.taskId, scope, teamId, controllerSessionId!, request.requestId), { teamId, controllerSessionId: controllerSessionId! })
      if (!mounted.current || latest.current !== submittedFor) return
      if (accepted) {
        setWaiting(true)
        setNotice(en ? 'Scope submitted; waiting for the persisted update. No continue request was sent.' : '范围已提交，等待持久化更新；未发送继续请求。')
      } else setError(en ? 'Command rejected. Check the connection and retry.' : '命令未受理，请检查连接后重试。')
    } catch (cause) {
      if (!mounted.current || latest.current !== submittedFor) return
      setError(cause instanceof YuqiCommandOutcomeError ? cause.message : en ? 'Transport failed; the result is unknown. Refresh or retry the same request.' : '传输失败，结果未知；请刷新或重试同一请求。')
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <div className="yuqi-task-command" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, width: '100%', overflowWrap: 'anywhere' }} aria-busy={busy}>
    <label className="yuqi-manual-summary" htmlFor={id}>{en ? 'Planned file scope (one path or glob per line)' : '计划文件范围（每行一个路径或 glob）'}
      <textarea id={id} rows={4} style={{ boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' }} value={draft}
        disabled={busy || waiting || unavailable} aria-describedby={`${id}-help`} aria-invalid={!valid}
        onChange={event => { setDraft(event.currentTarget.value); setError(null); setNotice(null) }} />
    </label>
    <p id={`${id}-help`}>{en ? 'Replaces the entire scope. Include existing paths to keep them. This changes scheduling only, grants no permissions, and never resumes the Team.' : '完整替换范围；需要保留的路径请一并填写。仅修改调度契约，不新增权限，也不会自动继续 Team。'}</p>
    {unavailable ? <p>{en ? 'Submit only after the entire Team is safely paused, execution and leases have settled, and manual ownership has been returned. A bound controller connection is required.' : '整个 Team 安全暂停、执行及租约收尾、人工接管交还后才可提交，并需要已绑定的主控连接。'}</p> : null}
    {!valid ? <p role="alert" className="yuqi-inline-error">{en ? 'Enter 1–512 project-relative paths/globs, at most 16384 JSON characters. Absolute paths and . or .. segments are invalid.' : '请填写 1–512 个项目相对路径/glob，JSON 总长度不超过 16384 字符；不能使用绝对路径或 .、.. 路径段。'}</p> : null}
    <button type="button" className="yuqi-child-link" disabled={unavailable || busy || waiting || !valid || canonical === saved} onClick={() => void submit()}>{busy ? (en ? 'Submitting…' : '提交中…') : waiting ? (en ? 'Awaiting scope update…' : '等待范围更新…') : (en ? 'Apply file scope' : '应用文件范围')}</button>
    <button type="button" className="yuqi-child-link" disabled={busy || waiting || draft === task.fileScope.join('\n')} onClick={() => { setDraft(task.fileScope.join('\n')); setError(null); setNotice(null) }}>{en ? 'Discard scope edits' : '放弃范围修改'}</button>
    {error === null ? null : <p role="alert" className="yuqi-inline-error">{error}</p>}
    {notice === null ? null : <p role="status" className="yuqi-command-notice">{notice}</p>}
  </div>
}
