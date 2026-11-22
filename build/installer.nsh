!macro customWelcomePage
  !define MUI_BGCOLOR "080C19"
  !define MUI_TEXTCOLOR "F1EEFF"
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Eclipse"
  !define MUI_WELCOMEPAGE_TEXT "Your Minecraft worlds, all in one place.$\r$\n$\r$\nChoose where to install Eclipse Launcher, then let the Eclipse guide you through the rest."
  !define MUI_BUTTONTEXT_NEXT "Continue"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  # Keep an existing per-user install path during updates and reinstalls.
  ${If} $hasPerUserInstallation != "1"
    StrCpy $INSTDIR "$APPDATA\.eclipse\Eclipse Launcher"
  ${EndIf}
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "EclipseRunApp"
  !define MUI_FINISHPAGE_RUN_TEXT "Run Eclipse Launcher"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "EclipseAddStartMenuShortcut"
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Add Eclipse to the Start menu"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "EclipseFinishPageShow"
  !insertmacro MUI_PAGE_FINISH

  Function EclipseFinishPageShow
    # NSIS/themed checkboxes can ignore MUI_TEXTCOLOR, so set their foreground explicitly.
    System::Call 'UXTHEME::SetWindowTheme(p$mui.FinishPage.Run,w" ",w" ")'
    System::Call 'UXTHEME::SetWindowTheme(p$mui.FinishPage.ShowReadme,w" ",w" ")'
    SetCtlColors $mui.FinishPage.Run "FFFFFF" "080C19"
    SetCtlColors $mui.FinishPage.ShowReadme "FFFFFF" "080C19"
  FunctionEnd

  Function EclipseRunApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function EclipseAddStartMenuShortcut
    CreateDirectory "$SMPROGRAMS\Eclipse Launcher"
    CreateShortCut "$SMPROGRAMS\Eclipse Launcher\Eclipse Launcher.lnk" "$INSTDIR\Eclipse Launcher.exe" "" "$INSTDIR\Eclipse Launcher.exe" 0
  FunctionEnd
!macroend

!macro customInstall
  # Remove a Desktop shortcut created by earlier Eclipse installer versions.
  Delete "$DESKTOP\Eclipse Launcher.lnk"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Eclipse Launcher\Eclipse Launcher.lnk"
  RMDir "$SMPROGRAMS\Eclipse Launcher"
!macroend



