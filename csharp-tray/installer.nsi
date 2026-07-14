; installer.nsi — NSIS installer RadioStation Import Studio (Windows)
; Usage : makensis installer.nsi  (depuis le dossier dist-native\win\)

Unicode true
!include "MUI2.nsh"

Name      "RadioStation Import Studio"
OutFile   "..\RadioStation-Import-Studio-Setup.exe"
InstallDir "$LOCALAPPDATA\RadioStation Import Studio"
RequestExecutionLevel user   ; pas besoin de droits admin

!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

; ─────────────────────────────────────────────────────────────────────────────
; Installation
; ─────────────────────────────────────────────────────────────────────────────

Section "Install"
  SetOutPath "$INSTDIR"

  ; Exécutable tray, Node.js, code serveur
  File "RadioStationImportStudio.exe"
  File "node.exe"
  File "main.js"
  File /r "node_modules"

  ; Raccourci Menu Démarrer
  CreateDirectory "$SMPROGRAMS\RadioStation"
  CreateShortcut  "$SMPROGRAMS\RadioStation\RadioStation Import Studio.lnk" \
                  "$INSTDIR\RadioStationImportStudio.exe"

  ; Désinstalleur
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "DisplayName" "RadioStation Import Studio"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "UninstallString" "$INSTDIR\uninstall.exe"

  ; Schéma d'URL radiostation-importstudio:// (appairage autonome, Phase 2c) — équivalent Windows
  ; du CFBundleURLTypes macOS / protocols electron-builder retirés avec Electron.
  WriteRegStr HKCU "Software\Classes\radiostation-importstudio" "" "URL:RadioStation Import Studio Pairing"
  WriteRegStr HKCU "Software\Classes\radiostation-importstudio" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\radiostation-importstudio\shell\open\command" "" \
              '"$INSTDIR\RadioStationImportStudio.exe" "%1"'

  ; Lancer l'application après installation
  Exec "$INSTDIR\RadioStationImportStudio.exe"
SectionEnd

; ─────────────────────────────────────────────────────────────────────────────
; Désinstallation
; ─────────────────────────────────────────────────────────────────────────────

Section "Uninstall"
  ; Arrêter le processus en cours
  nsExec::Exec 'taskkill /f /im RadioStationImportStudio.exe'

  ; Supprimer les fichiers
  RMDir /r "$INSTDIR"
  Delete   "$SMPROGRAMS\RadioStation\RadioStation Import Studio.lnk"
  RMDir    "$SMPROGRAMS\RadioStation"

  ; Nettoyer le registre
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RadioStationImportStudio"
  DeleteRegKey   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio"
  DeleteRegKey   HKCU "Software\Classes\radiostation-importstudio"
SectionEnd
