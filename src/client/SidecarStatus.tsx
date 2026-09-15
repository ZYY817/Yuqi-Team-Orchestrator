import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SidecarStore } from './sidecar-store.ts'
import { useYuqiLocale } from './client-locale.ts'

const SIDECAR_DISMISSED_KEY = 'yuqi_sidecar_status_dismissed'

function readDismissed(): boolean {
  try {
    return typeof window !== 'undefined' && window.sessionStorage?.getItem(SIDECAR_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

function writeDismissed(value: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      if (value) window.sessionStorage.setItem(SIDECAR_DISMISSED_KEY, 'true')
      else window.sessionStorage.removeItem(SIDECAR_DISMISSED_KEY)
    }
  } catch {}
}

export function SidecarStatus({ store }: { readonly store: SidecarStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const en = useYuqiLocale() === 'en'
  const unavailable = [...(state.unavailable ?? [])]
  const healthy = state.status === 'ready' && unavailable.length === 0
  const [collapsed, setCollapsed] = useState(state.status === 'loading')
  const [dismissed, setDismissedState] = useState(readDismissed)
  const setDismissed = (val: boolean) => {
    writeDismissed(val)
    setDismissedState(val)
  }
  const toggleRef = useRef<HTMLButtonElement>(null)
  const focusToggle = useRef(false)
  useEffect(() => {
    // A retry's loading/error transitions are one unresolved incident. Only a
    // healthy snapshot starts a new incident that may show its full notice.
    if (healthy) {
      setCollapsed(false)
      setDismissed(false)
    }
  }, [healthy])
  useEffect(() => {
    if (focusToggle.current) {
      toggleRef.current?.focus()
      focusToggle.current = false
    }
  }, [collapsed])
  const toggle = () => { focusToggle.current = true; setCollapsed(value => !value) }
  if (healthy || dismissed) return null

  const isNetworkOffline = state.status === 'error' && typeof state.error === 'string' && (
    state.error.includes('Failed to fetch') ||
    state.error.includes('NetworkError') ||
    state.error.includes('ECONNREFUSED') ||
    state.error.includes('connection closed')
  )

  const label = en ? 'Team data status' : 'Team 数据状态'
  if (collapsed) return <div className="yuqi-sidecar-status-collapsed-wrap">
    <button ref={toggleRef} type="button" className="yuqi-sidecar-status yuqi-sidecar-status-collapsed" aria-expanded={false} onClick={toggle}>
      {label}：{state.status === 'loading' ? (en ? 'Loading' : '加载中')
        : state.status === 'cancelled' ? (en ? 'Cancelled' : '已取消')
          : state.status === 'ready' ? (en ? 'Partly unavailable' : '部分不可用') : (en ? 'Load failed' : '加载失败')}
    </button>
    <button type="button" className="yuqi-sidecar-close-mini" aria-label={en ? 'Close notice' : '关闭提示'} title={en ? 'Close notice' : '关闭提示'} onClick={() => setDismissed(true)}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <line x1="3" y1="3" x2="13" y2="13" />
        <line x1="13" y1="3" x2="3" y2="13" />
      </svg>
    </button>
  </div>

  return <div role="status" className="yuqi-sidecar-status" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setDismissed(true) }
  }}>
    <header className="yuqi-sidecar-status-header">
      <strong>{label}</strong>
      <div className="yuqi-sidecar-header-actions">
        <button ref={toggleRef} type="button" className="yuqi-secondary-action" aria-expanded={true} onClick={toggle}>{en ? 'Collapse notice' : '收起提示'}</button>
        <button type="button" className="yuqi-sidecar-close" aria-label={en ? 'Close notice' : '关闭提示'} title={en ? 'Close notice' : '关闭提示'} onClick={() => setDismissed(true)}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <line x1="3" y1="3" x2="13" y2="13" />
            <line x1="13" y1="3" x2="3" y2="13" />
          </svg>
        </button>
      </div>
    </header>
    <span>{state.status === 'ready' ? (en ? `${unavailable.length} conversation logs are unavailable. Their Team controls are disabled; other conversations remain available. Original records have not been changed.` : `${unavailable.length} 个会话记录不可用，已禁用相关团队入口；其他会话仍可使用。原始记录未修改。`)
      : state.status === 'loading' ? (en ? 'Loading Team data…' : '正在加载 Team 数据…')
      : state.status === 'cancelled' ? (en ? 'Team loading cancelled. Refresh to restore controls.' : 'Team 加载已取消，刷新后恢复操作。')
        : isNetworkOffline ? (en ? 'Team data unavailable: Local service connection interrupted. Reconnecting…' : 'Team 数据加载失败：本地服务连接暂时中断，正在等待服务恢复…')
        : (en ? 'Team data unavailable. Stale controls have been cleared. Retry loading.' : 'Team 数据加载失败，已清除旧操作入口，请重试。')}</span>
    {state.status === 'error' && state.error ? <details className="yuqi-sidecar-error-detail"><summary>{en ? 'Technical reason' : '查看原因'}</summary><p>{isNetworkOffline ? (en ? `${state.error} (Local service may be starting or restarting. Will automatically recover once connected.)` : `${state.error}（本地服务可能正在启动或重启，连接建立后将自动恢复）`) : state.error}</p></details> : null}
    {unavailable.length > 0 ? <details><summary>{en ? 'Affected conversations' : '受影响的会话'}</summary><ul>{unavailable.map(id => <li key={id}>{id}</li>)}</ul></details> : null}
    <div className="yuqi-sidecar-status-actions">
      <button type="button" className="yuqi-secondary-action" onClick={() => { void store.refresh() }}>{en ? 'Refresh Team data' : '刷新 Team 数据'}</button>
      {state.status === 'loading' ? <button type="button" className="yuqi-secondary-action" onClick={store.cancel}>{en ? 'Cancel loading' : '取消加载'}</button> : null}
      <button type="button" className="yuqi-secondary-action" onClick={() => setDismissed(true)}>{en ? 'Dismiss notice' : '关闭提示'}</button>
    </div>
  </div>
}
