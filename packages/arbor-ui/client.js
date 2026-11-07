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
var ARBOR_PRESET = "arbor";
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
  const gate = (seat) => (props) => {
    const preset = props.useProjection?.("agentPreset");
    if (preset === ARBOR_PRESET) return null;
    return (0, import_react.createElement)(seat.component, props);
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
    const seat = slots.entriesOfSlot(SEAT_SLOT)[0];
    if (seat === void 0) return;
    dispose = slots.register({
      name: SEAT_SLOT,
      // Lower than the shipped occupant's default 0, so this gate renders.
      priority: -1,
      locale: seat.options.locale,
      inject: seat.options.inject
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

