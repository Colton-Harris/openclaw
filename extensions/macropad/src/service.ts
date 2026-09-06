/**
 * The plugin's runtime core: binder + activity tracker + compositor + device.
 *
 * Everything it touches arrives through injected seams (`createTransport`,
 * `openBindingStore`, `listSessions`, `now`), so the whole service runs in a
 * test with no device, no Gateway, and no clock.
 */
import { MACROPAD_SLOT_COUNT } from "../contract.js";
import {
  bindSession,
  EMPTY_BINDER_STATE,
  listBindings,
  unbindSlot,
  touchSession,
  type MacropadBinderState,
} from "./binder.js";
import { createMemoryBindingStore, type MacropadBindingStore } from "./binding-store.js";
import type { MacropadConfig } from "./config.js";
import type {
  MacropadDeviceStatus,
  MacropadSlot,
  MacropadSlotActivity,
  MacropadSlotList,
} from "./contract-types.js";
import { MacropadDeviceLink, type DeviceLinkLogger } from "./device-link.js";
import {
  composeBlankFrame,
  composeFrame,
  renderSlotFrame,
  type MacropadFullFrame,
  type MacropadSlotShadow,
} from "./frame-compositor.js";
import {
  applyAgentEvent,
  applySessionRow,
  capActivity,
  EMPTY_ACTIVITY_STATE,
  lookupActivity,
  sessionRowLabel,
  type AgentEventLike,
  type SessionActivityState,
  type SessionRowLike,
} from "./session-status.js";
import type { DeviceInputEvent, DeviceTransportFactory } from "./transport.js";

export type MacropadEventName = "device_changed" | "slots_changed";

export type MacropadServiceOptions = {
  config: MacropadConfig;
  createTransport: DeviceTransportFactory;
  /** Async so a SQLite-backed store can be opened lazily on service start. */
  openBindingStore?: () => MacropadBindingStore;
  /** Reads Gateway session rows. Resolving `undefined` means "unavailable, try later". */
  listSessions?: () => Promise<readonly SessionRowLike[] | undefined>;
  emitDeviceChanged: (status: MacropadDeviceStatus) => void;
  emitSlotsChanged: (slots: MacropadSlotList) => void;
  logger?: DeviceLinkLogger;
  now?: () => number;
  reconnectBaseMs?: number;
  jitter?: (delay: number) => number;
};

/**
 * Emits contract events, tolerating an emitter that is not ready yet.
 *
 * `defineFeaturePlugin`'s emitter throws until its own `${pluginId}:feature-events`
 * service has started, and service start order is not ours to control. A device
 * that connects fast would otherwise crash the plugin on its first event, so
 * failures park the newest payload per event name and the next successful emit
 * flushes it. Latest-wins is correct here because both events carry a complete
 * snapshot, not a delta.
 */
export class BufferedFeatureEmitter {
  /** Latest un-delivered send per event name, held as a fully-typed thunk. */
  private readonly pending = new Map<MacropadEventName, () => void>();

  get pendingCount(): number {
    return this.pending.size;
  }

  send(event: MacropadEventName, deliver: () => void): void {
    this.flush();
    if (!tryRun(deliver)) {
      this.pending.set(event, deliver);
    }
  }

  /** Retry buffered events. Safe to call at any time; a no-op when empty. */
  flush(): void {
    if (this.pending.size === 0) {
      return;
    }
    // Iterate a copy: successful sends delete from `pending` as we go.
    for (const [event, deliver] of Array.from(this.pending)) {
      if (!tryRun(deliver)) {
        // The emitter is still closed; leave the rest parked rather than
        // burning a throw per event on every state change.
        return;
      }
      this.pending.delete(event);
    }
  }
}

function tryRun(deliver: () => void): boolean {
  try {
    deliver();
    return true;
  } catch {
    return false;
  }
}

/** Streams worth waking for. Everything else only re-asserts `thinking`. */
export const MACROPAD_AGENT_EVENT_STREAMS = [
  "lifecycle",
  "approval",
  "thinking",
  "assistant",
  "error",
] as const;

export class MacropadService {
  private binderState: MacropadBinderState = EMPTY_BINDER_STATE;
  private activity: SessionActivityState = EMPTY_ACTIVITY_STATE;
  private store: MacropadBindingStore;
  private readonly emitter: BufferedFeatureEmitter;
  private readonly link: MacropadDeviceLink;
  private readonly now: () => number;
  private started = false;

  constructor(private readonly options: MacropadServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.store = createMemoryBindingStore();
    this.emitter = new BufferedFeatureEmitter();
    this.link = new MacropadDeviceLink({
      createTransport: options.createTransport,
      ...(options.config.deviceSerial === undefined
        ? {}
        : { deviceSerial: options.config.deviceSerial }),
      renderFrame: () => this.renderFrame(),
      renderBlankFrame: () => composeBlankFrame(this.options.config.lighting),
      onStatusChange: (status) => {
        this.emitter.send("device_changed", () => {
          this.options.emitDeviceChanged(status);
        });
      },
      onInput: (event) => {
        this.handleDeviceInput(event);
      },
      resyncIntervalMs: options.config.resyncIntervalMs,
      ...(options.reconnectBaseMs === undefined
        ? {}
        : { reconnectBaseMs: options.reconnectBaseMs }),
      ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  get deviceStatus(): MacropadDeviceStatus {
    return this.link.status;
  }

  /**
   * Restore bindings, seed activity from session rows, then open the device.
   *
   * Every step is independently failure-tolerant: a broken store or an
   * unavailable Gateway must still leave a working, if emptier, plugin.
   */
  async start(): Promise<void> {
    this.started = true;
    if (this.options.openBindingStore) {
      try {
        this.store = this.options.openBindingStore();
        this.binderState = await this.store.load();
      } catch (error) {
        this.options.logger?.warn(
          `macropad: could not restore key bindings: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.store = createMemoryBindingStore();
      }
    }
    await this.refreshSessions();
    this.emitter.flush();
    this.emitSlots();
    this.link.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    // `link.stop()` runs the transport unsubscribe, so the input subscription
    // installed on connect is torn down here rather than leaking past stop.
    await this.link.stop();
  }

  /**
   * Consume one device input event.
   *
   * Records it and stops there ON PURPOSE. Binding a press to a session action
   * is a separate change: the `v.oai.hid` key payload shape has never actually
   * been observed on this firmware - a 30-minute passive capture caught four
   * dial events and zero key events - so anything that branched on a key's
   * fields today would be branching on a guess. Logging is the honest ceiling
   * until a real press is captured, and it is what makes that capture possible.
   */
  private handleDeviceInput(event: DeviceInputEvent): void {
    if (event.type === "radial") {
      this.options.logger?.info(
        `macropad: device input v.oai.rad angle=${event.angle} distance=${event.distance}`,
      );
      return;
    }
    this.options.logger?.info(
      `macropad: device input v.oai.hid key=${event.key} action=${event.action}`,
    );
  }

  /**
   * Pull session rows to learn colours, labels, and cold-start status.
   *
   * Rows never overwrite a live agent event (see `session-status.ts`), so this
   * is safe to call repeatedly while the device is running.
   */
  async refreshSessions(): Promise<void> {
    if (!this.options.listSessions) {
      return;
    }
    let rows: readonly SessionRowLike[] | undefined;
    try {
      rows = await this.options.listSessions();
    } catch (error) {
      this.options.logger?.debug?.(
        `macropad: session refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!rows) {
      return;
    }
    let next = this.activity;
    for (const row of rows) {
      next = applySessionRow(next, row);
    }
    this.activity = next;
    this.pruneAndRepaint();
  }

  /** Handle one agent event: project activity, auto-bind, refresh LRU, repaint. */
  handleAgentEvent(event: AgentEventLike): void {
    const before = this.activity;
    this.activity = applyAgentEvent(this.activity, event);
    const sessionKey = event.sessionKey;
    if (typeof sessionKey !== "string" || sessionKey.length === 0) {
      return;
    }
    const changed = this.activity !== before;
    if (this.options.config.autoBind && changed) {
      this.autoBind(sessionKey, event.agentId);
    }
    this.binderState = touchSession(this.binderState, { sessionKey, now: this.now() });
    if (changed) {
      this.emitSlots();
      void this.link.repaint();
    }
  }

  /** Contract operation `slots.list`. Always exactly `MACROPAD_SLOT_COUNT` entries. */
  listSlots(): MacropadSlotList {
    const slots: MacropadSlot[] = [];
    for (const shadow of this.shadowSlots()) {
      const slot: MacropadSlot = {
        index: shadow.index,
        activity: shadow.activity,
        frame: renderSlotFrame(shadow, this.options.config.lighting),
        pinned: shadow.pinned,
      };
      if (shadow.sessionKey !== undefined) {
        slot.sessionKey = shadow.sessionKey;
      }
      if (shadow.agentId !== undefined) {
        slot.agentId = shadow.agentId;
      }
      if (shadow.label !== undefined) {
        slot.label = shadow.label;
      }
      slots.push(slot);
    }
    return { slots };
  }

  /** Contract operation `slots.bind`. */
  async bind(params: {
    sessionKey: string;
    agentId?: string;
    index?: number;
    pinned?: boolean;
  }): Promise<MacropadSlotList> {
    const result = bindSession(this.binderState, {
      sessionKey: params.sessionKey,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      ...(params.index === undefined ? {} : { index: params.index }),
      ...(params.pinned === undefined ? {} : { pinned: params.pinned }),
      now: this.now(),
    });
    if (!result.ok) {
      throw new Error(
        result.reason === "all-slots-pinned"
          ? "macropad: every key is pinned; unpin one or name a key index"
          : `macropad: key index must be 0-${MACROPAD_SLOT_COUNT - 1}`,
      );
    }
    this.binderState = result.state;
    await this.persist();
    this.pruneAndRepaint();
    return this.listSlots();
  }

  /** Contract operation `slots.unbind`. Idempotent. */
  async unbind(params: { index?: number; sessionKey?: string }): Promise<MacropadSlotList> {
    const { state, removed } = unbindSlot(this.binderState, params);
    this.binderState = state;
    if (removed.length > 0) {
      await this.persist();
      this.pruneAndRepaint();
    }
    return this.listSlots();
  }

  /** Contract operation `device.identify`. */
  identify(): Promise<boolean> {
    return this.link.identify();
  }

  /** Bind a session to a free or LRU key, if it does not already own one. */
  private autoBind(sessionKey: string, agentId?: string): void {
    const result = bindSession(this.binderState, {
      sessionKey,
      ...(agentId === undefined ? {} : { agentId }),
      now: this.now(),
    });
    if (!result.ok) {
      // Every key pinned. Correct outcome: the operator's pins win and this
      // session simply has no light. Not an error, and not worth a log line.
      return;
    }
    if (result.state !== this.binderState) {
      this.binderState = result.state;
      void this.persist();
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.binderState);
    } catch (error) {
      this.options.logger?.warn(
        `macropad: could not persist key bindings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The six-key shadow state: every slot, bound or not. */
  private shadowSlots(): MacropadSlotShadow[] {
    const bound = new Map(
      listBindings(this.binderState).map((binding) => [binding.index, binding]),
    );
    const slots: MacropadSlotShadow[] = [];
    for (let index = 0; index < MACROPAD_SLOT_COUNT; index++) {
      const binding = bound.get(index);
      if (!binding) {
        slots.push({ index, activity: "unbound", pinned: false });
        continue;
      }
      const entry = lookupActivity(this.activity, binding.sessionKey);
      const activity: MacropadSlotActivity = entry?.activity ?? "idle";
      const label = binding.label ?? entry?.label;
      const agentId = binding.agentId ?? entry?.agentId;
      slots.push({
        index,
        activity,
        pinned: binding.pinned,
        sessionKey: binding.sessionKey,
        ...(agentId === undefined ? {} : { agentId }),
        ...(label === undefined ? {} : { label }),
        ...(entry?.color === undefined ? {} : { sessionColor: entry.color }),
      });
    }
    return slots;
  }

  private renderFrame(): MacropadFullFrame {
    return composeFrame(this.shadowSlots(), this.options.config.lighting);
  }

  private pruneAndRepaint(): void {
    this.activity = capActivity(
      this.activity,
      new Set(listBindings(this.binderState).map((binding) => binding.sessionKey)),
    );
    this.emitSlots();
    if (this.started) {
      void this.link.repaint();
    }
  }

  private emitSlots(): void {
    const slots = this.listSlots();
    this.emitter.send("slots_changed", () => {
      this.options.emitSlotsChanged(slots);
    });
  }
}

/** Normalize an untyped `sessions.list` payload. Gateway responses are `unknown`. */
export function normalizeSessionRows(payload: unknown): readonly SessionRowLike[] | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return undefined;
  }
  const rows: SessionRowLike[] = [];
  for (const value of sessions) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.key !== "string" || row.key.length === 0) {
      continue;
    }
    const label = sessionRowLabel({
      key: row.key,
      ...(typeof row.label === "string" ? { label: row.label } : {}),
      ...(typeof row.derivedTitle === "string" ? { derivedTitle: row.derivedTitle } : {}),
      ...(typeof row.displayName === "string" ? { displayName: row.displayName } : {}),
    });
    rows.push({
      key: row.key,
      ...(typeof row.agentId === "string" ? { agentId: row.agentId } : {}),
      ...(label === undefined ? {} : { label }),
      ...(typeof row.color === "string" ? { color: row.color } : {}),
      ...(typeof row.status === "string" ? { status: row.status } : {}),
      ...(typeof row.lastRunError === "string" ? { lastRunError: row.lastRunError } : {}),
      ...(typeof row.lastActivityAt === "number" ? { lastActivityAt: row.lastActivityAt } : {}),
    });
  }
  return rows;
}
