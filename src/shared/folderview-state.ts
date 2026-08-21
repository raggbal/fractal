/**
 * フォルダビュー開閉状態の sidecar（FR-FLV-26 / ADRL-0075）— 再オープン① 2026-08-18
 *
 * リンク先実フォルダ直下の隠し JSON `.fractal-folderview.json`:
 *   { "version": 1, "expanded": ["<relPath>", ...] }
 * 相対パスのみ（絶対パス・マシン名・ユーザー名を含めない — 複数マシン共有・同期フォルダ混入を考慮）。
 *
 * save-dir-directive.ts（.fractal.json sidecar / ADRL-0016）の 4 性質と同型:
 *   best-effort read（壊れた JSON = 無視）/ 他キー保持 upsert / expanded 空でファイル削除 / 書込失敗 silent skip。
 * すべて path/fs のみ（vscode 非依存）。unit から直接 require できる。
 */

const path = require('path');
const fs = require('fs');

/** sidecar ファイル名（folderRoot 直下の固定名 — ユーザー制御のパス解決なし） */
export const FOLDER_VIEW_STATE_SIDECAR = '.fractal-folderview.json';

export function folderViewStatePath(folderRoot: string): string {
    return path.join(folderRoot, FOLDER_VIEW_STATE_SIDECAR);
}

/**
 * 開閉状態を読む。無い / 壊れている / 形式不正 → []（best-effort — 復元されないだけで動作は継続）。
 * 返り値は文字列の配列（相対パス想定。検証は保存側 = folderViewStateSave の責務）。
 */
export function readFolderViewExpanded(folderRoot: string): string[] {
    try {
        const p = folderViewStatePath(folderRoot);
        if (!fs.existsSync(p)) { return []; }
        const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (!obj || typeof obj !== 'object' || !Array.isArray(obj.expanded)) { return []; }
        return obj.expanded.filter((v: unknown) => typeof v === 'string' && v !== '');
    } catch {
        return [];
    }
}

/**
 * 開閉状態を保存（他キー保持 upsert）。expanded が空なら sidecar 自体を削除（残骸ゼロ）。
 * 書込・削除の失敗は silent skip（読み取り専用フォルダ等 — 開閉は動くが復元されない縮退）。
 */
export function saveFolderViewExpanded(folderRoot: string, expanded: string[]): void {
    const p = folderViewStatePath(folderRoot);
    try {
        let base: { [k: string]: unknown } = {};
        try {
            if (fs.existsSync(p)) {
                const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (obj && typeof obj === 'object') { base = obj; }
            }
        } catch { /* 壊れた既存 JSON は捨てて作り直す（best-effort） */ }
        if (!expanded || expanded.length === 0) {
            // 他キーが残っていればファイルは消さない（他機能の設定を巻き込まない — withoutSaveDir 同型）
            const otherKeys = Object.keys(base).filter((k) => k !== 'expanded' && k !== 'version');
            if (otherKeys.length === 0) {
                if (fs.existsSync(p)) { fs.unlinkSync(p); }
                return;
            }
            delete base.expanded;
            fs.writeFileSync(p, JSON.stringify(base, null, 2));
            return;
        }
        base.version = 1;
        base.expanded = expanded;
        fs.writeFileSync(p, JSON.stringify(base, null, 2));
    } catch {
        /* silent skip（NFR: 書込不能フォルダでは復元されない縮退 — 受容事項 7） */
    }
}

/**
 * 隠しファイル表示トグルの読み書き（FR-FLV-31 — sprint 20260821-015014）。
 * 同じ sidecar に `showHidden: true` を upsert。false はキー削除（残骸ゼロ — expanded と同じ 4 性質）。
 */
export function readFolderViewShowHidden(folderRoot: string): boolean {
    try {
        const p = folderViewStatePath(folderRoot);
        if (!fs.existsSync(p)) { return false; }
        const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
        return !!(obj && typeof obj === 'object' && obj.showHidden === true);
    } catch {
        return false;
    }
}

export function saveFolderViewShowHidden(folderRoot: string, value: boolean): void {
    const p = folderViewStatePath(folderRoot);
    try {
        let base: { [k: string]: unknown } = {};
        try {
            if (fs.existsSync(p)) {
                const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
                if (obj && typeof obj === 'object') { base = obj; }
            }
        } catch { /* 壊れた既存 JSON は捨てて作り直す（best-effort） */ }
        if (!value) {
            delete base.showHidden;
            const otherKeys = Object.keys(base).filter((k) => k !== 'version');
            if (otherKeys.length === 0) {
                if (fs.existsSync(p)) { fs.unlinkSync(p); }
                return;
            }
        } else {
            base.showHidden = true;
        }
        base.version = 1;
        fs.writeFileSync(p, JSON.stringify(base, null, 2));
    } catch {
        /* silent skip（書込不能フォルダでは永続化されない縮退 — expanded と同じ受容） */
    }
}
