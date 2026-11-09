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
  stream(window, event) {
    const before = this.snapshot.streams[window] ?? { text: "", send: "", streaming: false };
    let next = before;
    if (event.kind === "text_delta") {
      next = { ...before, text: tail(before.text + event.delta, TEXT_LIMIT) };
    } else {
      const content = sendContentOf(event.args);
      if (event.name === "send" && content !== void 0) {
        next = { ...before, send: tail(content, SEND_LIMIT) };
      }
    }
    const streams = { ...this.snapshot.streams, [window]: { ...next, streaming: true } };
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
  notesEpoch: "Epoch {epoch}",
  notesEmpty: "The active set is empty.",
  envCounts: "{skills} skills \xB7 {servers} MCP servers \xB7 {services} services",
  envBuiltin: "built-in",
  envFunctions: "functions",
  envSkills: "Skills",
  envMcp: "MCP servers",
  envServices: "Services",
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
  searchJournal: "Journal",
  searchNotes: "Notes",
  searchBoard: "Board",
  searchHint: "Arbor's own search over its journal, notes and board.",
  searchError: "Search failed: {message}",
  seconds: "{value}s",
  minutes: "{value}m",
  hours: "{value}h",
  tokens: "tokens",
  window: "window"
};
var zh = {
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
  notesEpoch: "\u7B2C {epoch} \u4EE3",
  notesEmpty: "\u6D3B\u8DC3\u96C6\u4E3A\u7A7A\u3002",
  envCounts: "{skills} \u4E2A\u6280\u80FD \xB7 {servers} \u4E2A MCP \u670D\u52A1 \xB7 {services} \u4E2A\u670D\u52A1",
  envBuiltin: "\u5185\u7F6E",
  envFunctions: "\u51FD\u6570",
  envSkills: "\u6280\u80FD",
  envMcp: "MCP \u670D\u52A1",
  envServices: "\u670D\u52A1",
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
  searchJournal: "\u65E5\u5FD7",
  searchNotes: "\u7B14\u8BB0",
  searchBoard: "\u770B\u677F",
  searchHint: "arbor \u81EA\u5DF1\u7684\u641C\u7D22\uFF0C\u67E5\u65E5\u5FD7\u3001\u7B14\u8BB0\u548C\u770B\u677F\u3002",
  searchError: "\u641C\u7D22\u5931\u8D25\uFF1A{message}",
  seconds: "{value} \u79D2",
  minutes: "{value} \u5206\u949F",
  hours: "{value} \u5C0F\u65F6",
  tokens: "\u4EE4\u724C",
  window: "\u7A97\u53E3"
};
function format(template, args) {
  if (args === void 0) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => Object.hasOwn(args, name) ? String(args[name]) : whole);
}
function fallbackTranslate(key, args) {
  const value = zh[key];
  return value === void 0 ? key : format(value, args);
}

// packages/arbor-ui/src/font.ts
var DIN_REGULAR = "data:font/woff;base64,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";
var DIN_MEDIUM = "data:font/woff;base64,d09GRk9UVE8AAH8UAAwAAAAA0eQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDRkYgAAAOKAAAUboAAHStV/ddAUdERUYAAF/kAAABIgAAAbKhB58/R1BPUwAAYQgAABVQAAAspv0czZ1HU1VCAAB2WAAACLoAABJ0E69B5U9TLzIAAAX0AAAAVAAAAGDbJrVVY21hcAAACBwAAAX2AAAIRM3wFA9oZWFkAAABJAAAADQAAAA2K7v0SGhoZWEAAAXUAAAAIAAAACQIdwVHaG10eAAAAVgAAAR5AAANpJdIqy5tYXhwAAABHAAAAAYAAAAGA2lQAG5hbWUAAAZIAAAB0wAABMqHPqjqcG9zdAAADhQAAAATAAAAIP+fADIAAFAAA2kAAHgBY2BkYGBglJz5f8l79Xh+m68MzMwvGIDgSYG3Loz+X/KfiyWAJR3IZWdgAokCAIqaDNd4AcXWA5AtRxQG4P90r22bwdr2zmYZ27ZtsxjbVjF2Uoht28/25J+evrX3reKkqr46rVHf26dbHYADAQDf0BcEQJYB+idA7YSwf9WRGDUOR9eMjmPfVPX/oAb77LmcjtEp8rABW1kZfnTnWSutVbZ9BeNmjGtovryL4gB1EEY3kjmVuyyovqnWmAimbsDonPju/5tRjHpMeX/GmdSgcFbPY1xpJMzqXIz+q4oQptunU2MU84eVTaVPQ5hxif1vc45kAyr+TXyuY4SgeUYxM4j450g/Cvz7ziEVzlT4BUNYjBFKonEsdn+wFltLOMZhXMT+EsZl9K2EuV9hnk8pOMEkJ8Bda8uh5FjR2oETjO8xt3A0/29i4FjNshccyqVyv2x9jorZsL9gLvYb/zXyJmLUN9PJU/TWH/QOmqfSNagwHDQr2Hl6G1vJIgypaJYr+W172O87z59L+ZY5J4nxS0TKS8iXOxDDccXiokt2RJX8yL71aFdh2FyWoksJ6y+gTCWgj+U2tS+asRJDIHkGxVQhVWg2GjFKzbKvj+u/WaUgnblxUK5kWxOONrzyZeiQ+wG9HSCf4WA8itoA2Y62Rw2xPNmO11GrXvMjSKqRLu1wvO+ZooO2C6pX2lgv3wCqEI5HzkGzrEGH7keZ3MRvPQOjnLdRPYEBNYE6cZCNT5EozXzOIDJkFAnSjWzZgvV8xMg2fhlPuyepH5GoliNR74xM9QvjdsjgfbJ1FWJUDfL0bshTwM2yzD2O8XxZhmMZD/fJ8Ywn4iX3c8Z36CZ6hOaZM8Nx1IYmdTaGN9o/b7ACew/3C5N/d2I9M6jPRrPfsF8cxNncZ/KRn3MwEpxLmCMSKZT9XF/uPLNW+J/z7s12/q9tnrW5wawz9ssGtP4Z+A4OmeeB0RrwcpR6DgWqDAUmt4f7z/JyXuD5Zh3tjDB1qD1bhVnFdAOigs8/+mvWd+Uc3Mh6wEHWMFLMOeN0O092v1IH81tXc05jEWY8zL4xxrMxrA7jPftpP47biw5luYPxTUDfw/t9bvf9g9BFrXDNGWmlHIFi9S3Cdbk5G5SqVxFu9lA+1+5jLf6cT1K1SAneZ3QaYuR7livgBMh6axG/8z62pdmcHTe5J8rpCA/kE8116uUfMy4Zjo6hSHud0BIaANRaROlKP78G9lF/v3IXe7+F967qGcrDOOcqSh5HiHkuz7ziotvklAXoVECH0qjlmJHgnMIxPdQl16HKRLbbXL+nCsWQikSPikc97+moWHTw+gHvOpb7OWaI9qZx6qVmGjHj7P1Z7zHvwTpjF+tb/tF1LT3I+6Nj8QVg8hIA5pkmk98CeXE10snB98wp5+MYky8S4ehdkR9yHypUBeoBHAu479BxAE5kfMLG8+gTAK8yvk2fA1hPx7P86ST0UiJtRdfRsXStfy1Bshh/AFBKB9n+o/37BcOrUxxD11AX4L5L78uDuMqsL649bw2bfZl7nHyBcjUAmP9QgPLXqnYwqPswqMrseSOCZa893f//yDz/f/0b9N1YhAAAAHgBY2BkYGB+8d+C4QTLqv8lf3+zBABFUABzJgC6fAfGeAFjYGFiZ/zCwAKku5giGBgYvCE0YxyDESMLAxJ4yMD0P8jx7X8WhgYFED/UO9yP4QAD728mZoX/FgwnWNIZvikwME4HyTFxM+0BUgoMPADtsBD+eAFMygNogGEQxvH/fZptI3O2bS97tpndspe19GVrWcte9rK9XLvaM7z83d0DlPJJiEVZ7hRko55UDsjnTQ7p5F2O/mVihi1TTqi3aTmLUtuRs73/IOewaM9ynjXbh1xIYRjJReSGpd82qA4bZXP3y4F7Uw7dZ3LkfpJjKsMXOfH+KxOcc8EjVxyyzwE3NNJOq98u16Z3dv2f8P+QE9+TzLHsnVWuOOfIp9tfrZLDmsQAEIT7Tda2dVnbvI6Zsefp909/sU4TVruqE625kB7vkjTwd7CXtVeX3h05lS3OIh3IIC8jm1Q1pIb3T9JUtOlT17mH3FuheSsRDF6oyeHr0ecTXAQZ2m1HNrm3Oc/kR56Y8QoKdtjwdfgFwxyrAZNpX487akYoKamyPSJ7qnCP02S8ktw7UuMlvo7mTFsTr2XDqt6c6O6+1TaZ3+qkLugLVAANtANf2MoweGe1n82tB86B22AYgKim7zPvNxiS6+v87OuwLtMxm920/q7wXJdNWvrcppY0ug2NDKxNENW5F/KhuMumpkN7a1gMCxY//5xN/VuLoY15v90F3q4qqJtT8PaVx05sJB0bMWIjj7GRBflS/R0pWV9krFmN2Iqjf0iUt6IAeAGMkgPQXzEQxO9y+Wz7JrVt27Zt29agtm3btm23f3y17TTzandnbnfz/Js8ABBmyEywcbRSuqc2eRR6gyuUBB9IBVmgJ2bCnFgYe2JvHIYjcSLOwOV4Ga+hA+/jI3yOWkSJZCKdyCRyiHyiimggGosOYrlYKdaJDWKz2CeuCBtJ8qZAiqLElJLS0AhaISNlPJlKppMZZBaZVeaTteQIuUzeZhf24yCOwwk4GafhElyBa3E9bsMDeBiP46n8WpHyV8EqUrGKqxKq1Cqdyqryq9aqi+qlhqrFceLGqRk3MG5IgoMJDqcMmzfkrdAawPAoSA1ZYTpmwTxY9CvPNFyGR/Aq2vGG4XmGH0S4SCzS/pFnrzhveIBcLZ54lPwzD8goGV+mlullRsOTTeaXw+VSeYsle3MgK47PSTklp+fSXJXrcnPuzUN5pOGZroThCVLhKlopiyetymLxtDc8Qyyeat/xDHqLWuvnADgOvmkJTId0sAK+V5XveoB+ru/ou/qQvqaL6e16m94CE2CMrgmgR1hXJAQ2HgJBuugHX4APzcx0NtPdTE/4L9ndAK6Tw8t2AsB2zMwh20P7A9sm20n7FPsU2zP7MFvkdef1bddu2Xwu57lS9QwBuG6y/r7DZm5hazFVzBdr4bMolCIpmrJSdsoJQEWpOJWk8lQV/ijKa11X1upfr6PqZoaamfl5ptNZOk8X6TJdJSfdoFt0h+7RE7N/KWVmmdXsXUlZGkBWBksu0ozrv/nlLSsIT+IdvII7BOMJvI1nPzZQDwxAJgAQBd/ul23btm3buOqcbZuHbNu2bdu2bf+IGZ13CH3Uc93WC13XK73WO33Qe53RFUKTmKSkJgOFKUIZKlKfhvxOM1rRibGMZwLTmMdS9rKPwxzhnC7oli4ay0m5wQc+CYVUHMVVUqVSDuVWfhVXaVVWK7VRW3VWLw3SNE3XHM3Vcl3SDV3WtyC2TmuX9uiaduumwzq5w7lVkEjfg7gO6dQOra9B5CCKkwTJHSaI4/RBJLcOEjuOYzuuzhKGsEQmIuGIwGVSkZFMZCYnlalCVapzjTb0oBvd6UpnfaYLy1jOSlZzjOvazE1u8YB73Oau1vBdoRRaYRRJaZRW6ZRB61VWNVVdNVRNVfRFVTVYQzRM/2q+NmgRCXlHTJ6RiPck4zMp+EpKvpGcL6SVSa8Q5FU08isGBRSTQopNHkWluBJQQgkppcSUVhLKKhkVlJK6ykZtZaGmMlFP2ankUtqoTTRQLn5TPv5QARqrCE1UlKYqRmuVoaMq0V4VnFPb+Fd/MVi/MkiNuKp1TFYHpqoTE9WOOerJbPVghroyXV1YpH4sVn+WaACbNYYtGstGjWKrxrFCQ9mm8RzSbE5rCSc5rxVc0mouaKVzMVxN2K4JxOM11ZSeAWrAKv3DOg1nrf5nvUawRv8Rnjtc0VqKKT6/Ki//6W/+V2OKKh4D1ZBZ6s5C9aWgYjFUv3NGS53GaZ3OGZzKyYK0Qfogc5A9yPHzuDRB6iB3kC3IGGT5KTL/T5MFg8JBEfd0L891V0/1FE/3DM/0JE/2LA90fw/3OHd0J3d2F3d3D/d2H/d1Pw/wCI/0aI/yGI/1RE/weE/zbM/xMi/3eu/2Hu/zXu/3AR/xYR/ySZ/zea/wSl/wEp/wcZ/yaZ/xUR/zWW/wOu/yQXfzUs/zRc/3JZLwkXQKnMnFSSNRUokop+SUVwpqKCONlMdZXY6/VIi/VdjZXYE/VZDmKkELlaSlStFO5Wmrcs7hinRQRfqoLv31C31Vj3FqzRR1ZJLaO7crMVPdWKA+zuPKzFdv9msGBzSTg5rFcS3golY5r6u4pAYSnzck4C1ReUR0nhCDp0TjMVF4SCyeE4n7xOElsXlBXF6RS5HJrSjkU3RyKCJZFY4sCks2hSe7IlBHWamlzPRWHYboN/7Rn/RSbXqqFv1Un2H6gzFqyWi1YKSaMUrNGaGmbNJoNmgkOzWJHZrIbk1hj6ayS5M5qnmc0ELOahmntFj39UDPbAe653yu6iw/AKUG5iMAAHgBY2BmAIP/cxiMGLAAACqDAdEAeAEEwQOUEAAABbCPbNu2bdu2bduuh2zbtm3btq3zRoQTSMYq26lzt27lKtfIXr19u879u4NkxoClCFjGgOX6lzBcYOxoDkwVOCXgVUBg+GRZisdMlr197HXJOs6Jo4kCER4REQ1xkQSpkQk5UQDFUQ5VURuN0BId0B39MBRjMBnTMBeLsRJbsA9HcRqXcAP38Qxv8QW/EUQzMmMxIZMzI3MwP4uxDKuzLpuwHbtyAIdzHCdxBudzGddwM3fxII/zHG/yCV/zE3/yv6CIiqH4Sqo0yqxcKqDiKqcqqq1GaqkO6q5+GqoxmqxpWqh12qLdOqSTuqDruqeneqWP+qH/hiM6huM5qVM7k3O6oEu4vGu5gZu7nbu6jwd7pMd6mud6iVd7k3f6gI/5rC/7lu/7mV/7k386jCB4ABADgIEANhTXzrZt27Zt27Zt27Zt27ZtPefkJ4UlUGSKSYkoLWWmXFSQSlBlqkUNqTm1ox7Un4bRWJpCs2kRraQNtI320hE6TZfoJj2g5/SOvlIw/eHwHJnjchJOxRk5O+fjolyGK3MtbsgtuB135T48iMfwZJ7FC3k5b+IdvJ9P8gW+zY/4Jb/lbxzC/4QlosSQ+JJU0kh2KSQlpYJUl7rSRFpLJ+kp/WWYjJUpMksWygpZJ1tljxyWU3JRbsh9eSZv5Yv8VNVIGlMTaHJNp1k1jxbWElpeq2ldbaKttZP20P46VMfoZJ2ti3SlbtFdelBP6Hm9pnf0gT7XLxqkf0CIgOiIhyRIjYzIgbwogpKogOqoh6Zog07ogYEYg0mYiQVYjk3YiQM4hrO4jnt4gEd4ilf4iK8ItjAGi2rxLYVltJxW2MpaNatrTay1dbKeNsCG2zibaDNsvi2ztbbFDtsle2DvLNjZY3g8T+ppPLPn8oJewst7Na/rTby1d/KePsDH+zxf47v8hF/zJ/7Kv/qvCPqfIHgAFMOKAQDYGXHer23btm3btm3btm3btm0bc7s7iAqJIT3kgmJQCepAc2gLPWAIjIfZsBw2wVbYA4fhFFyEG3AfnsFb+AL/4Y8I6Bgd42FSTIOZMRcWxBJYHqthXWyCrbET9sQBOBzH4VScg4txFW7EHbgfj+FZvIK38RG+xA/4F0WiX4gpMsWihJSC0lM2yktFqDRVoprUgJpTO+pKfWgwjaKJNIPm0zJaS1toNx2ik3SBrtM9ekpv6DP9yz/w72wcjeNyEk7NmTgnF+DiXI6rch1uzK24I/fg/jyMx/IUns2LeCWv4228l4/wWb7Kd/kJv+U/JZL8Li4xJbGklkySUwpJKakkNaWRtJbO0keGyBiZJvNlhWyQXXJEzsoteSF/6M8qGlXjanLNoDm1oJbWqlpPW2sn7akDdLiO06k6RxfrKt2oO3S/HtOzekVv60N9ru/0D/vBgsWw+JbM0lsuK2zlrKo1sObWzrpaHxtqY2y6LbL1ts322km7YNftnr21L/af/+jg7tE9kaf1HF7Yy3lNb+LtvZcP9Sm+1Nf4Zj/gZ/2aP/YP/i1wiBFShlyheKgSGoVOYWAYF+aElWFnOBYuh4fhRUS+iLJlKpcqVbBCmjb/k1keXI7iShj9R32EkAgnE+TJeV6OtM3Y7NKwxzadfv2DuuoW9tswt0oqlapk6WOmvp+GTiulQTxDRbWbEblSCYoKGFCABGTF7bG9b3H8MgM0SCRlVROigC7umu1xHIpxPw7t7zKoTNVsp3NbbZt5ptp2x+1096tvH6vdeG6223Y4S1yka4lgUVXPeRpmKg0UMCChDgcyUDjJ4SiDscpJL269ndI6cxQpfWzMG1n4JpT3JpyAVm8uFkdavw2BhBhQvL1tju8uo6sNc+5dSFkV76gRL3t37vpd+y6UpEyhYhW9v9onVpLSZYI4+Shny1QFEuAjyo/hVGMnMAroz2GxSYD5HMJNISmMFa82QFNxRQiwmrkEjxrr6Mupb04H2eTLYRr2zXG665vp/GV1Do5foyBBBtQXDodeC1B9OYxHKnN+P4en8CpAKmu+h05s9T20aslnkx/bdtf1fSOjiZZCouxHOPEfYVHOVqkiuCKYTIn+KVv9nH/6P6375BhiUIIUWJDTQPKncCLO/Enuwp84gj8du2H/J+7Fn8IBFCATbBReBdxf9sfmvv2LVP+XXdce21N3+kvo628yL8GZI4MB2d9ClLQYayaSv6/OQv/98oI7TTfc8zISFDWwoAQpyJuVvvhlFsSAc6ocIRGIGw6lWeuL3UppW/kNtqH+7ZW+xLuVvtS7lb7EIAIWpNSxATkoW8nRrvWlbqWX9kpf8natL3YvC/ehvP1KX6L9lb7Eh2t9saA8zJesu+nHbf/z+weOXTG16ULGquzW8pJ3cqW6lbwkIi+/XctLxA+aC+K0X8lLDVLgI6p+JS+clYlAPKzkJQV2COGGF+GVp7bA/xY1IcDGzKV4EW3rMcjLuH524+ocNvwYJQlyEI1reSlBPYbX5ffb4EV4NSCVtceVvNTHlbyQz6anC3mJUYz8FE78FBalEVE1UaRI4rPscZ5/ch5eOv2/vBhQgQwkwKtEOq3kxU5yFyZ/BIu8TP5ehAMoQS7YRHg12DyIfDxI9Q8v8vIQ+npaycuGDBbkT9fyEjORPq/kJX6+kpf43fvut3ZuvP/j0Mi61LrpOPbj8zzaPrfH8WaY7paHKTw/jPBwbBn5NU5HjO6ekVP3COeDGcRqu/3hLNbQ+USyl6FG5aQY6ahIM/8aDG14rxCYzA17Cc5p3zpBAnJDhtJ/oOUxfyre+o/ti8vfmsT7+vHD5wvvy4X348L7+4X3/uZ0UoYGeAs2p4pEvCSjgRSZUvRhqb7AKwWGdZaWEpBbeqm8Glz2kry424uahgtvvPBOF97zhdcsvehGxjCXa43pvxYMh0uG/3JHieSDwozcVEzeAzbvAXt5IFjybsTslz9jxFFMf15io4gMcyrYqCcholxinv9z/tW/ButSAS0Q6dEq3TCYLjCRAhHQIBYokPsQAyxzCvh1CUhBBnJCarwCr8Irgfdq4MBGoBWIgAa+ModngAUpSEAGfBE+ZwVK4EvKgfcs8KlrvASkIAM+iwPsoLSgYNARGSsQAQ1oxYLczxlgmVPAzyUgBRnICanxCrwKrwTeq4EDlGsUiIAGvjKHZ4AFKUhABnwRPmcFSuBLyoH3LPCpa7wEpCADPosD7GD9IeO5vFikXIR7PP0ah3bB+UE8VHs2RLQXdvfiz5K9AMWeDQR7NoaOBJJPntY4yLuMGDmphEWzlcrQuZdNZ8ybzmDT2WDTmbLpzHnTGWw6G2w6G2w6k3y+izNtQFL6RjAkKa1A0r40IxaJX9qZGRrAC02sp84Xc7thvJsLEp4f8ClosZaCMLp7RuaC4JJLLAparLkggl4z35zOO5RJLqMqc6BBzJwBFiQgBRlgXaFAPUO7iJBICbIauLtumNX21G7HQfbWkWU3+0d7XP6usDS/2OfDOJ2aYSf+Emkrud6xykAqqr8d727x1fy/ES0PY9EyhlmC6qbpz5gaVCABhXweQgbjsWwQzOgwjr83t+Nq/0iDcjeeb9t+fHid0QZYkIDXrypuCjJQgRo4QRz5Qpf9g6mCmQczxtTEYhKLSSymj81uFLGYenVey8zryb58x/mYVSCv2+3TUabKN9/d/6iyhsQKgijYJ8gm2sa2+eNkGZtjqxEdIyfJDceo2b16qjZdAFImZ9utii4auhhoMSWqArRQzrscFcwMKAeFIwEI0TW7YiBS2jjQMQ3XEDBELf4fN7sMAhYAfjUEJqK0PecWFxaOgvCHZhN0YGlhaXXgxtQGqo+UgQsa2JrCBw4ENwPKBl4mTM5DtjU/b1jcFPJc2hfz9xKlmr+Udvl8FfgyWUkD5V/Mf/bB0kV6SD8ZIbvkjHyQv4QgeAgUKgoCAPou513MZJvbbNtaZtvGKtu2be2y3bdtZbeqc4JzwZPgRRAZ5AV/WXlWmVVnrVkP1pcNYifYPfaIvWK5rJB9YX94fd6bD+az+Dy+lK/ga/hHUVVMF1dFovgna8i6so8cIh/LLFkkv6rGapJaq46oc+qJeqliVYrKUR/Vd/VH19CL9Eq9Ve/S+/VtfVe/0CX6i/4JIdSChtAU2kEfGAYTYCYsg5WwHrbCATgK5+E6RIQ2pLBDuDFMCHNMVdPFrDHPzFvrLNl+dq09ZWNtjkNX2nV009wed9xddFdcpPvjq/i6vpef5Nf5M/6hf+GzfRFyrI4tcACOxSW4BjfgZtyDF/AuRmA8FuIP0lSRGlJz6kZDaDTNpKW0lnbQETpHN+kevaQYSqMC+kr/6bIKuKqydT8Ie6/xrefB2sfxcNfaOHjHOoMoSkljC17spkGQbgZJa9IOFCUt7KTE7qDDdrCD+5ye+bb3O773NofbcWr33t9a379+v4PmgnkPc625bD7YfLj5aAkk6CdYiR9jP0EjdXyqJ5oFTCNZGXeCZNz7vPrcS9mWzYld4u8fe/Act2U21XOec80NdhFthe9LGYVtKyUwv18PQ+SfCQxxrkdzT8YD1ANRK6Wb5QUnDspznsIvBP5rwjXsi6KX73AezX5/cyaYyPafsWmiW3iI/YQlZVc4hRvLJbB79gYmylGMox52zWFU0nt3iFs3LcvKWrYsS54ZcFGsLiurro4pWyRrwhmh4KV956t/70ulllfNw4XbIprBUGG8usChAoVCtbqP6ppAJ8P9kdhEljIKI7WLWKBLCoPuU5vQdMaCFP9IfmW0oYhQtPyY4QiJgqtWKSbwraFYePPO91NDsYjfKsWC+hiRKmu17fhCMagbhO7wTicUvt7BKOSqT+p59+oP7QvKrQrliVuEGZvji0/qao6V1TYcj5nPv2hfT9rdb2B3FD19bBxOBf34Gb+RI9zM2ZPqp5sbFO01IeDAWb7WbhX59O5U+JB31RnkrNZJvRvQZMbClIAoDjm276cTKs1nVM/AB9IsmTJcex+3ENiimAr3UHGBzQQ3G0wFZ0LfFVqyj6UGN/wd0ahdcsMZRPMPDbuVcSbuMD+eX3LoTAMLT0le8gXPi4tcF27hyeQA41TBfXKv5nRdYeEXKwv5Y7ImK/ubTIsZ85Lmxcq3RhuKCT3AYIX2nAqcyycqLsaxmeUBaWx/SUnZvmL1v4CU5OjYpJL9XIPyAIa9nCbiEFrm0BDx6qv+VBgoUun+zVMP5e3kXPihjE388O4Nh0t1W0jzjNMu7tMWePEcElASV5jB/WNXLkjTZRDnm/Pv82az8KSdh+R8crSsqOzshogknkFC41MjOSwyC1lWViLnkeK8PUcO7kiO59kkJi05imvgtjpoy1+/Ay4rEZ8agskQXx/r4X+48ZYrwXpDBEH5tyFgyRe8K7NXIffocs0DeRupXbwrYyM/sXdNeb4uj9zyPz9qWPi4RTz5YYn66I2FFRui0tQKg+OyE/jisUfEyvzYKDmT+EfnJCxJzd/HixySifvVkLvGTkI7eVhz/Mb9vTOmcGx/Dk9J3aGzdx7snu6dwupTapaU8bIl/tv8LCbNjp8ZJl+Omr9zssW0ObFh8XIXMlVEwlwCfcAG/PAXAbqJuFZxg0TYLaAg4llDD0Hp0QlJ48NsSPtbGIQbBPhAxLlwG9xhkTBAxFDcLCgTuxB0t6rVD0yc0MSegA6qhFEiMrwgTAFPV6LBhXqmAQ+t8hWBCfh/QqMI4+B/BcOXHSrZCIYbfDBC8ekiRJP22bs5tiKF7Sp9//vBffhQ3kXql1zz3cdrdh84fUtXRH52vYPdLF1cB/JUMmXf/NPxfHp0+LRxugSC4sMxKti/eSBNCTjVIO8m9RXVtxpOLJrI48mEwIWTODw1mxFacVUuJpdPnLxw+XjQdJ5CfEMDpnHNIAbmisd/0ig6iJ1VJusZHcweKl+rS6kFrQmYwkBh78H8I4d1m0nTjBq3BSHpMUl8aeryxBhdQnsJqdq/fnv5hqh0nks+W5H6WSJHa5wv+Kr88SIH9udv3G2Rv2NVVpG8dO+2VTst9pRu3bNLbiWxselZ8RZpmRvzUuT8+Mx1CRYxaTnRcTIFb62y6Od6q/Okoqj4JK+o+4PoMG+evTzfe+JNwyJCi23Yi5pzr2XlgK1hD5mfnuzPA51VXoDjGYaO+xmFr7Qva86+kZVzGGcHvdVr5qSn+HGcbSdSGF3O6NuRQwjs1HYuqPQA94xRFzDFDvMIVUF3p6qytv4ElU6DXqDwgbCFWhEc8nAi9OLYHWKlt+SHiuNtLeUhn/AhZHBgkJdHwMnvOIWNuao53LwL1jKUEhjqfQf7YZ9JbjiUYylB60QGuQTMSk/fLtr+xYqtHPsbVgq5uz4/UqO7iNbqpUqOsDFhzZIAHeYS7J7g55GeuXp9trFnrnjG6Db09wxGG/p0rf9poAq4sziiiH2vNPxH21nAwAtGqpK3TdXg7yGjitF1duSrL4TZIRETXRYd+4XvgtZbBPTObdgLzR09UM+dCPViSYwqz2JVSI8h4D3iJY5EG+tR6MuvMrrq8Rpy9sT+G41Hw8fzWdiPYLeJ062pwpQfOu3wgtEOY1Q3pJeDT06fGRg0nf6d0VkRqgWrR4+gP/QZ/RBlGe3oTVfQ8iHwpUSbyfTUtUcjZapo380SXEWD9H6WQI0C8EdCebjTEZFelOe+lVTWSpcPlTVy6E4FeyiiFQz7146FfpxKyUxZnj6O/adJwf5wdSbTwECI+A/dBG/DGCmJvf0f4WXhxXropYtnKDdNhG7L+LBRXoxCfi6D7apA9rhT+1aOYGj9wB36cqTQLP1UdbS57WSYni/FpQQcDLO62qUyvcf9e9BbPkCAjr+NJglxK3IyOAyF08JgER2wVYiduXTRLF0UwV73XKEnHwALpQOktbziVu1Jf08eRTyD/CZPCq5u4RrYiiMlsId6Ye+l/PKzuoMEerh1NrC7vQeac1WdTZvcwWRPyfothRyHYqXwpRIm7SeNJ8tr604ETOCRZGJw0KTJQeX1XPMJA3v8U1eVf2d18ezvUb8Jli772/y8Nlv3t3lbRTS56uAa26Cn3FrNYB6UtOOvBm0N8yFOdWzDyExi1ewNhGs6JbkGPiEwDGsEMBHRDq4JL3edrX+rg95Od/F3HHeo+tihGNTBiY9OBTm7LfR3lNFeVBtS8OcKR9owiCV+ZVVJ1y1+aWoBK/k3AoM86y1nLEpYEMPrR713Ic8UIr0mz45fams+6qdXO2sdvnC8e+Clx2oNtlD6NaNqxdpbd1SyviIweEobalGa4oGD+TCCw265g8QHw+fSZQIf7K5pbdnjh6Z8OrFMmO/hFVcFplzzNVPz37EbdXIlAVOvwrmp6V/kpvKn4NGCa3FTG9m+YWPJEYsj2z4LkMPIjOhVKf6rdu/g+Y5pxLEh9hanKhk3E5gN24Xyi8VnrugKyE+ud7EbEndPNOFJrwtI45HDV64cCfNWrTo8Kzg6iGMutgjuRLNOzTs+gWHj3f2O/chV+FYev9t4cvFkvurxBkKBaGEcVME4rBJAEDFT+RAWw0MB1cm2wY04AjZ2uh9E4GPMMJgJmr9LkKDq4DrrVcRt1iz9gDnXoTcHRwLy+Ys/v7k0x4F/0bGWQP+hT3Aw2tYyuoEZ27kP7AjITx5CH2D293CAjJv/0kEb8dlp/1GO8wJHyWijsna0VC+2g+4EWMJgHeiDwNIetHyS2IAfHcZBaKXDjxfj4In4EddAr+VS7fnK1v0yfKl0jGU42mCBnygWYxksNOxID8gMiUoK+7J/suqhrqwDf/9naDxOYHBUv4/RrWpxK9QwXb27fK+8xqddKbLFRtE5caadfcLluxwaba8xbkwIzS8JLMNmYzw4qvSHTdBsjAfZeEXwhiv693NEDVRrf7ty/vvvAxtQlHEg+NkaisRnsEIC+QJDC5EWMgjt3Ee1F+8GiUEpJRUyNIJZXWewJiMXCyi6TLqHbcT+3OzHau9B29Q+DqbocQq6EwhV0gW9GjQM6ekMtUTTmUay7hKwxixjGJkFNeAIaZ1hxApDBR8q/bP9eTmLkPhurfTH4cM6Q+vXipuwKXZdRJAOPQj2njd14MLwvJ3xXDOfLYexlkzEje98BWd18d5XgFNKrQQifitgmkhhv3JXr0IbxkOlsDF1bUKUrksVo+I3bE/jGsgEWwlNwBRMwEz4gWAYRkAYhgsUrrVK4AzO36L6Y4/O6OwA6g+hcBBKJQyDCEHlfTc0U0Fuqq5S6S15feRUS9vxGbbcmtiFzDjGqDrZHfDqz8gZY7dw0QgjcroGMXDuZRUuVDrH6BGmyc/Ly8/P3pJBNz+W7Ej7pfPfb5L3whkBhhlmUwkGK+bCTdzhCWMJDjIIAoWBUPuP0kxdxoefes1p153yMjKyszMy8rLzZXqIZWXlZGRszd4qq0e3bv3L0ay8LPWoVgWTmi9fKD9LHcNV1NnEBTg5xVY959Bki/eNufOdKbxuN0x4P4do4OxjPAuR8H27Yep7X0pAmtaMHwaEZMQlcGqwFMMMSwSr5VnzwyzoI1K+/WBJpUXd/hAHmZKpaCM8Fc+AjaAhwM5e/umnM96ouht0QJ3Ujoft1Zv3NVqtVafVQh6xcxNwCtGI1UWhgQviI/1laot+GGPEK62xgB4PXLEHfkCxh7VgpTrGC8EYfVdADK6gOIag76vRMJziPYJ9L7mBSFukpuozLc0BNfRX7XmwFeCQSKWu4asY8egs6wo1pgL1ahoZNNkn/NAVTsHUEk2JRnfPcyKh/8+hPbBtephRAJxzP++ntW3vxrZt27Zt27Zt2zbbxk4uxbY7v2OSoyJyTBnHjVzHDXI8NyUncL2c2Mt4uYAJcmHjFibKpY1J3MGtyZUtt8t1nSYnt7ebKvc1pslD3MOdycPcLY+0m06ejunl2TKDvNDmeGaU/5SZ5DXulddbZuYBTuAh7osH5Z3BZpHvmTX5oWV2HpZf28yhtJmTx3lEtfOo6uAx1dnHXKmhjXlSI3lCjYon1ZjGfGoCT6mJcayazImcywUsynM8zbNqCs+npvKMmtbLYmoeFlfzNl5kCbVgY0le5aXUoi2vqKU6LZVaud0yaq3Gsmo9XuM/qfX5n9qg3XJq81hebVlWUNu0OZUV1U5lJbUrr6vdWlbmLU7jHd6It9Xeg62iTmbV1Cktq/OuOrNlDXVeuzX5kPfUpbyvLuMDdXkfa6XuaKyTuoeP1L3xsbq/sZ56mE/UI3GyeozTuYpL1eNxBjuknixtbMLmbMoW6hn6dumg2Jgx7EdXzM+CrM+GjKXFVvRhAy5mAXqxE8ewO4vQydY0bMNe7Mke9KQ3+zA8touRjGYUPbiSq7mI89mIs1godo7uXME5XMJubMm16tluNuM8LuQyWbjRzr4cwP4cyWEcyNEc1Dg8jlL/G+IU9eUkx3GSZuBVdtU80LIte2seXbrZpsQQQ40w2hjjTDTVrOazmJWtYxPb2N6u9nWok53mTBe6yrVudZ+HPO0VX/jaL/5IW3pmYEZmwSyaZbNa1s/G/1/Ru2ev7JvDcnxOzXm5PFfnltybx/Jc/pt380k+y/f5uVRn9fmbQ3tQFgIAAgA4c75s27Zt27ZrmG3btm3btm3jmbn2OxaSQfr/J7oQlIQKUBMGwnCYCLNgEayCTbANDsApuAL34eX/Ax0OP5HQMD4mw3SYCXNgfiyGlbAmNsL+OATH4DRcgEtwLW7D/f/n8zW8h4/wFX7CbxiB34nIKD4lpjSUlfJSMSpPdakptaPu1I+G0BiaSjNpIS2ldbSd9tMJukhX6C5F0U8WjsvJOBVn5uycn5tya+7EvbgPn+JzfI3v8CN+we/4E3/jcP4lInEkiaSQDJJDCkgJqSA1pJ60lE7SS+bKQlkpG2W77JdL8k4+S4h8V9bYGu//YE6v2TWvFtNyWkXralNtqR20p/bRoTpKp+hDfWpxLIGltEyWy4pbBRtm42ySzbJFtso223bbbUfsrF20m/bIntl7C/R8XshLe3mv7vW9ubf3IT7CJ/hMX+TLfJVv9j1+wI/4Wb/qd/2pv/WPHux/OLQHBbGCGACANZJsss9b27Zt27Zt27Zt27Zt27672u18x3yHSEDgQVzIAVWhFtSD5tABesBAGAWTYQ4sgJWwAXbCXjgEx+AC3IRH8BrewzeMiIQ+xsPkmA8LYRmsijWxEbbEjtgN++NwHIPTcB6uwJN4Dq/hA3z1/yH/osjEFFBcSkIpKAPloDxUlEpSJapG9akxtaGu1JeG0XiaS0tpHW2nI3SGrtBdekgv6S19VuFUNGWpmCqOKqt6qf5qpJqsZv9/xqvVZmZ2ORYn4lScnrNxXi7CPXgQD+eJPJXn8lJey1t5Lx/kk3yRb/JDfskh/EXC/z/EWSSHFJASUk6qSX3pLQNklEySObJMVsk62S4H5KRclFvySF5JmPzU4XU0bemYOpFOrjPo3vqmDrM8K67V3GpvdbdWWD/tcHZNe7i93/7p5HGmOZedB85TN59b2C3hlnYruVXdBV48L5dXzVvovfVCvE9+ND+m38hfFZQKpgQ/jJjYJrMpZkqZ6qaJmW2WmLVmv7lmXpvfMf4QBA8AdMNQAABn22n/Y5rZtm3btm3btm3btm3b9nYX1xgjJrnJZgqZcqayqWG6mYlmuVlttpvHnu+l8Jp4XbxJ3jxvh/fAj+538Nf5d/x/oS6h78CQHNJAFsgLRaEUVILqUB+aQ1voDSNhDiyFTbAbjsJJuAJ34BG8hA/wHf5hJIyKMTEBZsCCWA8bYivcgttxHx7Ck3gB/1JYikZxKQk5SkFpKAvlpbJUlepRN+pPJ+g8XaEbdJee0zuOwrE5ESMn5TSck/NxIS7FlbkON+G23JF78WAew1N4Di/ldbyd7/Izfsef+Y8kFJLkkkEqSE1pKi2lrXSUrtJL+slgGS7TZKbMkfmyWR7JM3klnzWHTtUZulCX6HJdpUf1lJ7TS/pEn+trfa+f9Y+tbevZhraXnWK32jP2gr0bhAvyBt2D3sFRF8slcEkcuPJuuDvkvrvf7j9B8AA2VgwDAHC2be+lr2mTtLNt27Ztf5pt27Zt27b5z777F0QNmgZLg1XBluAkxIJ4kBzSgwIEhrxQDEpBZWgOo2AKzIBVsBY2wnE4DVdUdVVbDVOz1FK1XZ1Tl9TtMHZYNGwVtgvXhZ/DH+EfHVlH14l0aT1Cr9Jr9Ua9TR/WJzALlsZyWBGrYg2sjfWwM3bDEXgU7+IjU8AUNaVMWVPZVDNzzEKz0+yzaW0RW9yWsuVsRVvFrrKH7TF7zz61b2yE/UVRKDYlopSUgbKTpVxUiEpRZapNjak1dabeNJiG0UgaRctpNa2nzXSeXtEH+s1RmLgYj+cLfI1v8wN+xM/5Jb/jCP7Cv/iPRJXYklCSS1rJLCBFpISUk1bSVjrIABkny2WtbJbtskeOyQk5K5flvjyU5/LdxXIJXGKX0qV3xVxD19S1dEPcJR/Dx/bxfDKfwWfxrfw6v8lv9w9z5M1RPEelHFVzNNj3fVKKH3V+4586Mdf9J9UqoOu4lWjp+dVqvwK/QWecfftewJTEzGw3zIz2aVyuw8yMrkONw+gwM7sYLKYM4ZSZO1rr9fw/o/104PM5vrpXo9GsJO/O2yOtk1AHP/29lv40REr9qdRfStlBqrbyQBNg4FB1wA8sotUBi8Xr6ohfuJwMn2E727SGqLU5LMapX3ziwGjxC86gbuPFgcEwooQbdqutKcxH1dYewuVowMU4znUbxbbv1Nq+zBxtMrBtMJyqDgsA25qrdRYbzKhqOkkRxrpIHaMBXILndYy+I+Ive/K0X1UivvvWs2szyAu9xIWxArsGD/vgXJyQhH3ONov1LmeZJYhznDU28wnnKPlglW5V5zRGeLDBio+u4h8aLgad9X4i1psY3kVHeuSrCYLxtj5gC2J80Em2jOihx/uAWxdGAgNf6SCY5vHxxcIpgv+mCnfKbA9zlvUQC+cJWh+u1nKWpRiR4Gz2s93EKK0ORBjrbGehJVh842yx2fKuc9tnDIOdBQHjstTZ64OFjwGmnzH07VJRli7w8gnwynMtBWM/T514N0+dOJemzjzfWRpgOw1qj83iJK8Fd4iMEe8WCEnAnFzBdDzW0Dz9SADeVT+q8jo3ijE0RofqZzE0WocOSj4RLP8K38Jn9VtfqnJvsJG/zs/4rN8r9aUo+Ev5JY/VKIzuIIy4mQaGR+QKw1fziZe42tl8zyYw6hTP1g2hm/w1RAdeEyPP8noZlcjrw6p8qYjqA5KAX6QB04Rc8XxbkASs5H8Oiw35wtTtGDE8DiThdhpQibKDodmxwlAncbg60TamSelM6g41LgOG4xrVqs773hYlHqyI1lXeJyYvyN67yqNvqwI6Z8OjXoklHcEU+F0aGEZeBFfxXH6JBUnAKh4Ti9o8BRYXuNkI7sHiZL5g6twBTA8a9bnmIAm/qtV+ca5UnNRRG+HcY4Jt2F1V0L+9G5hKharwmwrBvRvPjRCSXDEb77OAXXaoykfZZRWe8Qk2HFOV/Y3orGZaHJ5Crlwu2v3eciN3+FZVZDNjjJoRMCLZaRQB7nDcLMEXGV7CprfVwhRwg64l81NCEl6rHkM6SUgCDgzG+LhiorDYoD7yCWJ37CzMjCqXQOVSwESVSMNWldpbJwstz9tHD1zB+xo+BZs2Pl2+Pvy6jvHoKpXSG2RVhmBgtvqjJarmAHbgfyVb8lVTC8giTSU4OkbMayEk4ZizxBLzcINuNQiw5qp338bQhnh3p4v6/g3h48RyXfOdAqwxvYuOqs/eZ3OBylPNTfcOzipbcNXZYgHaqt68Olh4dQcW4v25N3WzxhiHPT2Xu/mP6zvCdFZZ21Qd0TA49lM12Xtjx1kMfeX8pJE7eZ+4vSfuE+9Ppx5JazJoUpPGuk58iOzfSjBG6AG2IP4ylsub6dD/abH0DJCmZ4d9rjQ3+NnZ4gfiAzQS5u7OlmzmPB4h8R6e5JUHQRLOY4EfiHlXipn/d8xTMdZi32eqIyOAeIGzOMB8KheudBTuaeQwdsBGzi77Lx45cEXV1I8UC7x3/Y3PsEZD12+j0A982gJrTA6PjP9LypZXMgXDDJWYh8rM4TPNRc1lor2Xy48evFwk8oODQ4aJCfhKXRxPG2cRITozeFxnqOO0b4/jaA9N4tpsYQq83UEY3pAGhttxgjUqNldsKYeSCCEJnIiIKA1R+RU/aMyxbKP00w/YxyQV4hG5XLp5h4TJOiWJQhJwdRowVXDCZrGFH14jOCZemy4kF/ijOmQDfo3nZ9Z57cW1+440LlLhN/RZbxlO9uCS63pJyAIc6cGzN4LhRSH7Huq5rm2YjkuI0W0a6wKvLrgegYnhOgK37BabhNmGMz9NlekCE7CVF8NvX+H936QPtUUbdlgrmjfy1Jw6GGG2gNP6FtMWcESI7NUMGDhO9fQDi0TV02LxvurrFy7zI9zeNq01VF4Oi+lq1f90lCh7dQHzctCrK133IRjhjLT5KkdUuxS2mZRDbDITG7iDGeAdKrevoAqfFPlYcPdTzhMBM65YlW8JMhjXBupKhLGuVANo2P/wDcc6b5OWTwDeWQTe8fM9eOs/+KBDlkwQDIzS2gcD4oUk7FE/W6x3qFuWIM5SX9jMx5y7yAfnc774afnLr3/XcKbQ9S61+WFSeGdKRLIkRTBOBGNtQaz6K28GkMBUXe1jIYsDBjgcq/zAogVWWVDchqwuzMqwwSxV8TQYzktInvvwUAoQX8YX/Gw3YWqr/AhgEYm7LcFiCZ612TJB3ekzhntxZ8C4pOCrPig+AD8FiwfBj8svXfpkrtCNLuX+NNEdPDVhu2BFsfhszYsXrlOb/UYO3j0tPDIhH6Se1RNkSZRgYEv8wQIWUXjdEiRO4Kc2M4bi1YBpWYpoG5GKf/KB2/TVZlGaBJKAtRy0BYt5sYb68usGN+prfal4b6XQ7zUTGKG+9AOra+pLy4ih6rpt2j5U71skFpvKPPVtnU2m/bh6NwAc5IvfZ/mMBduqH2yjXnCGRhgR58T4qB+mmo3lNV5f1BNAL5TrlKIuLzwM+kovwC7OHMuoD52JtujXDiQBR/OvN4vh+cLU7Rihd0cLycWQ6rssYKEbdyCeLyQX2L56lQ2m/S/OGKWuZpAFJ6tkeqvIecqDc+P1Hm/XkQuyz1d69EMbBM7wStzeBkyh6hUKwz4V9IGrOO2UtgBJwCmFgugVJ9bHbNaUiZ1ZTFRXLGOp1cHUp6ZDUVOQhMuqtl8UDRVHdOgWKHpSsA1jlLSgqK1bGaak31QI7q1ZNBMkuWIWv06wywwV9ii7mBuWDUtUWH8jIjFocXgK+cBy8WRw/hbucFHJbGa6M6sDRtRWz0SAOxw3F/FFRjiP2xxlr7o7BdywdahhCkjCZecM6UyQBD5K9XHFxGExQXXzCWJ39CzMnErmQsl/epY5QPBvOvVR/VqBkxnfxnt66KAt3cLs7Db04255dfP32vxw8cTmEzvC9VCvHq5CdoDUj2a5BVq85PrR5YBznNk2GFug0FiMA/2aJyaCJOznFJOIozml/Fhx6aXPGppvs8L/n2+zUi50+3IKPdTRHr7CmVy+1uHmMYKokDMZVznD6UcTQHKR38HoU7GC6WA61XCyblWHj0LW/8vztYID/S9NDu+gEzwmELblO5uVqWrhzPOL0hiQhF/Uz34gPsiXJu6pfs5mLuAhEe/jlSjNEpJwjt9TiGdggcXMNwXzVIyz2LfCGR8BxGXqRoD5dC6Xur6T7ONmDFfVttt+MwdK8Qa/pXyz7vTr6G3ofmJ3DHSNlwrxnunm6wJZmiwYv3C+IT5I6YaZwlJZQXmDmcJT3miGm+vSNDfyCWLNYJiuqcI8USGUOTd6JOanClPgWfWtH4yaXigMx6gf/a56QN22hb5vhmjeVEgCrnMW+IFFP2eBZUSJs8pnxK0VLnuccj/7b3Ne9zF/7Ey1mbHKWWIbj6zqmhEQmQqSgE8VCqbH+DZkMZrThREmgyx5VEgufsbnbconXcU7z28+ubfxwP3Pj3o7zP3CYnHSPG+vBfTFSljWgF1/ruU74Kq40vZVnDk4o5Nodq7msnMGFTUWBKSKCEgXUbBRrChVVCyoKPYWjbFFbIkaFESxIWisiL2LXbHGhn2zm2xW8w7/9/rt/5yBzZfdr7cf3Dkzp957pj/v8zxSl9v4cUS/iYPT6KERsZuCaph3cPMX9YeDxTdvfZfibMb3lHiTkqPevA/t9KPkRea96Ed0UMW9gsmX2owaeJk9vF1y9Rn/bY93O650FFZnZy0d64B2EX5I9TiCLW93gSYURchST5KXew7drSwd3JHGEueUgYH+yWVvqJIMbuim8rN3Gz97V0of3tWcqgp0aq8Rw+ffJCEpEQkaZHxYnqclwcEFKnh9XQke0GT+oe7b9QOb80pPW38OPYMfI+0dhk2pbU2VsYncK955+/rOcTH9JoyNpqP980WwmxnkgXWWxbfXM/1FZX5/zfh0n6bsZ2n31ezwgfvYTX17oATsdKM+gQY9/463WcXpnBTfk7hp2Yk00U9UHvaWHlzYem67vnvokYmXGQuXRC1N3PXCWkVe7C++uJjeJd0XDchOH2J/ZnRkkR+f8n9gRcVIlUcS23ESTVwtSUQZOk/rshPGqiuw3rmIP860d618Rf789bmK99Y/9zn72XqK9b5N33HSeq6k5PxieqMotftXepU4932/825r7R8Fdibtp/cJb2NteXLQH7Pp60knpvpbuyWNDg5J3XdzHlUy4FArFkP+8+qKih+tS7Qfe15psZL+HO1EsM6c0HDUrOz7OVwNh3qz2HdSvGGvBVpD86vYvIIvGxLwBpvQWkQVr6MFrgutRPBBm4CNwqF5JDZnS2wtKo6Gv+UJ5pH8wlU7y6w/gv4YdQgkJ7cUHTiweewA+lL8qee5tk5REUgounf3vox2JH7GyIzJ1I8o2PKQq/aXgweArNePwlsBpAfNxTxQhJO5+ZvKHHY9ThbbDByMdjn6ZGwitOvyREzAl0LvOZOy4xwyvdhOheOzVbCrvAB1VureYsys9FFRDr7pp6r0fRBA1lwRsMdliBPXXBYw6YD4aNfxB5eKM2NW0+/FX+aGXUTigA4hHthUHxrT/Wz3mIizwwlqV92BUiUOcueWSuCiwyoC7X+lqrWnuIqgS5YGEwkI+WWVtzcPxQYUJxK0Hz+4W/C4Q2BPFRwLXzMG8RbJ9oIoAUbIYq0/LJ2jgnznLjTQN5H7I89FFtATm3ccu2TdSKBO2FUUUQjpjnXo5GcbyOnikrNni5N60ckkKmVYr2zt2neJwXoWCU9K7NEzefdZus4tmzje6gESVYYYbTdoPWDxfC1hnIQCRFsGS+nRWgIss4An3BGKzqw9UM7ZT40DK1FB4h2EFppBsOHN4L9s2Zy76huKbfAoIz+NU3eSm3sPVlzaOySYjiDBbKzIpAOMSVUG02ar105uqTiqRx7YmHPAYe/DLHHG9FXrp+uj9z+GetHHgjugCJ7Co5vFRy5bn0dccHfr3tM1vnD4KV/q0nl4T38r1r0UAgJ1g55q2ZYDl89QaIyhQu8hGZMSHaJT913SoR5sUhPPTynaaT20fdvefUWZg/sljRieThW8Bh4wQl1vzBFaiOttc4QqHKFCneZYh/CyMMOdbTmyrfe2a2qOkS6EiDm2dEHBBrAOotmlqfir9fnb6NnvhV1lG0qOWt8HXcN62CCyO8oL2bF5dUnRznMOF7ZlxIyYPT5jsN63m5CROH9CvLU3+RNGq++bNye8q2zsooJcUQENF+uuYsSiMek9HWJGFJ8pWb1l51697KxQcmjV5lPW0o4jyPDPp2Sm0YExQtKAnKT+1pa3wqAePWU8UH9p4cj6+nqWhF/nargCvvJUn7hXe1c9xrAPT4jCcmZ4qtWPMdz7+QevTl4sJxk+91TPVKaJo6at36VDELk1dWfCBlq+ft2u21boSnZ9s2473X2ntxiUlOSvYwTpM3lCvy+oLzm56NsJMVaMIv57k25R3pHoqVaW7L2rQxQ5m5d/YjF9SPovyc4/bYUIcjd1byCNCdgtbv9m6ggduxL/DaPKcujAnCmj2a4LIiOm5YyiaYGiAt8bfdCq/ng7b/8dfeRVIa17VE4nB+yBjaAR9NZvEegFMkjQk6fYEKNoKOk4ITUhdczW4xTKfIeQ4uykvDiH1gMiUNa9CMpHIt5d2b/50EaauHH/mDMObxmpvpl+ncA47AyemI2TsDO64hQaQnAyy/CAHOpmNFHvkTtb9549XZQSQL1IQGZKn57j992lyihob9kGYwWwiJk4Vrgj8o0frncSN0AL4Q/XPMXCnRJaxC07pY5hT8TJ2EJwDf3erArNjBAVmpp52FRUzkA8eKoTdpbO2u+wv3R1/k79RsjpMyHXhU07Vpfut343q3RCMb1xvc/pkFBhU0bK6mEOw1JmTczQQ6737XM9RJiYMStlmHXYqtRNI2ho6KneAvSE+mpI/1O37hw/fvP28f6BwXF9AnUFO0Gz2SpkVicJASKO+ZAkKPgVJHixw8D7w2NibhjNVfjgjR/IY9skFf7JG/+J8HY/z1aRt/MXoaad51ENf28EcOaLLYAzX/ZVv+EbH96wDQ+YA5Fq6Y61mwv1zZvX7ii17pmxY/xmunn8yDXJDskjZ44fr2eNnzEy2Zq8ZtTm8XR84fYZexwU28dgNXLU45q5sjFJ4jkfG/3UVbBG8BJX4Ro2cBZYWQ6s4exg+NwCa7zZioLjeVOWTTxNzg0stBzXzMxNSRIsuKtCD29cS8zmQYM0WHCnlmDMh+A5v6b4/8A1TFLAmSfw15pPbe4v8Cf1isbXWc0nxtzdEq4tZE0Wb9WUDGMM+Kh4CiQ4BbLwjNh80E8IJIYP+gtm6RdqJcsEP8GDwGmU8TRKQidiFr1Rn9h8vHjdweojm48Py93Cu8yAC2y7I9+GDZCtQmNsfOoUfgxNgM1M31PYGD/GxmytHyvhf01O9RV43Up1e0HB9h1ZBaNGZWWNGlmQtV2HVPCt6ZytObLyzdu315aPKhi/XedDwnK0sh3q480GPAjL1fMpwsHCb9dtd9i0bk72Dn3C7sKZuxxOH9ldsU2PLhUSsybljHSYMG3lhpF6QWrW6nQmqhjRfTTrycj8RYXRNm8feIRW/uU/gb0qUHgBFF+wMwVDDF8hgCU2X0HxNbKxvnrBlt2TKFPglqtmlIDrI3SF+c44H119wNVWUlsCc8D1CSsZV5PMdMaZ6OoFrjiuJplDFAyFsYaH+hfydMDm/e7lz8qz9nsmCD/2/4x4HRmXWJXgnlCY+OSIwCISfWA5XFFBePgYBLDzeYJ2WMfbiy2Fx95QR0dnSFDfXLz86u2ZMNeOvcJc3CIrfqCgYF312W7ynYdwSBzyWihcvTavyLpvfMFA6oljxH0Qqe4T81fPnjx51uwJ+jBRgc2QBadUeA3kEh7vASK+JnDTAouXkCfYWygXH0FvYSkuvmJ81l3EurhaWCiiCKuFSNtnooJtIdnwVx9duPTwUY+Lvj5Rvby8z/V6qntDK/VoccmRsuLU+AHpqQMHpO8up0ol/MJeRwtffCj8vvodTiLo5NsGG2DDO51AnqPbuhElCdZgoPrztUuvr03c16dQP59ffLHS+tOQC20LqNfGjM3nrEe2Fx0+UTi6N30i/tzvItq1DYvq2HNT4okxtOe4tN7+1jaHo37Iok8n7h4XbU3IHN2/X+a2C9RTZE+UvcCOLoU/qtGpe6/dKNlz7kJxUmhYelJPXYHdRhfooL44dfShvjxyARmSOSahX0bhHXqTVO7Yeqq8aOwgurDiK/J933I35+gEtKP+BOufG/iGLkAvFVLACT6DNEhHJ2iDKZiMLbENpmMaOOFnkKRfrI+BKACB7sDmFwQIgGCwwwYYjhFYH+0xSFe2wGGGAkFrXIb84wTLhDYWSMWfuS4kDX5G9hHCRAVngzfkB0r4Qw9JweWwD4r6ajgHPCA/XFNwGhRAUQ8NFy5kGzPBB/LjJCzKZVUnQlfID9VYph8U9ZFsUnS0pEBED+kKFgVJ1faz+moQ20N6w7eMu7N6aHAYPGFjuAb2uJFlveZZPXpIl7AoQ4J9NQO+w/xpGuxeqP2I+Sx3Wa4EvbBomrZwBOu7fAS7NmGTSEmJh7lG1Q5NibpqVLXU4mGEURWgRUGi8aqlFA9Rxt0WLNnPIbF4o0F1m+ZSfKaGf01lNU8bPzdnSa5R+Xfap/xNW7dt4j5oJazhJnRVTwC7lond0U9Q4g0/HKveIH2TJagzVAslKKHAkfyXDMk/F2uGQ3fhhBbaCiiujlVR8wxGez3zWRE5X1764NXpeF/qaCPYiKDH8zbQAlo8/xE8KIwh0NztOTpRaGkbrrbvH+3p2f/cH+gp2EmUe/N4fM4QXbTa8Bw8duGxL8ORJcZA7Ka+LDv8k1491tmWT/CRkS8wwPutkS/CI1u+MJwkzZmRTmP92I02S+JBni22tS14pASiXExw/oOLVgLOxkIVklyxkvAReDCOx4tXVee1M6Ntm6vXtDOjYL7GMvVEgcTlFDzss6l6QzsT6p/NK+Dsd5YXR8zXTGfbHv6KOZgGeYkc9oUV+J5hr7DK2KJiI//ItvrnT5eS44v3FF9xuHs4uaU+Dm/3INjhQTd+bX94GzrQ7wl0ZDKQ31GQ8YbqNCQ1OGhYyVu6HqYREyd95mICliYiyrFIhS9YYGKCo4k+3mXFO2ANvy23hovueDHW+zj65UngTUxA8roLB/x4Lxx04pNhgjSai4kFXK2ZlNMqtHHFnJoWHE/kCHiu8cd2Em+bYrxqZ4J5vzPs23Hk6Gtewpv34SWxrSSFfaCNoTpqfKWuUdfJXGlp2Dny4hJDasHTC8anLXkKrljd3KyRYagtzZVFxu85jj93vrpU7OD52zC/CeUvWLR65epVuWs/nV4zFqPMBfJ2WUZCcwmremkKX3wPAY6/zoavORtB3rfwchVcJmYFmIEf+Wlm1Q/Hnc2Grz68bv7POGz4GAHmueM2Ejl2UcDlLQL+UmU4EAWasyl7t15TZvTX4GiNjsyMq3AQ1cSsOWRcO3c1EFApo1ecMrnxg0xa8jaTqTDkgMb+pxorqu1UWOiDHviOHcTVdkR5VygFVNvZnMlc9JqHbUfjuEDXT4fhChG6wQq15EkRxKyCXsseNIMs226xloJgfsCFhdQkIwgaWmA23BBe4Q0WnH8lwuzfMOxX1TLsZ9Uy7PFMFNuAMzwTVuENLLF9Kih74cRcFejPt+ETpiu8NexcSAG9mL/nbAUTocEnba9iU2zZLhAlOu/tCnL51IFHj04n+9F5JDhmRBDt6PMn8eGpVB99NgnqkeTt2ffQRbqiw1yC9m8DwIkq7xdL75dJcLV6nZPG1o9/rbH/TXmPVRfy9vBVcFqtbze8BUj/YPe2Ou6wVhNO59QEHviu6CJV28E+s8yWxTneLDZ8gtE9erMoaMpKjX9gbnWBkwYWg1quEXBZ9v0fINi6h0CQz1vsuIwe7RBP0GVB5/YYbE0m2O1Re+i4gIYR42p9myfpuHzABZCtJQQal1W8WUbf2jxVw5O8WXAkCmVrKsHGAyM7LKAKCyeyK9Vp4z36q7CC7bIOH+xwU7Wd84c4I8qXxwCXMOoNzxzMM82kg8lJP1P93GzjUW3XnuUP4vm1SVy1r690EP6SwmOXcbxVvtkjRPpKp1ZrCmxYrRkPvdXqmD2SAq5GCJdcYL43BH+w+9fI+wq7A2hc73UHmoHoVcUjhBTKD2v/ONWs9WMVPodmpKosPsJ7UFInXTH8q/tYwOnhb9o6QrkznsGjpjSjlvkhvjFbWknVEbOlm67wkPpxuDxXhbZvvwdHfXnHBcSt10B3tB92F+rRE5D5GDOLCYi7Ge3mxbmBnnTu25UErO0e4WcYEuCIXSiPfAbebwWBlPV0ivXU6fVTiNEhhEBMx6fojm3aeuLv6QImi3ly5vjrd8f6ok7TcYw3jOlPsElcL0eXPscfU66oQfraG9pTBc+bpBTONEmI1xQIgXILvCLfHDm6/IjDs/KenXUc+QZGEvioyztsFR/7+bR4CoMg9rFtsjfEfbAjCizsIsGN+3EEY156git4PmfKHcq/U48NkifG0CQ/c2YIbIT1l7S/bJLizHBtObS2QHs4KUAbPMkOXNwg4u99u2LjtsciXozX0QuvCECML9X7h7/7noI3zkNvsfOgA3d0BTqY3xIak5r9OsRtkZ7hvVeEFo9+o+Fr9tvvKfL4Nb/7mQFfyJ2vQpPbr0HRL7CfFvsKP+qbODk1nb7csqdsHT2y7uSic1vsn5Pg1K6LIibYu47M9upkxUSCny055QzNGSoLY9Uj5PuSC/ceFkb50/7Ef1RUF++x129QZTQcs0Cd08d/uDL2aOwGfX/B+tIy653Yo34UPzdFOjNUaCMezEtJHjJu5DAdnUT4a32wiHuKcgZnTRg2REeLqGDaZslcgJMZ2UtjUEC0Cgk9sAHGMbDUiCbKF1CfnzL+8Ab9q2BpHyMaK8l07DrPfXbE5NhPZ42cPmHaLPs4XCqCByxVt53Ie7kCPs79qRm0t4nibyKth1rWxE3LW0qQPV+CFHdMWSN1zZTmDZAU9oEC44mTxlcuc/y//zpNYR8Yz79ZRLFWZeThTTEdHwmB83IyUhwUkMMloxkBNzwvnBDBBc4LtmbPjbzWBAPwNgbAbaENmwkl8wxve1Ij5p0ilTWKhlRbNMuzWbieI3mBGW/GSJhlYUX0AbHZLRZ8obmN/fq/xQbcq2c7cVbPQDNuNXD7keyTDvDRsVfwkf6eQON+L7Bxv0HjBmVSWOqBS8nhzMGFfVhQoq8bNtabE2x4rAN8fLI8r2ybGacab4jqD+Re4cVHD3ZF+tGOxC+lZxev7JtXKVxYrL4m94srHjzdFNGNtiNds3p26ZJ84T5VeKgi00jmwVLcTHImjZrb2yE8+UClDmGdsDdB4Vw3qH+ibOW6HRQDiTLS2MD3G99h7rZozORJHvzVV4LR1QNYJ+slokBGde7fKq2XjPe+UiZcSuFBkrzftHH2lRK+0RTo+41mrO9yUVsPyGRhx376cfhVJDq2hCE4sQv83hYtPufSMCoe5jKcsSMTdXQQFRhUrMEw8Tc6siYw5O/2pOEBLio0+mf1DjZgzZae0WA0eX+WjVPTjMKQk5poUD7Gpyc0VEUeVlMGmXLUBg+ugB2Lliwg3QePiHTNPP2IboF2D7HtYnJ357FnFQfTutMFT5YRsPevwEaoh/uiAzWBcl9wpKyTr1gnv/utNcUnqPhHoB2d93Q5qdi3++rtA6kuS+gibOcL7ceSVkNSAsOGlVygyz0/J1j3bhg0orVRcx4MP5FihtFB/1wyRUiLpEnQzXIf/AVoiv7sIMUpYruwiNYhJdGnR+nO2F94Dn9Wb5zMP0ahHvbDemKPxNJzutIb7qOb+vrgiRc6GATE6FtYPy5hUuJICg3Aeh6tF92jonudsz2ogsfkaumxm5U7EkIpviT9pk7tQSeyJ3FUgOnGYSOBroZbiIYi7kMB9oVo0NXmJuBGwoMVnIcaByu/0EyE29jOEO4AooQZ3adK8bACfVSQ792ABvpmcj/jOIO4TxbuOFjBIe66oRfQHsXgCKxDp1StJ6d3l5w9X5zRk2YziDstKlu78V1qsD6ehCWlRUYlF5+jX7tMIY6VkSBTZaDhgh4qeHBJYFgHDOOSwCQjlgf0kmyxORp6EKX3JMnEv5dy8DtujhY3TEPnQxZ4/hgbGTZn8bRm+wobEYXnc5CcEQPshMc2yRt2E5zywU5QkmHdfx/wTzaa8AcJgv3QTmhOoD/UE2w/EGWw0W+xNgxy/2+w/zTDbYM2FFbO11Jmar1hdA30nwJr/7eg/2RY/wULqTe1GDvYb4vDj/hvS4CPBI5cJBsJU6VkWPPf3+umVv3f2fHJhud/uOOTJ0nsx9fu+GS242Hlf0W4vDJ30aIVtAXeEWZunl9Sbj2NbVWoCy+F/KyViZHWGkXz1OlLls+kCj9wMFb9l4cOO6iSYQp6siLjB+GJTfaCElZk+0Ew0YscDl5A+KyvJQ5fzKpBL3JqwYtZHLsA95xFGkcvcjh4Ab+btVPj8EVODXoxq4+EC8BjbqRkdmf41PRn+Nd0aPjX9Gj41HZp+Nf0afjUdGr41PRq+Nd0a/jU9Gv4s47fmEgqTNgtMZCQ43Rj7tsoOm31EwzaWx1zj2203Nq1Fl+uDV70LtRg6E8q1gM7qFejck3DEZCGLO7Se6tmuEK6immmnpUrl9DO1LMq+AzUkRoGwR5umzD9VrtaTGaESfKIJBPzt80ucTixbxNTJPdhd103rCJBQxKjeg7be4dClfsHFjCEI9AF1sVL0MnmwzCa2Wxuq2XYEC3NgRUqyBuendfBg0CD8KIwbDStYyxFD9LhUOwLGg9uKjiSS+vyiovX50RQdCQROVPS06fmVVBjpS0wXjIaoVugNA+2GyFDpBZj1L0apFj2argjQP1Ggp8t30g2uf0QyXCy7NFscgf1O41lfqfhzgB1ncSqrpNaZg6RlBqQp4zDOCb4k6mtMqocWTKUY0ClnG9RoIGVYz+prAejMlADEwKC2Zz4xJcDzfU0Tj4f0VaDRkZVvgSp1VSNIKkTJqTS0F6PxNuHSm/q94gCi90kSMTPWkqwFBcxzGjfqbFa333DJmvbNuUzv5wJo0dNKpEYRYT9G8LfA0fgjWOH17yzB85G0YkRKyATB6pQH9qyOiGuIS8ZJgz1sS2rG87prbCUE7+Mpi7cUSNBYou+NeKCVJ4xXePqaB9z+Tc5QYG51U+CocYr9W+2Iu4s3gzVxk/qq24upI+FLxWgfGp2jdT2mYEGtMKUkRp70Y4myE84PxEnsnOtN3/JduX72teYCV1sMwWl9L0FYo2bEGe7KfzIldtxNcrtOIGjDyYJrs0vFvjYsEJjm1V4K2Kkkcex7u62PEHx4ip4kCrPvzEfCuITR4aHJm47enBL3sXV9MJq4acNZd89sr4MuoAi2gf09KbzHy8lR74rulxRmjlweNak3rNpxCyh1eSEYd7WNnej4WOqrIcX57Ueg1JmTUrTXUnQgSFXKQ4GSYWv8PcPYCK6kA27S1ec0sI6Yits2PUB2OtK5hqN/6/VNhkvnLQB32qG5s6F9SZEsRUWzVcrThSe2K333VGeddHh2PFN+7brvZ8ZeZ3wMQlPiQ8JHFl+jcJjN3xGwlIHBQVlbJM64R8IiheDQaQKFFRXms9vkUb0f6qJORr9u9Euoj9RZkyTanhuicZ6s8O+vMNrxDQOyDKNAzqd0y4dZK4CdGnPY+jPfgLkGp3U69t3V15M2xPdPW1IpO5EfsFX6p2ik386l35woI4qdhBDy1NPU4xjYYoqAvLtG9Dw/e0wp9CJw4dm0GM5uyK7WLF1cCe0oODH7jVUgcnTpOpPsc9FjT88GRY2XYukkEzzlYFNnk1bI83NNfJyoWvuq1wRk3MJ3ej914YNvmwoG+fUok/q5HI1qaVWTRpapw/TpX7OBKgldfbWlep+VNdS173u1Loz686pu6buzrr3676vZ6nnUy+5Xm69NfXW1btWr6reH+w0puVsZdfWztkuyC7MrpddH7sBdsPtVjEd50a7nXaldvvsyuyO129Sv339TvX96gcwlebR+mfqP6n/WqgjqMKngpPQTvASfIUgIULoJcQLZcJl4ZHwQmwodhWXiM+JM/EknUkQGWrqKFeRh/aO9m3sA+ynMbXka/s/2L9r0LxBdIOpDZY0ONDgqUQkWWoiNZM6SJ0kTylUipLSpDHSZGm2tFDKk7ZJB6VL0g3ptvRU+ossMKM4KreRveVwuR9TOaaZGseZ8gKmcVwrr5e3yCXyYblcPiNfkq/xC0I7fkFwCX7FEuAuaEo/TemgKd6a8p9yeZE5Wnhi/7d7CvXpksyCIpUHdt4o1GGgcVtwEbGJrSk2NppyYlaEba0QPmHG1P4Oo31FuZbzmUfkv9Ha+0syXLTAYW4L0S6EjYhX0RmuhmiQYmsrYBmRuSWP+Sz6ya27DBszJrt3J0cyB+fHODiGhqKTHsHZgOE/XTxQcHArDSc+acO7xSRv3TuPeojuK671B9EB6xos8P7P7guxxDO5X6kmQ8pqSa61PoMC9rPbv7oNTWsVCPpkCa2rHwdDSwcZKuaq4PryKUTq0AAX+0LHWIJCQmyb5nHn4BPTNUQ7dpq7hnSmn79dTsDi/Bzbo5tzrVMAxrxh2AWVl0hE7iUpJkzT4dUTsOjLNYx57QmdqFw779egrj5X4kQj1jGbdwu4P38BUTp0IBDj8hRdKC4skqCt+OPxGPy9jm0JNonv2YpiW1E2Zlqe4E8E3hpb2RNNd294QvCtbavgReRl2usJ1xIP0dMrd5VcGCpFissnjOf8L9PiSE+V/s4Fbz25ufhg6Y2rWsaUSZmfU0+8LnJPvKmM6H0g/+BWvScHYXEpKcscvJnvhWBsyV92W1eG/UQ9YUwRq/ulBRRDB8WmC/dEcDM2smOhuc2KDQ2rECpiI5u1hWFledCJEfdk9CfcW0XuIv2HbjlF0j8Y5cj/qFxgR5SzNtgAb03mXMFWRiW0sVUKT0QIZmKGTiI2th3GZsZhAWURP2HrTdl6RxHCmbBBjpeU6lxuCDJRk7nGgEu84Che4xZ/eAyPwrE9kmz80VGzmJ4PppWa7CQdgD0dNLm1dsCwY6n6oLzsrp5H7iaUdemSMNCfZhP/8oEPaBQ0UTeQ3QX5e/YUTEijU0gac6pNzsrfTWUIh6JvJWbG11L7jQ+djK2+lGQL+y6m+ZBpViSrUAcGCQUHlhcUWfPI2TG70vPo2qyxy8c6ePeJ9dMnkb5bRuyYQmdu2Dg/3yF35ZdLcnVXDBC2wVE1jxzatrbw0KqRY+kkkjQuZ3TijB2FVPk37dE61CgGNkq13ndytqSoD88deaRvJA/jDnabN//LL+bTlxAguIpYBwcJ2SlzMsZaJxOvS4Pv0n5gMUdcs7ksNz2LTUJa9sS0YTO2b6XKf/vZTu4rlcIcRw38LJBjtBJsrdiTZVuCObZWgtHKvLIM1OBz6NRS+zf8kGROwuQP/NjzxU/Qnz/Y2wRF3aPJpn2H+UQmD5d++IMg/8YkS1YnaDWeaWuJXOPXZaJj8tlfXShh0nz17pkt5SV6bMnZLEbkbFJx+7m+3PNXIufg7ZLvbfyoe/zkxDS6PyP22yAHUxqhj9baXo0BUXeeosWJXZKG+5nSCLgAHjVX3b3mVTeHn8UQtUHiF5VULtvqxwZtEi1BPSMyUoJTtmuRkhwkGXPYi0Zv6V81tWKkxWGSyVVkJG3e3A3Wx2kwwZY5XHr7VoDGeVdegZv1NxZoFRqGPfKA5nOps1cwHy9b3X5cGLPn2IzzDlslCCGPJ19KP0hPvBF6iCP7CVuT47/uyS8rDJrlUhqvb3vsGkJjXYS3ULJDOlQ8c9xmil/aAoQ5WxYw2ooMc+arIN688Fz/ipwdfXjQBrpvQ+Hew9bl5FXUcRRbdI30oHNfrCBle3YeP72DhbHnk9iM8VE0pvtl8dKuzP76fJIwIjMmJmXHIfqV2zzicYNRc6jyyyh15wlh8s7vZh92KJau5xwbVUzL7gvx4qgEIW/k8FWDavicIRvidqbTeB/hOSzkc7O9cF7OtxQj8KAwJ29B4Q6r3F9Ca/Xr5hKsms0k6Vw896VkmpBulWr9R9WDcG7Idhagq19SrqUSZaKk1Ihs+7KKazGQG4VVMrjwyiEN+tcYhTUp0/qSLpe1rzrNYEZhPUyjsD9ZwPrwBnz8IOV8YIF+afOes1et0LDrVXSguI4bTME1FXzFJweHdwsYPMxbR1/R2F4fPMTvD6R2Cx2U4qejhyj7fS34f52y84L15pF9z54cTO7yFZ30eiOBptN9WADJAVt4+OPHzS/FQINJ+p2ZwoMZpRmhVv8Bw9s7D/zu8Sy6ynU2kU35cAsJDs1XGcc37tmFWsIvOsDYQRI38ppDwB86CMcPfXOoxLqY/MA8wESs6x/psoh+8XoJObJ0b2GZw9m9I/rqi8j4aRNSMihOxeHcygvyz2tRA4fMG5qpB9c+Sg8CSYWnVehFvt1duvaUFt4RW2NDf/4YLcc9I4uNb4VO/cU9o4dtjHNA+x7+SHUngo63AqAu7QiZ6lPycuu529cORPvRDsQ7vbc/jViSdvaeVZ4pKTVCYHZFhghP9bLYHZqlQ2twskLLXdDmCjSjkaI3Nh2Gjtjeip/tQ8dHaGUHj+UpdBZgHnY23B/jLZgOmx7hJsiCW49tGaLNnr2KGAHVomprjAOJzN5FBIgDCeOENyJ2hi3gAksZptEKw7EOhAvOInTAXPTGTYKyRAO7QGYKiI07R2BbbgxoXORAE/5CRo8cMD3UoWPvirc6zGmPCwm2+KEDtKs4siqvhOJKovAQY0eYIdzFGQzkvyeCc61dVj8oA58au6wWmCJEMXgc5j0cTbDtA3bew0cMIW1LObjZhY/8kV8kOi2kvrJ1hCZzXXMvSe4gTWZLEVbV2AMe2HNrmBQ0lBOaa2zGlkkKnLEYNh7vyPaGOJtNNqGTwRJ0tQCnA9jy35p4GacDGPksekZkUxbkzaTBGqlR+HFxGNf5cBOnot2a/O76LWjBUfQ2QVdN+ccYCkvdZRXUAon7DcuWXZJxxN12gjgfiX9B5Z4itoQU9jOhM07G/lgmKG2kl1w09K2k7NKmzZxV42b1q4PVjBnMwWrtDOZpxUHtGCP61yRPrvV3lFWjVwDxjBbcyL3jAv6RyDWD7ZLkf3B/lbkZVTP6N4MxJ1l9B02FLiKaJsimK5VshhgCHuAafht6lyIZQ9D/DayQnclpTa71nJNrzeJk821NLn2n19pRype0n2VgZ4k4BocL8rH7w8RhkzeW6/KvRrwy48b9zSvXdN6UTTPX/w8NeLwTAAB4AS3P06IeQBAD4ExS27Zt27Zt23yB2rbdXtfGMeu+TPPjIt96dhcBohIQNZwJINqjNMYjMBFr7LrojoieMdQOj1f2dbwB4228R7Aj+9r+HGcncIqdxvV2AzeC3MQt7m/jTrube+1+HrSHedye5Cl7hmfseV60V3jT3uYde48P7CM+sc/4wr7ma/uWH+1nfrHf+M1mMcfms9j+4C/7l/8QaqKmtpVa2dbqCKmzptiZmoXQAi2wi7TILtMyu1Ir7WqtRqACSqAOmqANuiBQIvzn5J/cR0S9dNs53c5Ptw2TLVDD6eYMc1wfFX1/G7VVe3X0G7qoq7qpu3qot/qAoPppMKChGoFSIEokXwvv7IPSGqlJqKopfnl9BKi+mvwfp3Y3UQAAeAGc1AOUnEkUBeD7qjnmIrZt2+zh2t4dBmvbthnbtm07PbbO8Eze3th8db77o5S/60wgADzxl9hh6d13cASCH395eDTqRj86MhadYQVLlVfAwAY7x0rPfmHV8QSgCgtANnSHZ4/7+lTH0F5hEcxBPe5jDunR/2S6BjOHDu7NDBk8iBnmGsKM6BFxMsMGMc/sIWSD49zKhk/OqCeHx6Ilkxnz6PAodLwoo2KicFdc7PMxeITJBGAgBHhzFa4IO9d0wgOe8OI7H/gC7PGDPwIACAWiLt4zj3m94JXg7e1X0+8zv9n+r/n/UvP22qX1mtd/q/74Bs81egAGgHAlg9sJqIqaEK4EfUhHQWDELaUwADnNQXMYxhwxxyDGbdzMRJPILDCFfF9kSnhfZsqY5aYcAs4hT7wC4cpWgPdPoC0e4jn0RH9en8BzbAJPWSPrZL1skE2yWbbIVkmWdIhs1sJTuedUHoVN1muGbNA9som2aKFs1dxTfcdOZQYEB5TfhY+4H/Ab1oMnDGihbsJlpSsufat7dS7bUVxQfGbDxRXMxtL1OgNXKF2iO3ga/G3FzW9JkXTJkExLVUs1GDj4zg3D98mwsi8FNvan8z5DMnifKZmwWKpxrMCgAnjWsMGHzYb72ewYjYk8pVVsgtVYDys2YhcMDrDZUMrmgAq4k02cTF/xZVaQCkyXhDDDJJIZL/HMF+UlOOUP+RMeMkpGMcfIGOZ4Gc+cLbPhMD1NT9hNb9Ob95+bz2E5e7qmKgS1YQXgw1ONwC/4C6NlpLwjH8k3UiwnjNV4QthbDY3RDeH4CX9gNDZit1SQxtJa+nH2Ks3DRp72ZtpGASjlyarmCshGdnKQk3ypgiaJi9cQCqNwiqBIiqfZnC9SVwsg3PMBtMJqeOKoFuMYHSe3liORkiiFirWEu+ZDNV9ANrKTg5zkSxWohpZIXapPDaghNaZ21Il6UT8aQC6OD6EwCqcIiqRY9sXzOozXD+hD+og+oc/oDy2XP2kUjaHxNFOLZTbnzNUSWC76tUSm6FwY3K+bTU/djAo4qhk4RsfJzfGJlEQpVKoHoXpQQDayk4Oc5EsVyEUhFEbhFEGRFE8zNUNmcw2RCvBkNsbTzNYIhpEULZQMLYSx8C8esDa0PcKzvAPQIp2mmbqftiJY12sxrluqWoabLB1BGTpfN2kBbbvCiKRL/+apUEs1GZcXe/VTXac/6zz9FtCf9F9mjh5VN8D1X9X3cZXSzwHmjqt/qR47978JdCqt4G80UQt0ss4BeKLg7iuu/K8CmMm4amnRBffzGaLHuJpb95375kzarIWXzVzDYC9bmWaBpUcvGZF9lT1zcd3SEzd0ivuu2Vt4ld+kGq5eQZeMXoabKF0CD9xSaT4uL4PG/5NdDlCSNEsUvhHVO6qqUVf32rZt27Zt27Zt294dPdv8rWfzf0bUXe+eOPd2TnZh8ktENE91wLdQFLdw0NwigmEW+TAKE5CAvRY+zuFrSMWH+BR18HeLzjzhu/CE78oTvjtP+N5SwHZkHykpJdFPykk59JcKUgkDpIrt0cFSR+pgiLSW1hgq7aU9hklH6Yjh0l36YoRMk2kYLzNkJibIOtmASbJJNmGqbJEtmMbsMF3OWHaYyewwm9lhjtyx7DBXHsgDLJAsycJCyZVcLNJaWguLtbE2xhJmjaU6UMdgGXPHJr2gF7DZ6ev0xRYoanP8wvErx+9w/BGOPx+zXQKu4vNIZM5LYs5LxtcsUsjFJRePXDz8z8ITCOCSjkc6ntEpAJ9Z0CUjl4xcMnLJyCUjl4xcMnLJyCUjj4w8Zk1XZhqpVJJyScolKZek0ozUGaQzm6aRVxp5pRmvu3CZUz1S80jNJTWX1CKkFiE1j9RcUksgNZfUXChacwWlhCvIvKSFoJyFsEYIMM9CsN9CSFBJ0CHBCAnmY9WQwKohBe9ZyBs0fa4ynxx9cvTJMU6OPjl65OiRo0eOntSX+uaNpTE80vRI0yNNjzWIzxrEf4mpT6Ye6xGShUeyHsl6wgqFZKNv1ikvkfWfk81GXEhWPpaPkca6K511VwbrriTWXRmsu5Lkt/IHJMqf5M/IZL0TcA78p3MwVsfC06k6FXHOhyrng3Va7OmsRJ7W01L4i8ZPI31YTyc7JZySdkU/Z4gzzBnljHXG2+otB6AKUOzteJ1YrYxHqAXEx8SHZfYL6qEBmjkR/S8Ec/W75necwhBJUKuJ9bgmhQ68eFu8GTzzHyOAQO1NY6EFfoEEiFrN89J/VcOu08LDsAGKQOfqXEDn60KILtaNiOhm3Y6o7tRdKKB7dA8K6X49iMJ6RE+imJ7WMyij52zU5fSSXkFFvaYPUUWzNAsNNEc/i4b6ef0CmumX9EtooV/Vr6Olfku/hzb6A/0ROurb+ja6oKu3S+pF50kTaSUdQkX/Gc3xU/yIKd1PkW7SRwbJCBkHyCzTlPDTPyR3QqVlAf63/Y/9Un6jICG1Q1pW6pQgIfp5WSDLAFlj2pQ2RHYA0UOyT44AqR3klFwA5FqQmRp+3gnlz5NH/jy/i7/NXwVInumLQbHox+EzYw2Kvm/3z5DvytdNP5b35SexNhl3Ym3kV6Y/yKfyb1WbB2iqKTAVCu+JNdASWg4Irw2KaZXgSHoj29MNohFtZmqT+U3tFD5Xe2g/QIfoKJ0A6LTgTmb4jDmhosOCJkGr9F/ERsV6ALrItCJ8HkSqao55fboDhM52zJll/kcgdPZUA0Jne51z3rx72MY/gNDZn0hvw2/Ls30KCD1s62fZPsD+CfQ6fMIKtvfQa7PnhnEwB9j+MatChB72S0R/TH9svgUIndf/GQid18TpffU3bNv1+C/977w+gdfnAqGz/Qv6z/UP5u/z3nVA6GxL6LqIPbPYU4qu9OH0NPPnuyIKeOaHbAcKMmxXLNGlukw36gHbayf0vO3z63pDb2qWfk2/p28jI9YvNoSxCGVicywWxXbFJjAOoFJsnbnob5FifvKV/fc+PPPfoAAEEd1oz86y50Xy97FYkH/Biyvzr7MrFQGuQaCSq++gHFCoiamVqYOpm6mPaZBphOmIaZZph2mcacpLfy8wLTOtgRSsYGphameq9lR1TI1e9JtQaBPvfaF9fMcLnTJdMF3jb3wkfTnpsxBp9TLZjHPheDNbIBMCsTFIUOSlU+tUOMb4tzEGCvt9is4AumIC2mKS1MZIqSstpbK0lsfSQHIsbkqexS2tqg3ltjbWTpKnXbSHfFt76WT5gU7TGfJ7naVz5E9OOaec/J+LeoyyHAiiAPzWQaerZs7atm3btm3btm3btm3btne4vun08sd3blV3RfMyCQwTZCQ30gJ7It2E+/AUXsN3CDGigld/1InesLzaCK/qqIBzIN3zxYaEkJYE+RuZyZ9mU02abX7VLtJsY7WRk2raRSmukZ/i2kWNokZpN+3SxnxjKVTU6mqNobrR/nfdErU71xV6w0AYC8NVTlZ7M2Hp/9eGo/BY3cNGqmlsN87DXuMw8qRx3hSmP0Q0hXFbu6rzITyHt0aAO2N8xpzPm0Wf2IwOcSGlmZ5ym+nNrEpuyk19aTD1NQuaxWmwWdZlVjZrumuom5rdoT60Njua3Wk8jaTx5njoaw5WterNqTTSnI3ee56FcBeCfj+XTlhuvlQza2EnbNb5FfbrPArv4bT5Uh1zHR7rcyKppj7H+9/XALuiFRYMd9+KTE2tyFZMK74lvUSflJrScisvlLRSW3mtjJBd9YXVWnmrKmekjlZtaAjNoS115IxWZ7W+21oPi//SU2d/GK0N1bkVJlor1TEHYTrMhfV/n0fvb1Uzx62z1lPrMtzU7sNr66MVQpupO222Y2sJ7atub31HHR4sYIj695w3g9m0dnLIbOe087vvsF3Rrs5n+TKftetqjaEltIeuMBwGck/w6t6/1mCyrsequqfqZ3JPdb75sNQ9N+7jtL2aTnNG+zxshO2wFw7bJ+3z7r6oTKfV3FUv+aZIzzft29pb7SE8Fz5VB8Bn4XPnREQQ4A/RIS4kFindPadktIbRmuP8uIbTVlQWWSE3FITiUBZqcgg/5RBRX2bmp6IpavQywOej63SXrovWWkfoDn1hMIwU+KIip8JsbxZeioWwXKylr2Kt2KzspK/8mj/ya7FfHOWP4rRLXBTXsYZ1eV68h7vwWLwU73H97xzi3OcQGVtmRo1E/1EE8XfxFf1Nvo9nC+vzOSWRDaE55P0rCztV1YwBEiJDTIiPY5IiU0NGqA3ZnareMVAeSnrJ9/U5av++BtBm9zdy2ropAziyDHA6O0Odnsj+zlCO7IzmyFzSWQkTnenOSmcuLFb9etjqXOb4zm44CMfhLFz+xbn5+9k9T+E1fIQQ+O6R4cEChqi//kaQEJJ755A5Ia1LZlZ1figqS8vefuH9LL/wsqJWHerKxrKlnCl7Q3ttu+yq+oEwHMbCZJjPVTk1V5VLYbXc6NaYPSz3wkl5Xl6Vt+VD2iw/y+fyrXqPUJOPIrp/UxLkT9EpLiWmlNhJT1n1d7cgFMd3syxVVt/O+tSUWlNHOkrd1T6+t1hfiJyqcjmtxW+w0+8w7cfMafVOGPwU7+BF7z2kx/CegvDuheWP2PvOkiNzTI7PSTm1eh9DsJaRsyPx+3NhLsnl8Wy1+WyMznyW+0NDaA5toTP3/L0+VM+Mhom8knfDdJ7Li1W9HrbCQT6uvi+4N/U/9pMFe4CR7gqgOH723tf5NlvbjaqgxnxWUNuNPse5U9uIOjNb2whq2/xqe5UsgyKo29t7/m+CX07O5Xvr7Z3p97/lX1v+5f86xpatNiO/gGfTHEy+nrwMD6G5Ads2J/IgMkey4aXibEa3zquKc/Nsy6p5dU/epjrYxuvJy8gtmxN5ENu4DG+wvqH+YefNwytuJMu5Te6/fz6muEiy8XqbE+5uPVMXuS+2sWWrJeQbbE7kZTiIZ1vJctZRtdxwT4nss/aVLP2+vonOJ6+fZ6N3viAuI/uel8a2lchn25ws+x9OcwTNESW7ads8G73D/rFlq2V4IB6MezPaxRtoNrPcs1nPD6/QODdzIg/i2eizdgovWfI+cZmVyDQ5oZ/0bz4uW9NsVZoia7eK16PnL5cs54Y8GxN6h3F2CMxcEq/Hlq02wyU0N+AyfAE9f2lOzuElmkErWZ5lY8kyekdtbGPLSpYTd5EscxqxhWfj9bgMB9E7zGL0lfCKlWxcWXxbsvRzJUveSbLOyuFHfNXGVThA8y75ZvI4+VG8hWYCh3AEH/N96jcZfsQhHC9GdpvIq2jW9Z2ZWTGzio/izZb569RNeNW5N3MEh/AxfBcnPMdZU+xfsX8jDOE4TuBjPpdVjTyb/HVx3fin9demzgnf4ih+hy/aeBV5rHhGTuSH8IfimeFb61V9fZKNbctnVCf+an2iujnRvGX5/LyXN3BfeNfmRLMu95mNx/BETxdjbONZvKsuksMXvOFvyZ/jD4yeTP6efD+5Hx+wOZG/wpeLkbUNPh8eC0P4GLo5k5ufwRP9zOhneZVzTlj36+I4etXveTYmy5zvWPW75J3j8eXEAd7Auj3HcQhf9WgcdI6r8Gr6EZzAd/ExRgfY7XPnnOj78CvrZ9Q0H51TOOvU8Cr6tsOS5f7TjK7Jibwuvorv4jg+5jkSeaQ4E37EIZsT+V3+/9JvJfJDxXslSy+y4mnqC7s7hyP46XAGfaP0fpZdLfObkg0v8XPtdEveQbLkJfX/ehjdl2Z98uE9d7XM2Z/Rfej3IQdyIDdwfZ7xAvLhtRI/C670DuQmeSvy1uQGeZaz3qp3y6db3uc5od9K5Df52um3eVfyd3ztnG55Gx3yulZn4GPs83sv38M7P93ytRM4PdZf3ViFD/05KVk3mpEsOYcx/A5H8UWbE/lbfMjGBvn/Ts0BSJYmCMJZNee7Z9u2bdu2rd+2bdu2bdu2bSsrY2Nj3u99kZFf1HQvcvpqcT0bmbfS63o/IJg0jBEgqD7fWvfdSuM7AUHVvwNB5cwDgq4u1exhQJA1R4CgbrkVEPTU/jTKUJk8D1eRlgyEoyYKUV970v1Zj8NstMF22B69sCP2QR9mPQYjdA1hOt7A91hv+VYD+1kLa48TraN1wZna1z/XJts8nG8LbB2utv3sVNxlN9qNeCl2b/Cyd/fueMUH+AC8qv3113y4j8DrPt2n403ttb/l630DPoMBKCCj57+wt3LUB/9Hjn9RwZbKPstNXj832Tf/R175H9R0S2U/5SaHN9WKlGWet+Y/qL43hXl/lMDsZ3Fncbg4JoiLVO8qDgniDNUTxYfFEend1oKNKCN3wxnR3bqiCHV0oTq6WB1dTR3d1GB56Gt9bBAGqYtHqotHq4un227s4mXq3329s3fBfuriA3Sl7kD18kE+xIfgYB/rY3GIT/AJONQn+2Qcpr4+3Jf5GhzhG9jXx/tWvhVOwIk2czPNz0ldU+r9PzQwpaVZHbCZ9spJw1Na/SeN/R+anNJemRWglWq10mxHbaRDu/D4AJjvmqwjb/BbyFdU1/CryOleSu4U4zZDs7NU/6B3w7FBvCM+IT6v8a/dyCLW+al3xvZw9MYzZH7SImkHJB2SnihMeicDUCkZlIxHjWRiMhHNYMiLq4y+1tehOcxPoc+iL6Avo6+hb6LvoH+hn6K/oO+jH0kdv0C/Rr8D2AH0GfR59GEZH0OflB0Pm39Ef5Hyd3qOrBOni+jyyEMJaqMjJsPpmTwCzG4gXb/DK0FFmD0JBLkWrpHqqAvDpUBQZ1UEBFmnb3EWENR6XgsE0+vJnGXkD5lrAGvJPDgKKK5VsjUK4tlRQhvKKENdrIbDtd7geg9FgTK3pgfTI+mOGXen+2bHw4YHARJB2131DeLP4k9kibI3RkuqPbqiNwZieNxTn7s//x4pf/o9MkHfoRfpe+cNv/fSbE/Nthe3yeb3bP6WVhmOvM16Zxi7ppK6pg7qAtiK3oHejd6HPog+gj6Ofoq+gL6PPoU+K3V8GX0NfRN9R4yl/Aj9VMov0K/R70RqN1DB318OWiMvYv2O6uZRo1T1fNU/RY2lqrdSfZy4k0a2zsyStlKcH8RPmv1drE7WzazsWPXdfNyApTgDq7ER22EX7IUDcBiOgX4xiEtwFedvwz14CE8o8bVKfKsSP6XElyjxU0p8tRI/pRwvRoKkQAlu1cglwWR7civxOH9W6Z+K9Mm5mhX9ZdVHxJlwJB5H9JdUH67HvFZndYPO6qnsXzwhy1AVpleXwZNeyQQYLOkFV5dBr6y2+r7ZWu87eTCb6Lf8AXpRklt4AY2XBXAUWReFzzlvMplMJmjI4gzu7i7/bjY4FYJrBLegv7u7u6+7u/vi8Bvu7mQhgsOtt1NkEuavbN06X9++97zbPdVdLx0QQFhLA2/A3Z05Kgfp+V9csRgjFueuWoq/IAAAN28iAwAhJCHN8mZohw7oiM7ogq7ohu7ogZ7ohd7og77ohzA47N7sKDr5tdVjayNIR9sEK+I9qaiNNgk8QxAeOvWeKAo/l50TxS9GDp0axTOjh2ZFsXX02FFRFI0ZdXeUGeNGjYxyQPbY0VHm5QzNifIHOdlWecRfow4AwiGAMGrZ2V1ojfbolOBq/b0/zfuFugkc8f2mVfSjVfQbJO6jRqyfgppoiFZVuEKW1UPLKlzJqI76aFGFK4hqaITmVdx3kyr6jRP0B+TmLl7Fhfm5K+ewMD9/SSHXfMqCxQvm8RsFS5ct4fc+O+euyM3nTz477SK5fGTx0tVL+FSMy/IXc6PnC56veb7j+VEcN95JG7CC//7sXGYH7ohxRcFS7iu0nEc+5YpVi3N5auWCpXNZtHJll64sNXYTjN0VNvZQurGnGht7qY2xt7qtXJ23UgNWri5cqWGrbI6yPiUAAp5djQ6t0QZt/Xltz2bGCOogA3ehLuqhPhqgoT31xmiCqHeke7bw7OTZ0bODZ3vPdp5NPZt71vJs6VnDswuCxm4w+Kw7QPqsB0D5rCdA57NeAAM+6w0wyWd9AAZhQGfPmp6t0B9fiDyR0u/OCHRJyQpkBwoCKwIPBJ4LFCXVSOqTfF/yG8k7kktDGaE+oemhb4UeC/03pYa5s1JmpzyUsifcMJwXvpCambo49Rup96WujQQjAyyyI3+IPBE5lxZN65E2Im1+2vfS7oMDQIRAFWEm3sNH2Iit+C92YA8O4AhO4AyKUIxLuEYwwBAjrMF01mVDRtmCbdiBXdiD/TiIw5jJERzDbE7kVM5kHgv5Nf6Iv+N9fIqvcS3/ywM8xjMsYjEv8ZqggEKKqIbSVVdRtVIHdVMfDdLdGqVsTdZszdVirdAX9DV9Rz/SL/Q7/U0P6Sm9pLf0kTZrhw7ohM6AGghhuoaB6m8aZBpgGgziPlBDQDwKaqhpimm2aapppinfVGCaYZpmmm6aZco15ZlyQLY29QQ1xzTXtBBSthaAmm9aZJpgGm+aCPLLoCaB/CaoyaYlCLo0RZy0R6d0ws6qKc057dVpHUeSq65qLqB9OmN5DVV3Sdqvs5bXVA0X1AGds7yWarpkHdR5y2urlgvpkIpsUrpquxQd1ic6aZ06SndhHdEFyzNUx6XqqC5C3O4aGre5RiB3mnaYdpt2mUpMxaYyUynoWphagpoHx49VrBsQ16rEuE6lxvUqM27QJeNGXTZu0hXzbtZV3YS4RdeMW3UdTsX82AFSCdcaS7nOWMb1xkvcYLzMjcYr3GS8ys3Ga9xivM6tcDqlPfzYjqe119Y7ndE+m+B0VvtthtM5HbApTud10OY4FemQTQroEx3mZkerXNARm+d0UUdtIt040yAQM9EM0zAPy7AaX8I/8AAew3YcwEEcwmEcxTGcwDlcRDFKUYarbMUe7M8BHMQhHMphzOIYjucX+VV+i8/wTX7MtVzH9dzAjdzEzdzCrdzG7dzBndzF3SxmCUtZpsZqopHaY09+nz3jA/Y8D9mzO2JP6ZT9yjM6q3P2a4rsF1zQRRWrRKUq0yVd1hVd1TVdd+3dQBAwhSBUQ0BLtUwmEAEkYw0OcGy5I2UIpExl3q7QdUHvuAn1EeZ2brP73GH3uYslLGYZSyHIqrsB2jmC5esDjzHTzgEhjBZwVvnT7f0SiMT+Ph/wnW/c0VnDsQjEZlkvdgxoMcSvgaCxvF/fH4UgInwDYiu+aezvfXWtCtyFHpiIL+APeAXbUMwa7MBMzuYX+As+xDe4lUdYqpDqqo36aRwcUt2pO0MC1QUA4ExUNfOtvTOsDjiE3UOVg2+BPFM+gRvN9b3KwY2+n+LmVgx+DeQTcat/Zp6simE16yLk2sUHh4EsjFuZY45q8cEc30vWhfJgGGSfuFWNrb+jPNjYd4J6S7HANpCB8hU4Y92HFAuc8fUk/Uw+8BCI/8a537LeF+TDcsAhoDxZ4EsgHolz/sY6Y2RhGeDg1E/9kA3iG3GupVZvozZY6itSBjqBmB7nGAUpaAQciGqmAb5Lr3aIvXmAkdwP7+NmEOmxI1A91gsC3u8A/5zI2b6vSp1fQRzATN9zlXpr4Bi1aOe7gUrdyQhQPiK+n1Sp38cqh2JxxjuClRwZdv7O7VjvPckVPbhglb/ExUPeFark2mjZmgrxDe9LqeR7wCpjKsVk7wxXcn7J7xWVo5P3pkKgIqrjnVRG3FqilmkQ4J1pEKQMc8DJpYLluxLScU/cWZD9IZAfcytwuy67Ynqi3TfRTgtBfj10ShcRLp+iXUhPtOMn2sPjr514VaL7gUCbdr3yvSe6QhX3vsemheN21C8hCTX8/06ZmA8i4NpBrofPOvgsgLA5MtDQjYBcWzfc2N6NMnZ3I4294xyZ3nGPd2R5x73e4Xds19N3e8G6IJIsb+86u66uh3VrQIjA7zIm4iumdiagb6xSy1Q3ViHIHsY019q18XM62qQuNqubXbOH6+36QLd/YxhCLb9WfINvGuuylWf/+HfEZGGdCn9PcR8e5Zf5TdDyf+AxfpHfinPUQJL6a4CyNd5/SSRhHlZzCMdU+LvcEKkaqEEarCEaqhxN0ERN0mQ3DkQqmmEZvoQHsB1XmcXx/Cqfce1vv/XkfRDCNoMImGwN4NUPvsK28ZW4dz7TKNp3R9VvXaIaBPn3BSrWdYQrzG5iJNfGTW6MiKZotqZqpvJVoBmapumapVzlgYj8v6+puAkZCGmO5mqhFmi+FmmJ5sE6Fb603tTICvdx3EhMq1ALGiX7toqbHYHTCd1wAP13rH15V+qe1E1H392sw7oKooYpDEBGKVNZIET79rvjrRGmscct2MgqGQAA";
var GOTHIC = "data:font/woff2;base64,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";
var FONT_FACES = `
@font-face{font-family:'ArborChillDIN';src:url(${DIN_REGULAR}) format('woff');font-weight:400;font-style:normal;font-display:swap}
@font-face{font-family:'ArborChillDIN';src:url(${DIN_MEDIUM}) format('woff');font-weight:500 600;font-style:normal;font-display:swap}
@font-face{font-family:'ArborChillDINGothic';src:url(${GOTHIC}) format('woff2');font-weight:400 600;font-style:normal;font-display:swap}
`;

// packages/arbor-ui/src/styles.ts
var STYLE_ID = "arbor-ui-panel-style";
var CSS = `${FONT_FACES}
.arbor-page,.arbor-panel{
  --arbor-face:'ArborChillDIN','ArborChillDINGothic',var(--dsw-font-family,system-ui,sans-serif);
  box-sizing:border-box;
  color:var(--dsw-alias-label-primary,#1b1b1f);
  font-family:var(--dsw-font-family,system-ui,sans-serif);
  font-size:12px;line-height:1.5;
}
.arbor-page{display:flex;flex-direction:column;gap:14px;min-height:100%;overflow:auto;padding:24px 28px 48px}
.arbor-panel{display:flex;flex-direction:column;gap:6px;height:100%;overflow:auto;padding:10px 12px 20px;font-size:12px;line-height:1.45}
.arbor-page *,.arbor-panel *{box-sizing:border-box}
.arbor-page-head,.arbor-tabs,.arbor-page-body{width:100%;max-width:1040px;margin:0 auto}
.arbor-page-head{display:flex;flex-direction:column;gap:5px;flex:none;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-page-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.arbor-page-title{font-size:19px;font-weight:600;letter-spacing:.01em}
.arbor-page-intro{font-size:12.5px;max-width:72ch}
.arbor-page-data{font-size:11px;overflow-wrap:anywhere}
.arbor-tabs{display:flex;flex:none;gap:2px;align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));overflow-x:auto}
.arbor-tab-group{display:flex;align-items:center;flex:none;border-bottom:2px solid transparent;margin-bottom:-1px}
.arbor-tab{height:32px;padding:0 11px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:11.5px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.arbor-tab:hover{color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-tab-group.is-active{border-bottom-color:var(--dsw-alias-brand-primary,#4176e6)}
.arbor-tab-group.is-active .arbor-tab{color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:500}
.arbor-tabs>.arbor-tab.is-active{border-bottom-color:var(--dsw-alias-brand-primary,#4176e6);color:var(--dsw-alias-label-primary,#1b1b1f);font-weight:500}
.arbor-tab-close{width:20px;height:20px;line-height:1;border:none;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a92);cursor:pointer;font-size:13px;padding:0;margin-right:3px}
.arbor-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-page-body{display:flex;flex-direction:column;flex:0 0 auto;gap:4px;padding-bottom:20px}
.arbor-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;padding:2px 0 8px}
.arbor-stat{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));display:flex;flex-direction:column;gap:1px;min-width:0}
.arbor-stat-label{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.05em;text-transform:uppercase}
.arbor-stat-value{font-size:20px;font-weight:500;line-height:1.25}
.arbor-session-list{display:flex;flex-direction:column;gap:6px;padding:2px 0 8px}
.arbor-session-row{display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));min-width:0}
.arbor-session-row.is-live{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 34%,var(--dsw-alias-border-l1,transparent))}
.arbor-session-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.arbor-session-title{display:flex;align-items:baseline;gap:7px;min-width:0}
.arbor-session-name{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-session-id{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-session-doing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-session-meta{font-size:10.5px}
.arbor-session-open{height:27px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.1));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;font-size:11px;cursor:pointer;flex:none}
.arbor-session-open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-session-head{display:flex;align-items:flex-start;gap:12px;padding:2px 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));margin-bottom:4px}
.arbor-session-head-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.arbor-session-head-title{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.arbor-session-head .arbor-session-name{font-size:15px}
.arbor-session-view{gap:2px}
.arbor-session-hint{margin-top:8px}
.arbor-chip-session{color:var(--dsw-alias-brand-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 12%,transparent)}
.arbor-page .arbor-sec-title,.arbor-page .arbor-stat-label,.arbor-page .arbor-page-title{font-family:var(--arbor-face)}
.arbor-page .arbor-sec-title{font-size:11px}
.arbor-page .arbor-sec-head{padding:12px 2px 8px}
.arbor-page .arbor-sec-body{padding-bottom:14px;gap:8px}
.arbor-page .arbor-muted{font-size:11.5px}
.arbor-page .arbor-empty{padding:14px}
.arbor-panel-empty{padding-top:22px}
.arbor-muted{color:var(--dsw-alias-label-tertiary,#8a8a92);font-size:11px}
.arbor-error{color:var(--dsw-alias-state-error-primary,#c62828);font-size:11px}
.arbor-hint{color:var(--dsw-alias-label-tertiary,#8a8a92);font-size:11px;line-height:1.5;margin-top:2px}
.arbor-stack{display:flex;flex-direction:column;gap:6px}
.arbor-row{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.arbor-label{letter-spacing:.01em}
.arbor-num,.arbor-handoff-key,.arbor-win-ref,.arbor-win-use,.arbor-chip,.arbor-badge,.arbor-sec-title,.arbor-kv-key,.arbor-panel-title,.arbor-panel-windows,.arbor-chip-name,.arbor-chip-state,.arbor-env-name,.arbor-note-id,.arbor-board-state,.arbor-stream-label,.arbor-send-label,.arbor-search-go,.arbor-hit-kind,.arbor-schedule-name{
  font-family:var(--arbor-face);
  font-feature-settings:'tnum' 1,'lnum' 1;
}
.arbor-num{font-variant-numeric:tabular-nums}
.arbor-panel-head{display:flex;flex-direction:column;gap:2px;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-panel-title-row{display:flex;align-items:center;gap:7px;min-width:0}
.arbor-panel-mark{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary,#4176e6);flex:none}
.arbor-panel-mark.is-live{animation:arbor-pulse 1.4s ease-in-out infinite}
.arbor-panel-title{font-size:12px;font-weight:500;letter-spacing:.04em}
.arbor-panel-windows{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a92);white-space:nowrap}
.arbor-panel-doing{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.arbor-sec{border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}
.arbor-sec:last-child{border-bottom:none}
.arbor-sec-head{display:flex;align-items:center;gap:8px;padding:8px 2px;cursor:pointer;list-style:none;user-select:none}
.arbor-sec-head::-webkit-details-marker{display:none}
.arbor-sec-title{font-size:10.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-sec-count{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-chevron{width:0;height:0;border-left:4px solid var(--dsw-alias-label-tertiary,#8a8a92);border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;transition:transform .15s ease;flex:none}
.arbor-sec[open] .arbor-chevron{transform:rotate(90deg)}
.arbor-sec-body{padding:0 2px 10px;display:flex;flex-direction:column;gap:6px}
.arbor-wins{display:flex;flex-direction:column;gap:8px}
.arbor-win{border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;padding:7px 8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));display:flex;flex-direction:column;gap:4px;min-width:0}
.arbor-win-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 35%,var(--dsw-alias-border-l1,transparent))}
.arbor-win-head{display:flex;align-items:center;gap:6px;min-width:0}
.arbor-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-dot-running{background:var(--dsw-alias-state-success-primary,#1a8a4a)}
.arbor-dot-idle{background:var(--dsw-alias-state-warn-primary,#b26a00)}
.arbor-dot-paused{background:var(--dsw-alias-state-warn-primary,#b26a00)}
.arbor-dot-ended{background:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-win-ref{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66);flex:none}
.arbor-chip{font-size:9.5px;line-height:16px;padding:0 5px;border-radius:5px;flex:none;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c5c66);white-space:nowrap}
.arbor-chip-running{color:var(--dsw-alias-state-success-primary,#1a8a4a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 12%,transparent)}
.arbor-chip-idle,.arbor-chip-paused{color:var(--dsw-alias-state-warn-primary,#b26a00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 12%,transparent)}
.arbor-win-doing{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.arbor-win-use{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none;white-space:nowrap}
.arbor-win-meta{display:flex;flex-wrap:wrap;gap:3px 8px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-meta-refs{font-size:10px;opacity:.8}
.arbor-meta-refused{color:var(--dsw-alias-state-error-primary,#c62828)}
.arbor-handoff{display:flex;flex-direction:column;gap:1px;border-left:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 40%,transparent);padding-left:7px;margin:2px 0}
.arbor-handoff-row{display:flex;gap:7px;align-items:baseline;font-size:11px;min-width:0}
.arbor-handoff-key{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.03em}
.arbor-handoff-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-badge{display:inline-block;font-size:9.5px;line-height:15px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#5c5c66);white-space:nowrap}
.arbor-badge-handoff,.arbor-badge-accent{color:var(--dsw-alias-brand-primary,#4176e6);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4176e6) 12%,transparent)}
.arbor-badge-ok{color:var(--dsw-alias-state-success-primary,#1a8a4a);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 12%,transparent)}
.arbor-badge-warn{color:var(--dsw-alias-state-warn-primary,#b26a00);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b26a00) 12%,transparent)}
.arbor-badge-err{color:var(--dsw-alias-state-error-primary,#c62828);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c62828) 12%,transparent)}
.arbor-badge-plain{opacity:.65}
.arbor-stream{margin-top:2px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:7px;padding:6px 7px;background:var(--dsw-alias-bg-base,transparent);display:flex;flex-direction:column;gap:4px}
.arbor-stream-head{display:flex;align-items:center;gap:6px}
.arbor-stream-label,.arbor-send-label{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-pulse{width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-pulse.is-live{background:var(--dsw-alias-state-success-primary,#1a8a4a);animation:arbor-pulse 1.1s ease-in-out infinite}
.arbor-stream-text{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:170px;overflow:auto;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-send{margin-top:2px;border-top:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-top:5px;display:flex;flex-direction:column;gap:3px}
.arbor-send-text{color:var(--dsw-alias-label-primary,#1b1b1f);max-height:130px}
.arbor-stream-empty{font-size:11px}
.arbor-kv{display:flex;gap:8px;align-items:baseline;min-width:0}
.arbor-kv-key{flex:none;width:76px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.03em}
.arbor-val{min-width:0;flex:1;display:flex;gap:6px;flex-wrap:wrap;align-items:baseline}
.arbor-mono{font-family:var(--dsw-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10.5px}
.arbor-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;display:inline-block;vertical-align:bottom}
.arbor-sub{display:flex;flex-direction:column;gap:3px}
.arbor-sub-title{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);letter-spacing:.04em;margin-top:2px}
.arbor-empty{border:1px dashed var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:3px}
.arbor-empty-title{font-size:11px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-board{display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-bottom:5px}
.arbor-board:last-child{border-bottom:none;padding-bottom:0}
.arbor-board-state{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92)}
.arbor-board-doing{font-size:11.5px}
.arbor-board-open{display:flex;flex-wrap:wrap;gap:4px}
.arbor-board-targets{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-notes-head{display:flex;flex-direction:column;gap:1px}
.arbor-notes-count{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-note{border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));padding-left:7px;display:flex;flex-direction:column;gap:1px}
.arbor-note-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.arbor-note-id{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-note-title{font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.arbor-note-sum{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.arbor-env-counts{font-size:10.5px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-env-name{font-size:11px}
.arbor-env-desc{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.arbor-schedule{display:flex;flex-direction:column;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));padding-bottom:5px}
.arbor-schedule:last-child{border-bottom:none;padding-bottom:0}
.arbor-schedule-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.arbor-schedule-meta{font-size:10px}
.arbor-judge{display:flex;flex-wrap:wrap;gap:3px}
.arbor-clamp{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:11px}
.arbor-search{display:flex;gap:6px;align-items:center}
.arbor-search-input{flex:1;min-width:0;height:26px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:7px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#1b1b1f);padding:0 8px;font:inherit;font-size:11px;outline:none}
.arbor-search-input:focus{border-color:var(--dsw-alias-brand-primary,#4176e6)}
.arbor-search-go{height:26px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.03));color:var(--dsw-alias-label-primary,#1b1b1f);font-size:10px;letter-spacing:.06em;cursor:pointer}
.arbor-search-go:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.arbor-search-go:disabled{opacity:.45;cursor:default}
.arbor-search-hint{font-size:10px}
.arbor-hit{display:flex;flex-direction:column;gap:1px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));padding-left:7px}
.arbor-hit-head{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
.arbor-hit-kind{font-size:10px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-hit-sum{font-size:11px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.arbor-loading{font-size:11px;color:var(--dsw-alias-label-secondary,#5c5c66)}
.arbor-chip-button{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c66);font:inherit;cursor:pointer;flex:none}
.arbor-chip-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#1b1b1f)}
.arbor-chip-button.is-running{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a8a4a) 38%,var(--dsw-alias-border-l1,transparent))}
.arbor-chip-mark{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8a92);flex:none}
.arbor-chip-button.is-running .arbor-chip-mark{background:var(--dsw-alias-state-success-primary,#1a8a4a)}
.arbor-chip-mark.is-streaming{animation:arbor-pulse 1s ease-in-out infinite}
.arbor-chip-name{font-size:10.5px;font-weight:500;letter-spacing:.04em}
.arbor-chip-state{font-size:10px;color:var(--dsw-alias-label-tertiary,#8a8a92);white-space:nowrap}
@keyframes arbor-pulse{0%,100%{opacity:.45;transform:scale(.86)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.arbor-panel-mark.is-live,.arbor-pulse.is-live,.arbor-chip-mark.is-streaming{animation:none}}
`;
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
function useChannel(channel) {
  (0, import_react.useEffect)(() => {
    channel.retain();
    return () => {
      channel.release();
    };
  }, [channel]);
  return (0, import_react.useSyncExternalStore)(channel.subscribe, channel.getSnapshot);
}
function stateLabel(t, window) {
  if (window.state === "running") return t("statusRunning");
  if (window.state === "idle") return t("statusIdle");
  if (window.state === "paused") return t("statusPaused");
  return t("statusEnded");
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
function number(value) {
  return value === void 0 ? "\u2014" : new Intl.NumberFormat("en-US").format(value);
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
function clock(value) {
  if (value === void 0) return "\u2014";
  return new Date(value).toLocaleString(void 0, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
function Section(props) {
  const [open, setOpen] = (0, import_react.useState)(props.open === true);
  return (0, import_react.createElement)(
    "details",
    {
      className: "arbor-sec",
      open,
      onToggle: (event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }
    },
    (0, import_react.createElement)(
      "summary",
      { className: "arbor-sec-head" },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-sec-title" }, props.label),
      props.count === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-num arbor-sec-count" }, props.count),
      (0, import_react.createElement)("span", { className: "arbor-chevron", "aria-hidden": true })
    ),
    (0, import_react.createElement)("div", { className: "arbor-sec-body" }, props.children)
  );
}
function KV(props) {
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-kv" },
    (0, import_react.createElement)("span", { className: "arbor-label arbor-kv-key" }, props.label),
    (0, import_react.createElement)("span", { className: props.mono === true ? "arbor-val arbor-mono" : "arbor-val" }, props.children)
  );
}
function Badge(props) {
  return (0, import_react.createElement)("span", {
    className: `arbor-badge arbor-label${props.tone === void 0 ? "" : ` arbor-badge-${props.tone}`}`
  }, props.children);
}
function Stream(props) {
  const text = props.stream?.text ?? "";
  const send = props.stream?.send ?? "";
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stream", "data-arbor-stream": true },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-stream-head" },
      (0, import_react.createElement)("span", { className: `arbor-pulse${props.stream?.streaming === true ? " is-live" : ""}` }),
      (0, import_react.createElement)("span", { className: "arbor-label arbor-stream-label" }, props.t("streamText"))
    ),
    text === "" ? (0, import_react.createElement)("div", { className: "arbor-muted arbor-stream-empty" }, props.t("streamWaiting")) : (0, import_react.createElement)("div", { className: "arbor-stream-text" }, text),
    send === "" ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-send" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-send-label" }, props.t("streamSend")),
      (0, import_react.createElement)("div", { className: "arbor-stream-text arbor-send-text" }, send)
    )
  );
}
function WindowRow(props) {
  const { window, t } = props;
  const reasons = [];
  if (window.continuationOf !== void 0) reasons.push(t("continuesFrom", { window: window.continuationOf }));
  if (window.continuedBy !== void 0) reasons.push(t("handoffTo", { window: window.continuedBy }));
  const end = endLabel(t, window.endReason);
  if (end !== void 0) reasons.push(end);
  return (0, import_react.createElement)(
    "div",
    { className: `arbor-win arbor-win-${window.state}`, "data-arbor-window": window.ref },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-win-head" },
      (0, import_react.createElement)("span", { className: `arbor-dot arbor-dot-${window.state}` }),
      (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, window.ref),
      props.label === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-chip arbor-label arbor-chip-session" }, props.label),
      (0, import_react.createElement)("span", { className: `arbor-chip arbor-label arbor-chip-${window.state}` }, stateLabel(t, window)),
      (0, import_react.createElement)("span", { className: "arbor-win-doing" }, window.doing ?? ""),
      window.used === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-num arbor-win-use" }, `${compact(window.used)} / ${compact(window.limit)}`)
    ),
    reasons.length === 0 && window.handoff === void 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-win-meta" },
      reasons.map((reason, index) => (0, import_react.createElement)("span", { className: "arbor-meta-item", key: `r${index}` }, reason)),
      window.handoff === void 0 ? null : (0, import_react.createElement)(
        "span",
        { className: "arbor-meta-item" },
        (0, import_react.createElement)(Badge, { tone: "handoff" }, t("handoff")),
        " ",
        (0, import_react.createElement)("span", { className: "arbor-mono arbor-meta-refs" }, window.handoff.refs.join(" "))
      ),
      window.refused === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-meta-item arbor-meta-refused" }, t("refused", { rule: window.refused }))
    ),
    window.handoff === void 0 ? null : handoffLines(window.handoff, t),
    window.live ? (0, import_react.createElement)(Stream, { stream: props.stream, t }) : null
  );
}
function handoffLines(handoff, t) {
  const lines = [
    [t("handoffTopics"), handoff.topics],
    [t("handoffProgress"), handoff.progress],
    [t("handoffPending"), handoff.pending],
    [t("handoffAgreements"), handoff.agreements]
  ];
  const shown = lines.filter((line) => line[1] !== void 0);
  if (shown.length === 0) return null;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-handoff" },
    shown.map(([label, values]) => (0, import_react.createElement)(
      "div",
      { className: "arbor-handoff-row", key: label },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-handoff-key" }, label),
      (0, import_react.createElement)("span", { className: "arbor-handoff-value" }, values.join(" \xB7 "))
    ))
  );
}
function WindowsList(props) {
  const { windows, snapshot, t } = props;
  const ordered = [...windows].reverse();
  if (ordered.length === 0) {
    return (0, import_react.createElement)(
      "div",
      { className: "arbor-empty" },
      (0, import_react.createElement)("div", { className: "arbor-empty-title arbor-label" }, t("noWindows")),
      (0, import_react.createElement)("div", { className: "arbor-muted" }, t("noWindowsHint"))
    );
  }
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-wins" },
    ordered.map((window) => (0, import_react.createElement)(WindowRow, {
      key: window.ref,
      window,
      stream: snapshot.streams[window.ref],
      t
    }))
  );
}
function WorkspaceBlock(props) {
  const { workspace, t } = props;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    (0, import_react.createElement)(
      KV,
      { label: t("workspaceBackend") },
      (0, import_react.createElement)("span", { className: "arbor-label" }, workspace.backend),
      (0, import_react.createElement)("span", { className: "arbor-mono arbor-path" }, workspace.shared)
    ),
    workspace.project === void 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("workspaceProject"), mono: false },
      (0, import_react.createElement)("span", null, workspace.project.name, " "),
      (0, import_react.createElement)("span", { className: "arbor-mono arbor-path" }, workspace.project.path)
    ),
    workspace.cwd === void 0 ? null : (0, import_react.createElement)(KV, { label: t("workspaceCwd"), mono: true }, workspace.cwd),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-sub" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, t("workspacePointers")),
      workspace.pointers.length === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("none")) : workspace.pointers.map((pointer) => (0, import_react.createElement)(
        "div",
        { className: "arbor-row", key: pointer.path },
        (0, import_react.createElement)("span", { className: "arbor-label" }, pointer.name),
        (0, import_react.createElement)("span", { className: "arbor-mono arbor-path" }, pointer.path)
      ))
    ),
    (0, import_react.createElement)(
      "div",
      { className: "arbor-sub" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, t("workspaceCheckouts")),
      workspace.checkouts.length === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("none")) : workspace.checkouts.map((checkout) => (0, import_react.createElement)(
        "div",
        { className: "arbor-row", key: checkout.path },
        (0, import_react.createElement)("span", { className: "arbor-mono arbor-path" }, checkout.name),
        (0, import_react.createElement)(Badge, { tone: checkout.dirty ? "warn" : "ok" }, checkout.dirty ? t("workspaceDirty") : t("workspaceClean"))
      ))
    ),
    workspace.keeps.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-sub" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, t("workspaceKeeps")),
      workspace.keeps.map((keep) => (0, import_react.createElement)(
        "div",
        { className: "arbor-row", key: keep.path },
        (0, import_react.createElement)("span", { className: "arbor-label" }, keep.name),
        (0, import_react.createElement)("span", { className: "arbor-mono arbor-path" }, keep.path)
      ))
    ),
    workspace.openWork.length === 0 ? null : (0, import_react.createElement)(
      "div",
      { className: "arbor-sub" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, t("workspaceOpenWork")),
      workspace.openWork.map((item) => (0, import_react.createElement)(
        "div",
        { className: "arbor-row", key: `${item.window}:${item.name}` },
        (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, item.window),
        (0, import_react.createElement)("span", { className: "arbor-label" }, item.name),
        item.detail === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-muted" }, item.detail)
      ))
    )
  );
}
function BoardBlock(props) {
  const { board, t } = props;
  if (board.length === 0) return (0, import_react.createElement)("div", { className: "arbor-muted" }, t("boardEmpty"));
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    board.map((line) => (0, import_react.createElement)(
      "div",
      { className: "arbor-board", key: line.window },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-win-head" },
        (0, import_react.createElement)("span", { className: `arbor-dot arbor-dot-${line.state}` }),
        (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, line.window),
        (0, import_react.createElement)("span", { className: "arbor-label arbor-board-state" }, line.state),
        (0, import_react.createElement)("span", { className: "arbor-num arbor-win-use" }, `${compact(line.usage.used)} / ${compact(line.usage.limit)}`)
      ),
      (0, import_react.createElement)("div", { className: "arbor-board-doing" }, line.doing),
      line.openWork === void 0 || line.openWork.length === 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-board-open" },
        line.openWork.map((item) => (0, import_react.createElement)(Badge, { key: item, tone: "warn" }, item))
      ),
      (0, import_react.createElement)(
        "div",
        { className: "arbor-muted arbor-board-targets" },
        t("boardTargets"),
        ": ",
        line.targets.join(" \xB7 ")
      )
    ))
  );
}
function NotesBlock(props) {
  const { notes, t } = props;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-notes-head" },
      (0, import_react.createElement)("span", { className: "arbor-label" }, t("notesActive")),
      (0, import_react.createElement)(
        "span",
        { className: "arbor-num arbor-notes-count" },
        t("notesCount", { count: notes.total, tokens: number(notes.tokens), budget: number(notes.budget.tokens) })
      ),
      (0, import_react.createElement)("span", { className: "arbor-num arbor-muted" }, t("notesEpoch", { epoch: notes.epoch }))
    ),
    notes.items.length === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("notesEmpty")) : notes.items.map((note) => (0, import_react.createElement)(
      "div",
      { className: "arbor-note", key: note.ref },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-note-head" },
        (0, import_react.createElement)("span", { className: "arbor-num arbor-note-id" }, note.ref),
        (0, import_react.createElement)("span", { className: "arbor-label arbor-note-title" }, note.title)
      ),
      note.summary === "" ? null : (0, import_react.createElement)("div", { className: "arbor-muted arbor-note-sum" }, note.summary)
    ))
  );
}
function EnvBlock(props) {
  const { env, t } = props;
  const items = env.items;
  const skills = items.filter((item) => item.kind === "skill");
  const servers = items.filter((item) => item.kind === "mcp");
  const services = items.filter((item) => item.kind === "service");
  const settings = items.filter((item) => item.kind === "settings");
  if (items.length === 0) return (0, import_react.createElement)("div", { className: "arbor-muted" }, t("envEmpty"));
  const group = (label, rows) => rows.length === 0 ? null : (0, import_react.createElement)(
    "div",
    { className: "arbor-sub" },
    (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, label),
    rows
  );
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-num arbor-env-counts" },
      t("envCounts", { skills: skills.length, servers: servers.length, services: services.length })
    ),
    group(t("envSkills"), skills.map((item) => (0, import_react.createElement)(
      "div",
      { className: "arbor-row", key: `sk:${item.name}` },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-env-name" }, item.name),
      item.builtin === true ? (0, import_react.createElement)(Badge, { tone: "ok" }, t("envBuiltin")) : null,
      (0, import_react.createElement)("span", { className: "arbor-mono arbor-path", title: item.description }, item.path ?? "")
    ))),
    group(t("envMcp"), servers.map((item) => (0, import_react.createElement)(
      "div",
      { className: "arbor-row", key: `mcp:${item.name}` },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-env-name" }, item.name),
      (0, import_react.createElement)(
        "span",
        { className: "arbor-muted arbor-env-desc", title: item.description },
        item.functions === void 0 || item.functions.length === 0 ? "\u2014" : item.functions.join(" \xB7 ")
      )
    ))),
    group(t("envServices"), services.map((item) => (0, import_react.createElement)(
      "div",
      { className: "arbor-row", key: `svc:${item.name}` },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-env-name" }, item.name),
      (0, import_react.createElement)(
        Badge,
        { tone: item.state === "running" ? "ok" : item.state === "failed" ? "err" : "warn" },
        item.state ?? "\u2014"
      ),
      item.error === void 0 ? null : (0, import_react.createElement)("span", { className: "arbor-muted arbor-env-desc" }, item.error)
    ))),
    group(t("envPath"), settings.map((item) => (0, import_react.createElement)(
      "div",
      { className: "arbor-row", key: `set:${item.name}` },
      (0, import_react.createElement)("span", { className: "arbor-label arbor-env-name" }, item.name),
      (0, import_react.createElement)("span", { className: "arbor-num arbor-muted" }, `@${item.revision}`)
    )))
  );
}
function SchedulesBlock(props) {
  const { schedules, t } = props;
  if (schedules.length === 0) return (0, import_react.createElement)("div", { className: "arbor-muted" }, t("schedulesEmpty"));
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    schedules.map((schedule) => {
      const repeat = schedule.everyMs !== void 0 ? t("scheduleEvery", { value: duration(t, schedule.everyMs) ?? String(schedule.everyMs) }) : schedule.dailyAt !== void 0 ? t("scheduleDaily", { value: schedule.dailyAt }) : schedule.weekdays !== void 0 ? t("scheduleWeekly", { value: schedule.weekdays.join(" ") }) : "";
      return (0, import_react.createElement)(
        "div",
        { className: "arbor-schedule", key: schedule.ref },
        (0, import_react.createElement)(
          "div",
          { className: "arbor-win-head" },
          (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, schedule.ref),
          (0, import_react.createElement)("span", { className: "arbor-label arbor-schedule-name" }, schedule.name ?? "\u2014"),
          schedule.mine ? (0, import_react.createElement)(Badge, { tone: "accent" }, t("scheduleMine")) : null,
          schedule.paused ? (0, import_react.createElement)(Badge, { tone: "warn" }, t("schedulePaused")) : null
        ),
        (0, import_react.createElement)(
          "div",
          { className: "arbor-muted arbor-schedule-meta" },
          t("scheduleNext", { time: clock(schedule.nextAt) }),
          repeat === "" ? "" : ` \xB7 ${repeat}`,
          schedule.fired === void 0 ? "" : ` \xB7 ${t("scheduleFired", { count: schedule.fired })}`
        )
      );
    })
  );
}
function SettingsBlock(props) {
  const { settings, t } = props;
  const tiers = Object.entries(settings.modelTiers ?? {});
  const judge = Object.entries(settings.judge?.modes ?? {});
  const judgeLabel = (mode) => mode === "off" ? t("settingsJudgeOff") : mode === "shadow" ? t("settingsJudgeShadow") : t("settingsJudgeOn");
  const window = settings.window ?? {};
  const notes = settings.notes ?? {};
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-stack" },
    (0, import_react.createElement)("div", { className: "arbor-muted" }, t(settings.source === "environment" ? "settingsSourceEnvironment" : "settingsSourceDeployment")),
    settings.identity === void 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsIdentity") },
      (0, import_react.createElement)("span", { className: "arbor-clamp" }, settings.identity)
    ),
    settings.generalRules === void 0 || settings.generalRules.length === 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsRules") },
      (0, import_react.createElement)("span", { className: "arbor-num" }, String(settings.generalRules.length))
    ),
    tiers.length === 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsTiers"), mono: true },
      tiers.map(([tier, model]) => `${tier} \u2192 ${model}`).join(" \xB7 ")
    ),
    settings.defaultTier === void 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsDefaultTier") },
      (0, import_react.createElement)("span", { className: "arbor-label" }, settings.defaultTier)
    ),
    judge.length === 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsJudge") },
      (0, import_react.createElement)(
        "span",
        { className: "arbor-judge" },
        judge.map(([kind, mode]) => (0, import_react.createElement)(
          Badge,
          { key: kind, tone: mode === "off" ? "plain" : mode === "shadow" ? "warn" : "ok" },
          `${kind} ${judgeLabel(mode)}`
        ))
      )
    ),
    (0, import_react.createElement)(
      KV,
      { label: t("settingsWindow") },
      (0, import_react.createElement)(
        "span",
        { className: "arbor-num" },
        [
          window.idleSeconds === void 0 ? "" : `${t("settingsIdle")} ${t("seconds", { value: window.idleSeconds })}`,
          window.contextTokens === void 0 ? "" : `${t("settingsContext")} ${compact(window.contextTokens)}`,
          window.reserveTokens === void 0 ? "" : `${t("settingsReserve")} ${compact(window.reserveTokens)}`,
          window.protectionSeconds === void 0 ? "" : `${t("settingsProtection")} ${t("seconds", { value: window.protectionSeconds })}`
        ].filter(Boolean).join(" \xB7 ")
      )
    ),
    (0, import_react.createElement)(
      KV,
      { label: t("settingsNotes") },
      (0, import_react.createElement)(
        "span",
        { className: "arbor-num" },
        [
          notes.activeCount === void 0 ? "" : `${t("settingsNotesCount")} ${notes.activeCount}`,
          notes.activeTokenBudget === void 0 ? "" : `${t("settingsNotesTokens")} ${compact(notes.activeTokenBudget)}`
        ].filter(Boolean).join(" \xB7 ")
      )
    ),
    settings.secrets === void 0 || settings.secrets.length === 0 ? null : (0, import_react.createElement)(
      KV,
      { label: t("settingsSecrets"), mono: true },
      settings.secrets.join(" \xB7 ")
    ),
    (0, import_react.createElement)("div", { className: "arbor-hint" }, t("settingsDsh"))
  );
}
function SearchGroup(props) {
  if (props.rows.length === 0) return null;
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-sub" },
    (0, import_react.createElement)("div", { className: "arbor-label arbor-sub-title" }, props.label),
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
    { className: "arbor-stack" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-search" },
      (0, import_react.createElement)("input", {
        className: "arbor-search-input",
        value: query,
        placeholder: t("searchPlaceholder"),
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
        type: "button",
        disabled: busy || query.trim() === "",
        onClick: () => {
          void run();
        }
      }, t("searchButton"))
    ),
    (0, import_react.createElement)("div", { className: "arbor-muted arbor-search-hint" }, t("searchHint")),
    error === void 0 ? null : (0, import_react.createElement)("div", { className: "arbor-error" }, t("searchError", { message: error })),
    result === void 0 ? null : result.total === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("searchEmpty")) : (0, import_react.createElement)(
      "div",
      { className: "arbor-stack" },
      (0, import_react.createElement)("div", { className: "arbor-num arbor-muted" }, t("searchTotal", { count: result.total })),
      (0, import_react.createElement)(SearchGroup, {
        label: t("searchJournal"),
        rows: result.journal.map((hit) => (0, import_react.createElement)(
          "div",
          { className: "arbor-hit", key: hit.ref },
          (0, import_react.createElement)(
            "div",
            { className: "arbor-hit-head" },
            (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, hit.ref),
            (0, import_react.createElement)("span", { className: "arbor-label arbor-hit-kind" }, hit.kind),
            hit.window === null ? null : (0, import_react.createElement)("span", { className: "arbor-num arbor-muted" }, hit.window)
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
            (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, hit.ref),
            (0, import_react.createElement)("span", { className: "arbor-label arbor-hit-kind" }, hit.title)
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
            (0, import_react.createElement)("span", { className: "arbor-num arbor-win-ref" }, hit.window)
          ),
          (0, import_react.createElement)("div", { className: "arbor-hit-sum" }, hit.doing)
        ))
      })
    )
  );
}
function sessionName(session) {
  return session.project?.name ?? (session.sessionId.length > 22 ? `${session.sessionId.slice(0, 22)}\u2026` : session.sessionId);
}
function liveWindowOf(windows) {
  return [...windows].reverse().find((window) => window.live);
}
function Overview(props) {
  const { facts, snapshot, t, onOpenSession } = props;
  const live = facts.windows.filter((window) => window.live);
  const recent = [...facts.windows].reverse().slice(0, 30);
  const summary = (label, value) => (0, import_react.createElement)(
    "div",
    { className: "arbor-stat", key: label },
    (0, import_react.createElement)("div", { className: "arbor-label arbor-stat-label" }, label),
    (0, import_react.createElement)("div", { className: "arbor-num arbor-stat-value" }, String(value))
  );
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-page-body" },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-summary" },
      summary(t("summarySessions"), facts.sessions.length),
      summary(t("summaryWindows"), live.length),
      summary(t("summaryNotes"), facts.notes.total),
      summary(t("summaryEnv"), facts.env.items.length),
      summary(t("summarySchedules"), facts.schedules.length)
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sessions"), count: String(facts.sessions.length), open: true, t },
      facts.sessions.length === 0 ? (0, import_react.createElement)(
        "div",
        { className: "arbor-empty" },
        (0, import_react.createElement)("div", { className: "arbor-empty-title arbor-label" }, t("noSessions")),
        (0, import_react.createElement)("div", { className: "arbor-muted" }, t("noSessionsHint"))
      ) : (0, import_react.createElement)(
        "div",
        { className: "arbor-session-list" },
        facts.sessions.map((session) => {
          const active = session.live > 0;
          const last = liveWindowOf(session.windows);
          return (0, import_react.createElement)(
            "div",
            {
              className: `arbor-session-row${active ? " is-live" : ""}`,
              key: session.sessionId,
              "data-arbor-session": session.sessionId
            },
            (0, import_react.createElement)("span", { className: `arbor-dot arbor-dot-${active ? "running" : "ended"}` }),
            (0, import_react.createElement)(
              "div",
              { className: "arbor-session-main" },
              (0, import_react.createElement)(
                "div",
                { className: "arbor-session-title" },
                (0, import_react.createElement)("span", { className: "arbor-label arbor-session-name" }, sessionName(session)),
                (0, import_react.createElement)("span", { className: "arbor-num arbor-session-id" }, session.sessionId.slice(0, 14))
              ),
              (0, import_react.createElement)(
                "div",
                { className: "arbor-muted arbor-session-doing" },
                last?.doing ?? (session.windows.at(-1)?.doing ?? "")
              ),
              (0, import_react.createElement)(
                "div",
                { className: "arbor-muted arbor-session-meta" },
                session.project?.path ?? session.cwd ?? session.sessionId,
                " \xB7 ",
                t("chain"),
                " ",
                String(session.windows.length)
              )
            ),
            (0, import_react.createElement)("button", {
              type: "button",
              className: "arbor-session-open arbor-label",
              title: t("openSessionTab"),
              "aria-label": t("openSessionTab"),
              onClick: () => {
                onOpenSession(session.sessionId);
              }
            }, t("openSessionTab"))
          );
        })
      )
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("liveWindows"), count: String(live.length), open: true, t },
      live.length === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("noLiveWindow")) : (0, import_react.createElement)(
        "div",
        { className: "arbor-wins" },
        live.map((window) => (0, import_react.createElement)(WindowRow, {
          key: window.ref,
          window,
          stream: snapshot.streams[window.ref],
          label: facts.sessions.find((session) => session.windows.some((one) => one.ref === window.ref))?.project?.name,
          t
        }))
      )
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionWindows"), count: String(facts.windows.length), t },
      recent.length === 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("none")) : (0, import_react.createElement)(
        "div",
        { className: "arbor-wins" },
        recent.map((window) => (0, import_react.createElement)(WindowRow, {
          key: window.ref,
          window,
          stream: snapshot.streams[window.ref],
          label: facts.sessions.find((session) => session.windows.some((one) => one.ref === window.ref))?.project?.name,
          t
        }))
      )
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionBoard"), count: String(facts.board.length), t },
      (0, import_react.createElement)(BoardBlock, { board: facts.board, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionNotes"), count: String(facts.notes.items.length), t },
      (0, import_react.createElement)(NotesBlock, { notes: facts.notes, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionEnvironment"), count: String(facts.env.items.length), t },
      (0, import_react.createElement)(EnvBlock, { env: facts.env, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionSchedules"), count: String(facts.schedules.length), t },
      (0, import_react.createElement)(SchedulesBlock, { schedules: facts.schedules, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionSettings"), t },
      (0, import_react.createElement)(SettingsBlock, { settings: facts.settings, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionSearch"), t },
      (0, import_react.createElement)(SearchBlock, { t })
    )
  );
}
function SessionView(props) {
  const { sessionId, session, t, openDshSession } = props;
  const snapshot = useChannel(channelFor(sessionId));
  const facts = snapshot.facts;
  if (facts === void 0) {
    return (0, import_react.createElement)(
      "div",
      { className: "arbor-page-body" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-loading" }, t("loading")),
      snapshot.status === "error" && snapshot.error !== void 0 ? (0, import_react.createElement)("div", { className: "arbor-error" }, t("error", { message: snapshot.error })) : null
    );
  }
  const live = facts.windows.filter((window) => window.live);
  const now = live.at(-1) ?? [...facts.windows].reverse()[0];
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-page-body arbor-session-view", "data-arbor-session-view": sessionId },
    (0, import_react.createElement)(
      "div",
      { className: "arbor-session-head" },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-session-head-main" },
        (0, import_react.createElement)(
          "div",
          { className: "arbor-session-head-title" },
          (0, import_react.createElement)("span", { className: "arbor-label arbor-session-name" }, session === void 0 ? sessionId : sessionName(session)),
          (0, import_react.createElement)("span", { className: "arbor-num arbor-session-id" }, sessionId.slice(0, 18)),
          (0, import_react.createElement)(
            "span",
            { className: `arbor-chip arbor-label arbor-chip-${now?.state ?? "ended"}` },
            now === void 0 ? t("statusEnded") : stateLabel(t, now)
          )
        ),
        (0, import_react.createElement)("div", { className: "arbor-muted" }, now?.doing ?? facts.workspace.project?.path ?? "")
      ),
      openDshSession === void 0 ? null : (0, import_react.createElement)("button", {
        type: "button",
        className: "arbor-session-open arbor-label",
        onClick: () => {
          openDshSession(sessionId);
        }
      }, t("openInDsh"))
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("now"), open: true, t },
      now === void 0 ? (0, import_react.createElement)("div", { className: "arbor-muted" }, t("noLiveWindow")) : (0, import_react.createElement)(
        "div",
        { className: "arbor-wins" },
        (0, import_react.createElement)(WindowRow, { window: now, stream: snapshot.streams[now.ref], t })
      )
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionWindows"), count: String(facts.windows.length), open: true, t },
      (0, import_react.createElement)(WindowsList, { windows: facts.windows, snapshot, t })
    ),
    (0, import_react.createElement)(
      Section,
      { label: t("sectionWorkspace"), open: true, t },
      (0, import_react.createElement)(WorkspaceBlock, { workspace: facts.workspace, t })
    ),
    (0, import_react.createElement)("div", { className: "arbor-hint arbor-session-hint" }, t("sessionTabHint"))
  );
}
function ArborPage(props) {
  const t = props.t ?? ((key) => key);
  const host = useChannel(hostChannel());
  const facts = host.facts;
  const [opened, setOpened] = (0, import_react.useState)([]);
  const [active, setActive] = (0, import_react.useState)(null);
  const sessions = facts?.sessions ?? [];
  const activeSession = active !== null && sessions.some((session) => session.sessionId === active) ? active : null;
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
    return session === void 0 ? sessionId.slice(0, 14) : sessionName(session);
  };
  return (0, import_react.createElement)(
    "div",
    { className: "arbor-page", "data-arbor-page": true },
    (0, import_react.createElement)(
      "header",
      { className: "arbor-page-head" },
      (0, import_react.createElement)(
        "div",
        { className: "arbor-page-title-row" },
        (0, import_react.createElement)("span", { className: "arbor-panel-mark" }),
        (0, import_react.createElement)("span", { className: "arbor-label arbor-page-title" }, t("pageTitle")),
        (0, import_react.createElement)("span", { className: "arbor-chip arbor-label arbor-chip-session" }, t("host"))
      ),
      (0, import_react.createElement)("div", { className: "arbor-muted arbor-page-intro" }, t("pageIntro")),
      facts === void 0 ? null : (0, import_react.createElement)(
        "div",
        { className: "arbor-muted arbor-page-data" },
        t("dataRoot"),
        ": ",
        (0, import_react.createElement)("span", { className: "arbor-mono" }, facts.dataRoot),
        " \xB7 ",
        facts.backend,
        " \xB7 ",
        facts.shared
      )
    ),
    (0, import_react.createElement)(
      "nav",
      { className: "arbor-tabs", "aria-label": t("pageTitle") },
      (0, import_react.createElement)("button", {
        type: "button",
        className: `arbor-tab arbor-label${activeSession === null ? " is-active" : ""}`,
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
    facts === void 0 ? (0, import_react.createElement)(
      "div",
      { className: "arbor-page-body" },
      (0, import_react.createElement)("div", { className: "arbor-label arbor-loading" }, t("loading")),
      host.status === "error" && host.error !== void 0 ? (0, import_react.createElement)("div", { className: "arbor-error" }, t("error", { message: host.error })) : null
    ) : activeSession === null ? (0, import_react.createElement)(Overview, { facts, snapshot: host, t, onOpenSession: openSession }) : (0, import_react.createElement)(SessionView, {
      sessionId: activeSession,
      session: sessions.find((session) => session.sessionId === activeSession),
      t,
      ...props.openDshSession === void 0 ? {} : { openDshSession: props.openDshSession }
    })
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

