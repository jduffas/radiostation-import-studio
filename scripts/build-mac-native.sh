#!/usr/bin/env bash
# build-mac-native.sh — Construit l'app macOS native (Swift tray + Node.js bundlé)
# Usage : ./scripts/build-mac-native.sh [arm64|x64]
# Sortie : dist-native/RadioStation-CD-Ripper.dmg  (~150 Mo vs ~500 Mo avec Electron)
set -euo pipefail

ARCH="${1:-arm64}"
NODE_ARCH=$([ "$ARCH" = "arm64" ] && echo "arm64" || echo "x64")
SWIFT_TARGET=$([ "$ARCH" = "arm64" ] && echo "arm64-apple-macos12.0" || echo "x86_64-apple-macos12.0")

NODE_VERSION="22.11.0"
APP_NAME="RadioStation CD Ripper"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
DIST_DIR="$ROOT_DIR/dist-native"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"

echo "=== Build macOS natif — $ARCH ==="

# ── Nettoyage ──────────────────────────────────────────────────────────────────
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# ── 1. Compilation Swift ───────────────────────────────────────────────────────
echo "→ Compilation Swift ($SWIFT_TARGET)..."
swiftc \
  -O \
  -target "$SWIFT_TARGET" \
  "$ROOT_DIR/swift-tray/App.swift" \
  -o "$APP_BUNDLE/Contents/MacOS/RadioStationCDRipper" \
  -framework Cocoa \
  -framework WebKit

# ── 2. Icône de l'app (.icns depuis icon.png, 512×512 source) ──────────────────
echo "→ Génération de l'icône .icns..."
ICONSET="$DIST_DIR/AppIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ROOT_DIR/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$ICONSET" -o "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

# ── 3. Info.plist ──────────────────────────────────────────────────────────────
# Version lue depuis package.json (source de vérité unique, cf. version dans le menu tray/
# main.js APP_VERSION) — était codée en dur à 1.0.0 ici, jamais mise à jour depuis.
APP_VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
cat > "$APP_BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>fr.radiostation.cd-ripper</string>
    <key>CFBundleName</key>
    <string>RadioStation CD Ripper</string>
    <key>CFBundleVersion</key>
    <string>$APP_VERSION</string>
    <key>CFBundleShortVersionString</key>
    <string>$APP_VERSION</string>
    <key>CFBundleExecutable</key>
    <string>RadioStationCDRipper</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHumanReadableCopyright</key>
    <string>RadioStation</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>fr.radiostation.cd-ripper.pairing</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>radiostation-cdripper</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

# ── 4. Node.js bundlé ──────────────────────────────────────────────────────────
echo "→ Téléchargement Node.js $NODE_VERSION ($NODE_ARCH)..."
NODE_PKG="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.gz" -o /tmp/node.tar.gz
tar -xzf /tmp/node.tar.gz -C /tmp
cp "/tmp/$NODE_PKG/bin/node" "$APP_BUNDLE/Contents/Resources/node"
chmod +x "$APP_BUNDLE/Contents/Resources/node"
rm -rf "/tmp/$NODE_PKG" /tmp/node.tar.gz

# ── 5. main.js + dépendances prod ─────────────────────────────────────────────
echo "→ Installation dépendances production..."
cp "$ROOT_DIR/main.js" "$APP_BUNDLE/Contents/Resources/"
cp "$ROOT_DIR/package.json" "$APP_BUNDLE/Contents/Resources/"
cp -r "$ROOT_DIR/local-ui" "$APP_BUNDLE/Contents/Resources/"
(cd "$ROOT_DIR" && npm ci --omit=dev --silent)
cp -r "$ROOT_DIR/node_modules" "$APP_BUNDLE/Contents/Resources/"

# ── 5b. Extraction binaires ffmpeg/ffprobe + shims minimalistes ───────────────
echo "→ Extraction binaires ffmpeg/ffprobe (darwin-${NODE_ARCH})..."
MODS="$APP_BUNDLE/Contents/Resources/node_modules"
echo "  node_modules avant : $(du -sh "$MODS" | cut -f1)"

# Trouver les vrais binaires via node (depuis ROOT_DIR où npm ci vient de tourner)
FFMPEG_BIN=$(cd "$ROOT_DIR" && node -e \
  "try{process.stdout.write(require('ffmpeg-static'))}catch(e){}" 2>/dev/null)
FFPROBE_BIN=$(cd "$ROOT_DIR" && node -e \
  "try{process.stdout.write(require('ffprobe-static').path)}catch(e){}" 2>/dev/null)

# ffprobe-static@3.x ne fournit que x64 sur darwin — forcer arm64 si disponible
if [ "$ARCH" = "arm64" ]; then
  ARM64_FFPROBE="$ROOT_DIR/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe"
  [ -f "$ARM64_FFPROBE" ] && FFPROBE_BIN="$ARM64_FFPROBE"
fi

# Copier les binaires dans _bins/
mkdir -p "$MODS/_bins"
if [ -f "$FFMPEG_BIN" ]; then
  cp "$FFMPEG_BIN"  "$MODS/_bins/ffmpeg" && chmod +x "$MODS/_bins/ffmpeg"
  echo "  ffmpeg  : $FFMPEG_BIN → _bins/ffmpeg"
else
  echo "  ATTENTION : binaire ffmpeg non trouvé (ffmpeg système sera utilisé)"
fi
if [ -f "$FFPROBE_BIN" ]; then
  cp "$FFPROBE_BIN" "$MODS/_bins/ffprobe" && chmod +x "$MODS/_bins/ffprobe"
  echo "  ffprobe : $FFPROBE_BIN → _bins/ffprobe"
else
  echo "  ATTENTION : binaire ffprobe non trouvé (ffprobe système sera utilisé)"
fi

# Supprimer les packages ffmpeg/ffprobe (avec tous leurs gros binaires multiplateforme)
rm -rf "$MODS/@ffmpeg-static" "$MODS/@ffprobe-static"
rm -rf "$MODS/ffmpeg-static"  "$MODS/ffprobe-static"

# Shim ffmpeg-static — retourne le chemin du binaire bundlé
mkdir -p "$MODS/ffmpeg-static"
cat > "$MODS/ffmpeg-static/index.js" << 'SHIM'
const path = require('path');
module.exports = path.join(__dirname, '..', '_bins', 'ffmpeg');
SHIM
printf '{"name":"ffmpeg-static","version":"5.2.0","main":"index.js"}\n' \
  > "$MODS/ffmpeg-static/package.json"

# Shim ffprobe-static — retourne { path: ... }
mkdir -p "$MODS/ffprobe-static"
cat > "$MODS/ffprobe-static/index.js" << 'SHIM'
const path = require('path');
module.exports = { path: path.join(__dirname, '..', '_bins', 'ffprobe') };
SHIM
printf '{"name":"ffprobe-static","version":"3.1.0","main":"index.js"}\n' \
  > "$MODS/ffprobe-static/package.json"

echo "  node_modules après  : $(du -sh "$MODS" | cut -f1)"

# ── 6. Signature ───────────────────────────────────────────────────────────────
if [ "${APPLE_CERT_AVAILABLE:-false}" = "true" ]; then
  echo "→ Signature codesign..."
  # Trouver l'identité Developer ID Application dans la liste de recherche par défaut —
  # PAS un keychain nommé "build.keychain" (n'existe pas : release.yml importe le certificat
  # dans un keychain temporaire ($RUNNER_TEMP/app-signing.keychain-db) qu'il ajoute à la
  # search list via `security list-keychain -d user -s`, sans le nommer "build.keychain").
  # Fonctionne aussi en local : recherche alors le login keychain normal de l'utilisateur.
  SIGNING_IDENTITY=$(security find-identity -v -p codesigning \
    | grep "Developer ID Application" | head -1 | awk '{print $2}')
  if [ -z "$SIGNING_IDENTITY" ]; then
    echo "ERREUR : aucun certificat 'Developer ID Application' trouvé dans la search list"
    security find-identity -v -p codesigning
    exit 1
  fi
  echo "  Identité : $SIGNING_IDENTITY"
  CSFLAGS="--force --options runtime --timestamp --sign $SIGNING_IDENTITY"
  # ffmpeg et ffprobe : binaires tiers, --deep ne les atteint pas (trop profond dans node_modules)
  for BIN in "$MODS/_bins/ffmpeg" "$MODS/_bins/ffprobe"; do
    [ -f "$BIN" ] && codesign $CSFLAGS "$BIN" && echo "  signé : $BIN"
  done
  # node : entitlement allow-jit requis pour le moteur V8
  codesign $CSFLAGS \
    --entitlements "$ROOT_DIR/entitlements.mac.plist" \
    "$APP_BUNDLE/Contents/Resources/node"
  # App bundle (--deep pour les éventuels autres binaires natifs dans node_modules)
  codesign --deep $CSFLAGS \
    --entitlements "$ROOT_DIR/entitlements.mac.plist" \
    "$APP_BUNDLE"
else
  echo "→ Signature ignorée (APPLE_CERT_AVAILABLE != true)"
fi

# ── 7. DMG — mise en page "glisser vers Applications" ───────────────────────────
# dmgbuild (Python) plutôt que Finder/AppleScript : 2 échecs CI réels avec la recette classique
# hdiutil RW + osascript (-1728 "Can't get disk" puis -2700 "introuvable" malgré attente et sans
# -nobrowse) — le runner GitHub Actions macOS n'a manifestement pas de session Finder pilotable
# de façon fiable pour cet usage. dmgbuild manipule le DS_Store et le fond directement via
# hdiutil/SetFile, sans jamais passer par une automatisation Finder — cf. lecture de son code
# source (aucune référence à Finder/osascript, contrairement à des outils comme create-dmg).
echo "→ Création du DMG..."
DMG_PATH="$DIST_DIR/RadioStation-CD-Ripper.dmg"
# venv dédié plutôt que --user : évite toute question de politique "externally-managed-
# environment" (PEP 668) du Python système du runner, sans dépendre d'un flag pip particulier.
DMGBUILD_VENV="$DIST_DIR/.dmgbuild-venv"
python3 -m venv "$DMGBUILD_VENV"
"$DMGBUILD_VENV/bin/pip" install --quiet dmgbuild
"$DMGBUILD_VENV/bin/python3" -m dmgbuild \
  -s "$SCRIPT_DIR/dmg-settings.py" \
  -D app="$APP_BUNDLE" \
  -D app_name="$APP_NAME" \
  -D background="$ROOT_DIR/resources/dmg-background.png" \
  "$APP_NAME" \
  "$DMG_PATH"

# ── 8. Notarisation (remplace le hook afterSign d'electron-builder + @electron/notarize) ───────
# Ignorée si les identifiants Apple ne sont pas fournis (build local sans compte développeur) ou
# si l'app n'a pas été signée avec un vrai Developer ID (APPLE_CERT_AVAILABLE != true ci-dessus).
if [ "${APPLE_CERT_AVAILABLE:-false}" = "true" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  echo "→ Notarisation (xcrun notarytool)..."
  xcrun notarytool submit "$DMG_PATH" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_SPECIFIC_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait
  echo "→ Stapling du ticket de notarisation..."
  xcrun stapler staple "$DMG_PATH"
else
  echo "→ Notarisation ignorée (identifiants Apple absents)"
fi

echo ""
echo "✓ Build terminé : $DMG_PATH"
echo ""
du -sh "$APP_BUNDLE" "$DMG_PATH"
