import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardWindowFocusBridgeTests {
    @Test func `trusted dashboard focuses its own native window and untrusted page is rejected`() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }

        let dashboardURL = server.url("/control/")
        let auth = DashboardWindowAuth.unauthenticated
        let autosaveName = "OpenClawDashboardWindow-Focus-Test-\(UUID().uuidString)"
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: autosaveName,
            requestBrowserProfileImportOffer: { _ in false })
        defer {
            controller.closeDashboard()
            NSWindow.removeFrame(usingName: autosaveName)
        }
        controller.show(url: dashboardURL, auth: auth)
        try await DashboardTestWait.document(controller, "trusted focus dashboard")

        let window = try #require(controller.window)
        if AppActivation.shared.allowsActivation, window.isVisible {
            window.miniaturize(nil)
        }
        let reply = try await controller.webView.callAsyncJavaScript("""
        return await window.webkit.messageHandlers.openclawWindowFocus.postMessage({type: 'focus-window'});
        """, in: nil, contentWorld: .page) as? [String: Any]
        let focused = try #require(reply?["focused"] as? Bool)
        if AppActivation.shared.allowsActivation {
            #expect(!window.isMiniaturized)
        } else {
            #expect(!focused)
        }
        if focused {
            #expect(window.isKeyWindow)
            #expect(NSApp.isActive)
            #expect(window.firstResponder === controller.webView)
        }

        controller.webView.load(URLRequest(url: server.url("/outside/")))
        try await TestWait.state("untrusted dashboard path") {
            !controller.webView.isLoading && controller.webView.url?.path == "/outside/"
        }
        var rejected = false
        do {
            _ = try await controller.webView.callAsyncJavaScript("""
            return await window.webkit.messageHandlers.openclawWindowFocus.postMessage({type: 'focus-window'});
            """, in: nil, contentWorld: .page)
        } catch {
            rejected = true
        }
        #expect(rejected)
    }
}
