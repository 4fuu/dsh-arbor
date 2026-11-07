#!/usr/bin/env node
/**
 * A functional stand-in for the `ovnfs` binary, for the proofs.
 *
 * The real ovnfs is a copy-on-write daemon pinned at v0.1.1; it is not
 * installed in the proof environment, so `openWorkspace` would fall back to the
 * plain-directory workspace and the checkout/apply flow could not be exercised.
 * This script implements the exact `ctl` admin protocol `@4fu/arbor-workspace-ovnfs`'s
 * `OvnfsCli` speaks (`--json start`, `ctl ls|new|diff|apply|rm`, `version`), so
 * arbor's own `OvnfsWorkspace` and `OvnfsWorkspaceGroup` run unmodified against
 * it. It is a fixture, not production code: a checkout is a real recursive copy
 * of the project subfolder under the mount, `diff` compares it to a base
 * snapshot, and `apply` copies the changed files back into the shared folder.
 * It records its index under the `--state` directory.
 *
 * A proof puts a directory holding this executable (named `ovnfs`) first on
 * PATH before it boots, so `openWorkspace` finds it and chooses the ovnfs
 * backend; see `useOvnfsStub` in the testkit.
 */

import { execFileSync } from 'node:child_process'
import {
  cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/** Parse `--state <s> --mount <m>` and the trailing command from argv. */
function parse(argv) {
  const values = { state: '', mount: '' }
  let i = 0
  while (i < argv.length && argv[i].startsWith('--')) {
    const key = argv[i].slice(2)
    if (key === 'json') { i += 1; continue }
    values[key] = argv[i + 1]
    i += 2
  }
  return { values, command: argv.slice(i) }
}

async function walk(root) {
  const files = []
  const dirs = []
  const recurse = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { dirs.push(full); await recurse(full) }
      else if (entry.isFile()) files.push(full)
    }
  }
  await recurse(root)
  return { files, dirs }
}

/** Copy src to dst, replacing dst. Skips nothing: a `.git` directory travels. */
async function replaceCopy(src, dst) {
  await rm(dst, { recursive: true, force: true })
  await cp(src, dst, { recursive: true })
}

/** The changed paths of a checkout relative to its base snapshot. */
async function changesOf(checkoutPath, basePath) {
  const changes = []
  const baseFiles = new Set(
    existsSync(basePath) ? (await walk(basePath)).files.map(f => relative(basePath, f)) : [],
  )
  const checkoutFiles = new Set((await walk(checkoutPath)).files.map(f => relative(checkoutPath, f)))
  for (const rel of checkoutFiles) {
    const a = await readFile(join(checkoutPath, rel))
    const b = existsSync(join(basePath, rel)) ? await readFile(join(basePath, rel)) : null
    if (b === null || !a.equals(b)) changes.push({ path: rel, status: b === null ? 'added' : 'modified' })
  }
  for (const rel of baseFiles) {
    if (!checkoutFiles.has(rel)) changes.push({ path: rel, status: 'removed' })
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path))
}

async function indexFile(state) {
  return join(state, 'index.json')
}

async function readIndex(state) {
  try { return JSON.parse(await readFile(await indexFile(state), 'utf8')) }
  catch { return {} }
}

async function writeIndex(state, index) {
  await writeFile(await indexFile(state), JSON.stringify(index), 'utf8')
}

async function main() {
  const { values, command } = parse(process.argv.slice(2))
  const { state, mount } = values
  await mkdir(state, { recursive: true })
  await mkdir(mount, { recursive: true })

  const reply = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0) }
  const fail = (message) => { process.stderr.write(message); process.exit(1) }

  if (command[0] === 'version') { process.stdout.write('0.1.1'); process.exit(0) }

  if (command[0] === 'start') {
    reply({
      version: 1, pid: process.pid, proto: 'http', port: 0,
      mount, state, socket: '', checkouts: Object.keys(await readIndex(state)).length,
    })
  }

  if (command[0] !== 'ctl') fail(`ovnfs-stub: unknown command ${command.join(' ')}`)
  const op = command[1]
  const args = command[2] === undefined ? {} : JSON.parse(command[2])
  const index = await readIndex(state)

  if (op === 'ls') {
    const checkouts = []
    for (const [name, record] of Object.entries(index)) {
      const dirty = (await changesOf(record.path, record.base)).length > 0
      checkouts.push({ name, path: record.path, source: record.source, base: record.base, git: record.git, dirty })
    }
    reply({ checkouts, snapshots: [] })
  }

  if (op === 'new') {
    const name = args.name
    const source = resolve(args.dir)
    if (!existsSync(source)) fail(`ovnfs-stub: no source dir ${source}`)
    const path = join(mount, name)
    const base = join(state, 'base', name)
    await replaceCopy(source, path)
    await replaceCopy(source, base)
    const record = { name, path, source, base, git: existsSync(join(source, '.git')) }
    index[name] = record
    await writeIndex(state, index)
    reply({ checkout: { ...record, dirty: false }, warnings: [] })
  }

  if (op === 'diff') {
    const record = index[args.checkout]
    if (record === undefined) fail(`ovnfs-stub: no checkout ${args.checkout}`)
    reply({ from: record.base, changes: await changesOf(record.path, record.base) })
  }

  if (op === 'apply') {
    const record = index[args.checkout]
    if (record === undefined) fail(`ovnfs-stub: no checkout ${args.checkout}`)
    const changes = await changesOf(record.path, record.base)
    const applied = []
    for (const change of changes) {
      const from = join(record.path, change.path)
      const to = join(record.source, change.path)
      if (change.status === 'removed') { await rm(to, { force: true }) }
      else { await mkdir(join(to, '..'), { recursive: true }); await cp(from, to) }
      applied.push({ path: change.path, status: change.status })
    }
    // A branch apply would move commits; the stand-in only moves files, so it
    // reports no branch and re-snapshots the base to the applied state.
    await replaceCopy(record.source, record.base)
    reply({
      snapshot: { id: `snap-${args.checkout}`, checkout: args.checkout },
      source: record.source, applied, merged: [], conflicts: [],
    })
  }

  if (op === 'rm') {
    const record = index[args.checkout]
    if (record !== undefined) {
      await rm(record.path, { recursive: true, force: true })
      await rm(record.base, { recursive: true, force: true })
      delete index[args.checkout]
      await writeIndex(state, index)
    }
    reply({})
  }

  fail(`ovnfs-stub: unknown op ${op}`)
}

main().catch(error => { process.stderr.write(String(error?.stack ?? error)); process.exit(1) })
