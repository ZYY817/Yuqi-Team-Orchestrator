#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { startFixtureProvider } from './fixture-provider.mjs'
import { runScenario, SCENARIOS } from './scenarios.mjs'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
if (!process.env.DSH_E2E_HARNESS_ROOT) {
  throw new Error('DSH_E2E_HARNESS_ROOT must point to a local deepseek-harness checkout')
}
const harnessRoot = resolve(process.env.DSH_E2E_HARNESS_ROOT)
const cliEntry = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
const harnessManifest = join(harnessRoot, 'package.json')
const overlayPath = join(projectRoot, 'tests', 'e2e', 'real-host.patch.yml')
const presetInstaller = join(projectRoot, 'scripts', 'install-preset.mjs')
const artifactRoot = resolve(process.env.DSH_E2E_ARTIFACT_DIR
  ?? join(projectRoot, 'tests', 'e2e', '.artifacts', runId()))

const requested = process.argv.slice(2)
const externalProject = process.env.DSH_E2E_PROJECT_DIR_OVERRIDE === undefined
  ? undefined
  : resolve(process.env.DSH_E2E_PROJECT_DIR_OVERRIDE)
const scenarioNames = requested.length === 0
  ? Object.values(SCENARIOS).filter(scenario => scenario.default !== false).map(scenario => scenario.name)
  : requested
for (const name of scenarioNames) {
  if (SCENARIOS[name] === undefined) throw new Error(`unknown E2E scenario ${JSON.stringify(name)}`)
}

preflight()
await mkdir(artifactRoot, { recursive: true })

const results = []
for (const name of scenarioNames) {
  const scenario = SCENARIOS[name]
  const result = await runIsolated(scenario)
  results.push(result)
  if (result.status === 'failed') break
}

await writeJson(join(artifactRoot, 'summary.json'), { harnessRoot, results })
if (results.some(result => result.status === 'failed')) process.exitCode = 1
else process.stdout.write(`Real Host E2E completed: ${results.map(result => result.scenario).join(', ')}\nArtifacts: ${artifactRoot}\n`)

async function runIsolated(scenario) {
  const startedAt = new Date().toISOString()
  const scenarioArtifacts = join(artifactRoot, scenario.name)
  await mkdir(scenarioArtifacts, { recursive: true })
  const ownedRoot = await realpath(await mkdtemp(join(tmpdir(), 'yuqi-real-host-e2e-')))
  const paths = ownedPaths(ownedRoot, externalProject)
  let fixture
  let host
  let environment
  let baseUrl
  let context
  let page
  const hostOutput = { stdout: '', stderr: '' }
  let failure

  try {
    for (const path of [paths.dshHome, paths.agentsHome, paths.browserProfile]) assertWithinOwnedRoot(ownedRoot, path)
    await Promise.all([
      mkdir(paths.dshHome, { recursive: true }),
      mkdir(paths.agentsHome, { recursive: true }),
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.browserProfile, { recursive: true }),
    ])
    if (externalProject === undefined) {
      await writeFile(join(paths.project, 'AGENTS.md'), 'Isolated E2E project. Do not access paths outside this temporary project.\n', 'utf8')
    }

    fixture = await startFixtureProvider()
    environment = isolatedEnvironment(paths, fixture.baseURL)
    await runCheckedDsh(
      ['plugin', '--profile', 'web', 'add', projectRoot],
      { cwd: paths.project, env: environment, label: 'profile plugin install' },
    )
    const configDump = await runCheckedDsh(
      ['--profile', 'web', '--dump-default-config'],
      { cwd: paths.project, env: environment, label: 'profile config dump' },
    )
    await writeFile(join(scenarioArtifacts, 'default-config.yml'), configDump.stdout, 'utf8')
    if (!configDump.stdout.includes('yuqi-team-orchestrator')) {
      throw new Error('installed web profile did not compose the Yuqi Host service')
    }
    await runCheckedProcess(
      process.execPath,
      [presetInstaller, '--dsh-home', paths.dshHome],
      { cwd: paths.project, env: environment, label: 'preset install' },
    )

    host = spawnDsh(['web', '--patch', overlayPath, '--port', '0'], {
      cwd: paths.project,
      env: environment,
      output: hostOutput,
    })
    baseUrl = await waitForHostReady(host, hostOutput, 60_000)

    const executablePath = browserExecutable()
    context = await chromium.launchPersistentContext(paths.browserProfile, {
      headless: process.env.DSH_E2E_HEADED !== '1',
      locale: 'en-US',
      viewport: { width: 1440, height: 960 },
      ...(executablePath === undefined ? {} : { executablePath }),
    })
    page = context.pages()[0] ?? await context.newPage()
    const browserErrors = []
    const networkFailures = []
    let intentionalRestartInProgress = false
    page.on('pageerror', error => {
      if (!intentionalRestartInProgress) browserErrors.push(`pageerror: ${error.message}`)
    })
    page.on('console', message => {
      if (message.type() === 'error' && !intentionalRestartInProgress) browserErrors.push(`console: ${message.text()}`)
    })
    page.on('requestfailed', request => {
      const errorText = request.failure()?.errorText ?? ''
      const navigationAbortedDirectoryRead = request.method() === 'POST'
        && request.url().includes('/api/host.listDirectory')
        && errorText === 'net::ERR_ABORTED'
      if (!intentionalRestartInProgress && !navigationAbortedDirectoryRead) {
        networkFailures.push(`requestfailed: ${request.method()} ${request.url()} ${errorText}`)
      }
    })
    await page.goto(baseUrl, { waitUntil: 'load', timeout: 30_000 })
    await page.getByRole('tree', { name: 'Sessions' }).waitFor({ state: 'visible', timeout: 30_000 })

    const previousProject = process.env.DSH_E2E_PROJECT_DIR
    const previousArtifacts = process.env.DSH_E2E_SCENARIO_ARTIFACTS
    process.env.DSH_E2E_PROJECT_DIR = paths.project
    process.env.DSH_E2E_SCENARIO_ARTIFACTS = scenarioArtifacts
    try {
      await runScenario({
        page, fixture, scenario,
        lifecycle: {
          restartHost: async () => {
            if (host === undefined || environment === undefined || baseUrl === undefined) throw new Error('Host lifecycle is not ready')
            intentionalRestartInProgress = true
            const port = new URL(baseUrl).port
            const beforeRestartStdout = hostOutput.stdout
            const beforeRestartStderr = hostOutput.stderr
            await terminateExactProcess(host)
            const restartMarker = `\n--- intentional E2E Host restart: pid=${String(host.pid)} ---\n`
            // Readiness must observe only the new process output. Keeping the
            // old URL in this buffer would make waitForHostReady return before
            // the replacement Host has actually bound the port.
            hostOutput.stdout = ''
            hostOutput.stderr = ''
            host = spawnDsh(['web', '--patch', overlayPath, '--port', port], {
              cwd: paths.project,
              env: environment,
              output: hostOutput,
            })
            const restartedUrl = await waitForHostReady(host, hostOutput, 60_000)
            hostOutput.stdout = `${beforeRestartStdout}${restartMarker}${hostOutput.stdout}`
            hostOutput.stderr = `${beforeRestartStderr}\n--- restarted Host stderr ---\n${hostOutput.stderr}`
            if (new URL(restartedUrl).port !== port) throw new Error(`Host restarted on unexpected port ${restartedUrl}`)
          },
          finishRestart: () => {
            browserErrors.length = 0
            networkFailures.length = 0
            intentionalRestartInProgress = false
          },
        },
      })
    } finally {
      if (previousProject === undefined) delete process.env.DSH_E2E_PROJECT_DIR
      else process.env.DSH_E2E_PROJECT_DIR = previousProject
    }
    if (browserErrors.length > 0 || networkFailures.length > 0) {
      throw new Error(`browser emitted errors:\n${[...browserErrors, ...networkFailures].join('\n')}`)
    }
    await page.screenshot({ path: join(scenarioArtifacts, 'final.png'), fullPage: true })
  } catch (error) {
    failure = error
    if (page !== undefined) {
      const actionItems = page.getByRole('button', { name: /Open controller action items|查看主控处理项/u }).first()
      if (await actionItems.isVisible().catch(() => false)) await actionItems.click().catch(() => {})
      await page.screenshot({ path: join(scenarioArtifacts, 'failure.png'), fullPage: true }).catch(() => {})
      await writeFile(join(scenarioArtifacts, 'failure-page.txt'), await page.locator('body').innerText(), 'utf8').catch(() => {})
    }
  } finally {
    const cleanupErrors = []
    if (fixture !== undefined) {
      await writeJson(join(scenarioArtifacts, 'fixture.json'), fixture.events()).catch(error => cleanupErrors.push(error))
    }
    if (context !== undefined) await context.close().catch(error => cleanupErrors.push(error))
    if (host !== undefined) await terminateExactProcess(host).catch(error => cleanupErrors.push(error))
    if (fixture !== undefined) await fixture.close().catch(error => cleanupErrors.push(error))
    await writeFile(
      join(scenarioArtifacts, 'host.log'),
      sanitizeLog(`${hostOutput.stdout}\n--- stderr ---\n${hostOutput.stderr}`, ownedRoot),
      'utf8',
    ).catch(error => cleanupErrors.push(error))
    await safeRemoveOwnedRoot(ownedRoot, [paths.dshHome, paths.agentsHome, paths.browserProfile]).catch(error => cleanupErrors.push(error))
    if (cleanupErrors.length > 0) {
      const cleanupFailure = new AggregateError(cleanupErrors, `${scenario.name} cleanup failed`)
      failure = failure === undefined ? cleanupFailure : new AggregateError([failure, cleanupFailure], `${scenario.name} failed and cleanup was incomplete`)
    }
  }

  const result = {
    scenario: scenario.name,
    status: failure === undefined ? 'passed' : 'failed',
    startedAt,
    finishedAt: new Date().toISOString(),
    ...(failure === undefined ? {} : { error: sanitizeLog(renderError(failure), ownedRoot) }),
  }
  await writeJson(join(scenarioArtifacts, 'result.json'), result)
  if (failure !== undefined) process.stderr.write(`${scenario.name} failed: ${result.error}\nEvidence: ${scenarioArtifacts}\n`)
  return result
}

function ownedPaths(root, projectOverride) {
  return Object.freeze({
    dshHome: join(root, 'dsh-home'),
    agentsHome: join(root, 'agents-home'),
    project: projectOverride ?? join(root, 'project'),
    browserProfile: join(root, 'browser-profile'),
  })
}

function isolatedEnvironment(paths, providerBaseURL) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (isProviderCredentialKey(key)) delete env[key]
  }
  delete env.DEEPSEEK_BASE_URL
  delete env.OPENAI_BASE_URL
  return {
    ...env,
    DSH_HOME: paths.dshHome,
    DSH_AGENTS_HOME: paths.agentsHome,
    DSH_BUNDLED_SKILL_DIR: join(paths.agentsHome, 'bundled-skills'),
    DSH_E2E_PROVIDER_BASE_URL: providerBaseURL,
    DSH_E2E_PROVIDER_KEY: 'isolated-e2e-fixture-key',
    TSX_TSCONFIG_PATH: join(harnessRoot, 'tsconfig.json'),
    NO_COLOR: '1',
  }
}

function isProviderCredentialKey(key) {
  return /(?:DEEPSEEK|OPENAI|ANTHROPIC|OPENROUTER|PERPLEXITY|EXA|GEMINI|GOOGLE|AZURE|AWS|COHERE|MISTRAL|GROQ|TOGETHER|FIREWORKS|DASHSCOPE)/iu.test(key)
    && /(?:API_?KEY|ACCESS_?KEY(?:_ID)?|SECRET(?:_ACCESS_KEY)?|TOKEN)$/iu.test(key)
}

function spawnDsh(args, { cwd, env, output }) {
  const child = spawn(process.execPath, sourceCliArgs(args), {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output.stdout = boundedAppend(output.stdout, chunk) })
  child.stderr.on('data', chunk => { output.stderr = boundedAppend(output.stderr, chunk) })
  child.on('error', error => { output.stderr = boundedAppend(output.stderr, `\nHost spawn error: ${error.message}\n`) })
  return child
}

async function runCheckedDsh(args, options) {
  return runCheckedProcess(process.execPath, sourceCliArgs(args), options)
}

function sourceCliArgs(args) {
  const requireFromHarness = createRequire(harnessManifest)
  const tsxLoader = pathToFileURL(requireFromHarness.resolve('tsx')).href
  return ['--import', tsxLoader, cliEntry, ...args]
}

async function runCheckedProcess(command, args, { cwd, env, label }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const closed = new Promise((resolveCode, reject) => {
    child.once('error', reject)
    child.once('close', resolveCode)
  })
  let code
  let timeout
  try {
    code = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after 120000ms`)), 120_000)
      }),
    ])
  } catch (error) {
    await terminateExactProcess(child).catch(() => {})
    throw error
  } finally {
    clearTimeout(timeout)
  }
  if (code !== 0) {
    throw new Error(`${label} exited ${String(code)}\n${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}`)
  }
  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

async function waitForHostReady(child, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /dsh web:\s+(https?:\/\/[^\s]+)/u.exec(output.stdout)
    if (match !== null) return match[1]
    if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode} before readiness\n${output.stderr}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`Host readiness timeout after ${timeoutMs}ms\n${output.stderr}`)
}

async function terminateExactProcess(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`refusing to terminate invalid Host PID ${String(pid)}`)
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    await new Promise((resolveKill, reject) => {
      killer.once('error', reject)
      killer.once('close', () => resolveKill())
    })
  } else {
    // Match Windows /T /F semantics: this scenario validates abrupt process
    // loss, not the graceful disposal path covered by ordinary shutdown tests.
    child.kill('SIGKILL')
  }
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise(resolveClose => child.once('close', resolveClose)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Host PID ${pid} did not exit`)), 10_000)),
  ])
}

async function safeRemoveOwnedRoot(root, children) {
  const absoluteRoot = resolve(root)
  const tempParent = resolve(tmpdir())
  if (dirname(absoluteRoot).toLowerCase() !== tempParent.toLowerCase()
    || !basename(absoluteRoot).startsWith('yuqi-real-host-e2e-')) {
    throw new Error(`refusing to remove unrecognized E2E root ${absoluteRoot}`)
  }
  for (const child of children) assertWithinOwnedRoot(absoluteRoot, child)
  await rm(absoluteRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

function assertWithinOwnedRoot(root, target) {
  const absoluteRoot = resolve(root)
  const absoluteTarget = resolve(target)
  const child = relative(absoluteRoot, absoluteTarget)
  if (!isAbsolute(absoluteRoot) || child === '' || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(child)) {
    throw new Error(`path is not an owned E2E child: ${absoluteTarget}`)
  }
}

function preflight() {
  for (const path of [projectRoot, harnessRoot, cliEntry, harnessManifest, overlayPath, presetInstaller]) {
    if (!existsSync(path)) throw new Error(`required E2E path is missing: ${path}`)
  }
  const requiredBuildOutputs = [
    join(projectRoot, 'lib', 'index.js'),
    join(projectRoot, 'lib', 'client.cjs'),
    join(harnessRoot, 'apps', 'web', 'dist', 'index.html'),
  ]
  const missing = requiredBuildOutputs.filter(path => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`real Host E2E requires the main-line build first; missing:\n${missing.join('\n')}`)
  }
  createRequire(harnessManifest).resolve('tsx')
}

function browserExecutable() {
  if (process.env.DSH_E2E_BROWSER_EXECUTABLE !== undefined) {
    const configured = resolve(process.env.DSH_E2E_BROWSER_EXECUTABLE)
    if (!existsSync(configured)) throw new Error(`DSH_E2E_BROWSER_EXECUTABLE is missing: ${configured}`)
    return configured
  }
  if (process.platform !== 'win32') return undefined
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(path => existsSync(path))
}

function sanitizeLog(value, ownedRoot) {
  return value
    .replaceAll(ownedRoot, '<TEMP_ROOT>')
    .replaceAll('isolated-e2e-fixture-key', '<REDACTED>')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1<REDACTED>')
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;]+/giu, '$1<REDACTED>')
}

function boundedAppend(current, chunk, max = 1_000_000) {
  const next = current + String(chunk)
  return next.length <= max ? next : next.slice(next.length - max)
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function renderError(error) {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(renderError).join('; ')}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function runId() {
  return new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
}
