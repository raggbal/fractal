/**
 * Value classes and enums of the vscode API, with the semantics of VS Code's extHostTypes.ts.
 * Only plain JS (no `declare` fields, no const enums) so that tsc and Playwright's babel transform
 * produce the same runtime shape.
 */
import { Uri, isUri } from './uri';

function illegalArgument(name: string): Error {
    return new Error(`Illegal argument: ${name}`);
}

/** Builds a TS-style numeric enum object (with the reverse mapping, like `enum X {}` emits). */
function makeEnum<T extends Record<string, number>>(values: T): Readonly<T & Record<number, string>> {
    const out: Record<string | number, string | number> = {};
    for (const [k, v] of Object.entries(values)) {
        out[k] = v;
        out[v] = k;
    }
    return Object.freeze(out) as Readonly<T & Record<number, string>>;
}

export const ViewColumn = makeEnum({
    Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9,
});
export const ConfigurationTarget = makeEnum({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });
export const ProgressLocation = makeEnum({ SourceControl: 1, Window: 10, Notification: 15 });
export const QuickPickItemKind = makeEnum({ Separator: -1, Default: 0 });
export const TextEditorRevealType = makeEnum({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
export const TreeItemCollapsibleState = makeEnum({ None: 0, Collapsed: 1, Expanded: 2 });
export const EndOfLine = makeEnum({ LF: 1, CRLF: 2 });
export const FileType = makeEnum({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });
export const FilePermission = makeEnum({ Readonly: 1 });
export const ExtensionMode = makeEnum({ Production: 1, Development: 2, Test: 3 });
export const ExtensionKind = makeEnum({ UI: 1, Workspace: 2 });
export const UIKind = makeEnum({ Desktop: 1, Web: 2 });
export const TextDocumentChangeReason = makeEnum({ Undo: 1, Redo: 2 });
export const TextDocumentSaveReason = makeEnum({ Manual: 1, AfterDelay: 2, FocusOut: 3 });
export const StatusBarAlignment = makeEnum({ Left: 1, Right: 2 });
export const InputBoxValidationSeverity = makeEnum({ Info: 1, Warning: 2, Error: 3 });
export const ColorThemeKind = makeEnum({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 });
export const LogLevel = makeEnum({ Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 });
export const DiagnosticSeverity = makeEnum({ Error: 0, Warning: 1, Information: 2, Hint: 3 });
export const TextEditorSelectionChangeKind = makeEnum({ Keyboard: 1, Mouse: 2, Command: 3 });

export class Position {
    static isPosition(other: unknown): other is Position {
        if (!other || typeof other !== 'object') {
            return false;
        }
        if (other instanceof Position) {
            return true;
        }
        const { line, character } = other as Position;
        return typeof line === 'number' && typeof character === 'number';
    }

    static of(obj: { line: number; character: number }): Position {
        if (obj instanceof Position) {
            return obj;
        }
        if (Position.isPosition(obj)) {
            return new Position(obj.line, obj.character);
        }
        throw new Error('Invalid argument, is NOT a position-like object');
    }

    private readonly _line: number;
    private readonly _character: number;

    constructor(line: number, character: number) {
        if (line < 0) {
            throw illegalArgument('line must be non-negative');
        }
        if (character < 0) {
            throw illegalArgument('character must be non-negative');
        }
        this._line = line;
        this._character = character;
    }

    get line(): number {
        return this._line;
    }

    get character(): number {
        return this._character;
    }

    isBefore(other: Position): boolean {
        if (this._line < other.line) {
            return true;
        }
        if (other.line < this._line) {
            return false;
        }
        return this._character < other.character;
    }

    isBeforeOrEqual(other: Position): boolean {
        if (this._line < other.line) {
            return true;
        }
        if (other.line < this._line) {
            return false;
        }
        return this._character <= other.character;
    }

    isAfter(other: Position): boolean {
        return !this.isBeforeOrEqual(other);
    }

    isAfterOrEqual(other: Position): boolean {
        return !this.isBefore(other);
    }

    isEqual(other: Position): boolean {
        return this._line === other.line && this._character === other.character;
    }

    compareTo(other: Position): number {
        if (this._line < other.line) {
            return -1;
        }
        if (this._line > other.line) {
            return 1;
        }
        if (this._character < other.character) {
            return -1;
        }
        if (this._character > other.character) {
            return 1;
        }
        return 0;
    }

    translate(lineDeltaOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
        if (lineDeltaOrChange === null || characterDelta === null) {
            throw illegalArgument('translate');
        }
        let lineDelta: number;
        if (typeof lineDeltaOrChange === 'undefined') {
            lineDelta = 0;
        } else if (typeof lineDeltaOrChange === 'number') {
            lineDelta = lineDeltaOrChange;
        } else {
            lineDelta = typeof lineDeltaOrChange.lineDelta === 'number' ? lineDeltaOrChange.lineDelta : 0;
            characterDelta = typeof lineDeltaOrChange.characterDelta === 'number' ? lineDeltaOrChange.characterDelta : 0;
        }
        if (lineDelta === 0 && characterDelta === 0) {
            return this;
        }
        return new Position(this.line + lineDelta, this.character + characterDelta);
    }

    with(lineOrChange?: number | { line?: number; character?: number }, character: number = this.character): Position {
        if (lineOrChange === null || character === null) {
            throw illegalArgument('with');
        }
        let line: number;
        if (typeof lineOrChange === 'undefined') {
            line = this.line;
        } else if (typeof lineOrChange === 'number') {
            line = lineOrChange;
        } else {
            line = typeof lineOrChange.line === 'number' ? lineOrChange.line : this.line;
            character = typeof lineOrChange.character === 'number' ? lineOrChange.character : this.character;
        }
        if (line === this.line && character === this.character) {
            return this;
        }
        return new Position(line, character);
    }

    toJSON(): { line: number; character: number } {
        return { line: this.line, character: this.character };
    }
}

export class Range {
    static isRange(thing: unknown): thing is Range {
        if (thing instanceof Range) {
            return true;
        }
        if (!thing || typeof thing !== 'object') {
            return false;
        }
        return Position.isPosition((thing as Range).start) && Position.isPosition((thing as Range).end);
    }

    static of(obj: { start: { line: number; character: number }; end: { line: number; character: number } }): Range {
        if (obj instanceof Range) {
            return obj;
        }
        if (Range.isRange(obj)) {
            return new Range(obj.start, obj.end);
        }
        throw new Error('Invalid argument, is NOT a range-like object');
    }

    protected _start: Position;
    protected _end: Position;

    constructor(start: Position, end: Position);
    constructor(startLine: number, startColumn: number, endLine: number, endColumn: number);
    constructor(
        startLineOrStart: number | Position,
        startColumnOrEnd: number | Position,
        endLine?: number,
        endColumn?: number
    ) {
        let start: Position | undefined;
        let end: Position | undefined;
        if (
            typeof startLineOrStart === 'number' &&
            typeof startColumnOrEnd === 'number' &&
            typeof endLine === 'number' &&
            typeof endColumn === 'number'
        ) {
            start = new Position(startLineOrStart, startColumnOrEnd);
            end = new Position(endLine, endColumn);
        } else if (Position.isPosition(startLineOrStart) && Position.isPosition(startColumnOrEnd)) {
            start = Position.of(startLineOrStart);
            end = Position.of(startColumnOrEnd);
        }
        if (!start || !end) {
            throw new Error('Invalid arguments');
        }
        if (start.isBefore(end)) {
            this._start = start;
            this._end = end;
        } else {
            this._start = end;
            this._end = start;
        }
    }

    get start(): Position {
        return this._start;
    }

    get end(): Position {
        return this._end;
    }

    contains(positionOrRange: Position | Range): boolean {
        if (Range.isRange(positionOrRange)) {
            return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
        }
        if (Position.isPosition(positionOrRange)) {
            if (Position.of(positionOrRange).isBefore(this._start)) {
                return false;
            }
            if (this._end.isBefore(positionOrRange)) {
                return false;
            }
            return true;
        }
        return false;
    }

    isEqual(other: Range): boolean {
        return this._start.isEqual(other.start) && this._end.isEqual(other.end);
    }

    intersection(other: Range): Range | undefined {
        const start = this._start.isAfter(other.start) ? this._start : other.start;
        const end = this._end.isBefore(other.end) ? this._end : other.end;
        if (start.isAfter(end)) {
            return undefined;
        }
        return new Range(start, end);
    }

    union(other: Range): Range {
        if (this.contains(other)) {
            return this;
        }
        if (other.contains(this)) {
            return other;
        }
        const start = this._start.isBefore(other.start) ? this._start : other.start;
        const end = this._end.isAfter(other.end) ? this._end : other.end;
        return new Range(start, end);
    }

    get isEmpty(): boolean {
        return this._start.isEqual(this._end);
    }

    get isSingleLine(): boolean {
        return this._start.line === this._end.line;
    }

    with(startOrChange?: Position | { start?: Position; end?: Position }, end: Position = this.end): Range {
        if (startOrChange === null || end === null) {
            throw illegalArgument('with');
        }
        let start: Position;
        if (!startOrChange) {
            start = this.start;
        } else if (Position.isPosition(startOrChange)) {
            start = startOrChange;
        } else {
            start = startOrChange.start || this.start;
            end = startOrChange.end || this.end;
        }
        if (start.isEqual(this._start) && end.isEqual(this.end)) {
            return this;
        }
        return new Range(start, end);
    }

    toJSON(): unknown {
        return [this.start, this.end];
    }
}

export class Selection extends Range {
    static isSelection(thing: unknown): thing is Selection {
        if (thing instanceof Selection) {
            return true;
        }
        if (!thing || typeof thing !== 'object') {
            return false;
        }
        const t = thing as Selection;
        return Range.isRange(t) && Position.isPosition(t.anchor) && Position.isPosition(t.active) && typeof t.isReversed === 'boolean';
    }

    private readonly _anchor: Position;
    private readonly _active: Position;

    constructor(anchor: Position, active: Position);
    constructor(anchorLine: number, anchorColumn: number, activeLine: number, activeColumn: number);
    constructor(
        anchorLineOrAnchor: number | Position,
        anchorColumnOrActive: number | Position,
        activeLine?: number,
        activeColumn?: number
    ) {
        let anchor: Position | undefined;
        let active: Position | undefined;
        if (
            typeof anchorLineOrAnchor === 'number' &&
            typeof anchorColumnOrActive === 'number' &&
            typeof activeLine === 'number' &&
            typeof activeColumn === 'number'
        ) {
            anchor = new Position(anchorLineOrAnchor, anchorColumnOrActive);
            active = new Position(activeLine, activeColumn);
        } else if (Position.isPosition(anchorLineOrAnchor) && Position.isPosition(anchorColumnOrActive)) {
            anchor = Position.of(anchorLineOrAnchor);
            active = Position.of(anchorColumnOrActive);
        }
        if (!anchor || !active) {
            throw new Error('Invalid arguments');
        }
        super(anchor, active);
        this._anchor = anchor;
        this._active = active;
    }

    get anchor(): Position {
        return this._anchor;
    }

    get active(): Position {
        return this._active;
    }

    get isReversed(): boolean {
        return this._anchor === this._end;
    }

    toJSON(): unknown {
        return { start: this.start, end: this.end, active: this.active, anchor: this.anchor };
    }
}

export class TextEdit {
    static isTextEdit(thing: unknown): thing is TextEdit {
        if (thing instanceof TextEdit) {
            return true;
        }
        if (!thing || typeof thing !== 'object') {
            return false;
        }
        return Range.isRange((thing as TextEdit).range) && typeof (thing as TextEdit).newText === 'string';
    }

    static replace(range: Range, newText: string): TextEdit {
        return new TextEdit(range, newText);
    }

    static insert(position: Position, newText: string): TextEdit {
        return TextEdit.replace(new Range(position, position), newText);
    }

    static delete(range: Range): TextEdit {
        return TextEdit.replace(range, '');
    }

    static setEndOfLine(eol: number): TextEdit {
        const ret = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
        ret.newEol = eol;
        return ret;
    }

    range: Range;
    newText: string;
    newEol: number | undefined;

    constructor(range: Range, newText: string | null | undefined) {
        if (!Range.isRange(range)) {
            throw illegalArgument('range');
        }
        this.range = Range.of(range);
        this.newText = typeof newText === 'string' ? newText : '';
        this.newEol = undefined;
    }

    toJSON(): unknown {
        return { range: this.range, newText: this.newText, newEol: this.newEol };
    }
}

export type WorkspaceEditEntry =
    | { _type: 'text'; uri: Uri; edit: TextEdit; metadata?: unknown }
    | { _type: 'file'; from?: Uri; to?: Uri; options?: unknown; metadata?: unknown };

/** WorkspaceEdit (text edits only are applied by the shim; file operations make applyEdit return false). */
export class WorkspaceEdit {
    private readonly _edits: WorkspaceEditEntry[] = [];

    /** Shim-internal: the recorded operations in insertion order. */
    _allEntries(): ReadonlyArray<WorkspaceEditEntry> {
        return this._edits;
    }

    renameFile(from: Uri, to: Uri, options?: { overwrite?: boolean; ignoreIfExists?: boolean }, metadata?: unknown): void {
        this._edits.push({ _type: 'file', from, to, options, metadata });
    }

    createFile(uri: Uri, options?: unknown, metadata?: unknown): void {
        this._edits.push({ _type: 'file', from: undefined, to: uri, options, metadata });
    }

    deleteFile(uri: Uri, options?: unknown, metadata?: unknown): void {
        this._edits.push({ _type: 'file', from: uri, to: undefined, options, metadata });
    }

    replace(uri: Uri, range: Range, newText: string, metadata?: unknown): void {
        this._edits.push({ _type: 'text', uri, edit: new TextEdit(range, newText), metadata });
    }

    insert(resource: Uri, position: Position, newText: string, metadata?: unknown): void {
        this.replace(resource, new Range(position, position), newText, metadata);
    }

    delete(resource: Uri, range: Range, metadata?: unknown): void {
        this.replace(resource, range, '', metadata);
    }

    has(uri: Uri): boolean {
        const key = uri.toString();
        return this._edits.some((e) => e._type === 'text' && e.uri.toString() === key);
    }

    set(uri: Uri, edits: ReadonlyArray<TextEdit | [TextEdit, unknown]> | null | undefined): void {
        const key = uri.toString();
        for (let i = this._edits.length - 1; i >= 0; i--) {
            const e = this._edits[i];
            if (e._type === 'text' && e.uri.toString() === key) {
                this._edits.splice(i, 1);
            }
        }
        if (!edits) {
            return;
        }
        for (const item of edits) {
            const [edit, metadata] = Array.isArray(item) ? item : [item, undefined];
            if (!edit) {
                continue;
            }
            if (TextEdit.isTextEdit(edit)) {
                this._edits.push({ _type: 'text', uri, edit, metadata });
            }
        }
    }

    get(uri: Uri): TextEdit[] {
        const key = uri.toString();
        const res: TextEdit[] = [];
        for (const e of this._edits) {
            if (e._type === 'text' && e.uri.toString() === key) {
                res.push(e.edit);
            }
        }
        return res;
    }

    entries(): [Uri, TextEdit[]][] {
        const byUri = new Map<string, [Uri, TextEdit[]]>();
        for (const e of this._edits) {
            if (e._type !== 'text') {
                continue;
            }
            const key = e.uri.toString();
            let entry = byUri.get(key);
            if (!entry) {
                entry = [e.uri, []];
                byUri.set(key, entry);
            }
            entry[1].push(e.edit);
        }
        return Array.from(byUri.values());
    }

    get size(): number {
        return this.entries().length;
    }

    toJSON(): unknown {
        return this.entries();
    }
}

/** RelativePattern(base, pattern): base is a WorkspaceFolder, a Uri or an absolute path. */
export class RelativePattern {
    pattern: string;
    private _base!: string;
    private _baseUri!: Uri;

    get base(): string {
        return this._base;
    }

    set base(base: string) {
        this._base = base;
        this._baseUri = Uri.file(base);
    }

    get baseUri(): Uri {
        return this._baseUri;
    }

    set baseUri(base: Uri) {
        this._baseUri = base;
        this._base = base.fsPath;
    }

    constructor(base: Uri | string | { uri: Uri }, pattern: string) {
        if (typeof base !== 'string') {
            if (!base || (!isUri(base) && !isUri((base as { uri: Uri }).uri))) {
                throw illegalArgument('base');
            }
        }
        if (typeof pattern !== 'string') {
            throw illegalArgument('pattern');
        }
        if (typeof base === 'string') {
            this.baseUri = Uri.file(base);
        } else if (isUri(base)) {
            this.baseUri = base;
        } else {
            this.baseUri = base.uri;
        }
        this.pattern = pattern;
    }

    toJSON(): unknown {
        return { pattern: this.pattern, base: this.base, baseUri: this.baseUri.toJSON() };
    }
}

export class ThemeColor {
    readonly id: string;

    constructor(id: string) {
        this.id = id;
    }
}

export class ThemeIcon {
    static readonly File: ThemeIcon = new ThemeIcon('file');
    static readonly Folder: ThemeIcon = new ThemeIcon('folder');

    readonly id: string;
    readonly color: ThemeColor | undefined;

    constructor(id: string, color?: ThemeColor) {
        this.id = id;
        this.color = color;
    }
}

export class MarkdownString {
    value: string;
    isTrusted: boolean | undefined;
    supportThemeIcons: boolean | undefined;
    supportHtml: boolean | undefined;

    constructor(value = '', supportThemeIcons = false) {
        this.value = value;
        this.isTrusted = undefined;
        this.supportThemeIcons = supportThemeIcons;
        this.supportHtml = false;
    }

    appendText(value: string): MarkdownString {
        this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
        return this;
    }

    appendMarkdown(value: string): MarkdownString {
        this.value += value;
        return this;
    }

    appendCodeblock(code: string, language = ''): MarkdownString {
        this.value += `\n\`\`\`${language}\n${code}\n\`\`\`\n`;
        return this;
    }
}

/**
 * TreeItem: a real constructible class (the bundle evaluates `class X extends vscode.TreeItem` at load).
 * Optional members are declared through interface merging so that no field initializers are emitted.
 */
export interface TreeItem {
    label?: string | { label: string; highlights?: [number, number][] };
    id?: string;
    iconPath?: unknown;
    description?: string | boolean;
    resourceUri?: Uri;
    tooltip?: string | MarkdownString;
    command?: { command: string; title: string; tooltip?: string; arguments?: unknown[] };
    contextValue?: string;
    accessibilityInformation?: unknown;
    checkboxState?: unknown;
}

export class TreeItem {
    collapsibleState: number;

    constructor(labelOrUri: string | { label: string } | Uri, collapsibleState: number = TreeItemCollapsibleState.None) {
        if (isUri(labelOrUri)) {
            this.resourceUri = labelOrUri;
        } else {
            this.label = labelOrUri as string | { label: string };
        }
        this.collapsibleState = collapsibleState;
    }
}

export class DataTransferItem {
    readonly value: unknown;

    constructor(value: unknown) {
        this.value = value;
    }

    async asString(): Promise<string> {
        return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
    }

    asFile(): undefined {
        return undefined;
    }
}

export class DataTransfer {
    private readonly _items = new Map<string, DataTransferItem>();

    get(mimeType: string): DataTransferItem | undefined {
        return this._items.get(mimeType.toLowerCase());
    }

    set(mimeType: string, value: DataTransferItem): void {
        this._items.set(mimeType.toLowerCase(), value);
    }

    forEach(callbackfn: (item: DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void, thisArg?: unknown): void {
        for (const [mime, item] of this._items) {
            callbackfn.call(thisArg, item, mime, this);
        }
    }

    *[Symbol.iterator](): IterableIterator<[mimeType: string, item: DataTransferItem]> {
        yield* this._items.entries();
    }
}

/** Provider-level error codes VS Code puts into FileSystemError#name. */
const PROVIDER_CODE: Record<string, string> = {
    FileExists: 'EntryExists',
    FileNotFound: 'EntryNotFound',
    FileNotADirectory: 'EntryNotADirectory',
    FileIsADirectory: 'EntryIsADirectory',
    NoPermissions: 'NoPermissions',
    Unavailable: 'Unavailable',
    Unknown: 'Unknown',
};

export class FileSystemError extends Error {
    static FileExists(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileExists');
    }

    static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileNotFound');
    }

    static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileNotADirectory');
    }

    static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'FileIsADirectory');
    }

    static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'NoPermissions');
    }

    static Unavailable(messageOrUri?: string | Uri): FileSystemError {
        return new FileSystemError(messageOrUri, 'Unavailable');
    }

    readonly code: string;

    constructor(uriOrMessage?: string | Uri, code = 'Unknown') {
        super(isUri(uriOrMessage) ? uriOrMessage.toString(true) : uriOrMessage);
        this.code = code;
        this.name = `${PROVIDER_CODE[code] ?? code} (FileSystemError)`;
        Object.setPrototypeOf(this, FileSystemError.prototype);
    }
}
