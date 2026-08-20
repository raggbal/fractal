/**
 * Path Safety Utilities
 *
 * Protects against path traversal attacks by validating relative paths
 * stay within a specified base directory.
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Safely resolves a relative path under a base directory.
 *
 * Returns null if the path:
 * - Is absolute
 * - Contains .. that would escape the baseDir
 * - Normalizes to a path outside baseDir
 *
 * @param baseDir The base directory to resolve paths under
 * @param relPath The relative path to resolve
 * @returns Absolute path if safe, null if unsafe
 */
export function safeResolveUnderDir(baseDir: string, relPath: string): string | null {
    // Reject absolute paths (Unix and Windows)
    if (path.isAbsolute(relPath)) {
        return null;
    }

    // Also reject Windows absolute paths on non-Windows systems
    if (/^[a-zA-Z]:[/\\]/.test(relPath)) {
        return null;
    }

    // Normalize the path to resolve .. and .
    const normalized = path.normalize(relPath);

    // Reject paths that start with .. (would escape immediately)
    if (normalized.startsWith('..' + path.sep) || normalized === '..') {
        return null;
    }

    // Resolve to absolute path
    const absPath = path.resolve(baseDir, normalized);

    // Check if resolved path is still under baseDir
    const relToBase = path.relative(baseDir, absPath);

    // If relative path starts with .., the resolved path is outside baseDir
    if (relToBase.startsWith('..')) {
        return null;
    }

    return absPath;
}

/**
 * FR-MDM-01 (sprint 20260818-183407): md 本文リンク（md/subpage/file）の Copy Path / full path 変換用の
 * 単一解決点。href を md の dir 基準で絶対化し rootAbs 配下に clamp（外は null — 呼び出し側が
 * エラー通知。silent return 禁止）。
 * - `?query` / `#fragment` / `<>` は strip、encode はデコード後に containment 検査
 *   （decodeURIComponent がマッチ後に走る文字クラス素通し = generator_failures 2026-08-05 の再発防止）。
 * - 絶対パス href も containment 検査のみ行い root 内なら許容（root 外は null）。
 * - clamp root は呼び出し側 provider が pin する（notes md リンク = mainFolder / notes file リンク =
 *   resolveFilesDirForMd(md) / standalone md = dirname(md) / single outliner = dirname(.out)）。
 */
export function resolveLinkTargetUnder(rootAbs: string, mdAbs: string, href: string): string | null {
    let h = String(href || '').trim().split(/[?#]/)[0].replace(/^<|>$/g, '');
    if (!h) return null;
    try {
        const d = decodeURIComponent(h);
        if (d) h = d;
    } catch { /* 不正 encode は raw のまま containment 検査 */ }
    const root = path.resolve(rootAbs);
    const abs = path.isAbsolute(h) ? path.normalize(h) : path.resolve(path.dirname(mdAbs), h);
    const relToRoot = path.relative(root, abs);
    if (relToRoot === '' || relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
        return null;
    }
    return abs;
}

/**
 * FR-FLV (NFR-FLV-01 / host-api.md §3): folder link のリンク先実フォルダ（folderRoot）配下への
 * 二段 clamp。folder view 起点の fs 実体に触れる全 sink（bridge 台帳 #6-16 — 読み取り・書き込み双方）が
 * 必ずこれを経由する（realpath 検査を関数内に一体化 = 呼び出し側の付け忘れを構造排除）。
 *
 * 1. lexical clamp: safeResolveUnderDir 同型（絶対パス reject / `..` escape reject）。
 *    relPath は decode しない生文字列として扱う（`..%2F` は 1 セグメント名 — generator_failures 2026-08-05）。
 * 2. realpath 実体検査: 解決パスの「実在する最深祖先（または自身）」を realpath し、
 *    realpath(folderRoot) 配下であることを再検証する。symlink 越し・TOCTOU（listing 後の
 *    symlink 差し替え）による folderRoot 外への読み書き・削除を遮断する（research-risk R3）。
 *    解決パス自身が symlink の場合も realpath で実体位置を検査する（folderRoot 外を指す
 *    symlink エントリの読み・削除・rename も遮断 — 走査が symlink を非表示にする一次防御の二次側）。
 *
 * @param folderRoot folder link のリンク先実フォルダ（絶対パス。実在すること）
 * @param relPath folderRoot 相対パス（'' = folderRoot 自身）
 * @returns lexical 解決の絶対パス / null（clamp 違反・realpath 検査違反・folderRoot 不正）
 */
export function safeResolveUnderFolderRoot(folderRoot: string, relPath: string): string | null {
    // '' はルート自身（list のルート要求等）— lexical 段は素通しし realpath 段だけ通す
    let absPath: string;
    if (relPath === '') {
        absPath = path.resolve(folderRoot);
    } else {
        const resolved = safeResolveUnderDir(folderRoot, relPath);
        if (resolved === null) { return null; }
        absPath = resolved;
    }

    // realpath 実体検査
    let rootReal: string;
    try {
        rootReal = fs.realpathSync(folderRoot);
        if (!fs.statSync(rootReal).isDirectory()) { return null; }
    } catch {
        return null; // folderRoot 自体が不在（broken link）
    }
    // 実在する最深祖先（新規作成先は親を辿る）を realpath する。
    // lstat で判定（broken symlink も「実在するエントリ」として realpath 検査対象にする）。
    let probe = absPath;
    for (;;) {
        try {
            fs.lstatSync(probe);
            break; // 実在エントリに到達
        } catch {
            const parent = path.dirname(probe);
            if (parent === probe) { return null; } // ルートまで遡って実在なし（異常）
            probe = parent;
        }
    }
    let probeReal: string;
    try {
        probeReal = fs.realpathSync(probe);
    } catch {
        // broken symlink 等で realpath 不能 → 実体位置を検証できないため遮断
        return null;
    }
    if (probeReal !== rootReal && !probeReal.startsWith(rootReal + path.sep)) {
        return null;
    }
    // 解決パス自身（またはその祖先）が folderRoot 内の symlink で、実体も folderRoot 内 …は許容。
    // 実体が folderRoot 外なら上の包含判定で null 済み。
    return absPath;
}
