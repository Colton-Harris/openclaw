/**
 * Work Louder Codex Micro vendor-channel wire format.
 *
 * PURE AND DEPENDENCY-FREE ON PURPOSE. No koffi, no `node:*`, no I/O.
 * Everything here is unit-testable with no device attached.
 *
 * Wire format (verified live against firmware v0.4.1):
 *
 *   byte 0     : 0x06        HID report ID (vendor channel)
 *   byte 1     : channel     1 = debug/log, 2 = RPC
 *   byte 2     : length      payload bytes in THIS packet, 0..61
 *   byte 3..63 : UTF-8 payload fragment (zero-padded)
 *
 * Total 64 bytes. Messages longer than 61 payload bytes split across
 * consecutive packets. Device->host replies use the same framing and are
 * reassembled until a newline terminator.
 */

export const REPORT_ID = 0x06;

/** Full packet size including the report-ID byte. */
export const PACKET_SIZE = 64;

/** Packet size as seen on the wire without the report-ID byte (IOKit input callbacks). */
export const PACKET_SIZE_NO_ID = 63;

/** Max payload bytes carried by a single packet: 64 - (id + channel + length). */
export const MAX_PAYLOAD_PER_PACKET = 61;

export const Channel = {
  /** Device debug / log stream. */
  Debug: 1,
  /** JSON-RPC request/response/notification stream. */
  Rpc: 2,
} as const;

export type ChannelId = (typeof Channel)[keyof typeof Channel];

/**
 * Firmware constraint: JSON-RPC ids must stay in [0, 999).
 * Larger ids are rejected by the device.
 */
export const MAX_RPC_ID = 999;

export type DecodedPacket = {
  /** Always `REPORT_ID` for well-formed vendor packets. */
  reportId: number;
  channel: number;
  /** Declared payload length for this packet (already validated <= 61). */
  length: number;
  /** Exactly `length` bytes; padding stripped. */
  payload: Uint8Array;
};

export class FramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FramingError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Split an arbitrary payload into 64-byte HID packets.
 *
 * A zero-length payload still yields one packet, which is how a bare
 * keepalive/flush would be expressed. Splitting is byte-oriented, so a
 * multi-byte UTF-8 sequence may straddle a packet boundary - that is fine,
 * because reassembly concatenates bytes before decoding.
 */
export function encodePackets(
  payload: Uint8Array | string,
  channel: ChannelId = Channel.Rpc,
): Uint8Array[] {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;

  if (!Number.isInteger(channel) || channel < 0 || channel > 0xff) {
    throw new FramingError(`channel must be a byte, got ${String(channel)}`);
  }

  const packets: Uint8Array[] = [];
  let offset = 0;

  do {
    const chunk = bytes.subarray(offset, offset + MAX_PAYLOAD_PER_PACKET);
    const packet = new Uint8Array(PACKET_SIZE); // zero-filled padding
    packet[0] = REPORT_ID;
    packet[1] = channel;
    packet[2] = chunk.length;
    packet.set(chunk, 3);
    packets.push(packet);
    offset += MAX_PAYLOAD_PER_PACKET;
  } while (offset < bytes.length);

  return packets;
}

export type RpcRequest = {
  method: string;
  params?: unknown;
  id: number;
};

/**
 * Serialise a JSON-RPC request the way this firmware expects it.
 *
 * NOTE: there is deliberately NO `jsonrpc` field - the device's dialect omits
 * it, and the vendor SDK does too. `params` is emitted as explicit `null` when
 * absent, matching observed vendor traffic.
 */
export function encodeRpcMessage(req: RpcRequest): string {
  assertValidRpcId(req.id);
  if (typeof req.method !== "string" || req.method.length === 0) {
    throw new FramingError("method must be a non-empty string");
  }
  return JSON.stringify({
    method: req.method,
    params: req.params === undefined ? null : req.params,
    id: req.id,
  });
}

/**
 * Encode a JSON-RPC request into ready-to-write 64-byte packets.
 *
 * `terminator` defaults to "\n" because replies are newline-delimited and the
 * device's parser is line-oriented.
 */
export function encodeRequest(
  req: RpcRequest,
  opts: { terminator?: string; channel?: ChannelId } = {},
): Uint8Array[] {
  const terminator = opts.terminator ?? "\n";
  return encodePackets(encodeRpcMessage(req) + terminator, opts.channel ?? Channel.Rpc);
}

/**
 * Decode one packet.
 *
 * Accepts both shapes seen in practice, discriminated purely by length:
 *  - 64 bytes: report-ID byte present (what we hand to `IOHIDDeviceSetReport`,
 *    and what this device's input reports actually carry).
 *  - 63 bytes: report-ID stripped, which is what IOKit's input-report callback
 *    delivers when it passes the reportID as a separate argument.
 */
export function decodePacket(buf: Uint8Array): DecodedPacket {
  let reportId: number;
  let body: Uint8Array;

  if (buf.length === PACKET_SIZE) {
    reportId = buf[0]!;
    body = buf.subarray(1);
  } else if (buf.length === PACKET_SIZE_NO_ID) {
    reportId = REPORT_ID;
    body = buf;
  } else {
    throw new FramingError(
      `packet must be ${PACKET_SIZE} or ${PACKET_SIZE_NO_ID} bytes, got ${buf.length}`,
    );
  }

  const channel = body[0]!;
  const length = body[1]!;

  if (length > MAX_PAYLOAD_PER_PACKET) {
    throw new FramingError(
      `declared payload length ${length} exceeds max ${MAX_PAYLOAD_PER_PACKET}`,
    );
  }

  return {
    reportId,
    channel,
    length,
    payload: body.subarray(2, 2 + length),
  };
}

export type ReassembledMessage = {
  channel: number;
  text: string;
};

/**
 * Reassembles newline-delimited messages from a stream of 64-byte packets.
 *
 * Per-channel buffering: the debug channel (1) and the RPC channel (2) are
 * independent streams and must not contaminate each other's partial lines.
 *
 * `maxBufferBytes` guards against a device that never emits a newline - without
 * it, a wedged device would grow this buffer without bound.
 */
export class Reassembler {
  // Buffers hold BYTES, not strings. Decoding each packet's payload to text
  // independently would corrupt any multi-byte UTF-8 sequence that straddles a
  // packet boundary - a 3-byte char split 1/2 across two packets decodes to
  // replacement characters and the message is silently wrong. Concatenate
  // first, decode only at newline boundaries.
  readonly #buffers = new Map<number, Uint8Array>();
  readonly #maxBufferBytes: number;

  constructor(opts: { maxBufferBytes?: number } = {}) {
    this.#maxBufferBytes = opts.maxBufferBytes ?? 64 * 1024;
  }

  /**
   * Feed one packet. Returns zero or more complete messages (newline stripped).
   * Empty lines are dropped - a keepalive packet yields nothing.
   */
  push(packet: Uint8Array): ReassembledMessage[] {
    const { channel, payload } = decodePacket(packet);
    return this.pushDecoded(channel, payload);
  }

  /** Same as `push`, for callers that already decoded the header. */
  pushDecoded(channel: number, payload: Uint8Array): ReassembledMessage[] {
    const prev = this.#buffers.get(channel);
    let buf: Uint8Array;
    if (prev === undefined || prev.length === 0) {
      buf = payload.slice();
    } else {
      buf = new Uint8Array(prev.length + payload.length);
      buf.set(prev, 0);
      buf.set(payload, prev.length);
    }

    const NEWLINE = 0x0a;
    const CR = 0x0d;

    const out: ReassembledMessage[] = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== NEWLINE) {
        continue;
      }
      let end = i;
      if (end > start && buf[end - 1] === CR) {
        end -= 1;
      }
      if (end > start) {
        out.push({ channel, text: decoder.decode(buf.subarray(start, end)) });
      }
      start = i + 1;
    }
    buf = buf.subarray(start);

    if (buf.length > this.#maxBufferBytes) {
      this.#buffers.delete(channel);
      throw new FramingError(
        `channel ${channel} exceeded ${this.#maxBufferBytes} bytes with no newline; buffer dropped`,
      );
    }

    this.#buffers.set(channel, buf);
    return out;
  }

  /** Bytes currently buffered for a channel, awaiting a newline. */
  pending(channel: number): number {
    return this.#buffers.get(channel)?.length ?? 0;
  }

  reset(): void {
    this.#buffers.clear();
  }
}

export type RpcResponse = {
  id: number;
  result?: unknown;
  error?: unknown;
};

export type RpcNotification = {
  method: string;
  params?: unknown;
};

export type RpcMessage =
  | ({ kind: "response" } & RpcResponse)
  | ({ kind: "notification" } & RpcNotification);

/**
 * Parse one reassembled line.
 *
 * Returns null for anything that is not valid JSON or not recognisably a
 * response/notification - the debug channel emits free-form log text, and a
 * transport must not throw on it.
 */
export function parseRpcMessage(text: string): RpcMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return null;
  }

  const rec = obj as Record<string, unknown>;

  // THE DISCRIMINATOR IS `id`, NOT `method`. This firmware echoes the method
  // back on replies - `{"result":{...},"id":1,"method":"sys.version"}` - so a
  // parser that checks for `method` first misclassifies EVERY reply as a
  // notification and no request ever resolves.
  if (typeof rec.id === "number") {
    return {
      kind: "response",
      id: rec.id,
      result: rec.result,
      error: rec.error,
    };
  }

  // NOTIFICATIONS ARRIVE IN COMPACT FORM. Verified against a live capture: the
  // device sends `{"m":"v.oai.rad","p":{"a":0.085069,"d":0.006819}}` unprompted.
  // Responses use the long `method`/`params` spelling, notifications use `m`/`p`,
  // and the vendor's own SDK reads `method || m`. Accepting only the long form
  // silently discards EVERY input event the device ever sends.
  //
  // Each spelling carries its OWN params key, so this is two branches rather
  // than a `method || m` / `params ?? p` chain: the long form must keep
  // reporting its literal `params`, including an explicit null.
  if (typeof rec.method === "string") {
    return { kind: "notification", method: rec.method, params: rec.params };
  }
  if (typeof rec.m === "string") {
    return { kind: "notification", method: rec.m, params: rec.p };
  }

  return null;
}

export function assertValidRpcId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id >= MAX_RPC_ID) {
    throw new FramingError(`rpc id must be an integer in [0, ${MAX_RPC_ID}), got ${String(id)}`);
  }
}

/** Next id in the firmware-legal [0, 999) ring. */
export function nextRpcId(current: number): number {
  assertValidRpcId(current);
  return (current + 1) % MAX_RPC_ID;
}

/** Stateful allocator over the same ring. */
export class RpcIdAllocator {
  #next: number;

  constructor(start = 0) {
    assertValidRpcId(start);
    this.#next = start;
  }

  take(): number {
    const id = this.#next;
    this.#next = nextRpcId(id);
    return id;
  }

  peek(): number {
    return this.#next;
  }
}
