import Cocoa
import UserNotifications
import WebKit

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

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {

    private var statusItem: NSStatusItem!
    private var nodeProcess: Process?
    private var processStartTime: Date?
    private var importWindow: NSWindow?
    private var importWebView: WKWebView?

    // MARK: — Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Le serveur démarre avant le menu pour que la lecture de /settings (case
        // "Analyse vocale") ait une petite longueur d'avance — reste best-effort,
        // le spawn du process ne garantit pas que le serveur HTTP écoute déjà.
        startNodeServer()
        buildStatusItem()
        sendStartupNotification()

        // Appairage autonome (Phase 2c) : radiostation-cdripper://pair?server=…&code=…
        // reçu comme Apple Event standard (kAEGetURL) — mécanisme historique AppKit pour les
        // schémas d'URL personnalisés, fonctionne que l'app soit déjà lancée ou non.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
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
            title: "Importer un CD…",
            action: #selector(openImportWindow),
            keyEquivalent: ""
        ))
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

        let vocalItem = NSMenuItem(
            title: "Analyse vocale (zones jingle)",
            action: #selector(toggleVocalAnalysis(_:)),
            keyEquivalent: ""
        )
        vocalItem.toolTip = "Détecter automatiquement les zones sans voix après chaque rip"
        vocalItem.state = fetchVocalAnalysisEnabled() ? .on : .off
        menu.addItem(vocalItem)

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

    // MARK: — Fenêtre d'import CD (webview intégrée, interface locale)

    // Page servie directement par main.js (127.0.0.1:19847, cf. local-ui/) — aucune dépendance
    // réseau au site RadioStation pour l'interface elle-même : détection CD, rip, coupe et cue
    // points tournent entièrement en local, seul l'envoi final (proxié par main.js avec le
    // jeton d'appareil déjà appairé) touche le réseau. Remplace l'ancien pointage direct vers
    // {server_url}/admin/import/cd (site distant complet, cf. historique du plan Phase 2b).
    private static let localImportURL = URL(string: "http://127.0.0.1:19847/")!

    @objc private func openImportWindow() {
        if let window = importWindow {
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            return
        }
        createAndShowImportWindow()
    }

    private func createAndShowImportWindow() {
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered, defer: false
        )
        window.title = "RadioStation — Import CD"
        window.contentView = webView
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self

        webView.load(URLRequest(url: Self.localImportURL))

        importWindow = window
        importWebView = webView
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard (notification.object as? NSWindow) === importWindow else { return }
        importWindow = nil
        importWebView = nil
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        let enable = sender.state == .off
        setLoginItem(enabled: enable)
        sender.state = enable ? .on : .off
    }

    // MARK: — Réglages du serveur local (/settings)

    private static let settingsURL = URL(string: "http://127.0.0.1:19847/settings")!

    /// Lecture synchrone de `vocal_analysis_enabled` — best-effort, quelques tentatives
    /// courtes car appelée juste après le lancement du process node (course possible).
    private func fetchVocalAnalysisEnabled() -> Bool {
        for attempt in 0..<3 {
            if attempt > 0 { Thread.sleep(forTimeInterval: 0.2) }
            let semaphore = DispatchSemaphore(value: 0)
            var result: Bool?
            var request = URLRequest(url: Self.settingsURL)
            request.timeoutInterval = 0.5
            URLSession.shared.dataTask(with: request) { data, _, _ in
                if let data,
                   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    result = (json["vocal_analysis_enabled"] as? Bool) ?? false
                }
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 0.6)
            if let result { return result }
        }
        return false
    }

    @objc private func toggleVocalAnalysis(_ sender: NSMenuItem) {
        let enable = sender.state == .off
        sender.state = enable ? .on : .off // optimiste — Electron ne rebuild pas non plus le menu

        var request = URLRequest(url: Self.settingsURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["vocal_analysis_enabled": enable])

        URLSession.shared.dataTask(with: request) { _, response, error in
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            if !ok {
                DispatchQueue.main.async {
                    sender.state = enable ? .off : .on // revert
                    let alert = NSAlert()
                    alert.messageText = "Erreur"
                    alert.informativeText = "Impossible de sauvegarder les paramètres."
                    alert.runModal()
                }
            }
        }.resume()
    }

    // MARK: — Notification de démarrage

    private func sendStartupNotification() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "RadioStation CD Ripper"
            content.body  = "Serveur démarré — vous pouvez importer des CD depuis RadioStation."
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request)
        }
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

    // MARK: — Appairage autonome (Phase 2c)

    @objc private func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        guard let urlString = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URL(string: urlString) else { return }
        handlePairingURL(url)
    }

    private func handlePairingURL(_ url: URL) {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let server = comps.queryItems?.first(where: { $0.name == "server" })?.value,
              let code = comps.queryItems?.first(where: { $0.name == "code" })?.value,
              let exchangeURL = URL(string: "\(server)/api/importer/cd-ripper/pair/exchange") else { return }

        var request = URLRequest(url: exchangeURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["code": code, "platform": "darwin", "label": Host.current().localizedName ?? "Mac"]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            guard error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                  let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let deviceToken = json["device_token"] as? String else {
                DispatchQueue.main.async { self.notifyPairingResult(success: false) }
                return
            }
            // Le serveur node tourne en process séparé (spawné, pas require() direct comme
            // Electron) — seul son propre endpoint /settings peut écrire settings.json.
            self.storeDeviceToken(server: server, token: deviceToken) { ok in
                DispatchQueue.main.async { self.notifyPairingResult(success: ok) }
            }
        }.resume()
    }

    private func storeDeviceToken(server: String, token: String, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: Self.settingsURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["server_url": server, "device_token": token])
        URLSession.shared.dataTask(with: request) { _, response, error in
            completion(error == nil && (response as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    private func notifyPairingResult(success: Bool) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = "RadioStation CD Ripper"
        content.body = success
            ? "Application connectée à RadioStation."
            : "Échec de la connexion — réessayez depuis la page web."
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
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
