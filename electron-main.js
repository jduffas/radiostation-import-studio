'use strict';

/**
 * Point d'entrée Electron — app de barre système (tray icon).
 * Lance le serveur HTTP de main.js dans le même processus.
 */

const { app, Tray, Menu, shell, nativeImage, dialog, Notification } = require('electron');
const https = require('https');
const http = require('http');
const os = require('os');
const path = require('path');
const { URL } = require('url');

// Une seule instance autorisée — prérequis pour capturer le lien de pairing dans
// 'second-instance' (Windows/Linux) au lieu d'ouvrir une 2e app qui ne saurait rien en faire.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray = null;
let contextMenu = null;

// ---- Appairage autonome (Phase 2c) : radiostation-cdripper://pair?server=…&code=… ----
// macOS : reçu via l'event 'open-url'. Windows/Linux : l'OS relance une 2e instance avec le
// lien en argv, interceptée par 'second-instance' grâce au verrou single-instance ci-dessus.
app.setAsDefaultProtocolClient('radiostation-cdripper');

function extractPairingUrl(argv) {
  return argv.find((a) => a.startsWith('radiostation-cdripper://'));
}

function httpPostJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(urlStr); } catch (e) { return reject(e); }
    const mod = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.detail || `HTTP ${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function handlePairingUrl(pairingUrl) {
  let parsed;
  try { parsed = new URL(pairingUrl); } catch { return; }
  const server = parsed.searchParams.get('server');
  const code = parsed.searchParams.get('code');
  if (!server || !code) return;

  try {
    const result = await httpPostJson(`${server}/api/importer/cd-ripper/pair/exchange`, {
      code,
      platform: process.platform,
      label: os.hostname(),
    });
    const m = require('./main.js');
    m.saveSettings({ server_url: server, device_token: result.device_token });
    if (Notification.isSupported()) {
      new Notification({
        title: 'RadioStation CD Ripper',
        body: 'Application connectée à ' + server,
      }).show();
    }
  } catch (e) {
    if (Notification.isSupported()) {
      new Notification({
        title: 'RadioStation CD Ripper — échec de connexion',
        body: e.message,
      }).show();
    }
  }
}

// Windows/Linux : lien reçu en argv d'une 2e instance bloquée par le verrou single-instance.
app.on('second-instance', (_event, argv) => {
  const pairingUrl = extractPairingUrl(argv);
  if (pairingUrl) handlePairingUrl(pairingUrl);
});

// macOS : lien reçu via l'event dédié du système (LSApplicationCategoryType URL scheme).
app.on('open-url', (event, pairingUrl) => {
  event.preventDefault();
  handlePairingUrl(pairingUrl);
});

// ---- Icône (inline SVG converti en dataURL si pas de fichier) ----
function loadIcon() {
  const iconFile = path.join(__dirname, 'tray-icon.png');
  try {
    const img = nativeImage.createFromPath(iconFile);
    if (!img.isEmpty()) {
      // Sur macOS, marquer comme template image pour s'adapter aux thèmes clair/sombre
      if (process.platform === 'darwin') img.setTemplateImage(true);
      return img;
    }
  } catch { /* ignore */ }

  // Icône de secours générée via SVG — monochrome sur macOS (template image obligatoire)
  const isMac = process.platform === 'darwin';
  const fill = isMac ? 'black' : '#0f4c75';
  const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
    <circle cx="8" cy="8" r="7" fill="${fill}"/>
    <circle cx="8" cy="8" r="2.5" fill="white"/>
    <circle cx="8" cy="8" r="1" fill="${fill}"/>
    <text x="8" y="5" text-anchor="middle" font-size="4" fill="white">♪</text>
  </svg>`;
  const img = nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svgIcon).toString('base64')
  );
  if (isMac) img.setTemplateImage(true);
  return img;
}

// ---- Démarrage du serveur HTTP ----
function startServer() {
  try {
    // main.js démarre le serveur quand il est requis en mode Electron
    process.env.ELECTRON_RUN = '1';
    require('./main.js');
  } catch (e) {
    dialog.showErrorBox(
      'Erreur démarrage serveur',
      `Impossible de démarrer le serveur CD Ripper :\n\n${e.message}`
    );
    app.quit();
  }
}

// ---- Menu barre système ----
function buildMenu(status) {
  const loginEnabled = app.getLoginItemSettings().openAtLogin;

  // Lire les paramètres depuis main.js (déjà chargé via startServer)
  let vocalEnabled = false;
  let cdRipperModule = null;
  try {
    cdRipperModule = require('./main.js');
    vocalEnabled = !!cdRipperModule.loadSettings().vocal_analysis_enabled;
  } catch { /* main.js pas encore chargé */ }

  contextMenu = Menu.buildFromTemplate([
    { label: 'RadioStation CD Ripper', enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Ouvrir RadioStation dans le navigateur',
      click: () => shell.openExternal(
        process.env.RADIOSTATION_URL || 'http://localhost:8080'
      ),
    },
    { type: 'separator' },
    {
      label: 'Analyse vocale (zones jingle)',
      type: 'checkbox',
      checked: vocalEnabled,
      toolTip: 'Détecter automatiquement les zones sans voix après chaque rip',
      click: (menuItem) => {
        try {
          const m = require('./main.js');
          m.saveSettings({ vocal_analysis_enabled: menuItem.checked });
        } catch (e) {
          dialog.showErrorBox('Erreur', `Impossible de sauvegarder les paramètres :\n${e.message}`);
        }
        // Pas de rebuild menu — la coche est mise à jour par Electron nativement
      },
    },
    { type: 'separator' },
    {
      label: 'Démarrer automatiquement au login',
      type: 'checkbox',
      checked: loginEnabled,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
        buildMenu(status);
        tray.setContextMenu(contextMenu);
      },
    },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => app.quit(),
    },
  ]);
  return contextMenu;
}

// ---- App prête ----
app.whenReady().then(() => {
  // Pas d'icône dans le Dock sur macOS (app de fond)
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  startServer();

  // Windows/Linux : 1er lancement de l'app DEPUIS le lien (pas encore d'instance tournante,
  // donc pas de 'second-instance') — le lien est déjà dans nos propres process.argv.
  const startupPairingUrl = extractPairingUrl(process.argv);
  if (startupPairingUrl) handlePairingUrl(startupPairingUrl);

  const icon = loadIcon();
  tray = new Tray(icon);
  tray.setToolTip('RadioStation CD Ripper');
  tray.setContextMenu(buildMenu('Serveur actif — port 19847'));
  // Sur macOS, le clic gauche n'ouvre pas le menu sans handler explicite.
  // On passe contextMenu explicitement — popUpContextMenu() sans arg est peu fiable.
  if (process.platform === 'darwin') {
    tray.on('click', () => tray.popUpContextMenu(contextMenu));
    tray.on('right-click', () => tray.popUpContextMenu(contextMenu));
  }

  // Notification de démarrage
  if (Notification.isSupported()) {
    new Notification({
      title: 'RadioStation CD Ripper',
      body: 'Serveur démarré — vous pouvez importer des CD depuis RadioStation.',
    }).show();
  }
});

// Ne pas quitter quand toutes les fenêtres sont fermées (app tray)
app.on('window-all-closed', () => { /* intentionnellement vide */ });
