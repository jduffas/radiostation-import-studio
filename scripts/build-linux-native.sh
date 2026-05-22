#!/usr/bin/env bash
# build-linux-native.sh — Build Linux natif (Python pystray + Node.js bundlé + AppImage)
# Sortie : dist-native/RadioStation-CD-Ripper.AppImage (~200 Mo vs ~350 Mo Electron)
# Usage  : ./scripts/build-linux-native.sh [x64|arm64]
set -euo pipefail

ARCH="${1:-x64}"
NODE_ARCH=$([ "$ARCH" = "arm64" ] && echo "arm64" || echo "x64")
NODE_VERSION="22.11.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
DIST_DIR="$ROOT_DIR/dist-native"
APPDIR="$DIST_DIR/AppDir"

echo "=== Build Linux natif — $ARCH ==="
mkdir -p "$DIST_DIR"

# ── 1. Dépendances système (AppIndicator3 pour pystray GTK) ───────────────────
echo "→ Installation dépendances système..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
    libayatana-appindicator3-dev \
    gir1.2-ayatanaappindicator3-0.1 \
    python3-gi python3-gi-cairo gir1.2-gtk-3.0

# ── 2. PyInstaller — freeze l'app tray Python ─────────────────────────────────
echo "→ Installation dépendances Python..."
pip install --quiet -r "$ROOT_DIR/python-tray/requirements.txt" pyinstaller

echo "→ PyInstaller freeze (--onedir)..."
PYINSTALLER_OUT="$DIST_DIR/pyinstaller"
rm -rf "$PYINSTALLER_OUT"
pyinstaller \
    --onedir \
    --name radiostation-cd-ripper \
    --distpath "$PYINSTALLER_OUT" \
    --workpath "$DIST_DIR/pyinstaller-build" \
    --noconfirm \
    "$ROOT_DIR/python-tray/main.py"

# ── 3. Node.js bundlé ─────────────────────────────────────────────────────────
echo "→ Téléchargement Node.js $NODE_VERSION ($NODE_ARCH)..."
NODE_PKG="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.gz" -o /tmp/node.tar.gz
tar -xzf /tmp/node.tar.gz -C /tmp
NODE_BIN="/tmp/$NODE_PKG/bin/node"

# ── 4. Dépendances Node prod ───────────────────────────────────────────────────
echo "→ Installation dépendances Node production..."
(cd "$ROOT_DIR" && npm ci --omit=dev --silent)

# ── 5. AppDir ─────────────────────────────────────────────────────────────────
echo "→ Assemblage AppDir..."
rm -rf "$APPDIR"
mkdir -p "$APPDIR/app" "$APPDIR/bundle"

# App tray Python (PyInstaller --onedir)
cp -r "$PYINSTALLER_OUT/radiostation-cd-ripper/." "$APPDIR/app/"

# Bundle Node.js + code serveur
cp "$NODE_BIN"               "$APPDIR/bundle/node"
chmod +x "$APPDIR/bundle/node"
cp "$ROOT_DIR/main.js"       "$APPDIR/bundle/"
cp -r "$ROOT_DIR/node_modules" "$APPDIR/bundle/"

# ── 4b. Extraction binaires ffmpeg/ffprobe + shims minimalistes ───────────────
echo "→ Extraction binaires ffmpeg/ffprobe (linux-${NODE_ARCH})..."
MODS="$APPDIR/bundle/node_modules"
echo "  node_modules avant : $(du -sh "$MODS" | cut -f1)"

FFMPEG_BIN=$(cd "$ROOT_DIR" && node -e \
  "try{process.stdout.write(require('ffmpeg-static'))}catch(e){}" 2>/dev/null)
FFPROBE_BIN=$(cd "$ROOT_DIR" && node -e \
  "try{process.stdout.write(require('ffprobe-static').path)}catch(e){}" 2>/dev/null)

mkdir -p "$MODS/_bins"
if [ -f "$FFMPEG_BIN" ]; then
  cp "$FFMPEG_BIN"  "$MODS/_bins/ffmpeg" && chmod +x "$MODS/_bins/ffmpeg"
  echo "  ffmpeg  : $FFMPEG_BIN → _bins/ffmpeg"
else
  echo "  ATTENTION : binaire ffmpeg non trouvé"
fi
if [ -f "$FFPROBE_BIN" ]; then
  cp "$FFPROBE_BIN" "$MODS/_bins/ffprobe" && chmod +x "$MODS/_bins/ffprobe"
  echo "  ffprobe : $FFPROBE_BIN → _bins/ffprobe"
else
  echo "  ATTENTION : binaire ffprobe non trouvé"
fi

rm -rf "$MODS/@ffmpeg-static" "$MODS/@ffprobe-static"
rm -rf "$MODS/ffmpeg-static"  "$MODS/ffprobe-static"

mkdir -p "$MODS/ffmpeg-static"
cat > "$MODS/ffmpeg-static/index.js" << 'SHIM'
const path = require('path');
module.exports = path.join(__dirname, '..', '_bins', 'ffmpeg');
SHIM
printf '{"name":"ffmpeg-static","version":"5.2.0","main":"index.js"}\n' \
  > "$MODS/ffmpeg-static/package.json"

mkdir -p "$MODS/ffprobe-static"
cat > "$MODS/ffprobe-static/index.js" << 'SHIM'
const path = require('path');
module.exports = { path: path.join(__dirname, '..', '_bins', 'ffprobe') };
SHIM
printf '{"name":"ffprobe-static","version":"3.1.0","main":"index.js"}\n' \
  > "$MODS/ffprobe-static/package.json"

echo "  node_modules après  : $(du -sh "$MODS" | cut -f1)"

# Icône PNG 256×256
python3 - << PYICON
from PIL import Image, ImageDraw
img  = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.ellipse((8, 8, 248, 248),   fill=(15, 76, 117))
draw.ellipse((88, 88, 168, 168), fill=(255, 255, 255))
draw.ellipse((112, 112, 144, 144), fill=(15, 76, 117))
img.save("$APPDIR/radiostation-cd-ripper.png")
PYICON

# .desktop
cat > "$APPDIR/radiostation-cd-ripper.desktop" << 'DESKTOP'
[Desktop Entry]
Type=Application
Name=RadioStation CD Ripper
Exec=radiostation-cd-ripper
Icon=radiostation-cd-ripper
Categories=AudioVideo;Audio;
DESKTOP

# AppRun — point d'entrée de l'AppImage
# Positionne RADIOSTATION_BUNDLE_DIR pour que Python trouve node + main.js
cat > "$APPDIR/AppRun" << 'APPRUN'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE="${SELF%/*}"

# Indiquer à l'app Python où se trouvent node, main.js et node_modules
export RADIOSTATION_BUNDLE_DIR="$HERE/bundle"

exec "$HERE/app/radiostation-cd-ripper" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# ── 6. AppImage ───────────────────────────────────────────────────────────────
echo "→ Création AppImage..."
APPIMAGETOOL="/tmp/appimagetool"
if [ ! -f "$APPIMAGETOOL" ]; then
    curl -fsSL "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" \
        -o "$APPIMAGETOOL"
    chmod +x "$APPIMAGETOOL"
fi

ARCH=x86_64 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$DIST_DIR/RadioStation-CD-Ripper.AppImage"

# Nettoyage
rm -rf "$DIST_DIR/pyinstaller" "$DIST_DIR/pyinstaller-build" "$APPDIR"
rm -f /tmp/node.tar.gz "/tmp/$NODE_PKG" 2>/dev/null || true

echo ""
echo "✓ Build terminé : $DIST_DIR/RadioStation-CD-Ripper.AppImage"
du -sh "$DIST_DIR/RadioStation-CD-Ripper.AppImage"
