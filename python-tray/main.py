#!/usr/bin/env python3
"""RadioStation CD Ripper — tray Linux (pystray + Pillow)"""

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

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
    env["ELECTRON_RUN"] = "1"

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
    _start_node_server()
    icon = pystray.Icon(BUNDLE_ID, make_icon(), APP_NAME, _build_menu())
    icon.run(setup=_on_ready)


if __name__ == "__main__":
    main()
