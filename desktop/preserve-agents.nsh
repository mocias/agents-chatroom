; Workspace files live beside the executable. Never recursively remove the
; whole installation directory during upgrade/uninstall: retain agents/.
!macro customRemoveFiles
  SetOutPath $TEMP
  FindFirst $R0 $R1 "$INSTDIR\*"
  loop_agentroom_remove:
    StrCmp $R1 "" done_agentroom_remove
    StrCmp $R1 "." next_agentroom_remove
    StrCmp $R1 ".." next_agentroom_remove
    StrCmp $R1 "agents" next_agentroom_remove
    IfFileExists "$INSTDIR\$R1\*" 0 file_agentroom_remove
      RMDir /r "$INSTDIR\$R1"
      Goto next_agentroom_remove
    file_agentroom_remove:
      Delete "$INSTDIR\$R1"
    next_agentroom_remove:
      FindNext $R0 $R1
      Goto loop_agentroom_remove
  done_agentroom_remove:
    FindClose $R0
    RMDir "$INSTDIR"
!macroend
