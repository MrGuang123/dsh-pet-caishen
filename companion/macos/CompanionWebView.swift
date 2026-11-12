import AppKit
import WebKit

/// The pet panel is a non-activating NSPanel, so its first click often arrives
/// while the panel is not key. WKWebView's default `acceptsFirstMouse` refuses
/// that click unless the page can begin a drag or legacy scroll while inactive;
/// AppKit then spends the click on activation and the renderer never receives
/// the pointerdown that starts a drag. Accept it here so the first press can
/// pet or drag immediately without first clicking the panel into focus.
final class CompanionWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}
