/**
 * 保存先サイドカー（standalone md 限定・フォルダ共有の画像/添付保存先）— ADRL-0016
 *
 * standalone md と同じフォルダに置く隠し JSON `.fractal.json`:
 *   { "imageDir": "<path>", "fileDir": "<path>" }
 * そのフォルダの全 standalone md が共有。md 本文は一切汚さない（Typora 等・WYSIWYG とも無害）。
 * ADRL-0015 の本文 HTML コメントディレクティブ方式を supersede。
 *
 * すべて path/fs のみ（vscode 非依存）。unit から直接 require できる。
 * WorkspaceEdit/QuickPick 等の vscode 呼び出しは editorProvider の呼び出し側に置く。
 */

const path = require('path');
const fs = require('fs');

export type SaveDirKind = 'imageDir' | 'fileDir';

/** サイドカーファイル名（md と同じフォルダに置く隠し JSON） */
export const SAVE_DIR_SIDECAR = '.fractal.json';

/** md のフォルダにある .fractal.json の絶対パス */
export function sidecarPathForMd(mdPath: string): string {
    return path.join(path.dirname(mdPath), SAVE_DIR_SIDECAR);
}

/** .fractal.json を読んでパース。無い/壊れている → null（best-effort・NFR-MD-03） */
export function readSaveDirConfig(mdPath: string): { imageDir?: string; fileDir?: string } | null {
    try {
        const p = sidecarPathForMd(mdPath);
        if (!fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf-8');
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        return obj;
    } catch {
        return null; // 壊れた JSON 等 → 従来デフォルトにフォールバック
    }
}

/**
 * md 同フォルダの .fractal.json から保存先を解決。
 * 該当キーがあり非空文字列ならその値、無ければ null（呼び出し側が従来デフォルトを使う）。
 */
export function resolveSaveDirFromSidecar(mdPath: string, key: SaveDirKind): string | null {
    const cfg = readSaveDirConfig(mdPath);
    if (!cfg) return null;
    const v = cfg[key];
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed ? trimmed : null;
}

/** 値がサイドカーに書ける形か（NFR-MD-03）。空・改行は不可（JSON 自体は安全だが異常値を弾く） */
export function isValidSaveDirValue(value: string): boolean {
    return !!value && !/[\r\n]/.test(value);
}

/**
 * .fractal.json の該当キーを value に upsert（他キー・他フィールドは保持）。
 * 既存 JSON をマージして返す（呼び出し側が fs.writeFile する。純粋にオブジェクトを組み立てる）。
 * value が不正なら既存 config を変更せず返す。
 */
export function withSaveDir(existing: { [k: string]: unknown } | null, key: SaveDirKind, value: string): { [k: string]: unknown } {
    const base: { [k: string]: unknown } = existing && typeof existing === 'object' ? { ...existing } : {};
    if (!isValidSaveDirValue(value)) return base;
    base[key] = value;
    return base;
}

/**
 * .fractal.json から該当キーを削除（他キーは保持）。
 * 返り値: { config: 削除後オブジェクト, empty: imageDir/fileDir が両方無くなったか }。
 * empty=true なら呼び出し側は .fractal.json 自体を削除する（残骸ゼロ・NFR-MD-02）。
 */
export function withoutSaveDir(existing: { [k: string]: unknown } | null, key: SaveDirKind): { config: { [k: string]: unknown }; empty: boolean } {
    const base: { [k: string]: unknown } = existing && typeof existing === 'object' ? { ...existing } : {};
    delete base[key];
    const hasImage = typeof base.imageDir === 'string' && (base.imageDir as string).trim() !== '';
    const hasFile = typeof base.fileDir === 'string' && (base.fileDir as string).trim() !== '';
    // imageDir/fileDir 以外のキーが残っていれば file は消さない（他機能の設定を巻き込まない）
    const otherKeys = Object.keys(base).filter((k) => k !== 'imageDir' && k !== 'fileDir').length > 0;
    const empty = !hasImage && !hasFile && !otherKeys;
    return { config: base, empty };
}

/**
 * md が fractal note フォルダ配下か（フォルダを上方向に辿り `outline.note` を持つ祖先があるか）。
 * standalone md の保存先 UI/解決を「note 配下でない md 限定」にするためのガード。
 */
export function isUnderFractalNote(mdPath: string): boolean {
    if (!mdPath) return false;
    let dir = path.dirname(mdPath);
    for (let i = 0; i < 128; i++) {
        try {
            if (fs.existsSync(path.join(dir, 'outline.note'))) return true;
        } catch { /* 権限エラー等は無視して上へ */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return false;
}

/**
 * standalone で直接 .md を開いた時に「outliner page MD」と heuristic 検出する。
 * 命名規約: `<basename>.out` の page MD は `<basename>/<pageId>.md` に保存される。
 * `.md` の親フォルダ名 (basename) と同名の `.out` が grandparent に存在すれば outliner page MD。
 */
export function detectStandaloneOutlinerPage(mdPath: string): { pageDir: string } | null {
    try {
        const pageDir = path.dirname(mdPath);
        const folderName = path.basename(pageDir);
        const parentDir = path.dirname(pageDir);
        if (!folderName || pageDir === parentDir) return null;
        const outFile = path.join(parentDir, `${folderName}.out`);
        if (fs.existsSync(outFile) && fs.statSync(outFile).isFile()) {
            return { pageDir };
        }
    } catch {
        /* fs error → 検出失敗扱い */
    }
    return null;
}
