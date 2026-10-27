/**
 * runtime.ts — 書き込み系 tool の共通の実行枠。
 *
 * - 1 本ずつ（serialized）・tmp + rename（withAtomicWrites）で実行する
 * - 実行の前後で Notes フォルダを走査し、変わった / できた / ゴミ箱へ移したファイルを返す（JSON の changed / created / trashed）
 * - destructive な操作は、その操作で新たに孤児になった実体（cleanup-core の判定）をゴミ箱へ移す
 *   （UI の Cleanup と MCP の doctor が「孤児 0」で一致する状態を保つ — AC-2）
 * - dryRun は Notes フォルダの写し（md / .out / outline.note は中身ごと、画像・添付は空の同名ファイル）の上で
 *   同じ処理を走らせ、何が変わるかだけを返す（本物には触らない）
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotesFileManager } from '../../../src/shared/notes-file-manager';
import { scanSingleNoteCore } from '../../../src/shared/cleanup-core';
import { ToolError, hashOfFile, serialized, withAtomicWrites } from './guard';
import { moveToOsTrash, requireTrash, trashBackend } from './trash';

const META_EXT = new Set(['.out', '.md', '.markdown', '.note', '.json']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_ENTRIES = 50_000;

interface Snapshot { meta: Map<string, string | null>; other: Set<string> }

function walk(root: string, onFile: (abs: string) => void): void {
    let count = 0;
    const rec = (dir: string) => {
        let ents: fs.Dirent[];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (++count > MAX_ENTRIES) { throw new ToolError('INVALID', `Notes フォルダのファイルが多すぎます（${MAX_ENTRIES} 件超）: ${root}`); }
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { rec(abs); } } else if (e.isFile()) { onFile(abs); }
        }
    };
    rec(root);
}

function isMeta(abs: string): boolean {
    return META_EXT.has(path.extname(abs).toLowerCase()) || path.basename(abs) === 'outline.note';
}

function snapshot(roots: string[]): Snapshot {
    const meta = new Map<string, string | null>();
    const other = new Set<string>();
    for (const r of roots) {
        walk(r, (abs) => {
            if (path.basename(abs).includes('.fractal-tmp-')) { return; }
            if (isMeta(abs)) { meta.set(abs, hashOfFile(abs)); } else { other.add(abs); }
        });
    }
    return { meta, other };
}

export interface FileChange { absPath: string; contentHash: string | null }
export interface Changes { changed: FileChange[]; created: FileChange[]; removed: string[] }

function diff(a: Snapshot, b: Snapshot, trashed: Set<string>): Changes {
    const changed: FileChange[] = [];
    const created: FileChange[] = [];
    const removed: string[] = [];
    for (const [p, h] of b.meta) {
        if (!a.meta.has(p)) { created.push({ absPath: p, contentHash: h }); } else if (a.meta.get(p) !== h) { changed.push({ absPath: p, contentHash: h }); }
    }
    for (const p of b.other) { if (!a.other.has(p)) { created.push({ absPath: p, contentHash: null }); } }
    for (const p of a.meta.keys()) { if (!b.meta.has(p) && !trashed.has(p)) { removed.push(p); } }
    for (const p of a.other) { if (!b.other.has(p) && !trashed.has(p)) { removed.push(p); } }
    const byPath = (x: FileChange, y: FileChange) => x.absPath.localeCompare(y.absPath);
    return { changed: changed.sort(byPath), created: created.sort(byPath), removed: removed.sort() };
}

async function orphanPaths(root: string): Promise<Set<string>> {
    try {
        return new Set((await scanSingleNoteCore(root)).map((c) => path.resolve(c.absPath)));
    } catch {
        return new Set();
    }
}

export interface WriteCtx {
    dryRun: boolean;
    /** ゴミ箱へ移す（dryRun では写しの上で消して記録だけ） */
    trash(absPath: string): Promise<void>;
    /** 引数のパス（本物）→ 実際に操作するパス（dryRun では写し） */
    p(absPath: string): string;
}

export interface WriteOutcome<T> {
    result: T;
    changes: Changes;
    trashed: string[];
    dryRun: boolean;
}

/** 失敗の後片付け: この操作で作られて空になった images/ files/ を消す（前からあった dir は残す） */
const ASSET_SUBS = ['images', 'files'];
function existingSubs(root: string): Set<string> {
    return new Set(ASSET_SUBS.filter((sub) => fs.existsSync(path.join(root, sub))));
}
function removeEmptyNewDirs(root: string, had: Set<string>): void {
    for (const sub of ASSET_SUBS) {
        const d = path.join(root, sub);
        try {
            if (!had.has(sub) && fs.existsSync(d) && fs.readdirSync(d).length === 0) { fs.rmdirSync(d); }
        } catch { /* 無視 */ }
    }
}

/** 写しを作る: md / .out / outline.note / .json は中身ごと、それ以外は空の同名ファイル */
function makeSandbox(roots: string[]): Map<string, string> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-dryrun-'));
    const map = new Map<string, string>();
    roots.forEach((r, i) => {
        const dst = path.join(base, String(i), path.basename(r));
        fs.mkdirSync(dst, { recursive: true });
        walk(r, (abs) => {
            const rel = path.relative(r, abs);
            const to = path.join(dst, rel);
            fs.mkdirSync(path.dirname(to), { recursive: true });
            if (isMeta(abs)) { fs.copyFileSync(abs, to); } else { fs.writeFileSync(to, ''); }
        });
        map.set(path.resolve(r), dst);
    });
    return map;
}

function mapper(map: Map<string, string>, reverse: boolean): (p: string) => string {
    const pairs = [...map.entries()].map(([a, b]) => (reverse ? [b, a] : [a, b]) as [string, string])
        .sort((x, y) => y[0].length - x[0].length);
    return (p: string) => {
        const abs = path.resolve(p);
        for (const [from, to] of pairs) {
            if (abs === from || abs.startsWith(from + path.sep)) { return to + abs.slice(from.length); }
        }
        return p;
    };
}

function mapDeep(v: unknown, f: (s: string) => string): unknown {
    if (typeof v === 'string') { return path.isAbsolute(v) ? f(v) : v; }
    if (Array.isArray(v)) { return v.map((x) => mapDeep(x, f)); }
    if (v && typeof v === 'object') {
        const o: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) { o[k] = mapDeep(x, f); }
        return o;
    }
    return v;
}

/**
 * 書き込み系 tool の実行枠。
 * @param roots      触る Notes フォルダ（別 note への移動なら 2 つ）
 * @param destructive true なら、その操作で新たに孤児になった実体をゴミ箱へ移す（ゴミ箱が無ければ書く前に拒否）
 * @param args       実処理に渡す引数。中の絶対パス（Notes フォルダの中のもの）は dryRun では写しのパスに置き換えて渡す
 * @param fn         実処理。args 以外から作るパスは ctx.p() を通す（dryRun で写しに向けるため）
 */
export function runWrite<A, T>(
    opts: { roots: string[]; dryRun?: boolean; destructive?: boolean },
    args: A,
    fn: (a: A, ctx: WriteCtx) => Promise<T> | T,
): Promise<WriteOutcome<T>> {
    return serialized(async () => {
        const roots = [...new Set(opts.roots.map((r) => path.resolve(r)))];
        const dryRun = !!opts.dryRun;
        const trashedReal = new Set<string>();
        let toReal: (p: string) => string = (p) => p;
        let toWork: (p: string) => string = (p) => p;
        let workRoots = roots;
        let sandboxBase: string | null = null;
        if (dryRun) {
            const map = makeSandbox(roots);
            sandboxBase = path.dirname(path.dirname([...map.values()][0]));
            toWork = mapper(map, false);
            toReal = mapper(map, true);
            workRoots = roots.map((r) => map.get(r)!);
        } else if (opts.destructive) {
            requireTrash(); // 書き始める前に、消すための手段があるかを確かめる（無ければ何も書かない）
        }
        const ctx: WriteCtx = {
            dryRun,
            p: toWork,
            trash: async (absPath: string) => {
                if (!fs.existsSync(absPath)) { return; }
                if (dryRun) { fs.rmSync(absPath, { recursive: true, force: true }); } else { await moveToOsTrash(absPath); }
                trashedReal.add(path.resolve(toReal(absPath)));
            },
        };
        const prevTrash = NotesFileManager.trashImpl;
        NotesFileManager.trashImpl = async (absPath) => { await ctx.trash(absPath); };
        try {
            const before = snapshot(workRoots);
            const subsBefore = workRoots.map(existingSubs);
            const orphansBefore = opts.destructive ? await Promise.all(workRoots.map(orphanPaths)) : [];
            const run = async () => {
                const r = await fn(mapDeep(args, toWork) as A, ctx);
                if (opts.destructive) {
                    // この操作で新たに孤児になった実体（page md / 画像 / 添付 / subpage）をゴミ箱へ（既存の孤児は触らない）
                    for (let i = 0; i < workRoots.length; i++) {
                        const after = await orphanPaths(workRoots[i]);
                        for (const p of after) { if (!orphansBefore[i].has(p)) { await ctx.trash(p); } }
                    }
                }
                return r;
            };
            let result: T;
            try {
                result = dryRun ? await run() : await withAtomicWrites(run);
            } catch (e) {
                // 途中で失敗したら、この操作で新しくできたファイル（コピーした画像・添付・page md）を消して
                // 孤児を残さない（監査 B-12）。前からあったファイルには触らない。書き換えは最後にまとめて
                // 1 回（tmp + rename）なので、失敗した時点の .out / md / outline.note は元のまま
                if (!dryRun) {
                    const now = snapshot(workRoots);
                    for (const p of [...now.meta.keys(), ...now.other]) {
                        if (!before.meta.has(p) && !before.other.has(p)) { try { fs.rmSync(p, { force: true }); } catch { /* 残っても次の doctor が拾う */ } }
                    }
                    workRoots.forEach((root, i) => removeEmptyNewDirs(root, subsBefore[i]));
                }
                throw e;
            }
            const after = snapshot(workRoots);
            const ch = diff(before, after, new Set([...trashedReal].map(toWork)));
            const changes: Changes = {
                changed: ch.changed.map((c) => ({ absPath: toReal(c.absPath), contentHash: c.contentHash })),
                created: ch.created.map((c) => ({ absPath: toReal(c.absPath), contentHash: c.contentHash })),
                removed: ch.removed.map(toReal),
            };
            return {
                result: (dryRun ? mapDeep(result, toReal) : result) as T,
                changes,
                trashed: [...trashedReal].sort(),
                dryRun,
            };
        } finally {
            NotesFileManager.trashImpl = prevTrash;
            if (sandboxBase) { try { fs.rmSync(sandboxBase, { recursive: true, force: true }); } catch { /* 片付け失敗は無視 */ } }
        }
    });
}

/** dryRun の返り値に付ける注意（本物で消すにはゴミ箱が要る） */
export function dryRunNote(destructive: boolean): Record<string, unknown> {
    const note: Record<string, unknown> = { dryRunNote: '書き込んでいません。Notes フォルダの写しで同じ処理を走らせた結果です（画像・添付は中身なしの同名ファイルで代用。新しく採番される nodeId / pageId / itemId は本番では別の値になります）。' };
    if (destructive && !trashBackend()) { note.trashWarning = 'この環境では OS のゴミ箱が使えないため、本番では TRASH_UNAVAILABLE で拒否されます。'; }
    return note;
}
