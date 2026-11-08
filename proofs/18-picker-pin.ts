/**
 * Proof 18: the picker filter is pinned to the shipped plugin it wraps.
 *
 * `@4fu/dsh-arbor-ui-workspace` runs the shipped workspace plugin with
 * `ctx.slots.register` wrapped for the one registration that matters — the hero
 * picker — and replaces only its component with a filtered one. The shipped row
 * stays enabled: the host serves the client module graph from the composed
 * plugin tree, so a disabled row's package is not in the graph and a
 * `dsh.client.inject` dependency of the shipped plugin cannot arrive (the
 * package then fails to import), and re-running the shipped `apply` with the row
 * enabled throws `service "uiWorkspace" has been registered`. The wrapper is
 * invisible when it silently stops matching: a registration that moved, a
 * component that reads its state another way, a service list that changed — any
 * of them turns the filter into either a broken picker or a picker that lists
 * arbor's projects to an ordinary session, with nothing said. So the shape this
 * repository depends on is read out of the shipped bundle and asserted here, and
 * the suite fails when it moves:
 *
 *  A. the pinned DSH is the one this repository runs (dsh-v0.2.2-rc.1);
 *  B. the hero-picker registration: the slot name, its children table (the
 *     `single`, root-scoped `directoryFlow` child the wrapper has to keep), its
 *     inject face and its locale namespace, and the component it registers;
 *  C. the pick flow reads the whole workspace state and the row's own fields
 *     (`workspaceId`, `title`, `path`), which is what the filter rewrites;
 *  D. the shipped plugin's own service list equals the one this package
 *     declares, because the shipped `apply` runs on this package's fiber;
 *  E. the bundle patch keeps the shipped row enabled and inserts this package,
 *     and the shipped package's `dsh.client.inject` is what puts it in the graph.
 *
 * Run: pnpm proof:picker-pin
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFailLoud } from '@deepseek-ai/dsh-app-boot'
import { installAnchor } from '../packages/arbor-testkit/src/index.ts'
import { DSH_PINNED_VERSION } from '../packages/arbor-prompt/src/index.ts'
import { inject as arborInject } from '../packages/arbor-ui-workspace/src/client.ts'

const NAME = 'arbor-spike-proof-18'

/** The shipped plugin this repository wraps. */
const SHIPPED_PACKAGE = '@deepseek-ai/dsh-client-ui-workspace'

/** The services this package's plugin declares, which must equal the shipped list. */
const DECLARED_INJECT: readonly string[] = [
  'contextMenus',
  'slots',
  'sessions',
  'workspaces',
  'locale',
  'remote',
  'remote.directoryPicker',
  'layout',
  'shortcuts',
  'remoteAccess',
]

const uninstallFailLoud = installFailLoud(NAME)
const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/** The shipped plugin's package directory in pnpm's virtual store. */
function shippedPackageDir(): string {
  const store = join(installAnchor, '..', '..', '..', '..', '..')
  const prefix = `${SHIPPED_PACKAGE.replace('/', '+')}@`
  for (const entry of readdirSync(store) as string[]) {
    if (!entry.startsWith(prefix)) continue
    const candidate = join(store, entry, 'node_modules', SHIPPED_PACKAGE)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  throw new Error(`the shipped package ${SHIPPED_PACKAGE} is not installed`)
}

/** Every quoted string a shipped bundle's registration object carries, in order. */
function quoted(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(match => match[1] ?? '')
}

try {
  const dir = shippedPackageDir()
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    version?: string; dsh?: { client?: { inject?: readonly string[] } }
  }
  const bundle = readFileSync(join(dir, 'lib', 'client.js'), 'utf8')

  // ---- A. the pin.
  check('the picker filter is pinned to the DSH this repository runs',
    manifest.version === DSH_PINNED_VERSION && DSH_PINNED_VERSION === '0.2.2-rc.1',
    `shipped ${SHIPPED_PACKAGE} is ${manifest.version}; the repository is pinned to ${DSH_PINNED_VERSION}`)

  // ---- B. the hero-picker registration, the one the wrapper replaces.
  const start = bundle.indexOf('ctx.slots.inject("conversation.hero.workspace"')
  const registration = start < 0 ? '' : bundle.slice(start, bundle.indexOf('}, WorkspacePicker)', start))
  check('the shipped plugin registers the hero picker seat the wrapper wraps',
    registration.includes('name: "conversation.hero.workspace"'),
    `the registration names the seat: ${registration.includes('name: "conversation.hero.workspace"')}`)
  check('the hero picker declares its directory-flow child, which the wrapper keeps',
    registration.includes('children: { "conversation.hero.workspace.directoryFlow": {')
      && registration.includes('kind: "single"')
      && registration.includes('scope: "root"'),
    `the children table is there: ${registration.includes('"conversation.hero.workspace.directoryFlow"')}`)
  check('the hero picker registration carries the inject face and the locale',
    registration.includes('inject: pickerInjected') && registration.includes('locale: NS'),
    `inject: ${registration.includes('inject: pickerInjected')}; locale: ${registration.includes('locale: NS')}`)
  check('the hero picker registers the WorkspacePicker component',
    bundle.includes('}, WorkspacePicker));'),
    'the shipped component is the one the wrapper wraps')

  // ---- C. the state the pick flow reads, which is what the filter rewrites.
  check('the pick flow reads the whole workspace state',
    bundle.includes('const workspaceSnapshot = useWorkspaces((state) => state);')
      && bundle.includes('const workspaces = workspaceSnapshot.items;'),
    'the flow selects the state and reads its items')
  const rows = quoted(bundle, /workspace\.(workspaceId|title|path)\b/g)
  check('the pick flow reads each row by its own fields',
    new Set(rows).size === 3 && ['workspaceId', 'title', 'path'].every(one => rows.includes(one)),
    `row fields the flow reads: ${[...new Set(rows)].join(', ')}`)

  // ---- D. the shipped service list, which this package's fiber has to declare.
  const list = /const inject = \[([^\]]*)\];/.exec(bundle)?.[1] ?? ''
  const services = quoted(list, /"([^"]+)"/g)
  check("the shipped plugin's service list is the one this package declares",
    services.length === DECLARED_INJECT.length
      && DECLARED_INJECT.every((one, index) => services[index] === one),
    `shipped: ${services.join(', ')}`)
  // This package runs the shipped `apply` on its own fiber, so every service the
  // shipped plugin declares has to be reachable from this one. It may declare
  // more — it does, for the two follow-ups it runs that the shipped plugin does
  // not — but never fewer, and never in a different order at the front.
  check("this package declares every service the shipped plugin needs",
    services.every(one => arborInject.includes(one)),
    `this package: ${arborInject.join(', ')}`)

  // ---- E. the graph and the row that mounts this package.
  check('the shipped package declares the client dependency graph',
    (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-connection'),
    `dsh.client.inject carries ${String((manifest.dsh?.client?.inject ?? []).length)} packages`)
  const patch = readFileSync(
    fileURLToPath(new URL('../packages/arbor-bundle/cordis.patch.yml', import.meta.url)), 'utf8')
  // The row stays enabled on purpose: see the module comment. A disabled row
  // drops the shipped package out of the client module graph the host serves,
  // and a re-mounted shipped `apply` throws on its own service registration.
  const rowDisabled = /id: ui-workspace[\s\S]{0,120}?disabled: true/.test(patch)
  check('the bundle patch does not disable the shipped workspace row', !rowDisabled,
    `the ui-workspace row is disabled: ${rowDisabled}`)
  check('the bundle patch mounts the arbor picker filter beside it',
    patch.includes("name: '@4fu/dsh-arbor-ui-workspace'"),
    'the patch inserts @4fu/dsh-arbor-ui-workspace')
} catch (error: unknown) {
  console.error(error)
  failures.push(String(error))
} finally {
  uninstallFailLoud()
  const { finishProof } = await import('../packages/arbor-testkit/src/finish.ts')
  finishProof('picker-pin', failures)
}
