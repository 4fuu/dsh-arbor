/**
 * `@4fu/dsh-arbor-facts` — what arbor is doing, read from arbor itself and
 * served to the web client.
 *
 * The browser cannot read arbor's host: a `dsh.client` package runs in the
 * page, and DSH offers it no channel to a host service (the Remote namespaces
 * are generated at build time, and Typert decorators do not run under Node's
 * type stripping). The least invasive route DSH does offer is its own exact
 * Fetch registry: `ctx.connection.fetch.register({ path, methods, requestBody,
 * fetch })` (`@deepseek-ai/dsh-client-connection`, `HostConnectionFetch`) owns a
 * path under `/api` and answers it to an authenticated owner Peer — the browser
 * — without touching a compiled bundle or the session log. This package
 * registers three routes on that registry:
 *
 *  - `/api/arbor/facts?sessionId=…` — one session's windows, workspace, board,
 *    notes, `/env`, schedules and settings, as NDJSON;
 *  - `/api/arbor/host` — the whole host across sessions, for the left sidebar's
 *    arbor page;
 *  - `/api/arbor/search?q=…` — arbor's own search over its journal, notes and
 *    board.
 *
 * Liveness comes from arbor, not from polling a heuristic: a plugin this
 * service registers on the host observes every journal append and every note
 * write, and each live window is watched with `Arbor.stream(window, …)` — the
 * per-window stream arbor documents for an embedding host. A change rebuilds
 * the facts somebody is reading and pushes them down the open streams; a live
 * delta goes down as its own frame, so a panel shows the model writing before
 * the call completes.
 *
 * On a profile with no browser connection (headless, acp, sdk) no route is
 * registered and the service is inert until a caller asks it for facts.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { EventInput, Plugin, StreamEvent } from '@4fu/arbor-interfaces'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionOfTarget, type ArborHostService } from '@4fu/dsh-arbor-host'
import { buildFacts, buildHostFacts } from './facts.ts'
import type {
  ArborFacts,
  ArborFactsFrame,
  ArborHostFacts,
  ArborHostFrame,
  ArborSearchResult,
  ArborStreamEvent,
} from './types.ts'

export type {
  ArborFacts,
  ArborFactsFrame,
  ArborHostFacts,
  ArborHostFrame,
  ArborSearchResult,
  ArborStreamEvent,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** What arbor is doing in one session or across the host, and the streams that answer it. */
    arborFacts: ArborFactsService
  }
}

/** The exact route one session's facts answer on. */
export const FACTS_PATH = '/api/arbor/facts'

/** The exact route the whole-host facts answer on. */
export const HOST_PATH = '/api/arbor/host'

/** The exact route arbor's own search answers on. */
export const SEARCH_PATH = '/api/arbor/search'

/** How long a burst of journal appends is coalesced before one rebuild. */
const REBUILD_MS = 120

/** How often an idle stream is kept warm through proxies. */
const KEEPALIVE_MS = 15_000

/**
 * The slice of DSH's Host connection service this package registers on.
 * Declared locally because this package does not depend on the browser wire
 * package; the shape is `HostConnectionFetch.register` from
 * `@deepseek-ai/dsh-client-connection`.
 */
interface ConnectionService {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly string[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/** The session services the facts service reads, as far as it uses them. */
interface AgentsService {
  get(id: SessionId): {
    readonly session: {
      readonly header: { readonly agentPreset?: string }
      snapshotEvents(): readonly {
        readonly type: string
        readonly data: unknown
      }[]
    }
  } | undefined
}

interface ProjectionsService {
  snapshot(session: unknown, keys?: readonly string[]): { readonly values: Readonly<Record<string, unknown>> }
}

/** What one open session stream's listeners share: the facts, the streams, the timer. */
interface SessionFacts {
  /** The change counter the facts carry. */
  revision: number
  /** The last built facts. */
  facts?: ArborFacts
  /** A build in flight, so several listeners share one. */
  building?: Promise<ArborFacts>
  /** A rebuild is owed. */
  dirty: boolean
  /** Timers this session owns. */
  timer?: ReturnType<typeof setTimeout>
  /** The frames' listeners. */
  readonly listeners: Set<(frame: ArborFactsFrame) => void>
  /** The live stream per window, and how to stop it. */
  readonly streams: Map<string, () => void>
}

/** What the whole-host stream's listeners share. */
interface HostFacts {
  revision: number
  facts?: ArborHostFacts
  building?: Promise<ArborHostFacts>
  dirty: boolean
  timer?: ReturnType<typeof setTimeout>
  readonly listeners: Set<(frame: ArborHostFrame) => void>
  readonly streams: Map<string, () => void>
}

/**
 * One session's facts and the watchers that read them, plus the host-wide view
 * beside it.
 *
 * The service keeps one record per session id; the first watcher builds it and
 * the last one releases the live subscriptions. A build coalesces every change
 * that arrived while it ran, so a burst of tool events costs one read.
 */
export class ArborFactsService extends Service {
  static inject = ['arborHost']

  /** What the host is doing, per session, for as long as somebody is reading. */
  private readonly sessions = new Map<string, SessionFacts>()

  /** The whole-host view, built while the left sidebar's page is open. */
  private readonly host: HostFacts = {
    revision: 0,
    dirty: true,
    listeners: new Set(),
    streams: new Map(),
  }

  /** The host's change counter, bumped by the plugin below. */
  private revision = 0

  /**
   * Which session each window serves, from the label the embedding attached.
   * It covers the session streams' frames and a host stream's `sessionId`.
   */
  private readonly windowSession = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'arborFacts')
  }

  /** The one arbor host this DSH process runs, read through its own service. */
  private arborHost(): ArborHostService {
    return (this.ctx as unknown as { arborHost: ArborHostService }).arborHost
  }

  protected async [Service.init](): Promise<void> {
    const host = this.arborHost()
    // Arbor's own hook surface: every append, every note write and every
    // environment reload is a reason the panels may be stale. A hook observes
    // only; it changes nothing.
    const plugin: Plugin = {
      name: 'dsh-arbor-facts',
      hooks: {
        afterAppend: ({ input }) => {
          this.bump()
          this.attachFromStart(input)
        },
        afterNoteWrite: () => { this.bump() },
        afterReload: () => { this.bump() },
        serviceStateChange: () => { this.bump() },
      },
    }
    host.host.register(plugin)
    this.ctx.effect(() => () => {
      for (const session of this.sessions.values()) this.release(session)
      this.sessions.clear()
      this.releaseHost()
    }, 'arborFacts.close()')
    // The exact Fetch registry exists only where a browser can connect. On a
    // profile with no connection the service stays a plain read face and no
    // route is registered.
    this.ctx.inject(['connection'], (child) => {
      const connection = serviceOf<ConnectionService>(child, 'connection')
      if (connection === undefined) return
      void connection.fetch.register({
        path: FACTS_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => this.streamResponse(request),
      })
      void connection.fetch.register({
        path: HOST_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => this.hostResponse(request),
      })
      void connection.fetch.register({
        path: SEARCH_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => this.searchResponse(request),
      })
    })
  }

  /** Note that something arbor holds may have changed, and rebuild what is watched. */
  bump(): void {
    this.revision += 1
    for (const [sessionId, session] of this.sessions) {
      session.dirty = true
      if (session.timer !== undefined) continue
      session.timer = setTimeout(() => {
        session.timer = undefined
        void this.refresh(sessionId as SessionId).catch(() => undefined)
      }, REBUILD_MS)
    }
    if (this.host.listeners.size === 0) return
    this.host.dirty = true
    if (this.host.timer !== undefined) return
    this.host.timer = setTimeout(() => {
      this.host.timer = undefined
      void this.refreshHost().catch(() => undefined)
    }, REBUILD_MS)
  }

  /**
   * One session's facts, rebuilt from arbor now.
   * @param sessionId - the DSH session to describe.
   * @returns the facts as arbor answers them.
   */
  async factsFor(sessionId: SessionId): Promise<ArborFacts> {
    const session = this.sessionOf(sessionId)
    session.dirty = true
    return this.refresh(sessionId)
  }

  /**
   * Open one live view of a session's facts.
   *
   * The returned function stops this listener; it does not stop the others. The
   * initial facts are delivered before the promise resolves, so a caller that
   * awaits `open` has its first frame.
   *
   * @param sessionId - the DSH session to describe.
   * @param onFrame - receives the initial facts, every rebuild, and each live delta.
   * @returns the listener's own stop function.
   */
  async open(sessionId: SessionId, onFrame: (frame: ArborFactsFrame) => void): Promise<() => void> {
    const session = this.sessionOf(sessionId)
    session.listeners.add(onFrame)
    const facts = await this.refresh(sessionId)
    onFrame({ type: 'facts', facts })
    return () => {
      session.listeners.delete(onFrame)
      if (session.listeners.size === 0) {
        this.release(session)
        this.sessions.delete(sessionId)
      }
    }
  }

  /** The whole-host facts, rebuilt from arbor now. */
  async hostFactsFor(): Promise<ArborHostFacts> {
    this.host.dirty = true
    return this.refreshHost()
  }

  /**
   * Open the whole-host view: the initial facts, every rebuild, and each live
   * delta from any session's windows.
   *
   * @param onFrame - receives the host frames.
   * @returns the listener's own stop function.
   */
  async openHost(onFrame: (frame: ArborHostFrame) => void): Promise<() => void> {
    this.host.listeners.add(onFrame)
    const facts = await this.refreshHost()
    onFrame({ type: 'facts', facts })
    return () => {
      this.host.listeners.delete(onFrame)
      if (this.host.listeners.size === 0) this.releaseHost()
    }
  }

  /**
   * One query over arbor's journal, notes and board, as `Arbor.search` answers it.
   * @param query - what the user typed.
   * @returns the hits, grouped the way arbor groups them.
   */
  async search(query: string): Promise<ArborSearchResult> {
    const host = this.arborHost()
    const outcome = await host.host.search(query)
    return {
      query: outcome.query,
      journal: outcome.hits.map(hit => ({
        ref: hit.ref,
        seq: hit.seq,
        window: hit.window,
        kind: hit.kind,
        time: hit.time,
        match: hit.match,
        score: hit.score,
        summary: hit.summary,
      })),
      notes: outcome.notes.map(note => ({ ref: note.ref, title: note.title, summary: note.summary })),
      board: outcome.windows.map(line => ({ window: line.window, doing: line.doing })),
      total: outcome.total,
    }
  }

  /** The record for a session, created on first use. */
  private sessionOf(sessionId: SessionId): SessionFacts {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionFacts = {
      revision: 0,
      dirty: true,
      listeners: new Set(),
      streams: new Map(),
    }
    this.sessions.set(sessionId, created)
    return created
  }

  /**
   * Build one session's facts once.
   *
   * A build already in flight was started before the caller's own change, so it
   * is awaited and a fresh one follows when the caller asked for one: returning
   * the in-flight answer would hand a reader facts from before the window it is
   * asking about existed. Several callers that arrive during one build share
   * that one, and the first to ask for a rebuild starts the next.
   */
  private async refresh(sessionId: SessionId): Promise<ArborFacts> {
    const session = this.sessionOf(sessionId)
    while (session.building !== undefined) await session.building.catch(() => undefined)
    if (session.facts !== undefined && !session.dirty) return session.facts
    session.dirty = false
    const building = this.build(sessionId, session)
    session.building = building
    try {
      return await building
    } finally {
      if (session.building === building) session.building = undefined
    }
  }

  private async build(sessionId: SessionId, session: SessionFacts): Promise<ArborFacts> {
    const host = this.arborHost()
    session.revision = this.revision
    const facts = await buildFacts(host, sessionId, this.revision, this.presetOf(sessionId))
    session.facts = facts
    for (const window of facts.windows) this.windowSession.set(window.ref, sessionId)
    for (const listener of session.listeners) listener({ type: 'facts', facts })
    this.reconcileStreams(session, facts.windows)
    if (session.dirty && session.timer === undefined) {
      session.timer = setTimeout(() => {
        session.timer = undefined
        void this.refresh(sessionId).catch(() => undefined)
      }, REBUILD_MS)
    }
    return facts
  }

  /** Build the whole-host view once, sharing a build already in flight. */
  private async refreshHost(): Promise<ArborHostFacts> {
    while (this.host.building !== undefined) await this.host.building.catch(() => undefined)
    if (this.host.facts !== undefined && !this.host.dirty) return this.host.facts
    this.host.dirty = false
    const building = this.buildHost()
    this.host.building = building
    try {
      return await building
    } finally {
      if (this.host.building === building) this.host.building = undefined
    }
  }

  private async buildHost(): Promise<ArborHostFacts> {
    const host = this.arborHost()
    this.host.revision = this.revision
    const facts = await buildHostFacts(host, this.revision, sessionId => this.titleOf(sessionId))
    this.host.facts = facts
    for (const session of facts.sessions) {
      for (const window of session.windows) this.windowSession.set(window.ref, session.sessionId)
    }
    for (const listener of this.host.listeners) listener({ type: 'facts', facts })
    this.reconcileHostStreams(facts)
    if (this.host.dirty && this.host.timer === undefined) {
      this.host.timer = setTimeout(() => {
        this.host.timer = undefined
        void this.refreshHost().catch(() => undefined)
      }, REBUILD_MS)
    }
    return facts
  }

  /**
   * Subscribe `Arbor.stream` to every live window of one session's chain and
   * let go of the windows that ended. The stream is arbor's own per-window read:
   * the assistant text and the arguments of a call still being written.
   */
  private reconcileStreams(session: SessionFacts, windows: ArborFacts['windows']): void {
    const live = new Set(windows.filter(window => window.live).map(window => window.ref))
    for (const [window, stop] of session.streams) {
      if (live.has(window)) continue
      stop()
      session.streams.delete(window)
    }
    for (const window of live) {
      if (session.streams.has(window)) continue
      session.streams.set(window, this.watch(window, (event) => {
        const narrowed = narrowStreamEvent(event)
        if (narrowed === undefined) return
        for (const listener of session.listeners) listener({ type: 'stream', window, event: narrowed })
      }))
    }
  }

  /** Subscribe the host stream to every live window across sessions. */
  private reconcileHostStreams(facts: ArborHostFacts): void {
    const live = new Set(facts.windows.filter(window => window.live).map(window => window.ref))
    for (const [window, stop] of this.host.streams) {
      if (live.has(window)) continue
      stop()
      this.host.streams.delete(window)
    }
    for (const window of live) {
      if (this.host.streams.has(window)) continue
      this.host.streams.set(window, this.watch(window, (event) => {
        const narrowed = narrowStreamEvent(event)
        if (narrowed === undefined) return
        const sessionId = this.windowSession.get(window)
        for (const listener of this.host.listeners) {
          listener({
            type: 'stream',
            window,
            ...(sessionId === undefined ? {} : { sessionId }),
            event: narrowed,
          })
        }
      }))
    }
  }

  /** One `Arbor.stream` subscription. */
  private watch(window: string, onEvent: (event: StreamEvent) => void): () => void {
    return this.arborHost().host.stream(window as never, onEvent)
  }

  /**
   * Subscribe a new window's live stream the moment its `window_start` is
   * appended, not at the next rebuild: arbor appends the start before it opens
   * the model call, so this is the one moment that cannot miss the first delta.
   */
  private attachFromStart(input: EventInput): void {
    if (input.kind !== 'window_start') return
    const window = input.window
    if (window === null || window === undefined) return
    let sessionId: string | undefined
    let previous: string | undefined
    if (input.body !== null && input.body !== undefined) {
      try {
        const parsed: unknown = JSON.parse(input.body)
        const body = parsed as { label?: unknown; continuation?: unknown } | null
        if (typeof body?.label === 'string' && body.label !== '') sessionId = body.label
        if (typeof body?.continuation === 'string') previous = body.continuation
      } catch {
        // A body that is not JSON names no label and no predecessor.
      }
    }
    if (sessionId === undefined) {
      for (const target of input.targets ?? []) {
        sessionId ??= sessionOfTarget(target)
      }
    }
    if (sessionId === undefined && previous !== undefined) sessionId = this.windowSession.get(previous)
    if (sessionId === undefined) return
    this.windowSession.set(window, sessionId)
    const session = this.sessions.get(sessionId)
    if (session !== undefined && session.listeners.size > 0 && !session.streams.has(window)) {
      session.streams.set(window, this.watch(window, (event) => {
        const narrowed = narrowStreamEvent(event)
        if (narrowed === undefined) return
        for (const listener of session.listeners) listener({ type: 'stream', window, event: narrowed })
      }))
    }
    if (this.host.listeners.size > 0 && !this.host.streams.has(window)) {
      this.host.streams.set(window, this.watch(window, (event) => {
        const narrowed = narrowStreamEvent(event)
        if (narrowed === undefined) return
        for (const listener of this.host.listeners) {
          listener({ type: 'stream', window, ...(sessionId === undefined ? {} : { sessionId }), event: narrowed })
        }
      }))
    }
  }

  /** Drop one session's live subscriptions and timer. */
  private release(session: SessionFacts): void {
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = undefined
    for (const stop of session.streams.values()) stop()
    session.streams.clear()
  }

  /** Drop the host view's live subscriptions and timer. */
  private releaseHost(): void {
    if (this.host.timer !== undefined) clearTimeout(this.host.timer)
    this.host.timer = undefined
    for (const stop of this.host.streams.values()) stop()
    this.host.streams.clear()
    this.host.facts = undefined
    this.host.dirty = true
  }

  /** The title DSH shows for a session: its latest `session/title` event. */
  private titleOf(sessionId: SessionId): string | undefined {
    const session = serviceOf<AgentsService>(this.ctx, 'agents')?.get(sessionId)?.session
    if (session === undefined) return undefined
    for (const event of session.snapshotEvents().toReversed()) {
      if (event.type !== 'session/title') continue
      const title = (event.data as { title?: unknown } | null)?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
      return undefined
    }
    return undefined
  }

  /** The preset DSH projects for a session, from its live session or its header. */
  private presetOf(sessionId: SessionId): string {
    const agents = serviceOf<AgentsService>(this.ctx, 'agents')
    const session = agents?.get(sessionId)?.session
    if (session !== undefined) {
      const projections = serviceOf<ProjectionsService>(this.ctx, 'sessionProjections')
      const value = projections?.snapshot(session, ['agentPreset']).values.agentPreset
      if (typeof value === 'string' && value !== '') return value
      if (session.header.agentPreset !== undefined) return session.header.agentPreset
    }
    return 'arbor'
  }

  /** `GET /api/arbor/facts?sessionId=…`: the facts, then every rebuild and live delta. */
  private async streamResponse(request: Request): Promise<Response> {
    const sessionId = new URL(request.url).searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      return Response.json({ error: 'sessionId is required' }, { status: 400 })
    }
    return this.ndjson(request.signal, write => this.open(sessionId as SessionId, write))
  }

  /** `GET /api/arbor/host`: the whole-host facts, then every rebuild and live delta. */
  private async hostResponse(request: Request): Promise<Response> {
    return this.ndjson(request.signal, write => this.openHost(write))
  }

  /**
   * One NDJSON response over a Fetch route.
   *
   * The initial frame and every later one are written by `open`; a blank line
   * every 15 seconds keeps a proxy from closing an idle panel. The stream is
   * cancelled with the request, which is what releases the opener's
   * subscription.
   */
  private ndjson(
    signal: AbortSignal,
    open: (write: (frame: ArborFactsFrame | ArborHostFrame) => void) => Promise<() => void>,
  ): Response {
    const encoder = new TextEncoder()
    let stop: (() => void) | undefined
    let keepalive: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false
        const write = (frame: ArborFactsFrame | ArborHostFrame): void => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
          } catch {
            closed = true
          }
        }
        keepalive = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode('\n'))
          } catch {
            closed = true
          }
        }, KEEPALIVE_MS)
        signal.addEventListener('abort', () => {
          closed = true
          stop?.()
          if (keepalive !== undefined) clearInterval(keepalive)
          try {
            controller.close()
          } catch {
            // The client closed the stream before the abort was observed.
          }
        }, { once: true })
        void open(write)
          .then((halt) => {
            stop = halt
            if (closed) halt()
          })
          .catch((error: unknown) => {
            write({ type: 'error', message: error instanceof Error ? error.message : String(error) })
          })
      },
      cancel: () => {
        stop?.()
        if (keepalive !== undefined) clearInterval(keepalive)
      },
    })
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        // A reverse proxy must not buffer a live panel.
        'x-accel-buffering': 'no',
      },
    })
  }

  /** `GET /api/arbor/search?q=…`: arbor's own search, as JSON. */
  private async searchResponse(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams.get('q') ?? ''
    if (query.trim() === '') return Response.json({ error: 'q is required' }, { status: 400 })
    try {
      return Response.json(await this.search(query))
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }
}

/** Narrow arbor's stream event to what a reader can show. */
function narrowStreamEvent(event: StreamEvent): ArborStreamEvent | undefined {
  if (event.kind === 'text_delta') return { kind: 'text_delta', delta: event.delta }
  if (event.kind === 'tool_call_delta') {
    return {
      kind: 'tool_call_delta',
      name: event.call.name,
      args: JSON.stringify(event.call.args),
    }
  }
  return undefined
}

/** Read one service off a context, or undefined when it is not mounted. */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  return (ctx as unknown as { get(key: string): unknown }).get(name) as T | undefined
}

export default ArborFactsService
