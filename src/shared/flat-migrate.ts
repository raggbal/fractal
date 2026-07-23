/**
 * flat-migrate — 旧レイアウト（per-<stem>/ or _notes_md/）を共有フラットレイアウトへ移行する純ロジック。
 *
 * sprint 20260707-124018-notes-flat-storage / decision 2026-07-07:
 *   新レイアウト: md=Note フォルダ直下 <noteDir>/<pageId>.md、画像/添付=共有 <noteDir>/images・<noteDir>/files
 *   .out は pageDir="." imageDir="./images" fileDir="./files"
 *
 * sprint 20260709-195420-flat-migrate-1to1 / ADRL-0001:
 *   ★content-dedup を一切しない。owner（page md ファイル / 添付 node）ごとに asset を物理コピーし、
 *     各 owner の参照を自分専用コピーへ書換える（1:1 所有不変条件）。
 *   ★dir 丸ごと sweep を廃止し、owner が実際に参照する asset（+ stray .md dir の孤児実体）を moves にする。
 *   ★同名衝突は中身の同一/相違に関わらず unique 連番名（name-1.ext…）で回避（shasum 集約はしない）。
 *   ★page md 本文の asset リンクと node.filePath/node.images を、uniquify で名前が変わった owner について
 *     新名へ書換える（applyLinkUrlRewrites で whole-link-target 書換、部分文字列誤置換を防ぐ）。
 *   ★1 source → 1 owner（衝突なし）は rename（ディスク増を避ける）。同一 source を N owner が参照するなら copy。
 *
 * 旧レイアウト:
 *   <noteDir>/<stem>/<pageId>.md  +  <noteDir>/<stem>/images|files/  （per-outliner）
 *   <noteDir>/_notes_md/<id>.md   +  <noteDir>/_notes_md/images|files/（notes-md）
 *   <noteDir>/<pid>.md/           （.md 名の "ディレクトリ" 残骸 — 中身を救出して削除）
 *
 * すべて vscode 非依存。command wrapper 側が dry-run 提示・承認・呼び出しを行う。
 */
import * as fs from 'fs';
import * as path from 'path';
import { isFlatOut } from './flat-layout';
import { applyLinkUrlRewrites, extractAllAssetRefs, promoteMdLinksToSubpage, isUnderNoteDir, normalizeMdLinkKeys } from './paste-asset-handler';

export type MoveKind = 'page' | 'image' | 'file';
export type ExecKind = 'copy' | 'rename';
export interface Move { from: string; to: string; kind: MoveKind; }
/** ★page md 本文リンク書換（dst md に対して適用）。renames が空なら書換不要（後方互換）。 */
export interface BodyRewrite { mdPath: string; renames: { oldRef: string; newRef: string }[]; }
export interface OutRewrite {
    outPath: string;
    /**
     * ★この .out 内の node 参照書換を **node（owner）単位**で行う。
     * plan 段で owner ごとに別 dst を採番している（cross-owner は content-dedup 禁止 = ADRL-0001）ため、
     * 適用段でも oldRef キーの単一 Map で畳まず、node ごとの renames Map で自 node の
     * node.filePath / node.images のみを完全一致で書換える。
     * これにより 1 つの .out 内の 2 node が同一 oldRef 文字列（同一物理 asset）を参照しても、
     * それぞれ別 dst（s.png / s-1.png）に 1:1 で書換わる（oldRef キー last-wins による畳み込みを防ぐ）。
     */
    nodeRenames: { nodeId: string; renames: { oldRef: string; newRef: string }[] }[];
}
export interface MigrationPlan {
    moves: Move[];               // uniquify 済み最終 to（同名でも別 owner は別 to）
    outRewrites: OutRewrite[];   // .out ヘッダ(pageDir 等) + node.filePath/images 書換（node 単位）
    bodyRewrites: BodyRewrite[]; // ★page md 本文の asset リンク書換
    strayDirs: string[];         // ★.md 名ディレクトリ残骸（中身救出後に削除）
    conflicts: { to: string; a: string; b: string }[]; // 「情報」に降格（abort 理由にしない）
    noteDir: string;
    newImages: string;
    newFiles: string;
    oldDirs: string[];           // ★FR-MG-08: 移行後に削除する旧 per-outliner サブフォルダ（noteDir 直下のみ・noteDir 自身は絶対含まない）
    unresolved: string[];        // ★FR-MG-11: 候補のどこにも実体が見つからなかった参照（1 件でもあれば cleanupOldDirs は削除しない）
    /**
     * ★FR-MG-13（reopen④）: md 単位で「subpage 昇格すべき本文 md リンクの url（flat 新名基準・normalizeMdLinkKeys 展開済み）」。
     * executePlan step(4) が applyLinkUrlRewrites（url を flat 新名へ書換）の後に promoteMdLinksToSubpage(body, onlyUrls)
     * を呼び、この urls に一致するリンクだけ `[[]]` 化する。空 or 未計上の md は昇格ゼロ（無条件昇格の廃止）。
     */
    promoteLinks: { mdPath: string; urls: string[] }[];
}

function readJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p: string, o: unknown): void { fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); }
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/** drawio 画像は ![]() 構文でも物理保存先は files/（paste-asset-handler の MD-41 慣習と一致） */
function isDrawio(ref: string): boolean {
    const l = (ref || '').toLowerCase();
    return l.endsWith('.drawio.svg') || l.endsWith('.drawio.png');
}

/**
 * ★FR-MG-14（reopen④）: 本文中の md→md リンク url を **プレーン `[](x.md)` + `[[]]` 両形式**で拾う（migration 専用）。
 * cleanup-core の CLEANUP_MD_LINK_RE と同型。`extractAllAssetRefs.mdLinks` はプレーンのみ・parseMarkdownLinks は
 * `[[]]` を落とすため流用不可（cleanup-core と同じ理由）。返すのは raw の cleaned url（trim/`<>`strip/`?#`除去。
 * decode はしない = applyLinkUrlRewrites の照合キーと一致）。image `!` マーカー・http/data/file/fractal・純 anchor は除外。
 */
const MIGRATE_MD_LINK_RE = /(!?)\[\[?[^\]]*\]\]?\(([^)\s]+)\)/g;
function extractMdLinkTargetsRaw(body: string): string[] {
    const out: string[] = [];
    if (!body) return out;
    const seen = new Set<string>();
    MIGRATE_MD_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MIGRATE_MD_LINK_RE.exec(body)) !== null) {
        if (m[1] === '!') continue;                                  // image → md リンクでない
        let url = (m[2] || '').trim().replace(/^<|>$/g, '');
        if (!url || /^(https?:|data:|file:|fractal:)/i.test(url)) continue;
        const cleaned = url.split(/[?#]/)[0];                        // query/fragment 除去（純 #anchor → ''）
        if (!cleaned) continue;
        const lower = cleaned.toLowerCase();
        if (!(lower.endsWith('.md') || lower.endsWith('.markdown'))) continue;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push(cleaned);
    }
    return out;
}

/**
 * ★本文書換が必要か: 旧本文リンク（oldRef）を新レイアウト相対（newRef）へ正規化して等しければ書換不要。
 * `./images/x.png` と `images/x.png` は同じ解決結果なので書換しない（後方互換で本文を保つ）。
 * サブ dir が変わる（drawio: images/→files/、任意サブ dir → images/|files/）or basename が uniquify で
 * 変わった場合のみ書換が必要（true を返す）。
 */
function needsBodyRewrite(oldRef: string, newRef: string): boolean {
    const norm = (r: string) => path.posix.normalize(r.replace(/\\/g, '/'));
    return norm(oldRef) !== norm(newRef);
}

/**
 * .out の現在の（旧）pageDir/imageDir/fileDir を解決する。
 * 旧 default: pageDir=<outDir>/<stem>, imageDir=<outDir>/<stem>/images, fileDir=<outDir>/<stem>/files
 * （JSON ヒントがあれば優先）。
 */
export function resolveOldDirs(outPath: string, data: any): { pageDir: string; imageDir: string; fileDir: string } {
    const outDir = path.dirname(outPath);
    const stem = path.basename(outPath, '.out');
    const resolve = (field: string, def: string): string => {
        const v = data?.[field];
        if (v) return path.isAbsolute(v) ? v : path.resolve(outDir, v);
        return def;
    };
    return {
        pageDir: resolve('pageDir', path.join(outDir, stem)),
        imageDir: resolve('imageDir', path.join(outDir, stem, 'images')),
        fileDir: resolve('fileDir', path.join(outDir, stem, 'files')),
    };
}

/** ある .out が既にフラット（pageDir="."）かを判定（flat-layout.isFlatOut に集約） */
function isAlreadyFlat(_outPath: string, data: any): boolean {
    return isFlatOut(data?.pageDir);
}

/**
 * uniquify — 「共有先ディレクトリ内で採番済み名 + ディスク実在」を見て unique 名を予約する。
 * used セットは note 全体で共有（同名衝突を全体で回避）。実コピーは executePlan（ここでは名前予約のみ）。
 * makeUniquifier(destDir) は sprint 1 の makeUniqueImageCopier と同型だが copy はしない。
 */
function makeUniquifier(destDir: string): (desiredBase: string) => string {
    const used = new Set<string>();
    return (desiredBase: string): string => {
        const ext = path.extname(desiredBase);
        const stem = path.basename(desiredBase, ext);
        // drawio.svg / drawio.png のような複合拡張子も基本の連番退避で扱う
        let candidate = desiredBase;
        let n = 0;
        while (used.has(candidate) || fs.existsSync(path.join(destDir, candidate))) {
            n++;
            candidate = `${stem}-${n}${ext}`;
        }
        used.add(candidate);
        return candidate;
    };
}

/**
 * 移行計画を構築する（ディスクは変更しない）。owner 参照グラフ駆動（ADRL-0001）。
 */
export function planMigration(noteDir: string): MigrationPlan {
    const moves: Move[] = [];
    const outRewrites: OutRewrite[] = [];
    const bodyRewrites: BodyRewrite[] = [];
    const strayDirs: string[] = [];
    const oldDirs: string[] = [];   // ★FR-MG-08: 削除対象の旧 per-outliner サブフォルダ
    const unresolved: string[] = []; // ★FR-MG-11: 解決できなかった参照
    const promoteLinks: { mdPath: string; urls: string[] }[] = []; // ★FR-MG-13: md 単位の昇格 allowlist
    const conflicts: { to: string; a: string; b: string }[] = [];
    const newImages = path.join(noteDir, 'images');
    const newFiles = path.join(noteDir, 'files');

    // ★note 全体で共有する 3 つの used セット（名前予約）
    const uniqImage = makeUniquifier(newImages);
    const uniqFile = makeUniquifier(newFiles);
    const uniqMd = makeUniquifier(noteDir); // <note>/ 直下 md 名

    // seenTargets: 情報用の衝突検出（abort しない）
    const seenTargets = new Map<string, string>();
    const pushMove = (from: string, to: string, kind: MoveKind) => {
        if (from === to) return; // 既に所定位置（フラット済み）
        if (seenTargets.has(to) && seenTargets.get(to) !== from) {
            conflicts.push({ to, a: seenTargets.get(to)!, b: from });
        }
        seenTargets.set(to, from);
        moves.push({ from, to, kind });
    };

    /**
     * ★owner ごとの asset 予約器。srcAbs→予約済み newRef の dedup Map は **owner ごとに新規**
     * （別 owner は別コピー・別名。ADRL-0001）。同一 owner 内で同一 src を複数参照した時だけ 1 コピー集約（1:1 OK）。
     * 1 つの owner（= page node or 添付 node or _notes_md）の中で、本文リンク・node.images・node.filePath は
     * 同じ物理 src を指せば同じ dedup Map を通り同一コピーへ集約される。
     */
    const makeOwnerReserver = () => {
        const dedup = new Map<string, string>(); // srcAbs → newRef（この owner 内でのみ再利用）
        /**
         * 1 参照を予約する。srcAbs が実在すれば move を積み、newRef（Note 直下基準の相対）を返す。実在しなければ null。
         * ★HIGH-1: 保存先は「本文抽出の由来（inImages）+ drawio 判定」で決める:
         *   inImages かつ !drawio → images/、それ以外（drawio / 📎 file 由来）→ files/。
         */
        return (ref: string, resolveBase: string, inImages: boolean, resolvedSrc?: string): string | null => {
            // ★FR-MG-12: resolvedSrc（cross-outliner 横断で見つけた実体）が与えられればそれを使う。
            //   未指定なら従来どおり resolveBase 基準。dedup キー / uniquify / pushMove / newRef は不変。
            const srcAsset = resolvedSrc ?? path.resolve(resolveBase, ref);
            if (!isFile(srcAsset)) return null;
            if (dedup.has(srcAsset)) return dedup.get(srcAsset)!; // owner 内 dedup（1:1 OK）
            const base = path.posix.basename(ref.replace(/\\/g, '/'));
            let newRef: string;
            if (inImages && !isDrawio(ref)) {
                const dstName = uniqImage(base);
                pushMove(srcAsset, path.join(newImages, dstName), 'image');
                newRef = `images/${dstName}`;
            } else {
                const dstName = uniqFile(base);
                pushMove(srcAsset, path.join(newFiles, dstName), 'file');
                newRef = `files/${dstName}`;
            }
            dedup.set(srcAsset, newRef);
            return newRef;
        };
    };

    const outFiles = isDir(noteDir)
        ? fs.readdirSync(noteDir).filter(f => f.endsWith('.out')).map(f => path.join(noteDir, f))
        : [];

    // ★FR-MG-10: cross-outliner md 探索の候補ディレクトリを先に集める（read-only）。
    //   各 .out の旧 pageDir（<noteDir>/<stem>/）。フラット済み .out は候補にしない。
    const notesMdDirForSearch = path.join(noteDir, '_notes_md');
    // ★FR-MG-15（reopen⑤）: 一時期の版で作られた <note>/pages/ 旧レイアウト。md/画像/添付とも探索・掃除対象に加える。
    const pagesDirForSearch = path.join(noteDir, 'pages');
    const allOldPageDirs: string[] = [];
    for (const op of outFiles) {
        try {
            const d2 = readJson(op);
            if (!isAlreadyFlat(op, d2)) { allOldPageDirs.push(path.resolve(resolveOldDirs(op, d2).pageDir)); }
        } catch { /* 壊れた .out はスキップ */ }
    }
    // ★LOW-1: 同一 md src を「cross-outliner 解決」と「_notes_md sweep」で二重に move しないための claim セット。
    const claimedMdSrcs = new Set<string>();
    // node.pageId の md 実体を候補横断で探す。自 stem → 他 stem → _notes_md の順。見つからなければ null。
    // pageId は note 内一意（実データ確認）なので、どこで見つかっても正しい実体（衝突しない）。
    function resolvePageMdSrc(ownPageDir: string, pageId: string): string | null {
        const own = path.join(ownPageDir, `${pageId}.md`);
        if (isFile(own)) { return own; }
        const ownAbs = path.resolve(ownPageDir);
        for (const dir of allOldPageDirs) {
            if (dir === ownAbs) { continue; }
            const c = path.join(dir, `${pageId}.md`);
            if (isFile(c)) { return c; }
        }
        const nm = path.join(notesMdDirForSearch, `${pageId}.md`);
        if (isFile(nm)) { return nm; }
        // ★FR-MG-15（reopen⑤）: <note>/pages/<id>.md（一時期の版の残骸）。自 stem → 他 stem → _notes_md → pages の順。
        //   pageDir 未指定 .out はページ実体が stem dir と pages/ に分散しうる（自 stem 候補が stem 側 / これが pages 側を拾う）。
        const pg = path.join(pagesDirForSearch, `${pageId}.md`);
        if (isFile(pg)) { return pg; }
        return null;
    }

    // ★FR-MG-12: cross-outliner 画像/添付の探索候補 dir（read-only）。各 .out の imageDir 群 / fileDir 群 +
    //   共有 newImages/newFiles + _notes_md/images|files。順序は resolveAssetSrc 側で inImages により組み替える。
    const allImageDirs: string[] = [];
    const allFileDirs: string[] = [];
    for (const op of outFiles) {
        try {
            const d2 = readJson(op);
            if (isAlreadyFlat(op, d2)) { continue; }
            const od = resolveOldDirs(op, d2);
            allImageDirs.push(path.resolve(od.imageDir));
            allFileDirs.push(path.resolve(od.fileDir));
        } catch { /* 壊れた .out はスキップ */ }
    }
    // ★FR-MG-16（reopen⑤・LOW-1）: 末尾に <note>/pages/images・<note>/pages/files を両方追加（画像も添付も）。
    //   順序: primary base（reserve/resolveAssetSrc 側で先行）→ 共有 newImages/newFiles → _notes_md → pages。
    allImageDirs.push(path.resolve(newImages), path.resolve(path.join(notesMdDirForSearch, 'images')), path.resolve(path.join(pagesDirForSearch, 'images')));
    allFileDirs.push(path.resolve(newFiles), path.resolve(path.join(notesMdDirForSearch, 'files')), path.resolve(path.join(pagesDirForSearch, 'files')));
    // inImages なら [画像群, 添付群]、!inImages なら [添付群, 画像群]。★HIGH-B: drawio は images 構文でも files 保存
    //   なので必ず両群走査（取りこぼし無し）。★HIGH-C: primary 種別を先に。
    function candidateAssetDirs(inImages: boolean): string[] {
        return inImages ? [...allImageDirs, ...allFileDirs] : [...allFileDirs, ...allImageDirs];
    }
    // ★FR-MG-12: ref を primaryBase で解決できなければ note 内の他 outliner の images//files/ を横断探索。
    //   見つかった実体の絶対パスを返す。どこにも無ければ null（= 真の元々壊れ）。
    //   ★HIGH-A: 横断 basename は raw + decodeURIComponent の両方で試す（本文 ref が空白/percent-encode の場合、
    //   実ディスク名は decode 後。extractAllAssetRefs は decode しない）。
    function resolveAssetSrc(ref: string, primaryBase: string, inImages: boolean): string | null {
        const primary = path.resolve(primaryBase, ref);
        if (isFile(primary)) { return primary; } // 従来基準（大多数・reserve と同一解決）
        const raw = path.posix.basename(ref.replace(/\\/g, '/'));
        let dec = raw; try { dec = decodeURIComponent(raw); } catch { /* 不正 encode は raw のまま */ }
        const bnCandidates = dec === raw ? [raw] : [raw, dec];
        for (const dir of candidateAssetDirs(inImages)) {
            for (const bn of bnCandidates) {
                const c = path.join(dir, bn);
                if (isFile(c)) { return c; }
            }
        }
        return null; // どこにも無い = 元々壊れ
    }

    // ★FR-MG-13（reopen④・H1 是正）: 「node/note から参照される pageId」の集合を構築する。
    //   subpage 昇格判定 (2)（node/note 未参照）に使う。cleanup-core.ts:118 と同一判定:
    //   全 .out の node.pageId ∪ outline.note の md item（type==='file' && ext==='md'）。
    //   ★ type==='file' は folder との区別（.out item も .md item も持つ）。.out/.md は ext で判別。
    const referencedPageIds = new Set<string>();
    for (const op of outFiles) {
        try {
            const d2 = readJson(op);
            for (const node of Object.values(d2.nodes || {})) {
                const n = node as any;
                if (n && typeof n.pageId === 'string' && n.pageId) referencedPageIds.add(n.pageId);
            }
        } catch { /* 壊れた .out はスキップ */ }
    }
    try {
        const on = readJson(path.join(noteDir, 'outline.note'));
        const items = on?.items;
        if (items && typeof items === 'object') {
            for (const id of Object.keys(items)) {
                const it = items[id];
                if (it && it.type === 'file' && it.ext === 'md') referencedPageIds.add(id);
            }
        }
    } catch { /* outline.note 無ければ skip */ }

    // ★FR-MG-14（reopen④）: 移行対象 md（node.pageId 起点 / _notes_md 起点）から本文 md リンクで到達可能な
    //   note 内 md を **種別不問で** 移行対象に積む fixpoint（H2 是正の核）。昇格するか否かは独立判定（shouldPromote）。
    //   processOwnerMd(srcMdAbs) は「1 枚の md を移行対象として owner 処理し dstMd 絶対パスを返す」既存ロジックを
    //   関数化したもの（node.pageId owner ブロックと同型）。BFS が発見した md にも同じ処理を適用する。

    // subpage 昇格判定: リンク先が (1) リンク元と同 stem に実在 (2) node/note 未参照。両立時のみ昇格（プレーン維持しない）。
    function shouldPromote(targetAbs: string, linkerMdDir: string): boolean {
        const targetPageId = path.basename(targetAbs).replace(/\.md$/i, '');
        const sameStem = path.dirname(targetAbs) === path.resolve(linkerMdDir);
        const notReferenced = !referencedPageIds.has(targetPageId);
        return sameStem && notReferenced;
    }
    // 本文 md リンク url を note 内実在 md の絶対パスに解決（decode 両候補 + noteDir clamp）。外部/note外/壊れは null。
    function resolveMdLinkTarget(url: string, linkerMdDir: string): string | null {
        if (/^(https?:|data:|file:|fractal:)/i.test(url) || url.startsWith('#')) return null;
        const rel = url.split(/[?#]/)[0];
        if (!rel) return null;
        const cands = [rel];
        try { const d = decodeURIComponent(rel); if (d !== rel) cands.push(d); } catch { /* raw のみ */ }
        for (const c of cands) {
            const abs = path.isAbsolute(c) ? path.resolve(c) : path.resolve(linkerMdDir, c);
            if (!isUnderNoteDir(abs, noteDir)) continue;  // 他 note/note 外 = 管理外（移行しない）
            if (isFile(abs)) return abs;
        }
        return null; // 実体なし（note 外 or 壊れ）
    }

    // ★reopen④ 作業状態: md 単位で bodyRewrites（asset + md-link）と昇格 allowlist を集約し、末尾で materialize する。
    //   （同一 md が owner でもあり linker でもあるので、両方の renames を同じ dstMd に積む。executePlan の
    //    bodyRewriteMap の last-wins 上書きも回避）。
    const mdSrcToDst = new Map<string, string>();                       // 処理済み md（srcAbs → dstMd 絶対パス）
    const bodyRewriteAccum = new Map<string, { oldRef: string; newRef: string }[]>(); // dstMd → renames
    const promoteAccum = new Map<string, Set<string>>();                // dstMd → 昇格 url（flat 新名基準・normalizeMdLinkKeys 展開）
    const addBodyRewrites = (dstMd: string, renames: { oldRef: string; newRef: string }[]) => {
        if (renames.length === 0 && !bodyRewriteAccum.has(dstMd)) { bodyRewriteAccum.set(dstMd, []); return; }
        const cur = bodyRewriteAccum.get(dstMd) || [];
        for (const r of renames) cur.push(r);
        bodyRewriteAccum.set(dstMd, cur);
    };
    // ★FR-MG-14: BFS で発見した standalone md（node を持たない）を移行対象として owner 処理し dstMd を返す。
    //   node.pageId owner（reserve を body+images+filePath で共有）とは違い、発見 md は body だけの owner なので
    //   専用 reserve で 1:1（ADRL-0001）。既処理なら既存 dst を返す（二重 move 防止）。
    function processMdOwner(srcMdAbs: string): string {
        const srcAbs = path.resolve(srcMdAbs);
        const ex = mdSrcToDst.get(srcAbs);
        if (ex) return ex;
        const dstMdName = uniqMd(path.basename(srcAbs));
        const dstMd = path.join(noteDir, dstMdName);
        mdSrcToDst.set(srcAbs, dstMd);
        claimedMdSrcs.add(srcAbs);
        const srcDir = path.dirname(srcAbs);
        let body = ''; try { body = fs.readFileSync(srcAbs, 'utf8'); } catch { body = ''; }
        const refs = extractAllAssetRefs(body);
        const reserve = makeOwnerReserver();
        const bodyR: { oldRef: string; newRef: string }[] = [];
        for (const ref of refs.images) {
            const s = resolveAssetSrc(ref, srcDir, true);
            if (s) { const nr = reserve(ref, srcDir, true, s); if (nr) bodyR.push({ oldRef: ref, newRef: nr }); }
            else { unresolved.push(`body image: ${ref} (in ${path.basename(srcAbs)})`); }
        }
        for (const ref of refs.files) {
            const s = resolveAssetSrc(ref, srcDir, false);
            if (s) { const nr = reserve(ref, srcDir, false, s); if (nr) bodyR.push({ oldRef: ref, newRef: nr }); }
            else { unresolved.push(`body file: ${ref} (in ${path.basename(srcAbs)})`); }
        }
        addBodyRewrites(dstMd, bodyR.filter(r => needsBodyRewrite(r.oldRef, r.newRef)));
        pushMove(srcAbs, dstMd, 'page');
        return dstMd;
    }

    for (const outPath of outFiles) {
        let data: any;
        try { data = readJson(outPath); } catch { continue; }
        if (isAlreadyFlat(outPath, data)) { continue; } // 既にフラットな .out はスキップ
        const old = resolveOldDirs(outPath, data);
        // ★★★ FR-MG-08 (data-loss BLOCKER 是正): 旧 per-outliner サブフォルダを削除対象に積む。
        //   old.pageDir は旧サブフォルダ <noteDir>/<stem>/ 「そのもの」（親ではない）。flat .out（pageDir="."）は
        //   noteDir 自身に解決されるため、4 ガードで noteDir 自身・外・親を絶対に対象にしない（全消し事故防止）。
        {
            const sub = path.resolve(old.pageDir);
            const noteAbs = path.resolve(noteDir);
            if (
                !isFlatOut(data.pageDir) &&               // (a) フラット .out はスキップ
                sub !== noteAbs &&                        // (b) ★最後の砦: noteDir 自身は絶対対象外
                sub.startsWith(noteAbs + path.sep) &&     // (c) noteDir の真下のみ
                isDir(sub) &&                             // 実在 dir のみ
                oldDirs.indexOf(sub) < 0
            ) {
                oldDirs.push(sub);
            }
        }
        const nodes = data.nodes || {};
        // ★node（owner）単位で参照書換を集める。同一 .out 内の別 node が同一 oldRef 文字列を
        //   参照しても、node ごとに別 dst に採番された renames をそのまま適用できるようにする。
        const nodeRenames: { nodeId: string; renames: { oldRef: string; newRef: string }[] }[] = [];

        for (const nid of Object.keys(nodes)) {
            const node = nodes[nid];
            if (!node) continue;
            // 1 node = 1 owner。本文 refs / node.images / node.filePath を同一 dedup Map で処理し、
            // 同じ物理 src は 1 コピーに集約（owner 内 1:1）。別 node/別 src は別コピー（ADRL-0001）。
            const reserve = makeOwnerReserver();
            // この node（owner）専用の参照書換。同一 owner 内で同一 src を複数参照した場合の
            // 集約（TC-M-05/08）は reserve 内 dedup が同一 newRef を返すので、この配列内でも矛盾しない。
            const refRenames: { oldRef: string; newRef: string }[] = [];

            // (1) page md owner: node.pageId → 本文 asset を予約 + BodyRewrite
            if (node.pageId) {
                // ★FR-MG-10: 自 stem だけでなく他 outliner stem / _notes_md も横断で md 実体を探す（cross-outliner）。
                const srcMd = resolvePageMdSrc(old.pageDir, node.pageId);
                if (srcMd) {
                    // ★本文相対 refs は「見つかった実体の dir 基準」で解決する（自 stem 基準ではない）。
                    //   cross-outliner md（別 stem にある）の images/x.png はその md が居る dir の images/ にある。
                    const srcDir = path.dirname(srcMd);
                    const dstMdName = uniqMd(`${node.pageId}.md`);
                    const dstMd = path.join(noteDir, dstMdName);
                    let body = '';
                    try { body = fs.readFileSync(srcMd, 'utf8'); } catch { body = ''; }
                    const refs = extractAllAssetRefs(body);
                    const bodyR: { oldRef: string; newRef: string }[] = [];
                    // refs.images は inImages=true（drawio は reserve 内で files/ へ）、refs.files は inImages=false。
                    // ★FR-MG-12: srcDir に無ければ cross-outliner 横断で実体を探す（resolveAssetSrc）。無ければ unresolved。
                    for (const ref of refs.images) {
                        const s = resolveAssetSrc(ref, srcDir, true);
                        if (s) { const newRef = reserve(ref, srcDir, true, s); if (newRef) bodyR.push({ oldRef: ref, newRef }); }
                        else { unresolved.push(`body image: ${ref} (in ${node.pageId}.md)`); }
                    }
                    for (const ref of refs.files) {
                        const s = resolveAssetSrc(ref, srcDir, false);
                        if (s) { const newRef = reserve(ref, srcDir, false, s); if (newRef) bodyR.push({ oldRef: ref, newRef }); }
                        else { unresolved.push(`body file: ${ref} (in ${node.pageId}.md)`); }
                    }
                    const effectiveBodyR = bodyR.filter(r => needsBodyRewrite(r.oldRef, r.newRef));
                    addBodyRewrites(dstMd, effectiveBodyR);   // ★reopen④: accumulator 経由（md-link rename も後で足す）
                    pushMove(srcMd, dstMd, 'page');
                    claimedMdSrcs.add(path.resolve(srcMd)); // ★LOW-1: _notes_md sweep で二重 move しない
                    mdSrcToDst.set(path.resolve(srcMd), dstMd); // ★FR-MG-14: closure seed / md-link rename の起点
                } else {
                    // ★FR-MG-11: どこにも実体が無い → unresolved に記録（silent skip をやめて可視化 → 削除ガード）。
                    unresolved.push(`page md: ${node.pageId} (referenced by ${path.basename(outPath)})`);
                }
            }

            // (2) node.images[] → images/（drawio は files/）。本文と同じ src なら同一コピーへ集約。
            if (Array.isArray(node.images)) {
                for (const ref of node.images) {
                    if (typeof ref !== 'string' || !ref) continue;
                    // node.images は outDir(=noteDir) 基準。★FR-MG-12: 無ければ cross-outliner 横断で実体を探す。
                    const s = resolveAssetSrc(ref, noteDir, true);
                    if (s) { const newRef = reserve(ref, noteDir, true, s); if (newRef && newRef !== ref) refRenames.push({ oldRef: ref, newRef }); }
                    else { unresolved.push(`image: ${ref} (referenced by ${path.basename(outPath)})`); } // ★FR-MG-11（真の元々壊れ）
                }
            }
            // (3) node.filePath → files/（inImages=false で必ず files/。本文 📎 と同じ src なら同一コピーへ集約）
            if (typeof node.filePath === 'string' && node.filePath) {
                const ref = node.filePath;
                // ★FR-MG-12: noteDir に無ければ cross-outliner 横断で実体を探す。
                const s = resolveAssetSrc(ref, noteDir, false);
                if (s) { const newRef = reserve(ref, noteDir, false, s); if (newRef && newRef !== ref) refRenames.push({ oldRef: ref, newRef }); }
                else { unresolved.push(`file: ${ref} (referenced by ${path.basename(outPath)})`); } // ★FR-MG-11（真の元々壊れ）
            }
            if (refRenames.length > 0) nodeRenames.push({ nodeId: nid, renames: refRenames });
        }
        outRewrites.push({ outPath, nodeRenames });
    }

    // ★FR-MG-17（reopen⑤）: <note>/pages/ を掃除対象に追加（特定 .out の pageDir でなく note 直下固定 dir なのでループ外で 1 回）。
    //   最後の砦ガード: noteDir 自身・外・親は絶対に消さない（固定 join なので !== noteDir / startsWith は自明に真だが式で明示）。
    {
        const pagesAbs = path.resolve(pagesDirForSearch);
        const noteAbs = path.resolve(noteDir);
        if (pagesAbs !== noteAbs && pagesAbs.startsWith(noteAbs + path.sep) && isDir(pagesAbs) && oldDirs.indexOf(pagesAbs) < 0) {
            oldDirs.push(pagesAbs);
        }
    }

    // (4) notes-md（_notes_md/）→ page md owner と同じ扱い（本文 refs を uniquify + BodyRewrite）
    const mdRoot = path.join(noteDir, '_notes_md');
    if (isDir(mdRoot)) {
        for (const f of fs.readdirSync(mdRoot)) {
            const from = path.join(mdRoot, f);
            if (!isFile(from) || !f.endsWith('.md')) continue;
            // ★LOW-1: cross-outliner 解決（resolvePageMdSrc の _notes_md 候補）で既に move 済みの src は
            //   ここで二重 move しない（同一 md が 2 つの flat コピーになるのを防ぐ）。
            if (claimedMdSrcs.has(path.resolve(from))) continue;
            const dstMdName = uniqMd(f);
            const dstMd = path.join(noteDir, dstMdName);
            let body = '';
            try { body = fs.readFileSync(from, 'utf8'); } catch { body = ''; }
            const refs = extractAllAssetRefs(body);
            const reserve = makeOwnerReserver(); // 1 md = 1 owner（新規 dedup）
            const bodyR: { oldRef: string; newRef: string }[] = [];
            // ★TASK-14（reopen③ Iteration 8・data-loss 是正）: sections 1-3 と対称に resolveAssetSrc を通す。
            //   primaryBase=mdRoot は従来と同一（後方互換）。無ければ cross-outliner 横断（+decode+drawio files 群）で
            //   実体を探し、reserve に resolvedSrc として渡す。どこにも無ければ unresolved に載せる（silent skip 廃止）。
            //   これで「実体あり→null→未移動なのに _notes_md/stem 削除で損失」経路を section 4 でも消す。
            for (const ref of refs.images) {
                const s = resolveAssetSrc(ref, mdRoot, true); // 本文相対は _notes_md/ 基準 + 横断フォールバック
                if (s) { const newRef = reserve(ref, mdRoot, true, s); if (newRef) bodyR.push({ oldRef: ref, newRef }); }
                else { unresolved.push(`notes-md image: ${ref} (in ${f})`); }
            }
            for (const ref of refs.files) {
                const s = resolveAssetSrc(ref, mdRoot, false);
                if (s) { const newRef = reserve(ref, mdRoot, false, s); if (newRef) bodyR.push({ oldRef: ref, newRef }); }
                else { unresolved.push(`notes-md file: ${ref} (in ${f})`); }
            }
            const effectiveBodyR = bodyR.filter(r => needsBodyRewrite(r.oldRef, r.newRef));
            addBodyRewrites(dstMd, effectiveBodyR);              // ★reopen④: accumulator 経由
            pushMove(from, dstMd, 'page');
            mdSrcToDst.set(path.resolve(from), dstMd);           // ★FR-MG-14: closure seed
        }
    }

    // ★FR-MG-14（reopen④・H2 是正の核）: 移行対象 md から本文 md リンクで到達可能な note 内 md を
    //   **種別不問で** 移行対象に積む fixpoint（BFS）。昇格は shouldPromote で別途 allowlist に載せる。
    //   これで「別 stem 孤立 md」「_notes_md 起点 body-link 先」も必ず move される（rmSync 前に全移行 = NFR-MG-11）。
    {
        const visited = new Set<string>(mdSrcToDst.keys()); // 既 move 済み src（node.pageId 起点 + _notes_md）
        const queue: string[] = [...mdSrcToDst.keys()];
        while (queue.length > 0) {
            const linkerSrc = queue.shift()!;
            const linkerDst = mdSrcToDst.get(linkerSrc)!;
            const linkerDir = path.dirname(linkerSrc);
            let body = ''; try { body = fs.readFileSync(linkerSrc, 'utf8'); } catch { body = ''; }
            for (const url of extractMdLinkTargetsRaw(body)) {
                const tgt = resolveMdLinkTarget(url, linkerDir);
                if (!tgt) continue;                              // 外部/note外/壊れ = 移行対象外
                // ★移行判定（種別不問・H2 の核）: 未 move の note 内実在 md は必ず move に積む。
                let tgtDst: string;
                if (visited.has(path.resolve(tgt))) { tgtDst = mdSrcToDst.get(path.resolve(tgt))!; }
                else {
                    visited.add(path.resolve(tgt));
                    tgtDst = processMdOwner(tgt);
                    queue.push(path.resolve(tgt));               // 推移: tgt の本文リンクも辿る
                }
                // ★M1-b: linker 本文の「旧 url（本文の生記法）→ flat 新名」rename を linker の bodyRewrites に積む。
                //   applyLinkUrlRewrites が norm(url) をキーに url span 置換する。新名 = tgtDst の basename。
                const newUrl = path.basename(tgtDst);
                const normOld = url.split(/[?#]/)[0];            // applyLinkUrlRewrites の norm（trim/<>strip 済み前提）
                if (normOld !== newUrl) addBodyRewrites(linkerDst, [{ oldRef: normOld, newRef: newUrl }]);
                // ★昇格判定（移行とは独立・FR-MG-13）: 同 stem・node/note 未参照なら昇格 allowlist に「新名基準」url を積む。
                //   executePlan は rewrite→promote 順なので、promote 時点の body url は新名 → allowlist も新名で持つ。
                if (shouldPromote(tgt, linkerDir)) {
                    const set = promoteAccum.get(linkerDst) || new Set<string>();
                    for (const k of normalizeMdLinkKeys(newUrl)) set.add(k);
                    promoteAccum.set(linkerDst, set);
                }
            }
        }
    }

    // ★reopen④: accumulator を plan の bodyRewrites / promoteLinks に materialize する。
    for (const [mdPath, renames] of bodyRewriteAccum) bodyRewrites.push({ mdPath, renames });
    for (const [mdPath, urls] of promoteAccum) { if (urls.size > 0) promoteLinks.push({ mdPath, urls: [...urls] }); }

    // (5) ★HIGH-2: stray .md dir の発見機構（.md 名の "ディレクトリ" 残骸）
    if (isDir(noteDir)) {
        for (const e of fs.readdirSync(noteDir)) {
            const abs = path.join(noteDir, e);
            if (!(e.endsWith('.md') && isDir(abs))) continue; // .md 名のディレクトリのみ
            const strayImg = path.join(abs, 'images');
            if (isDir(strayImg)) {
                for (const f of fs.readdirSync(strayImg)) {
                    const from = path.join(strayImg, f);
                    if (!isFile(from)) continue;
                    const dstName = isDrawio(f) ? uniqFile(f) : uniqImage(f);
                    const kind: MoveKind = isDrawio(f) ? 'file' : 'image';
                    const destDir = isDrawio(f) ? newFiles : newImages;
                    pushMove(from, path.join(destDir, dstName), kind);
                }
            }
            const strayFiles = path.join(abs, 'files');
            if (isDir(strayFiles)) {
                for (const f of fs.readdirSync(strayFiles)) {
                    const from = path.join(strayFiles, f);
                    if (!isFile(from)) continue;
                    const dstName = uniqFile(f);
                    pushMove(from, path.join(newFiles, dstName), 'file');
                }
            }
            strayDirs.push(abs);
        }
    }

    return { moves, outRewrites, bodyRewrites, strayDirs, conflicts, noteDir, newImages, newFiles, oldDirs, unresolved, promoteLinks };
}

/**
 * 計画全体を実行前に検証（アトミック性ゲート）。
 * ★uniquify / stray dir 処理で解消するため internal collision / pre-existing target は abort 理由にしない。
 * abort するのは真の I/O 前提エラー（source 消失など致命的なもの）のみ。
 */
export function validatePlan(plan: MigrationPlan, opts: { forceFailTarget?: string } = {}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    // stray dir 跡地は execute で先に空けるため、その配下への target は pre-existing 扱いしない。
    for (const m of plan.moves) {
        if (!fs.existsSync(m.from)) reasons.push(`missing source: ${m.from}`);
    }
    if (opts.forceFailTarget) {
        const bad = plan.moves.find(m => m.to.includes(opts.forceFailTarget!));
        if (bad) reasons.push(`injected failure: target unwritable ${bad.to}`);
    }
    return { ok: reasons.length === 0, reasons };
}

/**
 * 検証済み計画を実行する（ADRL-0001: owner ごとコピー、名前は uniquify 済み）。
 *
 * 順序（★HIGH-3、同名衝突を機械的に排除）:
 *   (0) stray dir の中身 move/copy → 空になった stray dir を rmdir（先に名前を空ける）
 *   (1) 残り asset move/copy
 *   (2) page md move
 *   (3) .out ヘッダ(pageDir='.'/imageDir='./images'/fileDir='./files') + node 単位の参照 完全一致書換
 *   (4) bodyRewrites を dst md に適用（renames が空ならスキップ = 後方互換）
 *
 * rename vs copy: source が 1 回だけ moves に現れる → rename、2 回以上（複数 owner）→ copy。
 * 途中失敗時は done リスト（copy/rename 種別を記録）を逆順で巻き戻し、.out/md snapshot を復元する。
 */
export function executePlan(plan: MigrationPlan, opts: { injectFailAfter?: number; injectFailOnRewrite?: number } = {}): { executedMoves: number; rolledBack: boolean; error?: string } {
    if (plan.moves.some(m => m.kind === 'image')) fs.mkdirSync(plan.newImages, { recursive: true });
    if (plan.moves.some(m => m.kind === 'file')) fs.mkdirSync(plan.newFiles, { recursive: true });

    // source 出現回数を数える（≥2 → copy、1 → rename）
    const srcCount = new Map<string, number>();
    for (const m of plan.moves) srcCount.set(m.from, (srcCount.get(m.from) || 0) + 1);
    const execKindOf = (from: string): ExecKind => (srcCount.get(from)! >= 2 ? 'copy' : 'rename');

    // stray dir 配下からの move かを判定（stray dir を先に処理するため）
    const strayDirsAbs = plan.strayDirs.map(d => path.resolve(d));
    const isUnderStray = (from: string): boolean => {
        const abs = path.resolve(from);
        return strayDirsAbs.some(d => abs === d || abs.startsWith(d + path.sep));
    };

    // moves を段に分ける
    const strayMoves = plan.moves.filter(m => m.kind !== 'page' && isUnderStray(m.from));
    const assetMoves = plan.moves.filter(m => m.kind !== 'page' && !isUnderStray(m.from));
    const pageMoves = plan.moves.filter(m => m.kind === 'page');

    const done: { move: Move; exec: ExecKind }[] = [];
    const rmdirDone: string[] = []; // 削除した stray dir（rollback で mkdir 復元）
    const rewrittenOut: { outPath: string; originalText: string }[] = [];
    const rewrittenMd: { mdPath: string; originalText: string }[] = [];

    let i = 0;
    const doMove = (m: Move) => {
        if (opts.injectFailAfter != null && i === opts.injectFailAfter) {
            throw new Error(`INJECTED failure after ${i} moves`);
        }
        const exec = execKindOf(m.from);
        fs.mkdirSync(path.dirname(m.to), { recursive: true });
        if (exec === 'copy') {
            fs.copyFileSync(m.from, m.to);
        } else {
            fs.renameSync(m.from, m.to);
        }
        done.push({ move: m, exec });
        i++;
    };

    try {
        // (0) stray dir の中身 move/copy → 空になった stray dir を rmdir
        for (const m of strayMoves) doMove(m);
        for (const d of plan.strayDirs) {
            // 中身が空になったサブディレクトリ（images/files）を畳んでから dir 本体を rmdir
            const collapseEmpty = (dir: string) => {
                if (!isDir(dir)) return;
                const entries = fs.readdirSync(dir);
                for (const e of entries) {
                    const sub = path.join(dir, e);
                    if (isDir(sub)) {
                        if (fs.readdirSync(sub).length === 0) fs.rmdirSync(sub);
                    }
                }
            };
            collapseEmpty(d);
            const remaining = isDir(d) ? fs.readdirSync(d) : [];
            if (remaining.length !== 0) {
                throw new Error(`stray dir not empty after content move: ${d} (${remaining.join(', ')})`);
            }
            fs.rmdirSync(d);
            rmdirDone.push(d);
        }

        // (1) 残り asset move/copy
        for (const m of assetMoves) doMove(m);
        // (2) page md move
        for (const m of pageMoves) doMove(m);

        // (3) .out ヘッダ + node（owner）単位の参照書換（完全一致）
        let j = 0;
        for (const r of plan.outRewrites) {
            const originalText = fs.readFileSync(r.outPath, 'utf8');
            if (opts.injectFailOnRewrite != null && j === opts.injectFailOnRewrite) {
                throw new Error(`INJECTED rewrite failure at outRewrite ${j}`);
            }
            const data = JSON.parse(originalText);
            data.pageDir = '.';
            data.imageDir = './images';
            data.fileDir = './files';
            const nodes = data.nodes || {};
            // ★node ごとに **自分の renames のみ** を Map にして書換える。
            //   oldRef キーの単一 Map で全 node 分を畳むと、同一 .out 内の 2 node が同一 oldRef
            //   （同一物理 asset）を参照した際に last-wins で両者が同一 dst に潰れて片方が孤児化する。
            //   plan が owner 単位に別 dst を採番しているので、適用も owner（node）単位に解決する。
            for (const nr of r.nodeRenames) {
                const node = nodes[nr.nodeId];
                if (!node) continue;
                const renameOf = new Map<string, string>();
                for (const rr of nr.renames) renameOf.set(rr.oldRef, rr.newRef);
                if (Array.isArray(node.images)) {
                    node.images = node.images.map((img: unknown) =>
                        (typeof img === 'string' && renameOf.has(img)) ? renameOf.get(img)! : img);
                }
                if (typeof node.filePath === 'string' && renameOf.has(node.filePath)) {
                    node.filePath = renameOf.get(node.filePath)!;
                }
            }
            writeJson(r.outPath, data);
            rewrittenOut.push({ outPath: r.outPath, originalText });
            j++;
        }

        // (4) 本文書換 + md リンク括弧化。
        //   移動した全 page md（page md owner + _notes_md + closure 発見 md、いずれも kind:'page'）を走査する。
        //   ① URL 書換（applyLinkUrlRewrites・bodyRewrites = asset の oldRef→newRef + ★md→md リンクの旧名→flat 新名）
        //   ② ★FR-MG-13（reopen④）: md リンク括弧化を **plan.promoteLinks の allowlist 駆動**に（無条件昇格の廃止）。
        //      同 stem・node/note 未参照の subpage と判定された url だけ `[[]]` 化する。allowlist は flat 新名基準なので
        //      ① の url 書換の後（body url が新名になった後）に照合する（rewrite→promote の順序 = M1-b）。
        const bodyRewriteMap = new Map<string, Map<string, string>>();
        for (const br of plan.bodyRewrites) {
            if (br.renames && br.renames.length > 0) {
                const m = new Map<string, string>();
                for (const rn of br.renames) m.set(rn.oldRef, rn.newRef);
                bodyRewriteMap.set(br.mdPath, m);
            }
        }
        const promoteMap = new Map<string, Set<string>>();
        for (const pl of (plan.promoteLinks || [])) {
            if (pl.urls && pl.urls.length > 0) promoteMap.set(pl.mdPath, new Set(pl.urls));
        }
        const promoteTargets = new Set<string>(
            plan.moves.filter((mv) => mv.kind === 'page').map((mv) => mv.to),
        );
        for (const mdPath of promoteTargets) {
            if (!isFile(mdPath)) continue;
            const originalText = fs.readFileSync(mdPath, 'utf8');
            let rewritten = originalText;
            const renames = bodyRewriteMap.get(mdPath);
            if (renames) rewritten = applyLinkUrlRewrites(rewritten, renames); // ① url 書換（asset + md リンク新名）
            const promoteUrls = promoteMap.get(mdPath);
            if (promoteUrls && promoteUrls.size > 0) {
                rewritten = promoteMdLinksToSubpage(rewritten, promoteUrls);   // ② allowlist の url だけ [[]] 化
            }
            if (rewritten !== originalText) {
                fs.writeFileSync(mdPath, rewritten, 'utf8');
                rewrittenMd.push({ mdPath, originalText });
            }
        }

        return { executedMoves: done.length, rolledBack: false };
    } catch (err) {
        // rollback（対称・copy 対応）: 書換を戻す → move を逆順で戻す → rmdir した stray dir を復元。
        for (const rw of rewrittenMd.reverse()) {
            try { fs.writeFileSync(rw.mdPath, rw.originalText, 'utf8'); } catch { /* best effort */ }
        }
        for (const rw of rewrittenOut.reverse()) {
            try { fs.writeFileSync(rw.outPath, rw.originalText, 'utf8'); } catch { /* best effort */ }
        }
        // rmdir した stray dir を先に復元（配下へ move を戻すため）
        for (const d of rmdirDone.reverse()) {
            try { fs.mkdirSync(d, { recursive: true }); } catch { /* best effort */ }
        }
        for (const d of done.reverse()) {
            try {
                if (d.exec === 'copy') {
                    // copy: 作った dst を削除（元 source は残っている）
                    if (fs.existsSync(d.move.to)) fs.rmSync(d.move.to, { force: true });
                } else {
                    // rename: 戻す
                    fs.mkdirSync(path.dirname(d.move.from), { recursive: true });
                    fs.renameSync(d.move.to, d.move.from);
                }
            } catch { /* best effort */ }
        }
        return { executedMoves: done.length, rolledBack: true, error: String((err as Error).message || err) };
    }
}

/** dry-run 用サマリ（件数 + 衝突 + 複製で増える件数） */
export function summarizePlan(plan: MigrationPlan): { pages: number; images: number; files: number; total: number; conflicts: number; copies: number } {
    const pages = plan.moves.filter(m => m.kind === 'page').length;
    const images = plan.moves.filter(m => m.kind === 'image').length;
    const files = plan.moves.filter(m => m.kind === 'file').length;
    // 複製（同一 source を 2 owner 以上が参照）で物理的に増える件数
    const srcCount = new Map<string, number>();
    for (const m of plan.moves) srcCount.set(m.from, (srcCount.get(m.from) || 0) + 1);
    let copies = 0;
    for (const c of srcCount.values()) if (c >= 2) copies += c;
    return { pages, images, files, total: plan.moves.length, conflicts: plan.conflicts.length, copies };
}

/**
 * FR-MG-08: executePlan 成功後の後始末。移行で参照データを flat へ移した残りの旧 per-outliner サブフォルダ
 * （plan.oldDirs）と、空になった _notes_md を削除して note 直下をクリーンにする。
 *
 * ★ 呼び出し側（notesEditorProvider.runFlatMigration）が「backup 成功 + executePlan rolledBack=false」を
 *   確認した後にのみ呼ぶこと（backup に原本が残る前提の recoverable な削除）。
 * ★ rmSync は本関数（flat-migrate.ts）に閉じ込める（DOD-24 allowlist。呼び出し側に delete API を書かない）。
 * ★ 削除失敗は throw せず errors に積む（掃除失敗は非致命。移行自体は既に成功・backup あり）。
 * ★ plan.oldDirs は planMigration が「noteDir 直下の実在旧サブフォルダのみ・noteDir 自身は絶対含まない」で
 *   構築済み。ここでも noteDir 自身でないことを二重チェックしてから rmSync（全消し事故の最終防波堤・維持）。
 * ★ FR-MG-11 改訂（再オープン③）: FR-MG-12 で画像/添付も cross-outliner 横断探索するようになったため、
 *   plan.unresolved に残るのは「全候補を探しても実体がどこにも無い」= 真の元々壊れリンクだけ。よって unresolved が
 *   あっても旧フォルダを削除してよい（消しても失うもの無し）。呼び出し側が unresolved リストを通知に使う。
 *   ★ 旧ガード（unresolved で削除中止）は撤廃。ただし noteDir 自身ガードは独立に維持（全消し事故防止）。
 */
export function cleanupOldDirs(plan: MigrationPlan): { removed: string[]; errors: string[]; skipped: boolean } {
    const removed: string[] = [];
    const errors: string[] = [];
    // ★FR-MG-11 改訂: unresolved は真の元々壊れのみ（FR-MG-12 の横断探索後）→ 削除を止めない（skipped は常に false）。
    const noteAbs = path.resolve(plan.noteDir);
    for (const dir of plan.oldDirs) {
        const abs = path.resolve(dir);
        // 最終防波堤: noteDir 自身・外・親は絶対に消さない（planMigration のガードと二重）。
        if (abs === noteAbs || !abs.startsWith(noteAbs + path.sep)) { continue; }
        try {
            fs.rmSync(abs, { recursive: true, force: true });
            removed.push(abs);
        } catch (e) {
            errors.push(`${abs}: ${String((e as Error).message || e)}`);
        }
    }
    // _notes_md は oldDirs とは別扱い: 未移行 md が残っていなければ（画像/添付の空 subdir だけなら）削除。
    const notesMd = path.join(noteAbs, '_notes_md');
    if (isDir(notesMd)) {
        try {
            const hasUnmigratedMd = walkHasMd(notesMd);
            if (!hasUnmigratedMd) {
                fs.rmSync(notesMd, { recursive: true, force: true });
                removed.push(notesMd);
            }
        } catch (e) {
            errors.push(`${notesMd}: ${String((e as Error).message || e)}`);
        }
    }
    return { removed, errors, skipped: false };
}

/** _notes_md 配下（再帰）に .md が 1 つでも残っているか（残っていれば削除しない = 保守的）。 */
function walkHasMd(dir: string): boolean {
    for (const e of fs.readdirSync(dir)) {
        const abs = path.join(dir, e);
        if (isDir(abs)) { if (walkHasMd(abs)) return true; }
        else if (e.endsWith('.md')) { return true; }
    }
    return false;
}
