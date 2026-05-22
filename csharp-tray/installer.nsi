; installer.nsi — NSIS installer RadioStation CD Ripper (Windows)
; Usage : makensis installer.nsi  (depuis le dossier dist-native\win\)

Unicode true
!include "MUI2.nsh"

Name      "RadioStation CD Ripper"
OutFile   "..\RadioStation-CD-Ripper-Setup.exe"
InstallDir "$LOCALAPPDATA\RadioStation CD Ripper"
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
  File "RadioStationCDRipper.exe"
  File "node.exe"
  File "main.js"
  File /r "node_modules"

  ; Raccourci Menu Démarrer
  CreateDirectory "$SMPROGRAMS\RadioStation"
  CreateShortcut  "$SMPROGRAMS\RadioStation\RadioStation CD Ripper.lnk" \
                  "$INSTDIR\RadioStationCDRipper.exe"

  ; Désinstalleur
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationCDRipper" \
              "DisplayName" "RadioStation CD Ripper"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationCDRipper" \
              "UninstallString" "$INSTDIR\uninstall.exe"

  ; Lancer l'application après installation
  Exec "$INSTDIR\RadioStationCDRipper.exe"
SectionEnd

; ─────────────────────────────────────────────────────────────────────────────
; Désinstallation
; ─────────────────────────────────────────────────────────────────────────────

Section "Uninstall"
  ; Arrêter le processus en cours
  nsExec::Exec 'taskkill /f /im RadioStationCDRipper.exe'

  ; Supprimer les fichiers
  RMDir /r "$INSTDIR"
  Delete   "$SMPROGRAMS\RadioStation\RadioStation CD Ripper.lnk"
  RMDir    "$SMPROGRAMS\RadioStation"

  ; Nettoyer le registre
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RadioStationCDRipper"
  DeleteRegKey   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\RadioStationCDRipper"
SectionEnd
