import * as fs from 'fs';
import * as path from 'path';

/**
 * Notes 一覧ファイル（`<name>-fractal-notes.json`）の形式・検証・読み書き
 * （spec 20261026-1555-fractal-notes-json D1 / D2 / D9 / D11）。
 * vscode を import しない — NotesFolderProvider と単体テストが共有する。
 *
 * 形式: { version: 1, name, title, notes: string[] }（notes は Note フォルダの絶対パス）。
 * 読んだ未知のキーは書き戻しで保持する。
 */

export const REGISTRY_VERSION = 1;
export const REGISTRY_SUFFIX = '-fractal-notes.json';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const TITLE_MAX = 100;

export interface NotesRegistryDoc {
    version: number;
    name: string;
    title: string;
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

/** title の検証（trim 後 1〜100 字）。正しければ null */
export function validateTitle(title: string): string | null {
    const t = title.trim();
    if (!t) return 'Title is required.';
    if (t.length > TITLE_MAX) return `Title must be ${TITLE_MAX} characters or fewer.`;
    return null;
}

export function registryFileName(name: string): string {
    return `${name}${REGISTRY_SUFFIX}`;
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
        return { ok: false, error: 'Not a fractal-notes.json file.' };
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.version !== 'number') return { ok: false, error: 'Not a fractal-notes.json file (no version).' };
    if (o.version > REGISTRY_VERSION) {
        return { ok: false, error: `Unsupported version ${o.version} (this Fractal supports ${REGISTRY_VERSION}).` };
    }
    if (o.version !== REGISTRY_VERSION) return { ok: false, error: `Unsupported version ${o.version}.` };
    if (typeof o.name !== 'string' || typeof o.title !== 'string') {
        return { ok: false, error: 'Not a fractal-notes.json file (name / title missing).' };
    }
    if (!Array.isArray(o.notes) || o.notes.some(n => typeof n !== 'string')) {
        return { ok: false, error: 'Not a fractal-notes.json file (notes must be a list of paths).' };
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
    const { version, name, title, notes, ...rest } = doc;
    return JSON.stringify({ version, name, title, notes, ...rest }, null, 2) + '\n';
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
 * tmp に書いてから link で置く（既存ファイルがあれば link が EEXIST で失敗する）。
 */
export function createRegistryFile(dir: string, name: string, title: string, notes: string[] = []): string {
    const nameErr = validateName(name);
    if (nameErr) throw new Error(nameErr);
    const titleErr = validateTitle(title);
    if (titleErr) throw new Error(titleErr);
    const file = path.join(dir, registryFileName(name));
    if (fs.existsSync(file)) throw new RegistryExistsError(file);
    const doc: NotesRegistryDoc = { version: REGISTRY_VERSION, name, title: title.trim(), notes: normalizeNotes(notes) };
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
    return file;
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
