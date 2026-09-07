# Macropad

Bind OpenClaw sessions to six status keys, with session colors, activity lighting,
pinned bindings, and a Control UI device page. The bundled driver supports the
Work Louder Codex Micro on macOS through Koffi and IOKit. Other platforms remain
inert; they do not have a hardware driver yet.

## Local use

Build OpenClaw with `pnpm build`. Enable the `macropad` plugin in the host's plugin
settings (and include it in `plugins.allow` if an allowlist is configured).
The **Macropad** sidebar page displays device identity, battery, and key bindings.
Plugin settings control automatic binding, brightness, colors, and repaint interval.
A successful connection requires a correlated `device.status` reply, not merely
an accepted USB write. With no matching device, the plugin stays disconnected.

Bindings persist in the host's plugin-scoped SQLite keyed store. Pinned bindings
survive least-recently-used eviction. A session waiting for approval receives
approval-colored lighting; this does **not** grant or resolve that approval.

## Current boundaries

- Physical key input is diagnostic-only. Raw action values are not interpreted,
  and a key does not navigate, interrupt, send a message, or resolve an approval.
- Compact `{m,p}` notifications and long-form replies are supported. The joystick
  payload has been captured. Physical key/encoder payloads and action meanings
  still need a labeled hardware capture; synthetic events are not hardware proof.
- Firmware acknowledgment proves the lighting command was received, not that a
  human saw the intended color. Visual LED confirmation remains a physical test.
- ChatGPT can hold a concurrent, nonexclusive connection. Both applications can
  repaint the same lighting; this plugin does not claim exclusive LED ownership.
- Hot-plug/replug, long-duration coexistence, and permission-loss recovery remain
  physical acceptance items. If the plugin starts without a matching device,
  restart its service after attaching one; it does not watch USB discovery.
- A zero input count alone does not prove a permission failure. Recheck the actual
  process's Input Monitoring grant only after a bounded, labeled input test.

## Verification

From the repository root:

```sh
node scripts/run-vitest.mjs run extensions/macropad
node scripts/run-vitest.mjs run --config test/vitest/vitest.ui.config.ts extensions/macropad/browser
node scripts/check-changed.mjs -- extensions/macropad
pnpm build
```

The normal test runner never opens real hardware. Live proof uses a separate
loopback gateway, isolated state, and explicit cleanup; do not test against an
operator's gateway or copy its credentials.

## Protocol credit

This implementation builds on public protocol research and local captures:
[freemicro](https://github.com/eliBenven/freemicro),
[cm2-probe](https://github.com/panghy/cm2-probe),
[work-louder-oai](https://github.com/boopdotpng/work-louder-oai), and
[cm2-agent-keys](https://github.com/honest-andy/cm2-agent-keys).
Work Louder and Codex Micro identify compatible hardware; this plugin is not
endorsed by Work Louder or OpenAI. No firmware or vendor artwork is redistributed.
