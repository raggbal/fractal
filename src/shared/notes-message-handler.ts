import * as fs from 'fs';
import * as path from 'path';
import { NotesFileManager } from './notes-file-manager';
import { importMdFiles } from './markdown-import';
import { OutlinerClipboardStore } from './outliner-clipboard-store';
import { handlePageAssets, handleImageAssets, handleFileAsset, copyImageAssets, moveImageAssets } from './paste-asset-handler';
import { safeResolveUnderDir } from './path-safety';
import { translateText, TRANSLATE_LANGUAGES } from './aws-translate';
import { processDropFilesImport, processDropVscodeUrisImport, DropImportItem } from './drop-import';

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
    /** .md ファイルをエディタで開く (Electron: createWindow, VSCode: vscode.openWith) */
    openFileInEditor(filePath: string): void;
    /** サイドパネルでページを開く (lineNumber指定時はスクロール) */
    openPageInSidePanel(filePath: string, lineNumber?: number, query?: string, occurrence?: number): void;
    /** 画像挿入ダイアログ表示 */
    requestInsertImage(sidePanelFilePath: string): void;
    /** パネル折り畳み状態を永続化 */
    savePanelCollapsed(collapsed: boolean): void;
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
    /** Outlinerノード画像保存 */
    saveOutlinerImage?(nodeId: string, dataUrl: string, fileName: string): void;
    /** .mdファイルインポートダイアログ表示 */
    importMdFilesDialog?(targetNodeId: string | null, sender: NotesSender): void;
    /** 任意ファイルインポートダイアログ表示 */
    importFilesDialog?(targetNodeId: string | null, sender: NotesSender): void;
    /** ファイル添付を開く */
    openAttachedFile?(nodeId: string, outFilePath: string, sender: NotesSender): void;
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
    /** v10: Get workspace config (for translate AWS credentials) */
    getWorkspaceConfig?(section: string): any;
    /** v10: Post message to webview (used in translate handler) */
    postMessage?(message: any): void;
    /** v10: Show quick pick for language selection */
    showQuickPick?(items: Array<{ label: string; description?: string }>, placeHolder: string): Promise<{ label: string; description?: string } | undefined>;
    /** v12: D&D ファイルインポート */
    dropFilesImport?(items: DropImportItem[], targetNodeId: string | null, position: string, sender: NotesSender): void;
    /** v12 拡張: VSCode Explorer D&D */
    dropVscodeUrisImport?(uris: string[], targetNodeId: string | null, position: string, sender: NotesSender): void;
    /** v12: フォルダ D&D 拒否通知 */
    notifyDropFolderRejected?(folders: string[]): void;
    /** v12: ファイルサイズ超過通知 */
    notifyDropFileTooLarge?(fileName: string): void;
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
    const structure = fileManager.getStructure();
    sender.postMessage({
        type: 'notesFileListChanged',
        fileList,
        structure,
        currentFile: currentFile !== undefined ? currentFile : fileManager.getCurrentFilePath(),
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

        case 'syncData':
            // stale sync（ファイル切替前のデータ）を無視
            if (message.fileChangeId !== undefined && message.fileChangeId !== fileManager.getFileChangeId()) {
                break;
            }
            fileManager.saveCurrentFile(message.content);
            break;

        case 'save':
            fileManager.flushSave();
            break;

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

        case 'openAttachedFile': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.openAttachedFile?.(message.nodeId, currentFilePath, sender);
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
            }
            break;
        }

        case 'saveSidePanelFile':
            platform.saveSidePanelFile(message.filePath, message.content);
            break;

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

        // ── Left File Panel Operations ──

        case 'notesOpenFile': {
            fileManager.flushSave();
            let content = fileManager.openFile(message.filePath);
            if (content !== null) {
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(message.filePath);
                }

                const data = JSON.parse(content);
                sendFileListWithStructure(fileManager, sender, message.filePath);
                const isDailyNotes = path.basename(message.filePath) === 'dailynotes.out';
                sender.postMessage({ type: 'updateData', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath(), isDailyNotes });
            } else {
                // ファイル読み込み失敗: 元のファイルリストを再送信してUI状態を復元
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        case 'notesCreateFile': {
            fileManager.flushSave();
            const filePath = fileManager.createFile(message.title || 'Untitled', message.parentId || null);
            const content = fileManager.openFile(filePath);
            if (content !== null) {
                if (platform.saveLastOpenedFile) {
                    platform.saveLastOpenedFile(filePath);
                }
                const data = JSON.parse(content);
                sendFileListWithStructure(fileManager, sender, filePath);
                sender.postMessage({ type: 'updateData', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
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
                        const data = JSON.parse(content);
                        sendFileListWithStructure(fileManager, sender, fp);
                        sender.postMessage({ type: 'updateData', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
                    }
                } else {
                    sendFileListWithStructure(fileManager, sender);
                    sender.postMessage({ type: 'updateData', data: { title: '', rootIds: [], nodes: {} }, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath() });
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

        case 'notesTogglePanel':
            platform.savePanelCollapsed(message.collapsed);
            break;

        // ── Folder Operations ──

        case 'notesCreateFolder': {
            fileManager.createFolder(message.title || 'New Folder', message.parentId || null);
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

        // v11: アイテム色設定
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
                        region
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
    }
}
