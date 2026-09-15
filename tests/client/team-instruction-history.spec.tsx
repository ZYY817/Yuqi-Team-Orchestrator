// @vitest-environment jsdom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync } from 'node:fs'
import { yuqiTeamStyles } from '../../src/client/styles.ts'
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TeamInstructionHistory } from '../../src/client/TeamInstructionHistory.tsx'
import { TEAM_INSTRUCTION_EVENT, type TeamInstruction } from '../../src/domain/team-instruction.ts'
import type { SidecarState } from '../../src/client/sidecar-store.ts'
import { hasInstructionDeliveryEvidence } from '../../src/client/instruction-delivery-evidence.ts'
import { teamSidecarEventSchema } from '../../src/domain/team-sidecar-web-contract.ts'

afterEach(cleanup)
const record: TeamInstruction = { operationId: 'r1', teamId: 't1', controllerSessionId: 'controller', authorSessionId: 'parent',
  target: 'all', text: '补充要求原文：请保留已有修改。', createdAt: '2026-09-14T00:00:00Z', recipients: [
    { taskId: 'inventory', goal: '检查文件', childSessionId: 'child', messageId: 'accepted-id', status: 'accepted' },
    { taskId: 'fix', goal: '修复门禁', status: 'failed', detail: 'Team paused' },
  ] }
function fixture() {
  const state: SidecarState = { status: 'ready', legacy: new Set(), summaries: new Map(), events: new Map([['controller', [
    { type: TEAM_INSTRUCTION_EVENT, seq: 1, time: 1, ignorable: true, data: record },
    { type: TEAM_INSTRUCTION_EVENT, seq: 2, time: 2, ignorable: true, data: record },
  ].map(event => teamSidecarEventSchema.parse(event))]]) }
  return { sessionId: 'parent', store: { subscribe: () => () => {}, getSnapshot: () => state },
    openChild: vi.fn(async () => true), checkDelivery: vi.fn(async () => true) }
}
describe('conversation instruction history', () => {
  it('requires an exact user message identity, not acceptance or a later assistant message', () => {
    expect(hasInstructionDeliveryEvidence([{ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'id' }] } },
      { type: 'assistant/message', data: { message: { id: 'id' } } }], 'id')).toBe(false)
    expect(hasInstructionDeliveryEvidence([{ type: 'user/message', data: { id: 'other' } }], 'id')).toBe(false)
    expect(hasInstructionDeliveryEvidence([{ type: 'user/message', data: { id: 'id' } }], 'id')).toBe(true)
    expect(hasInstructionDeliveryEvidence([{ type: 'user/message', data: { message: { id: 'id' } } }], 'id')).toBe(true)
  })
  it('renders the isolated source fixture for optional browser layout verification', () => {
    const html = renderToStaticMarkup(createElement(TeamInstructionHistory, fixture()))
    expect(html).toContain(record.text)
    if (process.env.YUQI_INSTRUCTION_QA_HTML) writeFileSync(process.env.YUQI_INSTRUCTION_QA_HTML,
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Team instruction source fixture</title><style>body{font-family:system-ui;margin:20px;max-width:900px} ${yuqiTeamStyles}</style><body><p>隔离源码渲染样例 · 非真实 Team 或部署验收</p>${html}</body></html>`)
  })
  it('shows one original, targets, partial failure and navigates exact child without sending', async () => {
    const props = fixture()
    render(createElement(TeamInstructionHistory, props))
    expect(screen.getAllByText(record.text)).toHaveLength(1)
    expect(screen.getByText('接口已受理；尚未确认处理或回复')).toBeTruthy()
    expect(screen.getByText('发送失败：门禁拒绝')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看子对话与真实回复' }))
    expect(props.openChild).toHaveBeenCalledWith('controller', 'child')
    fireEvent.click(screen.getByRole('button', { name: '核对真实送达' }))
    await waitFor(() => expect(screen.getByText(/已送达：子对话已记录同一 messageId/)).toBeTruthy())
    expect(props.checkDelivery).toHaveBeenCalledWith('controller', 'child', 'accepted-id')
  })
  it('does not treat absent history as delivery failure or invent a reply', async () => {
    const props = fixture()
    props.checkDelivery.mockResolvedValue(false)
    render(createElement(TeamInstructionHistory, props))
    fireEvent.click(screen.getByRole('button', { name: '核对真实送达' }))
    await waitFor(() => expect(screen.getByText(/送达仍未确认/)).toBeTruthy())
    expect(screen.queryByText(/已送达：/)).toBeNull()
  })
  it('reopens persisted history without sending and isolates another parent', () => {
    const props = fixture()
    const view = render(createElement(TeamInstructionHistory, props))
    view.unmount()
    render(createElement(TeamInstructionHistory, props))
    expect(screen.getAllByText(record.text)).toHaveLength(1)
    cleanup()
    render(createElement(TeamInstructionHistory, { ...props, sessionId: 'other' }))
    expect(screen.queryByText(record.text)).toBeNull()
    expect(props.checkDelivery).not.toHaveBeenCalled()
  })
})
