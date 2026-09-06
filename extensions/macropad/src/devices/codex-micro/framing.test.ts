/**
 * Wire-format unit tests. NO DEVICE REQUIRED.
 *
 * Ported from the proving spike, where every one of these ran green against a
 * device-free `node --test`. They stay device-free here on purpose: the framing
 * is the part that silently corrupts data when it is wrong, so it must be
 * provable without hardware in the loop.
 */
import { describe, expect, it } from "vitest";
import {
  Channel,
  decodePacket,
  encodePackets,
  encodeRequest,
  encodeRpcMessage,
  FramingError,
  MAX_PAYLOAD_PER_PACKET,
  MAX_RPC_ID,
  nextRpcId,
  PACKET_SIZE,
  PACKET_SIZE_NO_ID,
  parseRpcMessage,
  Reassembler,
  REPORT_ID,
  RpcIdAllocator,
} from "./framing.js";

const dec = new TextDecoder();

describe("packet layout", () => {
  it("puts a short payload in exactly one 64-byte packet with the right header", () => {
    const [packet, ...rest] = encodePackets("hi", Channel.Rpc);
    expect(rest).toHaveLength(0);
    expect(packet!).toHaveLength(PACKET_SIZE);
    expect(packet![0]).toBe(REPORT_ID);
    expect(packet![1]).toBe(Channel.Rpc);
    expect(packet![2]).toBe(2);
    expect(dec.decode(packet!.subarray(3, 5))).toBe("hi");
  });

  it("zero-pads unused tail bytes rather than leaving garbage", () => {
    const [packet] = encodePackets("abc");
    expect(packet!.subarray(6).every((byte) => byte === 0)).toBe(true);
  });

  it("still yields one packet with length 0 for an empty payload", () => {
    const packets = encodePackets("");
    expect(packets).toHaveLength(1);
    expect(packets[0]![2]).toBe(0);
  });

  it("fits exactly 61 bytes in one packet with no spurious second packet", () => {
    const packets = encodePackets("x".repeat(MAX_PAYLOAD_PER_PACKET));
    expect(packets).toHaveLength(1);
    expect(packets[0]![2]).toBe(61);
  });

  it("splits 62 bytes into two packets of 61 and 1", () => {
    const packets = encodePackets("x".repeat(62));
    expect(packets).toHaveLength(2);
    expect(packets[0]![2]).toBe(61);
    expect(packets[1]![2]).toBe(1);
  });

  it("encodes the debug channel distinctly from the RPC channel", () => {
    expect(encodePackets("a", Channel.Debug)[0]![1]).toBe(1);
    expect(encodePackets("a", Channel.Rpc)[0]![1]).toBe(2);
  });
});

describe("multi-packet payloads", () => {
  it("ACCEPTANCE: splits a >61-byte payload across packets and round-trips byte-exact", () => {
    // 200 bytes -> ceil(200/61) = 4 packets (61, 61, 61, 17)
    const payload = Array.from({ length: 200 }, (_, index) =>
      String.fromCharCode(0x41 + (index % 26)),
    ).join("");
    expect(payload).toHaveLength(200);

    const packets = encodePackets(payload, Channel.Rpc);
    expect(packets).toHaveLength(4);
    expect(packets.map((packet) => packet[2])).toEqual([61, 61, 61, 17]);

    // Every packet is a well-formed, full-size HID report.
    for (const packet of packets) {
      expect(packet).toHaveLength(PACKET_SIZE);
      expect(packet[0]).toBe(REPORT_ID);
      expect(packet[1]).toBe(Channel.Rpc);
    }

    const rebuilt = packets.map((packet) => dec.decode(decodePacket(packet).payload)).join("");
    expect(rebuilt).toBe(payload);
  });

  it("splits a realistic six-key thstatus request correctly", () => {
    const params = Array.from({ length: 6 }, (_, id) => ({
      id,
      c: 0x00_ff_88,
      b: 0.6,
      e: 1,
      s: 0,
      sk: 0,
      sa: 0,
    }));
    const packets = encodeRequest({ method: "v.oai.thstatus", params, id: 7 });
    expect(packets.length).toBeGreaterThan(1);

    const text = packets.map((packet) => dec.decode(decodePacket(packet).payload)).join("");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text.trimEnd()) as {
      method: string;
      id: number;
      params: { id: number }[];
    };
    expect(parsed.method).toBe("v.oai.thstatus");
    expect(parsed.id).toBe(7);
    expect(parsed.params).toHaveLength(6);
    expect(parsed.params[5]!.id).toBe(5);
  });
});

describe("decodePacket", () => {
  it("accepts the 63-byte id-stripped shape from IOKit input callbacks", () => {
    const full = encodePackets("hello")[0]!;
    const stripped = full.subarray(1);
    expect(stripped).toHaveLength(PACKET_SIZE_NO_ID);

    const decoded = decodePacket(stripped);
    expect(decoded.reportId).toBe(REPORT_ID);
    expect(decoded.channel).toBe(Channel.Rpc);
    expect(dec.decode(decoded.payload)).toBe("hello");
  });

  it("rejects a wrong-size buffer", () => {
    expect(() => decodePacket(new Uint8Array(10))).toThrow(FramingError);
    expect(() => decodePacket(new Uint8Array(65))).toThrow(FramingError);
  });

  it("rejects a declared length above the 61-byte maximum", () => {
    const bad = new Uint8Array(PACKET_SIZE);
    bad[0] = REPORT_ID;
    bad[1] = Channel.Rpc;
    bad[2] = 62; // impossible
    expect(() => decodePacket(bad)).toThrow(FramingError);
  });

  it("strips padding so payload length matches the declared length exactly", () => {
    const [packet] = encodePackets("ab");
    expect(decodePacket(packet!).payload).toHaveLength(2);
  });
});

describe("Reassembler", () => {
  it("ACCEPTANCE: reassembles a multi-packet newline-terminated reply into one message", () => {
    // Mimics a device reply larger than one packet, as device.status returns.
    const reply = JSON.stringify({
      id: 42,
      result: {
        version: "0.2.1",
        build: "2026-09-06T00:00:00Z",
        model: "codex-micro",
        serial: "441BF6D10AB4",
      },
    });
    expect(reply.length).toBeGreaterThan(MAX_PAYLOAD_PER_PACKET);

    const packets = encodePackets(`${reply}\n`, Channel.Rpc);
    expect(packets.length).toBeGreaterThanOrEqual(2);

    const reassembler = new Reassembler();
    const done: string[] = [];
    packets.forEach((packet, index) => {
      const messages = reassembler.push(packet);
      if (index < packets.length - 1) {
        expect(messages, "no message may complete before the newline arrives").toHaveLength(0);
      }
      done.push(...messages.map((message) => message.text));
    });

    expect(done).toHaveLength(1);
    expect(done[0]).toBe(reply);

    const parsed = parseRpcMessage(done[0]!);
    expect(parsed?.kind).toBe("response");
    expect((parsed as { id: number }).id).toBe(42);
    expect(reassembler.pending(Channel.Rpc), "buffer must be drained").toBe(0);
  });

  it("emits two messages packed into a single packet, in order", () => {
    const [packet] = encodePackets('{"id":1}\n{"id":2}\n');
    const messages = new Reassembler().push(packet!);
    expect(messages.map((message) => message.text)).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("reassembles a message split mid-token across packets", () => {
    const reassembler = new Reassembler();
    const a = encodePackets('{"id":9,"result":"abc')[0]!;
    const b = encodePackets('def"}\n')[0]!;
    expect(reassembler.push(a)).toHaveLength(0);
    const messages = reassembler.push(b);
    expect(messages).toHaveLength(1);
    expect((JSON.parse(messages[0]!.text) as { result: string }).result).toBe("abcdef");
  });

  it("survives a multi-byte UTF-8 sequence straddling a packet boundary", () => {
    // THIS TEST CAUGHT A REAL BUG. The first implementation buffered decoded
    // strings, so a 3-byte character split 1/2 across a packet boundary became
    // replacement characters and the reply was silently wrong. Buffering bytes
    // and decoding only at newlines is the fix; do not "simplify" it back.
    const payload = `${"y".repeat(60)}✓\n`;
    const packets = encodePackets(payload);
    expect(packets).toHaveLength(2);

    const reassembler = new Reassembler();
    const out = packets.flatMap((packet) => reassembler.push(packet));
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe(`${"y".repeat(60)}✓`);
  });

  it("buffers the debug and RPC channels independently", () => {
    const reassembler = new Reassembler();
    reassembler.push(encodePackets("partial-log-line", Channel.Debug)[0]!);
    const rpc = reassembler.push(encodePackets('{"id":3}\n', Channel.Rpc)[0]!);

    expect(rpc).toHaveLength(1);
    expect(rpc[0]!.channel).toBe(Channel.Rpc);
    expect(rpc[0]!.text).toBe('{"id":3}');
    expect(reassembler.pending(Channel.Debug), "debug buffer untouched").toBe(
      "partial-log-line".length,
    );
  });

  it("produces no messages for empty lines (keepalives)", () => {
    const reassembler = new Reassembler();
    expect(reassembler.push(encodePackets("\n\n")[0]!)).toHaveLength(0);
    expect(reassembler.push(encodePackets("")[0]!)).toHaveLength(0);
  });

  it("strips the carriage return from a CRLF-terminated line", () => {
    const messages = new Reassembler().push(encodePackets('{"id":1}\r\n')[0]!);
    expect(messages[0]!.text).toBe('{"id":1}');
  });

  it("drops the buffer and throws if a channel never emits a newline", () => {
    const reassembler = new Reassembler({ maxBufferBytes: 100 });
    const packet = encodePackets("z".repeat(61))[0]!;
    expect(() => {
      for (let i = 0; i < 5; i++) {
        reassembler.push(packet);
      }
    }).toThrow(FramingError);
    expect(reassembler.pending(Channel.Rpc), "buffer must be released, not leaked").toBe(0);
  });
});

describe("JSON-RPC envelope", () => {
  it("omits the jsonrpc field entirely - this firmware rejects the standard envelope", () => {
    const encoded = encodeRpcMessage({ method: "sys.version", id: 1 });
    expect(encoded.includes("jsonrpc")).toBe(false);
    expect(JSON.parse(encoded)).toEqual({ method: "sys.version", params: null, id: 1 });
  });

  it("serialises absent params as explicit null", () => {
    const encoded = JSON.parse(encodeRpcMessage({ method: "device.status", id: 0 })) as {
      params: unknown;
    };
    expect(encoded.params).toBeNull();
  });

  it("discriminates responses from notifications", () => {
    const response = parseRpcMessage('{"id":5,"result":{"ok":true}}');
    expect(response?.kind).toBe("response");
    expect((response as { id: number }).id).toBe(5);

    const notification = parseRpcMessage('{"method":"v.oai.hid","params":{"k":2,"act":1,"ag":0}}');
    expect(notification?.kind).toBe("notification");
    expect((notification as { method: string }).method).toBe("v.oai.hid");
  });

  it("classifies a reply that ECHOES its method as a response, not a notification", () => {
    // Verified live: this firmware replies `{"result":{...},"id":1,"method":"sys.version"}`.
    // A parser that checks `method` first misclassifies every reply and no
    // request ever resolves. `id` must be the discriminator.
    const reply = parseRpcMessage('{"result":{"version":"v0.4.1"},"id":1,"method":"sys.version"}');
    expect(reply?.kind).toBe("response");
    expect((reply as { id: number }).id).toBe(1);
    expect((reply as { result: unknown }).result).toEqual({ version: "v0.4.1" });
  });

  it("ACCEPTANCE: parses the COMPACT notification form the device actually sends", () => {
    // These are real captured bytes. The device emitted this unprompted during a
    // passive listening window while nothing had requested anything. Responses
    // use `method`/`params`; notifications use `m`/`p`. A parser that accepts
    // only the long spelling returns null here and throws away EVERY input
    // event the hardware produces, which reads exactly like a dead input path.
    const captured = '{"m":"v.oai.rad","p":{"a":0.085069,"d":0.006819}}';
    const parsed = parseRpcMessage(captured);

    expect(parsed, "captured dial bytes must not parse to null").not.toBeNull();
    expect(parsed?.kind).toBe("notification");
    expect((parsed as { method: string }).method).toBe("v.oai.rad");
    expect((parsed as { params: unknown }).params).toEqual({ a: 0.085069, d: 0.006819 });
  });

  it("still parses the LONG response form byte-for-byte after compact support", () => {
    // The compact fix must not disturb the response path: `id` stays the
    // discriminator even when the reply echoes its method back.
    const reply = parseRpcMessage('{"result":{"version":"v0.4.1"},"id":1,"method":"sys.version"}');
    expect(reply?.kind).toBe("response");
    expect((reply as { id: number }).id).toBe(1);
    expect((reply as { result: unknown }).result).toEqual({ version: "v0.4.1" });

    // ...and a long-form NOTIFICATION keeps reading its own `params` key rather
    // than falling through to the compact `p`.
    const longNotification = parseRpcMessage('{"method":"v.oai.rad","params":{"a":1,"d":2}}');
    expect(longNotification?.kind).toBe("notification");
    expect((longNotification as { params: unknown }).params).toEqual({ a: 1, d: 2 });
  });

  it("prefers the long spelling when a line somehow carries both", () => {
    const parsed = parseRpcMessage(
      '{"method":"long.form","params":{"x":1},"m":"short","p":{"y":2}}',
    );
    expect((parsed as { method: string }).method).toBe("long.form");
    expect((parsed as { params: unknown }).params).toEqual({ x: 1 });
  });

  it("returns null for log noise instead of throwing", () => {
    expect(parseRpcMessage("I (1234) wl_hid: booting")).toBeNull();
    expect(parseRpcMessage("[]")).toBeNull();
    expect(parseRpcMessage('{"unrelated":1}')).toBeNull();
  });

  it("surfaces an error response as a response rather than swallowing it", () => {
    const parsed = parseRpcMessage('{"id":8,"error":{"code":-32601,"message":"no such method"}}');
    expect(parsed?.kind).toBe("response");
    expect((parsed as { error: unknown }).error).toEqual({
      code: -32601,
      message: "no such method",
    });
  });
});

describe("rpc id ring", () => {
  it("ACCEPTANCE: wraps at 999 and never leaves the firmware-legal range", () => {
    expect(nextRpcId(0)).toBe(1);
    expect(nextRpcId(997)).toBe(998);
    expect(nextRpcId(998), "998 is the last legal id; the next must wrap to 0").toBe(0);

    const allocator = new RpcIdAllocator(996);
    expect([allocator.take(), allocator.take(), allocator.take(), allocator.take()]).toEqual([
      996, 997, 998, 0,
    ]);
  });

  it("visits every legal id exactly once in a full lap and returns to its start", () => {
    const allocator = new RpcIdAllocator(0);
    const seen = new Set<number>();
    for (let i = 0; i < MAX_RPC_ID; i++) {
      const id = allocator.take();
      expect(Number.isInteger(id) && id >= 0 && id < MAX_RPC_ID, `id ${id} out of range`).toBe(
        true,
      );
      seen.add(id);
    }
    expect(seen.size).toBe(MAX_RPC_ID);
    expect(allocator.peek()).toBe(0);
  });

  it("rejects out-of-range or non-integer ids at encode time", () => {
    expect(() => encodeRpcMessage({ method: "sys.version", id: 999 })).toThrow(FramingError);
    expect(() => encodeRpcMessage({ method: "sys.version", id: -1 })).toThrow(FramingError);
    expect(() => encodeRpcMessage({ method: "sys.version", id: 1.5 })).toThrow(FramingError);
    expect(() => nextRpcId(999)).toThrow(FramingError);
  });

  it("rejects an empty method name", () => {
    expect(() => encodeRpcMessage({ method: "", id: 1 })).toThrow(FramingError);
  });
});
