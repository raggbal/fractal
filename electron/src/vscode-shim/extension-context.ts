/**
 * vscode.ExtensionContext for the bundled extension.
 * extensionUri / extensionPath = the folder that holds out/, media/, vendor/ and package.json
 * (dev: the repo root; packaged: <Resources>/ext). Storage lives in the app's userData folder:
 *   globalState.json, workspaceState.json, globalStorage/<extensionId>/, logs/<extensionId>/.
 * storageUri is undefined like VS Code without a workspace.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Uri } from './uri';
import { EventEmitter } from './events';
import { ExtensionKind, ExtensionMode } from './types';
import type { FileMemento } from './memento';

export interface ExtensionContextOptions {
    extensionRoot: string;
    userDataDir: string;
    extensionId: string;
    globalState: FileMemento;
    workspaceState: FileMemento;
}

export interface ShimExtensionContext {
    subscriptions: Array<{ dispose(): unknown }>;
    extensionUri: Uri;
    extensionPath: string;
    asAbsolutePath(relativePath: string): string;
    globalState: FileMemento;
    workspaceState: FileMemento;
    secrets: unknown;
    globalStorageUri: Uri;
    globalStoragePath: string;
    storageUri: Uri | undefined;
    storagePath: string | undefined;
    logUri: Uri;
    logPath: string;
    extensionMode: number;
    extension: unknown;
    environmentVariableCollection: unknown;
    languageModelAccessInformation: unknown;
}

export function createExtensionContext(o: ExtensionContextOptions): ShimExtensionContext {
    const extensionPath = path.resolve(o.extensionRoot);
    const globalStoragePath = path.join(o.userDataDir, 'globalStorage', o.extensionId);
    const logPath = path.join(o.userDataDir, 'logs', o.extensionId);
    let packageJSON: unknown = {};
    try {
        packageJSON = JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
    } catch {
        packageJSON = {};
    }
    const secretsEmitter = new EventEmitter<{ key: string }>();
    const secretValues = new Map<string, string>();
    const extensionUri = Uri.file(extensionPath);
    return {
        subscriptions: [],
        extensionUri,
        extensionPath,
        asAbsolutePath: (relativePath: string) => path.join(extensionPath, relativePath),
        globalState: o.globalState,
        workspaceState: o.workspaceState,
        // in memory only: the desktop app keeps no credentials store yet (S3 / translate are out of scope)
        secrets: {
            get: async (key: string) => secretValues.get(key),
            store: async (key: string, value: string) => {
                secretValues.set(key, value);
                secretsEmitter.fire({ key });
            },
            delete: async (key: string) => {
                secretValues.delete(key);
                secretsEmitter.fire({ key });
            },
            keys: async () => Array.from(secretValues.keys()),
            onDidChange: secretsEmitter.event,
        },
        globalStorageUri: Uri.file(globalStoragePath),
        globalStoragePath,
        storageUri: undefined,
        storagePath: undefined,
        logUri: Uri.file(logPath),
        logPath,
        extensionMode: ExtensionMode.Production,
        extension: {
            id: o.extensionId,
            extensionUri,
            extensionPath,
            isActive: true,
            packageJSON,
            extensionKind: ExtensionKind.UI,
            exports: undefined,
            activate: async () => undefined,
        },
        environmentVariableCollection: {
            persistent: false,
            description: undefined,
            replace: () => undefined,
            append: () => undefined,
            prepend: () => undefined,
            get: () => undefined,
            forEach: () => undefined,
            delete: () => undefined,
            clear: () => undefined,
            getScoped: () => undefined,
        },
        languageModelAccessInformation: {
            onDidChange: new EventEmitter<void>().event,
            canSendRequest: () => undefined,
        },
    };
}
