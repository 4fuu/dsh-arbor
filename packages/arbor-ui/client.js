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
var import_react = require("react");
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
    return (0, import_react.createElement)(seat.component, props);
  };
  function usePresetPick(sessionId) {
    const bound = heroSeatFor(sessionId);
    const unbound = heroSeatFor(void 0);
    return (0, import_react.useSyncExternalStore)(
      (onChange) => {
        const stops = [bound, unbound].map((one) => one?.subscribe(onChange));
        return () => {
          for (const halt of stops) halt?.();
        };
      },
      () => {
        const picks = [bound, unbound].map((one) => one?.getSnapshot().current);
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
    return (0, import_react.useSyncExternalStore)(
      (onChange) => sessions?.list.subscribe(onChange) ?? (() => void 0),
      () => mainSession()
    );
  }
  const presetOf = (session) => typeof session?.projectionValues?.agentPreset === "string" ? session.projectionValues.agentPreset : void 0;
  const workspaceOf = (sessionId) => {
    const items = service("workspaces")?.list.getSnapshot().items ?? [];
    return items.find((item) => item.sessionIds.includes(sessionId));
  };
  const isArborProject = (path) => {
    const segments = path.split(/[\\/]/).filter((segment) => segment !== "");
    for (let index = 0; index + 1 < segments.length; index++) {
      if (segments[index] === "arbor" && segments[index + 1] === "shared") return true;
    }
    return false;
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
    if (workspace === void 0 || !isArborProject(workspace.path)) return false;
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

