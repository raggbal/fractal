/**
 * notes-asset-mover — cross-note move の「移動元アセット削除」を安全に行うヘルパ。
 *
 * sprint 20260707-124018-notes-flat-storage (reviewer iter1 TASK-09/10):
 *   共有フラットレイアウト（images/・files/ を Note 内の全 item で共有）では、
 *   ある item を別 Note へ移動して「移動元の共有アセットを削除」する際、
 *   残留 item がそのアセットをまだ参照していると削除でデータロスになる。
 *
 * このモジュールは:
 *   1. 削除前に「src Note の残留 item（他 .out の node.images/filePath + 他 .md 本文）が
 *      同じアセットを参照していないか」を走査し、参照ありなら削除をスキップする。
 *   2. アセット参照判定を basename の部分文字列一致でなく、md リンク/相対パスの
 *      完全一致で行う（`a.png` が `banana.png` に誤マッチしない）。
 *
 * DOD-24（src/ の即時 delete API 禁止）の allowlist に paste-asset-handler.ts と同じ
 * 「move semantics」理由で加える（このファイルは move の src cleanup 専用）。削除は
 * cross-note move の一部であり、コピー検証済みの元ファイルを消す move セマンティクス。
 */
import * as fs from 'fs';
import * as path from 'path';

const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);

/** md 本文 or .out の参照文字列からアセット basename の集合を抽出（相対パスの最終要素）。 */
function refBasenames(refs: string[]): Set<string> {
    const set = new Set<string>();
    for (const r of refs) {
        if (typeof r !== 'string' || !r) { continue; }
        // URL / 絶対 / データURI はスキップ
        if (/^(https?:|data:|file:)/i.test(r) || r.startsWith('/')) { continue; }
        set.add(path.posix.basename(r.replace(/\\/g, '/')));
    }
    return set;
}

/** md 本文から画像/添付リンクの URL を抽出（`](url)` の url 部分）。 */
function extractMdLinkUrls(body: string): string[] {
    const urls: string[] = [];
    // ![alt](url) と [text](url) の両方。balanced ではないが基本形をカバー。
    const re = /\]\(([^)\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { urls.push(m[1]); }
    return urls;
}

/**
 * src Note フォルダ内で、moving item（除外 id）を除いた残留 item が参照するアセット basename の集合を返す。
 * - 各 .out の node.images / node.filePath
 * - 各 .md（Note 直下 + legacy _notes_md/）の本文リンク
 */
export function collectSurvivingAssetRefs(mainFolderPath: string, excludeIds: Set<string>): Set<string> {
    const refs = new Set<string>();
    const addAll = (s: Set<string>) => { for (const x of s) { refs.add(x); } };

    let entries: string[] = [];
    try { entries = fs.readdirSync(mainFolderPath); } catch { return refs; }

    for (const entry of entries) {
        const full = path.join(mainFolderPath, entry);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { continue; }

        if (stat.isFile() && entry.endsWith('.out')) {
            const id = entry.replace(/\.out$/, '');
            if (excludeIds.has(id)) { continue; }
            try {
                const data = JSON.parse(fs.readFileSync(full, 'utf8'));
                const nodes = (data.nodes || {}) as Record<string, { images?: unknown; filePath?: unknown }>;
                for (const n of Object.values(nodes)) {
                    if (Array.isArray(n.images)) { addAll(refBasenames(n.images as string[])); }
                    if (typeof n.filePath === 'string') { addAll(refBasenames([n.filePath])); }
                }
            } catch { /* parse error は無視 */ }
        } else if (stat.isFile() && entry.endsWith('.md')) {
            const id = entry.replace(/\.md$/, '');
            if (excludeIds.has(id)) { continue; }
            try {
                addAll(refBasenames(extractMdLinkUrls(fs.readFileSync(full, 'utf8'))));
            } catch { /* 無視 */ }
        } else if (stat.isDirectory() && entry === '_notes_md') {
            // legacy notes-md も走査（新旧混在時の残留参照）
            let mds: string[] = [];
            try { mds = fs.readdirSync(full); } catch { /* 無視 */ }
            for (const f of mds) {
                if (!f.endsWith('.md')) { continue; }
                const id = f.replace(/\.md$/, '');
                if (excludeIds.has(id)) { continue; }
                try { addAll(refBasenames(extractMdLinkUrls(fs.readFileSync(path.join(full, f), 'utf8')))); } catch { /* 無視 */ }
            }
        }
    }
    return refs;
}

/**
 * cross-note move の src cleanup: 収集した削除候補のうち、残留 item がまだ参照する
 * 共有アセット（images/・files/ 配下）は削除をスキップする。それ以外（page md 本体・
 * per-id フォルダ・非参照アセット）は削除する。
 *
 * @param mainFolderPath 移動元 Note フォルダ
 * @param movedIds       移動した item の id（残留参照走査の除外対象。移動元/移動後 id 両方入れる）
 * @param deleteCandidates 削除候補 {absPath, recursive, isSharedAsset}
 * @returns 実際に削除したパスのリスト
 */
export function cleanupMovedAssets(
    mainFolderPath: string,
    movedIds: Set<string>,
    deleteCandidates: { absPath: string; recursive: boolean; isSharedAsset: boolean }[]
): string[] {
    const surviving = collectSurvivingAssetRefs(mainFolderPath, movedIds);
    const deleted: string[] = [];
    for (const c of deleteCandidates) {
        if (!fs.existsSync(c.absPath)) { continue; }
        if (c.isSharedAsset) {
            const base = path.basename(c.absPath);
            if (surviving.has(base)) {
                // 残留 item がまだ参照 → 削除しない（データロス防止）
                continue;
            }
        }
        // move semantics の即時削除（DOD-24 allowlist 対象。コピー検証済みの元を消す）
        fs.rmSync(c.absPath, { recursive: c.recursive, force: true });
        deleted.push(c.absPath);
    }
    return deleted;
}

export const __testHelpers = { refBasenames, extractMdLinkUrls, IMG_EXTS };
