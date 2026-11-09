window.__ModuleLoader__.load({
	id: "@4fu/dsh-arbor-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/arbor-ui/src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react2 = require("react");

// packages/arbor-ui/src/channel.ts
var TEXT_LIMIT = 6e3;
var SEND_LIMIT = 1500;
var ACTIVITY_MS = 1600;
var RETRY_BASE_MS = 800;
var RETRY_MAX_MS = 5e3;
function sendContentOf(raw) {
  const match = /"content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (match === null) return void 0;
  const body = match[1] ?? "";
  return body.replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
function tail(text, limit) {
  return text.length <= limit ? text : text.slice(text.length - limit);
}
var FactsChannel = class {
  url;
  listeners = /* @__PURE__ */ new Set();
  snapshot = { status: "connecting", streams: {}, streaming: false };
  controller;
  retry;
  retryDelay = RETRY_BASE_MS;
  activity;
  holds = 0;
  stopped = true;
  constructor(url) {
    this.url = url;
  }
  /** The current snapshot; the same reference until something changed. */
  getSnapshot = () => this.snapshot;
  /** Subscribe one React store listener. */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Take one hold on the stream; the first starts it. */
  retain() {
    this.holds += 1;
    if (this.holds !== 1) return;
    this.stopped = false;
    void this.connect();
  }
  /** Release one hold; the last stops the stream. */
  release() {
    this.holds -= 1;
    if (this.holds > 0) return;
    this.close();
  }
  /** Stop this channel for good, whoever still holds it. */
  close() {
    this.stopped = true;
    this.holds = 0;
    this.controller?.abort();
    this.controller = void 0;
    if (this.retry !== void 0) clearTimeout(this.retry);
    this.retry = void 0;
    if (this.activity !== void 0) clearTimeout(this.activity);
    this.activity = void 0;
  }
  /** Open the stream and read it until the page's carrier drops it. */
  async connect() {
    if (this.stopped) return;
    this.set({ ...this.snapshot, status: this.snapshot.facts === void 0 ? "connecting" : "live" });
    const controller = new AbortController();
    this.controller = controller;
    try {
      const response = await fetch(this.url, {
        signal: controller.signal,
        headers: { accept: "application/x-ndjson" },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`facts stream answered ${response.status}`);
      if (response.body === null) throw new Error("facts stream has no body");
      this.retryDelay = RETRY_BASE_MS;
      this.set({ ...this.snapshot, status: "live", error: void 0 });
      await this.read(response.body, controller.signal);
      if (controller.signal.aborted) return;
      throw new Error("facts stream ended");
    } catch (error) {
      if (controller.signal.aborted || this.stopped) return;
      this.set({
        ...this.snapshot,
        status: this.snapshot.facts === void 0 ? "error" : "live",
        error: error instanceof Error ? error.message : String(error)
      });
      this.retry = setTimeout(() => {
        this.retry = void 0;
        void this.connect();
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
  }
  /** Read one response's NDJSON body, one frame at a time. */
  async read(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { value, done } = await reader.read();
      if (signal.aborted) {
        await reader.cancel().catch(() => void 0);
        return;
      }
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (; ; ) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") this.handle(JSON.parse(line));
      }
    }
  }
  /** Fold one frame into the snapshot. */
  handle(frame) {
    if (frame.type === "facts") {
      this.set({ ...this.snapshot, status: "live", facts: frame.facts, error: void 0 });
      return;
    }
    if (frame.type === "error") {
      this.set({ ...this.snapshot, error: frame.message });
      return;
    }
    this.stream(frame.window, frame.event);
  }
  /** Fold one live window delta into its own buffer. */
  stream(window2, event) {
    const before = this.snapshot.streams[window2] ?? { text: "", send: "", streaming: false };
    let next = before;
    if (event.kind === "text_delta") {
      next = { ...before, text: tail(before.text + event.delta, TEXT_LIMIT) };
    } else {
      const content = sendContentOf(event.args);
      if (event.name === "send" && content !== void 0) {
        next = { ...before, send: tail(content, SEND_LIMIT) };
      }
    }
    const streams = { ...this.snapshot.streams, [window2]: { ...next, streaming: true } };
    this.set({ ...this.snapshot, streams, streaming: true });
    if (this.activity !== void 0) clearTimeout(this.activity);
    this.activity = setTimeout(() => {
      this.activity = void 0;
      const cleared = {};
      for (const [ref, view] of Object.entries(this.snapshot.streams)) cleared[ref] = { ...view, streaming: false };
      this.set({ ...this.snapshot, streams: cleared, streaming: false });
    }, ACTIVITY_MS);
  }
  /** Publish one snapshot and wake React. */
  set(snapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
};
var channels = /* @__PURE__ */ new Map();
function channelFor(sessionId) {
  const key = `session:${sessionId}`;
  let channel = channels.get(key);
  if (channel === void 0) {
    channel = new FactsChannel(`/api/arbor/facts?sessionId=${encodeURIComponent(sessionId)}`);
    channels.set(key, channel);
  }
  return channel;
}
function hostChannel() {
  const key = "host";
  let channel = channels.get(key);
  if (channel === void 0) {
    channel = new FactsChannel("/api/arbor/host");
    channels.set(key, channel);
  }
  return channel;
}
function closeChannels() {
  for (const channel of channels.values()) channel.close();
  channels.clear();
}

// packages/arbor-ui/src/i18n.ts
var NAMESPACE = "arborUi";
var en = {
  expandStream: "Show more",
  collapseStream: "Show less",
  heroIdleOne: "1 session is quiet; {ended} windows have finished.",
  chainSummaryOne: "{count} window \xB7 {window} {state}",
  dateLocale: "en-US",
  filterAll: "All",
  filterWindows: "Windows",
  filterBoard: "Board",
  filterNotes: "Notes",
  filterEnv: "Environment",
  filterSchedules: "Schedules",
  heroLive: "{window} is working. The board holds {board} things.",
  heroLiveBoardOne: "{window} is working. The board holds {board} thing.",
  heroFirst: "{window} is working. The board holds {board} things.",
  heroIdle: "{sessions} sessions are quiet; {ended} windows have finished.",
  heroIdleEndedOne: "{sessions} sessions are quiet; {ended} window has finished.",
  heroIdleBothOne: "1 session is quiet; {ended} window has finished.",
  heroIdleWait: "{waiting} sessions are waiting for you; {ended} windows have finished.",
  heroIdleWaitEndedOne: "{waiting} sessions are waiting for you; {ended} window has finished.",
  heroIdleWaitOne: "1 session is waiting for you; {ended} windows have finished.",
  heroIdleWaitBothOne: "1 session is waiting for you; {ended} window has finished.",
  heroLiveWait: "{window} is working. The board holds {board} things, and {waiting} other sessions are waiting for you.",
  heroLiveWaitBoardOne: "{window} is working. The board holds {board} thing, and {waiting} other sessions are waiting for you.",
  heroLiveWaitWaitingOne: "{window} is working. The board holds {board} things, and {waiting} other session is waiting for you.",
  heroLiveWaitBothOne: "{window} is working. The board holds {board} thing, and {waiting} other session is waiting for you.",
  heroLiveNoBoardWait: "{window} is working; the board is empty, and {waiting} other sessions are waiting for you.",
  heroLiveNoBoardWaitOne: "{window} is working; the board is empty, and {waiting} other session is waiting for you.",
  heroEmpty: "No arbor window yet.",
  heroEmptyHint: "Pick Arbor in any session and send a message; this page will light up.",
  sessionHeroLive: "{window} is carrying on from {previous}, with {board} things still on the board.",
  sessionHeroLiveBoardOne: "{window} is carrying on from {previous}, with {board} thing still on the board.",
  sessionHeroFirst: "{window} is working, with {board} things on the board.",
  sessionHeroFirstBoardOne: "{window} is working, with {board} thing on the board.",
  sessionHeroIdle: "{window} is waiting for your next message.",
  sessionHeroEnded: "All {count} windows are finished; the chain ends at {window}.",
  sessionHeroEndedOne: "1 window is finished; the chain ends at {window}.",
  sessionHeroEmpty: "This session has no window yet.",
  sessionHeroEmptyHint: "Send the first message and arbor will open its first window.",
  cardChain: "Window chain",
  cardWorkspace: "Workspace",
  cardEnvironment: "Environment",
  cardSchedules: "Schedules",
  cardSession: "Session",
  streamEmpty: "When the model starts writing, the lines appear here.",
  emptyWindows: "No window yet.",
  emptyWindowsHint: "The first message opens the first window.",
  emptyBoard: "The board is empty.",
  emptyBoardHint: "A running window writes what it is doing here.",
  emptyNotes: "No active note yet.",
  emptyNotesHint: "Notes are the memory a window writes for the next one.",
  emptyEnv: "The environment is empty.",
  emptyEnvHint: "Skills, MCP servers and services appear here.",
  emptySchedules: "No schedule yet.",
  emptySchedulesHint: "When arbor needs to work at a time, its schedule appears here.",
  openSearch: "Search",
  openSettings: "Settings",
  closeSheet: "Close",
  settingsHostData: "Host data",
  settingsBackend: "Workspace backend",
  settingsShared: "Shared folder",
  chainRestart: "restart",
  chainHandoff: "handoff",
  chainStart: "start",
  chainEnd: "end",
  tabTitle: "Arbor",
  panelLabel: "Arbor",
  pageTitle: "Arbor",
  pageIntro: "The whole arbor host: every session, window, board line, note, environment item, schedule and setting.",
  tabOverview: "Overview",
  sessions: "Sessions",
  liveWindows: "Live windows",
  noSessions: "No arbor window yet.",
  noSessionsHint: "Pick Arbor in any session and send a message; its windows appear here.",
  openSessionTab: "Expand session",
  closeTab: "Close tab",
  openInDsh: "Open session",
  now: "Now",
  noLiveWindow: "No live window.",
  chain: "Window chain",
  chainSummary: "{count} windows \xB7 {window} {state}",
  summarySessions: "Sessions",
  summaryWindows: "Live windows",
  summaryNotes: "Active notes",
  summaryEnv: "Environment",
  summarySchedules: "Schedules",
  host: "host",
  dataRoot: "Data root",
  sessionTabHint: "This tab has only this session's state.",
  chipTitle: "Arbor",
  chipAria: "Open the arbor panel",
  chipNoWindow: "No window",
  chipWindows: "{count} windows",
  chipWindowOne: "1 window",
  chipIdle: "Idle \xB7 {count} windows",
  chipIdleOne: "Idle \xB7 1 window",
  chipLive: "Live",
  panelIntro: "What arbor is actually doing in this session, read from arbor itself.",
  notArbor: "This session does not run on arbor.",
  loading: "Reading arbor\u2026",
  error: "The arbor channel is unavailable: {message}",
  retry: "Retrying\u2026",
  statusRunning: "Running",
  statusIdle: "Idle",
  statusEnded: "Ended",
  statusPaused: "Paused",
  sectionWindows: "Windows",
  sectionWorkspace: "Workspace",
  sectionBoard: "Board",
  sectionNotes: "Notes",
  sectionEnvironment: "Environment",
  sectionSchedules: "Schedules",
  sectionSettings: "Settings",
  sectionSearch: "Search",
  noWindows: "No window yet.",
  noWindowsHint: "The first message opens this session's first arbor window.",
  live: "live",
  ended: "ended",
  windowCount: "{count} in the chain",
  endModel: "model ended",
  endIdle: "idle timeout",
  endHardLimit: "context limit",
  endRestart: "host restart",
  endFailed: "model failed",
  endPaused: "paused",
  handoff: "handoff",
  handoffTo: "continued by {window}",
  continuesFrom: "continues {window}",
  handoffRefs: "handoff refs",
  handoffTopics: "Topics",
  handoffProgress: "Progress",
  handoffPending: "Pending",
  handoffAgreements: "Agreements",
  refused: "refused: {rule}",
  usage: "{used} / {limit} tokens",
  streamText: "Model output",
  streamSend: "send draft",
  streamWaiting: "No output yet.",
  workspaceBackend: "Workspace",
  workspaceShared: "Shared folder",
  workspaceProject: "Project",
  workspaceCwd: "Session directory",
  workspacePointers: "External pointers",
  workspaceCheckouts: "Checkouts",
  workspaceKeeps: "Persistent directories",
  workspaceOpenWork: "Open work",
  workspaceDirty: "unapplied",
  workspaceClean: "clean",
  none: "None.",
  boardEmpty: "No live window is on the board.",
  boardTargets: "Targets",
  notesActive: "Active set",
  notesCount: "{count} notes \xB7 {tokens} / {budget} tokens",
  notesCountOne: "1 note \xB7 {tokens} / {budget} tokens",
  notesEpoch: "Epoch {epoch}",
  notesEmpty: "The active set is empty.",
  envCounts: "{skills} skills \xB7 {servers} MCP servers \xB7 {services} services",
  envBuiltin: "built-in",
  envFunctions: "functions",
  envSkills: "Skills",
  envSkillOne: "Skill",
  envMcp: "MCP servers",
  envMcpOne: "MCP server",
  envServices: "Services",
  envServiceOne: "Service",
  envState: "state",
  envPath: "path",
  envEmpty: "The environment holds no item.",
  schedulesEmpty: "Arbor holds no schedule.",
  scheduleNext: "next {time}",
  scheduleEvery: "every {value}",
  scheduleDaily: "daily at {value}",
  scheduleWeekly: "weekdays {value}",
  schedulePaused: "paused",
  scheduleMine: "this session",
  scheduleFired: "{count} fired",
  settingsSourceEnvironment: "from /env/settings.json",
  settingsSourceDeployment: "deployment seed",
  settingsIdentity: "Identity",
  settingsRules: "General rules",
  settingsJudge: "Judge",
  settingsTiers: "Model tiers",
  settingsDefaultTier: "Default tier",
  settingsWindow: "Window",
  settingsIdle: "Idle",
  settingsContext: "Context",
  settingsReserve: "Reserve",
  settingsProtection: "Protection",
  settingsNotes: "Notes",
  settingsNotesCount: "Active count",
  settingsNotesTokens: "Active tokens",
  settingsSecrets: "Secret names",
  settingsJudgeOn: "on",
  settingsJudgeOff: "off",
  settingsJudgeShadow: "shadow",
  settingsDsh: "DSH's Agent loop page configures ordinary sessions; an arbor window runs under the tier and window limits above.",
  settingsEmpty: "Arbor runs on its own defaults.",
  searchPlaceholder: "Search the journal and notes",
  searchButton: "Search",
  searchEmpty: "Nothing matched.",
  searchTotal: "{count} hits",
  searchTotalOne: "1 hit",
  searchJournal: "Journal",
  searchNotes: "Notes",
  searchBoard: "Board",
  searchHint: "Arbor's own search over its journal, notes and board.",
  searchError: "Search failed: {message}",
  seconds: "{value}s",
  minutes: "{value}m",
  hours: "{value}h",
  tokens: "tokens",
  window: "window",
  heroLiveNoBoard: "{window} is working; the board is empty."
};
var zh = {
  expandStream: "\u5C55\u5F00\u5168\u6587",
  collapseStream: "\u6536\u8D77",
  heroIdleOne: "1 \u4E2A\u4F1A\u8BDD\u5B89\u9759\u7740\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  chainSummaryOne: "{count} \u4E2A\u7A97\u53E3 \xB7 {window} {state}",
  dateLocale: "zh-CN",
  filterAll: "\u5168\u90E8",
  filterWindows: "\u7A97\u53E3",
  filterBoard: "\u770B\u677F",
  filterNotes: "\u7B14\u8BB0",
  filterEnv: "\u73AF\u5883",
  filterSchedules: "\u65E5\u7A0B",
  heroLive: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  heroLiveBoardOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  heroFirst: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  heroIdle: "{sessions} \u4E2A\u4F1A\u8BDD\u5B89\u9759\u7740\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleEndedOne: "{sessions} \u4E2A\u4F1A\u8BDD\u5B89\u9759\u7740\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleBothOne: "1 \u4E2A\u4F1A\u8BDD\u5B89\u9759\u7740\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleWait: "{waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleWaitEndedOne: "{waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleWaitOne: "1 \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroIdleWaitBothOne: "1 \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\uFF0C{ended} \u4E2A\u7A97\u53E3\u5DF2\u7ECF\u6536\u5DE5\u3002",
  heroLiveWait: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroLiveWaitBoardOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroLiveWaitWaitingOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroLiveWaitBothOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroLiveNoBoardWait: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u7A7A\u7740\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroLiveNoBoardWaitOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u7A7A\u7740\uFF1B\u53E6\u5916 {waiting} \u4E2A\u4F1A\u8BDD\u5728\u7B49\u4F60\u3002",
  heroEmpty: "\u8FD8\u6CA1\u6709 Arbor \u7A97\u53E3\u3002",
  heroEmptyHint: "\u5728\u4EFB\u610F\u4F1A\u8BDD\u91CC\u9009\u62E9 Arbor\uFF0C\u53D1\u4E00\u6761\u6D88\u606F\uFF0C\u8FD9\u91CC\u5C31\u4F1A\u4EAE\u8D77\u6765\u3002",
  sessionHeroLive: "{window} \u6B63\u5728\u63A5\u7740 {previous} \u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  sessionHeroLiveBoardOne: "{window} \u6B63\u5728\u63A5\u7740 {previous} \u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  sessionHeroFirst: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  sessionHeroFirstBoardOne: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u4E0A\u8FD8\u6709 {board} \u4EF6\u4E8B\u3002",
  sessionHeroIdle: "{window} \u7A7A\u7740\uFF0C\u7B49\u4F60\u53D1\u4E0B\u4E00\u53E5\u8BDD\u3002",
  sessionHeroEnded: "\u8FD9\u4E2A\u4F1A\u8BDD\u7684 {count} \u4E2A\u7A97\u53E3\u90FD\u6536\u5DE5\u4E86\uFF0C\u6700\u540E\u505C\u5728 {window}\u3002",
  sessionHeroEndedOne: "\u8FD9\u4E2A\u4F1A\u8BDD\u7684 1 \u4E2A\u7A97\u53E3\u6536\u5DE5\u4E86\uFF0C\u6700\u540E\u505C\u5728 {window}\u3002",
  sessionHeroEmpty: "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u7A97\u53E3\u3002",
  sessionHeroEmptyHint: "\u53D1\u7B2C\u4E00\u6761\u6D88\u606F\uFF0Carbor \u4F1A\u4E3A\u5B83\u5F00\u7B2C\u4E00\u4E2A\u7A97\u53E3\u3002",
  cardChain: "\u7A97\u53E3\u94FE",
  cardWorkspace: "\u5DE5\u4F5C\u533A",
  cardEnvironment: "\u73AF\u5883",
  cardSchedules: "\u65E5\u7A0B",
  cardSession: "\u4F1A\u8BDD",
  streamEmpty: "\u6A21\u578B\u5F00\u59CB\u5199\u65F6\uFF0C\u8FD9\u91CC\u4F1A\u4E00\u884C\u884C\u51FA\u73B0\u3002",
  emptyWindows: "\u8FD8\u6CA1\u6709\u7A97\u53E3\u3002",
  emptyWindowsHint: "\u53D1\u7B2C\u4E00\u6761\u6D88\u606F\uFF0C\u7B2C\u4E00\u4E2A\u7A97\u53E3\u5C31\u4F1A\u5F00\u3002",
  emptyBoard: "\u770B\u677F\u662F\u7A7A\u7684\u3002",
  emptyBoardHint: "\u7A97\u53E3\u8DD1\u8D77\u6765\u540E\uFF0C\u5B83\u4F1A\u5728\u8FD9\u91CC\u5199\u4E0B\u6B63\u5728\u505A\u4EC0\u4E48\u3002",
  emptyNotes: "\u8FD8\u6CA1\u6709\u6D3B\u8DC3\u7B14\u8BB0\u3002",
  emptyNotesHint: "\u7B14\u8BB0\u662F\u7A97\u53E3\u5199\u7ED9\u4E0B\u4E00\u4E2A\u7A97\u53E3\u7684\u8BB0\u5FC6\u3002",
  emptyEnv: "\u73AF\u5883\u91CC\u8FD8\u6CA1\u6709\u4E1C\u897F\u3002",
  emptyEnvHint: "\u6280\u80FD\u3001MCP \u670D\u52A1\u548C\u670D\u52A1\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
  emptySchedules: "\u8FD8\u6CA1\u6709\u65E5\u7A0B\u3002",
  emptySchedulesHint: "\u9700\u8981\u5230\u70B9\u5E72\u6D3B\u65F6\uFF0Carbor \u7684\u65E5\u7A0B\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
  openSearch: "\u641C\u7D22",
  openSettings: "\u8BBE\u7F6E",
  closeSheet: "\u5173\u95ED",
  settingsHostData: "\u5BBF\u4E3B\u6570\u636E",
  settingsBackend: "\u5DE5\u4F5C\u533A\u540E\u7AEF",
  settingsShared: "\u5171\u4EAB\u76EE\u5F55",
  chainRestart: "\u91CD\u542F",
  chainHandoff: "\u4EA4\u63A5",
  chainStart: "\u5F00\u59CB",
  chainEnd: "\u7ED3\u675F",
  tabTitle: "Arbor",
  panelLabel: "Arbor",
  pageTitle: "Arbor",
  pageIntro: "\u6574\u4E2A arbor \u5BBF\u4E3B\uFF1A\u6240\u6709\u4F1A\u8BDD\u3001\u7A97\u53E3\u3001\u770B\u677F\u3001\u7B14\u8BB0\u3001\u73AF\u5883\u3001\u5B9A\u65F6\u4E0E\u8BBE\u7F6E\u3002",
  tabOverview: "\u603B\u89C8",
  sessions: "\u4F1A\u8BDD",
  liveWindows: "\u6D3B\u52A8\u7A97\u53E3",
  noSessions: "\u8FD9\u4E2A\u5BBF\u4E3B\u8FD8\u6CA1\u6709 arbor \u7A97\u53E3\u3002",
  noSessionsHint: "\u5728\u4EFB\u610F\u4F1A\u8BDD\u91CC\u9009\u62E9 Arbor \u5E76\u53D1\u4E00\u6761\u6D88\u606F\uFF0C\u7A97\u53E3\u5C31\u4F1A\u51FA\u73B0\u5728\u8FD9\u91CC\u3002",
  openSessionTab: "\u5C55\u5F00\u4F1A\u8BDD",
  closeTab: "\u5173\u95ED\u6807\u7B7E",
  openInDsh: "\u6253\u5F00\u4F1A\u8BDD",
  now: "\u6B63\u5728\u8FD0\u884C",
  noLiveWindow: "\u5F53\u524D\u6CA1\u6709\u6D3B\u52A8\u7A97\u53E3\u3002",
  chain: "\u7A97\u53E3\u94FE",
  chainSummary: "{count} \u4E2A\u7A97\u53E3 \xB7 {window} {state}",
  summarySessions: "\u4F1A\u8BDD",
  summaryWindows: "\u6D3B\u52A8\u7A97\u53E3",
  summaryNotes: "\u6D3B\u8DC3\u7B14\u8BB0",
  summaryEnv: "\u73AF\u5883",
  summarySchedules: "\u5B9A\u65F6",
  host: "\u5BBF\u4E3B",
  dataRoot: "\u6570\u636E\u76EE\u5F55",
  sessionTabHint: "\u8FD9\u4E2A\u6807\u7B7E\u53EA\u663E\u793A\u8FD9\u4E2A\u4F1A\u8BDD\u81EA\u5DF1\u7684\u72B6\u6001\u3002",
  chipTitle: "Arbor",
  chipAria: "\u6253\u5F00 Arbor \u9762\u677F",
  chipNoWindow: "\u65E0\u7A97\u53E3",
  chipWindows: "{count} \u4E2A\u7A97\u53E3",
  chipWindowOne: "1 \u4E2A\u7A97\u53E3",
  chipIdle: "\u7A7A\u95F2 \xB7 {count} \u4E2A\u7A97\u53E3",
  chipIdleOne: "\u7A7A\u95F2 \xB7 1 \u4E2A\u7A97\u53E3",
  chipLive: "\u8FD0\u884C\u4E2D",
  panelIntro: "\u8FD9\u4E2A\u4F1A\u8BDD\u91CC arbor \u771F\u5B9E\u5728\u505A\u4EC0\u4E48\uFF0C\u5168\u90E8\u8BFB\u81EA arbor \u672C\u8EAB\u3002",
  notArbor: "\u8FD9\u4E2A\u4F1A\u8BDD\u4E0D\u662F arbor \u4F1A\u8BDD\u3002",
  loading: "\u6B63\u5728\u8BFB\u53D6 arbor\u2026",
  error: "arbor \u901A\u9053\u4E0D\u53EF\u7528\uFF1A{message}",
  retry: "\u6B63\u5728\u91CD\u8BD5\u2026",
  statusRunning: "\u8FD0\u884C\u4E2D",
  statusIdle: "\u7A7A\u95F2",
  statusEnded: "\u5DF2\u7ED3\u675F",
  statusPaused: "\u6682\u505C",
  sectionWindows: "\u7A97\u53E3",
  sectionWorkspace: "\u5DE5\u4F5C\u533A",
  sectionBoard: "\u770B\u677F",
  sectionNotes: "\u7B14\u8BB0",
  sectionEnvironment: "\u73AF\u5883",
  sectionSchedules: "\u5B9A\u65F6",
  sectionSettings: "\u8BBE\u7F6E",
  sectionSearch: "\u641C\u7D22",
  noWindows: "\u8FD8\u6CA1\u6709\u7A97\u53E3\u3002",
  noWindowsHint: "\u53D1\u7B2C\u4E00\u6761\u6D88\u606F\u540E\uFF0Carbor \u4F1A\u4E3A\u8FD9\u4E2A\u4F1A\u8BDD\u5F00\u7B2C\u4E00\u4E2A\u7A97\u53E3\u3002",
  live: "\u6D3B\u52A8",
  ended: "\u7ED3\u675F",
  windowCount: "\u94FE\u4E0A {count} \u4E2A",
  endModel: "\u6A21\u578B\u7ED3\u675F",
  endIdle: "\u7A7A\u95F2\u8D85\u65F6",
  endHardLimit: "\u4E0A\u4E0B\u6587\u4E0A\u9650",
  endRestart: "\u5BBF\u4E3B\u91CD\u542F",
  endFailed: "\u6A21\u578B\u5931\u8D25",
  endPaused: "\u6682\u505C",
  handoff: "\u4EA4\u63A5",
  handoffTo: "\u7531 {window} \u7EE7\u7EED",
  continuesFrom: "\u7EE7\u7EED {window}",
  handoffRefs: "\u4EA4\u63A5\u5F15\u7528",
  handoffTopics: "\u4E3B\u9898",
  handoffProgress: "\u8FDB\u5C55",
  handoffPending: "\u5F85\u529E",
  handoffAgreements: "\u7EA6\u5B9A",
  refused: "\u88AB\u62D2\u7EDD\uFF1A{rule}",
  usage: "{used} / {limit} \u4EE4\u724C",
  streamText: "\u6A21\u578B\u8F93\u51FA",
  streamSend: "send \u8349\u7A3F",
  streamWaiting: "\u8FD8\u6CA1\u6709\u8F93\u51FA\u3002",
  workspaceBackend: "\u5DE5\u4F5C\u533A",
  workspaceShared: "\u5171\u4EAB\u6587\u4EF6\u5939",
  workspaceProject: "\u9879\u76EE",
  workspaceCwd: "\u4F1A\u8BDD\u76EE\u5F55",
  workspacePointers: "\u5916\u90E8\u6307\u5411",
  workspaceCheckouts: "\u68C0\u51FA",
  workspaceKeeps: "\u4FDD\u6301\u76EE\u5F55",
  workspaceOpenWork: "\u672A\u5B8C\u6210\u7684\u5DE5\u4F5C",
  workspaceDirty: "\u672A\u5408\u5E76",
  workspaceClean: "\u5E72\u51C0",
  none: "\u65E0\u3002",
  boardEmpty: "\u770B\u677F\u4E0A\u6CA1\u6709\u6D3B\u52A8\u7A97\u53E3\u3002",
  boardTargets: "\u76EE\u6807",
  notesActive: "\u6D3B\u8DC3\u96C6",
  notesCount: "{count} \u6761 \xB7 {tokens} / {budget} \u4EE4\u724C",
  notesCountOne: "1 \u6761 \xB7 {tokens} / {budget} \u4EE4\u724C",
  notesEpoch: "\u7B2C {epoch} \u4EE3",
  notesEmpty: "\u6D3B\u8DC3\u96C6\u4E3A\u7A7A\u3002",
  envCounts: "{skills} \u4E2A\u6280\u80FD \xB7 {servers} \u4E2A MCP \u670D\u52A1 \xB7 {services} \u4E2A\u670D\u52A1",
  envBuiltin: "\u5185\u7F6E",
  envFunctions: "\u51FD\u6570",
  envSkills: "\u6280\u80FD",
  envSkillOne: "\u6280\u80FD",
  envMcp: "MCP \u670D\u52A1",
  envMcpOne: "MCP \u670D\u52A1",
  envServices: "\u670D\u52A1",
  envServiceOne: "\u670D\u52A1",
  envState: "\u72B6\u6001",
  envPath: "\u8DEF\u5F84",
  envEmpty: "\u73AF\u5883\u91CC\u6CA1\u6709\u6761\u76EE\u3002",
  schedulesEmpty: "arbor \u6CA1\u6709\u5B9A\u65F6\u4EFB\u52A1\u3002",
  scheduleNext: "\u4E0B\u6B21 {time}",
  scheduleEvery: "\u6BCF {value}",
  scheduleDaily: "\u6BCF\u5929 {value}",
  scheduleWeekly: "\u6BCF\u5468 {value}",
  schedulePaused: "\u5DF2\u6682\u505C",
  scheduleMine: "\u672C\u4F1A\u8BDD",
  scheduleFired: "\u5DF2\u89E6\u53D1 {count} \u6B21",
  settingsSourceEnvironment: "\u6765\u81EA /env/settings.json",
  settingsSourceDeployment: "\u90E8\u7F72\u79CD\u5B50",
  settingsIdentity: "\u8EAB\u4EFD",
  settingsRules: "\u901A\u7528\u89C4\u5219",
  settingsJudge: "\u5224\u65AD",
  settingsTiers: "\u6A21\u578B\u5C42\u7EA7",
  settingsDefaultTier: "\u9ED8\u8BA4\u5C42\u7EA7",
  settingsWindow: "\u7A97\u53E3",
  settingsIdle: "\u7A7A\u95F2",
  settingsContext: "\u4E0A\u4E0B\u6587",
  settingsReserve: "\u9884\u7559",
  settingsProtection: "\u4FDD\u62A4\u671F",
  settingsNotes: "\u7B14\u8BB0",
  settingsNotesCount: "\u6D3B\u8DC3\u6761\u6570",
  settingsNotesTokens: "\u6D3B\u8DC3\u4EE4\u724C",
  settingsSecrets: "\u5BC6\u94A5\u540D",
  settingsJudgeOn: "\u5F00\u542F",
  settingsJudgeOff: "\u5173\u95ED",
  settingsJudgeShadow: "\u5F71\u5B50",
  settingsDsh: "DSH \u7684 Agent loop \u63D2\u4EF6\u9875\u9762\u7BA1\u7684\u662F\u666E\u901A\u4F1A\u8BDD\uFF1Barbor \u7A97\u53E3\u6309\u4E0A\u9762\u7684\u5C42\u7EA7\u548C\u7A97\u53E3\u9650\u5236\u8FD0\u884C\u3002",
  settingsEmpty: "arbor \u4F7F\u7528\u81EA\u5DF1\u7684\u9ED8\u8BA4\u503C\u3002",
  searchPlaceholder: "\u641C\u7D22\u65E5\u5FD7\u4E0E\u7B14\u8BB0",
  searchButton: "\u641C\u7D22",
  searchEmpty: "\u6CA1\u6709\u547D\u4E2D\u3002",
  searchTotal: "{count} \u6761\u547D\u4E2D",
  searchTotalOne: "1 \u6761\u547D\u4E2D",
  searchJournal: "\u65E5\u5FD7",
  searchNotes: "\u7B14\u8BB0",
  searchBoard: "\u770B\u677F",
  searchHint: "arbor \u81EA\u5DF1\u7684\u641C\u7D22\uFF0C\u67E5\u65E5\u5FD7\u3001\u7B14\u8BB0\u548C\u770B\u677F\u3002",
  searchError: "\u641C\u7D22\u5931\u8D25\uFF1A{message}",
  seconds: "{value} \u79D2",
  minutes: "{value} \u5206\u949F",
  hours: "{value} \u5C0F\u65F6",
  tokens: "\u4EE4\u724C",
  window: "\u7A97\u53E3",
  heroLiveNoBoard: "{window} \u6B63\u5728\u5E72\u6D3B\uFF0C\u770B\u677F\u7A7A\u7740\u3002"
};
function format(template, args) {
  if (args === void 0) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(args, name) ? String(args[name]) : whole);
}
function fallbackTranslate(key, args) {
  const value = zh[key];
  return value === void 0 ? key : format(value, args);
}

// packages/arbor-ui/src/styles.ts
var STYLE_ID = "arbor-ui-panel-style";
var CSS = `.arbor-page{
  --arbor-font-body:var(--dsw-font-family);
  --arbor-font-display:var(--dsw-font-family);
  --arbor-font-numeric:var(--dsw-font-family);
  --arbor-font-code:var(--ds-font-family-code);
  box-sizing:border-box;min-height:100%;overflow:auto;
  padding:24px 28px 32px;
  background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-label-primary,#0f1115);
  font-family:var(--arbor-font-body);
  font-size:13px;line-height:1.55;
}
.arbor-page *{box-sizing:border-box}
.arbor-page [data-arbor-text="body"]{font-family:var(--arbor-font-body)}
.arbor-page [data-arbor-text="display"]{font-family:var(--arbor-font-display)}
.arbor-page [data-arbor-text="numeric"]{font-family:var(--arbor-font-numeric);font-variant-numeric:tabular-nums}
.arbor-page [data-arbor-text="code"]{font-family:var(--arbor-font-code)}
.arbor-page-inner{width:100%;max-width:1160px;min-height:calc(100vh - 56px);margin:0 auto;display:flex;flex-direction:column;gap:14px}
.arbor-page .arbor-tabs{display:flex;flex:none;gap:4px;align-items:center;overflow-x:auto;padding:0 1px}
.arbor-page .arbor-tab-group{display:flex;align-items:center;flex:none}
.arbor-page .arbor-tab{height:27px;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-tab:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-tab.is-active, .arbor-page .arbor-tab-group.is-active .arbor-tab{background:var(--dsw-alias-bg-layer-1,#fff);border-color:var(--dsw-alias-border-l1,#0000000a);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-tab-close{width:20px;height:20px;padding:0;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;font-size:13px;line-height:1}
.arbor-page .arbor-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-hero{display:flex;flex-direction:column;gap:2px;padding:8px 0 10px}
.arbor-page .arbor-hero-top{display:flex;align-items:center;gap:12px;min-height:32px}
.arbor-page .arbor-date{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-top-actions{display:flex;gap:6px;align-items:center;flex:none}
.arbor-page .arbor-icon-button{width:32px;height:32px;padding:0;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#61666b);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;box-shadow:var(--dsw-elevation-soft,0 4px 16px #00000008)}
.arbor-page .arbor-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-hero-title{max-width:960px;margin:10px 0 2px;font-size:clamp(20px,2vw,27px);line-height:1.5;font-weight:400;letter-spacing:.005em;color:var(--dsw-alias-label-tertiary,#81858c);text-wrap:balance}
.arbor-page .arbor-hero-num{font-family:var(--arbor-font-numeric);font-weight:600;font-size:1.18em;line-height:.95;letter-spacing:-.01em;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-hero-name{font-weight:400;color:inherit}.arbor-page .arbor-hero-title .arbor-hero-name{color:inherit}
.arbor-page .arbor-hero-hint{display:block;margin-top:10px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hero-links{display:flex;gap:10px;margin-top:6px}.arbor-page .arbor-hero-links .arbor-card-link{margin-left:0;align-self:flex-start}
.arbor-page .arbor-overview{display:flex;flex:1;flex-direction:column;gap:4px;min-height:0}
.arbor-page .arbor-sky{position:relative;width:100%;flex:none;min-height:0}
.arbor-page .arbor-sky-cell{position:absolute;min-width:0;z-index:1;transform-origin:50% 50%;transition:transform 150ms ease}
.arbor-page .arbor-sky-cell>.arbor-card{width:100%}
.arbor-page .arbor-sky-cell[data-paper="true"]{transform:rotate(var(--arbor-tilt,0deg))}
.arbor-page .arbor-sky-cell[data-paper="true"]:hover{transform:rotate(0deg) translateY(-5px) scale(1.01);z-index:4}
.arbor-page .arbor-sky-cell[data-paper="true"]>.arbor-card{transition:box-shadow 150ms ease}
.arbor-page .arbor-sky-cell[data-paper="true"]:hover>.arbor-card{box-shadow:0 18px 36px #0000002b}
.arbor-page .arbor-index-card{background:var(--dsw-alias-bg-layer-1,#fff);border-top:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 55%,transparent);border-radius:7px;box-shadow:0 7px 18px #00000012}
.arbor-page .arbor-note-card{border-radius:8px;box-shadow:0 8px 20px #00000014}
.arbor-page .arbor-card{min-width:0;display:flex;flex-direction:column;gap:7px;padding:15px 17px 12px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:17px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-soft,0 4px 16px #00000008);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.arbor-page .arbor-card-kicker{flex:1;min-width:0;font-size:10px;line-height:14px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-aside{flex:none;display:inline-flex;align-items:center;gap:6px}
.arbor-page .arbor-card-session{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-title{font-size:16px;line-height:1.5;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere}
.arbor-page .arbor-card-project{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-card-meta{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-card-foot{margin-top:auto;display:flex;align-items:baseline;gap:3px 7px;flex-wrap:wrap;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a);font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-card-foot-line{flex-basis:100%;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-page .arbor-card-link{margin-left:auto;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-card-link:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-board-card{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 7%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 16%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-note-card{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 9%,var(--dsw-alias-bg-layer-1,#fff));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 20%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-empty-card{min-height:220px;align-items:center;justify-content:center;text-align:center;gap:8px;border-style:dashed;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 55%,transparent)}
.arbor-page .arbor-empty-mark{width:40px;height:40px;border:1px dashed var(--dsw-alias-border-l3,#0000001f);border-radius:50%;position:relative;margin-bottom:4px}
.arbor-page .arbor-empty-mark:after{content:'';position:absolute;inset:13px;border-radius:50%;background:var(--dsw-alias-brand-primary,#0f1115);opacity:.16}
.arbor-page .arbor-empty-title{font-size:19px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-empty-hint{max-width:44ch;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-state{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:9.5px;line-height:18px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-state-running{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent)}
.arbor-page .arbor-state-idle, .arbor-page .arbor-state-paused{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}
.arbor-page .arbor-state-ended{color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-dot-running{background:var(--dsw-alias-state-success-primary,#22c55e)}
.arbor-page .arbor-dot-idle{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.arbor-page .arbor-dot-paused{background:var(--dsw-alias-state-warn-primary,#f59e0b)}
.arbor-page .arbor-dot-ended{background:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-stream-block{margin-top:2px;padding:10px 11px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:5px;min-width:0}
.arbor-page .arbor-stream-head{display:flex;align-items:center;gap:6px}
.arbor-page .arbor-pulse{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#81858c);flex:none}
.arbor-page .arbor-pulse.is-live{background:var(--dsw-alias-state-success-primary,#22c55e);animation:arbor-pulse 1.1s ease-in-out infinite}
.arbor-page .arbor-stream-label{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-md-wrap{max-height:260px;overflow:hidden;position:relative}
.arbor-page .arbor-md-wrap.is-clamped{mask-image:linear-gradient(180deg,#000 72%,transparent 100%)}
.arbor-page .arbor-window-card .arbor-md-wrap{max-height:140px}
.arbor-page .arbor-md-wrap.is-expanded{max-height:none;overflow:visible}
.arbor-page .arbor-md{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-md-p{margin:0 0 8px}
.arbor-page .arbor-md-p:last-child{margin-bottom:0}
.arbor-page .arbor-md-heading{margin:4px 0 7px;font-size:14px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-md-list{margin:0 0 8px;padding-left:18px}
.arbor-page .arbor-md-list li{margin:1px 0}
.arbor-page .arbor-md-pre{margin:0 0 8px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-markdown-code-block,var(--dsw-alias-bg-layer-2,#f5f5f5));overflow:auto;font-family:var(--arbor-font-code);font-size:11px;line-height:1.55}
.arbor-page .arbor-md-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-markdown-inline-code,var(--dsw-alias-bg-layer-2,#f5f5f5));font-family:var(--arbor-font-code);font-size:11px}
.arbor-page .arbor-md-link{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary,#4176e6));text-decoration:underline;text-underline-offset:2px}
.arbor-page .arbor-stream-toggle{align-self:flex-start;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:10.5px;cursor:pointer}
.arbor-page .arbor-stream-toggle:hover{color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-stream-empty{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-stream-send{margin-top:4px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:3px}
.arbor-page .arbor-chain-scroll{overflow-x:auto;padding:3px 0 7px;scrollbar-width:thin}
.arbor-page .arbor-chain-card{container-type:inline-size}
.arbor-page .arbor-chain{display:flex;align-items:center;min-width:max-content}
.arbor-page .arbor-node{min-width:112px;max-width:166px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:12px;background:var(--dsw-alias-interactive-bg-hover,#2631480f);display:flex;flex-direction:column;gap:1px;min-height:72px}
.arbor-page .arbor-node-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 35%,var(--dsw-alias-border-l1,#0000000a));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 7%,var(--dsw-alias-bg-layer-1,#fff))}
.arbor-page .arbor-node-idle{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 28%,var(--dsw-alias-border-l1,#0000000a))}
.arbor-page .arbor-node-ref{font-family:var(--arbor-font-numeric);font-size:15px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-node-state{font-size:9px;line-height:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-node-running .arbor-node-state{color:var(--dsw-alias-state-success-primary,#22c55e)}
.arbor-page .arbor-node-doing{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-connector{width:52px;flex:none;height:72px;display:flex;align-items:center;justify-content:center;position:relative}
.arbor-page .arbor-connector-line{position:absolute;left:0;right:0;top:50%;height:1px;background:var(--dsw-alias-border-l2,#0000001a)}
.arbor-page .arbor-connector-label{position:relative;z-index:1;padding:0 4px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:8px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap}
.arbor-page .arbor-connector-arrow{position:relative;z-index:1;padding-left:2px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);line-height:1}
.arbor-page .arbor-handoffs{display:flex;flex-direction:column;gap:3px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-handoff-row{display:flex;gap:8px;align-items:baseline;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-handoff-ref{flex:none;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#81858c);letter-spacing:.04em}
.arbor-page .arbor-handoff-text{min-width:0;overflow-wrap:anywhere}
.arbor-page .arbor-note-sum{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
.arbor-page .arbor-tags{display:flex;flex-wrap:wrap;gap:4px}
.arbor-page .arbor-tag{display:inline-flex;align-items:center;height:19px;padding:0 6px;border-radius:6px;font-size:9.5px;line-height:19px;white-space:nowrap;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-tag-ok{color:var(--dsw-alias-state-success-primary,#22c55e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 12%,transparent)}
.arbor-page .arbor-tag-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 12%,transparent)}
.arbor-page .arbor-tag-err{color:var(--dsw-alias-state-error-primary,#ef4444);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 12%,transparent)}
.arbor-page .arbor-tag-plain{opacity:.7}
.arbor-page .arbor-env-counts{display:flex;gap:18px;align-items:baseline;flex-wrap:wrap;padding:1px 0 4px}
.arbor-page .arbor-env-count{display:flex;align-items:baseline;gap:3px;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}
.arbor-page .arbor-env-big{font-family:var(--arbor-font-numeric);font-size:26px;line-height:30px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115);font-variant-numeric:tabular-nums}
.arbor-page .arbor-env-group{padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,#0000000a);display:flex;flex-direction:column;gap:1px}
.arbor-page .arbor-env-group-title{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c);margin-bottom:2px}
.arbor-page .arbor-env-row{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:11.5px;line-height:1.6}
.arbor-page .arbor-env-name{flex:none;max-width:55%;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-env-path{flex:1;min-width:0;overflow-wrap:anywhere;font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-env-functions{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#61666b);font-size:10.5px}
.arbor-page .arbor-env-revision{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-schedule-next{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-workspace-rows{display:flex;flex-direction:column;gap:7px;min-width:0}
.arbor-page .arbor-workspace-row{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-workspace-row>.arbor-label{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-workspace-list{display:flex;flex-direction:column;gap:2px;min-width:0}
.arbor-page .arbor-workspace-item{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0;font-size:11px}
.arbor-page .arbor-muted{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
.arbor-page .arbor-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:11px;line-height:1.5}
.arbor-page .arbor-mono{font-family:var(--arbor-font-code);font-size:10.5px;overflow-wrap:anywhere}
.arbor-page .arbor-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.arbor-page .arbor-label{letter-spacing:.02em}
.arbor-page .arbor-num{font-variant-numeric:tabular-nums}
.arbor-page .arbor-dock{position:sticky;bottom:18px;z-index:8;margin:10px auto 0;width:fit-content;max-width:calc(100% - 24px);padding:5px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #0000000a);isolation:isolate}
.arbor-page .arbor-dock-pills{display:flex;gap:2px;align-items:center;overflow-x:auto;scrollbar-width:none}
.arbor-page .arbor-dock-pills::-webkit-scrollbar{display:none}
.arbor-page .arbor-pill{height:30px;padding:0 13px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
.arbor-page .arbor-pill:hover{background:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-pill.is-active{background:var(--dsw-alias-label-primary,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff)}
.arbor-page .arbor-sheet-layer{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end}
.arbor-page .arbor-sheet-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-2,#0000001f);backdrop-filter:blur(1px)}
.arbor-page .arbor-sheet{position:relative;width:min(560px,100%);height:100%;overflow:auto;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#fff));border-left:1px solid var(--dsw-alias-border-l1,#0000000a);box-shadow:var(--dsw-elevation-prominent,0 3px 8px #0000000a);padding:18px 20px 28px;display:flex;flex-direction:column;gap:14px}
.arbor-page .arbor-sheet-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:10px;padding-bottom:10px;background:inherit;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-sheet-title{flex:1;margin:0;font-size:16px;font-weight:500;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-sheet-body{display:flex;flex-direction:column;gap:12px}
.arbor-page .arbor-settings{display:flex;flex-direction:column;gap:8px;font-size:12px}
.arbor-page .arbor-settings-source{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-settings-group{display:flex;flex-direction:column;gap:6px;padding:9px 11px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-settings-group-title{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-setting-row{display:flex;gap:10px;align-items:baseline;min-width:0;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000a)}
.arbor-page .arbor-setting-row:last-child{border-bottom:none}
.arbor-page .arbor-setting-key{flex:none;width:98px;font-size:9.5px;line-height:1.45;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-setting-value{flex:1;min-width:0;font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary,#0f1115)}
.arbor-page .arbor-settings-wrap{overflow-wrap:anywhere}
.arbor-page .arbor-settings-note{padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 22%,var(--dsw-alias-border-l1,#0000000a));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 7%,var(--dsw-alias-bg-layer-1,#fff));font-size:11.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search{display:flex;flex-direction:column;gap:8px}
.arbor-page .arbor-search-row{display:flex;gap:7px;align-items:center}
.arbor-page .arbor-search-input{flex:1;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:12px;outline:none}
.arbor-page .arbor-search-input:focus{border-color:var(--dsw-alias-brand-primary,#0f1115)}
.arbor-page .arbor-search-go{height:34px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font-size:10px;letter-spacing:.05em;cursor:pointer}
.arbor-page .arbor-search-go:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#2631480f)}
.arbor-page .arbor-search-go:disabled{opacity:.45;cursor:default}
.arbor-page .arbor-search-hint{font-size:10.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-search-empty{padding:18px 0;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search-results{display:flex;flex-direction:column;gap:12px}
.arbor-page .arbor-search-total{font-size:10.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-search-group{display:flex;flex-direction:column;gap:5px}
.arbor-page .arbor-search-group-title{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#0000000a);background:var(--dsw-alias-bg-layer-2,#fff)}
.arbor-page .arbor-hit-head{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}
.arbor-page .arbor-hit-ref{font-size:10px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit-kind{font-size:9.5px;color:var(--dsw-alias-label-secondary,#61666b)}
.arbor-page .arbor-hit-window{font-size:9.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
.arbor-page .arbor-hit-sum{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
@container (max-width:460px){
.arbor-page .arbor-node{min-width:90px;max-width:130px;padding:8px 9px}
.arbor-page .arbor-connector{width:28px}
}
@container (max-width:360px){
.arbor-page .arbor-node{min-width:76px;max-width:120px;padding:7px 8px}
.arbor-page .arbor-connector{width:20px}
.arbor-page .arbor-node-ref{font-size:13px;line-height:17px}
.arbor-page .arbor-node-handoff{font-size:8px;padding:0 4px}
}
@container (max-width:260px){
.arbor-page .arbor-node{min-width:70px;max-width:100px;padding:6px 7px}
.arbor-page .arbor-connector{width:16px}
.arbor-page .arbor-node-handoff{display:none}
}
@keyframes arbor-pulse{0%,100%{opacity:.45;transform:scale(.86)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){
.arbor-page .arbor-sky-cell{transform:none!important;transition:none!important}
.arbor-page .arbor-sky-cell>.arbor-card{transition:none!important}
}
@media (max-width:620px){
.arbor-page{padding:18px 14px 24px}
.arbor-page .arbor-hero-title{font-size:23px}
.arbor-page .arbor-hero-hint{font-size:12px}
.arbor-page .arbor-dock{max-width:100%}
.arbor-page .arbor-pill{padding:0 10px}
}
@media (prefers-reduced-motion:reduce){.arbor-page .arbor-pulse.is-live{animation:none}}`;
function installStyles() {
  if (typeof document === "undefined") return () => {
  };
  const existing = document.getElementById(STYLE_ID);
  if (existing !== null) existing.remove();
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
  return () => {
    style.remove();
  };
}

// packages/arbor-ui/src/ui.ts
var import_react = require("react");
var PANEL_ID = "arbor";
var FILTERS = ["all", "windows", "board", "notes", "env", "schedules"];
function useChannel(channel) {
  (0, import_react.useEffect)(() => {
    channel.retain();
    return () => {
      channel.release();
    };
  }, [channel]);
  return (0, import_react.useSyncExternalStore)(channel.subscribe, channel.getSnapshot);
}
function shownState(window2, stream) {
  return window2.live && stream?.streaming === true ? "running" : window2.state;
}
function shownWindows(windows, streams) {
  return windows.map((window2) => {
    const state = shownState(window2, streams[window2.ref]);
    return state === window2.state ? window2 : { ...window2, state };
  });
}
function stateLabel(t, window2) {
  if (window2.state === "running") return t("statusRunning");
  if (window2.state === "idle") return t("statusIdle");
  if (window2.state === "paused") return t("statusPaused");
  return t("statusEnded");
}
function boardStateLabel(t, state) {
  if (state === "running") return t("statusRunning");
  if (state === "idle") return t("statusIdle");
  if (state === "paused") return t("statusPaused");
  if (state === "ended") return t("statusEnded");
  return state;
}
function endLabel(t, reason) {
  if (reason === void 0) return void 0;
  if (reason === "model_ended") return t("endModel");
  if (reason === "idle_timeout") return t("endIdle");
  if (reason === "hard_limit") return t("endHardLimit");
  if (reason === "host_restart") return t("endRestart");
  if (reason === "failed") return t("endFailed");
  if (reason === "paused") return t("endPaused");
  return reason;
}
function compact(value) {
  if (value === void 0) return "\u2014";
  if (value < 1e3) return String(value);
  if (value < 1e6) return `${(value / 1e3).toFixed(value < 1e4 ? 1 : 0)}k`;
  return `${(value / 1e6).toFixed(1)}M`;
}
function duration(t, ms) {
  if (ms === void 0 || !Number.isFinite(ms) || ms < 0) return void 0;
  if (ms < 6e4) return t("seconds", { value: Math.round(ms / 1e3) });
  if (ms < 36e5) return t("minutes", { value: Math.round(ms / 6e4) });
  return t("hours", { value: Math.round(ms / 36e5) });
}
function clock(value, t) {
  if (value === void 0) return "\u2014";
  return new Date(value).toLocaleString(t("dateLocale"), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
function dateLine(t, at) {
  const date = new Intl.DateTimeFormat(t("dateLocale"), {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date(at)).replace(/(星期[一二三四五六日天])/, " $1");
  return date;
}
function chainSummary(t, windows) {
  const last = windows.at(-1);
  return t(windows.length === 1 ? "chainSummaryOne" : "chainSummary", {
    count: windows.length,
    window: last?.ref ?? "\u2014",
    state: last === void 0 ? t("statusIdle") : stateLabel(t, last)
  });
}
function sessionTitle(session) {
  if (session.title !== void 0 && session.title !== "") return session.title;
  return session.project?.name ?? (session.sessionId.length > 22 ? `${session.sessionId.slice(0, 22)}\u2026` : session.sessionId);
}
function projectLabel(session) {
  return session.project === void 0 ? session.cwd ?? "" : `${session.project.name} \xB7 ${session.project.path}`;
}
function liveWindowOf(windows) {
  return [...windows].reverse().find((window2) => window2.live);
}
function hero(template, values) {
  return template.split(/(\{\w+\})/g).map((piece, index) => {
    const match = /^\{(\w+)\}$/.exec(piece);
    if (match === null) return piece;
    const value = values[match[1]];
    if (value === void 0) return piece;
    const text = typeof value === "string" ? value : value.text;
    const num = typeof value === "string" ? true : value.num !== false;
    return (0, import_react.createElement)("span", {
      key: `hero-${index}`,
      className: num ? "arbor-hero-num" : "arbor-hero-name",
      "data-arbor-text": num ? "numeric" : "display"
    }, text);
  });
}
var CJK = /[\u2018\u2019\u201c\u201d\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\uac00-\ud7af]/;
function softJoin(lines) {
  let joined = "";
  for (const line of lines) {
    const next = line.trim();
    if (next === "") continue;
    if (joined === "") {
      joined = next;
      continue;
    }
    const left = joined.at(-1) ?? "";
    const right = next[0] ?? "";
    joined += (CJK.test(left) && CJK.test(right) ? "" : " ") + next;
  }
  return joined;
}
function inlineMarkdown(text, key) {
  return text.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\n)/g).map((piece, index) => {
    const id = `${key}-${index}`;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
    if (link !== null) {
      const label = link[1];
      const href = link[2];
      if (/^(https?:|mailto:|#)/.test(href)) {
        return (0, import_react.createElement)("a", { key: id, className: "arbor-md-link", href, target: "_blank", rel: "noreferrer", "data-arbor-text": "body" }, label);
      }
      return (0, import_react.createElement)("span", { key: id, className: "arbor-md-link", title: href, "data-arbor-text": "body" }, label);
    }
    if (piece.startsWith("**") && piece.endsWith("**")) {
      return (0, import_react.createElement)("strong", { key: id, "data-arbor-text": "body" }, piece.slice(2, -2));
    }
    if (piece.startsWith("`") && piece.endsWith("`")) {
      return (0, import_react.createElement)("code", { key: id, className: "arbor-md-code", "data-arbor-text": "code" }, piece.slice(1, -1));
    }
    if (piece === "\n") return " ";
    return piece;
  });
}
function MarkdownText(props) {
  const lines = props.text.split(/\r?\n/);
  const blocks = [];
  let index = 0;
  let block = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push((0, import_react.createElement)(
        "pre",
        { className: "arbor-md-pre", "data-arbor-text": "code", key: `b${block++}` },
        (0, import_react.createElement)("code", { "data-arbor-text": "code" }, code.join("\n"))
      ));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = lines[index].replace(/^\s*[-*]\s+/, "");
        items.push((0, import_react.createElement)("li", { key: `li-${index}`, "data-arbor-text": "body" }, ...inlineMarkdown(item, `li${index}`)));
        index += 1;
      }
      blocks.push((0, import_react.createElement)("ul", { className: "arbor-md-list", key: `b${block++}` }, ...items));
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push((0, import_react.createElement)(
        "div",
        { className: "arbor-md-heading", "data-arbor-text": "display", key: `b${block++}` },
        ...inlineMarkdown(heading[2], `h${index}`)
      ));
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length) {
      const next = lines[index];
      if (next.trim() === "" || /^\s*[-*]\s+/.test(next) || /^#{1,4}\s+/.test(next) || next.trimStart().startsWith("```")) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push((0, import_react.createElement)(
      "p",
      { className: "arbor-md-p", "data-arbor-text": "body", key: `b${block++}` },
      ...inlineMarkdown(softJoin(paragraph), `p${block}`)
    ));
  }
  return (0, import_react.createElement)("div", { className: "arbor-md" }, ...blocks);
}
var SKY_GUTTER = 20;
var SKY_NARROW = 640;
function hashOf(value) {
  let hash = 2166136261;
  for (let at = 0; at < value.length; at += 1) {
    hash ^= value.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function paperOf(item) {
  if (item.kind !== "note" && item.kind !== "board") return void 0;
  const hash = hashOf(item.key);
  return {
    tilt: Math.round((-1.6 + hash % 3201 / 1e3) * 100) / 100,
    offset: (hash >>> 12) % 13
  };
}
function cardScale(surface) {
  return Math.max(0.55, Math.min(1.2, surface / 1100));
}
function cardWidth(item, surface) {
  if (item.kind === "empty" || item.kind === "loading") return surface;
  if (surface < SKY_NARROW) return surface;
  const scale = cardScale(surface);
  const base = (() => {
    switch (item.kind) {
      case "window":
        return 560;
      case "chain":
        return (item.nodes ?? 1) * 150 + 50;
      case "session":
      case "workspace":
        return 360;
      case "env":
        return 320;
      case "board":
        return 280;
      case "note": {
        const length = item.text?.length ?? 0;
        return 240 + Math.min(40, length);
      }
      case "schedule":
        return 230;
      default:
        return 240;
    }
  })();
  return Math.min(surface, Math.max(140, Math.round(base * scale)));
}
function clearOf(box, placed) {
  return placed.every((other) => box.x >= other.x + other.width + SKY_GUTTER || box.x + box.width + SKY_GUTTER <= other.x || box.y >= other.y + other.height + SKY_GUTTER || box.y + box.height + SKY_GUTTER <= other.y);
}
function measureCards(surface, items) {
  const cells = /* @__PURE__ */ new Map();
  for (const element of Array.from(surface.querySelectorAll("[data-sky-key]"))) {
    const key = element.dataset["skyKey"];
    if (key !== void 0) cells.set(key, element);
  }
  return items.map((item) => {
    const cell = cells.get(item.key);
    if (cell === void 0) return 0;
    const card = cell.querySelector(".arbor-card") ?? cell;
    return card.offsetHeight;
  });
}
function largestHoleArea(placements, surface) {
  const boxes = placements.map((one) => ({ x: one.x, y: one.y, width: one.width, height: one.height }));
  if (boxes.length === 0) return 0;
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const xs = [.../* @__PURE__ */ new Set([0, surface, ...boxes.flatMap((box) => [box.x, box.x + box.width])])].filter((value) => value >= 0 && value <= surface).sort((left, right) => left - right);
  const ys = [.../* @__PURE__ */ new Set([top, bottom, ...boxes.flatMap((box) => [box.y, box.y + box.height])])].sort((left, right) => left - right);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return 0;
  const heights = Array(nx).fill(0);
  let largest = 0;
  for (let yi = 0; yi < ny; yi += 1) {
    for (let xi = 0; xi < nx; xi += 1) {
      const x = (xs[xi] + xs[xi + 1]) / 2;
      const y = (ys[yi] + ys[yi + 1]) / 2;
      const inside = boxes.some((box) => x > box.x + 0.25 && x < box.x + box.width - 0.25 && y > box.y + 0.25 && y < box.y + box.height - 0.25);
      heights[xi] = inside ? 0 : heights[xi] + (ys[yi + 1] - ys[yi]);
    }
    const stack = [];
    for (let xi = 0; xi <= nx; xi += 1) {
      const height = xi < nx ? heights[xi] : 0;
      let start = xi;
      while (stack.length > 0 && stack[stack.length - 1].height >= height) {
        const topBar = stack.pop();
        const width = xs[xi] - xs[topBar.start];
        largest = Math.max(largest, width * topBar.height);
        start = topBar.start;
      }
      if (stack.length === 0 || stack[stack.length - 1].height < height) stack.push({ height, start });
    }
  }
  return largest;
}
function packSkySearch(items, widths, heights, surface) {
  let states = [{ placements: [], boxes: [], lefts: 0, hole: 0 }];
  const beam = 1e4;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const width = widths[index];
    const height = heights[index];
    const paper = paperOf(item);
    const offset = paper?.offset ?? 0;
    const reserved = height + offset;
    const next = [];
    for (const state of states) {
      const ys = [0, ...state.boxes.map((box) => box.y + box.height + SKY_GUTTER)].sort((left, right) => left - right);
      let placedAtSomeY = false;
      for (const at of ys) {
        const xs = /* @__PURE__ */ new Set([0, surface - width]);
        for (const box of state.boxes) {
          xs.add(box.x);
          xs.add(box.x + box.width + SKY_GUTTER);
          xs.add(box.x - width - SKY_GUTTER);
          xs.add(box.x + box.width - width);
        }
        const fitting = [...xs].filter((left) => left >= 0 && left + width <= surface).filter((left) => clearOf({ x: left, y: at, width, height: reserved }, state.boxes)).filter((value, atIndex, all) => all.indexOf(value) === atIndex).sort((left, right) => left - right);
        if (fitting.length === 0) continue;
        placedAtSomeY = true;
        const leftmost = fitting[0];
        for (const x of fitting) {
          const placements2 = [...state.placements, {
            key: item.key,
            x,
            y: at + offset,
            width,
            height,
            tilt: paper?.tilt ?? 0,
            offset
          }];
          const boxes = [...state.boxes, { x, y: at, width, height: reserved }];
          next.push({
            placements: placements2,
            boxes,
            lefts: state.lefts + (x === leftmost ? 1 : 0),
            hole: largestHoleArea(placements2, surface)
          });
        }
        break;
      }
      if (placedAtSomeY) continue;
      const y = state.boxes.length === 0 ? 0 : Math.max(...state.boxes.map((box) => box.y + box.height + SKY_GUTTER));
      const placements = [...state.placements, { key: item.key, x: 0, y: y + offset, width, height, tilt: paper?.tilt ?? 0, offset }];
      next.push({
        placements,
        boxes: [...state.boxes, { x: 0, y, width, height: reserved }],
        lefts: state.lefts + 1,
        hole: largestHoleArea(placements, surface)
      });
    }
    const filtered = index === 0 ? next.filter((state) => state.placements[0]?.x === 0) : next;
    states = (filtered.length === 0 ? next : filtered).sort((left, right) => left.hole - right.hole || right.lefts - left.lefts).slice(0, beam);
  }
  states.sort((left, right) => left.hole - right.hole || right.lefts - left.lefts);
  return states[0] === void 0 ? [] : [...states[0].placements];
}
function samePlacements(left, right) {
  if (left.length !== right.length) return false;
  return left.every((one, at) => {
    const other = right[at];
    return other !== void 0 && one.key === other.key && Math.abs(one.x - other.x) < 0.5 && Math.abs(one.y - other.y) < 0.5 && Math.abs(one.width - other.width) < 0.5 && Math.abs(one.height - other.height) < 0.5;
  });
}
function Skyline(props) {
  const ref = (0, import_react.useRef)(null);
  const [width, setWidth] = (0, import_react.useState)(0);
  const [layout, setLayout] = (0, import_react.useState)(void 0);
  const signature = props.items.map((item) => `${item.key}:${item.kind}:${item.nodes ?? ""}:${item.text?.length ?? 0}`).join("|");
  const key = `${width}:${signature}`;
  const active = layout !== void 0 && layout.key === key;
  const widths = props.items.map((item) => cardWidth(item, width === 0 ? 1100 : width));
  (0, import_react.useLayoutEffect)(() => {
    const surface = ref.current;
    if (surface === null) return;
    const measure = () => {
      setWidth(surface.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => {
      observer.disconnect();
    };
  }, []);
  (0, import_react.useLayoutEffect)(() => {
    const surface = ref.current;
    if (surface === null || width === 0) return;
    const heights = measureCards(surface, props.items);
    if (heights.every((height) => height === 0)) return;
    const placements = packSkySearch(props.items, widths, heights, width);
    const bottom = placements.length === 0 ? 0 : Math.max(...placements.map((one) => one.y + one.height));
    const next = { key, placements, height: bottom + SKY_GUTTER };
    setLayout((current) => current !== void 0 && current.key === key && samePlacements(current.placements, placements) ? current : next);
  });
  return (0, import_react.createElement)("div", {
    className: "arbor-sky",
    ref,
    style: { height: active ? layout.height : 0 }
  }, ...props.items.map((item, index) => {
    const placement = active ? layout.placements.find((one) => one.key === item.key) : void 0;
    const paper = paperOf(item);
    const style = placement === void 0 ? { left: 0, top: 0, width: widths[index], visibility: "hidden" } : {
      left: placement.x,
      top: placement.y,
      width: placement.width,
      "--arbor-tilt": `${String(placement.tilt)}deg`
    };
    return (0, import_react.createElement)("div", {
      className: `arbor-sky-cell${paper === void 0 ? "" : " is-paper"}${item.kind === "board" ? " is-board" : ""}`,
      key: item.key,
      style,
      "data-sky-key": item.key,
      "data-paper": paper === void 0 ? void 0 : "true"
    }, item.node);
  }));
}
function IconButton(props) {
  return (0, import_react.createElement)("button", {
    type: "button",
    className: "arbor-icon-button",
    title: props.label,
    "aria-label": props.label,
    onClick: props.onClick
  }, props.children);
}
function SearchIcon() {
  return (0, import_react.createElement)(
    "svg",
    {
      viewBox: "0 0 20 20",
      width: 18,
      height: 18,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      "aria-hidden": true
    },
    (0, import_react.createElement)("circle", { cx: 8.6, cy: 8.6, r: 5.4 }),
    (0, import_react.createElement)("path", { d: "m12.7 12.7 3.6 3.6" })
  );
}
function GearIcon() {
  return (0, import_react.createElement)(
    "svg",
    {
      viewBox: "0 0 20 20",
      width: 18,
      height: 18,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.5,
      strokeLinecap: "round",
      "aria-hidden": true
    },
    (0, import_react.createElement)("path", { d: "M3 5.5h14M3 10h14M3 14.5h14" }),
    (0, import_react.createElement)("circle", { cx: 7.5, cy: 5.5, r: 1.8, fill: "var(--dsw-alias-bg-layer-1,#fff)" }),
    (0, import_react.createElement)("circle", { cx: 12.5, cy: 10, r: 1.8, fill: "var(--dsw-alias-bg-layer-1,#fff)" }),
    (0, import_react.createElement)("circle", { cx: 6.5, cy: 14.5, r: 1.8, fill: "var(--dsw-alias-bg-layer-1,#fff)" })
  );
}
function CloseIcon() {
  return (0, import_react.createElement)(
    "svg",
    {
      viewBox: "0 0 20 20",
      width: 16,
      height: 16,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
      "aria-hidden": true
    },
    (0, import_react.createElement)("path", { d: "m5 5 10 10M15 5 5 15" })
  );
}
function TopActions(props) {
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-top-actions" },
    (0, import_react.createElement)(IconButton, { label: props.t("openSearch"), onClick: props.onSearch, children: (0, import_react.createElement)(SearchIcon) }),
    (0, import_react.createElement)(IconButton, { label: props.t("openSettings"), onClick: props.onSettings, children: (0, import_react.createElement)(GearIcon) })
  );
}
function Card(props) {
  return (0, import_react.createElement)("section", {
    className: `arbor-card${props.className === void 0 ? "" : ` ${props.className}`}`,
    ...props.attrs ?? {}
  }, props.children);
}
function CardHead(props) {
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-card-head" },
    (0, import_react.createElement)("span", { className: "arbor-card-kicker arbor-label", "data-arbor-text": "display" }, props.kicker),
    props.aside === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-card-aside" }, props.aside)
  );
}
function CardFoot(props) {
  return (0, import_react.createElement)("footer", { className: "arbor-card-foot arbor-label", "data-arbor-text": "body" }, props.children);
}
function StateChip(props) {
  return (0, import_react.createElement)("span", {
    className: `arbor-state arbor-state-${props.state} arbor-label`,
    "data-arbor-text": "display"
  }, props.t(props.state === "running" ? "statusRunning" : props.state === "idle" ? "statusIdle" : props.state === "paused" ? "statusPaused" : "statusEnded"));
}
function EmptyCard(props) {
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-empty-card" },
    (0, import_react.createElement)("div", { className: "arbor-empty-mark", "aria-hidden": true }),
    (0, import_react.createElement)("div", { className: "arbor-empty-title", "data-arbor-text": "display" }, props.title),
    (0, import_react.createElement)("div", { className: "arbor-empty-hint", "data-arbor-text": "body" }, props.hint)
  );
}
function Stream(props) {
  const text = props.stream?.text ?? "";
  const send = props.stream?.send ?? "";
  const [expanded, setExpanded] = (0, import_react.useState)(false);
  const long = text.length > 160 || send.length > 160;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stream-block", "data-arbor-stream": true },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-stream-head" },
      (0, import_react.createElement)("span", { className: `arbor-pulse${props.stream?.streaming === true ? " is-live" : ""}` }),
      (0, import_react.createElement)("span", { className: "arbor-stream-label arbor-label", "data-arbor-text": "display" }, props.t("streamText"))
    ),
    text === "" ? (0, import_react.createElement)("div", { className: "arbor-stream-empty", "data-arbor-text": "body" }, props.t("streamEmpty")) : (0, import_react.createElement)(
      "div",
      { className: `arbor-md-wrap${long && !expanded ? " is-clamped" : ""}${expanded ? " is-expanded" : ""}`, "data-arbor-text": "body" },
      (0, import_react.createElement)(MarkdownText, { text })
    ),
    send === "" ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-stream-send" },
      (0, import_react.createElement)("div", { className: "arbor-stream-label arbor-label" }, props.t("streamSend")),
      (0, import_react.createElement)(
        "div",
        { className: `arbor-md-wrap${long && !expanded ? " is-clamped" : ""}${expanded ? " is-expanded" : ""}`, "data-arbor-text": "body" },
        (0, import_react.createElement)(MarkdownText, { text: send })
      )
    ),
    long ? (0, import_react.createElement)("button", {
      type: "button",
      className: "arbor-stream-toggle arbor-label",
      "data-arbor-text": "display",
      onClick: () => {
        setExpanded((value) => !value);
      }
    }, props.t(expanded ? "collapseStream" : "expandStream")) : null
  );
}
function LiveWindowCard(props) {
  const { window: window2, session, stream, t } = props;
  const state = shownState(window2, stream);
  return (0, import_react.createElement)(
    Card,
    { className: `arbor-window-card arbor-window-${state}`, attrs: { "data-arbor-window": window2.ref } },
    (0, import_react.createElement)(CardHead, {
      kicker: `${t("filterWindows")} \xB7 ${window2.ref}`,
      aside: (0, import_react.createElement)(StateChip, { state, t })
    }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, window2.doing ?? (session === void 0 ? t("live") : sessionTitle(session))),
    window2.live ? (0, import_react.createElement)(Stream, { stream, t }) : null,
    (0, import_react.createElement)(
      CardFoot,
      null,
      session === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-card-session" }, sessionTitle(session)),
      (0, import_react.createElement)("span", { className: "arbor-num" }, window2.used === void 0 ? "\u2014" : `${compact(window2.used)} / ${compact(window2.limit)}`),
      window2.startedAt === void 0 ? null : (0, import_react.createElement)("span", null, " \xB7 ", clock(window2.startedAt, t))
    )
  );
}
function WindowCard(props) {
  const { window: window2, session, stream, t } = props;
  const state = shownState(window2, stream);
  return (0, import_react.createElement)(
    Card,
    { className: `arbor-window-card arbor-window-${state}`, attrs: { "data-arbor-window": window2.ref } },
    (0, import_react.createElement)(CardHead, {
      kicker: `${t("filterWindows")} \xB7 ${window2.ref}`,
      aside: (0, import_react.createElement)(StateChip, { state, t })
    }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, window2.doing ?? (session === void 0 ? t("live") : sessionTitle(session))),
    window2.live ? (0, import_react.createElement)(Stream, { stream, t }) : null,
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", { className: "arbor-num" }, window2.used === void 0 ? "\u2014" : `${compact(window2.used)} / ${compact(window2.limit)}`),
      window2.endReason === void 0 ? null : (0, import_react.createElement)("span", null, " \xB7 ", endLabel(t, window2.endReason)),
      window2.startedAt === void 0 ? null : (0, import_react.createElement)("span", null, " \xB7 ", clock(window2.startedAt, t))
    )
  );
}
function ChainCard(props) {
  const { session, windows, t } = props;
  if (windows.length === 0) return null;
  const shown = shownWindows(windows, props.streams);
  const handoffs = windows.filter((window2) => window2.handoff !== void 0 && (window2.handoff.topics !== void 0 || window2.handoff.progress !== void 0 || window2.handoff.pending !== void 0 || window2.handoff.agreements !== void 0));
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-chain-card" },
    (0, import_react.createElement)(CardHead, {
      kicker: t("cardChain"),
      aside: session === void 0 ? void 0 : (0, import_react.createElement)("span", { className: "arbor-card-session arbor-label" }, sessionTitle(session))
    }),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-chain-scroll" },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-chain" },
        shown.flatMap((window2, index) => {
          const next = shown[index + 1];
          const link = next?.continuationOf === window2.ref && window2.endReason === "host_restart" ? t("chainRestart") : void 0;
          const node = (0, import_react.createElement)(
            "div",
            {
              className: `arbor-node arbor-node-${window2.state}`,
              key: `node-${window2.ref}`,
              "data-arbor-window": window2.ref
            },
            (0, import_react.createElement)("span", { className: "arbor-node-ref arbor-num" }, window2.ref),
            (0, import_react.createElement)("span", { className: "arbor-node-state arbor-label" }, stateLabel(t, window2)),
            window2.handoff === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-node-handoff arbor-tag arbor-tag-warn" }, t("handoff"))
          );
          if (next === void 0) return [node];
          return [node, (0, import_react.createElement)(
            "div",
            { className: "arbor-connector", key: `edge-${window2.ref}` },
            (0, import_react.createElement)("span", { className: "arbor-connector-line", "aria-hidden": true }),
            link === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-connector-label arbor-label" }, link),
            (0, import_react.createElement)("span", { className: "arbor-connector-arrow", "aria-hidden": true }, "\u2192")
          )];
        })
      )
    ),
    handoffs.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-handoffs" },
      handoffs.map((window2) => (0, import_react.createElement)(
        "div",
        { className: "arbor-handoff-row", key: `h-${window2.ref}` },
        (0, import_react.createElement)("span", { className: "arbor-handoff-ref arbor-num" }, `${window2.ref} ${t("handoff")}`),
        (0, import_react.createElement)(
          "span",
          { className: "arbor-handoff-text", "data-arbor-text": "body" },
          [...window2.handoff?.topics ?? [], ...window2.handoff?.progress ?? [], ...window2.handoff?.pending ?? []].join(" \xB7 ")
        )
      ))
    ),
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", { className: "arbor-num" }, chainSummary(t, shown))
    )
  );
}
function SessionCard(props) {
  const { session, t, onOpen } = props;
  const shown = shownWindows(session.windows, props.streams);
  const last = liveWindowOf(shown) ?? shown.at(-1);
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-session-card", attrs: { "data-arbor-session": session.sessionId } },
    (0, import_react.createElement)(CardHead, {
      kicker: t("cardSession"),
      aside: (0, import_react.createElement)("span", { className: `arbor-dot arbor-dot-${last?.state ?? "ended"}` })
    }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, sessionTitle(session)),
    (0, import_react.createElement)("div", { className: "arbor-card-project", "data-arbor-text": "code" }, projectLabel(session)),
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", { className: "arbor-num" }, chainSummary(t, shown)),
      (0, import_react.createElement)("button", {
        type: "button",
        className: "arbor-card-link arbor-label",
        onClick: () => {
          onOpen(session.sessionId);
        }
      }, t("openSessionTab"), " \u2192")
    )
  );
}
function BoardCard(props) {
  const { line, streaming, t } = props;
  const state = streaming ? "running" : line.state;
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-board-card arbor-index-card" },
    (0, import_react.createElement)(CardHead, { kicker: t("filterBoard"), aside: (0, import_react.createElement)("span", { className: "arbor-card-session arbor-label" }, boardStateLabel(t, state)) }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "body" }, line.doing),
    line.openWork === void 0 || line.openWork.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-tags" },
      line.openWork.map((item) => (0, import_react.createElement)("span", { className: "arbor-tag arbor-tag-warn", key: item }, item))
    ),
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", { className: "arbor-num" }, line.window),
      (0, import_react.createElement)("span", null, " \xB7 ", boardStateLabel(t, state)),
      (0, import_react.createElement)("span", { className: "arbor-num" }, ` \xB7 ${compact(line.usage.used)} / ${compact(line.usage.limit)}`)
    )
  );
}
function NoteCard(props) {
  const { note, t } = props;
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-note-card" },
    (0, import_react.createElement)(CardHead, { kicker: t("filterNotes"), aside: (0, import_react.createElement)("span", { className: "arbor-card-session arbor-num" }, note.ref) }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, note.title),
    note.summary === "" ? null : (0, import_react.createElement)("div", { className: "arbor-note-sum", "data-arbor-text": "body" }, note.summary),
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", null, t("notesActive")),
      (0, import_react.createElement)("span", { className: "arbor-num" }, ` \xB7 ${clock(note.time, t)}`)
    )
  );
}
function EnvCard(props) {
  const { env, t } = props;
  const skills = env.items.filter((item) => item.kind === "skill");
  const servers = env.items.filter((item) => item.kind === "mcp");
  const services = env.items.filter((item) => item.kind === "service");
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-env-card" },
    (0, import_react.createElement)(CardHead, { kicker: t("cardEnvironment") }),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-env-counts" },
      (0, import_react.createElement)("span", { className: "arbor-env-count" }, (0, import_react.createElement)("span", { className: "arbor-env-big arbor-num" }, String(skills.length)), (0, import_react.createElement)("span", { className: "arbor-label" }, ` ${t(skills.length === 1 ? "envSkillOne" : "envSkills")}`)),
      (0, import_react.createElement)("span", { className: "arbor-env-count" }, (0, import_react.createElement)("span", { className: "arbor-env-big arbor-num" }, String(servers.length)), (0, import_react.createElement)("span", { className: "arbor-label" }, ` ${t(servers.length === 1 ? "envMcpOne" : "envMcp")}`)),
      (0, import_react.createElement)("span", { className: "arbor-env-count" }, (0, import_react.createElement)("span", { className: "arbor-env-big arbor-num" }, String(services.length)), (0, import_react.createElement)("span", { className: "arbor-label" }, ` ${t(services.length === 1 ? "envServiceOne" : "envServices")}`))
    ),
    skills.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-env-group" },
      (0, import_react.createElement)("div", { className: "arbor-env-group-title arbor-label" }, t("envSkills")),
      skills.map((item) => (0, import_react.createElement)(
        "div",
        { className: "arbor-env-row", key: `sk:${item.name}` },
        (0, import_react.createElement)("span", { className: "arbor-env-name", "data-arbor-text": "display" }, item.name),
        item.builtin === true ? (0, import_react.createElement)("span", { className: "arbor-tag arbor-tag-ok" }, t("envBuiltin")) : null
      ))
    ),
    servers.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-env-group" },
      (0, import_react.createElement)("div", { className: "arbor-env-group-title arbor-label" }, t("envMcp")),
      servers.map((item) => (0, import_react.createElement)(
        "div",
        { className: "arbor-env-row", key: `mcp:${item.name}` },
        (0, import_react.createElement)("span", { className: "arbor-env-name", "data-arbor-text": "display" }, item.name),
        (0, import_react.createElement)("span", { className: "arbor-env-functions" }, item.functions === void 0 || item.functions.length === 0 ? "\u2014" : item.functions.join(" \xB7 "))
      ))
    ),
    services.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-env-group" },
      (0, import_react.createElement)("div", { className: "arbor-env-group-title arbor-label" }, t("envServices")),
      services.map((item) => (0, import_react.createElement)(
        "div",
        { className: "arbor-env-row", key: `svc:${item.name}` },
        (0, import_react.createElement)("span", { className: "arbor-env-name", "data-arbor-text": "display" }, item.name),
        (0, import_react.createElement)("span", { className: `arbor-tag arbor-tag-${item.state === "running" ? "ok" : item.state === "failed" ? "err" : "warn"}` }, item.state ?? "\u2014")
      ))
    )
  );
}
function ScheduleCard(props) {
  const { schedule, t } = props;
  const repeat = schedule.everyMs !== void 0 ? t("scheduleEvery", { value: duration(t, schedule.everyMs) ?? String(schedule.everyMs) }) : schedule.dailyAt !== void 0 ? t("scheduleDaily", { value: schedule.dailyAt }) : schedule.weekdays !== void 0 ? t("scheduleWeekly", { value: schedule.weekdays.join(" ") }) : "";
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-schedule-card" },
    (0, import_react.createElement)(CardHead, {
      kicker: t("cardSchedules"),
      aside: schedule.paused ? (0, import_react.createElement)("span", { className: "arbor-tag arbor-tag-warn" }, t("schedulePaused")) : void 0
    }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, schedule.name ?? schedule.ref),
    (0, import_react.createElement)("div", { className: "arbor-schedule-next arbor-num", "data-arbor-text": "numeric" }, t("scheduleNext", { time: clock(schedule.nextAt, t) })),
    (0, import_react.createElement)(
      CardFoot,
      null,
      (0, import_react.createElement)("span", { className: "arbor-num" }, schedule.ref),
      repeat === "" ? null : (0, import_react.createElement)("span", null, ` \xB7 ${repeat}`),
      schedule.fired === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-num" }, ` \xB7 ${t("scheduleFired", { count: schedule.fired })}`)
    )
  );
}
function WorkspaceCard(props) {
  const { workspace, t } = props;
  const projectPath = workspace.project?.path;
  const showCwd = workspace.project !== void 0 && workspace.cwd !== void 0 && workspace.cwd !== projectPath;
  const hasFooter = workspace.pointers.length > 0 || workspace.checkouts.length > 0 || workspace.keeps.length > 0 || workspace.openWork.length > 0;
  return (0, import_react.createElement)(
    Card,
    { className: "arbor-workspace-card" },
    (0, import_react.createElement)(CardHead, { kicker: t("cardWorkspace") }),
    (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, workspace.project?.name ?? workspace.cwd ?? t("none")),
    projectPath === void 0 ? null : (0, import_react.createElement)("div", { className: "arbor-card-project arbor-mono", "data-arbor-text": "code" }, projectPath),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-workspace-rows" },
      showCwd ? (0, import_react.createElement)(
        "div",
        { className: "arbor-workspace-row" },
        (0, import_react.createElement)("span", { className: "arbor-label" }, t("workspaceCwd")),
        (0, import_react.createElement)("span", { className: "arbor-mono" }, workspace.cwd)
      ) : null,
      workspace.pointers.length === 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-workspace-row" },
        (0, import_react.createElement)("span", { className: "arbor-label" }, t("workspacePointers")),
        (0, import_react.createElement)("span", { className: "arbor-workspace-list" }, workspace.pointers.map((pointer) => (0, import_react.createElement)(
          "span",
          { key: pointer.path, className: "arbor-workspace-item" },
          (0, import_react.createElement)("span", null, pointer.name),
          (0, import_react.createElement)("span", { className: "arbor-mono" }, pointer.path)
        )))
      ),
      workspace.checkouts.length === 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-workspace-row" },
        (0, import_react.createElement)("span", { className: "arbor-label" }, t("workspaceCheckouts")),
        (0, import_react.createElement)("span", { className: "arbor-workspace-list" }, workspace.checkouts.map((checkout) => (0, import_react.createElement)(
          "span",
          { className: "arbor-workspace-item", key: checkout.path },
          (0, import_react.createElement)("span", { className: "arbor-mono" }, checkout.name),
          (0, import_react.createElement)("span", { className: `arbor-tag arbor-tag-${checkout.dirty ? "warn" : "ok"}` }, checkout.dirty ? t("workspaceDirty") : t("workspaceClean"))
        )))
      ),
      workspace.keeps.length === 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-workspace-row" },
        (0, import_react.createElement)("span", { className: "arbor-label" }, t("workspaceKeeps")),
        (0, import_react.createElement)("span", { className: "arbor-workspace-list" }, workspace.keeps.map((keep) => (0, import_react.createElement)(
          "span",
          { className: "arbor-workspace-item", key: keep.path },
          (0, import_react.createElement)("span", null, keep.name),
          (0, import_react.createElement)("span", { className: "arbor-mono" }, keep.path)
        )))
      ),
      workspace.openWork.length === 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-workspace-row" },
        (0, import_react.createElement)("span", { className: "arbor-label" }, t("workspaceOpenWork")),
        (0, import_react.createElement)("span", { className: "arbor-workspace-list" }, workspace.openWork.map((item) => (0, import_react.createElement)(
          "span",
          { className: "arbor-workspace-item", key: `${item.window}:${item.name}` },
          (0, import_react.createElement)("span", { className: "arbor-num" }, item.window),
          (0, import_react.createElement)("span", null, item.name)
        )))
      )
    ),
    hasFooter ? (0, import_react.createElement)(
      CardFoot,
      null,
      workspace.pointers.length === 0 ? null : (0, import_react.createElement)("span", { className: "arbor-num" }, `${workspace.pointers.length} ${t("workspacePointers")}`),
      workspace.checkouts.length === 0 ? null : (0, import_react.createElement)("span", { className: "arbor-num" }, `${workspace.checkouts.length} ${t("workspaceCheckouts")}`)
    ) : null
  );
}
function SettingRow(props) {
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-setting-row" },
    (0, import_react.createElement)("span", { className: "arbor-setting-key arbor-label" }, props.label),
    (0, import_react.createElement)("span", { className: "arbor-setting-value" }, props.children)
  );
}
function SettingsBlock(props) {
  const { settings, dataRoot, backend, shared, t } = props;
  const tiers = Object.entries(settings.modelTiers ?? {});
  const judge = Object.entries(settings.judge?.modes ?? {});
  const judgeLabel = (mode) => mode === "off" ? t("settingsJudgeOff") : mode === "shadow" ? t("settingsJudgeShadow") : t("settingsJudgeOn");
  const window2 = settings.window ?? {};
  const notes = settings.notes ?? {};
  const windowLine = [
    window2.idleSeconds === void 0 ? "" : `${t("settingsIdle")} ${t("seconds", { value: window2.idleSeconds })}`,
    window2.contextTokens === void 0 ? "" : `${t("settingsContext")} ${compact(window2.contextTokens)}`,
    window2.reserveTokens === void 0 ? "" : `${t("settingsReserve")} ${compact(window2.reserveTokens)}`,
    window2.protectionSeconds === void 0 ? "" : `${t("settingsProtection")} ${t("seconds", { value: window2.protectionSeconds })}`
  ].filter(Boolean).join(" \xB7 ");
  const notesLine = [
    notes.activeCount === void 0 ? "" : `${t("settingsNotesCount")} ${notes.activeCount}`,
    notes.activeTokenBudget === void 0 ? "" : `${t("settingsNotesTokens")} ${compact(notes.activeTokenBudget)}`
  ].filter(Boolean).join(" \xB7 ");
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-settings" },
    (0, import_react.createElement)("div", { className: "arbor-settings-source arbor-muted" }, t(settings.source === "environment" ? "settingsSourceEnvironment" : "settingsSourceDeployment")),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-settings-group" },
      (0, import_react.createElement)("div", { className: "arbor-settings-group-title arbor-label", "data-arbor-text": "display" }, t("settingsHostData")),
      (0, import_react.createElement)(SettingRow, { label: t("dataRoot") }, (0, import_react.createElement)("span", { className: "arbor-mono" }, dataRoot)),
      (0, import_react.createElement)(SettingRow, { label: t("settingsBackend") }, (0, import_react.createElement)("span", { className: "arbor-label" }, backend)),
      (0, import_react.createElement)(SettingRow, { label: t("settingsShared") }, (0, import_react.createElement)("span", { className: "arbor-mono" }, shared))
    ),
    settings.identity === void 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsIdentity") },
      (0, import_react.createElement)("span", { className: "arbor-clamp" }, settings.identity)
    ),
    settings.generalRules === void 0 || settings.generalRules.length === 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsRules") },
      (0, import_react.createElement)("span", { className: "arbor-num" }, String(settings.generalRules.length))
    ),
    tiers.length === 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsTiers") },
      (0, import_react.createElement)("span", { className: "arbor-mono arbor-settings-wrap" }, tiers.map(([tier, model]) => `${tier} \u2192 ${model}`).join(" \xB7 "))
    ),
    settings.defaultTier === void 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsDefaultTier") },
      (0, import_react.createElement)("span", { className: "arbor-label" }, settings.defaultTier)
    ),
    judge.length === 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsJudge") },
      (0, import_react.createElement)("span", { className: "arbor-tags" }, judge.map(([kind, mode]) => (0, import_react.createElement)("span", {
        key: kind,
        className: `arbor-tag arbor-tag-${mode === "off" ? "plain" : mode === "shadow" ? "warn" : "ok"}`
      }, `${kind} ${judgeLabel(mode)}`)))
    ),
    windowLine === "" ? null : (0, import_react.createElement)(SettingRow, { label: t("settingsWindow") }, (0, import_react.createElement)("span", { className: "arbor-num" }, windowLine)),
    notesLine === "" ? null : (0, import_react.createElement)(SettingRow, { label: t("settingsNotes") }, (0, import_react.createElement)("span", { className: "arbor-num" }, notesLine)),
    settings.secrets === void 0 || settings.secrets.length === 0 ? null : (0, import_react.createElement)(
      SettingRow,
      { label: t("settingsSecrets") },
      (0, import_react.createElement)("span", { className: "arbor-mono arbor-settings-wrap" }, settings.secrets.join(" \xB7 "))
    ),
    (0, import_react.createElement)("div", { className: "arbor-settings-note" }, t("settingsDsh"))
  );
}
function SearchGroup(props) {
  if (props.rows.length === 0) return null;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-search-group" },
    (0, import_react.createElement)("div", { className: "arbor-search-group-title arbor-label", "data-arbor-text": "display" }, props.label),
    props.rows
  );
}
function SearchBlock(props) {
  const { t } = props;
  const [query, setQuery] = (0, import_react.useState)("");
  const [result, setResult] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)(void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const run = async () => {
    const text = query.trim();
    if (text === "") return;
    setBusy(true);
    setError(void 0);
    try {
      const response = await fetch(`/api/arbor/search?q=${encodeURIComponent(text)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`search answered ${response.status}`);
      const body = await response.json();
      setResult(body);
    } catch (cause) {
      setResult(void 0);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-search" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-search-row" },
      (0, import_react.createElement)("input", {
        className: "arbor-search-input",
        value: query,
        placeholder: t("searchPlaceholder"),
        autoFocus: true,
        onChange: (event) => {
          setQuery(event.target.value);
        },
        onKeyDown: (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void run();
          }
        }
      }),
      (0, import_react.createElement)("button", {
        className: "arbor-search-go arbor-label",
        "data-arbor-text": "display",
        type: "button",
        disabled: busy || query.trim() === "",
        onClick: () => {
          void run();
        }
      }, t("searchButton"))
    ),
    (0, import_react.createElement)("div", { className: "arbor-search-hint" }, t("searchHint")),
    error === void 0 ? null : (0, import_react.createElement)("div", { className: "arbor-error" }, t("searchError", { message: error })),
    result === void 0 ? null : result.total === 0 ? (0, import_react.createElement)("div", { className: "arbor-search-empty" }, t("searchEmpty")) : (0, import_react.createElement)(
      "div",
      { className: "arbor-search-results" },
      (0, import_react.createElement)("div", { className: "arbor-search-total arbor-num" }, t(result.total === 1 ? "searchTotalOne" : "searchTotal", { count: result.total })),
      (0, import_react.createElement)(SearchGroup, {
        label: t("searchJournal"),
        rows: result.journal.map((hit) => (0, import_react.createElement)(
          "div",
          { className: "arbor-hit", key: hit.ref },
          (0, import_react.createElement)(
            "div",
            { className: "arbor-hit-head" },
            (0, import_react.createElement)("span", { className: "arbor-hit-ref arbor-num" }, hit.ref),
            (0, import_react.createElement)("span", { className: "arbor-hit-kind arbor-label" }, hit.kind),
            hit.window === null ? null : (0, import_react.createElement)("span", { className: "arbor-hit-window arbor-num" }, hit.window)
          ),
          (0, import_react.createElement)("div", { className: "arbor-hit-sum" }, hit.summary)
        ))
      }),
      (0, import_react.createElement)(SearchGroup, {
        label: t("searchNotes"),
        rows: result.notes.map((hit) => (0, import_react.createElement)(
          "div",
          { className: "arbor-hit", key: hit.ref },
          (0, import_react.createElement)(
            "div",
            { className: "arbor-hit-head" },
            (0, import_react.createElement)("span", { className: "arbor-hit-ref arbor-num" }, hit.ref),
            (0, import_react.createElement)("span", { className: "arbor-hit-kind arbor-label" }, hit.title)
          ),
          (0, import_react.createElement)("div", { className: "arbor-hit-sum" }, hit.summary)
        ))
      }),
      (0, import_react.createElement)(SearchGroup, {
        label: t("searchBoard"),
        rows: result.board.map((hit) => (0, import_react.createElement)(
          "div",
          { className: "arbor-hit", key: hit.window },
          (0, import_react.createElement)(
            "div",
            { className: "arbor-hit-head" },
            (0, import_react.createElement)("span", { className: "arbor-hit-ref arbor-num" }, hit.window)
          ),
          (0, import_react.createElement)("div", { className: "arbor-hit-sum" }, hit.doing)
        ))
      })
    )
  );
}
function Sheet(props) {
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-sheet-layer" },
    (0, import_react.createElement)("div", { className: "arbor-sheet-backdrop", onClick: props.onClose }),
    (0, import_react.createElement)(
      "section",
      { className: "arbor-sheet", role: "dialog", "aria-modal": true, "aria-label": props.title },
      (0, import_react.createElement)(
        "header",
        { className: "arbor-sheet-head" },
        (0, import_react.createElement)("h2", { className: "arbor-sheet-title", "data-arbor-text": "display" }, props.title),
        (0, import_react.createElement)("button", { type: "button", className: "arbor-icon-button", title: props.close, "aria-label": props.close, onClick: props.onClose }, (0, import_react.createElement)(CloseIcon))
      ),
      (0, import_react.createElement)("div", { className: "arbor-sheet-body" }, props.children)
    )
  );
}
function Dock(props) {
  const label = (filter) => {
    if (filter === "all") return props.t("filterAll");
    if (filter === "windows") return props.t("filterWindows");
    if (filter === "board") return props.t("filterBoard");
    if (filter === "notes") return props.t("filterNotes");
    if (filter === "env") return props.t("filterEnv");
    return props.t("filterSchedules");
  };
  return (0, import_react.createElement)(
    "nav",
    { className: "arbor-dock", "aria-label": props.t("pageTitle") },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-dock-pills", role: "tablist" },
      FILTERS.map((filter) => (0, import_react.createElement)("button", {
        key: filter,
        type: "button",
        role: "tab",
        "aria-selected": props.filter === filter,
        className: `arbor-pill${props.filter === filter ? " is-active" : ""} arbor-label`,
        "data-arbor-text": "display",
        onClick: () => {
          props.setFilter(filter);
        }
      }, label(filter)))
    )
  );
}
function Overview(props) {
  const { facts, snapshot, t, filter, setFilter, onSearch, onSettings, onOpenSession } = props;
  const live = facts.windows.filter((window2) => window2.live);
  const active = facts.windows.filter((window2) => shownState(window2, snapshot.streams[window2.ref]) === "running");
  const sessions = facts.sessions;
  const latest = active.at(-1);
  const ended = facts.windows.filter((window2) => window2.state === "ended").length;
  const waiting = sessions.filter((session) => session.windows.length > 0 && !session.windows.some((window2) => shownState(window2, snapshot.streams[window2.ref]) === "running") && session.windows.at(-1)?.state === "idle").length;
  const show = (section) => filter === "all" || filter === section;
  const boardCount = facts.board.length;
  const boardOne = boardCount === 1;
  const waitingOne = waiting === 1;
  const endedOne = ended === 1;
  const sessionsOne = sessions.length === 1;
  const heroKey = latest === void 0 ? waiting > 0 ? waitingOne ? endedOne ? "heroIdleWaitBothOne" : "heroIdleWaitOne" : endedOne ? "heroIdleWaitEndedOne" : "heroIdleWait" : sessionsOne ? endedOne ? "heroIdleBothOne" : "heroIdleOne" : endedOne ? "heroIdleEndedOne" : "heroIdle" : boardCount === 0 ? waiting > 0 ? waitingOne ? "heroLiveNoBoardWaitOne" : "heroLiveNoBoardWait" : "heroLiveNoBoard" : waiting > 0 ? boardOne ? waitingOne ? "heroLiveWaitBothOne" : "heroLiveWaitBoardOne" : waitingOne ? "heroLiveWaitWaitingOne" : "heroLiveWait" : boardOne ? "heroLiveBoardOne" : "heroLive";
  const heroContent = sessions.length === 0 ? [(0, import_react.createElement)("span", { key: "empty" }, t("heroEmpty")), (0, import_react.createElement)("span", { className: "arbor-hero-hint", key: "empty-hint", "data-arbor-text": "body" }, t("heroEmptyHint"))] : hero(t(heroKey), {
    window: latest?.ref ?? "",
    board: String(boardCount),
    waiting: String(waiting),
    ended: String(ended),
    sessions: String(sessions.length)
  });
  const cards = [];
  if (sessions.length > 0) {
    if (show("windows")) {
      for (const window2 of live) {
        cards.push({
          key: `live-${window2.ref}`,
          kind: "window",
          node: (0, import_react.createElement)(LiveWindowCard, {
            window: window2,
            session: sessions.find((session) => session.windows.some((one) => one.ref === window2.ref)),
            stream: snapshot.streams[window2.ref],
            t
          })
        });
      }
    }
    if (show("windows")) {
      for (const session of sessions) {
        cards.push({
          key: `chain-${session.sessionId}`,
          kind: "chain",
          nodes: session.windows.length,
          node: (0, import_react.createElement)(ChainCard, { session, windows: session.windows, streams: snapshot.streams, t })
        });
      }
      if (live.length === 0 && filter === "windows") {
        cards.push({ key: "empty-windows", kind: "empty", node: (0, import_react.createElement)(EmptyCard, { title: t("emptyWindows"), hint: t("emptyWindowsHint") }) });
      }
    }
    if (show("all") || filter === "windows") {
      for (const session of sessions) {
        cards.push({
          key: `session-${session.sessionId}`,
          kind: "session",
          node: (0, import_react.createElement)(SessionCard, { session, streams: snapshot.streams, t, onOpen: onOpenSession })
        });
      }
    }
    if (show("board")) {
      for (const line of facts.board) {
        cards.push({
          key: `board-${line.window}`,
          kind: "board",
          node: (0, import_react.createElement)(BoardCard, { line, streaming: snapshot.streams[line.window]?.streaming === true, t })
        });
      }
      if (facts.board.length === 0 && filter === "board") {
        cards.push({ key: "empty-board", kind: "empty", node: (0, import_react.createElement)(EmptyCard, { title: t("emptyBoard"), hint: t("emptyBoardHint") }) });
      }
    }
    if (show("notes")) {
      for (const note of facts.notes.items) {
        cards.push({
          key: `note-${note.ref}`,
          kind: "note",
          text: `${note.title} ${note.summary}`,
          node: (0, import_react.createElement)(NoteCard, { note, t })
        });
      }
      if (facts.notes.items.length === 0 && filter === "notes") {
        cards.push({ key: "empty-notes", kind: "empty", node: (0, import_react.createElement)(EmptyCard, { title: t("emptyNotes"), hint: t("emptyNotesHint") }) });
      }
    }
    if (show("env")) {
      cards.push({ key: "env", kind: "env", node: (0, import_react.createElement)(EnvCard, { env: facts.env, t }) });
    }
    if (show("schedules")) {
      for (const schedule of facts.schedules) {
        cards.push({
          key: `schedule-${schedule.ref}`,
          kind: "schedule",
          node: (0, import_react.createElement)(ScheduleCard, { schedule, t })
        });
      }
      if (facts.schedules.length === 0 && filter === "schedules") {
        cards.push({ key: "empty-schedules", kind: "empty", node: (0, import_react.createElement)(EmptyCard, { title: t("emptySchedules"), hint: t("emptySchedulesHint") }) });
      }
    }
  }
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-overview" },
    (0, import_react.createElement)(
      "header",
      { className: "arbor-hero" },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-hero-top" },
        (0, import_react.createElement)("span", { className: "arbor-date arbor-label", "data-arbor-text": "numeric" }, dateLine(t, facts.at)),
        (0, import_react.createElement)(TopActions, { t, onSearch, onSettings })
      ),
      (0, import_react.createElement)("h1", { className: "arbor-hero-title", "data-arbor-text": "display" }, ...heroContent)
    ),
    (0, import_react.createElement)(Skyline, { items: cards }),
    sessions.length === 0 ? null : (0, import_react.createElement)(Dock, { filter, setFilter, t })
  );
}
function SessionView(props) {
  const { sessionId, session, t, onSearch, onSettings, openDshSession } = props;
  const snapshot = useChannel(channelFor(sessionId));
  const facts = snapshot.facts;
  if (facts === void 0) {
    return (0, import_react.createElement)(
      "div",
      { className: "arbor-overview", "data-arbor-page": true, "data-arbor-session-view": sessionId },
      (0, import_react.createElement)(
        "header",
        { className: "arbor-hero" },
        (0, import_react.createElement)(
          "div",
          { className: "arbor-hero-top" },
          (0, import_react.createElement)("span", { className: "arbor-date arbor-label", "data-arbor-text": "numeric" }, dateLine(t, Date.now())),
          (0, import_react.createElement)(TopActions, { t, onSearch, onSettings })
        )
      ),
      (0, import_react.createElement)(Skyline, {
        items: [{
          key: "loading",
          kind: "loading",
          node: (0, import_react.createElement)(
            Card,
            { className: "arbor-loading-card" },
            (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, t("loading")),
            snapshot.status === "error" && snapshot.error !== void 0 ? (0, import_react.createElement)("div", { className: "arbor-error" }, t("error", { message: snapshot.error })) : null
          )
        }]
      })
    );
  }
  const windows = facts.windows;
  const now = liveWindowOf(windows) ?? windows.at(-1);
  const nowState = now === void 0 ? void 0 : shownState(now, snapshot.streams[now.ref]);
  const boardOne = facts.board.length === 1;
  const heroContent = windows.length === 0 ? [(0, import_react.createElement)("span", { key: "none" }, t("sessionHeroEmpty")), (0, import_react.createElement)("span", { className: "arbor-hero-hint", key: "hint", "data-arbor-text": "body" }, t("sessionHeroEmptyHint"))] : now === void 0 ? [(0, import_react.createElement)("span", { key: "none" }, t("sessionHeroEmpty"))] : nowState === "running" ? now.continuationOf === void 0 ? hero(t(boardOne ? "sessionHeroFirstBoardOne" : "sessionHeroFirst"), { window: now.ref, board: String(facts.board.length) }) : hero(t(boardOne ? "sessionHeroLiveBoardOne" : "sessionHeroLive"), { window: now.ref, previous: now.continuationOf, board: String(facts.board.length) }) : nowState === "idle" ? hero(t("sessionHeroIdle"), { window: now.ref }) : hero(t(windows.length === 1 ? "sessionHeroEndedOne" : "sessionHeroEnded"), { count: String(windows.length), window: now.ref });
  const cards = [];
  if (windows.length === 0) {
    cards.push({ key: "empty", kind: "empty", node: (0, import_react.createElement)(EmptyCard, { title: t("emptyWindows"), hint: t("sessionHeroEmptyHint") }) });
  } else {
    if (now !== void 0) {
      cards.push({
        key: `window-${now.ref}`,
        kind: "window",
        node: (0, import_react.createElement)(WindowCard, { window: now, session, stream: snapshot.streams[now.ref], t })
      });
    }
    cards.push({
      key: "chain",
      kind: "chain",
      nodes: windows.length,
      node: (0, import_react.createElement)(ChainCard, { session, windows, streams: snapshot.streams, t })
    });
    cards.push({ key: "workspace", kind: "workspace", node: (0, import_react.createElement)(WorkspaceCard, { workspace: facts.workspace, t }) });
    for (const line of facts.board) {
      cards.push({
        key: `board-${line.window}`,
        kind: "board",
        node: (0, import_react.createElement)(BoardCard, { line, streaming: snapshot.streams[line.window]?.streaming === true, t })
      });
    }
    for (const note of facts.notes.items) {
      cards.push({
        key: `note-${note.ref}`,
        kind: "note",
        text: `${note.title} ${note.summary}`,
        node: (0, import_react.createElement)(NoteCard, { note, t })
      });
    }
  }
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-overview", "data-arbor-page": true, "data-arbor-session-view": sessionId },
    (0, import_react.createElement)(
      "header",
      { className: "arbor-hero" },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-hero-top" },
        (0, import_react.createElement)("span", { className: "arbor-date arbor-label", "data-arbor-text": "numeric" }, dateLine(t, facts.at)),
        (0, import_react.createElement)(TopActions, { t, onSearch, onSettings })
      ),
      (0, import_react.createElement)("h1", { className: "arbor-hero-title", "data-arbor-text": "display" }, ...heroContent),
      openDshSession === void 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-hero-links" },
        (0, import_react.createElement)("button", { type: "button", className: "arbor-card-link arbor-label", onClick: () => {
          openDshSession(sessionId);
        } }, t("openInDsh"), " \u2192")
      )
    ),
    (0, import_react.createElement)(Skyline, { items: cards })
  );
}
function ArborPage(props) {
  const t = props.t ?? ((key) => key);
  const host = useChannel(hostChannel());
  const facts = host.facts;
  const [opened, setOpened] = (0, import_react.useState)([]);
  const [active, setActive] = (0, import_react.useState)(null);
  const [filter, setFilter] = (0, import_react.useState)("all");
  const [searchOpen, setSearchOpen] = (0, import_react.useState)(false);
  const [settingsOpen, setSettingsOpen] = (0, import_react.useState)(false);
  const sessions = facts?.sessions ?? [];
  const activeSession = active !== null && sessions.some((session) => session.sessionId === active) ? active : null;
  (0, import_react.useEffect)(() => {
    if (!searchOpen && !settingsOpen) return;
    const close = (event) => {
      if (event.key !== "Escape") return;
      setSearchOpen(false);
      setSettingsOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
    };
  }, [searchOpen, settingsOpen]);
  const openSession = (sessionId) => {
    setOpened((current) => current.includes(sessionId) ? current : [...current, sessionId]);
    setActive(sessionId);
  };
  const closeSession = (sessionId) => {
    setOpened((current) => current.filter((one) => one !== sessionId));
    if (active === sessionId) setActive(null);
  };
  const tabLabel = (sessionId) => {
    const session = sessions.find((one) => one.sessionId === sessionId);
    return session === void 0 ? sessionId.slice(0, 14) : sessionTitle(session);
  };
  (0, import_react.useLayoutEffect)(() => {
    const root = document.querySelector("[data-arbor-page]");
    if (!(root instanceof HTMLElement)) return;
    const mark = (selector, role) => {
      for (const element of Array.from(root.querySelectorAll(selector))) {
        if (!element.hasAttribute("data-arbor-text")) element.setAttribute("data-arbor-text", role);
      }
    };
    mark(".arbor-num,.arbor-hero-num,.arbor-date,.arbor-node-ref,.arbor-handoff-ref,.arbor-env-big,.arbor-search-total,.arbor-hit-ref,.arbor-hit-window", "numeric");
    mark(".arbor-mono,.arbor-card-project,.arbor-md-code,.arbor-md-pre,.arbor-md-pre code", "code");
    mark(".arbor-card-kicker,.arbor-card-title,.arbor-tab,.arbor-pill,.arbor-state,.arbor-tag,.arbor-empty-title,.arbor-card-link,.arbor-stream-label,.arbor-sheet-title,.arbor-search-group-title,.arbor-search-go,.arbor-settings-group-title,.arbor-node-state,.arbor-hero-name,.arbor-env-group-title,.arbor-workspace-row > .arbor-label,.arbor-hit-kind,.arbor-env-count > .arbor-label,.arbor-tab-close,.arbor-connector-label,.arbor-connector-arrow", "display");
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.namespaceURI === "http://www.w3.org/2000/svg") continue;
      if (element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
      if (element.hasAttribute("data-arbor-text")) continue;
      const direct = Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");
      if (direct) element.setAttribute("data-arbor-text", "body");
    }
  });
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-page", "data-arbor-page": true, "data-arbor-text": "body" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-page-inner" },
      (0, import_react.createElement)(
        "nav",
        { className: "arbor-tabs", "aria-label": t("pageTitle") },
        (0, import_react.createElement)("button", {
          type: "button",
          className: `arbor-tab arbor-label${activeSession === null ? " is-active" : ""}`,
          "data-arbor-text": "display",
          onClick: () => {
            setActive(null);
          }
        }, t("tabOverview")),
        opened.map((sessionId) => (0, import_react.createElement)(
          "div",
          { className: `arbor-tab-group${activeSession === sessionId ? " is-active" : ""}`, key: sessionId },
          (0, import_react.createElement)("button", {
            type: "button",
            className: "arbor-tab arbor-label",
            "data-arbor-text": "display",
            onClick: () => {
              setActive(sessionId);
            }
          }, tabLabel(sessionId)),
          (0, import_react.createElement)("button", {
            type: "button",
            className: "arbor-tab-close",
            title: t("closeTab"),
            "aria-label": t("closeTab"),
            onClick: () => {
              closeSession(sessionId);
            }
          }, "\xD7")
        ))
      ),
      facts === void 0 ? (0, import_react.createElement)(Skyline, {
        items: [{
          key: "loading",
          kind: "loading",
          node: (0, import_react.createElement)(
            Card,
            { className: "arbor-loading-card" },
            (0, import_react.createElement)("div", { className: "arbor-card-title", "data-arbor-text": "display" }, t("loading")),
            host.status === "error" && host.error !== void 0 ? (0, import_react.createElement)("div", { className: "arbor-error" }, t("error", { message: host.error })) : null
          )
        }]
      }) : activeSession === null ? (0, import_react.createElement)(Overview, {
        facts,
        snapshot: host,
        t,
        filter,
        setFilter,
        onSearch: () => {
          setSearchOpen(true);
        },
        onSettings: () => {
          setSettingsOpen(true);
        },
        onOpenSession: openSession
      }) : (0, import_react.createElement)(SessionView, {
        sessionId: activeSession,
        session: sessions.find((session) => session.sessionId === activeSession),
        t,
        onSearch: () => {
          setSearchOpen(true);
        },
        onSettings: () => {
          setSettingsOpen(true);
        },
        ...props.openDshSession === void 0 ? {} : { openDshSession: props.openDshSession }
      })
    ),
    searchOpen ? (0, import_react.createElement)(
      Sheet,
      { title: t("openSearch"), close: t("closeSheet"), onClose: () => {
        setSearchOpen(false);
      } },
      (0, import_react.createElement)(SearchBlock, { t })
    ) : null,
    settingsOpen && facts !== void 0 ? (0, import_react.createElement)(
      Sheet,
      { title: t("openSettings"), close: t("closeSheet"), onClose: () => {
        setSettingsOpen(false);
      } },
      (0, import_react.createElement)(SettingsBlock, {
        settings: facts.settings,
        dataRoot: facts.dataRoot,
        backend: facts.backend,
        shared: facts.shared,
        t
      })
    ) : null
  );
}
function ArborPanelIcon(props) {
  const size = props.size ?? 16;
  return (0, import_react.createElement)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.4,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      "data-arbor-icon": true
    },
    (0, import_react.createElement)("circle", { cx: 4, cy: 3.5, r: 1.6 }),
    (0, import_react.createElement)("circle", { cx: 12, cy: 6, r: 1.6 }),
    (0, import_react.createElement)("circle", { cx: 4, cy: 12.5, r: 1.6 }),
    (0, import_react.createElement)("path", { d: "M4 5.1v5.8" }),
    (0, import_react.createElement)("path", { d: "M5.4 3.9h2.1c2.2 0 3 1 3 2.1" })
  );
}

// packages/arbor-ui/src/client.ts
var SEAT_SLOT = "conversation.input.permission";
var HERO_SEAT_SLOT = "conversation.hero.agentPreset";
var ARBOR_PRESET = "arbor";
var PRESET_PROJECTION = "agentPreset";
var POLL_MS = 40;
var MAX_POLLS = 500;
var CARRY_MS = 2e3;
var inject = ["slots"];
function apply(ctx) {
  const slots = ctx.slots;
  const service = (name) => ctx.get(name);
  let dispose;
  let poll;
  let attempts = 0;
  let heroDispose;
  let heroAttempts = 0;
  const stop = () => {
    if (poll !== void 0) {
      clearInterval(poll);
      poll = void 0;
    }
  };
  let bound;
  ctx.inject(["locale"], () => {
    const locale = service("locale");
    if (locale === void 0) return;
    try {
      locale.register(NAMESPACE, { zh, en });
      bound = locale.bind(NAMESPACE);
    } catch (error) {
      ctx.logger.warn(`arbor-ui: the arbor locale did not register: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const t = (key, args) => (bound ?? fallbackTranslate)(key, args);
  installStyles();
  ctx.effect(() => () => {
    closeChannels();
  }, "arbor-ui: channels");
  const openDshSession = (sessionId) => {
    service("uiWorkspace")?.openSession(sessionId);
  };
  const registerSeat = (options, component) => {
    let stop2;
    let timer;
    let attempts2 = 0;
    const attempt = () => {
      if (stop2 !== void 0) return;
      if (++attempts2 > MAX_POLLS) {
        if (timer !== void 0) clearInterval(timer);
        timer = void 0;
        return;
      }
      try {
        stop2 = slots.register(options, component);
        document.body.dataset["arborSeat"] = `${document.body.dataset["arborSeat"] ?? ""}|ok:${options.name}:${options.id ?? options.key ?? ""}`;
      } catch (error) {
        document.body.dataset["arborSeat"] = `${document.body.dataset["arborSeat"] ?? ""}|fail:${options.name}:${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (timer !== void 0) clearInterval(timer);
      timer = void 0;
    };
    attempt();
    if (stop2 === void 0) timer = setInterval(attempt, POLL_MS);
    return () => {
      if (timer !== void 0) clearInterval(timer);
      timer = void 0;
      stop2?.();
    };
  };
  registerSeat({
    name: "main",
    key: PANEL_ID,
    locale: NAMESPACE,
    inject: () => ({ openDshSession })
  }, ArborPage);
  registerSeat({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 10,
    locale: NAMESPACE,
    label: () => t("panelLabel")
  }, ArborPanelIcon);
  let heroInject;
  let unboundSeat;
  const heroSeatFor = (sessionId) => {
    if (heroInject === void 0) return void 0;
    if (sessionId === void 0) {
      unboundSeat ??= heroInject()?.hooks?.agentPresetSeat;
      return unboundSeat;
    }
    return heroInject(sessionId)?.hooks?.agentPresetSeat;
  };
  const gate = (seat) => (props) => {
    const runtime = props;
    const main = useMainSession();
    const staged = usePresetPick(runtime.sessionId);
    const projected = runtime.useProjection?.(PRESET_PROJECTION);
    const stagedCounts = main === void 0 || main.blank === true;
    if (projected === ARBOR_PRESET) return null;
    if (stagedCounts && staged === ARBOR_PRESET) return null;
    return (0, import_react2.createElement)(seat.component, props);
  };
  function usePresetPick(sessionId) {
    const bound2 = heroSeatFor(sessionId);
    const unbound = heroSeatFor(void 0);
    return (0, import_react2.useSyncExternalStore)(
      (onChange) => {
        const stops = [bound2, unbound].map((one) => one?.subscribe(onChange));
        return () => {
          for (const halt of stops) halt?.();
        };
      },
      () => {
        const picks = [bound2, unbound].map((one) => one?.getSnapshot().current);
        return picks[0] !== void 0 && picks[0] !== "" ? picks[0] : picks.find((pick) => pick !== void 0 && pick !== "");
      }
    );
  }
  const mainSession = () => {
    const byId = service("sessions")?.list.getSnapshot().byId ?? {};
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return byId[id];
    }
    return void 0;
  };
  function useMainSession() {
    const sessions = service("sessions");
    return (0, import_react2.useSyncExternalStore)(
      (onChange) => sessions?.list.subscribe(onChange) ?? (() => void 0),
      () => mainSession()
    );
  }
  const presetOf = (session) => typeof session?.projectionValues?.agentPreset === "string" ? session.projectionValues.agentPreset : void 0;
  const workspaceOf = (sessionId) => {
    const items = service("workspaces")?.list.getSnapshot().items ?? [];
    return items.find((item) => item.sessionIds.includes(sessionId));
  };
  const crossesArbor = (id) => {
    const main = mainSession();
    if (main === void 0 || main.blank !== true) return false;
    return presetOf(main) === ARBOR_PRESET !== (id === ARBOR_PRESET);
  };
  const carryDraft = async (from, to) => {
    const input = service("conversation")?.input;
    if (input === void 0) return;
    let draft;
    let attachmentIds = [];
    try {
      const shell = input.shell(from);
      draft = shell.draftSnapshot;
      attachmentIds = shell.snapshot?.attachmentIds ?? [];
    } catch {
      return;
    }
    if ((draft?.text ?? "") === "" && attachmentIds.length === 0) return;
    const sessions = service("sessions");
    const deadline = Date.now() + CARRY_MS;
    for (; ; ) {
      if (sessions?.binding(to) !== void 0) {
        try {
          const next = input.shell(to);
          if (attachmentIds.length === 0 || next.addAttachments(attachmentIds)) {
            next.setDraft(draft ?? { text: "" });
          }
        } catch {
        }
        return;
      }
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  };
  const mintUnderPreset = async (id) => {
    const main = mainSession();
    const sessions = service("sessions");
    const navigation = service("uiWorkspace");
    if (main === void 0 || sessions === void 0 || navigation === void 0) return false;
    const workspace = workspaceOf(main.id);
    if (workspace === void 0) return false;
    try {
      const minted = await sessions.create({ workspaceId: workspace.workspaceId, agentPreset: id });
      navigation.openSession(minted);
      await carryDraft(main.id, minted);
      await navigation.archiveSession(main.id).catch(() => void 0);
      return true;
    } catch (error) {
      ctx.logger.warn(
        `arbor-ui: minting a session under preset ${id} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  };
  const tryShadowHeroSeat = () => {
    if (heroDispose !== void 0) return;
    if (++heroAttempts > MAX_POLLS) return;
    const entry = slots.entriesOfSlot(HERO_SEAT_SLOT)[0];
    if (entry === void 0) return;
    const shipped = entry.inject;
    if (typeof shipped !== "function") return;
    const wrapped = (sessionId) => {
      const face = shipped(sessionId);
      const select = face.select;
      if (typeof select !== "function") return face;
      return {
        ...face,
        select: (id) => {
          if (!crossesArbor(id)) return select(id);
          void mintUnderPreset(id).then((taken) => {
            if (!taken) void select(id);
          });
          return void 0;
        }
      };
    };
    heroDispose = slots.register({
      name: HERO_SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: entry.locale,
      inject: wrapped
    }, entry.component);
  };
  const tryRegister = () => {
    if (dispose !== void 0) {
      stop();
      return;
    }
    if (++attempts > MAX_POLLS) {
      stop();
      return;
    }
    if (heroInject === void 0) {
      const face = slots.entriesOfSlot(HERO_SEAT_SLOT)[0]?.inject;
      if (typeof face === "function") heroInject = face;
      if (heroInject === void 0) return;
    }
    const seat = slots.entriesOfSlot(SEAT_SLOT)[0];
    if (seat === void 0) return;
    dispose = slots.register({
      name: SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: seat.locale,
      inject: seat.inject
    }, gate(seat));
    tryShadowHeroSeat();
    stop();
  };
  ctx.effect(() => () => {
    stop();
  });
  poll = setInterval(tryRegister, POLL_MS);
  tryRegister();
}

		return module.exports;
	}
});

