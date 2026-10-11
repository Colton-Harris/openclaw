import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { raceWithTimeout } from "@openclaw/retry";
import type { QuestionRequestQuestion } from "../../../packages/gateway-protocol/src/index.js";
import type {
  MiniMeChoice,
  MiniMePrediction,
} from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { isValidMiniMeChoice } from "../../mini-me/choice.js";
import type { MiniMeToolConsultation } from "../../mini-me/consultation.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";

// One shared budget for every consultation in a call; slow advice must not hold the question.
const MINI_ME_ADVICE_TIMEOUT_MS = 30_000;
const MINI_ME_ADVICE_MAX_CHARS = 1_000;
const MINI_ME_ADVICE_MAX_EVIDENCE = 4;

function formatMiniMeAdvice(prediction: MiniMePrediction, recommendation: string): string {
  const evidence = prediction.evidence
    .slice(0, MINI_ME_ADVICE_MAX_EVIDENCE)
    .map((item) => `${item.sourceId}@${item.sourceRevision}`);
  const omitted = prediction.evidence.length - evidence.length;
  const explanation = prediction.explanation.replace(/\s+/g, " ").trim();
  return truncateUtf16Safe(
    [
      `Mini Me recommendation (advisory only; your answer decides): ${recommendation}`,
      `Uncertainty: ${prediction.uncertainty}. Correction applied: ${prediction.correctionApplied ? "yes" : "no"}.`,
      ...(explanation ? [`Why: ${truncateUtf16Safe(explanation, 400)}`] : []),
      `Evidence: ${evidence.length > 0 ? evidence.join(", ") : "none"}${omitted > 0 ? ` (+${omitted} more)` : ""}`,
    ].join("\n"),
    MINI_ME_ADVICE_MAX_CHARS,
  );
}

async function adviseAskUserQuestion(params: {
  consult: MiniMeToolConsultation;
  toolCallId: string;
  question: QuestionRequestQuestion;
  scope: string;
  signal: AbortSignal;
}): Promise<QuestionRequestQuestion> {
  const { question } = params;
  // MiniMeChoice predicts one optionId; multi-select has no faithful mapping and stays ordinary.
  if (question.multiSelect || question.isSecret || question.answerFormat === "lines") {
    return question;
  }
  // The host owns option ids by index; option content is frozen before consultation.
  const choice: MiniMeChoice = freezeJsonSnapshot({
    scope: params.scope,
    question: truncateUtf16Safe(question.question, 4096),
    options: question.options.map((option, index) => ({
      id: `option_${index + 1}`,
      label: option.label,
      // Stable choice value matches a stored preference even when display descriptions change.
      value: option.label,
    })),
  });
  // isOther permits the owner to type a different answer; it does not make a
  // bounded options question secret or free-text-only. Never predict that answer.
  if (!isValidMiniMeChoice(choice)) {
    return question;
  }
  // Separate key per question; the consultation owner replays its frozen prediction for this key.
  const result = await params.consult({
    toolCallId: `${params.toolCallId}:ask_user:${question.questionId}`,
    choice,
    candidates: [],
    signal: params.signal,
  });
  const prediction = result.prediction;
  const selected = choice.options.find((option) => option.id === prediction.optionId);
  if (result.kind === "executed" || (prediction.optionId !== null && !selected)) {
    throw new Error("Mini Me returned advice outside this ask_user choice");
  }
  const advice = formatMiniMeAdvice(
    prediction,
    selected ? selected.label : "no recommendation (abstained)",
  );
  return { ...question, question: `${question.question}\n\n${advice}` };
}

/**
 * Adds host-bound Mini Me advice to owner-visible question prose before registration.
 * Consultation failure or timeout keeps the ordinary question; only the run's abort fails.
 */
export async function adviseAskUserQuestions(params: {
  consult: MiniMeToolConsultation;
  toolCallId: string;
  questions: QuestionRequestQuestion[];
  preferenceScopes: string[];
  signal?: AbortSignal;
}): Promise<QuestionRequestQuestion[]> {
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const advised: QuestionRequestQuestion[] = [];
  const current = () => params.questions.map((question, index) => advised[index] ?? question);
  try {
    return await raceWithTimeout(
      async () => {
        for (const [index, question] of params.questions.entries()) {
          try {
            advised[index] = await adviseAskUserQuestion({
              consult: params.consult,
              toolCallId: params.toolCallId,
              question,
              scope: params.preferenceScopes[index] ?? question.header,
              signal,
            });
          } catch {
            params.signal?.throwIfAborted();
            if (deadline.signal.aborted) {
              break;
            }
          }
        }
        return current();
      },
      MINI_ME_ADVICE_TIMEOUT_MS,
      () => current(),
      {
        signal: params.signal,
        // The run's own abort must fail the tool, even while a provider ignores the signal.
        onAbort: (aborted) => {
          aborted.throwIfAborted();
          return current();
        },
      },
    );
  } finally {
    deadline.abort(new Error("ask_user Mini Me advice window closed"));
  }
}
