import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NotesFileManager } from './shared/notes-file-manager';
import {
    handleNotesMessage, NotesSender, NotesPlatformActions,
    treeFileImportIntoOut, treeFileAttachIntoMd, treeFileAttachToMdEditor,
    treeFileImportAtPosition, treeFileRegisterFromOutNode, treeFileRegisterFromMdLink, insertNodeAtDropPosition,
    registerExternalDroppedFileItem, registerExternalDroppedUris, linkMdAsSubpageForSidePanelCore,
    attachOutNodeFileToMd, importOutPageNodeToMd, attachMdFileLinkToMd, linkMdSubpageToMd,
} from './shared/notes-message-handler';
import { getNotesWebviewContent } from './notesWebviewContent';
import { getNotesMigrationGateContent } from './notesMigrationGate';
import { t, getWebviewMessages, initLocale } from './i18n/messages';
import { SidePanelManager } from './shared/sidePanelManager';
import { resolveResourceRoots, findOutOfRangeImages } from './shared/resource-roots';
import { NotesMdMainManager } from './shared/notesMdMainManager';
import { s3Sync, s3RemoteDeleteAndUpload, s3LocalDeleteAndDownload, S3SyncConfig } from './notes-s3-sync';
import { importMdFiles } from './shared/markdown-import';
import { importFiles } from './shared/file-import';
import { processDropFilesImport, processDropVscodeUrisImport, createDropImportHandler, DropImportItem } from './shared/drop-import';
import { DropStreamHost } from './shared/drop-stream-host';
import { parseDataUrl, mimeToExt } from './shared/data-url-image-extractor';
import { safeResolveUnderDir } from './shared/path-safety';
import { runNotesCleanup } from './notesCleanupCommand';
import { copyMdPasteAssets } from './shared/paste-asset-handler';
import { runExportBundle, runExportOutlinerNodesBundle } from './shared/export-bundle-host';
// FR-PDF-08 / TASK-11: md → PDF export の VS Code 依存 deps 生成は outlinerProvider に集約済み。
// editorProvider が既に同 import を使う先例に倣う（outlinerProvider は notes/editor を import し返さないため新規循環なし）。
import { buildPdfExportDeps } from './outlinerProvider';
import { runExportMdToPdf, PdfPanelLike } from './shared/pdf-export-host';
import { resolveImagesDirForMd, resolveFilesDirForMd, resolvePagesDir, resolveImagesDir, resolveFilesDir } from './shared/flat-layout';
import { DrawioWatcherRegistry, extractDrawioReferences, createDrawioFileWatcher } from './shared/drawioWatcher';
import { copyImageToClipboard, openImageInNewTab } from './shared/image-clipboard';
import { buildPlaceholderDrawioSvg, buildUniqueDrawioName } from './shared/drawioTemplate';
import { getCurrentTheme } from './shared/vscode-settings-provider';
import { moveSubtreeToOtherOut, OutDoc } from './shared/out-node-move';
import { buildLlmsTxt, LlmsTxtTreeNode } from './shared/llms-txt-builder';
import {
    toMarkdownPath,
    ensureDirectoryExists,
    generateUniqueFileName,
} from './editorProvider';
import { generateUniqueFileNamePreserving } from './shared/paste-asset-handler';
import { saveDroppedMdAsSubpage, dataUrlToUtf8, resolveSubpageTitle } from './shared/md-subpage-utils';

/**
 * NotesEditorProvider — WebviewPanel で Notes エディタを開く
 * 複数パネル対応: 各パネルが独立したfileManager/watcher/disposablesをクロージャで保持
 */
export class NotesEditorProvider {
    // 開いているパネルを追跡（folderPath → { panel, postMessage, fileManager, openPage }）
    private openPanels = new Map<string, {
        panel: vscode.WebviewPanel;
        postMessage: (msg: any) => void;
        fileManager: NotesFileManager;
        openPage?: (filePath: string) => Promise<void>;
    }>();

    /** v0.207.34: Cmd+\ で右パネル toggle — active な notes panel に message 送信 */
    public sendToggleSidebar(): void {
        for (const entry of this.openPanels.values()) {
            if (entry.panel.active) {
                entry.panel.webview.postMessage({ type: 'toggleSidebar' });
                return;
            }
        }
    }

    /**
     * FR-PDF-01: PDF エクスポートの対象 panel（Notes）。
     * openPanels 走査で active な panel を返す。アクティブタブ md / sidepanel md の
     * どちらか・filePath は webview 返信を正とする（design §2）ため filePath は返さない。
     */
    public getActivePanelForPdf(): { panel: vscode.WebviewPanel; filePath?: string } | undefined {
        for (const entry of this.openPanels.values()) {
            if (entry.panel.active) {
                return { panel: entry.panel };
            }
        }
        return undefined;
    }

    // FR-NT-03 / FR-MV-01: Notes Folder ツリー provider への参照 (ツリー更新 + 移動先一覧に使う)
    private folderProvider?: { refresh(): void; getFolders(): string[] };
    public setFolderProvider(fp: { refresh(): void; getFolders(): string[] }): void {
        this.folderProvider = fp;
    }

    /**
     * Notes webview の localResourceRoots を組む。
     * media/vendor（拡張同梱）+ 自 note（folderPath）+ homeDir。
     * 別 note の md を sidepanel で開いたときにその note の画像/添付がロードできるよう、
     * homeDir（ホームディレクトリ丸ごと）を許可範囲に含める。standalone md（editorProvider）が
     * 既に homeDir を許可している方針に揃える（note は任意パスに散らばりうるが通常はホーム配下）。
     */
    private buildLocalResourceRoots(folderPath: string): vscode.Uri[] {
        // FR-RR-03: homeDir ハードコードを settings 由来の許可範囲に置換（空なら [homedir]）。
        const cfg = vscode.workspace.getConfiguration('fractal');
        const roots = resolveResourceRoots(cfg.get<string[]>('resourceRoots', []));
        return [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            vscode.Uri.joinPath(this.context.extensionUri, 'vendor'),
            vscode.Uri.file(folderPath),
            ...roots.map(p => vscode.Uri.file(p)), // settings 由来（空なら [homedir]＝後方互換）
        ];
    }

    // sprint 20260723-233506: fractal:// ページリンクを絶対 md パスに解決（node リンク＝pageId 無しは null）。
    private resolveFractalPageToAbsPath(href: string): string | null {
        const m = href.match(/^fractal:\/\/note\/([^/]+)\/([^/]+)\/page\/([^/?]+)$/);
        if (!m) return null;
        const folderName = decodeURIComponent(m[1]);
        const outFileId = decodeURIComponent(m[2]);
        const pageId = decodeURIComponent(m[3]);
        const folders = this.folderProvider?.getFolders() || [];
        const folderPath = folders.find(f => path.basename(f) === folderName);
        if (!folderPath) return null;
        return this.resolvePagePath(folderPath, outFileId, pageId);
    }

    // sprint 20260723-233506: 他 note / note 外 md をタブで開く時、その dir を localResourceRoots に union
    //   （Webview.options は writable。FR-TAB-08）。既に含まれていれば no-op。
    private ensureResourceRootForFile(panel: vscode.WebviewPanel, filePath: string): void {
        try {
            const dir = path.dirname(filePath);
            const current = panel.webview.options.localResourceRoots || [];
            const already = current.some(u => {
                const r = u.fsPath;
                return dir === r || dir.startsWith(r + path.sep);
            });
            if (already) return;
            panel.webview.options = {
                ...panel.webview.options,
                localResourceRoots: [...current, vscode.Uri.file(dir)],
            };
        } catch (e) {
            console.error('[Notes] ensureResourceRootForFile failed:', e);
        }
    }

    constructor(private context: vscode.ExtensionContext) {}

    /**
     * FR-MV-01: Notes タブの item を別 Note へ移動する。
     * QuickPick で移動先 Note (現在の note を除く) を選ばせ、物理移動 + 両 outline.note 整合 +
     * 移動先の先頭に登録。移動後に src webview を更新し Notes Folder ツリーを refresh。
     */
    private async handleMoveItemToOtherNote(
        itemId: string,
        fm: NotesFileManager,
        sender: NotesSender
    ): Promise<void> {
        const srcFolder = fm.getMainFolderPath();
        const folders = (this.folderProvider?.getFolders() || []).filter(f => f !== srcFolder);
        if (folders.length === 0) {
            vscode.window.showInformationMessage(t('notesMoveNoOtherNote') || 'No other note to move to.');
            return;
        }
        // resolveNoteLabel で noteTitle 反映のラベルを出す
        const { resolveNoteLabel } = require('./notesFolderProvider');
        const picked = await vscode.window.showQuickPick(
            folders.map(f => ({ label: resolveNoteLabel(f), description: f, folderPath: f })),
            { placeHolder: t('notesMoveOtherNotePick') || 'Move to which note?' }
        );
        if (!picked) { return; } // キャンセル → 何もしない

        const newId = fm.moveFileItemToOtherNote(itemId, picked.folderPath);
        if (!newId) {
            vscode.window.showErrorMessage(t('notesMoveFailed') || 'Move failed.');
            return;
        }
        // src webview 更新 + ツリー refresh (dst は次回開いた時に反映)
        sender.postMessage({
            type: 'notesFileListChanged',
            fileList: fm.listFiles(),
            structure: fm.getStructureForWebview(),
            currentFile: fm.getCurrentFilePath(),
            noteFolderName: path.basename(srcFolder),
        });
        this.folderProvider?.refresh();
        vscode.window.showInformationMessage(t('notesMoveDone') || 'Moved to the selected note.');
    }

    async openNotesFolder(folderPath: string): Promise<void> {
        // 同じフォルダのパネルが既に存在する場合はrevealして再利用
        const existing = this.openPanels.get(folderPath);
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        // フォルダ存在確認 (N-45)
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
            vscode.window.showErrorMessage(`Notes folder not found: ${folderPath}`);
            return;
        }

        // --- パネル固有の状態（全てローカル変数） ---
        const fileManager = new NotesFileManager(folderPath);

        // FR-MG-01: 起動時フラット移行ゲート。★ loadStructure より前に old layout を判定する。
        //   loadStructure() は読むだけでなく開いた瞬間に .note→outline.note rename / 旧 md renameSync /
        //   saveStructure 上書き（notes-file-manager.ts:201-282）でディスクを書き換えるため、old layout の
        //   note でこれを先に走らせると flat-migrate が扱う前にフォルダが変わってしまう。
        //   planMigration は read-only（fs 書き込みゼロ）なので、判定だけでは何も書き換えない。
        const flatMigrate = await import('./shared/flat-migrate');
        let migrationSummary: { pages: number; images: number; files: number; total: number; conflicts: number; copies: number } | null = null;
        try {
            migrationSummary = flatMigrate.summarizePlan(flatMigrate.planMigration(folderPath));
        } catch {
            migrationSummary = null; // 判定に失敗しても通常経路で開く（安全側）
        }
        const needsMigration = !!migrationSummary && migrationSummary.total > 0;

        // 本体ロード（loadStructure / listFiles / createFile / openFile）は old layout では skip する。
        // ★ early-return せず、この if で本体ロードだけを条件 skip する（下流の onDidReceiveMessage 配線には
        //   線形に到達させる = Migrate ボタンを無反応にしないため）。
        let fileList: ReturnType<typeof fileManager.listFiles> = [];
        let currentFilePath: string | null = null;
        let jsonContent = '{"version":1,"rootIds":[],"nodes":{}}';
        // 初期ファイルが .md（ext:'md' item）の場合は outliner でなく md ペインで開く。
        // md 本文を jsonContent に入れると webview の JSON.parse が落ちて空 outliner になる（バグ）。
        let initialMdContent: string | null = null;
        if (!needsMigration) {
            // .note構造をロード（自動マイグレーション含む）
            fileManager.loadStructure();

            // ファイル一覧取得（空フォルダなら default outliner を自動作成）
            fileList = fileManager.listFiles();
            if (fileList.length === 0) {
                fileManager.createFile('default');
                fileList = fileManager.listFiles();
            }

            // 構造のツリー順で最初のファイルを開く
            const firstFileId = fileManager.findFirstFileId();
            if (firstFileId) {
                const fp = fileManager.getFilePathById(firstFileId);
                const content = fileManager.openFile(fp);
                if (content !== null) {
                    currentFilePath = fp;
                    if (fp.endsWith('.md')) { initialMdContent = content; } else { jsonContent = content; }
                }
            } else if (fileList.length > 0) {
                const content = fileManager.openFile(fileList[0].filePath);
                if (content !== null) {
                    currentFilePath = fileList[0].filePath;
                    if (currentFilePath.endsWith('.md')) { initialMdContent = content; } else { jsonContent = content; }
                }
            }
        }

        // パネル折り畳み状態を復元
        const panelCollapsed = this.context.globalState.get<boolean>(
            `notesPanelCollapsed:${folderPath}`, false
        );

        // WebviewPanel 作成
        const panel = vscode.window.createWebviewPanel(
            'fractal.notes',
            `Notes: ${path.basename(folderPath)}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: this.buildLocalResourceRoots(folderPath),
            }
        );

        // パネルをMapに登録、dispose時に除去
        this.openPanels.set(folderPath, {
            panel,
            postMessage: (msg: any) => panel.webview.postMessage(msg),
            fileManager,
        });
        panel.onDidDispose(() => {
            this.openPanels.delete(folderPath);
        });

        const sendTranslateLangFromConfig = () => {
            const cfg = vscode.workspace.getConfiguration('fractal');
            panel.webview.postMessage({
                type: 'translateLangSelected',
                sourceLang: cfg.get<string>('translateSourceLang', 'en'),
                targetLang: cfg.get<string>('translateTargetLang', 'ja'),
            });
        };

        // HTML 生成
        const config = vscode.workspace.getConfiguration('fractal');
        const folderBaseUri = panel.webview.asWebviewUri(vscode.Uri.file(folderPath)).toString();
        if (needsMigration && migrationSummary) {
            // FR-MG-02: old layout → 本体でなく移行ゲート画面を出す。
            //   ★ getNotesWebviewContent は initData で fileManager.getStructure()（loadStructure に
            //   フォールバックしてディスク書換する）を呼ぶため、gate 経路では**呼ばない**。
            panel.webview.html = getNotesMigrationGateContent(
                panel.webview,
                this.context.extensionUri,
                { pages: migrationSummary.pages, images: migrationSummary.images, files: migrationSummary.files, total: migrationSummary.total },
                path.basename(folderPath)
            );
        } else {
            panel.webview.html = getNotesWebviewContent(
                panel.webview,
                this.context.extensionUri,
                {
                    theme: getCurrentTheme(this.context),
                    fontSize: config.get<number>('fontSize', 12),
                    toolbarMode: config.get<string>('toolbarMode', 'simple'),
                    webviewMessages: getWebviewMessages() as unknown as Record<string, string>,
                    enableDebugLogging: config.get<boolean>('enableDebugLogging', false),
                    showTranslateButtons: config.get<boolean>('showTranslateButtons', false),
                    showOpenInTextEditor: config.get<boolean>('showOpenInTextEditor', true),
                    imageMaxWidth: config.get<number>('imageMaxWidth', 400),
                    documentBaseUri: folderBaseUri,
                    folderName: path.basename(folderPath),
                },
                {
                    jsonContent,
                    fileList,
                    currentFilePath,
                    panelCollapsed,
                    structure: fileManager.getStructure(),
                    panelWidth: fileManager.getPanelWidth(),
                    noteSidePanelWidth: fileManager.getSidePanelWidth(),
                    noteSidePanelOutlineWidth: fileManager.getSidePanelOutlineWidth(),
                    fileChangeId: fileManager.getFileChangeId(),
                    noteFolderName: path.basename(folderPath),  // FR-NT-01: noteTitle 未設定時の既定表示
                    currentFileTitle: currentFilePath ? fileManager.resolveTitleForPath(currentFilePath) : '',  // FR-TP-04: 初期タブ名
                    history: fileManager.getHistoryWithFreshTitles(),  // FR-HP: 最近開いたファイル履歴（title は最新解決）
                    historyPanelHeight: fileManager.getHistoryPanelHeight(),
                    historyPanelCollapsed: fileManager.getHistoryPanelCollapsed(),
                    // ツリー先頭が md item の場合は md ペインで初期表示（空 outliner バグ是正）
                    initialMd: (initialMdContent !== null && currentFilePath) ? {
                        content: initialMdContent,
                        documentBaseUri: panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(currentFilePath))).toString(),
                    } : null,
                }
            );
        }
        sendTranslateLangFromConfig();

        // 初期ファイルが md の場合、外部変更 watcher を張る（notesOpenFile 経由の mdMainOpened と対称。
        // mdMain はこの後で生成されるため次 tick で張る）
        if (initialMdContent !== null && currentFilePath) {
            const initialMdPath = currentFilePath;
            setImmediate(() => {
                mdMain.setupFileWatcher(initialMdPath).catch(e => {
                    console.error('[Notes] initial md setupFileWatcher error:', e);
                });
            });
            // FR-XP-01 (sprint 20260808-000219): 初期 md は notesOpenFile (mdMainOpened) を
            // 通らないため、ここでも assetContext を配線（mdMainOpened と対称）。
            panel.webview.postMessage({
                type: 'mainMdAssetContext',
                imageDir: resolveImagesDirForMd(initialMdPath),
                fileDir: resolveFilesDirForMd(initialMdPath),
                mdDir: path.dirname(initialMdPath)
            });
        }

        // サイドパネル管理
        const sidePanel = new SidePanelManager(
            {
                postMessage: (msg: any) => panel.webview.postMessage(msg),
                asWebviewUri: (uri: vscode.Uri) => panel.webview.asWebviewUri(uri),
            },
            {
                logPrefix: '[Notes]',
                // FR-HP-08/09: sidepanel で開いた md（リンク/subpage 遷移・他 note / note 外を含む）を Recent に記録。
                // sidePanelManager.openFile が sidepanel open の単一 choke point なので、ここ 1 箇所で全経路を捕捉する。
                onFileOpened: (fp: string) => {
                    if (!fp) return;
                    // ★reopen 2026-07-23: page md も含め全て note-md（絶対パス）で記録する（page-md kind 廃止）。
                    //   Recent クリックは kind によらず bridge.openFile(絶対パス) でメインペインに開くため、
                    //   記録も 1 種（note-md・絶対パス）に統一する。cross-note でも id が絶対パスなので自己完結。
                    fileManager.recordFileHistory(fp);
                    // 履歴パネル再描画（provider 既存の notesFileListChanged パターン）
                    panel.webview.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                        noteFolderName: path.basename(folderPath),
                    });
                },
            }
        );

        // v0.207.82: Notes 内 .md メインペイン管理 (sidepanel と同じ
        // openTextDocument + FileSystemWatcher + WorkspaceEdit パターン)
        const mdMain = new NotesMdMainManager({
            postMessage: (msg: any) => panel.webview.postMessage(msg),
            asWebviewUri: (uri: vscode.Uri) => panel.webview.asWebviewUri(uri),
        }, (filePath: string, content: string) => {
            // FR-TH-02 (★MEDIUM-3): 外部編集で確定した md の先頭 H1 を tree title に反映。
            // NotesMdMainManager は fileManager/sender を持たないため、fileManager/webview に
            // 到達できるこの生成側で反映する（hybridWatcher / onDidChangeTextDocument 両 fire site から呼ばれる）。
            let needResend = fileManager.syncTitleFromH1(filePath, content);
            // FR-TP-04（再オープン③・兄弟経路）: syncTitleFromH1 は tree item 専用。open-new-tab で開いた
            //   tree 外 md（page md 等）を外部プロセスが H1 書換した場合も、Recent history に note-md（絶対パス）で
            //   在れば再送する（notesSaveCurrentMd / saveSidePanelFile と対称。これが無いと tree 外 md の外部編集が
            //   Recent/tab に反映されない）。
            if (!needResend) {
                const fp = path.resolve(filePath);
                needResend = (fileManager.getHistory() || []).some(
                    (e) => e.kind === 'note-md' && path.resolve(e.id) === fp);
            }
            if (needResend) {
                panel.webview.postMessage({
                    type: 'notesFileListChanged',
                    fileList: fileManager.listFiles(),
                    structure: fileManager.getStructureForWebview(),
                    currentFile: fileManager.getCurrentFilePath(),
                    noteFolderName: path.basename(folderPath),
                });
                this.folderProvider?.refresh();
            }
        });

        // --- drawio watcher (MD-48 / Notes 経路): 既存 sidePanelManager とは完全分離 ---
        // NT-14 / OL-22 / MD-24 を破壊しないため、sidePanelManager / fileManager の経路には触らない。
        // Notes mode では side panel で .md を開いた際に当該 MD の drawio 参照を抽出し watcher 登録する。
        const drawioWatcher = new DrawioWatcherRegistry({
            // BUG-FIX (drawio.svg 外部編集が一部反映されない症状):
            //   旧実装は vscode.workspace.createFileSystemWatcher のみ。drawio Desktop 等の
            //   atomic-rename 保存 (write tmp → rename) を取りこぼすケースがあった。
            //   createDrawioFileWatcher は fs.watchFile (1s polling) を fallback として併用し、
            //   FileSystemWatcher の取りこぼしを polling で確実に検知する。
            createFileSystemWatcher: (drawioPath: string) =>
                createDrawioFileWatcher(drawioPath, vscode, fs),
            debounceMs: 200,
            onChange: (drawioPath: string, mdPaths: string[]) => {
                // mdPaths のいずれかが現在開いている side panel の .md と一致する場合のみ通知
                const watched = sidePanel.watchedPath;
                if (!watched) return;
                if (mdPaths.indexOf(watched) === -1) return;
                try {
                    const stat = fs.statSync(drawioPath);
                    panel.webview.postMessage({
                        type: 'sidePanelMessage',
                        data: {
                            type: 'drawioFileChanged',
                            path: drawioPath,
                            mtime: stat.mtimeMs
                        }
                    });
                } catch {
                    // file removed etc.
                }
            }
        });

        const refreshDrawioRefsForMd = (mdPath: string) => {
            try {
                if (!fs.existsSync(mdPath)) {
                    drawioWatcher.removeMd(mdPath);
                    return;
                }
                const content = fs.readFileSync(mdPath, 'utf8');
                const refs = extractDrawioReferences(content, path.dirname(mdPath));
                drawioWatcher.setReferences(mdPath, refs);
            } catch (err) {
                console.warn('[Notes] refreshDrawioRefsForMd error:', err);
            }
        };

        // SidePanelManager の onDidChangeTextDocument を観測する独立 listener を追加
        // (sidePanelManager 自体には触らない — 並走 listener として動作)
        const sidePanelDocChangeSub = vscode.workspace.onDidChangeTextDocument(e => {
            const watched = sidePanel.watchedPath;
            if (!watched) return;
            if (e.document.uri.fsPath !== watched) return;
            // sidePanelManager の applyEdit 経路にも同じ event が流れるが、内容差し替えのみ
            // — ここでは drawio refs だけ更新（document 経路には書き込まない）
            try {
                const refs = extractDrawioReferences(e.document.getText(), path.dirname(watched));
                drawioWatcher.setReferences(watched, refs);
            } catch (err) {
                console.warn('[Notes] drawio refs update error:', err);
            }
        });

        // Register openPage function for external access (in-app page links)
        const panelEntry = this.openPanels.get(folderPath);
        if (panelEntry) {
            panelEntry.openPage = async (filePath: string) => {
                // External openPage call (e.g., user clicks a page) → fresh open (clear nav history)
                await sidePanel.openFile(filePath, true);
                // MD-48: drawio refs 再スキャン（独立 watcher）
                refreshDrawioRefsForMd(filePath);
            };
        }

        // Sender
        const sender: NotesSender = {
            postMessage: (msg: unknown) => {
                panel.webview.postMessage(msg);
            },
        };

        // Notes-mode drop-import handler factory (DRY: dropFilesImport + dropVscodeUrisImport 共通骨格)
        // Close over fileManager / folderPath / panel / senderRef so the two dispatchers are one-liners
        const makeNotesDropHandler = <P>(
            senderRef: NotesSender,
            processor: (payload: P, ctx: import('./shared/drop-import').DropImportContext) => Promise<import('./shared/drop-import').DropImportResult[]>
        ) => createDropImportHandler(processor, {
            resolveDirs: () => {
                const currentOutFilePath = fileManager.getCurrentFilePath();
                const pagesDir = fileManager.getPagesDirPath();
                return {
                    fileDir: fileManager.getOutlinerFileDirPath(),
                    pageDir: pagesDir,
                    imageDir: fileManager.getOutlinerImageDirPath(),
                    outDir: currentOutFilePath ? path.dirname(currentOutFilePath) : fileManager.getMainFolderPath()
                };
            },
            postMessage: (msg: Record<string, unknown>) => senderRef.postMessage(msg),
            getDisplayUri: (p: string) => panel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
            onFailed: () => {
                vscode.window.showWarningMessage(t('dropImportFailed'));
            }
        });

        // v0.207.96: Streaming D&D sink for files > 50MB.
        // Mirrors the file/outDir resolution that makeNotesDropHandler uses.
        const dropStreamHost = new DropStreamHost({
            resolveDirs: () => {
                const currentOutFilePath = fileManager.getCurrentFilePath();
                return {
                    fileDir: fileManager.getOutlinerFileDirPath(),
                    outDir: currentOutFilePath ? path.dirname(currentOutFilePath) : fileManager.getMainFolderPath()
                };
            },
            postMessage: (msg) => sender.postMessage(msg),
            onFailed: () => {
                vscode.window.showWarningMessage(t('dropImportFailed'));
            }
        });

        // Platform Actions (全てローカル変数 panel / fileManager / folderPath をキャプチャ)
        const platform: NotesPlatformActions = {
            openExternalLink: (href: string) => {
                vscode.env.openExternal(vscode.Uri.parse(href));
            },
            openResourceRootsSettings: () => {
                vscode.commands.executeCommand('workbench.action.openSettings', 'fractal.resourceRoots');
            },
            // FR-MG-03/05/07: 起動時移行ゲートの「移行する」→ backup → validate → execute → 成功で reopen。
            runFlatMigration: async () => {
                const flatMigrate = await import('./shared/flat-migrate');
                try {
                    const plan = flatMigrate.planMigration(folderPath); // 再計算（再試行対応）
                    const v = flatMigrate.validatePlan(plan);
                    if (!v.ok) {
                        sender.postMessage({ type: 'migrationFailed', reasons: v.reasons.slice(0, 5) });
                        return;
                    }
                    // ★ FR-MG-07: executePlan（実ファイル rename/copy/rmdir）の前に note フォルダを丸ごと backup。
                    //   backup 先は noteDir の「外」（planMigration/executePlan の走査対象外・自己参照回避）。
                    let backupPath: string;
                    try {
                        backupPath = this.backupNoteFolder(folderPath);
                    } catch (e) {
                        // backup に失敗したら破壊的操作を走らせない（保険が無い状態で executePlan しない）。
                        sender.postMessage({ type: 'migrationFailed', reasons: ['バックアップに失敗したため移行を中止しました: ' + String((e as Error).message || e)] });
                        return;
                    }
                    const res = flatMigrate.executePlan(plan);
                    if (res.rolledBack) {
                        // FR-MG-09: 移行中エラー → executePlan が自動で旧レイアウトに巻き戻し済み。復旧場所も明示。
                        sender.postMessage({ type: 'migrationFailed', reasons: [
                            '移行中にエラーが発生したため、旧レイアウトに自動復元しました: ' + (res.error ?? ''),
                            'バックアップ（移行前の完全な状態）: ' + backupPath,
                        ] });
                        return;
                    }
                    // ★ FR-MG-08/11/12: 成功（backup 済み + rolledBack=false）→ 旧 outliner サブフォルダを削除して
                    //   note 直下をクリーンに。実削除は flat-migrate.cleanupOldDirs に閉じ込め（DOD-24 allowlist）。
                    //   ★ FR-MG-12 で画像/添付も cross-outliner 横断探索するため、plan.unresolved に残るのは
                    //   「全候補を探しても実体がどこにも無い」= 真の元々壊れリンクだけ → 削除してよい（失うもの無し）。
                    //   掃除失敗は非致命（backup に原本あり）→ log のみ、移行は成功扱い。
                    try {
                        const cleaned = flatMigrate.cleanupOldDirs(plan);
                        if (cleaned.errors.length > 0) {
                            console.warn('[NotesMigration] cleanup errors (non-fatal, backup exists):', cleaned.errors);
                        }
                    } catch (e) {
                        console.warn('[NotesMigration] cleanupOldDirs failed (non-fatal):', e);
                    }
                    // 成功 → 開き直し（flat になったので次の open は本体が出る = FR-MG-04。backup は残す）。
                    await this.disposeAndReopenNotePanel(folderPath);
                    // FR-MG-09/11: backup 場所 + 復旧手順を明示。元々壊れリンク（unresolved）があれば併せて通知。
                    const broken = (plan.unresolved || []);
                    if (broken.length > 0) {
                        vscode.window.showWarningMessage(
                            `フラットレイアウトへの移行が完了しました。ただし参照先が見つからなかった項目があります（実体が存在せず、旧フォルダは削除しました）: ${broken.slice(0, 5).join(' / ')}${broken.length > 5 ? ` ほか${broken.length - 5}件` : ''}。` +
                            `移行前の状態は「${backupPath}」にバックアップされています。`
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            `フラットレイアウトへの移行が完了しました。移行前の状態は「${backupPath}」にバックアップされています。` +
                            `問題があれば、このノートフォルダを削除し、バックアップフォルダを元の場所に戻してください。`
                        );
                    }
                } catch (e) {
                    sender.postMessage({ type: 'migrationFailed', reasons: [String((e as Error).message || e)] });
                }
            },
            exportBundle: (rootMdAbs: string, options) => {
                void runExportBundle(rootMdAbs, options);
            },
            // FR-PDF-08 / TASK-11: Notes panel の PDF export。メッセージを受けた自 panel を
            // opts.panel で渡し getTargets 走査を省く（editorProvider / outlinerProvider の
            // case 'exportPdf' と同型）。targetHint は webview 側が付与:
            //   Notes md タブ（main pane bridge）='main-md' / .out タブ + sidepanel header='sidepanel-md'。
            // pdf-export-webview 側の resolvePdfTarget が hint に従って main/sidepanel md を解決する。
            exportPdf: (targetHint?: string) => {
                const deps = buildPdfExportDeps(() => [], (k) => t(k as any));
                void runExportMdToPdf(deps, {
                    panel: panel as unknown as PdfPanelLike,
                    targetHint: targetHint || 'main-md',
                });
            },
            exportOutlinerNodesBundle: (args) => {
                void runExportOutlinerNodesBundle(args as Parameters<typeof runExportOutlinerNodesBundle>[0]);
            },
            navigateInAppLink: (href: string) => {
                vscode.commands.executeCommand('fractal.navigateInAppLink', href);
            },
            requestInsertLink: async (text: string, sender: { postMessage(msg: unknown): void }) => {
                const linkUrl = await vscode.window.showInputBox({
                    prompt: t('enterUrl'),
                    placeHolder: 'https://example.com'
                });
                if (linkUrl) {
                    const linkText = text || await vscode.window.showInputBox({
                        prompt: t('enterLinkText'),
                        placeHolder: 'Link text',
                        value: 'link'
                    }) || 'link';
                    sender.postMessage({
                        type: 'insertLinkHtml',
                        url: linkUrl,
                        text: linkText
                    });
                }
            },
            openFileInEditor: (filePath: string) => {
                const uri = vscode.Uri.file(filePath);
                vscode.commands.executeCommand('vscode.openWith', uri, 'fractal.editor');
            },
            openPageInSidePanel: async (filePath: string, lineNumber?: number, query?: string, occurrence?: number) => {
                if (!fs.existsSync(filePath)) {
                    vscode.window.showWarningMessage(`Page file not found: ${filePath}`);
                    return;
                }
                // Outliner → side panel = fresh open (clear nav history → back button starts disabled)
                await sidePanel.openFile(filePath, true);
                // MD-48: drawio refs 再スキャン
                refreshDrawioRefsForMd(filePath);
                // キーワードベースのジャンプを優先（行番号は表示HTMLとずれて失敗するため）
                if (query) {
                    setTimeout(() => {
                        panel.webview.postMessage({
                            type: 'scrollToText',
                            text: query,
                            occurrence: occurrence || 0,
                        });
                    }, 500);
                } else if (lineNumber !== undefined) {
                    setTimeout(() => {
                        panel.webview.postMessage({
                            type: 'scrollToLine',
                            lineNumber: lineNumber,
                        });
                    }, 500);
                }
            },
            openFileExternal: async (filePath: string) => {
                const uri = vscode.Uri.file(filePath);
                await vscode.commands.executeCommand('vscode.open', uri);
            },
            openInTextEditor: () => {
                const fp = fileManager.getCurrentFilePath();
                if (fp) {
                    vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fp), 'default');
                }
            },
            copyFilePath: () => {
                const fp = fileManager.getCurrentFilePath();
                if (fp) {
                    vscode.env.clipboard.writeText(fp);
                }
            },
            copyPagePaths: (paths: string[]) => {
                vscode.env.clipboard.writeText(paths.join('\n'));
            },
            requestInsertImage: async (sidePanelFilePath: string) => {
                // FR: sidepanel で開いている md の場所を基準に保存（別 note / 非 note 対応）
                const imagesDir = resolveImagesDirForMd(sidePanelFilePath);
                if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                const options: vscode.OpenDialogOptions = {
                    canSelectMany: false,
                    filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] },
                };
                const fileUris = await vscode.window.showOpenDialog(options);
                if (fileUris && fileUris[0]) {
                    const srcPath = fileUris[0].fsPath;
                    const imgFileName = path.basename(srcPath);
                    const destPath = path.join(imagesDir, imgFileName);
                    fs.copyFileSync(srcPath, destPath);
                    const spDir = path.dirname(sidePanelFilePath);
                    const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath: relPath,
                        displayUri,
                        sidePanelFilePath, // FR: 宛先=sidepanel
                    });
                }
            },
            savePanelCollapsed: (collapsed: boolean) => {
                this.context.globalState.update(
                    `notesPanelCollapsed:${folderPath}`, collapsed
                );
            },
            saveNoteSidePanelWidth: (width: number) => {
                fileManager.saveSidePanelWidth(width);
            },
            saveNoteSidePanelOutlineWidth: (width: number) => {
                fileManager.saveSidePanelOutlineWidth(width);
            },
            requestSetPageDir: async () => {
                if (!fileManager.getCurrentFilePath()) return;
                const currentDir = fileManager.getPagesDirPath();
                const outDir = path.dirname(fileManager.getCurrentFilePath()!);
                const relCurrent = path.relative(outDir, currentDir);
                const input = await vscode.window.showInputBox({
                    prompt: 'Enter page directory (relative to .out file or absolute)',
                    value: relCurrent || './pages',
                });
                if (input !== undefined) {
                    try {
                        const content = fs.readFileSync(fileManager.getCurrentFilePath()!, 'utf8');
                        const data = JSON.parse(content);
                        data.pageDir = input || undefined;
                        const jsonStr = JSON.stringify(data, null, 2);
                        fs.writeFileSync(fileManager.getCurrentFilePath()!, jsonStr, 'utf8');
                        panel.webview.postMessage({
                            type: 'pageDirChanged',
                            pageDir: input,
                        });
                    } catch {
                        vscode.window.showErrorMessage('Failed to update page directory setting');
                    }
                }
            },
            saveOutlinerImage: (nodeId: string, dataUrl: string, fileName: string) => {
                const pagesDir = fileManager.getPagesDirPath();
                const imagesDir = fileManager.getOutlinerImageDirPath();
                if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                const parsed = parseDataUrl(dataUrl);
                if (!parsed) return;
                let imgFileName = fileName;
                if (!imgFileName) {
                    imgFileName = `image_${Date.now()}.${parsed.ext}`;
                }
                const destPath = path.join(imagesDir, imgFileName);
                fs.writeFileSync(destPath, parsed.buffer);
                const outFilePath = fileManager.getCurrentFilePath();
                const outDir = outFilePath ? path.dirname(outFilePath) : fileManager.getMainFolderPath();
                const relativePath = path.relative(outDir, destPath).replace(/\\/g, '/');
                const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                sender.postMessage({
                    type: 'outlinerImageSaved',
                    nodeId: nodeId,
                    imagePath: relativePath,
                    displayUri: displayUri
                });
            },
            importMdFilesDialog: async (targetNodeId: string | null, senderRef: NotesSender) => {
                const options: vscode.OpenDialogOptions = {
                    canSelectMany: true,
                    canSelectFiles: true,
                    canSelectFolders: false,
                    filters: { 'Markdown': ['md'] },
                    title: 'Import .md files'
                };
                const fileUris = await vscode.window.showOpenDialog(options);
                if (!fileUris || fileUris.length === 0) return;

                const filePaths = fileUris.map(u => u.fsPath).sort();
                const pagesDir = fileManager.getPagesDirPath();
                const imageDir = fileManager.getOutlinerImageDirPath();
                const results = importMdFiles(filePaths, pagesDir, imageDir);

                senderRef.postMessage({
                    type: 'importMdFilesResult',
                    results,
                    targetNodeId,
                    position: 'after'
                });
            },
            importFilesDialog: async (targetNodeId: string | null, senderRef: NotesSender) => {
                const options: vscode.OpenDialogOptions = {
                    canSelectMany: true,
                    canSelectFiles: true,
                    canSelectFolders: false,
                    title: 'Import files'
                };
                const fileUris = await vscode.window.showOpenDialog(options);
                if (!fileUris || fileUris.length === 0) return;

                const filePaths = fileUris.map(u => u.fsPath).sort();
                // Notes mode: fileDir = 共有 files/ (flat-layout)
                const currentOutFilePath = fileManager.getCurrentFilePath();
                if (!currentOutFilePath) return;
                const fileDir = fileManager.getOutlinerFileDirPath();
                const outDir = path.dirname(currentOutFilePath);
                const results = importFiles(filePaths, fileDir, outDir);

                senderRef.postMessage({
                    type: 'importFilesResult',
                    results,
                    targetNodeId,
                    position: 'after'
                });
            },
            dropFilesImport: async (items: DropImportItem[], targetNodeId: string | null, position: string, senderRef: NotesSender) => {
                if (!fileManager.getCurrentFilePath()) return;
                await makeNotesDropHandler(senderRef, processDropFilesImport)(items, targetNodeId, position);
            },
            dropVscodeUrisImport: async (uris: string[], targetNodeId: string | null, position: string, senderRef: NotesSender) => {
                // v12 拡張: VSCode Explorer D&D (Notes mode)
                if (!fileManager.getCurrentFilePath()) return;
                await makeNotesDropHandler(senderRef, processDropVscodeUrisImport)(uris, targetNodeId, position);
            },
            notifyDropFolderRejected: () => {
                vscode.window.showWarningMessage(t('dropFolderRejected'));
            },
            notifyDropFileTooLarge: (fileName: string) => {
                vscode.window.showWarningMessage(`${t('dropFileTooLarge')}: ${fileName}`);
            },
            dropStreamMessage: (message) => dropStreamHost.handle(message),
            showInformationMessage: (text: string) => {
                vscode.window.showInformationMessage(text);
            },
            showErrorMessage: (text: string) => {
                vscode.window.showErrorMessage(text);
            },
            openAttachedFile: async (nodeId: string, outFilePath: string, senderRef: NotesSender) => {
                const content = fs.readFileSync(outFilePath, 'utf8');
                const data = JSON.parse(content);
                const node = data.nodes?.[nodeId];
                if (!node?.filePath) return;

                const outDir = path.dirname(outFilePath);
                const safeFilePath = safeResolveUnderDir(outDir, node.filePath);
                if (!safeFilePath) {
                    vscode.window.showErrorMessage(t('fileNotFoundOrUnsafe'));
                    return;
                }

                if (!fs.existsSync(safeFilePath)) {
                    vscode.window.showErrorMessage(t('fileNotFound'));
                    return;
                }

                // Use openExternal to open with OS default app
                await vscode.env.openExternal(vscode.Uri.file(safeFilePath));
            },
            // FR-NT-03: note タイトル変更後に Notes Folder ツリーを更新
            refreshNotesFolderTree: () => {
                this.folderProvider?.refresh();
            },
            // FR-FR-01: file 添付ノードを OS ファイラ (Finder) で選択状態表示
            revealAttachedFileInOS: async (nodeId: string, outFilePath: string, _senderRef: NotesSender) => {
                const content = fs.readFileSync(outFilePath, 'utf8');
                const data = JSON.parse(content);
                const node = data.nodes?.[nodeId];
                if (!node?.filePath) return;
                const outDir = path.dirname(outFilePath);
                const safeFilePath = safeResolveUnderDir(outDir, node.filePath);
                if (!safeFilePath || !fs.existsSync(safeFilePath)) {
                    vscode.window.showErrorMessage(t('fileNotFound'));
                    return;
                }
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(safeFilePath));
            },
            // FR-FR-02: md ページ実体を OS ファイラ (Finder) で選択状態表示
            revealPageInOS: async (nodeId: string, fm: NotesFileManager, _senderRef: NotesSender) => {
                const outFilePath = fm.getCurrentFilePath();
                if (!outFilePath) return;
                const content = fs.readFileSync(outFilePath, 'utf8');
                const data = JSON.parse(content);
                const node = data.nodes?.[nodeId];
                if (!node?.isPage || !node.pageId) return;
                const pagesDir = fm.getPagesDirPath(data);
                const pagePath = path.join(pagesDir, `${node.pageId}.md`);
                if (!fs.existsSync(pagePath)) {
                    vscode.window.showErrorMessage(t('fileNotFound'));
                    return;
                }
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pagePath));
            },
            // FR-MV-01: Notes タブの項目を別 Note へ移動 (QuickPick で移動先選択)
            moveItemToOtherNote: async (itemId: string, fm: NotesFileManager, senderRef: NotesSender) => {
                await this.handleMoveItemToOtherNote(itemId, fm, senderRef);
            },
            copyImageToClipboard: async (absPath: string) => {
                await copyImageToClipboard(absPath);
            },
            openImageInNewTab: async (absPath: string) => {
                await openImageInNewTab(absPath);
            },
            openDrawioExternal: async (absPath: string) => {
                const { openDrawioExternal } = await import('./shared/drawio-external');
                await openDrawioExternal(absPath);
            },
            // FR-OL-COPYPATH-1: file 添付ノードの絶対 path を OS clipboard へコピー
            copyAttachedFilePath: async (nodeId: string, outFilePath: string, _senderRef: NotesSender) => {
                const content = fs.readFileSync(outFilePath, 'utf8');
                const data = JSON.parse(content);
                const node = data.nodes?.[nodeId];
                if (!node?.filePath) return;

                const outDir = path.dirname(outFilePath);
                const safeFilePath = safeResolveUnderDir(outDir, node.filePath);
                if (!safeFilePath) {
                    vscode.window.showWarningMessage(t('fileNotFoundOrUnsafe'));
                    return;
                }
                await vscode.env.clipboard.writeText(safeFilePath);
            },
            // v0.207.48: 複数ノードの添付 file path を改行区切りで OS clipboard へコピー
            copyAttachedFilePaths: async (nodeIds: string[], outFilePath: string, _senderRef: NotesSender) => {
                const content = fs.readFileSync(outFilePath, 'utf8');
                const data = JSON.parse(content);
                const outDir = path.dirname(outFilePath);
                const paths: string[] = [];
                for (const nid of nodeIds) {
                    const n = data.nodes?.[nid];
                    if (!n?.filePath) continue;
                    const safe = safeResolveUnderDir(outDir, n.filePath);
                    if (safe) paths.push(safe);
                }
                if (paths.length > 0) {
                    await vscode.env.clipboard.writeText(paths.join('\n'));
                }
            },
            // llms.txt 風 subtree コピー (MD pages)
            copyLlmsTxtMdTree: async (tree: unknown, _outFilePath: string, _senderRef: NotesSender) => {
                if (!tree) return;
                const pagesDir = fileManager.getPagesDirPath();
                const md = buildLlmsTxt(tree as LlmsTxtTreeNode, 'md', {
                    resolveMdPath: (pageId: string) => {
                        const p = path.join(pagesDir, `${pageId}.md`);
                        return fs.existsSync(p) ? p : null;
                    },
                    resolveFilePath: () => null,
                });
                if (md.trim()) {
                    await vscode.env.clipboard.writeText(md);
                }
            },
            // llms.txt 風 subtree コピー (file attachments)
            copyLlmsTxtFileTree: async (tree: unknown, outFilePath: string, _senderRef: NotesSender) => {
                if (!tree) return;
                const outDir = path.dirname(outFilePath);
                const md = buildLlmsTxt(tree as LlmsTxtTreeNode, 'file', {
                    resolveMdPath: () => null,
                    resolveFilePath: (rel: string) => {
                        const safe = safeResolveUnderDir(outDir, rel);
                        if (!safe) return null;
                        return fs.existsSync(safe) ? safe : null;
                    },
                });
                if (md.trim()) {
                    await vscode.env.clipboard.writeText(md);
                }
            },
            // llms.txt 風 subtree コピー (MD pages + file attachments)
            copyLlmsTxtBothTree: async (tree: unknown, outFilePath: string, _senderRef: NotesSender) => {
                if (!tree) return;
                const pagesDir = fileManager.getPagesDirPath();
                const outDir = path.dirname(outFilePath);
                const md = buildLlmsTxt(tree as LlmsTxtTreeNode, 'both', {
                    resolveMdPath: (pageId: string) => {
                        const p = path.join(pagesDir, `${pageId}.md`);
                        return fs.existsSync(p) ? p : null;
                    },
                    resolveFilePath: (rel: string) => {
                        const safe = safeResolveUnderDir(outDir, rel);
                        if (!safe) return null;
                        return fs.existsSync(safe) ? safe : null;
                    },
                });
                if (md.trim()) {
                    await vscode.env.clipboard.writeText(md);
                }
            },
            saveImageToDir: (dataUrl: string, fileName: string, sidePanelFilePath: string) => {
                const imagesDir = resolveImagesDirForMd(sidePanelFilePath);
                if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                const parsed = parseDataUrl(dataUrl);
                if (!parsed) return;
                let imgFileName = fileName;
                if (!imgFileName) {
                    imgFileName = `image_${Date.now()}.${parsed.ext}`;
                }
                const destPath = path.join(imagesDir, imgFileName);
                fs.writeFileSync(destPath, parsed.buffer);
                const spDir = path.dirname(sidePanelFilePath);
                const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                panel.webview.postMessage({
                    type: 'insertImageHtml',
                    markdownPath: relPath,
                    displayUri,
                    dataUri: dataUrl,
                    sidePanelFilePath, // FR: 宛先=sidepanel（受信側が自分宛か判定）
                });
            },
            readAndInsertImage: (filePath: string, sidePanelFilePath: string) => {
                const imagesDir = resolveImagesDirForMd(sidePanelFilePath);
                if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                const imgFileName = path.basename(filePath);
                const destPath = path.join(imagesDir, imgFileName);
                try {
                    fs.copyFileSync(filePath, destPath);
                    const spDir = path.dirname(sidePanelFilePath);
                    const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath: relPath,
                        displayUri,
                        sidePanelFilePath, // FR: 宛先=sidepanel
                    });
                } catch (e) {
                    console.error('[Notes] readAndInsertImage error:', e);
                }
            },
            saveFileToDir: (dataUrl: string, fileName: string, sidePanelFilePath: string) => {
                // FR: sidepanel で開いている md の場所を基準に保存（別 note / 非 note 対応）
                const filesDir = resolveFilesDirForMd(sidePanelFilePath);
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                // Generate unique filename preserving original
                let destFileName = fileName;
                let destPath = path.join(filesDir, destFileName);
                let counter = 1;
                while (fs.existsSync(destPath)) {
                    const ext = path.extname(fileName);
                    const base = path.basename(fileName, ext);
                    destFileName = `${base}-${counter}${ext}`;
                    destPath = path.join(filesDir, destFileName);
                    counter++;
                }

                try {
                    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
                    fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
                    const spDir = path.dirname(sidePanelFilePath);
                    const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                    panel.webview.postMessage({
                        type: 'insertFileLink',
                        markdownPath: relPath,
                        fileName: destFileName,
                        sidePanelFilePath, // FR: 宛先=sidepanel
                    });
                } catch (e) {
                    console.error('[Notes] saveFileToDir error:', e);
                }
            },
            readAndInsertFile: (filePath: string, sidePanelFilePath: string) => {
                const filesDir = resolveFilesDirForMd(sidePanelFilePath);
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                const originalName = path.basename(filePath);
                let destFileName = originalName;
                let destPath = path.join(filesDir, destFileName);
                let counter = 1;
                while (fs.existsSync(destPath)) {
                    const ext = path.extname(originalName);
                    const base = path.basename(originalName, ext);
                    destFileName = `${base}-${counter}${ext}`;
                    destPath = path.join(filesDir, destFileName);
                    counter++;
                }

                try {
                    fs.copyFileSync(filePath, destPath);
                    const spDir = path.dirname(sidePanelFilePath);
                    const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                    panel.webview.postMessage({
                        type: 'insertFileLink',
                        markdownPath: relPath,
                        fileName: destFileName,
                        sidePanelFilePath, // FR: 宛先=sidepanel
                    });
                } catch (e) {
                    console.error('[Notes] readAndInsertFile error:', e);
                }
            },

            // ── ADR-008: Notes 内 .md メインペイン editor 用 ──
            // 保存先は常に <note>/images,files 固定・相対挿入（設定による上書きは廃止）。
            // md ファイルは <note>/<id>.md (フラット) にあり、getMdImagesDirPath() が
            // <note>/images/ を返すので images/<fileName> という相対 path を生成できる。
            saveMdImageToDir: (dataUrl: string, fileName: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                const parsed = parseDataUrl(dataUrl);
                if (!parsed) return;
                // Notes モードは常に <note>/images/ 固定・相対挿入。
                const imagesDir = fileManager.getMdImagesDirPath();
                ensureDirectoryExists(imagesDir);
                const useAbsolute = false;
                const forceRelative = false;
                const ext = parsed.ext || mimeToExt(parsed.ext) || 'png';
                const destFileName = fileName
                    ? generateUniqueFileNamePreserving(imagesDir, fileName)
                    : generateUniqueFileName(imagesDir, ext);
                const destPath = path.join(imagesDir, destFileName);
                try {
                    fs.writeFileSync(destPath, parsed.buffer);
                    const markdownPath = toMarkdownPath(destPath, cur, useAbsolute, forceRelative);
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath,
                        displayUri,
                        dataUri: dataUrl,
                    });
                } catch (e) {
                    console.error('[Notes] saveMdImageToDir error:', e);
                }
            },
            readAndInsertMdImage: (filePath: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                // Notes モードは常に <note>/images/ 固定・相対挿入。
                const imagesDir = fileManager.getMdImagesDirPath();
                ensureDirectoryExists(imagesDir);
                const useAbsolute = false;
                const forceRelative = false;
                const destFileName = generateUniqueFileNamePreserving(imagesDir, path.basename(filePath));
                const destPath = path.join(imagesDir, destFileName);
                try {
                    fs.copyFileSync(filePath, destPath);
                    const markdownPath = toMarkdownPath(destPath, cur, useAbsolute, forceRelative);
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath,
                        displayUri,
                    });
                } catch (e) {
                    console.error('[Notes] readAndInsertMdImage error:', e);
                }
            },
            saveMdFileToDir: (dataUrl: string, fileName: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                // Notes モードは常に <note>/files/ 固定・相対挿入。
                const filesDir = fileManager.getMdFilesDirPath();
                ensureDirectoryExists(filesDir);
                const useAbsolute = false;
                const forceRelative = false;
                const destFileName = generateUniqueFileNamePreserving(filesDir, fileName || `file_${Date.now()}`);
                const destPath = path.join(filesDir, destFileName);
                try {
                    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
                    fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
                    const markdownPath = toMarkdownPath(destPath, cur, useAbsolute, forceRelative);
                    panel.webview.postMessage({
                        type: 'insertFileLink',
                        markdownPath,
                        fileName: destFileName,
                    });
                } catch (e) {
                    console.error('[Notes] saveMdFileToDir error:', e);
                }
            },
            // FR-B07 (sprint 20260804-145603): Notes md メインペインへの .md D&D → subpage 登録。
            // 編集中 md と同階層（= note md ルート flat）に一意名コピー + insertSubpageLink 返信 +
            // ファイルツリーにも登録（ユーザー仕様「note フォルダに登録」）。
            saveMdAsSubpageForNotesMd: (dataUrl: string, fileName: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                try {
                    const r = saveDroppedMdAsSubpage(cur, dataUrlToUtf8(dataUrl), fileName || 'untitled.md');
                    panel.webview.postMessage({
                        type: 'insertSubpageLink',
                        markdownPath: r.relPath,
                        title: r.title,
                    });
                } catch (e) {
                    console.error('[Notes] saveMdAsSubpageForNotesMd error:', e);
                }
            },
            readMdAsSubpageForNotesMd: (filePath: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const r = saveDroppedMdAsSubpage(cur, content, path.basename(filePath));
                    panel.webview.postMessage({
                        type: 'insertSubpageLink',
                        markdownPath: r.relPath,
                        title: r.title,
                    });
                } catch (e) {
                    console.error('[Notes] readMdAsSubpageForNotesMd error:', e);
                }
            },
            // FR-B09 (TASK-08): ファイルツリー md → md editor D&D。ファイルは note 内に既存
            //（1:1 所有はツリー item が保持）なのでコピーせず、既存 md への subpage リンクのみ挿入
            linkMdAsSubpageForNotesMd: (filePath: string, mdFileId?: string | null) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                if (!fs.existsSync(filePath)) return;
                if (path.resolve(filePath) === path.resolve(cur)) return; // 自分自身へのリンクは無意味
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    // TASK-16 (US-09 cross-note): main pane は Recent 履歴経由で別 note / note 外の
                    // md を開きうる。cur が this-note（mainFolder）外なら、リンク + ツリー除去でなく
                    // **cur の隣へ複製**する（相手側に実体を渡す。this-note のツリーは触らない = 所有不変）
                    const mainFolder = fileManager.getMainFolderPath();
                    const curInThisNote = !path.relative(mainFolder, path.resolve(cur)).startsWith('..');
                    if (!curInThisNote) {
                        const r = saveDroppedMdAsSubpage(cur, content, path.basename(filePath));
                        panel.webview.postMessage({
                            type: 'insertSubpageLink',
                            markdownPath: r.relPath,
                            title: r.title,
                        });
                        return;
                    }
                    const relPath = path.relative(path.dirname(cur), filePath).replace(/\\/g, '/');
                    panel.webview.postMessage({
                        type: 'insertSubpageLink',
                        markdownPath: relPath,
                        title: resolveSubpageTitle(content, path.basename(filePath)),
                    });
                    // US-09: subpage 化したらツリーから md エントリを除去（ファイル実体・ファイル名は不変。
                    // notesImportMdIntoOut の「画面のエントリは消す・物理は消さない」と同じ方針）
                    if (mdFileId) {
                        fileManager.unregisterMdFromStructureOnly(mdFileId);
                        panel.webview.postMessage({
                            type: 'notesFileListChanged',
                            fileList: fileManager.listFiles(),
                            structure: fileManager.getStructureForWebview(),
                            currentFile: fileManager.getCurrentFilePath(),
                        });
                    }
                } catch (e) {
                    console.error('[Notes] linkMdAsSubpageForNotesMd error:', e);
                }
            },
            // TASK-17 (US-09 sidepanel): ツリー md → sidepanel md への D&D。
            // sidepanel は別 note の md を開きうる（page link 遷移・Recent）ので同一 note 判定が必須:
            //   同一 note → コピーせずリンク + ツリー除去 / 別 note → sidepanel md の隣へ複製 +
            //   ツリー除去（FR-TF-18 = cmd+x source orphan 契約への統一。元 md 実体は温存 = orphan 化し
            //   元 note の Clean Notes が回収。旧挙動「元 tree item 温存」は 2026-08-10 再オープン⑤で変更）
            linkMdAsSubpageForSidePanel: (filePath: string, mdFileId: string | null, sidePanelFilePath: string) => {
                linkMdAsSubpageForSidePanelCore(
                    fileManager,
                    { postMessage: (m: unknown) => panel.webview.postMessage(m) },
                    filePath, mdFileId, sidePanelFilePath
                );
            },
            // FR-B07: Notes sidepanel md への .md D&D → subpage 登録（sidepanel md と同階層）
            saveMdAsSubpageForSidePanel: (dataUrl: string, fileName: string, sidePanelFilePath: string) => {
                try {
                    const r = saveDroppedMdAsSubpage(sidePanelFilePath, dataUrlToUtf8(dataUrl), fileName || 'untitled.md');
                    panel.webview.postMessage({
                        type: 'insertSubpageLink',
                        markdownPath: r.relPath,
                        title: r.title,
                        sidePanelFilePath,
                    });
                } catch (e) {
                    console.error('[Notes] saveMdAsSubpageForSidePanel error:', e);
                }
            },
            readMdAsSubpageForSidePanel: (filePath: string, sidePanelFilePath: string) => {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const r = saveDroppedMdAsSubpage(sidePanelFilePath, content, path.basename(filePath));
                    panel.webview.postMessage({
                        type: 'insertSubpageLink',
                        markdownPath: r.relPath,
                        title: r.title,
                        sidePanelFilePath,
                    });
                } catch (e) {
                    console.error('[Notes] readMdAsSubpageForSidePanel error:', e);
                }
            },
            readAndInsertMdFile: (filePath: string) => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                // Notes モードは常に <note>/files/ 固定・相対挿入。
                const filesDir = fileManager.getMdFilesDirPath();
                ensureDirectoryExists(filesDir);
                const useAbsolute = false;
                const forceRelative = false;
                const destFileName = generateUniqueFileNamePreserving(filesDir, path.basename(filePath));
                const destPath = path.join(filesDir, destFileName);
                try {
                    fs.copyFileSync(filePath, destPath);
                    const markdownPath = toMarkdownPath(destPath, cur, useAbsolute, forceRelative);
                    panel.webview.postMessage({
                        type: 'insertFileLink',
                        markdownPath,
                        fileName: destFileName,
                    });
                } catch (e) {
                    console.error('[Notes] readAndInsertMdFile error:', e);
                }
            },
            // v0.207.82: Notes 内 .md メインペイン用 — 相対画像/ファイル URL の解決基準
            getMdDocumentBaseUri: (filePath: string): string => {
                if (!filePath) return '';
                const docDir = vscode.Uri.file(path.dirname(filePath));
                return panel.webview.asWebviewUri(docDir).toString();
            },
            // FR-RR-04: Notes 本体 md open 時、その md の画像に許可範囲外があればフッター案内を送る
            sendResourceAccessStatus: (filePath: string, mdBody: string): void => {
                try {
                    if (!filePath) return;
                    const config = vscode.workspace.getConfiguration('fractal');
                    const roots = resolveResourceRoots(config.get<string[]>('resourceRoots', []));
                    const outOfRange = findOutOfRangeImages(mdBody, path.dirname(filePath), roots);
                    panel.webview.postMessage({
                        type: 'resourceAccessStatus',
                        outOfRange: outOfRange.length > 0,
                        count: outOfRange.length,
                        samplePath: outOfRange[0],
                    });
                } catch { /* best-effort */ }
            },
            // v0.207.82: Notes 内 .md メインペイン用 — 画像/ファイル保存先をステータスバーに送出。
            // editorProvider の sendImageDirStatus / sendFileDirStatus と同じ shape で post。
            sendMdDirStatus: () => {
                const cur = fileManager.getCurrentFilePath();
                if (!cur || !cur.endsWith('.md')) return;
                const docDir = path.dirname(cur);

                // Notes モードは常に <note>/images,files 固定・相対表示。editable=false（保存先変更 UI は standalone md 限定）。
                const imgDisplay = path.relative(docDir, fileManager.getMdImagesDirPath()).replace(/\\/g, '/') || '.';
                panel.webview.postMessage({
                    type: 'imageDirStatus',
                    displayPath: imgDisplay,
                    source: 'default',
                    locked: false,
                    editable: false,
                });

                const fileDisplay = path.relative(docDir, fileManager.getMdFilesDirPath()).replace(/\\/g, '/') || '.';
                panel.webview.postMessage({
                    type: 'fileDirStatus',
                    displayPath: fileDisplay,
                    source: 'default',
                    locked: false,
                    editable: false,
                });
            },
            // v0.207.82: Notes 内 .md メインペインが開いた時 — TextDocument open +
            // FileSystemWatcher 起動（sidepanel と同じ pattern）。外部編集を検知して
            // webview に updateData kind:'md' を relay する。
            mdMainOpened: (filePath: string) => {
                mdMain.setupFileWatcher(filePath).catch(e => {
                    console.error('[Notes] mdMain.setupFileWatcher error:', e);
                });
                // FR-XP-01 (sprint 20260808-000219): main md の assetContext 配線。
                // md メインペイン open の単一 choke point。dir 解決は sidepanel 送信
                // (sendSidePanelImageDir :1698-1704) と同じ flat-layout ヘルパ（新規解決ロジック禁止）。
                panel.webview.postMessage({
                    type: 'mainMdAssetContext',
                    imageDir: resolveImagesDirForMd(filePath),
                    fileDir: resolveFilesDirForMd(filePath),
                    mdDir: path.dirname(filePath)
                });
            },
            // v0.207.82: Notes 内 .md 以外のファイル (.out) に切り替わった時 / md ファイルが
            // 削除された時 — TextDocument / watcher を破棄。
            mdMainClosed: () => {
                mdMain.disposeFileWatcher();
            },
            // v0.207.82: Notes 内 .md auto-save 経路 — sidepanel と同じく
            // TextDocument バッファ経由 (WorkspaceEdit) で書く。fileManager の debounced
            // fs.writeFile 経路は使わない (FileSystemWatcher との二重発火を避けるため)。
            mdMainSave: async (filePath: string, content: string) => {
                await mdMain.handleSave(filePath, content);
            },
            // v0.207.86: Notes 内 .md メインペインの cmd+/ → Add Page
            // standalone editor の createPageAuto と同じ semantics で
            // <md ファイルの dir>/pages/<unique>.md を作成し、md ファイルからの相対 path を
            // pageCreatedAtPath で返す。
            // Notes 構造では md ファイルは _notes_md/<id>.md にあるため、
            // pages dir は _notes_md/pages/ になり、相対 path は ./pages/<unique>.md。
            notesMdCreatePageAuto: (currentMdFilePath: string) => {
                if (!currentMdFilePath || !currentMdFilePath.endsWith('.md')) return;
                // Add Page (cmd+/) は「今の md と同じ階層」に作る。従来は pages/ サブフォルダに
                // 作っており、standalone/sidepanel (outliner page 検出で同階層に作る) と挙動が
                // 食い違っていた (ユーザー報告)。→ mdDir 直下に作成しリンクは [page](xxx.md)。
                const mdDir = path.dirname(currentMdFilePath);
                if (!fs.existsSync(mdDir)) {
                    try {
                        fs.mkdirSync(mdDir, { recursive: true });
                    } catch (e) {
                        console.error('[Notes] notesMdCreatePageAuto mkdir error:', e);
                        return;
                    }
                }
                const fileName = generateUniqueFileName(mdDir, 'md');
                const absPath = path.join(mdDir, fileName);
                try {
                    fs.writeFileSync(absPath, '# ', 'utf8');
                } catch (e) {
                    console.error('[Notes] notesMdCreatePageAuto write error:', e);
                    return;
                }
                const relPath = path.relative(mdDir, absPath).replace(/\\/g, '/');
                panel.webview.postMessage({
                    type: 'pageCreatedAtPath',
                    relativePath: relPath,
                });
            },
            notesMdUpdatePageH1: (currentMdFilePath: string, relativePath: string, h1Text: string) => {
                if (!currentMdFilePath || !relativePath || !h1Text) return;
                const mdDir = path.dirname(currentMdFilePath);
                const absPath = path.resolve(mdDir, relativePath);
                // safety: 解決後 path が _notes_md/ 配下に収まることを確認
                const mdRoot = fileManager.getMdRootDirPath();
                if (!absPath.startsWith(mdRoot + path.sep) && absPath !== mdRoot) {
                    console.warn('[Notes] notesMdUpdatePageH1 rejected (outside md root):', absPath);
                    return;
                }
                try {
                    if (fs.existsSync(absPath)) {
                        fs.writeFileSync(absPath, `# ${h1Text}\n`, 'utf8');
                    }
                } catch (e) {
                    console.error('[Notes] notesMdUpdatePageH1 write error:', e);
                }
            },
            // v0.207.86: Notes 内 .md からのリンククリック (plain) — sidepanel で開く
            notesMdOpenLink: async (currentMdFilePath: string, href: string) => {
                if (!href) return;
                if (href.startsWith('fractal://')) {
                    vscode.commands.executeCommand('fractal.navigateInAppLink', href);
                    return;
                }
                if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                    vscode.env.openExternal(vscode.Uri.parse(href));
                    return;
                }
                if (href.startsWith('#')) {
                    // 同一 md 内の anchor — メインペイン editor へ scrollToAnchor を送る
                    panel.webview.postMessage({
                        type: 'scrollToAnchor',
                        anchor: href.substring(1),
                    });
                    return;
                }
                // 相対 / 絶対 file path
                const baseDir = currentMdFilePath ? path.dirname(currentMdFilePath) : fileManager.getMdRootDirPath();
                const resolvedUri = path.isAbsolute(href)
                    ? vscode.Uri.file(href)
                    : vscode.Uri.joinPath(vscode.Uri.file(baseDir), href);
                const lower = resolvedUri.fsPath.toLowerCase();
                if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
                    if (!fs.existsSync(resolvedUri.fsPath)) {
                        vscode.window.showWarningMessage(`File not found: ${resolvedUri.fsPath}`);
                        return;
                    }
                    // sidepanel で開く (outliner → side panel と同様 freshOpen=true)
                    await sidePanel.openFile(resolvedUri.fsPath, true);
                } else {
                    // 非 .md ローカルファイル → OS デフォルトアプリ
                    vscode.env.openExternal(resolvedUri);
                }
            },
            // v0.207.86: Notes 内 .md からのリンククリック (cmd/ctrl+click) — 新タブ standalone editor で開く
            notesMdOpenLinkInTab: async (currentMdFilePath: string, href: string) => {
                if (!href) return;
                // sprint 20260723-233506: fractal:// ページリンクは絶対 md に解決して webview 内タブで開く（vscode.openWith を使わない）
                if (href.startsWith('fractal://')) {
                    const abs = this.resolveFractalPageToAbsPath(href);
                    if (abs && fs.existsSync(abs)) {
                        panel.webview.postMessage({ type: 'openInWebviewTab', filePath: abs, kind: 'md' });
                    } else {
                        // node リンク等（pageId 無し）は従来どおり navigate（タブ化しない）
                        vscode.commands.executeCommand('fractal.navigateInAppLink', href);
                    }
                    return;
                }
                if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
                    vscode.env.openExternal(vscode.Uri.parse(href));
                    return;
                }
                if (href.startsWith('#')) {
                    // anchor は新タブで開く意味がないので sidepanel と同じ scroll 動作
                    panel.webview.postMessage({
                        type: 'scrollToAnchor',
                        anchor: href.substring(1),
                    });
                    return;
                }
                const baseDir = currentMdFilePath ? path.dirname(currentMdFilePath) : fileManager.getMdRootDirPath();
                const resolvedUri = path.isAbsolute(href)
                    ? vscode.Uri.file(href)
                    : vscode.Uri.joinPath(vscode.Uri.file(baseDir), href);
                const lower = resolvedUri.fsPath.toLowerCase();
                if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
                    if (!fs.existsSync(resolvedUri.fsPath)) {
                        vscode.window.showWarningMessage(`File not found: ${resolvedUri.fsPath}`);
                        return;
                    }
                    // sprint 20260723-233506: webview 内タブで開く（Electron 前方互換。vscode.openWith を使わない）
                    this.ensureResourceRootForFile(panel, resolvedUri.fsPath);
                    panel.webview.postMessage({ type: 'openInWebviewTab', filePath: resolvedUri.fsPath, kind: 'md' });
                } else {
                    vscode.env.openExternal(resolvedUri);
                }
            },
            // v0.207.88 → sprint 20260723-233506: 「新タブで開く」= webview 内タブで現在の .md を開く（VS Code 別タブでない）
            notesMdOpenSelfInNewTab: async (currentMdFilePath: string) => {
                if (!currentMdFilePath) return;
                if (!fs.existsSync(currentMdFilePath)) {
                    vscode.window.showWarningMessage(`File not found: ${currentMdFilePath}`);
                    return;
                }
                this.ensureResourceRootForFile(panel, currentMdFilePath);
                panel.webview.postMessage({ type: 'openInWebviewTab', filePath: currentMdFilePath, kind: 'md' });
            },
            // MD-45/46/47: drawio (.drawio.svg / .drawio.png / .drawio (XML))
            saveDrawioToDir: (dataUrl: string, fileName: string, sidePanelFilePath: string) => {
                // BUG-FIX (iter2): 判定基準は「drawio 要求元が sidepanel か」= sidePanelFilePath の有無。
                // SidePanelHostBridge（editor.js）は this.filePath(=sidepanel md) を渡すので sidepanel 由来なら non-empty。
                // メインペイン自身の cmd+/ は空 → 従来経路（getMdFilesDirPath / dirname(cur)）。
                // 旧: isMd（メインが md editor か）で分岐 → メインが md を開いた状態で sidepanel から drawio 挿入すると親に貼りついていた。
                const fromSidePanel = !!sidePanelFilePath;
                const cur = fileManager.getCurrentFilePath();
                const filesDir = fromSidePanel
                    ? resolveFilesDirForMd(sidePanelFilePath)
                    : fileManager.getMdFilesDirPath();
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                const safeName = fileName || 'diagram.drawio.svg';
                const destFileName = buildUniqueDrawioName(safeName, (n) => fs.existsSync(path.join(filesDir, n)));
                const destPath = path.join(filesDir, destFileName);

                try {
                    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
                    fs.writeFileSync(destPath, Buffer.from(base64, 'base64'));
                    const baseDir = fromSidePanel ? path.dirname(sidePanelFilePath) : path.dirname(cur!);
                    const relPath = path.relative(baseDir, destPath).replace(/\\/g, '/');
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath: relPath,
                        displayUri: displayUri,
                        dataUri: dataUrl,
                        sidePanelFilePath: fromSidePanel ? sidePanelFilePath : undefined, // sidepanel 由来なら宛先を載せる（受信側が中継判定）
                    });
                } catch (e) {
                    console.error('[Notes] saveDrawioToDir error:', e);
                }
            },
            readAndInsertDrawio: (filePath: string, sidePanelFilePath: string) => {
                // BUG-FIX (iter2): saveDrawioToDir と同じく sidePanelFilePath の有無で要求元を判定。
                const fromSidePanel = !!sidePanelFilePath;
                const cur = fileManager.getCurrentFilePath();
                const filesDir = fromSidePanel
                    ? resolveFilesDirForMd(sidePanelFilePath)
                    : fileManager.getMdFilesDirPath();
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                if (!fs.existsSync(filePath)) {
                    vscode.window.showErrorMessage(`${t('fileNotFound')}: ${filePath}`);
                    return;
                }
                const originalName = path.basename(filePath);
                const destFileName = buildUniqueDrawioName(originalName, (n) => fs.existsSync(path.join(filesDir, n)));
                const destPath = path.join(filesDir, destFileName);
                try {
                    fs.copyFileSync(filePath, destPath);
                    const baseDir = fromSidePanel ? path.dirname(sidePanelFilePath) : path.dirname(cur!);
                    const relPath = path.relative(baseDir, destPath).replace(/\\/g, '/');
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath: relPath,
                        displayUri: displayUri,
                        sidePanelFilePath: fromSidePanel ? sidePanelFilePath : undefined, // sidepanel 由来なら宛先を載せる
                    });
                } catch (e) {
                    console.error('[Notes] readAndInsertDrawio error:', e);
                }
            },
            requestCreateDrawio: async (sidePanelFilePath: string) => {
                // v15+ で InputBox 廃止 → diagram.drawio.svg を自動命名で生成
                // BUG-FIX (iter2): sidePanelFilePath の有無で要求元を判定（メイン自身の cmd+/ は空 → getMdFilesDirPath）。
                const fromSidePanel = !!sidePanelFilePath;
                const cur = fileManager.getCurrentFilePath();
                const filesDir = fromSidePanel
                    ? resolveFilesDirForMd(sidePanelFilePath)
                    : fileManager.getMdFilesDirPath();
                if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

                const destFileName = buildUniqueDrawioName('diagram.drawio.svg', (n) => fs.existsSync(path.join(filesDir, n)));
                const destPath = path.join(filesDir, destFileName);
                try {
                    fs.writeFileSync(destPath, buildPlaceholderDrawioSvg(), 'utf8');
                    const baseDir = fromSidePanel ? path.dirname(sidePanelFilePath) : path.dirname(cur!);
                    const relPath = path.relative(baseDir, destPath).replace(/\\/g, '/');
                    const displayUri = panel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                    panel.webview.postMessage({
                        type: 'insertImageHtml',
                        markdownPath: relPath,
                        displayUri: displayUri,
                        sidePanelFilePath: fromSidePanel ? sidePanelFilePath : undefined, // sidepanel 由来なら宛先を載せる
                    });
                } catch (e) {
                    console.error('[Notes] requestCreateDrawio error:', e);
                }
            },
            sidePanelNavigateBack: async (sidePanelFilePath: string) => {
                await sidePanel.navigateBack(sidePanelFilePath || '');
            },
            sidePanelNavigateForward: async (sidePanelFilePath: string) => {
                await sidePanel.navigateForward(sidePanelFilePath || '');
            },
            createPageAutoForSidePanel: (sidePanelFilePath: string) => {
                // v15+: side panel cmd+/ Add Page — サイドパネルで開いている md と同じ場所に subpage を作る。
                // FR: メイン document でなく開いている md（sidePanelFilePath）の dir 基準（別 note / 非 note 対応）。
                if (!sidePanelFilePath) return;
                const pagesDir = path.dirname(sidePanelFilePath);
                if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
                const ts = Date.now();
                let fileName = `${ts}.md`;
                if (fs.existsSync(path.join(pagesDir, fileName))) {
                    let counter = 1;
                    // eslint-disable-next-line no-constant-condition
                    while (true) {
                        const cs = String(counter).padStart(4, '0');
                        fileName = `${ts}-${cs}.md`;
                        if (!fs.existsSync(path.join(pagesDir, fileName))) break;
                        counter++;
                    }
                }
                const absPath = path.join(pagesDir, fileName);
                try {
                    fs.writeFileSync(absPath, '# ', 'utf8');
                } catch (e) {
                    console.error('[Notes] createPageAutoForSidePanel write error:', e);
                    return;
                }
                const spDir = path.dirname(sidePanelFilePath);
                const relPath = path.relative(spDir, absPath).replace(/\\/g, '/');
                panel.webview.postMessage({
                    type: 'sidePanelMessage',
                    data: { type: 'pageCreatedAtPath', relativePath: relPath }
                });
            },
            sendSidePanelImageDir: (sidePanelFilePath: string) => {
                // FR: フッター表示・assetContext とも sidepanel で開いている md の場所を基準にする
                const spDir = path.dirname(sidePanelFilePath);
                const imagesDir = resolveImagesDirForMd(sidePanelFilePath);
                const displayPath = path.relative(spDir, imagesDir).replace(/\\/g, '/') || '.';
                panel.webview.postMessage({
                    type: 'sidePanelImageDirStatus',
                    displayPath,
                    source: 'default',
                });
                // Also send file dir status
                const fileDirPath = resolveFilesDirForMd(sidePanelFilePath);
                const fileDirDisplay = path.relative(spDir, fileDirPath).replace(/\\/g, '/') || '.';
                panel.webview.postMessage({
                    type: 'sidePanelFileDirStatus',
                    displayPath: fileDirDisplay,
                    source: 'default',
                });
                // v9: Send absolute paths for MD paste asset copy
                panel.webview.postMessage({
                    type: 'sidePanelAssetContext',
                    imageDir: imagesDir,
                    fileDir: fileDirPath,
                    mdDir: spDir
                });
            },
            saveSidePanelFile: async (filePath: string, content: string) => {
                await sidePanel.handleSave(filePath, content);
            },
            handleSidePanelOpenLink: (href: string, sidePanelFilePath: string) => {
                sidePanel.handleOpenLink(href, sidePanelFilePath);
            },
            handleSidePanelOpenInTextEditor: (sidePanelFilePath: string) => {
                if (sidePanelFilePath) {
                    const spTextUri = vscode.Uri.file(sidePanelFilePath);
                    vscode.commands.executeCommand('vscode.openWith', spTextUri, 'default');
                }
            },
            handleSidePanelClosed: () => {
                sidePanel.handleClose();
            },
            // sprint 20260723-233506: webview 内マルチタブの host 協調（NFR-TAB-03 / FR-TAB-06）
            flushActiveForTab: () => {
                fileManager.flushSave();
            },
            restoreSidePanelForTab: (filePath: string) => {
                // freshOpen=false（nav history 非汚染）+ restoreForTab=true（webview で scroll 復元 + auto-focus skip）
                void sidePanel.openFile(filePath, false, true);
            },
            openFileInWebviewTab: (filePath: string) => {
                // サイドパネル「Open in tab」/ 左ツリー右クリック「Open in new tab」→ webview 内タブ（FR-TAB-02・NFR-TAB-04）。
                // sprint 20260725: md/.out 両対応。拡張子で kind を決める（.out=outliner / それ以外=md）。
                if (!filePath || !fs.existsSync(filePath)) {
                    vscode.window.showWarningMessage(`File not found: ${filePath}`);
                    return;
                }
                this.ensureResourceRootForFile(panel, filePath);
                const kind = /\.out$/i.test(filePath) ? 'out' : 'md';
                panel.webview.postMessage({ type: 'openInWebviewTab', filePath, kind });
            },
            sendToChatFromSidePanel: async (sidePanelFilePath: string, startLine: number, endLine: number, selectedMarkdown: string) => {
                try {
                    await sidePanel.handleSendToChat(sidePanelFilePath, startLine, endLine, selectedMarkdown);
                } catch (err) {
                    console.error('[Notes] sendToChat error:', err);
                }
            },
            saveLastOpenedFile: (filePath: string) => {
                this.context.globalState.update(
                    `notesLastFile:${folderPath}`, filePath
                );
            },
            s3Sync: (bucketPath: string) => {
                this.runS3Operation('s3Sync', bucketPath, sender, fileManager, folderPath);
            },
            s3RemoteDeleteAndUpload: (bucketPath: string) => {
                this.runS3Operation('s3RemoteDeleteAndUpload', bucketPath, sender, fileManager, folderPath);
            },
            s3LocalDeleteAndDownload: (bucketPath: string) => {
                this.runS3Operation('s3LocalDeleteAndDownload', bucketPath, sender, fileManager, folderPath);
            },
            s3GetStatus: () => {
                const fractalConfig = vscode.workspace.getConfiguration('fractal');
                const bucketPath = fileManager.getS3BucketPath();
                const hasCredentials = !!(fractalConfig.get<string>('s3AccessKeyId') && fractalConfig.get<string>('s3SecretAccessKey'));
                sender.postMessage({
                    type: 'notesS3Status',
                    bucketPath: bucketPath || '',
                    hasCredentials,
                    region: fractalConfig.get<string>('s3Region', 'us-east-1'),
                });
            },
            cleanupUnusedFilesAllNotes: async () => {
                // FR-7: 手動クリーンアップコマンド (全 note 一気モード)
                await vscode.commands.executeCommand('fractal.cleanUnusedFilesInNote');
            },
            cleanupUnusedFilesCurrentNote: async () => {
                // FR-7: 手動クリーンアップコマンド (自ノート限定モード)
                await vscode.commands.executeCommand('fractal.cleanUnusedFilesInCurrentNote');
            },
            // outliner node paste の添付複製 (sprint 20260727-124904 / ADRL-0001)
            pasteOutlinerNodesWithAssets: (plainText: string, nodes: unknown[], sidePanelFilePath: string) => {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { runOutlinerNodesPaste } = require('./shared/paste-asset-handler');
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { OutlinerClipboardStore } = require('./shared/outliner-clipboard-store');
                const result = runOutlinerNodesPaste({
                    plainText,
                    fallbackNodes: nodes as any[],
                    destMdPath: sidePanelFilePath,
                    getClipboard: (pt: string) => OutlinerClipboardStore.get(pt),
                    destFilesDir: resolveFilesDirForMd(sidePanelFilePath),
                    destImagesDir: resolveImagesDirForMd(sidePanelFilePath),
                });
                panel.webview.postMessage({
                    type: 'pasteWithAssetCopyResult',
                    markdown: result.markdown
                });
            },
            pasteWithAssetCopy: (markdown: string, sourceContext: any, sidePanelFilePath: string, destination?: string) => {
                // v9: MD paste with asset copy (cross-outliner/cross-note paste)
                // FR: 貼り付け先は開いている md（sidepanel または main md pane）の場所を基準にする
                const destImageDir = resolveImagesDirForMd(sidePanelFilePath);
                const destFileDir = resolveFilesDirForMd(sidePanelFilePath);
                const destMdDir = path.dirname(sidePanelFilePath);

                const result = copyMdPasteAssets({
                    markdown,
                    sourceMdDir: sourceContext.mdDir,
                    sourceImageDir: sourceContext.imageDir,
                    sourceFileDir: sourceContext.fileDir,
                    destImageDir,
                    destFileDir,
                    destMdDir
                });

                panel.webview.postMessage({
                    type: 'pasteWithAssetCopyResult',
                    markdown: result.rewrittenMarkdown,
                    // FR-XP-01: 宛先札の echo back（main-md なら outliner.js の転送 switch が
                    // sidepanel への転送を止め、md pane の EditorInstance が直接受信する）
                    destination
                });
            },
            extractDataUrlsInPastedMd: (markdown: string, sidePanelFilePath: string) => {
                // HTML paste で残った data:image/... を pagesDir/images に実体化
                try {
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const { processDataUrlsInContent } = require('./shared/data-url-image-extractor');
                    // FR: sidepanel で開いている md の場所を基準に保存
                    const imageDir = sidePanelFilePath
                        ? resolveImagesDirForMd(sidePanelFilePath)
                        : fileManager.getOutlinerImageDirPath();
                    const mdFileDir = sidePanelFilePath ? path.dirname(sidePanelFilePath) : fileManager.getPagesDirPath();
                    const { newContent, savedCount } = processDataUrlsInContent(markdown, imageDir, mdFileDir);
                    panel.webview.postMessage({
                        type: 'extractDataUrlsInPastedMdResult',
                        markdown: newContent,
                        savedCount
                    });
                } catch (err) {
                    console.error('[notes extractDataUrlsInPastedMd] failed:', err);
                    panel.webview.postMessage({
                        type: 'extractDataUrlsInPastedMdResult',
                        markdown,
                        savedCount: 0
                    });
                }
            },
            getWorkspaceConfig: (section: string) => {
                return vscode.workspace.getConfiguration(section);
            },
            postMessage: (message: any) => {
                panel.webview.postMessage(message);
            },
            showQuickPick: async (items: Array<{ label: string; description?: string }>, placeHolder: string) => {
                return await vscode.window.showQuickPick(items, { placeHolder });
            },
            updateWorkspaceConfig: async (section: string, key: string, value: unknown) => {
                await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
            },
            executeCommand: async (command: string, ...args: unknown[]) => {
                return await vscode.commands.executeCommand(command, ...args);
            },
            saveTranslationToOutlinerNode: async (
                sidePanelFilePath: string,
                translatedMarkdown: string,
                h1Title: string,
                _sourceLang: string,
                _targetLang: string
            ) => {
                // v0.207.24: notes mode で sidepanel が属する outliner の親 node に子 page として attach
                // sidepanel filePath は ~/notes/<outlineId>/<pageId>.md という構造
                // → outline file: ~/notes/<outlineId>.out、 親 node = pageId に紐づく node
                const outFilePath = fileManager.getCurrentFilePath();
                if (!outFilePath || !fs.existsSync(outFilePath)) {
                    vscode.window.showErrorMessage('保存対象の outliner ファイルが見つかりません');
                    sender.postMessage({ type: 'translateSaveError', message: '保存対象の outliner ファイルが見つかりません' });
                    return;
                }
                const pagesDir = fileManager.getPagesDirPath();
                if (!pagesDir) {
                    vscode.window.showErrorMessage('Pages directory を解決できません');
                    sender.postMessage({ type: 'translateSaveError', message: 'Pages directory を解決できません' });
                    return;
                }

                // 1. sidepanel pageId を取得 (filePath の basename)
                const currentPageId = path.basename(sidePanelFilePath, path.extname(sidePanelFilePath));

                // 2. .out JSON を読み、pageId に紐づく node を探す
                let outData: { rootIds?: string[]; nodes?: Record<string, any>; [k: string]: unknown };
                try {
                    outData = JSON.parse(fs.readFileSync(outFilePath, 'utf8'));
                } catch (e) {
                    vscode.window.showErrorMessage('Outliner ファイルの parse に失敗しました');
                    sender.postMessage({ type: 'translateSaveError', message: 'Outliner JSON parse 失敗' });
                    return;
                }
                if (!outData || typeof outData !== 'object') {
                    sender.postMessage({ type: 'translateSaveError', message: 'Outliner JSON が空です' });
                    return;
                }
                outData.nodes = outData.nodes || {};

                let parentNodeId: string | null = null;
                for (const [nodeId, node] of Object.entries(outData.nodes)) {
                    if (node && (node as any).pageId === currentPageId) {
                        parentNodeId = nodeId;
                        break;
                    }
                }
                if (!parentNodeId) {
                    const msg = `翻訳元 page (${currentPageId}) を含む outliner node が見つかりません。outliner: ${path.basename(outFilePath)}`;
                    vscode.window.showErrorMessage(msg);
                    sender.postMessage({ type: 'translateSaveError', message: msg });
                    return;
                }

                // 3. 新 pageId 生成
                const newPageId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                const newPagePath = path.join(pagesDir, `${newPageId}.md`);
                if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });

                // 4. 翻訳結果 MD を保存
                fs.writeFileSync(newPagePath, translatedMarkdown, 'utf8');

                // 5. 新 node 生成 + parent.children に追加
                // v0.207.29: BUG FIX - OutlinerModel は `children` 配列を使う (childIds ではない)。
                // tags / isPage / subtext / images / filePath / parentId / checked も必須 (model.js:113)
                const newNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                const safeTitle = (h1Title || 'Untitled (translated)').trim() || 'Untitled (translated)';
                outData.nodes[newNodeId] = {
                    id: newNodeId,
                    parentId: parentNodeId,
                    children: [],
                    text: safeTitle,
                    tags: [],
                    isPage: true,
                    pageId: newPageId,
                    collapsed: false,
                    checked: null,
                    subtext: '',
                    images: [],
                    filePath: null,
                };
                const parentNode = outData.nodes[parentNodeId];
                parentNode.children = parentNode.children || [];
                parentNode.children.push(newNodeId);
                if (parentNode.collapsed) parentNode.collapsed = false;

                // 6. .out 保存
                // v0.207.28: outliner.js の pending syncData (古い model) で上書きされないよう
                // fileManager.openFile(outFilePath) を呼んで lastJsonString 更新 + fileChangeId++
                // → webview 側の旧 fileChangeId 付き syncData は notes-message-handler:172 で reject
                const newJsonString = JSON.stringify(outData, null, 2);
                fs.writeFileSync(outFilePath, newJsonString, 'utf8');
                fileManager.openFile(outFilePath); // bump fileChangeId + sync lastJsonString
                vscode.window.showInformationMessage(`翻訳結果を保存しました: ${safeTitle}（${path.relative(path.dirname(outFilePath), newPagePath)}）`);

                // 7. webview に直接 updateData を送って UI 即時反映 (新 fileChangeId 付き)
                sender.postMessage({
                    type: 'updateData',
                    data: outData,
                    fileChangeId: fileManager.getFileChangeId(),
                    outFileKey: outFilePath
                });

                // 8. webview に成功通知 (button text 反映用)
                sender.postMessage({
                    type: 'translateSaveOk',
                    newNodeId,
                    newPageId,
                    h1Title: safeTitle,
                    pagePath: newPagePath,
                    outPath: outFilePath
                });
            },

            // v0.207.77 (D&D Feature A): Notes 内 .md ファイルを別の .out item にドロップ →
            // 当該 .out の rootIds 先頭に page-node として追加 (md は .out の pageDir にコピーする)
            notesImportMdIntoOut: async (mdFileId: string, targetOutId: string, senderRef: NotesSender, targetNodeId?: string | null, position?: string | null) => {
                try {
                    const mdSourcePath = fileManager.getFilePathById(mdFileId);
                    const outFilePath = fileManager.getFilePathById(targetOutId);
                    if (!mdSourcePath || !outFilePath) return;
                    if (!fs.existsSync(mdSourcePath) || !fs.existsSync(outFilePath)) return;
                    if (!outFilePath.endsWith('.out')) return;

                    // 1. 対象 .out の json 読込 + pageDir 解決 (target が currentFile でなくても解決できる)
                    // US-08 (sprint 20260804-145603): 自前計算（legacy <outDir>/<stem>/ default）を
                    // 正典 flat-layout.resolvePagesDir に置換（flat note では note 直下を返す =
                    // 本体の page 読み取りと同じ解決。ミラー実装乖離の教訓 designer_failures 2026-07-26）。
                    const outRaw = fs.readFileSync(outFilePath, 'utf8');
                    const outData = JSON.parse(outRaw);
                    const pagesDir = resolvePagesDir(outFilePath, fileManager.getMainFolderPath(), {
                        pageDir: outData.pageDir,
                        imageDir: outData.imageDir,
                        fileDir: outData.fileDir,
                    });
                    const imagesDir = fileManager.getOutlinerImageDirPath();

                    // 2. md を page 化する。
                    // US-08 (sprint 20260804-145603): note 内 D&D で pagesDir が md の現在地と同じ
                    //（flat 構成の通常ケース）なら、コピー・リネームせず**既存ファイルをそのまま**
                    // page として参照する（pageId = 既存ファイル名 stem・ファイル名不変）。
                    // pagesDir が別の場所（legacy pageDir 指定の .out）のときだけ従来どおり import コピー。
                    let r: { title: string; pageId: string };
                    if (path.resolve(path.dirname(mdSourcePath)) === path.resolve(pagesDir)) {
                        const content = fs.readFileSync(mdSourcePath, 'utf8');
                        r = {
                            title: resolveSubpageTitle(content, path.basename(mdSourcePath)),
                            pageId: path.basename(mdSourcePath, '.md'),
                        };
                    } else {
                        const imported = importMdFiles([mdSourcePath], pagesDir, imagesDir);
                        if (!imported || imported.length === 0) return;
                        r = imported[0];
                    }

                    // 3. page-node を追加。FR-TF-14 (2026-08-10): targetNodeId/position 指定時は
                    // drop 位置（補助線の位置 = before/after/child）に挿入。省略時は従来の rootIds 先頭
                    //（tree 内 md→out item の中央 50% 経路 = 後方互換）。
                    // outliner-model.js と一致するノード構造 (children / parentId / isPage / pageId / 等)
                    const newNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                    outData.nodes = outData.nodes || {};
                    outData.rootIds = outData.rootIds || [];
                    const newNode: Record<string, unknown> = {
                        id: newNodeId,
                        parentId: null,
                        children: [],
                        text: r.title || '',
                        tags: [],
                        isPage: true,
                        pageId: r.pageId,
                        collapsed: false,
                        checked: null,
                        subtext: '',
                        images: [],
                        filePath: null,
                    };
                    outData.nodes[newNodeId] = newNode;
                    insertNodeAtDropPosition(outData, newNodeId, targetNodeId, position);

                    // 4. .out 保存
                    const newJsonString = JSON.stringify(outData, null, 2);
                    fs.writeFileSync(outFilePath, newJsonString, 'utf8');

                    // 5. 対象 .out が current file なら updateData で UI 即時反映
                    if (fileManager.getCurrentFilePath() === outFilePath) {
                        fileManager.openFile(outFilePath); // bump fileChangeId + sync lastJsonString
                        senderRef.postMessage({
                            type: 'updateData',
                            kind: 'out',
                            data: outData,
                            fileChangeId: fileManager.getFileChangeId(),
                            outFileKey: outFilePath,
                        });
                    }

                    // 6. v0.207.78: outliner cut/paste と同じく「画面上のデータは消す、
                    // 物理ファイルは消さない」方針に合わせ、コピー元 Notes panel エントリを除去
                    fileManager.unregisterMdFromStructureOnly(mdFileId);
                    senderRef.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                    });
                } catch (e) {
                    console.error('[Notes] notesImportMdIntoOut error:', e);
                    vscode.window.showErrorMessage('Failed to import .md into outliner');
                }
            },

            // ── FR-TF: tree file item（ext:'file'）D&D 経路 — pure-fs は notes-message-handler の
            // seam 関数へ委譲（DI: fileManager + senderRef）。vscode 依存分（open/reveal/clipboard/delete/
            // notify）だけ provider に置く。既存 openAttachedFile / revealAttachedFileInOS / copyAttachedFilePath と同型。 ──

            // FR-TF click（§4）: file item を OS 既定アプリで開く
            openTreeFileExternal: async (id: string, _senderRef: NotesSender) => {
                const p = fileManager.getTreeFilePath(id);
                if (!p || !fs.existsSync(p)) {
                    vscode.window.showErrorMessage(t('fileNotFound'));
                    return;
                }
                await vscode.env.openExternal(vscode.Uri.file(p));
            },
            // FR-TF-03 (§4b): tree file → .out item
            notesImportFileIntoOut: (dragItemId: string, targetOutId: string, senderRef: NotesSender) => {
                treeFileImportIntoOut(fileManager, senderRef, dragItemId, targetOutId);
            },
            // FR-TF-04 (§4c): tree file → md item（末尾に 📎 リンク追記）
            notesAttachFileIntoMd: (dragItemId: string, targetMdId: string, senderRef: NotesSender) => {
                treeFileAttachIntoMd(fileManager, senderRef, dragItemId, targetMdId);
            },
            // FR-TF-06a (§4f): tree file → 開いている md editor（main=currentFile / sidepanel=sidePanelFilePath）
            attachTreeFileToMd: (id: string, sidePanelFilePath: string | null | undefined, senderRef: NotesSender) => {
                treeFileAttachToMdEditor(fileManager, senderRef, id, sidePanelFilePath);
            },
            // FR-TF-19 (§4m): md editor drop 受け 4 経路（seam は notes-message-handler の pure-fs 関数）
            attachOutNodeFileToMd: (payload: { outFileKey: string; nodeId: string }, sidePanelFilePath: string | null, senderRef: NotesSender) => {
                attachOutNodeFileToMd(fileManager, senderRef, payload, sidePanelFilePath);
            },
            importOutPageNodeToMd: (payload: { outFileKey: string; nodeId: string; pageId: string; title?: string }, sidePanelFilePath: string | null, senderRef: NotesSender) => {
                importOutPageNodeToMd(fileManager, senderRef, payload, sidePanelFilePath);
            },
            attachMdFileLinkToMd: (payload: { href: string; sourceMdPath: string }, sidePanelFilePath: string | null, senderRef: NotesSender) => {
                attachMdFileLinkToMd(fileManager, senderRef, payload, sidePanelFilePath);
            },
            linkMdSubpageToMd: (payload: { href: string; sourceMdPath: string; title?: string }, sidePanelFilePath: string | null, senderRef: NotesSender) => {
                linkMdSubpageToMd(fileManager, senderRef, payload, sidePanelFilePath);
            },
            // FR-TF-05a (§4d): tree file → outliner の node 位置（dropFilesResult 互換 postback）
            notesImportTreeFileAtPosition: (id: string, outFileId: string, targetNodeId: string | null, position: string | null, senderRef: NotesSender) => {
                treeFileImportAtPosition(fileManager, senderRef, id, outFileId, targetNodeId, position);
            },
            // FR-TF-05b (§4e): outliner の file 添付 node → tree（所有移し替え）
            notesRegisterFileFromOutNode: (payload: { outFileKey: string; nodeId: string }, parentId: string | null, index: number, senderRef: NotesSender) => {
                treeFileRegisterFromOutNode(fileManager, senderRef, payload, parentId, index);
            },
            // FR-TF-06b (§4g): md editor 内 📎 file リンク → tree（元 md から removeFileLink）
            notesRegisterFileFromMdLink: (payload: { href: string; sourceMdPath: string }, parentId: string | null, index: number, senderRef: NotesSender) => {
                treeFileRegisterFromMdLink(fileManager, senderRef, payload, parentId, index);
            },
            // FR-TF-10 menu（§7）: Reveal in Finder
            revealTreeFileInOS: async (id: string, _senderRef: NotesSender) => {
                const p = fileManager.getTreeFilePath(id);
                if (!p || !fs.existsSync(p)) {
                    vscode.window.showErrorMessage(t('fileNotFound'));
                    return;
                }
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
            },
            // FR-TF-10 menu（§7）: Copy Path（絶対パスを OS clipboard へ。host→webview 応答方向なので NFR-TF-02 非抵触）
            copyTreeFilePath: async (id: string, _senderRef: NotesSender) => {
                const p = fileManager.getTreeFilePath(id);
                if (!p) {
                    vscode.window.showWarningMessage(t('fileNotFoundOrUnsafe'));
                    return;
                }
                await vscode.env.clipboard.writeText(p);
            },
            // FR-TF-10 menu（§7）: Delete（実体 useTrash 削除 + structure 除去。既存 deleteFile には流さない）
            deleteTreeFile: async (id: string, senderRef: NotesSender) => {
                await fileManager.deleteTreeFile(id);
                senderRef.postMessage({
                    type: 'notesFileListChanged',
                    fileList: fileManager.listFiles(),
                    structure: fileManager.getStructureForWebview(),
                    currentFile: fileManager.getCurrentFilePath(),
                });
            },
            // FR-TF-01 (§4a): 外部 D&D の明示通知（50MB 超 skip 等）
            notifyError: (message: string) => {
                if (message) { vscode.window.showErrorMessage(message); }
            },

            // TASK-19 (sprint 20260804-145603): md editor 内 subpage リンク → Notes ツリー D&D。
            // href を dirname(sourceMd) 基準で解決（本体リンク解決と同じ）。
            //   同一 note（mainFolder 直下 flat）→ 既存ファイルをそのまま登録（コピー・リネームなし）
            //   別 note / note 外 → mainFolder 直下へ複製登録（元ファイルは不変）
            // 登録成功後、元 md のアンカーを除去（removeSubpageLink → webview が該当 <a> を削除
            // して serialize。「所有」がツリーへ移る = 中途半端な二重参照を残さない）。
            notesRegisterSubpageFromMd: (payload: { href: string; sourceMdPath: string; title?: string }, parentId: string | null, index: number, senderRef: NotesSender) => {
                try {
                    if (!payload || !payload.href || !payload.sourceMdPath) return;
                    if (!/\.md$/i.test(payload.href)) return;
                    // href は相対（dirname(sourceMd) 基準）または絶対
                    const srcDir = path.dirname(payload.sourceMdPath);
                    const abs = path.isAbsolute(payload.href)
                        ? payload.href
                        : path.resolve(srcDir, decodeURIComponent(payload.href));
                    if (!fs.existsSync(abs)) return;
                    const content = fs.readFileSync(abs, 'utf8');
                    const title = resolveSubpageTitle(content, path.basename(abs));
                    const mainFolder = fileManager.getMainFolderPath();
                    const isFlatInNote = path.resolve(path.dirname(abs)) === path.resolve(mainFolder);
                    if (isFlatInNote) {
                        fileManager.registerExistingMdFile(path.basename(abs, '.md'), title, parentId, index);
                    } else {
                        fileManager.registerMarkdownFile(content, title, parentId, index);
                    }
                    senderRef.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                    });
                    // 元 md からアンカー除去（webview 側が sourceMdPath 一致の editor 内 <a> を削除して sync）
                    senderRef.postMessage({
                        type: 'removeSubpageLink',
                        href: payload.href,
                        sourceMdPath: payload.sourceMdPath,
                    });
                } catch (e) {
                    console.error('[Notes] notesRegisterSubpageFromMd error:', e);
                }
            },

            // FR-T01 (sprint 20260805-124854): Finder / VS Code Explorer から .md をツリーに D&D。
            // FR-TF-01 (§4a): 同経路で非 md ファイル（kind:'file'）も受理。webview が
            // md → readAsText（content）/ その他 → readAsArrayBuffer（bytes base64）で読む。
            // md は各々新 id で mainFolder 直下（flat）へ複製登録（title は H1 / stem）。
            // file は bytes を files/ に byte 一致で保存（50MB 超は per-file skip + 明示通知）。
            // 元ファイルは OS 側なので不変。挿入位置は index から登録済み件数ぶんずらす。
            notesRegisterExternalMd: (
                items: { kind: string; name: string; content?: string; bytes?: string }[],
                parentId: string | null,
                index: number,
                senderRef: NotesSender
            ) => {
                try {
                    if (!Array.isArray(items) || items.length === 0) return;
                    let registered = 0;
                    for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (!item) continue;
                        if (item.kind === 'md') {
                            const content = typeof item.content === 'string' ? item.content : '';
                            const title = resolveSubpageTitle(content, item.name || 'untitled.md');
                            fileManager.registerMarkdownFile(content, title, parentId, index + registered);
                            registered++;
                        } else if (item.kind === 'file') {
                            const fid = registerExternalDroppedFileItem(
                                fileManager,
                                item,
                                parentId,
                                index + registered,
                                (name: string) => vscode.window.showWarningMessage(`${t('dropFileTooLarge')}: ${name}`)
                            );
                            if (fid) registered++;
                        }
                    }
                    if (registered === 0) return;
                    senderRef.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                    });
                } catch (e) {
                    console.error('[Notes] notesRegisterExternalMd error:', e);
                }
            },

            // FR-TF-17 (§4k): VS Code Explorer uri-list drop。webview は URI を送るだけで
            // host が fs 直読み → md/file 振り分け登録（50MB cap なし = ADRL-C Decision 2）。
            notesRegisterExternalUris: (
                uris: string[],
                parentId: string | null,
                index: number,
                senderRef: NotesSender
            ) => {
                try {
                    registerExternalDroppedUris(fileManager, uris, parentId, index, senderRef);
                } catch (e) {
                    console.error('[Notes] notesRegisterExternalUris error:', e);
                }
            },

            // v0.207.77 (D&D Feature B): outliner page-node を Notes panel にドロップ →
            // 当該 page の .md を _notes_md/<newId>.md (v0.207.82: フラット) に複製し、独立 .md として構造へ登録
            notesImportOutPageNodeAsMd: async (
                payload: { outFileKey: string; nodeId: string; pageId: string; title: string },
                parentId: string | null,
                index: number,
                senderRef: NotesSender
            ) => {
                try {
                    if (!payload || !payload.outFileKey || !payload.pageId) return;
                    const srcOutPath = payload.outFileKey;
                    if (!srcOutPath.endsWith('.out')) return;
                    if (!fs.existsSync(srcOutPath)) return;

                    // 1. 元 .out の pageDir を解決。
                    // (3) 2026-08-05: 自前計算（legacy <outDir>/<stem>/ default）を正典
                    // flat-layout.resolvePagesDir に置換（flat note では note 直下を返す）。
                    const outRaw = fs.readFileSync(srcOutPath, 'utf8');
                    const outData = JSON.parse(outRaw);
                    const srcPageDir = resolvePagesDir(srcOutPath, fileManager.getMainFolderPath(), {
                        pageDir: outData.pageDir,
                        imageDir: outData.imageDir,
                        fileDir: outData.fileDir,
                    });

                    // 2. 安全に <pageDir>/<pageId>.md を解決
                    const srcMdPath = safeResolveUnderDir(srcPageDir, `${payload.pageId}.md`);
                    if (!srcMdPath || !fs.existsSync(srcMdPath)) return;

                    // 3. 中身を読み、H1 を抽出 (空 → payload.title → 'Untitled')
                    const mdContent = fs.readFileSync(srcMdPath, 'utf8');
                    const h1Match = mdContent.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
                    const h1 = h1Match ? h1Match[1].trim() : '';
                    const fallback = (payload.title || '').trim();
                    const title = h1 || fallback || 'Untitled';

                    // 4. ツリーへ登録。
                    // (3) 2026-08-05: 同一 note 内（page md が mainFolder 直下 = flat）なら
                    // コピー・リネームせず既存ファイルをそのまま登録（id = pageId・ファイル名不変）。
                    // legacy 配置（サブフォルダ pageDir）のみ従来どおり複製登録。
                    const isFlatInNote = path.resolve(path.dirname(srcMdPath)) === path.resolve(fileManager.getMainFolderPath());
                    if (isFlatInNote) {
                        fileManager.registerExistingMdFile(payload.pageId, title, parentId, index);
                    } else {
                        fileManager.registerMarkdownFile(mdContent, title, parentId, index);
                    }

                    // 5. v0.207.78: outliner cmd+x 単一ノードと同じく「画面上のデータは消す、
                    // 物理ファイルは消さない」方針。元の page-node の isPage/pageId/text/images
                    // をクリア (ノード自体は残し、children も保つ)。物理 .md は元の pageDir に残存。
                    // bridge.notesImportOutPageNodeAsMd 側で flushOutlinerSync 済 → disk が最新。
                    if (srcOutPath === fileManager.getCurrentFilePath()) {
                        try {
                            const freshRaw = fs.readFileSync(srcOutPath, 'utf8');
                            const freshData = JSON.parse(freshRaw);
                            const target = freshData.nodes?.[payload.nodeId];
                            if (target) {
                                target.isPage = false;
                                target.pageId = null;
                                target.text = '';
                                target.images = [];
                                fs.writeFileSync(srcOutPath, JSON.stringify(freshData, null, 2), 'utf8');
                                fileManager.openFile(srcOutPath); // bump fileChangeId + sync lastJsonString
                                senderRef.postMessage({
                                    type: 'updateData',
                                    kind: 'out',
                                    data: freshData,
                                    fileChangeId: fileManager.getFileChangeId(),
                                    outFileKey: srcOutPath,
                                });
                            }
                        } catch (clearErr) {
                            console.error('[Notes] clear source page-node error:', clearErr);
                        }
                    }

                    // 6. webview に最新 fileList + structure を broadcast
                    senderRef.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                    });
                } catch (e) {
                    console.error('[Notes] notesImportOutPageNodeAsMd error:', e);
                    vscode.window.showErrorMessage('Failed to import outliner page into notes');
                }
            },

            // node-move-to-other-outliner: outliner node（サブツリー）を右パネルの別 .out に move（root 先頭挿入）
            notesMoveOutNodeSubtreeIntoOut: async (
                payload: { outFileKey: string; nodeId: string },
                targetOutFilePath: string,
                senderRef: NotesSender
            ) => {
                try {
                    if (!payload || !payload.outFileKey || !payload.nodeId || !targetOutFilePath) return;
                    const srcOutPath = payload.outFileKey;
                    if (!srcOutPath.endsWith('.out') || !targetOutFilePath.endsWith('.out')) return;
                    // 同一 .out への move は no-op（同一 outliner 内の並べ替えは webview 側の tree D&D が担う）
                    if (srcOutPath === targetOutFilePath) return;
                    if (!fs.existsSync(srcOutPath) || !fs.existsSync(targetOutFilePath)) return;

                    // 1. src / target の .out json を読む（どちらも currentFile でなくても自前で読む）
                    const srcData = JSON.parse(fs.readFileSync(srcOutPath, 'utf8')) as OutDoc;
                    const targetData = JSON.parse(fs.readFileSync(targetOutFilePath, 'utf8')) as OutDoc;
                    if (!srcData.nodes || !srcData.nodes[payload.nodeId]) return;

                    // 1.5 HIGH-2 安全ガード: 参照引き継ぎ（物理移動なし）は「src と target が同じ pages/images/files dir を
                    //     共有する」flat レイアウト前提でのみ成立する。legacy per-id .out 混在等で dir が異なると、
                    //     参照だけ引き継いでも移動先で解決できず（broken ref）、src 削除で cleanup が物理削除するとデータロス。
                    //     dir が食い違う場合は abort して警告（物理移動の実装は将来スコープ・データロスを防ぐ安全側）。
                    const srcHints = { pageDir: srcData.pageDir as string | undefined, imageDir: srcData.imageDir as string | undefined, fileDir: srcData.fileDir as string | undefined };
                    const tgtHints = { pageDir: targetData.pageDir as string | undefined, imageDir: targetData.imageDir as string | undefined, fileDir: targetData.fileDir as string | undefined };
                    const dirsShared =
                        resolvePagesDir(srcOutPath, undefined, srcHints) === resolvePagesDir(targetOutFilePath, undefined, tgtHints) &&
                        resolveImagesDir(srcOutPath, undefined, srcHints) === resolveImagesDir(targetOutFilePath, undefined, tgtHints) &&
                        resolveFilesDir(srcOutPath, undefined, srcHints) === resolveFilesDir(targetOutFilePath, undefined, tgtHints);
                    if (!dirsShared) {
                        vscode.window.showWarningMessage(
                            'Cannot move node: the source and target outliners use different asset folders (legacy layout). This move is not supported yet.'
                        );
                        return;
                    }

                    // 2. 純関数でサブツリー転記（target root 先頭挿入 + src 削除）。
                    //    dirsShared=true を確認済みなので、pageId/images/filePath の参照文字列を
                    //    そのまま引き継ぐ（物理移動不要・1:1 所有の付替え）。src 削除でアセット物理ファイルは消さない。
                    const idSeed = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                    const res = moveSubtreeToOtherOut(srcData, targetData, payload.nodeId, idSeed);
                    if (!res) return;

                    // 3. 両 .out を保存
                    fs.writeFileSync(targetOutFilePath, JSON.stringify(targetData, null, 2), 'utf8');
                    fs.writeFileSync(srcOutPath, JSON.stringify(srcData, null, 2), 'utf8');

                    // 4. currentFile 側は webview に即時反映（bump fileChangeId + updateData）
                    const currentPath = fileManager.getCurrentFilePath();
                    if (currentPath === srcOutPath) {
                        fileManager.openFile(srcOutPath);
                        senderRef.postMessage({
                            type: 'updateData', kind: 'out', data: srcData,
                            fileChangeId: fileManager.getFileChangeId(), outFileKey: srcOutPath,
                        });
                    } else if (currentPath === targetOutFilePath) {
                        fileManager.openFile(targetOutFilePath);
                        senderRef.postMessage({
                            type: 'updateData', kind: 'out', data: targetData,
                            fileChangeId: fileManager.getFileChangeId(), outFileKey: targetOutFilePath,
                        });
                    }

                    // 5. fileList/structure を broadcast（.out の内容変化 = ページ数等が変わりうる）
                    senderRef.postMessage({
                        type: 'notesFileListChanged',
                        fileList: fileManager.listFiles(),
                        structure: fileManager.getStructureForWebview(),
                        currentFile: fileManager.getCurrentFilePath(),
                    });
                } catch (e) {
                    console.error('[Notes] notesMoveOutNodeSubtreeIntoOut error:', e);
                    vscode.window.showErrorMessage('Failed to move node to another outliner');
                }
            },
        };

        // --- パネル固有の disposables ---
        const disposables: vscode.Disposable[] = [];

        // メッセージハンドラ登録
        disposables.push(
            panel.webview.onDidReceiveMessage(async (message) => {
                await handleNotesMessage(message, fileManager, sender, platform);
            })
        );

        // テーマ変更対応 (N-50b)
        disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('fractal.language')) {
                    const langConfig = vscode.workspace.getConfiguration('fractal');
                    initLocale(langConfig.get<string>('language', 'default'), vscode.env.language);
                }
                // ★ FR-MG-01（SAFETY）: gate 経路では refresh を走らせない。listFiles()/getStructure() が
                //   loadStructure に到達して old layout フォルダを書き換え、かつ gate HTML を本体 HTML に
                //   差し替えて（移行前に）本体表示してしまう。gate 中の設定変更は無視でよい（移行後に再描画される）。
                if (!needsMigration && (e.affectsConfiguration('fractal.theme') ||
                    e.affectsConfiguration('fractal.fontSize') ||
                    e.affectsConfiguration('fractal.showTranslateButtons') ||
                    e.affectsConfiguration('fractal.showOpenInTextEditor') ||
                    e.affectsConfiguration('fractal.language'))) {
                    // refreshPanel inline (ローカル変数を使用)
                    const refreshConfig = vscode.workspace.getConfiguration('fractal');
                    const refreshFileList = fileManager.listFiles();
                    const refreshCurrentFile = fileManager.getCurrentFilePath();
                    let refreshJsonContent = '{"version":1,"rootIds":[],"nodes":{}}';
                    let refreshInitialMd: { content: string; documentBaseUri: string } | null = null;
                    if (refreshCurrentFile) {
                        const refreshContent = fileManager.openFile(refreshCurrentFile);
                        if (refreshContent !== null) {
                            // 現ファイルが md の場合は md ペインで再表示（jsonContent に入れると空 outliner になる）
                            if (refreshCurrentFile.endsWith('.md')) {
                                refreshInitialMd = {
                                    content: refreshContent,
                                    documentBaseUri: panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(refreshCurrentFile))).toString(),
                                };
                            } else {
                                refreshJsonContent = refreshContent;
                            }
                        }
                    }
                    const refreshPanelCollapsed = this.context.globalState.get<boolean>(
                        `notesPanelCollapsed:${folderPath}`, false
                    );
                    panel.webview.html = getNotesWebviewContent(
                        panel.webview,
                        this.context.extensionUri,
                        {
                            theme: getCurrentTheme(this.context),
                            fontSize: refreshConfig.get<number>('fontSize', 12),
                            webviewMessages: getWebviewMessages() as unknown as Record<string, string>,
                            enableDebugLogging: refreshConfig.get<boolean>('enableDebugLogging', false),
                            showTranslateButtons: refreshConfig.get<boolean>('showTranslateButtons', false),
                            showOpenInTextEditor: refreshConfig.get<boolean>('showOpenInTextEditor', true),
                            imageMaxWidth: refreshConfig.get<number>('imageMaxWidth', 400),
                            folderName: path.basename(folderPath),
                        },
                        { jsonContent: refreshJsonContent, fileList: refreshFileList, currentFilePath: refreshCurrentFile, panelCollapsed: refreshPanelCollapsed, structure: fileManager.getStructure(), panelWidth: fileManager.getPanelWidth(), noteSidePanelWidth: fileManager.getSidePanelWidth(), noteSidePanelOutlineWidth: fileManager.getSidePanelOutlineWidth(), fileChangeId: fileManager.getFileChangeId(), initialMd: refreshInitialMd }
                    );
                    sendTranslateLangFromConfig();
                }
                if (
                    e.affectsConfiguration('fractal.translateSourceLang') ||
                    e.affectsConfiguration('fractal.translateTargetLang')
                ) {
                    sendTranslateLangFromConfig();
                }
            })
        );

        // --- パネル固有のフォルダ監視 ---
        // ★ FR-MG-01（SAFETY）: gate 経路（needsMigration）では watcher を一切張らない。
        //   watcher callback は getStructure()→loadStructure() に到達し、old layout フォルダで
        //   .note→outline.note rename / saveStructure 上書きを起こす。特に `*.out` watcher は Migrate ボタン→
        //   executePlan が .out を rename/copy する最中に発火し executePlan と loadStructure がフォルダを奪い合う
        //   （rollback も壊れうる）。gate は静的画面で watcher は不要。移行成功後 disposeAndReopenNotePanel が
        //   新 panel を作り直し、そこで（flat になった状態で）watcher が張られる。
        if (!needsMigration) {
        const watcherPattern = new vscode.RelativePattern(vscode.Uri.file(folderPath), '*.out');
        const folderWatcher = vscode.workspace.createFileSystemWatcher(watcherPattern);

        const refreshFileListFromWatcher = () => {
            try {
                fileManager.invalidateStructureCache();
                const structure = fileManager.getStructureForWebview();
                const wFileList = fileManager.listFiles();
                const currentFile = fileManager.getCurrentFilePath();
                panel.webview.postMessage({
                    type: 'notesFileListChanged',
                    fileList: wFileList,
                    structure,
                    currentFile,
                });
            } catch {
                // ファイル読み込みエラーは無視
            }
        };

        disposables.push(folderWatcher.onDidCreate(refreshFileListFromWatcher));
        disposables.push(folderWatcher.onDidDelete(refreshFileListFromWatcher));

        // 現在開いている.outファイルの外部変更検知
        disposables.push(folderWatcher.onDidChange((uri) => {
            const currentFile = fileManager.getCurrentFilePath();
            if (!currentFile) return;
            if (uri.fsPath !== currentFile) return;
            if (fileManager.getIsWriting()) return;

            setTimeout(() => {
                try {
                    if (fileManager.getIsWriting()) return;
                    const content = fs.readFileSync(currentFile, 'utf8');
                    if (content === fileManager.getLastKnownContent()) return;
                    const data = JSON.parse(content);
                    panel.webview.postMessage({ type: 'updateData', data, outFileKey: fileManager.getCurrentFilePath() });
                    fileManager.updateLastKnownContent(content);
                } catch {
                    // JSONパースエラー or ファイル読み込みエラーは無視
                }
            }, 200);
        }));

        disposables.push(folderWatcher);

        // --- outline.note の外部変更検知 ---
        const noteFileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(folderPath), 'outline.note')
        );

        disposables.push(noteFileWatcher.onDidChange(() => {
            if (fileManager.getIsWritingStructure()) return;

            setTimeout(() => {
                try {
                    if (fileManager.getIsWritingStructure()) return;

                    // 内容比較: 同じなら何もしない（isWritingStructureタイミングずれの安全弁）
                    const noteFilePath = path.join(folderPath, 'outline.note');
                    const noteContent = fs.readFileSync(noteFilePath, 'utf8');
                    if (noteContent === fileManager.getLastKnownStructureContent()) return;

                    // 構造を再読み込みしてwebviewに送信
                    fileManager.invalidateStructureCache();
                    const structure = fileManager.getStructureForWebview();
                    const noteFileList = fileManager.listFiles();
                    const currentFile = fileManager.getCurrentFilePath();
                    panel.webview.postMessage({
                        type: 'notesFileListChanged',
                        fileList: noteFileList,
                        structure,
                        currentFile,
                    });
                    fileManager.updateLastKnownStructureContent(noteContent);
                } catch {
                    // 読み込みエラーは無視
                }
            }, 200);
        }));

        disposables.push(noteFileWatcher);
        } // end if (!needsMigration) — gate 経路では folderWatcher / noteFileWatcher を張らない

        // パネル破棄時のクリーンアップ
        panel.onDidDispose(() => {
            fileManager.dispose();
            sidePanel.disposeFileWatcher();
            mdMain.disposeFileWatcher();
            dropStreamHost.disposeAll();
            // MD-48: drawio watcher dispose
            try { sidePanelDocChangeSub.dispose(); } catch { /* ignore */ }
            drawioWatcher.disposeAll();
            // folderWatcher, noteFileWatcher は disposables に含まれているため
            // disposables.forEach で一括dispose（二重disposeを避ける）
            disposables.forEach(d => d.dispose());
        });
    }

    private getS3Config(bucketPath: string, folderPath: string): S3SyncConfig | null {
        const config = vscode.workspace.getConfiguration('fractal');
        const accessKeyId = config.get<string>('s3AccessKeyId', '');
        const secretAccessKey = config.get<string>('s3SecretAccessKey', '');
        const region = config.get<string>('s3Region', 'us-east-1');
        if (!accessKeyId || !secretAccessKey) {
            vscode.window.showErrorMessage('AWS credentials not configured. Set fractal.s3AccessKeyId and s3SecretAccessKey in settings.');
            return null;
        }
        return { accessKeyId, secretAccessKey, region, bucketPath, localPath: folderPath };
    }

    private async runS3Operation(
        op: 's3Sync' | 's3RemoteDeleteAndUpload' | 's3LocalDeleteAndDownload',
        bucketPath: string,
        sender: NotesSender,
        fileManager: NotesFileManager,
        folderPath: string,
    ): Promise<void> {
        fileManager.flushSave();

        // notes folder 配下の dirty な TextDocument (.md / .out 等) を flush。
        // VSCode テキストエディタで `_notes_md/*.md` を編集中に S3 sync すると、
        // dirty buffer がディスクに反映されないまま古い内容が S3 に upload されて
        // 編集が失われるリスクがあるため、operation 前に必ず flush する。
        const dirtyDecision = await this.flushDirtyDocsUnderFolder(folderPath);
        if (dirtyDecision === 'cancel') {
            sender.postMessage({ type: 'notesS3Progress', phase: 'cancelled', message: 'Sync cancelled' });
            return;
        }

        const config = this.getS3Config(bucketPath, folderPath);
        if (!config) {
            sender.postMessage({ type: 'notesS3Progress', phase: 'error', message: 'AWS credentials not configured.' });
            return;
        }

        const entry = this.openPanels.get(folderPath);
        const panel = entry?.panel;

        const onProgress = (p: { phase: string; message: string; currentFile?: string; filesProcessed?: number }) => {
            sender.postMessage({ type: 'notesS3Progress', ...p });
            // FR-OS3-08 / VSCode キャッシュ対策: webview overlay にも phase 表示
            if (panel) {
                panel.webview.postMessage({ type: 'sync-progress', phase: p.phase, message: p.message });
            }
        };

        // VSCode キャッシュ対策: 全 NT-09 操作中は webview を lock
        if (panel) panel.webview.postMessage({ type: 'sync-lock' });

        let needsDisposeAndReopen = false;
        let needsReinit = false;

        try {
            if (op === 's3Sync') {
                await s3Sync(config, onProgress);
                // 双方向 sync で local が変わった可能性 → revert + reinit
                needsReinit = true;
            } else if (op === 's3RemoteDeleteAndUpload') {
                await s3RemoteDeleteAndUpload(config, onProgress);
                // local 不変 → reinit 不要、lock 解除のみ
            } else {
                await s3LocalDeleteAndDownload(config, onProgress);
                sender.postMessage({ type: 'notesS3Progress', phase: 'complete', message: 'Local delete & download complete. Reopening...' });
                // local が完全置換 → panel を dispose して再生成
                needsDisposeAndReopen = true;
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            sender.postMessage({ type: 'notesS3Progress', phase: 'error', message });
        }

        // 後処理 (cache invalidation)
        if (needsDisposeAndReopen) {
            await this.disposeAndReopenNotePanel(folderPath);
            return;
        }
        if (needsReinit && panel) {
            await this.revertAndReinitNotePanel(folderPath, fileManager, panel);
        }
        // sync-applied で webview lock 解除 (revertAndReinit が send しなかった場合の保険)
        if (panel && !needsDisposeAndReopen) {
            panel.webview.postMessage({ type: 'sync-applied', data: null, fileChangeId: -1 });
        }
    }

    /**
     * notes folder 配下の dirty TextDocument を flush。拡張子制限なしで `folderPath`
     * 配下の全 TextDocument を対象 (`.md` / `.out` / `_notes_md/files/*.drawio.svg`
     * / `pages/*.md` 等)。バイナリ系 (画像) は VSCode の TextDocument に含まれないため
     * 自然と対象外 (直接編集手段がないので問題なし)。
     *
     * VSCode テキストエディタで開いている未保存変更が S3 sync で上書き消失するのを
     * 防ぐ。outliner-s3-sync.flushDirtyDocs と同じ user 選択 dialog。
     */
    private async flushDirtyDocsUnderFolder(folderPath: string): Promise<'continue' | 'cancel'> {
        const prefix = folderPath.endsWith(path.sep) ? folderPath : folderPath + path.sep;
        const dirtyDocs = vscode.workspace.textDocuments.filter((doc) => {
            if (!doc.isDirty) return false;
            const fp = doc.uri.fsPath;
            return fp === folderPath || fp.startsWith(prefix);
        });
        if (dirtyDocs.length === 0) return 'continue';

        const result = await vscode.window.showWarningMessage(
            'Unsaved changes detected',
            {
                modal: true,
                detail: `${dirtyDocs.length} file(s) have unsaved changes. How do you want to proceed?`,
            },
            'Save and continue',
            'Discard and continue',
            'Cancel sync',
        );

        if (!result || result === 'Cancel sync') return 'cancel';
        if (result === 'Save and continue') {
            for (const doc of dirtyDocs) {
                try { await doc.save(); } catch { /* ignore */ }
            }
            return 'continue';
        }
        return 'continue';
    }

    /**
     * note panel を dispose して再生成 (Local Delete & Download 後の cache 完全リセット用)
     */
    /**
     * FR-MG-07: note フォルダを丸ごとバックアップして backup パスを返す（executePlan の前の安全網）。
     * backup 先は noteDir の「外」（親ディレクトリ直下）に置く。noteDir 内に置くと
     * planMigration/executePlan の走査対象に入って二重コピー・自己参照を起こすため。コピーのみ（削除しない）。
     * ★ FR-MG-07 改訂: backup 名を `.` 開始にしない（`.` 開始は Finder/一部 mac ユーザーで不可視になり
     *   「バックアップ場所を明示」の意図が損なわれるため。可視名にする）。noteDir 外に置く点は不変
     *   （名前の `.` 有無は planMigration の走査対象性に無関係 = 走査は noteDir 内のみ）。
     * ★ timestamp は Date.now()（extension host = Node。webview 制約とは無関係）。
     */
    private backupNoteFolder(noteDir: string): string {
        const parent = path.dirname(noteDir);
        const base = path.basename(noteDir);
        const backupPath = path.join(parent, `${base}-backup-${Date.now()}`);
        if (fs.existsSync(backupPath)) {
            throw new Error(`backup path already exists: ${backupPath}`);
        }
        // fs.cpSync(recursive): 既存前例 notes-file-manager.ts:1196 と同パターン。削除 API を使わない（DOD-24 無関係）。
        fs.cpSync(noteDir, backupPath, { recursive: true });
        return backupPath;
    }

    private async disposeAndReopenNotePanel(folderPath: string): Promise<void> {
        const entry = this.openPanels.get(folderPath);
        if (entry) {
            try { entry.panel.dispose(); } catch { /* ignore */ }
            this.openPanels.delete(folderPath);
        }
        // dispose 後の race 回避のため少し待つ
        await new Promise((r) => setTimeout(r, 100));
        await this.openNotesFolder(folderPath);
    }

    /**
     * note panel の TextDocument を revert + outliner / file list を再 init
     * (Sync Backup 双方向で local が変わった後のキャッシュ整合用)
     */
    private async revertAndReinitNotePanel(
        folderPath: string,
        fileManager: NotesFileManager,
        panel: vscode.WebviewPanel,
    ): Promise<void> {
        // 関連 TextDocument を revert (page md / .out 等)
        const docs = vscode.workspace.textDocuments.filter((doc) => {
            const fp = doc.uri.fsPath;
            return fp === folderPath || fp.startsWith(folderPath + path.sep);
        });
        for (const doc of docs) {
            try {
                await vscode.commands.executeCommand('workbench.action.files.revertResource', doc.uri);
            } catch {
                try {
                    await vscode.commands.executeCommand('workbench.action.files.revert', doc.uri);
                } catch {
                    /* ignore */
                }
            }
        }

        // 構造 + 現在の outliner を再ロードして webview に送信
        try {
            fileManager.invalidateStructureCache();
            const structure = fileManager.getStructureForWebview();
            const fileList = fileManager.listFiles();
            const currentFile = fileManager.getCurrentFilePath();

            panel.webview.postMessage({
                type: 'notesFileListChanged',
                fileList, structure, currentFile,
            });

            if (currentFile && fs.existsSync(currentFile)) {
                const content = fs.readFileSync(currentFile, 'utf8');
                try {
                    const data = JSON.parse(content);
                    // sync-applied だけで model リセットには十分。
                    // updateData with fileChangeId を送ると bridge の currentFileChangeId が
                    // 不正な値で上書きされ、後続 syncData が host で stale 判定で破棄される
                    // (BUG: Date.now() を使うと host fileManager.fileChangeId と乖離)
                    panel.webview.postMessage({
                        type: 'sync-applied',
                        data,
                    });
                    fileManager.updateLastKnownContent(content);
                } catch (e) {
                    /* JSON parse エラー時は触らない */
                }
            } else {
                // 現在開いていた file が消えた可能性 → lock 解除のみ
                panel.webview.postMessage({ type: 'sync-applied', data: null });
            }
        } catch (e) {
            console.error('[NotesEditorProvider] revertAndReinitNotePanel error:', e);
            panel.webview.postMessage({ type: 'sync-applied', data: null, fileChangeId: -1 });
        }
    }

    /**
     * Resolve page md file path from note folder + outFileId + pageId.
     * Does not require the note to be open — reads .out file directly from disk.
     */
    resolvePagePath(noteFolderPath: string, outFileId: string, pageId: string): string | null {
        const outFilePath = path.join(noteFolderPath, `${outFileId}.out`);
        if (!fs.existsSync(outFilePath)) return null;
        let outData: Record<string, unknown> | undefined;
        try {
            outData = JSON.parse(fs.readFileSync(outFilePath, 'utf8'));
        } catch { /* ignore */ }
        // Resolve pageDir: 1) .out JSON 内 pageDir → 2) ./<basename>/ (convention) → 3) ./pages (legacy)
        // sprint 20260509-185557: VSCode 設定 outlinerPageDir 撤廃に伴い convention 経路を採用
        const outDir = path.dirname(outFilePath);
        const basename = path.basename(outFilePath, '.out');
        let resolvedPageDir: string;
        if (outData?.pageDir) {
            const pageDir = outData.pageDir as string;
            resolvedPageDir = path.isAbsolute(pageDir) ? pageDir : path.resolve(outDir, pageDir);
        } else {
            const newDefaultDir = path.resolve(outDir, basename);
            const legacyDir = path.resolve(outDir, 'pages');
            resolvedPageDir = (!fs.existsSync(newDefaultDir) && fs.existsSync(legacyDir))
                ? legacyDir
                : newDefaultDir;
        }
        const pagePath = path.join(resolvedPageDir, `${pageId}.md`);
        return fs.existsSync(pagePath) ? pagePath : null;
    }

    /**
     * Open a page md file in the currently visible (active) note panel's sidepanel.
     * No note switching or outliner navigation — just opens the md.
     */
    async openPageInCurrentPanel(filePath: string): Promise<void> {
        // Find the currently visible panel
        for (const [, entry] of this.openPanels) {
            if (entry.panel.visible && entry.openPage) {
                await entry.openPage(filePath);
                return;
            }
        }
        // Fallback: use the first panel with openPage
        for (const [, entry] of this.openPanels) {
            if (entry.openPage) {
                entry.panel.reveal(vscode.ViewColumn.One);
                await entry.openPage(filePath);
                return;
            }
        }
    }

    async navigateToLink(folderPath: string, params: { outFileId?: string; nodeId?: string; pageId?: string; mdFileId?: string }): Promise<void> {
        const entry = this.openPanels.get(folderPath);
        if (!entry) return;
        entry.panel.reveal(vscode.ViewColumn.One);
        if (params.mdFileId) {
            // FR-B11 md link: host 側で絶対パスに解決して渡す（webview は id → path を解決できない）。
            // webview 側で sidepanel を閉じてから notesOpenFile 経路（md は JSON.parse に流れない）で開く
            const mdFileId = params.mdFileId.replace(/\.md$/i, '');
            // TASK-09: mdFileId は外部入力（手貼りリンク）。note フォルダ外への traversal は
            // resolveMdFilePath 側で basename に clamp されるが、二重防御でここでも検証し
            // note 外に解決されたら開かない（belt-and-suspenders）。
            const mdFilePath = entry.fileManager.getMdFilePath(mdFileId);
            const mainFolder = entry.fileManager.getMainFolderPath();
            if (safeResolveUnderDir(mainFolder, path.relative(mainFolder, mdFilePath)) === null) {
                vscode.window.showWarningMessage('Invalid in-app link (path outside note folder)');
                return;
            }
            entry.postMessage({
                type: 'notesNavigateInAppLink',
                mdFilePath,
            });
            return;
        }
        entry.postMessage({
            type: 'notesNavigateInAppLink',
            outFileId: params.outFileId,
            nodeId: params.nodeId,
        });
    }

    /**
     * Get the main folder path of the active (visible) notes panel.
     * Used by fractal.cleanUnusedFilesInNote command.
     */
    getActiveMainFolderPath(): string | null {
        // Try to find the currently visible panel
        for (const [folderPath, entry] of this.openPanels) {
            if (entry.panel.visible) {
                return folderPath;
            }
        }
        // Fallback: if no panel is visible but panels exist, use the first one
        if (this.openPanels.size > 0) {
            return Array.from(this.openPanels.keys())[0];
        }
        return null;
    }
}
