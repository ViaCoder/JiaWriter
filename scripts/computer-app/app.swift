// The macOS test window of the computer check: pressing the button writes the field to the file named first.
import AppKit

final class Controller: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 420, height: 180), styleMask: [.titled], backing: .buffered, defer: false)
    let name = NSTextField(frame: NSRect(x: 10, y: 130, width: 380, height: 24))
    let secret = NSSecureTextField(frame: NSRect(x: 10, y: 90, width: 380, height: 24))
    let button = NSButton(title: "确定", target: nil, action: nil)

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "测试窗口"
        name.setAccessibilityLabel("姓名")
        secret.setAccessibilityLabel("口令")
        button.frame = NSRect(x: 10, y: 40, width: 100, height: 30)
        button.target = self
        button.action = #selector(done)
        for view in [name, secret, button] as [NSView] { window.contentView?.addSubview(view) }
        window.makeKeyAndOrderFront(nil)
    }

    @objc func done() {
        try? name.stringValue.write(toFile: CommandLine.arguments[1], atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let controller = Controller()
application.delegate = controller
application.run()
