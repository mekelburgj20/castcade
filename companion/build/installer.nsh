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

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Castcade video helper"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Castcade video helper" dir=in action=allow program="$INSTDIR\resources\video-helper\castcade-video.exe" enable=yes profile=private,domain protocol=UDP'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Castcade video helper" dir=in action=allow program="$INSTDIR\resources\video-helper\castcade-video.exe" enable=yes profile=private,domain protocol=TCP'
  Pop $0
  WriteRegStr HKCU "Software\Classes\castcade" "" "URL:castcade"
  WriteRegStr HKCU "Software\Classes\castcade" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\castcade\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\castcade"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Castcade video helper"'
  Pop $0
!macroend
