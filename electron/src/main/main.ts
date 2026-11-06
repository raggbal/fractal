/**
 * Fractal desktop — entry (electron/package.json "main": out/main/main.js).
 * ADR-0013 / ADR-0014, spec 20261106-1312-electron-vscode-shim.
 *
 * Before 'ready': userData, the single instance lock (a second launch focuses the running app / opens
 * the note it was given), the privileged schemes. After 'ready': DesktopShell boots the extension's
 * own out/extension.js on the vscode shim and opens the Notes panel.
 *
 * Options (all optional — see launch-options.ts for which build honors which):
 *   --fractal-open-note=<dir> | FRACTAL_OPEN_NOTE   open this note folder at start
 *   --fractal-user-data=<dir> | FRACTAL_USER_DATA   profile folder (unpackaged runs and the E2E build only;
 *                                                   default: the OS app data folder)
 *   FRACTAL_EXTENSION_ROOT                          the extension folder (unpackaged runs only;
 *                                                   default: repo root / Resources/ext)
 *   FRACTAL_NO_EXTERNAL=1                           log instead of opening other apps (automated tests)
 *   FRACTAL_LANG=<lang>                             the extension's display language (default: the OS locale)
 */
import { app, dialog, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DesktopShell } from './desktop-shell';
import { PANEL_SCHEME, UI_SCHEME } from './ipc';
import { argValue, resolveLaunchOptions } from './launch-options';

/** The E2E build (electron-builder.e2e.config.js) marks its packaged package.json (inside app.asar). */
function isTestBuild(): boolean {
    if (!app.isPackaged) {
        return false;
    }
    try {
        return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).fractalTestBuild === true;
    } catch {
        return false;
    }
}

const launch = resolveLaunchOptions({
    isPackaged: app.isPackaged,
    testBuild: isTestBuild(),
    argv: process.argv,
    env: process.env,
    resourcesPath: process.resourcesPath,
    mainDir: __dirname,
});
if (launch.userData) {
    app.setPath('userData', launch.userData);
} else if (launch.devProfile) {
    // `npm start` must not share the profile of the installed app
    app.setPath('userData', path.join(app.getPath('appData'), 'Fractal-dev'));
}
app.setName('Fractal');

protocol.registerSchemesAsPrivileged([
    { scheme: PANEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
    { scheme: UI_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    run();
}

function run(): void {
    let desktop: DesktopShell | undefined;
    const requested: string[] = [];
    if (launch.openNote) {
        requested.push(launch.openNote);
    }

    // log and keep running (Electron's default is a blocking error dialog)
    process.on('uncaughtException', (err) => {
        (desktop?.log ?? console).error('[main] uncaught exception:', err);
    });
    process.on('unhandledRejection', (reason) => {
        (desktop?.log ?? console).error('[main] unhandled rejection:', reason);
    });

    // macOS: a folder dropped on the dock icon / "Open With" (before and after 'ready')
    app.on('open-file', (e, p) => {
        e.preventDefault();
        if (desktop) {
            void desktop.openRequested([p]);
        } else {
            requested.push(p);
        }
    });
    app.on('second-instance', (_e, argv, workingDirectory) => {
        const note = argValue(argv, 'fractal-open-note');
        void desktop?.openRequested(note ? [path.resolve(workingDirectory, note)] : []);
    });
    app.on('window-all-closed', () => {
        // macOS: stay in the dock (the menu and the dock icon reopen a note); elsewhere quit
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });
    app.on('activate', () => desktop?.onActivate());
    app.on('before-quit', (e) => {
        if (desktop) {
            desktop.onBeforeQuit(e);
        }
    });

    app.whenReady()
        .then(async () => {
            desktop = new DesktopShell({
                extensionRoot: launch.extensionRoot,
                userData: app.getPath('userData'),
                requestedNotes: requested,
                noExternal: process.env.FRACTAL_NO_EXTERNAL === '1',
                ignoredSwitches: launch.ignored,
            });
            await desktop.start();
        })
        .catch((err: unknown) => {
            desktop?.log.error('[main] start failed:', err);
            dialog.showErrorBox('Fractal could not start', err instanceof Error ? err.stack || err.message : String(err));
            app.exit(1);
        });
}
