// Scripted synthetic extractor data only; no live provider or learned-preference accuracy claim.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const PREFERENCE_LINE = /^SYNTHETIC PREFERENCE: (.+?) -> prefer (\S+)$/gmu;

export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, out);
    }
  }
  return out;
}

function selectedSourceText(input: unknown): string | undefined {
  for (const text of collectStrings(input)) {
    const start = text.indexOf('{"selectedSourceText"');
    if (start < 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text.slice(start));
      if (isRecord(parsed) && typeof parsed.selectedSourceText === "string") {
        return parsed.selectedSourceText;
      }
    } catch {
      // Not the isolated-completion prompt; keep looking.
    }
  }
  return undefined;
}

export function scriptedMiniMeExtraction(input: unknown) {
  const sourceText = selectedSourceText(input);
  if (sourceText === undefined) {
    return undefined;
  }
  const preferences = [...sourceText.matchAll(PREFERENCE_LINE)].map((match) => ({
    preference: {
      document: "PREFERENCES.md",
      scope: match[1]!,
      statement: match[0],
      preferred: [match[2]!],
      avoided: [],
    },
    start: match.index,
    end: match.index + match[0].length,
  }));
  return { sourceText, preferences };
}
