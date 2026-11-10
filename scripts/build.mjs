/**
 * Build every published package into its `dist` directory.
 *
 * Development runs the TypeScript sources: `pnpm check` typechecks them and the
 * proofs load them from the workspace. A published package cannot do that,
 * because Node refuses to strip types inside `node_modules`, so this script
 * emits JavaScript and declarations. It follows arbor's release build: `tsc`
 * compiles `src` (tests and the browser entry excluded) into `dist`, with
 * `rewriteRelativeImportExtensions` turning the sources' `.ts` imports into
 * `.js` in both the JavaScript and the declarations.
 *
 * The browser halves are different: `client.js` is a DSH module-loader
 * registration built by esbuild, not a Node module. It is regenerated and copied
 * into `dist`, and each package's locale directory and the bundle's patch layer
 * are copied beside it.
 *
 * Run: pnpm build
 */

import { spawnSync } from 'node:child_process'
import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compilerOf, hasSources, releasePackages } from './release-packages.mjs'

/** Files a package ships beside its compiled output, from the package root. */
const ASSETS = {
  '@4fu/dsh-arbor-bundle': ['cordis.patch.yml'],
  '@4fu/dsh-arbor-ui': ['client.js'],
  '@4fu/dsh-arbor-ui-workspace': ['client.js'],
}

/** Browser entries rebuilt with esbuild before they are copied. */
const BROWSER_BUILDS = new Map([
  ['@4fu/dsh-arbor-ui', 'build.mjs'],
  ['@4fu/dsh-arbor-ui-workspace', 'build.mjs'],
])

/** Run one command, and stop the build when it fails. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

/**
 * Point the declarations' relative imports at the emitted JavaScript.
 *
 * `tsc` keeps the sources' `.ts` specifiers in `.d.ts` output even with
 * `rewriteRelativeImportExtensions`; the published package ships only `.js` and
 * `.d.ts`, so a declaration that imports `./routes.ts` would name a file that
 * is not there.
 */
async function rewriteDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await rewriteDeclarations(path)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const source = await readFile(path, 'utf8')
    const rewritten = source.replace(/(['"])(\.{1,2}\/[^'"]+)\.ts\1/g, '$1$2.js$1')
    if (rewritten !== source) await writeFile(path, rewritten)
  }
}

const packages = await releasePackages()
for (const package_ of packages) {
  await rm(package_.dist, { recursive: true, force: true })
  const browser = BROWSER_BUILDS.get(package_.name)
  if (browser !== undefined) run(process.execPath, [browser], package_.directory)
  if (await hasSources(package_)) {
    run(process.execPath, [compilerOf(package_.directory), '-p', 'tsconfig.build.json'], package_.directory)
    await rewriteDeclarations(package_.dist)
  }
  for (const asset of ASSETS[package_.name] ?? []) {
    await cp(join(package_.directory, asset), join(package_.dist, asset), { recursive: true })
  }
  // DSH reads a plugin's localized display text from its exported locale
  // directory: `<pkg>/locale/en.json` and its siblings carry the plugin page's
  // title and description. A package that has one ships it beside the build.
  if (await stat(join(package_.directory, 'locale')).then(() => true, () => false)) {
    await cp(join(package_.directory, 'locale'), join(package_.dist, 'locale'), { recursive: true })
  }
  console.log(`${package_.name}: dist`)
}
console.log(`built ${packages.length} packages`)
