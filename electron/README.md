# Fractal desktop (Electron)

Runs the VS Code extension's own Notes code (`../out/extension.js`, webview, media, vendor) unchanged on a
`vscode` API shim in the Electron main process — ADR-0013 / ADR-0014, spec `20261106-1312-electron-vscode-shim`.

- `src/vscode-shim/` — the `vscode` module (`require('vscode')` resolves here). No Electron imports.
- `src/main/` — the shell: lifecycle, one BrowserWindow per webview panel (`panel-host.ts`), dialogs /
  messages / prompts (`ui.ts`, `prompt-window.ts`), menu, D6 opener, theme variables.
- `src/renderer/` — sandboxed preloads (the page gets `acquireVsCodeApi()` only) and the prompt page.

## Build and run

```sh
npm install                  # once (Electron 45; postinstall downloads the binary)
npm run build:app-dir        # extension compile + shell build + dist/mac-arm64/Fractal.app (ad-hoc signed)
open dist/mac-arm64/Fractal.app
npm run build:mac            # the same as a zip in dist/
npm run build:e2e            # the E2E build in dist/e2e/mac-arm64 (for the tests only, see below; pack:e2e = without recompiling)
npm start                    # dev: compile, then run from this folder (profile: ~/Library/Application Support/Fractal-dev)
npm run start:fast           # dev without recompiling the extension (after a root `npm run compile`)
```

The app you use (`build:app-dir` / `build:mac`) runs only the code it ships: Electron's fuses turn off
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` and check `app.asar`, it is signed (ad-hoc) with the
hardened runtime (`DYLD_*` ignored; `build/entitlements.mac.plist`), and it ignores the development switches
below. So another local process cannot run its own code inside Fractal with the macOS privacy permissions you
gave the app (Documents, Desktop, iCloud Drive…).

First start opens the first note of the active notes list (`~/.fractal/default.fractal`, created or reused by
the extension); later starts reopen the notes that were open. File > Open Note Folder… / New Note… /
Notes / Notes Lists switch notes. Settings: Fractal > Settings… (`<userData>/User/settings.json`, same
`fractal.*` keys as VS Code — VS Code's own settings are not read). Logs: Help > Open Logs Folder.

Options: `--fractal-open-note=<dir>` (or `FRACTAL_OPEN_NOTE`) note to open, `FRACTAL_LANG`,
`FRACTAL_NO_EXTERNAL=1` (log instead of opening the browser / Finder — tests). Development / test only
(`src/main/launch-options.ts`): `FRACTAL_EXTENSION_ROOT` (unpackaged runs), `--fractal-user-data=<dir>` (or
`FRACTAL_USER_DATA`) profile folder (unpackaged runs and the E2E build).

## Tests

```sh
# from the repo root
npx playwright test test/unit/electron-vscode-shim.spec.ts                        # shim (AC-2, AC-3), headless, plain Node
(cd electron && npm run build:e2e) && npx playwright test test/e2e-electron-app    # AC-4 on the built Fractal.app (E2E build)
FRACTAL_E2E_DEV=1 npx playwright test test/e2e-electron-app                        # AC-4 on the dev build (after `npm run build:shim`)
# from electron/
npm run test:e2e                                                                   # build:app-dir + pack:e2e, then the AC-4 E2E
```

The shim spec needs only the root `npm install` (vscode-uri, chokidar and jsonc-parser are root
devDependencies too); it is part of the normal extension test run.

The E2E (`test/e2e-electron-app/notes-smoke.spec.ts`) launches the E2E build (`dist/e2e`: the release config
plus the `--inspect` fuse Playwright needs and the `--fractal-user-data` switch,
`electron-builder.e2e.config.js`) with Playwright's `_electron`, each test with its own temp HOME
(`~/.fractal/default.fractal`), `--fractal-user-data` profile and a note made by the extension's own
`NotesFileManager`, and `FRACTAL_NO_EXTERNAL=1`; your own notes and profile are not touched (it refuses to
start a release build, which would use them). It covers: the Notes panel and tree; real typing in a .out and
an md saved to disk; File > Save; close / quit right after typing still saving (page flush → message handlers
drained → onDidDispose); the resource boundary (outside / `..` / encoded `..` / symlink escape / other cdn host
→ 404, a sandboxed iframe can read neither note files nor the panel's own document, no Node in the page, no
navigation away, a second launch hands over); only the shipped code runs (fuses, hardened runtime, planted
`FRACTAL_EXTENSION_ROOT` / `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` / `DYLD_INSERT_LIBRARIES` load nothing); the
release build itself (`dist/mac-arm64`, started without Playwright on a temp home via `CFFIXED_USER_HOME`)
opens the note, ignores `--fractal-user-data` and quits cleanly; a note named `media` is remembered and
reopened as itself; the input box prompt; File > New Note… / Open Note Folder… / Notes; a dropped file
arriving byte for byte.
It opens real windows (they take focus), so it is not part of the normal `npm test`: the root
`playwright.config.ts` selects it only when the command line names `test/e2e-electron-app`.

Out of scope for now (not wired or not verified): S3 sync and translation (no AWS settings here — the Tools
tab shows the extension's "AWS credentials not set"), drawio in an external editor, auto update, signing,
Windows. PDF export is the extension's own (headless Chrome / Edge `--print-to-pdf`, found on the machine);
it worked once by hand but is not covered by the tests.
VS Code's standalone .md / .out editors do not exist here: "open in a VS Code tab" opens the item inside its
note when it can, else with the OS app (spec D6).
