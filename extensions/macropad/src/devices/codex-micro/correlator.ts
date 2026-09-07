/**
 * Request/response correlation over the firmware's [0, 999) id ring.
 *
 * Pure and I/O-free on purpose, so the tricky parts (id reuse across a lap of
 * the ring, timeouts, late replies, close-with-inflight) are unit-testable with
 * no device attached.
 */
import { MAX_RPC_ID, RpcIdAllocator } from "./framing.js";

export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly id: number;
  constructor(method: string, id: number, timeoutMs: number) {
    super(
      `no reply to "${method}" (id ${id}) within ${timeoutMs}ms. ` +
        `NOTE: IOHIDDeviceSetReport returning success does NOT prove delivery - ` +
        `this firmware silently drops malformed frames.`,
    );
    this.name = "RpcTimeoutError";
    this.method = method;
    this.id = id;
  }
}

export class RpcError extends Error {
  readonly rpcError: unknown;
  constructor(method: string, rpcError: unknown) {
    super(`device returned an error for "${method}": ${JSON.stringify(rpcError)}`);
    this.name = "RpcError";
    this.rpcError = rpcError;
  }
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cancelTimer: () => void;
};

export type CorrelatorOptions = {
  startId?: number;
  /** Injectable for tests; defaults to real timers. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export class Correlator {
  readonly #ids: RpcIdAllocator;
  readonly #pending = new Map<number, Pending>();
  readonly #setTimeout: (fn: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  constructor(opts: CorrelatorOptions = {}) {
    this.#ids = new RpcIdAllocator(opts.startId ?? 1);
    this.#setTimeout =
      opts.setTimeoutFn ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimeout =
      // SAFETY: the default timer factory above returns a native setTimeout handle.
      opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  hasPending(id: number): boolean {
    return this.#pending.has(id);
  }

  /**
   * Allocate an id that is not already awaiting a reply.
   *
   * The ring is only 999 wide, so a long-lived process WILL lap it. Handing out
   * an id that is still in flight would route the reply to the wrong caller, so
   * live ids are skipped.
   */
  allocateId(): number {
    for (let i = 0; i < MAX_RPC_ID; i++) {
      const id = this.#ids.take();
      if (!this.#pending.has(id)) {
        return id;
      }
    }
    throw new Error(`all ${MAX_RPC_ID} RPC ids are in flight`);
  }

  /** Register a pending request. Returns the promise the caller awaits. */
  register(id: number, method: string, timeoutMs: number): Promise<unknown> {
    if (this.#pending.has(id)) {
      throw new Error(`id ${id} is already in flight`);
    }
    return new Promise<unknown>((resolve, reject) => {
      const handle = this.#setTimeout(() => {
        this.#pending.delete(id);
        reject(new RpcTimeoutError(method, id, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        cancelTimer: () => this.#clearTimeout(handle),
      });
    });
  }

  /** Drop a registration without settling it (used when the write itself fails). */
  cancel(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    pending.cancelTimer();
    this.#pending.delete(id);
  }

  /**
   * Deliver a response. Returns true if it matched a pending request.
   *
   * A false return is normal and must not throw: it means a late reply arrived
   * after a timeout, or the reply belongs to another process sharing this
   * device (the ChatGPT app does exactly that).
   */
  settle(id: number, result: unknown, error?: unknown): boolean {
    const pending = this.#pending.get(id);
    if (!pending) {
      return false;
    }
    this.#pending.delete(id);
    pending.cancelTimer();
    if (error !== undefined && error !== null) {
      pending.reject(new RpcError(pending.method, error));
    } else {
      pending.resolve(result);
    }
    return true;
  }

  /** Reject everything in flight, e.g. on close or reconnect. */
  rejectAll(reason: string): void {
    // Snapshot: settling a caller can enqueue new requests.
    for (const [id, pending] of Array.from(this.#pending)) {
      this.#pending.delete(id);
      pending.cancelTimer();
      pending.reject(new Error(reason));
    }
  }
}
