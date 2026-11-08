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
var inject = ["slots"];
function apply(ctx) {
  const slots = ctx.slots;
  let dispose;
  let poll;
  let attempts = 0;
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
    const staged = usePresetPick(runtime.sessionId);
    const projected = runtime.useProjection?.(PRESET_PROJECTION);
    if (staged === ARBOR_PRESET || projected === ARBOR_PRESET) return null;
    return (0, import_react.createElement)(seat.component, props);
  };
  function usePresetPick(sessionId) {
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
        return picks.find((pick) => pick === ARBOR_PRESET) ?? picks.find((pick) => pick !== void 0 && pick !== "");
      }
    );
  }
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

