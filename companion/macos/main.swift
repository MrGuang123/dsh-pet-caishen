import AppKit
import Carbon
import Darwin
import Dispatch
import Foundation
import WebKit

// Keep in sync with NATIVE_PROTOCOL in lib/desktop.js.
let companionProtocol = 4

// macOS 13+; the web renderer and authenticated loopback server are owned by DSH.
struct LaunchConfiguration: Decodable {
    let launchURL: String
    let baseURL: String
    let parentPID: Int32
    var instanceId: String? = nil

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
        if let value = instanceId, value.range(of: "^[a-zA-Z0-9-]{1,64}$", options: .regularExpression) == nil { throw ConfigurationError.invalid }
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
    private let defaults: UserDefaults
    private var positionLocked = false
    private var dockEdge = false
    private var shortcutKey: String? = "A"
    private var shortcutItem: NSMenuItem!
    private var recoveryAttempts = 0
    private var rendererReady = false
    private var readyTimer: Timer?
    private var lastScreenBounds = ""
    private var globalMouseMonitor: Any?
    private var localMouseMonitor: Any?
    private var sleeping = false
    private let positionKey = "AcaiWindowPosition"

    init(configuration: LaunchConfiguration) {
        self.configuration = configuration
        defaults = configuration.instanceId.flatMap { UserDefaults(suiteName: "dev.dsh.pet.caishen." + $0) } ?? UserDefaults.standard
        // Migrate only our own legacy geometry, never DSH profile content.
        if configuration.instanceId != nil, defaults.dictionary(forKey: positionKey) == nil,
           let legacy = UserDefaults.standard.dictionary(forKey: positionKey),
           let x = legacy["x"] as? Double, let y = legacy["y"] as? Double, x.isFinite, y.isFinite {
            var geometry: [String: Double] = ["x": x, "y": y]
            if let left = legacy["contentLeft"] as? Double, let right = legacy["contentRight"] as? Double,
               left.isFinite, right.isFinite, left >= 0, right <= 420, right > left {
                geometry["contentLeft"] = left; geometry["contentRight"] = right
            }
            defaults.set(geometry, forKey: positionKey)
        }
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
        let hello: [String: Any] = ["type": "hello", "protocol": companionProtocol, "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"]
        if let data = try? JSONSerialization.data(withJSONObject: hello), let line = String(data: data, encoding: .utf8) { print(line) }
        fflush(stdout)
        show()
        webView.load(URLRequest(url: configuration.entryURL, cachePolicy: .reloadIgnoringLocalCacheData))
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in self?.updatePointerPassthrough() }
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] event in self?.updatePointerPassthrough(); return event }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(willSleep), name: NSWorkspace.willSleepNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)
        armReadyTimeout()
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
        panel.acceptsMouseMovedEvents = true
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
        statusItem.button?.toolTip = "阿财桌面宠物" + (configuration.instanceId.map { " · " + String($0.suffix(4)) } ?? "")
        let menu = NSMenu()
        visibilityItem = menu.addItem(withTitle: "收起阿财", action: #selector(toggleVisibility), keyEquivalent: "")
        visibilityItem.target = self
        let open = menu.addItem(withTitle: "打开 DeepSeek Harness", action: #selector(openDSH), keyEquivalent: "")
        open.target = self
        menu.addItem(.separator())
        let reset = menu.addItem(withTitle: "移回当前屏幕", action: #selector(resetPosition), keyEquivalent: "")
        reset.target = self
        let retry = menu.addItem(withTitle: "重新加载阿财", action: #selector(retryRenderer), keyEquivalent: "")
        retry.target = self
        shortcutItem = menu.addItem(withTitle: "快捷键正在准备", action: nil, keyEquivalent: "")
        shortcutItem.isEnabled = false
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
        reportPageVisibility()
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
        reportPageVisibility()
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
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        if let hotKeyHandler { RemoveEventHandler(hotKeyHandler); self.hotKeyHandler = nil }
        guard let key = shortcutKey else { reportShortcut("disabled"); return }
        let codes: [String: UInt32] = ["A":0,"B":11,"C":8,"D":2,"E":14,"F":3,"G":5,"H":4,"I":34,"J":38,"K":40,"L":37,"M":46,"N":45,"O":31,"P":35,"Q":12,"R":15,"S":1,"T":17,"U":32,"V":9,"W":13,"X":7,"Y":16,"Z":6]
        guard let code = codes[key] else { reportShortcut("conflict"); return }
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, _, pointer in
            guard let pointer else { return OSStatus(eventNotHandledErr) }
            let delegate = Unmanaged<CompanionDelegate>.fromOpaque(pointer).takeUnretainedValue()
            DispatchQueue.main.async { delegate.toggleVisibility() }
            return noErr
        }, 1, &eventType, context, &hotKeyHandler)
        guard installed == noErr else { reportShortcut("conflict"); return }
        let registered = RegisterEventHotKey(code, UInt32(controlKey | optionKey | cmdKey), EventHotKeyID(signature: 0x41434149, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        reportShortcut(registered == noErr ? "registered" : "conflict")
    }

    private func reportShortcut(_ state: String) {
        shortcutItem?.title = state == "registered" ? "显示 / 收起：⌃⌥⌘" + (shortcutKey ?? "") : state == "disabled" ? "快捷键已停用" : "快捷键冲突，请在设置中更换"
        print("{\"type\":\"shortcut\",\"state\":\"\(state)\"}"); fflush(stdout)
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('acai-shortcut',{detail:'\(state)'}))") { _, _ in }
    }

    @objc private func resetPosition() {
        finishDrag(cancelled: true)
        let point = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(point) }) ?? NSScreen.main
        guard let screen else { return }
        panel.setFrameOrigin(clampedOrigin(NSPoint(x: screen.visibleFrame.maxX - viewport.width - 20, y: screen.visibleFrame.minY + 16)))
        savePosition(); show()
    }
    private func reportPageVisibility() {
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('acai-visibility',{detail:\(panel.isVisible && !sleeping)}))") { _, _ in }
    }
    private func reportRenderer(_ ready: Bool) {
        rendererReady = ready
        print("{\"type\":\"renderer\",\"ready\":\(ready)}"); fflush(stdout)
    }
    private func armReadyTimeout() {
        readyTimer?.invalidate()
        readyTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in if self?.rendererReady == false { self?.recoverRenderer() } }
    }
    private func recoverRenderer() {
        reportRenderer(false); finishDrag(cancelled: true); hitZones = []; panel.ignoresMouseEvents = true
        readyTimer?.invalidate()
        guard recoveryAttempts < 2 else { return }
        recoveryAttempts += 1
        webView.load(URLRequest(url: configuration.entryURL, cachePolicy: .reloadIgnoringLocalCacheData)); armReadyTimeout()
    }
    @objc private func retryRenderer() { recoveryAttempts = 0; recoverRenderer(); show() }
    @objc private func willSleep() { sleeping = true; finishDrag(cancelled: true); reportPageVisibility() }
    @objc private func didWake() { sleeping = false; screensChanged(); reportPageVisibility() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { recoverRenderer() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { recoverRenderer() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if (error as NSError).code != NSURLErrorCancelled { recoverRenderer() } }

    private func startDragTimer() {
        mouseTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.updateDrag() }
        RunLoop.main.add(timer, forMode: .common); mouseTimer = timer
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let frameURL = message.frameInfo.request.url, configuration.accepts(frameURL),
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            readyTimer?.invalidate(); reportRenderer(true); reportPageVisibility()
            registerShortcut()
            updatePointerPassthrough()
            // A new document needs the bounds even when the window has not moved.
            lastScreenBounds = ""
            reportScreenBounds()
        case "settings":
            guard let locked = body["positionLocked"] as? Bool, let dock = body["dockEdge"] as? Bool else { return }
            positionLocked = locked; dockEdge = dock
            guard body.keys.contains("shortcutKey"), body["shortcutKey"] is String || body["shortcutKey"] is NSNull else { return }
            let nextKey = body["shortcutKey"] as? String
            guard nextKey == nil || (nextKey!.count == 1 && nextKey!.range(of: "^[A-Z]$", options: .regularExpression) != nil) else { return }
            if shortcutKey != nextKey { shortcutKey = nextKey; registerShortcut() }
            if locked { finishDrag(cancelled: true) }
        case "reset-position": resetPosition()
        case "retry-renderer": retryRenderer()
        case "drag-bounds":
            guard let left = finiteNumber(body["left"]), let right = finiteNumber(body["right"]),
                  left >= 0, right <= viewport.width, right > left else { return }
            if dragLeft == left && dragRight == right { return }
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
            guard let id = dragID(body["id"]), panel.isVisible, !positionLocked, !sleeping else { return }
            finishDrag(cancelled: true)
            drag = CompanionDrag(id: id, mouseStart: NSEvent.mouseLocation, windowStart: panel.frame.origin)
            panel.ignoresMouseEvents = false
            startDragTimer()
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
        mouseTimer?.invalidate(); mouseTimer = nil
        if dockEdge && !cancelled && gesture.moved {
            let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(panel.frame) }) ?? NSScreen.main
            if let screen {
                let mid = panel.frame.minX + (dragLeft + dragRight) / 2
                let x = mid < screen.visibleFrame.midX ? screen.visibleFrame.minX - dragLeft + 8 : screen.visibleFrame.maxX - dragRight - 8
                panel.setFrameOrigin(clampedOrigin(NSPoint(x: x, y: panel.frame.minY)))
            }
        }
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
        if drag == nil { savePosition() }
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
        let key = "\(left):\(right)"
        guard key != lastScreenBounds else { return }; lastScreenBounds = key
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
        readyTimer?.invalidate()
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
        NSWorkspace.shared.notificationCenter.removeObserver(self)
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
