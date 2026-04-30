/**
 * DrawioWatcherRegistry — `*.drawio.svg` / `*.drawio.png` の外部編集を監視する
 * 独立 module。既存 `editorProvider.ts:704-744` の fileWatcher / fileChangeSubscription
 * とは完全分離され、NT-14 / OL-22 / MD-24 の document 同期経路には触れない。
 *
 * 設計:
 *   - 双方向 Map で参照を管理:
 *       references: drawioPath -> Set<mdPath>
 *       mdToRefs:   mdPath -> Set<drawioPath>
 *   - mdPath が drawio path を新規参照したら個別 watcher を作成、
 *     全 mdPath が参照を外したら watcher を dispose
 *   - watcher.onDidChange 発火を debounceMs (default 200) でまとめ、
 *     最後の発火から debounceMs 後に opts.onChange(drawioPath, mdPaths[]) を呼ぶ
 *
 * vscode への型依存を避けるため createFileSystemWatcher の戻り値は
 * 最小限の interface (DrawioFileWatcher) に絞る — テスト時に mock しやすくする。
 *
 * Reference: PoC `.harness/poc/.../code/scripts/drawio-watcher-design.js`
 */

export interface DrawioFileWatcher {
    onDidChange(handler: () => void): { dispose: () => void };
    onDidCreate?(handler: () => void): { dispose: () => void };
    dispose(): void;
}

export interface DrawioWatcherOptions {
    /** vscode.workspace.createFileSystemWatcher 互換 */
    createFileSystemWatcher: (drawioPath: string) => DrawioFileWatcher;
    /** debounce window in ms, default 200 */
    debounceMs?: number;
    /** drawio file が変更された時に呼ばれる */
    onChange: (drawioPath: string, mdPaths: string[]) => void;
}

interface WatcherEntry {
    watcher: DrawioFileWatcher;
    listener: { dispose: () => void };
    createListener: { dispose: () => void } | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
}

export class DrawioWatcherRegistry {
    private readonly opts: DrawioWatcherOptions;
    private readonly debounceMs: number;
    /** drawioPath -> Set<mdPath> */
    private readonly references = new Map<string, Set<string>>();
    /** mdPath -> Set<drawioPath> */
    private readonly mdToRefs = new Map<string, Set<string>>();
    /** drawioPath -> watcher entry */
    private readonly watchers = new Map<string, WatcherEntry>();
    private disposed = false;

    constructor(opts: DrawioWatcherOptions) {
        this.opts = opts;
        this.debounceMs = opts.debounceMs ?? 200;
    }

    /**
     * mdPath が現時点で参照する drawio paths をセットする。
     * 内部で前回参照との diff を計算し、新規参照なら watcher を作成、
     * 削除参照かつ他の md が参照していなければ watcher を dispose する。
     */
    setReferences(mdPath: string, drawioPaths: string[]): void {
        if (this.disposed) return;

        const newSet = new Set<string>(drawioPaths);
        const oldSet = this.mdToRefs.get(mdPath) || new Set<string>();

        // 削除分: oldSet にあるが newSet にないもの
        for (const dp of oldSet) {
            if (!newSet.has(dp)) {
                this._removeReference(mdPath, dp);
            }
        }

        // 追加分: newSet にあるが oldSet にないもの
        for (const dp of newSet) {
            if (!oldSet.has(dp)) {
                this._addReference(mdPath, dp);
            }
        }

        if (newSet.size === 0) {
            this.mdToRefs.delete(mdPath);
        } else {
            this.mdToRefs.set(mdPath, newSet);
        }
    }

    /**
     * mdPath が close された時に呼び出して全参照を解除する
     */
    removeMd(mdPath: string): void {
        if (this.disposed) return;
        const oldSet = this.mdToRefs.get(mdPath);
        if (!oldSet) return;
        for (const dp of oldSet) {
            this._removeReference(mdPath, dp);
        }
        this.mdToRefs.delete(mdPath);
    }

    /**
     * 全 watcher を破棄する。debounce timer も clearTimeout する。
     */
    disposeAll(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const entry of this.watchers.values()) {
            try { entry.listener.dispose(); } catch { /* ignore */ }
            if (entry.createListener) { try { entry.createListener.dispose(); } catch { /* ignore */ } }
            try { entry.watcher.dispose(); } catch { /* ignore */ }
            if (entry.debounceTimer) {
                clearTimeout(entry.debounceTimer);
                entry.debounceTimer = null;
            }
        }
        this.watchers.clear();
        this.references.clear();
        this.mdToRefs.clear();
    }

    /** test 用: watcher 数 */
    _watcherCount(): number {
        return this.watchers.size;
    }

    /** test 用: drawioPath -> mdPaths のスナップショット */
    _snapshot(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [k, v] of this.references) out[k] = Array.from(v);
        return out;
    }

    private _addReference(mdPath: string, drawioPath: string): void {
        let mds = this.references.get(drawioPath);
        if (!mds) {
            mds = new Set<string>();
            this.references.set(drawioPath, mds);
        }
        if (!mds.has(mdPath)) {
            mds.add(mdPath);
        }

        if (!this.watchers.has(drawioPath)) {
            try {
                const watcher = this.opts.createFileSystemWatcher(drawioPath);
                const listener = watcher.onDidChange(() => this._fire(drawioPath));
                // drawio Desktop 等が「temp 書き込み + rename」で保存する場合、
                // onDidChange では拾えず onDidCreate として検知されるケースがある。
                // 両方 subscribe して同じ debounce 経路に流す。
                let createListener: { dispose: () => void } | null = null;
                if (typeof watcher.onDidCreate === 'function') {
                    createListener = watcher.onDidCreate(() => this._fire(drawioPath));
                }
                this.watchers.set(drawioPath, {
                    watcher,
                    listener,
                    createListener,
                    debounceTimer: null
                });
            } catch (err) {
                // watcher creation failed — log and skip (don't throw)
                // eslint-disable-next-line no-console
                console.warn('[drawio watcher] failed to create watcher for', drawioPath, err);
            }
        }
    }

    private _removeReference(mdPath: string, drawioPath: string): void {
        const mds = this.references.get(drawioPath);
        if (!mds) return;
        mds.delete(mdPath);
        if (mds.size === 0) {
            this.references.delete(drawioPath);
            const entry = this.watchers.get(drawioPath);
            if (entry) {
                try { entry.listener.dispose(); } catch { /* ignore */ }
                if (entry.createListener) { try { entry.createListener.dispose(); } catch { /* ignore */ } }
                try { entry.watcher.dispose(); } catch { /* ignore */ }
                if (entry.debounceTimer) {
                    clearTimeout(entry.debounceTimer);
                    entry.debounceTimer = null;
                }
                this.watchers.delete(drawioPath);
            }
        }
    }

    private _fire(drawioPath: string): void {
        if (this.disposed) return;
        const entry = this.watchers.get(drawioPath);
        if (!entry) return;
        if (entry.debounceTimer) {
            clearTimeout(entry.debounceTimer);
        }
        entry.debounceTimer = setTimeout(() => {
            entry.debounceTimer = null;
            const mds = this.references.get(drawioPath);
            if (!mds || mds.size === 0) return;
            try {
                this.opts.onChange(drawioPath, Array.from(mds));
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[drawio watcher] onChange error', err);
            }
        }, this.debounceMs);
    }
}

/**
 * vscode-aware DrawioFileWatcher factory:
 *   `vscode.workspace.createFileSystemWatcher(RelativePattern(dir, basename))` と
 *   `fs.watchFile(path, { interval })` を **両方** subscribe して統合する。
 *
 * VSCode の FileSystemWatcher は drawio Desktop 等の atomic rename 保存
 * (write tmp → rename) を取りこぼすことがあり、ファイル変更が反映されない事例が
 * 報告されている。fs.watchFile は polling で確実に検知できるので fallback として併用する。
 *
 * 利用側 (editorProvider / notesEditorProvider / outlinerProvider) は
 * `createDrawioFileWatcher(path, vscodeNs, fsNs)` を直接 createFileSystemWatcher オプションに渡すだけ。
 */
export function createDrawioFileWatcher(
    drawioPath: string,
    vscodeNs: {
        workspace: {
            createFileSystemWatcher: (pattern: any) => {
                onDidChange: (h: () => void) => { dispose: () => void };
                onDidCreate: (h: () => void) => { dispose: () => void };
                dispose: () => void;
            };
        };
        RelativePattern: new (base: any, pattern: string) => any;
        Uri: { file: (p: string) => any };
    },
    fsNs: {
        watchFile: (path: string, opts: { interval: number }, listener: (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => void) => void;
        unwatchFile: (path: string, listener: (...args: any[]) => void) => void;
    },
    pollIntervalMs: number = 1000
): DrawioFileWatcher {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const dir = path.dirname(drawioPath);
    const base = path.basename(drawioPath);
    const vsWatcher = vscodeNs.workspace.createFileSystemWatcher(
        new vscodeNs.RelativePattern(vscodeNs.Uri.file(dir), base)
    );
    const changeListeners: Array<() => void> = [];
    const fsListener = (curr: { mtimeMs: number }, prev: { mtimeMs: number }) => {
        if (curr.mtimeMs !== prev.mtimeMs && curr.mtimeMs > 0) {
            changeListeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
        }
    };
    try { fsNs.watchFile(drawioPath, { interval: pollIntervalMs }, fsListener); } catch { /* ignore */ }
    return {
        onDidChange: (h: () => void) => {
            changeListeners.push(h);
            const sub = vsWatcher.onDidChange(h);
            return {
                dispose: () => {
                    const i = changeListeners.indexOf(h);
                    if (i >= 0) changeListeners.splice(i, 1);
                    try { sub.dispose(); } catch { /* ignore */ }
                }
            };
        },
        onDidCreate: (h: () => void) => {
            changeListeners.push(h);
            const sub = vsWatcher.onDidCreate(h);
            return {
                dispose: () => {
                    const i = changeListeners.indexOf(h);
                    if (i >= 0) changeListeners.splice(i, 1);
                    try { sub.dispose(); } catch { /* ignore */ }
                }
            };
        },
        dispose: () => {
            try { fsNs.unwatchFile(drawioPath, fsListener); } catch { /* ignore */ }
            try { vsWatcher.dispose(); } catch { /* ignore */ }
            changeListeners.length = 0;
        }
    };
}

/**
 * mdContent から `![](*.drawio.svg)` / `![](*.drawio.png)` を抽出して
 * absolute path のリストを返す。
 *
 * - http/data/file/vscode-resource/vscode-webview スキームは除外
 * - 相対パスは mdDir 基準で resolve
 * - 重複は除去
 * - パース失敗時は空配列（throw しない）
 */
export function extractDrawioReferences(mdContent: string, mdDir: string): string[] {
    if (!mdContent) return [];
    const result = new Set<string>();
    try {
        // ![alt](url) または ![alt](url "title") を許容
        const re = /!\[[^\]]*\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(mdContent)) !== null) {
            let src = m[1];
            if (!src) continue;
            // skip remote / data / vscode schemes
            if (/^(https?:|data:|file:|vscode-resource:|vscode-webview:)/i.test(src)) continue;
            // strip ?query / #fragment first (then check extension suffix)
            src = src.split(/[?#]/)[0];
            const lower = src.toLowerCase();
            if (!lower.endsWith('.drawio.svg') && !lower.endsWith('.drawio.png')) continue;
            // resolve relative
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const path = require('path');
            const abs = path.isAbsolute(src) ? src : path.resolve(mdDir, src);
            result.add(abs);
        }
    } catch {
        // fallthrough: return whatever we have so far (or empty)
    }
    return Array.from(result);
}
