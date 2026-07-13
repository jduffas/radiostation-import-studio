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
    private var updateMenuItem: NSMenuItem?
    private var updatePollTimer: Timer?

    // MARK: — Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        startNodeServer()
        buildStatusItem()
        sendStartupNotification()

        // "Mettre à jour…" démarre grisé (état par défaut sûr tant qu'on n'a pas de réponse) —
        // rafraîchi tout de suite puis toutes les 5 min (lecture du cache de main.js, pas un
        // nouvel appel GitHub à chaque fois, cf. /update-check sans force).
        refreshUpdateAvailability()
        updatePollTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refreshUpdateAvailability()
        }

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
        updatePollTimer?.invalidate()
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
        // Sans ça, AppKit réactive automatiquement tout item ayant une action valide trouvée
        // sur la chaîne de répondeurs (autoenablesItems = true par défaut) — écrase le
        // isEnabled = false manuel de updateItem ci-dessous dès qu'AppKit revalide le menu.
        menu.autoenablesItems = false

        let titleItem = NSMenuItem(title: "RadioStation CD Ripper", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        let serverItem = NSMenuItem(title: "Serveur actif — port 19847", action: nil, keyEquivalent: "")
        serverItem.isEnabled = false
        menu.addItem(serverItem)

        let versionItem = NSMenuItem(title: "Version \(fetchAppVersion())", action: nil, keyEquivalent: "")
        versionItem.isEnabled = false
        menu.addItem(versionItem)

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
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(
            title: "Vérifier la mise à jour",
            action: #selector(checkForUpdate),
            keyEquivalent: ""
        ))
        let updateItem = NSMenuItem(
            title: "Mettre à jour…",
            action: #selector(triggerUpdate),
            keyEquivalent: ""
        )
        updateItem.isEnabled = false // grisé tant qu'on ne sait pas qu'une MAJ existe
        menu.addItem(updateItem)
        updateMenuItem = updateItem
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

    // `server_url` vient de l'appairage (stocké dans settings.json par ce même endpoint, cf.
    // storeDeviceToken) — plus de saisie manuelle d'adresse côté tray.
    private func fetchPairedServerURL(completion: @escaping (URL?) -> Void) {
        var request = URLRequest(url: Self.settingsURL)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, _, _ in
            var serverURL: URL?
            if let data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let s = json["server_url"] as? String {
                serverURL = URL(string: s)
            }
            completion(serverURL)
        }.resume()
    }

    @objc private func openRadioStation() {
        fetchPairedServerURL { url in
            DispatchQueue.main.async {
                guard let url else {
                    let alert = NSAlert()
                    alert.messageText = "Application non appairée"
                    alert.informativeText = "Connectez d'abord cette application à RadioStation depuis le site."
                    alert.runModal()
                    return
                }
                NSWorkspace.shared.open(url)
            }
        }
    }

    // MARK: — Vérification de mise à jour (GET /update-check, cf. main.js)

    private static let statusURL = URL(string: "http://127.0.0.1:19847/status")!
    private static let updateCheckURL = URL(string: "http://127.0.0.1:19847/update-check")!

    private struct UpdateCheckResult {
        let currentVersion: String
        let latestVersion: String?
        let updateAvailable: Bool
    }

    /// Lecture synchrone de la version installée — best-effort, même pattern que les autres
    /// lectures au tout premier affichage du menu (le serveur node vient de démarrer, course
    /// possible), cf. ancien fetchVocalAnalysisEnabled (retiré, logique migrée vers local-ui).
    private func fetchAppVersion() -> String {
        for attempt in 0..<3 {
            if attempt > 0 { Thread.sleep(forTimeInterval: 0.2) }
            let semaphore = DispatchSemaphore(value: 0)
            var result: String?
            var request = URLRequest(url: Self.statusURL)
            request.timeoutInterval = 0.5
            URLSession.shared.dataTask(with: request) { data, _, _ in
                if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    result = json["version"] as? String
                }
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 0.6)
            if let result { return result }
        }
        return "?"
    }

    private func fetchUpdateCheck(force: Bool, completion: @escaping (UpdateCheckResult?) -> Void) {
        var comps = URLComponents(url: Self.updateCheckURL, resolvingAgainstBaseURL: false)!
        if force { comps.queryItems = [URLQueryItem(name: "force", value: "true")] }
        var request = URLRequest(url: comps.url!)
        request.timeoutInterval = 8.0
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                completion(nil)
                return
            }
            completion(UpdateCheckResult(
                currentVersion: json["current_version"] as? String ?? "?",
                latestVersion: json["latest_version"] as? String,
                updateAvailable: json["update_available"] as? Bool ?? false
            ))
        }.resume()
    }

    /// Rafraîchit l'état grisé/actif de "Mettre à jour…" — appelé au démarrage puis toutes les
    /// 5 min (cf. applicationDidFinishLaunching). Non forcé : lit le cache de main.js, ne
    /// déclenche pas de nouvel appel GitHub à chaque poll.
    private func refreshUpdateAvailability() {
        fetchUpdateCheck(force: false) { [weak self] result in
            DispatchQueue.main.async {
                self?.updateMenuItem?.isEnabled = result?.updateAvailable ?? false
            }
        }
    }

    @objc private func checkForUpdate() {
        fetchUpdateCheck(force: true) { [weak self] result in
            DispatchQueue.main.async {
                self?.updateMenuItem?.isEnabled = result?.updateAvailable ?? false
                let alert = NSAlert()
                if let result, result.updateAvailable, let latest = result.latestVersion {
                    alert.messageText = "Mise à jour disponible"
                    alert.informativeText = "Version \(latest) disponible (actuelle : \(result.currentVersion))."
                } else if let result {
                    alert.messageText = "À jour"
                    alert.informativeText = "Vous utilisez déjà la dernière version (\(result.currentVersion))."
                } else {
                    alert.messageText = "Vérification impossible"
                    alert.informativeText = "Impossible de contacter GitHub pour vérifier les mises à jour."
                }
                alert.runModal()
            }
        }
    }

    @objc private func triggerUpdate() {
        fetchUpdateCheck(force: true) { [weak self] result in
            guard let self else { return }
            DispatchQueue.main.async {
                self.updateMenuItem?.isEnabled = result?.updateAvailable ?? false
                guard let result, result.updateAvailable else {
                    let alert = NSAlert()
                    alert.messageText = "À jour"
                    alert.informativeText = "Vous utilisez déjà la dernière version."
                    alert.runModal()
                    return
                }
                self.openUpdatePage()
            }
        }
    }

    // Priorité à la page d'import CD du RadioStation appairé (marque reconnue par l'utilisateur,
    // affiche déjà le même bandeau de MAJ automatiquement) — fallback GitHub Releases si
    // l'application n'est pas encore appairée.
    private func openUpdatePage() {
        fetchPairedServerURL { serverURL in
            DispatchQueue.main.async {
                let target = serverURL?.appendingPathComponent("admin/import/cd")
                    ?? URL(string: "https://github.com/jduffas/radiostation-cd-ripper/releases/latest")!
                NSWorkspace.shared.open(target)
            }
        }
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
