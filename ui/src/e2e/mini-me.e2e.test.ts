import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { empty, active, presenceUsers, baseResponses } from "../test-helpers/mini-me-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Mini Me owner controls",
  startServerBeforeBrowser: true,
});
const proofDirectories = new WeakMap<Page, string>();
async function capture(page: Page, name: string, selector: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  let directory = proofDirectories.get(page);
  if (!directory) {
    directory = createControlUiE2eArtifactDir("mini-me");
    proofDirectories.set(page, directory);
  }
  const surface = page.locator(selector);
  const png = await takeControlUiViewportScreenshot(page, surface, [surface]);
  await writeFile(path.join(directory, `${name}.png`), png);
}

suite.define(() => {
  it("dismisses the notice and cancels setup without creating a profile or importing sources", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": empty,
          "users.prefs.get": { status: "ok", entries: {} },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const welcome = page.locator(".mini-me-welcome");
      await welcome.getByRole("heading", { name: "Meet your Mini Me." }).waitFor();
      await capture(page, "welcome-desktop", ".mini-me-welcome");
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(page, "welcome-narrow", ".mini-me-welcome");
      await page.setViewportSize({ width: 1280, height: 1000 });
      await welcome.getByRole("button", { name: "Maybe later" }).click();
      const dismissal = await gateway.waitForRequest("users.prefs.set");
      expect(dismissal.params).toEqual({ entries: { "miniMe.welcome.v1": "dismissed" } });
      await welcome.waitFor({ state: "detached" });
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("button", { name: "Set up", exact: true }).click();
      await feature.getByRole("textbox", { name: "Name", exact: true }).fill("Uncreated Mini Me");
      await capture(page, "setup-models", "openclaw-mini-me-page");
      await feature.getByRole("button", { name: "Continue", exact: true }).click();
      await feature.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await gateway.getRequests("miniMe.create")).toHaveLength(0);
      expect(await gateway.getRequests("miniMe.source.add")).toHaveLength(0);
      expect(await gateway.getRequests("miniMe.learn")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });

  it("submits the reviewed setup once and sends a structured preference only on owner input", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": empty,
          "miniMe.create": active,
          "miniMe.learn": active,
          "users.prefs.get": { status: "ok", entries: { "miniMe.welcome.v1": "dismissed" } },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("button", { name: "Set up", exact: true }).click();
      await feature.getByRole("textbox", { name: "Name", exact: true }).fill("Preview Me");
      await feature.getByRole("button", { name: "Continue", exact: true }).click();
      await feature.getByRole("button", { name: "Continue", exact: true }).click();
      expect(await gateway.getRequests("miniMe.create")).toHaveLength(0);
      await feature.getByRole("button", { name: "Create Mini Me", exact: true }).click();
      const create = await gateway.waitForRequest("miniMe.create");
      expect(create.params).toMatchObject({
        name: "Preview Me",
        models: { conversationModel: null, decisionModel: null, allowInference: false },
        attachments: [],
        sources: [{ kind: "manual", label: "Preferences you enter" }],
      });
      expect(
        await feature.getByRole("combobox", { name: "Personal file", exact: true }).inputValue(),
      ).toBe("PREFERENCES.md");
      await feature
        .getByRole("textbox", { name: "When does this apply?", exact: true })
        .fill("Synthetic beverage preview");
      await feature
        .getByRole("textbox", { name: "What should it know?", exact: true })
        .fill("This is a UI test preference, not an owner preference.");
      await feature.getByRole("textbox", { name: "Prefer", exact: true }).fill("tea");
      await feature.getByRole("button", { name: "Add preference", exact: true }).click();
      const learn = await gateway.waitForRequest("miniMe.learn");
      expect(learn.params).toMatchObject({
        preference: {
          document: "PREFERENCES.md",
          scope: "Synthetic beverage preview",
          preferred: ["tea"],
          avoided: [],
          statement: "This is a UI test preference, not an owner preference.",
        },
      });
      expect(learn.params).not.toHaveProperty("profileId");
      await expect
        .poll(() =>
          feature.getByRole("textbox", { name: "What should it know?", exact: true }).inputValue(),
        )
        .toBe("");
      await feature
        .getByRole("combobox", { name: "Personal file", exact: true })
        .selectOption("OPINIONS.md");
      await feature
        .getByRole("textbox", { name: "When does this apply?", exact: true })
        .fill("Synthetic design opinion");
      await feature
        .getByRole("textbox", { name: "What should it know?", exact: true })
        .fill("SYNTHETIC: I value a calm interface.");
      await feature.getByRole("button", { name: "Add preference", exact: true }).click();
      const opinion = await gateway.waitForRequest("miniMe.learn", { after: 1 });
      expect(opinion.params).toMatchObject({
        preference: {
          document: "OPINIONS.md",
          scope: "Synthetic design opinion",
          statement: "SYNTHETIC: I value a calm interface.",
          preferred: [],
          avoided: [],
        },
      });
    });
  });

  it("preserves a conflicting file draft and exposes real current content before overwriting", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": active,
          "miniMe.operation.get": { status: "unknown" },
          "users.prefs.get": { status: "ok", entries: {} },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("tab", { name: "Personal files", exact: true }).click();
      const editor = feature.getByRole("textbox", { name: "SOUL.md content" });
      await editor.fill("The owner’s unsaved draft.");
      const before = await gateway.deferNext("miniMe.document.set");
      await feature.getByRole("button", { name: "Save changes", exact: true }).click();
      await gateway.waitForRequest("miniMe.document.set", { after: before });
      await gateway.setMethodResponse("miniMe.get", {
        ...active,
        documents: active.documents.map((document) =>
          document.name === "SOUL.md"
            ? { ...document, revision: 2, content: "A concurrent source edit." }
            : document,
        ),
      });
      await gateway.rejectDeferred("miniMe.document.set", {
        code: "INVALID_REQUEST",
        message: "Document revision conflict",
      });
      await feature
        .getByText("This file changed while you were editing.", { exact: false })
        .waitFor();
      expect(await editor.inputValue()).toBe("The owner’s unsaved draft.");
      await feature.getByText("Current version", { exact: true }).click();
      await feature.getByText("A concurrent source edit.", { exact: true }).waitFor();
      expect(
        await feature.getByRole("button", { name: "Save changes", exact: true }).isDisabled(),
      ).toBe(true);
    });
  });

  it("imports the reviewed disk version while preserving an unsaved browser draft", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const external = { content: "Synthetic external owner edit", baseRevision: 1 };
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": {
            ...active,
            documents: active.documents.map((document) =>
              document.name === "SOUL.md" ? { ...document, external } : document,
            ),
          },
          "miniMe.document.set": {
            ...active,
            documents: active.documents.map((document) =>
              document.name === "SOUL.md"
                ? { ...document, content: external.content, revision: 2 }
                : document,
            ),
          },
          "users.prefs.get": { status: "ok", entries: {} },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("tab", { name: "Personal files", exact: true }).click();
      const editor = feature.getByRole("textbox", { name: "SOUL.md content" });
      await editor.fill("The owner’s unsaved draft.");
      await feature.getByText(external.content, { exact: true }).waitFor();
      expect(
        await feature.getByRole("button", { name: "Save changes", exact: true }).isDisabled(),
      ).toBe(true);
      await page.setViewportSize({ width: 1280, height: 1100 });
      await capture(page, "external-file-review", "openclaw-mini-me-page");
      await feature.getByRole("button", { name: "Import this disk version", exact: true }).click();
      const imported = await gateway.waitForRequest("miniMe.document.set");
      expect(imported.params).toMatchObject({
        name: "SOUL.md",
        expectedRevision: 1,
        content: external.content,
      });
      await feature
        .getByText("This file changed while you were editing.", { exact: false })
        .waitFor();
      expect(await editor.inputValue()).toBe("The owner’s unsaved draft.");
      await feature.getByText("Current version", { exact: true }).click();
      await feature.getByText(external.content, { exact: true }).waitFor();
      expect(await gateway.getRequests("miniMe.document.set")).toHaveLength(1);
    });
  });

  it("shows predictions as advice and requires a separately selected genuine outcome", async () => {
    const prediction = {
      id: "prediction-preview",
      agentId: null,
      choice: {
        scope: "Synthetic beverage preview",
        question: "Tea or coffee?",
        options: [
          { id: "tea", label: "Tea", value: "tea" },
          { id: "coffee", label: "Coffee", value: "coffee" },
        ],
      },
      optionId: "tea",
      explanation: "Based on the selected synthetic preference.",
      uncertainty: "low" as const,
      evidence: [
        { sourceId: "manual-1", sourceRevision: "one", excerpt: "Synthetic fixture: prefer tea." },
      ],
      beliefIds: ["belief-preview"],
      correctionApplied: false,
      provider: "stated-preference",
      rubricVersion: "fixture-v1",
      providerRuntimeGeneration: null,
      createdAt: 1000,
      profileGeneration: 1,
      contentRevision: 1,
      authority: "advisory" as const,
    };
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": { ...active, predictions: [prediction] },
          "miniMe.outcome": active,
          "users.prefs.get": { status: "ok", entries: {} },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("tab", { name: "Decisions", exact: true }).click();
      const actual = feature.getByRole("combobox", {
        name: "What did you actually choose? — Tea or coffee?",
      });
      expect(await actual.inputValue()).toBe("");
      expect(await feature.getByRole("button", { name: "Record my decision" }).count()).toBe(0);
      await actual.selectOption("coffee");
      await feature.getByRole("button", { name: "Record my decision", exact: true }).click();
      const outcome = await gateway.waitForRequest("miniMe.outcome");
      expect(outcome.params).toMatchObject({
        predictionId: "prediction-preview",
        optionId: "coffee",
      });
      expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
    });
  });
  it("requires an explicit reviewed permission and displays unavailable action classes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers,
        methodResponses: {
          ...baseResponses,
          "miniMe.get": active,
          "miniMe.attach": active,
          "users.prefs.get": { status: "ok", entries: {} },
        },
      });
      await page.goto(`${suite.server.baseUrl}mini-me`);
      const feature = page.locator("openclaw-mini-me-page");
      await feature.getByRole("tab", { name: "Agents & permissions", exact: true }).click();
      await feature.getByRole("combobox", { name: "Agent", exact: true }).selectOption("main");
      await feature
        .getByRole("combobox", { name: "Decision mode", exact: true })
        .selectOption("all");
      expect(
        await feature.getByRole("button", { name: "Save permissions", exact: true }).isDisabled(),
      ).toBe(true);
      await feature.getByText("Unavailable: No qualified sender", { exact: true }).waitFor();
      expect(
        await feature
          .getByRole("combobox", { name: "Action", exact: true })
          .locator("option")
          .allTextContents(),
      ).toEqual(["Edit workspace files"]);
      await feature
        .getByRole("textbox", { name: "Exact allowed resources", exact: true })
        .fill("notes/preview.txt");
      await feature.getByRole("spinbutton", { name: "Maximum actions", exact: true }).fill("2");
      await feature
        .getByRole("spinbutton", { name: "Maximum bytes (optional)", exact: true })
        .fill("1024");
      await feature.getByLabel("Expires", { exact: true }).fill("2099-01-01T12:00");
      await feature.getByRole("button", { name: "Add permission", exact: true }).click();
      expect(await gateway.getRequests("miniMe.attach")).toHaveLength(0);
      await feature
        .getByRole("checkbox", {
          name: "I reviewed this agent’s action permissions and limits.",
          exact: true,
        })
        .check();
      await feature.getByRole("button", { name: "Save permissions", exact: true }).click();
      const permission = await gateway.waitForRequest("miniMe.attach");
      expect(permission.params).toMatchObject({
        agentId: "main",
        mode: "all",
        expectedRevision: 0,
        grants: [
          {
            effect: "workspace.edit",
            resources: ["notes/preview.txt"],
            maxActions: 2,
            maxBytes: 1024,
          },
        ],
      });
      expect(await gateway.getRequests("exec.approval.resolve")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
