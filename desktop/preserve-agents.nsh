; Remove only known application files. Preserve arbitrary user data directories.
; Keep the new uninstaller for incremental updates too, so old unsafe removal
; logic is replaced without running the old uninstaller.
!ifndef BUILD_UNINSTALLER
  !ifdef UNINSTALLER_OUT_FILE
    !system 'cmd /c copy /Y "${UNINSTALLER_OUT_FILE}" "${UNINSTALLER_OUT_FILE}.incremental" >nul'
  !endif
!endif
!macro customRemoveFiles
  SetOutPath $TEMP
  Delete "$INSTDIR\Agent Room.exe"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\dxcompiler.dll"
  Delete "$INSTDIR\dxil.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\version"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\resources\app.asar"
  Delete "$INSTDIR\resources\app-update.yml"
  Delete "$INSTDIR\resources\default_app.asar"
  Delete "$INSTDIR\resources\elevate.exe"
  RMDir "$INSTDIR\resources"
  Delete "$INSTDIR\locales\en-US.pak"
  Delete "$INSTDIR\locales\zh-CN.pak"
  Delete "$INSTDIR\locales\zh-TW.pak"
  RMDir "$INSTDIR\locales"
  RMDir "$INSTDIR"
!macroend
