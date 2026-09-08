import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import {
  isWebPushQuietHours,
  resolveEffectiveWebPushPreferences,
  webPushCategoryEnabled,
} from "../../../src/infra/push-web-preferences.js";
import { createHandoffService, type HandoffRecord } from "./handoff.js";
import type { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";

let setupCounter = 0;

function setup() {
  resetPluginStateStoreForTests();
  const store = createPluginStateKeyedStoreForTests<HandoffRecord>("workboard-handoff-test", {
    namespace: "handoffs-" + ++setupCounter,
    maxEntries: 100,
    overflowPolicy: "reject-new",
  });
  const service = createHandoffService({ store, now: () => 100 });
  return { store, service };
}

const createInput = {
  summary: "Candidate is ready for review.",
  artifact: { label: "candidate diff", path: "/tmp/candidate.diff" },
  nextAction: "Parent reviews and activates.",
  deliveryText: "Candidate is ready for review.",
  recipient: {
    channel: "telegram",
    accountId: "owner",
    to: "founder",
    sessionKey: "agent:main:main",
  },
  idempotencyKey: "candidate-1",
};

describe("durable founder handoffs", () => {
  it("survives service recreation and idempotent replay", async () => {
    const first = setup();
    const created = await first.service.create(createInput);
    const replay = await first.service.create(createInput);
    expect(replay.id).toBe(created.id);
    const restarted = createHandoffService({ store: first.store, now: () => 200 });
    await expect(restarted.listAll()).resolves.toHaveLength(1);
    await expect(restarted.listAll()).resolves.toMatchObject([
      { summary: createInput.summary, nextAction: createInput.nextAction },
    ]);
  });

  it("keeps attempted, delivered, failed, and unknown distinct and never resends", async () => {
    const { service } = setup();
    const delivered = await service.create({ ...createInput, idempotencyKey: "delivered" });
    const message = {
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "attempt-delivered-1",
    };
    await service.markAttempted(message);
    await service.markAttempted(message);
    await service.markSent({ ...message, success: true, messageId: "msg-1" });
    expect(
      (await service.listAll()).find((row) => row.id === delivered.id)?.attempts,
    ).toMatchObject([{ state: "delivered", messageId: "msg-1" }]);

    const failedMessage = { ...message, content: "failed delivery" };
    const failed = await service.create({
      ...createInput,
      deliveryText: failedMessage.content,
      idempotencyKey: "failed",
    });
    await service.markAttempted({ ...failedMessage, deliveryAttemptId: "attempt-failed-1" });
    await service.markSent({
      ...failedMessage,
      deliveryAttemptId: "attempt-failed-1",
      success: false,
      error: "rejected",
    });
    expect((await service.listAll()).find((row) => row.id === failed.id)?.attempts[0].state).toBe(
      "failed",
    );

    const unknownMessage = { ...message, content: "uncertain delivery" };
    const unknown = await service.create({
      ...createInput,
      deliveryText: unknownMessage.content,
      idempotencyKey: "unknown",
    });
    await service.markAttempted({
      ...unknownMessage,
      deliveryAttemptId: "attempt-unknown-1",
    });
    await service.markSent({
      ...unknownMessage,
      deliveryAttemptId: "attempt-unknown-1",
      success: false,
      messageId: "partial-1",
      error: "timeout",
    });
    expect(
      (await service.listAll()).find((row) => row.id === unknown.id)?.attempts[0],
    ).toMatchObject({ state: "unknown", messageId: "partial-1" });
    expect((await service.listAll()).find((row) => row.id === unknown.id)?.attempts).toHaveLength(
      1,
    );
  });

  it("acks only a trusted correlated reply or unambiguous explicit ack", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    const message = {
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "attempt-ack-1",
    };
    await service.markAttempted(message);
    await service.markSent({ ...message, success: true, messageId: "msg-ack" });
    await service.markReceived({
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      from: "stranger",
      content: "ack",
    });
    expect(
      (await service.listAll()).find((row) => row.id === record.id)?.acknowledged,
    ).toBeUndefined();
    await service.markReceived({
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      from: "founder",
      content: "I will review it.",
      replyToId: "msg-ack",
    });
    expect(
      (await service.listAll()).find((row) => row.id === record.id)?.acknowledged,
    ).toMatchObject({ kind: "reply", messageId: "msg-ack" });
  });

  it("matches inbound acknowledgments by trusted sender when destination is also present", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    const message = {
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "attempt-inbound-route",
    };
    await service.markAttempted(message);
    await service.markSent({ ...message, success: true, messageId: "msg-inbound-route" });
    await service.markReceived({
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      from: "founder",
      to: "operator-bot",
      content: "Thanks, I see it.",
      replyToId: "msg-inbound-route",
    });
    expect(
      (await service.listAll()).find((row) => row.id === record.id)?.acknowledged,
    ).toMatchObject({ kind: "reply", messageId: "msg-inbound-route" });
  });

  it("rejects acknowledgment from a different trusted route", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    await expect(
      service.acknowledgeForContext(record.id, {
        channelId: "telegram",
        accountId: "owner",
        sessionKey: "other-session",
        to: "founder",
      }),
    ).rejects.toThrow("handoff not found");
  });

  it("does not expose an unbound record to another profile", async () => {
    const { service } = setup();
    await service.create(createInput);
    await service.create({
      ...createInput,
      idempotencyKey: "profile-2",
      ownerProfileId: "profile-2",
    });
    await expect(service.listForProfile("profile-1")).resolves.toEqual([]);
    await expect(service.listForProfile("profile-2")).resolves.toHaveLength(1);
  });
  it("scopes idempotency by owner and exact intended recipient", async () => {
    const { service } = setup();
    const first = await service.create({
      ...createInput,
      ownerProfileId: "profile-1",
      idempotencyKey: "same-key",
    });
    await expect(
      service.create({
        ...createInput,
        ownerProfileId: "profile-1",
        idempotencyKey: "same-key",
        summary: "incompatible replay is rejected",
      }),
    ).rejects.toThrow("idempotency key is already bound");
    const otherProfile = await service.create({
      ...createInput,
      ownerProfileId: "profile-2",
      idempotencyKey: "same-key",
    });
    const otherRecipient = await service.create({
      ...createInput,
      ownerProfileId: "profile-1",
      recipient: { ...createInput.recipient, to: "other-founder" },
      idempotencyKey: "same-key",
    });
    const replay = await service.create({
      ...createInput,
      ownerProfileId: "profile-1",
      idempotencyKey: "same-key",
    });
    expect(replay.id).toBe(first.id);
    expect(otherProfile.id).not.toBe(first.id);
    expect(otherRecipient.id).not.toBe(first.id);
    await expect(service.listForProfile("profile-2")).resolves.toEqual([otherProfile]);
    await expect(service.listForProfile("profile-1")).resolves.toHaveLength(2);
  });

  it("fails closed for an underspecified route and ambiguous same-text handoffs", async () => {
    const { service } = setup();
    await expect(
      service.create({
        ...createInput,
        recipient: { sessionKey: "agent:main:main" },
      }),
    ).rejects.toThrow("channel and to");
    await service.create({ ...createInput, idempotencyKey: undefined });
    await service.create({ ...createInput, idempotencyKey: undefined });
    await service.markAttempted({
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "ambiguous-attempt",
    });
    expect((await service.listAll()).every((row) => row.attempts.length === 0)).toBe(true);
  });

  it("atomically deduplicates concurrent attempt callbacks", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    const event = {
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "concurrent-attempt",
    };
    await Promise.all(Array.from({ length: 16 }, () => service.markAttempted(event)));
    expect((await service.listAll()).find((row) => row.id === record.id)?.attempts).toHaveLength(1);
  });

  it("bounds reminders and honors native category and quiet-hour preferences", async () => {
    const { service } = setup();
    const record = await service.create({ ...createInput, ownerProfileId: "profile-1" });
    const native = resolveEffectiveWebPushPreferences({
      user: {
        categories: { agentFinished: true },
        quietHours: { enabled: true, startMinute: 0, endMinute: 60, timeZone: "UTC" },
      },
      device: { enabled: true },
    });
    const nativeReminderPreferences = (at: number) => ({
      enabled: webPushCategoryEnabled(native, "agent-finished"),
      inQuietHours: isWebPushQuietHours(native, at),
    });
    await expect(
      service.claimReminder(
        record.id,
        { ownerProfileId: "profile-1" },
        { enabled: false, inQuietHours: false },
        100,
      ),
    ).resolves.toBeUndefined();
    await expect(
      service.claimReminder(
        record.id,
        { ownerProfileId: "profile-1" },
        nativeReminderPreferences(Date.parse("2026-01-01T00:30:00Z")),
        Date.parse("2026-01-01T00:30:00Z"),
      ),
    ).resolves.toBeUndefined();
    expect(nativeReminderPreferences(Date.parse("2026-01-01T01:30:00Z"))).toEqual({
      enabled: true,
      inQuietHours: false,
    });
    for (const at of [100, 900_100, 1_800_100]) {
      await expect(
        service.claimReminder(
          record.id,
          { ownerProfileId: "profile-1" },
          { enabled: true, inQuietHours: false },
          at,
        ),
      ).resolves.toMatchObject({ id: record.id });
    }
    await expect(
      service.claimReminder(
        record.id,
        { ownerProfileId: "profile-1" },
        { enabled: true, inQuietHours: false },
        2_700_100,
      ),
    ).resolves.toBeUndefined();
    await expect(service.listForProfile("profile-1")).resolves.toMatchObject([
      { reminder: { maximum: 3, used: 3 } },
    ]);
    await expect(
      service.claimReminder(
        record.id,
        { ownerProfileId: "profile-2" },
        { enabled: true, inQuietHours: false },
        3_600_100,
      ),
    ).rejects.toThrow("handoff not found");
  });

  it("keeps unknown delivery unresolved and blocks an automatic retry", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    const event = {
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "unknown-restart-attempt",
    };
    await service.markAttempted(event);
    await service.markSent({ ...event, success: false, messageId: "partial-id", error: "restart" });
    await service.markAttempted({ ...event, deliveryAttemptId: "retry-after-restart" });
    expect((await service.listAll()).find((row) => row.id === record.id)).toMatchObject({
      attempts: [{ state: "unknown", messageId: "partial-id" }],
    });
    expect((await service.listAll()).find((row) => row.id === record.id)?.attempts).toHaveLength(1);
  });

  it("rejects incompatible reuse of an owner-scoped idempotency key", async () => {
    const { service } = setup();
    await service.create({ ...createInput, ownerProfileId: "profile-1", idempotencyKey: "same" });
    await expect(
      service.create({
        ...createInput,
        ownerProfileId: "profile-1",
        idempotencyKey: "same",
        deliveryText: "different text",
      }),
    ).rejects.toThrow("idempotency key is already bound");
  });

  it("uses the persisted native attempt id across transformed late sent hooks", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    const event = {
      channelId: "telegram",
      accountId: "owner",
      to: "founder",
      content: createInput.deliveryText,
      deliveryAttemptId: "native-attempt",
    };
    await service.markAttempted(event);
    await service.markSent({
      ...event,
      content: "chunk 2/2",
      success: true,
      messageId: "native-message",
    });
    expect((await service.listAll()).find((row) => row.id === record.id)?.attempts).toMatchObject([
      { state: "delivered", messageId: "native-message" },
    ]);
  });

  it("does not let an uncorrelated explicit ack resolve an undelivered item", async () => {
    const { service } = setup();
    const record = await service.create(createInput);
    await service.markReceived({
      channelId: "telegram",
      accountId: "owner",
      conversationId: "founder",
      sessionKey: "agent:main:main",
      from: "founder",
      content: "got it",
    });
    expect(
      (await service.listAll()).find((row) => row.id === record.id)?.acknowledged,
    ).toBeUndefined();
  });

  it("executes create, list, and acknowledge through the trusted plugin tools", async () => {
    const { service } = setup();
    const context = {
      authenticatedUserProfileId: "profile-1",
      sessionKey: "agent:main:main",
      deliveryContext: {
        channel: "telegram",
        accountId: "owner",
        to: "founder",
        threadId: 7,
      },
    };
    const store = {
      runOperation: async <T>(operation: () => Promise<T>) => await operation(),
    } as unknown as WorkboardStore;
    const tools = createWorkboardTools({ context, store, handoffs: service });
    const createTool = tools.find((tool) => tool.name === "workboard_handoff_create");
    const listTool = tools.find((tool) => tool.name === "workboard_handoff_list");
    const ackTool = tools.find((tool) => tool.name === "workboard_handoff_acknowledge");
    expect(createTool && listTool && ackTool).toBeTruthy();
    const created = await createTool!.execute("call-create", {
      ...createInput,
      idempotencyKey: "tool-created",
    });
    const id = (created as { details: { handoff: HandoffRecord } }).details.handoff.id;
    const listed = await listTool!.execute("call-list", {});
    expect((listed as { details: { handoffs: HandoffRecord[] } }).details.handoffs).toHaveLength(1);
    await ackTool!.execute("call-ack", { id });
    await expect(service.listForProfile("profile-1")).resolves.toMatchObject([
      { acknowledged: { kind: "gateway" } },
    ]);
  });

  it("claims due reminders through one bounded atomic loop", async () => {
    const { service } = setup();
    await service.create({ ...createInput, ownerProfileId: "profile-1" });
    await service.create({
      ...createInput,
      ownerProfileId: "profile-1",
      idempotencyKey: "second",
    });
    const claimed = await service.claimDueReminders(
      { ownerProfileId: "profile-1" },
      { enabled: true, inQuietHours: false },
      100,
    );
    expect(claimed).toHaveLength(2);
    expect(
      (await service.listForProfile("profile-1")).every((row) => row.reminder.used === 1),
    ).toBe(true);
  });
});
