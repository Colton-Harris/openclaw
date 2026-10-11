import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import {
  captureMiniMeEffectAssertion,
  captureMiniMeEffectPreparation,
} from "../../mini-me/effect-scope.js";
import { readToolStringParam } from "./common.js";

const MINI_ME_MESSAGE_SEND_PARAMS = new Set([
  "action",
  "channel",
  "accountId",
  "target",
  "message",
  "threadId",
  "idempotencyKey",
]);

/**
 * Reads the requested message action and binds any delegated Mini Me send to it.
 * A delegated grant covers only an exact plain-text send; the returned caller
 * assertion also fails once that delegated effect scope is no longer current.
 */
export function readMiniMeScopedMessageAction(
  params: Record<string, unknown>,
  assertCaller: () => void,
): { action: ChannelMessageActionName; assertCurrentCaller: () => void } {
  // Capture before any await so a retained invocation cannot borrow a later scope.
  const assertMiniMeEffectCurrent = captureMiniMeEffectAssertion();
  const action = readToolStringParam(params, "action", {
    required: true,
  }) as ChannelMessageActionName; // SAFETY: The closed message-tool schema supplies action names; ordinary dispatch still checks availability.
  if (captureMiniMeEffectPreparation("message.send")) {
    if (
      action !== "send" ||
      Object.keys(params).some((key) => !MINI_ME_MESSAGE_SEND_PARAMS.has(key))
    ) {
      throw new Error("Mini Me message grants cover only an exact plain-text send.");
    }
  }
  if (!assertMiniMeEffectCurrent) {
    return { action, assertCurrentCaller: assertCaller };
  }
  return {
    action,
    assertCurrentCaller: () => {
      assertCaller();
      assertMiniMeEffectCurrent();
    },
  };
}
