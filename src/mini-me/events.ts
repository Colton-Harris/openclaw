import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { readResidentUserProfileId } from "../state/user-profile-list.js";

/** Send only an invalidation signal to this person's current connections. */
export function publishMiniMeChanged(
  ownerId: string,
  context = getInProcessGatewayRequestContext(),
): void {
  if (!context?.getClientConnIds || readResidentUserProfileId(ownerId) !== ownerId) {
    return;
  }
  const recipients = context.getClientConnIds(
    (client) =>
      !client.invalidated &&
      !client.connectionSignal?.aborted &&
      client.authenticatedUserProfile?.profileId === ownerId,
  );
  if (recipients.size) {
    context.broadcastToConnIds("miniMe.changed", {}, recipients);
  }
}
