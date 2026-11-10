/**
 * Proof 26: the settings page's controls are arbor's own settings and keys.
 *
 * The Arbor page's Settings tab edits the settings arbor reads while it runs:
 * the judge modes its dispatcher consults per decision, the limits a new window
 * opens with, the active-note budget, and the checkout retention. A control is
 * worth showing only if a change reaches the running host, so this proof
 * installs an update through the same host method the facts route calls and
 * checks three things:
 *
 *  A. the update lands as arbor's own `/env/settings.json` item;
 *  B. the running `Arbor` host re-reads it, which is what the judge, window
 *     limits and snapshot read;
 *  C. a refused update changes nothing.
 *
 * The API keys are the other half: a value a person enters is stored in DSH's
 * credential store (`$DSH_HOME/.credentials.yaml` on the web profile, the same
 * seam the Models page writes), reaches the environment arbor resolves secrets
 * from, is scrubbed out of what leaves the host, and never appears in the facts
 * or in a settings document. The overlay re-enables the credential row the
 * headless profile disables, so this runs against DSH's own provider.
 *
 * The workspace backend and the shared folder are deliberately not editable:
 * both are settled when the host starts, so this proof does not pretend a
 * setting there would move them.
 *
 * Run: pnpm proof:settings
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Settings } from '@4fu/arbor-interfaces'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'
import { finishProof, useDshFixtures } from '../packages/arbor-testkit/src/index.ts'
import type { ArborHostService } from '../packages/arbor-host/src/index.ts'

const NAME = 'arbor-spike-proof-26'
/** The key a launch environment supplies, never the one the proof stores. */
const AMBIENT = 'proof-ambient-key-2468'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const credentialsOverlay = fileURLToPath(new URL('../patches/credentials.patch.yml', import.meta.url))

const uninstallFailLoud = installFailLoud(NAME)
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}
let ctx: Context | undefined

try {
  useDshFixtures()
  const home = await freshDshHome('arbor-spike')
  console.log(`DSH_HOME=${home}`)
  loadEnv(NAME)
  // A launch-environment key is part of what the proof exercises: it must read
  // as set, and clearing a stored value must uncover it rather than drop it.
  process.env.JEV_API_KEY = AMBIENT
  ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, credentialsOverlay] })
  const host = ctx.get('arborHost') as ArborHostService | undefined
  check('the arbor host is mounted', host !== undefined, `ctx.arborHost -> ${host === undefined ? 'absent' : 'present'}`)
  if (host === undefined) throw new Error('the arbor host is absent')

  const before = await host.environment.settings()
  check('the seed settings are not an environment item yet',
    !(await host.environment.list()).some(item => item.kind === 'settings'),
    `settings item installed: ${(await host.environment.list()).some(item => item.kind === 'settings')}`)
  console.log(`before: window context ${String(before?.window?.contextTokens ?? 'default')}`)

  const updated = await host.updateSettings({
    judgeModes: { route: 'shadow', active_set: 'on' },
    window: { contextTokens: 123_456, reserveTokens: 2_345, idleSeconds: 123, protectionSeconds: 30, handoffFloor: 0.35 },
    notes: { activeCount: 17, activeTokenBudget: 4_321 },
    retentionMs: 600_000,
  })
  check('the update answers with the edited values',
    updated.window?.contextTokens === 123_456 && updated.window?.handoffFloor === 0.35 && updated.notes?.activeCount === 17 && updated.judge?.modes?.route === 'shadow',
    `window=${JSON.stringify(updated.window)} notes=${JSON.stringify(updated.notes)} judge=${JSON.stringify(updated.judge)}`)

  const items = await host.environment.list()
  check('the update is arbor\'s own settings item',
    items.some(item => item.kind === 'settings'),
    `kinds=${items.map(item => item.kind).join(',')}`)
  const stored = await host.environment.settings()
  check('the installed document carries every edited field',
    stored?.window?.contextTokens === 123_456
      && stored?.window?.reserveTokens === 2_345
      && stored?.window?.idleSeconds === 123
      && stored?.window?.protectionSeconds === 30
      && stored?.window?.handoffFloor === 0.35
      && stored?.notes?.activeCount === 17
      && stored?.notes?.activeTokenBudget === 4_321
      && stored?.judge?.modes?.route === 'shadow'
      && stored?.judge?.modes?.active_set === 'on'
      && stored?.workspaces?.retentionMs === 600_000,
    JSON.stringify(stored))

  // The host reads its settings through `refresh()`, not from this service's
  // seed. Reading the live field is the check that a control takes effect.
  const live = host.host as unknown as { settings?: Settings }
  check('the running host re-read the edited settings',
    live.settings?.window?.contextTokens === 123_456
      && live.settings?.window?.idleSeconds === 123
      && live.settings?.window?.handoffFloor === 0.35
      && live.settings?.notes?.activeTokenBudget === 4_321
      && live.settings?.judge?.modes?.route === 'shadow'
      && live.settings?.workspaces?.retentionMs === 600_000,
    JSON.stringify(live.settings))

  // A refusal is a whole-document refusal: the installed item must stay as it
  // was, not half-updated.
  let refused = false
  try {
    await host.updateSettings({ window: { contextTokens: 1_000, reserveTokens: 1_000 } })
  } catch {
    refused = true
  }
  const afterRefusal = await host.environment.settings()
  check('a refused update changes nothing',
    refused && afterRefusal?.window?.contextTokens === 123_456 && afterRefusal?.window?.reserveTokens === 2_345,
    `refused=${refused} window=${JSON.stringify(afterRefusal?.window)}`)

  // A fraction outside 0..1 is refused too, and the installed floor stays.
  let refusedFloor = false
  try {
    await host.updateSettings({ window: { handoffFloor: 1.5 } })
  } catch {
    refusedFloor = true
  }
  check('a handoff floor outside 0..1 is refused and the installed one stays',
    refusedFloor && (await host.environment.settings())?.window?.handoffFloor === 0.35,
    `refused=${refusedFloor} window=${JSON.stringify((await host.environment.settings())?.window)}`)

  // The fields the settings page does not edit survive a later update.
  await host.updateSettings({ notes: { activeCount: 18 } })
  const afterSecond = await host.environment.settings()
  check('an unedited field survives a later update',
    afterSecond?.window?.contextTokens === 123_456
      && afterSecond?.window?.handoffFloor === 0.35
      && afterSecond?.judge?.modes?.route === 'shadow'
      && afterSecond?.notes?.activeCount === 18
      && afterSecond?.workspaces?.retentionMs === 600_000,
    JSON.stringify(afterSecond))

  // ---- the keys: DSH's own credential store, never a settings document.
  const credentialsPath = join(process.env.DSH_HOME ?? '', '.credentials.yaml')
  const settingsPath = join(home, 'arbor', 'env', 'settings.json')
  const KEY = 'JEV_API_KEY'
  const VALUE = 'proof-jev-key-0123456789'

  const none = await host.keys()
  check('the judge key is the first key arbor reads',
    none[0]?.name === KEY && none[0]?.purpose === 'judge',
    JSON.stringify(none))
  check('a key from the launch environment reads as set, from env',
    none.find(one => one.name === KEY)?.set === true
      && none.find(one => one.name === KEY)?.source === 'env'
      && !JSON.stringify(none).includes(AMBIENT),
    JSON.stringify(none))
  check('the credential store is writable while DSH mounts it',
    none.find(one => one.name === KEY)?.writable === true,
    JSON.stringify(none))

  const set = await host.setKey(KEY, VALUE)
  check('the key reads as set, and its value is nowhere in the answer',
    set.find(one => one.name === KEY)?.set === true && !JSON.stringify(set).includes(VALUE),
    JSON.stringify(set))
  const storedDocument = await readFile(credentialsPath, 'utf8')
  check('the value is in DSH\'s credential document',
    storedDocument.includes(VALUE) && storedDocument.includes(KEY),
    `document entries: ${[...storedDocument.matchAll(/^\s{2,}([A-Za-z_][A-Za-z0-9_]*):/gm)].map(match => match[1]).join(',')}`)
  check('the value is in the environment arbor resolves secrets from',
    process.env[KEY] === VALUE,
    `JEV_API_KEY ${process.env[KEY] === VALUE ? 'is' : 'is not'} the stored value`)
  const settingsDocument = await readFile(settingsPath, 'utf8').catch(() => '')
  check('the value is in no settings document',
    !settingsDocument.includes(VALUE),
    `settings.json ${settingsDocument === '' ? 'is absent' : `holds ${String(settingsDocument.length)} bytes, none of them the key`}`)
  // The scrub is what keeps the value out of the journal, the model and the
  // judge's own request; it re-reads the names on the host refresh the write
  // triggers, so the value typed a moment ago is already hidden.
  const scrub = (host.host as unknown as { secrets: { apply(text: string): string } }).secrets
  check('the value is scrubbed out of what leaves the host',
    scrub.apply(`key is ${VALUE} here`) !== `key is ${VALUE} here` && !scrub.apply(`key is ${VALUE} here`).includes(VALUE),
    scrub.apply(`key is ${VALUE} here`))

  const cleared = await host.clearKey(KEY)
  const afterClear = await readFile(credentialsPath, 'utf8').catch(() => '')
  check('clearing removes the stored value from the document and the environment',
    !afterClear.includes(VALUE)
      && process.env[KEY] !== VALUE
      && !JSON.stringify(cleared).includes(VALUE),
    JSON.stringify(cleared))

  // The launch environment is the documented fallback, so a cleared store must
  // uncover the value the process launched with rather than inventing an unset.
  check('clearing uncovers the launch-environment value again',
    cleared.find(one => one.name === KEY)?.source === 'env'
      && process.env[KEY] === AMBIENT
      && !afterClear.includes(AMBIENT)
      && !(await readFile(credentialsPath, 'utf8').catch(() => '')).includes(AMBIENT),
    `${JSON.stringify(cleared)} env=${process.env[KEY] === AMBIENT ? 'ambient' : String(process.env[KEY])}`)

  let refusedUnknown = false
  try {
    await host.setKey('ARBOR_NOT_A_KEY', VALUE)
  } catch {
    refusedUnknown = true
  }
  let refusedEmpty = false
  try {
    await host.setKey(KEY, '')
  } catch {
    refusedEmpty = true
  }
  check('a name arbor does not read, and an empty value, are both refused',
    refusedUnknown && refusedEmpty && !(await readFile(credentialsPath, 'utf8').catch(() => '')).includes(VALUE),
    `unknown=${refusedUnknown} empty=${refusedEmpty}`)
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  delete process.env.JEV_API_KEY
  await ctx?.fiber.dispose()
  uninstallFailLoud()
  finishProof('PROOF 26', failures)
}
