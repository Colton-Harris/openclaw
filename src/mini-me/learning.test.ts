import { describe, expect, it } from "vitest";
import { parseMiniMeExtraction } from "./learning.js";

const preference = {
  document: "TASTE.md",
  scope: "  Editor   theme ",
  statement: "Prefers dark themes",
  preferred: ["dark"],
  avoided: [],
};
const source = { sourceId: "selected", sourceRevision: "rev1", text: "I like dark themes." };

describe("Mini Me source extraction admission", () => {
  it("retains the actual source span and labels model interpretation as inference", () => {
    expect(
      parseMiniMeExtraction({
        ...source,
        response: JSON.stringify({ preferences: [{ preference, start: 0, end: 19 }] }),
      }),
    ).toEqual([
      {
        preference: { ...preference, scope: "editor theme" },
        origin: "inferred",
        evidence: [
          { sourceId: "selected", sourceRevision: "rev1", excerpt: "I like dark themes." },
        ],
      },
    ]);
  });

  it.each([
    { preference, start: 0, end: 999 },
    { preference, start: 7, end: 4 },
    { preference, start: 0, end: 19, approved: true },
    { preference: { ...preference, document: "AUTHORIZATION.md" }, start: 0, end: 19 },
  ])("rejects unsupported spans, artifacts, and injected authority fields: %j", (candidate) => {
    expect(() =>
      parseMiniMeExtraction({ ...source, response: JSON.stringify({ preferences: [candidate] }) }),
    ).toThrow();
  });
});
