import { reserveExternalWindowForDeferredNavigation } from "../lib/open-external-url.ts";
import { postNativeExternalLink } from "./native-link-routing.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

type WindowFocusHandler = {
  postMessage: (request: { type: "focus-window" }) => Promise<unknown>;
};

/** Focus this dashboard only; regular browsers retain their own focus policy. */
export async function focusControlUiWindow(signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  // SAFETY: The trusted macOS dashboard registers this reply-capable handler; the result is validated below.
  const nativeWindow = window as Window & {
    webkit?: { messageHandlers?: { openclawWindowFocus?: WindowFocusHandler } };
  };
  const handler = nativeWindow.webkit?.messageHandlers?.openclawWindowFocus;
  if (typeof handler?.postMessage !== "function") {
    window.focus();
    signal.throwIfAborted();
    return document.hasFocus();
  }
  const reply = await handler.postMessage({ type: "focus-window" });
  signal.throwIfAborted();
  if (nativeWindow.webkit?.messageHandlers?.openclawWindowFocus !== handler) {
    throw new Error("The native window connection changed. Use its current Control UI.");
  }
  return (
    typeof reply === "object" && reply !== null && "focused" in reply && reply.focused === true
  );
}

/** Open a validated HTTP(S) link through the native host or a detached browser window. */
export async function openControlUiExternalLink(
  rawUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const url = new URL(rawUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("External links require an HTTP or HTTPS URL without embedded credentials.");
  }
  const native = webKitHostWindow()?.webkit?.messageHandlers?.openclawLink;
  if (native) {
    const opened = postNativeExternalLink(url.href);
    signal.throwIfAborted();
    return opened;
  }
  const opened = reserveExternalWindowForDeferredNavigation();
  if (!opened) {
    return false;
  }
  opened.location.replace(url.href);
  signal.throwIfAborted();
  return true;
}
