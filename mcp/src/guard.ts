/**
 * guard.ts — MCP の書き込みの安全装置（spec 20261027-1700-mcp-full-ops D3 / D4 / D6）
 *
 * - ToolError: 機械可読な code（CONFLICT / AMBIGUOUS / NOT_FOUND / OUTSIDE_NOTES / INVALID / TRASH_UNAVAILABLE）付きの失敗
 * - contentHash: get / resolve が返し、書き込み系が expectedHash で受ける楽観ロックの値
 * - 書き込みは tmp + rename（withAtomicWrites で正典 src/shared の fs.writeFileSync も同じにする）
 * - 書き込み先は Notes フォルダ（outline.note のあるフォルダ）の中だけ
 * - 書き込みは 1 本ずつ（mutex）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

export type ErrorCode = 'CONFLICT' | 'AMBIGUOUS' | 'NOT_FOUND' | 'OUTSIDE_NOTES' | 'INVALID' | 'TRASH_UNAVAILABLE' | 'FAILED';

export class ToolError extends Error {
    constructor(public code: ErrorCode, message: string, public details: Record<string, unknown> = {}) {
        super(message);
    }
}

// ─── hash ───────────────────────────────────────────

/** ファイルの内容の hash（sha256 の先頭 16 桁）。無いファイルは null */
export function hashOfFile(absPath: string): string | null {
    try {
        return hashOfBuffer(fs.readFileSync(absPath));
    } catch {
        return null;
    }
}

export function hashOfBuffer(buf: Buffer | string): string {
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * expectedHash があれば今の内容と比べ、違えば書かずに CONFLICT。
 * 無ければ「ロック無し」として通す（返り値の lock に出す）。
 */
export function checkExpectedHash(absPath: string, expectedHash: string | undefined, label = 'expectedHash'): 'checked' | 'none' {
    if (expectedHash === undefined || expectedHash === null || expectedHash === '') { return 'none'; }
    const current = hashOfFile(absPath);
    if (current !== expectedHash) {
        throw new ToolError('CONFLICT',
            `${path.basename(absPath)} は読んだあとに変わっています（${label}=${expectedHash} / 今=${current ?? '(ファイル無し)'}）。書き込んでいません。fractal_get で読み直してから、新しい contentHash を付けてやり直してください。`,
            { absPath, expectedHash, currentHash: current });
    }
    return 'checked';
}

export function lockNote(lock: 'checked' | 'none'): Record<string, unknown> {
    return lock === 'checked'
        ? { lock: 'expectedHash' }
        : { lock: 'none', lockWarning: 'expectedHash 無しで書きました（ロック無し）。読んでから書くまでに Fractal 側で変わっていても検出できません。次からは fractal_get / fractal_resolve の contentHash を expectedHash に付けてください。' };
}

// ─── atomic write ───────────────────────────────────

let tmpSeq = 0;
function tmpPathFor(absPath: string): string {
    return path.join(path.dirname(absPath), `.${path.basename(absPath)}.fractal-tmp-${process.pid}-${Date.now().toString(36)}-${(tmpSeq++).toString(36)}`);
}

/** tmp に書いてから rename（同じ dir なので原子的に置き換わる。途中で落ちても元ファイルは壊れない） */
export function atomicWriteFile(absPath: string, data: string | Uint8Array, encoding: BufferEncoding = 'utf8'): void {
    const tmp = tmpPathFor(absPath);
    try {
        if (typeof data === 'string') { fs.writeFileSync(tmp, data, encoding); } else { fs.writeFileSync(tmp, data); }
        fs.renameSync(tmp, absPath);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 無い */ }
        throw e;
    }
}

const fsCjs = createRequire(import.meta.url)('fs') as typeof fs;
const origWriteFileSync = fsCjs.writeFileSync;

/**
 * fn の間だけ、プロセス内の fs.writeFileSync を「tmp に書いてから rename」に差し替える。
 * 正典（src/shared の NotesFileManager / notes-ops-core）は fs.writeFileSync で直接書いているので、
 * MCP から呼ぶときもここを通せば同じ原子性になる（正典の関数は変えない = 拡張機能の挙動は不変）。
 * 文字列パスへの書き込みだけを対象にする（fd 等はそのまま）。
 */
export async function withAtomicWrites<T>(fn: () => Promise<T> | T): Promise<T> {
    const patched = function (file: fs.PathOrFileDescriptor, data: any, options?: any): void {
        if (typeof file !== 'string') { return origWriteFileSync(file, data, options); }
        const tmp = tmpPathFor(file);
        try {
            origWriteFileSync(tmp, data, options);
            fsCjs.renameSync(tmp, file);
        } catch (e) {
            try { fsCjs.unlinkSync(tmp); } catch { /* 無い */ }
            throw e;
        }
    } as typeof fs.writeFileSync;
    fsCjs.writeFileSync = patched;
    syncBuiltinESMExports();
    try {
        return await fn();
    } finally {
        fsCjs.writeFileSync = origWriteFileSync;
        syncBuiltinESMExports();
    }
}

// ─── 書き込みの直列化 ────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();
/** 書き込み系の tool は 1 本ずつ実行する（同じファイルへの並行書き込みと fs 差し替えの重なりを防ぐ） */
export function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
}

// ─── Notes フォルダの境界 ────────────────────────────

/** p から上へたどって outline.note のあるフォルダを返す（無ければ null） */
export function findNoteRoot(p: string): string | null {
    let dir = path.resolve(p);
    try { if (!fs.statSync(dir).isDirectory()) { dir = path.dirname(dir); } } catch { dir = path.dirname(dir); }
    for (let i = 0; i < 64; i++) {
        if (fs.existsSync(path.join(dir, 'outline.note'))) { return dir; }
        const up = path.dirname(dir);
        if (up === dir) { break; }
        dir = up;
    }
    return null;
}

/** 書き込み対象のファイル / フォルダから Notes フォルダを決める。outline.note が無ければ拒否 */
export function requireNoteRoot(p: string, what = '対象'): string {
    const abs = path.resolve(p);
    const root = findNoteRoot(abs);
    if (!root) {
        throw new ToolError('OUTSIDE_NOTES',
            `${what}（${abs}）は Fractal の Notes フォルダ（outline.note のあるフォルダ）の中にありません。書き込みは Notes フォルダの中だけです。fractal_list_folders で Notes フォルダを確かめてください。`,
            { absPath: abs });
    }
    return root;
}

function realOrResolved(p: string): string {
    // 既存の部分までは realpath（symlink で外へ出るのを防ぐ）、まだ無い末尾はそのまま足す
    let cur = path.resolve(p);
    const rest: string[] = [];
    for (let i = 0; i < 256; i++) {
        try {
            const real = fs.realpathSync(cur);
            return rest.length ? path.join(real, ...rest.reverse()) : real;
        } catch {
            const up = path.dirname(cur);
            if (up === cur) { return path.resolve(p); }
            rest.push(path.basename(cur));
            cur = up;
        }
    }
    return path.resolve(p);
}

/** absPath が root の中か（正規化 + realpath。`..` で外へ出るものは false） */
export function isInside(root: string, absPath: string): boolean {
    const r = realOrResolved(root);
    const t = realOrResolved(absPath);
    const rel = path.relative(r, t);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function assertInside(root: string, absPath: string, what = '書き込み先'): void {
    if (!isInside(root, absPath)) {
        throw new ToolError('OUTSIDE_NOTES',
            `${what}（${path.resolve(absPath)}）が Notes フォルダ（${root}）の外です。Notes フォルダの外へは書き込みません。`,
            { absPath: path.resolve(absPath), noteDir: root });
    }
}

/** 絶対パスを要求する（相対パスは cwd 依存で別の場所に書くので拒否） */
export function requireAbs(p: unknown, what: string): string {
    if (typeof p !== 'string' || !p) { throw new ToolError('INVALID', `${what} が必要です`); }
    if (!path.isAbsolute(p)) { throw new ToolError('INVALID', `${what} は絶対パスで指定してください（${p}）`); }
    return path.resolve(p);
}

export function requireFile(p: string, what: string, ext?: string): void {
    if (ext && !p.endsWith(ext)) { throw new ToolError('INVALID', `${what} は ${ext} ファイルを指定してください（${p}）`); }
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { throw new ToolError('NOT_FOUND', `${what} が見つかりません: ${p}`, { absPath: p }); }
    if (!st.isFile()) { throw new ToolError('INVALID', `${what} はファイルではありません: ${p}`); }
}

export function requireDir(p: string, what: string): void {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { throw new ToolError('NOT_FOUND', `${what} が見つかりません: ${p}`, { absPath: p }); }
    if (!st.isDirectory()) { throw new ToolError('INVALID', `${what} はフォルダではありません: ${p}`); }
}

/** 変更したファイルの { absPath, contentHash } を返す（無くなったファイルは contentHash: null） */
export function fileRefs(paths: Iterable<string>): { absPath: string; contentHash: string | null }[] {
    const seen = new Set<string>();
    const out: { absPath: string; contentHash: string | null }[] = [];
    for (const p of paths) {
        const abs = path.resolve(p);
        if (seen.has(abs)) { continue; }
        seen.add(abs);
        out.push({ absPath: abs, contentHash: hashOfFile(abs) });
    }
    return out;
}
