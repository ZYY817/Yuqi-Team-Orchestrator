import { describe, expect, it } from 'vitest'
import {
  fileScopePatternsConflict,
  fileScopeSetsConflict,
  fileScopeMatchesPath,
  fileScopePatternSchema,
  teamTaskContractSchema,
} from '../src/index.ts'
import { contract } from './fixtures.ts'

describe('fileScope', () => {
  it.each([
    'src/**',
    'src/*/index.ts',
    'README.md',
    'packages/my package/**',
  ])('accepts the minimal repository-relative grammar: %s', (pattern) => {
    expect(fileScopePatternSchema.parse(pattern)).toBe(pattern)
  })

  it.each([
    '/absolute/**',
    'C:/drive/**',
    'src\\windows\\path',
    'src/../secret',
    'src/./file',
    'src//file',
    'src/{a,b}',
    'src/file?.ts',
  ])('rejects unsafe or undefined syntax: %s', (pattern) => {
    expect(() => fileScopePatternSchema.parse(pattern)).toThrow()
  })

  it.each([
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.ts', 'src/b.ts', false],
    ['src/**', 'src/a.ts', true],
    ['src/*', 'src/a.ts', true],
    ['src/*', 'src/a/nested.ts', false],
    ['src/a/**', 'src/b/**', false],
    ['src/*/a.ts', 'src/*/b.ts', false],
    ['src/**/Hero*', 'src/**/What*', false],
    ['src/**/Hero*', 'src/styles/Hero.css', true],
    ['src/styles/**', 'src/**/Hero*', true],
    ['**', 'README.md', true],
    ['**/**', 'a/b', true],
    ['**/**/x', 'a/b/y', false],
    ['src/a.ts', ' src/a.ts ', true],
  ] as const)('conservatively checks %s against %s', (left, right, expected) => {
    expect(fileScopePatternsConflict(left, right)).toBe(expected)
    expect(fileScopePatternsConflict(right, left)).toBe(expected)
  })

  it('keeps schema-v1 replay compatible while exposing the stricter C1 grammar', () => {
    expect(teamTaskContractSchema.parse({ ...contract(), fileScope: [] }).fileScope).toEqual([])
    expect(teamTaskContractSchema.parse({ ...contract(), fileScope: ['legacy/{pattern}'] }).fileScope).toEqual(['legacy/{pattern}'])
    expect(teamTaskContractSchema.parse({ ...contract(), authorityMode: 'read-only', fileScope: [] }).fileScope).toEqual([])
  })

  it('supports common filename wildcards without allowing recursive syntax inside a segment', () => {
    expect(fileScopePatternSchema.parse('**/*Tests*/**/ScheduledTask*Tests*.cs')).toBe('**/*Tests*/**/ScheduledTask*Tests*.cs')
    expect(fileScopeMatchesPath('**/*Tests*/**/ScheduledTask*Tests*.cs', 'src/AppTests/Unit/ScheduledTaskServiceTests.cs')).toBe(true)
    expect(() => fileScopePatternSchema.parse('src/a***b.ts')).toThrow()
  })

  it('treats every entry in a multi-file task scope as owned without widening unrelated paths', () => {
    const featureScope = ['src/components/Hero.tsx', 'src/styles/hero.css', 'src/assets/hero/**']

    expect(fileScopeSetsConflict(featureScope, ['src/styles/hero.css'])).toBe(true)
    expect(fileScopeSetsConflict(featureScope, ['src/assets/hero/background.webp'])).toBe(true)
    expect(fileScopeSetsConflict(featureScope, ['src/components/Footer.tsx', 'tests/hero.spec.ts'])).toBe(false)
  })

  it.each([
    ['src/**', 'src/a/file.ts', true],
    ['src/*', 'src/a/file.ts', false],
    ['README.md', 'README.md', true],
    ['src/**', 'tests/a.ts', false],
    ['src/**', '/src/a.ts', false],
    ['src/**', 'src/../outside.ts', false],
    ['src/**', 'src\\a.ts', true],
  ] as const)('matches scope %s against repository path %s', (pattern, repositoryPath, expected) => {
    expect(fileScopeMatchesPath(pattern, repositoryPath)).toBe(expected)
  })
})
