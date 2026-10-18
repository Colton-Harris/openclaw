import Foundation
import WebKit

/// A current trusted dashboard may focus its own window, never another app or document.
@MainActor
final class DashboardWindowFocusMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "openclawWindowFocus"
    weak var owner: DashboardWindowController?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard let owner else {
            replyHandler(nil, "The dashboard window is no longer available.")
            return
        }
        owner.receiveWindowFocusMessage(message, replyHandler: replyHandler)
    }
}
