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
 * A measured masonry surface: the cards keep their column spans and pack by
 * their real height, so a short card takes the gap a taller neighbour leaves.
 */
function Masonry(props: { readonly children?: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const surface = ref.current
    if (surface === null) return
    const items = Array.from(surface.children) as HTMLElement[]
    const measure = (): void => {
      const style = getComputedStyle(surface)
      const gap = Number.parseFloat(style.rowGap) || 13
      for (const item of items) {
        item.style.gridRowEnd = 'auto'
        const height = item.getBoundingClientRect().height
        const span = Math.max(1, Math.ceil((height + gap) / (1 + gap)))
        item.style.gridRowEnd = `span ${span}`
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(surface)
    for (const item of items) observer.observe(item)
    return () => { observer.disconnect() }
  }, [props.children])
  return createElement('div', { className: 'arbor-surface', ref }, props.children)
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
  return createElement(Card, { className: `arbor-window-card arbor-window-${window.state}`, attrs: { 'data-arbor-window': window.ref } },
    createElement(CardHead, {
      kicker: `${t('filterWindows')} · ${window.ref}`,
      aside: createElement(StateChip, { state: window.state, t }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, window.doing ?? t('live')),
    window.live ? createElement(Stream, { stream, t }) : null,
    createElement(CardFoot, null,
      session === undefined ? null : createElement('span', { className: 'arbor-card-session' }, sessionTitle(session)),
      createElement('span', { className: 'arbor-num' }, window.used === undefined ? '—' : `${compact(window.used)} / ${compact(window.limit)}`),
      window.startedAt === undefined ? null : createElement('span', null, ' · ', clock(window.startedAt, t))))
}

/** The current window of a session tab, even when it has ended. */
function WindowCard(props: {
  readonly window: ArborWindowFacts
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly t: Translate
}): ReactNode {
  const { window, stream, t } = props
  return createElement(Card, { className: `arbor-window-card arbor-window-${window.state}`, attrs: { 'data-arbor-window': window.ref } },
    createElement(CardHead, {
      kicker: `${t('filterWindows')} · ${window.ref}`,
      aside: createElement(StateChip, { state: window.state, t }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, window.doing ?? t('live')),
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
  readonly t: Translate
}): ReactNode {
  const { session, windows, t } = props
  if (windows.length === 0) return null
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
        windows.flatMap((window, index) => {
          const next = windows[index + 1]
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
      createElement('span', { className: 'arbor-num' }, chainSummary(t, windows))))
}

/** One session, as the card that opens its own tab. */
function SessionCard(props: {
  readonly session: ArborHostSessionFacts
  readonly t: Translate
  readonly onOpen: (sessionId: string) => void
}): ReactNode {
  const { session, t, onOpen } = props
  const last = liveWindowOf(session.windows) ?? session.windows.at(-1)
  return createElement(Card, { className: 'arbor-session-card', attrs: { 'data-arbor-session': session.sessionId } },
    createElement(CardHead, {
      kicker: t('cardSession'),
      aside: createElement('span', { className: `arbor-dot arbor-dot-${last?.state ?? 'ended'}` }),
    }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, sessionTitle(session)),
    createElement('div', { className: 'arbor-card-project', 'data-arbor-text': 'code' }, projectLabel(session)),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, chainSummary(t, session.windows)),
      createElement('button', {
        type: 'button',
        className: 'arbor-card-link arbor-label',
        onClick: () => { onOpen(session.sessionId) },
      }, t('openSessionTab'), ' →')))
}

/** A board line as a sticky note: what it is doing first. */
function BoardCard(props: { readonly line: ArborBoardFacts; readonly t: Translate }): ReactNode {
  const { line, t } = props
  return createElement(Card, { className: 'arbor-board-card' },
    createElement(CardHead, { kicker: t('filterBoard'), aside: createElement('span', { className: 'arbor-card-session arbor-label' }, boardStateLabel(t, line.state)) }),
    createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'body' }, line.doing),
    line.openWork === undefined || line.openWork.length === 0
      ? null
      : createElement('div', { className: 'arbor-tags' },
        line.openWork.map(item => createElement('span', { className: 'arbor-tag arbor-tag-warn', key: item }, item))),
    createElement(CardFoot, null,
      createElement('span', { className: 'arbor-num' }, line.window),
      createElement('span', null, ' · ', boardStateLabel(t, line.state)),
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
  const sessions = facts.sessions
  const latest = live.at(-1)
  const ended = facts.windows.filter(window => window.state === 'ended').length
  // A session waits only when it has a window and none of them is live, and its
  // last window is idle rather than ended. A blank session has no label and is
  // not in `sessions` at all, so it can never inflate this count.
  const waiting = sessions.filter(session => session.windows.length > 0 &&
    !session.windows.some(window => window.live) && session.windows.at(-1)?.state === 'idle').length
  const show = (section: Filter): boolean => filter === 'all' || filter === section
  const heroContent: ReactNode[] = sessions.length === 0
    ? [createElement('span', { key: 'empty' }, t('heroEmpty')), createElement('span', { className: 'arbor-hero-hint', key: 'empty-hint', 'data-arbor-text': 'body' }, t('heroEmptyHint'))]
    : live.length === 0
      ? waiting > 0
        ? hero(t(waiting === 1 ? 'heroIdleWaitOne' : 'heroIdleWait'), { waiting: String(waiting), ended: String(ended) })
        : hero(t(sessions.length === 1 ? 'heroIdleOne' : 'heroIdle'), { sessions: String(sessions.length), ended: String(ended) })
      : latest === undefined
        ? [createElement('span', { key: 'empty' }, t('heroEmpty'))]
        : hero(t(facts.board.length === 0
          ? waiting > 0 ? 'heroLiveNoBoardWait' : 'heroLiveNoBoard'
          : waiting > 0 ? 'heroLiveWait' : 'heroLive'), {
          window: latest.ref,
          board: String(facts.board.length),
          waiting: String(waiting),
        })
  const cards: ReactNode[] = []
  if (sessions.length > 0) {
    if (show('windows')) {
      for (const window of live) {
        cards.push(createElement(LiveWindowCard, {
          key: `live-${window.ref}`,
          window,
          session: sessions.find(session => session.windows.some(one => one.ref === window.ref)),
          stream: snapshot.streams[window.ref],
          t,
        }))
      }
      for (const session of sessions) {
        cards.push(createElement(ChainCard, { key: `chain-${session.sessionId}`, session, windows: session.windows, t }))
      }
      if (live.length === 0 && filter === 'windows') cards.push(createElement(EmptyCard, { key: 'empty-windows', title: t('emptyWindows'), hint: t('emptyWindowsHint') }))
    }
    if (show('all') || filter === 'windows') {
      for (const session of sessions) cards.push(createElement(SessionCard, { key: `session-${session.sessionId}`, session, t, onOpen: onOpenSession }))
    }
    if (show('board')) {
      for (const line of facts.board) cards.push(createElement(BoardCard, { key: `board-${line.window}`, line, t }))
      if (facts.board.length === 0 && filter === 'board') cards.push(createElement(EmptyCard, { key: 'empty-board', title: t('emptyBoard'), hint: t('emptyBoardHint') }))
    }
    if (show('notes')) {
      for (const note of facts.notes.items) cards.push(createElement(NoteCard, { key: `note-${note.ref}`, note, t }))
      if (facts.notes.items.length === 0 && filter === 'notes') cards.push(createElement(EmptyCard, { key: 'empty-notes', title: t('emptyNotes'), hint: t('emptyNotesHint') }))
    }
    if (show('env')) cards.push(createElement(EnvCard, { key: 'env', env: facts.env, t }))
    if (show('schedules')) {
      for (const schedule of facts.schedules) cards.push(createElement(ScheduleCard, { key: `schedule-${schedule.ref}`, schedule, t }))
      if (facts.schedules.length === 0 && filter === 'schedules') cards.push(createElement(EmptyCard, { key: 'empty-schedules', title: t('emptySchedules'), hint: t('emptySchedulesHint') }))
    }
  }
  return createElement('div', { className: 'arbor-overview' },
    createElement('header', { className: 'arbor-hero' },
      createElement('div', { className: 'arbor-hero-top' },
        createElement('span', { className: 'arbor-date arbor-label', 'data-arbor-text': 'numeric' }, dateLine(t, facts.at)),
        createElement(TopActions, { t, onSearch, onSettings })),
      createElement('h1', { className: 'arbor-hero-title', 'data-arbor-text': 'display' }, ...heroContent)),
    createElement(Masonry, null, ...cards),
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
      createElement(Masonry, null,
        createElement(Card, { className: 'arbor-loading-card' },
          createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, t('loading')),
          snapshot.status === 'error' && snapshot.error !== undefined
            ? createElement('div', { className: 'arbor-error' }, t('error', { message: snapshot.error }))
            : null)))
  }
  const windows = facts.windows
  const now = liveWindowOf(windows) ?? windows.at(-1)
  const heroContent: ReactNode[] = windows.length === 0
    ? [createElement('span', { key: 'none' }, t('sessionHeroEmpty')), createElement('span', { className: 'arbor-hero-hint', key: 'hint', 'data-arbor-text': 'body' }, t('sessionHeroEmptyHint'))]
    : now === undefined
      ? [createElement('span', { key: 'none' }, t('sessionHeroEmpty'))]
      : now.state === 'running'
        ? now.continuationOf === undefined
          ? hero(t('sessionHeroFirst'), { window: now.ref, board: String(facts.board.length) })
          : hero(t('sessionHeroLive'), { window: now.ref, previous: now.continuationOf, board: String(facts.board.length) })
        : now.state === 'idle'
          ? hero(t('sessionHeroIdle'), { window: now.ref })
          : hero(t('sessionHeroEnded'), { count: String(windows.length), window: now.ref })
  const cards: ReactNode[] = []
  if (windows.length === 0) {
    cards.push(createElement(EmptyCard, { key: 'empty', title: t('emptyWindows'), hint: t('sessionHeroEmptyHint') }))
  } else {
    cards.push(createElement(ChainCard, { key: 'chain', session, windows, t }))
    if (now !== undefined) cards.push(createElement(WindowCard, { key: `window-${now.ref}`, window: now, stream: snapshot.streams[now.ref], t }))
    cards.push(createElement(WorkspaceCard, { key: 'workspace', workspace: facts.workspace, t }))
    for (const line of facts.board) cards.push(createElement(BoardCard, { key: `board-${line.window}`, line, t }))
    for (const note of facts.notes.items) cards.push(createElement(NoteCard, { key: `note-${note.ref}`, note, t }))
  }
  return createElement('div', { className: 'arbor-overview', 'data-arbor-page': true, 'data-arbor-session-view': sessionId },
    createElement('header', { className: 'arbor-hero' },
      createElement('div', { className: 'arbor-hero-top' },
        createElement('span', { className: 'arbor-date arbor-label', 'data-arbor-text': 'numeric' }, dateLine(t, facts.at)),
        createElement(TopActions, { t, onSearch, onSettings })),
      createElement('h1', { className: 'arbor-hero-title', 'data-arbor-text': 'display' }, ...heroContent),
      openDshSession === undefined ? null : createElement('div', { className: 'arbor-hero-links' },
        createElement('button', { type: 'button', className: 'arbor-card-link arbor-label', onClick: () => { openDshSession(sessionId) } }, t('openInDsh'), ' →'))),
    createElement(Masonry, null, ...cards))
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
        ? createElement('div', { className: 'arbor-surface' },
          createElement(Card, { className: 'arbor-loading-card' },
            createElement('div', { className: 'arbor-card-title', 'data-arbor-text': 'display' }, t('loading')),
            host.status === 'error' && host.error !== undefined
              ? createElement('div', { className: 'arbor-error' }, t('error', { message: host.error }))
              : null))
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
