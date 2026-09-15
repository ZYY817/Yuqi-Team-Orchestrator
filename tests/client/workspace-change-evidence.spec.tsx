// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { expect, it, vi } from 'vitest'
import { WorkspaceChangeEvidence } from '../../src/client/WorkspaceChangeEvidence.tsx'

const snapshot = { kind: 'workspace-change-snapshot', seq: 3, data: {
  version: 1, childSessionId: 'child-a', runId: 'run-a', scope: 'workspace', attribution: 'unavailable', partial: false,
  beforeCapturedAt: '2026-09-06T00:00:00Z', afterCapturedAt: '2026-09-06T00:01:00Z', reasons: [],
  changes: [{ path: 'evidence.ts', kind: 'modified', before: { sha256: 'a'.repeat(64), size: 1 }, after: { sha256: 'b'.repeat(64), size: 2 } }],
} }

it('keeps activity workspace evidence hidden without a snapshot', () => {
  const { container } = render(<WorkspaceChangeEvidence variant="activity" nodes={[]} sessionId="child-a" en={false} onRefresh={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
})

it('keeps activity snapshot fingerprints and places refresh with the snapshot heading', () => {
  const refresh = vi.fn()
  render(<WorkspaceChangeEvidence variant="activity" nodes={[snapshot]} sessionId="child-a" en={false} onRefresh={refresh} />)
  expect(screen.getByRole('heading', { name: '工作区文件改动快照' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '刷新工作区快照' }))
  expect(refresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByText('文件指纹'))
  expect(screen.getByText(new RegExp(`a{64}`))).toBeVisible()
  expect(screen.getByText(new RegExp(`b{64}`))).toBeVisible()
})
