// SYNTHETIC runtime qualification for Mini Me through one isolated real Gateway: real
// trusted-proxy owner, real admitted embedded runs on main and second, real tools,
// storage, isolated-completion extraction and the registered TypeSafe Decision plugin.
// Only the model and System One HTTP endpoints are scripted on loopback, and part of
// the conversation is labeled seeded history. This is NOT genuine owner acceptance and
// NOT live-provider accuracy evidence.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { MINI_ME_DOCUMENT_NAMES } from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import type {
  MiniMeActionGetResult,
  MiniMeActionsResult,
  MiniMeAttachment,
  MiniMePrediction,
  MiniMeSnapshot,
  MiniMeSource,
} from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  attach,
  AGENT_MODEL_REF,
  attachmentOf,
  call,
  createPrivateSession,
  DECISION_MODEL_REF,
  editGrant,
  EXTRACTOR_MODEL_REF,
  HELD_FILE,
  inferredBeliefs,
  MAIN_FILE,
  observeMiniMe,
  ORIGINAL_BYTES,
  parseToolOutput,
  preferenceLine,
  SECOND_FILE,
  seedConversationHistory,
  SEEDED_LINES,
  settleRun,
  sha256,
  sendTurn,
  startMiniMeRuntimeFixture,
  untilSnapshot,
  workspaceRelativePath,
  type MiniMeRuntimeFixture,
} from "./mini-me-runtime-fixture.test-support.ts";

let fixture: MiniMeRuntimeFixture | undefined;
const suite = createControlUiE2eSuite({
  name: "Mini Me runtime qualification (SYNTHETIC, scripted loopback providers)",
  startServerBeforeBrowser: true,
  async startServer() {
    fixture = await startMiniMeRuntimeFixture();
    return { baseUrl: fixture.baseUrl, close: fixture.close };
  },
});

const contextOptions = {
  colorScheme: "light" as const,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 900 },
};
const EDIT_SCOPE = "synthetic edit choice";
const HELD_SCOPE = "synthetic held choice";
const DIRECT_STATEMENT = "SYNTHETIC FIXTURE, not a real person: applies the edit fixture.";
const HELD_LINE = preferenceLine(HELD_SCOPE, "apply");
const INGRESS_SCOPE = "synthetic ingress topic";
const INGRESS_LINE = preferenceLine(INGRESS_SCOPE, "ingress-value");
const NIGHT_SCOPE = "synthetic night drink";
const NIGHT_LINE = preferenceLine(NIGHT_SCOPE, "milk");
const MORNING_SCOPE = "synthetic morning drink";
const EVENING_SCOPE = "synthetic evening drink";
const LEAKED_SCOPES = [
  "synthetic leaked other person",
  "synthetic leaked relay",
  "synthetic leaked assistant",
];

function requireFixture(): MiniMeRuntimeFixture {
  if (!fixture) {
    throw new Error("Mini Me runtime fixture did not start");
  }
  return fixture;
}

const written = (cell: string) => `SYNTHETIC FIXTURE: bytes written by delegated cell ${cell}.\n`;

function choice(scope: string, question: string) {
  return {
    scope,
    question,
    options: [
      { id: "option-1", label: "apply", value: "apply" },
      { id: "option-2", label: "skip", value: "skip" },
    ],
  };
}

/** Scripted `mini_me` arguments: one structured choice with one exact text-file candidate. */
function cellArgs(scope: string, cell: string, relativePath: string) {
  return {
    choice: choice(scope, `SYNTHETIC: apply the fixture edit for cell ${cell}?`),
    candidates: [
      { optionId: "option-1", effect: "workspace.edit", relativePath, content: written(cell) },
    ],
  };
}

function createParams(attachments: Array<Pick<MiniMeAttachment, "agentId" | "mode" | "grants">>) {
  return {
    operationId: randomUUID(),
    name: "Synthetic Runtime Mini Me",
    // Explicit destination consent for extraction; no Decision model yet.
    models: { conversationModel: EXTRACTOR_MODEL_REF, decisionModel: null, allowInference: true },
    sources: [],
    attachments,
  };
}

async function openOwnerPage(page: Page): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem(
      "openclaw:control-ui:community-invite:v2",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    ),
  );
  expect((await page.goto(requireFixture().baseUrl))?.status()).toBe(200);
  await waitForControlUiGatewayReady(page);
}

/** One real owner turn; the scripted model calls `mini_me`, then answers its real result. */
async function runCell(page: Page, sessionKey: string, cell: string, args: object) {
  const { provider } = requireFixture();
  const started = performance.now();
  provider.script(cell, { ...args });
  await settleRun(
    page,
    await sendTurn(page, sessionKey, `[[cell:${cell}]] SYNTHETIC owner request for a choice.`),
  );
  process.stdout.write(
    `[Mini Me synthetic runtime timing] ${cell}: ${(performance.now() - started).toFixed(1)} ms\n`,
  );
  return cellResult(cell);
}

function cellResult(cell: string) {
  const { provider } = requireFixture();
  const raw = provider.cellOutput(cell);
  expect(
    raw,
    `cell ${cell} must return a real mini_me tool result (turns without the tool: ${provider.toollessCells.join(", ") || "none"})`,
  ).toBeDefined();
  return parseToolOutput(raw);
}

function conversationSource(snapshot: MiniMeSnapshot): MiniMeSource | undefined {
  return snapshot.sources.find((source) => source.selection.kind === "conversation");
}

suite.define(() => {
  it("SYNTHETIC runtime proof, not genuine owner or live-provider acceptance: four modes, exact grants, spent limit, restore receipt, Decision batch and held revocation on main and second", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => fixture?.instance.stateDir,
      async run(signal) {
        const { provider, workspaces } = requireFixture();
        await suite.withPage(contextOptions, async ({ page }) => {
          const observer = observeMiniMe(page);
          await openOwnerPage(page);
          const bytes = (dir: string, file: string) => readFile(path.join(dir, file), "utf8");
          const mainKey = "agent:main:mini-me-runtime-delegation";
          const secondKey = "agent:second:mini-me-runtime-delegation";
          await createPrivateSession(page, mainKey, "main");
          await createPrivateSession(page, secondKey, "second");
          // Before opt-in the ordinary admitted run has no Mini Me tool or inference work.
          const beforeOptIn = performance.now();
          provider.script("C0", cellArgs(EDIT_SCOPE, "C0", MAIN_FILE));
          await settleRun(
            page,
            await sendTurn(page, mainKey, "[[cell:C0]] SYNTHETIC ordinary turn."),
          );
          process.stdout.write(
            `[Mini Me synthetic runtime timing] before opt-in: ${(performance.now() - beforeOptIn).toFixed(1)} ms\n`,
          );
          expect(provider.toollessCells).toContain("C0");
          expect(provider.cellOutput("C0")).toBeUndefined();
          expect(provider.extractions).toHaveLength(0);
          expect(provider.decisions).toHaveLength(0);
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(ORIGINAL_BYTES[MAIN_FILE]);
          let snapshot = await call<MiniMeSnapshot>(
            page,
            "miniMe.create",
            createParams([
              { agentId: "main", mode: "dont-decide", grants: [editGrant("g-main", MAIN_FILE, 1)] },
              { agentId: "second", mode: "dont-decide", grants: [] },
            ]),
          );
          expect(snapshot.profile).toMatchObject({ lifecycle: "active" });
          // The host canonicalizes the operator's path into one exact workspace resource.
          expect(attachmentOf(snapshot, "main").grants.map((grant) => grant.resources)).toEqual([
            [expect.stringMatching(/^workspace:/u)],
          ]);
          expect(
            attachmentOf(snapshot, "main").grants[0]!.resources.map(workspaceRelativePath),
          ).toEqual([MAIN_FILE]);
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.learn", {
            operationId: randomUUID(),
            preference: {
              document: "PREFERENCES.md",
              scope: EDIT_SCOPE,
              statement: DIRECT_STATEMENT,
              preferred: ["apply"],
              avoided: [],
            },
          });
          // Don't decide: even with an exact grant, the admitted run gets advice only.
          expect(
            await runCell(page, mainKey, "C1", cellArgs(EDIT_SCOPE, "C1", MAIN_FILE)),
          ).toMatchObject({
            kind: "advice",
            prediction: { optionId: "option-1", uncertainty: "low", authority: "advisory" },
          });
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(ORIGINAL_BYTES[MAIN_FILE]);

          // Decide auto without any grant: denied, the owner still decides.
          snapshot = await attach(page, snapshot, "main", "auto", []);
          expect(
            await runCell(page, mainKey, "C2", cellArgs(EDIT_SCOPE, "C2", MAIN_FILE)),
          ).toMatchObject({
            kind: "pending-owner",
            reason: "No current grant covers this exact action.",
          });
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(ORIGINAL_BYTES[MAIN_FILE]);

          // Decide safe with the exact one-action grant: the admitted write tool runs.
          await attach(page, snapshot, "main", "safe", [editGrant("g-main", MAIN_FILE, 1)]);
          const executed = await runCell(
            page,
            mainKey,
            "C3",
            cellArgs(EDIT_SCOPE, "C3", MAIN_FILE),
          );
          expect(executed).toMatchObject({
            kind: "executed",
            prediction: { optionId: "option-1", authority: "advisory" },
            execution: { outcome: { state: "succeeded" }, settlement: { state: "recorded" } },
          });
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(written("C3"));
          const receiptId = executed?.restoreReceiptId;
          expect(typeof receiptId).toBe("string");
          const restore = await call<MiniMeActionGetResult>(page, "miniMe.action.get", {
            receiptId,
          });
          expect(restore.receipt).toMatchObject({
            receiptId,
            targetAgentId: "main",
            afterSha256: sha256(written("C3")),
          });
          expect(workspaceRelativePath(restore.receipt.resource)).toBe(MAIN_FILE);
          expect(restore.before).toEqual({
            utf8: ORIGINAL_BYTES[MAIN_FILE],
            sha256: sha256(ORIGINAL_BYTES[MAIN_FILE]),
          });

          // The spent one-action limit refuses the next delegated edit; C3's bytes remain.
          expect(
            await runCell(page, mainKey, "C4", cellArgs(EDIT_SCOPE, "C4", MAIN_FILE)),
          ).toMatchObject({
            kind: "pending-owner",
          });
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(written("C3"));
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.get", {});
          expect(
            attachmentOf(snapshot, "main").usage.find((item) => item.grantId === "g-main")
              ?.consumed,
          ).toBe(1);

          // Decide all on the second agent, bounded by its own exact grant.
          snapshot = await attach(page, snapshot, "second", "all", [
            editGrant("g-second", SECOND_FILE, 1),
          ]);
          expect(
            await runCell(page, secondKey, "C5", cellArgs(EDIT_SCOPE, "C5", SECOND_FILE)),
          ).toMatchObject({
            kind: "executed",
            execution: { outcome: { state: "succeeded" }, settlement: { state: "recorded" } },
          });
          expect(await bytes(workspaces.second, SECOND_FILE)).toBe(written("C5"));

          // Decide auto also executes a grounded choice under its own current grant.
          snapshot = await attach(page, snapshot, "second", "auto", [
            editGrant("g-auto", SECOND_FILE, 1),
          ]);
          expect(
            await runCell(page, secondKey, "C5auto", cellArgs(EDIT_SCOPE, "C5auto", SECOND_FILE)),
          ).toMatchObject({
            kind: "executed",
            execution: { outcome: { state: "succeeded" }, settlement: { state: "recorded" } },
          });
          expect(await bytes(workspaces.second, SECOND_FILE)).toBe(written("C5auto"));

          // Inferred learning from a selected document through the real isolated completion.
          const taste = snapshot.documents.find((document) => document.name === "TASTE.md");
          expect(taste).toBeDefined();
          const extractionsBefore = provider.extractions.length;
          await call(page, "miniMe.document.set", {
            operationId: randomUUID(),
            name: "TASTE.md",
            expectedRevision: taste!.revision,
            content: `${HELD_LINE}\n`,
          });
          await call(page, "miniMe.source.add", {
            operationId: randomUUID(),
            source: { kind: "document", name: "TASTE.md" },
          });
          snapshot = await untilSnapshot(
            page,
            observer,
            (current) => inferredBeliefs(current, HELD_SCOPE).length > 0,
            signal,
          );
          expect(provider.extractions.slice(extractionsBefore)).toEqual([
            { sourceText: `${HELD_LINE}\n`, scopes: [HELD_SCOPE] },
          ]);
          const held = inferredBeliefs(snapshot, HELD_SCOPE)[0]!;
          expect(held).toMatchObject({
            status: "active",
            evidence: [expect.objectContaining({ excerpt: HELD_LINE })],
          });

          // Baseline without a Decision model: inferred evidence stays medium, zero requests.
          const baseline = await call<MiniMePrediction>(page, "miniMe.predict", {
            operationId: randomUUID(),
            choice: choice(HELD_SCOPE, "SYNTHETIC: apply the held edit (baseline)?"),
          });
          expect(baseline).toMatchObject({
            provider: "explicit-preference-baseline",
            optionId: "option-1",
            uncertainty: "medium",
            beliefIds: [held.id],
          });
          expect(provider.decisions).toHaveLength(0);

          // The registered TypeSafe plugin (local System One origin) gets the bounded batch.
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.get", {});
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.configure", {
            operationId: randomUUID(),
            expectedRevision: snapshot.profile!.revision,
            models: {
              conversationModel: EXTRACTOR_MODEL_REF,
              decisionModel: DECISION_MODEL_REF,
              allowInference: true,
            },
          });
          const decided = await call<MiniMePrediction>(page, "miniMe.predict", {
            operationId: randomUUID(),
            choice: choice(HELD_SCOPE, "SYNTHETIC: apply the held edit (Decision)?"),
          });
          expect(decided).toMatchObject({
            provider: "kev-latest",
            optionId: "option-1",
            uncertainty: "medium",
            authority: "advisory",
          });
          expect(provider.decisions).toHaveLength(1);
          const batch = provider.decisions[0]!;
          expect(batch.bytes).toBeLessThanOrEqual(32_768);
          expect(batch.body).toMatchObject({
            model: "kev-latest",
            state: {
              scope: HELD_SCOPE,
              evidence: [
                {
                  statement: HELD_LINE,
                  origin: "inferred",
                  preferred: ["apply"],
                  avoided: [],
                  quotes: [HELD_LINE],
                },
              ],
            },
          });
          const questions = batch.body.questions as Record<string, { criteria: object }>;
          expect(Object.keys(questions)).toEqual(["preference"]);
          expect(Object.keys(questions.preference!.criteria)).toEqual([
            "abstain",
            "option-1",
            "option-2",
          ]);
          // Other topics, grants and workspace resources never reach the Decision destination.
          for (const excluded of [DIRECT_STATEMENT, "g-main", "workspace:"]) {
            expect(JSON.stringify(batch.body)).not.toContain(excluded);
          }

          // Revocation while an admitted consultation is held at the Decision provider.
          snapshot = await attach(page, snapshot, "second", "auto", [
            editGrant("g-held", HELD_FILE, 1),
          ]);
          provider.holdNextDecisions();
          provider.script("C6", cellArgs(HELD_SCOPE, "C6", HELD_FILE));
          const heldRun = await sendTurn(
            page,
            secondKey,
            "[[cell:C6]] SYNTHETIC owner request for a choice.",
          );
          const pending = await provider.until(() => provider.heldDecision(), signal);
          expect(pending.closed).toBe(false);
          snapshot = await attach(page, snapshot, "second", "auto", []);
          expect(attachmentOf(snapshot, "second")).toMatchObject({ mode: "auto", grants: [] });
          await provider.until(() => (pending.closed ? true : undefined), signal);
          await settleRun(page, heldRun);
          expect(cellResult("C6")?.kind).not.toBe("executed");
          expect(await bytes(workspaces.second, HELD_FILE)).toBe(ORIGINAL_BYTES[HELD_FILE]);
          expect(provider.decisions).toHaveLength(2);

          const actions = await call<MiniMeActionsResult>(page, "miniMe.actions", {});
          expect(actions.receipts.map((receipt) => receipt.receiptId)).toContain(receiptId);
          expect(
            actions.receipts.map((receipt) => workspaceRelativePath(receipt.resource)),
          ).not.toContain(HELD_FILE);
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.get", {});
          // Only executed effects are recorded, as delegated; no owner outcome is synthesized.
          expect(snapshot.outcomes.map((outcome) => outcome.origin)).toEqual([
            "delegated",
            "delegated",
            "delegated",
          ]);
          // Disabling removes the tool from a subsequent ordinary admitted turn.
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.configure", {
            operationId: randomUUID(),
            expectedRevision: snapshot.profile!.revision,
            enabled: false,
          });
          expect(snapshot.profile?.lifecycle).toBe("disabled");
          const modelWork = {
            extractions: provider.extractions.length,
            decisions: provider.decisions.length,
          };
          const disabledStart = performance.now();
          provider.script("C7", cellArgs(EDIT_SCOPE, "C7", MAIN_FILE));
          await settleRun(
            page,
            await sendTurn(page, mainKey, "[[cell:C7]] SYNTHETIC ordinary turn while disabled."),
          );
          process.stdout.write(
            `[Mini Me synthetic runtime timing] disabled: ${(performance.now() - disabledStart).toFixed(1)} ms\n`,
          );
          expect(provider.toollessCells).toContain("C7");
          expect(provider.cellOutput("C7")).toBeUndefined();
          expect(provider.extractions).toHaveLength(modelWork.extractions);
          expect(provider.decisions).toHaveLength(modelWork.decisions);
          expect(await bytes(workspaces.main, MAIN_FILE)).toBe(written("C3"));
          // Client-side evidence only: this owner connection never requested or resolved an approval.
          expect(
            observer.sentMethods().filter((method) => /approval\.(request|resolve)$/u.test(method)),
          ).toEqual([]);
          expect(provider.failures).toEqual([]);
        });
      },
    });
  }, 300_000);

  it("SYNTHETIC seeded-history proof, not genuine owner or live-provider acceptance: owner-only extraction across 100 entries, incremental learning and durable undo", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => fixture?.instance.stateDir,
      async run(signal) {
        const current = requireFixture();
        const { provider } = current;
        await suite.withPage(contextOptions, async ({ page }) => {
          const observer = observeMiniMe(page);
          await openOwnerPage(page);
          let snapshot = await call<MiniMeSnapshot>(page, "miniMe.get", {});
          // Independent of the first test's outcome: opt in here when it did not.
          if (!snapshot.profile) {
            snapshot = await call<MiniMeSnapshot>(page, "miniMe.create", createParams([]));
          }
          if (snapshot.profile?.lifecycle === "disabled") {
            await call<MiniMeSnapshot>(page, "miniMe.configure", {
              operationId: randomUUID(),
              expectedRevision: snapshot.profile.revision,
              enabled: true,
            });
          }
          const sourceKey = "agent:main:mini-me-runtime-source";
          const sessionId = await createPrivateSession(page, sourceKey, "main");
          // One real owner chat ingress establishes the canonical stored sender and provenance.
          provider.script("L1", null);
          await settleRun(
            page,
            await sendTurn(
              page,
              sourceKey,
              `[[cell:L1]] SYNTHETIC owner ingress.\n${INGRESS_LINE}`,
            ),
          );
          // SEEDED HISTORY: 118 labeled synthetic entries through the canonical batch owner.
          await seedConversationHistory({ fixture: current, sessionKey: sourceKey, sessionId });

          const before = provider.extractions.length;
          await call(page, "miniMe.source.add", {
            operationId: randomUUID(),
            source: { kind: "conversation", sessionKey: sourceKey, mode: "ongoing" },
          });
          snapshot = await untilSnapshot(
            page,
            observer,
            (next) => {
              const source = conversationSource(next);
              // A committed page can publish ready before the next page commits.
              // Wait for the final page's actual learned evidence, not that intermediate update.
              return (
                source !== undefined &&
                source.status !== "pending" &&
                inferredBeliefs(next, EVENING_SCOPE).length > 0
              );
            },
            signal,
          );
          const source = conversationSource(snapshot)!;
          expect(source, source.detail ?? undefined).toMatchObject({
            status: "ready",
            detail: null,
          });
          // More than 100 entries: the reader pages at 100, so one round sends two pages.
          const pages = provider.extractions.slice(before).map((item) => item.sourceText);
          expect(pages).toHaveLength(2);
          expect(pages[0]).toContain(INGRESS_LINE);
          expect(pages[0]).toContain(SEEDED_LINES.pageOne);
          expect(pages[0]).not.toContain(SEEDED_LINES.pageTwo);
          expect(pages[1]).toContain(SEEDED_LINES.pageTwo);
          expect(pages[1]).not.toContain(SEEDED_LINES.pageOne);
          // Canonical owner sender filtering: other people, relays and assistants never egress.
          for (const leaked of [
            SEEDED_LINES.otherPerson,
            SEEDED_LINES.interSession,
            SEEDED_LINES.assistant,
          ]) {
            expect(pages.join("\n")).not.toContain(leaked);
          }
          for (const scope of [INGRESS_SCOPE, MORNING_SCOPE, EVENING_SCOPE]) {
            expect(inferredBeliefs(snapshot, scope)).toEqual([
              expect.objectContaining({
                status: "active",
                evidence: [expect.objectContaining({ sourceId: source.id })],
              }),
            ]);
          }
          for (const scope of LEAKED_SCOPES) {
            expect(inferredBeliefs(snapshot, scope)).toEqual([]);
          }

          // Undo one inferred belief; its suppression is bound to the excerpt and source.
          const morning = inferredBeliefs(snapshot, MORNING_SCOPE)[0]!;
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.undo", {
            operationId: randomUUID(),
            beliefId: morning.id,
          });
          expect(snapshot.beliefs.find((belief) => belief.id === morning.id)?.status).toBe(
            "undone",
          );

          // Ongoing learning resumes from saved progress after the next settled owner turn.
          const afterUndo = provider.extractions.length;
          provider.script("L2", null);
          await settleRun(
            page,
            await sendTurn(
              page,
              sourceKey,
              `[[cell:L2]] SYNTHETIC later owner turn.\n${SEEDED_LINES.pageOne}\n${NIGHT_LINE}`,
            ),
          );
          snapshot = await untilSnapshot(
            page,
            observer,
            (next) => {
              const status = conversationSource(next);
              if (status?.status === "unavailable" || status?.status === "limit-reached") {
                throw new Error(`Incremental source learning failed: ${status.detail}`);
              }
              return inferredBeliefs(next, NIGHT_SCOPE).length > 0;
            },
            signal,
          );
          const incremental = provider.extractions.slice(afterUndo).map((item) => item.sourceText);
          // A concurrent session publication may invalidate a page after model egress.
          // At most two fresh-admission retries are allowed; every attempt is still scoped.
          expect(incremental.length).toBeGreaterThanOrEqual(1);
          expect(incremental.length).toBeLessThanOrEqual(3);
          for (const text of incremental) {
            expect(text).toContain(SEEDED_LINES.pageOne);
            expect(text).toContain(NIGHT_LINE);
            expect(text).not.toContain(INGRESS_LINE);
            expect(text).not.toContain(SEEDED_LINES.pageTwo);
          }
          // The unchanged excerpt was extracted again but the undo was not recreated.
          expect(
            inferredBeliefs(snapshot, MORNING_SCOPE).map((belief) => [belief.id, belief.status]),
          ).toEqual([[morning.id, "undone"]]);
          expect(inferredBeliefs(snapshot, NIGHT_SCOPE)).toEqual([
            expect.objectContaining({ status: "active" }),
          ]);
          expect(provider.failures).toEqual([]);
        });
      },
    });
  }, 300_000);
  it("SYNTHETIC private Mini Me conversation receives all six authored personal files", async (test) => {
    await suite.runScenario(test, {
      retainedState: () => fixture?.instance.stateDir,
      async run() {
        const { provider } = requireFixture();
        await suite.withPage(contextOptions, async ({ page }) => {
          await openOwnerPage(page);
          let snapshot = await call<MiniMeSnapshot>(page, "miniMe.get", {});
          if (!snapshot.profile) {
            snapshot = await call<MiniMeSnapshot>(page, "miniMe.create", createParams([]));
          }
          snapshot = await call<MiniMeSnapshot>(page, "miniMe.configure", {
            operationId: randomUUID(),
            expectedRevision: snapshot.profile!.revision,
            enabled: true,
            models: {
              conversationModel: AGENT_MODEL_REF,
              decisionModel: null,
              allowInference: false,
            },
          });
          for (const name of MINI_ME_DOCUMENT_NAMES) {
            snapshot = await call<MiniMeSnapshot>(page, "miniMe.document.set", {
              operationId: randomUUID(),
              name,
              expectedRevision: snapshot.documents.find((item) => item.name === name)!.revision,
              content: `SYNTHETIC PERSONAL FILE ${name}: unique owner-authored context.`,
            });
          }
          const agentId = snapshot.profile!.agentId;
          const key = `agent:${agentId}:private-persona-proof`;
          await createPrivateSession(page, key, agentId);
          provider.script("PERSONA", null);
          await settleRun(
            page,
            await sendTurn(page, key, "[[cell:PERSONA]] SYNTHETIC private conversation."),
          );
          const prompt = provider.cellPrompt("PERSONA");
          expect(prompt).toBeDefined();
          for (const name of MINI_ME_DOCUMENT_NAMES) {
            expect(prompt).toContain(
              `SYNTHETIC PERSONAL FILE ${name}: unique owner-authored context.`,
            );
          }
          expect(provider.failures).toEqual([]);
        });
      },
    });
  }, 120_000);
});
