/*
 * ChaosX's own pages of the NSIS script, compiled into electron-builder's
 * installer by `build/installer.nsh` being present.
 *
 * Two things were wrong with the lifecycle, and they pull in opposite directions.
 *
 * Uninstalling left everything behind — the profile under %APPDATA%, the playlists,
 * the scanned-library cache, the statistics — so a reinstall of a new build woke up
 * wearing the old install's data, which is not an uninstall by any meaning of the
 * word. `deleteAppDataOnUninstall` in package.json fixes that, and electron-builder
 * passes `--updated` when it runs the old uninstaller as part of an upgrade
 * specifically so that deletion does not fire, which is the half of the request
 * that an update must keep the user's data.
 *
 * What that flag does not reach is the `Run` key. A login item lives in
 * HKCU\Software\Microsoft\Windows\CurrentVersion\Run, outside the profile folder, so
 * an uninstall that "deletes everything" would still leave ChaosX starting at
 * sign-in from an executable that has just been removed. It is deleted here, and
 * only for a real uninstall — during an update the login item has to survive,
 * because the app does not re-register it on boot (it deliberately leaves Task
 * Manager's veto alone, and re-writing the key would overwrite that answer).
 *
 * The three names are the history of this app's identity: the appId, the product
 * name once `app.setName('ChaosX')` was added, and a bare product name. Only the
 * current one is left in place, and the app prunes any others it finds at startup.
 */

/*
 * The line in the bottom-left of every page of the wizard.
 *
 * `common.nsh` draws it as `BrandingText "${PRODUCT_NAME} ${VERSION}"`, and
 * `${VERSION}` is the npm version — so the installer said "ChaosX 1.0.0" while the
 * app, its window title and its artifact name all said ChaosX Mark x1.0. This file
 * is compiled into the script's *header*, ahead of the template body that carries
 * `common.nsh`, so redefining the constant here is what the branding line reads
 * later: measured with a compile-time `!warning`, which expands to
 * `BRANDING=[ChaosX Mark x1.0]`.
 *
 * `!undef` first, because NSIS refuses a silent redefinition. The npm `version` in
 * package.json is untouched, so `app.getVersion()` and the update checks still see
 * real semver; only the installer and `DisplayVersion` in Add/Remove Programs carry
 * the mark, which is the reading the user sees.
 */
!ifdef VERSION
  !undef VERSION
!endif
!define VERSION "Mark x1.0"

!macro customInit
  /*
   * Installing over an existing ChaosX asks one question, because the two things a
   * person wants at that moment are a mile apart and only they know which: carry
   * the library across, or start from nothing.
   *
   * The default is Update. Nothing is deleted on that path, and the assisted
   * installer then removes the old build with `--updated`, so the profile, the
   * playlists, the pinned folders and the statistics all stay where they are.
   */
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $0 != ""
    MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
      "ChaosX is already installed on this PC.$\n$\nYes — Update and keep your playlists, pinned folders, statistics and settings.$\nNo — Clear everything and start from scratch.$\nCancel — Close this installer and change nothing." \
      /SD IDYES IDYES chaosx_keep IDNO chaosx_wipe
    /*
     * Falling through to here is Cancel — the MessageBox jumped past it for Yes and
     * for No. No label: NSIS warns on a label nothing jumps to (6012), and
     * electron-builder builds with warnings treated as errors, which is how the
     * first version of this page failed the whole installer compile.
     */
    Abort
    chaosx_wipe:
      RMDir /r "$APPDATA\ChaosX"
      RMDir /r "$APPDATA\Silent Chaos Music Player"
      RMDir /r "$APPDATA\silent-chaos-music-player"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.chaosx.player"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChaosX"
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.ChaosX"
    chaosx_keep:
  ${endif}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    /*
     * The thumbnail's glyphs and the window captures. Both are written under %TEMP%
     * by the app and read back from disk — `LoadImageW` cannot see inside an asar,
     * and the capture is handed to the wallpaper picker as a file — so they outlive
     * the app unless something deletes them, and nothing else ever will.
     *
     * Two spellings of each because the folder these lived under was renamed with
     * the app: `silent-chaos-*` is what every install before this one left behind.
     */
    RMDir /r "$TEMP\chaosx-thumbbar"
    RMDir /r "$TEMP\chaosx-shots"
    RMDir /r "$TEMP\silent-chaos-thumbbar"
    RMDir /r "$TEMP\silent-chaos-shots"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.chaosx.player"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ChaosX"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "chaosx"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.ChaosX"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "silent-chaos-music-player"
    # The shell's enabled/disabled marker for each of those, so no ghost row is left
    # in Task Manager's Startup list pointing at a deleted file.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.chaosx.player"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ChaosX"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "chaosx"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "electron.app.ChaosX"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "silent-chaos-music-player"
  ${endif}
!macroend
