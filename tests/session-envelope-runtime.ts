import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Unit-only runtime: add the envelope field before the real append freezes and publishes it. */
export async function loadSessionEnvelopeFixture(): Promise<typeof import('@deepseek-ai/dsh-session')> {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@deepseek-ai/dsh-session')
  const source = await readFile(entry, 'utf8')
  const insertion = 'const surfaceMetadata = {'
  if (source.split(insertion).length !== 2) {
    throw new Error('Session unit fixture requires review: the installed append implementation changed')
  }
  const fromEntry = createRequire(entry)
  const transformed = source.replace(insertion,
    `${insertion}\n...surfaceOpts?.ignorable === true ? { ignorable: true } : {},`)
    .replace(/from (["'])([^"']+)\1/g, (_match, _quote: string, specifier: string) => {
      const target = specifier.startsWith('node:') ? specifier : pathToFileURL(fromEntry.resolve(specifier)).href
      return `from ${JSON.stringify(target)}`
    })
  // Evaluate a separate in-memory module. Never rewrite node_modules or a Host checkout.
  const url = `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`
  return import(/* @vite-ignore */ url)
}
