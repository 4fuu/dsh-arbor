/// <reference lib="dom" />
/**
 * The browser half of arbor's facts channels.
 *
 * The host serves NDJSON streams on DSH's exact Fetch routes: one per session
 * (`/api/arbor/facts?sessionId=…`) and one for the whole host
 * (`/api/arbor/host`), both registered by `@4fu/dsh-arbor-facts`. This module
 * owns one stream per scope for as long as a component holds it, folds the
 * frames into the snapshot React reads, and reconnects with a bounded backoff
 * when the page's carrier drops one.
 *
 * A frame is either the facts (the initial read and every rebuild) or one live
 * delta from `Arbor.stream(window, …)`. The deltas are folded per window into
 * a short buffer; the facts are kept as they arrived, because they are arbor's
 * own values and nothing here recomputes them.
 */

import type {
  ArborFacts,
  ArborFactsFrame,
  ArborHostFacts,
  ArborHostFrame,
  ArborStreamEvent,
} from '@4fu/dsh-arbor-facts/types'

/** Where one channel stands right now. */
export type ArborChannelStatus = 'connecting' | 'live' | 'error'

/** What one live window has written recently. */
export interface ArborWindowStream {
  /** The model's assistant text, newest at the end. */
  readonly text: string
  /** The `send` call's arguments while it is being written, when parsable. */
  readonly send: string
  /** A live delta arrived in the last moment. */
  readonly streaming: boolean
}

/** The immutable snapshot a component subscribes to. */
export interface FactsSnapshot<F> {
  readonly status: ArborChannelStatus
  readonly facts?: F
  readonly error?: string
  /** The live buffers, keyed by arbor window ref. */
  readonly streams: Readonly<Record<string, ArborWindowStream>>
  /** A live window wrote something within the activity window. */
  readonly streaming: boolean
}

/** One frame either stream can carry, with its facts type erased. */
type AnyFrame = ArborFactsFrame | ArborHostFrame

/** How much assistant text one window's buffer keeps. */
const TEXT_LIMIT = 6_000

/** How much of a `send` draft one window's buffer keeps. */
const SEND_LIMIT = 1_500

/** How long a frame keeps the "streaming" mark after it arrives. */
const ACTIVITY_MS = 1_600

/** The first reconnect delay, doubled to the cap. */
const RETRY_BASE_MS = 800

/** The longest a reconnect waits. */
const RETRY_MAX_MS = 5_000

/** Read the `content` a `send` call is composing out of its partial JSON. */
function sendContentOf(raw: string): string | undefined {
  // The arguments arrive as the characters the model has written so far, so
  // they are not valid JSON until the call closes. The text field is quoted,
  // so its opening quote is the one thing that is there early enough to read.
  const match = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
  if (match === null) return undefined
  const body = match[1] ?? ''
  return body
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

/** Keep the last `limit` characters of a buffer. */
function tail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit)
}

/** One scope's live stream, usable by any number of components. */
export class FactsChannel<F extends ArborFacts | ArborHostFacts> {
  private readonly url: string
  private readonly listeners = new Set<() => void>()
  private snapshot: FactsSnapshot<F> = { status: 'connecting', streams: {}, streaming: false }
  private controller: AbortController | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private retryDelay = RETRY_BASE_MS
  private activity: ReturnType<typeof setTimeout> | undefined
  private holds = 0
  private stopped = true

  constructor(url: string) {
    this.url = url
  }

  /** The current snapshot; the same reference until something changed. */
  readonly getSnapshot = (): FactsSnapshot<F> => this.snapshot

  /** Subscribe one React store listener. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Take one hold on the stream; the first starts it. */
  retain(): void {
    this.holds += 1
    if (this.holds !== 1) return
    this.stopped = false
    void this.connect()
  }

  /** Release one hold; the last stops the stream. */
  release(): void {
    this.holds -= 1
    if (this.holds > 0) return
    this.close()
  }

  /** Stop this channel for good, whoever still holds it. */
  close(): void {
    this.stopped = true
    this.holds = 0
    this.controller?.abort()
    this.controller = undefined
    if (this.retry !== undefined) clearTimeout(this.retry)
    this.retry = undefined
    if (this.activity !== undefined) clearTimeout(this.activity)
    this.activity = undefined
  }

  /** Open the stream and read it until the page's carrier drops it. */
  private async connect(): Promise<void> {
    if (this.stopped) return
    this.set({ ...this.snapshot, status: this.snapshot.facts === undefined ? 'connecting' : 'live' })
    const controller = new AbortController()
    this.controller = controller
    try {
      const response = await fetch(this.url, {
        signal: controller.signal,
        headers: { accept: 'application/x-ndjson' },
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`facts stream answered ${response.status}`)
      if (response.body === null) throw new Error('facts stream has no body')
      this.retryDelay = RETRY_BASE_MS
      this.set({ ...this.snapshot, status: 'live', error: undefined })
      await this.read(response.body, controller.signal)
      if (controller.signal.aborted) return
      throw new Error('facts stream ended')
    } catch (error: unknown) {
      if (controller.signal.aborted || this.stopped) return
      this.set({
        ...this.snapshot,
        status: this.snapshot.facts === undefined ? 'error' : 'live',
        error: error instanceof Error ? error.message : String(error),
      })
      this.retry = setTimeout(() => {
        this.retry = undefined
        void this.connect()
      }, this.retryDelay)
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS)
    }
  }

  /** Read one response's NDJSON body, one frame at a time. */
  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (signal.aborted) { await reader.cancel().catch(() => undefined); return }
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') this.handle(JSON.parse(line) as AnyFrame)
      }
    }
  }

  /** Fold one frame into the snapshot. */
  private handle(frame: AnyFrame): void {
    if (frame.type === 'facts') {
      this.set({ ...this.snapshot, status: 'live', facts: frame.facts as F, error: undefined })
      return
    }
    if (frame.type === 'error') {
      this.set({ ...this.snapshot, error: frame.message })
      return
    }
    this.stream(frame.window, frame.event)
  }

  /** Fold one live window delta into its own buffer. */
  private stream(window: string, event: ArborStreamEvent): void {
    const before = this.snapshot.streams[window] ?? { text: '', send: '', streaming: false }
    let next: ArborWindowStream = before
    if (event.kind === 'text_delta') {
      next = { ...before, text: tail(before.text + event.delta, TEXT_LIMIT) }
    } else {
      const content = sendContentOf(event.args)
      if (event.name === 'send' && content !== undefined) {
        next = { ...before, send: tail(content, SEND_LIMIT) }
      }
    }
    const streams = { ...this.snapshot.streams, [window]: { ...next, streaming: true } }
    this.set({ ...this.snapshot, streams, streaming: true })
    if (this.activity !== undefined) clearTimeout(this.activity)
    this.activity = setTimeout(() => {
      this.activity = undefined
      const cleared: Record<string, ArborWindowStream> = {}
      for (const [ref, view] of Object.entries(this.snapshot.streams)) cleared[ref] = { ...view, streaming: false }
      this.set({ ...this.snapshot, streams: cleared, streaming: false })
    }, ACTIVITY_MS)
  }

  /** Publish one snapshot and wake React. */
  private set(snapshot: FactsSnapshot<F>): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/** The channels one page holds, by scope, while a component holds them. */
const channels = new Map<string, FactsChannel<ArborFacts | ArborHostFacts>>()

/** The channel for one session, created on first use. */
export function channelFor(sessionId: string): FactsChannel<ArborFacts> {
  const key = `session:${sessionId}`
  let channel = channels.get(key)
  if (channel === undefined) {
    channel = new FactsChannel<ArborFacts>(`/api/arbor/facts?sessionId=${encodeURIComponent(sessionId)}`)
    channels.set(key, channel)
  }
  return channel as FactsChannel<ArborFacts>
}

/** The whole-host channel, created on first use. */
export function hostChannel(): FactsChannel<ArborHostFacts> {
  const key = 'host'
  let channel = channels.get(key)
  if (channel === undefined) {
    channel = new FactsChannel<ArborHostFacts>('/api/arbor/host')
    channels.set(key, channel)
  }
  return channel as FactsChannel<ArborHostFacts>
}

/** Stop every channel this page holds; called when the plugin unloads. */
export function closeChannels(): void {
  for (const channel of channels.values()) channel.close()
  channels.clear()
}
