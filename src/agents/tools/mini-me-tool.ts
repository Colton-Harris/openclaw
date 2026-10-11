import { Type } from "typebox";
import { Value } from "typebox/value";
import { MiniMeChoiceSchema } from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import type { MiniMeToolConsultation } from "../../mini-me/consultation.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { type AnyAgentTool, jsonResult, ToolInputError } from "./common.js";

const Id = Type.String({ minLength: 1, maxLength: 128 });
const Route = Type.String({ minLength: 1, maxLength: 512 });
export const MiniMeToolSchema = Type.Object(
  {
    choice: MiniMeChoiceSchema,
    candidates: Type.Array(
      Type.Union([
        Type.Object(
          {
            optionId: Id,
            effect: Type.Literal("workspace.edit"),
            relativePath: Route,
            content: Type.String({ maxLength: 65_536 }),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            optionId: Id,
            effect: Type.Literal("message.send"),
            channel: Id,
            accountId: Id,
            to: Route,
            threadId: Type.Optional(Id),
            text: Type.String({ minLength: 1, maxLength: 4096 }),
          },
          { additionalProperties: false },
        ),
      ]),
      { maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);

/** Created only for a private original-requester attachment bound by the host. */
export function createMiniMeTool(consult?: MiniMeToolConsultation): AnyAgentTool | null {
  if (!consult) {
    return null;
  }
  return {
    name: "mini_me",
    label: "Mini Me",
    catalogMode: "direct-only",
    description:
      "Consult the owner's attached Mini Me before a structured preference choice. Supply the alternatives and optional exact text-file/message candidates. Returns advisory evidence and uncertainty. The host may execute a supported candidate only under this agent's explicit owner grants and existing approvals. Predictions never represent owner approval. Unsupported actions remain pending for the owner; don't describe a prediction as an executed action.",
    parameters: MiniMeToolSchema,
    async execute(toolCallId, args, signal) {
      signal?.throwIfAborted();
      if (!Value.Check(MiniMeToolSchema, args)) {
        throw new ToolInputError("Mini Me requires a structured choice and bounded candidates.");
      }
      const request = freezeJsonSnapshot(structuredClone(args));
      const result = await consult({ ...request, toolCallId, signal });
      if (result.kind !== "executed") {
        return jsonResult(result);
      }
      const outcome = result.execution.outcome;
      return jsonResult({
        kind: result.kind,
        prediction: result.prediction,
        restoreReceiptId: result.restoreReceiptId,
        execution: {
          outcome: outcome.state === "succeeded" ? { state: outcome.state } : outcome,
          settlement: { state: result.execution.settlement.state },
          ...(result.execution.restoreRelease
            ? { restoreRelease: { state: result.execution.restoreRelease.state } }
            : {}),
        },
      });
    },
  };
}
