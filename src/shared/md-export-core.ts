// md-export-core — md export bundle のコア（VS Code 非依存・fs 直叩きの純関数）
// sprint 20260720-170429-md-export-bundle。
//
// 責務:
//  - collectExportClosure: root md から子(subpage `[[]]`)/リンク先(参照 `[]`)を
//    独立トグル + 深さ制御 + visited(循環検出) + 越境可 で BFS 収集する。
//  - exportBundle: 収集した md 群 + 画像/添付を <dest>/<rootBase>/ に flat 出力し、
//    本文のリンク/画像/添付パスを bundle 相対に書き換える（可搬・副作用ゼロ）。
//
// 既存 exported util のみ使う（paste-asset-handler.ts は変更しない）:
//   extractAllAssetRefs / applyLinkUrlRewrites / generateUniqueFileNamePreserving
//   + buildUniqueDrawioName（drawioTemplate）。
import * as fs from 'fs';
import * as path from 'path';
import { extractAllAssetRefs, applyLinkUrlRewrites } from './paste-asset-handler';
import { buildUniqueDrawioName } from './drawioTemplate';

export interface ExportOptions {
    includeChildren: boolean;   // 子md(subpage) を含む
    recurseChildren: boolean;   // 子を再帰的に取得（孫も）
    includeLinks: boolean;      // リンク先md(参照リンク) を含む
    recurseLinks: boolean;      // リンク先を再帰的に取得
}

export interface ExportResult {
    ok: boolean;
    bundleDir: string;   // <dest>/<rootBase>
    mdCount: number;     // 出力した md 数（root 含む）
    imageCount: number;
    fileCount: number;
    error?: string;
}

type ReadBody = (abs: string) => string | null;
type FileExists = (abs: string) => boolean;

const defaultReadBody: ReadBody = (p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
};
const defaultFileExists: FileExists = (p) => {
    try { return fs.existsSync(p); } catch { return false; }
};

const isDrawio = (p: string): boolean => /\.drawio\.(svg|png)$/i.test(p || '');
const isMd = (p: string): boolean => /\.md$/i.test(p || '');

/**
 * root md から ExportOptions に従い md を BFS 収集する。返りは発見順の絶対パス列（root 先頭）。
 * - visited(絶対パス) で循環除去（子/リンク先で 1 個共有）。
 * - 深さ制御: depth 0 = root。include が on なら root からその種別を follow。
 *   recurse が off なら depth>=1 の md からはその種別を follow しない（= root から 1 hop のみ）。
 *   recurse が on なら全 depth で follow。子/リンク先で recurse は独立。
 * - 越境可: isUnderNoteDir 制約を掛けない。実在する .md のみ収集。
 */
export function collectExportClosure(
    rootMdAbs: string,
    opts: ExportOptions,
    readBody: ReadBody = defaultReadBody,
    fileExists: FileExists = defaultFileExists,
): string[] {
    const root = path.resolve(rootMdAbs);
    const visited = new Set<string>([root]);
    const ordered: string[] = [root];
    const queue: { abs: string; depth: number }[] = [{ abs: root, depth: 0 }];

    while (queue.length > 0) {
        const cur = queue.shift()!;
        const body = readBody(cur.abs);
        if (body == null) continue;
        const curDir = path.dirname(cur.abs);
        for (const ref of extractAllAssetRefs(body).mdLinkRefs) {
            const isChild = ref.isSubpage;
            const kindOn = isChild ? opts.includeChildren : opts.includeLinks;
            if (!kindOn) continue;
            const recurse = isChild ? opts.recurseChildren : opts.recurseLinks;
            // depth>=1 の md から follow してよいのは recurse=on のときだけ
            if (cur.depth >= 1 && !recurse) continue;
            const url = ref.url;
            const target = path.isAbsolute(url) ? path.resolve(url) : path.resolve(curDir, url);
            if (!isMd(target)) continue;
            if (!fileExists(target)) continue;   // 解決不能はスキップ（本文は据置）
            if (visited.has(target)) continue;   // 循環検出
            visited.add(target);
            ordered.push(target);
            queue.push({ abs: target, depth: cur.depth + 1 });
        }
    }
    return ordered;
}

/** dest 直下に base（or base-1, base-2…）の未存在ディレクトリパスを返す。 */
function uniqueDir(dest: string, base: string, fileExists: FileExists): string {
    let candidate = path.join(dest, base);
    if (!fileExists(candidate)) return candidate;
    for (let i = 1; ; i++) {
        candidate = path.join(dest, `${base}-${i}`);
        if (!fileExists(candidate)) return candidate;
    }
}

/**
 * used(小文字) セットに対し name を一意化。既存なら stem-1.ext, stem-2.ext…
 * 多重拡張子（.drawio.svg/.drawio.png）は buildUniqueDrawioName のロジックを used ベースで適用。
 */
function uniqueAssetName(used: Set<string>, name: string): string {
    const lower = name.toLowerCase();
    if (lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png')) {
        return buildUniqueDrawioName(name, (n: string) => used.has(n.toLowerCase()));
    }
    if (!used.has(lower)) return name;
    const ext = path.extname(name);          // ".png"
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
        const cand = `${stem}-${i}${ext}`;
        if (!used.has(cand.toLowerCase())) return cand;
    }
}

/** md ファイル名の一意化（拡張子 .md 前提。stem-1.md…）。 */
function uniqueMdName(used: Set<string>, name: string): string {
    return uniqueAssetName(used, name);
}

// markdown-link-parser は UMD（require で取得。paste-asset-handler と同じ）
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkParser = require('./markdown-link-parser');

/**
 * FR-EX-10: fractal 独自の subpage marker `[[title]](url)`（isSubpage=true）を
 * 通常の markdown リンク `[title](url)` に変換する（外部可搬）。
 * - parseMarkdownLinks の {isSubpage,start,end} span を使い、右→左で splice（index 保持）。
 * - 参照リンク `[title](url)`・画像 `![alt](url)` は不変。alt/url は保持。
 */
export function demoteSubpageLinks(body: string): string {
    if (!body || body.indexOf('[[') < 0) return body;
    const toks = linkParser.parseMarkdownLinks(body) as Array<{
        kind: string; alt: string; url: string; isSubpage?: boolean; start: number; end: number;
    }>;
    // subpage token だけを対象に、後ろから置換（前方の index がズレないように）
    const subs = toks.filter((t) => t.kind === 'link' && t.isSubpage)
        .sort((a, b) => b.start - a.start);
    let out = body;
    for (const t of subs) {
        const replacement = `[${t.alt}](${t.url})`;   // `[[alt]](url)` → `[alt](url)`
        out = out.slice(0, t.start) + replacement + out.slice(t.end);
    }
    return out;
}

/**
 * root md を起点に export bundle を出力する。
 * <dest>/<rootBase>/ に md を flat 配置、images/ files/ にアセット集約、本文を bundle 相対に書換。
 * 元データは read-only（副作用ゼロ）。
 */
export function exportBundle(args: {
    rootMdAbs: string;
    dest: string;
    options: ExportOptions;
    readBody?: ReadBody;
    fileExists?: FileExists;
}): ExportResult {
    const readBody = args.readBody ?? defaultReadBody;
    const fileExists = args.fileExists ?? defaultFileExists;
    const root = path.resolve(args.rootMdAbs);
    const rootBase = path.basename(root).replace(/\.md$/i, '');

    try {
        const bundleDir = uniqueDir(args.dest, rootBase, fileExists);
        const imagesDir = path.join(bundleDir, 'images');
        const filesDir = path.join(bundleDir, 'files');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.mkdirSync(filesDir, { recursive: true });

        // 1) closure 収集
        const closure = collectExportClosure(root, args.options, readBody, fileExists);

        // 2) md 名の一意化マップ（srcAbs → bundle 内 flat md 名）。2 パス（先に全 md 名確定 → 本文書換）
        const nameMap = new Map<string, string>();   // srcAbs → "foo-1.md"
        const usedNames = new Set<string>();
        for (const abs of closure) {
            const unique = uniqueMdName(usedNames, path.basename(abs));
            usedNames.add(unique.toLowerCase());
            nameMap.set(abs, unique);
        }

        // 3) アセット copier（名前保持・prefix なし・srcAbs memo で 1:1 共有・used Set で連番退避）
        const imgMemo = new Map<string, string>();
        const fileMemo = new Map<string, string>();
        const usedImg = new Set<string>();
        const usedFile = new Set<string>();
        let imageCount = 0;
        let fileCount = 0;

        // 返り: bundle md から見た相対（"images/x.png" / "files/y.pdf"）。失敗は null（本文据置）。
        const copyAsset = (srcAbs: string, toFiles: boolean): string | null => {
            const memo = toFiles ? fileMemo : imgMemo;
            if (memo.has(srcAbs)) return (toFiles ? 'files/' : 'images/') + memo.get(srcAbs)!;
            if (!fileExists(srcAbs)) return null;
            const destDir = toFiles ? filesDir : imagesDir;
            const used = toFiles ? usedFile : usedImg;
            const unique = uniqueAssetName(used, path.basename(srcAbs));
            used.add(unique.toLowerCase());
            try { fs.copyFileSync(srcAbs, path.join(destDir, unique)); }
            catch { return null; }
            memo.set(srcAbs, unique);
            if (toFiles) fileCount++; else imageCount++;
            return (toFiles ? 'files/' : 'images/') + unique;
        };

        // 4) 各 md を処理: アセットコピー + 本文リンク書換 → bundle に write
        for (const abs of closure) {
            const body0 = readBody(abs);
            if (body0 == null) continue;
            const curDir = path.dirname(abs);
            const refs = extractAllAssetRefs(body0);
            const renames = new Map<string, string>();

            // 画像（drawio 以外）→ images/、drawio.svg/png → files/（drawio 振り分け規約）
            for (const ref of refs.images) {
                const srcAbs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
                const rel = copyAsset(srcAbs, isDrawio(ref));
                if (rel && rel !== ref) renames.set(ref, rel);
            }
            // 添付 → files/
            for (const ref of refs.files) {
                const srcAbs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
                const rel = copyAsset(srcAbs, true);
                if (rel && rel !== ref) renames.set(ref, rel);
            }
            // md-to-md リンク（両種別）→ nameMap の bundle 相対名（越境可の target 解決）
            for (const ref of refs.mdLinks) {
                const target = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
                if (nameMap.has(target)) {
                    const rel = nameMap.get(target)!;   // bundle flat（同一階層）→ basename 相対
                    if (rel !== ref) renames.set(ref, rel);
                }
                // nameMap に無い（収集対象外）リンクは触らない（本文据置）
            }
            let body = applyLinkUrlRewrites(body0, renames);
            // FR-EX-10: subpage marker `[[title]](path)` を通常リンク `[title](path)` に変換
            // （外部の人に渡すため。標準 markdown ビューアで開けるように）。URL 書換の後に適用。
            body = demoteSubpageLinks(body);
            fs.writeFileSync(path.join(bundleDir, nameMap.get(abs)!), body, 'utf8');
        }

        return { ok: true, bundleDir, mdCount: closure.length, imageCount, fileCount };
    } catch (e) {
        return {
            ok: false,
            bundleDir: '',
            mdCount: 0,
            imageCount: 0,
            fileCount: 0,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
