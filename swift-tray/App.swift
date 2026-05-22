import Cocoa

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée — menu bar app sans icône Dock
// ─────────────────────────────────────────────────────────────────────────────

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

// ─────────────────────────────────────────────────────────────────────────────
// Delegate principal
// ─────────────────────────────────────────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate {

    private var statusItem: NSStatusItem!
    private var nodeProcess: Process?
    private var processStartTime: Date?

    // MARK: — Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildStatusItem()
        startNodeServer()
    }

    func applicationWillTerminate(_ notification: Notification) {
        nodeProcess?.terminate()
    }

    // MARK: — Barre de menu système

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        guard let btn = statusItem.button else { return }

        if #available(macOS 11.0, *) {
            btn.image = NSImage(systemSymbolName: "opticaldisc", accessibilityDescription: "CD Ripper")
            btn.image?.isTemplate = true
        } else {
            btn.title = "CD"
        }
        btn.toolTip = "RadioStation CD Ripper"

        let menu = NSMenu()

        let titleItem = NSMenuItem(title: "RadioStation CD Ripper", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        let serverItem = NSMenuItem(title: "Serveur actif — port 19847", action: nil, keyEquivalent: "")
        serverItem.isEnabled = false
        menu.addItem(serverItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Ouvrir RadioStation dans le navigateur",
            action: #selector(openRadioStation),
            keyEquivalent: ""
        ))
        menu.addItem(NSMenuItem(
            title: "Configurer l'adresse…",
            action: #selector(configureURL),
            keyEquivalent: ""
        ))
        menu.addItem(.separator())

        let loginItem = NSMenuItem(
            title: "Démarrer automatiquement au login",
            action: #selector(toggleLoginItem(_:)),
            keyEquivalent: ""
        )
        loginItem.state = isLoginItemEnabled() ? .on : .off
        menu.addItem(loginItem)

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Quitter",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        ))

        statusItem.menu = menu
    }

    // MARK: — Actions

    private func radioStationURL() -> String {
        UserDefaults.standard.string(forKey: "radiostation_url") ?? "http://localhost:8080"
    }

    @objc private func openRadioStation() {
        guard let url = URL(string: radioStationURL()) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func configureURL() {
        let alert = NSAlert()
        alert.messageText = "Adresse de RadioStation"
        alert.informativeText = "Adresse du serveur RadioStation (ex : http://192.168.1.10:8080)"
        alert.addButton(withTitle: "Enregistrer")
        alert.addButton(withTitle: "Annuler")

        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = radioStationURL()
        field.placeholderString = "http://192.168.1.10:8080"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let val = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !val.isEmpty else { return }
        UserDefaults.standard.set(val, forKey: "radiostation_url")
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        let enable = sender.state == .off
        setLoginItem(enabled: enable)
        sender.state = enable ? .on : .off
    }

    // MARK: — Login item (LaunchAgent plist)

    private var launchAgentURL: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("LaunchAgents/fr.radiostation.cd-ripper.plist")
    }

    private func isLoginItemEnabled() -> Bool {
        FileManager.default.fileExists(atPath: launchAgentURL.path)
    }

    private func setLoginItem(enabled: Bool) {
        if enabled {
            guard let exe = Bundle.main.executablePath else { return }
            let plist = """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>fr.radiostation.cd-ripper</string>
    <key>ProgramArguments</key>
    <array><string>\(exe)</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><false/>
</dict>
</plist>
"""
            let dir = launchAgentURL.deletingLastPathComponent()
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? plist.write(to: launchAgentURL, atomically: true, encoding: .utf8)
        } else {
            try? FileManager.default.removeItem(at: launchAgentURL)
        }
    }

    // MARK: — Serveur Node.js

    private func startNodeServer() {
        guard let nodePath = resolveNode(), let mainJs = resolveMainJs() else {
            showNodeMissingAlert()
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [mainJs]
        // cwd = Resources/ pour que require('ffmpeg-static') trouve node_modules/
        process.currentDirectoryURL = Bundle.main.resourceURL
        process.environment = ProcessInfo.processInfo.environment.merging(
            ["ELECTRON_RUN": "1"], uniquingKeysWith: { $1 }
        )

        // Log dans ~/Library/Caches/fr.radiostation.cd-ripper/server.log
        let logDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("fr.radiostation.cd-ripper")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = fh
            process.standardError  = fh
        }

        // Redémarrage auto uniquement si le process a tourné > 5s (pas un crash au démarrage)
        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            let ran = self.processStartTime.map { Date().timeIntervalSince($0) } ?? 0
            guard ran > 5 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.startNodeServer() }
        }

        do {
            processStartTime = Date()
            try process.run()
            nodeProcess = process
        } catch {
            showNodeMissingAlert()
        }
    }

    /// Cherche le binaire node : bundlé en premier, puis chemins système courants, puis PATH shell
    private func resolveNode() -> String? {
        // 1. Bundlé dans Contents/Resources/node
        if let p = Bundle.main.path(forResource: "node", ofType: nil),
           FileManager.default.isExecutableFile(atPath: p) { return p }

        // 2. Chemins standards macOS
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }

        // 3. Fallback shell (gère nvm, asdf, etc.)
        let t = Process()
        t.launchPath  = "/bin/zsh"
        t.arguments   = ["-lc", "which node 2>/dev/null"]
        let pipe = Pipe(); t.standardOutput = pipe; t.standardError = Pipe()
        guard (try? t.run()) != nil else { return nil }
        t.waitUntilExit()
        let path = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty ? nil : path
    }

    private func resolveMainJs() -> String? {
        Bundle.main.path(forResource: "main", ofType: "js")
    }

    private func showNodeMissingAlert() {
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText     = "Node.js introuvable"
            alert.informativeText = "Installez Node.js depuis nodejs.org ou via Homebrew :\nbrew install node"
            alert.alertStyle      = .critical
            alert.addButton(withTitle: "Télécharger Node.js")
            alert.addButton(withTitle: "Quitter")
            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
            } else {
                NSApp.terminate(nil)
            }
        }
    }
}
