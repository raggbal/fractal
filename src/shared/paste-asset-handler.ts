/**
 * paste-asset-handler — page/images/files の copy/move 時のファイル操作を一元化
 *
 * - copyPageAssets: 新 filename で画像を実体コピー + .md 本文の参照を rewrite + .md 本体を保存
 * - movePageAssets: 画像と .md を src → dest にコピー (同一 dir なら no-op、元ファイルは削除しない — cleanup が管理)
 * - copyImageAssets / moveImageAssets: 非 isPage ノードの images[] 用 (move も元を削除しない)
 * - copyFileAsset / moveFileAsset: filePath 付きノードのファイル用 (original name 保持、move も元を削除しない)
 *
 * すべて同期的なファイル操作。失敗時は個別にスキップ (try/catch)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';
import { buildUniqueDrawioName } from './drawioTemplate';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require('./markdown-link-parser');

export interface PasteAssetResult {
    newNodeImages: string[];
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveSourceImage(ref: string, srcOutDir: string, srcPagesDir: string): string | null {
    const candA = path.isAbsolute(ref) ? ref : path.resolve(srcOutDir, ref);
    if (fs.existsSync(candA)) return candA;
    const candB = path.resolve(srcPagesDir, ref);
    if (fs.existsSync(candB)) return candB;
    return null;
}

// ────────────────────────────────────────────────────────────────────────────
// md-link-recursive-copy (2026-07-07): md-to-md リンクの再帰複製 closure 収集
// ────────────────────────────────────────────────────────────────────────────

/**
 * target が noteDir（末尾 sep 付きで比較）配下かを判定する純関数。
 * flat/legacy いずれのレイアウトでも noteDir が md 置き場 dir を指していれば成立。
 * - `..` エスケープ → resolve 後に noteDir 外になり false
 * - sibling-prefix（noteDir=/a/pages に対する /a/pagesX/…）→ 末尾 sep 比較で false
 */
export function isUnderNoteDir(target: string, noteDir: string): boolean {
    const nd = path.resolve(noteDir);
    const withSep = nd.endsWith(path.sep) ? nd : nd + path.sep;
    const t = path.resolve(target);
    return t === nd || t.startsWith(withSep);
}

/**
 * 起点 md（rootMdAbs）を出発点に md-to-md リンクを BFS で辿り、
 * 「自note内（sourceMdDir 配下）に実在する複製対象 md（起点除く）」の closure と、
 * 「自note外/解決不能を指したリンク先絶対パス」の external を返す。
 *
 * ★循環検出: visited に入れてから push（A→B→A は B 処理時に A が visited 済みで打ち切り）。
 * ★収集フェーズ専用（複製は呼び出し側のフェーズ B）。extractAllAssetRefs は function 宣言で hoist される。
 *
 * @param rootMdAbs   起点 md の絶対パス（貼り付け元の md 実体。読めなくても rootBody を渡せる）
 * @param sourceMdDir 自note の md 置き場 dir
 * @param rootBody    起点 md 本文（省略時は rootMdAbs を読む）
 */
export function collectMdLinkClosure(
    rootMdAbs: string,
    sourceMdDir: string,
    rootBody?: string,
): { closure: string[]; external: Set<string>; visitedCount: number } {
    const visited = new Set<string>();
    const closure: string[] = [];
    const external = new Set<string>();
    const rootAbs = path.resolve(rootMdAbs);
    visited.add(rootAbs); // 起点は複製済み扱い（自己参照・循環の打ち切り点）

    const queue: { mdAbs: string; body: string | null }[] = [
        { mdAbs: rootAbs, body: rootBody != null ? rootBody : null },
    ];

    while (queue.length > 0) {
        const cur = queue.shift()!;
        let body = cur.body;
        if (body == null) {
            try { body = fs.readFileSync(cur.mdAbs, 'utf8'); } catch { body = ''; }
        }
        const curDir = path.dirname(cur.mdAbs);
        for (const ref of extractAllAssetRefs(body).mdLinks) {
            const target = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
            if (!isUnderNoteDir(target, sourceMdDir) || !fs.existsSync(target)) {
                external.add(target); // 自note外 or 解決不能 → 複製しない
                continue;
            }
            if (visited.has(target)) { continue; } // ★循環検出
            visited.add(target);
            closure.push(target);
            queue.push({ mdAbs: target, body: null });
        }
    }
    return { closure, external, visitedCount: visited.size };
}

/**
 * body 内の md-to-md リンクを書き換える（複製はしない、書換のみ）。
 * - closure 内（closureNameMap にある src）→ dest 相対（複製先）
 * - closure 外（自note外/外部）→ dest（destMdDir）から元 md への相対パス（★絶対パスにしない = 可搬性原則）
 * - 解決不能（実在しない）→ 触らない
 * @param curDir その md の dir（相対リンクの resolve 基準）
 */
function rewriteMdLinksInBody(
    body: string,
    curDir: string,
    destMdDir: string,
    closureNameMap: Map<string, string>,
): string {
    // oldRef → newRef を確定してから whole-link-target 置換（部分文字列誤置換を防ぐ）
    const renames = new Map<string, string>();
    for (const ref of extractAllAssetRefs(body).mdLinks) {
        const target = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
        let newRef: string | null = null;
        if (closureNameMap.has(target)) {
            newRef = closureNameMap.get(target)!; // closure 内 → 複製先 dest 相対
        } else if (fs.existsSync(target)) {
            // 自note外だが実在 → dest から元 md への相対パス（絶対パス化しない）
            newRef = path.relative(destMdDir, target).replace(/\\/g, '/');
        } else {
            continue; // 解決不能 → 触らない
        }
        if (newRef && newRef !== ref) renames.set(ref, newRef);
    }
    return applyLinkUrlRewrites(body, renames);
}

/**
 * markdown 本文中の各リンク/画像の **URL span のみ**を renames に従って差し替える。
 * `parseMarkdownLinks` の {start,end,url} で url 位置を特定し、右→左で splice するので
 * `note.md` の書換が `mynote.md` を巻き込む部分文字列誤置換が起きない（HIGH バグ修正）。
 * renames のキーは「本文に現れる生の url 文字列」（extractAllAssetRefs / extract*Paths が返す値）。
 */
export function applyLinkUrlRewrites(body: string, renames: Map<string, string>): string {
    if (renames.size === 0) return body;
    const links = parser.parseMarkdownLinks(body) as Array<{ url: string; start: number; end: number }>;
    // url span を特定するため、各リンクトークン内で url 部分の絶対 index を求める。
    // トークンは `...](url)`。url は closeParen 直前まで。token 文字列内の url の開始 = end-1-url.length。
    type Edit = { at: number; len: number; repl: string };
    const edits: Edit[] = [];
    for (const lk of links) {
        // parseMarkdownLinks の url は raw（trim/クエリ除去前）。extractAllAssetRefs 側は
        // trim + <>除去 + ?# 分割後の値なので、raw url を同じ正規化して renames と突き合わせる。
        const norm = (lk.url || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        const repl = renames.get(norm);
        if (repl == null || repl === norm) continue;
        // token 内の url 実体位置: token = body.slice(lk.start, lk.end)、url は `(` の次〜`)` の前。
        const token = body.slice(lk.start, lk.end);
        const urlIdxInToken = token.lastIndexOf(lk.url);
        if (urlIdxInToken < 0) continue;
        // norm と raw が違う（<> や ?# 付き）場合は raw 内の norm 位置に限定して置換
        const rawUrl = lk.url;
        const normIdxInRaw = rawUrl.indexOf(norm);
        if (normIdxInRaw < 0) continue;
        const at = lk.start + urlIdxInToken + normIdxInRaw;
        edits.push({ at, len: norm.length, repl });
    }
    // 右→左で適用（index を保つ）
    edits.sort((a, b) => b.at - a.at);
    let out = body;
    for (const e of edits) out = out.slice(0, e.at) + e.repl + out.slice(e.at + e.len);
    return out;
}

/**
 * 1 枚の md（curDir 基準）が参照する画像/添付を dest（共有 destImageDir/destFileDir）へ複製し、
 * body 内のリンクを複製先相対（destMdDir でなく当該 md の位置 = destMdDir と同じ）に書換える。
 * closure md は destMdDir 直下に複製されるので、画像/添付への相対は起点と同じ基準になる。
 */
function copyAssetsAndRewriteForMd(
    body: string,
    curDir: string,
    destImageDir: string,
    destFileDir: string,
    destMdAbs: string,
): string {
    const destMdDir = path.dirname(destMdAbs);
    const refs = extractAllAssetRefs(body);
    const isDrawio = (p: string): boolean => {
        const l = (p || '').toLowerCase();
        return l.endsWith('.drawio.svg') || l.endsWith('.drawio.png');
    };
    // oldRef → newRef を確定してから whole-link-target 置換（部分文字列誤置換を防ぐ）
    const renames = new Map<string, string>();
    // 画像（drawio 以外）→ destImageDir
    for (const ref of refs.images.filter(p => !isDrawio(p))) {
        const src = path.resolve(curDir, ref);
        if (!fs.existsSync(src)) continue;
        const newName = `copy-${Date.now()}-${path.basename(ref)}`;
        const destAbs = path.join(destImageDir, newName);
        try { if (!fs.existsSync(destAbs)) fs.copyFileSync(src, destAbs); } catch { continue; }
        renames.set(ref, path.relative(destMdDir, destAbs).replace(/\\/g, '/'));
    }
    // drawio 画像 + 添付（📎）→ destFileDir
    const fileLikeRefs = [...refs.images.filter(isDrawio), ...refs.files];
    for (const ref of fileLikeRefs) {
        const src = path.resolve(curDir, ref);
        if (!fs.existsSync(src)) continue;
        const originalName = path.basename(ref);
        const lower = originalName.toLowerCase();
        const isMultiExt = lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png');
        const newName = isMultiExt
            ? buildUniqueDrawioName(originalName, (n) => fs.existsSync(path.join(destFileDir, n)))
            : generateUniqueFileNamePreserving(destFileDir, originalName);
        const destAbs = path.join(destFileDir, newName);
        try { if (!fs.existsSync(destAbs)) fs.copyFileSync(src, destAbs); } catch { continue; }
        renames.set(ref, path.relative(destMdDir, destAbs).replace(/\\/g, '/'));
    }
    return applyLinkUrlRewrites(body, renames);
}

// ────────────────────────────────────────────────────────────────────────────
// Unified Functions (v9.1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Unified page asset handler.
 * - newPageId=null: copy without rename (cut behavior)
 * - newPageId set: copy with rename prefix (copy behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handlePageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    pageId: string;
    newPageId: string | null;
    nodeImages: string[];
    sameDirSkip?: boolean;
}): PasteAssetResult {
    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: opts.nodeImages || [] };
    }

    ensureDir(opts.destPagesDir);
    const isCut = opts.newPageId === null;
    const sourcePageId = opts.pageId;
    const targetPageId = isCut ? opts.pageId : opts.newPageId;

    const srcMdPath = path.join(opts.srcPagesDir, `${sourcePageId}.md`);
    const destMdPath = path.join(opts.destPagesDir, `${targetPageId}.md`);

    let mdContent = '';
    if (fs.existsSync(srcMdPath)) {
        try { mdContent = fs.readFileSync(srcMdPath, 'utf8'); } catch { /* ignore */ }
    }

    // 修正2（バックストップ）: copy 経路（!isCut）で src の page md が存在しない場合は
    // dest md を書かない。src md が無ければ本文参照アセットも複製しようがないので
    // nodeImages はそのまま返す。webview が stale pageId を送った際の 0 バイト md 残渣を防ぐ防御。
    // cut 経路は同一 note 内移動の従来挙動を温存するため対象外。
    if (!isCut && !fs.existsSync(srcMdPath)) {
        return { newNodeImages: opts.nodeImages || [] };
    }

    // Extract all image references
    // MD-41: drawio.svg / drawio.png は ![]() 構文だが意味的には file (pages/files/ 配下)。
    // images から分離して file 側で処理する。
    const isDrawioAsset = (p: string): boolean => {
        const lower = (p || '').toLowerCase();
        return lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png');
    };
    const bodyRefsRaw = extractMarkdownImagePaths(mdContent);
    const bodyDrawioRefs = bodyRefsRaw.filter(isDrawioAsset);
    const bodyImageRefs = bodyRefsRaw.filter((p) => !isDrawioAsset(p));
    // nodeImages 側に drawio が紛れ込むケース (通常起きない) も考慮
    const nodeImagesArr = opts.nodeImages || [];
    const nodeImageOnly = nodeImagesArr.filter((p) => !isDrawioAsset(p));
    const nodeImageDrawio = nodeImagesArr.filter(isDrawioAsset);
    const allRefs = Array.from(new Set([...nodeImageOnly, ...bodyImageRefs]));

    const destImagesDir = path.join(opts.destPagesDir, 'images');
    const destFilesDir = path.join(opts.destPagesDir, 'files');
    const destMdDir = opts.destPagesDir; // 起点 md の dir（= 書換の resolve/相対の基準）

    // ── Images ──────────────────────────────────────────────────────────────
    // scope2: 部分文字列誤置換 + basename 衝突を解消するため、
    //   - 本文書換は「本文中の生 ref → destMdDir 基準の新相対」を renames に集約 → applyLinkUrlRewrites で一括。
    //   - dest ファイル名は既定で `copy-<targetPageId>-<basename>`（後方互換 NFR-U-04）。同一 dest 名が
    //     別の物理ファイルに既に割り当て済みなら `-<n>` を basename 前に付けて衝突回避（TC-HPA-02）。
    //   - 同一物理ファイルを指す複数 ref（body ref と nodeImage ref が別文字列で同一ファイル）は
    //     source 絶対パスで dedupe して 1 回だけコピーし、両 ref に同じ dest を割り当てる。
    // cut 経路は従来どおり basename 維持（rename しない）。
    const imgRenames = new Map<string, string>();       // 本文 ref → destMdDir 基準の新相対（本文書換用）
    const nodeImgRename = new Map<string, string>();     // nodeImage ref → destOutDir 基準の新相対
    const srcAbsToDestImg = new Map<string, string>();   // src 絶対 → dest 絶対（同一物理ファイルの再コピー防止）
    const usedImgNames = new Set<string>();              // 既に割当済みの dest ファイル名（衝突回避）

    // 別 src 同名の衝突回避: base 名で衝突したら `<name>-<n><ext>` に退避する。
    const uniqueImgName = (desired: string): string => {
        if (!usedImgNames.has(desired) && !fs.existsSync(path.join(destImagesDir, desired))) {
            usedImgNames.add(desired);
            return desired;
        }
        const ext = path.extname(desired);
        const stem = desired.slice(0, desired.length - ext.length);
        let n = 1;
        let cand = `${stem}-${n}${ext}`;
        while (usedImgNames.has(cand) || fs.existsSync(path.join(destImagesDir, cand))) {
            n++;
            cand = `${stem}-${n}${ext}`;
        }
        usedImgNames.add(cand);
        return cand;
    };

    // body ref を先に処理してから nodeImage-only を処理する（本文書換の対象を優先）。
    const bodyImageSet = new Set(bodyImageRefs);
    const imageRefsOrdered = [...bodyImageRefs, ...nodeImageOnly.filter(r => !bodyImageSet.has(r))];
    const allImageRefs = Array.from(new Set(imageRefsOrdered));
    if (allImageRefs.length > 0) ensureDir(destImagesDir);
    for (const ref of allImageRefs) {
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const srcAbs = path.resolve(srcImg);
        let destImg = srcAbsToDestImg.get(srcAbs);
        if (!destImg) {
            const base = path.basename(ref);
            const destName = isCut ? base : uniqueImgName(`copy-${targetPageId}-${base}`);
            destImg = path.join(destImagesDir, destName);
            if (srcAbs !== path.resolve(destImg)) {
                try {
                    if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
                } catch { /* ignore */ }
            }
            srcAbsToDestImg.set(srcAbs, destImg);
        }
        // 本文用: destMdDir 基準の相対（body ref はこの md 基準で書かれている）
        if (bodyImageSet.has(ref)) {
            imgRenames.set(ref, path.relative(destMdDir, destImg).replace(/\\/g, '/'));
        }
    }
    // nodeImage 用マップ: nodeImage ref → destOutDir 基準の新相対
    for (const ref of nodeImageOnly) {
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = srcAbsToDestImg.get(path.resolve(srcImg));
        if (!destImg) continue;
        nodeImgRename.set(ref, path.relative(opts.destOutDir, destImg).replace(/\\/g, '/'));
    }

    // Rewrite image links in MD content (only for copy, not for cut)
    let newMdContent = mdContent;
    if (!isCut) {
        newMdContent = applyLinkUrlRewrites(newMdContent, imgRenames);
    }

    // ── Files + drawio (image syntax の drawio.svg/png も file 扱い) ──────────
    const regularFileRefs: string[] = parser.extractMarkdownFileLinks(mdContent);
    const fileRefs: string[] = Array.from(new Set([...regularFileRefs, ...bodyDrawioRefs, ...nodeImageDrawio]));
    if (fileRefs.length > 0) {
        ensureDir(destFilesDir);
        const fileRenames = new Map<string, string>();
        for (const fileRef of fileRefs) {
            const srcFile = resolveSourceImage(fileRef, opts.srcOutDir, opts.srcPagesDir);
            if (!srcFile) continue;
            const originalName = path.basename(fileRef);
            // TC-03: drawio.svg/png は多重拡張子 suffix 対応
            const lowerOrig = originalName.toLowerCase();
            const isMultiExt = lowerOrig.endsWith('.drawio.svg') || lowerOrig.endsWith('.drawio.png');
            let newName: string;
            if (isCut) {
                newName = originalName;
            } else if (isMultiExt) {
                newName = buildUniqueDrawioName(originalName, (n) =>
                    fs.existsSync(path.join(destFilesDir, n))
                );
            } else {
                newName = generateUniqueFileNamePreserving(destFilesDir, originalName);
            }
            const destFile = path.join(destFilesDir, newName);
            if (path.resolve(srcFile) === path.resolve(destFile)) continue;
            try {
                if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
            } catch { /* ignore */ }
            // 本文書換: 生 ref → destMdDir 基準の新相対（whole-link-target）
            if (!isCut && bodyDrawioRefs.includes(fileRef)) {
                // drawio は本文中 ![]() 構文の image ref なので imgRenames に集約して後で処理
                imgRenames.set(fileRef, path.relative(destMdDir, destFile).replace(/\\/g, '/'));
            } else if (!isCut) {
                fileRenames.set(fileRef, path.relative(destMdDir, destFile).replace(/\\/g, '/'));
            }
        }
        if (!isCut) {
            // drawio（image 構文）分は imgRenames に入っているので再度画像書換を適用
            newMdContent = applyLinkUrlRewrites(newMdContent, imgRenames);
            newMdContent = applyLinkUrlRewrites(newMdContent, fileRenames);
        }
    }

    // ── mdLinks: [text](*.md) の完全再帰複製（scope3） ────────────────────────
    // cut 経路は再帰しない（同一 note 内移動 / 名前維持の従来挙動を温存）。
    if (!isCut) {
        // sourceMdDir = srcPagesDir（page md が置かれる dir）を自note境界とする。
        const sourceMdDir = opts.srcPagesDir;
        const syntheticRoot = path.join(sourceMdDir, '__page_paste_root__.md');
        const { closure } = collectMdLinkClosure(syntheticRoot, sourceMdDir, mdContent);
        if (closure.length > 0) ensureDir(opts.destPagesDir);
        const closureNameMap = new Map<string, string>(); // srcAbs → destMdDir 基準 rel
        const closureDestAbs = new Map<string, string>();  // srcAbs → destAbs
        for (const srcAbs of closure) {
            const uniqueName = generateUniqueFileNamePreserving(opts.destPagesDir, path.basename(srcAbs));
            const destAbs = path.join(opts.destPagesDir, uniqueName);
            try { fs.copyFileSync(srcAbs, destAbs); } catch { continue; }
            closureNameMap.set(srcAbs, path.relative(opts.destPagesDir, destAbs).replace(/\\/g, '/'));
            closureDestAbs.set(srcAbs, destAbs);
        }
        // 起点(newMdContent) の md-link のみ書換（★LOW-1: 起点の画像/添付は scope2 で処理済み・二重処理しない）
        newMdContent = rewriteMdLinksInBody(newMdContent, sourceMdDir, opts.destPagesDir, closureNameMap);
        // closure 各複製 md をフル処理（画像/添付複製 + 全リンク書換）。
        // 起点 md に画像が無いケースでも closure md の画像を受けられるよう images/files を事前作成する
        // （copyAssetsAndRewriteForMd は destImageDir を ensureDir しないため）。
        if (closureDestAbs.size > 0) {
            ensureDir(destImagesDir);
            ensureDir(destFilesDir);
        }
        for (const srcAbs of closure) {
            const destAbs = closureDestAbs.get(srcAbs);
            if (!destAbs) continue;
            const curDir = path.dirname(srcAbs); // resolve 基準 = その md 自身の dir（= srcPagesDir）
            let body = '';
            try { body = fs.readFileSync(destAbs, 'utf8'); } catch { continue; }
            body = copyAssetsAndRewriteForMd(
                body, curDir,
                destImagesDir,
                destFilesDir,
                destAbs,
            );
            body = rewriteMdLinksInBody(body, curDir, opts.destPagesDir, closureNameMap);
            try { fs.writeFileSync(destAbs, body, 'utf8'); } catch { /* ignore */ }
        }
    }

    try { fs.writeFileSync(destMdPath, newMdContent, 'utf8'); } catch { /* ignore */ }

    // Build newNodeImages（ref キー単位で解決。ヒットしない = コピー対象外は原値維持）
    const newNodeImages = (opts.nodeImages || []).map(orig =>
        nodeImgRename.get(orig) ?? orig);

    return { newNodeImages };
}

/**
 * Unified image asset handler.
 * - renamePrefix=null: copy without rename (cut behavior)
 * - renamePrefix set: copy with prefix (copy behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handleImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    renamePrefix: string | null;
    nodeImages: string[];
    sameDirSkip?: boolean;
}): PasteAssetResult {
    const images = opts.nodeImages || [];
    if (images.length === 0) return { newNodeImages: [] };

    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: images };
    }

    ensureDir(opts.destPagesDir);
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    ensureDir(destImagesDir);

    const isCut = opts.renamePrefix === null;
    const renameMap = new Map<string, string>();

    if (!isCut) {
        for (const ref of images) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, opts.renamePrefix + base);
        }
    } else {
        for (const ref of images) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, base);
        }
    }

    // Copy images
    for (const ref of images) {
        const base = path.basename(ref);
        const newBase = renameMap.get(base)!;
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, newBase);
        if (srcImg === destImg) continue;
        try {
            if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
        } catch { /* ignore */ }
    }

    const destImagesRelToOut = path
        .relative(opts.destOutDir, destImagesDir)
        .replace(/\\/g, '/');
    const newNodeImages = images.map(orig => {
        const base = path.basename(orig);
        const newBase = renameMap.get(base) || base;
        return destImagesRelToOut ? `${destImagesRelToOut}/${newBase}` : newBase;
    });

    return { newNodeImages };
}

/**
 * Unified file asset handler.
 * - useCollisionSuffix=true: add collision suffix (copy behavior)
 * - useCollisionSuffix=false: use original name (cut behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handleFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string;
    useCollisionSuffix?: boolean;
    sameDirSkip?: boolean;
}): { newFilePath: string | null } {
    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcFileDir === opts.destFileDir) {
        return { newFilePath: opts.filePath };
    }

    ensureDir(opts.destFileDir);

    const srcFilePath = path.isAbsolute(opts.filePath)
        ? opts.filePath
        : path.resolve(opts.srcOutDir, opts.filePath);

    if (!fs.existsSync(srcFilePath)) {
        return { newFilePath: null };
    }

    const originalName = path.basename(srcFilePath);
    // TC-03 仕様準拠: 多重拡張子 (.drawio.svg / .drawio.png) は suffix を多重拡張子の前に付ける
    // (foo.drawio.svg → foo-1.drawio.svg、generateUniqueFileNamePreserving だと foo.drawio-1.svg になる)
    const lowerName = originalName.toLowerCase();
    const isMultiExt = lowerName.endsWith('.drawio.svg') || lowerName.endsWith('.drawio.png');
    let uniqueName: string;
    if (!opts.useCollisionSuffix) {
        uniqueName = originalName;
    } else if (isMultiExt) {
        uniqueName = buildUniqueDrawioName(originalName, (n) =>
            fs.existsSync(path.join(opts.destFileDir, n))
        );
    } else {
        uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
    }
    const destFilePath = path.join(opts.destFileDir, uniqueName);

    if (srcFilePath === destFilePath) {
        return { newFilePath: opts.filePath };
    }

    try {
        if (!fs.existsSync(destFilePath) || opts.useCollisionSuffix) {
            fs.copyFileSync(srcFilePath, destFilePath);
        }
    } catch {
        return { newFilePath: null };
    }

    const relPath = path.relative(opts.destOutDir, destFilePath).replace(/\\/g, '/');
    return { newFilePath: relPath };
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy Functions (backward compatibility wrappers)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 新 filename で画像・ファイルを実体コピーし、.md 本文の参照も rewrite する。
 * cmd+c 経路。srcPagesDir === destPagesDir でも常に新 filename を発行する。
 * @deprecated Use handlePageAssets with newPageId set
 */
export function copyPageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    sourcePageId: string;
    newPageId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handlePageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        pageId: opts.sourcePageId,
        newPageId: opts.newPageId,
        nodeImages: opts.nodeImages,
        sameDirSkip: false
    });
}

/**
 * .md と画像・ファイルを src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op で元の nodeImages を返す。
 * cmd+x 経路。
 * @deprecated Use handlePageAssets with newPageId=null and sameDirSkip=true
 */
export function movePageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    pageId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handlePageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        pageId: opts.pageId,
        newPageId: null,
        nodeImages: opts.nodeImages,
        sameDirSkip: true
    });
}

/**
 * 非 isPage ノードの images[] を新 filename で実体コピー。
 * srcPagesDir === destPagesDir でも常に新 filename を発行する。
 * @deprecated Use handleImageAssets with renamePrefix set
 */
export function copyImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    newNodeId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handleImageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        renamePrefix: `copy-${opts.newNodeId}-`,
        nodeImages: opts.nodeImages,
        sameDirSkip: false
    });
}

/**
 * 非 isPage ノードの images[] を src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op。
 * @deprecated Use handleImageAssets with renamePrefix=null and sameDirSkip=true
 */
export function moveImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handleImageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        renamePrefix: null,
        nodeImages: opts.nodeImages,
        sameDirSkip: true
    });
}

/**
 * filePath 付きノードを copy 時にファイルを新 filename で実体コピー。
 * 元の名前を保ちつつ collision suffix (-1, -2, etc.) を付与する。
 * @deprecated Use handleFileAsset with useCollisionSuffix=true
 */
export function copyFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string; // relative from srcOutDir
}): { newFilePath: string | null } {
    return handleFileAsset({
        srcOutDir: opts.srcOutDir,
        srcFileDir: opts.srcFileDir,
        destOutDir: opts.destOutDir,
        destFileDir: opts.destFileDir,
        filePath: opts.filePath,
        useCollisionSuffix: true,
        sameDirSkip: false
    });
}

/**
 * filePath 付きノードを cut+cross-file 時にファイルを src → dest にコピー (元ファイルは削除しない — cleanup が管理)。
 * 同 dir なら no-op (元の filePath を返す)。
 * @deprecated Use handleFileAsset with useCollisionSuffix=false and sameDirSkip=true
 */
export function moveFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string;
}): { newFilePath: string | null } {
    return handleFileAsset({
        srcOutDir: opts.srcOutDir,
        srcFileDir: opts.srcFileDir,
        destOutDir: opts.destOutDir,
        destFileDir: opts.destFileDir,
        filePath: opts.filePath,
        useCollisionSuffix: false,
        sameDirSkip: true
    });
}

/**
 * Generate unique filename preserving original name with collision suffix.
 * Examples: report.pdf, report-1.pdf, report-2.pdf
 */
export function generateUniqueFileNamePreserving(targetDir: string, originalName: string): string {
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);

    let candidate = originalName;
    let suffix = 0;

    while (fs.existsSync(path.join(targetDir, candidate))) {
        suffix++;
        candidate = `${baseName}-${suffix}${ext}`;
    }

    return candidate;
}

/**
 * MD paste asset copy: extract image/file links from markdown, copy assets to dest, rewrite paths.
 * Used by MD editor copy/paste (side panel cross-outliner paste).
 */
export interface MdPasteAssetResult {
    rewrittenMarkdown: string;
}

/**
 * webview の resource URL 接頭辞を strip する。
 * cleanImageSrc が完全に剥がせなかったり、Turndown 経由の絶対 URL が
 * markdown に紛れた場合に「フルパス化」を防ぐため、複製前に正規化する。
 */
function stripWebviewUrlPrefixes(md: string): string {
    if (!md) return md;
    md = md.replace(/https:\/\/file\+\.vscode-resource\.vscode-cdn\.net/g, '');
    md = md.replace(/https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net/g, '');
    md = md.replace(/vscode-resource:\/\//g, '');
    md = md.replace(/vscode-webview:\/\//g, '');
    return md;
}

/**
 * markdown から ![alt](url) / [📎...](url) / [text](*.md) を抽出する。
 * extractImagePaths と違い **絶対パス・http(s) URL も結果に含める** (copyMdPasteAssets が後段でコピー判断)。
 * - images: `![](url)`
 * - files:  `[📎 ...](url)` (添付ファイル指定)
 * - mdLinks: `[text](url)` で url が `.md` で終わるもの (📎 でも image でもない通常リンク)
 */
export function extractAllAssetRefs(md: string): { images: string[]; files: string[]; mdLinks: string[] } {
    const images = new Set<string>();
    const files = new Set<string>();
    const mdLinks = new Set<string>();
    if (!md) return { images: [], files: [], mdLinks: [] };
    // images: ![alt](url)
    const imgRe = /!\[[^\]]*\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(md)) !== null) {
        const url = (m[1] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:)/i.test(url)) continue; // remote / data は除外
        images.add(url);
    }
    // files: [📎 ...](url)
    const fileRe = /\[📎[^\]]*\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    while ((m = fileRe.exec(md)) !== null) {
        const url = (m[1] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:)/i.test(url)) continue;
        files.add(url);
    }
    // mdLinks: [text](url.md) - 画像 (`!` 始まり) と 📎 始まり以外
    // (^|[^!]) で `!` 直前を排除、 \[(?!📎) で 📎 始まりを排除
    const mdLinkRe = /(^|[^!])\[(?!📎)[^\]]+\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    while ((m = mdLinkRe.exec(md)) !== null) {
        const url = (m[2] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:|fractal:)/i.test(url)) continue;
        if (url.startsWith('#')) continue; // anchor link
        if (!url.toLowerCase().endsWith('.md') && !url.toLowerCase().endsWith('.markdown')) continue;
        mdLinks.add(url);
    }
    return { images: Array.from(images), files: Array.from(files), mdLinks: Array.from(mdLinks) };
}

export function copyMdPasteAssets(opts: {
    markdown: string;
    sourceMdDir: string;
    sourceImageDir: string;
    sourceFileDir: string;
    destImageDir: string;
    destFileDir: string;
    destMdDir: string;
}): MdPasteAssetResult {
    // Step 1: webview URL 接頭辞を strip して、後段が絶対パスとして扱えるようにする
    let rewrittenMarkdown = stripWebviewUrlPrefixes(opts.markdown);

    // Step 2: ![]() / [📎]() を全件抽出 (絶対パスも含める。extractImagePaths は絶対パスをスキップするので使わない)
    const refs = extractAllAssetRefs(rewrittenMarkdown);

    // MD-41 拡張: drawio.svg / drawio.png は ![]() 構文だが file 系（destFileDir）へ振り分ける
    const isDrawioAsset = (p: string): boolean => {
        const lower = (p || '').toLowerCase();
        return lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png');
    };
    const imagePaths = refs.images.filter((p: string) => !isDrawioAsset(p));
    const drawioImagePaths = refs.images.filter((p: string) => isDrawioAsset(p));

    // Extract file paths from markdown (📎 attached files)
    const filePaths = refs.files;

    // Ensure dest directories exist
    if (imagePaths.length > 0) {
        ensureDir(opts.destImageDir);
    }
    if (filePaths.length > 0 || drawioImagePaths.length > 0) {
        ensureDir(opts.destFileDir);
    }

    // Copy images with rename pattern: copy-{timestamp}-{originalName}
    const timestamp = Date.now();
    const imageRenameMap = new Map<string, string>();

    for (const imagePath of imagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, imagePath);
        if (!fs.existsSync(srcAbsolute)) {
            continue; // Skip missing files
        }

        const originalName = path.basename(imagePath);
        const newName = `copy-${timestamp}-${originalName}`;
        const destAbsolute = path.join(opts.destImageDir, newName);

        // Copy file
        try {
            if (!fs.existsSync(destAbsolute)) {
                fs.copyFileSync(srcAbsolute, destAbsolute);
            }
        } catch {
            continue; // Skip on error
        }

        // Calculate new relative path from destMdDir
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        imageRenameMap.set(imagePath, newRelativePath);
    }

    // MD-41 拡張: drawio asset を destFileDir にコピー（imageDir には保存しない）
    // TC-03 / TC-15: 衝突 suffix は多重拡張子の前 (foo-1.drawio.svg) — buildUniqueDrawioName を使用
    for (const drawioPath of drawioImagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, drawioPath);
        if (!fs.existsSync(srcAbsolute)) continue;
        const originalName = path.basename(drawioPath);
        const uniqueName = buildUniqueDrawioName(originalName, (n) =>
            fs.existsSync(path.join(opts.destFileDir, n))
        );
        const destAbsolute = path.join(opts.destFileDir, uniqueName);
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            continue;
        }
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        imageRenameMap.set(drawioPath, newRelativePath);
    }

    // Rewrite image paths in markdown（whole-link-target: 部分文字列誤置換を防ぐ。TASK-05）
    rewrittenMarkdown = applyLinkUrlRewrites(rewrittenMarkdown, imageRenameMap);

    // Copy files with original name + collision suffix
    const fileRenameMap = new Map<string, string>();

    for (const filePath of filePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, filePath);
        if (!fs.existsSync(srcAbsolute)) {
            continue; // Skip missing files
        }

        const originalName = path.basename(filePath);
        const uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
        const destAbsolute = path.join(opts.destFileDir, uniqueName);

        // Copy file
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            continue; // Skip on error
        }

        // Calculate new relative path from destMdDir
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        fileRenameMap.set(filePath, newRelativePath);
    }

    // Rewrite file paths in markdown（whole-link-target。TASK-05）
    rewrittenMarkdown = applyLinkUrlRewrites(rewrittenMarkdown, fileRenameMap);

    // mdLinks: [text](*.md) 通常リンク → **自note内は再帰複製**、外部は相対パス書換のみ。
    // md-link-recursive-copy (2026-07-07): 収集フェーズ（closure）→ 複製フェーズ（per-md 書換）の 2 パス。
    // 起点は webview 文字列（opts.markdown = rewrittenMarkdown の元）なので、
    // synthetic root abs（sourceMdDir 直下）を使い rootBody を渡して closure を収集する。
    const syntheticRootAbs = path.join(opts.sourceMdDir, '__paste_root__.md');
    const { closure } = collectMdLinkClosure(syntheticRootAbs, opts.sourceMdDir, opts.markdown);

    // フェーズ B-0: closure 各 md を dest へ複製し、srcAbs → dest 相対パス(destMdDir 基準) を確定
    if (closure.length > 0) ensureDir(opts.destMdDir);
    const closureNameMap = new Map<string, string>(); // srcAbs → destRelFromDestMdDir ('/' 区切り)
    const closureDestAbs = new Map<string, string>(); // srcAbs → destAbs
    for (const srcAbs of closure) {
        const originalName = path.basename(srcAbs);
        const uniqueName = generateUniqueFileNamePreserving(opts.destMdDir, originalName);
        const destAbs = path.join(opts.destMdDir, uniqueName);
        try {
            fs.copyFileSync(srcAbs, destAbs);
        } catch {
            continue;
        }
        closureNameMap.set(srcAbs, path.relative(opts.destMdDir, destAbs).replace(/\\/g, '/'));
        closureDestAbs.set(srcAbs, destAbs);
    }

    // フェーズ B-2: 起点 md（rewrittenMarkdown）+ closure 各複製 md の本文を per-md 書換。
    //   - md-link(closure 内) → closureNameMap の dest 相対
    //   - md-link(external / 自note外) → dest から元 md への相対パス（絶対パスにしない）
    //   - 画像/添付 → dest の複製先（closure md 分も複製）
    // 起点は sourceMdDir 基準（既に上で画像/添付/rewrittenMarkdown を処理済み）なので、
    // ここでは起点の md-link 書換のみ行い、closure md はフル処理する。
    rewrittenMarkdown = rewriteMdLinksInBody(
        rewrittenMarkdown, opts.sourceMdDir, opts.destMdDir, closureNameMap,
    );

    // closure 各複製 md をフル処理（画像/添付複製 + 全リンク書換）
    for (const srcAbs of closure) {
        const destAbs = closureDestAbs.get(srcAbs);
        if (!destAbs) continue; // 複製失敗はスキップ
        const curSrcDir = path.dirname(srcAbs); // ★resolve 基準 = その md 自身の dir
        let body = '';
        try { body = fs.readFileSync(destAbs, 'utf8'); } catch { continue; }
        // 画像/添付を dest へ複製 + 本文書換（起点と同じ dest image/file dir を共有）
        body = copyAssetsAndRewriteForMd(body, curSrcDir, opts.destImageDir, opts.destFileDir, destAbs);
        // md-link を書換（closure→dest 相対 / external→dest からの相対）
        body = rewriteMdLinksInBody(body, curSrcDir, opts.destMdDir, closureNameMap);
        try { fs.writeFileSync(destAbs, body, 'utf8'); } catch { /* ignore */ }
    }

    return { rewrittenMarkdown };
}
