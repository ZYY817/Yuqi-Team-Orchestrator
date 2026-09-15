# Contributing

Thank you for contributing to Yuqi Team Orchestrator.

## Development setup

Use Node.js 24 and pnpm. Install dependencies and run the complete gate before opening a change:

```sh
pnpm install
pnpm run check
```

The architecture boundary is `host/adapters -> application -> domain`; the browser client consumes read-only projections and sends commands. Keep domain code independent from Harness, Cordis, Node I/O, Git, network, and UI.

## Source checkout and generated files

Commit source, tests, presets, scripts, documentation, package manifests and the
lockfile. `node_modules/` and `lib/` are local generated directories excluded by
`.gitignore`; a fresh checkout must run `pnpm install` and `pnpm run build` before
loading the plugin into Harness. The npm package uses the built `lib/` files
listed in `package.json`, while the GitHub repository stores their source.

Keep browser screenshots, test output, coverage reports and publishing-image
drafts outside the source repository. Keep referenced documentation assets and
test fixtures when they are required to reproduce a documented feature or test.

## Changes

- Keep each change focused and preserve existing public contracts unless the change explicitly includes a migration.
- Add behavior-based tests for fixes and new branches. Do not reduce coverage thresholds to make a change pass.
- Do not modify Harness source code or unrelated Agent presets.
- Document user-visible behavior in both READMEs or the appropriate user guide.
- Never commit credentials, Provider tokens, session data, generated coverage directories, or local worktrees.

## Pull requests

Describe the problem, solution, verification commands, and remaining risk. A change is ready for review when `pnpm run check` passes and user-facing flows have appropriate UI evidence.
