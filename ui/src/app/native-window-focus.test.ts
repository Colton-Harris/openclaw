import { afterEach, describe, expect, it, vi } from "vitest";
import { focusControlUiWindow, openControlUiExternalLink } from "./native-window-focus.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Control UI native window focus", () => {
  it("uses the owning window's native acknowledgement", async () => {
    const postMessage = vi.fn().mockResolvedValue({ focused: true });
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowFocus: { postMessage } } });

    await expect(focusControlUiWindow(new AbortController().signal)).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "focus-window" });
  });

  it("does not assume native focus succeeded when the OS declines it", async () => {
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawWindowFocus: { postMessage: async () => ({ focused: false }) } },
    });

    await expect(focusControlUiWindow(new AbortController().signal)).resolves.toBe(false);
  });

  it("rejects acknowledgements after the activation or native connection changes", async () => {
    const pending = Promise.withResolvers<unknown>();
    const handlers = { openclawWindowFocus: { postMessage: () => pending.promise } };
    vi.stubGlobal("webkit", { messageHandlers: handlers });
    const signal = new AbortController();
    const result = focusControlUiWindow(signal.signal);
    handlers.openclawWindowFocus = { postMessage: async () => ({ focused: true }) };
    pending.resolve({ focused: true });
    await expect(result).rejects.toThrow("connection changed");

    const secondPending = Promise.withResolvers<unknown>();
    vi.stubGlobal("webkit", {
      messageHandlers: { openclawWindowFocus: { postMessage: () => secondPending.promise } },
    });
    const secondSignal = new AbortController();
    const secondResult = focusControlUiWindow(secondSignal.signal);
    secondSignal.abort();
    secondPending.resolve({ focused: true });
    await expect(secondResult).rejects.toThrow();
  });
});

describe("Control UI external links", () => {
  it("rejects unsafe schemes and URLs with embedded credentials", async () => {
    const signal = new AbortController().signal;
    await expect(openControlUiExternalLink("javascript:alert(1)", signal)).rejects.toThrow(
      "HTTP or HTTPS",
    );
    await expect(
      openControlUiExternalLink("https://user:pass@example.com/", signal),
    ).rejects.toThrow("HTTP or HTTPS");
  });

  it("routes a valid external URL through the native link handler", async () => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });

    await expect(
      openControlUiExternalLink("https://example.com/path", new AbortController().signal),
    ).resolves.toBe(true);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "open-link",
      url: "https://example.com/path",
      target: "external",
    });
  });

  it("uses a detached browser window when a native link handler is absent", async () => {
    const opened = {
      opener: window,
      location: { replace: vi.fn() },
    } as unknown as WindowProxy;
    const open = vi.spyOn(window, "open").mockReturnValue(opened);

    await expect(
      openControlUiExternalLink("https://example.com/path", new AbortController().signal),
    ).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith("about:blank", "_blank", undefined);
    expect(opened.opener).toBeNull();
    expect(opened.location.replace).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
  });
});
