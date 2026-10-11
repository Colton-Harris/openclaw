import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { MiniMeLifecycleOwner } from "./lifecycle.js";

describe("Mini Me post-mutation admission", () => {
  it("waits for the mutation's final asynchronous work before opening a read", async () => {
    const entered = createDeferred();
    const finish = createDeferred();
    const owner = new MiniMeLifecycleOwner(() => {});
    const events: string[] = [];
    const mutation = owner.mutate(
      () => {},
      async () => {
        events.push("mutation");
        entered.resolve();
        await finish.promise;
        events.push("snapshot-complete");
      },
    );
    await entered.promise;
    const background = owner
      .whenMutationsSettled(() => {})
      .then(() =>
        owner.read(
          () => {},
          async () => {
            events.push("learning");
          },
        ),
      );
    await Promise.resolve();
    expect(events).toEqual(["mutation"]);
    finish.resolve();
    await Promise.all([mutation, background]);
    expect(events).toEqual(["mutation", "snapshot-complete", "learning"]);
  });

  it.each(["requester", "physical owner"] as const)(
    "rejects a waiter whose %s is revoked while the mutation finishes",
    async (revocation) => {
      const entered = createDeferred();
      const finish = createDeferred();
      let requester = true;
      let physical = true;
      const assertRequester = () => {
        if (!requester) {
          throw new Error("requester revoked");
        }
      };
      const owner = new MiniMeLifecycleOwner(() => {
        if (!physical) {
          throw new Error("physical owner revoked");
        }
      });
      const mutation = owner.mutate(assertRequester, async () => {
        entered.resolve();
        await finish.promise;
      });
      await entered.promise;
      const background = owner.whenMutationsSettled(assertRequester);
      const rejection = expect(background).rejects.toThrow("revoked");
      if (revocation === "requester") {
        requester = false;
      } else {
        physical = false;
      }
      finish.resolve();
      await mutation;
      await rejection;
    },
  );
});
