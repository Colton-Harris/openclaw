/**
 * Macropad backend entrypoint.
 *
 * Binds live agent sessions to six physical keys and renders their status as
 * lighting. Read-only: this plugin lights a key when a session is waiting on an
 * approval, but resolving that approval from a keypress is deliberately not
 * here - it touches the permission system and belongs in its own reviewable
 * change.
 *
 * With no device attached the plugin is completely inert: it registers, answers
 * its operations with an empty six-slot list, and logs nothing.
 */
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { macropadContract } from "./contract.js";
import { createKeyedBindingStore } from "./src/binding-store.js";
import { resolveMacropadConfig } from "./src/config.js";
import type { MacropadDeviceStatus, MacropadSlotList } from "./src/contract-types.js";
import { createCodexMicroTransport } from "./src/devices/codex-micro/index.js";
import {
  MACROPAD_AGENT_EVENT_STREAMS,
  MacropadService,
  normalizeSessionRows,
} from "./src/service.js";
import type { DeviceTransport } from "./src/transport.js";

/**
 * Opens the platform transport.
 *
 * Exactly one driver exists today: the Codex Micro over koffi -> IOKit, which
 * is macOS-only by construction. `createCodexMicroTransport` returns
 * `undefined` off macOS, when koffi cannot reach IOKit, and when no matching
 * device is attached - so every other install takes the inert branch, which is
 * the correct behaviour for a bundled plugin on a machine with no macropad.
 *
 * A second device would slot in as another `devices/<name>/` module returning
 * the same `DeviceTransport`, selected here. Nothing above this line changes.
 */
function createDeviceTransport(params: { deviceSerial?: string }): DeviceTransport | undefined {
  return createCodexMicroTransport(params);
}

const DISCONNECTED: MacropadDeviceStatus = {
  connected: false,
  slotCount: 0,
  inputPermissionRequired: false,
};

const EMPTY_SLOTS: MacropadSlotList = { slots: [] };

export default defineFeaturePlugin({
  contract: macropadContract,
  name: "Macropad",
  description: "Bind OpenClaw sessions to the keys of a USB macropad, with live status lighting.",
  setup(api: OpenClawPluginApi, events) {
    let service: MacropadService | undefined;
    let generation = 0;

    if (api.registrationMode === "full") {
      api.agent.events.registerAgentEventSubscription({
        id: "macropad-session-status",
        description: "Project agent activity onto macropad key lighting.",
        streams: [...MACROPAD_AGENT_EVENT_STREAMS],
        handle(event) {
          service?.handleAgentEvent(event);
        },
      });

      api.registerService({
        id: "macropad-device",
        reload: { configPrefixes: ["plugins.entries.macropad.config"] },
        start(context: OpenClawPluginServiceContext) {
          const activeGeneration = ++generation;
          const previous = service;
          service = undefined;
          const config = resolveMacropadConfig(api.pluginConfig);
          const start = async () => {
            await previous?.stop();
            if (activeGeneration !== generation || !config.enabled) {
              return;
            }
            const next = new MacropadService({
              config,
              createTransport: createDeviceTransport,
              openBindingStore: () => createKeyedBindingStore(api.runtime.state.openKeyedStore),
              listSessions: async () => {
                if (!(await api.runtime.gateway.isAvailable())) {
                  return undefined;
                }
                return normalizeSessionRows(
                  await api.runtime.gateway.request(
                    "sessions.list",
                    { configuredAgentsOnly: true, includeUnknown: false },
                    { scopes: ["operator.read"] },
                  ),
                );
              },
              emitDeviceChanged: (status) => {
                events.emit("device_changed", status);
              },
              emitSlotsChanged: (slots) => {
                events.emit("slots_changed", slots);
              },
              logger: context.logger,
            });
            if (activeGeneration !== generation) {
              return;
            }
            service = next;
            await next.start();
          };
          void start().catch((error: unknown) => {
            if (activeGeneration === generation) {
              context.serviceHealth?.reportFailure(error);
            }
          });
        },
        async stop() {
          generation++;
          const active = service;
          service = undefined;
          await active?.stop();
        },
      });
    }

    return {
      "device.get": () => service?.deviceStatus ?? DISCONNECTED,
      "slots.list": () => service?.listSlots() ?? EMPTY_SLOTS,
      "slots.bind": async (input) => {
        if (!service) {
          throw new Error("macropad: the device service is not running");
        }
        return await service.bind(input);
      },
      "slots.unbind": async (input) => {
        if (!service) {
          throw new Error("macropad: the device service is not running");
        }
        return await service.unbind(input);
      },
      "device.identify": async () => ({ ok: (await service?.identify()) ?? false }),
    };
  },
});
