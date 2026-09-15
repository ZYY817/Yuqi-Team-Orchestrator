import { defineConfig } from 'tsdown'

const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
]

export default defineConfig([
  {
    name: 'yuqi-team-orchestrator/host',
    entry: {
      index: 'src/index.ts',
      agent: 'src/agent/index.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    deps: { neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-session-projection/types',
      '@deepseek-ai/dsh-session/types',
      '@deepseek-ai/dsh-subagent',
    ] },
    dts: true,
    clean: true,
  },
  {
    name: 'yuqi-team-orchestrator/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: clientExternals,
      // The Harness browser loader only exposes registered shell modules.
      // Runtime dependencies such as zod must travel inside this plugin's
      // client bundle instead of becoming an unregistered require("zod").
      alwaysBundle: ['zod'],
      onlyBundle: ['zod'],
    },
    outputOptions: {
      entryFileNames: 'client.cjs',
      banner: 'window.__ModuleLoader__.load({ id: "yuqi-team-orchestrator", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
