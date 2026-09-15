import { useRef, useState, useSyncExternalStore } from 'react'
import { readTeamInstructions, type TeamInstruction } from '../domain/team-instruction.ts'
import type { SidecarState } from './sidecar-store.ts'
import { useYuqiLocale } from './client-locale.ts'

export interface TeamInstructionHistoryProps {
  sessionId: string
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SidecarState }
  openChild(controllerId: string, childId: string): Promise<boolean>
  checkDelivery(controllerId: string, childId: string, messageId: string): Promise<boolean>
}

/** Read-only conversation dock. Rendering or checking receipts never sends a prompt. */
export function TeamInstructionHistory({ sessionId, store, openChild, checkDelivery }: TeamInstructionHistoryProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const en = useYuqiLocale() === 'en'
  const [checks, setChecks] = useState<Record<string, string>>({})
  let records: TeamInstruction[] = []
  for (const events of state.events.values()) {
    records.push(...readTeamInstructions(events).filter(record => record.authorSessionId === sessionId || record.controllerSessionId === sessionId))
  }
  const retained = useRef<{ sessionId: string; records: TeamInstruction[] }>({ sessionId, records: [] })
  if (state.status === 'ready') retained.current = { sessionId, records }
  else if (retained.current.sessionId === sessionId) records = retained.current.records
  if (!records.length) return null
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return <section className="yuqi-instruction-history" aria-label={en ? 'Team messages' : '团队消息记录'}>
    <strong>{en ? 'Team messages' : '团队消息记录'}</strong>
    {state.status !== 'ready' ? <p role="status">{en ? 'Refresh unavailable; showing the last loaded receipts.' : '刷新暂不可用，以下保留上次读取的消息回执。'}</p> : null}
    <p>{en ? 'Your instructions and Host receipts. Replies are in the target conversations; no causal reply link is provided by this Host.' : '你的补充要求与 Host 回执。真实回复请打开对应子对话；Host 未提供逐条回复关联，不能认定后续输出是在回复本条。'}</p>
    {records.map(record => <article key={`${record.controllerSessionId}:${record.operationId}`}>
      <header>{en ? 'You → ' : '你 → '}{record.target === 'all' ? (en ? 'Running tasks at send time' : '发送时运行中的任务') : record.target} · <time>{record.createdAt}</time></header>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.text}</div>
      <small>{en ? 'Request' : '请求'}：{record.operationId}</small>
      <p>{en ? 'Recipients' : '接收方'}：{record.recipients.length} · {en ? 'API accepted' : '接口受理'} {record.recipients.filter(row => row.status === 'accepted').length} · {en ? 'Failed' : '失败'} {record.recipients.filter(row => row.status === 'failed').length} · {en ? 'Pending / unknown' : '待确认／未知'} {record.recipients.filter(row => row.status === 'sending' || row.status === 'unknown').length}</p>
      {record.recipients.length === 0 ? <p>{en ? 'Not sent: no eligible task.' : '未发送：没有可接收的目标任务。'}</p> : null}
      {record.recipients.map(recipient => {
        const key = `${record.controllerSessionId}:${record.operationId}:${recipient.taskId}`
        const labels = en ? { sending: 'Sending / receipt pending; do not resend', accepted: 'API accepted; processing and reply unconfirmed', failed: 'Not sent: gate rejected', unknown: 'Delivery unknown; do not resend' }
          : { sending: '发送中／等待回执；中断后不可据此重发', accepted: '接口已受理；尚未确认处理或回复', failed: '发送失败：门禁拒绝', unknown: '投递未知；勿重复发送' }
        return <div key={recipient.taskId} className="yuqi-instruction-recipient">
          <strong>{recipient.taskId}</strong> · {recipient.goal}<p role="status">{labels[recipient.status]}</p>
          {recipient.detail ? <p>{recipient.detail}</p> : null}
          {recipient.messageId ? <small>Host messageId：{recipient.messageId}</small> : null}
          {recipient.childSessionId ? <button type="button" onClick={() => { void openChild(record.controllerSessionId, recipient.childSessionId!).then(ok => {
            if (!ok) setChecks(old => ({ ...old, [key]: en ? 'Conversation unavailable; identity retained below.' : '子对话暂不可打开；下方保留定位身份。' }))
          }).catch(cause => setChecks(old => ({ ...old, [key]: cause instanceof Error && cause.name === 'YuqiTeamChildNavigationError'
            ? `${cause.message} ${en ? 'Navigation failure does not establish execution state.' : '导航失败不代表任务停止。'}`
            : en ? 'Could not open conversation.' : '无法打开子对话。' }))) }}>{en ? 'Open real conversation / replies' : '查看子对话与真实回复'}</button> : null}
          {recipient.childSessionId && recipient.messageId ? <button type="button" disabled={checks[key] === (en ? 'Checking…' : '正在核对…')} onClick={() => {
            setChecks(old => ({ ...old, [key]: en ? 'Checking…' : '正在核对…' }))
            void checkDelivery(record.controllerSessionId, recipient.childSessionId!, recipient.messageId!).then(found => setChecks(old => ({ ...old,
              [key]: found ? (en ? 'Delivered: exact message found in child conversation. This does not prove a reply.' : '已送达：子对话已记录同一 messageId；不代表已回复。')
                : (en ? 'No matching message in loaded history; delivery remains unconfirmed.' : '已读取历史未找到同一消息；送达仍未确认。') })))
              .catch(() => setChecks(old => ({ ...old, [key]: en ? 'History unavailable; delivery unconfirmed.' : '历史读取失败，送达未确认。' })))
          }}>{en ? 'Check delivery' : '核对真实送达'}</button> : null}
          {recipient.childSessionId ? <small>{en ? 'Conversation' : '子对话'}：{recipient.childSessionId}</small> : null}
          {checks[key] ? <p role="status">{checks[key]}</p> : null}
        </div>
      })}
    </article>)}
  </section>
}
