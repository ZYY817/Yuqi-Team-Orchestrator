import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findVerificationReadinessIssue, verificationCommandAvailability } from '../src/host/harness/verification-readiness.ts'
import type { TeamTaskContract } from '../src/domain/task-contract.ts'

const task = (verificationChecks?: TeamTaskContract['verificationChecks']): TeamTaskContract => ({
  taskId: 'task-1' as TeamTaskContract['taskId'],
  revision: 1,
  goal: 'run the task',
  scope: ['src'],
  nonGoals: ['unrelated work'],
  dependencies: [],
  fileScope: ['src/**'],
  modelRole: 'worker',
  modelId: 'model-1',
  acceptanceCriteria: ['the task runs'],
  authorityMode: 'read-only',
  inputDigest: 'digest',
  baselineRef: 'baseline',
  ...(verificationChecks === undefined ? {} : { verificationChecks }),
})

const unavailable = [{ kind: 'build' as const, available: false, reason: 'collector unavailable' }]

describe('verification readiness', () => {
  it('rejects an empty Team and safely ignores a missing task-shaped value', () => {
    expect(findVerificationReadinessIssue([], unavailable)).toEqual({
      taskId: '<team>', reason: 'Team start requires at least one task',
    })
    expect(findVerificationReadinessIssue([undefined as never], unavailable)).toBeUndefined()
  })

  it('does not require checks when a task has no verification configuration', () => {
    expect(findVerificationReadinessIssue([task()], unavailable)).toBeUndefined()
  })

  it('does not block a task when its requested Host capability is unavailable', () => {
    expect(findVerificationReadinessIssue([task([{
      checkId: 'build', kind: 'build', commandRef: 'pnpm-typecheck', timeoutMs: 1_000,
      stdoutMaxBytes: 1_024, stderrMaxBytes: 1_024,
    }])], unavailable)).toBeUndefined()
  })

  it('still rejects malformed explicitly supplied verification configuration', () => {
    expect(findVerificationReadinessIssue([task([])], unavailable)).toMatchObject({ taskId: 'task-1' })
  })

  it('proves package scripts and a single root .NET target from real workspace metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuqi-readiness-'))
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }), 'utf8')
      expect(await verificationCommandAvailability('pnpm-build', root)).toEqual({ available: true })
      expect(await verificationCommandAvailability('pnpm-typecheck', root)).toEqual({
        available: false, reason: 'Verification configuration unavailable: package.json does not declare scripts.typecheck',
      })
      expect(await verificationCommandAvailability('dotnet-build', root)).toEqual({
        available: false, reason: 'Verification configuration unavailable: no root .sln, .slnx, or .csproj target exists',
      })
      await writeFile(path.join(root, 'App.csproj'), '<Project />\n', 'utf8')
      expect(await verificationCommandAvailability('dotnet-build', root)).toEqual({ available: true })
      await writeFile(path.join(root, 'App.sln'), 'fixture\n', 'utf8')
      expect(await verificationCommandAvailability('dotnet-build', root)).toEqual({
        available: false, reason: 'Verification configuration unavailable: dotnet build has multiple root project/solution targets',
      })
      await writeFile(path.join(root, 'package.json'), '[]', 'utf8')
      expect(await verificationCommandAvailability('pnpm-build', root)).toEqual({
        available: false, reason: 'Verification configuration unavailable: package.json does not declare scripts.build',
      })
      expect(await verificationCommandAvailability('unknown-build', root)).toEqual({
        available: false, reason: 'Verification configuration unavailable: no Host command is registered for unknown-build',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
