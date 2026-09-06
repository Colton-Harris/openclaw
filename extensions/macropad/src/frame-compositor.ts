/**
 * Renders the plugin's six-key shadow state into device frames.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: `v.oai.thstatus` is a full-frame
 * repaint. Any key id omitted from a write goes dark - the firmware does not
 * preserve it. A "just update key 3" code path is therefore not an optimisation,
 * it is a bug that blanks the other five keys.
 *
 * So the compositor owns the complete state and `composeFrame` is the only way
 * to obtain a `MacropadFullFrame`. That type is a branded six-tuple, which makes
 * a partial update unrepresentable at the type level rather than merely
 * discouraged: `DeviceTransport.setFrame` accepts nothing else, and there is no
 * exported constructor that takes a caller-supplied array.
 */
import {
  MACROPAD_EFFECTS,
  MACROPAD_SLOT_COUNT,
  type MacropadEffect,
  type MacropadKeyFrame,
  type MacropadSlotActivity,
} from "../contract.js";
import { clampBrightness, MACROPAD_COLOR_OFF, resolveSessionColor } from "./colors.js";

declare const fullFrameBrand: unique symbol;

/**
 * A complete device frame: exactly `MACROPAD_SLOT_COUNT` entries in slot order.
 *
 * The brand is unforgeable outside this module, so the only way to reach
 * `setFrame` is through `composeFrame`, which always walks every slot.
 */
export type MacropadFullFrame = readonly [
  MacropadKeyFrame,
  MacropadKeyFrame,
  MacropadKeyFrame,
  MacropadKeyFrame,
  MacropadKeyFrame,
  MacropadKeyFrame,
] & { readonly [fullFrameBrand]: true };

/** One key's slice of the shadow state, before lighting is resolved. */
export type MacropadSlotShadow = {
  index: number;
  activity: MacropadSlotActivity;
  pinned: boolean;
  sessionKey?: string;
  agentId?: string;
  label?: string;
  /** Named sidebar tint from the session row, when known. */
  sessionColor?: string;
};

/** Resolved lighting policy. All colours are already packed `0xRRGGBB`. */
export type MacropadLighting = {
  brightness: number;
  idleBrightness: number;
  colorThinking: number;
  colorAwaitingApproval: number;
  colorError: number;
  useSessionColors: boolean;
};

type ActivityStyle = {
  effect: MacropadEffect;
  /** Which configured colour this activity falls back to. */
  fallback:
    | keyof Pick<MacropadLighting, "colorThinking" | "colorAwaitingApproval" | "colorError">
    | null;
  /** Whether the session's own sidebar tint may override the fallback colour. */
  tintable: boolean;
  dim: boolean;
};

/**
 * Activity to lighting.
 *
 * `awaiting-approval` and `error` are deliberately NOT tintable: they are alarm
 * states, and a key that turns "your session's pink" when it needs you is
 * indistinguishable from one that is merely busy. Identity colouring applies to
 * the two ambient states where it actually communicates whose key this is.
 */
const ACTIVITY_STYLE = {
  unbound: { effect: MACROPAD_EFFECTS.off, fallback: null, tintable: false, dim: true },
  idle: { effect: MACROPAD_EFFECTS.solid, fallback: "colorThinking", tintable: true, dim: true },
  thinking: {
    effect: MACROPAD_EFFECTS.shallowBreath,
    fallback: "colorThinking",
    tintable: true,
    dim: false,
  },
  "awaiting-approval": {
    effect: MACROPAD_EFFECTS.breath,
    fallback: "colorAwaitingApproval",
    tintable: false,
    dim: false,
  },
  error: { effect: MACROPAD_EFFECTS.solid, fallback: "colorError", tintable: false, dim: false },
  // `satisfies` rather than an annotation: it still proves every activity is
  // covered, but keeps the literal key set so indexing does not widen to
  // `ActivityStyle | undefined` under `noUncheckedIndexedAccess`.
} satisfies Record<MacropadSlotActivity, ActivityStyle>;

/** Lighting for one key. Exported for tests and for per-slot reasoning; never sent alone. */
export function renderSlotFrame(
  slot: MacropadSlotShadow,
  lighting: MacropadLighting,
): MacropadKeyFrame {
  const style = ACTIVITY_STYLE[slot.activity];
  if (style.fallback === null) {
    return { color: MACROPAD_COLOR_OFF, brightness: 0, effect: MACROPAD_EFFECTS.off };
  }
  const tint =
    lighting.useSessionColors && style.tintable
      ? resolveSessionColor(slot.sessionColor)
      : undefined;
  return {
    color: tint ?? lighting[style.fallback],
    brightness: clampBrightness(style.dim ? lighting.idleBrightness : lighting.brightness),
    effect: style.effect,
  };
}

const DARK_SLOT: MacropadSlotShadow = {
  index: 0,
  activity: "unbound",
  pinned: false,
};

/**
 * Render the complete frame.
 *
 * Slots are addressed by their `index`, not by array position, and every index
 * in `[0, MACROPAD_SLOT_COUNT)` is emitted whether the caller described it or
 * not. Passing three slots produces six frames; the three the caller forgot are
 * explicitly dark, which is the honest rendering of "nothing is bound there"
 * and is also what the firmware would have done to them anyway.
 */
export function composeFrame(
  slots: readonly MacropadSlotShadow[],
  lighting: MacropadLighting,
): MacropadFullFrame {
  const byIndex = new Map<number, MacropadSlotShadow>();
  for (const slot of slots) {
    if (Number.isInteger(slot.index) && slot.index >= 0 && slot.index < MACROPAD_SLOT_COUNT) {
      byIndex.set(slot.index, slot);
    }
  }
  const frames: MacropadKeyFrame[] = [];
  for (let index = 0; index < MACROPAD_SLOT_COUNT; index++) {
    frames.push(renderSlotFrame(byIndex.get(index) ?? { ...DARK_SLOT, index }, lighting));
  }
  // SAFETY: the loop above ran exactly MACROPAD_SLOT_COUNT times, so this is the
  // branded six-tuple by construction. This cast is the only one in the module
  // and is why no caller can mint a partial frame.
  return frames as unknown as MacropadFullFrame;
}

/** Every key dark. Used on teardown so the device does not keep a stale frame lit. */
export function composeBlankFrame(lighting: MacropadLighting): MacropadFullFrame {
  return composeFrame([], lighting);
}

/**
 * Runtime backstop for the type-level guarantee.
 *
 * The brand cannot survive a JSON round-trip or a `readonly KeyFrame[]` widening
 * at a plugin boundary, so transports assert rather than trust.
 */
export function assertFullFrame(frame: readonly MacropadKeyFrame[]): void {
  if (frame.length !== MACROPAD_SLOT_COUNT) {
    throw new Error(
      `macropad: refusing a partial frame of ${frame.length}; the device repaints all ${MACROPAD_SLOT_COUNT} keys and would blank the rest`,
    );
  }
}

/** Structural equality, so the repaint loop can skip writes that change nothing. */
export function framesEqual(
  left: readonly MacropadKeyFrame[],
  right: readonly MacropadKeyFrame[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((frame, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      frame.color === other.color &&
      frame.brightness === other.brightness &&
      frame.effect === other.effect
    );
  });
}
