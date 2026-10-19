import AppKit
import Carbon
import Darwin
import Dispatch
import Foundation
import WebKit

// Keep in sync with NATIVE_PROTOCOL in lib/desktop.js.
let companionProtocol = 3

// macOS 13+; the web renderer and authenticated loopback server are owned by DSH.
struct LaunchConfiguration: Decodable {
    let launchURL: String
    let baseURL: String
    let parentPID: Int32

    var entryURL: URL { URL(string: launchURL)! }
    var originURL: URL { URL(string: baseURL)! }

    static func trustedURL(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value),
              parts.scheme == "http", parts.host == "127.0.0.1",
              let port = parts.port, (1024...65535).contains(port),
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              let url = parts.url else { return nil }
        return url
    }

    func accepts(_ url: URL) -> Bool {
        guard let validated = Self.trustedURL(url.absoluteString) else { return false }
        return validated.scheme == originURL.scheme && validated.host == originURL.host && validated.port == originURL.port
    }

    func validated() throws -> Self {
        guard let launch = Self.trustedURL(launchURL),
              let base = Self.trustedURL(baseURL),
              (base.path.isEmpty || base.path == "/"), base.query == nil,
              launch.port == base.port, parentPID > 1, parentPID != getpid() else {
            throw ConfigurationError.invalid
        }
        return self
    }

    static func read() throws -> (Self, Bool) {
        var arguments = Array(CommandLine.arguments.dropFirst())
        let checkOnly = arguments.contains("--check-config")
        arguments.removeAll { $0 == "--check-config" }
        if arguments.isEmpty {
            // A single JSON line avoids leaking the launch token in process arguments.
            guard let line = readLine(), line.utf8.count <= 16_384,
                  let data = line.data(using: .utf8) else { throw ConfigurationError.invalid }
            let config = try JSONDecoder().decode(Self.self, from: data)
            return (try config.validated(), checkOnly)
        }
        var urlValue: String?
        var parent: Int32 = getppid()
        while !arguments.isEmpty {
            let key = arguments.removeFirst()
            guard !arguments.isEmpty else { throw ConfigurationError.invalid }
            let value = arguments.removeFirst()
            switch key {
            case "--url": urlValue = value
            case "--parent-pid":
                guard let pid = Int32(value) else { throw ConfigurationError.invalid }
                parent = pid
            default: throw ConfigurationError.invalid
            }
        }
        guard let value = urlValue, let url = trustedURL(value),
              let origin = URL(string: "/", relativeTo: url)?.absoluteURL else { throw ConfigurationError.invalid }
        return (try Self(launchURL: value, baseURL: origin.absoluteString, parentPID: parent).validated(), checkOnly)
    }

    enum ConfigurationError: Error { case invalid }
}

private struct CompanionCommand: Decodable {
    let type: String
    let name: String?
}

final class CompanionPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class CompanionDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private let configuration: LaunchConfiguration
    private let viewport = NSSize(width: 420, height: 440)
    private var panel: CompanionPanel!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var visibilityItem: NSMenuItem!
    private var hitZones: [NSRect] = []
    private var dragLeft: CGFloat = 0
    private var dragRight: CGFloat = 420
    private var drag: CompanionDrag?
    private var mouseTimer: Timer?
    private var lifecycleTimer: Timer?
    private var healthTimer: Timer?
    private var showSignal: DispatchSourceSignal?
    private var hideSignal: DispatchSourceSignal?
    private var reportedVisibility: Bool?
    private var healthInFlight = false
    private var healthFailures = 0
    private var hotKey: EventHotKeyRef?
    private var hotKeyHandler: EventHandlerRef?
    private let defaults = UserDefaults.standard
    private let positionKey = "AcaiWindowPosition"

    init(configuration: LaunchConfiguration) {
        self.configuration = configuration
        // Restore the footprint before the first clamp, otherwise a saved
        // screen-edge position would be pulled inward by transparent padding.
        if let saved = defaults.dictionary(forKey: positionKey),
           let left = saved["contentLeft"] as? Double, let right = saved["contentRight"] as? Double,
           left.isFinite, right.isFinite, left >= 0, right <= viewport.width, right > left {
            dragLeft = left
            dragRight = right
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeWindow()
        makeStatusMenu()
        registerShortcut()
        registerVisibilitySignals()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
        print("{\"type\":\"hello\",\"protocol\":\(companionProtocol)}")
        fflush(stdout)
        show()
        webView.load(URLRequest(url: configuration.entryURL, cachePolicy: .reloadIgnoringLocalCacheData))
        // Common modes keep the release guard running during AppKit tracking.
        let pointerTimer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.updateDrag()
            self?.updatePointerPassthrough()
        }
        RunLoop.main.add(pointerTimer, forMode: .common)
        mouseTimer = pointerTimer
        lifecycleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.checkParent() }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkHealth() }
        listenForCommands()
    }

    /// The host keeps stdin open after the launch config for one-shot pet commands.
    private func listenForCommands() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            while let line = readLine() {
                guard line.utf8.count <= 4096,
                      let data = line.data(using: .utf8),
                      let command = try? JSONDecoder().decode(CompanionCommand.self, from: data) else { continue }
                DispatchQueue.main.async { self?.handle(command) }
            }
        }
    }

    private func handle(_ command: CompanionCommand) {
        guard command.type == "animate", command.name == "coin" else { return }
        webView?.evaluateJavaScript("window.__ACAI_ANIMATE__ && window.__ACAI_ANIMATE__('coin')") { _, _ in }
    }

    private func makeWindow() {
        panel = CompanionPanel(contentRect: NSRect(origin: initialOrigin(), size: viewport), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "阿财"
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovable = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.ignoresMouseEvents = true
        panel.delegate = self

        let controller = WKUserContentController()
        controller.add(self, name: "acai")
        controller.addUserScript(WKUserScript(source: "window.__ACAI_NATIVE__ = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webConfiguration = WKWebViewConfiguration()
        webConfiguration.userContentController = controller
        webConfiguration.websiteDataStore = .nonPersistent()
        webConfiguration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: NSRect(origin: .zero, size: viewport), configuration: webConfiguration)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        panel.contentView = webView
        panel.setFrameOrigin(clampedOrigin(panel.frame.origin))
    }

    private func makeStatusMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "财"
        statusItem.button?.toolTip = "阿财桌面宠物"
        let menu = NSMenu()
        visibilityItem = menu.addItem(withTitle: "收起阿财", action: #selector(toggleVisibility), keyEquivalent: "")
        visibilityItem.target = self
        let open = menu.addItem(withTitle: "打开 DeepSeek Harness", action: #selector(openDSH), keyEquivalent: "")
        open.target = self
        menu.addItem(.separator())
        let shortcut = menu.addItem(withTitle: "显示 / 收起：⌃⌥⌘A", action: nil, keyEquivalent: "")
        shortcut.isEnabled = false
        menu.addItem(.separator())
        let quit = menu.addItem(withTitle: "退出阿财", action: #selector(quit), keyEquivalent: "")
        quit.target = self
        statusItem.menu = menu
    }

    @objc func toggleVisibility() {
        if panel.isVisible { hide() } else { show() }
    }

    private func show() {
        panel.setFrameOrigin(clampedOrigin(panel.frame.origin))
        panel.orderFrontRegardless()
        visibilityItem.title = "收起阿财"
        updatePointerPassthrough()
        reportVisibility()
    }

    private func registerVisibilitySignals() {
        let showSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        showSource.setEventHandler { [weak self] in self?.show() }
        showSignal = showSource
        showSource.resume()
        let hideSource = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
        hideSource.setEventHandler { [weak self] in self?.hide() }
        hideSignal = hideSource
        hideSource.resume()
    }

    private func hide() {
        finishDrag(cancelled: true)
        panel.orderOut(nil)
        visibilityItem.title = "唤回阿财"
        reportVisibility()
    }

    private func reportVisibility() {
        let visible = panel.isVisible
        guard reportedVisibility != visible else { return }
        reportedVisibility = visible
        // This stdout channel reports state only; never include launch credentials.
        print("{\"type\":\"visibility\",\"visible\":\(visible ? "true" : "false")}")
        fflush(stdout)
    }

    @objc private func openDSH() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.deepseek.dsh") else { return }
        let options = NSWorkspace.OpenConfiguration()
        options.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: options, completionHandler: nil)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func registerShortcut() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, pointer in
            guard let pointer else { return OSStatus(eventNotHandledErr) }
            let delegate = Unmanaged<CompanionDelegate>.fromOpaque(pointer).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggleVisibility() }
            return noErr
        }, 1, &eventType, context, &hotKeyHandler)
        guard installed == noErr else { return }
        let identifier = EventHotKeyID(signature: 0x41434149, id: 1)
        let modifiers = UInt32(controlKey | optionKey | cmdKey)
        let registered = RegisterEventHotKey(UInt32(kVK_ANSI_A), modifiers, identifier, GetApplicationEventTarget(), 0, &hotKey)
        if registered != noErr {
            fputs("Acai: global shortcut is unavailable; use the menu bar.\n", stderr)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let frameURL = message.frameInfo.request.url, configuration.accepts(frameURL),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            updatePointerPassthrough()
            reportScreenBounds()
        case "drag-bounds":
            guard let left = finiteNumber(body["left"]), let right = finiteNumber(body["right"]),
                  left >= 0, right <= viewport.width, right > left else { return }
            dragLeft = left
            dragRight = right
            if drag != nil { updateDrag() }
            else { panel.setFrameOrigin(clampedOrigin(panel.frame.origin)) }
            savePosition()
            reportScreenBounds()
        case "hit-zones":
            guard let zones = body["zones"] as? [[String: Any]], zones.count <= 64 else { return }
            hitZones = zones.compactMap { zone in
                guard let x = finiteNumber(zone["x"]), let y = finiteNumber(zone["y"]),
                      let width = finiteNumber(zone["width"]), let height = finiteNumber(zone["height"]),
                      width > 0, height > 0 else { return nil }
                let rect = NSRect(x: x, y: y, width: width, height: height)
                return rect.intersection(NSRect(origin: .zero, size: viewport))
            }.filter { !$0.isEmpty }
            updatePointerPassthrough()
        case "drag-start":
            guard let id = dragID(body["id"]), panel.isVisible else { return }
            finishDrag(cancelled: true)
            drag = CompanionDrag(id: id, mouseStart: NSEvent.mouseLocation, windowStart: panel.frame.origin)
            panel.ignoresMouseEvents = false
            updateDrag()
        case "drag-end":
            guard let id = dragID(body["id"]), drag?.id == id,
                  let cancelled = body["cancelled"] as? Bool else { return }
            finishDrag(cancelled: cancelled)
        case "resize":
            // Scaling is inside the fixed renderer viewport; do not resize or shift the panel.
            guard let size = finiteNumber(body["size"]), (120...240).contains(size) else { return }
        case "hide": hide()
        case "open-dsh": openDSH()
        case "quit": quit()
        default: break
        }
    }

    private func finiteNumber(_ value: Any?) -> CGFloat? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return CGFloat(number.doubleValue)
    }

    private func dragID(_ value: Any?) -> Int? {
        guard let number = finiteNumber(value), number >= 1, number <= 1_000_000_000,
              number.rounded() == number else { return nil }
        return Int(number)
    }

    private func reportDrag(_ gesture: CompanionDrag, phase: String, cancelled: Bool = false) {
        let script = "window.dispatchEvent(new CustomEvent('acai-drag',{detail:{id:\(gesture.id),phase:'\(phase)',moved:\(gesture.moved),cancelled:\(cancelled)}}))"
        webView.evaluateJavaScript(script) { _, _ in }
    }

    private func applyDragPosition() {
        guard var gesture = drag else { return }
        let wasMoving = gesture.moved
        let point = gesture.origin(at: NSEvent.mouseLocation)
        drag = gesture
        if let point {
            let origin = clampedOrigin(point)
            if origin != panel.frame.origin { panel.setFrameOrigin(origin) }
        }
        if gesture.moved && !wasMoving { reportDrag(gesture, phase: "move") }
    }

    private func updateDrag() {
        guard drag != nil else { return }
        guard panel.isVisible else { finishDrag(cancelled: true); return }
        // Release is checked natively as WebKit may lose pointer capture when
        // the transparent panel moves beneath it. No renderer event is required.
        if NSEvent.pressedMouseButtons & 1 == 0 { finishDrag(cancelled: false); return }
        applyDragPosition()
    }

    private func finishDrag(cancelled: Bool) {
        guard drag != nil else { return }
        if !cancelled { applyDragPosition() }
        guard let gesture = drag else { return }
        drag = nil
        reportDrag(gesture, phase: "end", cancelled: cancelled)
        savePosition()
        updatePointerPassthrough()
    }

    private func updatePointerPassthrough() {
        guard panel.isVisible else { return }
        // Keep an accepted mouse gesture until release, even if a moving window
        // briefly outruns the next renderer layout / hit-zone update.
        if NSEvent.pressedMouseButtons & 1 != 0 && !panel.ignoresMouseEvents { return }
        let cursor = NSEvent.mouseLocation
        let local = NSPoint(x: cursor.x - panel.frame.minX, y: panel.frame.maxY - cursor.y)
        panel.ignoresMouseEvents = !hitZones.contains { $0.contains(local) }
    }

    func windowDidMove(_ notification: Notification) {
        savePosition()
        reportScreenBounds()
    }

    private func savePosition() {
        defaults.set(["x": panel.frame.minX, "y": panel.frame.minY,
                      "contentLeft": dragLeft, "contentRight": dragRight], forKey: positionKey)
    }

    private func initialOrigin() -> NSPoint {
        if let saved = defaults.dictionary(forKey: positionKey),
           let x = saved["x"] as? Double, let y = saved["y"] as? Double, x.isFinite, y.isFinite {
            return NSPoint(x: x, y: y)
        }
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: screen.maxX - viewport.width - 24, y: screen.minY + 16)
    }

    private func clampedOrigin(_ proposed: NSPoint) -> NSPoint {
        let frame = NSRect(origin: proposed, size: viewport)
        let center = NSPoint(x: frame.minX + (dragLeft + dragRight) / 2, y: frame.midY)
        guard let bounds = NSScreen.screens.map(\.visibleFrame).min(by: { first, second in
            func squaredDistance(_ rect: NSRect) -> CGFloat {
                let dx = max(rect.minX - center.x, 0, center.x - rect.maxX)
                let dy = max(rect.minY - center.y, 0, center.y - rect.maxY)
                return dx * dx + dy * dy
            }
            return squaredDistance(first) < squaredDistance(second)
        }) else { return proposed }
        return NSPoint(x: CompanionGeometry.clampedX(proposed.x, screen: bounds, left: dragLeft, right: dragRight),
                       y: min(max(proposed.y, bounds.minY), max(bounds.minY, bounds.maxY - viewport.height)))
    }

    private func reportScreenBounds() {
        guard let panel, let webView else { return }
        let anchor = NSRect(x: panel.frame.minX + dragLeft, y: panel.frame.minY,
                            width: dragRight - dragLeft, height: viewport.height)
        guard let screen = NSScreen.screens.max(by: {
            $0.visibleFrame.intersection(anchor).width < $1.visibleFrame.intersection(anchor).width
        }) else { return }
        let left = max(0, screen.visibleFrame.minX - panel.frame.minX)
        let right = min(viewport.width, screen.visibleFrame.maxX - panel.frame.minX)
        let script = "window.dispatchEvent(new CustomEvent('acai-screen',{detail:{left:\(left),right:\(right)}}))"
        webView.evaluateJavaScript(script) { _, _ in }
    }

    @objc private func screensChanged() {
        finishDrag(cancelled: true)
        panel.setFrameOrigin(clampedOrigin(panel.frame.origin))
    }

    private func checkParent() {
        if kill(configuration.parentPID, 0) == -1 && errno == ESRCH { quit() }
    }

    private func checkHealth() {
        guard !healthInFlight else { return }
        healthInFlight = true
        let healthURL = configuration.originURL.appendingPathComponent("health")
        let request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 2)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.healthInFlight = false
                if error == nil, let response = response as? HTTPURLResponse, response.statusCode == 200 {
                    self.healthFailures = 0
                } else {
                    self.healthFailures += 1
                    if self.healthFailures >= 4 { self.quit() }
                }
            }
        }.resume()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, configuration.accepts(url), navigationAction.targetFrame?.isMainFrame != false else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(navigationAction.targetFrame == nil ? .cancel : .allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, configuration.accepts(url) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func applicationWillTerminate(_ notification: Notification) {
        mouseTimer?.invalidate()
        lifecycleTimer?.invalidate()
        healthTimer?.invalidate()
        showSignal?.cancel()
        showSignal = nil
        hideSignal?.cancel()
        hideSignal = nil
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler) }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "acai")
        NotificationCenter.default.removeObserver(self)
    }
}

// The plugin can idempotently reveal/hide the companion with SIGUSR1/SIGUSR2.
// Ignore both default terminating actions even during stdin/bootstrap setup.
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)

do {
    let (configuration, checkOnly) = try LaunchConfiguration.read()
    if checkOnly {
        print("Acai configuration is valid.")
        exit(0)
    }
    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let delegate = CompanionDelegate(configuration: configuration)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
} catch {
    // Never echo a launch URL or authentication token to logs.
    fputs("Acai: invalid startup configuration. Pass a loopback launch configuration via stdin.\n", stderr)
    exit(2)
}
