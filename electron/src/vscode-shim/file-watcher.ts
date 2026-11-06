/**
 * workspace.createFileSystemWatcher on chokidar (spec D5; chokidar 4 is pure JS, no native module).
 *
 * - RelativePattern(base, glob): watches `base`. A glob without '/' or '**' watches only the direct
 *   children (depth 0) and chokidar ignores every non-matching entry, so a note folder with many
 *   files costs one directory watch plus one per matching file.
 * - Events: add/addDir → onDidCreate, change → onDidChange, unlink/unlinkDir → onDidDelete. chokidar's
 *   `atomic` mode turns "unlink + add within 100 ms" (tmp + rename saves) into a change.
 * - The event Uri for a literal pattern is exactly path.join(base, pattern) (callers compare
 *   uri.fsPath with the path they built); names are matched NFC-normalized (macOS may report NFD).
 * - A string glob relative to the (absent) workspace, or a missing base folder, gives an inert watcher.
 * - Errors are logged; they never reach the process as an unhandled 'error' event.
 */
import * as fs from 'fs';
import * as path from 'path';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { EventEmitter } from './events';
import { RelativePattern } from './types';
import { Uri, isUri } from './uri';
import type { ShimLogger } from './adapters';

function escapeRegExp(c: string): string {
    return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Small glob → RegExp on '/'-separated relative paths: **, *, ?, [..], {a,b}. */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    let group = 0;
    for (let i = 0; i < glob.length; ) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i += 2;
                if (glob[i] === '/') {
                    re += '(?:[^/]*/)*';
                    i++;
                } else {
                    re += '.*';
                }
                continue;
            }
            re += '[^/]*';
            i++;
            continue;
        }
        if (c === '?') {
            re += '[^/]';
            i++;
            continue;
        }
        if (c === '[') {
            const close = glob.indexOf(']', i + 1);
            if (close > i + 1) {
                let body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
                if (body.startsWith('!')) {
                    body = '^' + body.slice(1);
                }
                re += `[${body}]`;
                i = close + 1;
                continue;
            }
        }
        if (c === '{') {
            group++;
            re += '(?:';
            i++;
            continue;
        }
        if (c === '}' && group > 0) {
            group--;
            re += ')';
            i++;
            continue;
        }
        if (c === ',' && group > 0) {
            re += '|';
            i++;
            continue;
        }
        re += escapeRegExp(c);
        i++;
    }
    return new RegExp(`^${re}$`);
}

const GLOB_CHARS = /[*?[\]{}]/;

interface ResolvedPattern {
    base: string;
    glob: string;
    literal: boolean;
    recursive: boolean;
    matches(relPosix: string): boolean;
}

export function resolveWatchPattern(globPattern: unknown): ResolvedPattern | undefined {
    let base: string | undefined;
    let glob: string | undefined;
    if (globPattern instanceof RelativePattern) {
        base = globPattern.base;
        glob = globPattern.pattern;
    } else if (globPattern && typeof globPattern === 'object' && typeof (globPattern as RelativePattern).pattern === 'string') {
        const g = globPattern as { base?: unknown; baseUri?: unknown; pattern: string };
        base = typeof g.base === 'string' ? g.base : isUri(g.baseUri) ? g.baseUri.fsPath : undefined;
        glob = g.pattern;
    } else if (typeof globPattern === 'string' && path.isAbsolute(globPattern)) {
        // absolute string pattern: split at the first segment with glob characters
        const parts = globPattern.split('/');
        const firstGlob = parts.findIndex((p) => GLOB_CHARS.test(p));
        if (firstGlob < 0) {
            base = path.dirname(globPattern);
            glob = path.basename(globPattern);
        } else {
            base = parts.slice(0, firstGlob).join('/') || '/';
            glob = parts.slice(firstGlob).join('/');
        }
    }
    if (!base || glob === undefined) {
        return undefined;
    }
    glob = glob.replace(/\\/g, '/').replace(/^\.\//, '');
    const literal = !GLOB_CHARS.test(glob);
    const recursive = glob.includes('/') || glob.includes('**');
    const normalizedGlob = glob.normalize('NFC');
    const re = literal ? undefined : globToRegExp(normalizedGlob);
    return {
        base,
        glob,
        literal,
        recursive,
        matches: (rel: string) => {
            const n = rel.normalize('NFC');
            return literal ? n === normalizedGlob : re!.test(n);
        },
    };
}

export class ShimFileSystemWatcher {
    private readonly _onDidCreate = new EventEmitter<Uri>();
    private readonly _onDidChange = new EventEmitter<Uri>();
    private readonly _onDidDelete = new EventEmitter<Uri>();
    readonly onDidCreate = this._onDidCreate.event;
    readonly onDidChange = this._onDidChange.event;
    readonly onDidDelete = this._onDidDelete.event;
    readonly ignoreCreateEvents: boolean;
    readonly ignoreChangeEvents: boolean;
    readonly ignoreDeleteEvents: boolean;
    /** Shim-internal: resolves when the initial scan finished (events before it are not reported). */
    readonly ready: Promise<void>;

    private watcher: FSWatcher | undefined;
    private disposed = false;

    constructor(
        pattern: ResolvedPattern | undefined,
        ignoreCreate: boolean,
        ignoreChange: boolean,
        ignoreDelete: boolean,
        private readonly log: ShimLogger,
        private readonly onDispose: (w: ShimFileSystemWatcher) => void
    ) {
        this.ignoreCreateEvents = ignoreCreate;
        this.ignoreChangeEvents = ignoreChange;
        this.ignoreDeleteEvents = ignoreDelete;
        if (!pattern) {
            this.ready = Promise.resolve();
            return;
        }
        let isDir = false;
        try {
            isDir = fs.statSync(pattern.base).isDirectory();
        } catch {
            isDir = false;
        }
        if (!isDir) {
            this.log.warn(`[vscode-shim] file watcher: base folder does not exist: ${pattern.base}`);
            this.ready = Promise.resolve();
            return;
        }
        const base = pattern.base;
        const relOf = (p: string) => path.relative(base, p).split(path.sep).join('/');
        const watcher = chokidarWatch(base, {
            ignoreInitial: true,
            persistent: true,
            followSymlinks: true,
            ignorePermissionErrors: true,
            atomic: true,
            depth: pattern.recursive ? undefined : 0,
            ignored: pattern.recursive
                ? undefined
                : (p: string) => {
                      if (p === base) {
                          return false;
                      }
                      const rel = relOf(p);
                      return rel.includes('/') || !pattern.matches(rel);
                  },
        });
        this.watcher = watcher;
        const toUri = (p: string): Uri | undefined => {
            if (p === base) {
                return undefined;
            }
            const rel = relOf(p);
            if (rel.startsWith('../') || !pattern.matches(rel)) {
                return undefined;
            }
            return Uri.file(pattern.literal ? path.join(base, pattern.glob) : p);
        };
        const fire = (emitter: EventEmitter<Uri>, ignored: boolean) => (p: string) => {
            if (this.disposed || ignored) {
                return;
            }
            const uri = toUri(p);
            if (uri) {
                emitter.fire(uri);
            }
        };
        watcher.on('add', fire(this._onDidCreate, ignoreCreate));
        watcher.on('addDir', fire(this._onDidCreate, ignoreCreate));
        watcher.on('change', fire(this._onDidChange, ignoreChange));
        watcher.on('unlink', fire(this._onDidDelete, ignoreDelete));
        watcher.on('unlinkDir', fire(this._onDidDelete, ignoreDelete));
        watcher.on('error', (err: unknown) => {
            this.log.warn(`[vscode-shim] file watcher error (${base}):`, err);
        });
        this.ready = new Promise<void>((resolve) => {
            watcher.once('ready', () => resolve());
        });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const w = this.watcher;
        this.watcher = undefined;
        if (w) {
            w.close().catch((err: unknown) => this.log.warn('[vscode-shim] file watcher close failed:', err));
        }
        this._onDidCreate.dispose();
        this._onDidChange.dispose();
        this._onDidDelete.dispose();
        this.onDispose(this);
    }
}

export class FileWatcherService {
    private readonly live = new Set<ShimFileSystemWatcher>();

    constructor(private readonly log: ShimLogger) {}

    createFileSystemWatcher(
        globPattern: unknown,
        ignoreCreateEvents = false,
        ignoreChangeEvents = false,
        ignoreDeleteEvents = false
    ): ShimFileSystemWatcher {
        const pattern = resolveWatchPattern(globPattern);
        if (!pattern) {
            this.log.warn('[vscode-shim] file watcher: pattern without an absolute base (no workspace) is not watched:', globPattern);
        }
        const w = new ShimFileSystemWatcher(pattern, !!ignoreCreateEvents, !!ignoreChangeEvents, !!ignoreDeleteEvents, this.log, (x) =>
            this.live.delete(x)
        );
        this.live.add(w);
        return w;
    }

    get size(): number {
        return this.live.size;
    }

    dispose(): void {
        for (const w of Array.from(this.live)) {
            w.dispose();
        }
        this.live.clear();
    }
}
