window.__ModuleLoader__.load({
	id: "@4fu/dsh-arbor-ui-workspace",
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

// packages/arbor-ui-workspace/src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var PICKER_SLOT = "conversation.hero.workspace";
var HERO_SEAT_SLOT = "conversation.hero.agentPreset";
var ARBOR_PRESET = "arbor";
var PRESET_PROJECTION = "agentPreset";
var POLL_MS = 40;
var MAX_POLLS = 500;
var CARRY_MS = 2e3;
function useMainSessionId(props) {
  const useSessions = props["useSessions"];
  return useSessions?.((state) => {
    for (const [id, row] of Object.entries(state.byId)) {
      if ((row.retainedBy?.mainView ?? 0) > 0) return id;
    }
    return void 0;
  });
}
function useProjectionOf(props) {
  const useProjection = props["useProjection"];
  return useProjection?.(PRESET_PROJECTION);
}
var inject = [
  "contextMenus",
  "slots",
  "sessions",
  "workspaces",
  "locale",
  "remote",
  "remote.directoryPicker",
  "layout",
  "shortcuts",
  "remoteAccess"
];
function isArborProject(path) {
  const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
  for (let index = 0; index + 1 < segments.length; index++) {
    if (segments[index] === "arbor" && segments[index + 1] === "shared") return true;
  }
  return false;
}
var EXTERNAL_MARK = "\uFF08\u5916\u90E8\uFF09";
function filterRows(rows, preset) {
  if (preset === ARBOR_PRESET) {
    return rows.map((row) => isArborProject(row.path) ? row : { ...row, title: `${row.title}${EXTERNAL_MARK}` });
  }
  return rows.filter((row) => !isArborProject(row.path));
}
var cached;
function filterState(state, preset) {
  if (cached !== void 0 && cached.state === state && cached.preset === preset) return cached.result;
  const result = { ...state, items: filterRows(state.items, preset) };
  cached = { state, preset, result };
  return result;
}
function apply(ctx) {
  const slots = ctx.slots;
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
  let poll;
  let attempts = 0;
  const stop = () => {
    if (poll !== void 0) {
      clearInterval(poll);
      poll = void 0;
    }
  };
  const look = () => {
    if (heroInject !== void 0) {
      stop();
      return;
    }
    if (++attempts > MAX_POLLS) {
      stop();
      return;
    }
    const face = slots.entriesOfSlot?.(HERO_SEAT_SLOT)[0]?.inject;
    if (typeof face === "function") {
      heroInject = face;
      stop();
    }
  };
  ctx.effect(() => () => {
    stop();
  }, "dsh-arbor-ui-workspace: stop the hero-seat poll");
  poll = setInterval(look, POLL_MS);
  look();
  function usePresetPick(sessionId, projected) {
    const bound = heroSeatFor(sessionId);
    const unbound = heroSeatFor(void 0);
    return (0, import_react.useSyncExternalStore)(
      (onChange) => {
        const stops = [bound, unbound].map((store) => store?.subscribe(onChange));
        return () => {
          for (const halt of stops) halt?.();
        };
      },
      () => {
        const picks = [bound, unbound].map((store) => store?.getSnapshot().current);
        return picks.find((pick) => pick === ARBOR_PRESET) ?? picks.find((pick) => pick !== void 0 && pick !== "") ?? (typeof projected === "string" ? projected : void 0);
      }
    );
  }
  const sessions = ctx.sessions;
  const heroFace = (sessionId) => heroInject === void 0 ? void 0 : heroInject(sessionId);
  const mainSession = () => {
    const byId = sessions?.list.getSnapshot().byId ?? {};
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return byId[id];
    }
    return void 0;
  };
  const gate = (shipped) => (props) => {
    const sessionId = useMainSessionId(props);
    const preset = usePresetPick(sessionId, useProjectionOf(props));
    const useWorkspaces = props["useWorkspaces"];
    const filtered = (selector) => useWorkspaces === void 0 ? void 0 : selector(filterState(useWorkspaces((state) => state), preset));
    const onPick = props["onPick"];
    const carryPick = onPick === void 0 ? void 0 : (workspaceId) => {
      const outcome = onPick(workspaceId);
      if (preset === ARBOR_PRESET) {
        const before = sessionId;
        const deadline = Date.now() + CARRY_MS;
        const settle = () => {
          const main = mainSession();
          if (main === void 0 || main.blank !== true) return;
          if (main.id === before && Date.now() < deadline) {
            setTimeout(settle, POLL_MS);
            return;
          }
          const committed = main.projectionValues?.agentPreset;
          if (committed !== ARBOR_PRESET) heroFace(main.id)?.select?.(ARBOR_PRESET);
        };
        setTimeout(settle, POLL_MS);
      }
      return outcome;
    };
    return (0, import_react.createElement)(shipped, {
      ...props,
      useWorkspaces: filtered,
      ...carryPick === void 0 ? {} : { onPick: carryPick }
    });
  };
  const original = slots.register.bind(slots);
  const register = (options, component) => options.name === PICKER_SLOT ? original(options, gate(component)) : original(options, component);
  Object.defineProperty(slots, "register", { value: register, configurable: true, writable: true });
  ctx.effect(() => () => {
    delete slots.register;
  }, "dsh-arbor-ui-workspace: restore slots.register");
}

		return module.exports;
	}
});

