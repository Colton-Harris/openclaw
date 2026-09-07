import Foundation
import Testing

/// The progress card renders outside the transcript `ScrollView`, so an unbounded
/// expanded body grows the card until the collapse control leaves the screen and the
/// only way out is force-quitting the app. These guards pin the layout invariants that
/// keep the card escapable; they are source checks because the failure is pure SwiftUI
/// layout with no observable model state.
struct ChatProgressCardSourceGuardTests {
    @Test func `expanded progress card is bounded and scrollable`() throws {
        let source = try Self.progressCardSource()

        #expect(source.contains("ScrollView(.vertical)"))
        #expect(source.contains("private static let expandedMaxHeight: CGFloat = 260"))
        #expect(source.contains(".frame(height: self.expandedHeight)"))
        #expect(source.contains("min(self.expandedContentHeight, Self.expandedMaxHeight)"))
    }

    @Test func `collapse control stays outside the scrolling body`() throws {
        let source = try Self.progressCardSource()

        let collapseToggle = try #require(source.range(of: "self.isExpanded.toggle()"))
        let scrollView = try #require(source.range(of: "ScrollView(.vertical)"))

        // The toggle must precede the ScrollView so it stays pinned to the card header
        // and cannot scroll or grow out of reach.
        #expect(collapseToggle.upperBound < scrollView.lowerBound)
    }

    @Test func `card clips content to its rounded surface`() throws {
        let source = try Self.progressCardSource()

        #expect(source.contains(".clipShape(RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))"))

        let clip = try #require(source.range(of: ".clipShape(RoundedRectangle"))
        let surface = try #require(source.range(of: ".modifier(ChatProgressCardSurface"))

        // Clipping is applied to the content before the surface draws, so wide markdown
        // tables stay inside the card instead of bleeding past its border.
        #expect(clip.upperBound < surface.lowerBound)
    }

    private static func progressCardSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()

        return try String(
            contentsOf: root.appendingPathComponent("Sources/OpenClawChatUI/ChatProgressCard.swift"),
            encoding: .utf8)
    }
}
