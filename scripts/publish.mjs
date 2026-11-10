/**
 * Pack every release package, or publish the release's packages, from `dist`.
 *
 *   node scripts/publish.mjs                   `npm pack --dry-run` for every package
 *   node scripts/publish.mjs --pack-dir <dir>  write real tarballs into <dir>, as
 *                                              a profile install would receive them
 *   node scripts/publish.mjs --publish         `npm publish` for each package at
 *                                              the release version
 *
 * Development points the package manifests' `exports` at the TypeScript sources
 * because that is what the proofs run. A published package cannot do that:
 * Node refuses to strip types inside `node_modules`. This script writes a
 * manifest of its own into each `dist`, rewrites `exports`, `types` and `main`
 * to the built files, pins every `workspace:*` dependency to the release
 * version, and drops `private`, `scripts` and `devDependencies`.
 *
 * Run `pnpm build` first: publishing packs whatever `dist` holds.
 */

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filesUnder, releasePackages } from './release-packages.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const publish = process.argv.includes('--publish')
const packDirAt = process.argv.indexOf('--pack-dir')
const packDir = packDirAt === -1 ? undefined : process.argv[packDirAt + 1]
if (packDirAt !== -1 && (packDir === undefined || packDir.startsWith('--'))) throw new Error('--pack-dir needs a directory')
if (publish && packDir !== undefined) throw new Error('--publish and --pack-dir are exclusive')
const packages = await releasePackages()
const version = packages[0]?.manifest.version

if (packages.some(package_ => package_.manifest.version !== version)) {
  throw new Error('every release package must carry the same version')
}
if (version === undefined || version === '0.0.0') {
  throw new Error('set the release version with node scripts/set-version.mjs first')
}

/** Whether a path exists. */
async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** A release carries today's date in Asia/Hong_Kong. */
function checkDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: 'numeric',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = type => parts.find(one => one.type === type).value
  const today = `${part('year')}.${part('month')}${part('day')}`
  if (!value.startsWith(`${today}.`)) {
    throw new Error(`version ${value} is not today's date in Asia/Hong_Kong (${today})`)
  }
}

/** A built file for one source specifier. */
function builtPath(specifier, extension) {
  if (specifier === './package.json') return './package.json'
  if (specifier.startsWith('./src/')) return `./${specifier.slice(6).replace(/\.ts$/, '')}.${extension}`
  return specifier
}

/** A published `exports` table, with types for every Node entry. */
function publishExports(exports) {
  const rewritten = {}
  for (const [key, target] of Object.entries(exports ?? {})) {
    if (typeof target !== 'string') {
      rewritten[key] = target
      continue
    }
    if (key === './package.json' || key === './client' || !target.startsWith('./src/')) {
      rewritten[key] = target
      continue
    }
    const base = target.slice(6).replace(/\.ts$/, '')
    rewritten[key] = { types: `./${base}.d.ts`, default: `./${base}.js` }
  }
  return rewritten
}

/** A workspace range becomes the release version; an external one is kept. */
function pin(dependencies) {
  if (dependencies === undefined) return undefined
  const pinned = {}
  for (const [name, range] of Object.entries(dependencies)) {
    pinned[name] = range.startsWith('workspace:') ? version : range
  }
  return pinned
}

/** The manifest one package is published with. */
async function publishManifest(package_, files) {
  const source = package_.manifest
  const manifest = { ...source }
  delete manifest.private
  delete manifest.scripts
  delete manifest.devDependencies
  manifest.exports = publishExports(source.exports)
  if (await exists(join(package_.dist, 'index.d.ts'))) manifest.types = './index.d.ts'
  else delete manifest.types
  if (await exists(join(package_.dist, 'index.js'))) manifest.main = './index.js'
  else delete manifest.main
  manifest.files = files
  const dependencies = pin(source.dependencies)
  if (dependencies === undefined) delete manifest.dependencies
  else manifest.dependencies = dependencies
  const peerDependencies = pin(source.peerDependencies)
  if (peerDependencies === undefined) delete manifest.peerDependencies
  else manifest.peerDependencies = peerDependencies
  return manifest
}

/** Every entry point the package declares, as the file it must have built. */
async function checkBuild(package_) {
  for (const [key, target] of Object.entries(package_.manifest.exports ?? {})) {
    if (key === './package.json' || typeof target !== 'string' || target.includes('*')) continue
    if (!target.startsWith('./src/')) {
      if (!(await exists(join(package_.dist, target.slice(2))))) {
        throw new Error(`${package_.name}: dist is missing ${target}; run pnpm build first`)
      }
      continue
    }
    const file = builtPath(target, 'js')
    if (!(await exists(join(package_.dist, file.slice(2))))) {
      throw new Error(`${package_.name}: dist is missing ${file}; run pnpm build first`)
    }
  }
}

/** Copy the repository README and the package LICENSE into dist. */
async function copyDocuments(package_) {
  await copyFile(join(root, 'README.md'), join(package_.dist, 'README.md'))
  await copyFile(join(package_.directory, 'LICENSE'), join(package_.dist, 'LICENSE'))
}

/**
 * Run npm in one package directory.
 *
 * On Windows npm is a `.cmd` shim, which `CreateProcess` cannot start without a
 * shell: a plain `spawnSync('npm')` returns a null status there and the pack
 * step fails before any tarball exists. The Windows command line goes through
 * cmd.exe instead, and an argument with a space (the pack destination can sit
 * under a profile name) is quoted for it.
 */
function npm(args, cwd) {
  if (process.platform !== 'win32') return spawnSync('npm', args, { cwd, stdio: 'inherit' })
  const line = ['npm.cmd', ...args.map(arg => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)].join(' ')
  return spawnSync(line, { cwd, stdio: 'inherit', shell: true })
}

if (publish) checkDate(version)
if (packDir !== undefined) await mkdir(resolve(packDir), { recursive: true })
console.log(`${publish ? 'publishing' : packDir === undefined ? 'packing' : `packing into ${resolve(packDir)}`} ${packages.length} packages at ${version}`)

for (const package_ of packages) {
  await checkBuild(package_)
  await copyDocuments(package_)
  const files = (await filesUnder(package_.dist)).filter(file => !['package.json', 'README.md', 'LICENSE'].includes(file))
  const manifest = await publishManifest(package_, files)
  await writeFile(join(package_.dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const args = publish ? ['publish', '--access', 'public'] : packDir === undefined ? ['pack', '--dry-run'] : ['pack', '--pack-destination', resolve(packDir)]
  const result = npm(args, package_.dist)
  if (result.status !== 0) throw new Error(`${package_.name}: npm exited with ${result.status}`)
}
