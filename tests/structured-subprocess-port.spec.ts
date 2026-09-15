import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  HARNESS_SUBPROCESS_GRACE_MS,
  HarnessStructuredSubprocessPort,
  type HarnessSubprocessHandle,
  type HarnessSubprocessRuntime,
  type HarnessSubprocessSpawnSpec,
} from '../src/host/harness/structured-subprocess-port.ts'
import type { StructuredSubprocessRequest } from '../src/host/harness/subprocess-evidence-collector.ts'

const request: StructuredSubprocessRequest = {
  argv: ['pnpm', 'run', 'build'],
  cwd: 'C:/project/worktree',
  stdoutMaxBytes: 8,
  stderrMaxBytes: 4,
  timeoutMs: 500,
}

function reader(text: string, lossy = false) {
  return { readFrom: vi.fn(() => ({ text, nextOffset: text.length, lossy })) }
}

function handle(overrides: Partial<HarnessSubprocessHandle> = {}): HarnessSubprocessHandle {
  return {
    collected: { stdout: reader('stdout'), stderr: reader('stderr') },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
    ...overrides,
  }
}

function runtimeFor(child: HarnessSubprocessHandle): { runtime: HarnessSubprocessRuntime; specs: HarnessSubprocessSpawnSpec[] } {
  const specs: HarnessSubprocessSpawnSpec[] = []
  return { specs, runtime: { spawn: vi.fn(spec => { specs.push(spec); return child }) } }
}

describe('HarnessStructuredSubprocessPort', () => {
  it('uses shell-free argv, fixed stdio bounds/grace, waits for tree exit, and reads bounded output', async () => {
    const child = handle()
    const { runtime, specs } = runtimeFor(child)
    const result = await new HarnessStructuredSubprocessPort(runtime).run(request)

    expect(result).toEqual({ outcome: 'completed', exitCode: 0, stdout: new TextEncoder().encode('stdout'), stderr: new TextEncoder().encode('stderr') })
    expect(specs[0]).toEqual({
      argv: ['pnpm', 'run', 'build'], cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 8 }, stderr: { maxBytes: 4 } },
      graceMs: HARNESS_SUBPROCESS_GRACE_MS, signal: expect.any(AbortSignal),
    })
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('resolves the Windows pnpm shim to a shell-free Node argv', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-pnpm-shim-'))
    try {
      const shim = path.join(root, 'pnpm.cmd')
      await writeFile(shim, '@echo off\r\n"%~dp0node.exe" "%~dp0node_modules\\pnpm\\bin\\pnpm.mjs" %*\r\n', 'utf8')
      const child = handle()
      const specs: HarnessSubprocessSpawnSpec[] = []
      const runtime: HarnessSubprocessRuntime = {
        resolveExecutable: vi.fn(async () => shim),
        spawn: vi.fn(spec => { specs.push(spec); return child }),
      }

      await new HarnessStructuredSubprocessPort(runtime).run(request)

      expect(specs[0]?.argv).toEqual([
        path.join(root, 'node.exe'),
        path.join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
        'run', 'build',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes through a resolved non-shim executable without invoking a shell', async () => {
    const child = handle()
    const specs: HarnessSubprocessSpawnSpec[] = []
    const runtime: HarnessSubprocessRuntime = {
      resolveExecutable: vi.fn(async () => 'C:/tools/pnpm.exe'),
      spawn: vi.fn(spec => { specs.push(spec); return child }),
    }

    await new HarnessStructuredSubprocessPort(runtime).run(request)

    expect(specs[0]?.argv).toEqual(['C:/tools/pnpm.exe', 'run', 'build'])
  })

  it('fails before spawn when executable resolution fails', async () => {
    const runtime: HarnessSubprocessRuntime = {
      resolveExecutable: vi.fn(async () => { throw new Error('resolver failure') }),
      spawn: vi.fn(() => handle()),
    }

    await expect(new HarnessStructuredSubprocessPort(runtime).run(request)).resolves.toEqual({
      outcome: 'failed', exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(),
    })
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('supports absolute paths in a Windows pnpm shim', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-pnpm-absolute-shim-'))
    try {
      const shim = path.join(root, 'pnpm.cmd')
      const nodePath = path.join(root, 'node.exe')
      const scriptPath = path.join(root, 'pnpm.mjs')
      await writeFile(shim, `@echo off\r\n"${nodePath}" "${scriptPath}" %*\r\n`, 'utf8')
      const child = handle()
      const specs: HarnessSubprocessSpawnSpec[] = []
      const runtime: HarnessSubprocessRuntime = {
        resolveExecutable: vi.fn(async () => shim),
        spawn: vi.fn(spec => { specs.push(spec); return child }),
      }

      await new HarnessStructuredSubprocessPort(runtime).run(request)

      expect(specs[0]?.argv).toEqual([nodePath, scriptPath, 'run', 'build'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails when a Windows pnpm shim contains an unsupported launcher path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-pnpm-invalid-shim-'))
    try {
      const shim = path.join(root, 'pnpm.cmd')
      await writeFile(shim, '@echo off\r\n"tools/node.exe" "C:\\tools\\pnpm.mjs" %*\r\n', 'utf8')
      const runtime: HarnessSubprocessRuntime = {
        resolveExecutable: vi.fn(async () => shim),
        spawn: vi.fn(() => handle()),
      }

      await expect(new HarnessStructuredSubprocessPort(runtime).run(request)).resolves.toEqual({
        outcome: 'failed', exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array(),
      })
      expect(runtime.spawn).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('classifies internal timeout, terminates, then waits for the process tree', async () => {
    const child = handle({ done: new Promise(() => undefined) })
    const { runtime } = runtimeFor(child)
    const result = await new HarnessStructuredSubprocessPort(runtime).run({ ...request, timeoutMs: 10 })

    expect(result.outcome).toBe('timed-out')
    expect(child.terminate).toHaveBeenCalledOnce()
    expect(child.waitForExit).toHaveBeenCalledOnce()
  })

  it('classifies caller cancellation separately and never spawns after pre-abort', async () => {
    const controller = new AbortController()
    const child = handle({ done: new Promise(() => undefined) })
    const { runtime } = runtimeFor(child)
    const running = new HarnessStructuredSubprocessPort(runtime).run({ ...request, signal: controller.signal })
    await vi.waitFor(() => expect(runtime.spawn).toHaveBeenCalledOnce())
    controller.abort()

    await expect(running).resolves.toMatchObject({ outcome: 'aborted', exitCode: null })
    expect(child.terminate).toHaveBeenCalledOnce()

    const preAborted = new AbortController()
    preAborted.abort()
    const second = runtimeFor(handle())
    await expect(new HarnessStructuredSubprocessPort(second.runtime).run({ ...request, signal: preAborted.signal })).resolves.toMatchObject({ outcome: 'aborted' })
    expect(second.runtime.spawn).not.toHaveBeenCalled()
  })

  it('maps spawn and tree-wait failures to stable failed results', async () => {
    const throwing: HarnessSubprocessRuntime = { spawn: vi.fn(() => { throw new Error('transport detail') }) }
    await expect(new HarnessStructuredSubprocessPort(throwing).run(request)).resolves.toEqual({ outcome: 'failed', exitCode: null, stdout: new Uint8Array(), stderr: new Uint8Array() })

    const child = handle({ waitForExit: vi.fn(async () => false) })
    const { runtime } = runtimeFor(child)
    await expect(new HarnessStructuredSubprocessPort(runtime).run(request)).resolves.toMatchObject({ outcome: 'failed', exitCode: null })

    const throwingWait = handle({ waitForExit: vi.fn(async () => { throw new Error('wait failure') }) })
    const throwingWaitRuntime = runtimeFor(throwingWait)
    await expect(new HarnessStructuredSubprocessPort(throwingWaitRuntime.runtime).run(request)).resolves.toMatchObject({ outcome: 'failed', exitCode: null })

    const rejected = handle({ done: Promise.reject(new Error('done failure')) })
    const rejectedRuntime = runtimeFor(rejected)
    await expect(new HarnessStructuredSubprocessPort(rejectedRuntime.runtime).run(request)).resolves.toMatchObject({ outcome: 'failed', exitCode: null })

    const unreadable = handle({ collected: { stdout: { readFrom: vi.fn(() => { throw new Error('read failure') }) } } })
    const unreadableRuntime = runtimeFor(unreadable)
    await expect(new HarnessStructuredSubprocessPort(unreadableRuntime.runtime).run(request)).resolves.toMatchObject({ outcome: 'failed', exitCode: null })
  })

  it('accepts lossy readers as bounded transcript and rejects malformed requests before spawn', async () => {
    const child = handle({ collected: { stdout: reader('tail', true) } })
    const { runtime } = runtimeFor(child)
    const result = await new HarnessStructuredSubprocessPort(runtime).run(request)
    expect(result.stdout).toEqual(new TextEncoder().encode('tail'))
    expect(result.stderr).toEqual(new Uint8Array())

    const invalid = await new HarnessStructuredSubprocessPort(runtime).run({ ...request, argv: [''] })
    expect(invalid.outcome).toBe('failed')
    expect(runtime.spawn).toHaveBeenCalledOnce()
  })

  it('rejects invalid cwd and numeric bounds before invoking the runtime', async () => {
    const { runtime } = runtimeFor(handle())
    const invalidRequests = [
      { ...request, cwd: '   ' },
      { ...request, cwd: 'bad\u0000cwd' },
      { ...request, stdoutMaxBytes: 0 },
      { ...request, stdoutMaxBytes: 1.5 },
      { ...request, stderrMaxBytes: 0 },
      { ...request, stderrMaxBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, timeoutMs: 0 },
      { ...request, timeoutMs: Number.NaN },
    ]

    for (const invalidRequest of invalidRequests) {
      await expect(new HarnessStructuredSubprocessPort(runtime).run(invalidRequest)).resolves.toMatchObject({ outcome: 'failed' })
    }
    expect(runtime.spawn).not.toHaveBeenCalled()
  })

  it('rejects oversized and launcher-free Windows pnpm shims without spawning', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'yuqi-pnpm-bounded-shim-'))
    try {
      const oversized = path.join(root, 'oversized.cmd')
      const launcherFree = path.join(root, 'launcher-free.cmd')
      await writeFile(oversized, 'x'.repeat(64 * 1024 + 1), 'utf8')
      await writeFile(launcherFree, '@echo off\r\necho pnpm\r\n', 'utf8')
      const runtime: HarnessSubprocessRuntime = {
        resolveExecutable: vi.fn()
          .mockResolvedValueOnce(oversized)
          .mockResolvedValueOnce(launcherFree),
        spawn: vi.fn(() => handle()),
      }
      const port = new HarnessStructuredSubprocessPort(runtime)

      await expect(port.run(request)).resolves.toMatchObject({ outcome: 'failed' })
      await expect(port.run(request)).resolves.toMatchObject({ outcome: 'failed' })
      expect(runtime.spawn).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves cancellation when executable resolution or spawn throws after abort', async () => {
    const duringResolution = new AbortController()
    const resolvingRuntime: HarnessSubprocessRuntime = {
      resolveExecutable: vi.fn(async () => {
        duringResolution.abort()
        throw new Error('resolver observed cancellation')
      }),
      spawn: vi.fn(() => handle()),
    }
    await expect(new HarnessStructuredSubprocessPort(resolvingRuntime).run({ ...request, signal: duringResolution.signal }))
      .resolves.toMatchObject({ outcome: 'aborted' })
    expect(resolvingRuntime.spawn).not.toHaveBeenCalled()

    const duringSpawn = new AbortController()
    const spawningRuntime: HarnessSubprocessRuntime = {
      spawn: vi.fn(() => {
        duringSpawn.abort()
        throw new Error('spawn observed cancellation')
      }),
    }
    await expect(new HarnessStructuredSubprocessPort(spawningRuntime).run({ ...request, signal: duringSpawn.signal }))
      .resolves.toMatchObject({ outcome: 'aborted' })
  })
})
