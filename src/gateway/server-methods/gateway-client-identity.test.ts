import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
  resolveChatSendCallerContext,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("sender provenance comes only from a live verified profile", () => {
    const profile = {
      profileId: "profile-id",
      displayName: "Person",
      hasAvatar: false,
      updatedAt: 1,
    };
    expect(
      gatewayClientSenderFields({ authenticatedUserId: "profile-id" } as GatewayClient),
    ).toEqual({ sender: { id: "profile-id" } });
    expect(
      gatewayClientSenderFields({ authenticatedUserProfile: profile } as GatewayClient),
    ).toEqual({
      sender: { id: "profile-id", name: "Person", identity: { type: "profile", id: "profile-id" } },
    });
    expect(
      gatewayClientSenderFields({
        authenticatedUserProfile: profile,
        internal: { syntheticClient: true },
      } as GatewayClient).sender,
    ).not.toHaveProperty("identity");
  });

  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      internal: {
        syntheticClient: true,
        senderAttribution: {
          id: "alice",
          name: "Suggested by Alice",
          identity: { type: "profile", id: "alice" },
        },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: {
        id: "alice",
        name: "Suggested by Alice",
        identity: { type: "profile", id: "alice" },
      },
    });
  });

  it("keeps a GitHub-backed mutable alias unattributed until immutable sync completes", () => {
    const client = {
      authenticatedUserId: "released-login@github",
      authenticatedGitHubIdentitySync: async () => ({ profileId: "owner", updatedAt: 1 }),
    } as GatewayClient;

    expect(gatewayClientSenderFields(client)).toEqual({});
    expect(gatewayClientSessionCreator(client)).toBeUndefined();
  });
});

describe("resolveChatSendCallerContext sender identity", () => {
  const ownerProfile = {
    profileId: "gateway-owner-profile",
    displayName: "Owner",
    hasAvatar: false,
    updatedAt: 1,
  };
  const controlUi: GatewayClientInfo = {
    id: GATEWAY_CLIENT_IDS.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    displayName: "Forged Label",
    version: "dev",
    platform: "web",
  };
  const macosApp: GatewayClientInfo = {
    id: GATEWAY_CLIENT_IDS.MACOS_APP,
    mode: GATEWAY_CLIENT_MODES.UI,
    displayName: "Forged Label",
    version: "dev",
    platform: "darwin",
  };

  function callerContext(client: Partial<GatewayClient>, clientInfo?: GatewayClientInfo) {
    return resolveChatSendCallerContext(client as GatewayClient, clientInfo);
  }

  it("projects the verified profile as the sender for operator UI clients", () => {
    const ctx = callerContext(
      {
        authenticatedUserProfile: ownerProfile,
        connect: { client: controlUi, scopes: ["operator.admin"] } as GatewayClient["connect"],
      },
      controlUi,
    );

    expect(ctx).toMatchObject({
      Provider: "webchat",
      SenderId: "gateway-owner-profile",
      SenderName: "Owner",
      GatewayClientScopes: ["operator.admin"],
    });
    expect(ctx).not.toHaveProperty("SenderUsername");
  });

  it("fails closed without a verified identity instead of using an operator UI label", () => {
    const ctx = callerContext({}, controlUi);

    expect(ctx).not.toHaveProperty("SenderId");
    expect(ctx).not.toHaveProperty("SenderName");
    expect(ctx).not.toHaveProperty("SenderUsername");
  });

  it("never lets a self-declared client label override the verified identity", () => {
    const forged = {
      ...macosApp,
      id: "gateway-owner" as GatewayClientInfo["id"],
      displayName: "gateway-owner",
    };

    expect(
      callerContext(
        {
          authenticatedUserProfile: {
            ...ownerProfile,
            profileId: "profile-bob",
            displayName: "Bob",
          },
        },
        forged,
      ),
    ).toMatchObject({ SenderId: "profile-bob", SenderName: "Bob" });
    expect(callerContext({ authenticatedUserId: "bob@example.com" }, forged)).toMatchObject({
      SenderId: "bob@example.com",
    });
  });

  it("keeps distinct verified users distinct on the same client", () => {
    const first = callerContext(
      { authenticatedUserProfile: { ...ownerProfile, profileId: "profile-a" } },
      controlUi,
    );
    const second = callerContext(
      { authenticatedUserProfile: { ...ownerProfile, profileId: "profile-b" } },
      controlUi,
    );

    expect(first.SenderId).toBe("profile-a");
    expect(second.SenderId).toBe("profile-b");
  });

  it("mirrors transcript attribution and keeps GitHub-pending identities unattributed", () => {
    expect(
      callerContext(
        {
          authenticatedUserProfile: ownerProfile,
          internal: {
            syntheticClient: true,
            senderAttribution: { id: "alice", name: "Suggested by Alice" },
          },
        },
        controlUi,
      ),
    ).toMatchObject({ SenderId: "alice", SenderName: "Suggested by Alice" });
    expect(
      callerContext(
        {
          authenticatedUserId: "released-login@github",
          authenticatedGitHubIdentitySync: async () => ({ profileId: "owner", updatedAt: 1 }),
        } as Partial<GatewayClient>,
        controlUi,
      ),
    ).not.toHaveProperty("SenderId");
  });

  it("keeps the legacy label fallback only for identity-less non-UI clients", () => {
    expect(callerContext({}, macosApp)).toMatchObject({
      SenderId: GATEWAY_CLIENT_IDS.MACOS_APP,
      SenderName: "Forged Label",
      SenderUsername: "Forged Label",
    });
  });
});
