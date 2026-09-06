/**
 * Shared feature contract for the macropad plugin.
 *
 * This module is the single interface boundary between the backend
 * (`index.ts` + `src/**`) and the Control UI (`browser/**`). Both sides import
 * it; neither imports the other. Keep it free of Node-only and DOM-only APIs.
 */
import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";
import { type Static, Type } from "typebox";

export const MACROPAD_PLUGIN_ID = "macropad";

/**
 * Number of addressable status keys.
 *
 * The Codex Micro firmware acknowledges ids 6-16 but lights nothing, so the
 * usable range is 0-5. Treat this as the device-independent slot count.
 */
export const MACROPAD_SLOT_COUNT = 6;

/** Lighting effects understood by the device firmware. */
export const MACROPAD_EFFECTS = {
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
} as const;

export type MacropadEffect = (typeof MACROPAD_EFFECTS)[keyof typeof MACROPAD_EFFECTS];

const SlotIndex = Type.Integer({
  minimum: 0,
  maximum: MACROPAD_SLOT_COUNT - 1,
  description: "Zero-based key index.",
});

/**
 * Session activity projected onto a key.
 *
 * `unbound` is distinct from `idle`: an unbound key is dark, an idle bound key
 * shows its session's colour dimmed.
 */
const SlotActivity = Type.Union(
  [
    Type.Literal("unbound"),
    Type.Literal("idle"),
    Type.Literal("thinking"),
    Type.Literal("awaiting-approval"),
    Type.Literal("error"),
  ],
  { description: "Live session state driving the key's lighting." },
);

const KeyFrame = Type.Object(
  {
    /** Packed 0xRRGGBB. The device takes a single integer, not a triplet. */
    color: Type.Integer({ minimum: 0, maximum: 0xff_ff_ff }),
    brightness: Type.Number({ minimum: 0, maximum: 1 }),
    effect: Type.Integer({ minimum: 0, maximum: 6 }),
  },
  {
    additionalProperties: false,
    description:
      "Rendered lighting for one key. Always a complete value; the device repaints full frames.",
  },
);

const Slot = Type.Object(
  {
    index: SlotIndex,
    activity: SlotActivity,
    frame: KeyFrame,
    sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    label: Type.Optional(Type.String({ maxLength: 256 })),
    /** Pinned slots survive LRU eviction when more sessions are active than keys. */
    pinned: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SlotList = Type.Object(
  { slots: Type.Array(Slot, { minItems: 0, maxItems: MACROPAD_SLOT_COUNT }) },
  { additionalProperties: false },
);

/**
 * Device connection state.
 *
 * `connected` means a verified round-trip, never a successful write: the
 * firmware silently drops malformed writes and still returns success, so
 * write-success proves nothing about health.
 */
const DeviceStatus = Type.Object(
  {
    connected: Type.Boolean(),
    /** Present only while connected. */
    serial: Type.Optional(Type.String({ maxLength: 128 })),
    firmware: Type.Optional(Type.String({ maxLength: 128 })),
    product: Type.Optional(Type.String({ maxLength: 128 })),
    /** Slot count the attached device actually exposes. */
    slotCount: Type.Integer({ minimum: 0, maximum: 64 }),
    /** Battery percentage, when the device reports one. Verified present on Codex Micro fw v0.4.1. */
    batteryPercent: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
    charging: Type.Optional(Type.Boolean()),
    /**
     * True when the platform withholds input reports pending user consent
     * (macOS Input Monitoring). Output lighting still works in this state, so
     * this is a capability flag, not a connection failure.
     */
    inputPermissionRequired: Type.Boolean(),
    /** Populated when `connected` is false, for display in the UI. */
    lastError: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const macropadContract = defineFeatureContract({
  pluginId: MACROPAD_PLUGIN_ID,
  operations: {
    "device.get": {
      kind: "query",
      description: "Read macropad connection state and firmware identity.",
      input: Type.Object({}, { additionalProperties: false }),
      output: DeviceStatus,
    },
    "slots.list": {
      kind: "query",
      description: "List macropad key slots with their bound sessions and rendered lighting.",
      input: Type.Object({}, { additionalProperties: false }),
      output: SlotList,
    },
    "slots.bind": {
      kind: "action",
      description: "Bind a session to a macropad key.",
      input: Type.Object(
        {
          sessionKey: Type.String({ minLength: 1, maxLength: 512 }),
          agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          /** Omit to take the next free slot, or evict the least-recently-used one. */
          index: Type.Optional(SlotIndex),
          pinned: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      output: SlotList,
    },
    "slots.unbind": {
      kind: "action",
      description: "Release a macropad key.",
      input: Type.Object(
        {
          index: Type.Optional(SlotIndex),
          sessionKey: Type.Optional(Type.String({ maxLength: 512 })),
        },
        { additionalProperties: false },
      ),
      output: SlotList,
    },
    "device.identify": {
      kind: "action",
      description: "Briefly flash every key so the operator can confirm which device is attached.",
      input: Type.Object({}, { additionalProperties: false }),
      output: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
    },
  },
  // Event ids allow [a-z0-9_-] only: no dots, unlike operation ids.
  events: {
    device_changed: DeviceStatus,
    slots_changed: SlotList,
  },
});

export type MacropadContract = typeof macropadContract;
export type MacropadDeviceStatus = Static<typeof DeviceStatus>;
export type MacropadSlot = Static<typeof Slot>;
export type MacropadSlotList = Static<typeof SlotList>;
export type MacropadKeyFrame = Static<typeof KeyFrame>;
export type MacropadSlotActivity = Static<typeof SlotActivity>;
