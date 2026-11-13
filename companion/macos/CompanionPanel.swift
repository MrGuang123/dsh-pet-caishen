import AppKit

final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    // AppKit otherwise clamps the entire 420×440 window to the visible screen,
    // including its transparent padding. CompanionDelegate clamps the actual
    // pet and control footprint before moving the panel instead.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }
}
