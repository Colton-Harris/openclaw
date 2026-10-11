import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createUserTurnInputController,
  createClientInfo,
  createAttachments,
} from "./chat-send-user-turn.test-support.js";

describe("installed native shadow ingress compatibility", () => {
  it.each([
    "owner",
    "other-owner",
    "synthetic",
    "shared",
    "other-session",
    "other-client",
  ] as const)("preserves the installed native shadow metadata boundary: %s", (kind) => {
    const { controller } = createUserTurnInputController("hello");
    const prepared = prepareChatSendUserTurn({
      request: {
        inboundMessage: "hello",
        clientInfo: createClientInfo({
          id: kind === "other-client" ? GATEWAY_CLIENT_IDS.CONTROL_UI : "openclaw-macos",
        }),
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "native-shadow",
        sessionKey: kind === "other-session" ? "other" : "private",
        entry: {
          sessionId: "private",
          updatedAt: 1,
          visibility: kind === "shared" ? "shared" : "draft",
          createdActor: { type: "human", source: "profile", id: "profile-ada" },
        },
        cfg: {
          plugins: {
            entries: {
              "jev-memory-adviser": {
                enabled: true,
                config: {
                  mode: "shadow",
                  ownerAgentId: "main",
                  ownerBindings: [
                    { sessionKey: "private", channel: "webchat", senderId: "profile-ada" },
                  ],
                },
              },
            },
          },
        },
      },
      admission: {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      },
      attachments: createAttachments({ parsedMessage: "hello" }),
      client: {
        authenticatedUserId: "ada@example.test",
        authenticatedUserProfile: {
          profileId: kind === "other-owner" ? "profile-other" : "profile-ada",
          displayName: "Ada",
          hasAvatar: false,
          updatedAt: 1,
        },
        internal: kind === "synthetic" ? { syntheticClient: true } : undefined,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: createClientInfo({ id: "openclaw-macos" }),
          scopes: ["operator.write"],
        },
      },
      logGateway: createSubsystemLogger("test/native-shadow"),
      userTurn: controller,
    });
    if (kind === "owner") {
      expect(prepared.ctx.SenderId).toBe("profile-ada");
      expect(prepared.ctx.InputProvenance).toEqual({ kind: "external_user" });
    } else {
      expect(prepared.ctx.SenderId).not.toBe("profile-ada");
      expect(prepared.ctx.InputProvenance).toBeUndefined();
    }
  });
});
