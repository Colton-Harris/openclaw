// SYNTHETIC integration proof for Mini Me through an isolated real Gateway, real
// SQLite people, and trusted-proxy browser identities. These fixture owners and
// their tea/coffee preferences are invented; this is not genuine owner acceptance.
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type {
  MiniMeExportResult,
  MiniMePrediction,
  MiniMeSnapshot,
} from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import type { OpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  waitForConfirmModal,
  waitForControlUiGatewayReady,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  checkAndCapture,
  recordGatewayFrames,
  requestThroughBrowserClient,
  startTrustedIdentityProxy,
  type GatewayFrameLog,
  type ObservedResponse,
} from "./mini-me-real.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Mini Me synthetic owners through a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const ownerA = { email: "mini-me-synthetic-a@example.test", name: "Synthetic Owner A" };
const ownerB = { email: "mini-me-synthetic-b@example.test", name: "Synthetic Owner B" };
const miniMeName = "Synthetic Mini Me A";
const scope = "synthetic drink choice";
const teaStatement = "SYNTHETIC FIXTURE, not a real person: prefers tea over coffee.";
const coffeeCorrection = "SYNTHETIC FIXTURE CORRECTION: this test owner now chooses coffee.";
const firstQuestion = "SYNTHETIC: tea or coffee this morning?";
const secondQuestion = "SYNTHETIC: tea or coffee this afternoon?";
// The six owner-visible files Mini Me projects into its private agent workspace.
const projectedFiles = [
  "SOUL.md",
  "OPINIONS.md",
  "PREFERENCES.md",
  "MORALS.md",
  "TASTE.md",
  "DECISIONS.md",
] as const;
const projectionHeader = "<!-- openclaw-mini-me ";
const contextOptions = {
  colorScheme: "light" as const,
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 1000 },
};

function snapshotOf(response: ObservedResponse): MiniMeSnapshot {
  expect(response.error).toBeUndefined();
  expect(response.ok).toBe(true);
  return response.payload as MiniMeSnapshot;
}

function predictionOf(response: ObservedResponse): MiniMePrediction {
  expect(response.error).toBeUndefined();
  expect(response.ok).toBe(true);
  return response.payload as MiniMePrediction;
}

function section(root: Locator, heading: string): Locator {
  return root
    .locator("section.settings-section")
    .filter({ has: root.page().getByRole("heading", { name: heading, exact: true }) });
}

function beliefDescription(feature: Locator, statement: string): Promise<string | null> {
  return feature
    .locator(".settings-row")
    .filter({ has: feature.page().locator(".settings-row__title", { hasText: statement }) })
    .locator(".settings-row__desc")
    .first()
    .textContent();
}

function predictedLabel(prediction: Locator): Promise<string | null> {
  return prediction
    .locator(".settings-row__title")
    .first()
    .textContent()
    .then((text) => text?.trim() ?? null);
}

function welcomeReads(frames: GatewayFrameLog): ObservedResponse[] {
  return frames
    .responses("users.prefs.get")
    .filter((response) => JSON.stringify(response.params).includes("miniMe.welcome.v1"));
}

/** Each document load reads the notice state for its own person; wait for that read. */
async function expectPersistedDismissal(frames: GatewayFrameLog, previous: number): Promise<void> {
  await expect.poll(() => welcomeReads(frames).length).toBeGreaterThan(previous);
  expect(welcomeReads(frames).at(-1)).toMatchObject({
    ok: true,
    payload: { status: "ok", entries: { "miniMe.welcome.v1": "dismissed" } },
  });
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function openMiniMe(page: Page, gatewayUrl: URL): Promise<void> {
  await page.addInitScript(() =>
    localStorage.setItem(
      "openclaw:control-ui:community-invite:v2",
      JSON.stringify({ dismissedAtMs: 1770000000000 }),
    ),
  );
  const url = new URL("mini-me", suite.server.baseUrl);
  url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
  expect((await page.goto(url.href))?.status()).toBe(200);
  await page
    .locator("openclaw-gateway-url-confirmation")
    .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
    .click();
  await waitForControlUiGatewayReady(page);
}

/** A fresh document load reconnects with the persisted Gateway selection. */
async function reopenMiniMe(page: Page): Promise<void> {
  expect((await page.goto(new URL("mini-me", suite.server.baseUrl).href))?.status()).toBe(200);
  await waitForControlUiGatewayReady(page);
}

suite.define(() => {
  it("SYNTHETIC integration, not genuine owner acceptance: two trusted-proxy owners opt in, learn, predict, correct, stay isolated, and delete", async (test) => {
    let state: OpenClawTestState | undefined;
    let gateway: OpenClawTestInstance | undefined;
    let proxyA: ViteDevServer | undefined;
    let proxyB: ViteDevServer | undefined;
    await suite.runScenario(test, {
      retainedState: () => state?.root,
      async run(signal) {
        const instance = await createOpenClawTestInstance({
          name: "control-ui-mini-me-real-gateway",
          env: {
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_PROVIDERS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            VITEST: undefined,
          },
        });
        gateway = instance;
        const fixture = instance.state;
        state = fixture;
        signal.throwIfAborted();
        const secondWorkspace = fixture.path("workspace-second");
        await mkdir(secondWorkspace, { recursive: true });
        // Canonical people: the trusted-proxy emails resolve to these SQLite profiles.
        for (const owner of [ownerA, ownerB]) {
          const storage = { env: instance.env };
          setDisplayName(ensureProfileForEmail(owner.email, storage).id, owner.name, storage);
        }
        const port = instance.port;
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [ownerA.email, ownerB.email],
          deviceAutoApprove: {
            enabled: true,
            scopes: ["operator.admin", "operator.read", "operator.write"],
          },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        await fixture.writeConfig({
          agents: {
            ownership: "explicit",
            defaults: {
              workspace: fixture.workspaceDir,
              systemAgent: { agentId: "main" },
              heartbeat: { agentId: "main" },
              sessionStore: { agentId: "main" },
            },
            entries: {
              main: { name: "Main", workspace: fixture.workspaceDir },
              second: { name: "Second", workspace: secondWorkspace },
            },
          },
          talk: { agentId: "main" },
          gateway: {
            auth: { mode: "trusted-proxy", trustedProxy },
            controlUi: {
              allowedOrigins: [new URL(suite.server.baseUrl).origin],
              enabled: false,
            },
            port,
            trustedProxies: ["127.0.0.1", "::1"],
          },
        });
        signal.throwIfAborted();
        // Agent provisioning requires the normal managed config-reload owner.
        await instance.startGateway();
        signal.throwIfAborted();
        const identityA = await startTrustedIdentityProxy({
          root: fixture.workspaceDir,
          gatewayPort: port,
          email: ownerA.email,
        });
        proxyA = identityA.server;
        const identityB = await startTrustedIdentityProxy({
          root: fixture.workspaceDir,
          gatewayPort: port,
          email: ownerB.email,
        });
        proxyB = identityB.server;
        signal.throwIfAborted();
        const artifacts =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("mini-me-real-gateway")
            : undefined;

        await suite.withPage(contextOptions, async ({ page: pageA }) => {
          const framesA = recordGatewayFrames(pageA);
          const featureA = pageA.locator("openclaw-mini-me-page");
          await openMiniMe(pageA, identityA.gatewayUrl);
          expect(snapshotOf(await framesA.nextResponse("miniMe.get", 0)).profile).toBeNull();

          // Dismissing the notice and cancelling setup leave no profile behind.
          const welcomeA = pageA.locator(".mini-me-welcome");
          const welcomeHeading = welcomeA.getByRole("heading", { name: "Meet your Mini Me." });
          await welcomeHeading.waitFor();
          await checkAndCapture(pageA, artifacts, "01-owner-a-welcome", welcomeA, [welcomeHeading]);
          const dismissals = framesA.responses("users.prefs.set").length;
          await welcomeA.getByRole("button", { name: "Maybe later", exact: true }).click();
          expect((await framesA.nextResponse("users.prefs.set", dismissals)).ok).toBe(true);
          await welcomeA.waitFor({ state: "detached" });
          await featureA.getByRole("button", { name: "Set up", exact: true }).click();
          await featureA
            .getByRole("textbox", { name: "Name", exact: true })
            .fill("Never created synthetic Mini Me");
          await featureA.getByRole("button", { name: "Continue", exact: true }).click();
          await featureA.getByRole("button", { name: "Cancel", exact: true }).click();
          await featureA.getByRole("button", { name: "Set up", exact: true }).waitFor();
          let reads = framesA.responses("miniMe.get").length;
          const noticeReadsA = welcomeReads(framesA).length;
          await reopenMiniMe(pageA);
          expect(snapshotOf(await framesA.nextResponse("miniMe.get", reads)).profile).toBeNull();
          await expectPersistedDismissal(framesA, noticeReadsA);
          await featureA.getByRole("button", { name: "Set up", exact: true }).waitFor();
          expect(await welcomeA.count()).toBe(0);
          expect(framesA.requests("miniMe.create")).toHaveLength(0);

          // Opt in with the baseline decision route, the manual source, and two agents.
          await featureA.getByRole("button", { name: "Set up", exact: true }).click();
          await featureA.getByRole("textbox", { name: "Name", exact: true }).fill(miniMeName);
          await featureA
            .locator(".settings-row__desc", { hasText: "Stated-preference matcher" })
            .waitFor();
          await featureA.getByRole("button", { name: "Continue", exact: true }).click();
          for (const agent of ["Main", "Second"]) {
            const control = featureA.getByRole("switch", { name: agent, exact: true });
            // Web Awesome's visible thumb overlays its native input. Exercise its accessible key path.
            await control.press("Space");
            expect(await control.isChecked()).toBe(true);
          }
          await featureA.getByRole("button", { name: "Continue", exact: true }).click();
          const review = featureA.locator("fieldset.settings-fieldset");
          const reviewed = [
            review.getByText("Preferences you enter", { exact: true }),
            review.getByText("Main — Don’t decide", { exact: true }),
            review.getByText("Second — Don’t decide", { exact: true }),
          ];
          await Promise.all(reviewed.map((item) => item.waitFor()));
          await checkAndCapture(pageA, artifacts, "02-owner-a-setup-review", review, reviewed);
          const creates = framesA.responses("miniMe.create").length;
          await featureA.getByRole("button", { name: "Create Mini Me", exact: true }).click();
          const created = snapshotOf(await framesA.nextResponse("miniMe.create", creates));
          expect(framesA.requests("miniMe.create")).toEqual([
            expect.objectContaining({
              name: miniMeName,
              models: { conversationModel: null, decisionModel: null, allowInference: false },
              sources: [{ kind: "manual", label: "Preferences you enter" }],
              attachments: [
                { agentId: "main", mode: "dont-decide", grants: [] },
                { agentId: "second", mode: "dont-decide", grants: [] },
              ],
            }),
          ]);
          const profile = created.profile!;
          expect(profile).toMatchObject({ name: miniMeName, lifecycle: "active" });
          expect(
            created.attachments
              .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
              .map((item) => [item.agentId, item.mode, item.grants]),
          ).toEqual([
            ["main", "dont-decide", []],
            ["second", "dont-decide", []],
          ]);

          // A clearly synthetic stated preference: tea versus coffee.
          expect(
            await featureA
              .getByRole("combobox", { name: "Personal file", exact: true })
              .inputValue(),
          ).toBe("PREFERENCES.md");
          await featureA
            .getByRole("textbox", { name: "When does this apply?", exact: true })
            .fill(scope);
          await featureA
            .getByRole("textbox", { name: "What should it know?", exact: true })
            .fill(teaStatement);
          await featureA.getByRole("textbox", { name: "Prefer", exact: true }).fill("tea");
          const learns = framesA.responses("miniMe.learn").length;
          await featureA.getByRole("button", { name: "Add preference", exact: true }).click();
          const learned = snapshotOf(await framesA.nextResponse("miniMe.learn", learns));
          const teaBelief = learned.beliefs.find(
            (belief) => belief.preference.statement === teaStatement,
          )!;
          expect(teaBelief).toMatchObject({
            origin: "direct",
            status: "active",
            preference: { document: "PREFERENCES.md", scope, preferred: ["tea"], avoided: [] },
          });
          await expect
            .poll(() => beliefDescription(featureA, teaStatement))
            .toContain("You stated · Active");

          // A structured choice is grounded in that preference and cites it.
          await featureA.getByRole("tab", { name: "Decisions", exact: true }).click();
          const ask = section(featureA, "Ask my Mini Me");
          const askChoice = async (question: string) => {
            await ask
              .getByRole("textbox", { name: "When does this apply?", exact: true })
              .fill(scope);
            await ask.getByRole("textbox", { name: "Your choice", exact: true }).fill(question);
            await ask.getByRole("textbox", { name: "Options", exact: true }).fill("tea\ncoffee");
            const predictions = framesA.responses("miniMe.predict").length;
            await ask.getByRole("button", { name: "Ask my Mini Me", exact: true }).click();
            return predictionOf(await framesA.nextResponse("miniMe.predict", predictions));
          };
          const first = await askChoice(firstQuestion);
          expect(first).toMatchObject({
            optionId: "option-1",
            uncertainty: "low",
            correctionApplied: false,
            provider: "explicit-preference-baseline",
            authority: "advisory",
            beliefIds: [teaBelief.id],
            evidence: [expect.objectContaining({ excerpt: teaStatement })],
          });
          const firstSection = section(featureA, firstQuestion);
          await expect.poll(() => predictedLabel(firstSection)).toBe("tea");
          const groundedTea = [
            firstSection.getByText("This option matches an explicit preference for this topic.", {
              exact: true,
            }),
            firstSection.getByText("Uncertainty: Low", { exact: true }),
            firstSection.getByText("Decision route: explicit-preference-baseline", {
              exact: true,
            }),
          ];
          await Promise.all(groundedTea.map((item) => item.waitFor()));
          await firstSection.locator("summary", { hasText: "Evidence" }).click();
          const teaEvidence = firstSection
            .locator("blockquote")
            .getByText(teaStatement, { exact: true });
          await teaEvidence.waitFor();
          await checkAndCapture(pageA, artifacts, "03-owner-a-grounded-tea", firstSection, [
            ...groundedTea,
            teaEvidence,
          ]);

          // A separate genuine-choice record (still synthetic) with an explicit correction.
          await firstSection
            .getByRole("combobox", {
              name: `What did you actually choose? — ${firstQuestion}`,
              exact: true,
            })
            .selectOption({ label: "coffee" });
          await firstSection
            .getByRole("checkbox", {
              name: "Apply a correction to comparable choices",
              exact: true,
            })
            .check();
          expect(
            await firstSection
              .getByRole("textbox", { name: "When does this apply?", exact: true })
              .inputValue(),
          ).toBe(scope);
          expect(
            await firstSection.getByRole("textbox", { name: "Prefer", exact: true }).inputValue(),
          ).toBe("coffee");
          await firstSection
            .getByRole("textbox", { name: "What should it know?", exact: true })
            .fill(coffeeCorrection);
          const outcomes = framesA.responses("miniMe.outcome").length;
          await firstSection
            .getByRole("button", { name: "Record my decision", exact: true })
            .click();
          const recorded = snapshotOf(await framesA.nextResponse("miniMe.outcome", outcomes));
          expect(framesA.requests("miniMe.outcome")).toEqual([
            expect.objectContaining({
              predictionId: first.id,
              optionId: "option-2",
              correction: {
                document: "PREFERENCES.md",
                scope,
                statement: coffeeCorrection,
                preferred: ["coffee"],
                avoided: [],
              },
            }),
          ]);
          const correction = recorded.beliefs.find(
            (belief) => belief.preference.statement === coffeeCorrection,
          )!;
          expect(correction).toMatchObject({
            origin: "correction",
            status: "active",
            supersedes: teaBelief.id,
          });
          expect(recorded.beliefs.find((belief) => belief.id === teaBelief.id)?.status).toBe(
            "superseded",
          );
          expect(recorded.outcomes).toEqual([
            expect.objectContaining({
              predictionId: first.id,
              optionId: "option-2",
              origin: "owner",
              matched: false,
              correctionId: correction.id,
            }),
          ]);
          const outcomeId = recorded.outcomes[0]!.id;
          await firstSection.getByText("Your actual decision", { exact: true }).waitFor();
          await firstSection
            .getByText("Different from your later decision", { exact: true })
            .waitFor();

          // Asking again applies the correction; the first prediction stays frozen.
          const second = await askChoice(secondQuestion);
          expect(second).toMatchObject({
            optionId: "option-2",
            uncertainty: "low",
            correctionApplied: true,
            beliefIds: [correction.id],
            evidence: [expect.objectContaining({ excerpt: coffeeCorrection })],
          });
          const secondSection = section(featureA, secondQuestion);
          await expect.poll(() => predictedLabel(secondSection)).toBe("coffee");
          const correctedCoffee = [
            secondSection.getByText("Your correction was applied", { exact: true }),
            secondSection.getByText(
              "The owner's latest explicit correction for this topic selects this option.",
              { exact: true },
            ),
          ];
          await Promise.all(correctedCoffee.map((item) => item.waitFor()));
          // Expanding the first prediction's evidence must not expand a newly
          // prepended prediction or move the owner's open state to another card.
          expect(
            await firstSection
              .locator("details")
              .evaluate((node) => node instanceof HTMLDetailsElement && node.open),
          ).toBe(true);
          expect(
            await secondSection
              .locator("details")
              .evaluate((node) => node instanceof HTMLDetailsElement && node.open),
          ).toBe(false);
          await secondSection.locator("summary", { hasText: "Evidence" }).click();
          const coffeeEvidence = secondSection
            .locator("blockquote")
            .getByText(coffeeCorrection, { exact: true });
          await coffeeEvidence.waitFor();
          expect(await predictedLabel(firstSection)).toBe("tea");
          expect(await firstSection.locator("blockquote").first().textContent()).toContain(
            teaStatement,
          );
          await checkAndCapture(pageA, artifacts, "04-owner-a-correction-applied", secondSection, [
            ...correctedCoffee,
            coffeeEvidence,
          ]);

          // The six projected files on disk carry the same canonical facts.
          const workspace = fixture.statePath("mini-me", profile.id, "workspace");
          const projected = new Map<string, string>();
          for (const name of projectedFiles) {
            const text = await readFile(path.join(workspace, name), "utf8");
            expect(text.startsWith(projectionHeader)).toBe(true);
            expect(
              JSON.parse(text.slice(projectionHeader.length, text.indexOf(" -->\n"))),
            ).toMatchObject({ version: 1, miniMeId: profile.id, name });
            projected.set(name, text);
          }
          const preferencesFile = projected.get("PREFERENCES.md")!;
          expect(preferencesFile).toContain(
            `- [correction; ${scope}; ${correction.id}] ${JSON.stringify(coffeeCorrection)}`,
          );
          expect(preferencesFile).not.toContain(JSON.stringify(teaStatement));
          const decisionsFile = projected.get("DECISIONS.md")!;
          expect(decisionsFile).toContain(
            `- Prediction ${first.id}: ${JSON.stringify(firstQuestion)}; predicted "option-1"; uncertainty low; explicit-preference-baseline.`,
          );
          expect(decisionsFile).toContain(JSON.stringify(teaStatement));
          expect(decisionsFile).toContain(
            `  - Genuine owner decision ${outcomeId}: "option-2"; differs from the frozen prediction; correction ${correction.id}.`,
          );
          expect(decisionsFile).toContain(
            `- Prediction ${second.id}: ${JSON.stringify(secondQuestion)}; predicted "option-2"; uncertainty low; explicit-preference-baseline.`,
          );
          for (const name of ["SOUL.md", "OPINIONS.md", "MORALS.md", "TASTE.md"]) {
            expect(projected.get(name)).not.toContain("SYNTHETIC FIXTURE");
          }
          // Positive control for the cross-owner denial below: the owner can read it.
          expect(
            await requestThroughBrowserClient(pageA, "agents.files.get", {
              agentId: profile.agentId,
              name: "SOUL.md",
            }),
          ).toMatchObject({
            ok: true,
            payload: {
              agentId: profile.agentId,
              file: { name: "SOUL.md", missing: false, content: projected.get("SOUL.md") },
            },
          });

          // A fresh browser load reads the persisted learning back from the Gateway.
          reads = framesA.responses("miniMe.get").length;
          await reopenMiniMe(pageA);
          const reloaded = snapshotOf(await framesA.nextResponse("miniMe.get", reads));
          expect(reloaded.predictions.find((item) => item.id === first.id)).toMatchObject({
            optionId: "option-1",
            correctionApplied: false,
            evidence: [expect.objectContaining({ excerpt: teaStatement })],
          });
          expect(reloaded.predictions.find((item) => item.id === second.id)).toMatchObject({
            optionId: "option-2",
            correctionApplied: true,
          });
          await featureA.getByRole("tab", { name: "Decisions", exact: true }).click();
          await expect.poll(() => predictedLabel(section(featureA, firstQuestion))).toBe("tea");
          await expect.poll(() => predictedLabel(section(featureA, secondQuestion))).toBe("coffee");
          await section(featureA, firstQuestion)
            .getByText("Your actual decision", { exact: true })
            .waitFor();
          await featureA.getByRole("tab", { name: "What I learned", exact: true }).click();
          await expect
            .poll(() => beliefDescription(featureA, coffeeCorrection))
            .toContain("You corrected · Active");
          await expect
            .poll(() => beliefDescription(featureA, teaStatement))
            .toContain("You stated · Superseded");
          const learningList = section(featureA, "What I learned");
          await checkAndCapture(pageA, artifacts, "05-owner-a-reloaded-learning", learningList, [
            learningList.getByText(coffeeCorrection, { exact: true }).first(),
          ]);

          await suite.withPage(contextOptions, async ({ page: pageB }) => {
            // A separate authenticated person sees only their own empty setup.
            const framesB = recordGatewayFrames(pageB);
            const featureB = pageB.locator("openclaw-mini-me-page");
            await openMiniMe(pageB, identityB.gatewayUrl);
            expect(snapshotOf(await framesB.nextResponse("miniMe.get", 0))).toMatchObject({
              profile: null,
              beliefs: [],
              predictions: [],
              outcomes: [],
              attachments: [],
            });
            const welcomeB = pageB.locator(".mini-me-welcome");
            await welcomeB.getByRole("heading", { name: "Meet your Mini Me." }).waitFor();
            await welcomeB.getByRole("button", { name: "Set up" }).click();
            await featureB
              .getByRole("textbox", { name: "Name", exact: true })
              .fill("Unsaved synthetic B draft");
            await featureB.getByRole("button", { name: "Continue", exact: true }).click();
            const agentsB = [
              featureB.getByRole("switch", { name: "Main", exact: true }),
              featureB.getByRole("switch", { name: "Second", exact: true }),
            ];
            await Promise.all(agentsB.map((item) => item.waitFor()));
            expect(await featureB.getByRole("switch", { name: miniMeName }).count()).toBe(0);
            const agentLists = framesB.responses("agents.list");
            expect(agentLists.length).toBeGreaterThan(0);
            for (const list of agentLists) {
              expect(list.ok).toBe(true);
              const ids = (list.payload as { agents: Array<{ id: string }> }).agents.map(
                (agent) => agent.id,
              );
              expect(ids).toEqual(expect.arrayContaining(["main", "second"]));
              expect(ids).not.toContain(profile.agentId);
            }
            const visibleB = (await pageB.locator("body").textContent()) ?? "";
            for (const privateText of [miniMeName, teaStatement, coffeeCorrection]) {
              expect(visibleB).not.toContain(privateText);
            }
            await checkAndCapture(
              pageB,
              artifacts,
              "06-owner-b-isolated-setup",
              featureB.locator("fieldset.settings-fieldset"),
              [
                featureB.locator(".settings-row__title", { hasText: /^Main$/ }),
                featureB.locator(".settings-row__title", { hasText: /^Second$/ }),
              ],
            );
            await featureB.getByRole("button", { name: "Cancel", exact: true }).click();
            expect(
              await requestThroughBrowserClient(pageB, "agents.files.get", {
                agentId: profile.agentId,
                name: "SOUL.md",
              }),
            ).toMatchObject({
              ok: false,
              code: "FORBIDDEN",
              message: expect.stringContaining("This private agent requires its current owner."),
            });
            expect(framesB.requests("miniMe.create")).toHaveLength(0);

            // Export through the visible control.
            await featureA.getByRole("tab", { name: "Settings", exact: true }).click();
            const [download] = await Promise.all([
              pageA.waitForEvent("download"),
              featureA.getByRole("button", { name: "Export my data", exact: true }).click(),
            ]);
            expect(download.suggestedFilename()).toBe("mini-me-export.json");
            const exported = JSON.parse(
              await readFile(await download.path(), "utf8"),
            ) as MiniMeExportResult;
            expect(exported.format).toBe("openclaw-mini-me-v1");
            expect(exported.snapshot.profile?.id).toBe(profile.id);
            expect(
              exported.snapshot.predictions
                .map((item) => [item.id, item.optionId])
                .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
            ).toEqual(
              [
                [first.id, "option-1"],
                [second.id, "option-2"],
              ].toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
            );
            expect(exported.snapshot.beliefs).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ id: teaBelief.id, status: "superseded" }),
                expect.objectContaining({ id: correction.id, status: "active" }),
              ]),
            );

            // Disable keeps data; enable restores it.
            let configures = framesA.responses("miniMe.configure").length;
            await featureA.getByRole("button", { name: "Disable Mini Me", exact: true }).click();
            const disabled = snapshotOf(await framesA.nextResponse("miniMe.configure", configures));
            expect(disabled.profile?.lifecycle).toBe("disabled");
            expect(disabled.beliefs.map((belief) => belief.id)).toContain(correction.id);
            const enable = featureA.getByRole("button", { name: "Enable Mini Me", exact: true });
            await enable.waitFor();
            const lifecycle = section(featureA, "Disable Mini Me");
            await checkAndCapture(pageA, artifacts, "07-owner-a-disabled", lifecycle, [
              enable,
              lifecycle.getByText("Disabled", { exact: true }),
            ]);
            configures = framesA.responses("miniMe.configure").length;
            await enable.click();
            expect(
              snapshotOf(await framesA.nextResponse("miniMe.configure", configures)).profile
                ?.lifecycle,
            ).toBe("active");
            await featureA.getByRole("button", { name: "Disable Mini Me", exact: true }).waitFor();

            // Delete removes the profile and every projected file.
            const deletes = framesA.responses("miniMe.delete").length;
            await featureA.getByRole("button", { name: "Delete Mini Me", exact: true }).click();
            const confirm = await waitForConfirmModal(pageA);
            await confirm.getByRole("button", { name: "Delete permanently", exact: true }).click();
            expect(snapshotOf(await framesA.nextResponse("miniMe.delete", deletes))).toMatchObject({
              profile: null,
              documents: [],
              beliefs: [],
              predictions: [],
              outcomes: [],
              attachments: [],
            });
            const emptyA = featureA.getByText(
              "Start with a name and one preference. You can add more at any time.",
              { exact: true },
            );
            await emptyA.waitFor();
            for (const name of projectedFiles) {
              expect(await pathExists(path.join(workspace, name))).toBe(false);
            }
            await checkAndCapture(pageA, artifacts, "08-owner-a-deleted", featureA, [
              emptyA,
              featureA.getByRole("button", { name: "Set up", exact: true }),
            ]);
            reads = framesA.responses("miniMe.get").length;
            await reopenMiniMe(pageA);
            expect(snapshotOf(await framesA.nextResponse("miniMe.get", reads)).profile).toBeNull();
            await featureA.getByRole("button", { name: "Set up", exact: true }).waitFor();

            // The other person is unaffected and keeps their ordinary agents.
            const readsB = framesB.responses("miniMe.get").length;
            const noticeReadsB = welcomeReads(framesB).length;
            await reopenMiniMe(pageB);
            expect(snapshotOf(await framesB.nextResponse("miniMe.get", readsB)).profile).toBeNull();
            await expectPersistedDismissal(framesB, noticeReadsB);
            await featureB.getByRole("button", { name: "Set up", exact: true }).click();
            await featureB
              .getByRole("textbox", { name: "Name", exact: true })
              .fill("Unsaved synthetic B draft");
            await featureB.getByRole("button", { name: "Continue", exact: true }).click();
            await Promise.all(agentsB.map((item) => item.waitFor()));
            await checkAndCapture(
              pageB,
              artifacts,
              "09-owner-b-unaffected",
              featureB.locator("fieldset.settings-fieldset"),
              [
                featureB.locator(".settings-row__title", { hasText: /^Main$/ }),
                featureB.locator(".settings-row__title", { hasText: /^Second$/ }),
              ],
            );
            await featureB.getByRole("button", { name: "Cancel", exact: true }).click();
            expect(framesB.requests("miniMe.create")).toHaveLength(0);
          });
        });
      },
      async close() {
        await runQaGatewayFixture(
          async () => {
            await proxyA?.close();
          },
          () => proxyB?.close(),
          () => gateway?.stopGateway(),
        );
      },
      release: async () => {
        await gateway?.cleanup();
      },
    });
  }, 180_000);
});
