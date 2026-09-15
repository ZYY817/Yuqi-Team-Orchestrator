import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyHarnessExecutionBoundary } from '../src/host/harness/continuable-child.ts'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-boundary-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const other = path.join(root, 'other')
  await Promise.all([mkdir(workspace), mkdir(other)])
  return { root, workspace, other }
}

function harness(cwd: string | undefined, workspaceRoot: string | undefined, mode: string) {
  const controller = { session: { header: { ...(cwd === undefined ? {} : { cwd }) } } } as unknown as Agent
  const ctx = { sandboxPolicy: { resolve: () => ({ workspaceRoot, mode }) } } as unknown as Context
  return { controller, ctx }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

describe('verifyHarnessExecutionBoundary', () => {
  it('accepts only the exact real controller cwd, policy root, and sandbox mode', async () => {
    const { workspace } = await fixture()
    const value = harness(workspace, workspace, 'workspace-write')
    await expect(verifyHarnessExecutionBoundary(value.ctx, value.controller, {
      cwd: workspace, sandboxMode: 'workspace-write',
    })).resolves.toBeUndefined()
  })

  it('accepts a cold-restored mode-only policy when the immutable Session cwd still matches exactly', async () => {
    const { workspace } = await fixture()
    const value = harness(workspace, undefined, 'read-only')
    await expect(verifyHarnessExecutionBoundary(value.ctx, value.controller, {
      cwd: workspace, sandboxMode: 'read-only',
    })).resolves.toBeUndefined()
  })

  it('rejects missing or mismatched cwd, policy root, mode, and unresolved paths', async () => {
    const { root, workspace, other } = await fixture()
    const cases = [
      harness(undefined, workspace, 'workspace-write'),
      harness(other, workspace, 'workspace-write'),
      harness(workspace, other, 'workspace-write'),
      harness(workspace, workspace, 'danger-full-access'),
    ]
    for (const value of cases) {
      await expect(verifyHarnessExecutionBoundary(value.ctx, value.controller, {
        cwd: workspace, sandboxMode: 'workspace-write',
      })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
    }
    const value = harness(workspace, workspace, 'workspace-write')
    await expect(verifyHarnessExecutionBoundary(value.ctx, value.controller, {
      cwd: path.join(root, 'missing'), sandboxMode: 'workspace-write',
    })).rejects.toMatchObject({ code: 'EXECUTION_GATE_REJECTED' })
  })
})
