/**
 * The command-line / environment switches of the desktop app (main.ts). No Electron import: unit-
 * tested headless (test/unit/electron-vscode-shim.spec.ts).
 *
 * Switches that change WHICH CODE runs or WHICH PROFILE is used are for development and tests only.
 * A packaged app ignores them (main.ts logs them), so no other local process can start Fractal.app
 * with its own code or a crafted profile and run under Fractal's identity, with the macOS privacy
 * grants the user gave the app (Documents, Desktop, iCloud Drive…):
 *   FRACTAL_EXTENSION_ROOT                     the folder whose out/extension.js the main process
 *                                              require()s: unpackaged runs only
 *   --fractal-user-data=<dir> | FRACTAL_USER_DATA
 *                                              the profile folder: unpackaged runs and the E2E build
 *                                              (electron-builder.e2e.config.js sets
 *                                              package.json "fractalTestBuild": true)
 * The release build also turns off Electron's RunAsNode / NODE_OPTIONS / --inspect fuses
 * (package.json build.electronFuses).
 * Harmless everywhere: --fractal-open-note=<dir> | FRACTAL_OPEN_NOTE (a note to open),
 * FRACTAL_NO_EXTERNAL=1, FRACTAL_LANG.
 */
import * as path from 'path';

export interface LaunchContext {
    isPackaged: boolean;
    /** The packaged app is the E2E build (package.json "fractalTestBuild": true inside app.asar). */
    testBuild: boolean;
    argv: readonly string[];
    env: Readonly<Record<string, string | undefined>>;
    /** process.resourcesPath */
    resourcesPath: string;
    /** __dirname of out/main/main.js */
    mainDir: string;
}

export interface LaunchOptions {
    /** Folder with out/extension.js, out/webview, media/, vendor/ and package.json. */
    extensionRoot: string;
    /** Profile folder to use instead of Electron's default; undefined = the default. */
    userData?: string;
    /** Unpackaged run without an explicit profile: use the separate "Fractal-dev" profile. */
    devProfile: boolean;
    /** A note folder to open at start. */
    openNote?: string;
    /** Switches that were given but are not honored by this build (to log). */
    ignored: string[];
}

export function argValue(argv: readonly string[], name: string): string | undefined {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
}

export function resolveLaunchOptions(ctx: LaunchContext): LaunchOptions {
    const ignored: string[] = [];
    const env = ctx.env;

    let extensionRoot: string;
    if (!ctx.isPackaged && env.FRACTAL_EXTENSION_ROOT) {
        extensionRoot = path.resolve(env.FRACTAL_EXTENSION_ROOT);
    } else if (ctx.isPackaged) {
        if (env.FRACTAL_EXTENSION_ROOT) {
            ignored.push('FRACTAL_EXTENSION_ROOT');
        }
        extensionRoot = path.join(ctx.resourcesPath, 'ext');
    } else {
        // dev: electron/out/main/main.js → the repo root (out/extension.js, out/webview, media, vendor)
        extensionRoot = path.resolve(ctx.mainDir, '..', '..', '..');
    }

    const userDataArg = argValue(ctx.argv, 'fractal-user-data');
    const userDataEnv = env.FRACTAL_USER_DATA;
    let userData: string | undefined;
    if (!ctx.isPackaged || ctx.testBuild) {
        const chosen = userDataArg || userDataEnv;
        userData = chosen ? path.resolve(chosen) : undefined;
    } else {
        if (userDataArg) {
            ignored.push('--fractal-user-data');
        }
        if (userDataEnv) {
            ignored.push('FRACTAL_USER_DATA');
        }
    }

    const openNote = argValue(ctx.argv, 'fractal-open-note') || env.FRACTAL_OPEN_NOTE;
    return {
        extensionRoot,
        userData,
        devProfile: !ctx.isPackaged && !userData,
        openNote: openNote ? path.resolve(openNote) : undefined,
        ignored,
    };
}
