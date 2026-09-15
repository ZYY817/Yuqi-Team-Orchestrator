/** Adapt the public Harness subprocess capability to the evidence collector seam. */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import type {
  StructuredSubprocessPort,
  StructuredSubprocessRequest,
  StructuredSubprocessResult,
} from './subprocess-evidence-collector.ts'

/** The public Harness reader shape, kept local so this adapter has no private import. */
export interface HarnessSubprocessOutputReader {
  readFrom(fromByte: number): {
    readonly text: string
    readonly nextOffset: number
    readonly lossy: boolean
    readonly spillPath?: string
  }
}

export interface HarnessSubprocessHandle {
  readonly collected: {
    readonly stdout?: HarnessSubprocessOutputReader
    readonly stderr?: HarnessSubprocessOutputReader
  }
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export interface HarnessSubprocessSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore'
    readonly stdout: { readonly maxBytes: number }
    readonly stderr: { readonly maxBytes: number }
  }
  readonly graceMs: number
  readonly signal?: AbortSignal
}

export interface HarnessSubprocessRuntime {
  spawn(spec: HarnessSubprocessSpawnSpec): HarnessSubprocessHandle
  readonly resolveExecutable?: (
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ) => Promise<string>
}

/** One fixed tree-termination grace period for all evidence subprocesses. */
export const HARNESS_SUBPROCESS_GRACE_MS = 1_000

const EMPTY_OUTPUT: Uint8Array<ArrayBuffer> = new Uint8Array(0)

/**
 * Runs only the collector's already-registered argv through Harness' shell-free
 * subprocess capability. The adapter owns cancellation classification and waits
 * for whole-tree exit before exposing the bounded collected transcript.
 */
export class HarnessStructuredSubprocessPort implements StructuredSubprocessPort {
  readonly #runtime: HarnessSubprocessRuntime

  constructor(runtime: HarnessSubprocessRuntime) {
    this.#runtime = runtime
  }

  async run(request: StructuredSubprocessRequest): Promise<StructuredSubprocessResult> {
    const invalid = validateRequest(request)
    if (invalid !== undefined) return failedResult()
    if (request.signal?.aborted === true) return abortedResult()

    const processAbort = new AbortController()
    let interruption: 'timed-out' | 'aborted' | undefined
    let resolveInterruption!: (kind: 'timed-out' | 'aborted') => void
    const interruptionPromise = new Promise<'timed-out' | 'aborted'>(resolve => {
      resolveInterruption = resolve
    })
    const interrupt = (kind: 'timed-out' | 'aborted'): void => {
      if (interruption !== undefined) return
      interruption = kind
      processAbort.abort()
      resolveInterruption(kind)
    }
    const onExternalAbort = (): void => interrupt('aborted')
    request.signal?.addEventListener('abort', onExternalAbort, { once: true })
    const timeout = setTimeout(() => interrupt('timed-out'), request.timeoutMs)

    let argv: readonly [string, ...string[]]
    try {
      argv = await resolveSubprocessArgv(request.argv, this.#runtime, processAbort.signal)
    } catch {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onExternalAbort)
      if (interruption !== undefined) return interruptedResult(interruption)
      return request.signal?.aborted ? abortedResult() : failedResult()
    }

    let handle: HarnessSubprocessHandle
    try {
      handle = this.#runtime.spawn({
        argv: [...argv],
        cwd: request.cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: request.stdoutMaxBytes },
          stderr: { maxBytes: request.stderrMaxBytes },
        },
        graceMs: HARNESS_SUBPROCESS_GRACE_MS,
        signal: processAbort.signal,
      })
    } catch {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onExternalAbort)
      if (interruption !== undefined) return interruptedResult(interruption)
      return request.signal?.aborted ? abortedResult() : failedResult()
    }

    try {
      const settlement = await Promise.race([
        handle.done.then(
          outcome => ({ kind: 'done' as const, outcome }),
          () => ({ kind: 'spawn-failed' as const }),
        ),
        interruptionPromise.then(kind => ({ kind: 'interrupted' as const, cause: kind })),
      ])

      if (settlement.kind === 'interrupted') handle.terminate()
      const exited = await handle.waitForExit(AbortSignal.timeout(HARNESS_SUBPROCESS_GRACE_MS * 2))
      if (!exited) return failedResult()

      let stdout: Uint8Array<ArrayBuffer>
      let stderr: Uint8Array<ArrayBuffer>
      try {
        stdout = readOutput(handle.collected.stdout)
        stderr = readOutput(handle.collected.stderr)
      } catch {
        return failedResult()
      }

      if (settlement.kind === 'interrupted') {
        return interruptedResult(settlement.cause, stdout, stderr)
      }
      if (settlement.kind === 'spawn-failed') {
        return { outcome: 'failed', exitCode: null, stdout, stderr }
      }
      return {
        outcome: 'completed',
        exitCode: settlement.outcome.exitCode,
        stdout,
        stderr,
      }
    } catch {
      return failedResult()
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onExternalAbort)
    }
  }
}

async function resolveSubprocessArgv(
  argv: readonly [string, ...string[]],
  runtime: HarnessSubprocessRuntime,
  signal: AbortSignal,
): Promise<readonly [string, ...string[]]> {
  if (runtime.resolveExecutable === undefined) return [...argv]
  signal.throwIfAborted()
  const resolved = await runtime.resolveExecutable(argv[0], undefined, signal)
  signal.throwIfAborted()
  if (process.platform !== 'win32' || argv[0] !== 'pnpm' || !/\.cmd$/iu.test(resolved)) {
    return [resolved, ...argv.slice(1)]
  }
  return [
    ...await resolveWindowsCommandShim(resolved),
    ...argv.slice(1),
  ]
}

/** Convert the fixed pnpm Windows shim to a shell-free Node argv. */
async function resolveWindowsCommandShim(shimPath: string): Promise<readonly [string, string]> {
  const source = await readFile(shimPath, 'utf8')
  if (source.length > 64 * 1024) throw new Error('pnpm command shim exceeds the bounded parser input')
  const tokens = [...source.matchAll(/"([^"\r\n]+)"/gu)].map(match => match[1]!)
  const nodeToken = tokens.find(token => /(?:^|[\\/]|%~dp0)node(?:\.exe)?$/iu.test(token))
  const scriptToken = tokens.find(token => /(?:pnpm|corepack).*\.(?:c?m?js)$/iu.test(token))
  if (nodeToken === undefined || scriptToken === undefined) throw new Error('pnpm command shim has no supported Node launcher')
  const nodePath = resolveShimToken(shimPath, nodeToken)
  const scriptPath = resolveShimToken(shimPath, scriptToken)
  if (nodePath === undefined || scriptPath === undefined) throw new Error('pnpm command shim uses an unsupported launcher path')
  return [nodePath, scriptPath]
}

function resolveShimToken(shimPath: string, token: string): string | undefined {
  const base = path.dirname(shimPath)
  if (token.toLowerCase().startsWith('%~dp0')) {
    return path.resolve(base, token.slice('%~dp0'.length))
  }
  return path.isAbsolute(token) ? path.normalize(token) : undefined
}

function validateRequest(request: StructuredSubprocessRequest): string | undefined {
  if (request.argv.length === 0 || request.argv[0]!.length === 0 || request.argv.some(argument => argument.includes('\u0000'))) return 'argv'
  if (request.cwd.trim() === '' || request.cwd.includes('\u0000')) return 'cwd'
  if (!Number.isSafeInteger(request.stdoutMaxBytes) || request.stdoutMaxBytes <= 0) return 'stdoutMaxBytes'
  if (!Number.isSafeInteger(request.stderrMaxBytes) || request.stderrMaxBytes <= 0) return 'stderrMaxBytes'
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) return 'timeoutMs'
  return undefined
}

function readOutput(reader: HarnessSubprocessOutputReader | undefined): Uint8Array<ArrayBuffer> {
  if (reader === undefined) return EMPTY_OUTPUT
  // `lossy` is intentionally accepted: the collector's artifact digest is a
  // bounded transcript, never a claim that the complete stream was retained.
  const encoded = new TextEncoder().encode(reader.readFrom(0).text)
  const bounded = new Uint8Array(encoded.byteLength)
  bounded.set(encoded)
  return bounded
}

function failedResult(): StructuredSubprocessResult {
  return { outcome: 'failed', exitCode: null, stdout: EMPTY_OUTPUT, stderr: EMPTY_OUTPUT }
}

function abortedResult(): StructuredSubprocessResult {
  return { outcome: 'aborted', exitCode: null, stdout: EMPTY_OUTPUT, stderr: EMPTY_OUTPUT }
}

function interruptedResult(
  outcome: 'timed-out' | 'aborted',
  stdout: Uint8Array<ArrayBuffer> = EMPTY_OUTPUT,
  stderr: Uint8Array<ArrayBuffer> = EMPTY_OUTPUT,
): StructuredSubprocessResult {
  return { outcome, exitCode: null, stdout, stderr }
}
