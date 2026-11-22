# Eclipse Launcher

Starter Electron launcher for Eclipse.

## Current milestone
- Custom purple scrollbar
- Local instance discovery from `instances/` during development
- Official Minecraft.net RSS news feed
- Clicking Read More opens the official Minecraft article in an Eclipse child window

## Instance layout
Put an instance directly inside `instances/`, for example:

```text
instances/
└── 1.20.1-PVP/
    ├── config/
    ├── mods/
    ├── resourcepacks/
    ├── ...
    └── eclipse-instance.json
```

The `eclipse-instance.json` belongs in the root of the instance folder, next to `config`, `mods`, etc.

## File locations
The launcher resolves bundled files from Electron's application directory, not from the terminal's working directory or a fixed development path. In development, instances are read from this project's `instances/` folder. In an installed build, writable instances and settings are stored under Electron's per-user `userData` directory, so they continue working when the app is installed in a different folder. Bundled assets and the initial bundled instances are read from the application package.

## Versioning
The launcher version uses `Eclipse vx.y.z`: increment `y` for a feature or other addition, `z` for a patch or bug fix, and `x` for a very large release. Keep `package.json` as the source version; the sidebar reads the packaged app version automatically. The current version is `v1.23.71`.

## Windows installer
Run `npm run dist` on Windows to create `dist/Eclipse-Launcher-Setup-<version>.exe`. It is an assisted, per-user NSIS installer with Eclipse artwork and a custom welcome page. Its default install directory is `%APPDATA%\.eclipse\Eclipse Launcher`, and the directory page lets the user choose a different location. The finish page lets the user launch Eclipse and optionally add a Start Menu shortcut. The installer does not create a Desktop shortcut, which avoids the Windows shortcut-arrow overlay; it also removes the old Desktop shortcut during an upgrade. Windows does not provide a supported per-user installer command to pin an app directly to the Start pinned section. Installer-only artwork and the `dist/` output are excluded from the packaged app by the explicit `build.files` list.

## Windows updates
Packaged Windows builds use electron-updater with the public GitHub releases for `eclipse-launcher/eclipse-launcher.github.io`. This is the repository where launcher installers are released; the Eclipse website is hosted from the same repository. The `build.publish` owner and repo in `package.json` set the release feed embedded into packaged builds. The updater is enabled only in packaged Windows builds; `npm start` does not contact the release feed. An available update downloads in the background, shows an in-app notice, then asks whether to install now or later. Choosing Later leaves the installer in electron-updater's cache; on the next launch, the updater checks the release metadata and reuses the cached installer when it still matches.

For each update release, increment the package version and run `npm run dist` on Windows to build the Windows **NSIS installer** locally without publishing. Attach the installer `.exe`, its matching `.blockmap`, and the generated `latest.yml` from `dist/` to a published (not draft) GitHub release in `eclipse-launcher/eclipse-launcher.github.io`. Use a release tag matching the package version; keep the repository public for anonymous update checks. `latest.yml` contains the installer filename and checksum and is required by electron-updater; the installer does not need a particular name, though this project's configured name is `Eclipse-Launcher-Setup-<version>.exe`. The `.blockmap` enables smaller differential downloads; without it the updater can fall back to a full installer download. `app-update.yml` is embedded in the installed app by electron-builder and is not a release asset. Do not hand-edit or mix a manifest with files from another build. The updater checks stable releases by default; a GitHub prerelease such as `v1.8.16` is ignored unless prerelease updates are explicitly enabled in the app.

People using builds from before updater support need to install an updater-enabled build manually once. Publish each new installer, `.blockmap`, and `latest.yml` together as assets on a public GitHub release.

Example:

```json
{
  "name": "PvP",
  "version": "1.20.1",
  "loader": "Fabric",
  "lastPlayed": 0
}
```

Run `npm install`, then `npm start`.
