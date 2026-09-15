#!/usr/bin/env node

import assert from 'node:assert/strict'
import { startFixtureProvider } from './fixture-provider.mjs'

const fixture = await startFixtureProvider()
try {
  const response = await fetch(`${fixture.baseURL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture-smoke',
      messages: [{ role: 'user', content: 'Run [E2E_SCENARIO:parallel-7]' }],
      tools: [{ type: 'function', function: { name: 'yuqi_team_start', parameters: { type: 'object' } } }],
    }),
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.match(body, /yuqi_team_start/u)
  assert.doesNotMatch(body, /maxConcurrency/u)
  assert.equal(fixture.events().filter(event => event.type === 'controller-tool-call').length, 1)
  process.stdout.write('Fixture smoke passed: controller tool call omits model-owned maxConcurrency.\n')
} finally {
  await fixture.close()
}
