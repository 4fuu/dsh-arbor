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
 * The page is the whole-host picture: every arbor session and its windows,
 * the board, the active notes, `/env`, the schedules, arbor's settings and
 * arbor's own search. A session row expands into its own tab, which shows only
 * that session: its live window and status, the continuation chain, its project
 * and the external pointers from `<workspace>`, and what is running now. An
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

/** The headline a chain is summarised by: no window, no live window, or a count. */
function headline(t: Translate, facts: ArborFacts | ArborHostFacts | undefined, live: number): string {
  if (facts === undefined || facts.windows.length === 0) return t('chipNoWindow')
  if (live === 0) return t('chipIdle', { count: facts.windows.length })
  return facts.windows.length === 1 ? t('chipWindowOne') : t('chipWindows', { count: facts.windows.length })
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

/** A clock time, in the page's own locale. */
function clock(value: number | undefined): string {
  if (value === undefined) return '—'
  return new Date(value).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** One collapsible section: a summary row and its body. */
function Section(props: {
  readonly label: string
  readonly count?: string
  readonly open?: boolean
  readonly t: Translate
  readonly children?: ReactNode
}): ReactNode {
  const [open, setOpen] = useState(props.open === true)
  return createElement('details', {
    className: 'arbor-sec',
    open,
    onToggle: (event: { currentTarget: HTMLDetailsElement; target: EventTarget }) => {
      if (event.target === event.currentTarget) setOpen(event.currentTarget.open)
    },
  },
    createElement('summary', { className: 'arbor-sec-head' },
      createElement('span', { className: 'arbor-label arbor-sec-title' }, props.label),
      props.count === undefined ? null : createElement('span', { className: 'arbor-num arbor-sec-count' }, props.count),
      createElement('span', { className: 'arbor-chevron', 'aria-hidden': true })),
    createElement('div', { className: 'arbor-sec-body' }, props.children))
}

/** One key/value line. */
function KV(props: { readonly label: string; readonly children?: ReactNode; readonly mono?: boolean }): ReactNode {
  return createElement('div', { className: 'arbor-kv' },
    createElement('span', { className: 'arbor-label arbor-kv-key' }, props.label),
    createElement('span', { className: props.mono === true ? 'arbor-val arbor-mono' : 'arbor-val' }, props.children))
}

/** One small badge. */
function Badge(props: { readonly children?: ReactNode; readonly tone?: string }): ReactNode {
  return createElement('span', {
    className: `arbor-badge arbor-label${props.tone === undefined ? '' : ` arbor-badge-${props.tone}`}`,
  }, props.children)
}

/** The live window's own stream: the model writing, and the `send` taking shape. */
function Stream(props: {
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly t: Translate
}): ReactNode {
  const text = props.stream?.text ?? ''
  const send = props.stream?.send ?? ''
  return createElement('div', { className: 'arbor-stream', 'data-arbor-stream': true },
    createElement('div', { className: 'arbor-stream-head' },
      createElement('span', { className: `arbor-pulse${props.stream?.streaming === true ? ' is-live' : ''}` }),
      createElement('span', { className: 'arbor-label arbor-stream-label' }, props.t('streamText'))),
    text === ''
      ? createElement('div', { className: 'arbor-muted arbor-stream-empty' }, props.t('streamWaiting'))
      : createElement('div', { className: 'arbor-stream-text' }, text),
    send === ''
      ? null
      : createElement('div', { className: 'arbor-send' },
        createElement('div', { className: 'arbor-label arbor-send-label' }, props.t('streamSend')),
        createElement('div', { className: 'arbor-stream-text arbor-send-text' }, send)))
}

/** One window of a chain, with the stream under the live one. */
function WindowRow(props: {
  readonly window: ArborWindowFacts
  readonly stream: FactsSnapshot<ArborFacts | ArborHostFacts>['streams'][string] | undefined
  readonly label?: string
  readonly t: Translate
}): ReactNode {
  const { window, t } = props
  const reasons: ReactNode[] = []
  if (window.continuationOf !== undefined) reasons.push(t('continuesFrom', { window: window.continuationOf }))
  if (window.continuedBy !== undefined) reasons.push(t('handoffTo', { window: window.continuedBy }))
  const end = endLabel(t, window.endReason)
  if (end !== undefined) reasons.push(end)
  return createElement('div', { className: `arbor-win arbor-win-${window.state}`, 'data-arbor-window': window.ref },
    createElement('div', { className: 'arbor-win-head' },
      createElement('span', { className: `arbor-dot arbor-dot-${window.state}` }),
      createElement('span', { className: 'arbor-num arbor-win-ref' }, window.ref),
      props.label === undefined ? null : createElement('span', { className: 'arbor-chip arbor-label arbor-chip-session' }, props.label),
      createElement('span', { className: `arbor-chip arbor-label arbor-chip-${window.state}` }, stateLabel(t, window)),
      createElement('span', { className: 'arbor-win-doing' }, window.doing ?? ''),
      window.used === undefined
        ? null
        : createElement('span', { className: 'arbor-num arbor-win-use' }, `${compact(window.used)} / ${compact(window.limit)}`)),
    reasons.length === 0 && window.handoff === undefined
      ? null
      : createElement('div', { className: 'arbor-win-meta' },
        reasons.map((reason, index) => createElement('span', { className: 'arbor-meta-item', key: `r${index}` }, reason)),
        window.handoff === undefined ? null : createElement('span', { className: 'arbor-meta-item' },
          createElement(Badge, { tone: 'handoff' }, t('handoff')),
          ' ',
          createElement('span', { className: 'arbor-mono arbor-meta-refs' }, window.handoff.refs.join(' '))),
        window.refused === undefined ? null : createElement('span', { className: 'arbor-meta-item arbor-meta-refused' }, t('refused', { rule: window.refused }))),
    window.handoff === undefined ? null : handoffLines(window.handoff, t),
    window.live ? createElement(Stream, { stream: props.stream, t }) : null)
}

/** The parts arbor's `end` call carried, when the journal kept them. */
function handoffLines(handoff: NonNullable<ArborWindowFacts['handoff']>, t: Translate): ReactNode {
  const lines: Array<readonly [string, readonly string[] | undefined]> = [
    [t('handoffTopics'), handoff.topics],
    [t('handoffProgress'), handoff.progress],
    [t('handoffPending'), handoff.pending],
    [t('handoffAgreements'), handoff.agreements],
  ]
  const shown = lines.filter((line): line is readonly [string, readonly string[]] => line[1] !== undefined)
  if (shown.length === 0) return null
  return createElement('div', { className: 'arbor-handoff' },
    shown.map(([label, values]) => createElement('div', { className: 'arbor-handoff-row', key: label },
      createElement('span', { className: 'arbor-label arbor-handoff-key' }, label),
      createElement('span', { className: 'arbor-handoff-value' }, values.join(' · ')))))
}

/** The windows of one chain, newest first. */
function WindowsList(props: {
  readonly windows: readonly ArborWindowFacts[]
  readonly snapshot: FactsSnapshot<ArborFacts | ArborHostFacts>
  readonly t: Translate
}): ReactNode {
  const { windows, snapshot, t } = props
  const ordered = [...windows].reverse()
  if (ordered.length === 0) {
    return createElement('div', { className: 'arbor-empty' },
      createElement('div', { className: 'arbor-empty-title arbor-label' }, t('noWindows')),
      createElement('div', { className: 'arbor-muted' }, t('noWindowsHint')))
  }
  return createElement('div', { className: 'arbor-wins' },
    ordered.map(window => createElement(WindowRow, {
      key: window.ref,
      window,
      stream: snapshot.streams[window.ref],
      t,
    })))
}

/** The workspace section: the project, the pointers and what the chain holds. */
function WorkspaceBlock(props: { readonly workspace: ArborWorkspaceFacts; readonly t: Translate }): ReactNode {
  const { workspace, t } = props
  return createElement('div', { className: 'arbor-stack' },
    createElement(KV, { label: t('workspaceBackend') },
      createElement('span', { className: 'arbor-label' }, workspace.backend),
      createElement('span', { className: 'arbor-mono arbor-path' }, workspace.shared)),
    workspace.project === undefined ? null : createElement(KV, { label: t('workspaceProject'), mono: false },
      createElement('span', null, workspace.project.name, ' '),
      createElement('span', { className: 'arbor-mono arbor-path' }, workspace.project.path)),
    workspace.cwd === undefined ? null : createElement(KV, { label: t('workspaceCwd'), mono: true }, workspace.cwd),
    createElement('div', { className: 'arbor-sub' },
      createElement('div', { className: 'arbor-label arbor-sub-title' }, t('workspacePointers')),
      workspace.pointers.length === 0
        ? createElement('div', { className: 'arbor-muted' }, t('none'))
        : workspace.pointers.map(pointer => createElement('div', { className: 'arbor-row', key: pointer.path },
          createElement('span', { className: 'arbor-label' }, pointer.name),
          createElement('span', { className: 'arbor-mono arbor-path' }, pointer.path)))),
    createElement('div', { className: 'arbor-sub' },
      createElement('div', { className: 'arbor-label arbor-sub-title' }, t('workspaceCheckouts')),
      workspace.checkouts.length === 0
        ? createElement('div', { className: 'arbor-muted' }, t('none'))
        : workspace.checkouts.map(checkout => createElement('div', { className: 'arbor-row', key: checkout.path },
          createElement('span', { className: 'arbor-mono arbor-path' }, checkout.name),
          createElement(Badge, { tone: checkout.dirty ? 'warn' : 'ok' }, checkout.dirty ? t('workspaceDirty') : t('workspaceClean'))))),
    workspace.keeps.length === 0 ? null : createElement('div', { className: 'arbor-sub' },
      createElement('div', { className: 'arbor-label arbor-sub-title' }, t('workspaceKeeps')),
      workspace.keeps.map(keep => createElement('div', { className: 'arbor-row', key: keep.path },
        createElement('span', { className: 'arbor-label' }, keep.name),
        createElement('span', { className: 'arbor-mono arbor-path' }, keep.path)))),
    workspace.openWork.length === 0 ? null : createElement('div', { className: 'arbor-sub' },
      createElement('div', { className: 'arbor-label arbor-sub-title' }, t('workspaceOpenWork')),
      workspace.openWork.map(item => createElement('div', { className: 'arbor-row', key: `${item.window}:${item.name}` },
        createElement('span', { className: 'arbor-num arbor-win-ref' }, item.window),
        createElement('span', { className: 'arbor-label' }, item.name),
        item.detail === undefined ? null : createElement('span', { className: 'arbor-muted' }, item.detail)))))
}

/** The board: arbor's live lines. */
function BoardBlock(props: { readonly board: readonly ArborBoardFacts[]; readonly t: Translate }): ReactNode {
  const { board, t } = props
  if (board.length === 0) return createElement('div', { className: 'arbor-muted' }, t('boardEmpty'))
  return createElement('div', { className: 'arbor-stack' },
    board.map(line => createElement('div', { className: 'arbor-board', key: line.window },
      createElement('div', { className: 'arbor-win-head' },
        createElement('span', { className: `arbor-dot arbor-dot-${line.state}` }),
        createElement('span', { className: 'arbor-num arbor-win-ref' }, line.window),
        createElement('span', { className: 'arbor-label arbor-board-state' }, line.state),
        createElement('span', { className: 'arbor-num arbor-win-use' }, `${compact(line.usage.used)} / ${compact(line.usage.limit)}`)),
      createElement('div', { className: 'arbor-board-doing' }, line.doing),
      line.openWork === undefined || line.openWork.length === 0
        ? null
        : createElement('div', { className: 'arbor-board-open' },
          line.openWork.map(item => createElement(Badge, { key: item, tone: 'warn' }, item))),
      createElement('div', { className: 'arbor-muted arbor-board-targets' },
        t('boardTargets'), ': ', line.targets.join(' · ')))))
}

/** The active note set: the memory every arbor window opens with. */
function NotesBlock(props: { readonly notes: ArborNotesFacts; readonly t: Translate }): ReactNode {
  const { notes, t } = props
  return createElement('div', { className: 'arbor-stack' },
    createElement('div', { className: 'arbor-notes-head' },
      createElement('span', { className: 'arbor-label' }, t('notesActive')),
      createElement('span', { className: 'arbor-num arbor-notes-count' },
        t('notesCount', { count: notes.total, tokens: number(notes.tokens), budget: number(notes.budget.tokens) })),
      createElement('span', { className: 'arbor-num arbor-muted' }, t('notesEpoch', { epoch: notes.epoch }))),
    notes.items.length === 0
      ? createElement('div', { className: 'arbor-muted' }, t('notesEmpty'))
      : notes.items.map(note => createElement('div', { className: 'arbor-note', key: note.ref },
        createElement('div', { className: 'arbor-note-head' },
          createElement('span', { className: 'arbor-num arbor-note-id' }, note.ref),
          createElement('span', { className: 'arbor-label arbor-note-title' }, note.title)),
        note.summary === '' ? null : createElement('div', { className: 'arbor-muted arbor-note-sum' }, note.summary))))
}

/** `/env`: arbor's skills, MCP servers, services and settings item. */
function EnvBlock(props: { readonly env: ArborEnvFacts; readonly t: Translate }): ReactNode {
  const { env, t } = props
  const items = env.items
  const skills = items.filter(item => item.kind === 'skill')
  const servers = items.filter(item => item.kind === 'mcp')
  const services = items.filter(item => item.kind === 'service')
  const settings = items.filter(item => item.kind === 'settings')
  if (items.length === 0) return createElement('div', { className: 'arbor-muted' }, t('envEmpty'))
  const group = (label: string, rows: readonly ReactNode[]): ReactNode => (
    rows.length === 0 ? null : createElement('div', { className: 'arbor-sub' },
      createElement('div', { className: 'arbor-label arbor-sub-title' }, label),
      rows)
  )
  return createElement('div', { className: 'arbor-stack' },
    createElement('div', { className: 'arbor-num arbor-env-counts' },
      t('envCounts', { skills: skills.length, servers: servers.length, services: services.length })),
    group(t('envSkills'), skills.map(item => createElement('div', { className: 'arbor-row', key: `sk:${item.name}` },
      createElement('span', { className: 'arbor-label arbor-env-name' }, item.name),
      item.builtin === true ? createElement(Badge, { tone: 'ok' }, t('envBuiltin')) : null,
      createElement('span', { className: 'arbor-mono arbor-path', title: item.description }, item.path ?? '')))),
    group(t('envMcp'), servers.map(item => createElement('div', { className: 'arbor-row', key: `mcp:${item.name}` },
      createElement('span', { className: 'arbor-label arbor-env-name' }, item.name),
      createElement('span', { className: 'arbor-muted arbor-env-desc', title: item.description },
        item.functions === undefined || item.functions.length === 0 ? '—' : item.functions.join(' · '))))),
    group(t('envServices'), services.map(item => createElement('div', { className: 'arbor-row', key: `svc:${item.name}` },
      createElement('span', { className: 'arbor-label arbor-env-name' }, item.name),
      createElement(Badge, { tone: item.state === 'running' ? 'ok' : item.state === 'failed' ? 'err' : 'warn' },
        item.state ?? '—'),
      item.error === undefined ? null : createElement('span', { className: 'arbor-muted arbor-env-desc' }, item.error)))),
    group(t('envPath'), settings.map(item => createElement('div', { className: 'arbor-row', key: `set:${item.name}` },
      createElement('span', { className: 'arbor-label arbor-env-name' }, item.name),
      createElement('span', { className: 'arbor-num arbor-muted' }, `@${item.revision}`)))))
}

/** The schedules arbor holds. */
function SchedulesBlock(props: { readonly schedules: readonly ArborScheduleFacts[]; readonly t: Translate }): ReactNode {
  const { schedules, t } = props
  if (schedules.length === 0) return createElement('div', { className: 'arbor-muted' }, t('schedulesEmpty'))
  return createElement('div', { className: 'arbor-stack' },
    schedules.map(schedule => {
      const repeat = schedule.everyMs !== undefined
        ? t('scheduleEvery', { value: duration(t, schedule.everyMs) ?? String(schedule.everyMs) })
        : schedule.dailyAt !== undefined
          ? t('scheduleDaily', { value: schedule.dailyAt })
          : schedule.weekdays !== undefined
            ? t('scheduleWeekly', { value: schedule.weekdays.join(' ') })
            : ''
      return createElement('div', { className: 'arbor-schedule', key: schedule.ref },
        createElement('div', { className: 'arbor-win-head' },
          createElement('span', { className: 'arbor-num arbor-win-ref' }, schedule.ref),
          createElement('span', { className: 'arbor-label arbor-schedule-name' }, schedule.name ?? '—'),
          schedule.mine ? createElement(Badge, { tone: 'accent' }, t('scheduleMine')) : null,
          schedule.paused ? createElement(Badge, { tone: 'warn' }, t('schedulePaused')) : null),
        createElement('div', { className: 'arbor-muted arbor-schedule-meta' },
          t('scheduleNext', { time: clock(schedule.nextAt) }),
          repeat === '' ? '' : ` · ${repeat}`,
          schedule.fired === undefined ? '' : ` · ${t('scheduleFired', { count: schedule.fired })}`))
    }))
}

/** Arbor's own settings, and which DSH card does not govern a window. */
function SettingsBlock(props: { readonly settings: ArborSettingsFacts; readonly t: Translate }): ReactNode {
  const { settings, t } = props
  const tiers = Object.entries(settings.modelTiers ?? {})
  const judge = Object.entries(settings.judge?.modes ?? {})
  const judgeLabel = (mode: string): string => mode === 'off' ? t('settingsJudgeOff') : mode === 'shadow' ? t('settingsJudgeShadow') : t('settingsJudgeOn')
  const window = settings.window ?? {}
  const notes = settings.notes ?? {}
  return createElement('div', { className: 'arbor-stack' },
    createElement('div', { className: 'arbor-muted' }, t(settings.source === 'environment' ? 'settingsSourceEnvironment' : 'settingsSourceDeployment')),
    settings.identity === undefined ? null : createElement(KV, { label: t('settingsIdentity') },
      createElement('span', { className: 'arbor-clamp' }, settings.identity)),
    settings.generalRules === undefined || settings.generalRules.length === 0 ? null : createElement(KV, { label: t('settingsRules') },
      createElement('span', { className: 'arbor-num' }, String(settings.generalRules.length))),
    tiers.length === 0 ? null : createElement(KV, { label: t('settingsTiers'), mono: true },
      tiers.map(([tier, model]) => `${tier} → ${model}`).join(' · ')),
    settings.defaultTier === undefined ? null : createElement(KV, { label: t('settingsDefaultTier') },
      createElement('span', { className: 'arbor-label' }, settings.defaultTier)),
    judge.length === 0 ? null : createElement(KV, { label: t('settingsJudge') },
      createElement('span', { className: 'arbor-judge' },
        judge.map(([kind, mode]) => createElement(Badge, { key: kind, tone: mode === 'off' ? 'plain' : mode === 'shadow' ? 'warn' : 'ok' },
          `${kind} ${judgeLabel(mode)}`)))),
    createElement(KV, { label: t('settingsWindow') },
      createElement('span', { className: 'arbor-num' },
        [
          window.idleSeconds === undefined ? '' : `${t('settingsIdle')} ${t('seconds', { value: window.idleSeconds })}`,
          window.contextTokens === undefined ? '' : `${t('settingsContext')} ${compact(window.contextTokens)}`,
          window.reserveTokens === undefined ? '' : `${t('settingsReserve')} ${compact(window.reserveTokens)}`,
          window.protectionSeconds === undefined ? '' : `${t('settingsProtection')} ${t('seconds', { value: window.protectionSeconds })}`,
        ].filter(Boolean).join(' · '))),
    createElement(KV, { label: t('settingsNotes') },
      createElement('span', { className: 'arbor-num' },
        [
          notes.activeCount === undefined ? '' : `${t('settingsNotesCount')} ${notes.activeCount}`,
          notes.activeTokenBudget === undefined ? '' : `${t('settingsNotesTokens')} ${compact(notes.activeTokenBudget)}`,
        ].filter(Boolean).join(' · '))),
    settings.secrets === undefined || settings.secrets.length === 0 ? null : createElement(KV, { label: t('settingsSecrets'), mono: true },
      settings.secrets.join(' · ')),
    createElement('div', { className: 'arbor-hint' }, t('settingsDsh')))
}

/** One search result group. */
function SearchGroup(props: { readonly label: string; readonly rows: readonly ReactNode[] }): ReactNode {
  if (props.rows.length === 0) return null
  return createElement('div', { className: 'arbor-sub' },
    createElement('div', { className: 'arbor-label arbor-sub-title' }, props.label),
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

  return createElement('div', { className: 'arbor-stack' },
    createElement('div', { className: 'arbor-search' },
      createElement('input', {
        className: 'arbor-search-input',
        value: query,
        placeholder: t('searchPlaceholder'),
        onChange: (event: { target: { value: string } }) => { setQuery(event.target.value) },
        onKeyDown: (event: { key: string; preventDefault(): void }) => {
          if (event.key === 'Enter') { event.preventDefault(); void run() }
        },
      }),
      createElement('button', {
        className: 'arbor-search-go arbor-label',
        type: 'button',
        disabled: busy || query.trim() === '',
        onClick: () => { void run() },
      }, t('searchButton'))),
    createElement('div', { className: 'arbor-muted arbor-search-hint' }, t('searchHint')),
    error === undefined ? null : createElement('div', { className: 'arbor-error' }, t('searchError', { message: error })),
    result === undefined
      ? null
      : result.total === 0
        ? createElement('div', { className: 'arbor-muted' }, t('searchEmpty'))
        : createElement('div', { className: 'arbor-stack' },
          createElement('div', { className: 'arbor-num arbor-muted' }, t('searchTotal', { count: result.total })),
          createElement(SearchGroup, {
            label: t('searchJournal'),
            rows: result.journal.map(hit => createElement('div', { className: 'arbor-hit', key: hit.ref },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-num arbor-win-ref' }, hit.ref),
                createElement('span', { className: 'arbor-label arbor-hit-kind' }, hit.kind),
                hit.window === null ? null : createElement('span', { className: 'arbor-num arbor-muted' }, hit.window)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.summary))),
          }),
          createElement(SearchGroup, {
            label: t('searchNotes'),
            rows: result.notes.map(hit => createElement('div', { className: 'arbor-hit', key: hit.ref },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-num arbor-win-ref' }, hit.ref),
                createElement('span', { className: 'arbor-label arbor-hit-kind' }, hit.title)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.summary))),
          }),
          createElement(SearchGroup, {
            label: t('searchBoard'),
            rows: result.board.map(hit => createElement('div', { className: 'arbor-hit', key: hit.window },
              createElement('div', { className: 'arbor-hit-head' },
                createElement('span', { className: 'arbor-num arbor-win-ref' }, hit.window)),
              createElement('div', { className: 'arbor-hit-sum' }, hit.doing))),
          })))
}

/** A session's short display name: its project, or the label's first characters. */
function sessionName(session: ArborHostSessionFacts): string {
  return session.project?.name ?? (session.sessionId.length > 22 ? `${session.sessionId.slice(0, 22)}…` : session.sessionId)
}

/** The live window of a session, if it has one. */
function liveWindowOf(windows: readonly ArborWindowFacts[]): ArborWindowFacts | undefined {
  return [...windows].reverse().find(window => window.live)
}

/** The whole-host page: one summary, every session, the host's own sections. */
function Overview(props: {
  readonly facts: ArborHostFacts
  readonly snapshot: FactsSnapshot<ArborHostFacts>
  readonly t: Translate
  readonly onOpenSession: (sessionId: string) => void
}): ReactNode {
  const { facts, snapshot, t, onOpenSession } = props
  const live = facts.windows.filter(window => window.live)
  const recent = [...facts.windows].reverse().slice(0, 30)
  const summary = (label: string, value: string | number): ReactNode => createElement('div', { className: 'arbor-stat', key: label },
    createElement('div', { className: 'arbor-label arbor-stat-label' }, label),
    createElement('div', { className: 'arbor-num arbor-stat-value' }, String(value)))
  return createElement('div', { className: 'arbor-page-body' },
    createElement('div', { className: 'arbor-summary' },
      summary(t('summarySessions'), facts.sessions.length),
      summary(t('summaryWindows'), live.length),
      summary(t('summaryNotes'), facts.notes.total),
      summary(t('summaryEnv'), facts.env.items.length),
      summary(t('summarySchedules'), facts.schedules.length)),
    createElement(Section, { label: t('sessions'), count: String(facts.sessions.length), open: true, t },
      facts.sessions.length === 0
        ? createElement('div', { className: 'arbor-empty' },
          createElement('div', { className: 'arbor-empty-title arbor-label' }, t('noSessions')),
          createElement('div', { className: 'arbor-muted' }, t('noSessionsHint')))
        : createElement('div', { className: 'arbor-session-list' },
          facts.sessions.map(session => {
            const active = session.live > 0
            const last = liveWindowOf(session.windows)
            return createElement('div', {
              className: `arbor-session-row${active ? ' is-live' : ''}`,
              key: session.sessionId,
              'data-arbor-session': session.sessionId,
            },
              createElement('span', { className: `arbor-dot arbor-dot-${active ? 'running' : 'ended'}` }),
              createElement('div', { className: 'arbor-session-main' },
                createElement('div', { className: 'arbor-session-title' },
                  createElement('span', { className: 'arbor-label arbor-session-name' }, sessionName(session)),
                  createElement('span', { className: 'arbor-num arbor-session-id' }, session.sessionId.slice(0, 14))),
                createElement('div', { className: 'arbor-muted arbor-session-doing' },
                  last?.doing ?? (session.windows.at(-1)?.doing ?? '')),
                createElement('div', { className: 'arbor-muted arbor-session-meta' },
                  session.project?.path ?? session.cwd ?? session.sessionId,
                  ' · ',
                  t('chain'), ' ', String(session.windows.length))),
              createElement('button', {
                type: 'button',
                className: 'arbor-session-open arbor-label',
                title: t('openSessionTab'),
                'aria-label': t('openSessionTab'),
                onClick: () => { onOpenSession(session.sessionId) },
              }, t('openSessionTab')),
            )
          })),
    ),
    createElement(Section, { label: t('liveWindows'), count: String(live.length), open: true, t },
      live.length === 0
        ? createElement('div', { className: 'arbor-muted' }, t('noLiveWindow'))
        : createElement('div', { className: 'arbor-wins' },
          live.map(window => createElement(WindowRow, {
            key: window.ref,
            window,
            stream: snapshot.streams[window.ref],
            label: facts.sessions.find(session => session.windows.some(one => one.ref === window.ref))?.project?.name,
            t,
          })))),
    createElement(Section, { label: t('sectionWindows'), count: String(facts.windows.length), t },
      recent.length === 0
        ? createElement('div', { className: 'arbor-muted' }, t('none'))
        : createElement('div', { className: 'arbor-wins' },
          recent.map(window => createElement(WindowRow, {
            key: window.ref,
            window,
            stream: snapshot.streams[window.ref],
            label: facts.sessions.find(session => session.windows.some(one => one.ref === window.ref))?.project?.name,
            t,
          })))),
    createElement(Section, { label: t('sectionBoard'), count: String(facts.board.length), t },
      createElement(BoardBlock, { board: facts.board, t })),
    createElement(Section, { label: t('sectionNotes'), count: String(facts.notes.items.length), t },
      createElement(NotesBlock, { notes: facts.notes, t })),
    createElement(Section, { label: t('sectionEnvironment'), count: String(facts.env.items.length), t },
      createElement(EnvBlock, { env: facts.env, t })),
    createElement(Section, { label: t('sectionSchedules'), count: String(facts.schedules.length), t },
      createElement(SchedulesBlock, { schedules: facts.schedules, t })),
    createElement(Section, { label: t('sectionSettings'), t },
      createElement(SettingsBlock, { settings: facts.settings, t })),
    createElement(Section, { label: t('sectionSearch'), t },
      createElement(SearchBlock, { t })))
}

/** One session's tab: only that session's state. */
function SessionView(props: {
  readonly sessionId: string
  readonly session: ArborHostSessionFacts | undefined
  readonly t: Translate
  readonly openDshSession?: (sessionId: string) => void
}): ReactNode {
  const { sessionId, session, t, openDshSession } = props
  const snapshot = useChannel(channelFor(sessionId))
  const facts = snapshot.facts
  if (facts === undefined) {
    return createElement('div', { className: 'arbor-page-body' },
      createElement('div', { className: 'arbor-label arbor-loading' }, t('loading')),
      snapshot.status === 'error' && snapshot.error !== undefined
        ? createElement('div', { className: 'arbor-error' }, t('error', { message: snapshot.error }))
        : null)
  }
  const live = facts.windows.filter(window => window.live)
  const now = live.at(-1) ?? [...facts.windows].reverse()[0]
  return createElement('div', { className: 'arbor-page-body arbor-session-view', 'data-arbor-session-view': sessionId },
    createElement('div', { className: 'arbor-session-head' },
      createElement('div', { className: 'arbor-session-head-main' },
        createElement('div', { className: 'arbor-session-head-title' },
          createElement('span', { className: 'arbor-label arbor-session-name' }, session === undefined ? sessionId : sessionName(session)),
          createElement('span', { className: 'arbor-num arbor-session-id' }, sessionId.slice(0, 18)),
          createElement('span', { className: `arbor-chip arbor-label arbor-chip-${now?.state ?? 'ended'}` },
            now === undefined ? t('statusEnded') : stateLabel(t, now))),
        createElement('div', { className: 'arbor-muted' }, now?.doing ?? facts.workspace.project?.path ?? '')),
      openDshSession === undefined
        ? null
        : createElement('button', {
          type: 'button',
          className: 'arbor-session-open arbor-label',
          onClick: () => { openDshSession(sessionId) },
        }, t('openInDsh'))),
    createElement(Section, { label: t('now'), open: true, t },
      now === undefined
        ? createElement('div', { className: 'arbor-muted' }, t('noLiveWindow'))
        : createElement('div', { className: 'arbor-wins' },
          createElement(WindowRow, { window: now, stream: snapshot.streams[now.ref], t }))),
    createElement(Section, { label: t('sectionWindows'), count: String(facts.windows.length), open: true, t },
      createElement(WindowsList, { windows: facts.windows, snapshot, t })),
    createElement(Section, { label: t('sectionWorkspace'), open: true, t },
      createElement(WorkspaceBlock, { workspace: facts.workspace, t })),
    createElement('div', { className: 'arbor-hint arbor-session-hint' }, t('sessionTabHint')))
}

/** The left sidebar's arbor page: a host overview and one tab per opened session. */
export function ArborPage(props: ArborSlotProps & ArborPageInjected): ReactNode {
  const t = props.t ?? ((key: string) => key)
  const host = useChannel(hostChannel())
  const facts = host.facts
  const [opened, setOpened] = useState<readonly string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const sessions = facts?.sessions ?? []
  const activeSession = active !== null && sessions.some(session => session.sessionId === active) ? active : null
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
    return session === undefined ? sessionId.slice(0, 14) : sessionName(session)
  }
  return createElement('div', { className: 'arbor-page', 'data-arbor-page': true },
    createElement('header', { className: 'arbor-page-head' },
      createElement('div', { className: 'arbor-page-title-row' },
        createElement('span', { className: 'arbor-panel-mark' }),
        createElement('span', { className: 'arbor-label arbor-page-title' }, t('pageTitle')),
        createElement('span', { className: 'arbor-chip arbor-label arbor-chip-session' }, t('host'))),
      createElement('div', { className: 'arbor-muted arbor-page-intro' }, t('pageIntro')),
      facts === undefined ? null : createElement('div', { className: 'arbor-muted arbor-page-data' },
        t('dataRoot'), ': ', createElement('span', { className: 'arbor-mono' }, facts.dataRoot),
        ' · ', facts.backend, ' · ', facts.shared)),
    createElement('nav', { className: 'arbor-tabs', 'aria-label': t('pageTitle') },
      createElement('button', {
        type: 'button',
        className: `arbor-tab arbor-label${activeSession === null ? ' is-active' : ''}`,
        onClick: () => { setActive(null) },
      }, t('tabOverview')),
      opened.map(sessionId => createElement('div', { className: `arbor-tab-group${activeSession === sessionId ? ' is-active' : ''}`, key: sessionId },
        createElement('button', {
          type: 'button',
          className: 'arbor-tab arbor-label',
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
      ? createElement('div', { className: 'arbor-page-body' },
        createElement('div', { className: 'arbor-label arbor-loading' }, t('loading')),
        host.status === 'error' && host.error !== undefined
          ? createElement('div', { className: 'arbor-error' }, t('error', { message: host.error }))
          : null)
      : activeSession === null
        ? createElement(Overview, { facts, snapshot: host, t, onOpenSession: openSession })
        : createElement(SessionView, {
          sessionId: activeSession,
          session: sessions.find(session => session.sessionId === activeSession),
          t,
          ...(props.openDshSession === undefined ? {} : { openDshSession: props.openDshSession }),
        }))
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
