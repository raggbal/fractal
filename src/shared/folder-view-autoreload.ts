/**
 * folder-view-autoreload — fv 自動リロード（FR-FLV-33 / ADRL-FVR-1 — ADRL-0074 supersede）。
 *
 * fv 表示中の folder link root を Node `fs.watch(root, { recursive: true })` で監視し、
 * 変化パスの親 dir を debounce（既定 300ms）で集約して listDir（folderViewList 再送）を呼ぶ。
 *
 * - **VS Code FSW は使わない**: workspace フォルダ外のパスに fire しない確立制約
 *   （MD-48 — editorProvider.ts:747 / external-md-watcher.ts:6 ほか 4 記録）。linkedfd は workspace 外が主用途。
 * - dir 単位**再スキャン**（差分適用しない — フォルダ削除は含有ファイル個別イベントが来ないため。ADRL-0074 の指摘）。
 * - filename null（プラットフォーム依存エッジ）→ root（''）の再 list にフォールバック。
 * - fs.watch throw（旧 Node Linux の recursive 非対応 / EMFILE / 権限）→ warn + no-op
 *   （縮退 = 契機リフレッシュ: 表示時・展開時・⟳・操作後 echo は全て不変で残る）。
 * - external-md-watcher.ts と同じ fs 注入 seam（vscode 非依存 — unit から fake で behavioral に駆動）。
 */
import * as path from 'path';

export interface FvAutoReloadDeps {
    /** fs.watch を持つ namespace（本番 = require('fs')。テストは fake） */
    fsNs: { watch(root: string, opts: { recursive: boolean }, cb: (event: string, filename: string | null) => void): { close(): void; on?(event: 'error', cb: (e: unknown) => void): void } };
    /** 変化 dir の list 再送（呼び出し側が folderViewList を bind する） */
    listDir(linkId: string, relPath: string): void;
    /** debounce ms（既定 300） */
    debounceMs?: number;
    /** 監視失敗の診断（既定 console.warn） */
    warn?(msg: string, e?: unknown): void;
}

export interface FvAutoReloadHandle {
    /** fv の root list 到達時に呼ぶ（既存同 root = no-op / 別 root = 張り替え） */
    ensure(linkId: string, root: string): void;
    /** fv close（folderViewClosed）/ link 切替時 */
    close(linkId: string): void;
    /** webview dispose 時 */
    disposeAll(): void;
}

interface WatchEntry {
    root: string;
    handle: { close(): void; on?(event: 'error', cb: (e: unknown) => void): void } | null;
    timer: ReturnType<typeof setTimeout> | null;
    pendingDirs: Set<string>;
}

export function createFolderViewAutoReload(deps: FvAutoReloadDeps): FvAutoReloadHandle {
    const debounceMs = deps.debounceMs ?? 300;
    const warn = deps.warn || ((msg: string, e?: unknown) => console.warn(msg, e));
    const entries = new Map<string, WatchEntry>();

    function flush(linkId: string): void {
        const entry = entries.get(linkId);
        if (!entry) { return; }
        entry.timer = null;
        const dirs = Array.from(entry.pendingDirs);
        entry.pendingDirs.clear();
        for (const rel of dirs) { deps.listDir(linkId, rel); }
    }

    function onFsEvent(linkId: string, filename: string | null): void {
        const entry = entries.get(linkId);
        if (!entry) { return; } // close 後の残イベントは無視（one-shot 対配線）
        // filename は watch root からの相対。null はエッジ → root 全体へフォールバック
        let rel = '';
        if (filename != null && String(filename) !== '') {
            const dir = path.dirname(String(filename));
            rel = dir === '.' ? '' : dir.replace(/\\/g, '/');
            if (rel === '..' || rel.startsWith('../')) { return; } // root 外相対は捨てる（防御）
        }
        entry.pendingDirs.add(rel);
        if (entry.timer === null) {
            entry.timer = setTimeout(() => flush(linkId), debounceMs);
        }
    }

    function closeEntry(linkId: string): void {
        const entry = entries.get(linkId);
        if (!entry) { return; }
        entries.delete(linkId);
        if (entry.timer !== null) { clearTimeout(entry.timer); }
        try { entry.handle?.close(); } catch { /* 二重 close 安全 */ }
    }

    return {
        ensure(linkId: string, root: string): void {
            const existing = entries.get(linkId);
            if (existing && existing.root === root) { return; } // 同 root = no-op
            if (existing) { closeEntry(linkId); }               // 別 root = 張り替え
            const entry: WatchEntry = { root, handle: null, timer: null, pendingDirs: new Set() };
            try {
                entry.handle = deps.fsNs.watch(root, { recursive: true }, (_event, filename) => onFsEvent(linkId, filename));
            } catch (e) {
                warn('[fractal] folder view auto-reload unavailable (fs.watch failed):', e);
                return; // 縮退 = 契機リフレッシュのみ（entry を登録しない）
            }
            // QUAL-1（reviewer iter1）: FSWatcher は EventEmitter — 'error' listener 不在の非同期 error
            //（監視 root 自身の削除/権限変更等）は unhandled で extension host を落とす。warn + dispose で縮退
            if (entry.handle && typeof entry.handle.on === 'function') {
                entry.handle.on('error', (e: unknown) => {
                    warn('[fractal] folder view auto-reload stopped (watch error):', e);
                    closeEntry(linkId);
                });
            }
            entries.set(linkId, entry);
        },
        close(linkId: string): void { closeEntry(linkId); },
        disposeAll(): void {
            for (const id of Array.from(entries.keys())) { closeEntry(id); }
        },
    };
}
