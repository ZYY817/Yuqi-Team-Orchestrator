/** UTF-8 project-local file adapter for the deliberately small summary index. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createEmptyProjectSummary,
  projectSummarySchema,
  updateProjectSummary,
  validateProjectSummary,
  type ProjectSummary,
  type ProjectSummaryPatch,
} from '../application/project-summary.ts'

export const PROJECT_SUMMARY_DIRECTORY = '.yuqi-team'
export const PROJECT_SUMMARY_FILENAME = 'index.json'

// Shared by all adapter instances/Teams in this module's process. This is not a
// cross-process lock; external writers must coordinate separately.
const summaryWrites = new Map<string, Promise<void>>()

export interface ProjectSummaryFilePort {
  read(projectRoot: string): Promise<ProjectSummary>
  write(projectRoot: string, summary: ProjectSummary): Promise<ProjectSummary>
  update(projectRoot: string, patch: ProjectSummaryPatch): Promise<ProjectSummary>
}

export class NodeProjectSummaryFile implements ProjectSummaryFilePort {
  readonly #nowIso: () => string

  constructor(nowIso: () => string = () => new Date().toISOString()) {
    this.#nowIso = nowIso
  }

  async read(projectRoot: string): Promise<ProjectSummary> {
    return this.#readFile(projectSummaryPath(projectRoot))
  }

  /**
   * Publish the current execution-project/worktree index under the writer queue.
   * The callback must not reenter this index's queue. Only subsequent reads are
   * affected; this does not retract snapshots already sent to conversations.
   */
  async publishLatest(projectRoot: string, publish: (summary: ProjectSummary) => Promise<void>): Promise<void> {
    const file = await canonicalSummaryPath(projectRoot, false)
    await serializeSummaryWrite(file, async () => {
      await publish(await this.#readFile(file))
    })
  }

  async #readFile(file: string): Promise<ProjectSummary> {
    try {
      const text = await readFile(file, 'utf8')
      return validateProjectSummary(JSON.parse(text) as unknown)
    } catch (cause) {
      if (isMissingFile(cause)) return createEmptyProjectSummary(this.#nowIso())
      throw new Error(`Yuqi project summary is invalid or unreadable: ${file}`, { cause })
    }
  }

  async write(projectRoot: string, summary: ProjectSummary): Promise<ProjectSummary> {
    const validated = validateProjectSummary(summary)
    const file = await canonicalSummaryPath(projectRoot)
    return serializeSummaryWrite(file, () => this.#writeFile(file, validated))
  }

  async #writeFile(file: string, validated: ProjectSummary): Promise<ProjectSummary> {
    const temporary = path.join(path.dirname(file), `.${PROJECT_SUMMARY_FILENAME}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      // Explicit write still replaces the whole summary, but cannot interleave
      // with an update's read-modify-write in this process.
      await rename(temporary, file)
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw cause
    }
    return validated
  }

  async update(projectRoot: string, patch: ProjectSummaryPatch): Promise<ProjectSummary> {
    const file = await canonicalSummaryPath(projectRoot)
    return serializeSummaryWrite(file, async () => {
      const current = await this.#readFile(file)
      const next = updateProjectSummary(current, patch, this.#nowIso())
      // Idempotent removal/clearing must not rewrite a file or create an empty index.
      return next === current ? current : this.#writeFile(file, next)
    })
  }
}

async function canonicalSummaryPath(projectRoot: string, create = true): Promise<string> {
  const directory = path.dirname(projectSummaryPath(projectRoot))
  // Resolve the containing directory, not index.json (which may not exist yet).
  // This also handles symlink/junction aliases of the root or .yuqi-team itself.
  if (create) await mkdir(directory, { recursive: true })
  try { return path.join(await realpath(directory), PROJECT_SUMMARY_FILENAME) }
  catch (cause) {
    if (create || !isMissingFile(cause)) throw cause
    // A read-only refresh must not create .yuqi-team in an untouched project.
    return path.join(await realpath(projectRoot), PROJECT_SUMMARY_DIRECTORY, PROJECT_SUMMARY_FILENAME)
  }
}

async function serializeSummaryWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = summaryWrites.get(file) ?? Promise.resolve()
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  summaryWrites.set(file, pending)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (summaryWrites.get(file) === pending) summaryWrites.delete(file)
  }
}

export function projectSummaryPath(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot)) throw new Error('Project summary requires an absolute project root')
  return path.join(path.resolve(projectRoot), PROJECT_SUMMARY_DIRECTORY, PROJECT_SUMMARY_FILENAME)
}

export function parseProjectSummary(value: unknown): ProjectSummary {
  return projectSummarySchema.parse(value)
}

function isMissingFile(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
}
