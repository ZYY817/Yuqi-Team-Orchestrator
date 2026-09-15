import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // These Node integration programs are exercised by their package scripts;
    // they are not Vitest suites and therefore must not be collected here.
    exclude: [...configDefaults.exclude, 'tests/integration/**/*.test.mjs'],
    // Real Git/worktree and Harness integration tests can exceed Vitest's
    // generic 5 s default on Windows under coverage instrumentation.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        // Keep a strong project-wide regression floor without forcing tests for
        // platform-only glue and defensive branches that cannot be exercised
        // through the public Host contract.
        lines: 95,
        functions: 95,
        statements: 95,
        branches: 95,
      },
    },
  },
})
