/**
 * Assemble one session's facts from arbor's own reads.
 *
 * Nothing here computes a fact of its own: the chain is
 * `ArborHostService.windowChainOf`, the live state is `Arbor.live()`, the usage
 * is the journal's `usage` and `run_ended` events (a window's record is gone
 * once it ends, its journal is not), the lines are `Arbor.boardLines()`, the
 * end reasons and handoffs are the journal's `window_end` events, a refused
 * `end` is the journal's `tool_result` for its `tool_call`, the board's own
 * line history is the journal's `board_line` events, the workspace facts are
 * the workspace implementation's calls, the active set is
 * `NoteStore.snapshot()`, `/env` is `Environment.list()` plus the journal's
 * `service_state` events, the schedules are `Arbor.schedules()`, and the
 * settings are `Environment.settings()` with the deployment's seed as the
 * fallback. The browser renders exactly these values.
 */

import type { Arbor } from '@4fu/arbor-core'
import type { Event, ScheduledTask, Settings, Workspace } from '@4fu/arbor-interfaces'
import { MAX_PAGE_LIMIT } from '@4fu/arbor-interfaces'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionTarget, type ArborHostService } from '@4fu/dsh-arbor-host'
import type {
  ArborBoardFacts,
  ArborEndRefusalFacts,
  ArborEnvFacts,
  ArborEnvItemFacts,
  ArborFacts,
  ArborHostFacts,
  ArborHostSessionFacts,
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

/**
 * Parse one host-owned event body, or an empty object when it has none.
 *
 * A `tool_call` body is the tool name and its JSON arguments as one string
 * (`end {"handoff":…}`), so the first object in it is what a reader parses.
 */
function body(event: Event): Record<string, unknown> {
  if (event.body === null) return {}
  const decode = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  const whole = decode(event.body)
  if (whole !== undefined) return whole
  const start = event.body.indexOf('{')
  return start < 0 ? {} : (decode(event.body.slice(start)) ?? {})
}

/** A string field of a host-owned event body. */
function text(event: Event, key: string): string | undefined {
  const value = body(event)[key]
  return typeof value === 'string' ? value : undefined
}

/** A string list recorded in a handoff part. */
function parts(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length === 0 ? undefined : items
}

/**
 * The handoff an end recorded, when it recorded one.
 *
 * `window_end` itself carries only `handoff: true` and the refs. The model's
 * `end` tool call carries the four parts, and it is arbor's own journal event,
 * so the page reads them from there when they are present; a handoff made
 * through `WindowSession.end` without that call still shows as a handoff with
 * its refs.
 */
async function handoffOf(host: ArborHostService, window: string, end: Event): Promise<ArborWindowFacts['handoff']> {
  const recorded = body(end)['handoff']
  if (recorded !== true) return undefined
  const page = await host.journal.list({ window: window as never, kinds: ['tool_call'], limit: 100 })
  const call = page.items.findLast(event => typeof body(event)['handoff'] === 'object')
  const value = call === undefined ? undefined : body(call)['handoff'] as Record<string, unknown>
  return {
    present: true,
    refs: [...end.refs],
    ...(value === undefined ? {} : {
      ...(parts(value['topics']) === undefined ? {} : { topics: parts(value['topics']) }),
      ...(parts(value['progress']) === undefined ? {} : { progress: parts(value['progress']) }),
      ...(parts(value['pending']) === undefined ? {} : { pending: parts(value['pending']) }),
      ...(parts(value['agreements']) === undefined ? {} : { agreements: parts(value['agreements']) }),
    }),
  }
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

/** The latest page of one window's events of some kinds, newest at the end. */
async function tailOfWindow(
  host: ArborHostService,
  window: string,
  kinds: readonly string[],
): Promise<Event[]> {
  const options = { window: window as never, kinds, limit: MAX_PAGE_LIMIT }
  const page = await host.journal.list(options)
  return page.total > page.items.length
    ? (await host.journal.list({ ...options, offset: page.total - MAX_PAGE_LIMIT })).items
    : page.items
}

/** The usage one window last recorded, from its `usage` or `run_ended` event. */
async function usageOfWindow(
  host: ArborHostService,
  window: string,
): Promise<{ used: number; limit: number; reserve: number } | undefined> {
  const event = (await tailOfWindow(host, window, ['usage', 'run_ended'])).at(-1)
  if (event === undefined) return undefined
  const values = body(event)
  const number = (key: string): number | undefined =>
    typeof values[key] === 'number' && Number.isFinite(values[key]) ? values[key] as number : undefined
  const used = number('used')
  const limit = number('limit')
  const reserve = number('reserve')
  if (used === undefined || limit === undefined || reserve === undefined) return undefined
  return { used, limit, reserve }
}

/**
 * The latest `end` arbor refused while the window is still open.
 *
 * The `end` tool call is one journal event and its refusal another; the result
 * names the call in its refs. A later `end` that succeeds replaces this, and an
 * ended window never carries it, so a reader can treat its presence as "the
 * window is still live because arbor refused to end it".
 */
async function endRefusalOf(host: ArborHostService, window: string): Promise<ArborEndRefusalFacts | undefined> {
  const events = await tailOfWindow(host, window, ['tool_call', 'tool_result'])
  const endCall = events.findLast(event =>
    event.kind === 'tool_call' && (event.body === 'end' || event.body?.startsWith('end ')))
  if (endCall === undefined) return undefined
  const result = events.find(event =>
    event.kind === 'tool_result' && event.refs.some(ref => ref === endCall.ref))
  if (result === undefined || result.body === null) return undefined
  const rule = /^(end\.[a-z_.]+)\s/.exec(result.body)?.[1]
  if (rule === undefined) return undefined
  return { rule, message: result.body, at: result.time, ref: result.ref }
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
    const usage = await usageOfWindow(host, ref)
    const endRefused = record === undefined || record.state === 'ended'
      ? undefined
      : await endRefusalOf(host, ref)
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
      ...(usage === undefined && record === undefined ? {} : { used: usage?.used ?? record?.usage.used }),
      ...(usage === undefined && record === undefined ? {} : { limit: usage?.limit ?? record?.usage.limit }),
      ...(usage === undefined && record === undefined ? {} : { reserve: usage?.reserve ?? record?.usage.reserve }),
      ...(line?.doing === undefined && lastLine === undefined
        ? {}
        : { doing: line?.doing ?? (lastLine === undefined ? undefined : text(lastLine, 'doing')) }),
      ...(start === undefined ? {} : { task: text(start, 'task') }),
      targets,
      ...(continuationOf === undefined ? {} : { continuationOf }),
      ...(end === undefined ? {} : { handoff: await handoffOf(host, ref, end) }),
      ...(end === undefined ? {} : { refused: text(end, 'refused') }),
      ...(endRefused === undefined ? {} : { endRefused }),
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
async function schedulesOf(host: ArborHostService, sessionId?: SessionId): Promise<ArborScheduleFacts[]> {
  const target = sessionId === undefined ? undefined : sessionTarget(sessionId)
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
    mine: target === undefined ? false : schedule.targets.includes(target),
    targets: [...schedule.targets],
  }))
}

/**
 * Arbor's settings: the environment's own, or the deployment's seed.
 *
 * `DshEnvironment.settings()` answers the seed when `/env/settings.json` is not
 * installed, so the source is read off the environment's item list instead:
 * a `settings` item is what the model's own `reload` installs.
 *
 * This whole document goes into `settings.json` when the page saves one, so the
 * API keys are deliberately absent: a settings document names a secret and
 * never holds its value, and the keys are their own facts (`ArborFacts.keys`).
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
  const [workspace, notes, env, schedules, settings, keys] = await Promise.all([
    workspaceOf(host, sessionId, chain),
    notesOf(host),
    envOf(host),
    schedulesOf(host, sessionId),
    settingsOf(host),
    host.keys(),
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
    keys,
  }
}


/** The label a `window_start` carries, or the empty string. */
function labelOf(event: Event): string {
  if (event.body === null) return ''
  try {
    const parsed: unknown = JSON.parse(event.body)
    const label = (parsed as { label?: unknown } | null)?.label
    return typeof label === 'string' ? label : ''
  } catch {
    return ''
  }
}

/** Every session the host holds windows for, by the label on their starts. */
async function sessionLabels(host: ArborHostService): Promise<string[]> {
  const labels = new Set<string>()
  for (let offset = 0; ; offset += 200) {
    const page = await host.journal.list({ kinds: ['window_start'], limit: 200, offset })
    for (const event of page.items) {
      const label = labelOf(event)
      if (label !== '') labels.add(label)
    }
    if (page.items.length < 200) break
  }
  return [...labels]
}

/**
 * One session's row in the whole-host view.
 * @param titleOf - the title DSH shows for a session, when the caller can read it.
 */
async function hostSessionOf(
  host: ArborHostService,
  sessionId: SessionId,
  titleOf?: (sessionId: SessionId) => string | undefined,
): Promise<ArborHostSessionFacts> {
  const { windows, board } = await windowsOf(host, sessionId)
  const chain = windows.map(window => window.ref)
  const workspace = await workspaceOf(host, sessionId, chain)
  const liveLine = [...board].reverse().find(line => windows.some(window => window.ref === line.window && window.live))
  const title = titleOf?.(sessionId)
  return {
    sessionId,
    ...(title === undefined || title === '' ? {} : { title }),
    preset: 'arbor',
    windows,
    live: windows.filter(window => window.live).length,
    ...(liveLine === undefined && windows.at(-1)?.doing === undefined
      ? {}
      : { doing: liveLine?.doing ?? windows.at(-1)?.doing }),
    ...(workspace.project === undefined ? {} : { project: workspace.project }),
    ...(workspace.cwd === undefined ? {} : { cwd: workspace.cwd }),
    pointers: workspace.pointers,
  }
}

/**
 * Assemble the whole-host view the left sidebar's arbor page reads.
 * @param titleOf - DSH's own session title, which the page leads with.
 */
export async function buildHostFacts(
  host: ArborHostService,
  revision: number,
  titleOf?: (sessionId: SessionId) => string | undefined,
): Promise<ArborHostFacts> {
  const labels = await sessionLabels(host)
  const sessions: ArborHostSessionFacts[] = []
  for (const label of labels) {
    sessions.push(await hostSessionOf(host, label as SessionId, titleOf))
  }
  sessions.sort((left, right) => {
    const one = left.windows.at(-1)?.startedAt ?? 0
    const other = right.windows.at(-1)?.startedAt ?? 0
    return other - one
  })
  const windows = sessions.flatMap(session => [...session.windows])
    .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
  const board: ArborBoardFacts[] = host.host.boardLines().map(line => ({
    window: line.window,
    doing: line.doing,
    state: line.state,
    targets: [...line.targets],
    usage: { ...line.usage },
    ...(line.openWork === undefined ? {} : { openWork: [...line.openWork] }),
  }))
  const [notes, env, schedules, settings, keys] = await Promise.all([
    notesOf(host),
    envOf(host),
    schedulesOf(host),
    settingsOf(host),
    host.keys(),
  ])
  return {
    version: 1,
    revision,
    at: Date.now(),
    dataRoot: host.dataRoot,
    backend: host.workspaceBackend,
    shared: host.sharedFolder,
    sessions,
    windows,
    board,
    notes,
    env,
    schedules,
    settings,
    keys,
  }
}
