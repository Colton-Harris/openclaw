/**
 * Resolves `plugins.entries.macropad.config` into values the rest of the plugin
 * can use without re-validating.
 *
 * The manifest schema is the source of truth for defaults, but a plugin must
 * still survive a config that was hand-edited past the schema, so every field
 * is coerced and clamped here rather than trusted.
 */
import { parseHexColor } from "./colors.js";
import type { MacropadLighting } from "./frame-compositor.js";

export type MacropadConfig = {
  enabled: boolean;
  deviceSerial?: string;
  autoBind: boolean;
  resyncIntervalMs: number;
  lighting: MacropadLighting;
};

const DEFAULTS = {
  brightness: 0.8,
  idleBrightness: 0.15,
  resyncIntervalSeconds: 10,
  colorThinking: "#4C8DFF",
  colorAwaitingApproval: "#FFB020",
  colorError: "#FF4D4D",
} as const;

const MIN_RESYNC_SECONDS = 1;
const MAX_RESYNC_SECONDS = 120;

function readUnitInterval(source: Record<string, unknown>, key: string, fallback: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
}

function readColor(source: Record<string, unknown>, key: string, fallback: string): number {
  const value = source[key];
  // SAFETY: the fallbacks are literal six-digit hex, so the second parse cannot fail.
  return parseHexColor(typeof value === "string" ? value : undefined) ?? parseHexColor(fallback)!;
}

function readSerial(source: Record<string, unknown>): string | undefined {
  const value = source.deviceSerial;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readResyncMs(source: Record<string, unknown>): number {
  const value = source.resyncIntervalSeconds;
  const seconds =
    typeof value === "number" && Number.isFinite(value) ? value : DEFAULTS.resyncIntervalSeconds;
  return Math.round(Math.min(MAX_RESYNC_SECONDS, Math.max(MIN_RESYNC_SECONDS, seconds)) * 1000);
}

export function resolveMacropadConfig(raw: unknown): MacropadConfig {
  const source: Record<string, unknown> =
    // SAFETY: only non-null objects reach the record view; each field is validated below.
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const serial = readSerial(source);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    ...(serial === undefined ? {} : { deviceSerial: serial }),
    autoBind: typeof source.autoBind === "boolean" ? source.autoBind : true,
    resyncIntervalMs: readResyncMs(source),
    lighting: {
      brightness: readUnitInterval(source, "brightness", DEFAULTS.brightness),
      idleBrightness: readUnitInterval(source, "idleBrightness", DEFAULTS.idleBrightness),
      colorThinking: readColor(source, "colorThinking", DEFAULTS.colorThinking),
      colorAwaitingApproval: readColor(
        source,
        "colorAwaitingApproval",
        DEFAULTS.colorAwaitingApproval,
      ),
      colorError: readColor(source, "colorError", DEFAULTS.colorError),
      useSessionColors:
        typeof source.useSessionColors === "boolean" ? source.useSessionColors : true,
    },
  };
}
