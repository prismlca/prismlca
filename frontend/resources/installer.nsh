; Additions to electron-builder's NSIS installer (nsis.include in electron-builder.yml).

; Windows tools read the install path from the uninstall entry; electron-builder writes it only under its
; own registry key, so the entry showed an empty InstallLocation.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
!macroend

; The installer copies itself to %LOCALAPPDATA%\prism-lca-updater\installer.exe as the base for differential
; updates (about 550 MB). A real uninstall left it behind; an update must keep it, so only a removal that is
; not part of an update clears the folder. User data in %APPDATA% and %LOCALAPPDATA%\Prism LCA stays.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The cache lives in the installing user's %LOCALAPPDATA% even for an all-users installation
    ; (electron-builder switches to the current-user context to write it), so switch the same way here.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$LOCALAPPDATA\prism-lca-updater"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endIf}
!macroend
