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
// paste-image-1to1-ownership (2026-07-09): 貼り付け画像の 1:1 所有権保証ファクトリ
// ────────────────────────────────────────────────────────────────────────────

/**
 * 1 paste 呼び出しにつき 1 インスタンス。destImagesDir に対する unique 名採番 + 同一 src dedup。
 *
 * 返す closure `(srcAbs, desiredName) => destAbs`:
 * - `srcAbsToDest.has(srcAbs)` → 既存の dest を返す（同一物理ソース = 1 コピー共有、1:1 OK）。
 * - それ以外 → existence + used-set の連番退避（`name-1.ext`, `name-2.ext`…）で必ず別名を割当て、
 *   物理コピー（`srcAbs===destAbs` の自己コピーのみ skip）してから srcAbsToDest に記録、destAbs を返す。
 *
 * ★basename 衝突 skip は廃止: 別 src（src 絶対が違う）は必ず別名 → 物理コピーされる（データロス防止）。
 * 手本 = handlePageAssets のインライン `usedImgNames`/`srcAbsToDestImg`/`uniqueImgName` と同一ロジック。
 */
function makeUniqueImageCopier(destImagesDir: string): (srcAbs: string, desiredName: string) => string {
    const used = new Set<string>();                 // 既に割当済みの dest ファイル名
    const srcAbsToDest = new Map<string, string>(); // src 絶対 → dest 絶対（同一物理ソースの再コピー防止）
    const uniqueName = (desired: string): string => {
        if (!used.has(desired) && !fs.existsSync(path.join(destImagesDir, desired))) {
            used.add(desired);
            return desired;
        }
        const ext = path.extname(desired);
        const stem = desired.slice(0, desired.length - ext.length);
        let n = 1;
        let cand = `${stem}-${n}${ext}`;
        while (used.has(cand) || fs.existsSync(path.join(destImagesDir, cand))) {
            n++;
            cand = `${stem}-${n}${ext}`;
        }
        used.add(cand);
        return cand;
    };
    return (srcAbs: string, desiredName: string): string => {
        const key = path.resolve(srcAbs);
        const hit = srcAbsToDest.get(key);
        if (hit) return hit; // 同一物理ソース → 既存コピーを共有（1:1 OK）
        const destName = uniqueName(desiredName);
        const destAbs = path.join(destImagesDir, destName);
        if (path.resolve(srcAbs) !== path.resolve(destAbs)) {
            try { fs.copyFileSync(srcAbs, destAbs); } catch { /* ignore */ }
        }
        srcAbsToDest.set(key, destAbs);
        return destAbs;
    };
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
        // ★subpage (`[[]]`) だけ follow して複製する（参照リンク `[]` は複製しない = ゲート反転・ADR-0009）。
        //   mdLinkRefs で種別付き。参照リンクの URL 書換は rewriteMdLinksInBody が mdLinks（両種別）で別途行う。
        for (const ref of extractAllAssetRefs(body).mdLinkRefs) {
            if (!ref.isSubpage) { continue; } // 参照リンクは follow しない（複製しない）
            const url = ref.url;
            const target = path.isAbsolute(url) ? path.resolve(url) : path.resolve(curDir, url);
            if (!isUnderNoteDir(target, sourceMdDir) || !fs.existsSync(target)) {
                external.add(target); // 自note外 subpage or 解決不能 → 複製しない（ADRL-0002）
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
    imgCopier?: (srcAbs: string, desiredName: string) => string,
): string {
    const destMdDir = path.dirname(destMdAbs);
    const refs = extractAllAssetRefs(body);
    const isDrawio = (p: string): boolean => {
        const l = (p || '').toLowerCase();
        return l.endsWith('.drawio.svg') || l.endsWith('.drawio.png');
    };
    // 1:1 所有権保証: 同一物理 src は 1 コピー共有・別 src 同名は連番退避で別ファイル化。
    // closure ループから共有 copier を受ければ closure md 群で used セットを共有する（同名別画像の衝突回避）。
    // 未指定なら関数内で生成（単独呼び出しの後方互換）。
    const copyImg = imgCopier || makeUniqueImageCopier(destImageDir);
    // oldRef → newRef を確定してから whole-link-target 置換（部分文字列誤置換を防ぐ）
    const renames = new Map<string, string>();
    // 画像（drawio 以外）→ destImageDir
    for (const ref of refs.images.filter(p => !isDrawio(p))) {
        const src = path.resolve(curDir, ref);
        if (!fs.existsSync(src)) continue;
        const destAbs = copyImg(path.resolve(src), `copy-${Date.now()}-${path.basename(ref)}`);
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
/**
 * cross paste の cut/copy セマンティクス確定（sprint 20260728-200503 — 両 provider の単一施行点）。
 * webview の message.isCut は OS クリップボードの HTML メタ由来で、clipboard.write 失敗等で
 * **過去の cut 操作の stale メタ**を拾いうる。host の Store には copy/cut 時に OS クリップボードと
 * 無関係の直接 message で真実の isCut が保存されているため、両者の AND を実効値とする:
 * - webview=cut / Store=copy → stale cut メタ確定 → copy に矯正（staleCutCorrected=true。
 *   呼び出し側は新 pageId を発行し updateNodePageId で webview に postback する）
 * - webview=copy / Store=cut → copy のまま（新 id での複製は常に安全。cut の元削除は
 *   ソース webview が実施済みで、残 md は orphan として cleanup が回収）
 */
export function resolveCrossPasteCut(messageIsCut: boolean, storeIsCut: boolean): {
    effectiveIsCut: boolean;
    staleCutCorrected: boolean;
} {
    const effectiveIsCut = !!messageIsCut && !!storeIsCut;
    return { effectiveIsCut, staleCutCorrected: !!messageIsCut && !storeIsCut };
}

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
    const srcAbsToDestImg = new Map<string, string>();   // src 絶対 → dest 絶対（同一物理ファイルの再コピー防止 + nodeImage 追従）
    // 1:1 所有権保証ファクトリ（copy 経路のみ）。同一 src dedup + 別 src 同名は連番退避で別ファイル化。
    const copyImg = makeUniqueImageCopier(destImagesDir);

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
            if (isCut) {
                // cut は移動セマンティクス: basename 維持・存在時 skip（従来どおり）。
                destImg = path.join(destImagesDir, base);
                if (srcAbs !== path.resolve(destImg)) {
                    try {
                        if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
                    } catch { /* ignore */ }
                }
            } else {
                destImg = copyImg(srcAbs, `copy-${targetPageId}-${base}`);
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
        // closure md 群で 1 つの copier を共有: 別 closure md が同名の別画像を持つ時、
        // 同じ used セット + srcAbs dedup で連番退避しないと衝突する（1:1 所有権保証）。
        const closureImgCopier = makeUniqueImageCopier(destImagesDir);
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
                closureImgCopier,
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
    const destImagesRelToOut = path
        .relative(opts.destOutDir, destImagesDir)
        .replace(/\\/g, '/');

    // cut 経路（renamePrefix===null）: 移動セマンティクスで従来どおり basename 維持（既に 1:1）。
    if (isCut) {
        for (const ref of images) {
            const base = path.basename(ref);
            const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
            if (!srcImg) continue;
            const destImg = path.join(destImagesDir, base);
            if (srcImg === destImg) continue;
            try {
                if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
            } catch { /* ignore */ }
        }
        const newNodeImages = images.map(orig => {
            const base = path.basename(orig);
            return destImagesRelToOut ? `${destImagesRelToOut}/${base}` : base;
        });
        return { newNodeImages };
    }

    // copy 経路: 1:1 所有権保証。ref ごとに src 絶対を解決し copier で dest を決定する。
    // basename キー renameMap（旧）だと同名別 dir 参照が同一 dest に畳まれ 1 枚消失したため、
    // per-ref マップ（ref → dest 相対）に置き換える。別 src 同名は連番退避で別ファイル化。
    const copyImg = makeUniqueImageCopier(destImagesDir);
    const refToNodeImage = new Map<string, string>(); // ref → destOutDir 基準の新相対
    for (const ref of images) {
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destAbs = copyImg(path.resolve(srcImg), opts.renamePrefix + path.basename(ref));
        refToNodeImage.set(ref, path.relative(opts.destOutDir, destAbs).replace(/\\/g, '/'));
    }
    const newNodeImages = images.map(orig => {
        const hit = refToNodeImage.get(orig);
        if (hit) return hit;
        // 解決不能（src 不在）は後方互換で従来の basename 命名を返す。
        const base = path.basename(orig);
        const newBase = opts.renamePrefix + base;
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
 * sprint 20260801-200307 (FR-DDX-02, TASK-04): 入口で basename 化 + 厳密名 `.`/`..` ガード。
 * 共有 export 版に防御を置くことで全 caller（editorProvider / notesEditorProvider の
 * Notes md 面 4 経路）が一律に守られる。global な `..` replace は正当な連続ドット名
 * （archive..tar.gz 等）を破壊するため使わない — path.basename() がディレクトリ成分を
 * 除去済みで、残る危険は厳密名 `.`/`..` のみ。
 */
export function generateUniqueFileNamePreserving(targetDir: string, originalName: string): string {
    originalName = path.basename(String(originalName || 'file'));
    if (!originalName || originalName === '.' || originalName === '..') originalName = 'file';
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
 * - mdLinks: `[text](url)` で url が `.md` で終わるもの (📎 でも image でもない通常リンク)。両種別 (subpage `[[]]` + 参照 `[]`)
 * - mdLinkRefs: mdLinks を種別付き ({ url, isSubpage }) で返す。複製ゲート (collectMdLinkClosure) が subpage だけ follow するのに使う
 */
export function extractAllAssetRefs(md: string): {
    images: string[]; files: string[];
    mdLinks: string[];
    mdLinkRefs: { url: string; isSubpage: boolean }[];
} {
    const images = new Set<string>();
    const files = new Set<string>();
    const mdLinks = new Set<string>();
    const mdLinkRefs: { url: string; isSubpage: boolean }[] = [];
    if (!md) return { images: [], files: [], mdLinks: [], mdLinkRefs: [] };
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
    // mdLinks / mdLinkRefs: parser.parseMarkdownLinks で subpage 判別を一元化 (`[[]]` も拾う)
    // url 正規化: title strip (`[x](y.md "title")`) → クエリ/フラグメント除去
    const normalizeMdUrl = (raw: string): string => {
        let u = (raw || '').trim().replace(/^<|>$/g, '');
        u = u.replace(/\s+["'][^"']*["']\s*$/, ''); // 末尾 title ("..." / '...') を除去
        return u.split(/[?#]/)[0];
    };
    const seenRef = new Set<string>();
    for (const tok of parser.parseMarkdownLinks(md) as Array<{ kind: string; alt: string; url: string; isSubpage?: boolean }>) {
        if (tok.kind !== 'link') continue;
        const altTrim = (tok.alt || '').trim();
        if (altTrim.indexOf('📎') === 0) continue; // 📎 添付は files 側
        const url = normalizeMdUrl(tok.url);
        if (!url) continue;
        if (/^(data:|https?:|file:|fractal:)/i.test(url)) continue;
        if (url.startsWith('#')) continue; // anchor link
        const lower = url.toLowerCase();
        if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) continue;
        mdLinks.add(url);
        const key = url + '|' + (tok.isSubpage ? '1' : '0');
        if (!seenRef.has(key)) { seenRef.add(key); mdLinkRefs.push({ url, isSubpage: !!tok.isSubpage }); }
    }
    return { images: Array.from(images), files: Array.from(files), mdLinks: Array.from(mdLinks), mdLinkRefs };
}

/**
 * md リンク url の正規化キー候補を返す（trim → `<>`strip → 末尾 title strip → `?#` 除去 + decode 両候補）。
 * flat-migrate の subpage 昇格 allowlist 構築側と、promoteMdLinksToSubpage の body 照合側が **同一実装**を通すことで
 * `![](images/a%20b.png)`（decode で一致・raw で不一致）や title 付き `[x](y.md "t")` の表現差を吸収する（M1-a）。
 */
export function normalizeMdLinkKeys(url: string): string[] {
    let u = (url || '').trim().replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']\s*$/, '').split(/[?#]/)[0];
    const keys = [u];
    try { const d = decodeURIComponent(u); if (d !== u) keys.push(d); } catch { /* 不正 encode は raw のみ */ }
    return keys;
}

/**
 * 本文中のプレーン md リンク `[label](x.md)` を subpage marker `[[label]](x.md)` に昇格する。
 * - 既に `[[]]`（subpage）のものは触らない（冪等）。
 * - 画像 `![]()`・📎 添付・http/data/file/fractal/anchor は対象外。
 * - `onlyUrls` 指定時: normalizeMdLinkKeys(t.url) のいずれかが onlyUrls に含まれるリンクだけ昇格
 *   （FR-MG-13 = 条件付き昇格。同 stem・node/note 未参照の subpage だけを flat-migrate 側が allowlist で渡す）。
 * - `onlyUrls` 省略時: 全 .md リンクを昇格（後方互換。src では未使用だが他 caller・既存 TC 温存のため残す）。
 * flat-migrate が旧フォルダ note の md 本文に適用する（applyLinkUrlRewrites は url span しか置換できず括弧を足せないため新規）。
 */
export function promoteMdLinksToSubpage(body: string, onlyUrls?: Set<string>): string {
    if (!body) return body;
    const toks = parser.parseMarkdownLinks(body) as Array<{ kind: string; alt: string; url: string; isSubpage?: boolean; start: number; end: number }>;
    // end 降順で置換（index ズレ回避・parseInline と同じパターン）
    const targets = toks
        .filter((t) => t.kind === 'link' && !t.isSubpage)
        .filter((t) => {
            // title strip してから .md 判定
            const u = (t.url || '').replace(/\s+["'][^"']*["']\s*$/, '').split(/[?#]/)[0].toLowerCase();
            return (u.endsWith('.md') || u.endsWith('.markdown'))
                && !/^(https?:|data:|file:|fractal:)/i.test(t.url) && !t.url.startsWith('#');
        })
        .filter((t) => (t.alt || '').trim().indexOf('📎') !== 0) // 📎 添付は除外
        // ★FR-MG-13: onlyUrls 指定時は allowlist に一致する url だけ昇格（正規化キーで照合）
        .filter((t) => !onlyUrls || normalizeMdLinkKeys(t.url).some((k) => onlyUrls.has(k)))
        .sort((a, b) => b.end - a.end);
    let out = body;
    for (const t of targets) {
        const replacement = '[[' + t.alt + ']](' + t.url + ')';
        out = out.slice(0, t.start) + replacement + out.slice(t.end);
    }
    return out;
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
    // 1:1 所有権保証: 別 dir 同名の別実体は連番退避で別ファイル化・同一物理 src は 1 コピー集約。
    // basename 衝突 skip（旧 `if(!existsSync) skip`）は廃止（別 src が 1 枚目に畳まれるデータロスを防止）。
    const timestamp = Date.now();
    const imageRenameMap = new Map<string, string>();
    const copyImg = makeUniqueImageCopier(opts.destImageDir);

    for (const imagePath of imagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, imagePath);
        if (!fs.existsSync(srcAbsolute)) {
            continue; // Skip missing files
        }

        const originalName = path.basename(imagePath);
        const destAbsolute = copyImg(path.resolve(srcAbsolute), `copy-${timestamp}-${originalName}`);

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
    // 起点 md に画像/添付が無いケース（imagePaths/filePaths が空で上の ensureDir を通っていない）でも
    // closure md の画像/添付を受けられるよう、dest image/file dir を事前作成する
    // （copyAssetsAndRewriteForMd / copier は destImageDir を ensureDir しないため）。
    if (closureDestAbs.size > 0) {
        ensureDir(opts.destImageDir);
        ensureDir(opts.destFileDir);
    }
    // closure md 群で 1 つの copier を共有（別 md が同名別画像を持っても連番退避で別ファイル化 = 1:1 所有権保証）。
    const closureImgCopier = makeUniqueImageCopier(opts.destImageDir);
    for (const srcAbs of closure) {
        const destAbs = closureDestAbs.get(srcAbs);
        if (!destAbs) continue; // 複製失敗はスキップ
        const curSrcDir = path.dirname(srcAbs); // ★resolve 基準 = その md 自身の dir
        let body = '';
        try { body = fs.readFileSync(destAbs, 'utf8'); } catch { continue; }
        // 画像/添付を dest へ複製 + 本文書換（起点と同じ dest image/file dir を共有）
        body = copyAssetsAndRewriteForMd(body, curSrcDir, opts.destImageDir, opts.destFileDir, destAbs, closureImgCopier);
        // md-link を書換（closure→dest 相対 / external→dest からの相対）
        body = rewriteMdLinksInBody(body, curSrcDir, opts.destMdDir, closureNameMap);
        try { fs.writeFileSync(destAbs, body, 'utf8'); } catch { /* ignore */ }
    }

    return { rewrittenMarkdown };
}

// ─────────────────────────────────────────────────────────────────────────────
// outliner node リスト → md editor paste の添付複製 (sprint 20260727-124904 / ADRL-0001)
// FR-NP-02..04: nodes (OutlinerClipboardStore 由来) からインデント md リストを組み立て、
//   - isPage node → page md を dirname(destMd) に複製 + 行末に subpage リンク [[title]](<id>.md)
//   - filePath node → destFilesDir に複製 + 行末に [📎 name](<相対>)
//   - images node → destImagesDir に複製 + 直後行に ![](<相対>)
// 既存プリミティブ (handlePageAssets / handleFileAsset) を再利用。1:1 所有 (NFR-NP-04)。
// ─────────────────────────────────────────────────────────────────────────────

/** subpage リンクラベルのサニタイズ (markdown-link-parser の [[label]] は `]` 単体で切れる制約。
 *  clipper-core.sanitizeSubpageTitle と同規約: `]`→`］` / `[`→`［` / 改行→空白 / 空→(untitled)) */
export function sanitizeSubpageLabel(title: string): string {
    const t = String(title || '').replace(/[\r\n]+/g, ' ').trim();
    if (!t) return '(untitled)';
    return t.replace(/\]/g, '］').replace(/\[/g, '［');
}

export interface OutlinerPasteNode {
    text: string;
    level: number;
    isPage?: boolean;
    pageId?: string | null;
    images?: string[];
    filePath?: string | null;
}

export function buildOutlinerNodesPasteMd(opts: {
    nodes: OutlinerPasteNode[];
    srcOutDir: string;
    srcPagesDir: string;
    srcFileDir: string;
    destMdPath: string;      // 貼り付け先 md の絶対パス (subpage md は dirname に置く)
    destFilesDir: string;    // resolveFilesDirForMd(destMdPath)
    destImagesDir: string;   // resolveImagesDirForMd(destMdPath)
    generatePageId?: () => string; // テスト注入用 (default: crypto.randomUUID)
}): { markdown: string } {
    const destMdDir = path.dirname(opts.destMdPath);
    const genId = opts.generatePageId
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        || (() => (require('crypto') as typeof import('crypto')).randomUUID());
    const lines: string[] = [];

    for (const node of opts.nodes || []) {
        const indent = '  '.repeat(Math.max(0, node.level || 0));
        const plainText = String(node.text || '').replace(/\n/g, ' ');
        let line = `${indent}- ${plainText}`;

        // (a) page md → 複製 + subpage リンク (FR-NP-02)
        if (node.isPage && node.pageId) {
            const srcMd = path.join(opts.srcPagesDir, `${node.pageId}.md`);
            if (fs.existsSync(srcMd)) {
                const newPageId = genId();
                // handlePageAssets が md 複製 + 本文参照 images/files の再帰複製 + リンク書換を行う
                // (destPagesDir = destMdDir: 新規 subpage md は「dirname(対象 md)」に置く —
                //  ADRL-0018 decision 4。note 直下固定は禁止)
                handlePageAssets({
                    srcOutDir: opts.srcOutDir,
                    srcPagesDir: opts.srcPagesDir,
                    destOutDir: destMdDir,
                    destPagesDir: destMdDir,
                    pageId: node.pageId,
                    newPageId: newPageId,
                    nodeImages: node.images || [],
                });
                // 改善2 (手動検収): label = nodetext なので素の text を繰り返さずリンクのみにする
                line = `${indent}- [[${sanitizeSubpageLabel(node.text)}]](${newPageId}.md)`;
            } else {
                // 参照切れ: リンクなしで行は残す (FR-NP-02。paste 全体は失敗させない)
                console.warn(`[buildOutlinerNodesPasteMd] page md not found: ${srcMd}`);
            }
        }

        // (b) ファイル添付 → 複製 + 📎 リンク (FR-NP-03)
        if (node.filePath) {
            const r = handleFileAsset({
                srcOutDir: opts.srcOutDir,
                srcFileDir: opts.srcFileDir,
                destOutDir: destMdDir,
                destFileDir: opts.destFilesDir,
                filePath: node.filePath,
                useCollisionSuffix: true,
            });
            if (r.newFilePath) {
                const abs = path.isAbsolute(r.newFilePath)
                    ? r.newFilePath
                    : path.resolve(destMdDir, r.newFilePath);
                const rel = path.relative(destMdDir, abs).replace(/\\/g, '/');
                // 改善2: nodetext をリンクテキストに使い、素の text の繰り返しを避ける
                // (page 添付と併存する場合は line が既にリンク化済みなので append)
                if (node.isPage && node.pageId) {
                    line += ` [📎 ${path.basename(abs)}](${rel})`;
                } else {
                    line = `${indent}- [📎 ${plainText || path.basename(abs)}](${rel})`;
                }
            } else {
                console.warn(`[buildOutlinerNodesPasteMd] attached file not found: ${node.filePath}`);
            }
        }

        lines.push(line);

        // (c) node 直付き画像 (非 page) → 複製 + 画像行 (FR-NP-04)。
        //     page node の images は handlePageAssets が処理済みなので対象外。
        if (!node.isPage && node.images && node.images.length) {
            ensureDir(opts.destImagesDir);
            for (const ref of node.images) {
                const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
                if (!srcImg) {
                    console.warn(`[buildOutlinerNodesPasteMd] node image not found: ${ref}`);
                    continue;
                }
                // 1:1 所有: 常に新実体 (衝突時 uniquify)
                const destName = generateUniqueFileNamePreserving(opts.destImagesDir, path.basename(srcImg));
                try { fs.copyFileSync(srcImg, path.join(opts.destImagesDir, destName)); } catch { continue; }
                const rel = path.relative(destMdDir, path.join(opts.destImagesDir, destName)).replace(/\\/g, '/');
                lines.push(`${indent}  ![](${rel})`);
            }
        }
    }

    return { markdown: lines.join('\n') + '\n' };
}

/**
 * pasteOutlinerNodesWithAssets の host 側共通処理 (4 provider から呼ばれる)。
 * OutlinerClipboardStore からソース dir + nodes を取得し、buildOutlinerNodesPasteMd で
 * 複製 + md 組み立て。Store miss 時は fallbackNodes (webview 検知用 nodes) から
 * リストのみ (添付リンクなし) を組む — エラーにしない (ADRL-0001 Consequences)。
 * 戻り値の markdown を呼び出し側が pasteWithAssetCopyResult で postback する。
 */
export function runOutlinerNodesPaste(opts: {
    plainText: string;
    fallbackNodes: OutlinerPasteNode[];
    destMdPath: string;
    // 循環 import 回避のため Store は呼び出し側から関数注入
    getClipboard: (plainText: string) => {
        nodes: OutlinerPasteNode[];
        sourcePagesDirPath: string;
        sourceFileDirPath: string;
        sourceOutDir: string;
    } | null;
    destFilesDir: string;
    destImagesDir: string;
}): { markdown: string } {
    const store = opts.getClipboard(opts.plainText);
    if (!store) {
        // fallback: 添付なしリストのみ (複製はソース dir が不明なため不可)
        const lines = (opts.fallbackNodes || []).map(n =>
            `${'  '.repeat(Math.max(0, n.level || 0))}- ${String(n.text || '').replace(/\n/g, ' ')}`);
        return { markdown: lines.join('\n') + '\n' };
    }
    return buildOutlinerNodesPasteMd({
        nodes: store.nodes,
        srcOutDir: store.sourceOutDir,
        srcPagesDir: store.sourcePagesDirPath,
        srcFileDir: store.sourceFileDirPath,
        destMdPath: opts.destMdPath,
        destFilesDir: opts.destFilesDir,
        destImagesDir: opts.destImagesDir,
    });
}

/**
 * outliner node subtree の Export bundle core (FR-EB-03/04/05)。
 * <dest>/<nodeId>/ を作成し <nodeId>.md + page md 複製 + files/ を出力。
 * node 直付き画像 (node.images) はここで [] に強制して無視する (FR-EB-04 単一施行点。
 * page md 本文参照画像は handlePageAssets が images/ に複製する = 「page md 添付」の一部)。
 * dialog は呼び出し側 (export-bundle-host)。dest 確定後にのみ呼ぶこと (NFR-04)。
 */
export function runOutlinerNodesExportBundle(opts: {
    nodeId: string;
    nodes: OutlinerPasteNode[];
    srcOutDir: string;
    srcPagesDir: string;
    srcFileDir: string;
    dest: string;                      // ダイアログで選択済みの出力先フォルダ
    generatePageId?: () => string;     // テスト注入
}): { ok: boolean; bundleDir?: string; error?: string } {
    try {
        // nodeId は webview message 経由 (.out から verbatim ロード = 外部由来になりうる) で
        // 信頼境界を越えるため、path に使う前に basename 化して traversal を遮断する
        // (通常の node id 't...'/'n...' 形式には no-op)。空/./.. は generic 名にフォールバック。
        const safeName = path.basename(String(opts.nodeId || ''));
        const base = (!safeName || safeName === '.' || safeName === '..') ? 'export' : safeName;

        // FR-EB-05: <dest>/<nodeId>/ 衝突時サフィックス (md-export-core uniqueDir と同パターン)
        let cand = base;
        let i = 1;
        while (fs.existsSync(path.join(opts.dest, cand))) { cand = `${base}-${i++}`; }
        const bundleDir = path.join(opts.dest, cand);
        fs.mkdirSync(bundleDir, { recursive: true });

        // FR-EB-04: node 直付き画像は無視 (単一施行点)
        const stripped = (opts.nodes || []).map(n => ({ ...n, images: [] as string[] }));

        const destMdPath = path.join(bundleDir, `${base}.md`);
        const r = buildOutlinerNodesPasteMd({
            nodes: stripped,
            srcOutDir: opts.srcOutDir,
            srcPagesDir: opts.srcPagesDir,
            srcFileDir: opts.srcFileDir,
            destMdPath: destMdPath,                         // dirname = bundleDir → page md は bundleDir 直下 (FR-EB-03)
            destFilesDir: path.join(bundleDir, 'files'),    // file 添付 → files/
            destImagesDir: path.join(bundleDir, 'images'),  // 非 page 画像は stripped で不発。page 本文画像は handlePageAssets 側
            generatePageId: opts.generatePageId,
        });
        fs.writeFileSync(destMdPath, r.markdown);
        return { ok: true, bundleDir };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
