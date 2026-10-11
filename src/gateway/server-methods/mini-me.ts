import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import * as S from "../../../packages/gateway-protocol/src/schema/mini-me.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { publishMiniMeChanged } from "../../mini-me/events.js";
import type { miniMeForGateway } from "../../mini-me/host.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { prepareAuthenticatedProfile } from "./users-profile-access.js";
import { defineValidatedGatewayHandler, type Validator } from "./validation.js";

type Service = ReturnType<typeof miniMeForGateway>;
async function withMiniMe(
  options: GatewayRequestHandlerOptions,
  consume: (service: Service) => Promise<unknown>,
) {
  const requester = await prepareAuthenticatedProfile(options);
  if (!requester.profileId) {
    throw new Error("Mini Me requires your authenticated OpenClaw profile");
  }
  const ownerId = requester.profileId;
  const captured = await captureGatewayOperatorRunAuthority({
    client: options.client,
    context: options.context,
  });
  if (!captured || captured.authority.profileId !== ownerId) {
    throw new Error("Mini Me cannot borrow an agent or another person's identity");
  }
  const assertCurrent = () => {
    requester.assertCurrent();
    captured.authority.assertCurrent();
  };
  try {
    assertCurrent();
    const { miniMeForGateway } = await import("../../mini-me/host.js");
    assertCurrent();
    const result = await consume(
      miniMeForGateway({ options, ownerId, operatorAuthority: captured.authority, assertCurrent }),
    );
    assertCurrent();
    options.respond(true, result);
    if (
      ![
        "miniMe.get",
        "miniMe.export",
        "miniMe.history",
        "miniMe.actions",
        "miniMe.action.get",
        "miniMe.sources.available",
        "miniMe.operation.get",
      ].includes(options.req.method)
    ) {
      publishMiniMeChanged(ownerId, options.context);
    }
  } finally {
    captured.release();
  }
}
function method<T>(
  name: string,
  validate: Validator<T>,
  consume: (service: Service, params: T) => Promise<unknown>,
): GatewayRequestHandler {
  return (options) =>
    defineValidatedGatewayHandler(
      name,
      validate,
      (validated) => withMiniMe(options, (service) => consume(service, validated.params)),
      (error) => errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    )(options);
}

export const miniMeHandlers: GatewayRequestHandlers = {
  "miniMe.get": method("miniMe.get", lazyCompile(S.MiniMeGetParamsSchema), (service) =>
    service.get(),
  ),
  "miniMe.actions": method(
    "miniMe.actions",
    lazyCompile(S.MiniMeActionsParamsSchema),
    (service, params) => service.actions(params.cursor),
  ),
  "miniMe.action.get": method(
    "miniMe.action.get",
    lazyCompile(S.MiniMeActionGetParamsSchema),
    (service, params) => service.action(params.receiptId),
  ),
  "miniMe.create": method(
    "miniMe.create",
    lazyCompile(S.MiniMeCreateParamsSchema),
    (service, params) => service.create(params),
  ),
  "miniMe.configure": method(
    "miniMe.configure",
    lazyCompile(S.MiniMeConfigureParamsSchema),
    (service, params) => service.configure(params),
  ),
  "miniMe.document.set": method(
    "miniMe.document.set",
    lazyCompile(S.MiniMeDocumentSetParamsSchema),
    (service, params) => service.documentSet(params),
  ),
  "miniMe.source.add": method(
    "miniMe.source.add",
    lazyCompile(S.MiniMeSourceAddParamsSchema),
    (service, params) => service.sourceAdd(params),
  ),
  "miniMe.source.remove": method(
    "miniMe.source.remove",
    lazyCompile(S.MiniMeSourceRemoveParamsSchema),
    (service, params) => service.sourceRemove(params),
  ),
  "miniMe.learn": method(
    "miniMe.learn",
    lazyCompile(S.MiniMeLearnParamsSchema),
    (service, params) => service.learn(params),
  ),
  "miniMe.undo": method("miniMe.undo", lazyCompile(S.MiniMeUndoParamsSchema), (service, params) =>
    service.undo(params),
  ),
  "miniMe.predict": method(
    "miniMe.predict",
    lazyCompile(S.MiniMePredictParamsSchema),
    (service, params) => service.predict(params),
  ),
  "miniMe.outcome": method(
    "miniMe.outcome",
    lazyCompile(S.MiniMeOutcomeParamsSchema),
    (service, params) => service.outcome(params),
  ),
  "miniMe.attach": method(
    "miniMe.attach",
    lazyCompile(S.MiniMeAttachParamsSchema),
    (service, params) => service.attach(params),
  ),
  "miniMe.detach": method(
    "miniMe.detach",
    lazyCompile(S.MiniMeDetachParamsSchema),
    (service, params) => service.detach(params),
  ),
  "miniMe.delete": method(
    "miniMe.delete",
    lazyCompile(S.MiniMeDeleteParamsSchema),
    (service, params) => service.delete(params),
  ),
  "miniMe.export": method("miniMe.export", lazyCompile(S.MiniMeExportParamsSchema), (service) =>
    service.export(),
  ),
  "miniMe.history": method(
    "miniMe.history",
    lazyCompile(S.MiniMeHistoryParamsSchema),
    (service, params) => service.history(params.cursor),
  ),
  "miniMe.sources.available": method(
    "miniMe.sources.available",
    lazyCompile(S.MiniMeSourcesAvailableParamsSchema),
    (service) => service.availableSources(),
  ),
  "miniMe.operation.get": method(
    "miniMe.operation.get",
    lazyCompile(S.MiniMeOperationGetParamsSchema),
    (service, params) => service.operation(params.operationId),
  ),
};
