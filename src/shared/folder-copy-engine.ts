/**
 * フォルダ複製エンジン（DOM-FolderCopyEngineContext / MOD-FolderCopyEngine）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-02 / FR-FDP-08 / NFR-FDP-01 / NFR-FDP-02 / NFR-FDP-05 / ADRL-0126 / ADRL-0127
 *
 * 「実フォルダを別の座標へ中身ごと複製する」唯一の汎用正典。既存の再帰実装 4 本
 * （walkFolderForImport / runFolderExport / registerFolderIntoTree / cpSync による別 note 移動）は
 * すべて用途固定で、symlink の扱い・並び・巻き戻しが非対称だったため 1 本だけ新設した。
 *
 * ## 契約（ADRL-0126）
 * - **純関数**: 件数ゲートを呼ばない / 通知を出さない / 閾値定数を新しく export しない。
 *   上限値は `folder-import.ts` の既存定数を**引数の既定値**として受け取る（第 3 のゲートを作らない）。
 * - **symlink は skip**（`lstat` 意味論 = `withFileTypes` の `isSymbolicLink()`）。walk の内側でも
 *   root を出ないので containment（NFR-FDP-02）がここで成立する。
 *   ※ 外部 URI の入口（`partitionDroppedUris`）は `statSync` で symlink を追従する — あちらは
 *   「ユーザーが外から指した対象」を解決するので辿るのが正しく、この非対称は**意図**（ADRL-0126）。
 * - **dotfile は `showHidden` に追従**（既定 skip）。skip した件数は `skipped[]` に載せる。
 * - **例外を投げない・`null` を返さない**（構造体で返す。ADRL-0127）。
 * - **上限超過は 0 件処理・原状不変**（宛先に何も作らない）。
 * - **部分コピーの残骸は消さない**（ADRL-0127。消すと「元も宛先も無い」瞬間ができる）。
 * - **一定件数ごとに制御を譲る**（NFR-FDP-01。既存 3 engine の同期一括は大量ファイルで
 *   extension host を数十秒ブロックした前例がある）。
 *
 * ## 🔴 禁止用途（ADRL-0127）
 * **別デバイスをまたぐ移動の救済（複製してから元を削除する形）に流用してはならない。**
 * `folderViewMove` の移動分岐は「別デバイスをまたぐ場合も含めて中断する」が既存の受容事項で、
 * 汎用複製ができると流用が容易になるため明文で禁止する（番人 = TC-CON-4）。
 */
import * as fsDefault from 'fs';
import * as path from 'path';
import { FOLDER_IMPORT_MAX_FILES, FOLDER_IMPORT_MAX_DEPTH } from './folder-import';

/** skip / failed の理由（呼び出し側が集計通知に載せる）。 */
export type DirCopySkipReason = 'symlink' | 'hidden' | 'unreadable_dir' | 'not_regular_file';
export type DirCopyFailReason = 'copy_failed' | 'mkdir_failed';
/** 0 件処理（原状不変）になった理由。 */
export type DirCopyAbortReason = 'too_many_files' | 'too_deep' | 'src_unreadable' | 'src_not_dir';

export interface DirCopySkip { path: string; reason: DirCopySkipReason }
export interface DirCopyFail { path: string; reason: DirCopyFailReason; message?: string }

/** 走査結果（件数ゲートは**呼び出し側**がこれを使って掛ける = FR-FDP-08 の 2 段目）。 */
export interface DirCopyPlan {
    ok: boolean;
    abort?: DirCopyAbortReason;
    totalFiles: number;
    totalDirs: number;
    maxDepthSeen: number;
    skipped: DirCopySkip[];
}

/** 複製結果。`ok=false` は「0 件処理・原状不変」を意味する。 */
export interface DirCopyOutcome extends DirCopyPlan {
    copiedFiles: number;
    copiedDirs: number;
    failed: DirCopyFail[];
    /** 実際に作られた宛先の絶対パス（uniquify 後の名前が反映される）。0 件処理なら null。 */
    dstAbs: string | null;
}

/** 注入可能な fs（テストで失敗を注入するため。既定は本物）。 */
export interface DirCopyFs {
    readdirSync: typeof fsDefault.readdirSync;
    existsSync: typeof fsDefault.existsSync;
    lstatSync: typeof fsDefault.lstatSync;
    mkdirSync: typeof fsDefault.mkdirSync;
    copyFileSync: typeof fsDefault.copyFileSync;
}

export interface DirCopyOpts {
    /** linkedfd の隠しファイル表示設定に追従する（既定 false = skip）。 */
    showHidden?: boolean;
    /** 上限。既定は folder-import の既存定数（**新しい定数を export しない**）。 */
    maxFiles?: number;
    maxDepth?: number;
    /** 宛先に作るフォルダ名（衝突解決後の名前を呼び出し側が決める）。既定は src の basename。 */
    destName?: string;
    /** 制御を譲る間隔（処理したエントリ数）。既定 200。 */
    yieldEvery?: number;
    /** 注入 fs（テスト用）。 */
    fs?: DirCopyFs;
}

interface DirentLike { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }

const DEFAULT_YIELD_EVERY = 200;

function realFs(): DirCopyFs {
    return {
        readdirSync: fsDefault.readdirSync,
        existsSync: fsDefault.existsSync,
        lstatSync: fsDefault.lstatSync,
        mkdirSync: fsDefault.mkdirSync,
        copyFileSync: fsDefault.copyFileSync,
    };
}

/** 制御を譲る（NFR-FDP-01: 単一の同期区間を短く保つ）。 */
function yieldToLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * dirent を「複製・走査の対象」に絞る。**複製と走査で同一の意味論を共有する**
 * （数える対象と複製する対象が食い違わないことが FR-FDP-02 の要件）。
 * 並びは既存 walk と同じ「フォルダ先行 + 大小文字無視の昇順」。
 */
function visibleDirents(
    dirents: DirentLike[],
    dirAbs: string,
    showHidden: boolean,
    skipped: DirCopySkip[]
): DirentLike[] {
    const out: DirentLike[] = [];
    for (const d of dirents) {
        if (d.isSymbolicLink()) {
            // symlink は追従しない（containment = NFR-FDP-02）
            skipped.push({ path: path.join(dirAbs, d.name), reason: 'symlink' });
            continue;
        }
        if (!showHidden && d.name.startsWith('.')) {
            skipped.push({ path: path.join(dirAbs, d.name), reason: 'hidden' });
            continue;
        }
        if (!d.isDirectory() && !d.isFile()) {
            skipped.push({ path: path.join(dirAbs, d.name), reason: 'not_regular_file' });
            continue;
        }
        out.push(d);
    }
    out.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
        const an = a.name.toLowerCase(); const bn = b.name.toLowerCase();
        return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    return out;
}

interface WalkNode { dirAbs: string; rel: string; depth: number; entries: DirentLike[] }

/**
 * 走査（複製しない）。`copyFolderRecursive` と `walkFolderCount` の共通土台。
 * fs への書き込みを 1 回も行わない。
 */
async function walkTree(srcAbs: string, opts: DirCopyOpts): Promise<{ plan: DirCopyPlan; nodes: WalkNode[] }> {
    const io = opts.fs ?? realFs();
    const showHidden = opts.showHidden === true;
    const maxFiles = opts.maxFiles ?? FOLDER_IMPORT_MAX_FILES;
    const maxDepth = opts.maxDepth ?? FOLDER_IMPORT_MAX_DEPTH;
    const yieldEvery = opts.yieldEvery ?? DEFAULT_YIELD_EVERY;
    const skipped: DirCopySkip[] = [];
    const nodes: WalkNode[] = [];
    let totalFiles = 0; let totalDirs = 0; let maxDepthSeen = 0; let processed = 0;

    const fail = (abort: DirCopyAbortReason): { plan: DirCopyPlan; nodes: WalkNode[] } => ({
        plan: { ok: false, abort, totalFiles, totalDirs, maxDepthSeen, skipped }, nodes: [],
    });

    try {
        if (!io.lstatSync(srcAbs).isDirectory()) { return fail('src_not_dir'); }
    } catch { return fail('src_unreadable'); }

    // 幅優先（深さを持ち回る）。再帰にしないのは制御を譲る点を素直に置けるため。
    const queue: Array<{ dirAbs: string; rel: string; depth: number }> = [{ dirAbs: srcAbs, rel: '', depth: 0 }];
    while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.depth > maxDepth) { return fail('too_deep'); }
        maxDepthSeen = Math.max(maxDepthSeen, cur.depth);
        let dirents: DirentLike[];
        try {
            dirents = io.readdirSync(cur.dirAbs, { withFileTypes: true }) as unknown as DirentLike[];
        } catch {
            // 読めない dir は中身を落として続行（既存 canon の 3 段目）
            skipped.push({ path: cur.dirAbs, reason: 'unreadable_dir' });
            continue;
        }
        const visible = visibleDirents(dirents, cur.dirAbs, showHidden, skipped);
        nodes.push({ dirAbs: cur.dirAbs, rel: cur.rel, depth: cur.depth, entries: visible });
        for (const d of visible) {
            if (d.isDirectory()) {
                totalDirs++;
                queue.push({ dirAbs: path.join(cur.dirAbs, d.name), rel: path.join(cur.rel, d.name), depth: cur.depth + 1 });
            } else {
                totalFiles++;
                if (totalFiles > maxFiles) { return fail('too_many_files'); }
            }
            if (++processed % yieldEvery === 0) { await yieldToLoop(); }
        }
    }
    return { plan: { ok: true, totalFiles, totalDirs, maxDepthSeen, skipped }, nodes };
}

/** 走査で得た 1 エントリ（rel は src root からの相対パス）。 */
export interface DirWalkEntry { rel: string; abs: string; kind: 'dir' | 'file'; depth: number }

/**
 * 走査して**エントリ列**を返す（台帳登録のような「複製ではない消費」のための入口）。
 * dirent 意味論（symlink skip / showHidden 追従 / フォルダ先行の昇順）は複製と**共有**する
 * ので、「数える対象 / 複製する対象 / 登録する対象」が食い違わない（ADRL-0128）。
 * fs への書き込みは行わない。
 */
export async function walkFolderEntries(
    srcAbs: string,
    opts: DirCopyOpts = {}
): Promise<{ plan: DirCopyPlan; entries: DirWalkEntry[] }> {
    const { plan, nodes } = await walkTree(srcAbs, opts);
    const entries: DirWalkEntry[] = [];
    for (const node of nodes) {
        for (const d of node.entries) {
            entries.push({
                rel: path.join(node.rel, d.name),
                abs: path.join(node.dirAbs, d.name),
                kind: d.isDirectory() ? 'dir' : 'file',
                depth: node.depth + 1,
            });
        }
    }
    return { plan, entries };
}

/**
 * 走査専用モード（FR-FDP-08 の 1 段目）。**fs への書き込みを 1 回も行わない。**
 * A-1（linkedfd 面内の移動）はエンジンの複製を呼ばないため、件数ゲートに渡す実件数をここで得る。
 */
export async function walkFolderCount(srcAbs: string, opts: DirCopyOpts = {}): Promise<DirCopyPlan> {
    const { plan } = await walkTree(srcAbs, opts);
    return plan;
}

/**
 * 実フォルダを別の座標へ中身ごと複製する。
 * 失敗しても例外を投げず `DirCopyOutcome` を返す（ADRL-0127）。
 */
export async function copyFolderRecursive(
    srcAbs: string,
    dstDirAbs: string,
    opts: DirCopyOpts = {}
): Promise<DirCopyOutcome> {
    const io = opts.fs ?? realFs();
    const yieldEvery = opts.yieldEvery ?? DEFAULT_YIELD_EVERY;
    const { plan, nodes } = await walkTree(srcAbs, opts);
    const base: DirCopyOutcome = { ...plan, copiedFiles: 0, copiedDirs: 0, failed: [], dstAbs: null };
    // 上限超過・読めない src は **0 件処理・原状不変**（宛先に何も作らない）
    if (!plan.ok) { return base; }

    const destName = opts.destName ?? path.basename(srcAbs);
    const dstRoot = path.join(dstDirAbs, destName);
    const failed: DirCopyFail[] = [];
    let copiedFiles = 0; let copiedDirs = 0; let processed = 0;

    try {
        io.mkdirSync(dstRoot, { recursive: true });
        copiedDirs++;
    } catch (e: any) {
        failed.push({ path: dstRoot, reason: 'mkdir_failed', message: e?.message });
        return { ...base, failed, dstAbs: null };
    }

    for (const node of nodes) {
        const dstNodeDir = path.join(dstRoot, node.rel);
        if (node.rel !== '') {
            try { io.mkdirSync(dstNodeDir, { recursive: true }); copiedDirs++; }
            catch (e: any) { failed.push({ path: dstNodeDir, reason: 'mkdir_failed', message: e?.message }); continue; }
        }
        for (const d of node.entries) {
            if (d.isDirectory()) { continue; }   // dir は node ループ側で作る
            const from = path.join(node.dirAbs, d.name);
            const to = path.join(dstNodeDir, d.name);
            try { io.copyFileSync(from, to); copiedFiles++; }
            catch (e: any) {
                // 個別ファイルの失敗は skip して続行（既存 canon の 3 段目）。残骸は消さない
                failed.push({ path: from, reason: 'copy_failed', message: e?.message });
            }
            if (++processed % yieldEvery === 0) { await yieldToLoop(); }
        }
    }
    return { ...plan, copiedFiles, copiedDirs, failed, dstAbs: dstRoot };
}
