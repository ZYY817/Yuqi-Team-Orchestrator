#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PRESET_ID = 'yuqi-team'
export const USER_PRESET_DIR = '.agent-presets'
export const EXPECTED_FILES = ['preset.yml', 'agent.cordis.yml']

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_SOURCE_DIR = resolve(dirname(SCRIPT_PATH), '..', 'presets', PRESET_ID)
const DSH_HOME_DIR_NAME = '.dsh'

/** Stable public failure category for callers and integration tests. */
export class PresetInstallError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'PresetInstallError'
    this.code = code
  }
}

/** Match Harness home-paths precedence without importing private Harness code. */
export function resolveDshHome(configured, env = process.env) {
  const explicit = configured === undefined ? undefined : String(configured).trim()
  if (explicit === '') throw new PresetInstallError('INVALID_DSH_HOME', 'The explicit --dsh-home path is empty')
  const fromEnv = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined
  const selected = explicit ?? fromEnv ?? join(homedir(), DSH_HOME_DIR_NAME)
  return resolve(expandHomePath(selected))
}

/** Install the packaged user preset into the Harness-discovered user root. */
export async function installPreset({ dshHome, env = process.env, sourceDir = DEFAULT_SOURCE_DIR, writeFileImpl = writeFile, update = false } = {}) {
  const home = resolveDshHome(dshHome, env)
  assertSafeHome(home)
  const source = resolve(sourceDir)
  const files = await readSource(source)
  await assertNoSymlinkPath(home)

  const userRoot = join(home, USER_PRESET_DIR)
  const destination = join(userRoot, PRESET_ID)
  await ensureDirectory(home)
  await assertNoSymlinkPath(home)
  await ensureDirectory(userRoot)
  await assertNoSymlinkPath(userRoot)

  const existing = await entryKind(destination)
  if (existing !== 'missing') {
    await assertNoSymlinkPath(destination)
    if (existing !== 'directory') {
      throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination is not a directory: ${destination}`)
    }
    await assertNoSymlinkPath(destination)
    if (!update) {
      await assertExistingPreset(destination, files)
      return { status: 'unchanged', home, destination }
    }
  }

  let staging
  let quarantine
  try {
    staging = await mkdtemp(join(userRoot, `.${PRESET_ID}.install-`))
    await assertNoSymlinkPath(staging)
    for (const file of EXPECTED_FILES) {
      await writeFileImpl(join(staging, file), files.get(file), { flag: 'wx', mode: 0o600 })
    }
    await assertExistingPreset(staging, files)

    if (existing === 'directory' && update) {
      quarantine = await mkdtemp(join(userRoot, `.${PRESET_ID}.update-`))
      await rmdir(quarantine)
      await rename(destination, quarantine)
    }

    try {
      await rename(staging, destination)
      staging = undefined

      if (quarantine !== undefined) {
        for (const file of EXPECTED_FILES) {
          try { await unlink(join(quarantine, file)) } catch {}
        }
        try { await rmdir(quarantine) } catch {}
        quarantine = undefined
        return { status: 'updated', home, destination }
      }

      return { status: 'installed', home, destination }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const raced = await entryKind(destination)
      if (raced !== 'directory') {
        throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination changed while installing: ${destination}`)
      }
      await assertNoSymlinkPath(destination)
      await assertExistingPreset(destination, files)
      return { status: 'unchanged', home, destination }
    }
  } catch (error) {
    if (quarantine !== undefined) {
      try { await rename(quarantine, destination) } catch {}
    }
    if (error instanceof PresetInstallError) throw error
    throw new PresetInstallError('INSTALL_FAILED', `Could not install the Yuqi preset at ${destination}`, { cause: error })
  } finally {
    if (staging !== undefined) await rollbackNewPreset(staging)
  }
}

/**
 * Remove only the exact Yuqi preset directory after validating its shape.
 * The Harness user root and all sibling presets are left untouched.
 */
export async function removePreset({ dshHome, env = process.env } = {}) {
  const home = resolveDshHome(dshHome, env)
  assertSafeHome(home)
  const destination = join(home, USER_PRESET_DIR, PRESET_ID)
  const homeKind = await entryKind(home)
  if (homeKind === 'missing') return { status: 'absent', home, destination }
  await assertNoSymlinkPath(home)
  if (homeKind !== 'directory') {
    throw new PresetInstallError('TARGET_INVALID', `Harness home is not a directory: ${home}`)
  }

  const userRoot = join(home, USER_PRESET_DIR)
  const userRootKind = await entryKind(userRoot)
  if (userRootKind === 'missing') return { status: 'absent', home, destination }
  await assertNoSymlinkPath(userRoot)
  if (userRootKind !== 'directory') {
    throw new PresetInstallError('TARGET_INVALID', `Preset root is not a directory: ${userRoot}`)
  }

  const destinationKind = await entryKind(destination)
  if (destinationKind === 'missing') return { status: 'absent', home, destination }
  await assertNoSymlinkPath(destination)
  if (destinationKind !== 'directory') {
    throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination is not a directory: ${destination}`)
  }
  await assertPresetEntries(destination)

  let quarantine
  let moved = false
  try {
    quarantine = await mkdtemp(join(userRoot, `.${PRESET_ID}.remove-`))
    await rmdir(quarantine)
    await rename(destination, quarantine)
    moved = true
    await assertNoSymlinkPath(quarantine)
    await assertPresetEntries(quarantine)
    for (const file of EXPECTED_FILES) await unlink(join(quarantine, file))
    await rmdir(quarantine)
    quarantine = undefined
    return { status: 'removed', home, destination }
  } catch (error) {
    if (error instanceof PresetInstallError) throw error
    throw new PresetInstallError('REMOVE_FAILED', `Could not remove the Yuqi preset at ${destination}`, { cause: error })
  } finally {
    // Once the exact preset has been moved to quarantine, preserve that
    // recoverable directory if deletion is interrupted or fails. Before the
    // move, only remove our own empty marker directory.
    if (quarantine !== undefined && !moved) {
      try { await rmdir(quarantine) } catch { /* preserve unexpected content */ }
    }
  }
}

async function readSource(source) {
  await assertRegularDirectory(source, 'SOURCE_INVALID')
  const files = new Map()
  for (const file of EXPECTED_FILES) {
    const path = join(source, file)
    await assertRegularFile(path, 'SOURCE_INVALID')
    files.set(file, await readFile(path))
  }
  return files
}

async function assertExistingPreset(destination, expected) {
  await assertPresetEntries(destination)
  for (const file of EXPECTED_FILES) {
    const content = await readFile(join(destination, file))
    if (!content.equals(expected.get(file))) {
      throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination has different content: ${join(destination, file)}`)
    }
  }
}

async function assertPresetEntries(destination) {
  const entries = await readdir(destination, { withFileTypes: true })
  const names = new Set(entries.map(entry => entry.name))
  for (const entry of entries) {
    if (!EXPECTED_FILES.includes(entry.name)) {
      throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination contains unexpected content: ${join(destination, entry.name)}`)
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new PresetInstallError('SYMLINK_NOT_ALLOWED', `Preset destination entry is not a regular file: ${join(destination, entry.name)}`)
    }
  }
  for (const file of EXPECTED_FILES) {
    if (!names.has(file)) {
      throw new PresetInstallError('DESTINATION_CONFLICT', `Preset destination is incomplete: ${destination}`)
    }
  }
}

/** Roll back files created below a destination that this invocation created. */
async function rollbackNewPreset(destination) {
  if (await entryKind(destination) !== 'directory') return
  for (const file of EXPECTED_FILES) {
    const path = join(destination, file)
    if (await entryKind(path) !== 'file') continue
    try {
      await unlink(path)
    } catch {
      // Keep the exact failed path for the caller rather than deleting anything
      // that appeared concurrently in this newly-created directory.
    }
  }
  try {
    await rmdir(destination)
  } catch {
    // A concurrent/unexpected entry means the safest recovery is to preserve it.
  }
}

async function ensureDirectory(path) {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw new PresetInstallError('TARGET_INVALID', `Could not create Harness directory: ${path}`, { cause: error })
  }
  await assertRegularDirectory(path, 'TARGET_INVALID')
}

async function assertRegularDirectory(path, code) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    throw new PresetInstallError(code, `Required directory is unavailable: ${path}`, { cause: error })
  }
  if (info.isSymbolicLink()) throw new PresetInstallError('SYMLINK_NOT_ALLOWED', `Symbolic-link directory is not allowed: ${path}`)
  if (!info.isDirectory()) throw new PresetInstallError(code, `Path is not a directory: ${path}`)
}

async function assertRegularFile(path, code) {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    throw new PresetInstallError(code, `Required preset file is unavailable: ${path}`, { cause: error })
  }
  if (info.isSymbolicLink()) throw new PresetInstallError('SYMLINK_NOT_ALLOWED', `Symbolic-link file is not allowed: ${path}`)
  if (!info.isFile()) throw new PresetInstallError(code, `Preset path is not a regular file: ${path}`)
}

async function entryKind(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'directory'
    return 'file'
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw new PresetInstallError('TARGET_INVALID', `Could not inspect preset destination: ${path}`, { cause: error })
  }
}

/** Reject symlinked ancestors, including a symlink created before the final mkdir. */
async function assertNoSymlinkPath(path) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw new PresetInstallError('TARGET_INVALID', `Could not inspect Harness path: ${current}`, { cause: error })
    }
    if (info.isSymbolicLink()) throw new PresetInstallError('SYMLINK_NOT_ALLOWED', `Symbolic-link path is not allowed: ${current}`)
    if (!info.isDirectory() && current !== absolute) {
      throw new PresetInstallError('TARGET_INVALID', `Harness path has a non-directory ancestor: ${current}`)
    }
  }
}

function assertSafeHome(home) {
  const root = resolve(parse(home).root)
  const osHome = resolve(homedir())
  const cwd = resolve(process.cwd())
  if (samePath(home, root) || samePath(home, osHome) || samePath(home, cwd)) {
    throw new PresetInstallError('DANGEROUS_PATH', 'Refusing to install into a filesystem root, OS home, or current working directory')
  }
  if (!isAbsolute(home)) throw new PresetInstallError('INVALID_DSH_HOME', 'Harness home must resolve to an absolute path')
}

function samePath(left, right) {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function isAlreadyExists(error) {
  return error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY' || error?.code === 'EISDIR'
}

function parseArgs(argv) {
  let dshHome
  let remove = false
  let update = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--remove') {
      remove = true
      continue
    }
    if (arg === '--update' || arg === '-u' || arg === '--force' || arg === '-f') {
      update = true
      continue
    }
    if (arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new PresetInstallError('INVALID_ARGUMENT', '--dsh-home requires a path')
      dshHome = value
      index += 1
      continue
    }
    throw new PresetInstallError('INVALID_ARGUMENT', `Unknown argument: ${arg}`)
  }
  return { dshHome, remove, update }
}

function usage() {
  return 'Usage: yuqi-team-install-preset [--dsh-home <path>] [--remove] [--update]'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  const result = args.remove ? await removePreset(args) : await installPreset(args)
  const message = result.status === 'installed'
    ? 'Installed'
    : result.status === 'updated'
    ? 'Updated'
    : result.status === 'removed' ? 'Removed' : result.status === 'absent' ? 'Already absent' : 'Already installed'
  console.log(`${message} Yuqi preset: ${result.destination}`)
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH || import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Yuqi preset installation failed: ${message}`)
    process.exitCode = 1
  })
}
