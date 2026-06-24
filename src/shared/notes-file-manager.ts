import * as fs from 'fs';
import * as path from 'path';

export interface NotesFileEntry {
    filePath: string;
    title: string;
    id: string;
}

// ── .note 構造管理 ──

export interface NoteTreeFile {
    type: 'file';
    id: string;        // ファイル名（拡張子なし）
    title: string;     // 表示タイトル（.outのtitleと同期）
    color?: string;    // v11: Tailwind palette name ('red', 'orange', ..., 'zinc') or undefined
    ext?: 'out' | 'md'; // v0.207.75: ファイル拡張子。省略時は 'out' (back-compat). ADR-008
}

export interface NoteTreeFolder {
    type: 'folder';
    id: string;        // フォルダ固有ID
    title: string;     // フォルダ名
    childIds: string[]; // 子アイテムID（順序付き）
    collapsed: boolean;
    color?: string;    // v11: Tailwind palette name or undefined
}

export type NoteTreeItem = NoteTreeFile | NoteTreeFolder;

export interface NoteStructure {
    version: number;
    rootIds: string[];                    // トップレベルの順序
    items: Record<string, NoteTreeItem>;  // 全アイテムのマップ
    panelWidth?: number;                  // 左パネル幅 (px)
    sidePanelWidth?: number;              // ノート全体共通の sidepanel md 幅 (px)
    sidePanelOutlineWidth?: number;       // ノート全体共通の sidepanel TOC 幅 (px)
    s3BucketPath?: string;                // S3バケットパス (例: "my-bucket/notes-backup")
    favorites?: string[];                 // v0.207.36: お気に入り outliner ID 配列 (NoteTreeFile.id を参照、順序維持)
}

// ── 検索関連 ──

export interface SearchResult {
    fileId: string;
    fileTitle: string;
    fileType: 'out' | 'md';
    matches: SearchMatch[];
    parentOutFileId?: string;  // pages .md の場合、親.outのfileId
    pageId?: string;           // pages .md の場合、pageId
    mdFilePath?: string;       // ルート直下.mdのフルパス
    parentNodeText?: string;   // pages .md の場合、ページが紐づくノード名
}

export interface SearchMatch {
    nodeId?: string;
    field: 'text' | 'subtext' | 'content';
    lineText: string;
    matchStart: number;
    matchEnd: number;
    lineNumber?: number;  // .mdファイルの行番号 (0-based)
}

export interface SearchOptions {
    caseSensitive: boolean;
    wholeWord: boolean;
    useRegex: boolean;
}

/**
 * Notes 共通ファイルマネージャ
 * .outファイルのCRUD、pageDir解決、デバウンス保存を管理
 * .noteファイルによるフォルダ/ツリー構造管理
 * VSCode拡張・Electron の両方で使用可能（純粋 Node.js fs + path のみ）
 */
export class NotesFileManager {
    private mainFolderPath: string;
    private currentFilePath: string | null = null;
    private isDirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private lastJsonString: string | null = null;
    private structure: NoteStructure | null = null;
    private fileChangeId = 0;
    private isWriting = false;
    private isWritingTimer: ReturnType<typeof setTimeout> | null = null;
    private isWritingStructure = false;
    private isWritingStructureTimer: ReturnType<typeof setTimeout> | null = null;

    private static SAVE_DEBOUNCE_MS = 1000;

    // v0.207.76: Markdown ファイル用の仮想 outliner フォルダ
    // mainFolderPath/_notes_md/ 配下に <id>.md を直接配置し、
    // images/ files/ サブディレクトリだけを補助的に持つ。"_notes_md" は予約名。
    // v0.207.82: _notes_md/pages/<id>.md → _notes_md/<id>.md にフラット化。
    //            md ファイル側から見た相対パスが ./images/xxx.png となるよう統一。
    static MD_VIRTUAL_DIR = '_notes_md';
    static MD_IMAGES_SUBDIR = 'images';
    static MD_FILES_SUBDIR = 'files';

    constructor(mainFolderPath: string) {
        this.mainFolderPath = mainFolderPath;
    }

    getMainFolderPath(): string { return this.mainFolderPath; }

    // ── v0.207.76: Markdown 仮想フォルダのパス解決 ──
    getMdRootDirPath(): string {
        return path.join(this.mainFolderPath, NotesFileManager.MD_VIRTUAL_DIR);
    }
    getMdImagesDirPath(): string {
        return path.join(this.getMdRootDirPath(), NotesFileManager.MD_IMAGES_SUBDIR);
    }
    getMdFilesDirPath(): string {
        return path.join(this.getMdRootDirPath(), NotesFileManager.MD_FILES_SUBDIR);
    }
    getMdFilePath(id: string): string {
        // v0.207.82: フラット化 — _notes_md/<id>.md
        return path.join(this.getMdRootDirPath(), `${id}.md`);
    }
    private ensureMdDirs(): void {
        try {
            fs.mkdirSync(this.getMdRootDirPath(), { recursive: true });
            fs.mkdirSync(this.getMdImagesDirPath(), { recursive: true });
            fs.mkdirSync(this.getMdFilesDirPath(), { recursive: true });
        } catch (e) {
            console.error('[NotesFileManager] ensureMdDirs error:', e);
        }
    }
    getCurrentFilePath(): string | null { return this.currentFilePath; }
    isDirtyState(): boolean { return this.isDirty; }
    getFileChangeId(): number { return this.fileChangeId; }
    getIsWriting(): boolean { return this.isWriting; }
    getIsWritingStructure(): boolean { return this.isWritingStructure; }
    getLastKnownContent(): string | null { return this.lastJsonString; }

    /**
     * 外部変更検知時に呼び出す。lastJsonStringを更新し、
     * 残っているデバウンスタイマーを停止する（古いデータの書き戻しを防止）。
     */
    updateLastKnownContent(jsonString: string): void {
        this.lastJsonString = jsonString;
        this.isDirty = false;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }

    /**
     * 構造キャッシュを無効化する。外部変更検知時に呼び出す。
     */
    invalidateStructureCache(): void {
        this.structure = null;
    }

    /**
     * outline.note の最後の既知内容を取得する（内容比較用）。
     */
    getLastKnownStructureContent(): string | null {
        if (!this.structure) return null;
        return JSON.stringify(this.structure, null, 2);
    }

    /**
     * 外部変更検知後に outline.note の最後の既知内容を更新する。
     */
    updateLastKnownStructureContent(content: string): void {
        try {
            this.structure = JSON.parse(content);
        } catch {
            // パースエラーは無視
        }
    }

    // ── outline.note 構造管理 ──

    private getNoteFilePath(): string {
        return path.join(this.mainFolderPath, 'outline.note');
    }

    private static generateItemId(): string {
        return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /**
     * outline.note ファイルを読み込み、ディスク上の .out と同期する
     * outline.note が存在しない場合は全 .out からフラット構造を自動生成
     * 旧 .note が存在する場合は自動マイグレーション
     */
    loadStructure(): NoteStructure {
        if (this.structure) return this.structure;

        const noteFilePath = this.getNoteFilePath();

        // マイグレーション: 旧 .note → outline.note
        if (!fs.existsSync(noteFilePath)) {
            const legacyPath = path.join(this.mainFolderPath, '.note');
            if (fs.existsSync(legacyPath)) {
                try {
                    fs.renameSync(legacyPath, noteFilePath);
                    console.log('[NotesFileManager] Migrated .note → outline.note');
                } catch (e) {
                    console.error('[NotesFileManager] Migration .note → outline.note failed:', e);
                }
            }
        }

        let structure: NoteStructure;

        if (fs.existsSync(noteFilePath)) {
            try {
                const content = fs.readFileSync(noteFilePath, 'utf8');
                structure = JSON.parse(content);
            } catch {
                structure = { version: 1, rootIds: [], items: {} };
            }
        } else {
            structure = { version: 1, rootIds: [], items: {} };
        }

        // v0.207.76 / v0.207.82: 旧配置を _notes_md/<id>.md (フラット) に集約
        // (a) 旧 flat 配置 <mainFolderPath>/<id>.md
        // (b) v0.207.76 配置 _notes_md/pages/<id>.md
        try {
            let didMigrate = false;
            const legacyPagesDir = path.join(this.getMdRootDirPath(), 'pages');
            for (const [id, item] of Object.entries(structure.items)) {
                if (item.type !== 'file' || item.ext !== 'md') continue;
                const newPath = this.getMdFilePath(id);
                if (fs.existsSync(newPath)) continue;
                // (a) <mainFolderPath>/<id>.md
                const oldFlatPath = path.join(this.mainFolderPath, `${id}.md`);
                // (b) _notes_md/pages/<id>.md
                const oldPagesPath = path.join(legacyPagesDir, `${id}.md`);
                let src: string | null = null;
                if (fs.existsSync(oldPagesPath)) src = oldPagesPath;
                else if (fs.existsSync(oldFlatPath)) src = oldFlatPath;
                if (!src) continue;
                this.ensureMdDirs();
                try {
                    fs.renameSync(src, newPath);
                    didMigrate = true;
                    console.log('[NotesFileManager] Migrated md:', src, '→', newPath);
                } catch (e) {
                    console.error('[NotesFileManager] md migration failed for', id, e);
                }
            }
            // legacy pages/ ディレクトリが空になっていれば削除
            try {
                if (fs.existsSync(legacyPagesDir)) {
                    const remaining = fs.readdirSync(legacyPagesDir);
                    if (remaining.length === 0) {
                        fs.rmdirSync(legacyPagesDir);
                        console.log('[NotesFileManager] Removed empty legacy', legacyPagesDir);
                    }
                }
            } catch (e) {
                console.error('[NotesFileManager] legacy pages/ cleanup error:', e);
            }
            if (didMigrate) {
                console.log('[NotesFileManager] _notes_md/ migration complete');
            }
        } catch (e) {
            console.error('[NotesFileManager] _notes_md migration error:', e);
        }

        // ディスク上の .out と同期
        this.syncStructureWithDisk(structure);
        this.structure = structure;
        this.saveStructure();
        return structure;
    }

    /**
     * .note 構造をディスク上の .out ファイルと同期
     * - 孤児 .out（.noteに未登録）→ rootIds末尾に追加
     * - 欠損 .out（.noteにあるがディスクにない）→ 削除
     */
    private syncStructureWithDisk(structure: NoteStructure): void {
        // ディスク上の .out / .md ファイルをスキャン
        const diskOutFiles = new Map<string, string>(); // id → title
        const diskMdIds = new Set<string>();             // id (登録済みのみ意味あり)
        let allEntries: string[] = [];
        try {
            allEntries = fs.readdirSync(this.mainFolderPath);
        } catch { /* ignore */ }
        for (const entry of allEntries) {
            const filePath = path.join(this.mainFolderPath, entry);
            try {
                if (!fs.statSync(filePath).isFile()) continue;
            } catch { continue; }
            if (entry.endsWith('.out')) {
                const id = entry.replace(/\.out$/, '');
                let title = 'Untitled';
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const data = JSON.parse(content);
                    if (data.title) title = data.title;
                } catch { /* use default */ }
                diskOutFiles.set(id, title);
            }
        }
        // v0.207.82: .md は _notes_md/ 直下をスキャン (フラット化)
        try {
            const mdRoot = this.getMdRootDirPath();
            if (fs.existsSync(mdRoot)) {
                for (const entry of fs.readdirSync(mdRoot)) {
                    if (!entry.endsWith('.md')) continue;
                    const filePath = path.join(mdRoot, entry);
                    try {
                        if (!fs.statSync(filePath).isFile()) continue;
                    } catch { continue; }
                    diskMdIds.add(entry.replace(/\.md$/, ''));
                }
            }
        } catch { /* ignore */ }

        // 構造内の全 file アイテムIDを収集
        const structureFileIds = new Set<string>();
        for (const [id, item] of Object.entries(structure.items)) {
            if (item.type === 'file') {
                structureFileIds.add(id);
            }
        }

        // 孤児 .out → rootIds末尾に追加
        for (const [id, title] of diskOutFiles) {
            if (!structureFileIds.has(id)) {
                structure.items[id] = { type: 'file', id, title };
                structure.rootIds.push(id);
            } else {
                // タイトル同期 (out のみ; md は manifest が真)
                const item = structure.items[id];
                if (item && item.type === 'file' && (item.ext ?? 'out') === 'out') {
                    item.title = title;
                }
            }
        }

        // 欠損ファイル → 構造から削除
        // ext === 'md' なら .md の存在を、それ以外は .out の存在を確認
        const toRemove: string[] = [];
        for (const [id, item] of Object.entries(structure.items)) {
            if (item.type !== 'file') continue;
            const ext = item.ext ?? 'out';
            if (ext === 'md') {
                if (!diskMdIds.has(id)) toRemove.push(id);
            } else {
                if (!diskOutFiles.has(id)) toRemove.push(id);
            }
        }
        for (const id of toRemove) {
            this.removeItemFromStructure(structure, id);
        }

        // rootIds の整合性チェック（存在しないIDを除去）
        structure.rootIds = structure.rootIds.filter(id => id in structure.items);
    }

    /**
     * 構造からアイテムを削除（rootIds・親の childIds から除去）
     */
    private removeItemFromStructure(structure: NoteStructure, itemId: string): void {
        // rootIds から除去
        const rootIdx = structure.rootIds.indexOf(itemId);
        if (rootIdx !== -1) structure.rootIds.splice(rootIdx, 1);

        // 親フォルダの childIds から除去
        for (const item of Object.values(structure.items)) {
            if (item.type === 'folder') {
                const idx = item.childIds.indexOf(itemId);
                if (idx !== -1) item.childIds.splice(idx, 1);
            }
        }

        // フォルダの場合、子を親に移動
        const target = structure.items[itemId];
        if (target && target.type === 'folder') {
            const parentId = this.findParentId(structure, itemId);
            if (parentId) {
                const parent = structure.items[parentId] as NoteTreeFolder;
                const idx = parent.childIds.indexOf(itemId);
                // 子を親の同じ位置に挿入
                parent.childIds.splice(idx, 0, ...target.childIds);
            } else {
                const idx = structure.rootIds.indexOf(itemId);
                const insertAt = idx !== -1 ? idx : structure.rootIds.length;
                structure.rootIds.splice(insertAt, 0, ...target.childIds);
            }
        }

        delete structure.items[itemId];
    }

    /**
     * アイテムの親フォルダIDを探す（ルートなら null）
     */
    private findParentId(structure: NoteStructure, itemId: string): string | null {
        for (const [id, item] of Object.entries(structure.items)) {
            if (item.type === 'folder' && item.childIds.includes(itemId)) {
                return id;
            }
        }
        return null;
    }

    /**
     * outline.note ファイルに構造を書き込む
     */
    saveStructure(): void {
        if (!this.structure) return;
        try {
            this.isWritingStructure = true;
            fs.writeFileSync(this.getNoteFilePath(), JSON.stringify(this.structure, null, 2), 'utf8');
            if (this.isWritingStructureTimer) clearTimeout(this.isWritingStructureTimer);
            this.isWritingStructureTimer = setTimeout(() => {
                this.isWritingStructure = false;
                this.isWritingStructureTimer = null;
            }, 300);
        } catch (e) {
            this.isWritingStructure = false;
            console.error('[NotesFileManager] saveStructure error:', e);
        }
    }

    /**
     * v0.207.36: お気に入り outliner ID 一覧を取得 (順序維持)
     */
    getFavorites(): string[] {
        const arr = this.getStructure().favorites;
        return Array.isArray(arr) ? arr.slice() : [];
    }

    /**
     * v0.207.36: お気に入りを toggle (存在すれば削除、無ければ末尾追加)。返り値は更新後の状態
     */
    toggleFavorite(fileId: string): { favorites: string[]; isFavorited: boolean } {
        const structure = this.getStructure();
        const favs = Array.isArray(structure.favorites) ? structure.favorites.slice() : [];
        const idx = favs.indexOf(fileId);
        let isFavorited;
        if (idx >= 0) {
            favs.splice(idx, 1);
            isFavorited = false;
        } else {
            favs.push(fileId);
            isFavorited = true;
        }
        structure.favorites = favs;
        this.saveStructure();
        return { favorites: favs, isFavorited };
    }

    /**
     * v0.207.36: 指定 outliner が favorite かどうか
     */
    isFavorited(fileId: string): boolean {
        const arr = this.getStructure().favorites;
        return Array.isArray(arr) && arr.indexOf(fileId) >= 0;
    }

    /**
     * 左パネル幅を outline.note に保存
     */
    savePanelWidth(width: number): void {
        const structure = this.getStructure();
        structure.panelWidth = width;
        this.saveStructure();
    }

    /**
     * 左パネル幅を取得
     */
    getPanelWidth(): number | undefined {
        return this.getStructure().panelWidth;
    }

    /**
     * ノート共通の sidepanel md 幅を outline.note に保存
     */
    saveSidePanelWidth(width: number): void {
        const structure = this.getStructure();
        structure.sidePanelWidth = width;
        this.saveStructure();
    }

    getSidePanelWidth(): number | undefined {
        return this.getStructure().sidePanelWidth;
    }

    /**
     * ノート共通の sidepanel TOC 幅を outline.note に保存
     */
    saveSidePanelOutlineWidth(width: number): void {
        const structure = this.getStructure();
        structure.sidePanelOutlineWidth = width;
        this.saveStructure();
    }

    getSidePanelOutlineWidth(): number | undefined {
        return this.getStructure().sidePanelOutlineWidth;
    }

    /**
     * S3バケットパスを outline.note に保存
     */
    saveS3BucketPath(bucketPath: string): void {
        const structure = this.getStructure();
        structure.s3BucketPath = bucketPath;
        this.saveStructure();
    }

    /**
     * S3バケットパスを取得
     */
    getS3BucketPath(): string | undefined {
        return this.getStructure().s3BucketPath;
    }

    /**
     * 現在の構造を取得（ロード済みならキャッシュ利用）
     */
    getStructure(): NoteStructure {
        return this.structure || this.loadStructure();
    }

    /**
     * フォルダ作成
     * afterId 指定時は、その兄弟リストにおいて afterId の直後に挿入する。
     * afterId が見つからない、または指定なしの場合は parentId 配下の先頭に挿入する。
     */
    createFolder(title: string, parentId?: string | null, afterId?: string | null): NoteStructure {
        const structure = this.getStructure();
        const id = NotesFileManager.generateItemId();
        structure.items[id] = { type: 'folder', id, title, childIds: [], collapsed: false };

        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;

        const insertIdx = afterId ? siblings.indexOf(afterId) : -1;
        if (insertIdx !== -1) {
            siblings.splice(insertIdx + 1, 0, id);
        } else {
            siblings.unshift(id);
        }

        this.saveStructure();
        return structure;
    }

    /**
     * フォルダ削除（中身は親レベルに移動）
     */
    deleteFolder(folderId: string): NoteStructure {
        const structure = this.getStructure();
        const folder = structure.items[folderId];
        if (!folder || folder.type !== 'folder') return structure;

        this.removeItemFromStructure(structure, folderId);
        this.saveStructure();
        return structure;
    }

    /**
     * フォルダ名変更
     */
    renameFolder(folderId: string, newTitle: string): NoteStructure {
        const structure = this.getStructure();
        const folder = structure.items[folderId];
        if (folder && folder.type === 'folder') {
            folder.title = newTitle;
            this.saveStructure();
        }
        return structure;
    }

    /**
     * フォルダの展開/折りたたみ切替
     */
    toggleFolderCollapsed(folderId: string): NoteStructure {
        const structure = this.getStructure();
        const folder = structure.items[folderId];
        if (folder && folder.type === 'folder') {
            folder.collapsed = !folder.collapsed;
            this.saveStructure();
        }
        return structure;
    }

    /**
     * アイテム移動（D&D）
     * @param itemId 移動するアイテム
     * @param targetParentId 移動先の親フォルダID（null=ルート）
     * @param index 挿入位置
     */
    moveItem(itemId: string, targetParentId: string | null, index: number): NoteStructure {
        const structure = this.getStructure();
        if (!structure.items[itemId]) return structure;

        // 循環参照チェック: フォルダを自身の子孫に移動しない
        if (targetParentId && this.isDescendant(structure, itemId, targetParentId)) {
            return structure;
        }

        // 現在の親から除去
        const currentParentId = this.findParentId(structure, itemId);
        if (currentParentId) {
            const parent = structure.items[currentParentId] as NoteTreeFolder;
            const idx = parent.childIds.indexOf(itemId);
            if (idx !== -1) parent.childIds.splice(idx, 1);
        } else {
            const idx = structure.rootIds.indexOf(itemId);
            if (idx !== -1) structure.rootIds.splice(idx, 1);
        }

        // 新しい親に挿入
        if (targetParentId && structure.items[targetParentId]?.type === 'folder') {
            const parent = structure.items[targetParentId] as NoteTreeFolder;
            const safeIndex = Math.min(index, parent.childIds.length);
            parent.childIds.splice(safeIndex, 0, itemId);
        } else {
            const safeIndex = Math.min(index, structure.rootIds.length);
            structure.rootIds.splice(safeIndex, 0, itemId);
        }

        this.saveStructure();
        return structure;
    }

    /**
     * itemId が targetId の子孫かどうか判定（循環参照防止）
     */
    private isDescendant(structure: NoteStructure, ancestorId: string, targetId: string): boolean {
        const item = structure.items[ancestorId];
        if (!item || item.type !== 'folder') return false;

        const stack = [...item.childIds];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (id === targetId) return true;
            const child = structure.items[id];
            if (child && child.type === 'folder') {
                stack.push(...child.childIds);
            }
        }
        return false;
    }

    // ── 既存ファイル操作（.note同期付き） ──

    /**
     * メインフォルダ内の .out ファイル一覧を返す
     * 各ファイルのJSON内 title を読み取って表示名とする
     */
    listFiles(): NotesFileEntry[] {
        try {
            const entries = fs.readdirSync(this.mainFolderPath);
            const result: NotesFileEntry[] = [];
            // .out ファイル
            for (const entry of entries) {
                if (!entry.endsWith('.out')) continue;
                const filePath = path.join(this.mainFolderPath, entry);
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) continue;
                const id = entry.replace(/\.out$/, '');
                let title = 'Untitled';
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const data = JSON.parse(content);
                    if (data.title) title = data.title;
                } catch {
                    // JSON parse failure — use default title
                }
                result.push({ filePath, title, id });
            }
            // v0.207.82: .md ファイル — _notes_md/ 直下から、outline.note 構造に登録された ID のみ列挙 (フラット化)
            const structure = this.getStructure();
            const mdRoot = this.getMdRootDirPath();
            if (fs.existsSync(mdRoot)) {
                for (const entry of fs.readdirSync(mdRoot)) {
                    if (!entry.endsWith('.md')) continue;
                    const id = entry.replace(/\.md$/, '');
                    const item = structure.items[id];
                    if (!item || item.type !== 'file' || item.ext !== 'md') continue;
                    const filePath = path.join(mdRoot, entry);
                    try {
                        if (!fs.statSync(filePath).isFile()) continue;
                    } catch { continue; }
                    result.push({ filePath, title: item.title || id, id });
                }
            }
            result.sort((a, b) => a.title.localeCompare(b.title));
            return result;
        } catch (e) {
            console.error('[NotesFileManager] listFiles error:', e);
            return [];
        }
    }

    /**
     * .out / .md ファイルを開いて中身を返す
     * .out → JSON 文字列 (parseable)
     * .md  → raw markdown text
     * currentFilePathを更新する
     */
    openFile(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (filePath.endsWith('.md')) {
                // Markdown: validate only existence, no JSON parse
            } else {
                JSON.parse(content); // validate
            }
            this.currentFilePath = filePath;
            this.isDirty = false;
            this.lastJsonString = content;
            this.fileChangeId++;
            return content;
        } catch (e) {
            console.error('[NotesFileManager] openFile error:', e);
            return null;
        }
    }

    /**
     * デバウンス付き保存 (1秒後に書き込み)
     */
    saveCurrentFile(jsonString: string): void {
        // v0.207.39: 診断 log — 誰が saveCurrentFile を呼んだか
        console.log('[NotesFileManager] saveCurrentFile size=', jsonString.length, 'B at', new Date().toISOString(), 'stack:', new Error().stack);
        this.lastJsonString = jsonString;
        this.isDirty = true;

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this._writeFile(jsonString);
        }, NotesFileManager.SAVE_DEBOUNCE_MS);
    }

    /**
     * 即座に保存 (ウィンドウ閉じ時等)
     */
    saveCurrentFileImmediate(jsonString?: string): void {
        const toSave = jsonString || this.lastJsonString;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (toSave) {
            this._writeFile(toSave);
        }
    }

    /**
     * デバウンスタイマーをフラッシュ (保存待ちがあれば即実行)
     */
    flushSave(): void {
        if (this.saveTimer && this.lastJsonString) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            this._writeFile(this.lastJsonString);
        }
    }

    private _writeFile(jsonString: string): void {
        if (!this.currentFilePath) return;
        // BUG FIX: 内容が disk と byte 一致なら書かない (mtime 不変を保証)
        // outliner-toolbar-s3-sync の sync 判定が mtime に依存するため、内容変更なしの
        // wasteful 書込で mtime が NOW に更新されると、別マシンで真に編集された S3 側より
        // local が新しく見えて誤って upload してしまう。
        // 注意: byte 比較のみ。semantic equal (parse + deep equal) は採用しない。
        // 「内容が違うのに skip して local の更新漏れが起きる」リスクを避けるため。
        // formatting 差で毎回 write する場合は、上位の sync 経路 (preFlushLocalInfo + 毎回確認 dialog) で safety net を取る。
        try {
            const existing = fs.readFileSync(this.currentFilePath, 'utf8');
            if (existing === jsonString) {
                this.isDirty = false;
                return;
            }
        } catch {
            // disk に未存在 (新規ファイル等) → そのまま書く
        }
        try {
            this.isWriting = true;
            // v0.207.39: 診断 log
            const stack = new Error().stack;
            console.log('[NotesFileManager] _writeFile to', this.currentFilePath, 'size=', jsonString.length, 'B at', new Date().toISOString());
            console.log('[NotesFileManager] _writeFile stack:', stack);
            fs.writeFileSync(this.currentFilePath, jsonString, 'utf8');
            this.isDirty = false;
            // FileSystemWatcherの発火タイミングを考慮し、遅延でフラグをリセット
            if (this.isWritingTimer) clearTimeout(this.isWritingTimer);
            this.isWritingTimer = setTimeout(() => {
                this.isWriting = false;
                this.isWritingTimer = null;
            }, 300);
        } catch (e) {
            this.isWriting = false;
            console.error('[NotesFileManager] write error:', e);
        }
    }

    /**
     * pageDir解決: JSON内のpageDirフィールドを優先、なければデフォルト ./pages
     */
    getPagesDirPath(outJsonData?: Record<string, unknown>): string {
        if (outJsonData && outJsonData.pageDir) {
            const pd = outJsonData.pageDir as string;
            if (path.isAbsolute(pd)) return pd;
            if (this.currentFilePath) {
                return path.resolve(path.dirname(this.currentFilePath), pd);
            }
        }

        if (this.currentFilePath) {
            try {
                const content = fs.readFileSync(this.currentFilePath, 'utf8');
                const data = JSON.parse(content);
                if (data.pageDir) {
                    if (path.isAbsolute(data.pageDir)) return data.pageDir;
                    return path.resolve(path.dirname(this.currentFilePath), data.pageDir);
                }
            } catch {
                // fallthrough
            }
            // Notes mode default: ./<basename> (Notes-created files have pageDir
            // explicit via createFile; legacy / dailynotes.out without pageDir
            // 用 fallback も <basename> で self-contained 構造を実現)
            const outlinerId = path.basename(this.currentFilePath, '.out');
            return path.resolve(path.dirname(this.currentFilePath), outlinerId);
        }

        return path.join(this.mainFolderPath, 'pages');
    }

    /**
     * ページファイルのフルパスを返す
     */
    getPageFilePath(pageId: string, outJsonData?: Record<string, unknown>): string {
        return path.join(this.getPagesDirPath(outJsonData), `${pageId}.md`);
    }

    /**
     * fileDir解決: JSON内のfileDirフィールドを優先、なければデフォルト ./files
     */
    getFileDirPath(outJsonData?: Record<string, unknown>): string {
        if (outJsonData && outJsonData.fileDir) {
            const fd = outJsonData.fileDir as string;
            if (path.isAbsolute(fd)) return fd;
            if (this.currentFilePath) {
                return path.resolve(path.dirname(this.currentFilePath), fd);
            }
        }

        if (this.currentFilePath) {
            try {
                const content = fs.readFileSync(this.currentFilePath, 'utf8');
                const data = JSON.parse(content);
                if (data.fileDir) {
                    if (path.isAbsolute(data.fileDir)) return data.fileDir;
                    return path.resolve(path.dirname(this.currentFilePath), data.fileDir);
                }
            } catch {
                // fallthrough
            }
            // Notes mode default: {mainFolderPath}/{outlinerId}/files
            // Same pattern as importFilesDialog in notesEditorProvider.ts
            const outlinerId = path.basename(this.currentFilePath, '.out');
            return path.join(this.mainFolderPath, outlinerId, 'files');
        }

        return path.join(this.mainFolderPath, 'files');
    }

    /**
     * 一意のアウトラインIDを生成
     */
    static generateOutlineId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    /**
     * 新規 .out ファイルを作成しファイルパスを返す
     * ページフォルダも同時に作成、.note構造にも追加
     * afterId 指定時は、その兄弟リストにおいて afterId の直後に挿入する。
     */
    createFile(title: string, parentId?: string | null, afterId?: string | null): string {
        const id = NotesFileManager.generateOutlineId();
        const filePath = path.join(this.mainFolderPath, `${id}.out`);
        const pageDir = `./${id}`;
        const pageDirAbs = path.join(this.mainFolderPath, id);

        const firstNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const data = {
            title: title || 'Untitled',
            pageDir: pageDir,
            rootIds: [firstNodeId],
            nodes: {
                [firstNodeId]: {
                    id: firstNodeId,
                    text: '',
                    childIds: [],
                    collapsed: false,
                },
            } as Record<string, unknown>,
        };

        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        fs.mkdirSync(pageDirAbs, { recursive: true });

        // .note 構造に追加
        const structure = this.getStructure();
        structure.items[id] = { type: 'file', id, title: title || 'Untitled' };

        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;
        const insertIdx = afterId ? siblings.indexOf(afterId) : -1;
        if (insertIdx !== -1) {
            siblings.splice(insertIdx + 1, 0, id);
        } else {
            siblings.unshift(id);
        }

        this.saveStructure();

        return filePath;
    }

    /**
     * v0.207.75 (ADR-008) / v0.207.82: 新規 Markdown ファイル (.md) を作成し、構造に登録する
     * 配置先は <mainFolderPath>/_notes_md/<id>.md (フラット化)
     * 関連アセット (画像/添付) は _notes_md/{images,files}/ で共有する
     */
    createMarkdownFile(title: string, parentId?: string | null, afterId?: string | null): string {
        const id = NotesFileManager.generateOutlineId();
        this.ensureMdDirs();
        const filePath = this.getMdFilePath(id);

        // 空の .md を作成 (先頭 H1 だけ入れて編集の入り口を提供)
        const initialBody = `# ${title || 'Untitled'}\n`;
        fs.writeFileSync(filePath, initialBody, 'utf8');

        const structure = this.getStructure();
        structure.items[id] = { type: 'file', id, title: title || 'Untitled', ext: 'md' };

        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;
        const insertIdx = afterId ? siblings.indexOf(afterId) : -1;
        if (insertIdx !== -1) {
            siblings.splice(insertIdx + 1, 0, id);
        } else {
            siblings.unshift(id);
        }

        this.saveStructure();
        return filePath;
    }

    /**
     * v0.207.77 (D&D Feature B): 既存 markdown 文字列を新規 .md ファイルとして
     * _notes_md/<newId>.md に書き込み、構造に index 指定で挿入する。
     * parentId=null → rootIds、parentId=folder → folder.childIds の `index` 位置に挿入。
     * @returns 新しく採番した id (= ファイル名)
     */
    registerMarkdownFile(
        content: string,
        title: string,
        parentId: string | null,
        index: number
    ): string {
        const id = NotesFileManager.generateOutlineId();
        this.ensureMdDirs();
        const filePath = this.getMdFilePath(id);
        fs.writeFileSync(filePath, content, 'utf8');

        const structure = this.getStructure();
        structure.items[id] = { type: 'file', id, title: title || 'Untitled', ext: 'md' };

        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;
        const safeIndex = Math.max(0, Math.min(index, siblings.length));
        siblings.splice(safeIndex, 0, id);

        this.saveStructure();
        return id;
    }

    /**
     * v0.207.78 (D&D Feature A): 物理 .md ファイルは残したまま、.note 構造からのみ除去する。
     * outliner cut/paste の「画面上のデータは消す、物理ファイルは消さない」既定挙動と整合させるため、
     * Notes 内 .md を別 .out にドロップした後、コピー元 Notes panel エントリを除去する用途。
     * @returns 除去した md の filePath。currentFile だった場合はクリア。
     */
    unregisterMdFromStructureOnly(mdFileId: string): string | null {
        const structure = this.getStructure();
        const item = structure.items[mdFileId];
        if (!item || item.type !== 'file' || item.ext !== 'md') return null;
        const filePath = this.getMdFilePath(mdFileId);

        this.removeItemFromStructure(structure, mdFileId);
        this.saveStructure();

        if (this.currentFilePath === filePath) {
            this.currentFilePath = null;
            this.isDirty = false;
            this.lastJsonString = null;
        }
        return filePath;
    }

    /**
     * ファイルと対応するページフォルダ (.out のみ) を削除、.note構造からも除去
     * .md ファイルの場合は flat な単一ファイルのみを削除
     */
    async deleteFile(filePath: string): Promise<void> {
        try {
            const vscode = require('vscode');
            const isMd = filePath.endsWith('.md');
            const id = path.basename(filePath, isMd ? '.md' : '.out');
            const pageDirAbs = isMd ? null : path.join(this.mainFolderPath, id);

            if (fs.existsSync(filePath)) {
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(filePath),
                    { useTrash: true, recursive: false }
                );
            }
            // .out のみ pageDir を削除する (.md は _notes_md/{images,files} を共有するため残す)
            if (!isMd && pageDirAbs && fs.existsSync(pageDirAbs)) {
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(pageDirAbs),
                    { useTrash: true, recursive: true }
                );
            }

            if (this.currentFilePath === filePath) {
                this.currentFilePath = null;
                this.isDirty = false;
                this.lastJsonString = null;
            }

            // .note 構造から除去
            const structure = this.getStructure();
            this.removeItemFromStructure(structure, id);
            this.saveStructure();
        } catch (e) {
            console.error('[NotesFileManager] deleteFile error:', e);
        }
    }

    /**
     * .out: JSON内 title を変更、.note構造の title も同期
     * .md : ディスク上のファイルは触らず、.note構造の title のみ更新 (タイトルはメタデータ)
     */
    renameTitle(filePath: string, newTitle: string): void {
        try {
            const isMd = filePath.endsWith('.md');
            if (!isMd) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                data.title = newTitle;
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            }

            // .note 構造のタイトルも同期
            const id = path.basename(filePath, isMd ? '.md' : '.out');
            const structure = this.getStructure();
            const item = structure.items[id];
            if (item && item.type === 'file') {
                item.title = newTitle;
                this.saveStructure();
            }
        } catch (e) {
            console.error('[NotesFileManager] renameTitle error:', e);
        }
    }

    /**
     * 構造内で指定IDのファイルパスを返す
     * 構造に登録された ext を見て .out か .md を解決する (default 'out')
     */
    getFilePathById(fileId: string): string {
        const structure = this.getStructure();
        const item = structure.items[fileId];
        const ext = (item && item.type === 'file' && item.ext) ? item.ext : 'out';
        if (ext === 'md') {
            return this.getMdFilePath(fileId);
        }
        return path.join(this.mainFolderPath, `${fileId}.${ext}`);
    }

    /**
     * 構造のツリー順で最初のファイルIDを返す
     */
    findFirstFileId(): string | null {
        const structure = this.getStructure();
        return this._findFirstFileInIds(structure, structure.rootIds);
    }

    private _findFirstFileInIds(structure: NoteStructure, ids: string[]): string | null {
        for (const id of ids) {
            const item = structure.items[id];
            if (!item) continue;
            if (item.type === 'file') return id;
            if (item.type === 'folder') {
                const found = this._findFirstFileInIds(structure, item.childIds);
                if (found) return found;
            }
        }
        return null;
    }

    // ── 検索 ──

    /**
     * ファイル単位でストリーミング検索
     * コールバックでファイルごとの結果を返す
     */
    searchFilesStreaming(
        query: string,
        options: SearchOptions,
        onResult: (result: SearchResult) => void
    ): void {
        let regex: RegExp;
        try {
            regex = this.buildSearchRegex(query, options);
        } catch {
            return; // invalid regex
        }

        // 1. .out ファイルを検索
        let outFiles: string[];
        try {
            outFiles = fs.readdirSync(this.mainFolderPath).filter(f => f.endsWith('.out'));
        } catch {
            outFiles = [];
        }

        for (const outFile of outFiles) {
            const filePath = path.join(this.mainFolderPath, outFile);
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                const fileId = outFile.replace(/\.out$/, '');
                const matches: SearchMatch[] = [];

                for (const [nodeId, node] of Object.entries(data.nodes || {})) {
                    const n = node as any;
                    if (n.text) {
                        this.findMatches(n.text, regex, 'text', nodeId, matches);
                    }
                    if (n.subtext) {
                        this.findMatches(n.subtext.substring(0, 500), regex, 'subtext', nodeId, matches);
                    }
                }

                if (matches.length > 0) {
                    onResult({
                        fileId,
                        fileTitle: data.title || fileId,
                        fileType: 'out',
                        matches,
                    });
                }
            } catch { /* skip corrupted */ }
        }

        // 2. v0.207.82: _notes_md/ 直下の .md (Notes-md エディタが管理するファイル, フラット化)
        try {
            const mdRoot = this.getMdRootDirPath();
            if (fs.existsSync(mdRoot)) {
                const mdFiles = fs.readdirSync(mdRoot).filter(f => f.endsWith('.md'));
                const structure = this.getStructure();
                for (const mdFile of mdFiles) {
                    const id = mdFile.replace(/\.md$/, '');
                    const item = structure.items[id];
                    if (!item || item.type !== 'file' || item.ext !== 'md') continue;
                    const displayTitle = item.title || id;
                    this.searchMdFile(
                        path.join(mdRoot, mdFile),
                        mdFile, displayTitle, regex, onResult,
                        undefined, undefined
                    );
                }
            }
        } catch { /* skip */ }

        // 3. 各 .out の所有ページ(.md)のみを検索
        // pageDir は複数 outline で共有されるケースがあるため、
        // ディレクトリ内の全 .md を列挙すると他 outline 所有ページまで
        // 拾って「未リンクページ」や重複ヒットの原因になる。
        // よって outline の nodes を走査し、pageId を持つノードに対応する
        // .md だけを検索する。
        for (const outFile of outFiles) {
            try {
                const outPath = path.join(this.mainFolderPath, outFile);
                const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
                const pDir = outData.pageDir
                    ? path.resolve(path.dirname(outPath), outData.pageDir)
                    : path.join(this.mainFolderPath, 'pages');
                if (!fs.existsSync(pDir)) continue;
                const outTitle = outData.title || outFile;
                const outFileId = outFile.replace(/\.out$/, '');
                for (const [, n] of Object.entries(outData.nodes || {})) {
                    const nn = n as any;
                    if (!nn || !nn.pageId) continue;
                    const pageId = String(nn.pageId);
                    const mdPath = path.join(pDir, `${pageId}.md`);
                    if (!fs.existsSync(mdPath)) continue;
                    // 表示名フォールバック: (1) node.text → (2) .md先頭見出し → (3) pageId先頭8文字
                    let label = (nn.text || '').trim();
                    if (!label) {
                        try {
                            const mdHead = fs.readFileSync(mdPath, 'utf8').split('\n').slice(0, 20);
                            for (const ln of mdHead) {
                                const hm = ln.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
                                if (hm) { label = hm[1].trim(); break; }
                            }
                        } catch { /* skip */ }
                    }
                    if (!label) label = pageId.substring(0, 8);
                    const nodeText = label;
                    const displayTitle = `${outTitle} / ${label}`;
                    this.searchMdFile(
                        mdPath,
                        `${pageId}.md`, displayTitle,
                        regex, onResult,
                        outFileId,
                        pageId,
                        nodeText,
                    );
                }
            } catch { /* skip */ }
        }
    }

    private searchMdFile(
        filePath: string,
        fileId: string,
        fileTitle: string,
        regex: RegExp,
        onResult: (result: SearchResult) => void,
        parentOutFileId?: string,
        pageId?: string,
        parentNodeText?: string,
    ): void {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');
            const matches: SearchMatch[] = [];
            for (let i = 0; i < lines.length; i++) {
                // DOMレンダ後のテキストノードと occurrence を一致させるため
                // markdown 構文を正規化してから検索する:
                //   - 画像 ![alt](url) は丸ごと削除（レンダ後 <img> は text node を持たない）
                //   - リンク [text](url) は text 部分のみ残す（url は href 属性になる）
                const normalized = lines[i]
                    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
                    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
                    .substring(0, 200);
                const lineMatches: SearchMatch[] = [];
                this.findMatches(normalized, regex, 'content', undefined, lineMatches);
                for (const m of lineMatches) {
                    m.lineNumber = i;
                    matches.push(m);
                }
            }
            if (matches.length > 0) {
                onResult({
                    fileId, fileTitle, fileType: 'md', matches,
                    parentOutFileId,
                    pageId,
                    mdFilePath: parentOutFileId ? undefined : filePath,
                    parentNodeText,
                });
            }
        } catch { /* skip */ }
    }

    private findMatches(
        text: string,
        regex: RegExp,
        field: 'text' | 'subtext' | 'content',
        nodeId: string | undefined,
        matches: SearchMatch[]
    ): void {
        regex.lastIndex = 0;
        const m = regex.exec(text);
        if (m) {
            matches.push({
                nodeId,
                field,
                lineText: text.substring(0, 200),
                matchStart: m.index,
                matchEnd: m.index + m[0].length,
            });
            regex.lastIndex = 0;
        }
    }

    private buildSearchRegex(query: string, options: SearchOptions): RegExp {
        let pattern: string;
        if (options.useRegex) {
            pattern = query;
        } else {
            pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        if (options.wholeWord) {
            pattern = `\\b${pattern}\\b`;
        }
        const flags = options.caseSensitive ? 'g' : 'gi';
        return new RegExp(pattern, flags);
    }

    // ── Daily Notes ──

    /**
     * dailynotes.out が存在しなければ作成し、outline.note にも登録
     * @returns dailynotes.out のフルパス
     */
    ensureDailyNotesFile(): string {
        const filePath = path.join(this.mainFolderPath, 'dailynotes.out');

        if (!fs.existsSync(filePath)) {
            // pageDir / fileDir / imageDir は Notes mode default で <basename> 配下に
            // 自動 resolve されるため、ここでは書き込まない (system 全体で一貫した命名規則)。
            const initialData = {
                version: 1,
                title: 'Daily Notes',
                rootIds: [] as string[],
                nodes: {} as Record<string, unknown>,
            };
            fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');

            // outline.note に登録
            const structure = this.getStructure();
            if (!structure.items['dailynotes']) {
                structure.items['dailynotes'] = {
                    type: 'file' as const,
                    id: 'dailynotes',
                    title: 'Daily Notes',
                };
                // rootIds の先頭に追加
                structure.rootIds.unshift('dailynotes');
                this.saveStructure();
            }
        }

        return filePath;
    }

    /**
     * 年→月→日の階層ノードを作成/確認
     * 既存ノードがあれば再利用、なければ新規作成
     * @returns { dayNodeId: string, modified: boolean }
     */
    ensureDailyNode(
        data: any,
        year: string,
        month: string,
        day: string
    ): { dayNodeId: string; modified: boolean } {
        let modified = false;

        // 年ノード検索/作成
        let yearNodeId = this.findChildByText(data, null, year);
        if (!yearNodeId) {
            yearNodeId = this.addNodeToData(data, null, year, 'first');
            modified = true;
        }

        // 月ノード検索/作成
        let monthNodeId = this.findChildByText(data, yearNodeId, month);
        if (!monthNodeId) {
            monthNodeId = this.addNodeToData(data, yearNodeId, month, 'first');
            modified = true;
        }

        // 日ノード検索/作成
        let dayNodeId = this.findChildByText(data, monthNodeId, day);
        if (!dayNodeId) {
            dayNodeId = this.addNodeToData(data, monthNodeId, day, 'first');
            modified = true;
        }

        return { dayNodeId, modified };
    }

    /**
     * 指定親の直接子ノードから text が一致するものを検索
     */
    private findChildByText(data: any, parentId: string | null, text: string): string | null {
        const childIds = parentId ? (data.nodes[parentId]?.children || []) : data.rootIds;
        for (const childId of childIds) {
            if (data.nodes[childId]?.text === text) {
                return childId;
            }
        }
        return null;
    }

    /**
     * data JSON にノードを追加（outliner-model.js と同等のロジックをホスト側で実行）
     */
    addNodeToData(data: any, parentId: string | null, text: string, position: 'first' | 'last'): string {
        const nodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

        const node: Record<string, unknown> = {
            id: nodeId,
            parentId: parentId,
            children: [],
            text: text,
            tags: [],
            isPage: false,
            pageId: null,
            collapsed: false,
            checked: null,
            subtext: '',
        };

        data.nodes[nodeId] = node;

        if (parentId) {
            if (!data.nodes[parentId].children) {
                data.nodes[parentId].children = [];
            }
            if (position === 'first') {
                data.nodes[parentId].children.unshift(nodeId);
            } else {
                data.nodes[parentId].children.push(nodeId);
            }
        } else {
            if (position === 'first') {
                data.rootIds.unshift(nodeId);
            } else {
                data.rootIds.push(nodeId);
            }
        }

        return nodeId;
    }

    /**
     * クリーンアップ
     */
    dispose(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.isWritingTimer) {
            clearTimeout(this.isWritingTimer);
            this.isWritingTimer = null;
        }
        this.isWriting = false;
        if (this.isWritingStructureTimer) {
            clearTimeout(this.isWritingStructureTimer);
            this.isWritingStructureTimer = null;
        }
        this.isWritingStructure = false;
        if (this.isDirty && this.lastJsonString && this.currentFilePath) {
            try {
                fs.writeFileSync(this.currentFilePath, this.lastJsonString, 'utf8');
            } catch {
                // ignore on dispose
            }
        }
        this.currentFilePath = null;
        this.isDirty = false;
        this.lastJsonString = null;
        this.structure = null;
    }
}
