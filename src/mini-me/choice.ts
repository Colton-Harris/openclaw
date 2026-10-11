import { Value } from "typebox/value";
import {
  MiniMeChoiceSchema,
  type MiniMeChoice,
} from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { normalizeMiniMeValue } from "./learning.js";

/** One semantic choice contract for RPCs, host consultation, and question advice. */
export function isValidMiniMeChoice(choice: unknown): choice is MiniMeChoice {
  if (!Value.Check(MiniMeChoiceSchema, choice) || !normalizeMiniMeValue(choice.scope)) {
    return false;
  }
  const values = choice.options.map((option) => normalizeMiniMeValue(option.value));
  return (
    choice.options.every((option) => option.id !== "abstain") &&
    values.every(Boolean) &&
    new Set(values).size === values.length &&
    new Set(choice.options.map((option) => option.id)).size === values.length
  );
}
