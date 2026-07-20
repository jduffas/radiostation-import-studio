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
  ; Ferme une instance déjà en cours (mise à jour par-dessus une install existante, sans
  ; désinstallation manuelle préalable) — sinon RadioStationImportStudio.exe est verrouillé et
  ; le File ci-dessous échoue. Nom unique, aucun risque de tuer un autre process par erreur —
  ; contrairement à "node.exe" (trop générique : tuerait n'importe quel Node.js tiers en cours
  ; sur la machine, ex. VS Code/autre projet dev). Le node.exe enfant bundlé n'est pas taskkill
  ; directement pour cette raison ; le filet de sécurité contre un éventuel orphelin est la
  ; technique de renommage juste plus bas (Windows autorise le renommage d'un exe verrouillé,
  ; pas son écrasement), plus JobObject.cs côté C# qui évite l'orphelinat à la source.
  nsExec::Exec 'taskkill /f /im RadioStationImportStudio.exe'
  Sleep 300

  SetOutPath "$INSTDIR"

  ; Filet de sécurité supplémentaire : un zombie d'une version antérieure au fix JobObject
  ; (cf. JobObject.cs) peut encore avoir node.exe/l'exe tray ouverts malgré le taskkill
  ; ci-dessus — écraser directement ces fichiers échoue alors ("impossible d'écrire node.exe").
  ; Windows autorise en revanche de RENOMMER un exécutable en cours d'usage (contrairement à
  ; l'écraser) — technique standard des auto-updaters. Bascule l'ancien fichier de côté avant
  ; d'écrire le nouveau ; le résidu .old (uniquement si un process s'accroche encore dessus) est
  ; nettoyé au mieux plus bas, sans bloquer l'installation si ça échoue. Rename/Delete sur un
  ; fichier absent (premier install) sont des no-op silencieux en NSIS.
  Delete "$INSTDIR\node.exe.old"
  Rename "$INSTDIR\node.exe" "$INSTDIR\node.exe.old"
  Delete "$INSTDIR\RadioStationImportStudio.exe.old"
  Rename "$INSTDIR\RadioStationImportStudio.exe" "$INSTDIR\RadioStationImportStudio.exe.old"

  ; Exécutable tray, Node.js, code serveur
  File "RadioStationImportStudio.exe"
  File "node.exe"
  File "main.js"
  File "vocal-precise.js"
  File "package.json"
  File /r "node_modules"
  File /r "local-ui"
  File /r "models"

  ; Best-effort — laisse le résidu si un vieux process s'y accroche encore, sans conséquence
  ; (l'app tourne déjà sur les fichiers fraîchement écrits ci-dessus, pas sur le .old).
  Delete "$INSTDIR\node.exe.old"
  Delete "$INSTDIR\RadioStationImportStudio.exe.old"

  ; Runtime WebView2 (moteur Chromium de la fenêtre d'import CD) — absent sur certaines
  ; images Windows débloatées/VM, ce qui fait échouer EnsureCoreWebView2Async au runtime.
  Call InstallWebView2IfMissing

  ; Raccourci Menu Démarrer
  CreateDirectory "$SMPROGRAMS\RadioStation"
  CreateShortcut  "$SMPROGRAMS\RadioStation\RadioStation Import Studio.lnk" \
                  "$INSTDIR\RadioStationImportStudio.exe"

  ; Désinstalleur
  WriteUninstaller "$INSTDIR\uninstall.exe"
  ; UninstallString DOIT être entre guillemets : $INSTDIR contient un espace ("Import Studio"),
  ; sans quoi Windows (bouton "Désinstaller" des Paramètres, Apps & Features) coupe la commande
  ; au premier espace et échoue à la lancer — symptôme observé : cliquer "Désinstaller" ouvrait
  ; juste l'explorateur de fichiers à la racine du profil utilisateur au lieu de lancer uninstall.exe.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "DisplayName" "RadioStation Import Studio"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "DisplayIcon" '"$INSTDIR\RadioStationImportStudio.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "InstallLocation" '"$INSTDIR"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationImportStudio" \
              "NoRepair" 1

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
; Runtime WebView2 — détection + installation silencieuse si absent
; ─────────────────────────────────────────────────────────────────────────────

Function InstallWebView2IfMissing
  ; Installation machine (64 bits) ou utilisateur — GUID produit WebView2 Runtime.
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 webview2_present
  ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 webview2_present
  ; Fallback registre 32 bits (build 32 bits du runtime sur une machine 64 bits).
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  StrCmp $0 "" 0 webview2_present

  DetailPrint "WebView2 Runtime absent — installation en cours..."
  File "MicrosoftEdgeWebView2Setup.exe"
  ; /silent /install : pas de fenêtre. Sans droits admin, le bootstrapper Microsoft
  ; retombe automatiquement sur une installation par utilisateur (cohérent avec
  ; RequestExecutionLevel user ci-dessus).
  nsExec::ExecToLog '"$INSTDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install'
  Pop $1
  Delete "$INSTDIR\MicrosoftEdgeWebView2Setup.exe"
  Goto webview2_done

  webview2_present:
  DetailPrint "WebView2 Runtime déjà présent."

  webview2_done:
FunctionEnd

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
