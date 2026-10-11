import { AsyncLocalStorage } from "node:async_hooks";
import type { MiniMeEffect } from "../../packages/gateway-protocol/src/schema/mini-me.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { MiniMeDelegationAction, MiniMeDelegationFence } from "./delegation.types.js";

type EffectScope = Readonly<{
  action: MiniMeDelegationAction;
  assertCurrent: () => void;
  beforeDispatch: (action: MiniMeDelegationAction) => Promise<void>;
}>;

const effectScope = resolveGlobalSingleton(
  Symbol.for("openclaw.miniMeEffectScope"),
  () => new AsyncLocalStorage<EffectScope>(),
);

/**
 * Host-only propagation through preparation and the exact final action fence.
 * This adds restrictions to existing tool owners; it grants no tool permission.
 */
export async function withMiniMeEffectScope<T>(
  fence: MiniMeDelegationFence,
  run: () => Promise<T>,
): Promise<T> {
  const inherited = effectScope.getStore();
  let open = true;
  let dispatched = false;
  let preparingDispatch = false;
  const assertCurrent = () => {
    if (!open) {
      throw new Error("Mini Me effect scope is closed.");
    }
    inherited?.assertCurrent();
    if (dispatched) {
      fence.assertCurrent();
    } else {
      fence.assertPreparing();
    }
  };
  try {
    assertCurrent();
    return await effectScope.run(
      Object.freeze({
        action: fence.action,
        assertCurrent,
        async beforeDispatch(action: MiniMeDelegationAction) {
          assertCurrent();
          if (preparingDispatch || dispatched) {
            throw new Error("Mini Me permits one effect per delegated choice.");
          }
          preparingDispatch = true;
          await fence.beforeDispatch(action);
          dispatched = true;
          assertCurrent();
        },
      }),
      run,
    );
  } finally {
    open = false;
  }
}

/** Capture before an await so a retained owner cannot borrow a later run's scope. */
export function captureMiniMeEffectAssertion(): (() => void) | undefined {
  return effectScope.getStore()?.assertCurrent;
}

/** Only the selected core effect owner may admit the final normalized action. */
export function captureMiniMeEffectPreparation(effect: MiniMeEffect): EffectScope | undefined {
  const scope = effectScope.getStore();
  if (scope && scope.action.effect !== effect) {
    throw new Error("This tool does not own the selected Mini Me effect.");
  }
  return scope;
}

export function miniMeWorkspaceResource(rootReal: string, relativePath: string): string {
  return `workspace:${JSON.stringify([rootReal, relativePath])}`;
}

export function miniMeMessageResource(input: {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string | number | null;
}): string {
  return `message:${JSON.stringify([
    input.channel,
    input.accountId,
    input.to,
    input.threadId == null ? null : String(input.threadId),
  ])}`;
}
