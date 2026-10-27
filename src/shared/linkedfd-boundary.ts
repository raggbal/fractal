/**
 * spec 20261027-1556-linkedfd-copy-only（D1 / D2）: linkedfd（folder link のフォルダ）と Fractal の境界判定。
 *
 * 境界をまたぐ転送（linkedfd → Fractal / Fractal → linkedfd / 別の linkedfd へ）は**常に複製**で、
 * 元（ファイル・md のリンク・ツリー項目・node の添付）を消さない・書き換えない。
 * 判定は host の source 側後処理（削除・台帳除去・リンク除去・node の添付外し）の直前で行い、
 * webview から来る経路名・dropEffect・mode を信じない（D2）。
 *
 * vscode 非依存（fs / path のみ）— unit spec から直接 require できる。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 実在する最も近い祖先で realpath を取り、残りを足して正規化する（macOS の /var → /private/var 等を吸収）。 */
function canonicalPath(p: string): string {
    const abs = path.resolve(p);
    let head = abs;
    const tail: string[] = [];
    for (;;) {
        try {
            const real = fs.realpathSync(head);
            return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
        } catch {
            const parent = path.dirname(head);
            if (parent === head) { return abs; }
            tail.push(path.basename(head));
            head = parent;
        }
    }
}

function isUnder(root: string, abs: string): boolean {
    const rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** note の構造から folder link の実フォルダ（linkedfd root）を全部集める。 */
export function linkedfdRootsOf(fm: { getStructure(): { items?: Record<string, unknown> } } | null | undefined): string[] {
    const roots: string[] = [];
    if (!fm || typeof fm.getStructure !== 'function') { return roots; }
    let items: Record<string, unknown> = {};
    try { items = fm.getStructure().items || {}; } catch { return roots; }
    for (const key of Object.keys(items)) {
        const it = items[key] as { type?: string; ext?: string; folderPath?: string } | null;
        if (it && it.type === 'file' && it.ext === 'folder' && typeof it.folderPath === 'string' && it.folderPath) {
            roots.push(it.folderPath);
        }
    }
    return roots;
}

/** absPath を含む linkedfd root（いちばん深いもの）を返す。どれにも入らなければ null（= Fractal 側）。 */
export function linkedfdRootOf(roots: string[], absPath: string): string | null {
    if (!absPath) { return null; }
    const target = canonicalPath(absPath);
    let best: string | null = null;
    for (const r of roots) {
        if (!r) { continue; }
        const root = canonicalPath(r);
        if (isUnder(root, target) && (!best || root.length > best.length)) { best = root; }
    }
    return best;
}

/**
 * src と dst が同じ側か（同じ linkedfd の中どうし / どちらも Fractal 側）。違えば境界をまたぐ。
 * dst が分からない（空）ときは**またぐ扱い**（安全側 = 元を消さない）。
 */
export function crossesLinkedfdBoundary(roots: string[], srcAbs: string, dstAbs: string | null | undefined): boolean {
    if (!srcAbs || !dstAbs) { return true; }
    return linkedfdRootOf(roots, srcAbs) !== linkedfdRootOf(roots, dstAbs);
}
