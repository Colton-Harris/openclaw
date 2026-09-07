/**
 * Colour helpers.
 *
 * The device takes a single packed `0xRRGGBB` integer per key, not a triplet,
 * so every colour in this plugin is normalised to that representation as early
 * as possible and never travels as a string.
 */

/**
 * Named sidebar tints, mirroring core's `SESSION_COLOR_IDS`.
 *
 * Duplicated deliberately: `extensions/AGENTS.md` forbids importing core
 * internals, and no `openclaw/plugin-sdk/*` subpath re-exports the list. If
 * core ever gains a ninth tint, the unknown name resolves to `undefined` and
 * the key falls back to its status colour rather than going dark.
 */
export const MACROPAD_SESSION_COLOR_IDS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type MacropadSessionColorId = (typeof MACROPAD_SESSION_COLOR_IDS)[number];

/**
 * Named tint to packed RGB.
 *
 * These are the Control UI's own dark-theme `--session-color-*` values
 * (`ui/src/styles/base.css`). Copying them rather than inventing a palette is
 * the whole point of `useSessionColors`: the key and the sidebar dot are meant
 * to be recognisably the same colour, and "close enough" defeats that.
 *
 * Dark theme specifically, because a lit key is an emissive object on a dark
 * desk, not ink on a light page.
 */
export const MACROPAD_SESSION_COLOR_RGB: Readonly<Record<MacropadSessionColorId, number>> = {
  red: 0xf0_78_78,
  blue: 0x72_a7_ed,
  green: 0x69_bf_8a,
  yellow: 0xdc_c3_65,
  purple: 0xb5_95_e8,
  orange: 0xea_a3_6a,
  pink: 0xdf_8c_b9,
  cyan: 0x66_bc_cb,
};

/** Fully dark key. Distinct from "black at zero brightness" only by intent. */
export const MACROPAD_COLOR_OFF = 0x00_00_00;

const HEX_COLOR = /^#?[0-9a-f]{6}$/iu;

/**
 * Parse `#RRGGBB` (or bare `RRGGBB`) into packed RGB.
 *
 * Returns `undefined` rather than throwing: colours arrive from user config,
 * and one malformed hex string must degrade to a default instead of taking the
 * whole device down.
 */
export function parseHexColor(value: string | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) {
    return undefined;
  }
  return Number.parseInt(trimmed.startsWith("#") ? trimmed.slice(1) : trimmed, 16);
}

/** Resolve a session's named sidebar tint. Unknown or absent names yield `undefined`. */
export function resolveSessionColor(id: string | undefined): number | undefined {
  if (typeof id !== "string") {
    return undefined;
  }
  const normalized = id.trim().toLowerCase();
  const known = MACROPAD_SESSION_COLOR_IDS.find((candidate) => candidate === normalized);
  return known === undefined ? undefined : MACROPAD_SESSION_COLOR_RGB[known];
}

/** Clamp an arbitrary number into the device's inclusive 0-1 brightness range. */
export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
