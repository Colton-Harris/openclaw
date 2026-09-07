/**
 * LED frame model for the six Agent Keys.
 *
 * TRAP THIS FILE EXISTS TO DEFUSE:
 * `v.oai.thstatus` is a FULL-FRAME REPAINT. Ids omitted from the array are NOT
 * preserved - they go dark. A natural-looking API like `setKey(2, red)` is
 * therefore a footgun: it would blank the other five keys.
 *
 * So the only thing that can be serialised here is `KeyFrame`, a tuple of
 * EXACTLY SIX entries. A partial update is a compile error, and `validateFrame`
 * re-checks at runtime for JS callers. To change one key you must derive a new
 * complete frame from the current one - `withKey()` does that for you.
 *
 * DIFFERENCE FROM THE SPIKE: the spike's `LightingController` owned a repaint
 * timer. `src/device-link.ts` already owns that loop (`startResyncTimer`), so
 * porting the controller would have produced two repainters fighting over one
 * device. This module is therefore pure serialisation, and the transport keeps
 * no lighting state of its own.
 */
import { MACROPAD_EFFECTS, MACROPAD_SLOT_COUNT, type MacropadEffect } from "../../../contract.js";
import { assertFullFrame, type MacropadFullFrame } from "../../frame-compositor.js";

export type EffectId = MacropadEffect;

/** ids 0..5 map to the six Agent Keys. Nothing else is addressable. */
export const AGENT_KEY_COUNT = MACROPAD_SLOT_COUNT;

const KNOWN_EFFECTS: ReadonlySet<number> = new Set<number>(Object.values(MACROPAD_EFFECTS));

export type KeyLight = {
  /** Packed RGB, 0xRRGGBB. */
  color: number;
  /** 0..1 */
  brightness: number;
  effect: EffectId;
  /** 0..1, only meaningful for animated effects. */
  speed?: number;
  /** `sk` in the wire format - secondary key colour. Pass-through. */
  sk?: number;
  /** `sa` in the wire format - secondary accent. Pass-through. */
  sa?: number;
};

/**
 * Exactly six entries, index == key id. The tuple type is the guardrail:
 * a caller cannot express a partial update by accident.
 */
export type KeyFrame = readonly [KeyLight, KeyLight, KeyLight, KeyLight, KeyLight, KeyLight];

/** One entry of the `v.oai.thstatus` params array, exactly as the firmware wants it. */
export type ThStatusParam = {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
  sk: number;
  sa: number;
};

export function rgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export const OFF: KeyLight = { color: 0x00_00_00, brightness: 0, effect: MACROPAD_EFFECTS.off };

/** All six keys identical - the common case, and safe by construction. */
export function uniformFrame(light: KeyLight): KeyFrame {
  // SAFETY: AGENT_KEY_COUNT is six and every element is a complete KeyLight.
  return Array.from({ length: AGENT_KEY_COUNT }, () => ({ ...light })) as unknown as KeyFrame;
}

/** Build a frame from six colours at a shared brightness/effect. */
export function frameFromColors(
  colors: readonly [number, number, number, number, number, number],
  opts: { brightness?: number; effect?: EffectId; speed?: number } = {},
): KeyFrame {
  const brightness = opts.brightness ?? 1;
  const effect = opts.effect ?? MACROPAD_EFFECTS.solid;
  return colors.map((color) => ({
    color,
    brightness,
    effect,
    ...(opts.speed === undefined ? {} : { speed: opts.speed }),
    // SAFETY: map preserves the six entries of the input KeyFrame.
  })) as unknown as KeyFrame;
}

/**
 * Derive a new complete frame with one key changed.
 * This is the ONLY supported way to do a "partial" update: it produces a full
 * frame, so the repaint semantics stay correct.
 */
export function withKey(frame: KeyFrame, id: number, light: KeyLight): KeyFrame {
  assertKeyId(id);
  const next = frame.map((key) => ({ ...key }));
  next[id] = { ...light };
  // SAFETY: next copies all six entries and only replaces one validated index.
  return next as unknown as KeyFrame;
}

export const ALL_OFF: KeyFrame = uniformFrame(OFF);

/** A dim neutral white - what the hardware probe left the device at. */
export const NEUTRAL: KeyFrame = uniformFrame({
  color: 0xff_ff_ff,
  brightness: 0.15,
  effect: MACROPAD_EFFECTS.solid,
});

function assertKeyId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= AGENT_KEY_COUNT) {
    throw new RangeError(`agent key id must be an integer in [0, ${AGENT_KEY_COUNT}), got ${id}`);
  }
}

export class LightingError extends Error {}

export function validateFrame(frame: KeyFrame): void {
  if (!Array.isArray(frame) || frame.length !== AGENT_KEY_COUNT) {
    throw new LightingError(
      `thstatus is a full-frame repaint: exactly ${AGENT_KEY_COUNT} key states are required, ` +
        `got ${Array.isArray(frame) ? frame.length : typeof frame}. ` +
        `Omitted keys are NOT preserved - they go dark.`,
    );
  }
  frame.forEach((key, index) => {
    if (!Number.isInteger(key.color) || key.color < 0 || key.color > 0xff_ff_ff) {
      throw new LightingError(`key ${index}: color must be a packed RGB int 0x000000..0xFFFFFF`);
    }
    if (!(key.brightness >= 0 && key.brightness <= 1)) {
      throw new LightingError(
        `key ${index}: brightness must be within 0..1, got ${key.brightness}`,
      );
    }
    if (key.speed !== undefined && !(key.speed >= 0 && key.speed <= 1)) {
      throw new LightingError(`key ${index}: speed must be within 0..1, got ${key.speed}`);
    }
    if (!KNOWN_EFFECTS.has(key.effect)) {
      throw new LightingError(`key ${index}: unknown effect ${key.effect}`);
    }
  });
}

/** Serialise a frame into the exact `v.oai.thstatus` params array. */
export function frameToParams(frame: KeyFrame): ThStatusParam[] {
  validateFrame(frame);
  return frame.map((key, id) => ({
    id,
    c: key.color,
    b: key.brightness,
    e: key.effect,
    s: key.speed ?? 0,
    sk: key.sk ?? 0,
    sa: key.sa ?? 0,
  }));
}

/**
 * The plugin's composed frame to the wire.
 *
 * `MacropadFullFrame` is a branded six-tuple that only `composeFrame` can mint,
 * which is what makes a partial repaint unrepresentable upstream. This function
 * consumes that brand and never mints one, so the guarantee survives the seam:
 * there is no path from a caller-supplied array to `v.oai.thstatus`.
 *
 * `assertFullFrame` is the plugin's own runtime backstop for the brand (which
 * cannot survive a plugin boundary), and `validateFrame` inside `frameToParams`
 * then re-checks each key. Two checks, because a silently wrong frame here is a
 * device that lies about session state.
 */
export function fullFrameToParams(frame: MacropadFullFrame): ThStatusParam[] {
  assertFullFrame(frame);
  // SAFETY: `assertFullFrame` proved the length; `validateFrame` inside
  // `frameToParams` proves every `effect` is a code this firmware knows, which
  // is the only way `MacropadKeyFrame["effect"]` (a plain integer from the
  // contract schema) narrows to `EffectId`.
  // SAFETY: MacropadFullFrame is the same six complete lighting entries, with a brand.
  return frameToParams(frame as unknown as KeyFrame);
}
