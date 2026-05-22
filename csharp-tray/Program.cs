using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace RadioStationCDRipper;

// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée
// ─────────────────────────────────────────────────────────────────────────────

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayApp());
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

    private const int    Port          = 19847;
    private const string AppName       = "RadioStation CD Ripper";
    private const string RegRunKey     = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RegRunValue   = "RadioStationCDRipper";

    public TrayApp()
    {
        _tray = new NotifyIcon
        {
            Icon    = CreateIcon(),
            Visible = true,
            Text    = AppName,
        };
        _tray.DoubleClick += (_, _) => OpenBrowser();
        _tray.ContextMenuStrip = BuildMenu();

        StartNodeServer();
    }

    // ── Menu ─────────────────────────────────────────────────────────────────

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();

        menu.Items.Add(new ToolStripMenuItem(AppName)                     { Enabled = false });
        menu.Items.Add(new ToolStripMenuItem($"Serveur actif — port {Port}") { Enabled = false });
        menu.Items.Add(new ToolStripSeparator());

        var openItem = new ToolStripMenuItem("Ouvrir RadioStation dans le navigateur");
        openItem.Click += (_, _) => OpenBrowser();
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
        psi.Environment["ELECTRON_RUN"] = "1";

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

    // ── Actions ───────────────────────────────────────────────────────────────

    private static void OpenBrowser()
    {
        var url = Environment.GetEnvironmentVariable("RADIOSTATION_URL") ?? "http://localhost:8080";
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    private void Quit()
    {
        try { _nodeProcess?.Kill(); } catch { /* ignore */ }
        _tray.Visible = false;
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            try { _nodeProcess?.Kill(); } catch { /* ignore */ }
            _tray.Dispose();
        }
        base.Dispose(disposing);
    }
}
