import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiniMePrediction } from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { MiniMeToolConsultation } from "../../mini-me/consultation.js";
import {
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

type GatewayCall = Extract<
  NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>,
  (...args: never[]) => unknown
>;
type ConsultInput = Parameters<MiniMeToolConsultation>[0];

const deployQuestion = {
  id: "deploy_target",
  header: "Deployment target",
  question: "Where should this deploy?",
  options: [{ label: "Staging", description: "Safer default" }, { label: "Production" }],
};
const answers = { answers: { deploy_target: ["Production"] } };

function prediction(input: ConsultInput, overrides: Partial<MiniMePrediction> = {}) {
  return {
    id: "prediction-1",
    agentId: "main",
    choice: input.choice,
    optionId: "option_1",
    explanation: "You chose staging first for risky releases.",
    uncertainty: "low",
    evidence: [{ sourceId: "source-a", sourceRevision: "rev-7", excerpt: "private excerpt" }],
    beliefIds: ["belief-1"],
    correctionApplied: true,
    provider: "baseline",
    rubricVersion: "v1",
    providerRuntimeGeneration: null,
    createdAt: 1,
    profileGeneration: 1,
    contentRevision: 1,
    authority: "advisory",
    ...overrides,
  } satisfies MiniMePrediction;
}

function adviceConsultation(overrides: Partial<MiniMePrediction> = {}) {
  return vi.fn<MiniMeToolConsultation>(async (input) => ({
    kind: "advice",
    prediction: prediction(input, overrides),
    reason: "No unambiguous executable choice was selected.",
  }));
}

function gatewayStub(onWaitAnswer: (questionId: string) => Promise<unknown> = async () => {}) {
  let registeredId: unknown;
  const mock = vi.fn<GatewayCall>(async (method, _opts, params) => {
    if (!isRecord(params)) {
      throw new Error("Question request has no parameters");
    }
    if (method === "question.request") {
      registeredId = params.id;
      return { id: params.id };
    }
    if (method === "question.waitAnswer") {
      if (typeof params.id !== "string") {
        throw new Error("Question id is missing");
      }
      await onWaitAnswer(params.id);
      return { status: "answered", answers };
    }
    if (method === "question.list") {
      return { questions: [{ id: registeredId, status: "pending" }] };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return {
    mock,
    call: mock,
    methods: () => mock.mock.calls.map(([method]) => method),
    sentQuestions: () => {
      const params = mock.mock.calls.find(([method]) => method === "question.request")?.[2];
      if (!isRecord(params) || !Array.isArray(params.questions)) {
        throw new Error("Questions were not registered");
      }
      return params.questions.map((question) => {
        if (!isRecord(question)) {
          throw new Error("Invalid question");
        }
        return question;
      });
    },
  };
}

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
  vi.useRealTimers();
});

describe("ask_user automatic Mini Me consultation", () => {
  it("keeps the ordinary tool schema and question unchanged without an attachment", async () => {
    const gateway = gatewayStub();
    const tool = createAskUserTool({
      sessionKey: "agent:main:ordinary",
      gatewayCall: gateway.call,
    });
    expect(JSON.stringify(tool.parameters)).not.toContain("preferenceScope");
    await tool.execute("ordinary-call", { questions: [deployQuestion] });
    expect(gateway.sentQuestions()[0]?.question).toBe(deployQuestion.question);
  });
  it("shows labeled advice without voluntary mini_me use and returns only the human answer", async () => {
    const consult = adviceConsultation();
    const gateway = gatewayStub();

    const result = await createAskUserTool({
      agentId: "main",
      sessionKey: "agent:main:mini-me-advice",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-advice", {
      questions: [{ ...deployQuestion, preferenceScope: "release risk" }],
    });

    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]?.[0]).toMatchObject({
      toolCallId: "call-advice:ask_user:deploy_target",
      candidates: [],
      choice: {
        scope: "release risk",
        question: "Where should this deploy?",
        options: [
          { id: "option_1", label: "Staging", value: "Staging" },
          { id: "option_2", label: "Production", value: "Production" },
        ],
      },
    });
    const [sent] = gateway.sentQuestions();
    expect(sent).not.toHaveProperty("preferenceScope");
    expect(sent?.options).toEqual([
      { label: "Staging", description: "Safer default" },
      { label: "Production" },
    ]);
    expect(sent?.question).toBe(
      [
        "Where should this deploy?",
        "",
        "Mini Me recommendation (advisory only; your answer decides): Staging",
        "Uncertainty: low. Correction applied: yes.",
        "Why: You chose staging first for risky releases.",
        "Evidence: source-a@rev-7",
      ].join("\n"),
    );
    expect(sent?.question).not.toContain("private excerpt");
    // The human answer is returned untouched; advice never reaches the model result.
    expect(result.details).toEqual({ status: "answered", answers });
    expect(JSON.stringify(result.content)).not.toContain("Mini Me");
    expect(gateway.methods()).toEqual(["question.request", "question.waitAnswer"]);
  });

  it("labels abstention and defaults the topic to the normalized header", async () => {
    const consult = adviceConsultation({
      optionId: null,
      uncertainty: "high",
      evidence: [],
      explanation: "",
    });
    const gateway = gatewayStub();

    await createAskUserTool({
      sessionKey: "agent:main:mini-me-abstain",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-abstain", { questions: [deployQuestion] });

    expect(consult.mock.calls[0]?.[0].choice.scope).toBe("Deployment t");
    expect(gateway.sentQuestions()[0]?.question).toContain(
      "Mini Me recommendation (advisory only; your answer decides): no recommendation (abstained)\nUncertainty: high. Correction applied: yes.\nEvidence: none",
    );
  });

  it("keeps multi-select questions ordinary while advising single-select siblings", async () => {
    const consult = adviceConsultation();
    const gateway = gatewayStub();
    const multi = {
      id: "regions",
      header: "Regions",
      question: "Which regions?",
      options: [{ label: "us-east" }, { label: "eu-west" }],
      multiSelect: true,
    };

    await createAskUserTool({
      sessionKey: "agent:main:mini-me-multi",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-multi", { questions: [multi, deployQuestion] });

    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]?.[0].toolCallId).toBe("call-multi:ask_user:deploy_target");
    const [sentMulti, sentSingle] = gateway.sentQuestions();
    expect(sentMulti?.question).toBe("Which regions?");
    expect(sentSingle?.question).toContain("Mini Me recommendation");
  });

  it("asks ordinarily without sending ambiguous normalized choice values to Mini Me", async () => {
    const consult = adviceConsultation();
    const gateway = gatewayStub();
    await createAskUserTool({
      sessionKey: "agent:main:mini-me-ambiguous",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-ambiguous", {
      questions: [
        { ...deployQuestion, options: [{ label: "Staging" }, { label: "Ｓｔａｇｉｎｇ" }] },
      ],
    });
    expect(consult).not.toHaveBeenCalled();
    expect(gateway.sentQuestions()[0]?.question).toBe(deployQuestion.question);
  });
  it("keeps the ordinary question when consultation fails", async () => {
    const consult = vi.fn<MiniMeToolConsultation>(async () => {
      throw new Error("Mini Me is unavailable for this run");
    });
    const gateway = gatewayStub();

    const result = await createAskUserTool({
      sessionKey: "agent:main:mini-me-failure",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-failure", { questions: [deployQuestion] });

    expect(gateway.sentQuestions()[0]?.question).toBe("Where should this deploy?");
    expect(result.details).toEqual({ status: "answered", answers });
    expect(gateway.methods()).toEqual(["question.request", "question.waitAnswer"]);
  });

  it("asks ordinarily when consultation outlives its budget", async () => {
    vi.useFakeTimers();
    let consultSignal: AbortSignal | undefined;
    const consult = vi.fn<MiniMeToolConsultation>(
      (input) =>
        new Promise((_resolve, reject) => {
          consultSignal = input.signal;
          input.signal?.addEventListener(
            "abort",
            () =>
              reject(
                input.signal?.reason instanceof Error
                  ? input.signal.reason
                  : new Error("Consultation aborted"),
              ),
            {
              once: true,
            },
          );
        }),
    );
    const gateway = gatewayStub();

    const pending = createAskUserTool({
      sessionKey: "agent:main:mini-me-timeout",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    }).execute("call-timeout", { questions: [deployQuestion] });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toMatchObject({ details: { status: "answered", answers } });
    expect(consultSignal?.aborted).toBe(true);
    expect(gateway.sentQuestions()[0]?.question).toBe("Where should this deploy?");
  });

  it("fails on run abort during consultation without registering a question", async () => {
    const started = createDeferred();
    const consult = vi.fn<MiniMeToolConsultation>(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () =>
              reject(
                input.signal?.reason instanceof Error
                  ? input.signal.reason
                  : new Error("Consultation aborted"),
              ),
            {
              once: true,
            },
          );
          started.resolve();
        }),
    );
    const gateway = gatewayStub();
    const controller = new AbortController();
    const tool = createAskUserTool({
      sessionKey: "agent:main:mini-me-abort",
      gatewayCall: gateway.call,
      miniMeConsultation: consult,
    });

    const pending = tool.execute("call-abort", { questions: [deployQuestion] }, controller.signal);
    await started.promise;
    controller.abort(new Error("run aborted"));

    await expect(pending).rejects.toThrow("run aborted");
    expect(gateway.methods()).toEqual([]);
    consult.mockImplementation(adviceConsultation());
    // The session slot was released, so the next question is not blocked.
    await expect(
      tool.execute("call-after-abort", { questions: [deployQuestion] }),
    ).resolves.toMatchObject({ details: { status: "answered" } });
  });

  it("delivers the advised question to a prompt reserved before execution", async () => {
    const sessionKey = "agent:main:mini-me-reserved";
    const normalized = normalizeAskUserParams({ questions: [deployQuestion] });
    const reservation = reserveAskUserPromptDelivery({
      toolCallId: "call-reserved",
      sessionKey,
      questions: normalized.questions,
      timeoutSeconds: normalized.timeoutSeconds,
    });
    if (!reservation) {
      throw new Error("expected prompt reservation");
    }
    const prompt: { questions?: Awaited<ReturnType<typeof waitForAskUserPromptReady>> } = {};
    const gateway = gatewayStub(async (questionId) => {
      prompt.questions = await waitForAskUserPromptReady(questionId, gateway.call);
    });

    const result = await createAskUserTool({
      sessionKey,
      gatewayCall: gateway.call,
      miniMeConsultation: adviceConsultation(),
    }).execute("call-reserved", { questions: [deployQuestion] });

    expect(prompt.questions?.[0]?.question).toContain(
      "Mini Me recommendation (advisory only; your answer decides): Staging",
    );
    expect(result.details).toEqual({ status: "answered", answers });
  });
});
