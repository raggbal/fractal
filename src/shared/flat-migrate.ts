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
import { applyLinkUrlRewrites, extractAllAssetRefs } from './paste-asset-handler';

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
        return (ref: string, resolveBase: string, inImages: boolean): string | null => {
            const srcAsset = path.resolve(resolveBase, ref);
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

    for (const outPath of outFiles) {
        let data: any;
        try { data = readJson(outPath); } catch { continue; }
        if (isAlreadyFlat(outPath, data)) { continue; } // 既にフラットな .out はスキップ
        const old = resolveOldDirs(outPath, data);
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
                const srcMd = path.join(old.pageDir, `${node.pageId}.md`);
                if (isFile(srcMd)) {
                    const dstMdName = uniqMd(`${node.pageId}.md`);
                    const dstMd = path.join(noteDir, dstMdName);
                    let body = '';
                    try { body = fs.readFileSync(srcMd, 'utf8'); } catch { body = ''; }
                    const refs = extractAllAssetRefs(body);
                    const bodyR: { oldRef: string; newRef: string }[] = [];
                    // 本文の相対参照は「旧 pageDir 基準」で解決（images/x.png / files/y.pdf）。
                    // refs.images は inImages=true（drawio は reserve 内で files/ へ）、refs.files は inImages=false。
                    for (const ref of refs.images) {
                        const newRef = reserve(ref, old.pageDir, true);
                        if (newRef) bodyR.push({ oldRef: ref, newRef });
                    }
                    for (const ref of refs.files) {
                        const newRef = reserve(ref, old.pageDir, false);
                        if (newRef) bodyR.push({ oldRef: ref, newRef });
                    }
                    // ★本文書換は解決結果が変わる時のみ（`./images/x`→`images/x` の正規化差では書換しない
                    //   = 後方互換。drawio の images/→files/ 移動や uniquify 連番退避では書換する）。
                    const effectiveBodyR = bodyR.filter(r => needsBodyRewrite(r.oldRef, r.newRef));
                    bodyRewrites.push({ mdPath: dstMd, renames: effectiveBodyR });
                    pushMove(srcMd, dstMd, 'page');
                }
            }

            // (2) node.images[] → images/（drawio は files/）。本文と同じ src なら同一コピーへ集約。
            if (Array.isArray(node.images)) {
                for (const ref of node.images) {
                    if (typeof ref !== 'string' || !ref) continue;
                    // node.images は outDir(=noteDir) 基準。inImages=true（drawio は reserve 内で files/ へ）。
                    const newRef = reserve(ref, noteDir, true);
                    if (newRef && newRef !== ref) refRenames.push({ oldRef: ref, newRef });
                }
            }
            // (3) node.filePath → files/（inImages=false で必ず files/。本文 📎 と同じ src なら同一コピーへ集約）
            if (typeof node.filePath === 'string' && node.filePath) {
                const ref = node.filePath;
                const newRef = reserve(ref, noteDir, false); // node.filePath は outDir(=noteDir) 基準
                if (newRef && newRef !== ref) refRenames.push({ oldRef: ref, newRef });
            }
            if (refRenames.length > 0) nodeRenames.push({ nodeId: nid, renames: refRenames });
        }
        outRewrites.push({ outPath, nodeRenames });
    }

    // (4) notes-md（_notes_md/）→ page md owner と同じ扱い（本文 refs を uniquify + BodyRewrite）
    const mdRoot = path.join(noteDir, '_notes_md');
    if (isDir(mdRoot)) {
        for (const f of fs.readdirSync(mdRoot)) {
            const from = path.join(mdRoot, f);
            if (!isFile(from) || !f.endsWith('.md')) continue;
            const dstMdName = uniqMd(f);
            const dstMd = path.join(noteDir, dstMdName);
            let body = '';
            try { body = fs.readFileSync(from, 'utf8'); } catch { body = ''; }
            const refs = extractAllAssetRefs(body);
            const reserve = makeOwnerReserver(); // 1 md = 1 owner（新規 dedup）
            const bodyR: { oldRef: string; newRef: string }[] = [];
            for (const ref of refs.images) {
                const newRef = reserve(ref, mdRoot, true); // 本文相対は _notes_md/ 基準
                if (newRef) bodyR.push({ oldRef: ref, newRef });
            }
            for (const ref of refs.files) {
                const newRef = reserve(ref, mdRoot, false);
                if (newRef) bodyR.push({ oldRef: ref, newRef });
            }
            const effectiveBodyR = bodyR.filter(r => needsBodyRewrite(r.oldRef, r.newRef));
            bodyRewrites.push({ mdPath: dstMd, renames: effectiveBodyR });
            pushMove(from, dstMd, 'page');
        }
    }

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

    return { moves, outRewrites, bodyRewrites, strayDirs, conflicts, noteDir, newImages, newFiles };
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

        // (4) bodyRewrites を dst md に適用（renames が空ならスキップ = 後方互換）
        for (const br of plan.bodyRewrites) {
            if (!br.renames || br.renames.length === 0) continue;
            if (!isFile(br.mdPath)) continue;
            const originalText = fs.readFileSync(br.mdPath, 'utf8');
            const renames = new Map<string, string>();
            for (const rn of br.renames) renames.set(rn.oldRef, rn.newRef);
            const rewritten = applyLinkUrlRewrites(originalText, renames);
            if (rewritten !== originalText) {
                fs.writeFileSync(br.mdPath, rewritten, 'utf8');
                rewrittenMd.push({ mdPath: br.mdPath, originalText });
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
