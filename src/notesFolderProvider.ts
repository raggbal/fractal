import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    NotesRegistryDoc,
    RegistryExistsError,
    createRegistryFile,
    defaultRegistryPath,
    ensureDefaultRegistry,
    readRegistry,
    updateRegistryNotes,
    validateName,
} from './shared/notes-registry';

/**
 * FR-NT-03: note フォルダの表示名を解決する。
 * outline.note に noteTitle があればそれを、無ければフォルダ名 (basename) を返す。
 */
export function resolveNoteLabel(folderPath: string): string {
    try {
        const p = path.join(folderPath, 'outline.note');
        if (fs.existsSync(p)) {
            const s = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (s && typeof s.noteTitle === 'string' && s.noteTitle.trim()) {
                return s.noteTitle.trim();
            }
        }
    } catch {
        /* 壊れた outline.note はフォルダ名にフォールバック */
    }
    return path.basename(folderPath);
}

/**
 * NotesFolderProvider — Activity Bar の Notes ビュー（アクティブの .fractal の Note）を提供する TreeDataProvider
 *
 * spec 20261026-1555-fractal-notes-json / 20261026-1845-fractal-file-views: Note の一覧の正は Notes 一覧ファイル（`<name>.fractal`）。
 * globalState には登録した一覧ファイルのパス（notesRegistries）とアクティブ（activeNotesRegistry）だけを持ち、
 * ツリーはアクティブの一覧の Note を出す。旧 notesFolders はアクティブの notes の写しとして書き続ける（旧版 MCP 等の互換）。
 * 登録した .fractal の一覧は上の Notes Lists ビュー（this.lists = NotesListsProvider）が出す。
 *
 * D&D 並べ替え対応: TreeDragAndDropController を実装し、ツリー上でフォルダを掴んで
 * 並べ替えるとアクティブの一覧ファイルの notes の順序を更新する。
 */
const NOTES_FOLDER_DND_MIME = 'application/vnd.fractal.notes-folder';
const KEY_REGISTRIES = 'notesRegistries';
const KEY_ACTIVE = 'activeNotesRegistry';
const KEY_LEGACY = 'notesFolders';
// rc.8 で立てた notesRegistryInitialized は default.fractal を作らずに立つことがあったので、別の名前で 1 回やり直す
const KEY_INITIALIZED = 'notesDefaultFractalCreated';
const CTX_HAS_REGISTRY = 'fractal.hasNotesRegistry';

interface RegistryState {
    /** 最後に読めた中身（壊れた・消えたときもこれを表示し続ける） */
    doc?: NotesRegistryDoc;
    /** 今読めない理由（読めていれば undefined） */
    error?: string;
}

export class NotesFolderProvider
    implements vscode.TreeDataProvider<NotesFolderItem>, vscode.TreeDragAndDropController<NotesFolderItem>, vscode.Disposable
{
    private _onDidChangeTreeData = new vscode.EventEmitter<NotesFolderItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    readonly dragMimeTypes = [NOTES_FOLDER_DND_MIME];
    readonly dropMimeTypes = [NOTES_FOLDER_DND_MIME];

    private registries: string[] = [];
    private active: string | undefined;
    private states = new Map<string, RegistryState>();
    private watchers = new Map<string, vscode.Disposable>();
    private treeView?: vscode.TreeView<NotesFolderItem>;
    /** 上の Notes Lists ビュー（登録した .fractal） */
    readonly lists: NotesListsProvider;

    constructor(private context: vscode.ExtensionContext, private readonly defaultRegistry: string = defaultRegistryPath()) {
        this.lists = new NotesListsProvider(this);
        this.registries = context.globalState.get<string[]>(KEY_REGISTRIES, []).filter(p => typeof p === 'string');
        const active = context.globalState.get<string>(KEY_ACTIVE);
        this.active = active && this.registries.includes(active) ? active : this.registries[0];
        for (const file of this.registries) {
            this.reload(file, false);
            this.watch(file);
        }
        this.updateContext();
    }

    /**
     * 初回（フラグなし）に default.fractal を作って旧 notesFolders を入れ、登録の先頭に置いてアクティブにする（D3）。
     * rc.8 の登録（*-fractal-notes.json）があっても作る。失敗したらフラグを立てない（次の起動でやり直す）。
     */
    async initialize(): Promise<void> {
        if (this.context.globalState.get<boolean>(KEY_INITIALIZED)) return;
        const file = this.defaultRegistry;
        const legacy = this.context.globalState.get<string[]>(KEY_LEGACY, []).filter(p => typeof p === 'string');
        try {
            ensureDefaultRegistry(file, legacy);
        } catch (e: any) {
            if (!fs.existsSync(file)) {
                vscode.window.showWarningMessage(`Could not create ${file}. ${e?.message || e}`);
                return;
            }
            // 壊れた default.fractal: 書かずに登録して ⚠ を出す（旧 notesFolders は globalState に残る。D7）
            vscode.window.showWarningMessage(`${file}: ${e?.message || e} Fix the file to see your notes.`);
        }
        if (!this.registries.includes(file)) this.registries.unshift(file);
        this.reload(file, false);
        this.watch(file);
        await this.context.globalState.update(KEY_INITIALIZED, true);
        await this.setActive(file);
    }

    /** view の description にアクティブのファイル名を出すため、作った TreeView を受け取る */
    setTreeView(view: vscode.TreeView<NotesFolderItem>): void {
        this.treeView = view;
        this.updateDescription();
    }

    getTreeItem(element: NotesFolderItem): vscode.TreeItem {
        return element;
    }

    getChildren(): NotesFolderItem[] {
        return this.getFolders().map(f => new NotesFolderItem(f));
    }

    handleDrag(source: NotesFolderItem[], dataTransfer: vscode.DataTransfer): void {
        const paths = source.map(item => item.folderPath);
        dataTransfer.set(NOTES_FOLDER_DND_MIME, new vscode.DataTransferItem(paths));
    }

    async handleDrop(target: NotesFolderItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const transferItem = dataTransfer.get(NOTES_FOLDER_DND_MIME);
        if (!transferItem) return;
        const draggedPaths = transferItem.value as string[];
        if (!Array.isArray(draggedPaths) || draggedPaths.length === 0) return;
        const folders = this.getFolders();

        // 既知のパスのみに絞り込み（外部からの偽データ対策）
        const movingSet = new Set(draggedPaths.filter(p => folders.includes(p)));
        if (movingSet.size === 0) return;

        // 並べ替え: target の位置に挿入。target=undefined（空白へドロップ）/ ドラッグ元に重なる場合は末尾。
        const reorder = (current: string[]): string[] => {
            const moving = current.filter(p => movingSet.has(p));
            const remaining = current.filter(p => !movingSet.has(p));
            let insertIndex = remaining.length;
            if (target && !movingSet.has(target.folderPath)) {
                const i = remaining.indexOf(target.folderPath);
                if (i >= 0) insertIndex = i;
            }
            return [...remaining.slice(0, insertIndex), ...moving, ...remaining.slice(insertIndex)];
        };

        // 変化なしなら何もしない
        const next = reorder(folders);
        if (next.every((p, i) => p === folders[i])) return;
        await this.mutateActive(reorder);
    }

    async addFolder(): Promise<void> {
        if (!this.active) {
            const ok = await this.promptSetup();
            if (!ok || !this.active) return;
        }
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Notes Folder',
        });
        if (!result || result.length === 0) return;
        const folderPath = path.resolve(result[0].fsPath);
        if (this.getFolders().includes(folderPath)) {
            vscode.window.showInformationMessage('This folder is already registered.');
            return;
        }
        await this.mutateActive(notes => [...notes, folderPath]);
    }

    /** アクティブの一覧の Note（ツリー・移動先・全 note 掃除・flat 移行の対象） */
    getFolders(): string[] {
        if (!this.active) return [];
        return [...(this.states.get(this.active)?.doc?.notes || [])];
    }

    /** 登録した全一覧の Note の和集合（In-App リンク・viewer のリンク逆引き用。D10） */
    getAllFolders(): string[] {
        const seen = new Set<string>();
        const out: string[] = [];
        const order = this.active ? [this.active, ...this.registries.filter(r => r !== this.active)] : this.registries;
        for (const file of order) {
            for (const p of this.states.get(file)?.doc?.notes || []) {
                if (seen.has(p)) continue;
                seen.add(p);
                out.push(p);
            }
        }
        return out;
    }

    getRegistries(): string[] {
        return [...this.registries];
    }

    getActiveRegistry(): string | undefined {
        return this.active;
    }

    /** FR-NT-03: note タイトル変更後にツリーを再描画する (label が noteTitle を拾い直す) */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    async removeFolder(item: NotesFolderItem): Promise<void> {
        if (!this.getFolders().includes(item.folderPath)) return;
        await this.mutateActive(notes => notes.filter(p => p !== item.folderPath));
    }

    // ─── Notes 一覧ファイルの登録・作成・切替・解除 ───

    /** 一覧が無いとき: 既存を開くか新規作成するかを選ばせる（D5） */
    async promptSetup(): Promise<boolean> {
        const open = 'Add existing .fractal…';
        const create = 'Create new .fractal…';
        const pick = await vscode.window.showInformationMessage(
            'Choose a .fractal notes list, or create a new one.',
            { modal: true },
            open,
            create
        );
        if (pick === open) return this.openRegistry();
        if (pick === create) return this.createRegistry();
        return false;
    }

    /** 既存の一覧ファイルを登録してアクティブにする（取り込みはしない。D7） */
    async openRegistry(): Promise<boolean> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'Fractal notes list': ['fractal'] },
            title: 'Add existing .fractal',
        });
        if (!result || result.length === 0) return false;
        const file = path.resolve(result[0].fsPath);
        const r = readRegistry(file);
        if (!r.ok) {
            vscode.window.showErrorMessage(`${path.basename(file)}: ${r.error}`);
            return false;
        }
        if (!this.registries.includes(file)) {
            this.registries.push(file);
            this.watch(file);
        }
        this.states.set(file, { doc: r.doc });
        await this.setActive(file);
        return true;
    }

    /** 保存先と name を指定させて <name>.fractal を作り、登録してアクティブにする（D5） */
    async createRegistry(): Promise<boolean> {
        const dirPick = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select the folder to save the .fractal file in',
            openLabel: 'Save here',
        });
        if (!dirPick || dirPick.length === 0) return false;
        const dir = dirPick[0].fsPath;
        const name = await vscode.window.showInputBox({
            title: 'File name (<name>.fractal)',
            prompt: 'Letters, digits, "-" and "_"',
            placeHolder: 'work',
            validateInput: v => validateName(v) ?? undefined,
        });
        if (name === undefined) return false;
        let file: string;
        try {
            file = createRegistryFile(dir, name);
        } catch (e: any) {
            vscode.window.showErrorMessage(e instanceof RegistryExistsError ? `${e.message} Choose another name.` : String(e?.message || e));
            return false;
        }
        this.registries.push(file);
        this.reload(file, false);
        this.watch(file);
        await this.setActive(file);
        return true;
    }

    /** Notes Lists の行をクリック: その .fractal をアクティブにする */
    async activateRegistry(file: string): Promise<void> {
        if (!this.registries.includes(file) || file === this.active) return;
        await this.setActive(file);
    }

    /** 切替（quick pick: 登録済み + 既存を追加 + 新規作成） */
    async switchRegistry(): Promise<void> {
        type Item = vscode.QuickPickItem & { file?: string; action?: 'open' | 'create' };
        const items: Item[] = this.registries.map(file => this.registryPickItem(file));
        items.push(
            { label: '$(folder-opened) Add existing .fractal…', action: 'open' },
            { label: '$(new-file) Create new .fractal…', action: 'create' }
        );
        const pick = await vscode.window.showQuickPick(items, { title: 'Switch notes list', placeHolder: 'Select a notes list' });
        if (!pick) return;
        if (pick.action === 'open') { await this.openRegistry(); return; }
        if (pick.action === 'create') { await this.createRegistry(); return; }
        if (!pick.file) return;
        const st = this.states.get(pick.file);
        if (st?.error && !st.doc) {
            const remove = 'Remove from list';
            const ans = await vscode.window.showWarningMessage(`${path.basename(pick.file)}: ${st.error}`, remove);
            if (ans === remove) await this.unregister(pick.file);
            return;
        }
        await this.setActive(pick.file);
    }

    /** 解除（登録から外すだけ。ファイルは消さない。D8）。Notes Lists の行から呼ばれたらその .fractal を外す */
    async removeRegistry(item?: NotesListItem): Promise<void> {
        if (item && item.file) {
            await this.unregister(item.file);
            return;
        }
        if (this.registries.length === 0) return;
        type Item = vscode.QuickPickItem & { file?: string };
        const items: Item[] = this.registries.map(file => this.registryPickItem(file));
        const pick = await vscode.window.showQuickPick(items, {
            title: 'Remove notes list (the file is not deleted)',
            placeHolder: 'Select a notes list to remove from Fractal',
        });
        if (!pick || !pick.file) return;
        await this.unregister(pick.file);
    }

    dispose(): void {
        for (const w of this.watchers.values()) w.dispose();
        this.watchers.clear();
    }

    // ─── 内部 ───

    private registryPickItem(file: string): vscode.QuickPickItem & { file: string } {
        const st = this.states.get(file);
        return {
            label: `${file === this.active ? '$(check) ' : ''}${st?.error ? '$(warning) ' : ''}${path.basename(file)}`,
            detail: st?.error ? `${st.error} — ${file}` : file,
            file,
        };
    }

    /** Notes Lists ビュー用: 登録した .fractal とその状態 */
    getRegistryStates(): { file: string; active: boolean; error?: string }[] {
        return this.registries.map(file => ({ file, active: file === this.active, error: this.states.get(file)?.error }));
    }

    private async unregister(file: string): Promise<void> {
        this.registries = this.registries.filter(r => r !== file);
        this.states.delete(file);
        this.watchers.get(file)?.dispose();
        this.watchers.delete(file);
        await this.context.globalState.update(KEY_REGISTRIES, this.registries);
        if (this.active === file) {
            await this.setActive(this.registries[0]);
        } else {
            this.updateContext();
        }
    }

    private async setActive(file: string | undefined): Promise<void> {
        this.active = file;
        await this.context.globalState.update(KEY_REGISTRIES, this.registries);
        await this.context.globalState.update(KEY_ACTIVE, file);
        await this.writeLegacyMirror();
        this.updateContext();
        this._onDidChangeTreeData.fire(undefined);
    }

    /** アクティブの一覧ファイルの notes を変える。書けなければ警告してメモリは変えない（D9 / D11） */
    private async mutateActive(mutate: (notes: string[]) => string[]): Promise<void> {
        const file = this.active;
        if (!file) return;
        let doc: NotesRegistryDoc;
        try {
            doc = updateRegistryNotes(file, mutate);
        } catch (e: any) {
            vscode.window.showWarningMessage(`Could not update the notes list. ${e?.message || e}`);
            this.reload(file, true);
            return;
        }
        this.states.set(file, { doc });
        await this.writeLegacyMirror();
        this.updateDescription();
        this._onDidChangeTreeData.fire(undefined);
    }

    /** 旧 notesFolders にアクティブの notes を写す（アクティブが無い・一度も読めていないときは触らない — 旧の Note を消さない） */
    private async writeLegacyMirror(): Promise<void> {
        if (!this.active || !this.states.get(this.active)?.doc) return;
        await this.context.globalState.update(KEY_LEGACY, this.getFolders());
    }

    /** ディスクから読み直す。読めなければ最後の中身を残して error を立てる（D11） */
    private reload(file: string, notify: boolean): void {
        const r = readRegistry(file);
        const prev = this.states.get(file);
        if (r.ok) {
            this.states.set(file, { doc: r.doc });
        } else {
            this.states.set(file, { doc: prev?.doc, error: r.error });
            if (notify && !prev?.error) {
                vscode.window.showWarningMessage(`${path.basename(file)}: ${r.error} Changes are not saved until it is fixed.`);
            }
        }
    }

    private watch(file: string): void {
        if (this.watchers.has(file) || typeof vscode.workspace.createFileSystemWatcher !== 'function') return;
        const w = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file))
        );
        const onChange = () => {
            this.reload(file, true);
            if (file === this.active) {
                void this.writeLegacyMirror();
                this._onDidChangeTreeData.fire(undefined);
            }
            this.updateDescription();
        };
        w.onDidChange(onChange);
        w.onDidCreate(onChange);
        w.onDidDelete(onChange);
        this.watchers.set(file, w);
    }

    private updateContext(): void {
        void vscode.commands.executeCommand('setContext', CTX_HAS_REGISTRY, !!this.active);
        this.updateDescription();
    }

    private updateDescription(): void {
        this.lists.refresh();
        if (!this.treeView) return;
        const st = this.active ? this.states.get(this.active) : undefined;
        this.treeView.description = this.active ? `${st?.error ? '⚠ ' : ''}${path.basename(this.active)}` : undefined;
    }
}

/** Notes Lists ビュー（上）: 登録した .fractal を出す。クリックで切替、行の ✕ で解除 */
export class NotesListsProvider implements vscode.TreeDataProvider<NotesListItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<NotesListItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly folders: NotesFolderProvider) {}

    getTreeItem(element: NotesListItem): vscode.TreeItem {
        return element;
    }

    getChildren(): NotesListItem[] {
        return this.folders.getRegistryStates().map(s => new NotesListItem(s.file, s.active, s.error));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }
}

export class NotesListItem extends vscode.TreeItem {
    constructor(public readonly file: string, active: boolean, error?: string) {
        super(path.basename(file), vscode.TreeItemCollapsibleState.None);
        this.description = active ? '●' : undefined;
        this.tooltip = error ? `${error}\n${file}` : file;
        this.contextValue = 'notesList';
        this.iconPath = new vscode.ThemeIcon(error ? 'warning' : active ? 'check' : 'file');
        this.command = { command: 'fractal.activateNotesRegistry', title: 'Switch Notes List', arguments: [file] };
    }
}

export class NotesFolderItem extends vscode.TreeItem {
    public readonly folderPath: string;

    constructor(folderPath: string) {
        // FR-NT-03: noteTitle があれば表示名に使う (無ければフォルダ名)
        super(resolveNoteLabel(folderPath), vscode.TreeItemCollapsibleState.None);
        this.folderPath = folderPath;
        this.tooltip = folderPath;
        this.contextValue = 'notesFolder';
        this.command = {
            command: 'fractal.openNotesFolder',
            title: 'Open Notes',
            arguments: [folderPath],
        };
        this.iconPath = new vscode.ThemeIcon('notebook');
    }
}
