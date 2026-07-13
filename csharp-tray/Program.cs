using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace RadioStationCDRipper;

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée
// ─────────────────────────────────────────────────────────────────────────────

static class Program
{
    // Appairage autonome (Phase 2c) : Windows relance l'exe avec le lien
    // radiostation-cdripper://... en argument (enregistré via installer.nsi) — pas d'event
    // dédié comme macOS/open-url. Un Mutex nommé assure une seule instance ; la 2e invocation
    // transmet le lien à la 1ère via named pipe puis se termine immédiatement.
    private const string MutexName = "Global\\RadioStationCDRipperSingleInstance";
    internal const string PipeName = "RadioStationCDRipperPairingPipe";

    [STAThread]
    static void Main(string[] args)
    {
        var pairingUrl = Array.Find(args, a => a.StartsWith("radiostation-cdripper://", StringComparison.OrdinalIgnoreCase));

        using var mutex = new Mutex(initiallyOwned: true, MutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            if (pairingUrl != null) SendPairingUrlToRunningInstance(pairingUrl);
            return;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp(pairingUrl));
    }

    private static void SendPairingUrlToRunningInstance(string url)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(2000);
            using var writer = new StreamWriter(client) { AutoFlush = true };
            writer.WriteLine(url);
        }
        catch { /* instance existante injoignable — abandon silencieux */ }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Application tray
// ─────────────────────────────────────────────────────────────────────────────

class TrayApp : ApplicationContext
{
    private readonly NotifyIcon _tray;
    private Process? _nodeProcess;
    private DateTime _processStartTime;
    private ImportWindow? _importWindow;

    private const int    Port          = 19847;
    private const string AppName       = "RadioStation CD Ripper";
    private const string RegRunKey     = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RegRunValue   = "RadioStationCDRipper";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMilliseconds(600) };
    // Pas "const" : une chaîne interpolée avec un placeholder int n'est pas une constante de compilation en C#.
    private static readonly string SettingsUrl = $"http://127.0.0.1:{Port}/settings";

    public TrayApp(string? startupPairingUrl)
    {
        _tray = new NotifyIcon
        {
            Icon    = CreateIcon(),
            Visible = true,
            Text    = AppName,
        };
        _tray.DoubleClick += (_, _) => _ = OpenBrowserAsync();

        StartNodeServer();
        _tray.ContextMenuStrip = BuildMenu();
        ShowStartupNotification();

        StartPairingPipeServer();
        if (startupPairingUrl != null) _ = HandlePairingUrlAsync(startupPairingUrl);
    }

    // ── Menu ─────────────────────────────────────────────────────────────────

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add(new ToolStripMenuItem(AppName)                     { Enabled = false });
        menu.Items.Add(new ToolStripMenuItem($"Serveur actif — port {Port}") { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());

        var importItem = new ToolStripMenuItem("Importer un CD…");
        importItem.Click += (_, _) => OpenImportWindow();
        menu.Items.Add(importItem);

        var openItem = new ToolStripMenuItem("Ouvrir RadioStation dans le navigateur");
        openItem.Click += (_, _) => _ = OpenBrowserAsync();
        menu.Items.Add(openItem);

        menu.Items.Add(new ToolStripSeparator());

        var loginItem = new ToolStripMenuItem("Démarrer automatiquement au login")
            { Checked = IsLoginItemEnabled() };
        loginItem.Click += (_, _) =>
        {
            loginItem.Checked = !loginItem.Checked;
            SetLoginItem(loginItem.Checked);
        };
        menu.Items.Add(loginItem);

        menu.Items.Add(new ToolStripSeparator());

        var quitItem = new ToolStripMenuItem("Quitter");
        quitItem.Click += (_, _) => Quit();
        menu.Items.Add(quitItem);

        return menu;
    }

    // ── Icône générée dynamiquement ───────────────────────────────────────────

    private static Icon CreateIcon()
    {
        using var bmp = new Bitmap(16, 16);
        using var g   = Graphics.FromImage(bmp);
        g.FillEllipse(new SolidBrush(Color.FromArgb(15, 76, 117)), 1, 1, 14, 14);
        g.FillEllipse(Brushes.White, 5, 5, 6, 6);
        g.FillEllipse(new SolidBrush(Color.FromArgb(15, 76, 117)), 7, 7, 2, 2);
        return Icon.FromHandle(bmp.GetHicon());
    }

    // ── Serveur Node.js ───────────────────────────────────────────────────────

    private void StartNodeServer()
    {
        var nodePath = ResolveNode();
        var mainJs   = ResolveMainJs();
        if (nodePath is null || mainJs is null)
        {
            var res = MessageBox.Show(
                "Node.js introuvable.\nInstallez Node.js depuis nodejs.org ou bundlez node.exe dans le dossier de l'application.",
                AppName, MessageBoxButtons.OKCancel, MessageBoxIcon.Error);
            if (res == DialogResult.Cancel) Quit();
            return;
        }

        // Log dans %LOCALAPPDATA%\fr.radiostation.cd-ripper\server.log
        var logDir  = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "fr.radiostation.cd-ripper");
        Directory.CreateDirectory(logDir);
        var logPath = Path.Combine(logDir, "server.log");

        var psi = new ProcessStartInfo
        {
            FileName         = nodePath,
            Arguments        = $"\"{mainJs}\"",
            WorkingDirectory = Path.GetDirectoryName(mainJs)!,
            UseShellExecute  = false,
            CreateNoWindow   = true,
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
        };

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };

        // Redirection vers le fichier de log
        process.OutputDataReceived += (_, e) => { if (e.Data != null) AppendLog(logPath, e.Data); };
        process.ErrorDataReceived  += (_, e) => { if (e.Data != null) AppendLog(logPath, e.Data); };

        // Redémarrage auto si crash après > 5s
        process.Exited += (_, _) =>
        {
            var ran = DateTime.Now - _processStartTime;
            if (ran.TotalSeconds > 5)
            {
                System.Threading.Thread.Sleep(2000);
                StartNodeServer();
            }
        };

        _processStartTime = DateTime.Now;
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _nodeProcess = process;
    }

    private static void AppendLog(string path, string line)
    {
        try { File.AppendAllText(path, line + Environment.NewLine); } catch { /* ignore */ }
    }

    // ── Résolution des chemins ────────────────────────────────────────────────

    private static string? ResolveNode()
    {
        // 1. node.exe bundlé dans le même dossier que l'exe
        var exeDir   = Path.GetDirectoryName(Application.ExecutablePath)!;
        var bundled  = Path.Combine(exeDir, "node.exe");
        if (File.Exists(bundled)) return bundled;

        // 2. Chemins d'installation standards Windows
        var progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        foreach (var root in new[] { progFiles, progFilesX86 })
        {
            var p = Path.Combine(root, "nodejs", "node.exe");
            if (File.Exists(p)) return p;
        }

        // 3. PATH
        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator))
        {
            var p = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(p)) return p;
        }
        return null;
    }

    private static string? ResolveMainJs()
    {
        var exeDir = Path.GetDirectoryName(Application.ExecutablePath)!;
        var p = Path.Combine(exeDir, "main.js");
        return File.Exists(p) ? p : null;
    }

    // ── Login item (registre Windows) ─────────────────────────────────────────

    private static bool IsLoginItemEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RegRunKey);
        return key?.GetValue(RegRunValue) != null;
    }

    private static void SetLoginItem(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RegRunKey, writable: true)
                        ?? Registry.CurrentUser.CreateSubKey(RegRunKey);
        if (enabled)
            key.SetValue(RegRunValue, Application.ExecutablePath);
        else
            key.DeleteValue(RegRunValue, throwOnMissingValue: false);
    }

    // ── Réglages du serveur local (/settings) ─────────────────────────────────

    /// `server_url` vient de l'appairage (stocké dans settings.json par ce même endpoint,
    /// cf. HandlePairingUrlAsync) — plus de saisie manuelle d'adresse côté tray.
    private static async Task OpenBrowserAsync()
    {
        string? serverUrl = null;
        try
        {
            var json = await Http.GetStringAsync(SettingsUrl);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("server_url", out var v) && v.ValueKind == JsonValueKind.String)
                serverUrl = v.GetString();
        }
        catch { /* serveur local injoignable — traité comme non appairé */ }

        if (string.IsNullOrEmpty(serverUrl))
        {
            MessageBox.Show("L'application n'est pas encore appairée à RadioStation.", AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        Process.Start(new ProcessStartInfo(serverUrl) { UseShellExecute = true });
    }

    // ── Appairage autonome (Phase 2c) ─────────────────────────────────────────

    private void StartPairingPipeServer()
    {
        _ = Task.Run(async () =>
        {
            while (true)
            {
                try
                {
                    using var server = new NamedPipeServerStream(Program.PipeName, PipeDirection.In);
                    await server.WaitForConnectionAsync();
                    using var reader = new StreamReader(server);
                    var url = await reader.ReadLineAsync();
                    if (!string.IsNullOrEmpty(url)) await HandlePairingUrlAsync(url);
                }
                catch { /* pipe cassé/instance en cours de fermeture — on relance la boucle */ }
            }
        });
    }

    private async Task HandlePairingUrlAsync(string pairingUrl)
    {
        Uri uri;
        try { uri = new Uri(pairingUrl); } catch { return; }
        // System.Web.HttpUtility n'est pas disponible hors ASP.NET/.NET Framework — parsing
        // manuel de la query string (pas de dépendance NuGet supplémentaire pour si peu).
        var query = ParseQueryString(uri.Query);
        query.TryGetValue("server", out var server);
        query.TryGetValue("code", out var code);
        if (string.IsNullOrEmpty(server) || string.IsNullOrEmpty(code)) return;

        try
        {
            var body = JsonSerializer.Serialize(new { code, platform = "win32", label = Environment.MachineName });
            using var content = new StringContent(body, Encoding.UTF8, "application/json");
            using var resp = await Http.PostAsync($"{server}/api/importer/cd-ripper/pair/exchange", content);
            if (!resp.IsSuccessStatusCode) throw new Exception($"HTTP {(int)resp.StatusCode}");
            var json = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(json);
            var deviceToken = doc.RootElement.GetProperty("device_token").GetString();

            // Le serveur node tourne en process séparé — seul son propre endpoint /settings
            // peut écrire settings.json (pas d'accès direct comme un require() in-process).
            var storeBody = JsonSerializer.Serialize(new { server_url = server, device_token = deviceToken });
            using var storeContent = new StringContent(storeBody, Encoding.UTF8, "application/json");
            await Http.PostAsync(SettingsUrl, storeContent);

            NotifyPairingResult(true);
        }
        catch
        {
            NotifyPairingResult(false);
        }
    }

    private static System.Collections.Generic.Dictionary<string, string> ParseQueryString(string query)
    {
        var result = new System.Collections.Generic.Dictionary<string, string>();
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (parts.Length == 2) result[Uri.UnescapeDataString(parts[0])] = Uri.UnescapeDataString(parts[1]);
        }
        return result;
    }

    private void NotifyPairingResult(bool success)
    {
        _tray.BalloonTipTitle = AppName;
        _tray.BalloonTipText = success
            ? "Application connectée à RadioStation."
            : "Échec de la connexion — réessayez depuis la page web.";
        _tray.BalloonTipIcon = success ? ToolTipIcon.Info : ToolTipIcon.Error;
        _tray.ShowBalloonTip(4000);
    }

    private void ShowStartupNotification()
    {
        _tray.BalloonTipTitle = AppName;
        _tray.BalloonTipText  = "Serveur démarré — vous pouvez importer des CD depuis RadioStation.";
        _tray.BalloonTipIcon  = ToolTipIcon.Info;
        _tray.ShowBalloonTip(4000);
    }

    // ── Fenêtre d'import CD (webview intégrée, interface locale) ──────────────

    // Page servie directement par main.js (127.0.0.1:19847, cf. local-ui/) — aucune dépendance
    // réseau au site RadioStation pour l'interface elle-même : détection CD, rip, coupe et cue
    // points tournent entièrement en local, seul l'envoi final (proxié par main.js avec le
    // jeton d'appareil déjà appairé) touche le réseau. Remplace l'ancien pointage direct vers
    // {server_url}/admin/import/cd (site distant complet, cf. historique du plan Phase 2b).
    private const string LocalImportUrl = "http://127.0.0.1:19847/";

    private void OpenImportWindow()
    {
        if (_importWindow is { IsDisposed: false })
        {
            _importWindow.Activate();
            return;
        }
        _importWindow = new ImportWindow(LocalImportUrl);
        _importWindow.FormClosed += (_, _) => _importWindow = null;
        _importWindow.Show();
        _importWindow.Activate();
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    private void Quit()
    {
        try { _nodeProcess?.Kill(); } catch { /* ignore */ }
        try { _importWindow?.Close(); } catch { /* ignore */ }
        _tray.Visible = false;
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            try { _nodeProcess?.Kill(); } catch { /* ignore */ }
            try { _importWindow?.Dispose(); } catch { /* ignore */ }
            _tray.Dispose();
        }
        base.Dispose(disposing);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fenêtre d'import CD — webview WebView2 pointée sur /admin/import/cd (Phase 2b)
// ─────────────────────────────────────────────────────────────────────────────

class ImportWindow : Form
{
    public ImportWindow(string url)
    {
        Text = "RadioStation — Import CD";
        Width = 1100;
        Height = 800;
        StartPosition = FormStartPosition.CenterScreen;

        var webView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(webView);

        Load += async (_, _) =>
        {
            try
            {
                await webView.EnsureCoreWebView2Async(null);
                webView.CoreWebView2.Navigate(url);
            }
            catch (Exception e)
            {
                MessageBox.Show(
                    "Impossible d'initialiser WebView2 (runtime absent ?) :\n" + e.Message,
                    "RadioStation CD Ripper", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        };
    }
}
