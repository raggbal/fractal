import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Notes 一覧ファイル（`<name>.fractal`）の形式・検証・読み書き
 * （spec 20261026-1555-fractal-notes-json D9 / D11、20261026-1845-fractal-file-views D1 / D3）。
 * vscode を import しない — NotesFolderProvider と単体テストが共有する。
 *
 * 形式: JSON { version: 1, notes: string[] }（notes は Note フォルダの絶対パス）。表示名はファイル名。
 * 読んだ未知のキーは書き戻しで保持する（rc.8 の *-fractal-notes.json の name / title もそのまま残る）。
 */

export const REGISTRY_VERSION = 1;
export const REGISTRY_EXT = '.fractal';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface NotesRegistryDoc {
    version: number;
    notes: string[];
    [key: string]: unknown;
}

export type ReadResult = { ok: true; doc: NotesRegistryDoc } | { ok: false; error: string };

/** name の検証。正しければ null、不正ならエラー文 */
export function validateName(name: string): string | null {
    if (!NAME_RE.test(name)) {
        return 'Use 1-64 letters, digits, "-" or "_" (start with a letter or digit).';
    }
    return null;
}

export function registryFileName(name: string): string {
    return `${name}${REGISTRY_EXT}`;
}

/** 初回に自動で作る一覧ファイル（mac / Linux は ~/.fractal、Windows は %USERPROFILE%\.fractal） */
export function defaultRegistryPath(home: string = os.homedir()): string {
    return path.join(home, '.fractal', `default${REGISTRY_EXT}`);
}

/** notes を path.resolve で正規化し、重複を除く（順序は最初の出現を保つ） */
export function normalizeNotes(notes: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of notes) {
        const norm = path.resolve(p);
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
    }
    return out;
}

export function parseRegistry(text: string): ReadResult {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, error: 'Invalid JSON.' };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'Not a .fractal notes list.' };
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.version !== 'number') return { ok: false, error: 'Not a .fractal notes list (no version).' };
    if (o.version > REGISTRY_VERSION) {
        return { ok: false, error: `Unsupported version ${o.version} (this Fractal supports ${REGISTRY_VERSION}).` };
    }
    if (o.version !== REGISTRY_VERSION) return { ok: false, error: `Unsupported version ${o.version}.` };
    if (!Array.isArray(o.notes) || o.notes.some(n => typeof n !== 'string')) {
        return { ok: false, error: 'Not a .fractal notes list (notes must be a list of paths).' };
    }
    return { ok: true, doc: { ...o, notes: normalizeNotes(o.notes as string[]) } as NotesRegistryDoc };
}

export function readRegistry(file: string): ReadResult {
    let text: string;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return { ok: false, error: 'File not found.' };
    }
    return parseRegistry(text);
}

export function serializeRegistry(doc: NotesRegistryDoc): string {
    const { version, notes, ...rest } = doc;
    return JSON.stringify({ version, notes, ...rest }, null, 2) + '\n';
}

function tmpPathFor(file: string): string {
    return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
}

/** tmp に書いて rename（途中で落ちても元のファイルは壊れない） */
export function writeRegistryAtomic(file: string, doc: NotesRegistryDoc): void {
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, serializeRegistry(doc), 'utf8');
    try {
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
    }
}

export class RegistryExistsError extends Error {
    constructor(public readonly file: string) {
        super(`${path.basename(file)} already exists.`);
    }
}

/**
 * 新しい一覧ファイルを dir に作る。同名があれば上書きせず RegistryExistsError。
 */
export function createRegistryFile(dir: string, name: string, notes: string[] = []): string {
    const nameErr = validateName(name);
    if (nameErr) throw new Error(nameErr);
    const file = path.join(dir, registryFileName(name));
    createRegistryAt(file, notes);
    return file;
}

/** file に一覧ファイルを作る。tmp に書いてから link で置く（既存ファイルがあれば link が EEXIST で失敗する） */
function createRegistryAt(file: string, notes: string[]): void {
    if (fs.existsSync(file)) throw new RegistryExistsError(file);
    const doc: NotesRegistryDoc = { version: REGISTRY_VERSION, notes: normalizeNotes(notes) };
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, serializeRegistry(doc), 'utf8');
    try {
        fs.linkSync(tmp, file);
    } catch (e: any) {
        if (e && e.code === 'EEXIST') throw new RegistryExistsError(file);
        throw e;
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
}

/**
 * 初回の default.fractal（spec 20261026-1845 D3）: 無ければ notes を入れて作る。あれば上書きせず、
 * 無い Note だけ末尾に足す（別の IDE が先に作っていた場合）。壊れていれば書かずに throw。
 */
export function ensureDefaultRegistry(file: string, notes: string[]): { created: boolean; added: number } {
    if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            createRegistryAt(file, notes);
            return { created: true, added: normalizeNotes(notes).length };
        } catch (e) {
            if (!(e instanceof RegistryExistsError)) throw e;
        }
    }
    let added = 0;
    updateRegistryNotes(file, current => {
        const have = new Set(current);
        const extra = normalizeNotes(notes).filter(p => !have.has(p));
        added = extra.length;
        return [...current, ...extra];
    });
    return { created: false, added };
}

/**
 * 一覧ファイルの notes を変更する。書く直前にディスクから読み直して mutate を当てる
 * （別ウィンドウの変更を潰さない）。読めない・壊れている・version が新しいときは書かずに throw。
 */
export function updateRegistryNotes(file: string, mutate: (notes: string[]) => string[]): NotesRegistryDoc {
    const r = readRegistry(file);
    if (!r.ok) throw new Error(`${path.basename(file)}: ${r.error}`);
    const doc: NotesRegistryDoc = { ...r.doc, notes: normalizeNotes(mutate([...r.doc.notes])) };
    writeRegistryAtomic(file, doc);
    return doc;
}
