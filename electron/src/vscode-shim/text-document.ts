/**
 * workspace.openTextDocument / textDocuments / applyEdit / onDidChangeTextDocument / TextDocument.save
 * as an in-memory model backed by files, with the semantics of VS Code's extension host documents:
 * - One TextDocument instance per URI while open (concurrent opens share one read). Documents are never
 *   closed automatically (isClosed stays false) and are NOT reloaded from disk when the file changes —
 *   Fractal reconciles external edits itself (hybrid watcher + applyEdit + save).
 * - Load: UTF-8, the BOM is stripped and remembered (written back on save, like VS Code's utf8bom);
 *   the EOL is CRLF when more than half of the line breaks are CR/CRLF, else LF, and the buffer is
 *   normalized to it (VS Code TextModel).
 * - applyEdit: opens the document if needed, clamps ranges (Range(0,0,lineCount,0) = whole document),
 *   converts inserted line breaks to the document EOL, marks the document dirty, bumps `version` and
 *   fires onDidChangeTextDocument BEFORE the returned promise resolves (synchronously when the
 *   document is already open). Overlapping edits make it resolve false. File operations are not
 *   supported (resolve false).
 * - save(): writes the buffer in place when dirty (one save at a time per document) and clears
 *   isDirty unless the document changed while writing; a failing write shows an error and resolves false.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from './events';
import { Uri, isUri } from './uri';
import { EndOfLine, Position, Range, TextEdit, WorkspaceEdit } from './types';
import type { ShimLogger } from './adapters';

export interface TextDocumentContentChangeEvent {
    readonly range: Range;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
}

export interface TextDocumentChangeEvent {
    readonly document: ShimTextDocument;
    readonly contentChanges: readonly TextDocumentContentChangeEvent[];
    readonly reason: number | undefined;
}

export interface TextLine {
    readonly lineNumber: number;
    readonly text: string;
    readonly range: Range;
    readonly rangeIncludingLineBreak: Range;
    readonly firstNonWhitespaceCharacterIndex: number;
    readonly isEmptyOrWhitespace: boolean;
}

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdwn', '.mdtxt', '.mdtext']);

function languageIdFor(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    if (MARKDOWN_EXT.has(ext)) {
        return 'markdown';
    }
    if (ext === '.json' || ext === '.out' || ext === '.note' || ext === '.fractal') {
        return 'json';
    }
    return 'plaintext';
}

/** VS Code's EOL choice for a loaded buffer. */
function detectEol(text: string): '\n' | '\r\n' {
    let cr = 0;
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 13) {
            if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
                crlf++;
                i++;
            } else {
                cr++;
            }
        } else if (c === 10) {
            lf++;
        }
    }
    const total = cr + lf + crlf;
    if (total === 0) {
        return '\n'; // files.eol "auto" on macOS
    }
    return cr + crlf > total / 2 ? '\r\n' : '\n';
}

function normalizeEol(text: string, eol: string): string {
    return text.replace(/\r\n|\r|\n/g, eol);
}

interface PreparedEdit {
    range: Range;
    start: number;
    end: number;
    text: string;
}

export interface DocumentServices {
    log: ShimLogger;
    onSaveError(doc: ShimTextDocument, err: unknown): void;
    fireSaved(doc: ShimTextDocument): void;
}

export class ShimTextDocument {
    readonly uri: Uri;
    readonly fileName: string;
    readonly isUntitled: boolean;
    languageId: string;
    version = 1;
    isDirty = false;
    isClosed = false;

    private _lines: string[] = [''];
    private _eol: '\n' | '\r\n' = '\n';
    private _hadBom = false;
    /** prefix sums of (line length + eol length) */
    private _lineStarts: number[] | undefined;
    private _saveChain: Promise<unknown> = Promise.resolve();
    private _saving = 0;
    /** mtime / size of the file as last read or written by this document */
    private _disk: { mtimeMs: number; size: number } | undefined;

    constructor(uri: Uri, text: string, hadBom: boolean, private readonly services: DocumentServices) {
        this.uri = uri;
        this.fileName = uri.scheme === 'file' ? uri.fsPath : uri.path;
        this.isUntitled = uri.scheme === 'untitled';
        this.languageId = languageIdFor(this.fileName);
        this._hadBom = hadBom;
        this._eol = detectEol(text);
        this._setText(normalizeEol(text, this._eol));
    }

    get eol(): number {
        return this._eol === '\r\n' ? EndOfLine.CRLF : EndOfLine.LF;
    }

    get encoding(): string {
        return this._hadBom ? 'utf8bom' : 'utf8';
    }

    get lineCount(): number {
        return this._lines.length;
    }

    getText(range?: Range): string {
        if (!range) {
            return this._lines.join(this._eol);
        }
        const r = this.validateRange(range);
        if (r.isEmpty) {
            return '';
        }
        if (r.isSingleLine) {
            return this._lines[r.start.line].substring(r.start.character, r.end.character);
        }
        const parts: string[] = [this._lines[r.start.line].substring(r.start.character)];
        for (let i = r.start.line + 1; i < r.end.line; i++) {
            parts.push(this._lines[i]);
        }
        parts.push(this._lines[r.end.line].substring(0, r.end.character));
        return parts.join(this._eol);
    }

    lineAt(lineOrPosition: number | Position): TextLine {
        let line: number | undefined;
        if (lineOrPosition instanceof Position || Position.isPosition(lineOrPosition)) {
            line = (lineOrPosition as Position).line;
        } else if (typeof lineOrPosition === 'number') {
            line = lineOrPosition;
        }
        if (typeof line !== 'number' || line < 0 || line >= this._lines.length || Math.floor(line) !== line) {
            throw new Error('Illegal value for `line`');
        }
        const text = this._lines[line];
        const isLast = line === this._lines.length - 1;
        const firstNonWs = /^(\s*)/.exec(text)![1].length;
        return {
            lineNumber: line,
            text,
            range: new Range(line, 0, line, text.length),
            rangeIncludingLineBreak: isLast ? new Range(line, 0, line, text.length) : new Range(line, 0, line + 1, 0),
            firstNonWhitespaceCharacterIndex: firstNonWs,
            isEmptyOrWhitespace: firstNonWs === text.length,
        };
    }

    offsetAt(position: Position): number {
        const p = this.validatePosition(position);
        return this._lineStart(p.line) + p.character;
    }

    positionAt(offset: number): Position {
        offset = Math.floor(offset);
        offset = Math.max(0, offset);
        const starts = this._getLineStarts();
        // binary search the last line whose start <= offset
        let lo = 0;
        let hi = this._lines.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= offset) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        const line = lo;
        const remainder = offset - starts[line];
        return new Position(line, Math.min(remainder, this._lines[line].length));
    }

    validatePosition(position: Position): Position {
        if (!Position.isPosition(position)) {
            throw new Error('Invalid argument');
        }
        const pos = Position.of(position);
        let { line, character } = pos;
        let changed = false;
        if (line < 0) {
            line = 0;
            character = 0;
            changed = true;
        } else if (line >= this._lines.length) {
            line = this._lines.length - 1;
            character = this._lines[line].length;
            changed = true;
        } else {
            const max = this._lines[line].length;
            if (character < 0) {
                character = 0;
                changed = true;
            } else if (character > max) {
                character = max;
                changed = true;
            }
        }
        return changed ? new Position(line, character) : pos;
    }

    validateRange(range: Range): Range {
        if (!Range.isRange(range)) {
            throw new Error('Invalid argument');
        }
        const r = Range.of(range);
        const start = this.validatePosition(r.start);
        const end = this.validatePosition(r.end);
        if (start === r.start && end === r.end) {
            return r;
        }
        return new Range(start.line, start.character, end.line, end.character);
    }

    getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
        const p = this.validatePosition(position);
        const text = this._lines[p.line];
        const re = regex ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g') : /[^\s`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?]+/g;
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(text))) {
            const start = m.index;
            const end = start + m[0].length;
            if (start <= p.character && p.character <= end && m[0].length > 0) {
                return new Range(p.line, start, p.line, end);
            }
            if (m[0].length === 0) {
                re.lastIndex++;
            }
        }
        return undefined;
    }

    save(): Promise<boolean> {
        if (this.isClosed) {
            return Promise.reject(new Error('Document has been closed'));
        }
        const run = this._saveChain.then(() => this._doSave());
        this._saveChain = run.catch(() => undefined);
        return run;
    }

    private async _doSave(): Promise<boolean> {
        if (!this.isDirty) {
            return true; // nothing to write (VS Code resolves true for a clean document)
        }
        if (this.uri.scheme !== 'file') {
            return false;
        }
        const versionAtSave = this.version;
        const data = (this._hadBom ? '\uFEFF' : '') + this.getText();
        this._saving++;
        try {
            await fs.promises.mkdir(path.dirname(this.uri.fsPath), { recursive: true });
            await fs.promises.writeFile(this.uri.fsPath, data, 'utf8');
            try {
                this._noteDiskState(await fs.promises.stat(this.uri.fsPath));
            } catch {
                this._disk = undefined;
            }
        } catch (err) {
            this.services.onSaveError(this, err);
            return false;
        } finally {
            this._saving--;
        }
        if (this.version === versionAtSave) {
            this.isDirty = false;
        }
        this.services.fireSaved(this);
        return true;
    }

    /** Shim-internal: remember the file state this buffer corresponds to. */
    _noteDiskState(st: { mtimeMs: number; size: number }): void {
        this._disk = { mtimeMs: st.mtimeMs, size: st.size };
    }

    /**
     * Shim-internal: when the document is clean and the file changed on disk since it was read or
     * saved, reload the buffer (VS Code reloads clean models on external changes). Returns the
     * content change to fire, or undefined.
     */
    async _reloadIfChangedOnDisk(): Promise<TextDocumentContentChangeEvent | undefined> {
        if (this.isDirty || this._saving > 0 || this.uri.scheme !== 'file' || !this._disk) {
            return undefined;
        }
        let st: fs.Stats;
        try {
            st = await fs.promises.stat(this.uri.fsPath);
        } catch {
            return undefined; // deleted: keep the buffer (VS Code keeps an orphaned model)
        }
        if (st.mtimeMs === this._disk.mtimeMs && st.size === this._disk.size) {
            return undefined;
        }
        const bytes = await fs.promises.readFile(this.uri.fsPath);
        if (this.isDirty || this._saving > 0) {
            return undefined; // an edit or a save started while reading
        }
        const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
        const raw = new TextDecoder('utf-8').decode(hadBom ? bytes.subarray(3) : bytes);
        const eol = detectEol(raw);
        const text = normalizeEol(raw, eol);
        this._noteDiskState(st);
        this._hadBom = hadBom;
        const oldText = this.getText();
        if (eol === this._eol && text === oldText) {
            return undefined;
        }
        const oldEnd = this.positionAt(oldText.length);
        const range = new Range(0, 0, oldEnd.line, oldEnd.character);
        this._eol = eol;
        this._setText(text);
        this.version++;
        return { range, rangeOffset: 0, rangeLength: oldText.length, text };
    }

    /** Resolves when the saves queued so far have finished. */
    _whenSaved(): Promise<void> {
        return this._saveChain.then(() => undefined);
    }

    /**
     * Shim-internal: validates edits against the current text (clamped ranges, document EOL,
     * no-op edits dropped) and rejects overlapping ranges, without changing anything.
     */
    _prepareEdits(edits: readonly TextEdit[]): PreparedEdit[] | 'overlap' {
        const ops = edits
            .map((e) => {
                const range = this.validateRange(e.range);
                const start = this.offsetAt(range.start);
                const end = this.offsetAt(range.end);
                return { range, start, end, text: normalizeEol(e.newText, this._eol) };
            })
            .filter((op) => !(op.start === op.end && op.text.length === 0));
        ops.sort((a, b) => a.start - b.start || a.end - b.end);
        for (let i = 0; i + 1 < ops.length; i++) {
            if (ops[i + 1].start < ops[i].end) {
                return 'overlap';
            }
        }
        return ops;
    }

    /** Shim-internal: applies prepared edits; returns the content changes (bottom-up, like VS Code). */
    _commitEdits(ops: readonly PreparedEdit[]): TextDocumentContentChangeEvent[] {
        if (ops.length === 0) {
            return [];
        }
        let text = this.getText();
        const changes: TextDocumentContentChangeEvent[] = [];
        for (let i = ops.length - 1; i >= 0; i--) {
            const op = ops[i];
            text = text.slice(0, op.start) + op.text + text.slice(op.end);
            changes.push({ range: op.range, rangeOffset: op.start, rangeLength: op.end - op.start, text: op.text });
        }
        this._setText(text);
        this.version++;
        this.isDirty = true;
        return changes;
    }

    private _setText(text: string): void {
        this._lines = text.split(this._eol);
        this._lineStarts = undefined;
    }

    private _getLineStarts(): number[] {
        if (!this._lineStarts) {
            const starts = new Array<number>(this._lines.length);
            let acc = 0;
            for (let i = 0; i < this._lines.length; i++) {
                starts[i] = acc;
                acc += this._lines[i].length + this._eol.length;
            }
            this._lineStarts = starts;
        }
        return this._lineStarts;
    }

    private _lineStart(line: number): number {
        return this._getLineStarts()[line];
    }
}

export class TextDocumentRegistry {
    private readonly documents = new Map<string, ShimTextDocument>();
    private readonly opening = new Map<string, Promise<ShimTextDocument>>();
    private untitledCounter = 1;

    readonly onDidOpen = new EventEmitter<ShimTextDocument>();
    readonly onDidClose = new EventEmitter<ShimTextDocument>();
    readonly onDidChange = new EventEmitter<TextDocumentChangeEvent>();
    readonly onDidSave = new EventEmitter<ShimTextDocument>();
    readonly onWillSave = new EventEmitter<unknown>();

    private readonly services: DocumentServices;

    constructor(private readonly log: ShimLogger, showError: (message: string) => void) {
        this.services = {
            log,
            onSaveError: (doc, err) => {
                const detail = err instanceof Error ? err.message : String(err);
                log.error(`[vscode-shim] failed to save ${doc.fileName}:`, err);
                showError(`Failed to save '${path.basename(doc.fileName)}': ${detail}`);
            },
            fireSaved: (doc) => this.onDidSave.fire(doc),
        };
    }

    get textDocuments(): ShimTextDocument[] {
        return Array.from(this.documents.values());
    }

    get(uri: Uri): ShimTextDocument | undefined {
        return this.documents.get(uri.toString());
    }

    openTextDocument(arg?: Uri | string | { language?: string; content?: string; encoding?: string }): Promise<ShimTextDocument> {
        if (typeof arg === 'string') {
            return this.openUri(Uri.file(arg));
        }
        if (isUri(arg)) {
            return this.openUri(arg);
        }
        const options = (arg ?? {}) as { language?: string; content?: string };
        const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${this.untitledCounter++}` });
        const doc = new ShimTextDocument(uri, typeof options.content === 'string' ? options.content : '', false, this.services);
        if (options.language) {
            doc.languageId = options.language;
        }
        this.documents.set(uri.toString(), doc);
        this.onDidOpen.fire(doc);
        return Promise.resolve(doc);
    }

    private openUri(uri: Uri): Promise<ShimTextDocument> {
        const key = uri.toString();
        const existing = this.documents.get(key);
        if (existing) {
            // documents stay open for the whole session: a clean one is refreshed if the file changed
            return existing._reloadIfChangedOnDisk().then(
                (change) => {
                    if (change) {
                        this.onDidChange.fire({ document: existing, contentChanges: [change], reason: undefined });
                    }
                    return existing;
                },
                () => existing
            );
        }
        const pending = this.opening.get(key);
        if (pending) {
            return pending;
        }
        if (uri.scheme !== 'file') {
            return Promise.reject(new Error(`cannot open ${key}. Detail: Unable to resolve resource ${key}`));
        }
        const p = (async () => {
            let bytes: Buffer;
            try {
                bytes = await fs.promises.readFile(uri.fsPath);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                const why = code === 'ENOENT'
                    ? `Unable to resolve nonexistent file '${uri.fsPath}'`
                    : code === 'EISDIR'
                        ? `Unable to read file '${uri.fsPath}' that is actually a directory`
                        : String((err as Error).message || err);
                throw new Error(`cannot open ${key}. Detail: Unable to read file '${uri.fsPath}' (Error: ${why})`);
            }
            const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
            const text = new TextDecoder('utf-8').decode(hadBom ? bytes.subarray(3) : bytes);
            const again = this.documents.get(key);
            if (again) {
                return again;
            }
            const doc = new ShimTextDocument(uri, text, hadBom, this.services);
            try {
                doc._noteDiskState(await fs.promises.stat(uri.fsPath));
            } catch {
                /* vanished right after reading: no refresh baseline */
            }
            const raced = this.documents.get(key);
            if (raced) {
                return raced;
            }
            this.documents.set(key, doc);
            this.onDidOpen.fire(doc);
            return doc;
        })();
        this.opening.set(key, p);
        const clear = () => this.opening.delete(key);
        p.then(clear, clear);
        return p;
    }

    /**
     * workspace.applyEdit. Fires onDidChangeTextDocument for every changed document before resolving
     * (synchronously when all target documents are already open).
     */
    applyEdit(edit: WorkspaceEdit): Promise<boolean> {
        if (!(edit instanceof WorkspaceEdit)) {
            return Promise.resolve(false);
        }
        const entries = edit._allEntries();
        if (entries.some((e) => e._type === 'file')) {
            this.log.warn('[vscode-shim] applyEdit: file operations are not supported');
            return Promise.resolve(false);
        }
        const groups = edit.entries();
        const missing = groups.filter(([uri]) => !this.documents.has(uri.toString()));
        if (missing.length === 0) {
            return Promise.resolve(this.applyToOpenDocuments(groups));
        }
        return (async () => {
            try {
                await Promise.all(missing.map(([uri]) => this.openUri(uri)));
            } catch (err) {
                this.log.warn('[vscode-shim] applyEdit: could not open a target document:', err);
                return false;
            }
            return this.applyToOpenDocuments(groups);
        })();
    }

    private applyToOpenDocuments(groups: [Uri, TextEdit[]][]): boolean {
        // validate every document's edits first so that a bad edit changes nothing
        const plans: Array<{ doc: ShimTextDocument; ops: PreparedEdit[] }> = [];
        for (const [uri, edits] of groups) {
            const doc = this.documents.get(uri.toString());
            if (!doc) {
                return false;
            }
            let ops: PreparedEdit[] | 'overlap';
            try {
                ops = doc._prepareEdits(edits);
            } catch (err) {
                this.log.warn(`[vscode-shim] applyEdit: invalid edit for ${uri.toString()}:`, err);
                return false;
            }
            if (ops === 'overlap') {
                this.log.warn(`[vscode-shim] applyEdit: overlapping ranges for ${uri.toString()}`);
                return false;
            }
            plans.push({ doc, ops });
        }
        for (const { doc, ops } of plans) {
            const changes = doc._commitEdits(ops);
            if (changes.length > 0) {
                this.onDidChange.fire({ document: doc, contentChanges: changes, reason: undefined });
            }
        }
        return true;
    }

    /** Saves every dirty document (workspace.saveAll). */
    async saveAll(): Promise<boolean> {
        const results = await Promise.all(this.textDocuments.filter((d) => d.isDirty).map((d) => d.save()));
        return results.every(Boolean);
    }

    /** Waits for the saves already in flight (shell quit path). Does not save anything by itself. */
    async flush(): Promise<void> {
        await Promise.all(this.textDocuments.map((d) => d._whenSaved()));
    }

    dispose(): void {
        this.onDidOpen.dispose();
        this.onDidClose.dispose();
        this.onDidChange.dispose();
        this.onDidSave.dispose();
        this.onWillSave.dispose();
    }
}
