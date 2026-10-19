import Foundation
import CoreGraphics

/// All coordinates are AppKit screen points (Y increases upwards). Never add a
/// WebView event delta to the window's already updated origin.
struct CompanionDrag {
    let id: Int
    let mouseStart: CGPoint
    let windowStart: CGPoint
    private(set) var moved = false

    mutating func origin(at cursor: CGPoint) -> CGPoint? {
        let dx = cursor.x - mouseStart.x
        let dy = cursor.y - mouseStart.y
        guard moved || hypot(dx, dy) >= 5 else { return nil }
        moved = true
        return CGPoint(x: windowStart.x + dx, y: windowStart.y + dy)
    }
}

enum CompanionGeometry {
    /// Only the visible pet/toolbar footprint constrains horizontal dragging.
    /// The transparent part of the 420px WKWebView may extend past the screen.
    static func clampedX(_ proposed: CGFloat, screen: CGRect, left: CGFloat, right: CGFloat) -> CGFloat {
        let minimum = screen.minX + 8 - left
        let maximum = screen.maxX - 8 - right
        return min(max(proposed, minimum), max(minimum, maximum))
    }
}
