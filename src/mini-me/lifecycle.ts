import { MINI_ME_LIMITS } from "./learning.js";

export type MiniMeReadLifetime = { signal: AbortSignal; assertCurrent(this: void): void };

/**
 * One host owner coordinates feature work with its canonical SQLite owners.
 * Durable lifecycle/generation remains in SQLite; this fence closes admission
 * synchronously while its durable change is awaiting the writer broker.
 */
export class MiniMeLifecycleOwner {
  private epoch = 0;
  private pendingMutations = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private readonly reads = new Set<Promise<unknown>>();
  private retired = false;

  constructor(private readonly assertPhysicalOwner: () => void) {}

  private assertOwner(): void {
    this.assertPhysicalOwner();
    if (this.retired) {
      throw new Error("Mini Me runtime owner has retired");
    }
  }

  read<T>(
    assertRequester: () => void,
    operation: (lifetime: MiniMeReadLifetime) => Promise<T>,
  ): Promise<T> {
    this.assertOwner();
    assertRequester();
    if (this.pendingMutations) {
      return Promise.reject(
        new Error("Mini Me is updating; read again after the operation settles"),
      );
    }
    const epoch = this.epoch;
    const signal = this.controller.signal;
    const assertCurrent = () => {
      this.assertOwner();
      assertRequester();
      signal.throwIfAborted();
      if (epoch !== this.epoch || this.pendingMutations) {
        throw new Error("Mini Me consent or data changed during this operation");
      }
    };
    const work = Promise.resolve().then(async () => {
      assertCurrent();
      const result = await operation({ signal, assertCurrent });
      assertCurrent();
      return result;
    });
    this.reads.add(work);
    void work.finally(() => this.reads.delete(work)).catch(() => {});
    return work;
  }

  /** Admit post-mutation work only after the mutation that queued it has settled. */
  async whenMutationsSettled(assertRequester: () => void): Promise<void> {
    this.assertOwner();
    assertRequester();
    const currentTail = this.mutationTail;
    await currentTail;
    this.assertOwner();
    assertRequester();
  }

  mutate<T>(assertRequester: () => void, operation: () => Promise<T>): Promise<T> {
    this.assertOwner();
    assertRequester();
    if (this.pendingMutations >= MINI_ME_LIMITS.queuePerOwner) {
      return Promise.reject(new Error("Mini Me update queue is full; no data was accepted"));
    }
    this.pendingMutations += 1;
    // Close read/model admission before the first asynchronous durable change.
    this.controller.abort(new Error("Mini Me is updating"));
    const result = this.mutationTail.then(async () => {
      this.assertOwner();
      assertRequester();
      this.epoch += 1;
      await Promise.allSettled(this.reads);
      this.assertOwner();
      assertRequester();
      return operation();
    });
    const settled = result.finally(() => {
      this.pendingMutations -= 1;
      this.epoch += 1;
      if (!this.pendingMutations && !this.retired) {
        this.controller = new AbortController();
      }
    });
    this.mutationTail = settled.then(
      () => {},
      () => {},
    );
    return settled;
  }

  async retire(): Promise<void> {
    this.retired = true;
    this.controller.abort(new Error("Mini Me runtime owner has retired"));
    await Promise.allSettled([this.mutationTail, ...this.reads]);
  }
}
