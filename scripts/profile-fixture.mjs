/**
 * The fixture a profile check needs: pack the release, install the pinned DSH,
 * build a fresh web profile from the packed tarballs, and start and stop it.
 *
 * `scripts/check-profile.mjs` drives the profile through the HTTP RPC the web UI
 * uses; `scripts/check-live.mjs` drives it through the real web UI in a browser.
 * Both need the same profile: the tarballs this checkout built, installed the
 * way `dsh plugin add` installs them, with the profile's own `overrides` table
 * pointing every arbor package at its tarball so nothing is fetched from npm.
 * This module owns that setup, so the two checks cannot drift.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_PACKAGES } from './release-packages.mjs'

/** The checkout this fixture builds from. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The one DSH version this repository is built against. */
export const PIN = '0.2.2-rc.1'

/** The installed DSH CLI, relative to the fixture's install directory. */
export const DSH_CLI = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/** A fresh directory for one check, or the one named by an environment variable. */
export async function workspace(variable, prefix) {
  const named = process.env[variable]
  if (named !== undefined && named !== '') {
    await mkdir(named, { recursive: true })
    return named
  }
  return mkdtemp(join(tmpdir(), prefix))
}

/** Run one command, and return its combined output; throw on a nonzero exit. */
export function run(command, args, options = {}) {
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
export function freePort() {
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
export function unmountUnder(path) {
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
export async function removeTree(path) {
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
export function isDshRuntime(name) {
  return name === 'cordis' || name.startsWith('cordis-') || name === 'dsh' || name.startsWith('dsh-')
}

/**
 * Build and pack every release package into `<work>/tarballs`.
 * @returns the packed packages, the shared version and the bundle row.
 */
export async function packRelease(work) {
  const tarballs = join(work, 'tarballs')
  const packages = []
  for (const directory of RELEASE_PACKAGES) {
    const manifest = JSON.parse(await readFile(join(ROOT, 'packages', directory, 'package.json'), 'utf8'))
    packages.push({
      name: manifest.name,
      version: manifest.version,
      tarball: join(tarballs, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`),
    })
  }
  const version = packages[0].version
  if (packages.some(package_ => package_.version !== version)) throw new Error('every release package must carry the same version')
  const bundle = packages.find(package_ => package_.name === '@4fu/dsh-arbor-bundle')
  await removeTree(tarballs)
  await mkdir(tarballs, { recursive: true })
  await run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')])
  await run(process.execPath, [join(ROOT, 'scripts', 'publish.mjs'), '--pack-dir', tarballs])
  return { packages, version, bundle, tarballs }
}

/**
 * Install the pinned DSH into `<work>/dsh`, reusing an existing install there.
 * @returns the install directory.
 */
export async function installDsh(work) {
  const install = join(work, 'dsh')
  if (existsSync(join(install, DSH_CLI))) return install
  console.log(`installing @deepseek-ai/dsh@${PIN} into ${install}`)
  await removeTree(install)
  await mkdir(install, { recursive: true })
  await run('npm', ['install', '--prefix', install, '--no-audit', '--no-fund', '--loglevel', 'error', `@deepseek-ai/dsh@${PIN}`], { cwd: install })
  return install
}

/**
 * Create `<work>/home` and install the packed bundle into its web profile, the
 * way a user's `dsh plugin --profile web add` does. Every arbor package is
 * overridden to its tarball, so the install needs no registry access after DSH
 * itself is installed.
 * @returns the DSH home and the profile directory.
 */
export async function createProfile(work, install, packages, bundle) {
  const home = join(work, 'home')
  const profile = join(home, 'profiles', 'web')
  await removeTree(home)
  await mkdir(home, { recursive: true })
  const dshEnv = { ...process.env, DSH_HOME: home }
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'version-exemptions'], { env: dshEnv })
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const workspace = await readFile(workspacePath, 'utf8')
  const overrides = packages.map(package_ => `  '${package_.name}': file:${package_.tarball}`).join('\n')
  await writeFile(workspacePath, `${workspace.trimEnd()}\n\noverrides:\n${overrides}\n`)
  await run(process.execPath, [join(install, DSH_CLI), 'plugin', '--profile', 'web', 'add', `file:${bundle.tarball}`], { env: dshEnv })
  return { home, profile }
}

/**
 * Start `dsh web` for a profile, and settle on the printed launch URL.
 * @returns the child process, its URL and a live output reader.
 */
export async function startWeb({ work, install, home, env = {} }) {
  const port = await freePort()
  const child = spawn(process.execPath, [join(install, DSH_CLI), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: work,
    env: { ...process.env, ...env, DSH_HOME: home },
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
export async function stopWeb(server) {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  const stopped = await Promise.race([new Promise(resolve => server.child.on('close', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 10_000))])
  if (!stopped) server.child.kill('SIGKILL')
}

/** Exchange the launch token for the API cookie the web UI's RPC uses. */
export async function connect(url) {
  const launch = new URL(url)
  const connectUrl = new URL('/connect', launch.origin)
  connectUrl.searchParams.set('token', launch.searchParams.get('token'))
  connectUrl.searchParams.set('interactions', 'none')
  const response = await fetch(connectUrl, { redirect: 'manual' })
  if (response.status !== 302) throw new Error(`/connect answered ${response.status}, expected the 302 that mints the API cookie`)
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('/connect minted no cookie')
  return { origin: launch.origin, cookie }
}

/** One Session through the endpoint the web UI's New session button calls. */
export async function createSession(connection, request) {
  const rpcId = crypto.randomUUID()
  const response = await fetch(`${connection.origin}/api/session/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: connection.cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/create', payload: { args: { request } } }),
  })
  if (response.status !== 200) throw new Error(`session/create answered HTTP ${response.status}`)
  const body = await response.json()
  if (body.rpcId !== rpcId) throw new Error(`session/create answered rpcId ${String(body.rpcId)}, sent ${rpcId}`)
  return body.result
}
