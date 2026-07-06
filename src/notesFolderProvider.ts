import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

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
 * NotesFolderProvider — Activity Bar の Notes フォルダ一覧を提供する TreeDataProvider
 * globalState でフォルダ一覧を永続化
 *
 * D&D 並べ替え対応: TreeDragAndDropController を実装し、ツリー上でフォルダを掴んで
 * 並べ替えると this.folders 配列の順序を更新して globalState に保存する。
 */
const NOTES_FOLDER_DND_MIME = 'application/vnd.fractal.notes-folder';

export class NotesFolderProvider
    implements vscode.TreeDataProvider<NotesFolderItem>, vscode.TreeDragAndDropController<NotesFolderItem>
{
    private _onDidChangeTreeData = new vscode.EventEmitter<NotesFolderItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    readonly dragMimeTypes = [NOTES_FOLDER_DND_MIME];
    readonly dropMimeTypes = [NOTES_FOLDER_DND_MIME];

    private folders: string[] = [];

    constructor(private context: vscode.ExtensionContext) {
        this.folders = context.globalState.get<string[]>('notesFolders', []);
    }

    getTreeItem(element: NotesFolderItem): vscode.TreeItem {
        return element;
    }

    getChildren(): NotesFolderItem[] {
        return this.folders.map(f => new NotesFolderItem(f));
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

        // 既知のパスのみに絞り込み（外部からの偽データ対策）
        const movingSet = new Set(draggedPaths.filter(p => this.folders.includes(p)));
        if (movingSet.size === 0) return;

        // 並べ替え: target の位置に挿入。target=undefined（空白へドロップ）なら末尾。
        const remaining = this.folders.filter(p => !movingSet.has(p));
        let insertIndex: number;
        if (target && !movingSet.has(target.folderPath)) {
            insertIndex = remaining.indexOf(target.folderPath);
            if (insertIndex < 0) insertIndex = remaining.length;
        } else if (target && movingSet.has(target.folderPath)) {
            // ドラッグ元に重なる場合は末尾扱い
            insertIndex = remaining.length;
        } else {
            insertIndex = remaining.length;
        }

        // 元の順序を保ったまま挿入
        const orderedMoving = this.folders.filter(p => movingSet.has(p));
        const next = [...remaining.slice(0, insertIndex), ...orderedMoving, ...remaining.slice(insertIndex)];

        // 変化なしなら何もしない
        if (next.length === this.folders.length && next.every((p, i) => p === this.folders[i])) {
            return;
        }

        this.folders = next;
        await this.context.globalState.update('notesFolders', this.folders);
        this._onDidChangeTreeData.fire(undefined);
    }

    async addFolder(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Select Notes Folder',
        });
        if (!result || result.length === 0) return;
        const folderPath = result[0].fsPath;
        if (this.folders.includes(folderPath)) {
            vscode.window.showInformationMessage('This folder is already registered.');
            return;
        }
        this.folders.push(folderPath);
        await this.context.globalState.update('notesFolders', this.folders);
        this._onDidChangeTreeData.fire(undefined);
    }

    getFolders(): string[] {
        return [...this.folders];
    }

    /** FR-NT-03: note タイトル変更後にツリーを再描画する (label が noteTitle を拾い直す) */
    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    async removeFolder(item: NotesFolderItem): Promise<void> {
        const idx = this.folders.indexOf(item.folderPath);
        if (idx >= 0) {
            this.folders.splice(idx, 1);
            await this.context.globalState.update('notesFolders', this.folders);
            this._onDidChangeTreeData.fire(undefined);
        }
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
