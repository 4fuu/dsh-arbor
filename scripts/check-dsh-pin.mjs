/**
 * Check that every DeepSeek Harness dependency is the one pinned version.
 *
 * The integration is built against one DSH version (docs/versions.md). A
 * manifest that drifts to another version, or a `^`/`~` range, would make the
 * proof suite test something other than what an installation gets, so this
 * check fails before the install is used.
 *
 * Run: pnpm check:pin
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN = '0.2.2-rc.1'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Every `package.json` whose dependencies are part of the composed tree. */
async function manifests() {
  const files = [join(ROOT, 'package.json'), join(ROOT, 'proofs', 'package.json')]
  const packages = await readdir(join(ROOT, 'packages'), { withFileTypes: true })
  for (const entry of packages) {
    if (entry.isDirectory()) files.push(join(ROOT, 'packages', entry.name, 'package.json'))
  }
  return files
}

/** A DSH package name, as opposed to Cordis or a non-DSH dependency. */
function isDshPackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

const failures = []
const seen = new Set()

for (const file of await manifests()) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!isDshPackage(name)) continue
      if (version !== PIN) failures.push(`${file}: ${section}.${name} is ${version}, expected ${PIN}`)
      seen.add(name)
    }
  }
}

const sections = await readFile(join(ROOT, 'packages', 'arbor-prompt', 'src', 'sections.ts'), 'utf8')
const constant = /export const DSH_PINNED_VERSION = '([^']+)'/.exec(sections)?.[1]
if (constant !== PIN) failures.push(`packages/arbor-prompt/src/sections.ts: DSH_PINNED_VERSION is ${constant ?? 'missing'}, expected ${PIN}`)

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`)
  process.exitCode = 1
} else {
  console.log(`PASS dsh pin: ${seen.size} DSH packages and DSH_PINNED_VERSION are ${PIN}`)
}
