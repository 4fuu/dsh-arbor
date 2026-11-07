/**
 * Proof 12: an official DSH prompt section the decision table does not decide
 * fails the proof.
 *
 * The table in `@4fu/dsh-arbor-prompt` is pinned to one DSH version. Upgrading
 * DSH can register a section name the table has never seen, and the failure mode
 * that matters is not a crash — it is a new section quietly reaching the model,
 * or quietly not reaching it, because nobody decided which. So the proof has two
 * halves:
 *
 *  1. **The pinned DSH's own registrations.** Every `systemPrompt.section` and
 *     `systemPrompt.context` registration in the installed `@deepseek-ai/*`
 *     packages is read out of their sources and checked against the table. This
 *     is the half that catches a package the booted profile does not load — a
 *     terminal bundle, a live-share row, a computer-use family — which a boot
 *     alone would never show.
 *  2. **What the shipped profile actually assembles.** A live boot assembles
 *     DSH's prompt, with the MCP fixture and the third-party section mounted,
 *     and checks every name that reached the assembly is decided. This is the
 *     half that catches a row a deployment composes that the static scan cannot
 *     see.
 *
 * Both halves fail on the same condition: a name the table makes no decision
 * for. The proof then registers one such name itself and shows the test would
 * have caught it.
 *
 * Run: pnpm proof:sections
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { installFailLoud, loadEnv } from '@deepseek-ai/dsh-app-boot'
import {
  SCRIPTED_SELECTION,
  arborPatch,
  bootArborProfile,
  finishProof,
  freshDshHome,
  installAnchor,
  scriptedLlm,
} from '../packages/arbor-testkit/src/index.ts'
import {
  DSH_OFFICIAL_SECTION_PREFIXES,
  DSH_PINNED_VERSION,
  DSH_SECTION_DECISIONS,
  DSH_SECTION_PREFIX_DECISIONS,
  decideSection,
  decisionFor,
  isOfficialSection,
} from '../packages/arbor-prompt/src/index.ts'

const NAME = 'arbor-spike-proof-12'
const arborOverlay = fileURLToPath(new URL('../patches/arbor.patch.yml', import.meta.url))
const scriptedOverlay = fileURLToPath(new URL('../patches/scripted.patch.yml', import.meta.url))
const mcpOverlay = fileURLToPath(new URL('../patches/mcp.patch.yml', import.meta.url))

const failures: string[] = []
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${detail}`)
  if (!ok) failures.push(label)
}

/**
 * Every `name:` value one registration call site passes.
 *
 * A registration is a `systemPrompt.section({...})` or
 * `systemPrompt.context({...})` call, so the scan walks each package's `lib`
 * tree, finds those calls, and reads the `name:` field inside them. Both the
 * literal form (`name: "tool:bash"`) and the built form
 * (`name: \`tool:${toolName}\``) are recognised; a built name is recorded as the
 * prefix before the first `${`, which is the part of it the table can decide.
 */
function registeredNames(source: string): readonly string[] {
  const names: string[] = []
  const call = /\.(section|context)\(\{/g
  for (let at = call.exec(source); at !== null; at = call.exec(source)) {
    // The call's argument object ends at the matching close brace; the name
    // field is inside it, and a nested object is the only thing that can put a
    // brace between them.
    const open = source.indexOf('{', at.index)
    let depth = 0
    let end = open
    for (let index = open; index < source.length; index++) {
      if (source[index] === '{') depth++
      else if (source[index] === '}') {
        depth--
        if (depth === 0) { end = index; break }
      }
    }
    const body = source.slice(open, end)
    const literal = /\bname:\s*"([^"]+)"/.exec(body)
    if (literal?.[1] !== undefined) {
      names.push(literal[1])
      continue
    }
    const built = /\bname:\s*`([^`]*)`/.exec(body)
    if (built?.[1] !== undefined) names.push(built[1].split('${')[0] ?? '')
  }
  return names
}

/** Every official name the installed DSH packages register, by package. */
function scanDshRegistrations(): Map<string, readonly string[]> {
  // The published packages live in pnpm's virtual store, one directory per
  // package. The testkit's own anchor resolves the shipped CLI package, which
  // is what puts the store root five levels above it.
  const anchor = installAnchor
  const store = join(anchor, '..', '..', '..', '..', '..')
  const found = new Map<string, readonly string[]>()
  if (!existsSync(store)) return found
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('@deepseek-ai+dsh-')) continue
    const packageDir = join(store, entry, 'node_modules', '@deepseek-ai', entry.slice('@deepseek-ai+'.length).split('@')[0] ?? '')
    const lib = join(packageDir, 'lib')
    if (!existsSync(lib)) continue
    const names = new Set<string>()
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, item.name)
        if (item.isDirectory()) { walk(path); continue }
        if (!item.name.endsWith('.js') || item.name.endsWith('.d.ts')) continue
        for (const name of registeredNames(readFileSync(path, 'utf8'))) names.add(name)
      }
    }
    walk(lib)
    if (names.size > 0) found.set(entry.slice('@deepseek-ai+'.length).split('@')[0] ?? entry, [...names].sort())
  }
  return found
}

async function main(): Promise<void> {
  check('the table is pinned to the DSH this repository runs',
    DSH_PINNED_VERSION === '0.2.2-rc.1', `pinned to ${DSH_PINNED_VERSION}`)

  // ---- half 1: the pinned DSH's own registrations ---------------------------
  const registrations = scanDshRegistrations()
  check('the DSH packages were scanned', registrations.size > 5,
    `packages with prompt registrations: ${registrations.size}`)
  const undecided: string[] = []
  const decided = new Map<string, string>()
  const exact = new Set(Object.keys(DSH_SECTION_DECISIONS))
  for (const [packageName, names] of registrations) {
    for (const name of names) {
      if (name === '') continue
      // A name built from a template (`tool:${toolName}`) is recorded as the
      // literal part before the placeholder, so it ends in a colon. Such a
      // registration is decided when the table decides at least one exact name
      // under its prefix: the tool names that package can register are each
      // decided on their own.
      if (name.endsWith(':')) {
        const prefixDecision = decisionFor(name)
        if (prefixDecision !== undefined) {
          decided.set(name, `${prefixDecision}, decided for the whole prefix (${packageName})`)
          continue
        }
        if ([...exact].some(one => one.startsWith(name))) {
          decided.set(name, `templated, decided per name (${packageName})`)
          continue
        }
        undecided.push(`${packageName}: ${name}<name>`)
        continue
      }
      const decision = decisionFor(name)
      if (decision === undefined) {
        undecided.push(`${packageName}: ${name}`)
        continue
      }
      decided.set(name, `${decision} (${packageName})`)
    }
  }
  check('every official name the pinned DSH registers is decided by the table',
    undecided.length === 0, `undecided: ${undecided.length === 0 ? 'none' : undecided.join(', ')}`)

  // The scan must also agree with the table about what is official: a name the
  // table decides but the prefixes do not call official would be third-party
  // material wearing an official decision.
  const notOfficial = [...decided.keys()].filter(name => !isOfficialSection(name))
  check('every decided name is one the official prefixes cover',
    notOfficial.length === 0, `not official: ${notOfficial.length === 0 ? 'none' : notOfficial.join(', ')}`)

  // A third-party name must never be decided as anything but `outside`, and the
  // prefixes must not swallow it.
  check('a third-party name is outside material',
    decideSection('acme:policy') === 'outside' && !isOfficialSection('acme:policy'),
    `acme:policy decides ${decideSection('acme:policy')}, official=${isOfficialSection('acme:policy')}`)
  const uncoveredPrefixes = Object.keys(DSH_SECTION_PREFIX_DECISIONS)
    .filter(prefix => !DSH_OFFICIAL_SECTION_PREFIXES.includes(prefix))
  check('every prefix the table decides is an official prefix',
    uncoveredPrefixes.length === 0,
    `uncovered: ${uncoveredPrefixes.length === 0 ? 'none' : uncoveredPrefixes.join(', ')}`)
  check('the table decides the names the pinned DSH registers',
    decided.size > 20, `decided names: ${decided.size}`)

  // ---- half 2: what the shipped profile actually assembles ------------------
  await freshDshHome('arbor-spike')
  loadEnv(NAME)
  const ctx = await bootArborProfile({
    binName: NAME,
    profile: 'headless',
    overlayPaths: [arborPatch, arborOverlay, scriptedOverlay, mcpOverlay],
  })
  try {
    const sessionId = brandString<SessionId>(`session-${randomUUID()}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd(), agentPreset: 'arbor' },
      agentOptions: { ...SCRIPTED_SELECTION } as AgentOptions,
      setup: (agentCtx) => { installModelSelection(agentCtx) },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const names = [...assembly.sections.map(section => section.name), ...assembly.contexts.map(context => context.name)]
    console.log(`assembled names: ${names.join(', ')}`)
    // Only an official name has to be decided: a third party's section is
    // outside material by definition, and the table's job for it is to say so.
    const liveUndecided = names.filter(name => name !== '' && isOfficialSection(name) && decisionFor(name) === undefined)
    check('every name the shipped profile assembles is decided by the table',
      liveUndecided.length === 0, `undecided: ${liveUndecided.length === 0 ? 'none' : liveUndecided.join(', ')}`)
    check('the assembly carries both official and third-party names',
      names.some(name => isOfficialSection(name)) && names.some(name => !isOfficialSection(name)),
      `official: ${names.filter(isOfficialSection).length}, third-party: ${names.filter(name => !isOfficialSection(name)).length}`)
    check('every third-party name in the assembly is outside material',
      names.filter(name => !isOfficialSection(name)).every(name => decideSection(name) === 'outside'),
      `third-party: ${names.filter(name => !isOfficialSection(name)).join(', ')}`)

    // A name nobody decided is exactly what the test is for, so the proof
    // registers one and runs the same predicate over it: the guard is not
    // passing because it never looks. `tool:brand_new` is an official name —
    // `tool:` is a registered prefix — and the table decides no such tool.
    const unregister = ctx.systemPrompt.section({
      name: 'tool:brand_new',
      order: 9_500,
      text: 'a tool section a newer DSH would register',
    })
    const extended = await ctx.systemPrompt.assemble({ agent, scope: agent })
    const extendedNames = [
      ...extended.sections.map(section => section.name),
      ...extended.contexts.map(context => context.name),
    ]
    const newlyUndecided = extendedNames
      .filter(name => name !== '' && isOfficialSection(name) && decisionFor(name) === undefined)
    check('an official name the table does not decide is detected',
      newlyUndecided.includes('tool:brand_new')
      && !names.includes('tool:brand_new'),
      `newly undecided: ${newlyUndecided.join(', ') || 'none'}`)
    unregister()
  } finally {
    await ctx.fiber.dispose()
  }
}

const uninstallFailLoud = installFailLoud(NAME)
try {
  await main()
} catch (error: unknown) {
  console.error(error)
  failures.push(`exception: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  uninstallFailLoud()
}
finishProof('PROOF 12', failures)
