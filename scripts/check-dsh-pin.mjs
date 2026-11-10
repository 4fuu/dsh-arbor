/**
 * Check that every DeepSeek Harness dependency is the one pinned version, and
 * that a published package never carries a DSH runtime package as a dependency.
 *
 * The integration is built against one DSH version (docs/versions.md). A
 * manifest that drifts to another version, or a `^`/`~` range, would make the
 * proof suite test something other than what an installation gets, so this
 * check fails before the install is used.
 *
 * A DSH runtime package (Cordis and every `dsh-*` package) may only be a
 * `peerDependency` in a published package, mirrored by a `devDependency` for
 * the checkout. Declaring one as a `dependency` installs a second copy into a
 * DSH profile; DSH's profile resolver then routes arbor's imports to that copy
 * while DSH keeps using its own, and classes, services and scoped contexts stop
 * matching. `@deepseek-ai/schemastery` is a library, not a DSH runtime module:
 * it has no service of its own and brands its schemas with a process-global
 * symbol, so it stays a plain dependency.
 *
 * Run: pnpm check:pin
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PIN = '0.2.2-rc.1'
const CORDIS_PIN = '4.1.0'
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

/** A package DSH itself loads: Cordis or one of the `dsh-*` packages. */
function isDshRuntime(name) {
  return name === '@deepseek-ai/cordis' || name.startsWith('@deepseek-ai/cordis-') || isDshPackage(name)
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
      if (isDshPackage(name)) {
        if (version !== PIN) failures.push(`${file}: ${section}.${name} is ${version}, expected ${PIN}`)
        seen.add(name)
      }
      if (name === '@deepseek-ai/cordis' && version !== CORDIS_PIN) {
        failures.push(`${file}: ${section}.${name} is ${version}, expected ${CORDIS_PIN}`)
      }
    }
  }
  // DSH reads `engines.dsh` as the plugin runtime requirement. Every package
  // under packages/ is loaded by DSH; the proof harness is not a plugin.
  if (file.includes(`${sep}packages${sep}`) && manifest.engines?.dsh !== PIN) {
    failures.push(`${file}: engines.dsh is ${String(manifest.engines?.dsh)}, expected ${PIN}`)
  }
  // Only a published package reaches a profile. The private proof harness and
  // the root manifest may keep a DSH package as a plain dependency.
  if (file.includes(`${sep}packages${sep}`) && manifest.private !== true) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (isDshRuntime(name)) {
        failures.push(
          `${file}: dependencies.${name} is ${version}: a DSH runtime package must be a peerDependency, ` +
            'mirrored in devDependencies, so a profile install does not add a second copy',
        )
      }
    }
    for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.devDependencies?.[name] !== version) {
        failures.push(`${file}: peerDependencies.${name} is ${version} but devDependencies does not mirror it`)
      }
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
  console.log(`PASS dsh pin: ${seen.size} DSH packages, every engines.dsh and DSH_PINNED_VERSION are ${PIN}, no DSH runtime package is a dependency`)
}
