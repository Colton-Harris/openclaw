import { describe, expect, it, vi } from "vitest";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
  catalogSessionSearch,
  lookupCatalogSession,
  parseCatalogSessionKey,
} from "./catalog-key.ts";

describe("catalog session keys", () => {
  it.each([undefined, "main", "other"])("round-trips opaque source ids for owner %s", (agentId) => {
    const key = { catalogId: "fixture", hostId: "node:DevBox", threadId: "Thread:A/B" };
    expect(parseCatalogSessionKey(buildCatalogSessionKey(key, agentId))).toEqual(key);
  });

  it.each(["", "catalog:", "catalog:a:b", "catalog:a:b:c:d", "catalog:a:%:c"])(
    "rejects %s",
    (value) => expect(parseCatalogSessionKey(value)).toBeNull(),
  );

  it("round-trips a catalog thread URL target", () => {
    const key = { catalogId: "claude", hostId: "node:abc", threadId: "thread:a/b" };
    expect(catalogSessionKeyFromSearch(catalogSessionSearch(key))).toEqual(key);
  });

  it.each([undefined, "home-b"])(
    "keeps the agent and exact home %s across paginated lookup requests",
    async (sourceHomeId) => {
      const key = { catalogId: "codex", hostId: "gateway:local", threadId: "thread-2" };
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: {},
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: sourceHomeId ? [{ threadId: "thread-2", sourceHomeId: "home-a" }] : [],
                  nextCursor: "next",
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: {},
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-2",
                      ...(sourceHomeId ? { sourceHomeId } : {}),
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
              ],
            },
          ],
        });

      const result = await lookupCatalogSession({
        client: { request } as never,
        key,
        sourceHomeId,
        agentId: "jarvis",
        isCurrent: () => true,
      });

      expect(result?.session?.threadId).toBe("thread-2");
      expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
        agentId: "jarvis",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        limitPerHost: 100,
      });
      expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
        agentId: "jarvis",
        catalogId: "codex",
        hostIds: ["gateway:local"],
        limitPerHost: 100,
        cursors: { "gateway:local": "next" },
      });
    },
  );
});
