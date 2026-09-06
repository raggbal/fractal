/**
 * folder-import — outliner「Import folder...」の再帰列挙 + コピー統合
 * （DOM-FolderImportWalk / DOM-FolderImportPlan・FR-OIF-02/03/04）
 * Sprint 20260827-172802（ADRL-0103: 実体は note へコピー）。
 *
 * - 隠し「.」エントリ skip + symlink 非追従（fv listing = FR-FLV-11 と同一の dirent 意味論）
 * - 上限 maxFiles 2000 / maxDepth 20（fv-residual-refs walk と同じ定数系譜）— 超過は列挙段階で
 *   中断し {ok:false} を返す（コピー 0 = 原状不変。部分取り込みしない — FR-OIF-03）
 * - totalCount > 200（FOLDER_IMPORT_CONFIRM_THRESHOLD）は呼び出し側が確認 modal を出す
 * - 並び = フォルダ先行・名前昇順（fv listing と同じ — node 挿入順の決定論）
 */
import * as fs from 'fs';
import * as path from 'path';
import { importMdFilesCore, ImportMdItem, ImportedMdFile, ImportMdOptions } from './markdown-import';
import { importFilesCore, ImportFileItem, ImportedFile } from './file-import';
import { extractAllAssetRefs, applyLinkUrlRewrites, normalizeMdLinkKeys } from './paste-asset-handler';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mdLinkParser = require('./markdown-link-parser');

export const FOLDER_IMPORT_MAX_FILES = 2000;
export const FOLDER_IMPORT_MAX_DEPTH = 20;
export const FOLDER_IMPORT_CONFIRM_THRESHOLD = 200;

export type FolderImportEntry =
    | { kind: 'dir'; name: string; children: FolderImportEntry[] }
    | { kind: 'md'; name: string; absPath: string }
    | { kind: 'file'; name: string; absPath: string };

export type WalkFolderResult =
    | { ok: true; entries: FolderImportEntry[]; fileCount: number; totalCount: number; unreadableDirs: number }
    | { ok: false; error: 'too_many' | 'too_deep' };

/** 上限超過による列挙中断（内部専用）。Error 派生にして stack trace を残す（no-throw-literal 準拠） */
class FolderImportAbort extends Error {
    constructor(public readonly reason: 'too_many' | 'too_deep') {
        super(`folder import aborted: ${reason}`);
        this.name = 'FolderImportAbort';
    }
}

export function walkFolderForImport(
    rootAbs: string,
    limits?: { maxFiles?: number; maxDepth?: number }
): WalkFolderResult {
    const maxFiles = limits?.maxFiles ?? FOLDER_IMPORT_MAX_FILES;
    const maxDepth = limits?.maxDepth ?? FOLDER_IMPORT_MAX_DEPTH;
    let fileCount = 0;
    let totalCount = 0;
    let unreadableDirs = 0;

    const walkDir = (dirAbs: string, depth: number): FolderImportEntry[] => {
        if (depth > maxDepth) { throw new FolderImportAbort('too_deep'); }
        let dirents: fs.Dirent[];
        try {
            dirents = fs.readdirSync(dirAbs, { withFileTypes: true });
        } catch (e) {
            // 読めない dir は中身を落とすが、silent 消失させない（件数を呼び出し側の skip 集計へ）
            unreadableDirs++;
            console.warn('[Outliner] folder import: directory not readable — contents skipped:', dirAbs, e);
            return [];
        }
        // 隠し「.」+ symlink 除外（FR-FLV-11 意味論）→ フォルダ先行 + 大小文字を無視した昇順
        // （比較関数は precedent readFolderEntriesAt（notes-message-handler.ts）と同一 — fv 一覧と並びを揃える）
        const visible = dirents.filter((d) => !d.name.startsWith('.') && !d.isSymbolicLink());
        visible.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) { return a.isDirectory() ? -1 : 1; }
            const an = a.name.toLowerCase(); const bn = b.name.toLowerCase();
            return an < bn ? -1 : (an > bn ? 1 : 0);
        });
        const out: FolderImportEntry[] = [];
        for (const d of visible) {
            const abs = path.join(dirAbs, d.name);
            if (d.isDirectory()) {
                totalCount++;
                out.push({ kind: 'dir', name: d.name, children: walkDir(abs, depth + 1) });
            } else if (d.isFile()) {
                fileCount++; totalCount++;
                if (fileCount > maxFiles) { throw new FolderImportAbort('too_many'); }
                out.push(/\.md$/i.test(d.name)
                    ? { kind: 'md', name: d.name, absPath: abs }
                    : { kind: 'file', name: d.name, absPath: abs });
            }
            // socket/fifo 等はどれでもない → skip
        }
        return out;
    };

    try {
        const entries = walkDir(rootAbs, 1);
        return { ok: true, entries, fileCount, totalCount, unreadableDirs };
    } catch (e) {
        if (e instanceof FolderImportAbort) { return { ok: false, error: e.reason }; }
        throw e;
    }
}

// ────────────────────────────────────────────
// DOM-ImportClosureSuppression — md 添付 closure の算出と node 化抑止
// （sprint 20260901-075849 / FR-OIF-05/06/07 / NFR-DCP-01）
// ────────────────────────────────────────────

/**
 * walk entries に含まれる md 群が**本文から参照している**実体（画像 / 📎 file / subpage md）の
 * closure を絶対パス集合で返す（FR-OIF-05 rev2 / ADRL-0110）。
 *
 * 🔴 **closure = 随伴転送エンジン（`copyMdPasteAssets`）が実際に複製する参照の集合と同一**でなければならない。
 * 抽出は `extractAllAssetRefs`（`paste-asset-handler.ts`）の 3 集合に**依存**する（規則を写経しない）:
 *   (1) `images`      = `![alt](x)`               (2) `files` = `[📎 …](x)`（ラベル先頭が 📎 のもののみ）
 *   (3) `mdLinkRefs` のうち `isSubpage === true` = `[[label]](x.md)`
 * プレーン `[text](x.md)` / `[text](x.pdf)` は**含めない**（ADRL-0078 / `collectMdLinkClosure` の isSubpage ゲート:
 * 参照リンクは複製しない = エンジンと同じ）。
 *
 * rev1 は `CLEANUP_MD_LINK_RE`（全 `[..](..)`）に pin していたため closure がエンジンの複製集合より広く、
 * 差分（プレーンリンク先）が「node を作らない」かつ「複製もされない」で**どこにも入らなかった**
 * （実行再現: `index.md` + `[Chapter 1](chapter1.md)` → node は index.md のみ / pages 1 / files 0）。
 *
 * - **URL decode を伴う**（`images/pic%20a.png` → 実名 `pic a.png` と照合できるように）
 * - **containment**: `rootAbs` 配下に解決されない参照（絶対パス / 境界外 `../`）は closure に入れない
 *   （md 本文はディスク上の非信頼入力 = NFR-DCP-01）
 * - **循環 root ルール**（FR-OIF-05 R2）: root = 他の走査 md から参照されない走査 md。closure は root から
 *   subpage エッジで到達する参照先（root 自身を除く）。どの root からも到達しない走査 md（相互参照だけで
 *   閉じた群）が残ったら**走査順先頭を root に昇格**して繰り返す。走査 md は必ず「node になる」か
 *   「root の subpage として複製される」のどちらかに落ち、両方から漏れる状態を作らない
 *   （rev1 は「参照された md は無条件で closure」だったため `a.md ⇄ b.md` で両方が抑止され何も取り込まれなかった）。
 *
 * closure に入った実体は **node を作らない**（実体のコピーは md の随伴転送が担う = FR-OIF-06）。
 */
export function computeMdClosure(entries: FolderImportEntry[], rootAbs: string): Set<string> {
    // 走査 md（走査順 = 循環時の root 昇格順）
    const walkMds: string[] = [];
    const collectMd = (list: FolderImportEntry[]): void => {
        for (const e of list) {
            if (e.kind === 'dir') { collectMd(e.children); } else if (e.kind === 'md') { walkMds.push(path.resolve(e.absPath)); }
        }
    };
    collectMd(entries);
    const closure = new Set<string>();
    if (walkMds.length === 0) { return closure; }

    /** rootAbs 配下に clamp して絶対パスへ。境界外 / 絶対パス指定 / 外部 URL は null。 */
    const resolveUnderRoot = (baseDir: string, ref: string): string | null => {
        if (!ref) { return null; }
        if (/^(https?:|data:|file:|fractal:|mailto:)/i.test(ref)) { return null; }
        const cleaned = ref.split(/[?#]/)[0];
        if (!cleaned) { return null; }
        let decoded = cleaned;
        try { decoded = decodeURIComponent(cleaned); } catch { /* 不正 escape は生のまま照合 */ }
        if (path.isAbsolute(decoded) || /^[a-zA-Z]:[/\\]/.test(decoded)) { return null; }
        const abs = path.resolve(baseDir, decoded);
        const relToRoot = path.relative(rootAbs, abs);
        if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) { return null; }
        return abs;
    };

    /** 1 md の直接参照（エンジンと同じ 3 形式のみ・decode + containment + 実在）。読めない md は空。 */
    const refsCache = new Map<string, { mds: string[]; assets: string[] }>();
    const refsOf = (mdAbs: string): { mds: string[]; assets: string[] } => {
        const hit = refsCache.get(mdAbs);
        if (hit) { return hit; }
        const out = { mds: [] as string[], assets: [] as string[] };
        let body: string;
        try { body = fs.readFileSync(mdAbs, 'utf8'); } catch { refsCache.set(mdAbs, out); return out; }
        const baseDir = path.dirname(mdAbs);
        const refs = extractAllAssetRefs(body);
        const push = (raw: string, isMd: boolean): void => {
            const abs = resolveUnderRoot(baseDir, raw);
            if (!abs || !fs.existsSync(abs)) { return; }
            (isMd ? out.mds : out.assets).push(path.resolve(abs));
        };
        for (const u of refs.images) { push(u, false); }
        for (const u of refs.files) { push(u, false); }
        for (const r of refs.mdLinkRefs) { if (r.isSubpage) { push(r.url, true); } }
        refsCache.set(mdAbs, out);
        return out;
    };

    /** start から subpage エッジで到達する md 集合（循環なら start 自身も含みうる）。 */
    const reachMds = (start: string): Set<string> => {
        const seen = new Set<string>();
        const stack = [start];
        while (stack.length > 0) {
            const m = stack.pop()!;
            for (const n of refsOf(m).mds) {
                if (!seen.has(n)) { seen.add(n); stack.push(n); }
            }
        }
        return seen;
    };

    // root = 他の走査 md（自分以外）から到達されない走査 md
    const referenced = new Set<string>();
    for (const m of walkMds) {
        for (const n of reachMds(m)) { if (n !== m) { referenced.add(n); } }
    }
    const roots: string[] = walkMds.filter((m) => !referenced.has(m));

    /** roots から到達する参照先（md + 資産）を closure に積む。root 自身は入れない。 */
    const build = (): void => {
        closure.clear();
        const rootSet = new Set(roots);
        const visited = new Set<string>();
        const stack = [...roots];
        while (stack.length > 0) {
            const m = stack.pop()!;
            if (visited.has(m)) { continue; }
            visited.add(m);
            const r = refsOf(m);
            for (const a of r.assets) { closure.add(a); }
            for (const n of r.mds) {
                if (!rootSet.has(n)) { closure.add(n); }
                if (!visited.has(n)) { stack.push(n); }
            }
        }
    };
    build();
    // 相互参照だけで閉じた群（どの root からも到達しない走査 md）は走査順先頭を root に昇格して繰り返す
    for (;;) {
        const unreached = walkMds.find((m) => !roots.includes(m) && !closure.has(m));
        if (!unreached) { break; }
        roots.push(unreached);
        build();
    }
    return closure;
}

/**
 * その dir 配下（**再帰的に**）に closure 外の実体が 1 件以上あるか（FR-OIF-07）。
 *
 * `true` のときだけ folder node を作る。
 *
 * 2 つの落とし穴:
 * 1. **「直下だけ見る」実装にすると中間 dir の node が消えて孫が root へ浮く**
 *    （design/system.md §5-4 の行 3 — 最も落ちやすいセル）→ 再帰で判定する。
 * 2. **children が 1 つも無い dir は `true`**（design/system.md §5-4 の行 5
 *    「元から空の dir は従来挙動を維持」）。空 dir / **読めない dir**（EACCES で children が
 *    空になる = 既存 TC-OIF-09）は closure と何の関係も無いので、抑止の対象にしない。
 *    ここを `false` にすると読めない dir の node が silent に消える（実測で既存 TC が RED）。
 */
export function hasNonClosureDescendant(entry: FolderImportEntry, closure: Set<string>): boolean {
    if (entry.kind === 'dir') {
        // 行 5: 空 dir / 読めない dir は従来どおり node を作る（closure 由来の抑止対象ではない）
        if (entry.children.length === 0) { return true; }
        for (const c of entry.children) {
            if (hasNonClosureDescendant(c, closure)) { return true; }
        }
        return false;
    }
    return !closure.has(path.resolve(entry.absPath));
}

// ────────────────────────────────────────────

// ────────────────────────────────────────────
// DOM-FolderImportPlan — コピー実行と results 契約（FR-OIF-02/04・design §A3）
// ────────────────────────────────────────────

/**
 * webview へ渡す階層 entries（walk entries ではなく取り込み後の実体参照を持つ）。
 * message: { type:'importFolderResult', targetNodeId, entries, skipped }
 */
export type FolderImportResultEntry =
    | { kind: 'dir'; name: string; children: FolderImportResultEntry[] }
    | { kind: 'md'; name: string; pageId: string }      // pages/<pageId>.md（importMdFilesCore の結果）
    | { kind: 'file'; name: string; filePath: string }; // outDir 相対（importFilesCore の結果）

export interface FolderImportDeps {
    /** showOpenDialog({canSelectFolders:true, canSelectFiles:false, canSelectMany:false})。undefined = キャンセル */
    pickFolder(): Promise<string | undefined> | string | undefined;
    /** totalCount > 閾値 の確認 modal（importFolderConfirm）。false = 取り込まない */
    confirmLarge(totalCount: number): Promise<boolean> | boolean;
    /** 上限超過の失敗通知（importFolderTooMany） */
    notifyLimitExceeded(error: 'too_many' | 'too_deep'): void;
    /** 個別失敗の集計通知（importFolderSkipped）。skipped > 0 のときだけ呼ぶ */
    notifySkipped(skipped: number): void;
    pageDir: string;
    imageDir: string;
    fileDir: string;
    outDir: string;
    /** 既定は既存 core そのまま（新規コピー/衝突ロジックを書かない）。unit が spy を差すために注入可 */
    importMd?(items: ImportMdItem[], pageDir: string, imageDir: string, options?: ImportMdOptions): ImportedMdFile[];
    importFile?(items: ImportFileItem[], fileDir: string, outDir: string): ImportedFile[];
    limits?: { maxFiles?: number; maxDepth?: number; confirmThreshold?: number };
    /**
     * FR-OIF-08（TASK-44）: 取り込んだ実体の台帳（元絶対パス → 取込先）。
     * **呼び出し側が渡した場合は記録だけ行い、リンク張り替えパスは走らせない**（複数 root を 1 回で
     * 張り替える `runSendToOutliner` 用）。未指定なら自前の台帳で取込完了後に 1 回張り替える。
     */
    importedMap?: ImportedMap;
}

/** FR-OIF-08: 同じ取り込みで note に入った実体 1 件（元絶対パス → 取込先）。 */
export type ImportedEntry =
    | { kind: 'md'; pageId: string; srcDir: string }     // pages/<pageId>.md（srcDir = 元 md の dir。プレーン file リンクの解決基準）
    | { kind: 'file'; filePath: string }                  // outDir 相対（importFilesCore の契約）
    // TASK-48（reviewer iteration 5 DSN-16）: closure 複製 subpage（`[[ ]]` でエンジンが pages/ へ元名で複製した md）。
    // 元 dir を持たせて、その page 自身のプレーン file リンクも解決基準②で張り替えられるようにする
    | { kind: 'subpage'; srcDir: string; name: string };
export type ImportedMap = Map<string, ImportedEntry>;

/** pageDir 直下の md ファイル名集合（dir 不在 = 空）。取込前後の差分で「この取り込みが書いた page」を特定する。 */
function listMdNames(dir: string): Set<string> {
    try { return new Set(fs.readdirSync(dir).filter((n) => /\.md$/i.test(n))); } catch { return new Set(); }
}
function addedMdNames(dir: string, before: Set<string>): string[] {
    return [...listMdNames(dir)].filter((n) => !before.has(n)).sort();
}

/**
 * FR-OIF-08（design §5-6 / ADRL-0110）: 取り込んだ実体へのプレーンリンクを取込後の位置へ張り替える**後段パス**。
 *
 * 随伴転送エンジンの既定（ADRL-0078: 参照リンクは複製しない）は、プレーン md リンクを「元位置への相対パス」に
 * 書き換え、プレーン file リンクは触らない。Import folder ではリンク先自身も同じ操作で note に入るので、
 * 取り込み完了後に 1 パスで `pages/<pageId>.md` / `files/<name>` へ張り替える。
 *
 * - `pageNames` = この取り込みが pageDir に書いた md（node page + closure 複製）。他の page は触らない
 * - url の解決基準は 2 つ試す: ① pageDir 基準（エンジンが md リンクを dest 相対に書き換えた後の形）
 *   ② 元 md の dir 基準（プレーン file リンクはエンジンが触らず元相対のまま）。どちらかが `importedMap` に
 *   当たれば張り替える。当たらない参照先（同じ取り込みに含まれない）は**触らない**（エンジンの既定に従う）
 * - **whole-link-target 置換**（`applyLinkUrlRewrites`）で部分文字列の誤置換をしない
 * - **失敗系（page 単位独立・rollback なし）**: 1 page の書き込み失敗は `skipped` に数えて他 page を続行する。
 *   実体は既に複製済みなのでデータロスは無く、当該 page のリンクだけがエンジン既定のまま残る（FR-OIF-08 受容事項）
 *
 * @returns rewritten = 書き換えた page 数 / skipped = 書き込めなかった page 数（FR-OIF-04 の集計通知に合流させる）
 */
export function rewriteImportedPlainLinks(
    pageDir: string,
    importedMap: ImportedMap,
    pageNames: string[],
    outDir?: string
): { rewritten: number; skipped: number } {
    const res = { rewritten: 0, skipped: 0 };
    if (importedMap.size === 0 || pageNames.length === 0) { return res; }
    const baseOut = outDir ?? path.dirname(pageDir);
    // page 名 → 元 md の dir（プレーン file リンクの解決基準②）。node page は `<pageId>.md`、closure 複製 subpage は元名
    //（エンジンの uniquify で `name-N.md` になった場合は `-N` を落として引く = best-effort）
    const srcDirByPage = new Map<string, string>();
    for (const v of importedMap.values()) {
        if (v.kind === 'md') { srcDirByPage.set(`${v.pageId}.md`, v.srcDir); }
        else if (v.kind === 'subpage') { if (!srcDirByPage.has(v.name)) { srcDirByPage.set(v.name, v.srcDir); } }
    }
    const srcDirOf = (name: string): string | undefined =>
        srcDirByPage.get(name) ?? srcDirByPage.get(name.replace(/-\d+(\.md)$/i, '$1'));
    /** 取込先の絶対パス。subpage 複製は元名で pages/ に居るはず（uniquify されて無ければ張り替え対象外 = null） */
    const destOf = (e: ImportedEntry): string | null => {
        if (e.kind === 'md') { return path.join(pageDir, `${e.pageId}.md`); }
        if (e.kind === 'file') { return path.resolve(baseOut, e.filePath); }
        const cand = path.join(pageDir, e.name);
        return fs.existsSync(cand) ? cand : null;
    };

    for (const name of pageNames) {
        const pageAbs = path.join(pageDir, name);
        let body: string;
        try { body = fs.readFileSync(pageAbs, 'utf8'); } catch { res.skipped++; continue; }
        const srcDir = srcDirOf(name);
        const toks = mdLinkParser.parseMarkdownLinks(body) as Array<{ kind: string; url: string }>;
        const renames = new Map<string, string>();
        for (const t of toks) {
            if (t.kind !== 'link') { continue; }   // 画像はエンジンが dest へ複製済み（対象外）
            // 正規化は共有ヘルパ normalizeMdLinkKeys に一本化（trim → <> strip → title strip → ?# 除去 → [raw, decoded]）—
            // 第 6 の正規化実装を書かない（reviewer iteration 5 QUAL5-1）。renames のキーは keys[0]（title strip 済み）。
            // applyLinkUrlRewrites 側は raw 正規化 `norm`（title を含む）で外れたとき同ヘルパの候補で再照合する
            // （TASK-51 / reviewer iteration 6 QUAL6-1 — 片側正規化の回帰を consumer 側の additive 変更で吸収）
            const keys = normalizeMdLinkKeys(t.url || '');
            const key = keys[0];
            if (!key || key.startsWith('#')) { continue; }
            if (/^(https?:|data:|file:|fractal:|mailto:)/i.test(key)) { continue; }
            let hit: ImportedEntry | undefined;
            for (const k of keys) {
                if (path.isAbsolute(k) || /^[a-zA-Z]:[/\\]/.test(k)) { continue; }   // 絶対パスは触らない（NFR-DCP-01）
                const cands = [path.resolve(pageDir, k)];
                if (srcDir) { cands.push(path.resolve(srcDir, k)); }
                for (const c of cands) { hit = importedMap.get(c); if (hit) { break; } }
                if (hit) { break; }
            }
            if (!hit) { continue; }
            const dest = destOf(hit);
            if (!dest) { continue; }
            const newRel = path.relative(pageDir, dest).split(path.sep).join('/');
            if (newRel && newRel !== key) { renames.set(key, newRel); }
        }
        if (renames.size === 0) { continue; }
        const next = applyLinkUrlRewrites(body, renames);
        if (next === body) { continue; }
        try {
            fs.writeFileSync(pageAbs, next, 'utf8');
            res.rewritten++;
        } catch (e) {
            // page 単位で skip（他 page は続行・rollback なし）。集計は呼び出し側の skipped に合流する
            res.skipped++;
            console.warn('[Outliner] import: link rewrite skipped (write failed):', pageAbs, e);
        }
    }
    return res;
}

/** FR-MSEL-02/04 / NFR-MSEL-02 (§4-3b): batch 実行前の件数ゲートの判定結果。 */
export type BatchLimitVerdict = 'ok' | 'abort' | 'cancel';

/**
 * FR-MSEL-02/04 / NFR-MSEL-02 (§4-3b): **複数選択 D&D の件数上限**。
 *
 * 🔴 **FR-OIF-03 と同一の定数・同一の閾値を使う共有関数**（第 3 の上限実装を書かない）。
 * `runFolderImport` の判定（`walked.totalCount > threshold` → `confirmLarge`）と
 * ここが `FOLDER_IMPORT_MAX_FILES` / `FOLDER_IMPORT_CONFIRM_THRESHOLD` を共有する。
 *
 * | 件数 | 戻り値 | 呼び出し側の責務 |
 * |---|---|---|
 * | ≤ 200 | `'ok'` | そのまま実行 |
 * | 201〜2000 | `confirmLarge` の結果次第で `'ok'` / `'cancel'` | `'cancel'` は **0 件処理** |
 * | > 2000 | `'abort'`（`notifyLimitExceeded('too_many')` 済み） | **0 件処理** |
 *
 * ⚠️ **「深さ 20」（`maxDepth`）は適用しない** — 複数選択はフラットな行集合で階層の概念が無い
 * （`FOLDER_IMPORT_MAX_DEPTH` は `walkFolderForImport` の再帰専用）。
 */
export async function checkBatchLimit(
    count: number,
    deps: {
        confirmLarge(totalCount: number): Promise<boolean> | boolean;
        notifyLimitExceeded(error: 'too_many' | 'too_deep'): void;
        limits?: { maxFiles?: number; confirmThreshold?: number };
    }
): Promise<BatchLimitVerdict> {
    const maxFiles = deps.limits?.maxFiles ?? FOLDER_IMPORT_MAX_FILES;
    const threshold = deps.limits?.confirmThreshold ?? FOLDER_IMPORT_CONFIRM_THRESHOLD;
    if (count > maxFiles) {
        deps.notifyLimitExceeded('too_many');
        return 'abort';
    }
    if (count > threshold && !(await deps.confirmLarge(count))) {
        return 'cancel';
    }
    return 'ok';
}

export interface FolderImportOutcome {
    status: 'cancelled' | 'declined' | 'aborted' | 'imported';
    error?: 'too_many' | 'too_deep';
    entries: FolderImportResultEntry[];
    skipped: number;
}

/**
 * フォルダ選択 → 列挙 → 確認 → コピー を通す host 側オーケストレーション。
 * VS Code 依存（dialog / modal / 通知）は deps 注入。webview への 1 message 送信は呼び出し側
 * （status==='imported' のときだけ entries/skipped を post する）。
 *
 * - キャンセル: walk もコピーも通知も 0（FR-OIF-04・TC-OIF-08）
 * - 上限超過: 失敗通知 1 回・コピー 0 = 原状不変（部分取り込みしない — FR-OIF-03・TC-OIF-07）
 * - 個別失敗（読取/書込）: skip して他を続行し、件数を集計通知（FR-OIF-04・TC-OIF-03）
 */
export async function runFolderImport(deps: FolderImportDeps): Promise<FolderImportOutcome> {
    const rootAbs = await deps.pickFolder();
    if (!rootAbs) { return { status: 'cancelled', entries: [], skipped: 0 }; }

    const walked = walkFolderForImport(rootAbs, deps.limits);
    if (!walked.ok) {
        deps.notifyLimitExceeded(walked.error);
        return { status: 'aborted', error: walked.error, entries: [], skipped: 0 };
    }

    const threshold = deps.limits?.confirmThreshold ?? FOLDER_IMPORT_CONFIRM_THRESHOLD;
    if (walked.totalCount > threshold && !(await deps.confirmLarge(walked.totalCount))) {
        return { status: 'declined', entries: [], skipped: 0 };
    }

    const importMd = deps.importMd ?? importMdFilesCore;
    const importFile = deps.importFile ?? importFilesCore;
    // 列挙段階で中身を落とした dir も skip 件数に含める（部分成功を silent にしない — reviewer SECGOV-1）
    let skipped = walked.unreadableDirs;

    const warnSkipped = (absPath: string, reason: unknown): void => {
        console.warn('[Outliner] folder import: entry skipped:', absPath, reason);
    };

    // 走査順に 1 エントリずつコピー（個別失敗を skip に縮退させるため core 呼び出しも 1 件単位。
    // files/ の連番 uniquify は core 内蔵規則が逐次で効く — 新規衝突ロジックを書かない）
    // FR-OIF-05/06/07: md 本文が参照する実体（画像 / 📎 / [[ ]] subpage）の closure（rev2 = エンジンの複製集合と同一 / ADRL-0110）。
    // closure の実体は **node を作らず、ここでも個別コピーしない** — コピーとリンク書換は
    // md 側の随伴（markdown-import の copyMdPasteAssets 経路）が担う。
    // 二重コピーを避けるのと、files//images/ の folder node を作らないための 2 つが目的。
    const closure = computeMdClosure(walked.entries, rootAbs);

    // FR-OIF-08（TASK-44）: 取り込んだ実体の台帳（元絶対パス → 取込先）。呼び出し側が渡せば記録のみ（張り替えは呼び出し側が 1 回）
    const importedMap: ImportedMap = deps.importedMap ?? new Map();
    const pagesBefore = listMdNames(deps.pageDir);
    // TASK-48（DSN-16）: closure 複製 subpage（node にならない md）も元 dir を台帳に持つ —
    // その page 自身のプレーン file リンクを rewriteImportedPlainLinks が元 dir 基準で解決できるようにする
    for (const abs of closure) {
        if (/\.md$/i.test(abs) && !importedMap.has(path.resolve(abs))) {
            importedMap.set(path.resolve(abs), { kind: 'subpage', srcDir: path.dirname(abs), name: path.basename(abs) });
        }
    }

    const copyEntries = (entries: FolderImportEntry[]): FolderImportResultEntry[] => {
        const out: FolderImportResultEntry[] = [];
        for (const e of entries) {
            if (e.kind === 'dir') {
                // FR-OIF-07: 配下（再帰）に closure 外の実体が 1 件も無い dir は node にしない。
                // 「直下だけ見る」判定にすると中間 dir が消えて孫が root へ浮く。
                if (!hasNonClosureDescendant(e, closure)) { continue; }
                out.push({ kind: 'dir', name: e.name, children: copyEntries(e.children) });
                continue;
            }
            // FR-OIF-05: closure に入る実体は node 化しない（md の随伴が実体を運ぶ）
            if (closure.has(path.resolve(e.absPath))) { continue; }
            try {
                if (e.kind === 'md') {
                    // core は content 文字列を取る（相対画像は sourceDir 起点で解決される）
                    const item: ImportMdItem = {
                        name: e.name,
                        content: fs.readFileSync(e.absPath, 'utf8'),
                        sourceDir: path.dirname(e.absPath),
                    };
                    // FR-OIF-06: fileDir + restrictSourceRoots を渡して随伴転送の正典に載せる
                    // （📎/subpage も複製 + リンク書換・containment は importRoot 配下に限定）
                    const [imported] = importMd([item], deps.pageDir, deps.imageDir, {
                        fileDir: deps.fileDir,
                        restrictSourceRoots: [rootAbs],
                    });
                    // 現行 core は 1 要素なら「throw か 1 件返す」の二択だが、空返しを取り込まないための契約ガード
                    if (!imported) { skipped++; warnSkipped(e.absPath, 'importMd returned no result'); continue; }
                    importedMap.set(path.resolve(e.absPath), { kind: 'md', pageId: imported.pageId, srcDir: path.dirname(e.absPath) });
                    out.push({ kind: 'md', name: e.name, pageId: imported.pageId });
                } else {
                    const item: ImportFileItem = { name: e.name, buffer: fs.readFileSync(e.absPath) };
                    const [imported] = importFile([item], deps.fileDir, deps.outDir);
                    if (!imported) { skipped++; warnSkipped(e.absPath, 'importFile returned no result'); continue; }
                    importedMap.set(path.resolve(e.absPath), { kind: 'file', filePath: imported.filePath });
                    out.push({ kind: 'file', name: e.name, filePath: imported.filePath });
                }
            } catch (err) {
                // 読取不能 / 書込失敗の 1 件は skip して他を続行（FR-OIF-04）。
                // 通知は件数のみなので、どのファイルが何で落ちたかはログに残す（silent 握り禁止）
                skipped++;
                warnSkipped(e.absPath, err);
            }
        }
        return out;
    };

    const copied = copyEntries(walked.entries);
    // 仕様変更 2026-08-29（ユーザー裁定）: **選んだフォルダ自身も node にする**（中身だけ並ぶと
    // どのフォルダを取り込んだのか分からないため）。webview 側は dir entry を通常 node + 子再帰で
    // 扱うので、既存 applyFolderImportResult の変更は不要。
    const rootName = path.basename(rootAbs) || rootAbs;
    const resultEntries: FolderImportResultEntry[] = [{ kind: 'dir', name: rootName, children: copied }];
    // FR-OIF-08: 取込完了後に 1 パスで張り替え（呼び出し側が台帳を渡した場合はそちらが 1 回まとめて行う）
    if (!deps.importedMap) {
        const rw = rewriteImportedPlainLinks(deps.pageDir, importedMap, addedMdNames(deps.pageDir, pagesBefore), deps.outDir);
        skipped += rw.skipped;
    }
    if (skipped > 0) { deps.notifySkipped(skipped); }
    return { status: 'imported', entries: resultEntries, skipped };
}

/**
 * FR-SND-01/02 (§6-1): 「Outliner に送る」— **複数のファイル / フォルダ**を 1 操作で取り込む。
 *
 * 🔴 **Import folder（`runFolderImport`）と同一経路を通す**（closure 抑止 / 随伴転送 / uniquify を
 * 二重実装しない = FR-OIF-05..07 をそのまま継承）。root ごとに `runFolderImport` を
 * `pickFolder: () => root` で呼び、`entries` を**選択順に連結**するだけ。
 *
 * - **フォルダ**: `walkFolderForImport` の再帰列挙 + **選んだフォルダ自身も dir node で包む**
 *   （`runFolderImport` の 2026-08-29 裁定をそのまま継承）
 * - **ファイル**: その 1 件だけを取り込む（親フォルダの node は作らない）。
 *   実装は「親 dir を root にした `runFolderImport` の結果から当該 1 件を抜く」ではなく、
 *   `singleFileRoots` として **親 dir を root に walk し、当該ファイル以外を落とす**方式にすると
 *   closure 判定が親 dir 全体を見てしまうため、**ファイルは専用の 1 件経路**で処理する。
 *
 * 件数上限（FR-OIF-03 / NFR-MSEL-02）は **root の総数ではなく取り込む実体の総数**で見るため、
 * 各 root の `runFolderImport` が持つ既存ゲートに委ねる（第 3 の上限実装を書かない）。
 */
export async function runSendToOutliner(deps: Omit<FolderImportDeps, 'pickFolder'> & {
    /** 取り込む対象の絶対パス（選択順）。dir / file が混在してよい */
    roots: string[];
}): Promise<FolderImportOutcome> {
    const all: FolderImportResultEntry[] = [];
    let skipped = 0;
    let aborted: 'too_many' | 'too_deep' | undefined;

    // ── FR-MSEL-02 / NFR-MSEL-02 (TASK-36 / reviewer iteration 2 QUAL2-1): 件数ゲートは **全 root の合計**で 1 回 ──
    //
    // 🔴 root ごとに `runFolderImport` を呼ぶと**各 root の件数でしか閾値判定されない**ため、
    // 合計が閾値を跨いでも素通りする（実測: 3 root × 150 件 = 450 件が確認 modal なしで取り込まれた）。
    // 逆方向（`runFolderExport`）は `countEntries(tree)` で全体合算しているので、そこに揃える。
    //
    // 合計を数えるために dir ごとに `walkFolderForImport` を 1 度余分に走らせる（受容事項）。
    // 上限が 2000 件なので許容範囲（Import folder も同じ walk を 1 度している）。
    let totalCount = 0;
    for (const rootAbs of deps.roots) {
        let stat0: fs.Stats;
        try { stat0 = fs.statSync(rootAbs); } catch { continue; }
        if (stat0.isDirectory()) {
            const walked0 = walkFolderForImport(rootAbs, deps.limits);
            if (!walked0.ok) {
                // 単一 root で列挙が破綻した場合は従来どおり即中断（合計を数える意味が無い）
                deps.notifyLimitExceeded(walked0.error);
                return { status: 'aborted', error: walked0.error, entries: [], skipped: 0 };
            }
            totalCount += walked0.totalCount;
        } else {
            totalCount += 1;
        }
    }
    const gate = await checkBatchLimit(totalCount, deps);
    if (gate === 'abort') { return { status: 'aborted', error: 'too_many', entries: [], skipped: 0 }; }
    if (gate === 'cancel') { return { status: 'declined', entries: [], skipped: 0 }; }

    // FR-OIF-08（TASK-44）: 全 root 共通の台帳。root を跨いだプレーンリンクも 1 パスで張り替える
    const importedMap: ImportedMap = new Map();
    const pagesBefore = listMdNames(deps.pageDir);

    for (const rootAbs of deps.roots) {
        let stat: fs.Stats;
        try { stat = fs.statSync(rootAbs); } catch { skipped++; continue; }

        if (stat.isDirectory()) {
            // ★ Import folder と完全に同じ経路（closure 抑止 / 随伴 / uniquify を継承）
            const outcome = await runFolderImport(Object.assign({}, deps, {
                pickFolder: () => rootAbs,
                // NFR-MSEL-03: 通知は root ごとではなく **全体で 1 回**。内側の通知はすべて抑止し、
                // 集計 / 上限は上の合計ゲートと下の 1 箇所からだけ出す。
                // 🔴 `confirmLarge` も抑止する（reviewer iteration 2 QUAL2-1: これを残すと
                // 各 root が 200 件超のときに **root ごとに modal** が出る = 「全体で 1 回」の主張と矛盾）。
                notifySkipped: () => { /* 集計は呼び出し側で 1 回 */ },
                notifyLimitExceeded: () => { /* 上限も呼び出し側で 1 回 */ },
                confirmLarge: () => true,   // 合計ゲートで既に確認済み
                importedMap,                // 記録のみ（張り替えは下で 1 回）
            }));
            if (outcome.status === 'aborted') { aborted = outcome.error; break; }
            if (outcome.status !== 'imported') { continue; }
            all.push(...outcome.entries);
            skipped += outcome.skipped;
            continue;
        }

        // ── ファイル 1 件 ──
        // 親 dir を root にすると closure が親 dir 全体を見てしまうので、
        // **その 1 件だけ**を entry にして既存 core（importMd / importFile）へ渡す。
        const name = path.basename(rootAbs);
        try {
            if (/\.md$/i.test(name)) {
                const importMd = deps.importMd ?? importMdFilesCore;
                const [imported] = importMd([{
                    name,
                    content: fs.readFileSync(rootAbs, 'utf8'),
                    sourceDir: path.dirname(rootAbs),
                }], deps.pageDir, deps.imageDir, {
                    fileDir: deps.fileDir,
                    // containment: その md の隣接資産だけを許す（親 dir 全体を開かない）
                    restrictSourceRoots: [path.dirname(rootAbs)],
                });
                if (!imported) { skipped++; continue; }
                importedMap.set(path.resolve(rootAbs), { kind: 'md', pageId: imported.pageId, srcDir: path.dirname(rootAbs) });
                all.push({ kind: 'md', name, pageId: imported.pageId });
            } else {
                const importFile = deps.importFile ?? importFilesCore;
                const [imported] = importFile([{ name, buffer: fs.readFileSync(rootAbs) }], deps.fileDir, deps.outDir);
                if (!imported) { skipped++; continue; }
                importedMap.set(path.resolve(rootAbs), { kind: 'file', filePath: imported.filePath });
                all.push({ kind: 'file', name, filePath: imported.filePath });
            }
        } catch (e) {
            skipped++;
            console.warn('[Outliner] send to outliner: entry skipped:', rootAbs, e);
        }
    }

    if (aborted) {
        deps.notifyLimitExceeded(aborted);
        return { status: 'aborted', error: aborted, entries: [], skipped: 0 };
    }
    // FR-OIF-08: 全 root 完了後に 1 回（root を跨いだリンクも解決できる）。失敗 page は skipped に合流
    const rw = rewriteImportedPlainLinks(deps.pageDir, importedMap, addedMdNames(deps.pageDir, pagesBefore), deps.outDir);
    skipped += rw.skipped;
    if (skipped > 0) { deps.notifySkipped(skipped); }   // NFR-MSEL-03: 集計通知 1 回
    return { status: 'imported', entries: all, skipped };
}

// ────────────────────────────────────────────
// FR-SND-02 rev2（2026-09-04 手動テスト (2)）: 送り先 `.out` を選べるようになったため、
// 選んだ `.out` が**メインペインで開いていない**ときは webview（applySendToOutlinerResult）に頼れない。
// host が .out JSON を直接更新する経路（notesImportMdIntoOut / treeFileImportIntoOut と同じ契約）。
// ────────────────────────────────────────────

/** outliner-model.js と一致する node 構造（notesImportMdIntoOut の newNode と同形） */
export interface OutDataNodeLike {
    id: string;
    parentId: string | null;
    children: string[];
    text: string;
    tags: string[];
    isPage: boolean;
    pageId: string | null;
    collapsed: boolean;
    checked: boolean | null;
    subtext: string;
    images: string[];
    filePath: string | null;
}

export interface OutDataLike {
    nodes?: Record<string, OutDataNodeLike>;
    rootIds?: string[];
    [k: string]: unknown;
}

function newOutNodeId(): string {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 取り込み結果 entries を `.out` データの **root 先頭に選択順**で挿入する（webview `applySendToOutlinerResult` の host 版）。
 *
 * 🔴 webview 版と**同じ写像**を守る（reviewer QUAL2-1b の同型集合）:
 *   - dir  → 通常 node（text = フォルダ名）+ children を再帰で子に積む
 *   - md   → page node（isPage / pageId・text = 拡張子を落としたファイル名）
 *   - file → file 添付 node（filePath・text = ファイル名）
 *   - 1 件目 = 先頭 / 2 件目以降 = 直前の後ろ（`unshift` を N 回すると順序が反転する — TC-SND-01 と同じ落とし穴）
 *
 * @returns 作った node 数（dir を含む）。entries が空なら 0 で outData は不変
 */
export function prependImportEntriesToOutData(outData: OutDataLike, entries: FolderImportResultEntry[]): number {
    outData.nodes = outData.nodes || {};
    outData.rootIds = outData.rootIds || [];
    const nodes = outData.nodes;
    let made = 0;
    const build = (e: FolderImportResultEntry, parentId: string | null): string => {
        const id = newOutNodeId();
        const text = e.kind === 'md' ? String(e.name || '').replace(/\.md$/i, '') : String(e.name || '');
        const node: OutDataNodeLike = {
            id, parentId, children: [], text, tags: [],
            isPage: e.kind === 'md', pageId: e.kind === 'md' ? e.pageId : null,
            collapsed: false, checked: null, subtext: '', images: [],
            filePath: e.kind === 'file' ? e.filePath : null,
        };
        nodes[id] = node;
        made++;
        if (e.kind === 'dir') {
            for (const c of e.children || []) { node.children.push(build(c, id)); }
        }
        return id;
    };
    const topIds: string[] = [];
    for (const e of entries || []) {
        if (!e || !e.kind) { continue; }
        topIds.push(build(e, null));
    }
    // 選択順のまま**まとめて**先頭へ（1 件ずつ unshift すると反転する）
    outData.rootIds.unshift(...topIds);
    return made;
}
