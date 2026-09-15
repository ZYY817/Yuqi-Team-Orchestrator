import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const task = (scenario, index, behavior, authorityMode = 'read-only') => ({
  taskId: `${scenario}-${index}`,
  revision: 1,
  goal: `E2E ${scenario} task ${index} [E2E_TASK:${scenario}:${index}:${behavior}]`,
  dependencies: [],
  fileScope: [`e2e/${scenario}/${index}.txt`],
  modelRole: 'worker',
  authorityMode,
})

export const SCENARIOS = Object.freeze({
  'parallel-7': Object.freeze({
    name: 'parallel-7',
    title: 'E2E parallel seven',
    settings: Object.freeze({ maxConcurrency: 7 }),
    tasks: Object.freeze(Array.from({ length: 7 }, (_, index) => task('parallel-7', index + 1, 'barrier'))),
  }),
  'rolling-6-of-7': Object.freeze({
    name: 'rolling-6-of-7',
    title: 'E2E rolling six of seven',
    settings: Object.freeze({ maxConcurrency: 6 }),
    tasks: Object.freeze(Array.from({ length: 7 }, (_, index) => task('rolling-6-of-7', index + 1, 'barrier'))),
  }),
  'failure-matrix': Object.freeze({
    name: 'failure-matrix',
    title: 'E2E failure matrix',
    settings: Object.freeze({ maxConcurrency: 4 }),
    tasks: Object.freeze([
      task('failure-matrix', 1, 'success'),
      task('failure-matrix', 2, 'empty'),
      task('failure-matrix', 3, 'fail'),
      task('failure-matrix', 4, 'hang'),
    ]),
  }),
  'quality-gate-setting': Object.freeze({
    name: 'quality-gate-setting',
    title: 'E2E quality gate setting snapshot',
    settings: Object.freeze({
      maxConcurrency: 1,
      reviewPolicy: Object.freeze({
        mode: 'quality-gate',
        maxReworkRounds: 2,
        additionalPrompt: '[E2E_REVIEW:quality-gate-setting]',
      }),
    }),
    tasks: Object.freeze([task('quality-gate-setting', 1, 'success')]),
  }),
  'homepage-7': Object.freeze({
    name: 'homepage-7',
    title: 'E2E seven-agent personal homepage',
    settings: Object.freeze({ maxConcurrency: 7 }),
    tasks: Object.freeze(Array.from({ length: 7 }, (_, index) => task('homepage-7', index + 1, 'write', 'write-authorized'))),
  }),
  'restart-recovery': Object.freeze({
    name: 'restart-recovery',
    title: 'E2E Host restart recovery',
    default: false,
    settings: Object.freeze({ maxConcurrency: 1 }),
    tasks: Object.freeze([task('restart-recovery', 1, 'hang')]),
  }),
})

export function scenarioPrompt(scenario) {
  return `Use Team mode now for [E2E_SCENARIO:${scenario.name}]. Create the exact fixture task graph and wait for confirmation.`
}

export function scenarioToolArguments(scenario) {
  return {
    title: scenario.title,
    objective: `Exercise the isolated real Host path for ${scenario.name}.`,
    workspaceMode: 'direct',
    tasks: scenario.tasks,
  }
}

export async function runScenario({ page, fixture, scenario, lifecycle, timeoutMs = 90_000 }) {
  await dismissInitialTestingNotice(page)
  await connectWorkspace(page)
  await configureAndConfirmTeamSettings(page, scenario.settings, timeoutMs)
  // Reproduce a slow durable preset commit through the real picker. One click
  // must survive this race; a second click would conceal the admission bug.
  if (scenario.name === 'parallel-7') {
    await page.route('**/api/agentPreset.select', async route => {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      await route.continue()
    })
  }
  await selectYuqiPreset(page)

  const composer = page.getByRole('textbox', { name: 'Describe what you want to build' })
  await composer.fill(scenarioPrompt(scenario))
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await send.click()
  await fixture.waitFor(event => event.type === 'controller-tool-call' && event.scenario === scenario.name, timeoutMs)
  await page.unroute('**/api/agentPreset.select')
  assert.equal(fixture.events().filter(event => event.type === 'controller-tool-call' && event.scenario === scenario.name).length, 1,
    `${scenario.name}: a single send must create exactly one controller request`)
  assert.equal(
    fixture.events().filter(event => event.type === 'child-request' && event.scenario === scenario.name).length,
    0,
    `${scenario.name}: a child request escaped before explicit start confirmation`,
  )

  const start = page.getByRole('button', { name: /^(Start this Team|开始本次)$/u })
  await start.waitFor({ state: 'visible', timeout: timeoutMs })
  assert.equal(
    fixture.events().filter(event => event.type === 'child-request' && event.scenario === scenario.name).length,
    0,
    `${scenario.name}: waiting for the confirmation UI already dispatched a child`,
  )
  await start.click()

  if (scenario.name === 'parallel-7') await verifyParallelSeven({ page, fixture, scenario, timeoutMs })
  else if (scenario.name === 'rolling-6-of-7') await verifyRollingSix({ page, fixture, scenario, timeoutMs })
  else if (scenario.name === 'failure-matrix') await verifyFailureMatrix({ page, fixture, scenario, timeoutMs })
  else if (scenario.name === 'quality-gate-setting') await verifyQualityGateSetting({ page, fixture, scenario, timeoutMs })
  else if (scenario.name === 'homepage-7') await verifyHomepageSeven({ page, fixture, scenario, timeoutMs })
  else await verifyRestartRecovery({ page, fixture, scenario, lifecycle, timeoutMs })

  await verifyRefreshRecovery(page, scenario, timeoutMs)
}

async function dismissInitialTestingNotice(page) {
  const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
  if (!await continueButton.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) return
  await continueButton.click()
  await continueButton.waitFor({ state: 'hidden', timeout: 10_000 })
}

async function configureAndConfirmTeamSettings(page, settings, timeoutMs) {
  await openTeamSettings(page, timeoutMs)
  await fillTeamSettings(page, settings)
  const dialog = await settingsDialog(page)
  const save = dialog.getByRole('button', { name: /Save|保存/, exact: true })
  await save.waitFor({ state: 'visible', timeout: timeoutMs })
  await assertEnabled(save, timeoutMs, 'Team settings Save button did not become enabled')
  await save.click()
  // Embedded settings remain mounted in Team management after a successful
  // Host write. Wait for the component's persisted-success acknowledgement,
  // then close the management surface explicitly before reopening it.
  await dialog.getByText(/Saved\. Applies to new Teams\.|已保存，对新建团队生效。|已保存，仅影响之后启动的 Team。/).waitFor({ state: 'visible', timeout: timeoutMs })
  const centerAfterSave = page.getByRole('dialog', { name: /Team management|Team 管理中心/ }).first()
  await centerAfterSave.getByRole('button', { name: /Close|关闭/u, exact: true }).first().click()
  await centerAfterSave.waitFor({ state: 'hidden', timeout: timeoutMs })

  // Re-read through the same public UI. Reopening proves that a new consumer
  // sees the persisted values before the controller request exists.
  await openTeamSettings(page, timeoutMs)
  const confirmed = await settingsDialog(page)
  await assertInputValue(confirmed.getByRole('spinbutton', { name: /Concurrency safety ceiling|并发保护上限/ }), String(settings.maxConcurrency))
  if (settings.reviewPolicy !== undefined) {
    await assertChecked(confirmed.getByRole('radio', { name: /Quality gate|Automatic key-checkpoint review|关键节点自动审查|自动审查/ }))
    await assertInputValue(confirmed.getByRole('spinbutton', { name: /Maximum automatic rework rounds|最多自动返工轮数|最多返工次数/ }), String(settings.reviewPolicy.maxReworkRounds))
    await assertInputValue(confirmed.getByRole('textbox', { name: /Additional reviewer prompt|Reviewer 补充要求|希望审查代理重点检查什么/ }), settings.reviewPolicy.additionalPrompt)
  }
  const closeSettings = confirmed.getByRole('button', { name: /Close Team settings|关闭团队设置/, exact: true }).first()
  if (await closeSettings.isVisible().catch(() => false)) await closeSettings.click()
  const center = page.getByRole('dialog', { name: /Team management|Team 管理中心/ }).first()
  if (await center.isVisible().catch(() => false)) {
    await center.getByRole('button', { name: /Close|关闭/u, exact: true }).first().click()
    await center.waitFor({ state: 'hidden', timeout: timeoutMs })
  } else {
    await confirmed.waitFor({ state: 'hidden', timeout: timeoutMs })
  }
}

async function openTeamSettings(page, timeoutMs) {
  const management = page.getByRole('button', { name: /Open Team management|打开 Team 管理中心/ }).first()
  await management.waitFor({ state: 'visible', timeout: timeoutMs })
  await management.click()
  const center = page.getByRole('dialog', { name: /Team management|Team 管理中心/ })
  await center.waitFor({ state: 'visible', timeout: timeoutMs })
  await center.getByRole('button', { name: /Team defaults|团队默认设置/, exact: true }).click()
  await page.locator('[data-yuqi-team-settings-dialog="true"]').or(center).first().waitFor({ state: 'visible', timeout: timeoutMs })
}

async function settingsDialog(page) {
  const embedded = page.locator('[data-yuqi-team-settings-dialog="true"]')
  if (await embedded.count() > 0 && await embedded.first().isVisible().catch(() => false)) return embedded.first()
  return page.getByRole('dialog', { name: /Team management|Team 管理中心/ }).first()
}

async function fillTeamSettings(page, settings) {
  const dialog = await settingsDialog(page)
  const concurrency = dialog.getByRole('spinbutton', { name: /Concurrency safety ceiling|并发保护上限/ })
  try {
    await assertEnabled(concurrency, 10_000, 'Team settings concurrency input did not become writable')
  } catch (error) {
    const alerts = await dialog.getByRole('alert').allTextContents()
    const statuses = await dialog.getByRole('status').allTextContents()
    const settingsDescribe = await page.evaluate(async () => {
      const rpcId = crypto.randomUUID()
      const response = await fetch('/api/settings.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'settings.describe', payload: {} }),
      })
      return { status: response.status, body: await response.text() }
    }).catch(fetchError => ({ status: -1, body: String(fetchError) }))
    throw new Error(`${error instanceof Error ? error.message : String(error)}; alerts=${JSON.stringify(alerts)}; statuses=${JSON.stringify(statuses)}; settings.describe=${JSON.stringify(settingsDescribe)}`)
  }
  await concurrency.fill(String(settings.maxConcurrency))
  if (settings.reviewPolicy === undefined) return
  await dialog.getByRole('radio', { name: /Quality gate|Automatic key-checkpoint review|关键节点自动审查|自动审查/ }).check()
  await dialog.getByRole('spinbutton', { name: /Maximum automatic rework rounds|最多自动返工轮数|最多返工次数/ })
    .fill(String(settings.reviewPolicy.maxReworkRounds))
  await dialog.getByRole('textbox', { name: /Additional reviewer prompt|Reviewer 补充要求|希望审查代理重点检查什么/ })
    .fill(settings.reviewPolicy.additionalPrompt)
}

async function connectWorkspace(page) {
  const workspaceTrigger = page.getByRole('textbox', { name: 'Choose workspace' })
  await workspaceTrigger.waitFor({ state: 'visible', timeout: 30_000 })
  await workspaceTrigger.click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(process.env.DSH_E2E_PROJECT_DIR)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await page.getByRole('textbox', { name: 'Describe what you want to build' })
    .waitFor({ state: 'visible', timeout: 15_000 })
}

async function selectYuqiPreset(page) {
  const presetButton = page.getByRole('button', { name: /mode$|主控$/ }).first()
  await presetButton.waitFor({ state: 'visible', timeout: 15_000 })
  await presetButton.click()
  const option = page.getByRole('menuitem', { name: /Yuqi 团队负责人/ }).first()
  await option.waitFor({ state: 'visible', timeout: 10_000 })
  await option.click()
  await page.getByRole('button', { name: 'Yuqi 团队负责人', exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 })
}

async function verifyParallelSeven({ page, fixture, scenario, timeoutMs }) {
  await fixture.waitFor(event => event.type === 'barrier-open' && event.scenario === scenario.name, timeoutMs)
  const telemetry = fixture.telemetry(scenario.name)
  assert.equal(telemetry.peakConcurrency, 7, 'parallel-7 must reach seven concurrent child requests')
  const starts = telemetry.events.filter(event => event.type === 'child-request')
  const firstFinish = telemetry.events.findIndex(event => event.type === 'child-finish')
  assert.equal(starts.length, 7)
  assert.ok(firstFinish >= 7, 'all seven children must start before the first barrier completion')
  await waitForTaskState(page, scenario.tasks[0].goal, /Completed|已完成/u, timeoutMs)
}

async function verifyRollingSix({ page, fixture, scenario, timeoutMs }) {
  await fixture.waitFor(event => event.type === 'rolling-refill' && event.scenario === scenario.name, timeoutMs)
  const telemetry = fixture.telemetry(scenario.name)
  assert.equal(telemetry.peakConcurrency, 6, 'rolling-6-of-7 must never exceed six concurrent requests')
  const starts = telemetry.events.filter(event => event.type === 'child-request')
  assert.equal(starts.length, 7)
  const firstFinishIndex = telemetry.events.findIndex(event => event.type === 'child-finish')
  const seventhStartIndex = telemetry.events.findIndex(event => event.type === 'child-request' && event.task === '7')
  assert.ok(firstFinishIndex >= 6, 'the initial six children must occupy every slot')
  assert.ok(seventhStartIndex > firstFinishIndex, 'the seventh child must refill only after a slot completes')
  await waitForTaskState(page, scenario.tasks[6].goal, /Completed|已完成/u, timeoutMs)
}

async function verifyFailureMatrix({ page, fixture, scenario, timeoutMs }) {
  await fixture.waitFor(event => event.type === 'child-request' && event.scenario === scenario.name && event.task === '4', timeoutMs)
  await waitForTaskState(page, scenario.tasks[0].goal, /Completed|已完成/u, timeoutMs)
  await waitForTaskState(page, scenario.tasks[1].goal, /Failed|Result unverified|失败|结果未验证/u, timeoutMs)
  await waitForTaskState(page, scenario.tasks[2].goal, /Failed|Result unverified|失败|结果未验证/u, timeoutMs)

  const emptyRequest = fixture.telemetry(scenario.name).requests.find(request => request.task === '2')
  assert.equal(emptyRequest?.behavior, 'empty')
  const emptyRow = await taskRowText(page, scenario.tasks[1].goal)
  assert.doesNotMatch(emptyRow, /Completed|已完成/u, 'a content-less provider completion must not be presented as successful')
  assert.match(await taskRowText(page, scenario.tasks[2].goal), /Failed|Result unverified|失败|结果未验证/u, 'provider failure must remain visible')

  const artifactsDir = process.env.DSH_E2E_SCENARIO_ARTIFACTS

  // 1. Test "团队管理主动发送消息" while task 4 is actively running:
  const messageInput = page.getByRole('textbox', { name: /Team instruction content|补充团队要求内容/u })
  if (await messageInput.isVisible().catch(() => false)) {
    await messageInput.fill('E2E 实时补充要求：请在执行中注意安全边界')
    const sendBtn = page.getByRole('button', { name: /Send instruction|发送补充要求/u })
    await sendBtn.waitFor({ state: 'visible', timeout: timeoutMs })
    await sendBtn.click()
    const notice = page.getByText(/The instruction was forwarded|补充要求已转发/u)
    await notice.waitFor({ state: 'visible', timeout: timeoutMs })
    await page.waitForTimeout(1500)
    if (artifactsDir !== undefined) {
      await page.screenshot({ path: join(artifactsDir, '00-active-message-sent.png') })
    }
  }

  // 2. Test "发送消息之后的中断": stop running task 4 and confirm
  const stop = page.getByRole('button', { name: new RegExp(`^(?:Stop child Agent: |停止子代理：)${escapeRegExp(scenario.tasks[3].goal)}$`, 'u') })
  await stop.waitFor({ state: 'visible', timeout: timeoutMs })
  await stop.click()
  const confirmation = page.getByRole('alertdialog', { name: new RegExp(`^(?:Confirm stopping child Agent: |确认停止子代理：)${escapeRegExp(scenario.tasks[3].goal)}$`, 'u') })
  await confirmation.getByRole('button', { name: /^(Confirm stop|确认停止)$/u }).click()
  await fixture.waitFor(event => event.type === 'child-cancelled' && event.scenario === scenario.name && event.task === '4', timeoutMs)
  await waitForTaskState(page, scenario.tasks[3].goal, /Cancelled|已取消/u, timeoutMs)
  if (artifactsDir !== undefined) {
    await page.screenshot({ path: join(artifactsDir, '00-active-task-interrupted.png') })
  }

  await verifyInteractiveControls(page, timeoutMs)
}

async function verifyInteractiveControls(page, timeoutMs) {
  const artifactsDir = process.env.DSH_E2E_SCENARIO_ARTIFACTS

  // 0. Close task panel if open so backdrop doesn't intercept clicks
  const closePanelBtn = page.getByRole('button', { name: /Close Team panel|关闭团队面板/u }).first()
  if (await closePanelBtn.isVisible().catch(() => false)) {
    await closePanelBtn.click()
    await page.waitForTimeout(300)
  }

  // 1. Open TeamCenter drawer via bottom-left trigger
  const teamCenterBtn = page.getByRole('button', { name: /Team management|打开 Team 管理中心|团队管理/u }).first()
  await teamCenterBtn.waitFor({ state: 'visible', timeout: timeoutMs })
  await teamCenterBtn.click()

  const center = page.getByRole('dialog', { name: /Team management|Team 管理中心/u })
  await center.waitFor({ state: 'visible', timeout: timeoutMs })
  if (artifactsDir !== undefined) {
    await page.screenshot({ path: join(artifactsDir, '01-team-center-chinese.png') })
  }

  // 2. Language Switch: Toggle to English and verify text updates
  const enBtn = center.getByRole('button', { name: 'English' })
  await enBtn.click()
  await page.waitForTimeout(300)
  assert.match(await center.textContent(), /Global settings|Decisions needed|Team defaults/u, 'Language switch to English failed')
  if (artifactsDir !== undefined) {
    await page.screenshot({ path: join(artifactsDir, '02-team-center-english.png') })
  }

  // Toggle back to Chinese
  const zhBtn = center.getByRole('button', { name: '中文' })
  await zhBtn.click()
  await page.waitForTimeout(300)
  assert.match(await center.textContent(), /全局设置|需要你决定的事项|团队默认设置/u, 'Language switch back to Chinese failed')

  // 3. Mark as read on attention decisions if present
  const markReadBtn = center.getByRole('button', { name: /标为已读|Mark as read/u }).first()
  if (await markReadBtn.isVisible().catch(() => false)) {
    await markReadBtn.click()
    await page.waitForTimeout(400)

    // Verify it moved to read decisions details
    const readDetails = center.getByText(/已标为已读的决定|Read decisions/u).first()
    await readDetails.waitFor({ state: 'visible', timeout: timeoutMs })
    if (artifactsDir !== undefined) {
      await page.screenshot({ path: join(artifactsDir, '03-team-center-marked-read.png') })
    }

    // Restore it back to active pending
    const unreadBtn = center.getByRole('button', { name: /重新标为待处理|Mark as pending/u }).first()
    if (await unreadBtn.isVisible().catch(() => false)) {
      await unreadBtn.click()
      await page.waitForTimeout(400)
    }
  }

  // 4. Close TeamCenter
  const closeBtn = center.getByRole('button', { name: /Close|关闭/u, exact: true }).first()
  await closeBtn.click()
  await center.waitFor({ state: 'hidden', timeout: timeoutMs })

  // 5. Test Header SessionNavigator
  const navigatorTrigger = page.getByRole('button', { name: /子代理会话|child Agent conversation/u }).first()
  if (await navigatorTrigger.isVisible().catch(() => false)) {
    await navigatorTrigger.click()
    const navDialog = page.locator('#yuqi-session-navigation-dialog')
    await navDialog.waitFor({ state: 'visible', timeout: timeoutMs })
    if (artifactsDir !== undefined) {
      await page.screenshot({ path: join(artifactsDir, '04-session-navigator.png') })
    }

    // Find and click the first child row open button (index 0 is main controller, index 1 is first child)
    const openChildBtn = navDialog.locator('.yuqi-session-open').nth(1)
    if (await openChildBtn.isVisible().catch(() => false)) {
      await openChildBtn.click()
      await page.waitForTimeout(1000)

      // In child session, check return button
      const returnBtn = page.getByRole('button', { name: /返回 Team 主对话|Back to Team controller/u }).first()
      if (await returnBtn.isVisible().catch(() => false)) {
        if (artifactsDir !== undefined) {
          await page.screenshot({ path: join(artifactsDir, '05-child-subagent-session.png') })
        }
        await returnBtn.click()
        await page.waitForTimeout(1000)
        if (artifactsDir !== undefined) {
          await page.screenshot({ path: join(artifactsDir, '06-returned-to-controller.png') })
        }
      }
    }
  }
}

async function verifyQualityGateSetting({ page, fixture, scenario, timeoutMs }) {
  await fixture.waitFor(event => event.type === 'review-request' && event.scenario === scenario.name, timeoutMs)
  await waitForTaskState(page, scenario.tasks[0].goal, /Completed|已完成/u, timeoutMs)
  const gate = page.getByRole('region', { name: /Quality gate control|质量门主控/ })
  await gate.waitFor({ state: 'visible', timeout: timeoutMs })
  await poll(
    async () => /Durable checkpoint state for this Team|此 Team 的持久化审查节点状态/u.test(await gate.textContent() ?? ''),
    timeoutMs,
    'quality-gate-setting: the new Team snapshot did not retain the quality-gate policy',
  )
  await poll(
    async () => /Pass|通过/u.test(await gate.textContent() ?? ''),
    timeoutMs,
    'quality-gate-setting: fixture reviewer pass was not projected into the Team snapshot',
  )
}

async function verifyHomepageSeven({ page, fixture, scenario, timeoutMs }) {
  await fixture.waitFor(event => event.type === 'homepage-write-barrier-open' && event.scenario === scenario.name, timeoutMs)
  const telemetry = fixture.telemetry(scenario.name)
  assert.equal(telemetry.peakConcurrency, 7, 'homepage-7 must hold seven child Agents concurrently')
  assert.equal(telemetry.events.filter(event => event.type === 'child-write-tool').length, 7, 'each child must invoke one real write tool')
  await waitForTaskState(page, scenario.tasks[6].goal, /Completed|已完成/u, timeoutMs)

  const expected = ['index.html', 'base.css', 'layout.css', 'app.js', 'profile.svg', 'content.json', 'README.md']
  for (const file of expected) {
    const content = await readFile(join(process.env.DSH_E2E_PROJECT_DIR, file), 'utf8')
    assert.match(content, /YUQI_HOMEPAGE_E2E/u, `${file} was not written by the fixture child Agent`)
  }
}

async function verifyRestartRecovery({ page, fixture, scenario, lifecycle, timeoutMs }) {
  assert.equal(typeof lifecycle?.restartHost, 'function', 'restart-recovery requires a Host lifecycle hook')
  await fixture.waitFor(event => event.type === 'child-request' && event.scenario === scenario.name, timeoutMs)
  await waitForTaskState(page, scenario.tasks[0].goal, /Running|运行中/u, timeoutMs)
  // Child admission happens only after the controller journal and parent
  // projection bridge have been durably committed. Waiting on the real child
  // request is therefore the persistence barrier; a fixed delay is not.
  await lifecycle.restartHost()
  await page.reload({ waitUntil: 'load', timeout: timeoutMs })
  await page.getByRole('tree', { name: 'Sessions' }).waitFor({ state: 'visible', timeout: timeoutMs })
  lifecycle.finishRestart?.()

  const pageText = await page.locator('body').innerText()
  assert.doesNotMatch(pageText, /Failed to load history|unknown to this harness|not marked ignorable/u,
    'Host cold load rejected a Yuqi Session event before plugin recovery could run')

  const recovery = page.getByText(/Safety check needed|待安全核对/u).first()
  const paused = page.getByText(/Paused|已暂停/u).first()
  await Promise.race([
    recovery.waitFor({ state: 'visible', timeout: timeoutMs }),
    paused.waitFor({ state: 'visible', timeout: timeoutMs }),
  ])

  const check = page.getByRole('button', { name: /Check recovery state|检查恢复状态|Recover and continue|恢复并继续/u }).first()
  if (await check.isVisible().catch(() => false)) {
    const panelButton = page.getByRole('button', { name: /Open Yuqi Team task panel|打开 Yuqi Team 任务面板/u }).first()
    if (await panelButton.isVisible().catch(() => false)) await panelButton.click()
    await check.waitFor({ state: 'visible', timeout: timeoutMs })
    await check.click()
    await page.getByText(/Recovery check submitted|恢复检查已提交|Paused|已暂停|Safety check needed|待安全核对/u).first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
  }

  const settledPageText = await page.locator('body').innerText()
  assert.doesNotMatch(settledPageText, /运行中\s*0\/1\s*已完成\s*1\s*正在处理/u,
    'restart recovery left the public Team summary on the stale running projection')
  const recoveryReports = settledPageText.match(/E2E Host restart recovery[：:]\s*(?:needs_reconciliation|Safety check needed|待安全核对)/gu) ?? []
  assert.ok(recoveryReports.length <= 1, 'restart recovery must expose at most one controller action item')

  const childRequests = fixture.events().filter(event => event.type === 'child-request' && event.scenario === scenario.name)
  assert.equal(childRequests.length, 1, 'cold recovery must not blindly dispatch a duplicate child')
}

async function verifyRefreshRecovery(page, scenario, timeoutMs) {
  await page.reload({ waitUntil: 'load' })
  const panelButton = page.getByRole('button', { name: /Open Yuqi Team task panel|打开 Yuqi Team 任务面板/u })
  if (await panelButton.count() > 0) {
    await panelButton.click()
    const panel = page.getByRole('dialog', { name: /Yuqi Team task panel|Yuqi Team 任务面板/u })
    await panel.waitFor({ state: 'visible', timeout: timeoutMs })
    await panel.getByText(scenario.title, { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
    await panel.getByText(scenario.tasks[0].goal, { exact: true }).waitFor({ state: 'visible', timeout: timeoutMs })
    return
  }

  // Terminal controllers can be archived automatically. The product-owned
  // management center is the refresh recovery surface for those Teams.
  const management = page.getByRole('button', { name: /Open Team management|打开 Team 管理中心/u })
  await management.waitFor({ state: 'visible', timeout: timeoutMs })
  await management.click()
  const center = page.getByRole('dialog', { name: /Team management|Team 管理中心/u })
  await center.waitFor({ state: 'visible', timeout: timeoutMs })
  await center.getByText(scenario.title, { exact: true }).waitFor({ state: 'attached', timeout: timeoutMs })
}

async function waitForTaskState(page, goal, state, timeoutMs) {
  await poll(async () => state.test(await taskRowText(page, goal)), timeoutMs, `${goal} did not reach ${state}`)
}

async function taskRowText(page, goal) {
  let taskButton = page.getByRole('button', { name: new RegExp(escapeRegExp(goal)) }).first()
  if (await taskButton.count() === 0 || !await taskButton.isVisible().catch(() => false)) {
    const view = page.getByRole('button', { name: /Open Yuqi Team task panel|打开 Yuqi Team 任务面板/u }).first()
    await view.waitFor({ state: 'visible', timeout: 15_000 })
    await view.click()
    await page.getByRole('dialog', { name: /Yuqi Team task panel|Yuqi Team 任务面板/u })
      .waitFor({ state: 'visible', timeout: 15_000 })
    taskButton = page.getByRole('button', { name: new RegExp(escapeRegExp(goal)) }).first()
  }
  await taskButton.waitFor({ state: 'visible', timeout: 15_000 })
  return taskButton.textContent()
}

async function poll(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(message)
}

async function assertEnabled(locator, timeoutMs, message) {
  await poll(() => locator.isEnabled(), timeoutMs, message)
}

async function assertInputValue(locator, expected) {
  assert.equal(await locator.inputValue(), expected)
}

async function assertChecked(locator) {
  assert.equal(await locator.isChecked(), true)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
