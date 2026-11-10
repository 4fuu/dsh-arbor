/**
 * Check what a user actually gets from a profile install.
 *
 * The checkout runs every package from one workspace, so arbor and DSH always
 * resolve the same copy of Cordis and of each `dsh-*` package there. A profile
 * install is different: `dsh plugin --profile web add` runs pnpm in
 * `$DSH_HOME/profiles/web` with `autoInstallPeers: false`, and anything a
 * published package lists as a `dependency` is installed a second time beside
 * DSH. That is how 2026.1110.0 shipped: `@4fu/dsh-arbor-driver` extended the
 * profile's `@deepseek-ai/dsh-agent`, which scoped its contexts with the
 * profile's `@deepseek-ai/dsh-scope`, while DSH's preset registry read the scope
 * with its own copy, found none, and every new session failed with
 * `Agent preset binding requires a scoped context`.
 *
 * So this check installs the packed tarballs into a fresh DSH profile the way a
 * user does, asserts that the profile holds no second copy of a DSH runtime
 * package, and creates one ordinary session and one arbor session through the
 * same HTTP RPC the web UI uses.
 *
 * Run: pnpm check:profile
 *
 * Set ARBOR_CHECK_WORK to a directory to keep the install and the server logs
 * for inspection; a failing run prints the directory it used.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createProfile,
  createSession,
  connect,
  installDsh,
  isDshRuntime,
  packRelease,
  removeTree,
  startWeb,
  stopWeb,
  unmountUnder,
  workspace,
} from './profile-fixture.mjs'

const work = await workspace('ARBOR_CHECK_WORK', 'dsh-arbor-profile-')

const passed = []
function pass(message) {
  passed.push(message)
  console.log(`PASS ${message}`)
}
function fail(message) {
  throw new Error(message)
}

try {
  console.log(`work directory: ${work}`)
  const { packages, version, bundle } = await packRelease(work)
  console.log(`packing ${packages.length} packages at ${version}`)
  pass(`packed ${packages.length} tarballs at ${version}`)

  const install = await installDsh(work)
  pass(`DSH is installed at ${install}`)

  // A fresh profile, with the tarballs standing in for the registry: the bundle
  // names its siblings at the release version, and an override resolves each of
  // them to the tarball this run packed.
  const { home, profile } = await createProfile(work, install, packages, bundle)

  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@4fu/dsh-arbor-bundle')) fail(`the profile does not compose @4fu/dsh-arbor-bundle: ${JSON.stringify(bundles)}`)
  pass(`the profile composes the bundle: ${bundles.join(', ')}`)

  // The regression: a published package that lists a DSH runtime package as a
  // dependency installs a second copy into the profile, and DSH's resolver
  // hands arbor the profile's copy while DSH keeps its own.
  const modules = join(profile, 'node_modules', '@deepseek-ai')
  const copies = (await readdir(modules).catch(() => [])).filter(isDshRuntime).sort()
  if (copies.length > 0) {
    fail(
      `the profile holds ${copies.length} second copies of DSH runtime packages: ${copies.join(', ')}\n` +
        'a published package must declare them as peerDependencies, mirrored in devDependencies',
    )
  }
  const libraries = (await readdir(modules).catch(() => [])).sort()
  pass(`the profile holds no DSH runtime copy${libraries.length === 0 ? '' : ` (only libraries: ${libraries.join(', ')})`}`)

  for (const package_ of packages) {
    const installed = JSON.parse(await readFile(join(profile, 'node_modules', ...package_.name.split('/'), 'package.json'), 'utf8'))
    if (installed.version !== version) fail(`${package_.name} installed as ${String(installed.version)}, expected the packed ${version}`)
  }
  pass(`all ${packages.length} arbor packages are the packed ${version}`)

  const driver = JSON.parse(await readFile(join(profile, 'node_modules', '@4fu', 'dsh-arbor-driver', 'package.json'), 'utf8'))
  const driverRuntime = Object.keys(driver.dependencies ?? {}).filter(name => name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-') || name.startsWith('@deepseek-ai/dsh-'))
  if (driverRuntime.length > 0) fail(`the installed driver still depends on ${driverRuntime.join(', ')}`)
  const driverPeers = Object.keys(driver.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
  if (driverPeers.length === 0) fail('the installed driver declares no DSH peer, so the packed tarball is not the one this checkout built')
  pass(`the installed driver declares ${driverPeers.length} DSH peers and no DSH dependency`)

  const server = await startWeb({ work, install, home })
  try {
    const connection = await connect(server.url)
    pass(`dsh web served its launch URL on ${connection.origin}`)

    const ordinary = await createSession(connection, { cwd: work })
    if (!ordinary.ok) fail(`an ordinary session failed: ${JSON.stringify(ordinary.error)}`)
    const arbor = await createSession(connection, { cwd: work, agentPreset: 'arbor' })
    if (!arbor.ok) fail(`an arbor session failed: ${JSON.stringify(arbor.error)}`)
    if (ordinary.value.agentPreset !== 'standard') fail(`the ordinary session ran preset ${String(ordinary.value.agentPreset)}`)
    if (arbor.value.agentPreset !== 'arbor') fail(`the arbor session ran preset ${String(arbor.value.agentPreset)}`)
    pass(`an ordinary session was created: ${ordinary.value.sessionId} (${ordinary.value.agentPreset})`)
    pass(`an arbor session was created: ${arbor.value.sessionId} (${arbor.value.agentPreset})`)
    const output = server.output()
    for (const line of output.split('\n').filter(line => /error|warn/i.test(line)).slice(0, 10)) console.log(`server: ${line}`)
  } finally {
    await stopWeb(server)
    unmountUnder(home)
  }

  console.log(`\nPROFILE INSTALL OK: ${passed.length} checks passed at ${version}`)
  if (process.env.ARBOR_CHECK_WORK === undefined) await removeTree(work)
} catch (error) {
  console.error(`\nFAIL ${error instanceof Error ? error.message : String(error)}`)
  console.error(`work directory kept at ${work}`)
  process.exitCode = 1
}
