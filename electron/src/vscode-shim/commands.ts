/**
 * commands.registerCommand / executeCommand with VS Code's ExtHostCommands semantics:
 * - registering an id twice throws; the Disposable unregisters.
 * - executeCommand runs a registered handler synchronously (an async handler starts before
 *   executeCommand returns) and resolves to its (awaited) result; a throw becomes a rejection.
 * - unknown ids reject with "command 'x' not found".
 * Built-in VS Code commands the extension calls are handled here (spec D6):
 *   setContext → stored + onDidChangeContext (the shell's when-clauses read it), vscode.open / vscode.openWith → OpenerAdapter
 *   (default: OS app), revealFileInOS → Finder, workbench.* → host hook (default no-op),
 *   undo / redo / vscode.diff → no-op.
 */
import { Disposable, EventEmitter } from './events';
import { isUri, Uri } from './uri';
import type { OpenerAdapter, ShellAdapter, ShimLogger } from './adapters';

type Handler = (...args: unknown[]) => unknown;

const BUILTIN_NOOP = new Set(['undo', 'redo', 'cursorUndo', 'cursorRedo', 'vscode.diff', 'editor.action.formatDocument']);

export interface CommandServices {
    log: ShimLogger;
    shell: ShellAdapter;
    opener: OpenerAdapter;
    workbench?: (id: string, args: unknown[]) => Promise<unknown> | unknown;
}

export class CommandRegistry {
    private readonly handlers = new Map<string, { callback: Handler; thisArg: unknown }>();
    /** setContext keys (the shell evaluates its sidebar's when-clauses against them). */
    readonly contextKeys = new Map<string, unknown>();
    /** Shim-only hook: fires before any command runs (the shell remembers the last opened note this way). */
    readonly onWillExecuteCommand = new EventEmitter<{ command: string; args: readonly unknown[] }>();
    /** Shim-only hook: a setContext call changed a key's value (the key). */
    readonly onDidChangeContext = new EventEmitter<string>();

    constructor(private readonly services: CommandServices) {}

    registerCommand(id: string, callback: Handler, thisArg?: unknown): Disposable {
        if (!id || typeof id !== 'string' || !id.trim()) {
            throw new Error('invalid id');
        }
        if (typeof callback !== 'function') {
            throw new Error('invalid callback');
        }
        if (this.handlers.has(id)) {
            throw new Error(`command '${id}' already exists`);
        }
        const entry = { callback, thisArg };
        this.handlers.set(id, entry);
        return new Disposable(() => {
            if (this.handlers.get(id) === entry) {
                this.handlers.delete(id);
            }
        });
    }

    has(id: string): boolean {
        return this.handlers.has(id);
    }

    async executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
        this.onWillExecuteCommand.fire({ command: id, args });
        const entry = this.handlers.get(id);
        if (entry) {
            return (await entry.callback.apply(entry.thisArg, args)) as T;
        }
        return (await this.executeBuiltin(id, args)) as T;
    }

    async getCommands(filterInternal = false): Promise<string[]> {
        const ids = [...this.handlers.keys(), 'setContext', 'vscode.open', 'vscode.openWith', 'revealFileInOS', ...BUILTIN_NOOP];
        return filterInternal ? ids.filter((id) => !id.startsWith('_')) : ids;
    }

    private async executeBuiltin(id: string, args: unknown[]): Promise<unknown> {
        const { log, shell, opener } = this.services;
        switch (id) {
            case 'setContext': {
                const [key, value] = args;
                if (typeof key === 'string') {
                    const had = this.contextKeys.has(key);
                    const before = this.contextKeys.get(key);
                    this.contextKeys.set(key, value);
                    // objects / arrays may have changed inside: always report them
                    if (!had || before !== value || (value !== null && typeof value === 'object')) {
                        this.onDidChangeContext.fire(key);
                    }
                }
                return undefined;
            }
            case 'vscode.open': {
                const uri = toUri(args[0]);
                if (!uri) {
                    throw new Error("Invalid argument for 'vscode.open': expected a Uri");
                }
                await opener.open({ command: 'vscode.open', uri });
                return undefined;
            }
            case 'vscode.openWith': {
                const uri = toUri(args[0]);
                if (!uri) {
                    throw new Error("Invalid argument for 'vscode.openWith': expected a Uri");
                }
                await opener.open({ command: 'vscode.openWith', uri, viewType: typeof args[1] === 'string' ? args[1] : undefined });
                return undefined;
            }
            case 'revealFileInOS': {
                const uri = toUri(args[0]);
                if (uri && uri.scheme === 'file') {
                    shell.showItemInFolder(uri.fsPath);
                }
                return undefined;
            }
            default:
                break;
        }
        if (id.startsWith('workbench.')) {
            if (this.services.workbench) {
                return this.services.workbench(id, args);
            }
            log.info(`[vscode-shim] ${id}: no-op in the desktop app`);
            return undefined;
        }
        if (BUILTIN_NOOP.has(id)) {
            log.info(`[vscode-shim] ${id}: no-op in the desktop app`);
            return undefined;
        }
        log.warn(`[vscode-shim] command '${id}' not found`);
        throw new Error(`command '${id}' not found`);
    }
}

function toUri(v: unknown): Uri | undefined {
    if (isUri(v)) {
        return v;
    }
    if (typeof v === 'string' && v) {
        return v.startsWith('/') ? Uri.file(v) : Uri.parse(v);
    }
    return undefined;
}

/** D6 default: local files open with the OS default app, web links in the browser. */
export function createDefaultOpener(shell: ShellAdapter, log: ShimLogger): OpenerAdapter {
    return {
        open: async ({ command, uri, viewType }) => {
            if (uri.scheme === 'file') {
                const err = await shell.openPath(uri.fsPath);
                if (err) {
                    log.warn(`[vscode-shim] ${command}(${uri.fsPath}${viewType ? `, ${viewType}` : ''}) failed: ${err}`);
                }
                return;
            }
            if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
                await shell.openExternal(encodeURI(uri.toString(true)));
                return;
            }
            log.warn(`[vscode-shim] ${command}: refusing to open ${uri.scheme}: URI`);
        },
    };
}
