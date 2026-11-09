/**
 * Assemble one session's facts from arbor's own reads.
 *
 * Nothing here computes a fact of its own: the chain is
 * `ArborHostService.windowChainOf`, the live state and tokens are
 * `Arbor.live()`, the lines are `Arbor.boardLines()`, the end reasons and
 * handoffs are the journal's `window_end` events, the board's own line history
 * is the journal's `board_line` events, the workspace facts are the workspace
 * implementation's calls, the active set is `NoteStore.snapshot()`, `/env` is
 * `Environment.list()` plus the journal's `service_state` events, the schedules
 * are `Arbor.schedules()`, and the settings are `Environment.settings()` with
 * the deployment's seed as the fallback. The browser renders exactly these
 * values.
 */

import type { Arbor } from '@4fu/arbor-core'
import type { Event, ScheduledTask, Settings, Workspace } from '@4fu/arbor-interfaces'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionTarget, type ArborHostService } from '@4fu/dsh-arbor-host'
import type {
  ArborBoardFacts,
  ArborEnvFacts,
  ArborEnvItemFacts,
  ArborFacts,
  ArborNotesFacts,
  ArborScheduleFacts,
  ArborOpenWorkFacts,
  ArborSettingsFacts,
  ArborWindowFacts,
  ArborWorkspaceFacts,
} from './types.ts'

/** The parts of the host a build reads, so a test can pass its own. */
export interface FactsHost {
  readonly arborHost: ArborHostService
}

/** Parse one host-owned event body, or an empty object when it has none. */
function body(event: Event): Record<string, unknown> {
  if (event.body === null) return {}
  try {
    const parsed: unknown = JSON.parse(event.body)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** A string field of a host-owned event body. */
function text(event: Event, key: string): string | undefined {
  const value = body(event)[key]
  return typeof value === 'string' ? value : undefined
}

/** The handoff an end recorded, when it recorded one. */
function handoffOf(event: Event): ArborWindowFacts['handoff'] {
  const recorded = body(event)['handoff']
  if (recorded !== true) return undefined
  return { present: true, refs: [...event.refs] }
}

/** One window's own journal events, oldest first. */
async function windowEvents(host: ArborHostService, window: string): Promise<Event[]> {
  const page = await host.journal.list({
    window: window as never,
    kinds: ['window_start', 'window_end', 'board_line'],
    limit: 50,
  })
  return page.items
}

/** The session's windows, oldest first, with the live ones' state attached. */
async function windowsOf(host: ArborHostService, sessionId: SessionId): Promise<{
  windows: ArborWindowFacts[]
  board: ArborBoardFacts[]
}> {
  const chain = await host.windowChainOf(sessionId)
  const live = new Map(host.host.live().map(record => [record.window, record]))
  const lines = new Map(host.host.boardLines().map(line => [line.window, line]))
  const windows: ArborWindowFacts[] = []
  for (const ref of chain) {
    const events = await windowEvents(host, ref)
    const start = events.find(event => event.kind === 'window_start')
    const end = events.find(event => event.kind === 'window_end')
    const lastLine = events.filter(event => event.kind === 'board_line').at(-1)
    const record = live.get(ref)
    const line = lines.get(ref)
    const continuationOf = start === undefined ? undefined : text(start, 'continuation')
    const targets = [...new Set([
      ...(start?.targets ?? []),
      ...(end?.targets ?? []),
      ...(line?.targets ?? []),
    ])]
    windows.push({
      ref,
      state: record?.state ?? 'ended',
      live: record !== undefined && record.state !== 'ended',
      ...(start === undefined ? {} : { startedAt: start.time }),
      ...(end === undefined ? {} : { endedAt: end.time }),
      ...(end === undefined ? {} : { endReason: text(end, 'reason') }),
      ...(record === undefined ? {} : { used: record.usage.used }),
      ...(record === undefined ? {} : { limit: record.usage.limit }),
      ...(record === undefined ? {} : { reserve: record.usage.reserve }),
      ...(line?.doing === undefined && lastLine === undefined
        ? {}
        : { doing: line?.doing ?? (lastLine === undefined ? undefined : text(lastLine, 'doing')) }),
      ...(start === undefined ? {} : { task: text(start, 'task') }),
      targets,
      ...(continuationOf === undefined ? {} : { continuationOf }),
      ...(end === undefined ? {} : { handoff: handoffOf(end) }),
      ...(end === undefined ? {} : { refused: text(end, 'refused') }),
      ...(line?.openWork === undefined ? {} : { openWork: line.openWork }),
    })
  }
  // Attach `continuationOf` to the predecessor as `continuedBy`, which is the
  // only place the chain's link is visible: a continuation's start names its
  // predecessor, the predecessor's end does not name the continuation.
  const byRef = new Map(windows.map(window => [window.ref, window]))
  for (const window of windows) {
    if (window.continuationOf === undefined) continue
    const before = byRef.get(window.continuationOf)
    if (before === undefined) continue
    const updated: ArborWindowFacts = { ...before, continuedBy: window.ref }
    byRef.set(before.ref, updated)
  }
  const board: ArborBoardFacts[] = []
  for (const line of host.host.boardLines()) {
    if (!chain.includes(line.window)) continue
    board.push({
      window: line.window,
      doing: line.doing,
      state: line.state,
      targets: [...line.targets],
      usage: { ...line.usage },
      ...(line.openWork === undefined ? {} : { openWork: [...line.openWork] }),
    })
  }
  return { windows: windows.map(window => byRef.get(window.ref) ?? window), board }
}

/** The workspace facts: the project, the pointers, and what the chain holds open. */
async function workspaceOf(
  host: ArborHostService,
  sessionId: SessionId,
  chain: readonly string[],
): Promise<ArborWorkspaceFacts> {
  const workspace: Workspace = host.workspace
  const cwd = await host.directoryOf(sessionId)
  const project = cwd === undefined ? undefined : host.projects.projectOf(cwd)
  // The chain's own answer: the implementation documents `checkouts(window)` as
  // "the open checkouts of a window's chain", so the newest window is the one to
  // ask, and a chain with nothing open answers nothing.
  const newest = chain.at(-1)
  const checkouts = newest === undefined || workspace.checkouts === undefined
    ? []
    : await workspace.checkouts(newest as never)
  const keeps = newest === undefined || workspace.keeps === undefined
    ? []
    : await workspace.keeps(newest as never)
  const openWork: ArborOpenWorkFacts[] = []
  if (workspace.openWork !== undefined) {
    for (const window of chain) {
      for (const item of await workspace.openWork(window as never)) {
        openWork.push({ window, name: item.name, ...(item.detail === undefined ? {} : { detail: item.detail }) })
      }
    }
  }
  return {
    backend: host.workspaceBackend,
    shared: host.sharedFolder,
    ...(cwd === undefined ? {} : { cwd }),
    ...(project === undefined ? {} : { project: { name: project.name, path: project.path } }),
    pointers: (await host.listArborPointers(sessionId)).map(pointer => ({ name: pointer.name, path: pointer.path })),
    checkouts: checkouts.map(checkout => ({ name: checkout.name, path: checkout.path, dirty: checkout.dirty })),
    keeps: keeps.map(keep => ({ name: keep.name, path: keep.path })),
    openWork,
  }
}

/** Arbor's active note set, exactly the snapshot a new window's prefix carries. */
async function notesOf(host: ArborHostService): Promise<ArborNotesFacts> {
  const snapshot = await host.notes.snapshot()
  return {
    epoch: snapshot.epoch,
    total: snapshot.total,
    tokens: snapshot.tokens,
    budget: { ...snapshot.budget },
    items: snapshot.items.map(note => ({
      ref: note.ref,
      id: note.id,
      title: note.title,
      summary: note.summary,
      revision: note.revision,
      time: note.time,
    })),
  }
}

/** The last state the journal recorded for one service. */
async function serviceState(host: ArborHostService, name: string): Promise<{ state?: string; error?: string }> {
  const page = await host.journal.list({
    kinds: ['service_state'],
    targets: [`svc:${name}`],
    limit: 1,
  })
  const event = page.items.at(-1)
  if (event === undefined) return {}
  return {
    state: text(event, 'state'),
    error: text(event, 'error'),
  }
}

/** Arbor's environment: the skills, MCP servers, services and the settings item. */
async function envOf(host: ArborHostService): Promise<ArborEnvFacts> {
  const environment = host.environment
  const [revision, items] = await Promise.all([environment.revision(), environment.list()])
  const facts: ArborEnvItemFacts[] = []
  for (const item of items) {
    const service = item.kind === 'service' ? await serviceState(host, item.name) : {}
    facts.push({
      kind: item.kind,
      name: item.name,
      description: item.description,
      ...(item.path === undefined ? {} : { path: item.path }),
      revision: item.revision,
      ...(item.builtin === undefined ? {} : { builtin: item.builtin }),
      ...(item.functions === undefined ? {} : { functions: item.functions.map(fn => fn.name) }),
      ...(service.state === undefined ? {} : { state: service.state }),
      ...(service.error === undefined ? {} : { error: service.error }),
    })
  }
  return { revision, mount: environment.mount, directory: environment.directory, items: facts }
}

/** One schedule's repeat rule, flattened to what a line can show. */
function repeatOf(schedule: ScheduledTask): Pick<ArborScheduleFacts, 'everyMs' | 'dailyAt' | 'weekdays'> {
  const repeat = schedule.repeat
  if (repeat === undefined) return {}
  if ('everyMs' in repeat) return { everyMs: repeat.everyMs }
  if ('dailyAt' in repeat) return { dailyAt: repeat.dailyAt }
  return { weekdays: [...repeat.weekdays] }
}

/** The schedules arbor holds, marking the ones that name this session's target. */
async function schedulesOf(host: ArborHostService, sessionId: SessionId): Promise<ArborScheduleFacts[]> {
  const target = sessionTarget(sessionId)
  const schedules = await host.host.schedules()
  return schedules.map(schedule => ({
    ref: schedule.ref,
    ...(schedule.name === undefined ? {} : { name: schedule.name }),
    firstAt: schedule.firstAt,
    nextAt: schedule.nextAt,
    ...(schedule.lastAt === undefined ? {} : { lastAt: schedule.lastAt }),
    ...(schedule.fired === undefined ? {} : { fired: schedule.fired }),
    paused: schedule.paused,
    ...repeatOf(schedule),
    mine: schedule.targets.includes(target),
    targets: [...schedule.targets],
  }))
}

/**
 * Arbor's settings: the environment's own, or the deployment's seed.
 *
 * `DshEnvironment.settings()` answers the seed when `/env/settings.json` is not
 * installed, so the source is read off the environment's item list instead:
 * a `settings` item is what the model's own `reload` installs.
 */
async function settingsOf(host: ArborHostService): Promise<ArborSettingsFacts> {
  const settings: Settings = await host.environment.settings() ?? host.settings
  const installed = (await host.environment.list()).some(item => item.kind === 'settings')
  return {
    source: installed ? 'environment' : 'deployment',
    ...(settings.identity === undefined ? {} : { identity: settings.identity }),
    ...(settings.generalRules === undefined ? {} : { generalRules: [...settings.generalRules] }),
    ...(settings.judge === undefined ? {} : {
      judge: {
        ...(settings.judge.modes === undefined ? {} : { modes: { ...settings.judge.modes } }),
        ...(settings.judge.maxCandidates === undefined ? {} : { maxCandidates: settings.judge.maxCandidates }),
        ...(settings.judge.activeSetJudgeShare === undefined ? {} : { activeSetJudgeShare: settings.judge.activeSetJudgeShare }),
      },
    }),
    ...(settings.modelTiers === undefined ? {} : { modelTiers: { ...settings.modelTiers } }),
    ...(settings.defaultTier === undefined ? {} : { defaultTier: settings.defaultTier }),
    ...(settings.window === undefined ? {} : {
      window: {
        ...(settings.window.idleSeconds === undefined ? {} : { idleSeconds: settings.window.idleSeconds }),
        ...(settings.window.contextTokens === undefined ? {} : { contextTokens: settings.window.contextTokens }),
        ...(settings.window.reserveTokens === undefined ? {} : { reserveTokens: settings.window.reserveTokens }),
        ...(settings.window.protectionSeconds === undefined ? {} : { protectionSeconds: settings.window.protectionSeconds }),
      },
    }),
    ...(settings.notes === undefined ? {} : {
      notes: {
        ...(settings.notes.activeCount === undefined ? {} : { activeCount: settings.notes.activeCount }),
        ...(settings.notes.activeTokenBudget === undefined ? {} : { activeTokenBudget: settings.notes.activeTokenBudget }),
      },
    }),
    ...(settings.schedule === undefined ? {} : {
      schedule: {
        ...(settings.schedule.spreadColliding === undefined ? {} : { spreadColliding: settings.schedule.spreadColliding }),
        ...(settings.schedule.jitterMs === undefined ? {} : { jitterMs: settings.schedule.jitterMs }),
      },
    }),
    ...(settings.workspaces === undefined ? {} : {
      workspaces: {
        ...(settings.workspaces.retentionMs === undefined ? {} : { retentionMs: settings.workspaces.retentionMs }),
        ...(settings.workspaces.shared === undefined ? {} : { shared: settings.workspaces.shared }),
      },
    }),
    ...(settings.secrets === undefined ? {} : { secrets: [...settings.secrets] }),
  }
}

/**
 * Assemble one session's facts.
 *
 * @param host - the one arbor host this DSH process runs.
 * @param sessionId - the DSH session whose chain the facts describe.
 * @param revision - the host's own change counter, carried for the client.
 * @param preset - the agent preset DSH projects for the session, read by the
 *   caller from the session it owns.
 */
export async function buildFacts(
  host: ArborHostService,
  sessionId: SessionId,
  revision: number,
  preset: string,
): Promise<ArborFacts> {
  const { windows, board } = await windowsOf(host, sessionId)
  const chain = windows.map(window => window.ref)
  const [workspace, notes, env, schedules, settings] = await Promise.all([
    workspaceOf(host, sessionId, chain),
    notesOf(host),
    envOf(host),
    schedulesOf(host, sessionId),
    settingsOf(host),
  ])
  return {
    version: 1,
    sessionId,
    revision,
    at: Date.now(),
    preset,
    dataRoot: host.dataRoot,
    windows,
    board,
    workspace,
    notes,
    env,
    schedules,
    settings,
  }
}
