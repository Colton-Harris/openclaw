// Shared helpers for the synthetic Mini Me real-Gateway proof. Nothing here answers
// Gateway requests: frames are observed passively and direct requests use the
// page's own authenticated Control UI client.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { expect } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";

export type ObservedResponse = {
  params: unknown;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};
export type GatewayFrameLog = {
  requests(method: string): unknown[];
  responses(method: string): ObservedResponse[];
  /** Resolve the first response for `method` after `previous` responses were observed. */
  nextResponse(method: string, previous: number): Promise<ObservedResponse>;
};

/** Record this page's real Gateway request/response frames across reloads. */
export function recordGatewayFrames(page: Page): GatewayFrameLog {
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<ObservedResponse & { method: string }> = [];
  page.on("websocket", (socket) => {
    // Request IDs are only unique per socket; a reload opens a new one.
    const pending = new Map<string, { method: string; params: unknown }>();
    const parse = (payload: string | Buffer): unknown => {
      try {
        return JSON.parse(String(payload));
      } catch {
        return undefined;
      }
    };
    socket.on("framesent", ({ payload }) => {
      const frame = parse(payload);
      if (
        isRecord(frame) &&
        frame.type === "req" &&
        typeof frame.id === "string" &&
        typeof frame.method === "string"
      ) {
        pending.set(frame.id, { method: frame.method, params: frame.params });
        requests.push({ method: frame.method, params: frame.params });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = parse(payload);
      if (!isRecord(frame) || frame.type !== "res" || typeof frame.id !== "string") {
        return;
      }
      const request = pending.get(frame.id);
      if (request) {
        pending.delete(frame.id);
        responses.push({
          ...request,
          ok: frame.ok === true,
          payload: frame.payload,
          error: frame.error,
        });
      }
    });
  });
  const responsesFor = (method: string) => responses.filter((item) => item.method === method);
  return {
    requests: (method) =>
      requests.filter((item) => item.method === method).map((item) => item.params),
    responses: responsesFor,
    async nextResponse(method, previous) {
      await expect
        .poll(() => responsesFor(method).length, {
          message: `${method} response`,
          // Full Gateway cold-start metadata preparation measured 16s before the first read.
          timeout: 30_000,
        })
        .toBeGreaterThan(previous);
      return responsesFor(method)[previous]!;
    },
  };
}

export type BrowserRequestResult =
  | { ok: true; payload: unknown }
  | { ok: false; code: string; message: string };

/** Send one request over the page's existing authenticated Control UI connection. */
export function requestThroughBrowserClient(
  page: Page,
  method: string,
  params: unknown,
): Promise<BrowserRequestResult> {
  return page.evaluate(
    async ({ method: requested, params: requestParams }) => {
      const app = document.querySelector("openclaw-app") as
        | (HTMLElement & { runtime: { context: { gateway: ApplicationGateway } } })
        | null;
      const client = app?.runtime.context.gateway.snapshot.client;
      if (!client) {
        throw new Error("Control UI Gateway client is unavailable");
      }
      try {
        return { ok: true as const, payload: await client.request(requested, requestParams) };
      } catch (error) {
        const failure = error as { gatewayCode?: unknown; message?: unknown };
        return {
          ok: false as const,
          code: typeof failure.gatewayCode === "string" ? failure.gatewayCode : "",
          message: typeof failure.message === "string" ? failure.message : String(error),
        };
      }
    },
    { method, params },
  );
}

/**
 * Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades, so
 * each synthetic owner gets a loopback proxy that injects its trusted identity.
 */
export async function startTrustedIdentityProxy(params: {
  root: string;
  gatewayPort: number;
  email: string;
}): Promise<{ server: ViteDevServer; gatewayUrl: URL }> {
  const server = await createServer({
    configFile: false,
    envFile: false,
    root: params.root,
    appType: "custom",
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/": {
          target: `http://127.0.0.1:${params.gatewayPort}`,
          ws: true,
          headers: {
            "x-forwarded-for": "192.0.2.10",
            "x-forwarded-proto": "http",
            "x-forwarded-user": params.email,
          },
        },
      },
    },
  });
  try {
    await server.listen();
    const local = server.resolvedUrls?.local[0];
    if (!local) {
      throw new Error("Mini Me identity proxy did not expose a loopback URL");
    }
    const gatewayUrl = new URL(local);
    gatewayUrl.protocol = "ws:";
    return { server, gatewayUrl };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Assert the page fits its viewport, then retain one settled frame when capture is enabled. */
export async function checkAndCapture(
  page: Page,
  directory: string | undefined,
  name: string,
  surface: Locator,
  content: readonly Locator[],
): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    `${name} must not overflow the viewport horizontally`,
  ).toBe(true);
  if (!directory) {
    return;
  }
  await surface.scrollIntoViewIfNeeded();
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    animations: "disabled",
  });
  await writeFile(path.join(directory, `${name}.png`), frame.png);
}
