# Fractal desktop (Electron)

Runs the VS Code extension's own Notes code (`../out/extension.js`, webview, media, vendor) unchanged on a
`vscode` API shim in the Electron main process — ADR-0013 / ADR-0014, specs `20261106-1312-electron-vscode-shim`
and `20261107-0431-electron-sidebar` (the window model and the sidebar).

- `src/vscode-shim/` — the `vscode` module (`require('vscode')` resolves here). No Electron imports.
  `window.createTreeView` / `registerTreeDataProvider` register `{ id, treeDataProvider, dragAndDropController }`
  for the shell (`controller.treeViews()`, a TreeView with title / description / message / visible / selection /
  reveal and their events); `setContext` keys are kept for the sidebar's when-clauses.
- `src/main/` — the shell: lifecycle; a window (`app-window.ts`, a BaseWindow) = the sidebar on the left
  (`sidebar-view.ts`, a WebContentsView) + one WebContentsView per webview panel on the right (`panel-host.ts`);
  the sidebar model and page assets (`sidebar-contributes.ts`, `sidebar-model.ts`, `sidebar-icons.ts`,
  `sidebar-assets.ts` — no Electron imports, unit-tested); dialogs / messages / prompts (`ui.ts`,
  `prompt-window.ts`), menu, D6 opener, the theme (`theme.ts`; `theme-vars.ts` = the note views' `--vscode-*`
  variables, `design-tokens.ts` = the Fractal design the shell's own pages use).
- `src/renderer/` — sandboxed preloads (a note page gets `acquireVsCodeApi()` only, the sidebar page
  `window.fractalSidebar` only), the sidebar page and the prompt page.

## Windows and the sidebar

A window shows the sidebar on the left and one note on the right. The sidebar is VS Code's Fractal List
(`notesLists`) and Notes (`notesExplorer`) views: their items come from the extension's own tree data providers,
and their titles, header buttons (`view/title`), row buttons (`view/item/context` `inline`), right-click menus (the
other `view/item/context` groups), welcome content (`viewsWelcome`) and icons from the root `package.json`
`contributes` (when-clauses: `view`, `viewItem` and setContext keys such as `fractal.hasNotesRegistry`; a clause
outside that subset hides its entry). A click runs the item's `TreeItem.command`.

- Choosing a note shows it in the same window; the notes a window opened stay alive behind it (choosing one again
  shows it at once, as it was). Open notes have a ● left of their name; on the ● it is a × that closes the note
  (its pending edits are flushed first). Right-click > Close Note and File > Close Note (Cmd+W) do the same for
  the shown note (Cmd+W / Shift+Cmd+W act on the key window only — with no window of the app key, e.g. the
  window minimized or About in front, no note closes); then the window shows the last viewed open note, or an
  empty view. The row's right-end × is the
  extension's Remove from Notes (the list changes, the note stays open — as in VS Code).
- Right-click > Open in New Window: a second window with its own sidebar shows that note (an open note moves
  there, page and all; a note whose close is still under way opens there once it is closed). A note that is open
  in another window is brought forward there.
- The sidebar collapses to a 28px bar (its top-right button, or View > Toggle Sidebar, Alt+Cmd+B) and its right
  edge drags between 180 and 480px. Collapsed / width / which sections are expanded are saved
  (`<userData>/desktop-state.json`) and used by the next window and the next start. The note always gets the rest
  of the window (never less than 320px).
- Window > lists the open notes (also those outside the active .fractal). The window title is the shown note's.
- Look: the sidebar, the prompt sheet and the toasts use the Fractal design (`docs/design/modern-2026.md` §14, the
  same as the note's own left panel). The sidebar and prompt pages load the extension's own `out/webview/tokens.css`
  and `fr-base.css` — the files the note views load, read, not copied (`design-tokens.ts`), so another design in
  tokens.css reaches the app with the next build — and read only their `--fr-*` tokens; the toasts read the note
  page's. The colors the views paint before their page are tokens.css's `bg-app` / `bg-panel` / `bg-elevated`.
  Light / dark follow `fractal.theme`, else the OS appearance. The note views also get the `--vscode-*` variables
  VS Code would inject (Light / Dark Modern values, `theme-vars.ts`).
- Not yet (spec D5): drag and drop in the lists (reorder, drop a folder to add), searching the lists, nested items.

Security (spec D4): the sidebar page is sandboxed with contextIsolation and no Node, served from its own
in-memory session (`fractal-ui://sidebar/index.html`, a CSP that allows only its own script and style; it never
navigates or opens anything). Its preload exposes only: the list model; run the `TreeItem.command` of an item the
page was given, or a header / row button / welcome link the page was given (both by opaque handle / token — the
page never sends a command id; the main process maps them to what `package.json` declares, for the snapshot the
page shows or the one before it, and refuses anything else); a row's native menu; close an open note; and the
sidebar's own state. Every IPC message is answered only for the top frame of that window's sidebar page.

## Build and run

```sh
npm install                  # once (Electron 45; postinstall downloads the binary)
npm run build:app-dir        # extension compile + shell build + dist/mac-arm64/Fractal.app (ad-hoc signed)
open dist/mac-arm64/Fractal.app
npm run build:mac            # the same as dist/Fractal-mac-arm64.zip (what a release ships)
npm run build:e2e            # the E2E build in dist/e2e/mac-arm64 (for the tests only, see below; pack:e2e = without recompiling)
npm start                    # dev: compile, then run from this folder (profile: ~/Library/Application Support/Fractal-dev)
npm run start:fast           # dev without recompiling the extension (after a root `npm run compile`)
```

The app's version is the extension's (`electron-builder.config.js` takes it from the root `package.json`), so a
release bumps only that one.

The app you use (`build:app-dir` / `build:mac`) runs only the code it ships: Electron's fuses turn off
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` and check `app.asar`, it is signed (ad-hoc) with the
hardened runtime (`DYLD_*` ignored; `build/entitlements.mac.plist`), and it ignores the development switches
below — also Chromium's `--remote-debugging-port` / `--remote-debugging-pipe` (no fuse covers them; they would
open every page of the app, the notes it shows, to the DevTools protocol), so it opens no DevTools endpoint. So
another local process cannot run its own code inside Fractal, or drive its pages, with the macOS privacy
permissions you gave the app (Documents, Desktop, iCloud Drive…).

First start opens the first note of the active notes list (`~/.fractal/default.fractal`, created or reused by
the extension) — with an empty list the sidebar shows the extension's welcome content; later starts reopen the
notes that were open, in the windows they were in. The sidebar, and File > Open Note Folder… / New Note… / Notes /
Notes Lists, switch notes. Settings: Fractal > Settings… (`<userData>/User/settings.json`, same
`fractal.*` keys as VS Code — VS Code's own settings are not read). Logs: Help > Open Logs Folder.

Options: `--fractal-open-note=<dir>` (or `FRACTAL_OPEN_NOTE`) note to open, `FRACTAL_LANG`,
`FRACTAL_NO_EXTERNAL=1` (log instead of opening the browser / Finder — tests). Development / test only
(`src/main/launch-options.ts`): `FRACTAL_EXTENSION_ROOT` (unpackaged runs), `--fractal-user-data=<dir>` (or
`FRACTAL_USER_DATA`) profile folder (unpackaged runs and the E2E build), `--remote-debugging-port` /
`--remote-debugging-pipe` (unpackaged runs and the E2E build: Playwright drives the pages through it).

## Release (GitHub)

macOS, Apple Silicon only (Intel Macs, Windows and Linux are not built or verified). The build is ad-hoc signed
with the hardened runtime, not signed with a Developer ID nor notarized: macOS blocks its first launch on another
Mac until the user allows it (System Settings → Privacy & Security → Open Anyway, or
`xattr -dr com.apple.quarantine /Applications/Fractal.app`). The website (`site/`, deployed by
`.github/workflows/pages.yml`) explains it and links the zip as `releases/latest/download/Fractal-mac-arm64.zip`,
so the asset name must stay the same.

```sh
cd electron
npm run test:e2e                     # both E2E specs on the release and E2E builds
npm run build:mac                    # dist/Fractal-mac-arm64.zip
cd .. && git tag -a v<version> -m "Fractal <version>" && git push origin main v<version>
gh release create v<version> electron/dist/Fractal-mac-arm64.zip --title "Fractal <version>" --notes-file <notes>
```

The old `.github/workflows/release-electron.yml` (tags `electron-v*`, also Windows / Linux) predates this app; it is
not used.

## Tests

```sh
# from the repo root
npx playwright test test/unit/electron-vscode-shim.spec.ts                        # shim (AC-2, AC-3), headless, plain Node
npx playwright test test/unit/electron-sidebar.spec.ts                            # sidebar model / contributes / when / IPC rule (sidebar AC-3)
(cd electron && npm run build:e2e) && npx playwright test test/e2e-electron-app    # both E2E specs on the built Fractal.app (E2E build)
FRACTAL_E2E_DEV=1 npx playwright test test/e2e-electron-app                        # the same on the dev build (after `npm run build:shim`)
# from electron/
npm run test:e2e                                                                   # build:app-dir + pack:e2e, then both E2E specs
```

The unit specs need only the root `npm install` (vscode-uri, chokidar and jsonc-parser are root
devDependencies too); they are part of the normal extension test run. `electron-sidebar.spec.ts` also boots the
real `out/extension.js` on the shim in a child process (temp HOME) and drives its own tree views through the
sidebar model (header button → the extension's command → a new row → its `TreeItem.command` opens the note).

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
opens the note, ignores `--fractal-user-data`, opens no DevTools endpoint for `--remote-debugging-port=0` /
`--remote-debugging-pipe` (no listening socket, no `DevToolsActivePort`, no reply on the pipe) and quits cleanly; a note named `media` is remembered and
reopened as itself; the input box prompt; File > New Note… / Open Note Folder… / Notes; a dropped file
arriving byte for byte.

`test/e2e-electron-app/sidebar.spec.ts` (sidebar AC-2 / AC-2b, same E2E build and fixtures; launch and
window-model helpers shared with notes-smoke in `test/e2e-electron-app/harness.ts`) covers: Fractal List and
Notes with the package.json titles / buttons / tooltips / icons; choosing a note switches inside the one window
and the previous note's page comes back unreloaded; the 28px bar and the note's wider bounds; collapsed and the
dragged width survive a restart; New Note… / Reveal / Remove / welcome buttons run the extension's commands;
right-click (native menu, captured) Open in New Window, also moving an open note's page; the welcome content of
an empty Fractal List / Notes (when-clauses); the light / dark look from the note views' own design tokens; the ● / ×
close with the typed text saved, the last viewed note or the empty view after it, right-click Close Note and Cmd+W;
Cmd+W / Shift+Cmd+W with no key window (minimized) closing nothing; Open in New Window on a note whose close is
under way; a message from a window that shows no note as a message box there (not a toast in another window's
note); a sidebar update during an edge drag; the drag in a window too narrow for the saved width.

The E2E specs open real windows (they take focus), so they are not part of the normal `npm test`: the root
`playwright.config.ts` selects them only when the command line names `test/e2e-electron-app`.

Out of scope for now (not wired or not verified): S3 sync and translation (no AWS settings here — the Tools
tab shows the extension's "AWS credentials not set"), drawio in an external editor, auto update, signing,
Windows. PDF export is the extension's own (headless Chrome / Edge `--print-to-pdf`, found on the machine);
it worked once by hand but is not covered by the tests.
VS Code's standalone .md / .out editors do not exist here: "open in a VS Code tab" opens the item inside its
note when it can, else with the OS app (spec D6).
Non-modal messages (VS Code's notifications) are toasts in the note the window you work in shows; while it shows
none (the empty view) they are message boxes on it — never toasts in another window's note.
