/**
 * The arbor pages: one permanent entry in DSH's left sidebar and the main
 * panel it selects.
 *
 * The entry is the sidebar's own seam — a `sidebar.panellist` row whose `id` is
 * the key of a `main` slot page
 * (`@deepseek-ai/dsh-client-ui-sidebar`, "Global panel entries"; the shipped
 * Automation-tasks row and the official plugin manager register exactly this
 * pair). The row is the accessible navigation entry; DSH's sidebar selects the
 * page by the same id. The page is root-scoped and belongs to no Session.
 *
 * The page is the whole-host picture: every arbor session and its windows, the
 * board, the active notes, `/env`, the schedules, arbor's settings and arbor's
 * own search. A session row expands into its own tab, which shows only that
 * session: its live window and status, the continuation chain, its project and
 * the external pointers from `<workspace>`, and what is running now. An
 * ordinary DSH session never appears here, because only an arbor task carries a
 * label and only a labeled window is in these facts.
 *
 * Every value comes from `@4fu/dsh-arbor-facts`, which reads arbor's own API;
 * nothing here computes a fact of its own, and an empty answer is shown as
 * empty rather than filled with a plausible one.
 */

import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type {
  ArborBoardFacts,
  ArborEnvFacts,
  ArborFacts,
  ArborHostFacts,
  ArborHostSessionFacts,
  ArborNotesFacts,
  ArborScheduleFacts,
  ArborSettingsFacts,
  ArborWindowFacts,
  ArborWorkspaceFacts,
} from '@4fu/dsh-arbor-facts/types'
import { channelFor, hostChannel, type FactsChannel, type FactsSnapshot } from './channel.ts'
import { NAMESPACE, type Translate } from './i18n.ts'

/** The left sidebar entry's id, and the key of its main page. */
export const PANEL_ID = 'arbor'

/** What the main page needs from the page's services, injected at registration. */
export interface ArborPageInjected {
  readonly openDshSession?: (sessionId: string) => void
}

/** One slot component's own props, as far as this package reads them. */
export interface ArborSlotProps {
  readonly sessionId?: string
  readonly t?: Translate
}

type Filter = 'all' | 'windows' | 'board' | 'notes' | 'env' | 'schedules'

const FILTERS: readonly Filter[] = ['all', 'windows', 'board', 'notes', 'env', 'schedules']

/** Subscribe one component to a facts channel. */
function useChannel<F extends ArborFacts | ArborHostFacts>(channel: FactsChannel<F>): FactsSnapshot<F> {
  useEffect(() => {
    channel.retain()
    return () => { channel.release() }
  }, [channel])
  return useSyncExternalStore(channel.subscribe, channel.getSnapshot)
}

type WindowStreamView = FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string]

/**
 * What the status should say right now. Arbor's own `state` can still be
 * `idle` for the first moments of a new run — the host learns a run is active
 * from the usage event, which arrives after the first text — while arbor's
 * `Arbor.stream` is already delivering the model's output. A window that is
 * writing is shown as running; the underlying arbor state is unchanged.
 */
function shownState(window: ArborWindowFacts, stream: WindowStreamView | undefined): ArborWindowFacts['state'] {
  return window.live && stream?.streaming === true ? 'running' : window.state
}

/** The chain's windows with the live stream's current state applied. */
function shownWindows(windows: readonly ArborWindowFacts[], streams: Readonly<Record<string, WindowStreamView>>): ArborWindowFacts[] {
  return windows.map(window => {
    const state = shownState(window, streams[window.ref])
    return state === window.state ? window : { ...window, state }
  })
}

/** The status label for one window state. */
function stateLabel(t: Translate, window: ArborWindowFacts): string {
  if (window.state === 'running') return t('statusRunning')
  if (window.state === 'idle') return t('statusIdle')
  if (window.state === 'paused') return t('statusPaused')
  return t('statusEnded')
}

/** A board line's state, in the reader's language. */
function boardStateLabel(t: Translate, state: string): string {
  if (state === 'running') return t('statusRunning')
  if (state === 'idle') return t('statusIdle')
  if (state === 'paused') return t('statusPaused')
  if (state === 'ended') return t('statusEnded')
  return state
}

/** The end reason, in the reader's language, from arbor's own reason. */
function endLabel(t: Translate, reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  if (reason === 'model_ended') return t('endModel')
  if (reason === 'idle_timeout') return t('endIdle')
  if (reason === 'hard_limit') return t('endHardLimit')
  if (reason === 'host_restart') return t('endRestart')
  if (reason === 'failed') return t('endFailed')
  if (reason === 'paused') return t('endPaused')
  return reason
}

/** A number with thousands separators. */
function number(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value)
}

/** A compact token count: 12.3k, 1.2M. */
function compact(value: number | undefined): string {
  if (value === undefined) return '—'
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** A duration in ms, as a short reader-facing value. */
function duration(t: Translate, ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 60_000) return t('seconds', { value: Math.round(ms / 1000) })
  if (ms < 3_600_000) return t('minutes', { value: Math.round(ms / 60_000) })
  return t('hours', { value: Math.round(ms / 3_600_000) })
}

/** A clock time in the page's locale, with DSH's 24-hour Chinese form. */
function clock(value: number | undefined, t: Translate): string {
  if (value === undefined) return '—'
  return new Date(value).toLocaleString(t('dateLocale'), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** The editorial date line above the hero sentence. */
function dateLine(t: Translate, at: number): string {
  const date = new Intl.DateTimeFormat(t('dateLocale'), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(at)).replace(/(星期[一二三四五六日天])/, ' $1')
  return date
}

/** The session's title as DSH shows it, falling back to its project and id. */
/** The chain summary with the singular form when a session has one window. */
function chainSummary(t: Translate, windows: readonly ArborWindowFacts[]): string {
  const last = windows.at(-1)
  return t(windows.length === 1 ? 'chainSummaryOne' : 'chainSummary', {
    count: windows.length,
    window: last?.ref ?? '—',
    state: last === undefined ? t('statusIdle') : stateLabel(t, last),
  })
}

function sessionTitle(session: ArborHostSessionFacts): string {
  if (session.title !== undefined && session.title !== '') return session.title
  return session.project?.name ?? (session.sessionId.length > 22 ? `${session.sessionId.slice(0, 22)}…` : session.sessionId)
}

/** The project part of a session card, which is secondary to DSH's title. */
function projectLabel(session: ArborHostSessionFacts): string {
  return session.project === undefined ? (session.cwd ?? '') : `${session.project.name} · ${session.project.path}`
}

/** The live window of a session, if it has one. */
function liveWindowOf(windows: readonly ArborWindowFacts[]): ArborWindowFacts | undefined {
  return [...windows].reverse().find(window => window.live)
}

/** A template value: a number/ref gets the display face, a name stays body text. */
interface HeroValue {
  readonly text: string
  readonly num?: boolean
}

/**
 * Render one hero template, wrapping the values that are numbers, refs or
 * counts in the numeric role. The template itself is the page's own copy, so
 * every sentence is still translated and every value still comes from arbor.
 */
function hero(template: string, values: Readonly<Record<string, string | HeroValue>>): ReactNode[] {
  return template.split(/(\{\w+\})/g).map((piece, index) => {
    const match = /^\{(\w+)\}$/.exec(piece)
    if (match === null) return piece
    const value = values[match[1] as string]
    if (value === undefined) return piece
    const text = typeof value === 'string' ? value : value.text
    const num = typeof value === 'string' ? true : value.num !== false
    return createElement('span', {
      key: `hero-${index}`,
      className: num ? 'arbor-hero-num' : 'arbor-hero-name',
      'data-arbor-text': num ? 'numeric' : 'display',
    }, text)
  })
}

/** Inline Markdown: links, bold and code, with local paths kept as text. */
function inlineMarkdown(text: string, key: string): ReactNode[] {
  return text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\n)/g).map((piece, index) => {
    const id = `${key}-${index}`
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece)
    if (link !== null) {
      const label = link[1] as string
      const href = link[2] as string
      if (/^(https?:|mailto:|#)/.test(href)) {
        return createElement('a', { key: id, className: 'arbor-md-link', href, target: '_blank', rel: 'noreferrer', 'data-arbor-text': 'body' }, label)
      }
      return createElement('span', { key: id, className: 'arbor-md-link', title: href, 'data-arbor-text': 'body' }, label)
    }
    if (piece.startsWith('**') && piece.endsWith('**')) {
      return createElement('strong', { key: id, 'data-arbor-text': 'body' }, piece.slice(2, -2))
    }
    if (piece.startsWith('`') && piece.endsWith('`')) {
      return createElement('code', { key: id, className: 'arbor-md-code', 'data-arbor-text': 'code' }, piece.slice(1, -1))
    }
    if (piece === '\n') return createElement('br', { key: id })
    return piece
  })
}

/** Render the model's stream as Markdown, without an HTML sink. */
function MarkdownText(props: { readonly text: string }): ReactNode {
  const lines = props.text.split(/\r?\n/)
  const blocks: ReactNode[] = []
  let index = 0
  let block = 0
  while (index < lines.length) {
    const line = lines[index] as string
    if (line.trim() === '') { index += 1; continue }
    if (line.trimStart().startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] as string).trimStart().startsWith('```')) {
        code.push(lines[index] as string)
        index += 1
      }
      index += 1
      blocks.push(createElement('pre', { className: 'arbor-md-pre', 'data-arbor-text': 'code', key: `b${block++}` },
        createElement('code', { 'data-arbor-text': 'code' }, code.join('\n'))))
      continue
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] as string)) {
        const item = (lines[index] as string).replace(/^\s*[-*]\s+/, '')
        items.push(createElement('li', { key: `li-${index}`, 'data-arbor-text': 'body' }, ...inlineMarkdown(item, `li${index}`)))
        index += 1
      }
      blocks.push(createElement('ul', { className: 'arbor-md-list', key: `b${block++}` }, ...items))
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push(createElement('div', { className: 'arbor-md-heading', 'data-arbor-text': 'display', key: `b${block++}` },
        ...inlineMarkdown(heading[2] as string, `h${index}`)))
      index += 1
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index] as string
      if (next.trim() === '' || /^\s*[-*]\s+/.test(next) || /^#{1,4}\s+/.test(next) || next.trimStart().startsWith('```')) break
      paragraph.push(next)
      index += 1
    }
    blocks.push(createElement('p', { className: 'arbor-md-p', 'data-arbor-text': 'body', key: `b${block++}` },
      ...inlineMarkdown(paragraph.join('\n'), `p${block}`)))
  }
  return createElement('div', { className: 'arbor-md' }, ...blocks)
}

/**
 * A measured editorial mosaic: cards declare a kind (and, for a chain, a
 * weight that follows its node count), the surface picks a 12/8/6/4/1 track
 * ladder from its own width, and the planner packs cards into full-width bands.
 * A feature band stacks a narrow column beside a tall window and lets the grid
 * share their rows; the other bands take their row height from the tallest
 * measured card. Every band sums to the track count, so the right edge is one
 * line and no card leaves a hole wider than the gutter. The DOM order stays the
 * reading order.
 */

/** What a card is, for its span rule and its band. */
type MosaicKind = 'window' | 'chain' | 'session' | 'workspace' | 'board' | 'note' | 'env' | 'schedule' | 'empty' | 'loading'

/** One card on the mosaic. `weight` is the chain's preferred width in 12ths. */
interface MosaicItem {
  readonly key: string
  readonly kind: MosaicKind
  readonly weight?: number
  readonly node: ReactNode
}

/** A card's preferred, smallest and largest column span at one track count. */
interface SpanRule {
  readonly pref: number
  readonly min: number
  readonly max: number
}

/** The track count the surface uses at one content width. */
function trackCount(width: number): number {
  if (width >= 1000) return 12
  if (width >= 720) return 8
  if (width >= 500) return 6
  if (width >= 340) return 4
  return 1
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * The span a card kind asks for at one track count. The 12-track values are the
 * editorial intent; the smaller ladders keep the same proportion, with a floor
 * of two tracks for the small cards so a note never narrows to a sliver.
 */
function spanRule(kind: MosaicKind, cols: number, weight?: number): SpanRule {
  if (cols <= 1) return { pref: 1, min: 1, max: 1 }
  const scaled = (units: number): number => Math.max(1, Math.round(units * cols / 12))
  let pref: number
  let min: number
  let max: number
  switch (kind) {
    case 'window':
      pref = scaled(7)
      min = scaled(5)
      max = scaled(8)
      if (cols <= 4) { pref = cols; min = cols; max = cols }
      break
    case 'chain':
      pref = scaled(weight ?? 4)
      min = Math.max(2, scaled(3))
      max = scaled(8)
      break
    case 'workspace':
      pref = scaled(5)
      min = Math.max(2, scaled(4))
      max = scaled(6)
      break
    case 'session':
      pref = scaled(4)
      min = cols >= 12 ? 4 : Math.max(2, scaled(3))
      max = scaled(5)
      break
    case 'env':
      pref = scaled(4)
      min = Math.max(2, scaled(3))
      max = scaled(5)
      break
    case 'board':
    case 'note':
    case 'schedule':
      pref = scaled(3)
      min = Math.max(2, scaled(2))
      max = scaled(4)
      break
    default:
      pref = cols
      min = cols
      max = cols
  }
  min = clamp(min, 1, cols)
  max = clamp(max, 1, cols)
  if (max < min) max = min
  pref = clamp(pref, min, max)
  return { pref, min, max }
}

/** The chain's preferred width in 12ths, from its node count. */
function chainWeight(nodes: number): number {
  return Math.min(3 + Math.max(1, nodes), 7)
}

/** One planned column: its width and the cards stacked in it, top to bottom. */
interface MosaicColumn {
  readonly span: number
  readonly cards: readonly number[]
}

/** One planned band: columns whose spans sum to the track count. */
interface MosaicBand {
  readonly columns: readonly MosaicColumn[]
}

/**
 * Fit one chosen run of cards to the track count, closest to their preferred
 * spans. The narrowest card grows first, so width is shared rather than dumped
 * into one banner, and the widest shrinks first. `stretch` lets a band that
 * would otherwise leave a hole take the remaining tracks; the last band is
 * always allowed to stretch, because nothing follows it to fill the gap.
 */
function fitRun(
  indices: readonly number[],
  rules: readonly SpanRule[],
  heights: readonly number[],
  cols: number,
  stretch: boolean,
): number[] | undefined {
  const mins = indices.map(index => rules[index]!.min)
  const maxs = indices.map(index => stretch ? cols : rules[index]!.max)
  const sumMin = mins.reduce((sum, value) => sum + value, 0)
  const sumMax = maxs.reduce((sum, value) => sum + value, 0)
  if (cols < sumMin || cols > sumMax) return undefined
  const spans = indices.map(index => rules[index]!.pref)
  let total = spans.reduce((sum, value) => sum + value, 0)
  while (total < cols) {
    let pick = -1
    for (let at = 0; at < indices.length; at += 1) {
      if (spans[at]! >= maxs[at]!) continue
      if (pick < 0) { pick = at; continue }
      const height = heights[indices[at]!] ?? 0
      const chosen = heights[indices[pick]!] ?? 0
      if (spans[at]! < spans[pick]! || (spans[at] === spans[pick] && height > chosen)) pick = at
    }
    if (pick < 0) return undefined
    spans[pick] = spans[pick]! + 1
    total += 1
  }
  while (total > cols) {
    let pick = -1
    for (let at = 0; at < indices.length; at += 1) {
      if (spans[at]! <= mins[at]!) continue
      if (pick < 0) { pick = at; continue }
      const height = heights[indices[at]!] ?? 0
      const chosen = heights[indices[pick]!] ?? 0
      if (spans[at]! > spans[pick]! || (spans[at] === spans[pick] && height > chosen)) pick = at
    }
    if (pick < 0) return undefined
    spans[pick] = spans[pick]! - 1
    total -= 1
  }
  return spans
}

/**
 * Pack the remaining cards into full-width single-row bands. The plan is a
 * dynamic program over contiguous runs, not a greedy pick: a band that looks
 * cheap now but leaves a lonely card at the end loses to one that pays a small
 * height spread and ends every row cleanly. A band is never left open: the
 * last one, and one that leaves exactly two trailing cards, stretch to the
 * track count, and a lone card takes the full width.
 */
function planBands(
  rules: readonly SpanRule[],
  heights: readonly number[],
  cols: number,
  initial?: readonly number[],
): MosaicBand[] {
  const remaining = initial === undefined ? rules.map((_, index) => index) : [...initial]
  const total = remaining.length
  if (total === 0) return []
  const maxCards = cols >= 10 ? 4 : cols >= 6 ? 3 : cols >= 3 ? 2 : 1
  interface Choice {
    readonly cost: number
    readonly count: number
    readonly spans: readonly number[]
  }
  const best: Array<Choice | undefined> = new Array(total + 1)
  best[total] = { cost: 0, count: 0, spans: [] }
  for (let at = total - 1; at >= 0; at -= 1) {
    for (let count = 1; count <= maxCards && at + count <= total; count += 1) {
      const indices = remaining.slice(at, at + count)
      const last = at + count === total
      const tailPair = total - (at + count) === 2
      const spans = fitRun(indices, rules, heights, cols, last || tailPair)
      if (spans === undefined) continue
      const rest = best[at + count]
      if (rest === undefined) continue
      const measured = indices.map(index => heights[index] ?? 0)
      const spread = Math.max(...measured) - Math.min(...measured)
      const deviation = spans.reduce((sum, span, index) => sum + Math.abs(span - rules[indices[index]!]!.pref), 0)
      const lonely = count === 1 && total > 1 ? 90 : 0
      const cost = rest.cost + spread + deviation * 14 + lonely
      const current = best[at]
      if (current === undefined || cost < current.cost) best[at] = { cost, count, spans }
    }
  }
  if (best[0] === undefined) {
    // No run fits. A full-width single card is the only truthful fallback.
    return [{ columns: [{ span: cols, cards: [remaining[0]!] }] }, ...planBands(rules, heights, cols, remaining.slice(1))]
  }
  const bands: MosaicBand[] = []
  let at = 0
  while (at < total) {
    const choice = best[at]!
    const indices = remaining.slice(at, at + choice.count)
    bands.push({
      columns: indices.map((index, column) => ({ span: choice.spans[column]!, cards: [index] })),
    })
    at += choice.count
  }
  return bands
}

/**
 * The feature band: a tall window beside a narrow column of two or three
 * smaller cards stacked in the same rows. The stack is chosen by measured
 * height so the window and the column end together; the window's row span and
 * the row heights are then resolved by the grid itself, with no wrapper and no
 * hole. A short window or a wildly mismatched stack stays a plain band, and a
 * second window never enters the stack.
 */
function featureBand(
  items: readonly MosaicItem[],
  rules: readonly SpanRule[],
  heights: readonly number[],
  cols: number,
): { readonly band: MosaicBand; readonly used: readonly number[] } | undefined {
  if (cols < 8 || items[0]?.kind !== 'window') return undefined
  const wide = rules[0]!.pref
  const narrow = cols - wide
  if (narrow < 2) return undefined
  const windowHeight = heights[0] ?? 0
  const support = items
    .map((item, index) => ({ item, index }))
    .filter(entry => entry.index > 0 && entry.item.kind !== 'window' && entry.item.kind !== 'empty' && entry.item.kind !== 'loading')
    .slice(0, 3)
    .map(entry => entry.index)
  let best: { cards: number[]; total: number; cost: number } | undefined
  for (let count = 2; count <= support.length; count += 1) {
    const cards = support.slice(0, count)
    const total = cards.reduce((sum, index) => sum + (heights[index] ?? 0), 0) + (count - 1) * 13
    const cost = Math.abs(total - windowHeight)
    if (best === undefined || cost < best.cost) best = { cards, total, cost }
  }
  // A short window beside a tall stack would only make the window empty, and a
  // tall window beside a short stack only makes the stack empty. A plain band
  // is more truthful than either; the stack is for a window with real output.
  if (best === undefined || windowHeight < 260 || Math.abs(best.total - windowHeight) > 220) return undefined
  return {
    band: {
      columns: [
        { span: wide, cards: [0] },
        { span: narrow, cards: best.cards },
      ],
    },
    used: [0, ...best.cards],
  }
}

/** The whole plan: one feature band when a window leads, then flat bands. */
function planMosaic(
  items: readonly MosaicItem[],
  rules: readonly SpanRule[],
  heights: readonly number[],
  cols: number,
): MosaicBand[] {
  const feature = featureBand(items, rules, heights, cols)
  if (feature === undefined) return planBands(rules, heights, cols)
  const used = new Set(feature.used)
  const remaining = rules.map((_, index) => index).filter(index => !used.has(index))
  return [feature.band, ...planBands(rules, heights, cols, remaining)]
}

/**
 * The measured mosaic surface. It lays out synchronously before paint: each
 * card first takes its preferred span so its natural height is measured, the
 * planner packs full-width bands, and each card is then placed at its column
 * start and row. A width change re-plans; content growth only grows the row.
 */
function Masonry(props: { readonly items: readonly MosaicItem[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const lastWidth = useRef(0)
  const lastLayout = useRef(0)
  const featureActive = useRef(false)
  const windowHeight = useRef(0)
  const signature = props.items.map(item => `${item.key}:${item.kind}:${item.weight ?? ''}`).join('|')

  const layout = (): void => {
    const surface = ref.current
    if (surface === null) return
    const cards = Array.from(surface.children) as HTMLElement[]
    if (cards.length !== props.items.length) return
    const cols = trackCount(surface.clientWidth)
    const rules = props.items.map(item => spanRule(item.kind, cols, item.weight))
    surface.style.setProperty('--arbor-cols', String(cols))
    for (let at = 0; at < cards.length; at += 1) {
      const card = cards[at]!
      card.style.gridColumn = ''
      card.style.gridRow = ''
      card.style.alignSelf = 'start'
      card.style.gridColumn = `span ${rules[at]!.pref}`
    }
    // Read every card after its width is set: the heights decide the bands.
    const heights = cards.map(card => card.getBoundingClientRect().height)
    const bands = planMosaic(props.items, rules, heights, cols)
    let row = 1
    for (const band of bands) {
      const rows = Math.max(...band.columns.map(column => column.cards.length))
      let start = 1
      for (const column of band.columns) {
        for (let at = 0; at < column.cards.length; at += 1) {
          const card = cards[column.cards[at]!]!
          const rowSpan = at === column.cards.length - 1 ? rows - (column.cards.length - 1) : 1
          card.style.gridColumn = `${start} / span ${column.span}`
          card.style.gridRow = `${row + at} / span ${rowSpan}`
          card.style.alignSelf = ''
        }
        start += column.span
      }
      row += rows
    }
    featureActive.current = bands[0]?.columns.some(column => column.cards.length > 1) === true
    windowHeight.current = props.items[0]?.kind === 'window' ? (heights[0] ?? 0) : 0
    lastWidth.current = surface.clientWidth
    lastLayout.current = performance.now()
  }

  useLayoutEffect(layout, [signature])
  useEffect(() => {
    const surface = ref.current
    if (surface === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (performance.now() - lastLayout.current < 120) return
      if (surface.clientWidth !== lastWidth.current) { layout(); return }
      // A window opens short and then receives its stream. Once its output has
      // made it tall, re-plan so the feature band can share that height; after
      // that, content growth only grows the row.
      if (props.items[0]?.kind !== 'window') return
      const first = surface.children[0]
      if (!(first instanceof HTMLElement)) return
      const height = first.getBoundingClientRect().height
      if (featureActive.current ? height < 240 : Math.abs(height - windowHeight.current) > 80) layout()
    })
    observer.observe(surface)
    for (const card of Array.from(surface.children)) observer.observe(card)
    return () => { observer.disconnect() }
  }, [signature])
  return createElement('div', { className: 'arbor-surface', ref }, ...props.items.map(item => item.node))
}

/** One icon button in the top-right actions. */
function IconButton(props: {
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}): ReactNode {
  return createElement('button', {
    type: 'button',
    className: 'arbor-icon-button',
    title: props.label,
    'aria-label': props.label,
    onClick: props.onClick,
  }, props.children)
}

/** The magnifier. */
function SearchIcon(): ReactNode {
  return createElement('svg', {
    viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
  },
    createElement('circle', { cx: 8.6, cy: 8.6, r: 5.4 }),
    createElement('path', { d: 'm12.7 12.7 3.6 3.6' }))
}

/** The settings control, as three sliders. */
function GearIcon(): ReactNode {
  return createElement('svg', {
    viewBox: '0 0 20 20', width: 18, height: 18, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true,
  },
    createElement('path', { d: 'M3 5.5h14M3 10h14M3 14.5h14' }),
    createElement('circle', { cx: 7.5, cy: 5.5, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1,#fff)' }),
    createElement('circle', { cx: 12.5, cy: 10, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1,#fff)' }),
    createElement('circle', { cx: 6.5, cy: 14.5, r: 1.8, fill: 'var(--dsw-alias-bg-layer-1,#fff)' }))
}

/** The close cross. */
function CloseIcon(): ReactNode {
  return createElement('svg', {
    viewBox: '0 0 20 20', width: 16, height: 16, fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true,
  },
    createElement('path', { d: 'm5 5 10 10M15 5 5 15' }))
}

/** The two top-right actions: arbor's search and settings. */
function TopActions(props: {
  readonly t: Translate
  readonly onSearch: () => void
  readonly onSettings: () => void
}): ReactNode {
  return createElement('div', { className: 'arbor-top-actions' },
    createElement(IconButton, { label: props.t('openSearch'), onClick: props.onSearch, children: createElement(SearchIcon) }),
    createElement(IconButton, { label: props.t('openSettings'), onClick: props.onSettings, children: createElement(GearIcon) }))
}

/** One card on the surface. Content first; the footer is metadata. */
function Card(props: {
  readonly className?: string
  readonly children?: ReactNode
  readonly attrs?: Readonly<Record<string, string>>
}): ReactNode {
  return createElement('section', {
    className: `arbor-card${props.className === undefined ? '' : ` ${props.className}`}`,
    ...(props.attrs ?? {}),
  }, props.children)
}

/** A card's small kicker and, when present, the state on its right. */
function CardHead(props: {
  readonly kicker: string
  readonly aside?: ReactNode
}): ReactNode {
  return createElement('div', { className: 'arbor-card-head' },
    createElement('span', { className: 'arbor-card-kicker arbor-label', 'data-arbor-text': 'display' }, props.kicker),
    props.aside === undefined ? null : createElement('span', { className: 'arbor-card-aside' }, props.aside))
}

/** A card's metadata line. */
function CardFoot(props: { readonly children?: ReactNode }): ReactNode {
  return createElement('footer', { className: 'arbor-card-foot arbor-label', 'data-arbor-text': 'body' }, props.children)
}

/** The state chip on a card. */
function StateChip(props: { readonly state: ArborWindowFacts['state']; readonly t: Translate }): ReactNode {
  return createElement('span', {
    className: `arbor-state arbor-state-${props.state} arbor-label`,
    'data-arbor-text': 'display',
  }, props.t(props.state === 'running' ? 'statusRunning' : props.state === 'idle' ? 'statusIdle' : props.state === 'paused' ? 'statusPaused' : 'statusEnded'))
}

/** The empty card, with copy that says what will fill it. */
function EmptyCard(props: {
  readonly title: string
  readonly hint: string
}): ReactNode {
  return createElement(Card, { className: 'arbor-empty-card' },
    createElement('div', { className: 'arbor-empty-mark', 'aria-hidden': true }),
    createElement('div', { className: 'arbor-empty-title', 'data-arbor-text': 'display' }, props.title),
    createElement('div', { className: 'arbor-empty-hint', 'data-arbor-text': 'body' }, props.hint))
}

/** The live window's own stream: the model writing, and the `send` taking shape. */
function Stream(props: {
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly t: Translate
}): ReactNode {
  const text = props.stream?.text ?? ''
  const send = props.stream?.send ?? ''
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 360 || send.length > 360
  return createElement('div', { className: 'arbor-stream-block', 'data-arbor-stream': true },
    createElement('div', { className: 'arbor-stream-head' },
      createElement('span', { className: `arbor-pulse${props.stream?.streaming === true ? ' is-live' : ''}` }),
      createElement('span', { className: 'arbor-stream-label arbor-label', 'data-arbor-text': 'display' }, props.t('streamText'))),
    text === ''
      ? createElement('div', { className: 'arbor-stream-empty', 'data-arbor-text': 'body' }, props.t('streamEmpty'))
      : createElement('div', { className: `arbor-md-wrap${long && !expanded ? ' is-clamped' : ''}`, 'data-arbor-text': 'body' },
        createElement(MarkdownText, { text })),
    send === ''
      ? null
      : createElement('div', { className: 'arbor-stream-send' },
        createElement('div', { className: 'arbor-stream-label arbor-label' }, props.t('streamSend')),
        createElement('div', { className: `arbor-md-wrap${long && !expanded ? ' is-clamped' : ''}`, 'data-arbor-text': 'body' },
          createElement(MarkdownText, { text: send }))),
    long ? createElement('button', {
      type: 'button',
      className: 'arbor-stream-toggle arbor-label',
      'data-arbor-text': 'display',
      onClick: () => { setExpanded(value => !value) },
    }, props.t(expanded ? 'collapseStream' : 'expandStream')) : null)
}

/** One live window as a card: what it is doing first, then its output. */
function LiveWindowCard(props: {
  readonly window: ArborWindowFacts
  readonly session: ArborHostSessionFacts | undefined
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly t: Translate
}): ReactNode {
  const { window, session, stream, t } = props
  const state = shownState(window, stream)
  return createElement(Card, { className: `arbor-window-card arbor-window-${state}`, attrs: { 'data-arbor-window': window.ref } },
    createElement(CardHead, {
      kicker: `${t('filterWindows')} · ${window.ref}`,
      aside: createElement(StateChip, { state, t }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, window.doing ?? (session === undefined ? t('live') : sessionTitle(session))),
    window.live ? createElement(Stream, { stream, t }) : null,
    createElement(CardFoot, null,
      session === undefined ? null : createElement('span', { className: 'arbor-card-session' }, sessionTitle(session)),
      createElement('span', { className: 'arbor-num' }, window.used === undefined ? '—' : `${compact(window.used)} / ${compact(window.limit)}`),
      window.startedAt === undefined ? null : createElement('span', null, ' · ', clock(window.startedAt, t))))
}

/** The current window of a session tab, even when it has ended. */
function WindowCard(props: {
  readonly window: ArborWindowFacts
  readonly session: ArborHostSessionFacts | undefined
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly t: Translate
}): ReactNode {
  const { window, session, stream, t } = props
  const state = shownState(window, stream)
  return createElement(Card, { className: `arbor-window-card arbor-window-${state}`, attrs: { 'data-arbor-window': window.ref } },
    createElement(CardHead, {
      kicker: `${t('filterWindows')} · ${window.ref}`,
      aside: createElement(StateChip, { state, t }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, window.doing ?? (session === undefined ? t('live') : sessionTitle(session))),
    window.live ? createElement(Stream, { stream, t }) : null,
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, window.used === undefined ? '—' : `${compact(window.used)} / ${compact(window.limit)}`),
      window.endReason === undefined ? null : createElement('span', null, ' · ', endLabel(t, window.endReason)),
      window.startedAt === undefined ? null : createElement('span', null, ' · ', clock(window.startedAt, t))))
}

/** The chain as a row of nodes, with the link that carried each continuation. */
function ChainCard(props: {
  readonly session: ArborHostSessionFacts | undefined
  readonly windows: readonly ArborWindowFacts[]
  readonly streams: Readonly<Record<string, WindowStreamView>>
  readonly t: Translate
}): ReactNode {
  const { session, windows, t } = props
  if (windows.length === 0) return null
  const shown = shownWindows(windows, props.streams)
  const handoffs = windows.filter(window => window.handoff !== undefined && (
    window.handoff.topics !== undefined || window.handoff.progress !== undefined ||
    window.handoff.pending !== undefined || window.handoff.agreements !== undefined))
  return createElement(Card, { className: 'arbor-chain-card' },
    createElement(CardHead, {
      kicker: t('cardChain'),
      aside: session === undefined ? undefined : createElement('span', { className: 'arbor-card-session arbor-label' }, sessionTitle(session)),
    }),
    createElement('div', { className: 'arbor-chain-scroll' },
      createElement('div', { className: 'arbor-chain' },
        shown.flatMap((window, index) => {
          const next = shown[index + 1]
          const link = next?.continuationOf === window.ref && window.endReason === 'host_restart'
            ? t('chainRestart')
            : undefined
          const node = createElement('div', {
            className: `arbor-node arbor-node-${window.state}`,
            key: `node-${window.ref}`,
            'data-arbor-window': window.ref,
          },
            createElement('span', { className: 'arbor-node-ref arbor-num' }, window.ref),
            createElement('span', { className: 'arbor-node-state arbor-label' }, stateLabel(t, window)),
            window.handoff === undefined ? null : createElement('span', { className: 'arbor-node-handoff arbor-tag arbor-tag-warn' }, t('handoff')))
          if (next === undefined) return [node]
          return [node, createElement('div', { className: 'arbor-connector', key: `edge-${window.ref}` },
            createElement('span', { className: 'arbor-connector-line', 'aria-hidden': true }),
            link === undefined ? null : createElement('span', { className: 'arbor-connector-label arbor-label' }, link),
            createElement('span', { className: 'arbor-connector-arrow', 'aria-hidden': true }, '→'))]
        })),
    ),
    handoffs.length === 0 ? null : createElement('div', { className: 'arbor-handoffs' },
      handoffs.map(window => createElement('div', { className: 'arbor-handoff-row', key: `h-${window.ref}` },
        createElement('span', { className: 'arbor-handoff-ref arbor-num' }, `${window.ref} ${t('handoff')}`),
        createElement('span', { className: 'arbor-handoff-text', 'data-arbor-text': 'body' },
          [...(window.handoff?.topics ?? []), ...(window.handoff?.progress ?? []), ...(window.handoff?.pending ?? [])].join(' · '))))),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, chainSummary(t, shown))))
}

/** One session, as the card that opens its own tab. */
function SessionCard(props: {
  readonly session: ArborHostSessionFacts
  readonly streams: Readonly<Record<string, WindowStreamView>>
  readonly t: Translate
  readonly onOpen: (sessionId: string) => void
}): ReactNode {
  const { session, t, onOpen } = props
  const shown = shownWindows(session.windows, props.streams)
  const last = liveWindowOf(shown) ?? shown.at(-1)
  return createElement(Card, { className: 'arbor-session-card', attrs: { 'data-arbor-session': session.sessionId } },
    createElement(CardHead, {
      kicker: t('cardSession'),
      aside: createElement('span', { className: `arbor-dot arbor-dot-${last?.state ?? 'ended'}` }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, sessionTitle(session)),
    createElement('div', { className: 'arbor-card-project', 'data-arbor-text': 'code' }, projectLabel(session)),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, chainSummary(t, shown)),
      createElement('button', {
        type: 'button',
        className: 'arbor-card-link arbor-label',
        onClick: () => { onOpen(session.sessionId) },
      }, t('openSessionTab'), ' →')))
}

/** A board line as a sticky note: what it is doing first. */
function BoardCard(props: { readonly line: ArborBoardFacts; readonly streaming: boolean; readonly t: Translate }): ReactNode {
  const { line, streaming, t } = props
  const state = streaming ? 'running' : line.state
  return createElement(Card, { className: 'arbor-board-card' },
    createElement(CardHead, { kicker: t('filterBoard'), aside: createElement('span', { className: 'arbor-card-session arbor-label' }, boardStateLabel(t, state)) }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'body' }, line.doing),
    line.openWork === undefined || line.openWork.length === 0
      ? null
      : createElement('div', { className: 'arbor-tags' },
        line.openWork.map(item => createElement('span', { className: 'arbor-tag arbor-tag-warn', key: item }, item))),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, line.window),
      createElement('span', null, ' · ', boardStateLabel(t, state)),
      createElement('span', { className: 'arbor-num' }, ` · ${compact(line.usage.used)} / ${compact(line.usage.limit)}`)))
}

/** One active note as a sticky note. */
function NoteCard(props: { readonly note: ArborNotesFacts['items'][number]; readonly t: Translate }): ReactNode {
  const { note, t } = props
  return createElement(Card, { className: 'arbor-note-card' },
    createElement(CardHead, { kicker: t('filterNotes'), aside: createElement('span', { className: 'arbor-card-session arbor-num' }, note.ref) }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, note.title),
    note.summary === '' ? null : createElement('div', { className: 'arbor-note-sum', 'data-arbor-text': 'body' }, note.summary),
    createElement(CardFoot, null,
      createElement('span', null, t('notesActive')),
      createElement('span', { className: 'arbor-num' }, ` · ${clock(note.time, t)}`)))
}

/** `/env` as one compact surface card. */
function EnvCard(props: { readonly env: ArborEnvFacts; readonly t: Translate }): ReactNode {
  const { env, t } = props
  const skills = env.items.filter(item => item.kind === 'skill')
  const servers = env.items.filter(item => item.kind === 'mcp')
  const services = env.items.filter(item => item.kind === 'service')
  return createElement(Card, { className: 'arbor-env-card' },
    createElement(CardHead, { kicker: t('cardEnvironment') }),
    createElement('div', { className: 'arbor-env-counts' },
      createElement('span', { className: 'arbor-env-count' }, createElement('span', { className: 'arbor-env-big arbor-num' }, String(skills.length)), createElement('span', { className: 'arbor-label' }, ` ${t('envSkills')}`)),
      createElement('span', { className: 'arbor-env-count' }, createElement('span', { className: 'arbor-env-big arbor-num' }, String(servers.length)), createElement('span', { className: 'arbor-label' }, ` ${t('envMcp')}`)),
      createElement('span', { className: 'arbor-env-count' }, createElement('span', { className: 'arbor-env-big arbor-num' }, String(services.length)), createElement('span', { className: 'arbor-label' }, ` ${t('envServices')}`))),
    skills.length === 0 ? null : createElement('div', { className: 'arbor-env-group' },
      createElement('div', { className: 'arbor-env-group-title arbor-label' }, t('envSkills')),
      skills.map(item => createElement('div', { className: 'arbor-env-row', key: `sk:${item.name}` },
        createElement('span', { className: 'arbor-env-name', 'data-arbor-text': 'display' }, item.name),
        item.builtin === true ? createElement('span', { className: 'arbor-tag arbor-tag-ok' }, t('envBuiltin')) : null))),
    servers.length === 0 ? null : createElement('div', { className: 'arbor-env-group' },
      createElement('div', { className: 'arbor-env-group-title arbor-label' }, t('envMcp')),
      servers.map(item => createElement('div', { className: 'arbor-env-row', key: `mcp:${item.name}` },
        createElement('span', { className: 'arbor-env-name', 'data-arbor-text': 'display' }, item.name),
        createElement('span', { className: 'arbor-env-functions' }, item.functions === undefined || item.functions.length === 0 ? '—' : item.functions.join(' · '))))),
    services.length === 0 ? null : createElement('div', { className: 'arbor-env-group' },
      createElement('div', { className: 'arbor-env-group-title arbor-label' }, t('envServices')),
      services.map(item => createElement('div', { className: 'arbor-env-row', key: `svc:${item.name}` },
        createElement('span', { className: 'arbor-env-name', 'data-arbor-text': 'display' }, item.name),
        createElement('span', { className: `arbor-tag arbor-tag-${item.state === 'running' ? 'ok' : item.state === 'failed' ? 'err' : 'warn'}` }, item.state ?? '—')))))
}

/** One schedule as a card. */
function ScheduleCard(props: { readonly schedule: ArborScheduleFacts; readonly t: Translate }): ReactNode {
  const { schedule, t } = props
  const repeat = schedule.everyMs !== undefined
    ? t('scheduleEvery', { value: duration(t, schedule.everyMs) ?? String(schedule.everyMs) })
    : schedule.dailyAt !== undefined
      ? t('scheduleDaily', { value: schedule.dailyAt })
      : schedule.weekdays !== undefined
        ? t('scheduleWeekly', { value: schedule.weekdays.join(' ') })
        : ''
  return createElement(Card, { className: 'arbor-schedule-card' },
    createElement(CardHead, {
      kicker: t('cardSchedules'),
      aside: schedule.paused ? createElement('span', { className: 'arbor-tag arbor-tag-warn' }, t('schedulePaused')) : undefined,
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, schedule.name ?? schedule.ref),
    createElement('div', { className: 'arbor-schedule-next arbor-num', 'data-arbor-text': 'numeric' }, t('scheduleNext', { time: clock(schedule.nextAt, t) })),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, schedule.ref),
      repeat === '' ? null : createElement('span', null, ` · ${repeat}`),
      schedule.fired === undefined ? null : createElement('span', { className: 'arbor-num' }, ` · ${t('scheduleFired', { count: schedule.fired })}`)))
}

/** The session's `<workspace>`, as one card. */
function WorkspaceCard(props: { readonly workspace: ArborWorkspaceFacts; readonly t: Translate }): ReactNode {
  const { workspace, t } = props
  const projectPath = workspace.project?.path
  const showCwd = workspace.cwd !== undefined && workspace.cwd !== projectPath
  const hasFooter = workspace.pointers.length > 0 || workspace.checkouts.length > 0 || workspace.keeps.length > 0 || workspace.openWork.length > 0
  return createElement(Card, { className: 'arbor-workspace-card' },
    createElement(CardHead, { kicker: t('cardWorkspace') }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, workspace.project?.name ?? workspace.cwd ?? t('none')),
    projectPath === undefined ? null : createElement('div', { className: 'arbor-card-project arbor-mono', 'data-arbor-text': 'code' }, projectPath),
    createElement('div', { className: 'arbor-workspace-rows' },
      showCwd ? createElement('div', { className: 'arbor-workspace-row' },
        createElement('span', { className: 'arbor-label' }, t('workspaceCwd')),
        createElement('span', { className: 'arbor-mono' }, workspace.cwd)) : null,
      workspace.pointers.length === 0 ? null : createElement('div', { className: 'arbor-workspace-row' },
        createElement('span', { className: 'arbor-label' }, t('workspacePointers')),
        createElement('span', { className: 'arbor-workspace-list' }, workspace.pointers.map(pointer => createElement('span', { key: pointer.path, className: 'arbor-workspace-item' },
          createElement('span', null, pointer.name),
          createElement('span', { className: 'arbor-mono' }, pointer.path))))),
      workspace.checkouts.length === 0 ? null : createElement('div', { className: 'arbor-workspace-row' },
        createElement('span', { className: 'arbor-label' }, t('workspaceCheckouts')),
        createElement('span', { className: 'arbor-workspace-list' }, workspace.checkouts.map(checkout => createElement('span', { className: 'arbor-workspace-item', key: checkout.path },
          createElement('span', { className: 'arbor-mono' }, checkout.name),
          createElement('span', { className: `arbor-tag arbor-tag-${checkout.dirty ? 'warn' : 'ok'}` }, checkout.dirty ? t('workspaceDirty') : t('workspaceClean')))))),
      workspace.keeps.length === 0 ? null : createElement('div', { className: 'arbor-workspace-row' },
        createElement('span', { className: 'arbor-label' }, t('workspaceKeeps')),
        createElement('span', { className: 'arbor-workspace-list' }, workspace.keeps.map(keep => createElement('span', { className: 'arbor-workspace-item', key: keep.path },
          createElement('span', null, keep.name),
          createElement('span', { className: 'arbor-mono' }, keep.path))))),
      workspace.openWork.length === 0 ? null : createElement('div', { className: 'arbor-workspace-row' },
        createElement('span', { className: 'arbor-label' }, t('workspaceOpenWork')),
        createElement('span', { className: 'arbor-workspace-list' }, workspace.openWork.map(item => createElement('span', { className: 'arbor-workspace-item', key: `${item.window}:${item.name}` },
          createElement('span', { className: 'arbor-num' }, item.window),
          createElement('span', null, item.name)))))),
    hasFooter
      ? createElement(CardFoot, null,
        workspace.pointers.length === 0 ? null : createElement('span', { className: 'arbor-num' }, `${workspace.pointers.length} ${t('workspacePointers')}`),
        workspace.checkouts.length === 0 ? null : createElement('span', { className: 'arbor-num' }, `${workspace.checkouts.length} ${t('workspaceCheckouts')}`))
      : null)
}

/** One settings row. */
function SettingRow(props: { readonly label: string; readonly children?: ReactNode }): ReactNode {
  return createElement('div', { className: 'arbor-setting-row' },
    createElement('span', { className: 'arbor-setting-key arbor-label' }, props.label),
    createElement('span', { className: 'arbor-setting-value' }, props.children))
}

/** Arbor's own settings, and which DSH card does not govern a window. */
function SettingsBlock(props: {
  readonly settings: ArborSettingsFacts
  readonly dataRoot: string
  readonly backend: string
  readonly shared: string
  readonly t: Translate
}): ReactNode {
  const { settings, dataRoot, backend, shared, t } = props
  const tiers = Object.entries(settings.modelTiers ?? {})
  const judge = Object.entries(settings.judge?.modes ?? {})
  const judgeLabel = (mode: string): string => mode === 'off' ? t('settingsJudgeOff') : mode === 'shadow' ? t('settingsJudgeShadow') : t('settingsJudgeOn')
  const window = settings.window ?? {}
  const notes = settings.notes ?? {}
  const windowLine = [
    window.idleSeconds === undefined ? '' : `${t('settingsIdle')} ${t('seconds', { value: window.idleSeconds })}`,
    window.contextTokens === undefined ? '' : `${t('settingsContext')} ${compact(window.contextTokens)}`,
    window.reserveTokens === undefined ? '' : `${t('settingsReserve')} ${compact(window.reserveTokens)}`,
    window.protectionSeconds === undefined ? '' : `${t('settingsProtection')} ${t('seconds', { value: window.protectionSeconds })}`,
  ].filter(Boolean).join(' · ')
  const notesLine = [
    notes.activeCount === undefined ? '' : `${t('settingsNotesCount')} ${notes.activeCount}`,
    notes.activeTokenBudget === undefined ? '' : `${t('settingsNotesTokens')} ${compact(notes.activeTokenBudget)}`,
  ].filter(Boolean).join(' · ')
  return createElement('div', { className: 'arbor-settings' },
    createElement('div', { className: 'arbor-settings-source arbor-muted' }, t(settings.source === 'environment' ? 'settingsSourceEnvironment' : 'settingsSourceDeployment')),
    createElement('div', { className: 'arbor-settings-group' },
      createElement('div', { className: 'arbor-settings-group-title arbor-label', 'data-arbor-text': 'display' }, t('settingsHostData')),
      createElement(SettingRow, { label: t('dataRoot') }, createElement('span', { className: 'arbor-mono' }, dataRoot)),
      createElement(SettingRow, { label: t('settingsBackend') }, createElement('span', { className: 'arbor-label' }, backend)),
      createElement(SettingRow, { label: t('settingsShared') }, createElement('span', { className: 'arbor-mono' }, shared))),
    settings.identity === undefined ? null : createElement(SettingRow, { label: t('settingsIdentity') },
      createElement('span', { className: 'arbor-clamp' }, settings.identity)),
    settings.generalRules === undefined || settings.generalRules.length === 0 ? null : createElement(SettingRow, { label: t('settingsRules') },
      createElement('span', { className: 'arbor-num' }, String(settings.generalRules.length))),
    tiers.length === 0 ? null : createElement(SettingRow, { label: t('settingsTiers') },
      createElement('span', { className: 'arbor-mono arbor-settings-wrap' }, tiers.map(([tier, model]) => `${tier} → ${model}`).join(' · '))),
    settings.defaultTier === undefined ? null : createElement(SettingRow, { label: t('settingsDefaultTier') },
      createElement('span', { className: 'arbor-label' }, settings.defaultTier)),
    judge.length === 0 ? null : createElement(SettingRow, { label: t('settingsJudge') },
      createElement('span', { className: 'arbor-tags' }, judge.map(([kind, mode]) => createElement('span', {
        key: kind,
        className: `arbor-tag arbor-tag-${mode === 'off' ? 'plain' : mode === 'shadow' ? 'warn' : 'ok'}`,
      }, `${kind} ${judgeLabel(mode)}`)))),
    windowLine === '' ? null : createElement(SettingRow, { label: t('settingsWindow') }, createElement('span', { className: 'arbor-num' }, windowLine)),
    notesLine === '' ? null : createElement(SettingRow, { label: t('settingsNotes') }, createElement('span', { className: 'arbor-num' }, notesLine)),
    settings.secrets === undefined || settings.secrets.length === 0 ? null : createElement(SettingRow, { label: t('settingsSecrets') },
      createElement('span', { className: 'arbor-mono arbor-settings-wrap' }, settings.secrets.join(' · '))),
    createElement('div', { className: 'arbor-settings-note' }, t('settingsDsh')))
}

/** One search result row. */
function SearchGroup(props: { readonly label: string; readonly rows: readonly ReactNode[] }): ReactNode {
  if (props.rows.length === 0) return null
  return createElement('div', { className: 'arbor-search-group' },
    createElement('div', { className: 'arbor-search-group-title arbor-label', 'data-arbor-text': 'display' }, props.label),
    props.rows)
}

/** Arbor's own search over its journal, notes and board. */
function SearchBlock(props: { readonly t: Translate }): ReactNode {
  const { t } = props
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{
    journal: Array<{ ref: string; kind: string; window: string | null; summary: string }>
    notes: Array<{ ref: string; title: string; summary: string }>
    board: Array<{ window: string; doing: string }>
    total: number
  } | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    const text = query.trim()
    if (text === '') return
    setBusy(true)
    setError(undefined)
    try {
      const response = await fetch(`/api/arbor/search?q=${encodeURIComponent(text)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`search answered ${response.status}`)
      const body = await response.json() as {
        journal: Array<{ ref: string; kind: string; window: string | null; summary: string }>
        notes: Array<{ ref: string; title: string; summary: string }>
        board: Array<{ window: string; doing: string }>
        total: number
      }
      setResult(body)
    } catch (cause: unknown) {
      setResult(undefined)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return createElement('div', { className: 'arbor-search' },
    createElement('div', { className: 'arbor-search-row' },
      createElement('input', {
        className: 'arbor-search-input',
        value: query,
        placeholder: t('searchPlaceholder'),
        autoFocus: true,
        onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === 'Enter') { event.preventDefault(); void run() }
        },
      }),
      createElement('button', {
        className: 'arbor-search-go arbor-label',
        'data-arbor-text': 'display',
        type: 'button',
        disabled: busy || query.trim() === '',
        onClick: () => { void run() },
      }, t('searchButton'))),
    createElement('div', { className: 'arbor-search-hint' }, t('searchHint')),
    error === undefined ? null : createElement('div', { className: 'arbor-error' }, t('searchError', { message: error })),
    result === undefined
      ? null
      : result.total === 0
        ? createElement('div', { className: 'arbor-search-empty' }, t('searchEmpty'))
        : createElement('div', { className: 'arbor-search-results' },
          createElement('div', { className: 'arbor-search-total arbor-num' }, t('searchTotal', { count: result.total })),
          createElement(SearchGroup, {
            label: t('searchJournal'),
            rows: result.journal.map(hit => createElement('div', { className: 'arbor-hit', key: hit.ref },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-hit-ref arbor-num' }, hit.ref),
                createElement('span', { className: 'arbor-hit-kind arbor-label' }, hit.kind),
                hit.window === null ? null : createElement('span', { className: 'arbor-hit-window arbor-num' }, hit.window)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.summary))),
          }),
          createElement(SearchGroup, {
            label: t('searchNotes'),
            rows: result.notes.map(hit => createElement('div', { className: 'arbor-hit', key: hit.ref },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-hit-ref arbor-num' }, hit.ref),
                createElement('span', { className: 'arbor-hit-kind arbor-label' }, hit.title)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.summary))),
          }),
          createElement(SearchGroup, {
            label: t('searchBoard'),
            rows: result.board.map(hit => createElement('div', { className: 'arbor-hit', key: hit.window },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-hit-ref arbor-num' }, hit.window)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.doing))),
          })))
}

/** A modal surface for search and settings, with the page's own chrome. */
function Sheet(props: {
  readonly title: string
  readonly close: string
  readonly onClose: () => void
  readonly children?: ReactNode
}): ReactNode {
  return createElement('div', { className: 'arbor-sheet-layer' },
    createElement('div', { className: 'arbor-sheet-backdrop', onClick: props.onClose }),
    createElement('section', { className: 'arbor-sheet', role: 'dialog', 'aria-modal': true, 'aria-label': props.title },
      createElement('header', { className: 'arbor-sheet-head' },
        createElement('h2', { className: 'arbor-sheet-title', 'data-arbor-text': 'display' }, props.title),
        createElement('button', { type: 'button', className: 'arbor-icon-button', title: props.close, 'aria-label': props.close, onClick: props.onClose }, createElement(CloseIcon))),
      createElement('div', { className: 'arbor-sheet-body' }, props.children)))
}

/** The bottom filter dock. */
function Dock(props: { readonly filter: Filter; readonly setFilter: (filter: Filter) => void; readonly t: Translate }): ReactNode {
  const label = (filter: Filter): string => {
    if (filter === 'all') return props.t('filterAll')
    if (filter === 'windows') return props.t('filterWindows')
    if (filter === 'board') return props.t('filterBoard')
    if (filter === 'notes') return props.t('filterNotes')
    if (filter === 'env') return props.t('filterEnv')
    return props.t('filterSchedules')
  }
  return createElement('nav', { className: 'arbor-dock', 'aria-label': props.t('pageTitle') },
    createElement('div', { className: 'arbor-dock-pills', role: 'tablist' },
      FILTERS.map(filter => createElement('button', {
        key: filter,
        type: 'button',
        role: 'tab',
        'aria-selected': props.filter === filter,
        className: `arbor-pill${props.filter === filter ? ' is-active' : ''} arbor-label`,
        'data-arbor-text': 'display',
        onClick: () => { props.setFilter(filter) },
      }, label(filter)))))
}

/** The whole-host overview: editorial hero, host cards, and the filter dock. */
function Overview(props: {
  readonly facts: ArborHostFacts
  readonly snapshot: FactsSnapshot<ArborHostFacts>
  readonly t: Translate
  readonly filter: Filter
  readonly setFilter: (filter: Filter) => void
  readonly onSearch: () => void
  readonly onSettings: () => void
  readonly onOpenSession: (sessionId: string) => void
}): ReactNode {
  const { facts, snapshot, t, filter, setFilter, onSearch, onSettings, onOpenSession } = props
  const live = facts.windows.filter(window => window.live)
  const active = facts.windows.filter(window => shownState(window, snapshot.streams[window.ref]) === 'running')
  const sessions = facts.sessions
  const latest = active.at(-1)
  const ended = facts.windows.filter(window => window.state === 'ended').length
  // An idle window is still live — arbor keeps it open for the next turn — so
  // "live" cannot decide the sentence. A session waits when it has a window,
  // none of its windows is running, and its last window is idle. A blank
  // session has no label and is not in `sessions` at all, so it never counts.
  const waiting = sessions.filter(session => session.windows.length > 0 &&
    !session.windows.some(window => shownState(window, snapshot.streams[window.ref]) === 'running') &&
    session.windows.at(-1)?.state === 'idle').length
  const show = (section: Filter): boolean => filter === 'all' || filter === section
  const heroContent: ReactNode[] = sessions.length === 0
    ? [createElement('span', { key: 'empty' }, t('heroEmpty')), createElement('span', { className: 'arbor-hero-hint', key: 'empty-hint', 'data-arbor-text': 'body' }, t('heroEmptyHint'))]
    : latest === undefined
      ? waiting > 0
        ? hero(t(waiting === 1 ? 'heroIdleWaitOne' : 'heroIdleWait'), { waiting: String(waiting), ended: String(ended) })
        : hero(t(sessions.length === 1 ? 'heroIdleOne' : 'heroIdle'), { sessions: String(sessions.length), ended: String(ended) })
      : hero(t(facts.board.length === 0
        ? waiting > 0 ? 'heroLiveNoBoardWait' : 'heroLiveNoBoard'
        : waiting > 0 ? 'heroLiveWait' : 'heroLive'), {
        window: latest.ref,
        board: String(facts.board.length),
        waiting: String(waiting),
      })
  const cards: MosaicItem[] = []
  if (sessions.length > 0) {
    if (show('windows')) {
      for (const window of live) {
        cards.push({
          key: `live-${window.ref}`,
          kind: 'window',
          node: createElement(LiveWindowCard, {
            window,
            session: sessions.find(session => session.windows.some(one => one.ref === window.ref)),
            stream: snapshot.streams[window.ref],
            t,
          }),
        })
      }
    }
    // The env is the window's tall neighbour: its names and counts sit beside
    // a live window instead of stretching a short card to a tall row.
    if (show('env')) {
      cards.push({ key: 'env', kind: 'env', node: createElement(EnvCard, { env: facts.env, t }) })
    }
    if (show('windows')) {
      for (const session of sessions) {
        cards.push({
          key: `chain-${session.sessionId}`,
          kind: 'chain',
          weight: chainWeight(session.windows.length),
          node: createElement(ChainCard, { session, windows: session.windows, streams: snapshot.streams, t }),
        })
      }
      if (live.length === 0 && filter === 'windows') {
        cards.push({ key: 'empty-windows', kind: 'empty', node: createElement(EmptyCard, { title: t('emptyWindows'), hint: t('emptyWindowsHint') }) })
      }
    }
    if (show('all') || filter === 'windows') {
      for (const session of sessions) {
        cards.push({
          key: `session-${session.sessionId}`,
          kind: 'session',
          node: createElement(SessionCard, { session, streams: snapshot.streams, t, onOpen: onOpenSession }),
        })
      }
    }
    if (show('board')) {
      for (const line of facts.board) {
        cards.push({
          key: `board-${line.window}`,
          kind: 'board',
          node: createElement(BoardCard, { line, streaming: snapshot.streams[line.window]?.streaming === true, t }),
        })
      }
      if (facts.board.length === 0 && filter === 'board') {
        cards.push({ key: 'empty-board', kind: 'empty', node: createElement(EmptyCard, { title: t('emptyBoard'), hint: t('emptyBoardHint') }) })
      }
    }
    if (show('notes')) {
      for (const note of facts.notes.items) {
        cards.push({ key: `note-${note.ref}`, kind: 'note', node: createElement(NoteCard, { note, t }) })
      }
      if (facts.notes.items.length === 0 && filter === 'notes') {
        cards.push({ key: 'empty-notes', kind: 'empty', node: createElement(EmptyCard, { title: t('emptyNotes'), hint: t('emptyNotesHint') }) })
      }
    }
    if (show('schedules')) {
      for (const schedule of facts.schedules) {
        cards.push({
          key: `schedule-${schedule.ref}`,
          kind: 'schedule',
          node: createElement(ScheduleCard, { schedule, t }),
        })
      }
      if (facts.schedules.length === 0 && filter === 'schedules') {
        cards.push({ key: 'empty-schedules', kind: 'empty', node: createElement(EmptyCard, { title: t('emptySchedules'), hint: t('emptySchedulesHint') }) })
      }
    }
  }
  return createElement('div', { className: 'arbor-overview' },
    createElement('header', { className: 'arbor-hero' },
      createElement('div', { className: 'arbor-hero-top' },
        createElement('span', { className: 'arbor-date arbor-label', 'data-arbor-text': 'numeric' }, dateLine(t, facts.at)),
        createElement(TopActions, { t, onSearch, onSettings })),
      createElement('h1', { className: 'arbor-hero-title', 'data-arbor-text': 'display' }, ...heroContent)),
    createElement(Masonry, { items: cards }),
    sessions.length === 0 ? null : createElement(Dock, { filter, setFilter, t }))
}

/** One session's tab: the same editorial language, scoped to its own state. */
function SessionView(props: {
  readonly sessionId: string
  readonly session: ArborHostSessionFacts | undefined
  readonly t: Translate
  readonly onSearch: () => void
  readonly onSettings: () => void
  readonly openDshSession?: (sessionId: string) => void
}): ReactNode {
  const { sessionId, session, t, onSearch, onSettings, openDshSession } = props
  const snapshot = useChannel(channelFor(sessionId))
  const facts = snapshot.facts
  if (facts === undefined) {
    return createElement('div', { className: 'arbor-overview', 'data-arbor-page': true, 'data-arbor-session-view': sessionId },
      createElement('header', { className: 'arbor-hero' },
        createElement('div', { className: 'arbor-hero-top' },
          createElement('span', { className: 'arbor-date arbor-label', 'data-arbor-text': 'numeric' }, dateLine(t, Date.now())),
          createElement(TopActions, { t, onSearch, onSettings }))),
      createElement(Masonry, {
        items: [{
          key: 'loading',
          kind: 'loading',
          node: createElement(Card, { className: 'arbor-loading-card' },
            createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, t('loading')),
            snapshot.status === 'error' && snapshot.error !== undefined
              ? createElement('div', { className: 'arbor-error' }, t('error', { message: snapshot.error }))
              : null),
        }],
      }))
  }
  const windows = facts.windows
  const now = liveWindowOf(windows) ?? windows.at(-1)
  const nowState = now === undefined ? undefined : shownState(now, snapshot.streams[now.ref])
  const heroContent: ReactNode[] = windows.length === 0
    ? [createElement('span', { key: 'none' }, t('sessionHeroEmpty')), createElement('span', { className: 'arbor-hero-hint', key: 'hint', 'data-arbor-text': 'body' }, t('sessionHeroEmptyHint'))]
    : now === undefined
      ? [createElement('span', { key: 'none' }, t('sessionHeroEmpty'))]
      : nowState === 'running'
        ? now.continuationOf === undefined
          ? hero(t('sessionHeroFirst'), { window: now.ref, board: String(facts.board.length) })
          : hero(t('sessionHeroLive'), { window: now.ref, previous: now.continuationOf, board: String(facts.board.length) })
        : nowState === 'idle'
          ? hero(t('sessionHeroIdle'), { window: now.ref })
          : hero(t('sessionHeroEnded'), { count: String(windows.length), window: now.ref })
  const cards: MosaicItem[] = []
  if (windows.length === 0) {
    cards.push({ key: 'empty', kind: 'empty', node: createElement(EmptyCard, { title: t('emptyWindows'), hint: t('sessionHeroEmptyHint') }) })
  } else {
    // The current window and the workspace are the tall pair; the chain and
    // the board follow, and the notes fill the low ground.
    if (now !== undefined) {
      cards.push({
        key: `window-${now.ref}`,
        kind: 'window',
        node: createElement(WindowCard, { window: now, session, stream: snapshot.streams[now.ref], t }),
      })
    }
    cards.push({ key: 'workspace', kind: 'workspace', node: createElement(WorkspaceCard, { workspace: facts.workspace, t }) })
    cards.push({
      key: 'chain',
      kind: 'chain',
      weight: chainWeight(windows.length),
      node: createElement(ChainCard, { session, windows, streams: snapshot.streams, t }),
    })
    for (const line of facts.board) {
      cards.push({
        key: `board-${line.window}`,
        kind: 'board',
        node: createElement(BoardCard, { line, streaming: snapshot.streams[line.window]?.streaming === true, t }),
      })
    }
    for (const note of facts.notes.items) {
      cards.push({ key: `note-${note.ref}`, kind: 'note', node: createElement(NoteCard, { note, t }) })
    }
  }
  return createElement('div', { className: 'arbor-overview', 'data-arbor-page': true, 'data-arbor-session-view': sessionId },
    createElement('header', { className: 'arbor-hero' },
      createElement('div', { className: 'arbor-hero-top' },
        createElement('span', { className: 'arbor-date arbor-label', 'data-arbor-text': 'numeric' }, dateLine(t, facts.at)),
        createElement(TopActions, { t, onSearch, onSettings })),
      createElement('h1', { className: 'arbor-hero-title', 'data-arbor-text': 'display' }, ...heroContent),
      openDshSession === undefined ? null : createElement('div', { className: 'arbor-hero-links' },
        createElement('button', { type: 'button', className: 'arbor-card-link arbor-label', onClick: () => { openDshSession(sessionId) } }, t('openInDsh'), ' →'))),
    createElement(Masonry, { items: cards }))
}

/** The left sidebar's arbor page: a host overview and one tab per opened session. */
export function ArborPage(props: ArborSlotProps & ArborPageInjected): ReactNode {
  const t = props.t ?? ((key: string) => key)
  const host = useChannel(hostChannel())
  const facts = host.facts
  const [opened, setOpened] = useState<readonly string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sessions = facts?.sessions ?? []
  const activeSession = active !== null && sessions.some(session => session.sessionId === active) ? active : null
  useEffect(() => {
    if (!searchOpen && !settingsOpen) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSearchOpen(false)
      setSettingsOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('keydown', close) }
  }, [searchOpen, settingsOpen])
  const openSession = (sessionId: string): void => {
    setOpened(current => current.includes(sessionId) ? current : [...current, sessionId])
    setActive(sessionId)
  }
  const closeSession = (sessionId: string): void => {
    setOpened(current => current.filter(one => one !== sessionId))
    if (active === sessionId) setActive(null)
  }
  const tabLabel = (sessionId: string): string => {
    const session = sessions.find(one => one.sessionId === sessionId)
    return session === undefined ? sessionId.slice(0, 14) : sessionTitle(session)
  }
  // Fill the role contract for every text node after each render. The root
  // carries `body`; these selectors mark the display, numeric and code nodes
  // that a font plugin styles through the four custom properties.
  useLayoutEffect(() => {
    const root = document.querySelector('[data-arbor-page]')
    if (!(root instanceof HTMLElement)) return
    const mark = (selector: string, role: 'display' | 'numeric' | 'code'): void => {
      for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
        if (!element.hasAttribute('data-arbor-text')) element.setAttribute('data-arbor-text', role)
      }
    }
    mark('.arbor-num,.arbor-hero-num,.arbor-date,.arbor-node-ref,.arbor-handoff-ref,.arbor-env-big,.arbor-search-total,.arbor-hit-ref,.arbor-hit-window', 'numeric')
    mark('.arbor-mono,.arbor-card-project,.arbor-md-code,.arbor-md-pre,.arbor-md-pre code', 'code')
    mark('.arbor-card-kicker,.arbor-card-title,.arbor-tab,.arbor-pill,.arbor-state,.arbor-tag,.arbor-empty-title,.arbor-card-link,.arbor-stream-label,.arbor-sheet-title,.arbor-search-group-title,.arbor-search-go,.arbor-settings-group-title,.arbor-node-state,.arbor-hero-name,.arbor-env-group-title,.arbor-workspace-row > .arbor-label,.arbor-hit-kind,.arbor-env-count > .arbor-label,.arbor-tab-close,.arbor-connector-label,.arbor-connector-arrow', 'display')
    // A role must sit on the text node itself, not only on an ancestor: the
    // font plugin sets its properties on the role nodes, so an untagged leaf
    // would keep inheriting the root's body face. Anything left with direct
    // text is reading text unless a more specific role already claimed it.
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') continue
      if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE') continue
      if (element.hasAttribute('data-arbor-text')) continue
      const direct = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '')
      if (direct) element.setAttribute('data-arbor-text', 'body')
    }
  })
  return createElement('div', { className: 'arbor-page', 'data-arbor-page': true, 'data-arbor-text': 'body' },
    createElement('div', { className: 'arbor-page-inner' },
      createElement('nav', { className: 'arbor-tabs', 'aria-label': t('pageTitle') },
        createElement('button', {
          type: 'button',
          className: `arbor-tab arbor-label${activeSession === null ? ' is-active' : ''}`,
          'data-arbor-text': 'display',
          onClick: () => { setActive(null) },
        }, t('tabOverview')),
        opened.map(sessionId => createElement('div', { className: `arbor-tab-group${activeSession === sessionId ? ' is-active' : ''}`, key: sessionId },
          createElement('button', {
            type: 'button',
            className: 'arbor-tab arbor-label',
            'data-arbor-text': 'display',
            onClick: () => { setActive(sessionId) },
          }, tabLabel(sessionId)),
          createElement('button', {
            type: 'button',
            className: 'arbor-tab-close',
            title: t('closeTab'),
            'aria-label': t('closeTab'),
            onClick: () => { closeSession(sessionId) },
          }, '×')))),
      facts === undefined
        ? createElement(Masonry, {
          items: [{
            key: 'loading',
            kind: 'loading',
            node: createElement(Card, { className: 'arbor-loading-card' },
              createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, t('loading')),
              host.status === 'error' && host.error !== undefined
                ? createElement('div', { className: 'arbor-error' }, t('error', { message: host.error }))
                : null),
          }],
        })
        : activeSession === null
          ? createElement(Overview, {
            facts,
            snapshot: host,
            t,
            filter,
            setFilter,
            onSearch: () => { setSearchOpen(true) },
            onSettings: () => { setSettingsOpen(true) },
            onOpenSession: openSession,
          })
          : createElement(SessionView, {
            sessionId: activeSession,
            session: sessions.find(session => session.sessionId === activeSession),
            t,
            onSearch: () => { setSearchOpen(true) },
            onSettings: () => { setSettingsOpen(true) },
            ...(props.openDshSession === undefined ? {} : { openDshSession: props.openDshSession }),
          })),
    searchOpen ? createElement(Sheet, { title: t('openSearch'), close: t('closeSheet'), onClose: () => { setSearchOpen(false) } },
      createElement(SearchBlock, { t })) : null,
    settingsOpen && facts !== undefined ? createElement(Sheet, { title: t('openSettings'), close: t('closeSheet'), onClose: () => { setSettingsOpen(false) } },
      createElement(SettingsBlock, {
        settings: facts.settings,
        dataRoot: facts.dataRoot,
        backend: facts.backend,
        shared: facts.shared,
        t,
      })) : null)
}

/**
 * The sidebar row's icon: a branch, because arbor's unit is a window with
 * continuations, not a chat bubble. DSH owns the row's accessible label.
 */
export function ArborPanelIcon(props: { readonly size?: number; readonly active?: boolean }): ReactNode {
  const size = props.size ?? 16
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    'data-arbor-icon': true,
  },
    createElement('circle', { cx: 4, cy: 3.5, r: 1.6 }),
    createElement('circle', { cx: 12, cy: 6, r: 1.6 }),
    createElement('circle', { cx: 4, cy: 12.5, r: 1.6 }),
    createElement('path', { d: 'M4 5.1v5.8' }),
    createElement('path', { d: 'M5.4 3.9h2.1c2.2 0 3 1 3 2.1' }))
}
