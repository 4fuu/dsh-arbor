/**
 * B1 testkit: boot a DSH profile with the arbor bundle patch, a scripted model
 * and the proof fixtures.
 *
 * `bootArborProfile` loads and composes one shipped DSH profile with overlay
 * patch files, the way `packages/test-support/loader-smoke/tests/fixtures/
 * production-profile.ts` does inside the DSH monorepo, but anchored on the
 * npm-published `@deepseek-ai/dsh` installation instead of `apps/cli`. Every
 * proof in this repository boots through it.
 *
 * The arbor overlay the proofs use is the bundle's own patch file
 * (`@4fu/dsh-arbor-bundle/cordis.patch.yml`), so what a proof boots is exactly
 * what an installed bundle composes.
 */

import { existsSync } from 'node:fs'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfile,
  PluginPackages,
  type ProfileContext,
  type ProfileLayer,
} from '@deepseek-ai/dsh-app-boot'

/** The dsh installation anchor: the published CLI package's own package.json. */
export const installAnchor: string = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')

/** The arbor bundle's patch file, as an overlay path. */
export const arborPatch: string = createRequire(import.meta.url).resolve('@4fu/dsh-arbor-bundle/cordis.patch.yml')

function insertedPluginNames(entries: readonly EntryOptions[]): string[] {
  return entries.flatMap((entry) => {
    const children = entry.group && Array.isArray(entry.config)
      ? insertedPluginNames(entry.config as EntryOptions[])
      : []
    return [entry.name, ...children]
  })
}

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * Overlay-only packages need profile module visibility in plain-Node mode;
 * these synthetic layers contribute no Cordis patches of their own.
 */
function overlayModuleLayers(path: string, patches: readonly PatchOptions[]): ProfileLayer[] {
  const require = createRequire(path)
  const packages = new Map<string, string>()
  const inserted = patches.flatMap(patch => patch.insert ?? [])
  for (const specifier of insertedPluginNames(inserted)) {
    const name = packageName(specifier)
    if (name === undefined || packages.has(name)) continue
    // Probe the require resolution paths for the package directory, the way
    // app-boot's own packageDirFromAnchor does, so a package that does not
    // export ./package.json still resolves.
    for (const searchPath of require.resolve.paths(`${name}/package.json`) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) {
        packages.set(name, candidate)
        break
      }
    }
  }
  return [...packages].map(([name, packageDir], index) => ({
    packageName: `test-overlay:${index}:${name}`,
    packageDir,
    patchPaths: [path],
    patches: [],
  }))
}

/** Inputs for {@link bootArborProfile}. */
export interface ArborProfileOptions {
  /** Diagnostic prefix for profile and Loader failures. */
  readonly binName: string
  /** Shipped profile whose bundle layers form the test tree. */
  readonly profile: string
  /** Overlay patch files, applied above the shipped bundle layers in order. */
  readonly overlayPaths: readonly string[]
  /** Optional host setup before any composed entry mounts. */
  readonly prepare?: (ctx: Context) => Promise<void> | void
}

/**
 * Load and compose one shipped DSH profile with overlay patches.
 * @param options - profile, overlay files, and optional host setup.
 * @returns the settled Loader root context.
 */
export async function bootArborProfile(options: ArborProfileOptions): Promise<Context> {
  for (const path of options.overlayPaths) {
    if (!path.endsWith('.patch.yml')) {
      throw new Error(`${options.binName}: overlay path must end in .patch.yml: ${path}`)
    }
  }
  const profile = loadProfile(options.binName, options.profile, installAnchor, undefined, { userLayer: false })
  const rootConfig = join(profile.dir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')

  const overlays = options.overlayPaths.map(path => loadOverlayPatches(options.binName, path))
  const moduleLayers = options.overlayPaths.flatMap((path, index) => (
    overlayModuleLayers(path, overlays[index] ?? [])
  ))
  const resolution = await createRuntimeResolution({
    installAnchor,
    profile: { ...profile, layers: [...profile.layers, ...moduleLayers] },
  })
  return boot(
    options.binName,
    rootConfig,
    [
      ...profile.layers.flatMap(layer => layer.patches),
      ...overlays.flat(),
    ],
    async (ctx) => {
      const profileContext: ProfileContext = {
        name: options.profile, dir: profile.dir, patchPath: profile.patchPath, installAnchor,
        cwd: process.cwd(), home: process.env['DSH_HOME'] ?? join(tmpdir(), '.dsh'),
        startedBundles: profile.layers.map(layer => layer.packageName),
        overlays: overlays.flat(), telemetryDisabledEnv: process.env['DSH_TELEMETRY_DISABLED'],
      }
      ctx.provide('profileContext', profileContext)
      await ctx.plugin(PluginPackages, { resolution })
      await options.prepare?.(ctx)
    },
  )
}

/** A fresh Harness home under the system temp directory, for one isolated boot. */
export async function freshDshHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-`))
  process.env['DSH_HOME'] = home
  return home
}
