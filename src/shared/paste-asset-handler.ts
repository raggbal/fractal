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
 * source containment（reviewer iter1 SEC-1）: 解決済み資産パスが許可 roots のいずれかの配下か。
 * roots 未指定 = 制限なし（paste 直接経路の既存挙動 — 絶対パス import は spec pin 済みの仕様）。
 * 指定時 = ディスク上の md 本文（非信頼入力）由来の絶対パス /../ escape 参照を複製対象から外す。
 */
function isRefUnderRoots(srcAbs: string, roots?: string[]): boolean {
    if (!roots || roots.length === 0) return true;
    return roots.some((r) => isUnderNoteDir(srcAbs, r));
}

/**
 * 複製結果報告（NFR-ACD-01 — sprint 20260822-051129）。opt-in の out-param:
 * 呼び出し側が渡した場合のみ記録する（未指定 = 従来どおり無記録・挙動 byte 不変）。
 * - copied: 複製に成功した source 絶対パス（画像/📎/drawio/closure md）
 * - copyFailed: 複製を試みて失敗（削除フェーズの全成功判定はこれが空であること）
 * - skipped: missing（元々 broken）/ containment-skip（境界外 = 複製対象外）— ブロックしない
 */
export interface MdPasteAssetReport {
    copied: string[];
    copyFailed: string[];
    skipped: string[];
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
    restrictSourceRoots?: string[],
    report?: MdPasteAssetReport,
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
        if (!fs.existsSync(src)) { report?.skipped.push(src); continue; }
        if (!isRefUnderRoots(src, restrictSourceRoots)) { report?.skipped.push(src); continue; } // SEC-1: roots 外は複製しない（書換なし温存）
        const destAbs = copyImg(path.resolve(src), `copy-${Date.now()}-${path.basename(ref)}`);
        // QUAL-1（reviewer iter1）: makeUniqueImageCopier は copy 失敗を握って destAbs を返す —
        // report 指定時（= 削除フェーズの全成功判定に使う transfer 経路）のみ実在検証して copyFailed に落とす
        if (report) {
            if (!fs.existsSync(destAbs)) { report.copyFailed.push(src); continue; }
            report.copied.push(src);
        }
        renames.set(ref, path.relative(destMdDir, destAbs).replace(/\\/g, '/'));
    }
    // drawio 画像 + 添付（📎）→ destFileDir
    const fileLikeRefs = [...refs.images.filter(isDrawio), ...refs.files];
    for (const ref of fileLikeRefs) {
        const src = path.resolve(curDir, ref);
        if (!fs.existsSync(src)) { report?.skipped.push(src); continue; }
        if (!isRefUnderRoots(src, restrictSourceRoots)) { report?.skipped.push(src); continue; } // SEC-1: roots 外は複製しない
        const originalName = path.basename(ref);
        const lower = originalName.toLowerCase();
        const isMultiExt = lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png');
        const newName = isMultiExt
            ? buildUniqueDrawioName(originalName, (n) => fs.existsSync(path.join(destFileDir, n)))
            : generateUniqueFileNamePreserving(destFileDir, originalName);
        const destAbs = path.join(destFileDir, newName);
        try { if (!fs.existsSync(destAbs)) fs.copyFileSync(src, destAbs); } catch { report?.copyFailed.push(src); continue; }
        report?.copied.push(src);
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
        // closure 複製（uniquify 予約 → 複製 → 資産複製 + リンク書換）はエンジンに集約（TASK-04）。
        const closureNameMap = replicateMdClosureToDest({
            closure, destMdDir: opts.destPagesDir, destImageDir: destImagesDir, destFileDir: destFilesDir,
        });
        // 起点(newMdContent) の md-link のみ書換（★LOW-1: 起点の画像/添付は scope2 で処理済み・二重処理しない）
        newMdContent = rewriteMdLinksInBody(newMdContent, sourceMdDir, opts.destPagesDir, closureNameMap);
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
    /**
     * FR-EXF-03（Export folder）: dest 側の希望ファイル名（拡張子込み）。
     * 未指定なら従来どおり `basename(src)`（既存呼び出し面の挙動は不変）。
     * 衝突時は useCollisionSuffix に従って既存 uniquify 規則で連番になる。
     */
    destName?: string;
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

    // destName 指定時はそれを希望名にする（Export folder = node text 名。未指定は従来どおり src の basename）
    const originalName = opts.destName ? path.basename(opts.destName) : path.basename(srcFilePath);
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
 * md closure 複製エンジン（sprint 20260819-231621 TASK-03 — copyMdPasteAssets フェーズ B と
 * handlePageAssets mdLinks ブロックの逐語重複 ~35 行 × 2 を集約）。
 * closure 各 md を destMdDir へ uniquify 複製し、各複製 md の資産（画像/📎）を
 * destImage/FileDir へ複製 + 全リンクを dest 相対で書換える。
 * closure の収集（collectMdLinkClosure・syntheticRoot）と起点 md のリンク書換は
 * 呼び出し側の責務（返り値 closureNameMap を rewriteMdLinksInBody に渡す）。
 * @returns closureNameMap: srcAbs → destMdDir 基準の複製先相対パス（'/' 区切り）
 */
export function replicateMdClosureToDest(opts: {
    closure: string[];
    destMdDir: string;
    destImageDir: string;
    destFileDir: string;
    restrictSourceRoots?: string[]; // SEC-1: closure member の資産参照にも source containment を通す
    report?: MdPasteAssetReport;    // NFR-ACD-01: opt-in 複製結果報告
}): Map<string, string> {
    const { closure, destMdDir, destImageDir, destFileDir } = opts;
    if (closure.length > 0) ensureDir(destMdDir);
    const closureNameMap = new Map<string, string>(); // srcAbs → destRelFromDestMdDir ('/' 区切り)
    const closureDestAbs = new Map<string, string>(); // srcAbs → destAbs
    for (const srcAbs of closure) {
        const uniqueName = generateUniqueFileNamePreserving(destMdDir, path.basename(srcAbs));
        const destAbs = path.join(destMdDir, uniqueName);
        try {
            fs.copyFileSync(srcAbs, destAbs);
        } catch {
            opts.report?.copyFailed.push(srcAbs);
            continue;
        }
        opts.report?.copied.push(srcAbs);
        closureNameMap.set(srcAbs, path.relative(destMdDir, destAbs).replace(/\\/g, '/'));
        closureDestAbs.set(srcAbs, destAbs);
    }
    // 起点 md に画像/添付が無いケースでも closure md の資産を受けられるよう dest dir を事前作成
    // （copyAssetsAndRewriteForMd / copier は destImageDir を ensureDir しないため）。
    if (closureDestAbs.size > 0) {
        ensureDir(destImageDir);
        ensureDir(destFileDir);
    }
    // closure md 群で 1 つの copier を共有（別 md が同名別画像を持っても連番退避で別ファイル化 = 1:1 所有権保証）。
    const closureImgCopier = makeUniqueImageCopier(destImageDir);
    for (const srcAbs of closure) {
        const destAbs = closureDestAbs.get(srcAbs);
        if (!destAbs) continue; // 複製失敗はスキップ
        const curSrcDir = path.dirname(srcAbs); // ★resolve 基準 = その md 自身の dir
        let body = '';
        try { body = fs.readFileSync(destAbs, 'utf8'); } catch { continue; }
        body = copyAssetsAndRewriteForMd(body, curSrcDir, destImageDir, destFileDir, destAbs, closureImgCopier, opts.restrictSourceRoots, opts.report);
        body = rewriteMdLinksInBody(body, curSrcDir, destMdDir, closureNameMap);
        try { fs.writeFileSync(destAbs, body, 'utf8'); } catch { /* ignore */ }
    }
    return closureNameMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// 随伴転送（sprint 20260820-063902 / ADRL-ACC-1）
// md ファイルを資産（images / 📎files / subpage 再帰閉包）ごと dest 座標へ複製する adapter。
// 実体は copyMdPasteAssets（正典・無改造）— 座標指定だけでフラット⇄隣接（fv）レイアウト変換が
// 成立する。copy semantics（source 不触 — 移動の source 側処理は呼び出し面の責務 = 2 段構成）。
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferCoords {
    sourceMdDir: string;
    sourceImageDir: string;
    sourceFileDir: string;
    destMdDir: string;
    destImageDir: string;
    destFileDir: string;
}

/** 座標半組（source/dest どちらか片側）。noteCoords / adjacentCoords / mdCoords が返す共通形 */
export interface CoordHalf { mdDir: string; imageDir: string; fileDir: string }

/** note フラット座標（共有 images//files/ + note 直下）。flat-layout 正典 resolver の束ね */
export function noteCoords(mainFolderAbs: string): CoordHalf {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const flatLayout = require('./flat-layout');
    return {
        mdDir: flatLayout.resolveMdRootDir(mainFolderAbs),
        imageDir: flatLayout.resolveMdImagesDir(mainFolderAbs),
        fileDir: flatLayout.resolveMdFilesDir(mainFolderAbs),
    };
}

/** 隣接座標（fv / md 隣の images//files/ — resolveImagesDirForMd と同型の dirname ベース） */
export function adjacentCoords(mdDirAbs: string): CoordHalf {
    return {
        mdDir: mdDirAbs,
        imageDir: path.join(mdDirAbs, 'images'),
        fileDir: path.join(mdDirAbs, 'files'),
    };
}

/** md 自身の座標半組（resolve*ForMd 正典 — flat note では共有 dir・legacy pages/ でも親共有 dir に解決） */
export function mdCoords(mdAbs: string): CoordHalf {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const flatLayout = require('./flat-layout');
    return {
        mdDir: path.dirname(mdAbs),
        imageDir: flatLayout.resolveImagesDirForMd(mdAbs),
        fileDir: flatLayout.resolveFilesDirForMd(mdAbs),
    };
}

/** source/dest の座標半組から TransferCoords を組む（半組の生成は noteCoords / adjacentCoords / mdCoords に一本化 — reviewer iter1 QUAL-1/DESIGN-1） */
export function makeTransferCoords(src: CoordHalf, dest: CoordHalf): TransferCoords {
    return {
        sourceMdDir: src.mdDir, sourceImageDir: src.imageDir, sourceFileDir: src.fileDir,
        destMdDir: dest.mdDir, destImageDir: dest.imageDir, destFileDir: dest.fileDir,
    };
}

/**
 * md ファイルを資産随伴で dest へ複製（FR-ACC-01）。
 * - 随伴内容・命名・closure 再帰は copyMdPasteAssets の既存挙動そのまま
 *   （画像 = copy-<ts>- prefix / 📎・closure md = 元名維持 + -N uniquify・参照リンクは書換のみ）
 * - dest の images//files/ は資産がある時のみ作成（正典挙動）
 * - throw = source 不在 / 書込失敗（呼び出し側の既存 catch 経路に乗せる — 新 message を足さない）
 */
export function transferMdWithAssets(
    srcMdAbs: string,
    coords: TransferCoords,
    preferredName?: string,
    // NFR-ACC-02b rev2: fv 起点移動は linkedfd root を追加 root として許容（linkedfd 内共有フォルダ運用の随伴）
    // NFR-ACD-01: report = opt-in 複製結果報告（削除フェーズの全成功判定に使う）
    opts?: { extraSourceRoots?: string[]; report?: MdPasteAssetReport }
): { destMdPath: string; newName: string } {
    if (!fs.existsSync(srcMdAbs) || !fs.statSync(srcMdAbs).isFile()) {
        throw new Error(`transferMdWithAssets: source not found: ${srcMdAbs}`);
    }
    const body = fs.readFileSync(srcMdAbs, 'utf8');
    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown: body,
        sourceMdDir: coords.sourceMdDir,
        sourceImageDir: coords.sourceImageDir,
        sourceFileDir: coords.sourceFileDir,
        destImageDir: coords.destImageDir,
        destFileDir: coords.destFileDir,
        destMdDir: coords.destMdDir,
        // SEC-1: ディスク上の md 本文は非信頼入力 — 資産の読取は source 座標 3 dir（+ 呼び出し面が明示した追加 root）に contain する
        restrictSourceRoots: [coords.sourceMdDir, coords.sourceImageDir, coords.sourceFileDir, ...(opts?.extraSourceRoots || [])],
        report: opts?.report,
    });
    ensureDir(coords.destMdDir);
    const newName = generateUniqueFileNamePreserving(
        coords.destMdDir,
        path.basename(preferredName || path.basename(srcMdAbs))
    );
    const destMdPath = path.join(coords.destMdDir, newName);
    fs.writeFileSync(destMdPath, rewrittenMarkdown, 'utf8');
    return { destMdPath, newName };
}

/**
 * file 実体コピーの正典（uniquify + copyFileSync — sprint 20260819-231621 TASK-01 で
 * notes-message-handler の module-local から export 移設。uniquify 正典の隣が置き場）。
 * 成功 = dst 絶対パス / 失敗 = null（元は無傷・例外は swallow — folder-view 系の既存契約を維持）。
 */
export function copyEntityWithUniquify(srcAbs: string, dstDirAbs: string, preferredName: string): string | null {
    try {
        const uniqueName = generateUniqueFileNamePreserving(dstDirAbs, preferredName);
        const dstAbs = path.join(dstDirAbs, uniqueName);
        fs.copyFileSync(srcAbs, dstAbs);
        if (!fs.existsSync(dstAbs)) { return null; }
        return dstAbs;
    } catch {
        return null;
    }
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
    // images / files: 正典パーサ parseMarkdownLinks で抽出する（bugfix 2026-08-09:
    // 旧 regex `[^)\s"]+` はスペース入りファイル名 `files/my file.docx` にマッチせず
    // 複製から silent 脱落していた。パーサは括弧バランス走査でスペースを扱える）。
    // url 正規化は旧 regex と同一: trim → <>strip → 末尾 title strip → ?# 除去。
    const normalizeAssetUrl = (raw: string): string => {
        let u = (raw || '').trim().replace(/^<|>$/g, '');
        u = u.replace(/\s+["'][^"']*["']\s*$/, ''); // 末尾 title ("..." / '...') を除去
        return u.split(/[?#]/)[0];
    };
    for (const tok of parser.parseMarkdownLinks(md) as Array<{ kind: string; alt: string; url: string }>) {
        const url = normalizeAssetUrl(tok.url);
        if (!url) continue;
        if (/^(data:|https?:|file:)/i.test(url)) continue; // remote / data は除外
        if (tok.kind === 'image') {
            images.add(url);
        } else if (tok.kind === 'link' && (tok.alt || '').trim().indexOf('📎') === 0) {
            files.add(url);
        }
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
    /** SEC-1（reviewer iter1）: 指定時、解決済み資産参照が roots 配下でなければ複製しない（書換なし温存）。
     *  未指定 = 制限なし — clipboard paste 直接経路の「絶対パス入力でも複製」pin（cross-outliner /
     *  location-matrix spec）を壊さないための opt-in。ディスク上の md 本文を流す構造的操作
     *  （transferMdWithAssets 経由の Duplicate / D&D / Move）だけが指定する。 */
    restrictSourceRoots?: string[];
    /** NFR-ACD-01: opt-in 複製結果報告（未指定 = 従来どおり無記録・挙動不変） */
    report?: MdPasteAssetReport;
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
            opts.report?.skipped.push(srcAbsolute);
            continue; // Skip missing files
        }
        if (!isRefUnderRoots(srcAbsolute, opts.restrictSourceRoots)) { opts.report?.skipped.push(srcAbsolute); continue; } // SEC-1

        const originalName = path.basename(imagePath);
        const destAbsolute = copyImg(path.resolve(srcAbsolute), `copy-${timestamp}-${originalName}`);
        // QUAL-1（reviewer iter1）: 画像 copier は失敗 swallow — report 指定時のみ実在検証
        if (opts.report) {
            if (!fs.existsSync(destAbsolute)) { opts.report.copyFailed.push(srcAbsolute); continue; }
            opts.report.copied.push(srcAbsolute);
        }

        // Calculate new relative path from destMdDir
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        imageRenameMap.set(imagePath, newRelativePath);
    }

    // MD-41 拡張: drawio asset を destFileDir にコピー（imageDir には保存しない）
    // TC-03 / TC-15: 衝突 suffix は多重拡張子の前 (foo-1.drawio.svg) — buildUniqueDrawioName を使用
    for (const drawioPath of drawioImagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, drawioPath);
        if (!fs.existsSync(srcAbsolute)) { opts.report?.skipped.push(srcAbsolute); continue; }
        if (!isRefUnderRoots(srcAbsolute, opts.restrictSourceRoots)) { opts.report?.skipped.push(srcAbsolute); continue; } // SEC-1
        const originalName = path.basename(drawioPath);
        const uniqueName = buildUniqueDrawioName(originalName, (n) =>
            fs.existsSync(path.join(opts.destFileDir, n))
        );
        const destAbsolute = path.join(opts.destFileDir, uniqueName);
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            opts.report?.copyFailed.push(srcAbsolute);
            continue;
        }
        opts.report?.copied.push(srcAbsolute);
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
            opts.report?.skipped.push(srcAbsolute);
            continue; // Skip missing files
        }
        if (!isRefUnderRoots(srcAbsolute, opts.restrictSourceRoots)) { opts.report?.skipped.push(srcAbsolute); continue; } // SEC-1

        const originalName = path.basename(filePath);
        const uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
        const destAbsolute = path.join(opts.destFileDir, uniqueName);

        // Copy file
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            opts.report?.copyFailed.push(srcAbsolute);
            continue; // Skip on error
        }
        opts.report?.copied.push(srcAbsolute);

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

    // closure 複製（uniquify 予約 → 複製 → 資産複製 + リンク書換）はエンジンに集約（TASK-03）。
    const closureNameMap = replicateMdClosureToDest({
        closure, destMdDir: opts.destMdDir, destImageDir: opts.destImageDir, destFileDir: opts.destFileDir,
        restrictSourceRoots: opts.restrictSourceRoots,
        report: opts.report,
    });

    // 起点 md（rewrittenMarkdown）の md-link 書換のみ呼び出し側で実施
    //（起点の画像/添付は上で処理済み — closure 内→dest 相対 / external→dest からの相対）。
    rewrittenMarkdown = rewriteMdLinksInBody(
        rewrittenMarkdown, opts.sourceMdDir, opts.destMdDir, closureNameMap,
    );

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

/**
 * FR-XP-01 (sprint 20260808-000219): pasteWithAssetCopy の宛先 md 解決 seam。
 * sidepanel 経路は message.sidePanelFilePath が畳まれているのでそれを使い、
 * main md 経路（sidePanelFilePath なし）は host が知る自 document のパスに fallback する。
 * 従来は sidePanelFilePath 必須ガードで main md paste が silent no-op だった
 * （notes-host-bridge.js:265-276 の pasteOutlinerNodesWithAssets override と同型の穴）。
 * pure 関数（fs/vscode 非依存）— unit から直接 require して behavioral 検証する。
 */
export function resolvePasteWithAssetCopyDest(
    sidePanelFilePath: string | undefined | null,
    documentFsPath: string | undefined | null
): string | null {
    if (sidePanelFilePath) return sidePanelFilePath;
    if (documentFsPath) return documentFsPath;
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// md 範囲選択 copy → outliner paste の添付 node 化 + asset 複製
// (sprint 20260808-000219 FR-XP-02 / ADRL-md-paste-transport「単一 postback」)
// webview (outliner.js handleNodePaste) が text/x-any-md + context を host へ送り
// (pasteMdIntoOutliner)、host が本関数で複製 + 行→node 変換を一括実行して
// pasteMdIntoOutlinerResult で確定 node 配列を返す。per-line cross message
// (updateNodeFilePath 等の placeholder 上書き postback) は使わない。
// ─────────────────────────────────────────────────────────────────────────────

export interface MdOutlinerPasteNode {
    text: string;
    level: number;
    images?: string[];
    filePath?: string;
    isPage?: boolean;
    pageId?: string;
}

/**
 * FR-XP-02: md テキストを outliner node 記述の配列に変換する。
 * - 実体複製は copyMdPasteAssets（既存エンジン・無変更）に委譲し、書換済み md の
 *   行を分類する: 行全体が画像リンク → 画像 node / 行全体が 📎 → file 添付 node /
 *   行全体が subpage [[t]](x.md) → page node（pageId = 複製後 md の stem）/ それ以外 → text node
 * - cut + sameOutliner（sourceCtx と dest の imageDir+fileDir 文字列一致 = editor.js:18611 の
 *   分岐と同一規則）は複製せず参照そのまま node 化（同一 note 内 move セマンティクス）。
 * - source 実体は消さない（orphan → cleanup 回収。cut の統一規約）。
 * pure 寄り関数（fs は copyMdPasteAssets 経由のみ）— unit から直接 require して behavioral 検証。
 */
export function runMdIntoOutlinerPaste(opts: {
    mdText: string;
    sourceContext: { imageDir: string; fileDir: string; mdDir: string };
    isCut: boolean;
    destOutDir: string;
    destPagesDir: string;
    destImagesDir: string;
    destFilesDir: string;
}): { nodes: MdOutlinerPasteNode[] } {
    // SEC-4 (reviewer): sourceContext は OS クリップボード由来の外部入力。
    // 3 フィールドが string でなければ複製せずプレーンテキスト扱い（型ガード）。
    const ctx = opts.sourceContext;
    if (!ctx || typeof ctx.imageDir !== 'string' || typeof ctx.fileDir !== 'string' || typeof ctx.mdDir !== 'string') {
        opts = { ...opts, isCut: true, sourceContext: { imageDir: opts.destImagesDir, fileDir: opts.destFilesDir, mdDir: opts.destPagesDir } };
    }
    const sameOutliner = !!opts.sourceContext
        && opts.sourceContext.imageDir === opts.destImagesDir
        && opts.sourceContext.fileDir === opts.destFilesDir;

    let body = opts.mdText || '';
    if (!(opts.isCut && sameOutliner)) {
        // copy / cross-cut: 実体を dest note へ複製しリンクを書換（既存エンジン流用）
        const r = copyMdPasteAssets({
            markdown: body,
            sourceMdDir: opts.sourceContext.mdDir,
            sourceImageDir: opts.sourceContext.imageDir,
            sourceFileDir: opts.sourceContext.fileDir,
            destImageDir: opts.destImagesDir,
            destFileDir: opts.destFilesDir,
            destMdDir: opts.destPagesDir,
        });
        body = r.rewrittenMarkdown;
    }

    // 行→node 変換。インデント規則は outliner.js pasteNodesFromText の外部経路と同一
    // （タブ / 2〜4 スペース = 1 レベル・空行スキップ・先頭バレット除去）。
    // リンク相対パスは destPagesDir 基準（copyMdPasteAssets の destMdDir）なので、
    // node.images / node.filePath は destOutDir 基準に付け替える。
    const toOutRel = (rel: string): string => {
        const abs = path.resolve(opts.destPagesDir, rel);
        return path.relative(opts.destOutDir, abs).replace(/\\/g, '/');
    };

    // 行全体が単一リンクか（bugfix 2026-08-09: 旧 regex `[^)\s"]+` はスペース入り
    // ファイル名にマッチせず、docx がテキスト node に落ちてリンク切れになった。
    // 正典パーサで解析し「行 == リンクトークン 1 個」を判定する）。
    const classifyLine = (content: string): { kind: 'image' | 'file' | 'subpage'; alt: string; url: string } | null => {
        const toks = parser.parseMarkdownLinks(content) as Array<{ kind: string; alt: string; url: string; isSubpage?: boolean; start: number; end: number }>;
        if (toks.length !== 1) return null;
        const t = toks[0];
        if (t.start !== 0 || t.end !== content.length) return null; // 行内混在はテキスト node
        const url = (t.url || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) return null;
        const altTrim = (t.alt || '').trim();
        if (t.kind === 'image') return { kind: 'image', alt: altTrim, url };
        if (t.isSubpage && url.toLowerCase().endsWith('.md')) return { kind: 'subpage', alt: altTrim, url };
        if (altTrim.indexOf('📎') === 0) return { kind: 'file', alt: altTrim.replace(/^📎\s*/, ''), url };
        return null;
    };

    const nodes: MdOutlinerPasteNode[] = [];
    for (const rawLine of body.split('\n')) {
        let j = 0;
        let level = 0;
        let sawTab = false;
        while (j < rawLine.length) {
            if (rawLine[j] === '\t') { level++; j++; sawTab = true; }
            else if (rawLine[j] === ' ' && !sawTab) {
                let spaces = 0;
                while (j < rawLine.length && rawLine[j] === ' ') { spaces++; j++; }
                level += Math.max(1, Math.round(spaces / 2));
            } else { break; }
        }
        let content = rawLine.substring(j).replace(/^(?:[-*+]|\d+\.)[ \t]+/, '').trim();
        if (content === '') continue;

        const cls = classifyLine(content);
        if (cls && cls.kind === 'image') {
            nodes.push({ text: cls.alt, level, images: [toOutRel(cls.url)] });
        } else if (cls && cls.kind === 'file') {
            nodes.push({ text: cls.alt, level, filePath: toOutRel(cls.url) });
        } else if (cls && cls.kind === 'subpage') {
            const stem = path.basename(cls.url, '.md');
            nodes.push({ text: cls.alt, level, isPage: true, pageId: stem });
        } else {
            nodes.push({ text: content, level });
        }
    }
    return { nodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// DuplicationCore（sprint 20260818-183407 / ADRL-0078）
//
// Duplicate 系 3 面（md リンク Duplicate = FR-MDM-02 / tree item Duplicate = FR-FTM-03）の
// 実体複製エンジン。asset 1:1 所有 invariant を 1 箇所に閉じ込める:
// naive fs.copyFile 単体は「複製 md が元 asset を共有 → 片方削除で他方リンク切れ /
// Clean Notes 誤回収」の invariant 破り。
// uniquify は generateUniqueFileNamePreserving（本ファイル :808 正典）のみ（ADRL-0005 =
// 新規衝突解決ロジック禁止）。
// clamp（noteDir 配下検査）は呼び出し側 provider の責務（core は与えられた abs パスを信頼する
// 既存流儀 — copyMdPasteAssets 等と同じ）。
// outliner node の Duplicate（FR-OCM-03）はこの core を使わない — 既存 cmd+v 経路
// （pasteNodesFromText + per-node asset 複製）が同 invariant を実装済みのため二重実装しない。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * files/ 実体の複製。同 dir に uniquify 新名でコピーし新 filename を返す。
 * 元 filename が存在しない場合は throw（呼び出し側がエラー通知 — silent 握り禁止）。
 */
export function duplicateFileEntity(filesDirAbs: string, filename: string): string {
    const srcAbs = path.join(filesDirAbs, path.basename(String(filename || '')));
    if (!fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
        throw new Error(`duplicateFileEntity: source not found: ${srcAbs}`);
    }
    const newName = generateUniqueFileNamePreserving(filesDirAbs, path.basename(srcAbs));
    fs.copyFileSync(srcAbs, path.join(filesDirAbs, newName));
    return newName;
}

/** rel パス（'images/a.png' 等）の basename だけを newName に差し替える（区切りは '/' で正規化） */
function replaceRelBasename(rel: string, newName: string): string {
    const dir = path.dirname(rel);
    return (dir === '.' ? newName : dir.replace(/\\/g, '/') + '/' + newName);
}

/**
 * md 実体の複製。本文参照 asset（画像 / 📎 添付）を各 uniquify 複製して本文リンクを
 * whole-link-target で書換え、md 自体を同 dir に uniquify 新名で書き出す。
 * subpage リンク（`[[]]`）は **再帰的に複製**する（ADRL-0078 改訂版 2026-08-19 —
 * 収集は collectMdLinkClosure 正典: visited set 循環打ち切り・noteDir 境界 clamp・
 * 自note外/解決不能は複製しない）。参照リンク（非 subpage の md リンク）は複製しない
 * （共有参照温存 — subpage = 所有 / 参照リンク = 共有のゲート反転は ADR-0009 と同じ）。
 * @param noteDirAbs 再帰の note 境界（省略時 = dirname(mdPathAbs)）
 */
export function duplicateMdEntity(mdPathAbs: string, noteDirAbs?: string): { newMdPath: string; newStem: string } {
    if (!fs.existsSync(mdPathAbs) || !fs.statSync(mdPathAbs).isFile()) {
        throw new Error(`duplicateMdEntity: source not found: ${mdPathAbs}`);
    }
    const rootAbs = path.resolve(mdPathAbs);
    const noteDir = noteDirAbs || path.dirname(rootAbs);
    // subpage closure（起点含む複製対象の全 md）
    const { closure } = collectMdLinkClosure(rootAbs, noteDir);
    const members = [rootAbs, ...closure];
    // pass 1: 全 member の新名を先に予約（placeholder 書出 — uniquify が後続 member の
    // 予約済み名を見えるようにし、member 間の名前衝突を防ぐ）
    const nameMap = new Map<string, { newAbs: string; newName: string }>();
    for (const abs of members) {
        const dir = path.dirname(abs);
        const newName = generateUniqueFileNamePreserving(dir, path.basename(abs));
        const newAbs = path.join(dir, newName);
        fs.writeFileSync(newAbs, '');
        nameMap.set(abs, { newAbs, newName });
    }
    // pass 2: 各 member の asset 複製 + リンク書換 → 予約先へ書出
    for (const abs of members) {
        const dir = path.dirname(abs);
        const body = fs.readFileSync(abs, 'utf8');
        const refs = extractAllAssetRefs(body);
        const renames = new Map<string, string>();
        for (const rel of [...refs.images, ...refs.files]) {
            if (renames.has(rel)) continue;
            if (path.isAbsolute(rel)) continue; // 絶対パス参照は複製対象外（所有外）
            const srcAbs = path.resolve(dir, rel);
            if (!fs.existsSync(srcAbs)) continue; // 欠損参照は skip（既存の best-effort 流儀）
            if (!isUnderNoteDir(srcAbs, noteDir)) continue; // SEC-1: `../` escape も所有外（境界 = noteDir。外部 dir への複製書込を遮断）
            const assetDir = path.dirname(srcAbs);
            const newName = generateUniqueFileNamePreserving(assetDir, path.basename(srcAbs));
            fs.copyFileSync(srcAbs, path.join(assetDir, newName));
            renames.set(rel, replaceRelBasename(rel, newName));
        }
        // subpage リンクのうち複製 member を指すものだけ新名へ（複製先は元と同 dir なので
        // basename 差し替えで相対構造が保たれる）。参照リンクは温存
        for (const ref of refs.mdLinkRefs) {
            if (!ref.isSubpage || renames.has(ref.url)) continue;
            const target = path.isAbsolute(ref.url) ? path.resolve(ref.url) : path.resolve(dir, ref.url);
            const mapped = nameMap.get(target);
            if (mapped) { renames.set(ref.url, replaceRelBasename(ref.url, mapped.newName)); }
        }
        const newBody = renames.size > 0 ? applyLinkUrlRewrites(body, renames) : body;
        fs.writeFileSync(nameMap.get(abs)!.newAbs, newBody);
    }
    const rootNew = nameMap.get(rootAbs)!;
    return { newMdPath: rootNew.newAbs, newStem: path.basename(rootNew.newName, path.extname(rootNew.newName)) };
}

/**
 * .out 実体の複製（deep copy）。全 node の pageId（page md + その本文 asset の 2 段）・
 * filePath・images[] を複製して参照を書換えた新 .out を同 dir に uniquify 新名で書き出す。
 * 複製後の 2 つの .out は資産を一切共有しない。
 * title は uniquify 結果のサフィックスに追従（'My Out' + '-1' — 名前の発明はしない）。
 */
export function duplicateOutEntity(outPathAbs: string, noteDirAbs: string): { newOutPath: string; newOutId: string } {
    if (!fs.existsSync(outPathAbs) || !fs.statSync(outPathAbs).isFile()) {
        throw new Error(`duplicateOutEntity: source not found: ${outPathAbs}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const flatLayout = require('./flat-layout');
    const outDir = path.dirname(outPathAbs);
    const data = JSON.parse(fs.readFileSync(outPathAbs, 'utf8'));
    const dup = JSON.parse(JSON.stringify(data));
    const nodes = (dup && dup.nodes && typeof dup.nodes === 'object') ? dup.nodes : {};
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        if (!node || typeof node !== 'object') continue;
        // page md（+ 本文 asset）— flat-layout 正典で実体を解決（hints = .out の pageDir 等）
        if (node.pageId) {
            const pageAbs = flatLayout.resolvePageFilePath(outPathAbs, node.pageId, noteDirAbs, dup);
            if (pageAbs && fs.existsSync(pageAbs)) {
                // noteDirAbs 伝搬で page md 本文の subpage も再帰複製される（ADRL-0078 改訂版）
                const r = duplicateMdEntity(pageAbs, noteDirAbs);
                node.pageId = r.newStem;
            }
        }
        // file 添付（outDir 相対 — cleanup-core と同じ基準）
        if (node.filePath && typeof node.filePath === 'string' && !path.isAbsolute(node.filePath)) {
            const srcAbs = path.resolve(outDir, node.filePath);
            if (fs.existsSync(srcAbs)) {
                const assetDir = path.dirname(srcAbs);
                const newName = generateUniqueFileNamePreserving(assetDir, path.basename(srcAbs));
                fs.copyFileSync(srcAbs, path.join(assetDir, newName));
                node.filePath = replaceRelBasename(node.filePath, newName);
            }
        }
        // 画像（outDir 相対）
        if (Array.isArray(node.images)) {
            node.images = node.images.map((rel: string) => {
                if (!rel || typeof rel !== 'string' || path.isAbsolute(rel)) return rel;
                const srcAbs = path.resolve(outDir, rel);
                if (!fs.existsSync(srcAbs)) return rel;
                const assetDir = path.dirname(srcAbs);
                const newName = generateUniqueFileNamePreserving(assetDir, path.basename(srcAbs));
                fs.copyFileSync(srcAbs, path.join(assetDir, newName));
                return replaceRelBasename(rel, newName);
            });
        }
    }
    const oldName = path.basename(outPathAbs);
    const oldStem = path.basename(oldName, path.extname(oldName));
    const newOutName = generateUniqueFileNamePreserving(outDir, oldName);
    const newOutId = path.basename(newOutName, path.extname(newOutName));
    // title は uniquify サフィックス追従（stem 'myout' → 'myout-1' なら title 'My Out' → 'My Out-1'）
    if (typeof dup.title === 'string' && dup.title && newOutId.startsWith(oldStem)) {
        dup.title = dup.title + newOutId.slice(oldStem.length);
    }
    const newOutPath = path.join(outDir, newOutName);
    fs.writeFileSync(newOutPath, JSON.stringify(dup, null, 2));
    return { newOutPath, newOutId };
}

/**
 * FR-MDM-03 (sprint 20260818-183407): Copy (file link full path) の変換 core。
 * md テキスト中の md/subpage リンクと 📎 file リンクの URL 部だけを resolver の返す
 * 絶対パスへ whole-link-target 置換する（applyLinkUrlRewrites 正典）。
 * 通常 URL リンク（https 等）・画像・ラベル・平文は不変。resolver が null（clamp 棄却・
 * 解決不能）のリンクは変換せずそのまま残す。
 */
export function convertMdLinksToFullPaths(
    md: string,
    resolvers: { resolveMd: (url: string) => string | null; resolveFile: (url: string) => string | null }
): string {
    if (!md) return md;
    const refs = extractAllAssetRefs(md);
    const renames = new Map<string, string>();
    for (const url of refs.mdLinks) {
        if (renames.has(url)) continue;
        const abs = resolvers.resolveMd(url);
        if (abs) renames.set(url, abs);
    }
    for (const url of refs.files) {
        if (renames.has(url)) continue;
        const abs = resolvers.resolveFile(url);
        if (abs) renames.set(url, abs);
    }
    return renames.size > 0 ? applyLinkUrlRewrites(md, renames) : md;
}
