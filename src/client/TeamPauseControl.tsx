import { useEffect, useSyncExternalStore } from 'react'
import type { TeamConsoleSummary } from '../domain/team-console-contract.ts'
import { createRequestId, teamCommandLine, type YuqiCommand } from './command-actions.ts'
import { YuqiCommandOutcomeError, waitForCommandDelivery } from './command-outcome.ts'
import { useYuqiLocale } from './client-locale.ts'

type Pending = { readonly phase: 'submitting' | 'waiting' | 'error'; readonly message?: string; readonly action?: 'pause' | 'resume' }
// Share admission across the dock and details, including hide/reopen while a request is in flight.
const requests = new Map<string, Pending>()
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function publish(key: string, value?: Pending) {
  const timer = timers.get(key)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(key)
  if (value === undefined) requests.delete(key)
  else requests.set(key, value)
  listeners.forEach(listener => listener())
  // Bound retained state when all surfaces have been closed.
  if (value !== undefined) timers.set(key, setTimeout(() => publish(key), 5 * 60_000))
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export interface TeamPauseControlProps {
  readonly teamId: string
  readonly controllerSessionId?: string | undefined
  readonly status: TeamConsoleSummary['team']['status']
  readonly cancellationRequested?: boolean | undefined
  readonly command?: YuqiCommand | undefined
  readonly hideResumeButton?: boolean | undefined
}

export function TeamPauseControl({ teamId, controllerSessionId, status, cancellationRequested, command, hideResumeButton = false }: TeamPauseControlProps) {
  const en = useYuqiLocale() === 'en'
  const key = JSON.stringify([teamId, controllerSessionId])
  const request = useSyncExternalStore(subscribe, () => requests.get(key), () => undefined)
  const canControl = (status === 'running' || status === 'pausing' || status === 'paused') && !cancellationRequested
  const canPause = status === 'running' && !cancellationRequested
  const canResumeFromPaused = status === 'paused' && !cancellationRequested && !hideResumeButton
  useEffect(() => {
    // A confirmed projection wins over any late command result.
    if (!canControl) {
      publish(key)
    } else if (status === 'paused' && request?.action === 'pause') {
      publish(key)
    } else if (status === 'running' && request?.action === 'resume') {
      publish(key)
    }
  }, [key, canControl, status, request?.action])
  const waiting = request?.phase === 'submitting' || request?.phase === 'waiting'
  const unavailable = command === undefined || controllerSessionId === undefined

  async function pause(options?: { immediate?: boolean }) {
    if (!canControl || command === undefined || controllerSessionId === undefined || (requests.get(key)?.phase !== 'error' && requests.has(key))) return
    const operation: Pending = { phase: 'submitting', action: 'pause' }
    publish(key, operation)
    try {
      const accepted = await waitForCommandDelivery(command(teamCommandLine('pause', teamId, controllerSessionId, createRequestId(), options), { teamId, controllerSessionId }))
      if (requests.get(key) !== operation) return
      if (!accepted) {
        publish(key, { phase: 'error', message: en ? 'Pause was not admitted. Check the connection and retry.' : '暂停请求未受理，请检查连接后重试。', action: 'pause' })
        return
      }
      const pending: Pending = { phase: 'waiting', action: 'pause' }
      publish(key, pending)
      clearTimeout(timers.get(key))
      timers.set(key, setTimeout(() => {
        if (requests.get(key) === pending) publish(key, { phase: 'error', message: en
          ? 'No confirmed pause state after 15 seconds. Execution may still be settling; check Team state before retrying.'
          : '15 秒内未收到暂停状态确认，执行可能仍在收尾；请核对团队状态后重试。', action: 'pause' })
      }, 15_000))
    } catch (cause) {
      if (requests.get(key) !== operation) return
      publish(key, { phase: 'error', message: cause instanceof YuqiCommandOutcomeError ? cause.message : (en
        ? 'Pause transport failed; the result is unconfirmed. Check Team state before retrying.'
        : '暂停请求传输失败，结果尚未确认；请核对团队状态后重试。'), action: 'pause' })
    }
  }

  async function resume() {
    if (!canControl || command === undefined || controllerSessionId === undefined || (requests.get(key)?.phase !== 'error' && requests.has(key))) return
    const operation: Pending = { phase: 'submitting', action: 'resume' }
    publish(key, operation)
    try {
      const accepted = await waitForCommandDelivery(command(teamCommandLine('resume', teamId, controllerSessionId, createRequestId()), { teamId, controllerSessionId }))
      if (requests.get(key) !== operation) return
      if (!accepted) {
        publish(key, { phase: 'error', message: en ? 'Resume was not admitted. Check the connection and retry.' : '恢复请求未受理，请检查连接后重试。', action: 'resume' })
        return
      }
      const pending: Pending = { phase: 'waiting', action: 'resume' }
      publish(key, pending)
      clearTimeout(timers.get(key))
      timers.set(key, setTimeout(() => {
        if (requests.get(key) === pending) publish(key, { phase: 'error', message: en
          ? 'No confirmed resume state after 15 seconds. Check Team state before retrying.'
          : '15 秒内未收到恢复状态确认；请核对团队状态后重试。', action: 'resume' })
      }, 15_000))
    } catch (cause) {
      if (requests.get(key) !== operation) return
      publish(key, { phase: 'error', message: cause instanceof YuqiCommandOutcomeError ? cause.message : (en
        ? 'Resume transport failed; the result is unconfirmed. Check Team state before retrying.'
        : '恢复请求传输失败，结果尚未确认；请核对团队状态后重试。'), action: 'resume' })
    }
  }

  const reason = cancellationRequested || status === 'cancelling' ? (en ? 'Cancellation is in progress; pause is unavailable.' : '取消正在进行，暂不能暂停。')
    : status === 'needs_reconciliation' ? (en ? 'Verify execution state before pausing.' : '执行状态待安全核对，暂不能暂停。')
      : status === 'paused' ? (en ? 'Paused' : '已暂停')
        : status === 'draft' ? (en ? 'Execution has not started.' : '执行尚未开始，无需暂停。')
          : (en ? 'Execution has ended; pause is unavailable.' : '执行已结束，无需暂停。')
  return <div className="yuqi-pause-control">
    {canPause ? <button type="button" className="yuqi-secondary-action" disabled={unavailable || waiting}
      onClick={() => void pause()}>{waiting ? (en ? 'Pausing…' : '正在暂停…') : request?.phase === 'error' && request.action === 'pause' ? (en ? 'Retry pause' : '重试暂停') : (en ? 'Pause' : '暂停')}</button> : null}
    {status === 'pausing' ? <>
      <span role="status">{en ? 'Pausing (waiting for execution to settle)' : '正在暂停（等待执行收尾）'}</span>
      <button type="button" className="yuqi-secondary-action yuqi-pause-stop-immediate" disabled={unavailable || waiting}
        title={en ? 'Immediately interrupt active subagents and stop token consumption' : '立即打断正在运行的子代理并截断 Token 消耗'}
        onClick={() => void pause({ immediate: true })}>
        {waiting && request?.action === 'pause' ? (en ? 'Stopping…' : '正在停止…') : (en ? 'Stop now' : '立即停止')}
      </button>
      <button type="button" className="yuqi-secondary-action yuqi-pause-cancel-resume" disabled={unavailable || waiting}
        title={en ? 'Cancel pause and resume execution' : '取消暂停并恢复运行'}
        onClick={() => void resume()}>
        {waiting && request?.action === 'resume' ? (en ? 'Resuming…' : '正在恢复…') : (en ? 'Resume' : '恢复运行')}
      </button>
    </> : status === 'paused' ? <>
      <span role="status">{en ? 'Paused' : '已暂停'}</span>
      {canResumeFromPaused ? (
        <button type="button" className="yuqi-primary-action yuqi-pause-resume" disabled={unavailable || waiting}
          title={en ? 'Resume execution' : '继续团队任务执行'}
          onClick={() => void resume()}>
          {waiting && request?.action === 'resume' ? (en ? 'Resuming…' : '正在继续…') : request?.phase === 'error' && request.action === 'resume' ? (en ? 'Retry resume' : '重试继续') : (en ? 'Resume' : '继续任务')}
        </button>
      ) : null}
    </> : canPause && waiting ? <span role="status">{en ? 'Pausing (waiting for execution to settle)' : '正在暂停（等待执行收尾）'}</span>
      : !canPause ? <span role="status">{reason}</span> : unavailable ? <span role="status">{en ? 'View-only connection; pause is unavailable.' : '当前会话仅支持查看，暂不能暂停。'}</span> : null}
    {canControl && request?.phase === 'error' ? <span role="alert">{request.message}</span> : null}
  </div>
}
