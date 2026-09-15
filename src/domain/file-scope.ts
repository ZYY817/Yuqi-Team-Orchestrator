/** Minimal, repository-relative file-scope patterns used for safe scheduling. */

import { z } from 'zod'

const FORBIDDEN_LITERAL = /[\\:?\[\]{}!]/u

/** Runtime schema for the C1 `fileScope` grammar. */
export const fileScopePatternSchema = z.string().trim().min(1).superRefine((pattern, context) => {
  if (pattern.startsWith('/') || pattern.endsWith('/') || pattern.includes('//')) {
    context.addIssue({ code: 'custom', message: 'fileScope must be a normalized repository-relative pattern' })
    return
  }
  for (const segment of pattern.split('/')) {
    if (segment === '.' || segment === '..') {
      context.addIssue({ code: 'custom', message: 'fileScope cannot contain . or .. segments' })
    } else if (segment !== '**' && (FORBIDDEN_LITERAL.test(segment) || segment.includes('***'))) {
      context.addIssue({ code: 'custom', message: `fileScope segment ${segment} uses unsupported syntax` })
    }
  }
})

/** Whether any two patterns may address the same repository-relative path. */
export function fileScopeSetsConflict(left: readonly string[], right: readonly string[]): boolean {
  return left.some(leftPattern => right.some(rightPattern => fileScopePatternsConflict(leftPattern, rightPattern)))
}

/** Conservative overlap check: uncertainty is treated as a conflict. */
export function fileScopePatternsConflict(left: string, right: string): boolean {
  const leftSegments = parseSegments(left)
  const rightSegments = parseSegments(right)
  return patternsHaveCommonPath(leftSegments, rightSegments)
}

/** Whether one normalized repository-relative path is covered by a scope pattern. */
export function fileScopeMatchesPath(pattern: string, repositoryPath: string): boolean {
  const normalized = repositoryPath.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.endsWith('/') || normalized.includes('//')) return false
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return matchesPattern(parseSegments(pattern), segments)
}

function parseSegments(pattern: string): readonly string[] {
  return fileScopePatternSchema.parse(pattern).split('/')
}

function matchesPattern(pattern: readonly string[], path: readonly string[]): boolean {
  const memo = new Map<string, boolean>()
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`
    const previous = memo.get(key)
    if (previous !== undefined) return previous
    let matches: boolean
    if (patternIndex === pattern.length) {
      matches = pathIndex === path.length
    } else if (pattern[patternIndex] === '**') {
      matches = visit(patternIndex + 1, pathIndex) || (pathIndex < path.length && visit(patternIndex, pathIndex + 1))
    } else {
      matches = pathIndex < path.length
        && segmentMatches(pattern[patternIndex]!, path[pathIndex]!)
        && visit(patternIndex + 1, pathIndex + 1)
    }
    memo.set(key, matches)
    return matches
  }
  return visit(0, 0)
}

/** Decide whether two supported path globs have at least one common path. */
function patternsHaveCommonPath(left: readonly string[], right: readonly string[]): boolean {
  const memo = new Map<string, boolean>()
  const visit = (leftIndex: number, rightIndex: number): boolean => {
    const key = `${leftIndex}:${rightIndex}`
    const previous = memo.get(key)
    if (previous !== undefined) return previous

    let overlaps: boolean
    if (leftIndex === left.length || rightIndex === right.length) {
      overlaps = leftIndex === left.length
        ? right.slice(rightIndex).every(segment => segment === '**')
        : left.slice(leftIndex).every(segment => segment === '**')
    } else {
      const leftSegment = left[leftIndex]!
      const rightSegment = right[rightIndex]!
      if (leftSegment === '**' && rightSegment === '**') {
        overlaps = visit(leftIndex + 1, rightIndex) || visit(leftIndex, rightIndex + 1)
      } else if (leftSegment === '**') {
        overlaps = visit(leftIndex + 1, rightIndex) || visit(leftIndex, rightIndex + 1)
      } else if (rightSegment === '**') {
        overlaps = visit(leftIndex, rightIndex + 1) || visit(leftIndex + 1, rightIndex)
      } else {
        overlaps = segmentPatternsOverlap(leftSegment, rightSegment)
          && visit(leftIndex + 1, rightIndex + 1)
      }
    }
    memo.set(key, overlaps)
    return overlaps
  }
  return visit(0, 0)
}

/** Decide whether two single-segment `*` globs share at least one filename. */
function segmentPatternsOverlap(left: string, right: string): boolean {
  const memo = new Map<string, boolean>()
  const visit = (leftIndex: number, rightIndex: number): boolean => {
    const key = `${leftIndex}:${rightIndex}`
    const previous = memo.get(key)
    if (previous !== undefined) return previous

    let overlaps: boolean
    if (leftIndex === left.length || rightIndex === right.length) {
      overlaps = leftIndex === left.length
        ? [...right.slice(rightIndex)].every(character => character === '*')
        : [...left.slice(leftIndex)].every(character => character === '*')
    } else {
      const leftCharacter = left[leftIndex]!
      const rightCharacter = right[rightIndex]!
      if (leftCharacter === '*' && rightCharacter === '*') {
        overlaps = visit(leftIndex + 1, rightIndex) || visit(leftIndex, rightIndex + 1)
      } else if (leftCharacter === '*') {
        overlaps = visit(leftIndex + 1, rightIndex) || visit(leftIndex, rightIndex + 1)
      } else if (rightCharacter === '*') {
        overlaps = visit(leftIndex, rightIndex + 1) || visit(leftIndex + 1, rightIndex)
      } else {
        overlaps = leftCharacter === rightCharacter && visit(leftIndex + 1, rightIndex + 1)
      }
    }
    memo.set(key, overlaps)
    return overlaps
  }
  return visit(0, 0)
}

function segmentMatches(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`, 'u').test(value)
}
