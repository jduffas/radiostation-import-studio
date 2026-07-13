#!/usr/bin/env python3
"""RadioStation CD Ripper — tray Linux (pystray + Pillow)"""

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

# Sans ce réglage, WebKit2GTK produit un rendu visuellement corrompu (bandes/artefacts de
# compositing) sur ce matériel (Raspberry Pi, GPU VC4/Mesa) — bug reproduit et corrigé
# réellement le 13 juillet 2026. Doit être positionné AVANT toute initialisation de WebKit2.
os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# Chemins — fonctionne en mode normal ET en mode PyInstaller frozen
# La variable RADIOSTATION_BUNDLE_DIR (positionée par AppRun) indique la
# racine du bundle AppImage où se trouvent node, main.js et node_modules.
# ─────────────────────────────────────────────────────────────────────────────

APP_NAME     = "RadioStation CD Ripper"
PORT         = 19847
BUNDLE_ID    = "fr.radiostation.cd-ripper"
SETTINGS_URL = f"http://127.0.0.1:{PORT}/settings"

_frozen = getattr(sys, "frozen", False)
_here   = Path(sys.executable if _frozen else __file__).resolve().parent

# Dossier bundle : env var (AppImage) > même dossier que l'exe (développement)
BUNDLE_DIR = Path(os.environ.get("RADIOSTATION_BUNDLE_DIR", str(_here)))

# ─────────────────────────────────────────────────────────────────────────────
# Icône — cercle bleu RadioStation généré en mémoire
# ─────────────────────────────────────────────────────────────────────────────

def make_icon() -> Image.Image:
    img  = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((2, 2, 62, 62),   fill=(15, 76, 117))
    draw.ellipse((22, 22, 42, 42), fill=(255, 255, 255))
    draw.ellipse((28, 28, 36, 36), fill=(15, 76, 117))
    return img

# ─────────────────────────────────────────────────────────────────────────────
# Serveur Node.js
# ─────────────────────────────────────────────────────────────────────────────

_node_proc: "subprocess.Popen | None" = None
_proc_start: float = 0.0


def _resolve_node() -> "str | None":
    # 1. node bundlé dans le bundle AppImage
    bundled = BUNDLE_DIR / "node"
    if bundled.is_file() and os.access(bundled, os.X_OK):
        return str(bundled)
    # 2. Chemins système courants
    for p in ("/usr/local/bin/node", "/usr/bin/node"):
        if os.access(p, os.X_OK):
            return p
    # 3. PATH
    return shutil.which("node")


def _resolve_main_js() -> "str | None":
    p = BUNDLE_DIR / "main.js"
    return str(p) if p.is_file() else None


def _start_node_server():
    global _node_proc, _proc_start

    node    = _resolve_node()
    main_js = _resolve_main_js()
    if not node or not main_js:
        return  # Node introuvable — le serveur ne démarrera pas

    env = os.environ.copy()

    # Log dans ~/.cache/fr.radiostation.cd-ripper/server.log
    log_dir = Path.home() / ".cache" / BUNDLE_ID
    log_dir.mkdir(parents=True, exist_ok=True)
    log_fh = open(log_dir / "server.log", "a")

    _proc_start = time.monotonic()
    _node_proc  = subprocess.Popen(
        [node, main_js],
        cwd=str(BUNDLE_DIR),   # node_modules est dans BUNDLE_DIR
        env=env,
        stdout=log_fh,
        stderr=log_fh,
    )

    # Surveillance — redémarrage auto si crash après > 5s
    def _watch():
        _node_proc.wait()
        if time.monotonic() - _proc_start > 5:
            time.sleep(2)
            _start_node_server()

    threading.Thread(target=_watch, daemon=True).start()

# ─────────────────────────────────────────────────────────────────────────────
# Login item — autostart XDG (~/.config/autostart/)
# ─────────────────────────────────────────────────────────────────────────────

def _autostart_path() -> Path:
    return Path.home() / ".config" / "autostart" / f"{BUNDLE_ID}.desktop"


def _is_login_enabled() -> bool:
    return _autostart_path().is_file()


def _set_login_item(enabled: bool):
    path = _autostart_path()
    if enabled:
        exe = str(Path(sys.executable).resolve())
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f"[Desktop Entry]\n"
            f"Type=Application\n"
            f"Name={APP_NAME}\n"
            f"Exec={exe}\n"
            f"Hidden=false\n"
            f"NoDisplay=false\n"
            f"X-GNOME-Autostart-enabled=true\n"
        )
    else:
        path.unlink(missing_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
# Réglages du serveur local (/settings) — pas de course au démarrage à gérer
# ici : contrairement aux trays Swift/C#, pystray réévalue `checked` à chaque
# ouverture du menu (pas une seule fois à la construction), donc un serveur pas
# encore prêt au tout premier affichage se corrige de lui-même à l'ouverture
# suivante, sans logique de retry.
# ─────────────────────────────────────────────────────────────────────────────

def _fetch_vocal_analysis_enabled() -> bool:
    try:
        with urllib.request.urlopen(SETTINGS_URL, timeout=1) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("vocal_analysis_enabled"))
    except (urllib.error.URLError, OSError, ValueError):
        return False

# ─────────────────────────────────────────────────────────────────────────────
# Fenêtre d'import CD — webview WebKit2GTK intégrée sur l'interface locale (servie par ce
# process lui-même, cf. local-ui/) — aucune dépendance réseau au site RadioStation pour
# l'interface elle-même : détection CD, rip, coupe et cue points tournent entièrement en
# local, seul l'envoi final (proxié par ce process avec le jeton d'appareil déjà appairé)
# touche le réseau. Remplace l'ancien pointage direct vers {server_url}/admin/import/cd
# (site distant complet, cf. historique du plan Phase 2b).
# ─────────────────────────────────────────────────────────────────────────────

_import_window = None  # référence module-level : évite le garbage-collect de la fenêtre GTK
_LOCAL_IMPORT_URL = f"http://127.0.0.1:{PORT}/"


def _open_import_window(icon, item):
    global _import_window
    if _import_window is not None:
        _import_window.present()
        return

    window = Gtk.Window(title="RadioStation — Import CD")
    window.set_default_size(1100, 800)

    webview = WebKit2.WebView()
    webview.load_uri(_LOCAL_IMPORT_URL)
    window.add(webview)

    def _on_destroy(_widget):
        global _import_window
        _import_window = None

    window.connect("destroy", _on_destroy)
    window.show_all()
    window.present()
    _import_window = window

# ─────────────────────────────────────────────────────────────────────────────
# Appairage autonome (Phase 2c) — radiostation-cdripper://pair?server=…&code=…
#
# Linux n'a pas d'équivalent OS natif à second-instance (Windows)/open-url (macOS) : le
# gestionnaire de MimeType x-scheme-handler relance un nouveau process avec le lien en argv à
# chaque clic. Single-instance + relais du lien vers le process déjà lancé implémentés ici via
# un socket Unix (le lock/écoute échoue si une instance tourne déjà -> on relaie et on quitte).
# ─────────────────────────────────────────────────────────────────────────────

_PAIRING_SOCKET_PATH = Path.home() / ".cache" / BUNDLE_ID / "pairing.sock"


def _extract_pairing_url(argv) -> "str | None":
    for arg in argv:
        if arg.startswith("radiostation-cdripper://"):
            return arg
    return None


def _handle_pairing_url(url: str, icon=None):
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    server = (qs.get("server") or [None])[0]
    code = (qs.get("code") or [None])[0]
    if not server or not code:
        return

    def _notify(success: bool):
        if icon is None:
            return
        try:
            icon.notify(
                "Application connectée à RadioStation." if success
                else "Échec de la connexion — réessayez depuis la page web.",
                APP_NAME,
            )
        except Exception:
            pass

    try:
        body = json.dumps({"code": code, "platform": "linux", "label": socket.gethostname()}).encode("utf-8")
        req = urllib.request.Request(
            f"{server}/api/importer/cd-ripper/pair/exchange", data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            device_token = json.loads(resp.read().decode("utf-8"))["device_token"]

        # Le serveur node tourne en process séparé — seul son propre endpoint /settings peut
        # écrire settings.json (pas d'accès direct comme un import Python in-process).
        store_body = json.dumps({"server_url": server, "device_token": device_token}).encode("utf-8")
        store_req = urllib.request.Request(
            SETTINGS_URL, data=store_body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(store_req, timeout=2)
        _notify(True)
    except (urllib.error.URLError, OSError, KeyError, ValueError):
        _notify(False)


def _try_claim_pairing_socket() -> "socket.socket | None":
    """Tente de devenir la 1ère instance (bind du socket Unix). `None` si une instance tourne
    déjà (bind refusé) — l'appelant doit alors relayer le lien via `_relay_pairing_url_to_running_instance`
    et quitter sans démarrer le serveur node ni le tray."""
    _PAIRING_SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)

    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        srv.bind(str(_PAIRING_SOCKET_PATH))
    except OSError:
        # Le socket existe déjà : soit une instance l'occupe (bind légitimement refusé), soit
        # c'est un fichier orphelin d'un crash précédent — on vérifie en tentant une connexion.
        try:
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            probe.settimeout(0.5)
            probe.connect(str(_PAIRING_SOCKET_PATH))
            probe.close()
            srv.close()
            return None  # une instance répond bien — on n'est pas la 1ère
        except OSError:
            pass  # personne ne répond — fichier orphelin, on le remplace et on re-tente
        try:
            _PAIRING_SOCKET_PATH.unlink()
            srv.bind(str(_PAIRING_SOCKET_PATH))
        except OSError:
            srv.close()
            return None

    srv.listen(4)
    return srv


def _serve_pairing_socket(srv: "socket.socket", icon):
    def _accept_loop():
        while True:
            try:
                conn, _ = srv.accept()
                with conn:
                    data = conn.recv(4096).decode("utf-8", errors="ignore").strip()
                if data:
                    _handle_pairing_url(data, icon)
            except OSError:
                break

    threading.Thread(target=_accept_loop, daemon=True).start()


def _relay_pairing_url_to_running_instance(url: str):
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(2)
        client.connect(str(_PAIRING_SOCKET_PATH))
        client.sendall(url.encode("utf-8"))
        client.close()
    except OSError:
        pass  # instance existante injoignable — abandon silencieux

# ─────────────────────────────────────────────────────────────────────────────
# Menu et tray
# ─────────────────────────────────────────────────────────────────────────────

def _open_browser(icon, item):
    url = os.environ.get("RADIOSTATION_URL", "http://localhost:8080")
    subprocess.Popen(["xdg-open", url])


def _toggle_login(icon, item):
    _set_login_item(not _is_login_enabled())
    icon.menu = _build_menu()


def _toggle_vocal_analysis(icon, item):
    enable = not _fetch_vocal_analysis_enabled()
    body = json.dumps({"vocal_analysis_enabled": enable}).encode("utf-8")
    req = urllib.request.Request(
        SETTINGS_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        urllib.request.urlopen(req, timeout=1)
    except (urllib.error.URLError, OSError):
        try:
            icon.notify("Impossible de sauvegarder les paramètres.", APP_NAME)
        except Exception:
            pass  # notify() dépend du backend desktop, pas garanti partout


def _quit_app(icon, item):
    if _node_proc:
        _node_proc.terminate()
    icon.stop()


def _build_menu():
    return pystray.Menu(
        pystray.MenuItem(APP_NAME,                             None, enabled=False),
        pystray.MenuItem(f"Serveur actif — port {PORT}",      None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Importer un CD…", _open_import_window),
        pystray.MenuItem("Ouvrir RadioStation dans le navigateur", _open_browser),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Analyse vocale (zones jingle)",
            _toggle_vocal_analysis,
            checked=lambda item: _fetch_vocal_analysis_enabled(),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "Démarrer automatiquement au login",
            _toggle_login,
            checked=lambda item: _is_login_enabled(),
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quitter", _quit_app),
    )

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def _on_ready(icon):
    icon.visible = True
    try:
        icon.notify(
            "Serveur démarré — vous pouvez importer des CD depuis RadioStation.",
            APP_NAME,
        )
    except Exception:
        pass  # notify() dépend du backend desktop (libnotify), pas garanti partout


def main():
    pairing_url = _extract_pairing_url(sys.argv[1:])

    # Single-instance AVANT tout le reste (serveur node, tray) — si une instance tourne déjà,
    # on relaie juste le lien reçu (le cas échéant) et on quitte sans rien démarrer d'autre.
    pairing_socket = _try_claim_pairing_socket()
    if pairing_socket is None:
        if pairing_url:
            _relay_pairing_url_to_running_instance(pairing_url)
        return

    _start_node_server()
    icon = pystray.Icon(BUNDLE_ID, make_icon(), APP_NAME, _build_menu())

    def _on_ready_with_pairing(icon):
        _on_ready(icon)
        _serve_pairing_socket(pairing_socket, icon)
        if pairing_url:
            threading.Thread(target=_handle_pairing_url, args=(pairing_url, icon), daemon=True).start()

    icon.run(setup=_on_ready_with_pairing)


if __name__ == "__main__":
    main()
