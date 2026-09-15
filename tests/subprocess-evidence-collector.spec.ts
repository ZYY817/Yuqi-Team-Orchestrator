import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assessEvidenceRecord } from '../src/domain/evidence-verdict.ts'
import {
  FIXED_COMMANDS,
  SubprocessEvidenceCollector,
  boundedEvidenceDigest,
  parseVitestJsonReport,
  type StructuredSubprocessPort,
  type StructuredSubprocessRequest,
  type StructuredSubprocessResult,
} from '../src/host/harness/subprocess-evidence-collector.ts'
import { verificationCheckSchema, type TeamTaskContract } from '../src/domain/task-contract.ts'
import type { TeamWorkspace } from '../src/domain/workspace.ts'

let fixtureRoot = ''
let workspace: TeamWorkspace

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'yuqi-evidence-stack-'))
  await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', typecheck: 'tsc --noEmit', test: 'vitest run', 'yuqi-interface-probe': 'node probe.mjs', 'yuqi-screenshot-probe': 'node screenshot.mjs' } }), 'utf8')
  await writeFile(path.join(fixtureRoot, 'fixture.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />\n', 'utf8')
  workspace = {
  workspaceId: 'workspace-1' as TeamWorkspace['workspaceId'],
  project: {
    projectRoot: 'C:/project', repositoryRoot: 'C:/project', gitCommonDirectory: 'C:/project/.git',
    baselineRef: 'commit-1', volumeRoot: 'C:/', protectedRoots: ['C:/project/.git'],
  },
    worktreePath: fixtureRoot, branchName: 'yuqi/team-1', status: 'ready',
  }
})

afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

const defaultChecks: NonNullable<TeamTaskContract['verificationChecks']> = [{ checkId: 'build', kind: 'build', commandRef: 'pnpm-build', timeoutMs: 1000, stdoutMaxBytes: 16, stderrMaxBytes: 16 }]
const task = (checks: NonNullable<TeamTaskContract['verificationChecks']> = defaultChecks): TeamTaskContract => ({
  taskId: 'task-1' as TeamTaskContract['taskId'], revision: 1, goal: 'goal', scope: ['src'], nonGoals: ['deploy'], dependencies: [], fileScope: ['src/**'],
  modelRole: 'worker', modelId: 'deepseek-v4', acceptanceCriteria: ['build'], authorityMode: 'write-authorized', inputDigest: 'digest', baselineRef: 'commit-1', verificationChecks: checks,
})

function fakePort(result: StructuredSubprocessResult): { port: StructuredSubprocessPort; requests: StructuredSubprocessRequest[] } {
  const requests: StructuredSubprocessRequest[] = []
  return { requests, port: { async run(request) { requests.push(request); return result } } }
}

function report(statuses: readonly string[] = ['passed', 'passed', 'skipped']) {
  const failed = statuses.filter(status => status === 'failed').length
  return {
    numTotalTestSuites: 1, numPassedTestSuites: failed > 0 ? 0 : 1, numFailedTestSuites: failed > 0 ? 1 : 0, numPendingTestSuites: 0,
    numTotalTests: statuses.length, numPassedTests: statuses.filter(status => status === 'passed').length,
    numFailedTests: failed, numPendingTests: statuses.filter(status => status === 'skipped' || status === 'pending').length,
    numTodoTests: statuses.filter(status => status === 'todo').length, success: failed === 0,
    testResults: [{ name: '/project/example.spec.ts', status: failed > 0 ? 'failed' : 'passed', assertionResults: statuses.map((status, index) => ({
      fullName: `test ${index}`, status, failureMessages: status === 'failed' ? ['assertion failed'] : [],
    })) }],
  }
}

const testChecks: NonNullable<TeamTaskContract['verificationChecks']> = [{
  checkId: 'tests', kind: 'test', commandRef: 'pnpm-test', timeoutMs: 1000, stdoutMaxBytes: 65536, stderrMaxBytes: 4096,
}]

describe('SubprocessEvidenceCollector', () => {
  it('maps durable build checks to fixed argv and hashes only bounded output facts', async () => {
    const { port, requests } = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from('stdout-secret'), stderr: Buffer.from('stderr-secret') })
    const collector = new SubprocessEvidenceCollector(port)
    const signal = new AbortController().signal
    const result = await collector.collect({ task: task(), workspace, signal })

    expect(result.kind).toBe('collected')
    if (result.kind !== 'collected') return
    expect(result.evidence).toMatchObject([{ checkId: 'build', kind: 'build', producer: 'build-runner', command: 'pnpm run build', exitCode: 0 }])
    expect(result.evidence[0]).toMatchObject({ artifactDigest: boundedEvidenceDigest('pnpm run build', 0, Buffer.from('stdout-secret'), Buffer.from('stderr-secret')) })
    expect(JSON.stringify(result)).not.toContain('stdout-secret')
    expect(JSON.stringify(result)).not.toContain('stderr-secret')
    expect(requests[0]).toMatchObject({ argv: FIXED_COMMANDS['pnpm-build'].argv, cwd: workspace.worktreePath, stdoutMaxBytes: 16, stderrMaxBytes: 16, timeoutMs: 1000 })
    expect(requests[0]?.signal).toBe(signal)
  })

  it('maps pnpm-typecheck independently and never accepts caller argv', async () => {
    const { port, requests } = fakePort({ outcome: 'completed', exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
    const result = await new SubprocessEvidenceCollector(port).collect({
      task: task([{ checkId: 'types', kind: 'build', commandRef: 'pnpm-typecheck', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]), workspace,
    })
    expect(result.kind).toBe('collected')
    expect(requests[0]?.argv).toEqual(['pnpm', 'run', 'typecheck'])
  })

  it('runs only the registered pnpm test command for test evidence', async () => {
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from(JSON.stringify(report())), stderr: new Uint8Array() })
    const result = await new SubprocessEvidenceCollector(fake.port).collect({
      task: task(testChecks), workspace,
    })
    expect(result).toMatchObject({ kind: 'collected', evidence: [{ checkId: 'tests', kind: 'test', command: 'pnpm --silent run test --run --reporter=json --silent=true', exitCode: 0, total: 3, passed: 2, failed: 0, skipped: 1 }] })
    expect(fake.requests[0]?.argv).toEqual(['pnpm', '--silent', 'run', 'test', '--run', '--reporter=json', '--silent=true'])
  })

  it('collects interface evidence only from the fixed probe JSON and exact durable target', async () => {
    const check = { checkId: 'api', kind: 'interface' as const, commandRef: 'pnpm-interface-probe' as const, method: 'GET', path: '/health', expectedStatusCodes: [200], timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from(JSON.stringify({ method: 'GET', path: '/health', statusCode: 200, responseDigest: 'sha256:response', contractDigest: 'sha256:contract' })), stderr: new Uint8Array() })
    const result = await new SubprocessEvidenceCollector(fake.port).collect({ task: task([check]), workspace })
    expect(result).toMatchObject({ kind: 'collected', evidence: [{ kind: 'interface', producer: 'http-probe', method: 'GET', path: '/health', statusCode: 200 }] })
    expect(fake.requests[0]?.argv).toEqual(['pnpm', '--silent', 'run', 'yuqi-interface-probe', '--method', 'GET', '--path', '/health'])
  })

  it('does not accept valid-looking interface or screenshot JSON after a non-zero probe exit', async () => {
    const interfaceCheck = { checkId: 'api', kind: 'interface' as const, commandRef: 'pnpm-interface-probe' as const, method: 'GET', path: '/health', timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    const interfaceFake = fakePort({ outcome: 'completed', exitCode: 1, stdout: Buffer.from(JSON.stringify({ method: 'GET', path: '/health', statusCode: 200, responseDigest: 'sha256:r', contractDigest: 'sha256:c' })), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(interfaceFake.port).collect({ task: task([interfaceCheck]), workspace })).resolves.toMatchObject({ kind: 'failed', code: 'SUBPROCESS_FAILED' })

    const screenshotCheck = { checkId: 'screen', kind: 'screenshot' as const, commandRef: 'pnpm-screenshot-probe' as const, path: '/dashboard', viewport: { width: 1280, height: 720 }, format: 'image/png' as const, referenceDigest: 'sha256:reference', timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    const screenshotFake = fakePort({ outcome: 'completed', exitCode: 1, stdout: Buffer.from(JSON.stringify({ path: '/dashboard', width: 1280, height: 720, format: 'image/png', captureSource: 'browser', artifactDigest: 'sha256:actual', referenceDigest: 'sha256:reference', comparison: 'match' })), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(screenshotFake.port).collect({ task: task([screenshotCheck]), workspace })).resolves.toMatchObject({ kind: 'failed', code: 'SUBPROCESS_FAILED' })
  })

  it('collects screenshot evidence without treating capture receipt as a match', async () => {
    const check = { checkId: 'screen', kind: 'screenshot' as const, commandRef: 'pnpm-screenshot-probe' as const, path: '/dashboard', viewport: { width: 1280, height: 720 }, format: 'image/png' as const, referenceDigest: 'sha256:reference', timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from(JSON.stringify({ path: '/dashboard', width: 1280, height: 720, format: 'image/png', captureSource: 'browser', artifactDigest: 'sha256:actual', referenceDigest: 'sha256:reference', comparison: 'unavailable' })), stderr: new Uint8Array() })
    const result = await new SubprocessEvidenceCollector(fake.port).collect({ task: task([check]), workspace })
    expect(result).toMatchObject({ kind: 'collected', evidence: [{ kind: 'screenshot', comparison: 'unavailable' }] })
    expect(assessEvidenceRecord({ checkId: 'screen', kind: 'screenshot' }, (result as Extract<typeof result, { kind: 'collected' }>).evidence[0]!).outcome).toBe('inconclusive')
  })

  it('rejects probe output that does not match the durable target or strict shape', async () => {
    const check = { checkId: 'api', kind: 'interface' as const, commandRef: 'pnpm-interface-probe' as const, method: 'GET', path: '/health', timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from(JSON.stringify({ method: 'POST', path: '/other', statusCode: 200, responseDigest: 'sha256:r', contractDigest: 'sha256:c', extra: true })), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(fake.port).collect({ task: task([check]), workspace })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('rejects cross-origin-looking double-slash paths at the durable contract boundary', () => {
    const check = { checkId: 'api', kind: 'interface' as const, commandRef: 'pnpm-interface-probe' as const, method: 'GET', path: '//other-host/health', timeoutMs: 1000, stdoutMaxBytes: 4096, stderrMaxBytes: 4096 }
    expect(verificationCheckSchema.safeParse(check).success).toBe(false)
  })

  it.each([
    { statuses: ['passed'], exitCode: 0, outcome: 'passed' },
    { statuses: ['passed', 'failed'], exitCode: 1, outcome: 'failed' },
    { statuses: ['passed'], exitCode: 2, outcome: 'failed' },
    { statuses: ['passed', 'todo'], exitCode: 0, outcome: 'inconclusive' },
  ])('assesses real report counts with process exit: $outcome / $exitCode', async ({ statuses, exitCode, outcome }) => {
    const fake = fakePort({ outcome: 'completed', exitCode, stdout: Buffer.from(JSON.stringify(report(statuses))), stderr: Buffer.from('diagnostic') })
    const result = await new SubprocessEvidenceCollector(fake.port).collect({ task: task(testChecks), workspace })
    expect(result.kind).toBe('collected')
    if (result.kind !== 'collected') throw new Error('Expected collected test report')
    expect(assessEvidenceRecord({ checkId: 'tests', kind: 'test' }, result.evidence[0]!).outcome).toBe(outcome)
  })

  it('rejects a contradictory successful exit and failed report', async () => {
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: Buffer.from(JSON.stringify(report(['failed']))), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(fake.port).collect({ task: task(testChecks), workspace })).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('runs the registered .NET build command without accepting caller shell text', async () => {
    const { port, requests } = fakePort({ outcome: 'completed', exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(port).collect({
      task: task([{ checkId: 'build', kind: 'build', commandRef: 'dotnet-build', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]), workspace,
    })).resolves.toMatchObject({ kind: 'collected' })
    expect(requests[0]?.argv).toEqual(['dotnet', 'build', '--configuration', 'Release', '--nologo'])
  })

  it('fails closed for missing checks, non-ready workspaces, and unsupported test counts', async () => {
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
    const withoutChecks = { ...task() }
    Reflect.deleteProperty(withoutChecks, 'verificationChecks')
    await expect(new SubprocessEvidenceCollector(fake.port).collect({ task: withoutChecks, workspace })).resolves.toMatchObject({ kind: 'failed', code: 'INVALID_VERIFICATION_CHECKS' })
    await expect(new SubprocessEvidenceCollector(fake.port).collect({ task: task(), workspace: { ...workspace, status: 'needs_reconciliation' } })).resolves.toMatchObject({ kind: 'failed', code: 'WORKSPACE_NOT_READY' })
    await expect(new SubprocessEvidenceCollector(fake.port).collect({ task: task([{ checkId: 'tests', kind: 'test', commandRef: 'pnpm-build', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]), workspace })).resolves.toMatchObject({ kind: 'unavailable' })
    expect(fake.requests).toHaveLength(0)
  })

  it('classifies an unknown fixed command as configuration-unavailable before invoking the Host subprocess', async () => {
    const fake = fakePort({ outcome: 'completed', exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
    const result = await new SubprocessEvidenceCollector(fake.port).collect({
      task: task([{ checkId: 'build', kind: 'build', commandRef: 'pnpm-unknown', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]),
      workspace,
    })
    expect(result).toEqual({ kind: 'unavailable', reason: 'Verification configuration unavailable: No Host command is registered for pnpm-unknown' })
    expect(fake.requests).toHaveLength(0)
  })

  it('classifies workspace stack mismatches as unavailable without consuming a code-failure attempt', async () => {
    const mismatchRoot = path.join(fixtureRoot, 'mismatch')
    await mkdir(mismatchRoot)
    await writeFile(path.join(mismatchRoot, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }), 'utf8')
    const fake = fakePort({ outcome: 'completed', exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() })
    const collector = new SubprocessEvidenceCollector(fake.port)
    const mismatchedWorkspace = { ...workspace, worktreePath: mismatchRoot }

    await expect(collector.collect({
      task: task([{ checkId: 'types', kind: 'build', commandRef: 'pnpm-typecheck', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]),
      workspace: mismatchedWorkspace,
    })).resolves.toEqual({
      kind: 'unavailable', reason: 'Verification configuration unavailable: package.json does not declare scripts.typecheck',
    })
    await expect(collector.collect({
      task: task([{ checkId: 'dotnet', kind: 'build', commandRef: 'dotnet-build', timeoutMs: 1000, stdoutMaxBytes: 4, stderrMaxBytes: 4 }]),
      workspace: mismatchedWorkspace,
    })).resolves.toEqual({
      kind: 'unavailable', reason: 'Verification configuration unavailable: no root .sln, .slnx, or .csproj target exists',
    })
    expect(fake.requests).toEqual([])
  })

  it('records a non-zero build exit as failed build evidence, but not timeout or cancellation', async () => {
    const failed = fakePort({ outcome: 'completed', exitCode: 2, stdout: new Uint8Array(), stderr: Buffer.from('failure') })
    const failedResult = await new SubprocessEvidenceCollector(failed.port).collect({ task: task(), workspace })
    expect(failedResult).toMatchObject({ kind: 'collected', evidence: [{ exitCode: 2 }] })
    if (failedResult.kind === 'collected') {
      expect(assessEvidenceRecord({ checkId: 'build', kind: 'build' }, failedResult.evidence[0]!).outcome).toBe('failed')
    }

    const timeout = fakePort({ outcome: 'timed-out', exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(timeout.port).collect({ task: task(), workspace })).resolves.toMatchObject({ kind: 'failed', code: 'SUBPROCESS_TIMEOUT' })

    const controller = new AbortController()
    controller.abort()
    const aborted = fakePort({ outcome: 'completed', exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() })
    await expect(new SubprocessEvidenceCollector(aborted.port).collect({ task: task(), workspace, signal: controller.signal })).resolves.toMatchObject({ kind: 'aborted' })
    expect(aborted.requests).toHaveLength(0)
  })

  it('turns adapter failures into a bounded generic result without leaking adapter details', async () => {
    const port: StructuredSubprocessPort = { async run() { throw new Error('token=secret-value') } }
    const result = await new SubprocessEvidenceCollector(port).collect({ task: task(), workspace })
    expect(result).toEqual({ kind: 'failed', code: 'SUBPROCESS_FAILED', reason: 'Evidence subprocess failed' })
    expect(JSON.stringify(result)).not.toContain('secret-value')
  })

})

describe('parseVitestJsonReport', () => {
  it('accepts one complete whitespace-wrapped report and includes todo in skipped counts', () => {
    expect(parseVitestJsonReport(Buffer.from(`\n${JSON.stringify(report(['passed', 'skipped', 'todo']))}\n`), 0))
      .toEqual({ total: 3, passed: 1, failed: 0, skipped: 2 })
  })

  it.each([
    '', 'not JSON', 'null', '[]', '{}',
    JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0 }),
    `banner\n${JSON.stringify(report())}`,
    `${JSON.stringify(report())}\nextra log`,
    `${JSON.stringify(report())}\n${JSON.stringify(report())}`,
    JSON.stringify({ log: report() }),
    JSON.stringify(report()).slice(0, -1),
  ])('rejects logs, count-only objects, multiple reports and truncated output %#', output => {
    expect(parseVitestJsonReport(Buffer.from(output), 0)).toBeUndefined()
  })

  it.each([
    { numTotalTests: 0 }, { numTotalTests: -1 }, { numPassedTests: 1.5 }, { numTotalTests: Number.MAX_SAFE_INTEGER + 1 },
    { numPassedTests: '2' }, { numPendingTests: 0 }, { numTodoTests: -1 },
    { numPassedTests: 1, numPendingTests: 2 }, // totals agree, assertion details do not
    { numPassedTestSuites: 0 }, { numFailedTestSuites: 1, numPassedTestSuites: 0 },
    { success: false }, { success: 'true' }, { testResults: [] },
    { snapshot: { failure: true } },
    { testResults: [{ name: 'file', status: 'passed', assertionResults: [{ fullName: 'A', status: 'running', failureMessages: [] }] }] },
  ])('rejects incomplete or contradictory report structure %#', patch => {
    expect(parseVitestJsonReport(Buffer.from(JSON.stringify({ ...report(), ...patch })), 0)).toBeUndefined()
  })

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid exit codes %s', exitCode => {
    expect(parseVitestJsonReport(Buffer.from(JSON.stringify(report())), exitCode)).toBeUndefined()
  })
})
