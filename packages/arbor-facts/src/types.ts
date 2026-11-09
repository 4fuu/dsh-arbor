/**
 * The shape of what the arbor panels read, and the wire frames a browser
 * receives from the host half.
 *
 * Every field is arbor's own answer, read from arbor's own API by
 * `@4fu/dsh-arbor-facts` and never re-derived by the browser: the window chain
 * and its ends are the journal's, the board lines are `Arbor.boardLines()`, the
 * workspace facts are the workspace implementation's, the active notes are
 * `NoteStore.snapshot()`, the environment items are `Environment.list()`, the
 * schedules are `Arbor.schedules()`, and the settings are
 * `Environment.settings()` falling back to the deployment's own
 * (`@4fu/dsh-arbor-host` `defaultSettings`). The browser renders them and
 * nothing else.
 *
 * JSON only: the values cross an exact Fetch route as NDJSON.
 */

/** One checkout a window's chain holds open (ovnfs), as the workspace reports it. */
export interface ArborCheckoutFacts {
  /** The checkout's name, which begins with the window ref that opened it. */
  readonly name: string
  /** Where a command works in it. */
  readonly path: string
  /** It holds changes not yet applied back to the shared folder. */
  readonly dirty: boolean
}

/** One persistent directory a chain created, as the workspace reports it. */
export interface ArborKeepFacts {
  readonly name: string
  readonly path: string
}

/** One piece of work a window still has open, as the workspace reports it. */
export interface ArborOpenWorkFacts {
  readonly window: string
  readonly name: string
  readonly detail?: string
}

/**
 * An `end` arbor refused while the window stayed open.
 *
 * The rule, the wording and the next action are arbor's own journal record of
 * the refusal (`end.handoff.invalid`, for a handoff whose fields are not the
 * four string arrays). The window is still live, so a reader must show this as
 * a refusal, never as an ended window.
 */
export interface ArborEndRefusalFacts {
  readonly rule: string
  /** The refusal text arbor recorded: rule, message and next action. */
  readonly message: string
  readonly at: number
  /** The `tool_result` event that recorded the refusal. */
  readonly ref: string
}

/** One window of a session's chain. */
export interface ArborWindowFacts {
  /** Arbor's own window ref, `c41`. */
  readonly ref: string
  /** The host's live state, or `ended` for a window only the journal holds. */
  readonly state: 'running' | 'idle' | 'ended' | 'paused'
  readonly live: boolean
  /** From the window's `window_start` event. */
  readonly startedAt?: number
  /** From the window's `window_end` event. */
  readonly endedAt?: number
  /** The end reason arbor recorded: `model_ended`, `idle_timeout`, `hard_limit`, `host_restart`, `failed`. */
  readonly endReason?: string
  /** Tokens the window used, and the budget it ran under. */
  readonly used?: number
  readonly limit?: number
  readonly reserve?: number
  /** The board's line: what this window is doing, or last did. */
  readonly doing?: string
  /** The task ref the window was opened for. */
  readonly task?: string
  /** The targets the window touched, as the board holds them. */
  readonly targets: readonly string[]
  /** The window this one continues. */
  readonly continuationOf?: string
  /** The window that continues this one, when the chain went on. */
  readonly continuedBy?: string
  /** The end recorded a handoff, with the refs and parts arbor kept. */
  readonly handoff?: {
    readonly present: true
    readonly refs: readonly string[]
    readonly topics?: readonly string[]
    readonly progress?: readonly string[]
    readonly pending?: readonly string[]
    readonly agreements?: readonly string[]
  }
  /** Why the end was refused, when arbor recorded one. */
  readonly refused?: string
  /**
   * The latest `end` arbor refused, when the window is still live. Absent once
   * the window ends or a later `end` succeeds.
   */
  readonly endRefused?: ArborEndRefusalFacts
  /** What the window still has open in its workspace, as the board last learned it. */
  readonly openWork?: readonly string[]
}

/** The session's `<workspace>`: the project, the pointers and what the chain holds open. */
export interface ArborWorkspaceFacts {
  /** Which implementation arbor settled on. */
  readonly backend: 'ovnfs' | 'dir'
  /** Arbor's shared folder: the projects' home and ovnfs's source. */
  readonly shared: string
  /** The project the session's current directory resolves to, when it is one. */
  readonly project?: {
    readonly name: string
    readonly path: string
  }
  /** The session's current directory, as DSH projects it. */
  readonly cwd?: string
  /** The directories the user added, which arbor names and uses in place. */
  readonly pointers: readonly ArborKeepFacts[]
  /** The chain's open checkouts, for an implementation that makes them. */
  readonly checkouts: readonly ArborCheckoutFacts[]
  /** The persistent directories the chain created. */
  readonly keeps: readonly ArborKeepFacts[]
  /** What the chain's windows still have open. */
  readonly openWork: readonly ArborOpenWorkFacts[]
}

/** One line of arbor's board, for a window of this session's chain. */
export interface ArborBoardFacts {
  readonly window: string
  readonly doing: string
  readonly state: string
  readonly targets: readonly string[]
  readonly usage: {
    readonly used: number
    readonly limit: number
    readonly reserve: number
  }
  readonly openWork?: readonly string[]
}

/** Arbor's active note set: the memory every window opens with. */
export interface ArborNotesFacts {
  /** The epoch the active set belongs to. */
  readonly epoch: number
  readonly total: number
  readonly tokens: number
  readonly budget: {
    readonly count: number
    readonly tokens: number
  }
  readonly items: ReadonlyArray<{
    readonly ref: string
    readonly id: string
    readonly title: string
    readonly summary: string
    readonly revision: number
    readonly time: number
  }>
}

/** One item of arbor's `/env`. */
export interface ArborEnvItemFacts {
  readonly kind: 'skill' | 'mcp' | 'service' | 'settings'
  readonly name: string
  readonly description: string
  readonly path?: string
  readonly revision: number
  readonly builtin?: boolean
  /** The functions an MCP server listed. */
  readonly functions?: readonly string[]
  /** The last state a service event recorded, for a service item. */
  readonly state?: string
  /** The last error a service event recorded. */
  readonly error?: string
}

/** Arbor's environment as the model reads it. */
export interface ArborEnvFacts {
  /** The revision every window opens with. */
  readonly revision: string
  /** The shared mount, `/env`. */
  readonly mount: string
  /** The directory behind the mount on the host. */
  readonly directory: string
  readonly items: readonly ArborEnvItemFacts[]
}

/** One scheduled task arbor holds. */
export interface ArborScheduleFacts {
  readonly ref: string
  readonly name?: string
  readonly firstAt: number
  readonly nextAt: number
  readonly lastAt?: number
  readonly fired?: number
  readonly paused: boolean
  readonly everyMs?: number
  readonly dailyAt?: string
  readonly weekdays?: readonly number[]
  /** The schedule names this session's target. */
  readonly mine: boolean
  readonly targets: readonly string[]
}

/** Arbor's settings, as the environment installs them. */
export interface ArborSettingsFacts {
  /** `environment` when `/env/settings.json` holds them, `deployment` for the seed. */
  readonly source: 'environment' | 'deployment'
  readonly identity?: string
  readonly generalRules?: readonly string[]
  readonly judge?: {
    readonly modes?: Readonly<Record<string, string>>
    readonly maxCandidates?: number
    readonly activeSetJudgeShare?: number
  }
  readonly modelTiers?: Readonly<Record<string, string>>
  readonly defaultTier?: string
  readonly window?: {
    readonly idleSeconds?: number
    readonly contextTokens?: number
    readonly reserveTokens?: number
    readonly protectionSeconds?: number
  }
  readonly notes?: {
    readonly activeCount?: number
    readonly activeTokenBudget?: number
  }
  readonly schedule?: {
    readonly spreadColliding?: boolean
    readonly jitterMs?: number
  }
  readonly workspaces?: {
    readonly retentionMs?: number
    readonly shared?: string
  }
  readonly secrets?: readonly string[]
}

/** Everything one arbor session's panels read, in one frame. */
export interface ArborFacts {
  readonly version: 1
  readonly sessionId: string
  /** Moves whenever the host rebuilt the facts; the client uses it to skip equal frames. */
  readonly revision: number
  /** When the host assembled this frame. */
  readonly at: number
  /** What the session is, as DSH projects it. */
  readonly preset: string
  /** Where arbor keeps the journal, the notes and the environment. */
  readonly dataRoot: string
  /** The session's chain, oldest window first. */
  readonly windows: readonly ArborWindowFacts[]
  /** The live windows of the chain, as the board shows them. */
  readonly board: readonly ArborBoardFacts[]
  readonly workspace: ArborWorkspaceFacts
  readonly notes: ArborNotesFacts
  readonly env: ArborEnvFacts
  readonly schedules: readonly ArborScheduleFacts[]
  readonly settings: ArborSettingsFacts
}

/**
 * One live delta from `Arbor.stream(window, …)`, narrowed to what a reader can
 * show: the assistant text as it is written, and the arguments of a tool call
 * still being written - which is where `send`'s content becomes readable before
 * the call completes (`@4fu/arbor-interfaces`, `StreamEvent`).
 */
export type ArborStreamEvent =
  | { readonly kind: 'text_delta'; readonly delta: string }
  | { readonly kind: 'tool_call_delta'; readonly name: string; readonly args: string }

/** One arbor session in the whole-host view. */
export interface ArborHostSessionFacts {
  /** DSH's session id, which is also the label every window carries. */
  readonly sessionId: string
  /**
   * The title DSH shows for the session, read from its latest `session/title`
   * event. The host page leads with it so one session never reads as two
   * different things in the sidebar and the page.
   */
  readonly title?: string
  readonly preset: string
  /** Every window of this session, oldest first. */
  readonly windows: readonly ArborWindowFacts[]
  readonly live: number
  /** What it is doing now, from its newest live board line. */
  readonly doing?: string
  readonly project?: {
    readonly name: string
    readonly path: string
  }
  readonly cwd?: string
  readonly pointers: readonly ArborKeepFacts[]
}

/** Everything the overall arbor view reads, across every session of the host. */
export interface ArborHostFacts {
  readonly version: 1
  readonly revision: number
  readonly at: number
  readonly dataRoot: string
  readonly backend: 'ovnfs' | 'dir'
  readonly shared: string
  /** Every arbor session the host holds windows for, most recent first. */
  readonly sessions: readonly ArborHostSessionFacts[]
  /** Every window of every session, oldest first. */
  readonly windows: readonly ArborWindowFacts[]
  readonly board: readonly ArborBoardFacts[]
  readonly notes: ArborNotesFacts
  readonly env: ArborEnvFacts
  readonly schedules: readonly ArborScheduleFacts[]
  readonly settings: ArborSettingsFacts
}

/** One frame of the NDJSON facts stream. */
export type ArborFactsFrame =
  | { readonly type: 'facts'; readonly facts: ArborFacts }
  | { readonly type: 'stream'; readonly window: string; readonly event: ArborStreamEvent }
  | { readonly type: 'error'; readonly message: string }

/** One frame of the whole-host NDJSON stream. */
export type ArborHostFrame =
  | { readonly type: 'facts'; readonly facts: ArborHostFacts }
  | { readonly type: 'stream'; readonly window: string; readonly sessionId?: string; readonly event: ArborStreamEvent }
  | { readonly type: 'error'; readonly message: string }

/** One journal hit, as arbor's own search answered it. */
export interface ArborJournalHit {
  readonly ref: string
  readonly seq: number
  readonly window: string | null
  readonly kind: string
  readonly time: number
  readonly match: string
  readonly score: number
  readonly summary: string
}

/** One note hit, as arbor's own search answered it. */
export interface ArborNoteHit {
  readonly ref: string
  readonly title: string
  readonly summary: string
}

/** One board hit, as arbor's own search answered it. */
export interface ArborBoardHit {
  readonly window: string
  readonly doing: string
}

/** What `Arbor.search(query)` answered, over the journal, the notes and the board. */
export interface ArborSearchResult {
  readonly query: string
  readonly journal: readonly ArborJournalHit[]
  readonly notes: readonly ArborNoteHit[]
  readonly board: readonly ArborBoardHit[]
  readonly total: number
}
