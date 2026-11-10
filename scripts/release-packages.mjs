/**
 * The packages this repository publishes, as the build and publish scripts see
 * them.
 *
 * `@4fu/dsh-arbor-testkit` is deliberately absent: it is the proof harness and
 * stays private. The root package stays private too.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** The package directories published by a release. */
export const RELEASE_PACKAGES = Object.freeze([
  // Dependency order: a package is published after everything it names.
  'arbor-prompt',
  'arbor-tools',
  'arbor-llm',
  'arbor-env',
  'arbor-workspace',
  'arbor-preset',
  'arbor-host',
  'arbor-driver',
  'arbor-facts',
  'arbor-ui',
  'arbor-ui-workspace',
  'arbor-bundle',
])

/** Whether a directory exists. */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Every package a release publishes, with its manifest, directory and dist. */
export async function releasePackages() {
  const packages = []
  for (const name of RELEASE_PACKAGES) {
    const directory = join(root, 'packages', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    packages.push({ name: manifest.name, directory, dist: join(directory, 'dist'), manifest })
  }
  return packages
}

/** `tsc` as one package resolves it, so the root needs no TypeScript of its own. */
export function compilerOf(directory) {
  return require.resolve('typescript/bin/tsc', { paths: [directory] })
}

/** Every file under a directory, as paths relative to it, sorted. */
export async function filesUnder(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...(await filesUnder(path)).map(one => join(entry.name, one)))
    else found.push(entry.name)
  }
  return found.sort()
}

/** Whether a package has TypeScript sources to compile. */
export async function hasSources(package_) {
  return exists(join(package_.directory, 'src'))
}
