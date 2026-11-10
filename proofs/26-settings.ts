/**
 * Proof 26: the settings drawer's controls are arbor's own settings.
 *
 * The Arbor page edits the settings arbor reads while it runs: the judge modes
 * its dispatcher consults per decision, the limits a new window opens with, the
 * active-note budget, and the checkout retention. A control is worth showing
 * only if a change reaches the running host, so this proof installs an update
 * through the same host method the facts route calls and checks three things:
 *
 *  A. the update lands as arbor's own `/env/settings.json` item;
 *  B. the running `Arbor` host re-reads it, which is what the judge, window
 *     limits and snapshot read;
 *  C. a refused update changes nothing.
 *
 * The workspace backend and the shared folder are deliberately not editable:
 * both are settled when the host starts, so this proof does not pretend a
 * setting there would move them.
 *
 * Run: pnpm proof:settings
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Settings } from '@4fu/arbor-interfaces'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import { arborPatch, bootArborProfile, freshDshHome } from '../packages/arbor-testkit/src/boot.ts'
import { finishProof, useDshFixtures } from '../packages/arbor-testkit/src/index.ts'
import type { ArborHostService } from '../packages/arbor-host/src/index.ts'

const NAME = 'arbor-spike-proof-26'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))

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
  ctx = await bootArborProfile({ binName: NAME, profile: 'headless', overlayPaths: [arborPatch, arborOverlay, scriptedOverlay] })
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
    window: { contextTokens: 123_456, reserveTokens: 2_345, idleSeconds: 123, protectionSeconds: 30 },
    notes: { activeCount: 17, activeTokenBudget: 4_321 },
    retentionMs: 600_000,
  })
  check('the update answers with the edited values',
    updated.window?.contextTokens === 123_456 && updated.notes?.activeCount === 17 && updated.judge?.modes?.route === 'shadow',
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

  // The fields the drawer does not edit survive a later update.
  await host.updateSettings({ notes: { activeCount: 18 } })
  const afterSecond = await host.environment.settings()
  check('an unedited field survives a later update',
    afterSecond?.window?.contextTokens === 123_456
      && afterSecond?.judge?.modes?.route === 'shadow'
      && afterSecond?.notes?.activeCount === 18
      && afterSecond?.workspaces?.retentionMs === 600_000,
    JSON.stringify(afterSecond))
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
  finishProof('PROOF 26', failures)
}
