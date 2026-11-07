/**
 * `/env` inside DSH: arbor's own environment, with DSH's skills and MCP servers
 * mounted read-only beside it (docs/environment.md).
 *
 * The environment's home is `<DSH_HOME>/arbor/env`, and it is arbor's own
 * `DirectoryEnvironment`: the settings at `/env/settings.json`, arbor's built-in
 * skills, and everything the model installs itself with `reload` all keep
 * working exactly as they do in any other deployment.
 *
 * What this package adds is DSH's side of the world:
 *
 *  - **DSH's skills** are read from `ctx.skills`, DSH's own layered registry,
 *    and mounted by writing each one's body to `<env>/skills/<name>/SKILL.md`.
 *    The model sees them in `<env>` with that path and reads them with `read`;
 *    they are read-only, because a change goes through DSH, not through arbor's
 *    `reload`.
 *  - **DSH's MCP servers** are listed from the tools DSH publishes under the
 *    `mcp__<server>__<tool>` names. Their tools stay DSH tools — the tool bridge
 *    brings them in as external tools — so the item declares no functions and no
 *    arbor MCP module is created for it. Duplicating them as modules would give
 *    the model two ways to call the same tool.
 *
 * The mount is live: `skills/change` re-reads DSH's catalog, so a skill a DSH
 * plugin adds or removes reaches `/env` without a restart.
 */

import type {
  EnvDelta,
  EnvDraft,
  EnvItem,
  EnvItemKind,
  EnvItemName,
  EnvItemRef,
  EnvRef,
  EnvRevision,
  EnvValidation,
  Environment,
  Settings,
} from '@4fu/arbor-interfaces'
import { arborError } from '@4fu/arbor-errors'
import { textOf, type TextArgs } from '@4fu/arbor-prompt'
import { DirectoryEnvironment } from '@4fu/arbor-environment-dir'
import { readDshSkills, syncSkills, type DshSkill, type DshSkillSource } from './skills.ts'
import { serversOfToolNames, type DshServer } from './servers.ts'
import { dshEnvText } from './text.ts'

/** What this package needs from the DSH process it runs in. */
export interface DshEnvironmentOptions {
  /** The environment arbor's own items live in, rooted under `DSH_HOME/arbor`. */
  readonly inner: DirectoryEnvironment
  /** DSH's own skill registry, and how to hear that it moved. */
  readonly skills: DshSkillSource
  /** Every tool name DSH publishes, for the MCP servers among them. */
  readonly toolNames: () => readonly string[]
  /** The working directory DSH's skills are read for. Defaults to the host's. */
  readonly cwd?: () => string
  /**
   * The settings the host runs with until the model installs its own at
   * `/env/settings.json`.
   *
   * Arbor reads its identity, general rules, judge and model tiers from the
   * environment once one is mounted, and answers `undefined` until a settings
   * item is installed — which would leave a window with no identity at all. The
   * deployment's own settings are the seed, so a fresh `DSH_HOME` behaves
   * exactly as it did before `/env` existed, and the model's own install
   * replaces them the moment it makes one.
   */
  readonly seedSettings?: Settings
}

export class DshEnvironment implements Environment {
  private readonly inner: DirectoryEnvironment
  private readonly skills: DshSkillSource
  private readonly toolNames: () => readonly string[]
  private readonly cwd: () => string
  private readonly seed: Settings | undefined

  /** The mounted DSH skills and MCP servers, read the last time `list` ran. */
  private mounted: { skills: readonly DshSkill[]; servers: readonly DshServer[] } = { skills: [], servers: [] }
  /** The names DSH owns, which arbor's own `reload` may not touch. */
  private owned = new Set<string>()
  /** Set while this package is writing the mount, so a re-read is not recursive. */
  private syncing = false

  constructor(options: DshEnvironmentOptions) {
    this.inner = options.inner
    this.skills = options.skills
    this.toolNames = options.toolNames
    this.cwd = options.cwd ?? (() => process.cwd())
    this.seed = options.seedSettings
    // DSH's catalog moving re-reads it, so a skill a plugin adds or removes
    // reaches `/env` without a restart.
    this.skills.onChange(() => {
      if (this.syncing) return
      void this.refresh().catch(() => {})
    })
  }

  /** The shared mount every window reads `/env` through. */
  get mount(): string {
    return this.inner.mount
  }

  /** The directory the mount is, on the host, which the file tools read. */
  get directory(): string {
    return this.inner.directory
  }

  /** Every item: arbor's own, then DSH's mounted ones. */
  async list(): Promise<readonly EnvItem[]> {
    await this.refresh()
    return [...await this.inner.list(), ...this.dshItems()]
  }

  /** Re-read DSH's skills and MCP servers, and write the mount. */
  async refresh(): Promise<void> {
    this.syncing = true
    try {
      const cwd = this.cwd()
      const skills = await readDshSkills(this.skills, cwd)
      const servers = serversOfToolNames(this.toolNames())
      await syncSkills(this.inner.directory, skills)
      this.mounted = { skills, servers }
      this.owned = new Set([
        ...skills.map(skill => `skill:${skill.name}`),
        ...servers.map(server => `mcp:${server.name}`),
      ])
    } finally {
      this.syncing = false
    }
  }

  /** The items DSH owns, as arbor's environment lists them. */
  private dshItems(): readonly EnvItem[] {
    const items: EnvItem[] = []
    for (const skill of this.mounted.skills) {
      items.push({
        ref: `dsh:skill:${skill.name}` as EnvItemRef,
        kind: 'skill',
        name: skill.name as EnvItemName,
        description: this.text('env.dsh.skill', {
          name: skill.name,
          description: skill.description,
          path: `${this.mount}/skills/${skill.name}/SKILL.md`,
        }),
        path: `${this.mount}/skills/${skill.name}/SKILL.md`,
        revision: 1,
        time: 0,
        builtin: true,
      })
    }
    for (const server of this.mounted.servers) {
      items.push({
        ref: `dsh:mcp:${server.name}` as EnvItemRef,
        kind: 'mcp',
        name: server.name as EnvItemName,
        description: server.tools.length === 0
          ? this.text('env.dsh.server.notools', { name: server.name })
          : this.text('env.dsh.server', { name: server.name, tools: server.tools.join('、') }),
        // No functions: the tools stay DSH tools, and an arbor MCP module here
        // would be a second way to call the same thing.
        functions: [],
        revision: 1,
        time: 0,
        builtin: true,
      })
    }
    return items
  }

  /** The revisions, arbor's own: a mounted item has none of its own to give. */
  async history(item?: EnvItemRef | EnvItemName): Promise<readonly EnvRevision[]> {
    return this.inner.history(item)
  }

  /**
   * The settings: the model's own from `/env/settings.json` once it installs
   * one, and the deployment's seed until then.
   */
  async settings(): Promise<Settings | undefined> {
    return (await this.inner.settings()) ?? this.seed
  }

  /**
   * Validate drafts, refusing the whole call when one names an item DSH owns.
   *
   * Everything else is the inner environment's own validation, so a skill
   * parses and an MCP server starts and lists its functions exactly as it does
   * in any other deployment.
   */
  async validate(drafts: readonly EnvDraft[]): Promise<EnvValidation> {
    const taken = this.takenBy(drafts)
    if (taken.length === 0) return this.inner.validate(drafts)
    return {
      ok: false,
      items: drafts.map(draft => ({
        name: draft.name,
        ok: false,
        error: this.readonly(draft.kind, draft.name),
      })),
    }
  }

  /** Install drafts, refusing one that names an item DSH owns. */
  async install(drafts: readonly EnvDraft[], remove?: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision> {
    this.refuseTaken([
      ...drafts.map(draft => `${draft.kind}:${draft.name}`),
      ...this.namedBy(remove),
    ])
    return this.inner.install(drafts, remove)
  }

  /** Remove items, refusing one that names an item DSH owns. */
  async remove(items: readonly (EnvItemRef | EnvItemName)[]): Promise<EnvRevision> {
    this.refuseTaken(this.namedBy(items))
    return this.inner.remove(items)
  }

  /** What changed since a revision. DSH's mounted items never change one. */
  async delta(since: EnvRef): Promise<EnvDelta> {
    return this.inner.delta(since)
  }

  /** The revision the environment stands at, arbor's own. */
  async revision(): Promise<EnvRef> {
    return this.inner.revision()
  }

  /** Start every installed service again, after a host restart. */
  async resume(): Promise<void> {
    await this.refresh().catch(() => {})
    return this.inner.resume()
  }

  /**
   * Call one function of an installed MCP server.
   *
   * A mounted DSH server has no functions here — its tools are DSH tools and
   * run through the tool bridge — so a call naming one is refused rather than
   * silently sent somewhere else.
   */
  async call(server: string, fn: string, args: Record<string, unknown>): Promise<string> {
    if (this.mounted.servers.some(one => one.name === server)) {
      throw arborError({
        code: 'invalid',
        rule: 'env.dsh.server.not_a_module',
        message: this.text('refused.env.dsh.readonly', { kind: 'MCP 服务器', name: server }),
        nextAction: this.text('next.env.dsh.readonly'),
      })
    }
    return this.inner.call(server, fn, args)
  }

  /** One refusal naming an item DSH owns, in this package's own words. */
  private readonly(kind: EnvItemKind, name: string) {
    return arborError({
      code: 'invalid',
      rule: 'env.dsh.readonly',
      message: this.text('refused.env.dsh.readonly', { kind: kindLabel(kind), name }),
      nextAction: this.text('next.env.dsh.readonly'),
    })
  }

  /** One fixed string, from this package's own table. */
  private text(key: string, args: TextArgs = {}): string {
    return textOf(dshEnvText, key, args, key)
  }

  /** The drafts whose names DSH owns, as `kind:name` entries. */
  private takenBy(drafts: readonly EnvDraft[]): string[] {
    return drafts.map(draft => `${draft.kind}:${draft.name}`).filter(name => this.owned.has(name))
  }

  /** The item names a removal list names, as `kind:name` entries. */
  private namedBy(items: readonly (EnvItemRef | EnvItemName)[] | undefined): string[] {
    if (items === undefined) return []
    const names: string[] = []
    for (const item of items) {
      const text = String(item)
      for (const candidate of [text, ...kinds().map(kind => `${kind}:${text}`)]) {
        if (this.owned.has(candidate)) names.push(candidate)
      }
    }
    return names
  }

  /** Refuse a call that would change an item DSH owns. */
  private refuseTaken(taken: readonly string[]): void {
    const first = taken[0]
    if (first === undefined) return
    const [kind, name] = first.split(':')
    throw this.readonly(kind as EnvItemKind, name ?? '')
  }
}

/** Every item kind, for reading a bare name a removal list may carry. */
function kinds(): readonly EnvItemKind[] {
  return ['skill', 'mcp', 'service', 'settings']
}

/** One kind, as the refusal names it. */
function kindLabel(kind: EnvItemKind): string {
  return kind === 'mcp' ? 'MCP 服务器' : kind === 'skill' ? '技能' : kind === 'service' ? '服务' : '设置'
}

export { dshEnvText } from './text.ts'
export {
  readDshSkills,
  syncSkills,
  skillDirectory,
  skillFile,
  dshSkillSource,
  type DshSkill,
  type DshSkillSource,
} from './skills.ts'
export { serversOfToolNames, serverOfToolName, type DshServer } from './servers.ts'
