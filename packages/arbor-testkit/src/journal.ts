/**
 * An in-memory arbor `Journal` for the B0 spike.
 *
 * The arbor core ships no journal implementation: a deployment provides one
 * (docs/architecture.md#interfaces). This one keeps every event in memory,
 * which is all the proofs need, and implements the whole interface so the
 * host runs the real code paths. B1 replaces it with a durable journal: the
 * arbor host rebuilds every running window from the journal after a restart,
 * so the journal is what makes an arbor session survive one.
 */

import type {
  AroundOptions,
  BlobContent,
  BlobInfo,
  BlobInput,
  BlobRef,
  BlobStore,
  Event,
  EventInput,
  EventPage,
  EventRef,
  Journal,
  Link,
  LinkPage,
  LinksOptions,
  ListOptions,
  SearchHit,
  SearchOptions,
  SearchPage,
  Target,
  TargetGap,
  TraceNode,
  TraceOptions,
  WindowRef,
} from '@4fu/arbor-interfaces'

interface Watermark {
  seq: number
}

/** In-memory journal: append-only, one global order, watermarks, links. */
export class MemoryJournal implements Journal {
  private readonly events: Event[] = []
  private readonly byRef = new Map<EventRef, Event>()
  private readonly watermarks = new Map<string, Watermark>()
  private readonly blobs_ = new Map<BlobRef, { info: BlobInfo; data: Uint8Array }>()
  private nextBlob = 1

  readonly blobs: BlobStore = {
    put: async (input: BlobInput) => {
      const data = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
      const ref = `b${this.nextBlob++}` as BlobRef
      this.blobs_.set(ref, { info: { ref, size: data.byteLength, mime: input.mime ?? 'application/octet-stream', time: Date.now() }, data })
      return ref
    },
    get: async (ref) => {
      const hit = this.blobs_.get(ref)
      return hit === undefined ? null : { data: hit.data, mime: hit.info.mime }
    },
    has: async (ref) => this.blobs_.has(ref),
    stat: async (ref) => this.blobs_.get(ref)?.info ?? null,
    delete: async (ref) => { this.blobs_.delete(ref) },
  }

  async append(input: EventInput): Promise<Event> {
    if (input.external !== undefined && input.external !== null) {
      for (const event of this.events) {
        if (event.external === input.external) return event
      }
    }
    const seq = this.events.length
    const ref = `r${seq}` as EventRef
    const links: Link[] = (input.links ?? []).map(link => ({
      kind: link.kind,
      from: ref,
      to: link.to,
      weight: link.weight ?? 1,
      time: input.time ?? Date.now(),
    }))
    const event: Event = {
      ref,
      seq,
      window: input.window ?? null,
      time: input.time ?? Date.now(),
      kind: input.kind,
      targets: [...(input.targets ?? [])],
      refs: [...(input.refs ?? [])],
      links,
      external: input.external ?? null,
      blobs: [...(input.blobs ?? [])],
      body: input.body ?? null,
      redacted: null,
    }
    this.events.push(event)
    this.byRef.set(ref, event)
    return event
  }

  async get(ref: EventRef): Promise<Event | null> {
    return this.byRef.get(ref) ?? null
  }

  async getMany(refs: readonly EventRef[]): Promise<Event[]> {
    return refs.flatMap(ref => {
      const event = this.byRef.get(ref)
      return event === undefined ? [] : [event]
    })
  }

  async list(options: ListOptions = {}): Promise<EventPage> {
    let items = this.events.filter(event => (
      (options.window === undefined || event.window === options.window)
      && (options.kinds === undefined || options.kinds.includes(event.kind))
      && (options.targets === undefined || options.targets.some(target => event.targets.includes(target)))
      && (options.external === undefined || event.external === options.external)
      && (options.afterSeq === undefined || event.seq > options.afterSeq)
      && (options.beforeSeq === undefined || event.seq < options.beforeSeq)
    ))
    const total = items.length
    const offset = options.offset ?? 0
    items = items.slice(offset, offset + (options.limit ?? total))
    return { items, total, limit: options.limit ?? total, nextCall: 'journal.list()' }
  }

  async around(ref: EventRef, options: AroundOptions = {}): Promise<Event[]> {
    const event = this.byRef.get(ref)
    if (event === undefined) return []
    const before = options.before ?? 5
    const after = options.after ?? 5
    return this.events.slice(Math.max(0, event.seq - before), event.seq + after + 1)
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchPage> {
    const needle = query.toLowerCase()
    const hits: SearchHit[] = []
    for (const event of this.events) {
      if (options.kinds !== undefined && !options.kinds.includes(event.kind)) continue
      if (options.window !== undefined && event.window !== options.window) continue
      if (options.targets !== undefined && !options.targets.some(target => event.targets.includes(target))) continue
      if (options.afterSeq !== undefined && event.seq <= options.afterSeq) continue
      if (options.beforeSeq !== undefined && event.seq >= options.beforeSeq) continue
      const body = event.body ?? ''
      const at = body.toLowerCase().indexOf(needle)
      if (at < 0) continue
      hits.push({
        ref: event.ref,
        seq: event.seq,
        window: event.window,
        kind: event.kind,
        time: event.time,
        match: 'substring',
        score: 1,
        summary: body.slice(0, 120),
      })
    }
    const offset = options.offset ?? 0
    const items = hits.slice(offset, offset + (options.limit ?? hits.length))
    return { items, total: hits.length, limit: options.limit ?? hits.length, nextCall: `search({ query: ${JSON.stringify(query)} })` }
  }

  async links(ref: EventRef | string, _options: LinksOptions = {}): Promise<LinkPage> {
    const items = this.events.flatMap(event => event.links
      .filter(link => link.to === ref || link.from === ref)
      .map(link => ({
        ref: link.from === ref ? link.to : link.from,
        kind: link.kind,
        weight: link.weight,
        direction: link.from === ref ? 'out' as const : 'in' as const,
        window: event.window,
        time: link.time,
        summary: (event.body ?? '').slice(0, 120),
      })))
    return { items, total: items.length, limit: items.length, nextCall: 'journal.links()' }
  }

  async trace(ref: EventRef | string, options: TraceOptions = {}): Promise<TraceNode> {
    const maxHops = options.maxHops ?? 10
    const seen = new Set<string>()
    const walk = (at: string, hops: number): TraceNode => {
      const event = this.byRef.get(at as EventRef)
      const from = hops >= maxHops || seen.has(at) ? [] : (() => {
        seen.add(at)
        return (event?.links ?? []).map(link => walk(link.to, hops + 1))
      })()
      return {
        ref: at as EventRef,
        kind: event?.kind,
        window: event?.window ?? null,
        time: event?.time ?? 0,
        summary: (event?.body ?? '').slice(0, 120),
        origin: event === undefined || event.external !== null,
        from,
      }
    }
    return walk(ref, 0)
  }

  async watermark(window: WindowRef, target: Target): Promise<number | null> {
    return this.watermarks.get(`${window}|${target}`)?.seq ?? null
  }

  async advanceWatermark(window: WindowRef, target: Target, seq: number): Promise<number> {
    const key = `${window}|${target}`
    const current = this.watermarks.get(key)?.seq ?? -1
    const next = Math.max(current, seq)
    this.watermarks.set(key, { seq: next })
    return next
  }

  async targetsBehind(window: WindowRef): Promise<TargetGap[]> {
    const seen = new Map<Target, number>()
    for (const event of this.events) {
      if (event.window === window) continue
      for (const target of event.targets) {
        seen.set(target, Math.max(seen.get(target) ?? -1, event.seq))
      }
    }
    const gaps: TargetGap[] = []
    for (const [target, latest] of seen) {
      const mark = await this.watermark(window, target)
      const watermark = mark ?? -1
      if (latest <= watermark) continue
      const count = this.events.filter(event => event.window !== window
        && event.targets.includes(target) && event.seq > watermark).length
      gaps.push({ target, latest, watermark, count })
    }
    return gaps
  }

  async redact(ref: EventRef, reason: string): Promise<Event> {
    const event = this.byRef.get(ref)
    if (event === undefined) throw new Error(`journal: no event ${ref}`)
    event.body = null
    event.redacted = { by: `r${this.events.length}` as EventRef, reason, time: Date.now() }
    return event
  }

  async close(): Promise<void> {
    this.events.length = 0
    this.byRef.clear()
    this.watermarks.clear()
    this.blobs_.clear()
  }
}
