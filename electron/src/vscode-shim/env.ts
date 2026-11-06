/**
 * The `env` namespace.
 * - language: lazy (Electron's app.getLocale() is valid only after 'ready'); lowercased, 'en' if empty.
 * - remoteName: undefined (a local window).
 * - clipboard: the injected adapter (Electron clipboard).
 * - openExternal: http / https / mailto go to the OS browser / mail client (VS Code's
 *   encodeURI(uri.toString(true))); file: opens with the OS default app (VS Code opens attachments
 *   this way); any other scheme is refused and resolves false — the webview never navigates and no
 *   other URL handler is launched.
 */
import * as crypto from 'crypto';
import { EventEmitter, NoneEvent } from './events';
import { Uri, isUri } from './uri';
import { LogLevel, UIKind } from './types';
import type { ClipboardAdapter, EnvAdapter, ShellAdapter, ShimLogger } from './adapters';

export interface EnvServices {
    env: EnvAdapter;
    clipboard: ClipboardAdapter;
    shell: ShellAdapter;
    log: ShimLogger;
    appRoot: string;
}

export async function openExternalWithPolicy(target: unknown, shell: ShellAdapter, log: ShimLogger): Promise<boolean> {
    let uri: Uri;
    try {
        uri = isUri(target) ? target : Uri.parse(String(target));
    } catch {
        log.warn('[vscode-shim] openExternal: not a URI:', target);
        return false;
    }
    const scheme = uri.scheme.toLowerCase();
    try {
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
            await shell.openExternal(encodeURI(uri.toString(true)));
            return true;
        }
        if (scheme === 'file') {
            const err = await shell.openPath(uri.fsPath);
            if (err) {
                log.warn(`[vscode-shim] openExternal(${uri.fsPath}) failed: ${err}`);
                return false;
            }
            return true;
        }
    } catch (err) {
        log.warn(`[vscode-shim] openExternal(${uri.toString()}) failed:`, err);
        return false;
    }
    log.warn(`[vscode-shim] openExternal: refusing to open a ${scheme}: URI`);
    return false;
}

export function createEnvNamespace(s: EnvServices) {
    const sessionId = crypto.randomUUID();
    const machineId = crypto.createHash('sha256').update(`fractal-desktop:${s.appRoot}`).digest('hex');
    const onDidChangeTelemetryEnabled = new EventEmitter<boolean>();
    const onDidChangeLogLevel = new EventEmitter<number>();
    return {
        get language(): string {
            let lang = '';
            try {
                lang = String(s.env.language() || '');
            } catch {
                lang = '';
            }
            return lang.toLowerCase() || 'en';
        },
        appName: 'Fractal',
        appRoot: s.appRoot,
        appHost: 'desktop',
        uriScheme: 'fractal',
        uiKind: UIKind.Desktop,
        remoteName: undefined as string | undefined,
        remoteAuthority: undefined as string | undefined,
        machineId,
        sessionId,
        isNewAppInstall: false,
        isTelemetryEnabled: false,
        onDidChangeTelemetryEnabled: onDidChangeTelemetryEnabled.event,
        logLevel: LogLevel.Info,
        onDidChangeLogLevel: onDidChangeLogLevel.event,
        onDidChangeShell: NoneEvent,
        shell: process.env.SHELL || '',
        clipboard: {
            readText: (): Promise<string> => Promise.resolve(s.clipboard.readText()),
            writeText: (value: string): Promise<void> => Promise.resolve(s.clipboard.writeText(String(value ?? ''))),
        },
        openExternal: (target: Uri): Promise<boolean> => openExternalWithPolicy(target, s.shell, s.log),
        asExternalUri: (target: Uri): Promise<Uri> => Promise.resolve(target),
        createTelemetryLogger: () => ({
            logUsage: () => undefined,
            logError: () => undefined,
            dispose: () => undefined,
            onDidChangeEnableStates: NoneEvent,
            isUsageEnabled: false,
            isErrorsEnabled: false,
        }),
    };
}
