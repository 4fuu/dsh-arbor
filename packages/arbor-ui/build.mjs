/**
 * Build the dsh-arbor-ui browser bundle: `src/client.ts` -> `client.js`.
 *
 * DSH loads a client plugin as a classic script that registers itself with the
 * page's module loader, `window.__ModuleLoader__.load({ id, factory })`, where
 * `factory(require)` is a CommonJS module body whose `require` the loader
 * resolves against the loaded plugin graph. `tsdown` emits that shape inside the
 * DSH monorepo; here `esbuild` bundles `src/client.ts` to CommonJS with every
 * dependency external, and the banner/footer wrap it in the same registration
 * call. The `id` is this package's name, so the loader's `require` and the
 * `dsh.client.inject` graph resolve this plugin and its declared client
 * dependencies (permission-presets) as one client half each.
 *
 * Run: node packages/arbor-ui/build.mjs   (esbuild is a devDependency)
 */

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'))
const id = pkg.name

const banner = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n`
const footer = `\n\t\treturn module.exports;\n\t}\n});\n`

await build({
  entryPoints: [join(here, 'src/client.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Dependencies the page's module loader provides at runtime: React and every
  // DSH client package (resolved per plugin in the loaded graph). Nothing is
  // inlined, so this bundle stays one small registration call.
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@deepseek-ai/*', '@4fu/*'],
  banner: { js: banner },
  footer: { js: footer },
  outfile: join(here, 'client.js'),
  logLevel: 'info',
})

console.log(`built ${id} -> client.js`)
