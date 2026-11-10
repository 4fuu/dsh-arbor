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
 * Set ARBOR_CHECK_WORK to an empty directory to keep the install and the
 * server logs for inspection; a failing run prints the directory it used.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PACKAGES } from './release-packages.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN = '0.2.2-rc.1'
const DSH_CLI = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

const work = process.env.ARBOR_CHECK_WORK ?? (await mkdtemp(join(tmpdir(), 'dsh-arbor-profile-')))
const tarballs = join(work, 'tarballs')
const install = join(work, 'dsh')
const home = join(work, 'home')
const profile = join(home, 'profiles', 'web')

/** Every published package, as its manifest and tarball name. */
const packages = []
for (const directory of RELEASE_PACKAGES) {
  const manifest = JSON.parse(await readFile(join(ROOT, 'packages', directory, 'package.json'), 'utf8'))
  packages.push({ name: manifest.name, version: manifest.version, tarball: join(tarballs, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`) })
}
const version = packages[0].version
if (packages.some(package_ => package_.version !== version)) throw new Error('every release package must carry the same version')

const passed = []
function pass(message) {
  passed.push(message)
  console.log(`PASS ${message}`)
}
function fail(message) {
  throw new Error(message)
}

/** Run one command, and return its combined output; throw on a nonzero exit. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output}`))
    })
  })
}

/** One free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/** Paths a stopped DSH left mounted, deepest first, from this process's mount table. */
function mountsUnder(path) {
  let table
  try {
    table = readFileSync('/proc/self/mounts', 'utf8')
  } catch {
    return []
  }
  const prefix = `${path}/`
  return table
    .split('\n')
    .map(line => line.split(' ')[1]?.replaceAll('\\040', ' '))
    .filter(point => point !== undefined && point.startsWith(prefix))
    .sort((left, right) => right.length - left.length)
}

/** Unmount whatever a stopped DSH left mounted under a directory. */
function unmountUnder(path) {
  for (const mount of mountsUnder(path)) spawnSync('fusermount3', ['-uz', mount], { stdio: 'ignore' })
}

/**
 * Remove a directory tree, first unmounting anything under it.
 *
 * Arbor's workspace mounts its shared folder with FUSE (ovnfs). A stopped
 * server normally unmounts it, but a killed one cannot, and a busy mount makes
 * the tree impossible to delete. This is cleanup only: a tree that still
 * refuses to go is reported and left behind, never a failed check.
 */
async function removeTree(path) {
  const attempt = () => rm(path, { recursive: true, force: true, maxRetries: 5 })
  try {
    await attempt()
    return
  } catch (error) {
    if (error.code !== 'EBUSY' && error.code !== 'ENOTEMPTY') throw error
  }
  unmountUnder(path)
  await new Promise(resolve => setTimeout(resolve, 300))
  try {
    await attempt()
  } catch (error) {
    console.log(`warning: left ${path} behind (${error.code})`)
  }
}

/** A DSH runtime package: Cordis or one of the `dsh-*` packages. */
function isDshRuntime(name) {
  return name === 'cordis' || name.startsWith('cordis-') || name === 'dsh' || name.startsWith('dsh-')
}

/** Start `dsh web`, and settle on the printed launch URL. */
async function startWeb() {
  const port = await freePort()
  const child = spawn(process.execPath, [join(install, DSH_CLI), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: work,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dsh web did not print a URL within 90s\n${output}`)), 90_000)
    const read = chunk => {
      output += chunk
      const match = /dsh web: (http:\/\/\S+\?token=\S+)/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    child.stdout.on('data', read)
    child.stderr.on('data', read)
    child.on('close', code => {
      clearTimeout(timer)
      reject(new Error(`dsh web exited with ${code}\n${output}`))
    })
  })
  return { child, url, output: () => output }
}

/** Stop the server and let the port go. */
async function stopWeb(server) {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  const stopped = await Promise.race([new Promise(resolve => server.child.on('close', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 10_000))])
  if (!stopped) server.child.kill('SIGKILL')
}

/** Exchange the launch token for the API cookie the web UI's RPC uses. */
async function connect(url) {
  const launch = new URL(url)
  const connectUrl = new URL('/connect', launch.origin)
  connectUrl.searchParams.set('token', launch.searchParams.get('token'))
  connectUrl.searchParams.set('interactions', 'none')
  const response = await fetch(connectUrl, { redirect: 'manual' })
  if (response.status !== 302) fail(`/connect answered ${response.status}, expected the 302 that mints the API cookie`)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (cookie === '') fail('/connect minted no cookie')
  return { origin: launch.origin, cookie }
}

/** One Session through the endpoint the web UI's New session button calls. */
async function createSession(connection, request) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${connection.origin}/api/session/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: connection.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/create', payload: { args: { request } } }),
  })
  if (response.status !== 200) fail(`session/create answered HTTP ${response.status}`)
  const body = await response.json()
  if (body.rpcId !== rpcId) fail(`session/create answered rpcId ${String(body.rpcId)}, sent ${rpcId}`)
  return body.result
}

try {
  console.log(`work directory: ${work}`)
  console.log(`packing ${packages.length} packages at ${version}`)
  await removeTree(tarballs)
  await mkdir(tarballs, { recursive: true })
  await run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')])
  await run(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), '--pack-dir', tarballs])
  pass(`packed ${packages.length} tarballs at ${version}`)

  if (!existsSync(join(install, DSH_CLI))) {
    console.log(`installing @deepseek-ai/dsh@${PIN} into ${install}`)
    await rm(install, { recursive: true, force: true })
    await mkdir(install, { recursive: true })
    await run('npm', ['install', '--prefix', install, '--no-audit', '--no-fund', '--loglevel', 'error', `@deepseek-ai/dsh@${PIN}`], { cwd: install })
  }
  pass(`DSH ${PIN} is installed at ${install}`)

  // A fresh profile, with the tarballs standing in for the registry: the bundle
  // names its siblings at the release version, and an override resolves each of
  // them to the tarball this run packed.
  await removeTree(home)
  await mkdir(home, { recursive: true })
  const dshEnv = { ...process.env, DSH_HOME: home }
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'version-exemptions'], { env: dshEnv })
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const workspace = await readFile(workspacePath, 'utf8')
  const overrides = packages.map(package_ => `  '${package_.name}': file:${package_.tarball}`).join('\n')
  await writeFile(workspacePath, `${workspace.trimEnd()}\n\noverrides:\n${overrides}\n`)
  const bundle = packages.find(package_ => package_.name === '@4fu/dsh-arbor-bundle')
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'add', `file:${bundle.tarball}`], { env: dshEnv })

  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@4fu/dsh-arbor-bundle')) fail(`the profile does not compose @4fu/dsh-arbor-bundle: ${JSON.stringify(bundles)}`)
  pass(`the profile composes the bundle: ${bundles.join(', ')}`)

  // The regression: a published package that lists a DSH runtime package as a
  // dependency installs a second copy into the profile, and DSH's resolver
  // hands arbor the profile's copy while DSH keeps its own.
  const modules = join(profile, 'node_modules', '@deepseek-ai')
  const copies = existsSync(modules) ? (await readdir(modules)).filter(isDshRuntime).sort() : []
  if (copies.length > 0) {
    fail(
      `the profile holds ${copies.length} second copies of DSH runtime packages: ${copies.join(', ')}\n` +
        'a published package must declare them as peerDependencies, mirrored in devDependencies',
    )
  }
  const libraries = existsSync(modules) ? (await readdir(modules)).sort() : []
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

  const server = await startWeb()
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
