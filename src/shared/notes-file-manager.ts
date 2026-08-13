import * as fs from 'fs';
import * as path from 'path';
import * as flatLayout from './flat-layout';
import * as assetMover from './notes-asset-mover';
import { collectMdLinkClosure, applyLinkUrlRewrites, extractAllAssetRefs, generateUniqueFileNamePreserving } from './paste-asset-handler';
import { safeResolveUnderDir } from './path-safety';
import { HistoryEntry, pushHistoryEntry } from './history-store';
import { extractFirstH1, setFirstH1, writeFileIfChanged } from './md-h1-utils';
import { CONTENT_SEARCH_EXTS } from './doc-text-extract';
import { DocExtractCache } from './doc-extract-cache';
const mdLinkParser = require('./markdown-link-parser');

export interface NotesFileEntry {
    filePath: string;
    title: string;
    id: string;
    kind?: 'out' | 'md' | 'file'; // FR-TF: 列挙元の種別（.out / .md / tree file）
}

// ── .note 構造管理 ──

export interface NoteTreeFile {
    type: 'file';
    id: string;        // ファイル名（拡張子なし）
    title: string;     // 表示タイトル（.outのtitleと同期）
    color?: string;    // v11: Tailwind palette name ('red', 'orange', ..., 'zinc') or undefined
    ext?: 'out' | 'md' | 'file'; // v0.207.75: ファイル拡張子。省略時は 'out' (back-compat). ADR-008
                                 // 'file' (FR-TF): 任意拡張子の添付を files/ 配下に実体保持する tree file item。
    filename?: string; // FR-TF: ext:'file' の実体名（files/ 配下・拡張子込み）。id とは別（id は uuid）。
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
    noteTitle?: string;                   // FR-NT-01: note フォルダ全体のタイトル。未設定=フォルダ名表示 (後方互換)
    history?: HistoryEntry[];             // FR-HP-02: 最近開いたファイル履歴 (最新順・最大 HISTORY_MAX 件)
    historyPanelHeight?: number;          // FR-HP-07: history パネルの高さ (px)
    historyPanelCollapsed?: boolean;      // FR-HP-06: history パネルの開閉状態
}

// ── 検索関連 ──

export interface SearchResult {
    fileId: string;
    fileTitle: string;
    fileType: 'out' | 'md' | 'file';
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
    loc?: string;         // FR-DS-09: 添付中身ヒットの位置（p.5 / slide 3 / シート名!B12）。docx は無し
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

    // FR-DS-04: 添付中身検索の抽出キャッシュ dir（globalStorageUri 配下を provider が string 注入。
    // optional — 既存の 1 引数呼び出し（unit spec / electron / dstFm）は null = 都度抽出に縮退。
    // note フォルダ内は不可（S3 sync / cleanup の走査対象になる — NFR-DS-06 / ADRL-0058）
    private docCache: DocExtractCache;

    constructor(mainFolderPath: string, docCacheDir?: string | null) {
        this.mainFolderPath = mainFolderPath;
        this.docCache = new DocExtractCache(docCacheDir ?? null);
    }

    getMainFolderPath(): string { return this.mainFolderPath; }

    // ── v0.207.76: Markdown 仮想フォルダのパス解決 ──
    // notes-flat-storage (2026-07-07): md=mainFolder 直下 / images・files=共有。
    // legacy _notes_md/ は flat-layout の fallback で読む（新 wins）。
    getMdRootDirPath(): string {
        return flatLayout.resolveMdRootDir(this.mainFolderPath);
    }
    getMdImagesDirPath(): string {
        return flatLayout.resolveMdImagesDir(this.mainFolderPath);
    }
    getMdFilesDirPath(): string {
        return flatLayout.resolveMdFilesDir(this.mainFolderPath);
    }
    getMdFilePath(id: string): string {
        return flatLayout.resolveMdFilePath(this.mainFolderPath, id);
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

    // ── FR-TF: tree file item（ext:'file'）— 任意拡張子の添付を files/ 配下に実体保持 ──

    /**
     * filename（相対名）を files/ 共有サブフォルダ配下の絶対パスに解決する（getStructure 非依存）。
     * design §1: traversal（`../..` / `..%2F`）は safeResolveUnderDir で files/ 外へ escape させず null に clamp。
     * loadStructure→syncStructureWithDisk からも呼べるよう getStructure() を参照しない。
     */
    private resolveTreeFileEntity(filename: string | undefined): string | null {
        if (!filename) { return null; }
        const filesDir = flatLayout.resolveMdFilesDir(this.mainFolderPath);
        return safeResolveUnderDir(filesDir, filename);
    }

    /**
     * FR-TF §1: tree file item（ext:'file'）の実体パスを返す。
     * @returns files/ 配下の絶対パス / null（item が file でない・filename 無し・traversal escape）
     */
    getTreeFilePath(itemId: string): string | null {
        const structure = this.getStructure();
        const item = structure.items[itemId];
        if (!item || item.type !== 'file' || item.ext !== 'file') { return null; }
        return this.resolveTreeFileEntity(item.filename);
    }

    /**
     * FR-TF §4y: tree file の実体名を markdown リンク構文で安全な名前に正規化する。
     * - `?` `#` `[` `]` + 制御文字（\x00-\x1f, \x7f）→ `_`（常に置換）
     * - `(` `)` は balanced（開閉が対応）なら保持・unbalanced なら `_` に置換
     *   （markdown-link-parser は balanced-paren aware なので、対応が取れた括弧は URL 部で壊れない）。
     * - `.` は保持する（連続ドット名 archive..tar.gz を破壊しない — §4z の趣旨。global `\.\.` replace 禁止）。
     */
    static sanitizeTreeFileName(name: string): string {
        let s = String(name || '');
        // markdown リンク構文の破壊文字（label 終端 `]` / 誤解析 `?#[`）+ 制御文字を _ に。
        // eslint-disable-next-line no-control-regex
        s = s.replace(/[?#[\]\x00-\x1f\x7f]/g, '_');
        // () の balance 判定（depth が負になる or 最終 depth≠0 なら unbalanced）
        let depth = 0;
        let balanced = true;
        for (const ch of s) {
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; if (depth < 0) { balanced = false; break; } }
        }
        if (depth !== 0) { balanced = false; }
        if (!balanced) { s = s.replace(/[()]/g, '_'); }
        return s;
    }

    /**
     * FR-TF §0/§2: tree file item（ext:'file'）を新規登録する。
     * filename を sanitize（§4y）+ uniquify（§4z generateUniqueFileNamePreserving）して files/ に実体を書き、
     * outline.note の items に {type:'file', ext:'file', filename, title} を登録する。
     * @param bytes 実体バイト列（省略時は空ファイル。台帳登録が主目的で bytes は D&D 経路が渡す）
     * @returns 生成した item id（uuid・filename とは別）
     */
    registerTreeFile(
        filename: string,
        title: string,
        parentId: string | null,
        index: number,
        bytes?: Buffer | Uint8Array
    ): string {
        const id = NotesFileManager.generateOutlineId();
        const filesDir = flatLayout.resolveMdFilesDir(this.mainFolderPath);
        try { fs.mkdirSync(filesDir, { recursive: true }); } catch { /* ignore */ }
        // §4y sanitize → §4z uniquify（generateUniqueFileNamePreserving が入口で basename + 厳密名 ./.. ガード）
        const sanitized = NotesFileManager.sanitizeTreeFileName(path.basename(String(filename || 'file')));
        const uniqueName = generateUniqueFileNamePreserving(filesDir, sanitized);
        const entityPath = path.join(filesDir, uniqueName);
        try {
            fs.writeFileSync(entityPath, bytes ?? Buffer.alloc(0));
        } catch (e) {
            console.error('[NotesFileManager] registerTreeFile write error:', e);
        }

        const structure = this.getStructure();
        structure.items[id] = { type: 'file', id, title: title || uniqueName, ext: 'file', filename: uniqueName };

        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;
        const safeIndex = Math.max(0, Math.min(index, siblings.length));
        siblings.splice(safeIndex, 0, id);

        this.saveStructure();
        return id;
    }

    /**
     * FR-TF: 物理実体（files/ 配下）は残したまま、outline.note 構造からのみ tree file item を除去する。
     * unregisterMdFromStructureOnly の tree file 版（D&D で別 note へ移した後の src エントリ除去用）。
     * @returns 除去した実体の filePath（or null）
     */
    unregisterTreeFileFromStructureOnly(itemId: string): string | null {
        const structure = this.getStructure();
        const item = structure.items[itemId];
        if (!item || item.type !== 'file' || item.ext !== 'file') { return null; }
        const filePath = this.getTreeFilePath(itemId);

        this.removeItemFromStructure(structure, itemId);
        this.saveStructure();

        if (filePath && this.currentFilePath === filePath) {
            this.currentFilePath = null;
            this.isDirty = false;
            this.lastJsonString = null;
        }
        return filePath;
    }

    /**
     * FR-TF §7: tree file item を削除する（files/ 実体を trash へ + 構造から除去）。
     * deleteFile（.out/.md 用の filePath ベース経路）には載せない（id ベースの別経路）。
     */
    async deleteTreeFile(itemId: string): Promise<void> {
        try {
            const structure = this.getStructure();
            const item = structure.items[itemId];
            if (!item || item.type !== 'file' || item.ext !== 'file') { return; }
            const entityPath = this.getTreeFilePath(itemId);
            if (entityPath && fs.existsSync(entityPath)) {
                const vscode = require('vscode');
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(entityPath),
                    { useTrash: true, recursive: false }
                );
                // SEC-3: 抽出テキストキャッシュも実体削除に連動して evict
                //（削除済み添付の本文テキストを globalStorage に残さない）
                this.docCache.evict(entityPath);
            }
            this.removeItemFromStructure(structure, itemId);
            this.saveStructure();
        } catch (e) {
            console.error('[NotesFileManager] deleteTreeFile error:', e);
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
        // notes-flat-storage (2026-07-07): .md は mainFolder 直下 + legacy _notes_md/ の両方をスキャン。
        // diskMdIds は ext==='md' の登録済み item id でのみ照会されるため、
        // page md (<pageId>.md) が混ざっても無害（id は一意）。
        try {
            for (const id of flatLayout.listNotesMdIds(this.mainFolderPath)) {
                diskMdIds.add(id);
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
        // ext === 'md' なら .md、ext === 'file' なら files/ 実体、それ以外は .out の存在を確認
        // FR-TF §2 :346-356: tree file item（ext:'file'）は実体を files/ 配下に filename で持つため
        //   diskOutFiles/diskMdIds のどちらにも現れない。第 3 分岐で getTreeFilePath 実在を確認する
        //   （この分岐が無いと file item が else に落ち diskOutFiles 非該当で誤削除される）。
        //   disk→items 自動追加は行わない（未登録 stray はスキャンしない）。
        const toRemove: string[] = [];
        for (const [id, item] of Object.entries(structure.items)) {
            if (item.type !== 'file') continue;
            const ext = item.ext ?? 'out';
            if (ext === 'md') {
                if (!diskMdIds.has(id)) toRemove.push(id);
            } else if (ext === 'file') {
                // getTreeFilePath は getStructure() 依存で loadStructure 中は再入するため、
                // item.filename から直接解決する getStructure-free ヘルパを使う。
                const entityPath = this.resolveTreeFileEntity(item.filename);
                if (!entityPath || !fs.existsSync(entityPath)) toRemove.push(id);
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

    // ── FR-HP: 最近開いたファイル履歴（outline.note に永続化） ──
    /** history に entry を push（重複先頭移動 + 20 件トリム）して保存。 */
    pushHistory(entry: HistoryEntry): void {
        const structure = this.getStructure();
        structure.history = pushHistoryEntry(structure.history, entry);
        this.saveStructure();
    }
    getHistory(): HistoryEntry[] {
        return this.getStructure().history || [];
    }

    /**
     * 履歴 entry の title を「現在の値」で再解決して返す（保存値は変えない・非破壊）。
     * entry.title は記録時点のスナップショットなので、その後 title/H1 を変えると stale になる。
     * webview へ送出する時にこれを通すことで、ファイル切替（再描画）タイミングで最新 title が出る。
     * 解決元（kind 別）: note-md → items[basename].title（items 外の絶対パス md は先頭 H1）、out → .out disk data.title。
     * 解決不可（ファイル無し等）は stored title/id にフォールバック。
     */
    getHistoryWithFreshTitles(): HistoryEntry[] {
        const history = this.getStructure().history || [];
        return history.map((entry) => {
            let fresh: string | null = null;
            try {
                if (entry.kind === 'out') {
                    // .out の disk data.title（listFiles と同じ）
                    if (fs.existsSync(entry.id)) {
                        const data = JSON.parse(fs.readFileSync(entry.id, 'utf8'));
                        if (typeof data.title === 'string' && data.title) { fresh = data.title; }
                    }
                } else {
                    // note-md: items[basename].title（tree title の正）優先。
                    // ★reopen 2026-07-23: items に無い絶対パス md（page md / 他 note / note 外）は先頭 H1 を再解決
                    //   （page-md kind 廃止で統一。旧 page-md 分岐が持っていた live H1 解決を維持する）。
                    //   items ヒットは file 非読込（安い）。items 外のみ readFileSync。保存値 history は非破壊。
                    const id = entry.id.replace(/^.*[/\\]/, '').replace(/\.(md|out)$/i, '');
                    const item = this.getStructure().items?.[id] as { title?: string } | undefined;
                    if (item && item.title) {
                        fresh = item.title;
                    } else if (/\.md$/i.test(entry.id) && fs.existsSync(entry.id)) {
                        fresh = extractFirstH1(fs.readFileSync(entry.id, 'utf8'));
                    }
                }
            } catch { /* 解決失敗はフォールバック */ }
            // fresh が取れたらそれを、無ければ stored title（さらに無ければ id）
            return { ...entry, title: fresh || entry.title || entry.id };
        });
    }

    /**
     * webview へ送る structure（history の title を最新解決した非破壊 clone）。
     * notesFileListChanged を送る全経路（notes-message-handler / notesEditorProvider の 9 箇所）は
     * getStructure()/loadStructure() の生 structure ではなくこれを送ることで、
     * 履歴パネルが常に最新 title を描画する（保存値 getStructure().history は非破壊）。
     */
    getStructureForWebview(): NoteStructure {
        return { ...this.getStructure(), history: this.getHistoryWithFreshTitles() };
    }
    /**
     * FR-HP-03: filePath（note の md/.out）を履歴に記録する共通ヘルパ。
     * title は structure.items[id].title（human-readable）優先・無ければ basename。
     * 全 open 経路（ツリークリック / 検索ジャンプ / Today / アプリ内リンク等）から呼ぶ。
     */
    recordFileHistory(filePath: string): void {
        if (!filePath) return;
        const isMd = /\.md$/i.test(filePath);
        const isOut = /\.out$/i.test(filePath);
        if (!isMd && !isOut) return;
        const id = filePath.replace(/^.*[/\\]/, '').replace(/\.(md|out)$/i, '');
        this.pushHistory({
            kind: isMd ? 'note-md' : 'out',
            id: filePath,
            title: this.resolveTitleForPath(filePath) || id,
            ts: Date.now(),
        });
    }
    /**
     * sprint 20260724-063158 (FR-TP-04): filePath の表示 title を解決する（tab 名 / Recent 共通）。
     * 「items[basename].title 優先 → md は先頭 H1（extractFirstH1・CommonMark ATX 準拠で C#/F# を壊さない）
     *  → out は .out data.title → basename」。content を渡せば md の H1 抽出にそれを使う（disk 再読込を避ける）。
     * items 外の md（他 note / note 外）は H1、out は data.title で解決。
     */
    resolveTitleForPath(filePath: string, content?: string): string {
        if (!filePath) return '';
        const isMd = /\.md$/i.test(filePath);
        const isOut = /\.out$/i.test(filePath);
        const id = filePath.replace(/^.*[/\\]/, '').replace(/\.(md|out)$/i, '');
        const item = this.getStructure().items?.[id] as { title?: string } | undefined;
        let title = (item && item.title) || '';
        if (!title && isMd) {
            try {
                const md = typeof content === 'string' ? content : fs.readFileSync(filePath, 'utf8');
                title = extractFirstH1(md) || '';
            } catch { /* ignore */ }
        }
        if (!title && isOut) {
            try {
                const raw = typeof content === 'string' ? content : fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(raw);
                if (typeof data.title === 'string' && data.title) { title = data.title; }
            } catch { /* ignore */ }
        }
        return title || id;
    }
    // ★reopen 2026-07-23: recordPageHistory は廃止（page md も recordFileHistory で note-md・絶対パス記録に統一）。
    saveHistoryPanelHeight(height: number): void {
        const structure = this.getStructure();
        structure.historyPanelHeight = height;
        this.saveStructure();
    }
    getHistoryPanelHeight(): number | undefined {
        return this.getStructure().historyPanelHeight;
    }
    saveHistoryPanelCollapsed(collapsed: boolean): void {
        const structure = this.getStructure();
        structure.historyPanelCollapsed = collapsed;
        this.saveStructure();
    }
    getHistoryPanelCollapsed(): boolean {
        return !!this.getStructure().historyPanelCollapsed;
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
     * FR-NT-01/02: note フォルダ全体のタイトル。
     * 表示用 getNoteTitle は未設定時にフォルダ名 (basename) へフォールバック。
     * getRawNoteTitle は保存値そのもの (未設定なら undefined)。
     */
    getNoteTitle(): string {
        const t = this.getStructure().noteTitle;
        return (t && t.trim()) ? t.trim() : path.basename(this.mainFolderPath);
    }

    getRawNoteTitle(): string | undefined {
        return this.getStructure().noteTitle;
    }

    /**
     * note タイトルを outline.note に保存。空文字で確定するとクリア (= フォルダ名表示に戻る)。
     */
    setNoteTitle(title: string): void {
        const structure = this.getStructure();
        const v = (title || '').trim();
        if (v) {
            structure.noteTitle = v;
        } else {
            delete structure.noteTitle;
        }
        this.saveStructure();
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
                result.push({ filePath, title, id, kind: 'out' });
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
                    result.push({ filePath, title: item.title || id, id, kind: 'md' });
                }
            }
            // FR-TF §3: tree file item（ext:'file'）を登録ベースで列挙（files/ 全 walk はしない）。
            //   実体が存在するものだけ列挙（実体欠損 item は非列挙）。
            for (const [id, item] of Object.entries(structure.items)) {
                if (item.type !== 'file' || item.ext !== 'file') continue;
                const filePath = this.getTreeFilePath(id);
                if (!filePath || !fs.existsSync(filePath)) continue;
                result.push({ filePath, title: item.title || id, id, kind: 'file' });
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
     * outliner (.out) の title 変更を tree（items[id].title）へ即反映する。
     * syncData で受け取った .out JSON から data.title を抽出し、現在の tree title と
     * 異なれば items[id].title を更新して true を返す（呼び出し側が sendFileList で再描画）。
     * md の syncTitleFromH1 と対称の「.out title → tree」経路。反映なしなら false。
     * 対象は現在開いている .out（currentFilePath）のみ。
     */
    syncOutTitleToTree(jsonString: string): boolean {
        const cur = this.currentFilePath;
        if (!cur || !cur.endsWith('.out')) { return false; }
        let title: unknown;
        try {
            title = JSON.parse(jsonString).title;
        } catch {
            return false;
        }
        if (typeof title !== 'string') { return false; }
        const id = path.basename(cur, '.out');
        const structure = this.getStructure();
        const item = structure.items[id];
        if (!item || item.type !== 'file') { return false; }
        if (item.title === title) { return false; } // 冪等
        item.title = title;
        this.saveStructure();
        // ★1テンポ遅れバグの真因修正: file panel の main tree は fileList（listFiles() = .out の
        // disk data.title を readFileSync で読む）から title を表示し、items[id].title は使わない。
        // saveCurrentFile は 1000ms debounce のため、この時点で disk はまだ旧 title。
        // pending 保存を即 flush して disk に新 title を書き、直後の listFiles() が新 title を読めるようにする。
        // （別ファイル click で反映されていたのは、切替時の flush で disk が更新されていたため）
        this.flushSave();
        return true;
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
    /**
     * .out JSON ヒント（pageDir/imageDir/fileDir）を outJsonData or currentFilePath から取り出す
     */
    private readOutHints(outJsonData?: Record<string, unknown>): flatLayout.OutDirHints {
        if (outJsonData) {
            return {
                pageDir: outJsonData.pageDir as string | undefined,
                imageDir: outJsonData.imageDir as string | undefined,
                fileDir: outJsonData.fileDir as string | undefined,
            };
        }
        if (this.currentFilePath) {
            try {
                const data = JSON.parse(fs.readFileSync(this.currentFilePath, 'utf8'));
                return { pageDir: data.pageDir, imageDir: data.imageDir, fileDir: data.fileDir };
            } catch { /* fallthrough */ }
        }
        return {};
    }

    // notes-flat-storage (2026-07-07): .out ページ/画像/添付のパスは flat-layout に一元化。
    // md=basedir 直下、images/files=共有サブフォルダ。currentFilePath があれば outFile 基準。
    getPagesDirPath(outJsonData?: Record<string, unknown>): string {
        return flatLayout.resolvePagesDir(this.currentFilePath ?? null, this.mainFolderPath, this.readOutHints(outJsonData));
    }

    /**
     * ページファイルのフルパスを返す
     */
    getPageFilePath(pageId: string, outJsonData?: Record<string, unknown>): string {
        return flatLayout.resolvePageFilePath(this.currentFilePath ?? null, pageId, this.mainFolderPath, this.readOutHints(outJsonData));
    }

    /**
     * fileDir解決: 共有 files/ (flat-layout)
     */
    getFileDirPath(outJsonData?: Record<string, unknown>): string {
        return flatLayout.resolveFilesDir(this.currentFilePath ?? null, this.mainFolderPath, this.readOutHints(outJsonData));
    }

    /**
     * ★HIGH-1: .out 画像 dir の共有 builder（Notes provider のインライン導出を集約）。
     * 共有 <basedir>/images。currentFilePath があれば outFile 基準。
     */
    getOutlinerImageDirPath(outJsonData?: Record<string, unknown>): string {
        return flatLayout.resolveImagesDir(this.currentFilePath ?? null, this.mainFolderPath, this.readOutHints(outJsonData));
    }

    /**
     * ★HIGH-1: .out 添付 dir の共有 builder（getFileDirPath の別名。明示的に対称化）。
     */
    getOutlinerFileDirPath(outJsonData?: Record<string, unknown>): string {
        return flatLayout.resolveFilesDir(this.currentFilePath ?? null, this.mainFolderPath, this.readOutHints(outJsonData));
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

        const firstNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        // notes-flat-storage (2026-07-07): 新規 .out は flat 規約。
        // md=basedir(=mainFolder) 直下、images/files=共有。per-<id>/ フォルダは作らない。
        const data = {
            title: title || 'Untitled',
            pageDir: flatLayout.FLAT_OUT_HINTS.pageDir,
            imageDir: flatLayout.FLAT_OUT_HINTS.imageDir,
            fileDir: flatLayout.FLAT_OUT_HINTS.fileDir,
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
        // 共有 dir はページ/画像追加時に必要に応じて作成される（ここでは per-<id>/ を作らない）。

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
     * FR-MV-01/02: この note の item (file: .out or .md) を別 note フォルダへ物理移動し、
     * 移動先 outline.note の rootIds 先頭に登録する。フォルダ item は対象外 (file のみ)。
     *
     * - .out: `<src>/<id>.out` + pageDir `<src>/<id>/`（pages/assets 丸ごと）を dst へ移動。
     * - .md : `<src>/_notes_md/<id>.md` + その md が参照する images/files を dst の `_notes_md/` へ移動。
     * - id が dst で衝突する場合は dst 用に採番し直す（ファイル名・pageDir・構造 id を一貫更新）。
     * - copy→検証→元削除の順で、途中失敗時は dst の部分コピーを cleanup（NFR-03）。
     *
     * @returns 移動先での新 id（成功時）/ null（対象が file でない・存在しない等）
     */
    moveFileItemToOtherNote(itemId: string, dstFolderPath: string): string | null {
        const structure = this.getStructure();
        const item = structure.items[itemId];
        if (!item || item.type !== 'file') { return null; }
        // FR-TF §5 / §2 :1124: 明示 3 値化。tree file item（ext:'file'）は専用経路へ分岐し、
        //   .md/.out closure 機構に載せない（else-out に落とすと <src>/<uuid>.out が無く copy されず、
        //   dst に実体なし item が登録される回帰 = TC-TF-17 counterfactual）。
        if (item.ext === 'file') {
            return this._moveTreeFileToOtherNote(itemId, item, dstFolderPath);
        }
        const ext: 'out' | 'md' = item.ext === 'md' ? 'md' : 'out';

        const dstFm = new NotesFileManager(dstFolderPath);
        const dstStructure = dstFm.getStructure();
        // id 衝突なら dst 用に採番
        let newId = itemId;
        if (dstStructure.items[newId]) {
            newId = NotesFileManager.generateOutlineId();
        }

        // コピー対象 (src 絶対パス → dst 絶対パス) を収集
        const copies: Array<{ src: string; dst: string; recursive: boolean }> = [];
        // move-other-note-recursive-md: md 再帰移動の状態（.md / .out(flat) 両分岐が plan から充填）
        let mdClosureIdMap = new Map<string, string>();     // srcMdAbs → dst 新 id（起点 + closure）
        let mdMoveClosureAbs = new Set<string>();            // move する closure md（src 削除・structure 除去）
        let mdCopyFallbackAbs = new Set<string>();           // copy する closure md（src 温存）
        let mdClosureItemIds: { srcId: string; newId: string; title: string }[] = []; // dst 登録する md item
        // md-move-link-recursion-unify (scope1): .md / .out(flat) 両方で closure 本文書換・cleanup を行うフラグ。
        let hasMdClosurePlan = false;
        // notes-flat-storage (2026-07-07): flat .out は per-id フォルダを持たない。
        // page md は Note 直下、images/files は共有。フラットかどうかを .out の pageDir で判定。
        let outIsFlat = false;
        const srcOutPath = path.join(this.mainFolderPath, `${itemId}.out`);
        if (ext === 'out') {
            copies.push({ src: srcOutPath, dst: path.join(dstFolderPath, `${newId}.out`), recursive: false });
            const srcPageDir = path.join(this.mainFolderPath, itemId);
            if (fs.existsSync(srcPageDir)) {
                // legacy per-id フォルダ: 丸ごと移動
                copies.push({ src: srcPageDir, dst: path.join(dstFolderPath, newId), recursive: true });
            } else {
                // flat: page md（Note 直下）を起点として .md 分岐と同じ closure 機構に載せる。
                // md-move-link-recursion-unify (scope1): substring 収集を廃止し、page md の md-link 先を再帰移動。
                outIsFlat = true;
                try {
                    const outData = JSON.parse(fs.readFileSync(srcOutPath, 'utf8'));
                    const nodes = (outData.nodes || {}) as Record<string, { isPage?: boolean; pageId?: string }>;
                    // 起点 = 各 page md。★pageId 維持で copies 追加 + rootIdMap 構築（呼び出し側の責務）
                    const rootIdMap = new Map<string, string>();
                    for (const n of Object.values(nodes)) {
                        if (!n.isPage || !n.pageId) { continue; }
                        const p = path.join(this.mainFolderPath, `${n.pageId}.md`);
                        if (!fs.existsSync(p)) { continue; }
                        copies.push({ src: p, dst: path.join(dstFolderPath, `${n.pageId}.md`), recursive: false }); // pageId 維持
                        rootIdMap.set(path.resolve(p), n.pageId); // 起点 dst id = 元 pageId
                    }
                    if (rootIdMap.size > 0) {
                        const plan = this._planMdRecursiveMove({
                            rootIdMap, srcMdRoot: this.getMdRootDirPath(),
                            dstFm, dstStructure, structure,
                            reservedIds: new Set<string>([newId, ...rootIdMap.values()]),
                            extraExcludeIds: new Set<string>([itemId]), // 移動する .out 自身を残留参照走査から除外
                        });
                        for (const c of plan.closureCopies) { copies.push(c); } // ★closure 分だけ取り込む（起点は上で追加済み）
                        mdClosureIdMap = plan.mdClosureIdMap;
                        mdMoveClosureAbs = plan.mdMoveClosureAbs;
                        mdCopyFallbackAbs = plan.mdCopyFallbackAbs;
                        mdClosureItemIds = plan.mdClosureItemIds;
                        hasMdClosurePlan = true;
                    }
                } catch { /* .out 読めなければ本体だけ移動 */ }
            }
        } else {
            // move-other-note-recursive-md / md-move-link-recursion-unify (scope1):
            // 移動する md が参照する自note内 md を再帰移動。起点 copies + 起点 seed は呼び出し側に残し、
            // closure 収集・move/copy 判定・asset 収集は共通ヘルパ _planMdRecursiveMove に委譲する。
            const srcMd = this.getMdFilePath(itemId);
            // 起点 md（新 id で dst へ）= 呼び出し側で copies 追加
            copies.push({ src: srcMd, dst: dstFm.getMdFilePath(newId), recursive: false });
            const rootIdMap = new Map<string, string>([[path.resolve(srcMd), newId]]); // 起点 seed
            const plan = this._planMdRecursiveMove({
                rootIdMap, srcMdRoot: this.getMdRootDirPath(),
                dstFm, dstStructure, structure, reservedIds: new Set<string>([newId]),
            });
            for (const c of plan.closureCopies) { copies.push(c); } // closure md 本体 + そのアセット
            mdClosureIdMap = plan.mdClosureIdMap;
            mdMoveClosureAbs = plan.mdMoveClosureAbs;
            mdCopyFallbackAbs = plan.mdCopyFallbackAbs;
            mdClosureItemIds = plan.mdClosureItemIds;
            hasMdClosurePlan = true;
        }

        // copy フェーズ (dst に配置)。失敗したら dst の作成済みを cleanup。
        const created: string[] = [];
        try {
            for (const c of copies) {
                if (!fs.existsSync(c.src)) { continue; }
                fs.mkdirSync(path.dirname(c.dst), { recursive: true });
                fs.cpSync(c.src, c.dst, { recursive: c.recursive });
                created.push(c.dst);
            }
        } catch (e) {
            for (const d of created) {
                try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* noop */ }
            }
            console.error('[NotesFileManager] moveFileItemToOtherNote copy error:', e);
            return null;
        }

        // dst 構造に登録 (rootIds 先頭)。.out は title/pageDir を newId に合わせる。
        const movedItem: NoteTreeFile = { type: 'file', id: newId, title: item.title, ...(item.color ? { color: item.color } : {}), ...(ext === 'md' ? { ext: 'md' } : {}) };
        dstStructure.items[newId] = movedItem;
        dstStructure.rootIds.unshift(newId);

        // move-other-note-recursive-md / md-move-link-recursion-unify (scope1):
        // closure md item を dst に登録 + 起点/closure の dst コピー本文を書換。
        // .md 分岐（起点 1 個）と .out(flat) 分岐（起点 = 複数 page md）の両方で実行する。
        // ★closure md item 登録は .md 由来のみ（mdClosureItemIds は helper が ext:'md' item のみ積む。
        //   .out の page md は .out 側で管理され item 登録不要 = 空になるので .out でも安全）。
        if (hasMdClosurePlan) {
            // closure md item（元 note で ext:'md' item だったもの）を dst 登録
            for (const ci of mdClosureItemIds) {
                dstStructure.items[ci.newId] = { type: 'file', id: ci.newId, title: ci.title, ext: 'md' };
                dstStructure.rootIds.unshift(ci.newId);
            }
            // 起点 + closure 各 dst コピー本文の md-link を書換（closure→新 id / external→dst 相対）。
            // srcMdAbs → newId の対応表を「その md の本文中に現れる生 ref → 新 ref」に変換して applyLinkUrlRewrites。
            for (const [srcMdAbs, dstNewId] of mdClosureIdMap.entries()) {
                const dstMdAbs = dstFm.getMdFilePath(dstNewId);
                if (!fs.existsSync(dstMdAbs)) { continue; }
                let body = '';
                try { body = fs.readFileSync(dstMdAbs, 'utf8'); } catch { continue; }
                const curDir = path.dirname(srcMdAbs); // 相対リンクの解決基準 = 元 md の dir
                const renames = new Map<string, string>();
                for (const ref of extractAllAssetRefs(body).mdLinks) {
                    const targetAbs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(curDir, ref);
                    if (mdClosureIdMap.has(targetAbs)) {
                        // closure 内 → dst の新 id 相対
                        const targetNewId = mdClosureIdMap.get(targetAbs)!;
                        const newRel = path.relative(dstFm.getMdRootDirPath(), dstFm.getMdFilePath(targetNewId)).replace(/\\/g, '/');
                        if (newRel !== ref) { renames.set(ref, newRel); }
                    } else if (fs.existsSync(targetAbs)) {
                        // 自note外だが実在 → dst から元 md への相対（絶対にしない）
                        const newRel = path.relative(dstFm.getMdRootDirPath(), targetAbs).replace(/\\/g, '/');
                        if (newRel !== ref) { renames.set(ref, newRel); }
                    }
                }
                if (renames.size > 0) {
                    try { fs.writeFileSync(dstMdAbs, applyLinkUrlRewrites(body, renames), 'utf8'); } catch { /* ignore */ }
                }
            }
        }

        // .out の pageDir を書き換え。flat は "."（Note 直下）、legacy per-id は './<newId>'。
        if (ext === 'out') {
            try {
                const dstOut = path.join(dstFolderPath, `${newId}.out`);
                const data = JSON.parse(fs.readFileSync(dstOut, 'utf8'));
                if (outIsFlat) {
                    data.pageDir = flatLayout.FLAT_OUT_HINTS.pageDir;
                    data.imageDir = flatLayout.FLAT_OUT_HINTS.imageDir;
                    data.fileDir = flatLayout.FLAT_OUT_HINTS.fileDir;
                } else {
                    data.pageDir = `./${newId}`;
                }
                fs.writeFileSync(dstOut, JSON.stringify(data, null, 2), 'utf8');
            } catch { /* pageDir 書換失敗は致命的でない */ }
        }
        dstFm.saveStructure();

        // src から物理削除 + 構造除去 (copy 検証済みなので安全)。
        // notes-flat-storage TASK-09/10: 共有アセット（images/・files/）は残留 item が参照中なら
        // 削除しない（データロス防止）。削除判定は notes-asset-mover に集約（DOD-24 allowlist）。
        try {
            // 移動 id は残留参照走査の除外対象。
            // ★TASK-04（HIGH データロス修正）: copy-fallback の closure md は src に残り、
            // その md が参照する共有 image/file はまだ src で生きている。よって共有アセットの
            // surviving 走査（collectSurvivingAssetRefs）の除外集合には copy-fallback の id を含めない
            // （含めると copy-fallback md 参照の共有アセットが「残留参照なし」と誤判定され削除される）。
            // = 除外するのは「起点（.md=itemId/newId, .out=各 page md pageId）+ MOVE する closure md
            //   + それらの dst id」のみ。
            // md-move-link-recursion-unify (scope1): 起点 + MOVE-closure を mdClosureIdMap から一括算出。
            //   起点（root）は常に移動なので必ず含める。copy-fallback（closure のみ発生）だけ除外する。
            const movedIds = new Set<string>([itemId, newId]);
            for (const [srcMdAbs, dstNewId] of mdClosureIdMap.entries()) {
                if (mdCopyFallbackAbs.has(srcMdAbs)) { continue; } // copy-fallback は src 温存 → 除外集合に入れない
                movedIds.add(path.basename(srcMdAbs, '.md'));
                if (dstNewId) { movedIds.add(dstNewId); }
            }
            // 共有アセット dir（basename が images/files 配下か）を判定するためのパス集合
            const sharedImagesDir = path.join(this.mainFolderPath, 'images');
            const sharedFilesDir = path.join(this.mainFolderPath, 'files');
            const isShared = (p: string): boolean => {
                const d = path.dirname(p);
                return d === sharedImagesDir || d === sharedFilesDir;
            };
            const candidates: { absPath: string; recursive: boolean; isSharedAsset: boolean }[] = [];
            if (ext === 'out') {
                const srcOut = path.join(this.mainFolderPath, `${itemId}.out`);
                candidates.push({ absPath: srcOut, recursive: false, isSharedAsset: false });
                const srcPageDir = path.join(this.mainFolderPath, itemId);
                if (fs.existsSync(srcPageDir)) {
                    // legacy per-id フォルダ: 丸ごと削除（隔離なので残留参照リスクなし）
                    candidates.push({ absPath: srcPageDir, recursive: true, isSharedAsset: false });
                } else if (outIsFlat) {
                    // flat: page md（Note 直下・共有でない）+ closure md + 参照 assets（共有）を候補に。
                    // md-move-link-recursion-unify (scope1): copy-fallback の closure md は src 温存
                    // （削除しない）= .md 分岐と同型のデータロス防止（NFR-U-02）。
                    for (const c of copies) {
                        if (c.src === srcOut) { continue; }
                        if (mdCopyFallbackAbs.has(path.resolve(c.src))) { continue; } // copy-fallback md は削除しない
                        candidates.push({ absPath: c.src, recursive: c.recursive, isSharedAsset: isShared(c.src) });
                    }
                }
            } else {
                const srcMd = this.getMdFilePath(itemId);
                candidates.push({ absPath: srcMd, recursive: false, isSharedAsset: false });
                for (const c of copies) {
                    if (c.src === srcMd) { continue; }
                    // move-other-note-recursive-md: copy-fallback の closure md は src 温存（削除しない）。
                    if (mdCopyFallbackAbs.has(c.src)) { continue; }
                    candidates.push({ absPath: c.src, recursive: false, isSharedAsset: isShared(c.src) });
                }
            }
            assetMover.cleanupMovedAssets(this.mainFolderPath, movedIds, candidates);
        } catch (e) {
            console.error('[NotesFileManager] moveFileItemToOtherNote src cleanup error:', e);
        }
        this.removeItemFromStructure(structure, itemId);
        // move-other-note-recursive-md: MOVE した closure md item を src structure から除去（copy-fallback は残す）。
        for (const srcMdAbs of mdMoveClosureAbs) {
            const cId = path.basename(srcMdAbs, '.md');
            if (structure.items[cId]) { this.removeItemFromStructure(structure, cId); }
        }
        this.saveStructure();

        return newId;
    }

    /**
     * FR-TF §5: tree file item（ext:'file'）を別 note へ移動する専用経路。
     * - src 実体（files/<filename>）を dst の files/ へ sanitize(§4y)+uniquify(§4z) して copy。
     * - dst outline.note に {type:'file', ext:'file', filename:new, title, color} を rootIds 先頭で登録。
     * - src 残留参照判定（§5）: 他 .out/.md が同 basename を参照（collectSurvivingAssetRefs）
     *   OR 残留 file item が同 filename を持つ → 参照ありなら src 実体温存、参照なしなら削除。
     *   共有アセットの実削除は notes-asset-mover.cleanupMovedAssets に委譲（DOD-24 allowlist）。
     * - src structure エントリを除去。
     * @returns dst での新 id / null（filename 無し・実体不在・copy 失敗）
     */
    /**
     * FR-TF-18 (§4l): file 実体を別 note の files/ へコピーする共有部品（sanitize §4y + uniquify §4z）。
     * Move Other Note（src 掃除つき）と cross-note D&D（source orphan 契約 = src 不触）の両方が使う。
     * @returns dst files/ 内の実体名（コピー失敗は null）
     */
    static copyTreeFileEntityTo(srcEntityAbs: string, dstFolderPath: string): string | null {
        try {
            const dstFilesDir = flatLayout.resolveMdFilesDir(dstFolderPath);
            fs.mkdirSync(dstFilesDir, { recursive: true });
            const sanitized = NotesFileManager.sanitizeTreeFileName(path.basename(srcEntityAbs));
            const dstName = generateUniqueFileNamePreserving(dstFilesDir, sanitized);
            fs.copyFileSync(srcEntityAbs, path.join(dstFilesDir, dstName));
            return dstName;
        } catch (e) {
            console.error('[NotesFileManager] copyTreeFileEntityTo error:', e);
            return null;
        }
    }

    private _moveTreeFileToOtherNote(itemId: string, item: NoteTreeFile, dstFolderPath: string): string | null {
        const structure = this.getStructure();
        const filename = item.filename;
        if (!filename) { return null; }
        const srcEntity = this.getTreeFilePath(itemId);
        if (!srcEntity || !fs.existsSync(srcEntity)) { return null; }

        const dstFm = new NotesFileManager(dstFolderPath);
        const dstStructure = dstFm.getStructure();

        // dst files/ へ copy（§4y sanitize + §4z uniquify — §4l 共有部品）
        const dstName = NotesFileManager.copyTreeFileEntityTo(srcEntity, dstFolderPath);
        if (!dstName) { return null; }

        // dst 構造に登録（rootIds 先頭）
        let newId = itemId;
        if (dstStructure.items[newId]) { newId = NotesFileManager.generateOutlineId(); }
        dstStructure.items[newId] = {
            type: 'file', id: newId, title: item.title, ext: 'file', filename: dstName,
            ...(item.color ? { color: item.color } : {}),
        };
        dstStructure.rootIds.unshift(newId);
        dstFm.saveStructure();

        // src 残留参照判定 → 実体削除 or 温存（§5）
        try {
            // (1) 残留 file item が同 filename を参照するか（collectSurvivingAssetRefs は tree file item を
            //     走査しないため、ここで別途確認する）。
            let referencedByOtherFileItem = false;
            for (const [id2, it2] of Object.entries(structure.items)) {
                if (id2 === itemId) { continue; }
                if (it2.type === 'file' && it2.ext === 'file' && it2.filename === filename) {
                    referencedByOtherFileItem = true;
                    break;
                }
            }
            if (!referencedByOtherFileItem) {
                // (2) 他 .out/.md 本文の 📎 参照は cleanupMovedAssets 内の collectSurvivingAssetRefs が判定。
                //     surviving に basename があれば削除スキップ（データロス防止）、無ければ削除。
                assetMover.cleanupMovedAssets(
                    this.mainFolderPath,
                    new Set<string>([itemId, newId]),
                    [{ absPath: srcEntity, recursive: false, isSharedAsset: true }]
                );
                // SEC-3: src 実体が削除されうる経路なのでキャッシュも evict（temporal に残っても
                // mtime 不一致で無効化されるが、本文テキストを残さない対称性を優先）
                this.docCache.evict(srcEntity);
            }
            // else: 残留 file item がまだ同実体を参照 → src 実体温存（削除しない）
        } catch (e) {
            console.error('[NotesFileManager] _moveTreeFileToOtherNote src cleanup error:', e);
        }

        // src 構造エントリ除去
        this.removeItemFromStructure(structure, itemId);
        this.saveStructure();
        return newId;
    }

    /**
     * md-move-link-recursion-unify (scope1): Move Other Note の md 再帰移動を計画する共通ヘルパ。
     *
     * `.md` 分岐（起点 1 個）と `.out` flat 分岐（起点 = 各 page md、複数）が共有する。
     * 起点 md の dst id 決定・起点 copies 追加は呼び出し側の責務（.md=newId / .out=元 pageId 維持）。
     * このヘルパは **確定済みの起点対応表 `rootIdMap`（srcMdAbs→dstId）** を受け取り、
     * closure（起点から辿った先の md、起点自身は除く）だけを計画して返す。
     *
     * @returns
     *  - closureCopies: closure md 本体 + そのアセットの copy 計画（起点は含まない）
     *  - mdClosureIdMap: srcMdAbs → dstId（rootIdMap を seed 済 + closure を統合。本文書換の基準）
     *  - mdMoveClosureAbs: move する closure md（src 削除・structure 除去）
     *  - mdCopyFallbackAbs: copy-fallback（残留参照あり → src 温存）
     *  - mdClosureItemIds: dst 登録する .md item（元 structure で ext:'md' item だったもののみ）
     */
    private _planMdRecursiveMove(params: {
        rootIdMap: Map<string, string>;   // 起点 md 絶対パス → dst id（呼び出し側が確定。.md=newId / .out=pageId）
        srcMdRoot: string;
        dstFm: NotesFileManager;
        dstStructure: NoteStructure;
        structure: NoteStructure;
        reservedIds: Set<string>;         // dst で既に予約済みの id（起点の dst id 群。closure 採番の衝突回避）
        extraExcludeIds?: Set<string>;    // 残留参照走査の追加除外 id（.out=移動する .out 自身の id。
                                          //   collectSurvivingMdLinkRefs は .out を basename(.out) で除外するため、
                                          //   起点 pageId とは別に .out id も除外しないと自 .out の page md が残留参照扱いになる）
    }): {
        closureCopies: Array<{ src: string; dst: string; recursive: boolean }>;
        mdClosureIdMap: Map<string, string>;
        mdMoveClosureAbs: Set<string>;
        mdCopyFallbackAbs: Set<string>;
        mdClosureItemIds: { srcId: string; newId: string; title: string }[];
    } {
        const roots = [...params.rootIdMap.keys()].map(p => path.resolve(p)); // 起点絶対パス群
        const rootSet = new Set(roots);
        // mdClosureIdMap を rootIdMap で seed（closure→起点リンクを dst 起点 id に解決するため）
        const mdClosureIdMap = new Map(params.rootIdMap);

        // (1) 起点ごとに closure を収集し 1 本に統合（絶対パスで dedupe、起点自身は除外）
        const closureSet = new Set<string>();
        for (const rootAbs of roots) {
            // collectMdLinkClosure は単一起点しか visited seed しないため、per-root で呼び統合する。
            let perRoot: string[] = [];
            try { perRoot = collectMdLinkClosure(rootAbs, params.srcMdRoot).closure; } catch { perRoot = []; }
            for (const cAbs of perRoot) {
                const abs = path.resolve(cAbs);
                if (rootSet.has(abs)) { continue; } // ★他起点は closure に入れない（page md→別 page md 対策）
                closureSet.add(abs);
            }
        }
        const closure = [...closureSet];

        // (2) 残留参照走査の除外集合 = 全起点 id + 全 closure id (+ 追加除外 id = 移動する .out 自身)
        const closureIds = new Set<string>(params.extraExcludeIds ?? []);
        for (const srcAbs of params.rootIdMap.keys()) { closureIds.add(path.basename(srcAbs, '.md')); }
        for (const cAbs of closure) { closureIds.add(path.basename(cAbs, '.md')); }
        const survivingRefs = assetMover.collectSurvivingMdLinkRefs(this.mainFolderPath, closureIds);

        // (3) closure 各 md: dst id 採番 → copies/id-map/move|copy/item 登録
        const closureCopies: Array<{ src: string; dst: string; recursive: boolean }> = [];
        const mdMoveClosureAbs = new Set<string>();
        const mdCopyFallbackAbs = new Set<string>();
        const mdClosureItemIds: { srcId: string; newId: string; title: string }[] = [];
        const used = new Set<string>([...params.reservedIds, ...params.rootIdMap.values()]);
        for (const cAbs of closure) {
            const cId = path.basename(cAbs, '.md');
            let newCId = cId;
            if (params.dstStructure.items[newCId] || used.has(newCId)) { newCId = NotesFileManager.generateOutlineId(); }
            used.add(newCId);
            mdClosureIdMap.set(cAbs, newCId);
            closureCopies.push({ src: cAbs, dst: params.dstFm.getMdFilePath(newCId), recursive: false });
            // move か copy か: 残留参照あり（他 item がまだ参照）なら copy（元残す）
            if (survivingRefs.has(cAbs)) { mdCopyFallbackAbs.add(cAbs); } else { mdMoveClosureAbs.add(cAbs); }
            // 元 structure で ext:'md' item だったものだけ dst に item 登録（.out page md 等は除く）
            const cItem = params.structure.items[cId];
            if (cItem && cItem.type === 'file' && cItem.ext === 'md') {
                mdClosureItemIds.push({ srcId: cId, newId: newCId, title: cItem.title });
            }
        }

        // (4) 起点 + closure 各 md が参照する共有 images/files を exact-ref で収集
        //     （現行 :1053-1079 と同一ロジック。md-link は closure 側で処理済みなので除外）
        const dstMdRoot = params.dstFm.getMdRootDirPath();
        const allMdAbs = [...roots, ...closure];
        for (const mdAbs of allMdAbs) {
            if (!fs.existsSync(mdAbs)) { continue; }
            let body = '';
            try { body = fs.readFileSync(mdAbs, 'utf8'); } catch { continue; }
            const refBasenames = new Set<string>();
            const refs = extractAllAssetRefs(body);
            const allLinkUrls = (mdLinkParser.parseMarkdownLinks(body) as Array<{ url: string }>).map(l => l.url);
            for (const r of [...refs.images, ...refs.files, ...allLinkUrls]) {
                if (!r || /^(https?:|data:|file:|fractal:)/i.test(r) || r.startsWith('#')) { continue; }
                if (r.toLowerCase().endsWith('.md') || r.toLowerCase().endsWith('.markdown')) { continue; } // md-link は closure 側で処理
                refBasenames.add(path.posix.basename(r.replace(/\\/g, '/').split(/[?#]/)[0]));
            }
            for (const sub of [NotesFileManager.MD_IMAGES_SUBDIR, NotesFileManager.MD_FILES_SUBDIR]) {
                const srcSub = path.join(params.srcMdRoot, sub);
                if (!fs.existsSync(srcSub)) { continue; }
                for (const fname of fs.readdirSync(srcSub)) {
                    if (refBasenames.has(fname)) {
                        const dstAsset = path.join(dstMdRoot, sub, fname);
                        if (!closureCopies.some(c => c.dst === dstAsset)) {
                            closureCopies.push({ src: path.join(srcSub, fname), dst: dstAsset, recursive: false });
                        }
                    }
                }
            }
        }

        return { closureCopies, mdClosureIdMap, mdMoveClosureAbs, mdCopyFallbackAbs, mdClosureItemIds };
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
    /**
     * TASK-18 (sprint 20260804-145603): mainFolder 直下に既に実在する md を、
     * コピー・リネームせず**そのまま**ツリー構造に登録する（id = ファイル名 stem）。
     * 既に構造に居る id なら何もしない（冪等）。
     */
    registerExistingMdFile(
        id: string,
        title: string,
        parentId: string | null,
        index: number
    ): boolean {
        const filePath = path.join(this.mainFolderPath, `${id}.md`);
        if (!fs.existsSync(filePath)) return false;
        const structure = this.getStructure();
        if (structure.items[id]) return false; // 既登録（冪等）
        structure.items[id] = { type: 'file', id, title: title || 'Untitled', ext: 'md' };
        const siblings = parentId && structure.items[parentId]?.type === 'folder'
            ? (structure.items[parentId] as NoteTreeFolder).childIds
            : structure.rootIds;
        const safeIndex = Math.max(0, Math.min(index, siblings.length));
        siblings.splice(safeIndex, 0, id);
        this.saveStructure();
        return true;
    }

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
            // notes-flat-storage (2026-07-07): flat .out（pageDir=".")は per-<id>/ フォルダを持たない。
            // page md はこの .out のノード pageId ごとに basedir 直下 <pageId>.md として存在する。
            // 削除対象の page md 一覧を、.out を消す前に集める。
            let flatPageMdPaths: string[] = [];
            const legacyPageDirAbs = isMd ? null : path.join(this.mainFolderPath, id);
            if (!isMd) {
                try {
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    const pageDir = data.pageDir;
                    // flat（pageDir="." or basedir 直下解決）なら page md を個別収集。
                    // 旧 per-<id>/（pageDir="./<id>"）はフォルダごと削除するので個別収集不要。
                    const isLegacyPerId = typeof pageDir === 'string' && pageDir.replace(/^\.\//, '') === id;
                    if (!isLegacyPerId) {
                        const pagesDir = this.getPagesDirPath(data);
                        const nodes = (data.nodes || {}) as Record<string, { isPage?: boolean; pageId?: string }>;
                        for (const n of Object.values(nodes)) {
                            if (n.isPage && n.pageId) {
                                const mp = path.join(pagesDir, `${n.pageId}.md`);
                                if (fs.existsSync(mp)) flatPageMdPaths.push(mp);
                            }
                        }
                    }
                } catch { /* ignore parse errors — .out 本体だけ消す */ }
            }

            if (fs.existsSync(filePath)) {
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(filePath),
                    { useTrash: true, recursive: false }
                );
            }
            // 旧 per-<id>/ レイアウトのみ pageDir フォルダごと削除（存在すれば）。
            // flat .out は mainFolder 共有なのでフォルダを消さず、page md を個別に削除する。
            if (!isMd && legacyPageDirAbs && fs.existsSync(legacyPageDirAbs)) {
                await vscode.workspace.fs.delete(
                    vscode.Uri.file(legacyPageDirAbs),
                    { useTrash: true, recursive: true }
                );
            }
            for (const mp of flatPageMdPaths) {
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.file(mp), { useTrash: true, recursive: false });
                } catch { /* best-effort: cleanup が孤児として拾う */ }
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
     * .md : FR-TH-01 で先頭 H1 を newTitle に同期（本文保持・冪等・byte skip）、.note構造の title も更新
     *       (tree title はメタデータ items[id].title が正だが、本文 H1 も追従させる)
     */
    renameTitle(filePath: string, newTitle: string): void {
        try {
            // FR-TF §2 :1647: tree file item（files/ 配下の実体パス）は id ベースの別経路。
            //   実体パスを .out/.md の filePath ベースロジック（JSON.parse / setFirstH1）に流さない
            //   （binary を JSON.parse/H1 書換すると破壊するため）。title のみ更新・実体は不変。
            const filesDir = path.resolve(flatLayout.resolveMdFilesDir(this.mainFolderPath));
            if (path.dirname(path.resolve(filePath)) === filesDir) {
                const base = path.basename(filePath);
                const structure = this.getStructure();
                for (const it of Object.values(structure.items)) {
                    if (it.type === 'file' && it.ext === 'file' && it.filename === base) {
                        it.title = newTitle;
                        this.saveStructure();
                        break;
                    }
                }
                return;
            }
            const isMd = filePath.endsWith('.md');
            if (!isMd) {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                data.title = newTitle;
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
            } else {
                // ★FR-TH-01: .md は先頭 H1 を newTitle に同期。
                // _writeFile は private+currentFilePath 専用なので使えない → writeFileIfChanged。
                try {
                    if (fs.existsSync(filePath)) {
                        const body = fs.readFileSync(filePath, 'utf8');
                        writeFileIfChanged(filePath, setFirstH1(body, newTitle)); // 冪等
                    }
                } catch (e) {
                    console.error('[NotesFileManager] renameTitle H1 sync error:', e);
                }
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
     * FR-TH-02: md content の先頭 H1 を tree title (items[id].title) に反映する。
     * 反映したら true（呼び出し側は sendFileListWithStructure で再描画）。
     * - 先頭 H1 が無い content は title を変更しない（H1 消失時は既存 title 維持）。
     * - tree item でない md（subpage / pages 配下 = structure.items に無い）は対象外。
     * - 冪等: title が既に H1 と同じなら false（再描画しない）。
     */
    syncTitleFromH1(filePath: string, content: string): boolean {
        if (!filePath.endsWith('.md')) { return false; }
        const h1 = extractFirstH1(content);
        if (!h1) { return false; } // 先頭 H1 無し → title 変更しない
        const id = path.basename(filePath, '.md');
        const structure = this.getStructure();
        const item = structure.items[id];
        if (!item || item.type !== 'file') { return false; } // tree item でない md
        if (item.title === h1) { return false; } // 冪等
        item.title = h1;
        this.saveStructure();
        return true;
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
        if (ext === 'file') {
            // FR-TF §2 :1709: fake `${id}.file` を返さず実体パス（files/ 配下）へ委譲する。
            //   返り値契約は string（既存 caller が .endsWith 等で string を前提）を維持し、
            //   traversal escape 等で null のときは '' に落とす（openFile('') が readFileSync で
            //   ENOENT → null を返し caller が安全に中断する。fake .file 経路には決して流さない）。
            return this.getTreeFilePath(fileId) ?? '';
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
    // FR-DS-01: 旧検索 abort 用 generation カウンタ（新検索発行で旧ループが次 check で return）
    private searchGeneration = 0;

    async searchFilesStreaming(
        query: string,
        options: SearchOptions,
        onResult: (result: SearchResult) => void
    ): Promise<void> {
        const gen = ++this.searchGeneration;
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

        // 4. FR-DS-01 rev.2: files/ 配下の添付中身検索（再帰 walk — cleanup-core listAllFiles 同型）。
        //    files/ は tree file item・node 📎・md 📎 の共有実体置き場（ADRL-0048 決定 4）なので、
        //    1 walk で全種の添付が対象になる（rev.1 の items 台帳走査は node/md 添付を落とすため改訂）。
        //    台帳 items は表示 title の逆引きにのみ使用。抽出は DocExtractCache 経由。
        try {
            const filesDir = flatLayout.resolveMdFilesDir(this.mainFolderPath);
            // filename（files/ 相対）→ 台帳 title の逆引き
            const titleByRel = new Map<string, string>();
            try {
                const structure = this.getStructure();
                for (const item of Object.values(structure.items)) {
                    const it = item as { type?: string; ext?: string; filename?: string; title?: string };
                    if (it && it.type === 'file' && it.ext === 'file' && it.filename && it.title) {
                        titleByRel.set(it.filename, it.title);
                    }
                }
            } catch { /* 台帳が読めなくても walk は続行（title は basename に縮退） */ }

            for (const abs of NotesFileManager.walkContentSearchFiles(filesDir)) {
                if (gen !== this.searchGeneration) { return; }           // 旧検索 abort
                const res = await this.docCache.getOrExtract(abs);       // await 単位で yield
                if (gen !== this.searchGeneration) { return; }
                if (res.skipReason) { continue; }                        // 記録済み・結果には出さない（FR-DS-08）
                const rel = path.relative(filesDir, abs);
                const matches: SearchMatch[] = [];
                for (let i = 0; i < res.lines.length; i++) {
                    const before = matches.length;
                    this.findMatches(res.lines[i].text, regex, 'content', undefined, matches);
                    if (matches.length > before) {
                        matches[matches.length - 1].lineNumber = i;      // 0-based（既存 md 検索と同じ）
                        // FR-DS-09: 位置メタ（p.5 / slide 3 / シート名!B12）— docx は undefined
                        matches[matches.length - 1].loc = res.lines[i].loc;
                    }
                }
                if (matches.length > 0) {
                    onResult({
                        fileId: `files/${rel}`,                          // rev.2: 同定は files/ 相対パス
                        fileTitle: titleByRel.get(rel) || path.basename(abs),
                        fileType: 'file',
                        matches,
                    });
                }
            }
        } catch { /* 第 4 段の障害は既存 3 段の結果に影響させない */ }
    }

    /**
     * FR-DS-01 rev.2: files/ 配下の中身検索対象（CONTENT_SEARCH_EXTS）を再帰列挙する。
     * symlink は追わない（isFile/isDirectory は lstat 相当の Dirent 判定 — files/ 外への
     * escape を構造的に防ぐ。ADRL-0040 の防御思想）。walk 順は決定的（名前昇順）。
     */
    private static walkContentSearchFiles(dir: string): string[] {
        const result: string[] = [];
        const walk = (d: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(d, { withFileTypes: true });
            } catch { return; }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            for (const entry of entries) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {                // symlink dir は isDirectory()=false → 追わない
                    walk(full);
                } else if (entry.isFile()) {              // symlink file も isFile()=false → 対象外
                    const ext = path.extname(entry.name).toLowerCase();
                    if (CONTENT_SEARCH_EXTS.includes(ext)) { result.push(full); }
                }
            }
        };
        walk(dir);
        return result;
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
            // notes-flat-storage (2026-07-07): 新規 .out は flat 規約 (createOutlineFile と同一)。
            // ヒント無しだと notesArchiveTasks 等の書き込み側が旧 <basename>/ レイアウトを
            // 新規に作ってしまい移行ゲートが再発する (sprint 20260812-171126)。
            const initialData = {
                version: 1,
                title: 'Daily Notes',
                pageDir: flatLayout.FLAT_OUT_HINTS.pageDir,
                imageDir: flatLayout.FLAT_OUT_HINTS.imageDir,
                fileDir: flatLayout.FLAT_OUT_HINTS.fileDir,
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
