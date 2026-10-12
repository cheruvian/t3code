import Cocoa

func emit(_ event: String, _ id: String) {
    if let data = try? JSONSerialization.data(withJSONObject: ["event": event, "notice_id": id]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

final class FlippedView: NSView { override var isFlipped: Bool { true } }

final class ToastCard: NSView {
    let id: String
    var expires: Double
    let headline: NSTextField
    let revoke: NSButton
    var onAction: ((String, String) -> Void)?
    init(_ notice: [String: Any]) {
        id = notice["notice_id"] as! String
        expires = Date().timeIntervalSince1970 + 300
        headline = NSTextField(labelWithString: "Automatically approved")
        revoke = NSButton(title: "Revoke & stop", target: nil, action: nil)
        super.init(frame: NSRect(x: 0, y: 0, width: 410, height: 142))
        wantsLayer = true
        layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
        layer?.cornerRadius = 10
        headline.font = .boldSystemFont(ofSize: 14)
        headline.frame = NSRect(x: 14, y: 110, width: 380, height: 20)
        addSubview(headline)
        let site = NSTextField(labelWithString: "\(notice["site"] as? String ?? "Vault item") · \(notice["executable"] as? String ?? "Command")")
        site.frame = NSRect(x: 14, y: 83, width: 380, height: 20)
        site.lineBreakMode = .byTruncatingMiddle
        addSubview(site)
        let summary = NSTextField(labelWithString: "\(notice["label"] as? String ?? "Credential use") · visible for 5 minutes")
        summary.frame = NSRect(x: 14, y: 57, width: 380, height: 20)
        summary.font = .systemFont(ofSize: 11)
        summary.textColor = .secondaryLabelColor
        summary.lineBreakMode = .byTruncatingTail
        addSubview(summary)
        revoke.frame = NSRect(x: 12, y: 14, width: 190, height: 30)
        revoke.bezelStyle = .rounded
        revoke.target = self
        revoke.action = #selector(revokeClicked)
        addSubview(revoke)
        let dismiss = NSButton(title: "Dismiss", target: self, action: #selector(dismissClicked))
        dismiss.bezelStyle = .rounded
        dismiss.frame = NSRect(x: 280, y: 14, width: 118, height: 30)
        addSubview(dismiss)
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func revokeClicked() { revoke.isEnabled = false; onAction?("revoke", id) }
    @objc func dismissClicked() { onAction?("dismiss", id) }
    func markRevoked() { headline.stringValue = "Access revoked · command stopped"; revoke.isEnabled = false }
}

final class ToastHost: NSObject {
    let panel: NSPanel
    let scroll = NSScrollView()
    let document = FlippedView()
    var cards: [ToastCard] = []
    override init() {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 438, height: 168),
                        styleMask: [.titled, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.title = "Credential Broker · Automatic access"
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        scroll.documentView = document
        scroll.hasVerticalScroller = true
        scroll.autoresizingMask = [.width, .height]
        scroll.drawsBackground = false
        panel.contentView = scroll
        Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.expire() }
    }
    func accept(_ data: [String: Any]) {
        guard let command = data["command"] as? String, let id = data["notice_id"] as? String else { return }
        if command == "show", data["expires_at"] is Double, cards.allSatisfy({ $0.id != id }) {
            let card = ToastCard(data)
            card.onAction = { [weak self] action, noticeId in
                emit(action, noticeId)
                if action == "dismiss" { self?.remove(noticeId) }
            }
            cards.append(card); document.addSubview(card); layout()
            emit("shown", id)
        } else if command == "dismiss" { remove(id) }
        else if command == "update", let card = cards.first(where: { $0.id == id }) {
            if let expiry = data["expires_at"] as? Double { card.expires = expiry / 1000 }
            if data["revoked"] as? Bool == true { card.markRevoked() }
        }
    }
    func remove(_ id: String) {
        cards.first(where: { $0.id == id })?.removeFromSuperview()
        cards.removeAll(where: { $0.id == id }); layout()
    }
    func expire() {
        let now = Date().timeIntervalSince1970
        for card in cards.filter({ now >= $0.expires }) { remove(card.id) }
    }
    func layout() {
        if cards.isEmpty { panel.close(); return }
        guard let screen = NSScreen.main else { return }
        let available = screen.visibleFrame
        let height = min(CGFloat(cards.count * 152 + 16), max(168, available.height - 80))
        panel.setContentSize(NSSize(width: 438, height: height))
        scroll.frame = NSRect(x: 0, y: 0, width: 438, height: height)
        document.frame = NSRect(x: 0, y: 0, width: 420, height: CGFloat(cards.count * 152 + 16))
        for (index, card) in cards.enumerated() { card.setFrameOrigin(NSPoint(x: 8, y: CGFloat(8 + index * 152))) }
        panel.setFrameTopLeftPoint(NSPoint(x: available.maxX - 458, y: available.maxY - 20))
        panel.orderFrontRegardless()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let host = ToastHost()
DispatchQueue.global().async {
    while let line = readLine() {
        if let bytes = line.data(using: .utf8), let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] {
            DispatchQueue.main.async { host.accept(data) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
