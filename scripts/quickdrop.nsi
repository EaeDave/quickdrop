Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\QuickDrop"
!define PRODUCT_KEY "Software\QuickDrop\QuickDrop"
Name "QuickDrop"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\QuickDrop"
InstallDirRegKey HKCU "${PRODUCT_KEY}" ""
Icon "${ICON}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "QuickDrop"
VIAddVersionKey "FileDescription" "QuickDrop installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "QuickDrop contributors"
!define MUI_FINISHPAGE_RUN "$INSTDIR\quickdrop.exe"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var Parameters
Var UpdateMode
Var RestartMode
Var RestartArgs
Var Attempts

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/D=" $0
  ${If} ${Errors}
    ReadRegStr $0 HKCU "${PRODUCT_KEY}" ""
    ${If} $0 == ""
      ReadRegStr $0 HKCU "${UNINSTALL_KEY}" "InstallLocation"
    ${EndIf}
    ${If} $0 != ""
      StrCpy $INSTDIR $0
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/P" $0
  ${IfNot} ${Errors}
    SetSilent silent
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/R" $RestartMode
  ${IfNot} ${Errors}
    StrCpy $RestartMode "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/ARGS" $RestartArgs
  ; NSIS handles /S and the final unquoted /D= path itself.
FunctionEnd

Section "QuickDrop"
  SetOutPath "$INSTDIR"
  ; A legacy updater exits just after spawning us. Never kill another user's process.
  StrCpy $Attempts 0
  SetOverwrite try
retry_binary:
  ClearErrors
  File /oname=quickdrop.exe "${BINARY}"
  ${If} ${Errors}
    IntOp $Attempts $Attempts + 1
    ${If} $Attempts < 30
      Sleep 1000
      Goto retry_binary
    ${EndIf}
    SetErrorLevel 1
    Abort "Close QuickDrop before installing the update."
  ${EndIf}
  SetOverwrite on
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${PRODUCT_KEY}" "" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "QuickDrop"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "QuickDrop"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" '$\"$INSTDIR\quickdrop.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "MainBinaryName" "quickdrop.exe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteRegStr HKCU "Software\Classes\AppUserModelId\dev.quickdrop.quickdrop" "DisplayName" "QuickDrop"
  WriteRegStr HKCU "Software\Classes\AppUserModelId\dev.quickdrop.quickdrop" "IconUri" "$INSTDIR\quickdrop.exe"
  CreateShortcut "$SMPROGRAMS\QuickDrop.lnk" "$INSTDIR\quickdrop.exe"
  ${If} ${FileExists} "$DESKTOP\QuickDrop.lnk"
    CreateShortcut "$DESKTOP\QuickDrop.lnk" "$INSTDIR\quickdrop.exe"
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ${If} ${Silent}
  ${AndIf} $RestartMode == "1"
    Exec '$\"$INSTDIR\quickdrop.exe$\" $RestartArgs'
  ${EndIf}
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
FunctionEnd

Section "Uninstall"
  Delete "$INSTDIR\quickdrop.exe"
  ${If} ${FileExists} "$INSTDIR\quickdrop.exe"
    SetErrorLevel 1
    Abort "Close QuickDrop before uninstalling."
  ${EndIf}
  Delete "$SMPROGRAMS\QuickDrop.lnk"
  Delete "$DESKTOP\QuickDrop.lnk"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "QuickDrop"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  DeleteRegKey HKCU "Software\Classes\AppUserModelId\dev.quickdrop.quickdrop"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
