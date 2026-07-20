import * as fs from 'fs';
import * as path from 'path';
import { NotesFileManager } from './notes-file-manager';
import { importMdFiles } from './markdown-import';
import { OutlinerClipboardStore } from './outliner-clipboard-store';
import { handlePageAssets, handleImageAssets, handleFileAsset, copyImageAssets, moveImageAssets } from './paste-asset-handler';
import { safeResolveUnderDir } from './path-safety';
import { handleExportMindmap } from './mindmap-export-host';
import { translateText, TRANSLATE_LANGUAGES } from './aws-translate';
import { processDropFilesImport, processDropVscodeUrisImport, DropImportItem } from './drop-import';
import { setFirstH1, writeFileIfChanged } from './md-h1-utils';

/**
 * Webview へのメッセージ送信インターフェース
 * VSCode: panel.webview.postMessage()
 * Electron: win.webContents.send('host-message', ...)
 */
export interface NotesSender {
    postMessage(message: unknown): void;
}

/**
 * プラットフォーム固有アクションのインターフェース
 */
export interface NotesPlatformActions {
    /** 外部リンクをブラウザで開く */
    openExternalLink(href: string): void;
    /** FR-RR-06: fractal.resourceRoots の settings を開く */
    openResourceRootsSettings?(): void;
    /** FR-RR-04: notes 本体 md open 時、その md の画像に許可範囲外があればフッター案内を送る */
    sendResourceAccessStatus?(filePath: string, mdBody: string): void;
    /** .md ファイルをエディタで開く (Electron: createWindow, VSCode: vscode.openWith) */
    openFileInEditor(filePath: string): void;
    /** サイドパネルでページを開く (lineNumber指定時はスクロール) */
    openPageInSidePanel(filePath: string, lineNumber?: number, query?: string, occurrence?: number): void;
    /** 画像挿入ダイアログ表示 */
    requestInsertImage(sidePanelFilePath: string): void;
    /** パネル折り畳み状態を永続化 */
    savePanelCollapsed(collapsed: boolean): void;
    /** ノート共通の sidepanel md 幅を outline.note に保存 */
    saveNoteSidePanelWidth?(width: number): void;
    /** ノート共通の sidepanel TOC 幅を outline.note に保存 */
    saveNoteSidePanelOutlineWidth?(width: number): void;
    /** ページディレクトリ変更ダイアログ */
    requestSetPageDir(): void;
    /** 画像をディレクトリに保存してマークダウン挿入 */
    saveImageToDir(dataUrl: string, fileName: string, sidePanelFilePath: string): void;
    /** ファイルを画像ディレクトリにコピーしてマークダウン挿入 */
    readAndInsertImage(filePath: string, sidePanelFilePath: string): void;
    /** ファイル添付をディレクトリに保存してマークダウンリンク挿入 */
    saveFileToDir?(dataUrl: string, fileName: string, sidePanelFilePath: string): void;
    /** ファイル添付をコピーしてマークダウンリンク挿入 */
    readAndInsertFile?(filePath: string, sidePanelFilePath: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/images/ に保存して挿入 */
    saveMdImageToDir?(dataUrl: string, fileName: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/images/ にコピーして挿入 */
    readAndInsertMdImage?(filePath: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/files/ に保存して挿入 */
    saveMdFileToDir?(dataUrl: string, fileName: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/files/ にコピーして挿入 */
    readAndInsertMdFile?(filePath: string): void;
    /** v0.207.82: Notes 内 .md エディタ用 — メインペインステータスバーへ画像/ファイル保存先を送出 */
    sendMdDirStatus?(): void;
    /** v0.207.82: Notes 内 .md エディタ用 — webview 内で相対画像 URL を解決するための base URI */
    getMdDocumentBaseUri?(filePath: string): string;
    /** v0.207.86: Notes 内 .md メインペインの cmd+/ → Add Page — <_notes_md>/pages/<unique>.md を作成 */
    notesMdCreatePageAuto?(currentMdFilePath: string): void;
    /** v0.207.86: Notes 内 .md メインペインの cmd+/ → Add Page で linkName を H1 に同期 */
    notesMdUpdatePageH1?(currentMdFilePath: string, relativePath: string, h1Text: string): void;
    /** v0.207.86: Notes 内 .md メインペインからのリンククリック (plain) — sidepanel で開く */
    notesMdOpenLink?(currentMdFilePath: string, href: string): void;
    /** v0.207.86: Notes 内 .md メインペインからのリンククリック (cmd/ctrl+click) — 新タブ standalone で開く */
    notesMdOpenLinkInTab?(currentMdFilePath: string, href: string): void;
    /** v0.207.88: Notes 内 .md メインペインヘッダーの「新タブで開く」ボタン — 自身を standalone editor で開く */
    notesMdOpenSelfInNewTab?(currentMdFilePath: string): void;
    /** v0.207.82: Notes 内 .md メインペインの open hook — sidepanel パターンで TextDocument 開き + FileSystemWatcher 起動 */
    mdMainOpened?(filePath: string): void;
    /** v0.207.82: Notes 内 .md メインペインの close hook — TextDocument / watcher を破棄 */
    mdMainClosed?(): void;
    /** v0.207.82: Notes 内 .md auto-save 経路 — TextDocument バッファ経由で書く (sidepanel と同じ) */
    mdMainSave?(filePath: string, content: string): Promise<void> | void;
    /** MD-45: drawio dataUrl を fileDir に保存して `![]()` 挿入 */
    saveDrawioToDir?(dataUrl: string, fileName: string, sidePanelFilePath: string): void;
    /** MD-45 (URI 経路): drawio ファイルを fileDir にコピーして `![]()` 挿入 */
    readAndInsertDrawio?(filePath: string, sidePanelFilePath: string): void;
    /** MD-46: .drawio (XML) D&D 棄却ダイアログ + drawio Desktop で開く */
    notifyUnsupportedDrawioXml?(droppedPath: string, fileName: string, sidePanelFilePath: string): void;
    /** MD-47: Cmd+/ → Insert Drawio Diagram → InputBox → fileDir/<name>.drawio.svg 生成 + 挿入 */
    requestCreateDrawio?(sidePanelFilePath: string): void;
    createPageAutoForSidePanel?(sidePanelFilePath: string): void;
    sidePanelNavigateBack?(sidePanelFilePath: string): void;
    sidePanelNavigateForward?(sidePanelFilePath: string): void;
    /** サイドパネルの画像ディレクトリ情報を送信 */
    sendSidePanelImageDir(sidePanelFilePath: string): void;
    /** サイドパネルファイルを保存 */
    saveSidePanelFile(filePath: string, content: string): Promise<void>;
    /** サイドパネルのリンクを処理 */
    handleSidePanelOpenLink(href: string, sidePanelFilePath: string): void;
    /** サイドパネルファイルをテキストエディタで開く */
    handleSidePanelOpenInTextEditor?(sidePanelFilePath: string): void;
    /** サイドパネルが閉じられた */
    handleSidePanelClosed(): void;
    /** サイドパネルの sendToChat を処理（テキストエディタで開いて行選択） */
    sendToChatFromSidePanel?(sidePanelFilePath: string, startLine: number, endLine: number, selectedMarkdown: string): Promise<void>;
    /** .outファイルをテキストエディタで開く */
    openInTextEditor?(): void;
    /** .outファイルパスをクリップボードにコピー */
    copyFilePath?(): void;
    /** ページファイルパスをクリップボードにコピー */
    copyPagePaths?(paths: string[]): void;
    /** 外部エディタでファイルを開く */
    openFileExternal?(filePath: string): void;
    /** 最後に開いたファイルを記録 */
    saveLastOpenedFile?(filePath: string): void;
    /** ファイル検索 */
    searchFiles?(query: string): void;
    /** S3同期（バックアップ） */
    s3Sync?(bucketPath: string): void;
    /** S3リモート全削除＋アップロード */
    s3RemoteDeleteAndUpload?(bucketPath: string): void;
    /** S3ローカル全削除＋ダウンロード */
    s3LocalDeleteAndDownload?(bucketPath: string): void;
    /** S3ステータス取得（認証情報の有無、バケットパス） */
    s3GetStatus?(): void;
    /** outliner toolbar の同期ボタン押下 (FR-OS3-03) */
    outlinerS3Sync?(outlinerId: string): void;
    /** Outlinerノード画像保存 */
    saveOutlinerImage?(nodeId: string, dataUrl: string, fileName: string): void;
    /** .mdファイルインポートダイアログ表示 */
    importMdFilesDialog?(targetNodeId: string | null, sender: NotesSender): void;
    /** 任意ファイルインポートダイアログ表示 */
    importFilesDialog?(targetNodeId: string | null, sender: NotesSender): void;
    /** ファイル添付を開く */
    openAttachedFile?(nodeId: string, outFilePath: string, sender: NotesSender): void;
    /** FR-NT-03: note タイトル変更後に Notes Folder ツリービューを更新する */
    refreshNotesFolderTree?(): void;
    /** FR-FR-01: ファイル添付を OS ファイラ (Finder) で選択状態表示する */
    revealAttachedFileInOS?(nodeId: string, outFilePath: string, sender: NotesSender): void;
    /** FR-FR-02: md ページ実体を OS ファイラ (Finder) で選択状態表示する */
    revealPageInOS?(nodeId: string, fileManager: NotesFileManager, sender: NotesSender): void;
    /** FR-MV-01: Notes タブの項目を別 Note へ移動 (QuickPick で移動先選択) */
    moveItemToOtherNote?(itemId: string, fileManager: NotesFileManager, sender: NotesSender): void;
    /** FR-OL-COPYPATH-1: ファイル添付ノードの絶対 path を OS clipboard へコピー */
    copyAttachedFilePath?(nodeId: string, outFilePath: string, sender: NotesSender): void;
    /** 画像 fullscreen overlay: 画像をピクセルとして OS clipboard へコピー */
    copyImageToClipboard?(absPath: string): void;
    /** 画像 fullscreen overlay: 画像を新規タブで開く */
    openImageInNewTab?(absPath: string): void;
    /** v0.207.48: 複数ノードの添付 file path を改行区切りで OS clipboard へコピー */
    copyAttachedFilePaths?(nodeIds: string[], outFilePath: string, sender: NotesSender): void;
    /** llms.txt 風 subtree コピー (MD pages) — tree.children を再帰し pageId→絶対パスを解決 */
    copyLlmsTxtMdTree?(tree: unknown, outFilePath: string, sender: NotesSender): void;
    /** llms.txt 風 subtree コピー (file attachments) — tree.children を再帰し filePath→絶対パスを解決 */
    copyLlmsTxtFileTree?(tree: unknown, outFilePath: string, sender: NotesSender): void;
    /** llms.txt 風 subtree コピー (MD pages + file attachments) — 同一ノードに両方ある場合は 2 本 bullet */
    copyLlmsTxtBothTree?(tree: unknown, outFilePath: string, sender: NotesSender): void;
    /** アプリ内リンクナビゲーション */
    navigateInAppLink?(href: string): void;
    /** リンク挿入ダイアログ表示 (サイドパネル editor 用) */
    requestInsertLink?(text: string, sender: NotesSender): void;
    /** FR-7: 手動クリーンアップコマンド (全 note 一気モード) */
    cleanupUnusedFilesAllNotes?(): Promise<void>;
    /** FR-7: 手動クリーンアップコマンド (自ノート限定モード) */
    cleanupUnusedFilesCurrentNote?(): Promise<void>;
    /** v9: MD paste with asset copy (cross-outliner/cross-note paste) */
    pasteWithAssetCopy?(markdown: string, sourceContext: any, sidePanelFilePath: string): void;
    /** HTML paste で MD に残った data:image/... を images/ に実体化し相対 path 化 */
    extractDataUrlsInPastedMd?(markdown: string, sidePanelFilePath: string): void;
    /** v10: Get workspace config (for translate AWS credentials) */
    getWorkspaceConfig?(section: string): any;
    /** v10: Post message to webview (used in translate handler) */
    postMessage?(message: any): void;
    /** v10: Show quick pick for language selection */
    showQuickPick?(items: Array<{ label: string; description?: string }>, placeHolder: string): Promise<{ label: string; description?: string } | undefined>;
    /** v0.207.24: Update workspace config (for saving translate lang preferences) */
    updateWorkspaceConfig?(section: string, key: string, value: unknown): Promise<void>;
    /** v0.207.24: 翻訳結果を sidepanel の所属 outliner node に子 page として attach */
    saveTranslationToOutlinerNode?(sidePanelFilePath: string, translatedMarkdown: string, h1Title: string, sourceLang: string, targetLang: string): Promise<void>;
    /** v0.207.25: 任意の VSCode command を実行 (Tools tab → fractal.updateTranslateTerminology 等) */
    executeCommand?(command: string, ...args: unknown[]): Promise<unknown>;
    /** v12: D&D ファイルインポート */
    dropFilesImport?(items: DropImportItem[], targetNodeId: string | null, position: string, sender: NotesSender): void;
    /** v12 拡張: VSCode Explorer D&D */
    dropVscodeUrisImport?(uris: string[], targetNodeId: string | null, position: string, sender: NotesSender): void;
    /** v12: フォルダ D&D 拒否通知 */
    notifyDropFolderRejected?(folders: string[]): void;
    /** v12: ファイルサイズ超過通知 */
    notifyDropFileTooLarge?(fileName: string): void;
    /** v0.207.96: Streaming D&D pipeline (files > 50MB). Routes all 5 dropStream* messages
     *  to a per-panel DropStreamHost on the platform side. */
    dropStreamMessage?(message: { type: string } & Record<string, unknown>): Promise<boolean> | boolean;
    /** タスクモード archive: 情報メッセージ表示 */
    showInformationMessage?(text: string): void;
    /** タスクモード archive: エラーメッセージ表示 */
    showErrorMessage?(text: string): void;
    /** v0.207.77 (D&D Feature A): Notes 内 .md を別の .out item にドロップ → 当該 .out のトップに page-node を追加 */
    notesImportMdIntoOut?(mdFileId: string, targetOutId: string, sender: NotesSender): Promise<void> | void;
    /** v0.207.77 (D&D Feature B): outliner page-node を Notes panel にドロップ → そのページを独立 .md として登録 */
    notesImportOutPageNodeAsMd?(
        payload: { outFileKey: string; nodeId: string; pageId: string; title: string },
        parentId: string | null,
        index: number,
        sender: NotesSender
    ): Promise<void> | void;
    /** node-move-to-other-outliner: outliner node（サブツリー）を右パネルの別 .out に move（root 先頭挿入） */
    notesMoveOutNodeSubtreeIntoOut?(
        payload: { outFileKey: string; nodeId: string },
        targetOutFilePath: string,
        sender: NotesSender
    ): Promise<void> | void;
}

/**
 * 構造付きファイルリスト更新メッセージを送信するヘルパー
 */
function sendFileListWithStructure(
    fileManager: NotesFileManager,
    sender: NotesSender,
    currentFile?: string | null
): void {
    const fileList = fileManager.listFiles();
    // FR-HP: 履歴 title を送出時に最新解決（保存値は非破壊。stale title の 1テンポ遅れ解消）。
    // 全 notesFileListChanged 送出経路で getStructureForWebview() に統一（送出経路の取りこぼし防止）。
    const structure = fileManager.getStructureForWebview();
    sender.postMessage({
        type: 'notesFileListChanged',
        fileList,
        structure,
        currentFile: currentFile !== undefined ? currentFile : fileManager.getCurrentFilePath(),
        // FR-NT-01: note フォルダ名 (noteTitle 未設定時の既定表示に webview 側で使う)
        noteFolderName: path.basename(fileManager.getMainFolderPath()),
    });
}

/**
 * Notes メッセージハンドラ
 * webview からのメッセージを処理する共通ロジック
 */
export async function handleNotesMessage(
    message: any,
    fileManager: NotesFileManager,
    sender: NotesSender,
    platform: NotesPlatformActions
): Promise<void> {
    switch (message.type) {
        // ── Core Data ──

        case 'openResourceRootsSettings':
            platform.openResourceRootsSettings?.();
            break;

        case 'syncData':
            // stale sync（ファイル切替前のデータ）を無視
            if (message.fileChangeId !== undefined && message.fileChangeId !== fileManager.getFileChangeId()) {
                console.log('[NotesMessageHandler] syncData REJECTED stale fileChangeId got=', message.fileChangeId, 'expected=', fileManager.getFileChangeId());
                break;
            }
            console.log('[NotesMessageHandler] syncData received from webview at', new Date().toISOString(), 'size=', (message.content || '').length, 'B fileChangeId=', message.fileChangeId);
            fileManager.saveCurrentFile(message.content);
            // .out の title 変更を tree（items[id].title）へ即反映（md の syncTitleFromH1 と対称）。
            // 変化時のみ再描画。tree の .out title は items[id].title を優先表示するため即時反映される。
            if (fileManager.syncOutTitleToTree(message.content)) {
                sendFileListWithStructure(fileManager, sender);
            }
            break;

        // ADR-008: Notes メインペイン Markdown editor からの auto-save
        case 'notesSaveCurrentMd': {
            if (message.fileChangeId !== undefined && message.fileChangeId !== fileManager.getFileChangeId()) {
                break;
            }
            const cur = fileManager.getCurrentFilePath();
            if (!cur || !cur.endsWith('.md')) break;
            // v0.207.82: sidepanel と同じく TextDocument バッファ経由で保存。
            // mdMainSave が無い場合は従来の fileManager.saveCurrentFile (debounced fs.writeFile) に fallback。
            if (platform.mdMainSave) {
                Promise.resolve(platform.mdMainSave(cur, message.content)).catch(e => {
                    console.error('[NotesMessageHandler] mdMainSave error:', e);
                });
            } else {
                fileManager.saveCurrentFile(message.content);
            }
            // FR-TH-02: 先頭 H1 を tree title に反映（変化時のみ再描画）
            if (fileManager.syncTitleFromH1(cur, message.content)) {
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        case 'save':
            fileManager.flushSave();
            break;

        case 'exportMindmap': {
            // Mindmap Mode (sprint 20260701-122355): Note モードの PNG/SVG/OPML/MD 書き出し (#M2, 4-mode)。
            const cur = fileManager.getCurrentFilePath();
            const baseDir = cur ? path.dirname(cur) : '';
            const result = await handleExportMindmap(message, baseDir);
            sender.postMessage({ type: 'mindmapExportDone', ...result });
            break;
        }

        case 'openInTextEditor':
            platform.openInTextEditor?.();
            break;


        case 'copyFilePath':
            platform.copyFilePath?.();
            break;

        case 'copyPagePaths': {
            const pageIds: string[] = message.pageIds || [];
            const paths = pageIds
                .map((pid: string) => fileManager.getPageFilePath(pid))
                .filter((p: string) => fs.existsSync(p));
            if (paths.length > 0) {
                platform.copyPagePaths?.(paths);
            }
            break;
        }

        // ── Page Operations ──

        case 'importMdFilesDialog':
            platform.importMdFilesDialog?.(message.targetNodeId, sender);
            break;

        case 'importFilesDialog':
            platform.importFilesDialog?.(message.targetNodeId, sender);
            break;

        case 'dropFilesImport':
            platform.dropFilesImport?.(message.items, message.targetNodeId, message.position, sender);
            break;

        case 'dropVscodeUrisImport':
            platform.dropVscodeUrisImport?.(message.uris, message.targetNodeId, message.position, sender);
            break;

        case 'notifyDropFolderRejected':
            platform.notifyDropFolderRejected?.(message.folders);
            break;

        case 'notifyDropFileTooLarge':
            platform.notifyDropFileTooLarge?.(message.fileName);
            break;

        case 'dropStreamBegin':
        case 'dropStreamChunk':
        case 'dropStreamFileEnd':
        case 'dropStreamSessionEnd':
        case 'dropStreamCancel':
            await platform.dropStreamMessage?.(message);
            break;

        case 'openAttachedFile': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.openAttachedFile?.(message.nodeId, currentFilePath, sender);
            }
            break;
        }

        // FR-FR-01: file 添付ノードを OS ファイラ (Finder) で選択状態表示 (Notes mode)
        case 'revealAttachedFileInOS': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.revealAttachedFileInOS?.(message.nodeId, currentFilePath, sender);
            }
            break;
        }

        // FR-FR-02: md ページ実体を OS ファイラ (Finder) で選択状態表示 (Notes mode)
        case 'revealPageInOS': {
            platform.revealPageInOS?.(message.nodeId, fileManager, sender);
            break;
        }

        // FR-MV-01: Notes タブの項目を別 Note へ移動 (QuickPick で移動先選択)
        case 'notesMoveToOtherNote': {
            platform.moveItemToOtherNote?.(message.itemId, fileManager, sender);
            break;
        }

        // FR-OL-COPYPATH-1: file 添付の Copy File Path (Notes mode)
        case 'copyAttachedFilePath': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyAttachedFilePath?.(message.nodeId, currentFilePath, sender);
            }
            break;
        }

        // v0.207.48: 複数ノードの Copy File Paths (Notes mode)
        case 'copyAttachedFilePaths': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyAttachedFilePaths?.(message.nodeIds || [], currentFilePath, sender);
            }
            break;
        }

        // llms.txt 風 subtree コピー (Notes mode)
        case 'copyLlmsTxtMdTree': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyLlmsTxtMdTree?.(message.tree, currentFilePath, sender);
            }
            break;
        }
        case 'copyLlmsTxtFileTree': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyLlmsTxtFileTree?.(message.tree, currentFilePath, sender);
            }
            break;
        }
        case 'copyLlmsTxtBothTree': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyLlmsTxtBothTree?.(message.tree, currentFilePath, sender);
            }
            break;
        }

        case 'makePage': {
            const pagesDir = fileManager.getPagesDirPath();
            if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
            const pagePath = path.join(pagesDir, `${message.pageId}.md`);
            try {
                fs.writeFileSync(pagePath, `# ${message.title}\n`, 'utf8');
                sender.postMessage({ type: 'pageCreated', nodeId: message.nodeId, pageId: message.pageId });
            } catch (e) {
                console.error('[Notes] makePage error:', e);
            }
            break;
        }

        case 'openPage': {
            const pagePath = fileManager.getPageFilePath(message.pageId);
            if (fs.existsSync(pagePath)) {
                platform.openFileInEditor(pagePath);
            }
            break;
        }

        case 'removePage': {
            // .md ファイルは削除しない (オーファンとして残す)
            // → cleanup コマンドで掃除する
            break;
        }

        case 'saveOutlinerClipboard': {
            const clipPagesDir = fileManager.getPagesDirPath();
            const clipFileDir = fileManager.getFileDirPath();
            const currentFilePath = fileManager.getCurrentFilePath();
            OutlinerClipboardStore.save({
                plainText: message.plainText,
                isCut: message.isCut,
                nodes: message.nodes,
                sourcePagesDirPath: clipPagesDir,
                sourceImagesDirPath: path.join(clipPagesDir, 'images'),
                sourceFileDirPath: clipFileDir,
                sourceOutDir: currentFilePath ? path.dirname(currentFilePath) : clipPagesDir
            });
            break;
        }

        case 'handlePageAssetsCross': {
            const clipData = OutlinerClipboardStore.get(message.clipboardPlainText);
            if (!clipData) break;
            const currentFilePath = fileManager.getCurrentFilePath();
            const destPagesDir = fileManager.getPagesDirPath();
            const result = handlePageAssets({
                srcOutDir: clipData.sourceOutDir,
                srcPagesDir: clipData.sourcePagesDirPath,
                destOutDir: currentFilePath ? path.dirname(currentFilePath) : destPagesDir,
                destPagesDir,
                pageId: message.pageId,
                newPageId: message.newPageId,
                nodeImages: message.nodeImages || [],
                sameDirSkip: message.isCut
            });
            sender.postMessage({
                type: 'updateNodeImages',
                nodeId: message.targetNodeId,
                newImages: result.newNodeImages
            });
            if (message.isCut) {
                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
            }
            break;
        }

        case 'copyImagesCross': {
            const imgClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
            if (!imgClipData || !message.images) break;
            const currentFilePath = fileManager.getCurrentFilePath();
            const destPagesDir = fileManager.getPagesDirPath();
            const result = message.isCut
                ? moveImageAssets({
                    srcOutDir: imgClipData.sourceOutDir,
                    srcPagesDir: imgClipData.sourcePagesDirPath,
                    destOutDir: currentFilePath ? path.dirname(currentFilePath) : destPagesDir,
                    destPagesDir,
                    nodeImages: message.images
                })
                : copyImageAssets({
                    srcOutDir: imgClipData.sourceOutDir,
                    srcPagesDir: imgClipData.sourcePagesDirPath,
                    destOutDir: currentFilePath ? path.dirname(currentFilePath) : destPagesDir,
                    destPagesDir,
                    newNodeId: message.targetNodeId,
                    nodeImages: message.images
                });
            sender.postMessage({
                type: 'updateNodeImages',
                nodeId: message.targetNodeId,
                newImages: result.newNodeImages
            });
            if (message.isCut) {
                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
            }
            break;
        }

        case 'handleFileAssetCross': {
            const fileClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
            if (!fileClipData || !message.filePath) break;
            const currentFilePathFA = fileManager.getCurrentFilePath();
            const destFileDirFA = fileManager.getFileDirPath();
            const resultFA = handleFileAsset({
                srcOutDir: fileClipData.sourceOutDir,
                srcFileDir: fileClipData.sourceFileDirPath || path.join(fileClipData.sourceOutDir, 'files'),
                destOutDir: currentFilePathFA ? path.dirname(currentFilePathFA) : destFileDirFA,
                destFileDir: destFileDirFA,
                filePath: message.filePath,
                useCollisionSuffix: !message.isCut,
                sameDirSkip: message.isCut
            });
            sender.postMessage({
                type: 'updateNodeFilePath',
                nodeId: message.nodeId,
                newFilePath: resultFA.newFilePath
            });
            if (message.isCut) {
                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
            }
            break;
        }

        case 'insertLink':
            if (platform.requestInsertLink) {
                platform.requestInsertLink(message.text || '', sender);
            }
            break;

        case 'setPageDir':
            platform.requestSetPageDir();
            break;

        case 'saveOutlinerImage': {
            if (platform.saveOutlinerImage && message.nodeId && message.dataUrl) {
                platform.saveOutlinerImage(message.nodeId, message.dataUrl, message.fileName);
            }
            break;
        }

        // ── Side Panel ──

        case 'openPageInSidePanel': {
            const pagePath = fileManager.getPageFilePath(message.pageId);
            if (fs.existsSync(pagePath)) {
                platform.openPageInSidePanel(pagePath);
                // FR-HP-03: page md を履歴に記録。
                fileManager.recordPageHistory(message.pageId);
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        // FR-HP-05: history の page-md クリック → pageId を現 note で解決して sidepanel で開く。
        case 'openPageFromHistory': {
            const pagePath = fileManager.getPageFilePath(message.pageId);
            if (fs.existsSync(pagePath)) {
                platform.openPageInSidePanel(pagePath);
                // FR-HP-03: sidepanel md も history 最上位へ移動する（note md / .out と同じ挙動）。
                fileManager.recordPageHistory(message.pageId);
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        // FR-HP-06/07: history パネルの開閉状態・高さを永続化。
        case 'notesSaveHistoryPanelCollapsed':
            fileManager.saveHistoryPanelCollapsed(!!message.collapsed);
            break;

        case 'notesSaveHistoryPanelHeight':
            if (typeof message.height === 'number') {
                fileManager.saveHistoryPanelHeight(message.height);
            }
            break;

        case 'saveSidePanelFile': {
            // disk 書込を await してから履歴を再解決する（getHistoryWithFreshTitles は disk を読むため、
            // await しないと page md の新 H1 が disk 反映前に読まれて stale になる = レース）。
            await platform.saveSidePanelFile(message.filePath, message.content);
            // FR-TH-02: sidepanel md（tree item = note md の場合）の先頭 H1 を tree title に反映。
            let needFileListResend = fileManager.syncTitleFromH1(message.filePath, message.content);
            // FR-HP（sidepanel page md の Recent title 反映）: sidepanel で開いた md が
            // page md（basename=pageId が page-md 履歴に存在）なら、その H1 編集を Recent に反映するため
            // history を再送する。syncTitleFromH1 は tree item（items）専用で page-md を拾わないため、
            // これが無いと page md の H1 変更が Recent に永久に反映されない（別ファイルを開いても
            // notesOpenFile を通らない sidepanel-only 操作では再送されない）。
            if (!needFileListResend) {
                const base = path.basename(message.filePath).replace(/\.md$/i, '');
                const hasPageHistory = (fileManager.getHistory() || []).some(
                    (e) => e.kind === 'page-md' && e.id === base);
                if (hasPageHistory) { needFileListResend = true; }
            }
            if (needFileListResend) {
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        // FR-TH-04: outliner の page node text 確定 → 添付 page md の先頭 H1 を text に同期。
        // notes モードは fileManager.getPageFilePath(pageId)（1引数）で解決。
        case 'syncNodeTextToPageH1': {
            if (!message.pageId || typeof message.text !== 'string') break;
            const pagePath = fileManager.getPageFilePath(message.pageId);
            if (pagePath && fs.existsSync(pagePath)) {
                const body = fs.readFileSync(pagePath, 'utf8');
                writeFileIfChanged(pagePath, setFirstH1(body, message.text)); // 冪等・byte skip
            }
            break;
        }

        case 'sidePanelClosed':
            platform.handleSidePanelClosed();
            break;

        case 'sidePanelOpenLink':
            platform.handleSidePanelOpenLink(message.href, message.sidePanelFilePath);
            break;

        case 'sidePanelOpenInTextEditor':
            platform.handleSidePanelOpenInTextEditor?.(message.sidePanelFilePath);
            break;

        case 'sendToChat':
            if (message.sidePanelFilePath && message.startLine != null && message.endLine != null) {
                platform.sendToChatFromSidePanel?.(
                    message.sidePanelFilePath, message.startLine, message.endLine, message.selectedMarkdown || ''
                );
            }
            break;

        case 'getSidePanelImageDir':
            if (message.sidePanelFilePath) {
                platform.sendSidePanelImageDir(message.sidePanelFilePath);
            }
            break;

        case 'pasteWithAssetCopy':
            if (message.sidePanelFilePath && message.markdown && message.sourceContext && platform.pasteWithAssetCopy) {
                platform.pasteWithAssetCopy(message.markdown, message.sourceContext, message.sidePanelFilePath);
            }
            break;

        case 'extractDataUrlsInPastedMd':
            if (message.markdown && platform.extractDataUrlsInPastedMd) {
                platform.extractDataUrlsInPastedMd(message.markdown, message.sidePanelFilePath);
            }
            break;

        case 'insertImage':
            if (message.sidePanelFilePath) {
                platform.requestInsertImage(message.sidePanelFilePath);
            }
            break;

        case 'saveImageAndInsert':
            if (message.sidePanelFilePath && message.dataUrl) {
                platform.saveImageToDir(message.dataUrl, message.fileName, message.sidePanelFilePath);
            }
            break;

        case 'readAndInsertImage':
            if (message.sidePanelFilePath && message.filePath) {
                platform.readAndInsertImage(message.filePath, message.sidePanelFilePath);
            }
            break;

        case 'saveFileAndInsert':
            if (message.sidePanelFilePath && message.dataUrl && platform.saveFileToDir) {
                platform.saveFileToDir(message.dataUrl, message.fileName, message.sidePanelFilePath);
            }
            break;

        case 'readAndInsertFile':
            if (message.sidePanelFilePath && message.filePath && platform.readAndInsertFile) {
                platform.readAndInsertFile(message.filePath, message.sidePanelFilePath);
            }
            break;

        case 'saveDrawioAndInsert':
            if (message.sidePanelFilePath && message.dataUrl && platform.saveDrawioToDir) {
                platform.saveDrawioToDir(message.dataUrl, message.fileName, message.sidePanelFilePath);
            }
            break;

        // ── ADR-008: Notes 内 .md メインペイン editor 用 ──
        case 'notesMdSaveImage':
            if (message.dataUrl && platform.saveMdImageToDir) {
                platform.saveMdImageToDir(message.dataUrl, message.fileName);
            }
            break;

        case 'notesMdReadAndInsertImage':
            if (message.filePath && platform.readAndInsertMdImage) {
                platform.readAndInsertMdImage(message.filePath);
            }
            break;

        case 'notesMdSaveFile':
            if (message.dataUrl && platform.saveMdFileToDir) {
                platform.saveMdFileToDir(message.dataUrl, message.fileName);
            }
            break;

        case 'notesMdReadAndInsertFile':
            if (message.filePath && platform.readAndInsertMdFile) {
                platform.readAndInsertMdFile(message.filePath);
            }
            break;

        // v0.207.86: Notes 内 .md メインペインの cmd+/ → Add Page
        case 'notesMdCreatePageAuto':
            if (platform.notesMdCreatePageAuto) {
                platform.notesMdCreatePageAuto(message.filePath || '');
            }
            break;

        case 'notesMdUpdatePageH1':
            if (platform.notesMdUpdatePageH1) {
                platform.notesMdUpdatePageH1(
                    message.filePath || '',
                    message.relativePath || '',
                    message.h1Text || ''
                );
            }
            break;

        // v0.207.86: Notes 内 .md からのリンククリック route
        case 'notesMdOpenLink':
            if (platform.notesMdOpenLink) {
                platform.notesMdOpenLink(message.filePath || '', message.href || '');
            }
            break;

        case 'notesMdOpenLinkInTab':
            if (platform.notesMdOpenLinkInTab) {
                platform.notesMdOpenLinkInTab(message.filePath || '', message.href || '');
            }
            break;

        // v0.207.88: notes md ヘッダーの「新タブで開く」ボタン
        case 'notesMdOpenSelfInNewTab':
            if (platform.notesMdOpenSelfInNewTab) {
                platform.notesMdOpenSelfInNewTab(message.filePath || '');
            }
            break;

        case 'readAndInsertDrawio':
            if (message.sidePanelFilePath && message.filePath && platform.readAndInsertDrawio) {
                platform.readAndInsertDrawio(message.filePath, message.sidePanelFilePath);
            }
            break;

        case 'notifyUnsupportedDrawioXml':
            if (platform.notifyUnsupportedDrawioXml) {
                platform.notifyUnsupportedDrawioXml(
                    message.droppedPath || '',
                    message.fileName || '',
                    message.sidePanelFilePath || ''
                );
            }
            break;

        case 'requestCreateDrawio':
            if (platform.requestCreateDrawio) {
                platform.requestCreateDrawio(message.sidePanelFilePath || '');
            }
            break;

        case 'createPageAutoForSidePanel':
            if (platform.createPageAutoForSidePanel) {
                platform.createPageAutoForSidePanel(message.sidePanelFilePath || '');
            }
            break;

        case 'sidePanelNavigateBack':
            if (platform.sidePanelNavigateBack) {
                platform.sidePanelNavigateBack(message.sidePanelFilePath || '');
            }
            break;

        case 'sidePanelNavigateForward':
            if (platform.sidePanelNavigateForward) {
                platform.sidePanelNavigateForward(message.sidePanelFilePath || '');
            }
            break;

        // ── Links ──

        case 'openLink':
            if (message.href) {
                if (message.href.startsWith('fractal://')) {
                    if (platform.navigateInAppLink) {
                        platform.navigateInAppLink(message.href);
                    }
                } else {
                    platform.openExternalLink(message.href);
                }
            }
            break;

        case 'openLinkInTab':
            if (message.href) {
                platform.openFileInEditor(message.href);
            }
            break;

        case 'copyImageToClipboard':
            if (message.absPath) {
                platform.copyImageToClipboard?.(message.absPath);
            }
            break;

        case 'openImageInNewTab':
            if (message.absPath) {
                platform.openImageInNewTab?.(message.absPath);
            }
            break;

        // ── Left File Panel Operations ──

        case 'notesOpenFile': {
            fileManager.flushSave();
            let content = fileManager.openFile(message.filePath);
            if (content !== null) {
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(message.filePath);
                }

                const isMd = message.filePath.endsWith('.md');
                // FR-HP-03: 履歴に記録（sendFileListWithStructure が structure ごと送るので、その前に）。
                fileManager.recordFileHistory(message.filePath);
                if (isMd) {
                    sendFileListWithStructure(fileManager, sender, message.filePath);
                    sender.postMessage({
                        type: 'updateData',
                        kind: 'md',
                        markdown: content,
                        filePath: message.filePath,
                        documentBaseUri: platform.getMdDocumentBaseUri?.(message.filePath) || '',
                        fileChangeId: fileManager.getFileChangeId(),
                        outFileKey: fileManager.getCurrentFilePath(),
                    });
                    platform.sendMdDirStatus?.();
                    platform.sendResourceAccessStatus?.(message.filePath, content);
                    platform.mdMainOpened?.(message.filePath);
                    // search hit からの open の場合、markdown pane が rebuild された後に
                    // ヒット箇所へジャンプ + 黄色ハイライト (scrollToText)。
                    // EditorInstance の構築 & DOM レンダリング完了を待つため delay。
                    if (message.searchQuery) {
                        const sq = message.searchQuery;
                        const so = typeof message.searchOccurrence === 'number'
                            ? message.searchOccurrence : 0;
                        setTimeout(() => {
                            sender.postMessage({
                                type: 'scrollToText',
                                text: sq,
                                occurrence: so,
                            });
                        }, 500);
                    }
                } else {
                    platform.mdMainClosed?.();
                    const data = JSON.parse(content);
                    sendFileListWithStructure(fileManager, sender, message.filePath);
                    const isDailyNotes = path.basename(message.filePath) === 'dailynotes.out';
                    sender.postMessage({ type: 'updateData', kind: 'out', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath(), isDailyNotes });
                }
            } else {
                // ファイル読み込み失敗: 元のファイルリストを再送信してUI状態を復元
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        case 'notesCreateFile': {
            fileManager.flushSave();
            const filePath = fileManager.createFile(message.title || 'Untitled', message.parentId || null, message.afterId || null);
            const content = fileManager.openFile(filePath);
            if (content !== null) {
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(filePath);
                }
                const data = JSON.parse(content);
                sendFileListWithStructure(fileManager, sender, filePath);
                sender.postMessage({ type: 'updateData', kind: 'out', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
            }
            break;
        }

        case 'notesCreateMarkdownFile': {
            fileManager.flushSave();
            const filePath = fileManager.createMarkdownFile(message.title || 'Untitled', message.parentId || null, message.afterId || null);
            const content = fileManager.openFile(filePath);
            if (content !== null) {
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(filePath);
                }
                sendFileListWithStructure(fileManager, sender, filePath);
                sender.postMessage({
                    type: 'updateData',
                    kind: 'md',
                    markdown: content,
                    filePath,
                    documentBaseUri: platform.getMdDocumentBaseUri?.(filePath) || '',
                    fileChangeId: fileManager.getFileChangeId(),
                    outFileKey: fileManager.getCurrentFilePath(),
                });
                platform.sendMdDirStatus?.();
                platform.sendResourceAccessStatus?.(filePath, content);
                platform.mdMainOpened?.(filePath);
            }
            break;
        }

        case 'notesDeleteFile': {
            const wasCurrent = fileManager.getCurrentFilePath() === message.filePath;
            await fileManager.deleteFile(message.filePath);
            if (wasCurrent) {
                const firstId = fileManager.findFirstFileId();
                if (firstId) {
                    const fp = fileManager.getFilePathById(firstId);
                    const content = fileManager.openFile(fp);
                    if (content !== null) {
                        if (platform.saveLastOpenedFile) {
                            platform.saveLastOpenedFile(fp);
                        }
                        const isMd = fp.endsWith('.md');
                        sendFileListWithStructure(fileManager, sender, fp);
                        if (isMd) {
                            sender.postMessage({
                                type: 'updateData',
                                kind: 'md',
                                markdown: content,
                                filePath: fp,
                                documentBaseUri: platform.getMdDocumentBaseUri?.(fp) || '',
                                fileChangeId: fileManager.getFileChangeId(),
                                outFileKey: fileManager.getCurrentFilePath(),
                            });
                            platform.sendMdDirStatus?.();
                            platform.sendResourceAccessStatus?.(fp, content);
                            platform.mdMainOpened?.(fp);
                        } else {
                            platform.mdMainClosed?.();
                            const data = JSON.parse(content);
                            sender.postMessage({ type: 'updateData', kind: 'out', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
                        }
                    }
                } else {
                    sendFileListWithStructure(fileManager, sender);
                    sender.postMessage({ type: 'updateData', kind: 'out', data: { title: '', rootIds: [], nodes: {} }, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
                }
            } else {
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        case 'notesRenameTitle': {
            fileManager.renameTitle(message.filePath, message.newTitle);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        // FR-NT-02: note フォルダ全体のタイトルを outline.note に保存し、webview 再描画 +
        // Notes Folder ツリーの表示名を更新する。
        case 'notesSetNoteTitle': {
            fileManager.setNoteTitle(message.title || '');
            sendFileListWithStructure(fileManager, sender);
            platform.refreshNotesFolderTree?.();
            break;
        }

        case 'notesTogglePanel':
            platform.savePanelCollapsed(message.collapsed);
            break;

        case 'notesSetSidePanelWidth':
            if (typeof message.width === 'number' && platform.saveNoteSidePanelWidth) {
                platform.saveNoteSidePanelWidth(message.width);
            }
            break;

        case 'notesSetSidePanelOutlineWidth':
            if (typeof message.width === 'number' && platform.saveNoteSidePanelOutlineWidth) {
                platform.saveNoteSidePanelOutlineWidth(message.width);
            }
            break;

        // ── Folder Operations ──

        case 'notesCreateFolder': {
            fileManager.createFolder(message.title || 'New Folder', message.parentId || null, message.afterId || null);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        case 'notesDeleteFolder': {
            fileManager.deleteFolder(message.folderId);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        case 'notesRenameFolder': {
            fileManager.renameFolder(message.folderId, message.newTitle);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        case 'notesToggleFolder': {
            fileManager.toggleFolderCollapsed(message.folderId);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        case 'notesMoveItem': {
            fileManager.moveItem(message.itemId, message.targetParentId, message.index);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        // v0.207.77 (D&D Feature A): Notes 内 .md を別の .out item にドロップ → 当該 .out のトップに page-node を追加
        case 'notesImportMdIntoOut': {
            if (typeof platform.notesImportMdIntoOut === 'function') {
                await platform.notesImportMdIntoOut(message.mdFileId, message.targetOutId, sender);
            }
            break;
        }

        // v0.207.77 (D&D Feature B): outliner page-node を Notes panel にドロップ → 独立 .md として登録
        case 'notesImportOutPageNodeAsMd': {
            if (typeof platform.notesImportOutPageNodeAsMd === 'function') {
                await platform.notesImportOutPageNodeAsMd(
                    message.payload,
                    message.parentId ?? null,
                    typeof message.index === 'number' ? message.index : 0,
                    sender
                );
            }
            break;
        }

        // node-move-to-other-outliner: outliner node（サブツリー）を別 .out に move
        case 'notesMoveOutNodeSubtreeIntoOut': {
            if (typeof platform.notesMoveOutNodeSubtreeIntoOut === 'function') {
                await platform.notesMoveOutNodeSubtreeIntoOut(
                    message.payload,
                    message.targetOutFilePath,
                    sender
                );
            }
            break;
        }

        // v11: アイテム色設定
        case 'notesToggleFavorite': {
            // v0.207.36: お気に入り toggle (outline.note の favorites array を更新)
            const fileId = String(message.fileId || '');
            if (!fileId) break;
            fileManager.toggleFavorite(fileId);
            sendFileListWithStructure(fileManager, sender);
            break;
        }

        case 'notesSetItemColor': {
            const structure = fileManager.getStructure();
            if (structure && structure.items && structure.items[message.itemId]) {
                const item = structure.items[message.itemId];
                if (message.color === null || message.color === undefined) {
                    // color クリア: delete で undefined 化 (後方互換)
                    delete item.color;
                } else {
                    // v11 セキュリティ: パレット登録済み色名のみ許可
                    const { NOTES_COLOR_PALETTE } = require('./notes-color-palette') as { NOTES_COLOR_PALETTE: Array<{ name: string; hex: string }> };
                    const validNames = NOTES_COLOR_PALETTE.map(c => c.name);
                    if (!validNames.includes(message.color)) {
                        console.warn('[notes-message-handler] Invalid color name rejected:', message.color);
                        return;
                    }
                    item.color = message.color;
                }
                fileManager.saveStructure();
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        // ── Daily Notes ──

        case 'notesOpenDailyNotes': {
            fileManager.flushSave();
            const dailyFilePath = fileManager.ensureDailyNotesFile();
            const dailyContent = fileManager.openFile(dailyFilePath);
            if (dailyContent === null) break;
            fileManager.recordFileHistory(dailyFilePath); // FR-HP-03

            const dailyData = JSON.parse(dailyContent);
            const today = new Date();
            const year = String(today.getFullYear());
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');

            const { dayNodeId, modified } = fileManager.ensureDailyNode(dailyData, year, month, day);
            let dailyDidModify = modified;
            if (dailyDidModify) {
                fileManager.saveCurrentFileImmediate(JSON.stringify(dailyData));
            }

            if (platform.saveLastOpenedFile) {
                platform.saveLastOpenedFile(dailyFilePath);
            }
            sendFileListWithStructure(fileManager, sender, dailyFilePath);
            sender.postMessage({
                type: 'updateData',
                data: dailyData,
                fileChangeId: fileManager.getFileChangeId(),
                outFileKey: fileManager.getCurrentFilePath(),
                scopeToNodeId: dayNodeId,
                isDailyNotes: true,
            });
            break;
        }

        case 'notesNavigateDailyNotes': {
            fileManager.flushSave();
            const navDailyFilePath = fileManager.ensureDailyNotesFile();
            const navContent = fileManager.openFile(navDailyFilePath);
            if (navContent === null) break;
            fileManager.recordFileHistory(navDailyFilePath); // FR-HP-03

            const navData = JSON.parse(navContent);

            // currentDate が送られてきた場合はそこからの相対、なければ今日から
            let baseDate: Date;
            if (message.currentDate) {
                baseDate = new Date(message.currentDate);
            } else {
                baseDate = new Date();
            }
            baseDate.setDate(baseDate.getDate() + (message.dayOffset || 0));

            const navYear = String(baseDate.getFullYear());
            const navMonth = String(baseDate.getMonth() + 1).padStart(2, '0');
            const navDay = String(baseDate.getDate()).padStart(2, '0');

            const navResult = fileManager.ensureDailyNode(navData, navYear, navMonth, navDay);
            let navDidModify = navResult.modified;
            if (navDidModify) {
                fileManager.saveCurrentFileImmediate(JSON.stringify(navData));
            }

            if (platform.saveLastOpenedFile) {
                platform.saveLastOpenedFile(navDailyFilePath);
            }
            sendFileListWithStructure(fileManager, sender, navDailyFilePath);
            sender.postMessage({
                type: 'updateData',
                data: navData,
                fileChangeId: fileManager.getFileChangeId(),
                outFileKey: fileManager.getCurrentFilePath(),
                scopeToNodeId: navResult.dayNodeId,
                isDailyNotes: true,
            });
            break;
        }

        case 'notesNavigateToDate': {
            fileManager.flushSave();
            const navDateFilePath = fileManager.ensureDailyNotesFile();
            const navDateContent = fileManager.openFile(navDateFilePath);
            if (navDateContent === null) break;
            fileManager.recordFileHistory(navDateFilePath); // FR-HP-03

            const navDateData = JSON.parse(navDateContent);
            const targetDate = new Date(message.targetDate);
            const targetYear = String(targetDate.getFullYear());
            const targetMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
            const targetDay = String(targetDate.getDate()).padStart(2, '0');

            const dateResult = fileManager.ensureDailyNode(navDateData, targetYear, targetMonth, targetDay);
            let dateDidModify = dateResult.modified;
            if (dateDidModify) {
                fileManager.saveCurrentFileImmediate(JSON.stringify(navDateData));
            }

            if (platform.saveLastOpenedFile) {
                platform.saveLastOpenedFile(navDateFilePath);
            }
            sendFileListWithStructure(fileManager, sender, navDateFilePath);
            sender.postMessage({
                type: 'updateData',
                data: navDateData,
                fileChangeId: fileManager.getFileChangeId(),
                outFileKey: fileManager.getCurrentFilePath(),
                scopeToNodeId: dateResult.dayNodeId,
                isDailyNotes: true,
            });
            break;
        }

        // ── タスクモード: 完了タスクを Daily Notes へ archive ──
        // メッセージ: { type: 'notesArchiveTasks', subtrees: [{ rootId, nodes: { id: nodeObj, ... } }] }
        // 動作: dailynotes.out を fs 直接書き込み (openFile しないので current view は変わらない)
        // アセット (page MD / 画像 / 添付ファイル) は dailynotes 側の pageDir/fileDir/imageDir に
        // コピーする。MD 内の画像・ファイル参照も copy + 名前 rewrite で追従。
        case 'notesArchiveTasks': {
            try {
                fileManager.flushSave();
                const sourceFilePath = fileManager.getCurrentFilePath();
                const archiveFilePath = fileManager.ensureDailyNotesFile();
                if (!sourceFilePath) break;

                // Source dirs (current file)
                const srcOutDir = path.dirname(sourceFilePath);
                const srcPagesDir = fileManager.getPagesDirPath();
                const srcFileDir = fileManager.getFileDirPath();

                // Read dailynotes.out
                const archiveContent = fs.readFileSync(archiveFilePath, 'utf8');
                const archiveData = JSON.parse(archiveContent);
                if (!archiveData.nodes) archiveData.nodes = {};
                if (!archiveData.rootIds) archiveData.rootIds = [];

                // Dest dirs (dailynotes.out)
                // pageDir / fileDir は archiveData に明示があればそれを尊重、なければ
                // Notes mode 既定 (<basename> / <basename>/files) を archive ファイルの
                // basename を使って resolve する。
                const destOutDir = path.dirname(archiveFilePath);
                const archiveBasename = path.basename(archiveFilePath, '.out');
                const archivePageDirRel = (archiveData.pageDir as string) || `./${archiveBasename}`;
                const destPagesDir = path.isAbsolute(archivePageDirRel)
                    ? archivePageDirRel
                    : path.resolve(destOutDir, archivePageDirRel);
                const archiveFileDirRel = (archiveData.fileDir as string) || `./${archiveBasename}/files`;
                const destFileDir = path.isAbsolute(archiveFileDirRel)
                    ? archiveFileDirRel
                    : path.resolve(destOutDir, archiveFileDirRel);

                const today = new Date();
                const archYear = String(today.getFullYear());
                const archMonth = String(today.getMonth() + 1).padStart(2, '0');
                const archDay = String(today.getDate()).padStart(2, '0');
                const { dayNodeId } = fileManager.ensureDailyNode(archiveData, archYear, archMonth, archDay);

                const dayNode = archiveData.nodes[dayNodeId];
                if (!dayNode) break;
                if (!dayNode.children) dayNode.children = [];

                const subtrees: Array<{ rootId: string; nodes: Record<string, any> }> = message.subtrees || [];
                let archivedCount = 0;
                for (const st of subtrees) {
                    if (!st || !st.nodes || !st.rootId) continue;
                    // 各 node のアセットをコピー + パス rewrite
                    for (const nid in st.nodes) {
                        if (!Object.prototype.hasOwnProperty.call(st.nodes, nid)) continue;
                        const node = st.nodes[nid];
                        try {
                            // page MD (isPage + pageId)
                            if (node.isPage && node.pageId) {
                                const result = handlePageAssets({
                                    srcOutDir, srcPagesDir,
                                    destOutDir, destPagesDir,
                                    pageId: node.pageId,
                                    newPageId: null, // cut セマンティクス: pageId 維持
                                    nodeImages: Array.isArray(node.images) ? node.images : [],
                                    sameDirSkip: true
                                });
                                node.images = result.newNodeImages;
                            }
                            // 非 page node の images[]
                            else if (Array.isArray(node.images) && node.images.length > 0) {
                                const result = handleImageAssets({
                                    srcOutDir, srcPagesDir,
                                    destOutDir, destPagesDir,
                                    renamePrefix: null, // cut: 名前維持
                                    nodeImages: node.images,
                                    sameDirSkip: true
                                });
                                node.images = result.newNodeImages;
                            }
                            // file 添付 (filePath)
                            if (node.filePath) {
                                const result = handleFileAsset({
                                    srcOutDir, srcFileDir,
                                    destOutDir, destFileDir,
                                    filePath: node.filePath,
                                    useCollisionSuffix: false, // cut: 名前維持
                                    sameDirSkip: true
                                });
                                if (result.newFilePath) node.filePath = result.newFilePath;
                            }
                        } catch (assetErr) {
                            // 個別アセット失敗は archive 全体を止めない (元ノード参照のまま継続)
                            console.error('[archive] asset copy failed for node', nid, assetErr);
                        }
                        // dailynotes.out にノード追加
                        if (!archiveData.nodes[nid]) {
                            archiveData.nodes[nid] = node;
                        }
                    }
                    const rootCopy = archiveData.nodes[st.rootId];
                    if (!rootCopy) continue;
                    // #TASK / #DONE タグを末尾追加 (重複しない場合のみ)
                    const existingTags: string[] = Array.isArray(rootCopy.tags) ? rootCopy.tags : [];
                    const tagsToAdd: string[] = [];
                    if (existingTags.indexOf('#TASK') === -1) tagsToAdd.push('#TASK');
                    if (existingTags.indexOf('#DONE') === -1) tagsToAdd.push('#DONE');
                    if (tagsToAdd.length > 0) {
                        rootCopy.text = (rootCopy.text || '') + ' ' + tagsToAdd.join(' ');
                        rootCopy.tags = existingTags.concat(tagsToAdd);
                    }
                    // parent を dayNode に変更 + dayNode の children に追加
                    rootCopy.parentId = dayNodeId;
                    dayNode.children.push(st.rootId);
                    archivedCount++;
                }

                fs.writeFileSync(archiveFilePath, JSON.stringify(archiveData, null, 2), 'utf8');

                if (platform.showInformationMessage) {
                    platform.showInformationMessage(`Archived ${archivedCount} task(s) to Daily Notes`);
                }
            } catch (err) {
                if (platform.showErrorMessage) {
                    platform.showErrorMessage('Archive failed: ' + (err instanceof Error ? err.message : String(err)));
                }
            }
            break;
        }

        case 'showInfoMessage': {
            if (platform.showInformationMessage) {
                platform.showInformationMessage(message.text || '');
            }
            break;
        }

        // ── Panel Width ──

        case 'notesSavePanelWidth': {
            fileManager.savePanelWidth(message.width);
            break;
        }

        // ── S3 Sync ──

        case 'notesS3Sync': {
            if (platform.s3Sync) platform.s3Sync(message.bucketPath);
            break;
        }
        case 'notesS3RemoteDeleteUpload': {
            if (platform.s3RemoteDeleteAndUpload) platform.s3RemoteDeleteAndUpload(message.bucketPath);
            break;
        }
        case 'notesS3LocalDeleteDownload': {
            if (platform.s3LocalDeleteAndDownload) platform.s3LocalDeleteAndDownload(message.bucketPath);
            break;
        }
        case 'notesS3SaveBucketPath': {
            fileManager.saveS3BucketPath(message.bucketPath);
            // FR-OS3-02 / TASK-06: bucket path 変更で outliner toolbar の sync ボタン表示切替を broadcast
            if (platform.postMessage) {
                const visible = !!(message.bucketPath && message.bucketPath.trim());
                platform.postMessage({ type: 'sync-button-visibility', visible });
            }
            break;
        }
        case 'outlinerS3SyncRequest': {
            if (platform.outlinerS3Sync) platform.outlinerS3Sync(message.outlinerId);
            break;
        }
        case 'notesS3GetStatus': {
            if (platform.s3GetStatus) platform.s3GetStatus();
            break;
        }

        // ── Focus (no-op in shared, platforms handle if needed) ──
        case 'webviewFocus':
        case 'webviewBlur':
            break;

        // ── Notes Search ──

        case 'notesSearch': {
            fileManager.flushSave();
            const searchOpts = {
                caseSensitive: message.caseSensitive || false,
                wholeWord: message.wholeWord || false,
                useRegex: message.useRegex || false,
            };
            const searchId = Date.now();

            sender.postMessage({ type: 'notesSearchStart', searchId, query: message.query });

            fileManager.searchFilesStreaming(message.query, searchOpts, (partialResult) => {
                sender.postMessage({
                    type: 'notesSearchPartial',
                    searchId,
                    result: partialResult,
                });
            });

            sender.postMessage({ type: 'notesSearchEnd', searchId });
            break;
        }

        case 'notesJumpToNode': {
            fileManager.flushSave();
            const jumpFilePath = fileManager.getFilePathById(message.fileId);
            const jumpContent = fileManager.openFile(jumpFilePath);
            if (jumpContent !== null) {
                fileManager.recordFileHistory(jumpFilePath); // FR-HP-03（検索から .out へジャンプ）
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(jumpFilePath);
                }
                const jumpData = JSON.parse(jumpContent);
                sendFileListWithStructure(fileManager, sender, jumpFilePath);
                sender.postMessage({
                    type: 'updateData',
                    data: jumpData,
                    fileChangeId: fileManager.getFileChangeId(),
                    outFileKey: fileManager.getCurrentFilePath(),
                    jumpToNodeId: message.nodeId,
                });
            }
            break;
        }

        case 'notesJumpToMdPage': {
            fileManager.flushSave();
            const mdOutFilePath = fileManager.getFilePathById(message.outFileId);
            const mdOutContent = fileManager.openFile(mdOutFilePath);
            if (mdOutContent === null) break;
            // FR-HP-03: 検索から md page を開く経路。ユーザーが見るのは page md（sidepanel）なので
            // .out ではなく page md を履歴に記録する（下の openPageInSidePanel 箇所で recordPageHistory）。

            const mdOutData = JSON.parse(mdOutContent);

            // pageIdからnodeIdを逆引き
            let pageNodeId: string | null = null;
            for (const [nodeId, node] of Object.entries(mdOutData.nodes || {})) {
                if ((node as any).pageId === message.pageId) {
                    pageNodeId = nodeId;
                    break;
                }
            }

            if (platform.saveLastOpenedFile) {
                platform.saveLastOpenedFile(mdOutFilePath);
            }
            sendFileListWithStructure(fileManager, sender, mdOutFilePath);

            // .outをアウトライナに表示し、該当ノードへジャンプ
            sender.postMessage({
                type: 'updateData',
                data: mdOutData,
                fileChangeId: fileManager.getFileChangeId(),
                outFileKey: fileManager.getCurrentFilePath(),
                jumpToNodeId: pageNodeId,
            });

            // サイドパネルでページを開く（lineNumber付き）
            if (pageNodeId) {
                const pagePath = fileManager.getPageFilePath(message.pageId);
                if (platform.openPageInSidePanel) {
                    platform.openPageInSidePanel(pagePath, message.lineNumber, message.query, message.occurrence);
                    fileManager.recordPageHistory(message.pageId); // FR-HP-03/MEDIUM-1（検索から page md を sidepanel で開く）
                }
            }
            break;
        }

        case 'notesOpenMdExternal': {
            if (platform.openFileExternal) {
                platform.openFileExternal(message.filePath);
            }
            break;
        }

        case 'notesNavigateInAppLink': {
            // Node link only — navigate to note + outliner + node
            fileManager.flushSave();
            const navFilePath = fileManager.getFilePathById(message.outFileId);
            if (!navFilePath) break;
            const navContent = fileManager.openFile(navFilePath);
            if (navContent === null) break;
            fileManager.recordFileHistory(navFilePath); // FR-HP-03（アプリ内リンク）

            if (platform.saveLastOpenedFile) {
                platform.saveLastOpenedFile(navFilePath);
            }

            const navData = JSON.parse(navContent);
            sendFileListWithStructure(fileManager, sender, navFilePath);

            sender.postMessage({
                type: 'updateData',
                data: navData,
                fileChangeId: fileManager.getFileChangeId(),
                outFileKey: fileManager.getCurrentFilePath(),
                jumpToNodeId: message.nodeId,
            });
            break;
        }

        // ── Search (legacy) ──
        case 'searchFiles':
            if (platform.searchFiles) {
                platform.searchFiles(message.query);
            }
            break;

        // ── Cleanup (FR-7) ──
        case 'cleanupUnusedFilesAllNotes':
            if (platform.cleanupUnusedFilesAllNotes) {
                await platform.cleanupUnusedFilesAllNotes();
            }
            break;

        case 'cleanupUnusedFilesCurrentNote':
            if (platform.cleanupUnusedFilesCurrentNote) {
                await platform.cleanupUnusedFilesCurrentNote();
            }
            break;

        case 'translateContent': {
            if (platform.getWorkspaceConfig && platform.postMessage) {
                const config = platform.getWorkspaceConfig('fractal');
                const accessKeyId = config.get('transAccessKeyId', '');
                const secretAccessKey = config.get('transSecretAccessKey', '');
                const region = config.get('transRegion', 'us-east-1');
                // v0.207.25: Custom Terminology が設定済なら使う
                const terminologyName = (config.get('translateTerminologyName', '') || '').toString().trim();
                if (!accessKeyId || !secretAccessKey) {
                    sender.postMessage({
                        type: 'translateError',
                        message: 'AWS credentials not configured. Set fractal.transAccessKeyId and transSecretAccessKey in settings.'
                    });
                    break;
                }
                try {
                    const result = await translateText({
                        text: message.markdown,
                        sourceLang: message.sourceLang,
                        targetLang: message.targetLang,
                        accessKeyId,
                        secretAccessKey,
                        region,
                        terminologyName: terminologyName || undefined,
                    });
                    sender.postMessage({
                        type: 'translateResult',
                        translatedMarkdown: result.translatedText,
                        sourceLang: result.sourceLang,
                        targetLang: result.targetLang
                    });
                } catch (err: any) {
                    const errMsg = err?.message || String(err);
                    console.error('[Translate] Error:', errMsg, err?.stack || '');
                    sender.postMessage({
                        type: 'translateError',
                        message: errMsg
                    });
                }
            }
            break;
        }

        case 'translateSelectLang': {
            if (platform.showQuickPick) {
                const sourcePick = await platform.showQuickPick(
                    TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                    'Source language'
                );
                if (!sourcePick) break;
                const targetPick = await platform.showQuickPick(
                    TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                    'Target language'
                );
                if (!targetPick) break;
                sender.postMessage({
                    type: 'translateLangSelected',
                    sourceLang: sourcePick.description,
                    targetLang: targetPick.description
                });
            }
            break;
        }

        case 'saveTranslateLangs': {
            // v0.207.24: popup の select で選んだ言語を settings に永続化
            if (platform.updateWorkspaceConfig) {
                try {
                    await platform.updateWorkspaceConfig('fractal', 'translateSourceLang', message.sourceLang);
                    await platform.updateWorkspaceConfig('fractal', 'translateTargetLang', message.targetLang);
                } catch (err: any) {
                    console.error('[Translate] saveTranslateLangs error:', err);
                }
            }
            break;
        }

        case 'updateTranslateTerminology': {
            // v0.207.25: Tools tab 「翻訳辞書を更新」 button
            if (platform.executeCommand) {
                try {
                    await platform.executeCommand('fractal.updateTranslateTerminology');
                } catch (err: any) {
                    console.error('[Translate] updateTranslateTerminology error:', err);
                }
            }
            break;
        }

        case 'saveTranslationToOutlinerNode': {
            // v0.207.24: 翻訳結果を sidepanel が属する outliner の親 node に子 page として attach
            // platform 側 (notesEditorProvider / outlinerProvider) で実装
            if (platform.saveTranslationToOutlinerNode) {
                try {
                    await platform.saveTranslationToOutlinerNode(
                        message.sidePanelFilePath,
                        message.translatedMarkdown,
                        message.h1Title,
                        message.sourceLang,
                        message.targetLang
                    );
                } catch (err: any) {
                    console.error('[Translate] saveTranslationToOutlinerNode error:', err);
                    sender.postMessage({
                        type: 'translateSaveError',
                        message: err?.message || String(err)
                    });
                }
            }
            break;
        }
    }
}
