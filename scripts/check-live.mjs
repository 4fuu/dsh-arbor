/**
 * Check that switching the arbor bundle off and on in a running web client
 * leaves DSH's own UI standing.
 *
 * The bundle's client packages occupy and shadow DSH's seats. Toggling a
 * plugin in the running client disposes its fiber, and a seat registration that
 * was made through a bound context can take DSH's own registrations down with
 * it. That is not visible to a type check or to a fresh page load — the
 * published 2026.1110.1 lost the whole sidebar that way, with nothing in the
 * console. So this check drives the real page: open Plugins, switch Arbor off,
 * assert the sidebar and the current page still render, switch it back on, and
 * assert the same. It also visits the composer after the switch, because that is
 * where the shadowed agent-preset and permission seats render.
 *
 * Run: pnpm check:live
 *
 * Environment:
 *   ARBOR_CHECK_LIVE_WORK    keep the install, profile and screenshots here
 *   ARBOR_CHECK_SCREENSHOTS  write screenshots here (default: <work>/screenshots)
 *   ARBOR_CHROME             Chrome or Chromium executable (default: probe PATH,
 *                            then the agent-browser cache)
 *
 * The check needs a Chrome that speaks the DevTools protocol, as CI's
 * ubuntu-latest image has.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  createProfile,
  installDsh,
  packRelease,
  removeTree,
  startWeb,
  stopWeb,
  unmountUnder,
  workspace,
} from './profile-fixture.mjs'

// A key the machine exports is a key arbor reads — the settings page would
// rightly report it as set, and this check could not tell its own writes from
// it. The check starts from a home and an environment with no judge key.
delete process.env.JEV_API_KEY

const work = await workspace('ARBOR_CHECK_LIVE_WORK', 'dsh-arbor-live-')
const screenshots = process.env.ARBOR_CHECK_SCREENSHOTS ?? join(work, 'screenshots')

const passed = []
function pass(message) {
  passed.push(message)
  console.log(`PASS ${message}`)
}
function fail(message) {
  throw new Error(message)
}
function assert(label, condition, detail) {
  if (!condition) fail(`${label}: ${detail}`)
  pass(label)
}

/** The Chrome this machine can run, or a clear failure. */
function chromePath() {
  const named = process.env.ARBOR_CHROME ?? process.env.CHROME_PATH
  if (named !== undefined && named !== '' && existsSync(named)) return named
  for (const path of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(path)) return path
  }
  const cache = join(homedir(), '.agent-browser', 'browsers')
  if (existsSync(cache)) {
    const versions = readdirSync(cache)
      .filter(name => name.startsWith('chrome-'))
      .sort((left, right) => Number(right.split('-')[1]?.split('.')[0] ?? 0) - Number(left.split('-')[1]?.split('.')[0] ?? 0))
    for (const version of versions) {
      const path = join(cache, version, 'chrome')
      if (existsSync(path)) return path
    }
  }
  throw new Error('no Chrome or Chromium found; set ARBOR_CHROME to an executable')
}

/**
 * One page in headless Chrome, driven over the DevTools protocol.
 *
 * The protocol is used directly instead of a browser package so the check adds
 * no dependency: Node's own `WebSocket` and `fetch` are enough for a page click,
 * a screenshot and a console log.
 */
class Page {
  /** @param {WebSocket} socket @param {import('node:child_process').ChildProcess} chrome @param {string} stderr */
  constructor(socket, chrome, stderr) {
    this.socket = socket
    this.chrome = chrome
    this.stderr = stderr
    this.nextId = 0
    this.pending = new Map()
    this.messages = []
    this.closed = false
    socket.onmessage = event => this.receive(JSON.parse(event.data))
  }

  static async open(url) {
    const profile = join(tmpdir(), `dsh-arbor-live-chrome-${process.pid}-${Date.now()}`)
    const chrome = spawn(chromePath(), [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    chrome.stderr.on('data', chunk => (stderr += chunk))
    const portFile = join(profile, 'DevToolsActivePort')
    for (let attempt = 0; !existsSync(portFile) && attempt < 200; attempt++) {
      if (chrome.exitCode !== null) throw new Error(`Chrome exited with ${chrome.exitCode}\n${stderr.split('\n').slice(-8).join('\n')}`)
      await sleep(100)
    }
    if (!existsSync(portFile)) throw new Error(`Chrome did not open a DevTools port\n${stderr.split('\n').slice(-8).join('\n')}`)
    const port = readFileSync(portFile, 'utf8').split('\n')[0]
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    const page = new Page(socket, chrome, stderr)
    page.profile = profile
    await page.send('Runtime.enable')
    await page.send('Log.enable')
    await page.send('Page.enable')
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
    await page.send('Page.navigate', { url })
    await page.waitFor('the web client to boot', "document.readyState === 'complete' && !!document.querySelector('[data-slot=root]')", 60_000)
    return page
  }

  receive(frame) {
    if (frame.id !== undefined) {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) pending.reject(new Error(JSON.stringify(frame.error)))
      else pending.resolve(frame.result)
      return
    }
    const at = Date.now()
    if (frame.method === 'Runtime.consoleAPICalled') {
      this.messages.push({
        at,
        kind: `console.${frame.params.type}`,
        text: frame.params.args.map(argument => argument.value ?? argument.description ?? argument.type).join(' '),
        stack: frame.params.stackTrace?.callFrames?.slice(0, 8).map(call => `${call.functionName}@${call.url}:${call.lineNumber}`).join('\n') ?? '',
      })
    } else if (frame.method === 'Runtime.exceptionThrown') {
      const details = frame.params.exceptionDetails
      this.messages.push({
        at,
        kind: 'exception',
        text: details.exception?.description ?? details.text,
        stack: details.stackTrace?.callFrames?.slice(0, 10).map(call => `${call.functionName}@${call.url}:${call.lineNumber}`).join('\n') ?? '',
      })
    } else if (frame.method === 'Log.entryAdded') {
      this.messages.push({ at, kind: `log.${frame.params.entry.level}`, text: `${frame.params.entry.source}: ${frame.params.entry.text}`, stack: '' })
    }
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }

  async waitFor(description, expression, timeout = 30_000, { dump = true } = {}) {
    const deadline = Date.now() + timeout
    let last
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return
      } catch (error) {
        last = error
      }
      await sleep(200)
    }
    if (dump) await this.dumpFailure(description)
    throw new Error(`timed out waiting for ${description}${last === undefined ? '' : ` (${last instanceof Error ? last.message : String(last)})`}`)
  }

  /** What the page showed when a wait timed out: a screenshot, the switches, the text and the page messages. */
  async dumpFailure(description) {
    try {
      const path = await this.screenshot(`failure-${description.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`)
      console.error(`failure screenshot: ${path}`)
      console.error(`url: ${await this.evaluate('location.href')}`)
      console.error(`switches: ${await this.evaluate(`JSON.stringify([...document.querySelectorAll('[role="switch"]')].map(node => node.getAttribute('aria-label')))`)}`)
      console.error(`page text:\n${(await this.evaluate('document.body.innerText')).slice(0, 3000)}`)
    } catch (error) {
      console.error(`failure dump failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const message of this.messages.slice(-20)) console.error(`page ${message.kind}: ${message.text}`)
  }

  /** The current UI facts this check asserts on. */
  async state() {
    return JSON.parse(await this.evaluate(`JSON.stringify({
      nav: !!document.querySelector('nav[aria-label="Global panels"]'),
      sidebar: (document.querySelector('[data-slot="sidebar"]')?.childElementCount ?? 0) > 0,
      sessionTree: !!document.querySelector('[role="tree"]'),
      main: (document.querySelector('[data-slot="main"]')?.childElementCount ?? 0) > 0,
      pluginsPage: document.body.innerText.includes('Installed plugins'),
      arborNav: !!document.querySelector('[data-arbor-icon]'),
      switchChecked: document.querySelector('button[role="switch"][aria-label*="Arbor"]')?.getAttribute('aria-checked') ?? null,
      restartNotice: !!document.querySelector('[data-arbor-enable-notice]'),
    })`))
  }

  /**
   * Click the element an expression finds with a real mouse press at its
   * center, so an overlay that covers it fails the check instead of being
   * bypassed by `element.click()`.
   */
  async click(description, expression) {
    const point = await this.evaluate(`(() => {
      const element = ${expression}
      if (element === undefined || element === null) return null
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        label: element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 60),
      }
    })()`)
    if (point === null) throw new Error(`could not find ${description}`)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return point.label
  }

  /**
   * Type into the field an expression finds, at a real focus and as the
   * browser's own input event, so the component's change handler runs the way
   * a person's typing would make it run.
   */
  async fill(description, expression, text) {
    await this.click(description, expression)
    await this.send('Input.insertText', { text })
  }

  /** What the settings page shows right now. */
  async settingsState() {
    return JSON.parse(await this.evaluate(`JSON.stringify({
      open: !!document.querySelector('[data-arbor-settings]'),
      sections: [...document.querySelectorAll('.arbor-settings-nav button')].map(button => button.textContent.trim()),
      active: document.querySelector('.arbor-settings-pane h2')?.textContent.trim() ?? null,
      selects: document.querySelectorAll('.arbor-settings-pane select').length,
      numbers: document.querySelectorAll('.arbor-settings-pane input[type=number]').length,
      facts: document.querySelectorAll('.arbor-settings-pane .arbor-setting-row').length,
      keys: [...document.querySelectorAll('.arbor-key')].map(row => ({
        name: row.querySelector('.arbor-key-name')?.textContent.trim() ?? null,
        state: row.querySelector('.arbor-key-state')?.textContent.trim() ?? null,
      })),
      passwordFields: document.querySelectorAll('.arbor-key input[type=password]').length,
      passwordValue: document.querySelector('.arbor-key input[type=password]')?.value ?? null,
      text: document.body.innerText,
    })`))
  }

  /**
   * Dismiss DSH's own first-run dialogs (the preview notice, then the optional
   * API-key onboarding) until none is standing, so the page the check drives
   * is the one a returning user sees. A dialog that will not close fails the
   * check instead of leaving it over every screenshot.
   */
  async dismissNotices() {
    const open = `document.body.innerText.includes('Preview Notice') ||
      document.body.innerText.includes('预览版说明') ||
      document.body.innerText.includes('Add an API key to get started') ||
      document.body.innerText.includes('添加 API 密钥以开始')`
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!(await this.evaluate(open))) {
        // The welcome step loads asynchronously; give a late dialog a moment to
        // appear before declaring the page clear.
        await sleep(1_000)
        if (!(await this.evaluate(open))) return
      }
      const clicked = await this.click('the first-run dialog button', `(() => {
        const labels = ['Continue', '继续', 'Configure later', '稍后配置']
        return [...document.querySelectorAll('button')].find(button => labels.includes(button.textContent.trim()))
      })()`).catch(() => null)
      if (clicked === null) throw new Error('a first-run dialog is open with no button that closes it')
      await sleep(700)
    }
    if (await this.evaluate(open)) throw new Error('first-run dialogs did not close')
  }

  /** Every crash a page is not allowed to survive. */
  crashesSince(index) {
    return this.messages.slice(index).filter(message => (
      message.kind === 'exception' ||
      /slot entry crashed|Uncaught|Minified React error|The above error occurred/.test(message.text)
    ))
  }

  assertNoCrash(index, phase) {
    const crashes = this.crashesSince(index)
    if (crashes.length > 0) {
      fail(`${phase} crashed the page:\n${crashes.map(message => `[${message.kind}] ${message.text}${message.stack === '' ? '' : `\n${message.stack}`}`).join('\n\n')}`)
    }
    pass(`${phase} raised no uncaught error and no slot-entry crash`)
  }

  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    const path = join(screenshots, name)
    await writeFile(path, Buffer.from(result.data, 'base64'))
    return path
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.socket.close() } catch { /* the page may already be gone */ }
    this.chrome.kill('SIGKILL')
    try { rmSync(this.profile, { recursive: true, force: true }) } catch { /* Chrome may still hold a file */ }
  }
}

/** The switch that enables or disables the bundle, by its accessible label. */
const ARBOR_SWITCH = `document.querySelector('button[role="switch"][aria-label*="Arbor"]')`

/** The Plugins entry in the global navigation. */
const PLUGINS_ENTRY = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Plugins' || button.getAttribute('aria-label') === 'Plugins')`

/**
 * Click a navigation entry until what it opens appears. On a CI runner a click
 * shortly after boot reaches the entry but does not navigate, so the click is
 * repeated a few times before the wait counts as failed.
 */
async function clickUntil(page, entryDescription, entry, description, ready) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.click(entryDescription, entry)
    try {
      await page.waitFor(description, ready, 10_000, { dump: attempt === 3 })
      return
    } catch (error) {
      if (attempt === 3) throw error
      console.log(`${entryDescription} did not open ${description} on click ${attempt}; clicking again`)
    }
  }
}

/** Open the Plugins page and wait for the Arbor switch. */
function openPlugins(page, description) {
  return clickUntil(page, 'the Plugins entry', PLUGINS_ENTRY, description, `!!${ARBOR_SWITCH}`)
}

/** The Arbor entry in the global navigation, once the bundle is on. */
const ARBOR_ENTRY = `document.querySelector('[data-arbor-icon]')?.closest('button')`

/** The Settings tab of the arbor page. */
const SETTINGS_TAB = `document.querySelector('[data-arbor-settings-tab]')`

/** One section of the settings page's rail, by its label. */
const sectionButton = name => `[...document.querySelectorAll('.arbor-settings-nav button')].find(button => button.textContent.trim() === ${JSON.stringify(name)})`

/** The settings section this check expects, in the order the rail lists them. */
const SECTIONS = ['Judge', 'Windows', 'Notes', 'Workspace', 'API keys', 'Facts']

/** The dummy key the check stores: never a real credential. */
const DUMMY_KEY = 'dsh-arbor-live-dummy-key-0123456789'

try {
  await mkdir(screenshots, { recursive: true })
  console.log(`work directory: ${work}`)
  console.log(`screenshots: ${screenshots}`)
  const { packages, version, bundle } = await packRelease(work)
  pass(`packed ${packages.length} tarballs at ${version}`)
  const install = await installDsh(work)
  pass(`DSH is installed at ${install}`)
  const { home } = await createProfile(work, install, packages, bundle)
  pass(`the web profile composes the packed bundle at ${version}`)

  const server = await startWeb({ work, install, home })
  let page
  try {
    page = await Page.open(server.url)
    pass(`the web client booted on ${new URL(server.url).origin}`)

    // The first-run dialogs belong to DSH, not to arbor; dismiss them so the
    // check drives the same page a returning user sees and the screenshots show
    // the UI rather than a modal.
    await page.dismissNotices()
    // A fresh profile also toasts about its missing default workspace; let the
    // toast expire before the first screenshot.
    await page.waitFor('the workspace toast to clear', `!document.body.innerText.includes('Unable to create default workspace')`, 10_000).catch(() => undefined)

    await page.waitFor('the global navigation', `!!document.querySelector('nav[aria-label="Global panels"]')`)
    // ---- the settings page: a tab of the arbor page, its own sections, and
    // the API keys it can change. Every section is opened by a real click and
    // its pane is asserted, because a rail that renders but never switches
    // would look exactly like this one in a fresh screenshot.
    const settingsMark = page.messages.length
    await clickUntil(page, 'the Arbor entry', ARBOR_ENTRY, 'the Settings tab', `!!${SETTINGS_TAB}`)
    await page.click('the Settings tab', SETTINGS_TAB)
    await page.waitFor('the settings page', `!!document.querySelector('[data-arbor-settings]')`, 30_000)
    const opened = await page.settingsState()
    assert('the Settings tab opens a settings page, not a drawer',
      opened.open && (await page.evaluate(`!document.querySelector('[role=dialog]')`)),
      JSON.stringify({ open: opened.open }))
    assert('the rail lists every section',
      JSON.stringify(opened.sections) === JSON.stringify(SECTIONS),
      JSON.stringify(opened.sections))
    assert('the first section is the judge',
      opened.active === 'Judge' && opened.selects === 6,
      JSON.stringify({ active: opened.active, selects: opened.selects }))

    for (const [index, name] of SECTIONS.entries()) {
      await page.click(`the ${name} section`, sectionButton(name))
      await page.waitFor(`the ${name} pane`, `document.querySelector('.arbor-settings-pane h2')?.textContent.trim() === ${JSON.stringify(name)}`)
      const pane = await page.settingsState()
      assert(`the ${name} section switches the pane`, pane.active === name, JSON.stringify({ active: pane.active }))
      if (name === 'Judge') {
        assert('the Judge section has one control per judge decision', pane.selects === 6, JSON.stringify({ selects: pane.selects }))
      } else if (name === 'Windows') {
        assert('the Windows section has the four window limits', pane.numbers === 4, JSON.stringify({ numbers: pane.numbers }))
      } else if (name === 'Notes') {
        assert('the Notes section has the two note budgets', pane.numbers === 2, JSON.stringify({ numbers: pane.numbers }))
      } else if (name === 'Workspace') {
        assert('the Workspace section has the checkout retention', pane.numbers === 1, JSON.stringify({ numbers: pane.numbers }))
      } else if (name === 'API keys') {
        assert('the API keys section lists the judge key', pane.keys.some(key => key.name === 'JEV_API_KEY'), JSON.stringify(pane.keys))
        assert('a key with no value reads as not set',
          pane.keys.every(key => key.state === 'Not set'),
          JSON.stringify(pane.keys))
        assert('the key field is a password field', pane.passwordFields === 1, JSON.stringify({ fields: pane.passwordFields }))
      } else if (name === 'Facts') {
        assert('the Facts section is read-only', pane.facts >= 3 && pane.numbers === 0 && pane.selects === 0,
          JSON.stringify({ facts: pane.facts, numbers: pane.numbers, selects: pane.selects }))
        assert('the Facts section names the workspace and the settings source',
          pane.text.includes('Workspace backend') && pane.text.includes('Settings source'),
          pane.text.slice(0, 400))
      }
      const shot = await page.screenshot(`settings-0${index + 1}-${name.toLowerCase().replaceAll(' ', '-')}.png`)
      console.log(`screenshot: ${shot}`)
    }

    // ---- a key, end to end: typed into a masked field, stored in DSH's
    // credential store, never echoed back by the page or the facts, and cleared
    // again from the same control.
    await page.click('the API keys section', sectionButton('API keys'))
    await page.waitFor('the API keys pane', `document.querySelector('.arbor-settings-pane h2')?.textContent.trim() === 'API keys'`)
    await page.fill('the key field', `document.querySelector('.arbor-key input[type=password]')`, DUMMY_KEY)
    const typed = await page.settingsState()
    assert('the key field is masked', typed.passwordValue === DUMMY_KEY && (await page.evaluate(`document.querySelector('.arbor-key input[type=password]').type`)) === 'password',
      JSON.stringify({ type: await page.evaluate(`document.querySelector('.arbor-key input[type=password]').type`) }))
    await page.click('the save-key button', `[...document.querySelectorAll('.arbor-key button')].find(button => button.textContent.trim() === 'Save key')`)
    await page.waitFor('the key to read as set', `document.querySelector('.arbor-key-state')?.textContent.trim() === 'Set'`)
    const stored = await page.settingsState()
    assert('saving the key reads back as set, with the field emptied', stored.keys[0]?.state === 'Set' && stored.passwordValue === '',
      JSON.stringify({ keys: stored.keys, field: stored.passwordValue }))
    assert('the page never shows the key value', !stored.text.includes(DUMMY_KEY), 'the value is in the page text')
    const credentials = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(error => {
      fail(`DSH's credential document could not be read: ${error instanceof Error ? error.message : String(error)}`)
    })
    assert('the key is stored in DSH\'s credential document',
      credentials.includes('JEV_API_KEY') && credentials.includes(DUMMY_KEY),
      `the document holds ${String(credentials.length)} bytes`)
    const settingsDocument = await readFile(join(home, 'arbor', 'env', 'settings.json'), 'utf8').catch(() => '')
    assert('the key is in no settings document', !settingsDocument.includes(DUMMY_KEY), 'the value is in settings.json')
    // The whole point of a write-only field: the facts a browser can fetch must
    // not carry the value either, now or after a rebuild.
    const facts = await page.evaluate(`(async () => {
      const response = await fetch('/api/arbor/host')
      const reader = response.body.getReader()
      const first = await reader.read()
      await reader.cancel().catch(() => undefined)
      return new TextDecoder().decode(first.value)
    })()`)
    assert('the facts stream carries the key\'s state and not its value',
      facts.includes('JEV_API_KEY') && facts.includes('"set":true') && !facts.includes(DUMMY_KEY),
      `the first frame holds ${String(facts.length)} characters`)
    const setShot = await page.screenshot('settings-07-key-set.png')
    console.log(`screenshot: ${setShot}`)

    const answer = await page.evaluate(`(async () => {
      const response = await fetch('/api/arbor/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'JEV_API_KEY', clear: true }),
      })
      return response.text()
    })()`)
    assert('clearing answers with the keys, never the value', answer.includes('JEV_API_KEY') && !answer.includes(DUMMY_KEY),
      `the answer holds ${String(answer.length)} characters`)
    await page.waitFor('the key to read as not set', `document.querySelector('.arbor-key-state')?.textContent.trim() === 'Not set'`)
    const afterClear = await readFile(join(home, '.credentials.yaml'), 'utf8').catch(() => '')
    assert('clearing removes the stored value from DSH\'s credential document',
      !afterClear.includes(DUMMY_KEY),
      `the document holds ${String(afterClear.length)} bytes`)
    page.assertNoCrash(settingsMark, 'opening the settings page and changing a key')
    const clearShot = await page.screenshot('settings-08-key-cleared.png')
    console.log(`screenshot: ${clearShot}`)

    await openPlugins(page, 'the Arbor switch on the Plugins page')
    await sleep(500)

    const before = await page.state()
    assert('the sidebar renders before the switch', before.nav && before.sidebar, JSON.stringify(before))
    assert('the Plugins page renders before the switch', before.pluginsPage && before.main, JSON.stringify(before))
    assert('the Arbor entry is present before the switch', before.arborNav, JSON.stringify(before))
    assert('the Arbor switch is on before the switch', before.switchChecked === 'true', JSON.stringify(before))
    const beforeShot = await page.screenshot('01-before-disable.png')
    console.log(`screenshot: ${beforeShot}`)

    // ---- off: the client packages dispose while the page is live.
    const mark = page.messages.length
    const offLabel = await page.click('the Arbor switch', ARBOR_SWITCH)
    console.log(`clicked: ${offLabel}`)
    await page.waitFor('the Arbor entry to go away', `!document.querySelector('[data-arbor-icon]')`, 30_000)
    await page.waitFor('the switch to read off', `${ARBOR_SWITCH}?.getAttribute('aria-checked') === 'false'`, 30_000)
    await sleep(2_000)
    const afterOff = await page.state()
    assert('the sidebar still renders after switching Arbor off', afterOff.nav && afterOff.sidebar, JSON.stringify(afterOff))
    assert('the session tree still renders after switching Arbor off', afterOff.sessionTree, JSON.stringify(afterOff))
    assert('the current Plugins page still renders after switching Arbor off', afterOff.pluginsPage && afterOff.main, JSON.stringify(afterOff))
    assert('the Arbor entry is gone after switching Arbor off', !afterOff.arborNav, JSON.stringify(afterOff))
    assert('the Arbor switch reads off', afterOff.switchChecked === 'false', JSON.stringify(afterOff))
    page.assertNoCrash(mark, 'switching Arbor off')
    const offShot = await page.screenshot('02-after-disable.png')
    console.log(`screenshot: ${offShot}`)

    // ---- the composer: the hero preset seat and the permission seat live here.
    await page.click('the New session entry', `[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'New session')`)
    await page.waitFor('the composer preset chip', `document.body.innerText.includes('Standard mode')`)
    await sleep(500)
    const composer = await page.state()
    assert('the composer still renders after switching Arbor off', !composer.pluginsPage && composer.main, JSON.stringify(composer))
    assert('the sidebar still renders on the composer after switching Arbor off', composer.nav && composer.sidebar, JSON.stringify(composer))
    const composerShot = await page.screenshot('03-composer-after-disable.png')
    console.log(`screenshot: ${composerShot}`)

    // ---- on: the client packages apply again, into the same page.
    await openPlugins(page, 'the Arbor switch again')
    await page.click('the Arbor switch', ARBOR_SWITCH)
    await page.waitFor('the Arbor entry to come back', `!!document.querySelector('[data-arbor-icon]')`, 30_000)
    await page.waitFor('the switch to read on', `${ARBOR_SWITCH}?.getAttribute('aria-checked') === 'true'`, 30_000)
    await page.waitFor('the restart notice a live enable shows', `!!document.querySelector('[data-arbor-enable-notice]')`, 15_000)
    await sleep(2_000)
    const afterOn = await page.state()
    assert('the sidebar still renders after switching Arbor on', afterOn.nav && afterOn.sidebar, JSON.stringify(afterOn))
    assert('the session tree still renders after switching Arbor on', afterOn.sessionTree, JSON.stringify(afterOn))
    assert('the current Plugins page still renders after switching Arbor on', afterOn.pluginsPage && afterOn.main, JSON.stringify(afterOn))
    assert('the Arbor entry is back after switching Arbor on', afterOn.arborNav, JSON.stringify(afterOn))
    assert('a live enable says a DSH restart is needed', afterOn.restartNotice, JSON.stringify(afterOn))
    page.assertNoCrash(mark, 'switching Arbor off and on')
    const onShot = await page.screenshot('04-after-enable.png')
    console.log(`screenshot: ${onShot}`)

    const serverOutput = server.output().split('\n').filter(line => /error|warn|Problem/i.test(line)).slice(0, 10)
    for (const line of serverOutput) console.log(`server: ${line}`)

    console.log(`\nLIVE CHECK OK: ${passed.length} checks passed at ${version}`)
  } finally {
    page?.close()
    await stopWeb(server)
    unmountUnder(home)
  }
  if (process.env.ARBOR_CHECK_LIVE_WORK === undefined) await removeTree(work)
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`)
  console.error(`work directory kept at ${work}`)
  process.exitCode = 1
}
