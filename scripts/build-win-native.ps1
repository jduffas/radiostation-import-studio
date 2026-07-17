# build-win-native.ps1 — Build Windows natif (C# NotifyIcon + Node.js bundlé)
# Sortie : dist-native\RadioStation-Import-Studio-Setup.exe (~150 Mo vs ~300 Mo Electron)
# Usage  : .\scripts\build-win-native.ps1
param()
$ErrorActionPreference = "Stop"

$NodeVersion = "22.11.0"
$ScriptDir   = $PSScriptRoot
$RootDir     = Split-Path $ScriptDir -Parent
$DistDir     = Join-Path $RootDir "dist-native"
$WinDir      = Join-Path $DistDir "win"

Write-Host "=== Build Windows natif ==="

# ── Nettoyage ─────────────────────────────────────────────────────────────────
Remove-Item -Recurse -Force $WinDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $WinDir | Out-Null
New-Item -ItemType Directory -Path $DistDir -ErrorAction SilentlyContinue | Out-Null

# ── 1. Compilation C# ─────────────────────────────────────────────────────────
Write-Host "→ Compilation C# .NET 8..."
$CsprojPath = Join-Path $RootDir "csharp-tray\RadioStationImportStudio.csproj"
dotnet publish $CsprojPath `
    -c Release `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -o $WinDir `
    --nologo -v quiet

# ── 2. Node.js bundlé ─────────────────────────────────────────────────────────
Write-Host "→ Téléchargement Node.js $NodeVersion (win-x64)..."
$NodeZip = Join-Path $env:TEMP "node-win.zip"
$NodePkg  = "node-v$NodeVersion-win-x64"
$NodeUrl  = "https://nodejs.org/dist/v$NodeVersion/$NodePkg.zip"
Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing
Expand-Archive -Path $NodeZip -DestinationPath $env:TEMP -Force
Copy-Item (Join-Path $env:TEMP "$NodePkg\node.exe") -Destination $WinDir
Remove-Item $NodeZip, (Join-Path $env:TEMP $NodePkg) -Recurse -Force -ErrorAction SilentlyContinue

# ── 3. main.js + dépendances prod ─────────────────────────────────────────────
Write-Host "→ Installation dépendances Node production..."
Copy-Item (Join-Path $RootDir "main.js") -Destination $WinDir
Copy-Item (Join-Path $RootDir "vocal-precise.js") -Destination $WinDir
Copy-Item (Join-Path $RootDir "package.json") -Destination $WinDir
Copy-Item (Join-Path $RootDir "local-ui") -Destination $WinDir -Recurse
Copy-Item (Join-Path $RootDir "models") -Destination $WinDir -Recurse
Push-Location $RootDir
npm ci --omit=dev --silent 2>&1 | Out-Null
Pop-Location
Copy-Item (Join-Path $RootDir "node_modules") -Destination $WinDir -Recurse

# onnxruntime-node (analyse vocale précise) embarque les binaires de TOUTES les
# plateformes (~260 Mo) : ne garder que win32/x64.
$OrtBin = Join-Path $WinDir "node_modules\onnxruntime-node\bin\napi-v6"
if (Test-Path $OrtBin) {
    Get-ChildItem $OrtBin -Directory | Where-Object { $_.Name -ne "win32" } | Remove-Item -Recurse -Force
    Get-ChildItem (Join-Path $OrtBin "win32") -Directory | Where-Object { $_.Name -ne "x64" } | Remove-Item -Recurse -Force
    Write-Host "  onnxruntime élagué (win32/x64)"
}

# ── 3b. Extraction binaires ffmpeg/ffprobe + shims minimalistes ───────────────
Write-Host "→ Extraction binaires ffmpeg/ffprobe (win32-x64)..."
$Mods = Join-Path $WinDir "node_modules"

$FfmpegBin  = & node -e "try{process.stdout.write(require('ffmpeg-static'))}catch(e){}" 2>$null
$FfprobeBin = & node -e "try{process.stdout.write(require('ffprobe-static').path)}catch(e){}" 2>$null

New-Item -ItemType Directory -Path "$Mods\_bins" -Force | Out-Null
if ($FfmpegBin -and (Test-Path $FfmpegBin)) {
    Copy-Item $FfmpegBin -Destination "$Mods\_bins\ffmpeg.exe"
    Write-Host "  ffmpeg  : $FfmpegBin -> _bins\ffmpeg.exe"
} else { Write-Host "  ATTENTION : binaire ffmpeg non trouvé" }
if ($FfprobeBin -and (Test-Path $FfprobeBin)) {
    Copy-Item $FfprobeBin -Destination "$Mods\_bins\ffprobe.exe"
    Write-Host "  ffprobe : $FfprobeBin -> _bins\ffprobe.exe"
} else { Write-Host "  ATTENTION : binaire ffprobe non trouvé" }

Remove-Item "$Mods\@ffmpeg-static"  -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Mods\@ffprobe-static" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Mods\ffmpeg-static"   -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$Mods\ffprobe-static"  -Recurse -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Path "$Mods\ffmpeg-static"  -Force | Out-Null
New-Item -ItemType Directory -Path "$Mods\ffprobe-static" -Force | Out-Null

Set-Content "$Mods\ffmpeg-static\index.js"  "const path = require('path'); module.exports = path.join(__dirname, '..', '_bins', 'ffmpeg.exe');"
Set-Content "$Mods\ffmpeg-static\package.json"  '{"name":"ffmpeg-static","version":"5.2.0","main":"index.js"}'
Set-Content "$Mods\ffprobe-static\index.js" "const path = require('path'); module.exports = { path: path.join(__dirname, '..', '_bins', 'ffprobe.exe') };"
Set-Content "$Mods\ffprobe-static\package.json" '{"name":"ffprobe-static","version":"3.1.0","main":"index.js"}'

# ── 4. NSIS installer ─────────────────────────────────────────────────────────
Write-Host "→ Création de l'installer NSIS..."
$NsiScript  = Join-Path $RootDir "csharp-tray\installer.nsi"
$MakensisExe = "C:\Program Files (x86)\NSIS\makensis.exe"
if (-not (Test-Path $MakensisExe)) {
    # Chemin alternatif sur certains runners GitHub Actions
    $MakensisExe = "makensis"
}
# Copier le script NSIS dans dist-native\win\ pour que les chemins relatifs fonctionnent
$NsiCopy = Join-Path $WinDir "installer.nsi"
Copy-Item $NsiScript -Destination $NsiCopy
Push-Location $WinDir
& $MakensisExe "installer.nsi"
Pop-Location
Remove-Item $NsiCopy -ErrorAction SilentlyContinue

$Output = Join-Path $DistDir "RadioStation-Import-Studio-Setup.exe"
Write-Host ""
Write-Host "✓ Build terminé : $Output"
(Get-Item $Output).Length / 1MB | ForEach-Object { Write-Host ("Taille : {0:F1} Mo" -f $_) }
