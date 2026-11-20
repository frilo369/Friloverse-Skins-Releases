Unicode true
RequestExecutionLevel user
!ifndef SHOWN
  !define SHOWN "${VERSION}"
!endif
Name "Friloverse ${SHOWN}"
OutFile "${OUTPUT_SETUP}"
Icon "..\src\ui\friloverse.ico"
SetCompress off
ShowInstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Friloverse Complete Setup"
VIAddVersionKey "FileDescription" "Friloverse setup"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "FrYiLo"
VIAddVersionKey "LegalCopyright" "Copyright 2026 FrYiLo"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "StrFunc.nsh"
!include "x64.nsh"
${StrRep}

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install Friloverse"
!define MUI_WELCOMEPAGE_TEXT "This installs Friloverse ${SHOWN} and everything it needs. There is nothing else to set up.$\r$\n$\r$\nFriloverse uses LTK Manager, separate free software by LeagueToolkit. If it is missing or out of date, setup downloads it from the official release and installs it in the background. Windows may ask for permission once."
!define MUI_FINISHPAGE_TEXT "Friloverse is ready and running in your system tray. It starts with Windows.$\r$\n$\r$\nGo into champion select and it opens by itself, or click the gold star at the top left of the League client."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE ShowTermsIfNeeded
!define MUI_PAGE_HEADER_TEXT "LTK Manager"
!define MUI_PAGE_HEADER_SUBTEXT "Friloverse needs LTK Manager, and this PC does not have a usable copy."
!insertmacro MUI_PAGE_LICENSE "ltk-terms.txt"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Var LtkDir
Var LtkRegistered
Var LtkVersion
Var LtkNeeded
Var FriloverseDir
Var InstalledVersion
Var CheckResult

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Friloverse requires 64-bit Windows."
    Quit
  ${EndIf}
  IfSilent 0 +3
    SetErrorLevel 1
    Quit
  SetShellVarContext current
FunctionEnd

; Return 0 for a running process, 1 for none, and anything else on error.
Function CheckLtkProcess
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { if (Get-Process -Name 'ltk-manager' -ErrorAction SilentlyContinue) {exit 0} else {exit 1} } catch {exit 2}"`
  Pop $CheckResult
  Pop $0
FunctionEnd

Function CheckFriloverseProcess
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { if (Get-Process -Name 'Friloverse-Skins' -ErrorAction SilentlyContinue) {exit 0} else {exit 1} } catch {exit 2}"`
  Pop $CheckResult
  Pop $0
FunctionEnd

Function WaitForGame
  game_check:
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { if (Get-Process -Name 'League of Legends' -ErrorAction SilentlyContinue) {exit 0} else {exit 1} } catch {exit 2}"`
  Pop $CheckResult
  Pop $0
  ${If} $CheckResult == 0
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "A League game is running. Finish the game, then click Retry." IDRETRY game_check
    Abort
  ${ElseIf} $CheckResult != 1
    MessageBox MB_ICONSTOP "Could not check whether League is running. Setup stopped without changing either application."
    Abort
  ${EndIf}
FunctionEnd

; Only a game is worth waiting for: closing these between matches loses nothing.
Function CloseFriloverse
  Call CheckFriloverseProcess
  ${If} $CheckResult == 1
    Return
  ${EndIf}
  DetailPrint "Closing Friloverse..."
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM Friloverse-Skins.exe`
  Pop $0
  ; Friloverse runs as administrator (since 13.1), which this setup cannot close without asking.
  Call CheckFriloverseProcess
  ${If} $CheckResult != 1
    ExecShellWait "runas" "$SYSDIR\taskkill.exe" `/F /T /IM Friloverse-Skins.exe` SW_HIDE
  ${EndIf}
  ; Left behind by a version before 1.6, if it was still running.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM divinity-celestial-guard.exe`
  Pop $0
  StrCpy $1 0
  friloverse_closing:
  Sleep 500
  Call CheckFriloverseProcess
  ${If} $CheckResult != 1
    IntOp $1 $1 + 1
    ${If} $1 < 20
      Goto friloverse_closing
    ${EndIf}
    MessageBox MB_ICONSTOP "Friloverse could not be closed. Restart your PC, then run this setup again."
    Abort
  ${EndIf}
FunctionEnd

Function CloseLtk
  Call CheckLtkProcess
  ${If} $CheckResult == 1
    Return
  ${EndIf}
  DetailPrint "Closing LTK Manager..."
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM ltk-manager.exe`
  Pop $0
  StrCpy $1 0
  ltk_closing:
  Sleep 500
  Call CheckLtkProcess
  ${If} $CheckResult != 1
    IntOp $1 $1 + 1
    ${If} $1 < 20
      Goto ltk_closing
    ${EndIf}
    MessageBox MB_ICONSTOP "LTK Manager could not be closed. Restart your PC, then run this setup again."
    Abort
  ${EndIf}
FunctionEnd

; Match Friloverse's preference: per-user registry, machine registry, default.
Function FindLtk
  StrCpy $LtkDir ""
  SetRegView 64
  ReadRegStr $LtkDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager" "InstallLocation"
  ${If} $LtkDir == ""
    SetRegView 32
    ReadRegStr $LtkDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager" "InstallLocation"
  ${EndIf}
  ${If} $LtkDir == ""
    SetRegView 64
    ReadRegStr $LtkDir HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager" "InstallLocation"
  ${EndIf}
  ${If} $LtkDir == ""
    SetRegView 32
    ReadRegStr $LtkDir HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\LTK Manager" "InstallLocation"
  ${EndIf}
  ${StrRep} $LtkDir $LtkDir '"' ""
  StrCpy $LtkRegistered $LtkDir
  ${If} $LtkDir == ""
    StrCpy $LtkDir "$PROGRAMFILES64\LTK Manager"
  ${EndIf}
FunctionEnd

; Missing or too old. A newer one is left alone: Friloverse checks it when it connects.
Function CheckLtkNeeded
  Call FindLtk
  StrCpy $LtkNeeded "yes"
  IfFileExists "$LtkDir\ltk-manager.exe" 0 needed_checked
  ClearErrors
  ${GetFileVersion} "$LtkDir\ltk-manager.exe" $LtkVersion
  IfErrors needed_checked
  ${VersionCompare} "$LtkVersion" "1.33.0.0" $0
  ${If} $0 != 2
    StrCpy $LtkNeeded "no"
  ${EndIf}
  needed_checked:
FunctionEnd

Function ShowTermsIfNeeded
  Call CheckLtkNeeded
  ${If} $LtkNeeded == "no"
    Abort
  ${EndIf}
FunctionEnd

Function DownloadLtk
  ; Process-local environment avoids quoting a temporary path inside PowerShell.
  System::Call 'Kernel32::SetEnvironmentVariableW(w "FRILOVERSE_SETUP_DEST", w "$PLUGINSDIR\LTK-Setup.exe") i .r0'
  ${If} $0 == 0
    MessageBox MB_ICONSTOP "Could not prepare the LTK Manager download."
    Abort
  ${EndIf}
  download_retry:
  DetailPrint "Downloading the official LTK Manager 1.33.0 installer..."
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('https://github.com/LeagueToolkit/ltk-manager/releases/download/v1.33.0/LTK.Manager_x64-setup.exe', $$env:FRILOVERSE_SETUP_DEST); $$stream = [IO.File]::OpenRead($$env:FRILOVERSE_SETUP_DEST); try { $$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($$stream)).Replace('-','') } finally { $$stream.Dispose() }; if ($$hash -ne 'D615A752940061E683E032506C432851DF79E8B39F3732A9576FBEDFDC6B5920') {exit 2}; exit 0 } catch {exit 1}"`
  Pop $CheckResult
  Pop $0
  ${If} $CheckResult != 0
    Delete "$PLUGINSDIR\LTK-Setup.exe"
    MessageBox MB_ICONEXCLAMATION|MB_RETRYCANCEL "The official LTK Manager download failed or did not match the expected file. Check your connection and click Retry. No downloaded installer was run." IDRETRY download_retry
    Abort
  ${EndIf}
FunctionEnd

Function InstallLtk
  Call DownloadLtk
  Call WaitForGame
  Call CloseLtk
  DetailPrint "Installing LTK Manager in the background..."
  ; It installs for every user of this PC, so Windows asks for permission: a plain
  ; ExecWait cannot start it. The file itself shows whether it worked.
  ExecShellWait "open" "$PLUGINSDIR\LTK-Setup.exe" "/S"
  Call CheckLtkNeeded
  ${If} $LtkNeeded == "yes"
    ; Better its own installer window than a setup that stops here.
    DetailPrint "Opening LTK Manager's installer..."
    ExecShellWait "open" "$PLUGINSDIR\LTK-Setup.exe"
    Call CheckLtkNeeded
    ${If} $LtkNeeded == "yes"
      MessageBox MB_ICONEXCLAMATION "LTK Manager could not be installed, so Friloverse was not installed. Run this setup again."
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; In the tray, like a start with Windows: setup's last page says so.
; Friloverse starts in its own folder, never in setup's temporary one: a program working there
; holds it, and Windows could not remove setup's copies (hundreds of MB) when setup closes.
Function StartFriloverse
  Delete "$PLUGINSDIR\Friloverse-Setup.exe"
  Delete "$PLUGINSDIR\LTK-Setup.exe"
  RMDir /r "$PLUGINSDIR\update"
  ${If} ${FileExists} "$FriloverseDir\Friloverse-Skins.exe"
    SetOutPath "$FriloverseDir"
    Exec '"$FriloverseDir\Friloverse-Skins.exe" --startup'
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\friloverse-skins\Friloverse-Skins.exe"
    SetOutPath "$LOCALAPPDATA\friloverse-skins"
    Exec '"$LOCALAPPDATA\friloverse-skins\Friloverse-Skins.exe" --startup'
  ${Else}
    MessageBox MB_ICONEXCLAMATION "Friloverse was installed, but its launcher was not found. Open Friloverse from the Start menu."
    Return
  ${EndIf}
  ; A blocked or failed launch must not leave the finish page claiming it is running.
  Sleep 3000
  Call CheckFriloverseProcess
  ${If} $CheckResult != 0
    MessageBox MB_ICONEXCLAMATION "Friloverse was installed, but it did not start. Open Friloverse from the Start menu."
  ${EndIf}
FunctionEnd

Function ExtractFriloverse
  SetOutPath "$PLUGINSDIR"
  File /oname=Friloverse-Setup.exe "${FRILOVERSE_SETUP}"
FunctionEnd

; A fresh Squirrel install removes an existing install root. Older versions stored
; player libraries there. Move that directory out first, or stop before replacement.
Function PreserveDatabase
  IfFileExists "$LOCALAPPDATA\friloverse-skins\Database" 0 database_preserved
  IfFileExists "$LOCALAPPDATA\friloverse-skins-data\Database" database_conflict 0
  CreateDirectory "$LOCALAPPDATA\friloverse-skins-data"
  ClearErrors
  Rename "$LOCALAPPDATA\friloverse-skins\Database" "$LOCALAPPDATA\friloverse-skins-data\Database"
  IfErrors database_conflict database_preserved
  database_conflict:
  MessageBox MB_ICONSTOP "Your skin database could not be moved safely. Setup stopped before replacing Friloverse. Back up the Database folder in the old install, or start the latest Friloverse once to merge it, then retry."
  SetErrorLevel 1
  Abort
  database_preserved:
FunctionEnd

Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  Call WaitForGame
  Call CloseFriloverse
  Call CheckLtkNeeded
  ${If} $LtkNeeded == "yes"
    Call InstallLtk
  ${EndIf}
  Call WaitForGame

  SetRegView 64
  ReadRegStr $FriloverseDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\friloverse-skins" "InstallLocation"
  ReadRegStr $InstalledVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\friloverse-skins" "DisplayVersion"
  ${StrRep} $FriloverseDir $FriloverseDir '"' ""
  ${If} $FriloverseDir == ""
    IfFileExists "$LOCALAPPDATA\friloverse-skins\Update.exe" incomplete_install fresh_install
  ${EndIf}
  IfFileExists "$FriloverseDir\Update.exe" existing_install incomplete_install
  incomplete_install:
  ; The fresh-install path preserves older in-folder databases before replacing it.
  DetailPrint "Replacing an incomplete Friloverse installation..."
  Goto fresh_install
  existing_install:
  ${If} $InstalledVersion == ""
    Goto incomplete_install
  ${EndIf}
  ; Update.exe alone is not an install: without Squirrel's launcher it is replaced.
  IfFileExists "$FriloverseDir\Friloverse-Skins.exe" 0 incomplete_install
  ${VersionCompare} "$InstalledVersion" "${VERSION}" $0
  ; Nothing is skipped when the registered version's own program is missing.
  ${If} $0 != 2
  ${AndIfNot} ${FileExists} "$FriloverseDir\app-$InstalledVersion\Friloverse-Skins.exe"
    Goto incomplete_install
  ${EndIf}
  ${If} $0 == 1
    DetailPrint "A newer Friloverse is already installed."
    Goto done
  ${ElseIf} $0 == 0
    DetailPrint "Friloverse ${SHOWN} is already installed."
    Goto done
  ${EndIf}
  DetailPrint "Preparing the Friloverse update..."
  Call ExtractFriloverse
  File /oname=7z.exe "${SEVEN_Z}"
  File /oname=7z.dll "${SEVEN_Z_DLL}"
  CreateDirectory "$PLUGINSDIR\update"
  nsExec::ExecToStack '"$PLUGINSDIR\7z.exe" x -tzip -y "-o$PLUGINSDIR\update" "$PLUGINSDIR\Friloverse-Setup.exe" "RELEASES" "friloverse-skins-${VERSION}-full.nupkg"'
  Pop $0
  Pop $1
  ; The zip is embedded inside an exe, so 7-Zip returns 1, or 2 with "Headers Error", although
  ; both files come out whole. The checks below and Update.exe's own package check decide.
  ${If} $0 != 0
  ${AndIf} $0 != 1
  ${AndIf} $0 != 2
    MessageBox MB_ICONSTOP "Could not prepare the Friloverse update. The existing installation was left in place."
    Abort
  ${EndIf}
  IfFileExists "$PLUGINSDIR\update\RELEASES" 0 update_error
  IfFileExists "$PLUGINSDIR\update\friloverse-skins-${VERSION}-full.nupkg" 0 update_error
  Call WaitForGame
  Call CloseFriloverse
  DetailPrint "Updating Friloverse..."
  ExecWait '"$FriloverseDir\Update.exe" --update "$PLUGINSDIR\update"' $0
  ${If} $0 != 0
    Goto update_error
  ${EndIf}
  IfFileExists "$FriloverseDir\app-${VERSION}\Friloverse-Skins.exe" done update_error
  update_error:
  MessageBox MB_ICONSTOP "The Friloverse update did not finish. Your previous installation and app data were not intentionally removed."
  Abort
  fresh_install:
  ; A registered folder that failed the checks above is not where this install goes.
  StrCpy $FriloverseDir "$LOCALAPPDATA\friloverse-skins"
  DetailPrint "Installing Friloverse..."
  Call ExtractFriloverse
  Call WaitForGame
  Call CloseFriloverse
  Call PreserveDatabase
  ; This window already shows progress, so its splash screen stays hidden.
  ExecWait '"$PLUGINSDIR\Friloverse-Setup.exe" --silent' $0
  ; A leftover program from an earlier try does not prove that this one worked.
  ${If} $0 == 0
  ${AndIf} ${FileExists} "$LOCALAPPDATA\friloverse-skins\Friloverse-Skins.exe"
  ${AndIf} ${FileExists} "$LOCALAPPDATA\friloverse-skins\app-${VERSION}\Friloverse-Skins.exe"
    Goto fresh_checked
  ${EndIf}
  ExecWait '"$PLUGINSDIR\Friloverse-Setup.exe"' $0
  fresh_checked:
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Friloverse setup did not finish."
    Abort
  ${EndIf}
  IfFileExists "$LOCALAPPDATA\friloverse-skins\app-${VERSION}\Friloverse-Skins.exe" done fresh_error
  fresh_error:
  MessageBox MB_ICONSTOP "Friloverse setup did not create the expected installation. Check the installer's error and retry."
  Abort
  done:
  Call StartFriloverse
  DetailPrint "Setup finished."
SectionEnd
