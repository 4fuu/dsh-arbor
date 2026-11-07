/**
 * DSH's skills, as arbor's environment sees them.
 *
 * DSH owns its skill catalog: `ctx.skills` is the layered `SkillRegistry`
 * (`@deepseek-ai/dsh-skill`, `lib/types/index.d.ts`), whose `list` answers with
 * the winning summaries for a working directory and whose `get` loads one
 * skill's body. The shipped `headless` profile mounts the registry plus the
 * filesystem provider (`packages/bundle/base/cordis.patch.yml`, rows `skill`
 * and `skill-filesystem`) and the `skill` tool (`tool-skill`).
 *
 * Arbor's environment is a directory of `SKILL.md` files a window reads at
 * `/env` (`@4fu/arbor-environment-dir`), so a DSH skill is mounted by writing
 * its body to `<env>/skills/<name>/SKILL.md` and listing it with that path. The
 * body is DSH's own — the markdown after its frontmatter — and the description
 * on the listing is DSH's own, carried verbatim rather than restated.
 *
 * What is staged is the instruction file and nothing else: a skill's other
 * files stay where DSH keeps them, and a window reaches them by their absolute
 * path, which every sandbox mode permits reading.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SkillDefinition, SkillSummary } from '@deepseek-ai/dsh-skill'

/** One DSH skill, as this package mounts it. */
export interface DshSkill {
  readonly name: string
  readonly description: string
  /** The skill's markdown body, after its frontmatter. */
  readonly body: string
}

/** What the DSH side of the mount answers with. */
export interface DshSkillSource {
  /** Every model-invocable skill DSH offers for one working directory. */
  list(cwd: string): Promise<readonly SkillSummary[]>
  /** One skill's body, or `undefined` when it is no longer loadable. */
  get(name: string, cwd: string): Promise<SkillDefinition | undefined>
  /** Hear that DSH's skill catalog may have changed; returns the disposer. */
  onChange(listener: () => void): () => void
}

/** The skill source over DSH's own registry. */
export function dshSkillSource(
  skills: {
    list(options?: { cwd?: string }): Promise<readonly SkillSummary[]>
    get(name: string, options?: { cwd?: string }): Promise<SkillDefinition | undefined>
  },
  onChange: (listener: () => void) => () => void,
): DshSkillSource {
  return {
    list: cwd => skills.list({ cwd }),
    get: (name, cwd) => skills.get(name, { cwd }),
    onChange,
  }
}

/**
 * The directory the mounted skills live in, under the environment's own.
 *
 * `<env>/skills/<name>/SKILL.md` is the layout arbor's environment already uses
 * (`@4fu/arbor-environment-dir`, `directory-environment.d.ts`), so a mounted
 * skill sits beside the model's own and arbor's built-in ones and reads the same
 * way.
 */
export function skillDirectory(environmentDirectory: string, name: string): string {
  return join(environmentDirectory, 'skills', name, 'SKILL.md')
}

/** One mounted skill's `SKILL.md`: DSH's frontmatter, then DSH's body. */
export function skillFile(skill: DshSkill): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description.replaceAll('\n', ' ')}\n---\n\n${skill.body}\n`
}

/**
 * Write the current DSH skills into the environment's own directory, and remove
 * the mounted ones that are gone.
 *
 * The environment's directory is the host's own data under `DSH_HOME/arbor`,
 * the same place the journal and the note store live, so it is written with
 * `node:fs` like they are: it is not the session's workspace and the sandbox
 * that fences a window's files does not govern it.
 */
export async function syncSkills(
  environmentDirectory: string,
  skills: readonly DshSkill[],
): Promise<void> {
  const wanted = new Set(skills.map(skill => skill.name))
  const root = join(environmentDirectory, 'skills')
  await mkdir(root, { recursive: true })
  for (const skill of skills) {
    const path = skillDirectory(environmentDirectory, skill.name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, skillFile(skill), 'utf8')
  }
  // A mounted skill DSH no longer offers is removed, so `/env` says what is
  // true now rather than what was true when the process started.
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || wanted.has(entry.name)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
  }
}

/** Read the current DSH skills for one working directory. */
export async function readDshSkills(source: DshSkillSource, cwd: string): Promise<readonly DshSkill[]> {
  const summaries = await source.list(cwd)
  const skills: DshSkill[] = []
  for (const summary of summaries) {
    if (summary.invocation?.modelInvocable === false) continue
    const definition = await source.get(summary.name, cwd)
    skills.push({
      name: summary.name,
      description: summary.description,
      body: definition?.content ?? '',
    })
  }
  return skills
}
