import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { scenarioToolArguments, SCENARIOS } from './scenarios.mjs'

const TASK_MARKER = /\[E2E_TASK:([^:\]]+):(\d+):(success|empty|fail|hang|barrier|write)\]/u
const SCENARIO_MARKER = /\[E2E_SCENARIO:([^\]]+)\]/u
const REVIEW_MARKER = /\[E2E_REVIEW:([^\]]+)\]/u

export async function startFixtureProvider() {
  const records = []
  const waiters = new Set()
  const activeResponses = new Set()
  const activeByScenario = new Map()
  const peakByScenario = new Map()
  const barriers = new Map()
  const pendingWrites = new Map()

  const emit = event => {
    const record = Object.freeze({ sequence: records.length + 1, at: new Date().toISOString(), ...event })
    records.push(record)
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(record)) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(record)
    }
    return record
  }

  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !new URL(request.url ?? '/', 'http://fixture.invalid').pathname.endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"fixture route not found"}}')
      return
    }

    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"error":{"message":"invalid fixture JSON"}}')
        return
      }

      const searchable = JSON.stringify(body.messages ?? [])
      const scenarioMatch = SCENARIO_MARKER.exec(searchable)
      const reviewMatch = REVIEW_MARKER.exec(searchable)
      const taskMatch = TASK_MARKER.exec(searchable)
      const reviewerPrompt = searchable.includes('你是 Yuqi Team 的反对者/审查 Agent')
        || searchable.includes('You are the adversarial/review Agent for Yuqi Team')
      const controllerToolOffered = (body.tools ?? []).some(tool => tool?.function?.name === 'yuqi_team_start')
      const controllerSurface = controllerToolOffered
        || (body.messages ?? []).some(message => message?.tool_calls?.some(call => call?.function?.name === 'yuqi_team_start'))
      // Reviewer prompts deliberately carry the original Team objective for
      // independent verification. That objective may still contain the E2E
      // scenario marker, so classify the more specific review request before
      // the broader controller surface.
      if (reviewMatch !== null || (reviewerPrompt && scenarioMatch !== null)) {
        emit({ type: 'review-request', scenario: reviewMatch?.[1] ?? scenarioMatch[1], request: sanitizeRequest(body) })
        sendText(response, JSON.stringify({ decision: 'pass', findings: [], unverified: [] }))
        return
      }
      // Child prompts now retain the Team objective and can therefore contain
      // both scenario markers and the parent's historical start tool call.
      // The tool set offered to the current request is the authoritative role
      // boundary: workers never receive yuqi_team_start.
      if (taskMatch !== null && !controllerToolOffered) {
        serveChild({ response, body, match: taskMatch })
        return
      }
      if (scenarioMatch !== null && controllerSurface) {
        serveController({ response, body, scenarioName: scenarioMatch[1] })
        return
      }
      if (taskMatch !== null) {
        serveChild({ response, body, match: taskMatch })
        return
      }

      if (scenarioMatch !== null) {
        serveController({ response, body, scenarioName: scenarioMatch[1] })
        return
      }

      emit({ type: 'unmatched-request', purpose: inferPurpose(body), request: sanitizeRequest(body) })
      sendText(response, 'E2E auxiliary request completed')
    })
  })

  function serveController({ response, body, scenarioName }) {
    const scenario = SCENARIOS[scenarioName]
    if (scenario === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"unknown E2E scenario"}}')
      return
    }
    const alreadyCalled = (body.messages ?? []).some(message => message?.role === 'tool'
      || (message?.role === 'assistant' && Array.isArray(message.tool_calls)))
    if (alreadyCalled) {
      emit({ type: 'controller-after-tool', scenario: scenarioName, request: sanitizeRequest(body) })
      sendText(response, `E2E ${scenarioName} Team is waiting for explicit confirmation.`)
      return
    }
    emit({ type: 'controller-tool-call', scenario: scenarioName, request: sanitizeRequest(body) })
    sendToolCall(response, 'yuqi_team_start', scenarioToolArguments(scenario))
  }

  function serveChild({ response, body, match }) {
    const [, scenario, task, behavior] = match
    const writeKey = `${scenario}:${task}`
    const pendingWrite = pendingWrites.get(writeKey)
    if (behavior === 'write' && pendingWrite !== undefined) {
      pendingWrites.delete(writeKey)
      emit({ type: 'child-write-tool', scenario, task, behavior, requestId: pendingWrite.requestId })
      queueHomepageWrite({ scenario, task, response, finish: pendingWrite.finish })
      return
    }
    const requestId = randomUUID()
    const active = (activeByScenario.get(scenario) ?? 0) + 1
    activeByScenario.set(scenario, active)
    peakByScenario.set(scenario, Math.max(peakByScenario.get(scenario) ?? 0, active))
    let finished = false
    const finish = (outcome = 'completed') => {
      if (finished) return
      finished = true
      activeResponses.delete(response)
      activeByScenario.set(scenario, Math.max(0, (activeByScenario.get(scenario) ?? 1) - 1))
      emit({ type: outcome === 'cancelled' ? 'child-cancelled' : 'child-finish', scenario, task, behavior, requestId, outcome })
    }
    const entry = emit({
      type: 'child-request', scenario, task, behavior, requestId, active,
      request: sanitizeRequest(body),
    })
    activeResponses.add(response)
    response.once('close', () => {
      if (!finished && behavior === 'hang') finish('cancelled')
    })

    if (behavior === 'success') {
      sendText(response, `E2E child ${scenario}/${task} completed.\nYUQI_CHANGED_FILES: []`)
      finish()
      return
    }
    if (behavior === 'empty') {
      sendEmpty(response)
      finish('empty')
      return
    }
    if (behavior === 'fail') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `fixture failure ${scenario}/${task}`, type: 'invalid_request_error' } }))
      finish('failed')
      return
    }
    if (behavior === 'hang') {
      openSse(response)
      response.write(': fixture hang; waits for product cancellation\n\n')
      return
    }
    if (behavior === 'write') {
      pendingWrites.set(writeKey, { requestId, finish })
      const asset = homepageAsset(task)
      sendToolCall(response, 'write', { file_path: asset.path, content: asset.content })
      return
    }
    queueBarrier({ scenario, task, response, requestId, entry, finish })
  }

  function queueHomepageWrite(item) {
    const state = barriers.get(item.scenario) ?? { held: [], opened: false, refilled: false }
    state.held.push(item)
    barriers.set(item.scenario, state)
    openSse(item.response)
    item.response.write(': homepage write barrier\n\n')
    if (state.held.length !== 7 || state.opened) return
    state.opened = true
    emit({ type: 'homepage-write-barrier-open', scenario: item.scenario, count: 7 })
    for (const held of state.held.splice(0)) {
      writeTextEvents(held.response, `E2E homepage child ${held.scenario}/${held.task} completed.\nYUQI_CHANGED_FILES: [${homepageAsset(held.task).path}]`)
      held.response.end()
      held.finish()
    }
  }

  function queueBarrier(held) {
    const state = barriers.get(held.scenario) ?? { held: [], opened: false, refilled: false }
    state.held.push(held)
    barriers.set(held.scenario, state)
    openSse(held.response)
    held.response.write(': fixture barrier\n\n')

    if (held.scenario === 'parallel-7' && state.held.length === 7 && !state.opened) {
      state.opened = true
      emit({ type: 'barrier-open', scenario: held.scenario, count: 7 })
      for (const item of state.held.splice(0)) releaseBarrier(item)
      return
    }

    if (held.scenario === 'rolling-6-of-7' && state.held.length === 6 && !state.opened) {
      state.opened = true
      emit({ type: 'barrier-open', scenario: held.scenario, count: 6 })
      const first = state.held.shift()
      releaseBarrier(first)
      return
    }

    if (held.scenario === 'rolling-6-of-7' && held.task === '7' && state.opened && !state.refilled) {
      state.refilled = true
      emit({ type: 'rolling-refill', scenario: held.scenario, task: held.task })
      for (const item of state.held.splice(0)) releaseBarrier(item)
    }
  }

  function releaseBarrier(item) {
    writeTextEvents(item.response, `E2E barrier child ${item.scenario}/${item.task} completed.\nYUQI_CHANGED_FILES: []`)
    item.response.end()
    item.finish()
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture provider did not bind a TCP port')

  return Object.freeze({
    baseURL: `http://127.0.0.1:${address.port}`,
    events: () => [...records],
    telemetry(scenario) {
      const events = records.filter(event => event.scenario === scenario)
      return {
        peakConcurrency: peakByScenario.get(scenario) ?? 0,
        events,
        requests: events.filter(event => event.type === 'child-request'),
      }
    },
    waitFor(predicate, timeoutMs = 30_000) {
      const existing = records.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error(`fixture event timeout after ${timeoutMs}ms`))
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
    async close() {
      for (const response of activeResponses) response.destroy()
      activeResponses.clear()
      for (const waiter of waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('fixture provider closed'))
      }
      waiters.clear()
      await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    },
  })
}

function sanitizeRequest(body) {
  const tools = Array.isArray(body.tools)
    ? body.tools.map(tool => tool?.function?.name).filter(name => typeof name === 'string')
    : []
  const text = JSON.stringify(body.messages ?? [])
  return Object.freeze({
    model: typeof body.model === 'string' ? body.model : '<unknown>',
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    tools,
    markers: [...text.matchAll(/\[E2E_(?:SCENARIO|TASK|REVIEW):[^\]]+\]/gu)].map(match => match[0]),
  })
}

function inferPurpose(body) {
  if (body.max_tokens === 64) return 'title'
  return 'auxiliary'
}

function openSse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function sendText(response, text) {
  openSse(response)
  writeTextEvents(response, text)
  response.end()
}

function writeTextEvents(response, text) {
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4 } })}\n\n`)
  response.write('data: [DONE]\n\n')
}

function sendEmpty(response) {
  openSse(response)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 0 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function sendToolCall(response, name, args) {
  openSse(response)
  const id = `call_${randomUUID().replaceAll('-', '')}`
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 16, completion_tokens: 8 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

function homepageAsset(task) {
  const assets = {
    '1': {
      path: 'index.html',
      content: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Yuqi · Personal Home</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%239f3d32'/%3E%3C/svg%3E"><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="layout.css"></head><body><main><section class="hero"><img src="profile.svg" alt="Yuqi profile mark"><p class="eyebrow">YUQI_HOMEPAGE_E2E · PRODUCT BUILDER</p><h1>把复杂想法，做成清晰可用的产品。</h1><p id="intro">正在载入个人简介…</p><a href="#work">查看作品</a></section><section id="work"><h2>Selected work</h2><div id="projects"></div></section></main><script type="module" src="app.js"></script></body></html>`,
    },
    '2': { path: 'base.css', content: `/* YUQI_HOMEPAGE_E2E */\n:root{color-scheme:dark;--bg:#101113;--paper:#ece8df;--accent:#9f3d32;--copper:#b77b4f;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--paper)}a{color:inherit}` },
    '3': { path: 'layout.css', content: `/* YUQI_HOMEPAGE_E2E */\nmain{max-width:1100px;margin:auto;padding:clamp(24px,6vw,88px)}.hero{min-height:70vh;display:grid;align-content:center;gap:20px}.hero img{width:96px}.eyebrow{color:var(--copper);letter-spacing:.14em}h1{font-size:clamp(44px,8vw,100px);line-height:.95;max-width:900px;margin:0}#projects{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.card{border:1px solid #ffffff22;padding:24px;background:#ffffff08}@media(max-width:600px){main{padding:24px}h1{font-size:48px}}` },
    '4': { path: 'app.js', content: `// YUQI_HOMEPAGE_E2E\nconst data=await fetch('./content.json').then(r=>r.json());document.querySelector('#intro').textContent=data.intro;document.querySelector('#projects').innerHTML=data.projects.map(p=>\`<article class="card"><h3>\${p.title}</h3><p>\${p.summary}</p></article>\`).join('');` },
    '5': { path: 'profile.svg', content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img"><!-- YUQI_HOMEPAGE_E2E --><circle cx="50" cy="50" r="47" fill="#9f3d32"/><path d="M24 62 50 18l26 44-26 20z" fill="#ece8df"/></svg>` },
    '6': { path: 'content.json', content: `{"marker":"YUQI_HOMEPAGE_E2E","intro":"产品策略、AI 工作流与前端体验。","projects":[{"title":"Agent Team","summary":"让多个代理并行协作并由主控统一汇报。"},{"title":"Design Systems","summary":"把视觉规范转化为稳定的产品界面。"}]}` },
    '7': { path: 'README.md', content: `# Personal homepage fixture\n\nYUQI_HOMEPAGE_E2E\n\nSeven child Agents each own one independent file. Open index.html through a local static server to inspect the result.\n` },
  }
  const asset = assets[task]
  if (asset === undefined) throw new Error(`unknown homepage task ${task}`)
  return asset
}
