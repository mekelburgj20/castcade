; Custom NSIS include for the Castcade installer (electron-builder `nsis.include`, companion/electron-builder.yml).
;
; D10.1: a Windows Firewall allow rule for the native spectator-video helper (castcade-video.exe), so its WebRTC
; media (UDP, plus TCP for the fallback) reaches the peer without the user answering the Windows prompt.
;
; ELEVATION (checked in app-builder-lib/templates/nsis/installer.nsi, electron-builder 26): the installer requests
; `RequestExecutionLevel user` unless the build is perMachine (INSTALL_MODE_PER_ALL_USERS). Castcade is perMachine:
; false with allowElevation: false, so customInstall and customUnInstall run NOT elevated, and `netsh advfirewall
; firewall add rule` fails with "requires elevation". That is expected: the rule is best-effort, nsExec::ExecToLog
; swallows the exit code, and the helper still works because Windows shows its own firewall prompt the first time the
; exe listens (the same prompt any unelevated install gets). The rule only takes effect when the installer or
; uninstaller happens to be run as administrator.
;
; Rule name is fixed so the uninstall (and a reinstall, which deletes first) removes exactly this rule.
;
; A14: the join link castcade://join/<invite>. electron-builder's NSIS target registers no URL protocol, so the keys
; are written here, per user (HKCU, which an unelevated installer may write), in the shape Electron's own
; `app.setAsDefaultProtocolClient` writes at the app's first start: the URL is one quoted argument and nothing of it
; is ever a switch (the app looks only at an argument that starts with castcade://, src/main/deep-link.ts). The
; uninstaller removes the key; an update's uninstall-then-install writes it again.
;
; E9 (2026-11-16): an update ends with Castcade running, and the one Castcade starts itself is shown. Castcade runs the
; installer of an update visibly (src/main/updater.ts: electron-updater's install(false, true), i.e. `--updated
; --force-run`, no /S). electron-builder's assisted installer (checked in app-builder-lib 26.15.3 templates/nsis) would
; then ask "who should this be installed for" (multiUserUi.nsh; the all-users choice is disabled for Castcade, which
; is per user) and stop on its Finish page, because it starts the app by itself only after a SILENT --force-run install
; (installSection.nsh). So: an update skips that question (customInstallMode, the hook multiUserUi.nsh offers), and an
; update shown with --force-run starts Castcade and closes at the end of the install section, the way the one-click
; installer ends (`doStartApp` + `quitSuccess` in installSection.nsh). And an update an older Castcade installed
; silently when it quit (`--updated /S`, no --force-run: 0.2.45 and before) starts Castcade in the tray at its end,
; instead of leaving nothing running.
;
; E10 (2026-11-19): the Witness edition's installer (electron-builder.witness.yml) includes this file through
; installer-witness.nsh, which defines CASTCADE_WITNESS_EDITION first. It gets everything above for updates, but no
; firewall rule (it ships no video helper) and no castcade:// keys (it has no matches); instead it deletes both when a
; full install left them (installed over a full install, whose uninstaller normally removes them first). The uninstall
; step is the same for both editions.

!macro customInstallMode
  ${if} ${isUpdated}
  ${andIf} $hasPerMachineInstallation == "0"
    StrCpy $isForceCurrentInstall "1"
  ${endIf}
!macroend

; multiUserUi.nsh (app-builder-lib 26) guards the hook with `!ifmacrodef customInstallmode` (lower-case m) and then
; inserts `customInstallMode`. makensis 3.0.4.1 matches macro names without regard to case (checked 2026-11-16), so the
; guard finds the macro above and this alias is skipped; where names are matched exactly, the alias satisfies the guard.
!ifmacrondef customInstallmode
  !macro customInstallmode
    !insertmacro customInstallMode
  !macroend
!endif

!macro customInstall
  !ifdef CASTCADE_WITNESS_EDITION
  ; E10: the Witness edition keeps neither: a full install's castcade:// keys and firewall rule go (best-effort).
  DeleteRegKey HKCU "Software\Classes\castcade"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Castcade video helper"'
  Pop $0
  !else
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Castcade video helper"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Castcade video helper" dir=in action=allow program="$INSTDIR\resources\video-helper\castcade-video.exe" enable=yes profile=private,domain protocol=UDP'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Castcade video helper" dir=in action=allow program="$INSTDIR\resources\video-helper\castcade-video.exe" enable=yes profile=private,domain protocol=TCP'
  Pop $0
  WriteRegStr HKCU "Software\Classes\castcade" "" "URL:castcade"
  WriteRegStr HKCU "Software\Classes\castcade" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\castcade\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  !endif
  ; E9: the end of an update (see the top of this file). $launchLink is the Start menu shortcut, else the exe. After an
  ; older Castcade's silent install at quit the user had closed Castcade (maybe for a game in VR): it comes back in the
  ; tray (`--hidden`, the Start with Windows start), not with its window.
  ${if} ${isUpdated}
    ${if} ${Silent}
      ${ifNot} ${isForceRun}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated --hidden"
      ${endIf}
    ${elseif} ${isForceRun}
      HideWindow
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      SetErrorLevel 0
      Quit
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\castcade"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Castcade video helper"'
  Pop $0
!macroend
