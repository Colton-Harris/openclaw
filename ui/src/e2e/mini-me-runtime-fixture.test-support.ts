// SYNTHETIC fixture for the Mini Me runtime qualification. Every person, preference,
// file, model answer and Decision answer here is generated test data served by one
// loopback HTTP listener. It is not a live provider, a genuine owner, or an accuracy
// measurement. The Gateway, agent runs, tools, storage and TypeSafe plugin are real.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import type { ViteDevServer } from "vite";
import type {
  MiniMeAttachment,
  MiniMeBelief,
  MiniMeGrant,
  MiniMeMode,
  MiniMeSnapshot,
} from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { appendTranscriptMessages } from "../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { InputProvenance } from "../../../src/sessions/input-provenance.js";
import { buildPersistedUserTurnMetadata } from "../../../src/sessions/user-turn-transcript.metadata.js";
import { setDisplayName } from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../test/helpers/openai-responses-sse.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { withinTest } from "../../../test/helpers/promise.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import {
  requestThroughBrowserClient,
  startTrustedIdentityProxy,
} from "./mini-me-real.test-support.ts";
import {
  collectStrings,
  scriptedMiniMeExtraction,
} from "./mini-me-scripted-extraction.test-support.ts";

export const SYNTHETIC_OWNER = {
  email: "mini-me-runtime-owner@example.test",
  name: "Synthetic Runtime Owner",
};
const SYNTHETIC_OTHER = {
  email: "mini-me-runtime-other@example.test",
  name: "Synthetic Other Person",
};
const PROVIDER_ID = "mini-me-fixture";
const AGENT_MODEL = "agent";
export const AGENT_MODEL_REF = `${PROVIDER_ID}/${AGENT_MODEL}`;
const EXTRACTOR_MODEL = "extractor";
export const EXTRACTOR_MODEL_REF = `${PROVIDER_ID}/${EXTRACTOR_MODEL}`;
export const DECISION_MODEL_REF = "typesafe/kev-latest";
export const MAIN_FILE = "fixture-choice.md";
export const SECOND_FILE = "second-choice.md";
export const HELD_FILE = "held-choice.md";
export const ORIGINAL_BYTES = {
  [MAIN_FILE]: "SYNTHETIC FIXTURE: original main workspace bytes.\n",
  [SECOND_FILE]: "SYNTHETIC FIXTURE: original second workspace bytes.\n",
  [HELD_FILE]: "SYNTHETIC FIXTURE: original held-choice bytes.\n",
};

/** The scripted extractor grounds one preference per matching line, at its exact span. */
export function preferenceLine(scope: string, value: string): string {
  return `SYNTHETIC PREFERENCE: ${scope} -> prefer ${value}`;
}
const CELL_MARKER = /\[\[cell:([A-Za-z0-9-]+)\]\]/gu;

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Inverse of the host's exact `workspace:[root, relative]` resource serialization. */
export function workspaceRelativePath(resource: string): string | undefined {
  if (!resource.startsWith("workspace:")) {
    return undefined;
  }
  const tuple: unknown = JSON.parse(resource.slice("workspace:".length));
  return Array.isArray(tuple) && typeof tuple[1] === "string" ? tuple[1] : undefined;
}

/** Parse the `mini_me` tool result the Gateway returned to the scripted model. */
export function parseToolOutput(output: unknown): Record<string, unknown> | undefined {
  const text =
    typeof output === "string"
      ? output
      : collectStrings(output)
          .filter((part) => part.trimStart().startsWith("{"))
          .join("");
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function miniMeToolCallEvents(callId: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name: "mini_me",
    arguments: JSON.stringify(args),
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `response_${callId}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
}

type ResponsesBody = {
  model?: string;
  tools?: Array<{ name?: string }>;
  input?: Array<{ type?: string; call_id?: string; output?: unknown }>;
};
export type ScriptedExtraction = { sourceText: string; scopes: string[] };
export type ScriptedDecision = { bytes: number; body: Record<string, unknown> };

/**
 * One loopback listener scripts both the model provider (OpenAI Responses SSE) and
 * the local TypeSafe System One endpoint. It never answers Gateway requests.
 */
async function startScriptedProviders() {
  const cells = new Map<string, Record<string, unknown> | null>();
  const outputs = new Map<string, unknown>();
  const prompts = new Map<string, string>();
  const extractions: ScriptedExtraction[] = [];
  const decisions: ScriptedDecision[] = [];
  const failures: string[] = [];
  const toollessCells: string[] = [];
  const listeners = new Set<() => void>();
  const handlers = new Set<Promise<void>>();
  let holdDecisions = false;
  let holdExtractionIndex: number | undefined;
  let heldExtraction: { closed: boolean; sourceText: string; scopes: string[] } | undefined;
  let held: { closed: boolean } | undefined;
  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const answerModel = (body: ResponsesBody, response: ServerResponse) => {
    const reply = (text: string, id: string) =>
      writeOpenAiResponsesText(response, {
        text,
        messageId: `msg_${id}`,
        responseId: `resp_${id}`,
      });
    if (body.model === EXTRACTOR_MODEL) {
      const extraction = scriptedMiniMeExtraction(body.input);
      if (extraction === undefined) {
        failures.push("extractor request without selectedSourceText");
        response.writeHead(500).end();
        return;
      }
      const { sourceText, preferences } = extraction;
      extractions.push({ sourceText, scopes: preferences.map((item) => item.preference.scope) });
      if (extractions.length === holdExtractionIndex) {
        heldExtraction = {
          closed: false,
          sourceText,
          scopes: preferences.map((item) => item.preference.scope),
        };
        const currentHeld = heldExtraction;
        response.once("close", () => {
          currentHeld.closed = true;
          notify();
        });
        notify();
        return;
      }
      reply(JSON.stringify({ preferences }), `extract_${extractions.length}`);
      return;
    }
    if (body.model !== AGENT_MODEL) {
      failures.push(`unexpected model ${String(body.model)}`);
      response.writeHead(404).end();
      return;
    }
    const cell = [...JSON.stringify(body.input ?? []).matchAll(CELL_MARKER)].at(-1)?.[1];
    const script = cell === undefined ? undefined : cells.get(cell);
    if (cell === undefined || script === undefined) {
      // Title or other auxiliary model work: answered, never scripted as a choice.
      reply("SYNTHETIC auxiliary reply.", `aux_${randomUUID()}`);
      return;
    }
    prompts.set(cell, JSON.stringify(body));
    if (!script) {
      reply(`SYNTHETIC cell ${cell} acknowledged.`, `cell_${cell}`);
      return;
    }
    const callId = `call_mini_me_${cell}`;
    const result = body.input?.find(
      (item) => item.type === "function_call_output" && item.call_id === callId,
    );
    if (result) {
      outputs.set(cell, result.output);
      reply(`SYNTHETIC cell ${cell} finished.`, `cell_${cell}_done`);
      return;
    }
    if (!body.tools?.some((tool) => tool.name === "mini_me")) {
      toollessCells.push(cell);
      reply("SYNTHETIC auxiliary reply.", `aux_${randomUUID()}`);
      return;
    }
    writeOpenAiResponsesSse(response, miniMeToolCallEvents(callId, script));
  };

  const answerDecision = (raw: string, response: ServerResponse) => {
    const body: unknown = JSON.parse(raw);
    if (!isRecord(body) || !isRecord(body.questions)) {
      failures.push("malformed TypeSafe request");
      response.writeHead(422).end();
      return;
    }
    decisions.push({ bytes: Buffer.byteLength(raw), body });
    if (holdDecisions) {
      // Unanswered until the Gateway itself closes the request; no timer decides it.
      const entry = { closed: false };
      held = entry;
      response.once("close", () => {
        entry.closed = true;
        notify();
      });
      return;
    }
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      if (!isRecord(question) || question.type !== "choice" || !isRecord(question.criteria)) {
        failures.push(`unexpected TypeSafe question ${id}`);
        response.writeHead(422).end();
        return;
      }
      const labels = Object.keys(question.criteria);
      const choice = labels.includes("option-1") ? "option-1" : labels[0]!;
      answers[id] = {
        type: "choice",
        choice,
        confidence: 0.8,
        probabilities: Object.fromEntries(
          labels.map((label) => [label, label === choice ? 0.9 : 0.1 / (labels.length - 1)]),
        ),
      };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: typeof body.model === "string" ? body.model : "kev-latest",
        answers,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  };

  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const handler = (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          if (request.method === "POST" && request.url === "/v1/responses") {
            answerModel(JSON.parse(raw) as ResponsesBody, response);
          } else if (request.method === "POST" && request.url === "/v1/systemone") {
            answerDecision(raw, response);
          } else {
            failures.push(`unexpected ${request.method} ${request.url}`);
            response.writeHead(404).end();
          }
          notify();
        })();
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          (error: unknown) => {
            handlers.delete(handler);
            failures.push(error instanceof Error ? error.message : String(error));
            response.destroy();
            notify();
          },
        );
      }),
  });
  return {
    port: reserved.claim.port,
    extractions,
    decisions,
    failures,
    toollessCells,
    /** Register a cell before its turn: tool args make the model call `mini_me`; null replies text. */
    script(cell: string, toolArgs: Record<string, unknown> | null) {
      cells.set(cell, toolArgs);
    },
    cellOutput: (cell: string) => outputs.get(cell),
    cellPrompt: (cell: string) => prompts.get(cell),
    holdNextDecisions() {
      holdDecisions = true;
    },
    heldDecision: () => held,
    holdExtractionAt(index: number) {
      holdExtractionIndex = index;
    },
    heldExtraction: () => heldExtraction,
    /** Event-driven wait: re-evaluated only when the listener records new traffic. */
    until<T>(read: () => T | undefined, signal: AbortSignal): Promise<T> {
      return withinTest(
        new Promise<T>((resolve) => {
          const check = () => {
            const value = read();
            if (value !== undefined) {
              listeners.delete(check);
              resolve(value);
            }
          };
          listeners.add(check);
          check();
        }),
        signal,
      );
    },
    async stop() {
      await runQaGatewayFixture(
        async () => {
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
          await Promise.allSettled(handlers);
        },
        () => reserved.claim.release(),
      );
    },
  };
}
export type ScriptedProviders = Awaited<ReturnType<typeof startScriptedProviders>>;

export type MiniMeRuntimeFixture = {
  instance: OpenClawTestInstance;
  provider: ScriptedProviders;
  baseUrl: string;
  ownerId: string;
  otherId: string;
  config: OpenClawConfig;
  workspaces: { main: string; second: string };
  close: () => Promise<void>;
};

/** One isolated child Gateway (non-minimal, so bundled TypeSafe registers) behind one identity proxy. */
export async function startMiniMeRuntimeFixture(): Promise<MiniMeRuntimeFixture> {
  const provider = await startScriptedProviders();
  let instance: OpenClawTestInstance | undefined;
  let proxy: ViteDevServer | undefined;
  const close = () =>
    runQaGatewayFixture(
      async () => {
        await proxy?.close();
      },
      () => instance?.cleanup(),
      () => provider.stop(),
    );
  try {
    instance = await createOpenClawTestInstance({
      name: "mini-me-runtime",
      env: { VITEST: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      config: {
        update: { checkOnStart: false },
        cron: { enabled: false },
        gateway: {
          controlUi: { enabled: true },
          trustedProxies: ["127.0.0.1", "::1"],
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              allowLoopback: true,
              allowUsers: [SYNTHETIC_OWNER.email],
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              deviceAutoApprove: {
                enabled: true,
                scopes: ["operator.admin", "operator.read", "operator.write"],
              },
            },
          },
        },
        tools: { profile: "full", codeMode: false, toolSearch: false },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            [PROVIDER_ID]: {
              api: "openai-responses",
              apiKey: "synthetic-mini-me-fixture-key",
              baseUrl: `http://127.0.0.1:${provider.port}/v1`,
              models: [
                { id: AGENT_MODEL, name: "Synthetic agent" },
                { id: EXTRACTOR_MODEL, name: "Synthetic extractor" },
              ],
            },
          },
        },
        plugins: {
          allow: ["typesafe"],
          slots: { memory: "none" },
          // Local System One origin: the plugin sends no credential to loopback.
          entries: {
            typesafe: { enabled: true, config: { baseUrl: `http://127.0.0.1:${provider.port}` } },
          },
        },
      },
    });
    const env = instance.env;
    const workspaces = {
      main: instance.state.workspaceDir,
      second: instance.state.path("workspace-second"),
    };
    await mkdir(workspaces.main, { recursive: true });
    await mkdir(workspaces.second, { recursive: true });
    await writeFile(path.join(workspaces.main, MAIN_FILE), ORIGINAL_BYTES[MAIN_FILE]);
    for (const file of [SECOND_FILE, HELD_FILE] as const) {
      await writeFile(path.join(workspaces.second, file), ORIGINAL_BYTES[file]);
    }
    const [ownerId, otherId] = [SYNTHETIC_OWNER, SYNTHETIC_OTHER].map((person) => {
      const profile = ensureProfileForEmail(person.email, { env });
      setDisplayName(profile.id, person.name, { env });
      return profile.id;
    });
    const identity = await startTrustedIdentityProxy({
      root: workspaces.main,
      gatewayPort: instance.port,
      email: SYNTHETIC_OWNER.email,
    });
    proxy = identity.server;
    const baseUrl = new URL(identity.gatewayUrl.href);
    baseUrl.protocol = "http:";
    const written: OpenClawConfig = JSON.parse(await readFile(instance.configPath, "utf8"));
    if (!written.gateway?.auth || !written.gateway.controlUi) {
      throw new Error("Fixture must supply Gateway authentication and Control UI settings");
    }
    // The instance helper defaults to token auth; this fixture uses a real proxy identity.
    delete written.gateway.auth.token;
    written.gateway.controlUi.allowedOrigins = [baseUrl.origin];
    written.agents = {
      ownership: "explicit",
      defaults: {
        model: `${PROVIDER_ID}/${AGENT_MODEL}`,
        modelPolicy: { allow: [`${PROVIDER_ID}/*`] },
      },
      entries: {
        main: { name: "Main", workspace: workspaces.main },
        second: { name: "Second", workspace: workspaces.second },
      },
    };
    await instance.state.writeConfig(written);
    const config: OpenClawConfig = structuredClone(written);
    await instance.startGateway();
    return {
      instance,
      provider,
      baseUrl: baseUrl.href,
      ownerId: ownerId!,
      otherId: otherId!,
      config,
      workspaces,
      close,
    };
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, close);
  }
}

/** Passive frame observation for `miniMe.changed` and the methods this page sent. */
export function observeMiniMe(page: Page) {
  let changes = 0;
  const sent: string[] = [];
  const listeners = new Set<() => void>();
  const parse = (payload: string | Buffer): unknown => {
    try {
      return JSON.parse(String(payload));
    } catch {
      return undefined;
    }
  };
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = parse(payload);
      if (isRecord(frame) && frame.type === "req" && typeof frame.method === "string") {
        sent.push(frame.method);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = parse(payload);
      if (isRecord(frame) && frame.type === "event" && frame.event === "miniMe.changed") {
        changes += 1;
        for (const listener of listeners) {
          listener();
        }
      }
    });
  });
  return {
    changes: () => changes,
    sentMethods: () => [...sent],
    afterChange(seen: number, signal: AbortSignal): Promise<void> {
      return withinTest(
        new Promise<void>((resolve) => {
          const check = () => {
            if (changes > seen) {
              listeners.delete(check);
              resolve();
            }
          };
          listeners.add(check);
          check();
        }),
        signal,
      );
    },
  };
}
export type MiniMeObserver = ReturnType<typeof observeMiniMe>;

/** One authenticated request over the page's own Control UI connection; failures throw. */
export async function call<T>(page: Page, method: string, params: unknown): Promise<T> {
  const result = await requestThroughBrowserClient(page, method, params);
  if (!result.ok) {
    throw new Error(`${method} failed: ${result.code} ${result.message}`);
  }
  return result.payload as T;
}

/** Re-read the owner's snapshot after each `miniMe.changed` until it satisfies `ready`. */
export async function untilSnapshot(
  page: Page,
  observer: MiniMeObserver,
  ready: (snapshot: MiniMeSnapshot) => boolean,
  signal: AbortSignal,
): Promise<MiniMeSnapshot> {
  for (;;) {
    const seen = observer.changes();
    const result = await requestThroughBrowserClient(page, "miniMe.get", {});
    if (result.ok) {
      const snapshot = result.payload as MiniMeSnapshot;
      if (ready(snapshot)) {
        return snapshot;
      }
    } else if (!/updating|settles/iu.test(result.message)) {
      throw new Error(`miniMe.get failed: ${result.code} ${result.message}`);
    }
    await observer.afterChange(seen, signal);
  }
}

export function attachmentOf(snapshot: MiniMeSnapshot, agentId: string): MiniMeAttachment {
  const attachment = snapshot.attachments.find((item) => item.agentId === agentId);
  if (!attachment) {
    throw new Error(`Mini Me is not attached to ${agentId}`);
  }
  return attachment;
}

export function inferredBeliefs(snapshot: MiniMeSnapshot, scope: string): MiniMeBelief[] {
  return snapshot.beliefs.filter(
    (belief) => belief.origin === "inferred" && belief.preference.scope === scope,
  );
}

export function attach(
  page: Page,
  snapshot: MiniMeSnapshot,
  agentId: string,
  mode: MiniMeMode,
  grants: MiniMeGrant[],
): Promise<MiniMeSnapshot> {
  return call<MiniMeSnapshot>(page, "miniMe.attach", {
    operationId: randomUUID(),
    agentId,
    expectedRevision: attachmentOf(snapshot, agentId).revision,
    mode,
    grants,
  });
}

export function editGrant(id: string, relativePath: string, maxActions: number): MiniMeGrant {
  return {
    id,
    effect: "workspace.edit",
    resources: [relativePath],
    maxActions,
    expiresAt: Date.now() + 3_600_000,
  };
}

/** A private (draft) conversation created by the authenticated owner. */
export async function createPrivateSession(
  page: Page,
  key: string,
  agentId: string,
): Promise<string> {
  const created = await call<{ key: string; sessionId?: string }>(page, "sessions.create", {
    key,
    agentId,
    visibility: "draft",
    permissionMode: "workspace",
  });
  if (!created.sessionId) {
    throw new Error(`sessions.create returned no sessionId for ${key}`);
  }
  return created.sessionId;
}

/** Real owner chat ingress through `chat.send`; returns the run to settle. */
export async function sendTurn(page: Page, sessionKey: string, message: string) {
  const runId = randomUUID();
  await call(page, "chat.send", { sessionKey, message, idempotencyKey: runId });
  return runId;
}

/** Completion signal: the Gateway's own `agent.wait`, not client polling. */
export async function settleRun(page: Page, runId: string): Promise<void> {
  const settled = await call<{ status?: string }>(page, "agent.wait", {
    runId,
    timeoutMs: 120_000,
  });
  if (settled.status !== "ok") {
    throw new Error(`run ${runId} settled as ${settled.status}`);
  }
}

export const SEEDED_LINES = {
  pageOne: preferenceLine("synthetic morning drink", "tea"),
  pageTwo: preferenceLine("synthetic evening drink", "cocoa"),
  otherPerson: preferenceLine("synthetic leaked other person", "leak-other"),
  interSession: preferenceLine("synthetic leaked relay", "leak-relay"),
  assistant: preferenceLine("synthetic leaked assistant", "leak-assistant"),
};
const SEEDED_ENTRY_COUNT = 118;

/**
 * SEEDED HISTORY (labeled): bounded synthetic entries appended through the canonical
 * transcript batch owner, with the canonical user-turn metadata owner supplying sender
 * attribution. Only owner-authored, external-user entries may become evidence.
 */
export async function seedConversationHistory(params: {
  fixture: MiniMeRuntimeFixture;
  sessionKey: string;
  sessionId: string;
}): Promise<void> {
  const { fixture } = params;
  const owner = {
    id: fixture.ownerId,
    identity: { type: "profile", id: fixture.ownerId },
  } as const;
  const other = {
    id: fixture.otherId,
    identity: { type: "profile", id: fixture.otherId },
  } as const;
  const start = Date.now();
  const user = (
    text: string,
    sender: typeof owner | typeof other,
    provenance?: InputProvenance,
  ) => ({
    role: "user",
    content: [{ type: "text", text }],
    ...(provenance ? { provenance } : {}),
    __openclaw: buildPersistedUserTurnMetadata(
      { sender, ...(provenance ? { provenance } : {}) },
      [],
    ),
  });
  const messages = Array.from({ length: SEEDED_ENTRY_COUNT }, (_, index) => {
    const timestamp = start + index;
    const filler = `SYNTHETIC seeded entry ${index + 1}.`;
    const message =
      index % 2 === 1
        ? {
            role: "assistant",
            content: [{ type: "text", text: index === 81 ? SEEDED_LINES.assistant : filler }],
            timestamp,
          }
        : index === 4
          ? user(`${filler}\n${SEEDED_LINES.pageOne}`, owner)
          : index === 40
            ? user(`${filler}\n${SEEDED_LINES.otherPerson}`, other)
            : index === 60
              ? user(`${filler}\n${SEEDED_LINES.interSession}`, owner, { kind: "inter_session" })
              : index === 112
                ? user(`${filler}\n${SEEDED_LINES.pageTwo}`, owner)
                : user(filler, owner);
    return { message: { timestamp, ...message }, now: timestamp };
  });
  await appendTranscriptMessages(
    {
      agentId: "main",
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      env: fixture.instance.env,
    },
    { config: fixture.config, messages },
  );
}
