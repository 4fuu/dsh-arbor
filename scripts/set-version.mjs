/**
 * Set the release version on every published package.
 *
 *   node scripts/set-version.mjs 2026.1110.0
 *
 * Versions use `YYYY.MDD.REVISION`, with the date in `Asia/Hong_Kong`; the
 * month is unpadded and the day is two digits. This repository has no earlier
 * npm release, so every published package takes the version. The private
 * `@4fu/dsh-arbor-testkit` and the root package are not touched.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { releasePackages } from './release-packages.mjs'

const PATTERN = /^(\d{4})\.(\d{3,4})\.(\d+)$/
const [version] = process.argv.slice(2)
if (version === undefined || process.argv.length !== 3) {
  throw new Error('usage: node scripts/set-version.mjs <YYYY.MDD.REVISION>')
}
const match = PATTERN.exec(version)
if (match === null) throw new Error('version must use YYYY.MDD.REVISION, for example 2026.1110.0')
const month = Number.parseInt(match[2].slice(0, -2), 10)
const day = Number.parseInt(match[2].slice(-2), 10)
const date = new Date(Date.UTC(Number(match[1]), month - 1, day))
if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
  throw new Error(`invalid calendar version ${version}: no such date`)
}
if (match[2] !== `${month}${String(day).padStart(2, '0')}`) {
  throw new Error('the month must be unpadded and the day two digits')
}

for (const package_ of await releasePackages()) {
  const manifest = { ...package_.manifest, version }
  await writeFile(join(package_.directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`${package_.name}: ${version}`)
}
console.log(`set ${(await releasePackages()).length} packages to ${version}`)
