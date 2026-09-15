/** Host-owned build evidence over a structured, shell-free subprocess seam. */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { TeamTaskContract, VerificationCheck } from '../../domain/task-contract.ts'
import { verificationChecksSchema } from '../../domain/task-contract.ts'
import type { TeamWorkspace } from '../../domain/workspace.ts'
import { teamWorkspaceSchema } from '../../domain/workspace.ts'
import { workspaceProjectRoot } from '../workspace-project-root.ts'
import type { HostEvidenceCollectionResult } from '../../application/ports.ts'
import type { StructuredEvidence } from '../../domain/evidence-verdict.ts'
import { verificationCommandAvailability } from './verification-readiness.ts'

/** Structured process invocation accepted by the public Host subprocess seam. */
export interface StructuredSubprocessRequest {
  readonly argv: readonly [string, ...string[]]
  readonly cwd: string
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** Ephemeral bounded process facts; raw output is never persisted by the collector. */
export interface StructuredSubprocessResult {
  readonly outcome: 'completed' | 'failed' | 'timed-out' | 'aborted'
  readonly exitCode: number | null
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/**
 * Public injection seam for a Host-owned structured subprocess implementation.
 * The adapter owns shell-free execution, bounded capture, timeout/cancellation,
 * and whole-process-tree termination through the Harness public API.
 */
export interface StructuredSubprocessPort {
  run(request: StructuredSubprocessRequest): Promise<StructuredSubprocessResult>
}

/** Fixed command references. No model or caller supplied argv is accepted. */
export const FIXED_COMMANDS = Object.freeze({
  'pnpm-build': Object.freeze({ kind: 'build' as const, argv: ['pnpm', 'run', 'build'] as const, command: 'pnpm run build' }),
  'pnpm-typecheck': Object.freeze({ kind: 'build' as const, argv: ['pnpm', 'run', 'typecheck'] as const, command: 'pnpm run typecheck' }),
  'dotnet-build': Object.freeze({ kind: 'build' as const, argv: ['dotnet', 'build', '--configuration', 'Release', '--nologo'] as const, command: 'dotnet build --configuration Release --nologo' }),
  // pnpm options precede the script; script arguments have no intervening --.
  // Explicit run mode exits even when scripts.test is just "vitest". The two
  // silent flags suppress pnpm lifecycle banners and intercepted test logging.
  'pnpm-test': Object.freeze({ kind: 'test' as const, argv: ['pnpm', '--silent', 'run', 'test', '--run', '--reporter=json', '--silent=true'] as const, command: 'pnpm --silent run test --run --reporter=json --silent=true' }),
  'pnpm-interface-probe': Object.freeze({ kind: 'interface' as const, command: 'pnpm --silent run yuqi-interface-probe' }),
  'pnpm-screenshot-probe': Object.freeze({ kind: 'screenshot' as const, command: 'pnpm --silent run yuqi-screenshot-probe' }),
})

/**
 * Collects only checks declared by the durable task contract in its exact
 * durable-ready worktree. Unsupported test reporting remains unavailable.
 */
export class SubprocessEvidenceCollector {
  readonly #port: StructuredSubprocessPort

  constructor(port: StructuredSubprocessPort) {
    this.#port = port
  }

  async collect(request: SubprocessEvidenceCollectionRequest): Promise<HostEvidenceCollectionResult> {
    const source = validateSource(request)
    if (source.kind !== 'ready') return source.result
    if (request.signal?.aborted === true) return { kind: 'aborted', reason: 'Evidence collection was cancelled before subprocess start' }

    const requested = selectChecks(source.checks, request.requirementIds)
    if (requested.kind === 'invalid') return requested.result
    const evidence: StructuredEvidence[] = []
    for (const check of requested.checks) {
      const command = FIXED_COMMANDS[check.commandRef as keyof typeof FIXED_COMMANDS]
      const unsupported = unsupportedVerificationCheck(check)
      if (unsupported !== undefined || command === undefined) {
        return { kind: 'unavailable', reason: `Verification configuration unavailable: ${unsupported ?? `no Host command is registered for ${check.commandRef}`}` }
      }
      const cwd = workspaceProjectRoot(source.workspace)
      const availability = await verificationCommandAvailability(check.commandRef, cwd)
      if (!availability.available) return { kind: 'unavailable', reason: availability.reason }
      let result: StructuredSubprocessResult
      try {
        result = await this.#port.run({
          argv: commandArgv(check),
          cwd,
          stdoutMaxBytes: check.stdoutMaxBytes,
          stderrMaxBytes: check.stderrMaxBytes,
          timeoutMs: check.timeoutMs,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
      } catch {
        return { kind: 'failed', code: 'SUBPROCESS_FAILED', reason: 'Evidence subprocess failed' }
      }
      if (result.outcome === 'aborted') return { kind: 'aborted', reason: 'Evidence subprocess was cancelled' }
      if (result.outcome === 'timed-out') return { kind: 'failed', code: 'SUBPROCESS_TIMEOUT', reason: 'Evidence subprocess exceeded its durable timeout' }
      if (result.outcome === 'failed' || result.exitCode === null) {
        return { kind: 'failed', code: 'SUBPROCESS_FAILED', reason: 'Evidence subprocess did not produce a reliable exit result' }
      }
      if ((check.kind === 'interface' || check.kind === 'screenshot') && result.exitCode !== 0) {
        return { kind: 'failed', code: 'SUBPROCESS_FAILED', reason: 'Evidence probe exited unsuccessfully' }
      }
      if (check.kind === 'test') {
        const counts = parseVitestJsonReport(result.stdout, result.exitCode)
        if (counts === undefined) return { kind: 'unavailable', reason: 'Host test evidence did not contain a complete Vitest JSON count report' }
        evidence.push({
          checkId: check.checkId, capturedAt: new Date().toISOString(), kind: 'test', producer: 'test-runner',
          command: command.command, exitCode: result.exitCode, ...counts,
          reportDigest: boundedEvidenceDigest(command.command, result.exitCode, result.stdout, result.stderr),
        })
      } else if (check.kind === 'build') {
        evidence.push({
          checkId: check.checkId,
          capturedAt: new Date().toISOString(),
          kind: 'build',
          producer: 'build-runner',
          command: command.command,
          exitCode: result.exitCode,
          artifactDigest: boundedEvidenceDigest(command.command, result.exitCode, result.stdout, result.stderr),
        })
      } else if (check.kind === 'interface') {
        const parsed = parseInterfaceProbe(result.stdout)
        if (parsed === undefined) return { kind: 'unavailable', reason: 'Host interface probe did not contain a complete JSON result' }
        if (parsed.method !== check.method || parsed.path !== check.path) return { kind: 'failed', code: 'INTERFACE_TARGET_MISMATCH', reason: 'Interface probe result does not match the durable target' }
        evidence.push({ checkId: check.checkId, capturedAt: new Date().toISOString(), kind: 'interface', producer: 'http-probe', method: parsed.method, path: parsed.path, statusCode: parsed.statusCode, responseDigest: parsed.responseDigest, contractDigest: parsed.contractDigest })
      } else {
        const parsed = parseScreenshotProbe(result.stdout)
        if (parsed === undefined) return { kind: 'unavailable', reason: 'Host screenshot probe did not contain a complete JSON result' }
        if (parsed.path !== check.path || parsed.width !== check.viewport.width || parsed.height !== check.viewport.height || parsed.format !== check.format || parsed.referenceDigest !== check.referenceDigest) {
          return { kind: 'failed', code: 'SCREENSHOT_TARGET_MISMATCH', reason: 'Screenshot probe result does not match the durable target' }
        }
        evidence.push({ checkId: check.checkId, capturedAt: new Date().toISOString(), kind: 'screenshot', producer: 'screenshot-capture', captureSource: parsed.captureSource, format: parsed.format, width: parsed.width, height: parsed.height, artifactDigest: parsed.artifactDigest, referenceDigest: parsed.referenceDigest, comparison: parsed.comparison })
      }
    }
    return { kind: 'collected', evidence }
  }
}

/** Return a safe diagnostic when a durable check cannot be executed by this Host. */
export function unsupportedVerificationCheck(check: VerificationCheck): string | undefined {
  const command = FIXED_COMMANDS[check.commandRef as keyof typeof FIXED_COMMANDS]
  if (command === undefined) return `No Host command is registered for ${check.commandRef}`
  if (command.kind !== check.kind) return `Host command ${check.commandRef} cannot execute evidence kind ${check.kind}`
  return undefined
}

function commandArgv(check: VerificationCheck): readonly [string, ...string[]] {
  switch (check.kind) {
    case 'build': return FIXED_COMMANDS[check.commandRef as 'pnpm-build' | 'pnpm-typecheck' | 'dotnet-build'].argv
    case 'test': return FIXED_COMMANDS['pnpm-test'].argv
    case 'interface': return ['pnpm', '--silent', 'run', 'yuqi-interface-probe', '--method', check.method, '--path', check.path]
    case 'screenshot': return ['pnpm', '--silent', 'run', 'yuqi-screenshot-probe', '--path', check.path, '--width', String(check.viewport.width), '--height', String(check.viewport.height), '--format', check.format, '--reference-digest', check.referenceDigest]
  }
}

interface InterfaceProbeResult { readonly method: string; readonly path: string; readonly statusCode: number; readonly responseDigest: string; readonly contractDigest: string }
interface ScreenshotProbeResult { readonly path: string; readonly width: number; readonly height: number; readonly format: 'image/png' | 'image/jpeg' | 'image/webp'; readonly captureSource: 'browser' | 'desktop'; readonly artifactDigest: string; readonly referenceDigest: string; readonly comparison: 'match' | 'mismatch' | 'unavailable' }

function parseInterfaceProbe(output: Uint8Array): InterfaceProbeResult | undefined {
  try {
    const value = z.object({
      method: z.string().regex(/^[A-Z]+$/u), path: z.string().regex(/^\/(?!\/)[^\s]*$/u),
      statusCode: z.number().int().min(100).max(599), responseDigest: z.string().trim().min(1), contractDigest: z.string().trim().min(1),
    }).strict().safeParse(JSON.parse(Buffer.from(output).toString('utf8')))
    return value.success ? value.data : undefined
  } catch { return undefined }
}

function parseScreenshotProbe(output: Uint8Array): ScreenshotProbeResult | undefined {
  try {
    const value = z.object({
      path: z.string().regex(/^\/(?!\/)[^\s]*$/u), width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096),
      format: z.enum(['image/png', 'image/jpeg', 'image/webp']), captureSource: z.enum(['browser', 'desktop']),
      artifactDigest: z.string().trim().min(1), referenceDigest: z.string().trim().min(1), comparison: z.enum(['match', 'mismatch', 'unavailable']),
    }).strict().safeParse(JSON.parse(Buffer.from(output).toString('utf8')))
    return value.success ? value.data : undefined
  } catch { return undefined }
}

/** Input assembled from the durable task projection and durable workspace projection. */
export interface SubprocessEvidenceCollectionRequest {
  readonly task: TeamTaskContract
  readonly workspace: TeamWorkspace
  readonly requirementIds?: readonly string[]
  readonly signal?: AbortSignal
}

/** Require a single pure Vitest report, not a JSON fragment found inside logs. */
export function parseVitestJsonReport(output: Uint8Array, exitCode?: number): { total: number; passed: number; failed: number; skipped: number } | undefined {
  let value: unknown
  try { value = JSON.parse(Buffer.from(output).toString('utf8')) } catch { return undefined }
  if (!isRecord(value) || typeof value.success !== 'boolean'
    || !Array.isArray(value.testResults) || value.testResults.length === 0) return undefined
  const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending,
    numTotalTestSuites: suites, numPassedTestSuites: passedSuites, numFailedTestSuites: failedSuites,
    numPendingTestSuites: pendingSuites } = value
  const todo = value.numTodoTests ?? 0
  if (!isCount(total) || !isCount(passed) || !isCount(failed) || !isCount(pending) || !isCount(todo)
    || !isCount(suites) || !isCount(passedSuites) || !isCount(failedSuites) || !isCount(pendingSuites)
    || total === 0 || suites === 0 || passed + failed + pending + todo !== total
    || passedSuites + failedSuites + pendingSuites !== suites) return undefined
  if (exitCode !== undefined && (!isCount(exitCode) || (exitCode === 0 && !value.success))) return undefined
  if (value.success && (failed > 0 || failedSuites > 0 || (isRecord(value.snapshot) && value.snapshot.failure === true))) return undefined
  const actual = { passed: 0, failed: 0, pending: 0, todo: 0 }
  for (const suite of value.testResults) {
    if (!isRecord(suite) || typeof suite.name !== 'string' || suite.name.trim() === ''
      || !Array.isArray(suite.assertionResults) || !['passed', 'failed'].includes(String(suite.status))
      || (value.success && suite.status === 'failed')) return undefined
    for (const assertion of suite.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.fullName !== 'string'
        || !Array.isArray(assertion.failureMessages) || !assertion.failureMessages.every(message => typeof message === 'string')) return undefined
      switch (assertion.status) {
        case 'passed':
          if (assertion.failureMessages.length > 0) return undefined
          actual.passed++
          break
        case 'failed': actual.failed++; break
        case 'pending':
        case 'skipped': actual.pending++; break
        case 'todo': actual.todo++; break
        default: return undefined
      }
    }
  }
  if (actual.passed !== passed || actual.failed !== failed || actual.pending !== pending || actual.todo !== todo) return undefined
  // A non-zero exit remains failed evidence even if assertions passed (for
  // example an unhandled error or a failing command after the test script).
  return { total, passed, failed, skipped: pending + todo }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

type SourceValidation =
  | { readonly kind: 'ready'; readonly checks: readonly VerificationCheck[]; readonly workspace: TeamWorkspace }
  | { readonly kind: 'invalid'; readonly result: Extract<HostEvidenceCollectionResult, { readonly kind: 'failed' }> }

function validateSource(request: SubprocessEvidenceCollectionRequest): SourceValidation {
  const workspace = teamWorkspaceSchema.safeParse(request.workspace)
  if (!workspace.success || workspace.data.status !== 'ready' || workspace.data.worktreePath.trim() === '') {
    return { kind: 'invalid', result: { kind: 'failed', code: 'WORKSPACE_NOT_READY', reason: 'Evidence requires the exact durable ready workspace' } }
  }
  const checks = verificationChecksSchema.safeParse(request.task.verificationChecks)
  if (!checks.success) {
    return { kind: 'invalid', result: { kind: 'failed', code: 'INVALID_VERIFICATION_CHECKS', reason: 'Evidence requires durable verification checks' } }
  }
  return { kind: 'ready', checks: checks.data, workspace: workspace.data }
}

type CheckSelection =
  | { readonly kind: 'selected'; readonly checks: readonly VerificationCheck[] }
  | { readonly kind: 'invalid'; readonly result: Extract<HostEvidenceCollectionResult, { readonly kind: 'failed' }> }

function selectChecks(checks: readonly VerificationCheck[], requirementIds: readonly string[] | undefined): CheckSelection {
  const ids = requirementIds === undefined ? checks.map(check => check.checkId) : [...requirementIds]
  const seen = new Set<string>()
  const selected: VerificationCheck[] = []
  for (const id of ids) {
    if (id.trim() === '' || seen.has(id)) {
      return { kind: 'invalid', result: { kind: 'failed', code: 'INVALID_VERIFICATION_REQUIREMENTS', reason: 'Evidence check ids must be non-empty and unique' } }
    }
    seen.add(id)
    const check = checks.find(candidate => candidate.checkId === id)
    if (check === undefined) {
      return { kind: 'invalid', result: { kind: 'failed', code: 'VERIFICATION_CHECK_NOT_DURABLE', reason: 'Requested evidence check is not in the durable task contract' } }
    }
    selected.push(check)
  }
  if (selected.length === 0) {
    return { kind: 'invalid', result: { kind: 'failed', code: 'INVALID_VERIFICATION_REQUIREMENTS', reason: 'At least one durable verification check is required' } }
  }
  return { kind: 'selected', checks: selected }
}

/**
 * Evidence transcript digest (stored in the schema's artifactDigest field):
 * fixed command, exit code, and bounded output byte prefixes. It is never a
 * hash of files or other workspace artifacts.
 */
export function boundedEvidenceDigest(command: string, exitCode: number, stdout: Uint8Array, stderr: Uint8Array): string {
  const canonical = JSON.stringify({
    command,
    exitCode,
    stdout: Buffer.from(stdout).toString('base64'),
    stderr: Buffer.from(stderr).toString('base64'),
  })
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`
}
