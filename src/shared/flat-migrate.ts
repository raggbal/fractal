/**
 * flat-migrate — 旧レイアウト（per-<stem>/ or _notes_md/）を共有フラットレイアウトへ移行する純ロジック。
 *
 * sprint 20260707-124018-notes-flat-storage / decision 2026-07-07:
 *   新レイアウト: md=Note フォルダ直下 <noteDir>/<pageId>.md、画像/添付=共有 <noteDir>/images・<noteDir>/files
 *   .out は pageDir="." imageDir="./images" fileDir="./files"
 *
 * 旧レイアウト:
 *   <noteDir>/<stem>/<pageId>.md  +  <noteDir>/<stem>/images|files/  （per-outliner）
 *   <noteDir>/_notes_md/<id>.md   +  <noteDir>/_notes_md/images|files/（notes-md）
 *
 * ★md=Note 直下なので md 本文の相対リンクは `./images/x.png` のまま解決する（旧 <stem>/ 直下 md と
 *   相対階層が一致）→ 本文リンク書換は行わない（PoC の rewriteMdBodyLinks は本 sprint では不要）。
 * ★ただし .out の node.images / node.filePath 文字列は書き換える（outDir 基準の相対で、旧 <stem>/images/x.png
 *   → images/x.png）。これを怠ると表示崩壊 + cleanup 誤爆（データロス）。
 *
 * すべて vscode 非依存。command wrapper 側が dry-run 提示・承認・呼び出しを行う。
 */
import * as fs from 'fs';
import * as path from 'path';

export type MoveKind = 'page' | 'image' | 'file';
export interface Move { from: string; to: string; kind: MoveKind; }
export interface OutRewrite { outPath: string; }
export interface MigrationPlan {
    moves: Move[];
    outRewrites: OutRewrite[];
    conflicts: { to: string; a: string; b: string }[];
    noteDir: string;
    newImages: string;
    newFiles: string;
}

function readJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p: string, o: unknown): void { fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8'); }
function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

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

/** ある .out が既にフラット（pageDir="." かつ imageDir が共有 images）かを判定 */
function isAlreadyFlat(outPath: string, data: any): boolean {
    const norm = (v: unknown) => (typeof v === 'string' ? v.replace(/^\.\//, '').replace(/\/$/, '') : undefined);
    return norm(data?.pageDir) === '' || data?.pageDir === '.' || norm(data?.pageDir) === '.';
}

/**
 * 移行計画を構築する（ディスクは変更しない）。
 * md → <noteDir>/<basename>.md（Note 直下）、image → <noteDir>/images/、file → <noteDir>/files/。
 */
export function planMigration(noteDir: string): MigrationPlan {
    const moves: Move[] = [];
    const outRewrites: OutRewrite[] = [];
    const conflicts: { to: string; a: string; b: string }[] = [];
    const newImages = path.join(noteDir, 'images');
    const newFiles = path.join(noteDir, 'files');

    const seenTargets = new Map<string, string>();
    const addMove = (from: string, to: string, kind: MoveKind) => {
        if (from === to) return; // 既に所定位置（フラット済み）
        if (seenTargets.has(to) && seenTargets.get(to) !== from) {
            conflicts.push({ to, a: seenTargets.get(to)!, b: from });
        }
        seenTargets.set(to, from);
        moves.push({ from, to, kind });
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
        // pages: node.pageId ごとに Note 直下へ
        for (const nid of Object.keys(nodes)) {
            const node = nodes[nid];
            if (node && node.pageId) {
                const from = path.join(old.pageDir, `${node.pageId}.md`);
                const to = path.join(noteDir, `${node.pageId}.md`);
                if (isFile(from)) addMove(from, to, 'page');
            }
        }
        // images dir contents（丸ごと共有 images/ へ）
        if (isDir(old.imageDir)) {
            for (const f of fs.readdirSync(old.imageDir)) {
                const from = path.join(old.imageDir, f);
                if (isFile(from)) addMove(from, path.join(newImages, f), 'image');
            }
        }
        // files dir contents
        if (isDir(old.fileDir)) {
            for (const f of fs.readdirSync(old.fileDir)) {
                const from = path.join(old.fileDir, f);
                if (isFile(from)) addMove(from, path.join(newFiles, f), 'file');
            }
        }
        outRewrites.push({ outPath });
    }

    // notes-md（_notes_md/）→ Note 直下 md + 共有 images/files
    const mdRoot = path.join(noteDir, '_notes_md');
    if (isDir(mdRoot)) {
        for (const f of fs.readdirSync(mdRoot)) {
            const from = path.join(mdRoot, f);
            if (isFile(from) && f.endsWith('.md')) addMove(from, path.join(noteDir, f), 'page');
        }
        const mdImg = path.join(mdRoot, 'images');
        if (isDir(mdImg)) for (const f of fs.readdirSync(mdImg)) {
            const from = path.join(mdImg, f);
            if (isFile(from)) addMove(from, path.join(newImages, f), 'image');
        }
        const mdFiles = path.join(mdRoot, 'files');
        if (isDir(mdFiles)) for (const f of fs.readdirSync(mdFiles)) {
            const from = path.join(mdFiles, f);
            if (isFile(from)) addMove(from, path.join(newFiles, f), 'file');
        }
    }

    return { moves, outRewrites, conflicts, noteDir, newImages, newFiles };
}

/**
 * 計画全体を実行前に検証（アトミック性ゲート）。1 件でも問題があれば ok=false（execute しない）。
 */
export function validatePlan(plan: MigrationPlan, opts: { forceFailTarget?: string } = {}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    for (const c of plan.conflicts) reasons.push(`internal collision: ${c.a} and ${c.b} both -> ${c.to}`);
    for (const m of plan.moves) {
        if (!fs.existsSync(m.from)) reasons.push(`missing source: ${m.from}`);
        if (fs.existsSync(m.to)) reasons.push(`pre-existing target: ${m.to}`);
    }
    if (opts.forceFailTarget) {
        const bad = plan.moves.find(m => m.to.includes(opts.forceFailTarget!));
        if (bad) reasons.push(`injected failure: target unwritable ${bad.to}`);
    }
    return { ok: reasons.length === 0, reasons };
}

/** node.images / node.filePath 文字列を共有 dir 相対（images/<base> / files/<base>）へ書き換える */
function rewriteAssetRef(ref: unknown, kind: 'images' | 'files'): unknown {
    if (typeof ref !== 'string' || !ref) return ref;
    const base = path.posix.basename(ref.replace(/\\/g, '/'));
    return `${kind}/${base}`;
}

/**
 * 検証済み計画を実行する。rename を順に行い、全 rename 成功後に .out JSON を書き換える。
 * 途中失敗時は実行済み rename を逆順で戻す（ロールバック）。md 本文は書き換えない（md 直下で ./images 有効）。
 */
export function executePlan(plan: MigrationPlan, opts: { injectFailAfter?: number } = {}): { executedMoves: number; rolledBack: boolean; error?: string } {
    if (plan.moves.some(m => m.kind === 'image')) fs.mkdirSync(plan.newImages, { recursive: true });
    if (plan.moves.some(m => m.kind === 'file')) fs.mkdirSync(plan.newFiles, { recursive: true });

    const done: Move[] = [];
    try {
        let i = 0;
        for (const m of plan.moves) {
            if (opts.injectFailAfter != null && i === opts.injectFailAfter) {
                throw new Error(`INJECTED failure after ${i} moves`);
            }
            fs.mkdirSync(path.dirname(m.to), { recursive: true });
            fs.renameSync(m.from, m.to);
            done.push(m);
            i++;
        }
        // 全 rename 成功後に .out JSON を書換（ヘッダ + node.images/filePath）。
        for (const r of plan.outRewrites) {
            const data = readJson(r.outPath);
            data.pageDir = '.';
            data.imageDir = './images';
            data.fileDir = './files';
            const nodes = data.nodes || {};
            for (const nid of Object.keys(nodes)) {
                const node = nodes[nid];
                if (Array.isArray(node.images)) {
                    node.images = node.images.map((img: unknown) => rewriteAssetRef(img, 'images'));
                }
                if (node.filePath) {
                    node.filePath = rewriteAssetRef(node.filePath, 'files');
                }
            }
            writeJson(r.outPath, data);
        }
        return { executedMoves: done.length, rolledBack: false };
    } catch (err) {
        // rollback: 実行済み rename を逆順で戻す（JSON はまだ書いていないので巻き戻し不要）
        for (const m of done.reverse()) {
            try { fs.renameSync(m.to, m.from); } catch { /* best effort */ }
        }
        return { executedMoves: done.length, rolledBack: true, error: String((err as Error).message || err) };
    }
}

/** dry-run 用サマリ（件数 + 衝突） */
export function summarizePlan(plan: MigrationPlan): { pages: number; images: number; files: number; total: number; conflicts: number } {
    const pages = plan.moves.filter(m => m.kind === 'page').length;
    const images = plan.moves.filter(m => m.kind === 'image').length;
    const files = plan.moves.filter(m => m.kind === 'file').length;
    return { pages, images, files, total: plan.moves.length, conflicts: plan.conflicts.length };
}
