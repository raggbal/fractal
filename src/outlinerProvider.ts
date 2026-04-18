import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getOutlinerWebviewContent } from './outlinerWebviewContent';
import { t, getWebviewMessages, initLocale } from './i18n/messages';
import { SidePanelManager } from './shared/sidePanelManager';
import { importMdFiles } from './shared/markdown-import';
import { importFiles } from './shared/file-import';
import { processDropFilesImport, processDropVscodeUrisImport, DropImportItem, DropImportResult } from './shared/drop-import';
import { OutlinerClipboardStore } from './shared/outliner-clipboard-store';
import { handlePageAssets, handleImageAssets, handleFileAsset, copyImageAssets, moveImageAssets, copyMdPasteAssets } from './shared/paste-asset-handler';
import { safeResolveUnderDir } from './shared/path-safety';
import { translateText, TRANSLATE_LANGUAGES } from './shared/aws-translate';


/**
 * OutlinerProvider — .out ファイル用 Custom Text Editor Provider
 *
 * JSON ベースのアウトライナデータを管理し、
 * ページ機能（pages/{pageId}.md）とサイドパネル連携を提供する。
 */
export class OutlinerProvider implements vscode.CustomTextEditorProvider {
    private readonly context: vscode.ExtensionContext;

    // アクティブな webview パネルを追跡（undo/redo forwarding用）
    private activeWebviewPanel: vscode.WebviewPanel | undefined;

    // outlinerから開いたページファイルの追跡 (key: ファイルパス, value: ページディレクトリパス)
    static outlinerPagePaths: Map<string, string> = new Map();


    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public sendScopeIn(): void {
        this.activeWebviewPanel?.webview.postMessage({ type: 'scopeIn' });
    }

    public sendScopeOut(): void {
        this.activeWebviewPanel?.webview.postMessage({ type: 'scopeOut' });
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // Clear cached webview state
        webviewPanel.webview.html = '';

        const documentDir = vscode.Uri.joinPath(document.uri, '..');
        const outlinerImageDir = vscode.Uri.file(this.getOutlinerImageDirPath(document));

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                documentDir,
                outlinerImageDir
            ]
        };

        this.activeWebviewPanel = webviewPanel;

        const sendTranslateLangFromConfig = () => {
            const cfg = vscode.workspace.getConfiguration('fractal');
            webviewPanel.webview.postMessage({
                type: 'translateLangSelected',
                sourceLang: cfg.get<string>('translateSourceLang', 'en'),
                targetLang: cfg.get<string>('translateTargetLang', 'ja'),
            });
        };

        // --- updateWebview ---
        const updateWebview = () => {
            try {
                const config = vscode.workspace.getConfiguration('fractal');
                const content = document.getText();
                const docBaseUri = webviewPanel.webview.asWebviewUri(documentDir).toString();
                webviewPanel.webview.html = getOutlinerWebviewContent(
                    webviewPanel.webview,
                    this.context.extensionUri,
                    content,
                    {
                        theme: config.get<string>('theme', 'things'),
                        fontSize: config.get<number>('fontSize', 14),
                        toolbarMode: config.get<string>('toolbarMode', 'simple'),
                        webviewMessages: getWebviewMessages() as unknown as Record<string, string>,
                        enableDebugLogging: config.get<boolean>('enableDebugLogging', false),
                        outlinerPageTitle: config.get<boolean>('outlinerPageTitle', true),
                        documentBaseUri: docBaseUri
                    },
                    document.uri.fsPath
                );
                sendTranslateLangFromConfig();
            } catch (error) {
                console.error('[Outliner] Error updating webview:', error);
                webviewPanel.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Error</title></head>
<body style="padding:20px;font-family:sans-serif;">
<h2>Failed to load outliner</h2>
<p>Please try closing and reopening this file.</p>
<details><summary>Error details</summary><pre>${String(error)}</pre></details>
</body></html>`;
            }
        };

        // Initial content
        updateWebview();

        // --- 自己編集フラグ (editorProvider.tsと同じパターン) ---
        let isApplyingOwnEdit = false;

        // --- サイドパネル管理 (SidePanelManager で共通化) ---
        const sidePanel = new SidePanelManager(
            {
                postMessage: (msg: any) => webviewPanel.webview.postMessage(msg),
                asWebviewUri: (uri: vscode.Uri) => webviewPanel.webview.asWebviewUri(uri)
            },
            { logPrefix: '[Outliner]' }
        );

        // 画像ディレクトリ状態送信 (MDファイルからの相対パスで表示 — toMarkdownPath と同じロジック)
        const sendSidePanelImageDirStatus = (spFilePath: string) => {
            const pagesDir = this.getPagesDirPath(document);
            const imagesDir = path.join(pagesDir, 'images');
            const spDir = path.dirname(spFilePath);
            const displayPath = path.relative(spDir, imagesDir).replace(/\\/g, '/') || '.';
            webviewPanel.webview.postMessage({
                type: 'sidePanelImageDirStatus',
                displayPath,
                source: 'default'
            });
        };

        // ファイルディレクトリ状態送信 ({pageDir}/files/ — 画像と同じパターン)
        const sendSidePanelFileDirStatus = (spFilePath: string) => {
            const pagesDir = this.getPagesDirPath(document);
            const filesDir = path.join(pagesDir, 'files');
            const spDir = path.dirname(spFilePath);
            const displayPath = path.relative(spDir, filesDir).replace(/\\/g, '/') || '.';
            webviewPanel.webview.postMessage({
                type: 'sidePanelFileDirStatus',
                displayPath,
                source: 'default'
            });
        };

        // --- メッセージハンドラ ---
        const disposables: vscode.Disposable[] = [];

        disposables.push(
            webviewPanel.webview.onDidReceiveMessage(async (message) => {
                switch (message.type) {
                    case 'syncData':
                        try {
                            isApplyingOwnEdit = true;
                            await this.applyEdit(document, message.content);
                        } finally {
                            isApplyingOwnEdit = false;
                        }
                        break;

                    case 'save':
                        await document.save();
                        break;

                    case 'openInTextEditor':
                        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                        break;

                    case 'copyFilePath':
                        await vscode.env.clipboard.writeText(document.uri.fsPath);
                        break;

                    case 'copyPagePaths': {
                        const pageIds: string[] = message.pageIds || [];
                        const paths = pageIds
                            .map((pid: string) => this.getPageFilePath(document, pid))
                            .filter((p: string) => fs.existsSync(p));
                        if (paths.length > 0) {
                            await vscode.env.clipboard.writeText(paths.join('\n'));
                        }
                        break;
                    }

                    case 'importMdFilesDialog': {
                        const options: vscode.OpenDialogOptions = {
                            canSelectMany: true,
                            canSelectFiles: true,
                            canSelectFolders: false,
                            filters: { 'Markdown': ['md'] },
                            title: 'Import .md files'
                        };
                        const fileUris = await vscode.window.showOpenDialog(options);
                        if (!fileUris || fileUris.length === 0) break;

                        const filePaths = fileUris.map(u => u.fsPath).sort();
                        const pageDir = this.getPagesDirPath(document);
                        const imageDir = path.join(pageDir, 'images');
                        const results = importMdFiles(filePaths, pageDir, imageDir);

                        webviewPanel.webview.postMessage({
                            type: 'importMdFilesResult',
                            results,
                            targetNodeId: message.targetNodeId,
                            position: 'after'
                        });
                        break;
                    }

                    case 'importFilesDialog': {
                        const options: vscode.OpenDialogOptions = {
                            canSelectMany: true,
                            canSelectFiles: true,
                            canSelectFolders: false,
                            title: 'Import files'
                        };
                        const fileUris = await vscode.window.showOpenDialog(options);
                        if (!fileUris || fileUris.length === 0) break;

                        const filePaths = fileUris.map(u => u.fsPath).sort();
                        const fileDir = this.getFileDirPath(document);
                        const outDir = path.dirname(document.uri.fsPath);
                        const results = importFiles(filePaths, fileDir, outDir);

                        webviewPanel.webview.postMessage({
                            type: 'importFilesResult',
                            results,
                            targetNodeId: message.targetNodeId,
                            position: 'after'
                        });
                        break;
                    }

                    case 'dropFilesImport': {
                        const items: DropImportItem[] = message.items;
                        const fileDir = this.getFileDirPath(document);
                        const pageDir = this.getPagesDirPath(document);
                        const imageDir = this.getOutlinerImageDirPath(document);
                        const outDir = path.dirname(document.uri.fsPath);

                        const results = await processDropFilesImport(items, {
                            fileDir,
                            pageDir,
                            imageDir,
                            outDir,
                            getDisplayUri: (filePath: string) => webviewPanel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString()
                        });

                        const failed = results.filter((r: DropImportResult) => !r.ok);
                        if (failed.length > 0) {
                            vscode.window.showWarningMessage(t('dropImportFailed'));
                        }

                        webviewPanel.webview.postMessage({
                            type: 'dropFilesResult',
                            results,
                            targetNodeId: message.targetNodeId,
                            position: message.position
                        });
                        break;
                    }

                    case 'dropVscodeUrisImport': {
                        // v12 拡張: VSCode Explorer D&D
                        const uris: string[] = message.uris;
                        const fileDir = this.getFileDirPath(document);
                        const pageDir = this.getPagesDirPath(document);
                        const imageDir = this.getOutlinerImageDirPath(document);
                        const outDir = path.dirname(document.uri.fsPath);

                        const results = await processDropVscodeUrisImport(uris, {
                            fileDir,
                            pageDir,
                            imageDir,
                            outDir,
                            getDisplayUri: (filePath: string) =>
                                webviewPanel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString()
                        });

                        const failed = results.filter((r): r is Extract<DropImportResult, { ok: false }> => !r.ok);
                        if (failed.length > 0) {
                            const names = failed.map(f => f.name).slice(0, 3).join(', ');
                            vscode.window.showWarningMessage(`${t('dropImportFailed')}: ${names}${failed.length > 3 ? '...' : ''}`);
                        }

                        // Use same dropFilesResult message format for webview reuse
                        webviewPanel.webview.postMessage({
                            type: 'dropFilesResult',
                            results,
                            targetNodeId: message.targetNodeId,
                            position: message.position
                        });
                        break;
                    }

                    case 'notifyDropFolderRejected': {
                        vscode.window.showWarningMessage(t('dropFolderRejected'));
                        break;
                    }

                    case 'notifyDropFileTooLarge': {
                        // Note: t() doesn't support interpolation, keeping plain string with filename
                        vscode.window.showWarningMessage(`${t('dropFileTooLarge')}: ${message.fileName}`);
                        break;
                    }

                    case 'openAttachedFile': {
                        const data = JSON.parse(document.getText());
                        const node = data.nodes?.[message.nodeId];
                        if (!node?.filePath) break;

                        const outDir = path.dirname(document.uri.fsPath);
                        const safeFilePath = safeResolveUnderDir(outDir, node.filePath);
                        if (!safeFilePath) {
                            vscode.window.showErrorMessage(t('fileNotFoundOrUnsafe'));
                            break;
                        }

                        if (!fs.existsSync(safeFilePath)) {
                            vscode.window.showErrorMessage(t('fileNotFound'));
                            break;
                        }

                        // Use openExternal to open with OS default app
                        await vscode.env.openExternal(vscode.Uri.file(safeFilePath));
                        break;
                    }

                    case 'makePage':
                        await this.handleMakePage(document, webviewPanel, message);
                        break;

                    case 'removePage':
                        await this.handleRemovePage(document, sidePanel, message);
                        break;

                    case 'openPage':
                        await this.handleOpenPage(document, webviewPanel, message);
                        break;

                    case 'saveOutlinerClipboard': {
                        const clipPagesDir = this.getPagesDirPath(document);
                        const clipImagesDir = this.getOutlinerImageDirPath(document);
                        const clipFileDir = this.getFileDirPath(document);
                        OutlinerClipboardStore.save({
                            plainText: message.plainText,
                            isCut: message.isCut,
                            nodes: message.nodes,
                            sourcePagesDirPath: clipPagesDir,
                            sourceImagesDirPath: clipImagesDir,
                            sourceFileDirPath: clipFileDir,
                            sourceOutDir: path.dirname(document.uri.fsPath)
                        });
                        break;
                    }

                    case 'handlePageAssetsCross': {
                        const clipData = OutlinerClipboardStore.get(message.clipboardPlainText);
                        if (clipData) {
                            await this.ensurePagesDir(document);
                            const result = handlePageAssets({
                                srcOutDir: clipData.sourceOutDir,
                                srcPagesDir: clipData.sourcePagesDirPath,
                                destOutDir: path.dirname(document.uri.fsPath),
                                destPagesDir: this.getPagesDirPath(document),
                                pageId: message.pageId,
                                newPageId: message.newPageId,
                                nodeImages: message.nodeImages || [],
                                sameDirSkip: message.isCut
                            });
                            webviewPanel.webview.postMessage({
                                type: 'updateNodeImages',
                                nodeId: message.targetNodeId,
                                newImages: result.newNodeImages
                            });
                            if (message.isCut) {
                                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
                            }
                        }
                        break;
                    }

                    case 'copyImagesCross': {
                        const imgClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
                        if (imgClipData && message.images) {
                            await this.ensurePagesDir(document);
                            const result = message.isCut
                                ? moveImageAssets({
                                    srcOutDir: imgClipData.sourceOutDir,
                                    srcPagesDir: imgClipData.sourcePagesDirPath,
                                    destOutDir: path.dirname(document.uri.fsPath),
                                    destPagesDir: this.getPagesDirPath(document),
                                    nodeImages: message.images
                                })
                                : copyImageAssets({
                                    srcOutDir: imgClipData.sourceOutDir,
                                    srcPagesDir: imgClipData.sourcePagesDirPath,
                                    destOutDir: path.dirname(document.uri.fsPath),
                                    destPagesDir: this.getPagesDirPath(document),
                                    newNodeId: message.targetNodeId,
                                    nodeImages: message.images
                                });
                            webviewPanel.webview.postMessage({
                                type: 'updateNodeImages',
                                nodeId: message.targetNodeId,
                                newImages: result.newNodeImages
                            });
                            if (message.isCut) {
                                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
                            }
                        }
                        break;
                    }

                    case 'handleFileAssetCross': {
                        const fileClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
                        if (fileClipData && message.filePath) {
                            const result = handleFileAsset({
                                srcOutDir: fileClipData.sourceOutDir,
                                srcFileDir: fileClipData.sourceFileDirPath || path.join(fileClipData.sourceOutDir, 'files'),
                                destOutDir: path.dirname(document.uri.fsPath),
                                destFileDir: this.getFileDirPath(document),
                                filePath: message.filePath,
                                useCollisionSuffix: !message.isCut,
                                sameDirSkip: message.isCut
                            });
                            webviewPanel.webview.postMessage({
                                type: 'updateNodeFilePath',
                                nodeId: message.nodeId,
                                newFilePath: result.newFilePath
                            });
                            if (message.isCut) {
                                OutlinerClipboardStore.consumeIfCut(message.clipboardPlainText);
                            }
                        }
                        break;
                    }

                    case 'insertLink': {
                        const linkUrl = await vscode.window.showInputBox({
                            prompt: t('enterUrl'),
                            placeHolder: 'https://example.com'
                        });
                        if (linkUrl) {
                            const linkText = message.text || await vscode.window.showInputBox({
                                prompt: t('enterLinkText'),
                                placeHolder: 'Link text',
                                value: 'link'
                            }) || 'link';
                            webviewPanel.webview.postMessage({
                                type: 'insertLinkHtml',
                                url: linkUrl,
                                text: linkText
                            });
                        }
                        break;
                    }

                    case 'openLink':
                        if (message.href) {
                            if (message.href.startsWith('fractal://')) {
                                vscode.commands.executeCommand('fractal.navigateInAppLink', message.href);
                            } else {
                                vscode.env.openExternal(vscode.Uri.parse(message.href));
                            }
                        }
                        break;

                    case 'setPageDir': {
                        const currentDir = this.getPagesDirPath(document);
                        const relCurrent = path.relative(path.dirname(document.uri.fsPath), currentDir);
                        const input = await vscode.window.showInputBox({
                            prompt: 'Enter page directory (relative to .out file or absolute)',
                            value: relCurrent || './pages'
                        });
                        if (input !== undefined) {
                            try {
                                const data = JSON.parse(document.getText());
                                data.pageDir = input || undefined;
                                const jsonStr = JSON.stringify(data, null, 2);
                                isApplyingOwnEdit = true;
                                await this.applyEdit(document, jsonStr);
                                isApplyingOwnEdit = false;
                                webviewPanel.webview.postMessage({
                                    type: 'pageDirChanged',
                                    pageDir: input
                                });
                            } catch {
                                vscode.window.showErrorMessage('Failed to update page directory setting');
                            }
                        }
                        break;
                    }

                    // --- サイドパネル関連メッセージ ---

                    case 'openPageInSidePanel': {
                        const filePath = this.getPageFilePath(document, message.pageId);
                        if (!fs.existsSync(filePath)) {
                            vscode.window.showWarningMessage(`Page file not found: ${filePath}`);
                            break;
                        }
                        await sidePanel.openFile(filePath);
                        break;
                    }

                    case 'saveSidePanelFile':
                        await sidePanel.handleSave(message.filePath, message.content);
                        break;

                    case 'sidePanelClosed':
                        sidePanel.handleClose();
                        break;

                    case 'sidePanelOpenLink':
                        await sidePanel.handleOpenLink(message.href, message.sidePanelFilePath);
                        break;

                    case 'sidePanelOpenInTextEditor':
                        if (message.sidePanelFilePath) {
                            const spTextUri = vscode.Uri.file(message.sidePanelFilePath);
                            await vscode.commands.executeCommand('vscode.openWith', spTextUri, 'default');
                        }
                        break;

                    case 'sendToChat': {
                        const spFilePath = message.sidePanelFilePath as string;
                        if (spFilePath && message.startLine != null && message.endLine != null) {
                            try {
                                await sidePanel.handleSendToChat(
                                    spFilePath, message.startLine, message.endLine, message.selectedMarkdown || ''
                                );
                            } catch (err) {
                                console.error('[Outliner] sendToChat error:', err);
                            }
                        }
                        break;
                    }

                    case 'openLinkInTab': {
                        const uri = vscode.Uri.file(message.href);
                        vscode.commands.executeCommand('vscode.openWith', uri, 'fractal.editor');
                        break;
                    }

                    case 'getSidePanelImageDir':
                        if (message.sidePanelFilePath) {
                            sendSidePanelImageDirStatus(message.sidePanelFilePath);
                            sendSidePanelFileDirStatus(message.sidePanelFilePath);
                            // v9: Send absolute paths for MD paste asset copy
                            const pagesDir = this.getPagesDirPath(document);
                            webviewPanel.webview.postMessage({
                                type: 'sidePanelAssetContext',
                                imageDir: path.join(pagesDir, 'images'),
                                fileDir: path.join(pagesDir, 'files'),
                                mdDir: pagesDir
                            });
                        }
                        break;

                    case 'pasteWithAssetCopy': {
                        // v9: MD paste with asset copy (cross-outliner/cross-note paste)
                        if (message.sidePanelFilePath && message.markdown && message.sourceContext) {
                            const pagesDir = this.getPagesDirPath(document);
                            const destImageDir = path.join(pagesDir, 'images');
                            const destFileDir = path.join(pagesDir, 'files');
                            const destMdDir = path.dirname(message.sidePanelFilePath);

                            const result = copyMdPasteAssets({
                                markdown: message.markdown,
                                sourceMdDir: message.sourceContext.mdDir,
                                sourceImageDir: message.sourceContext.imageDir,
                                sourceFileDir: message.sourceContext.fileDir,
                                destImageDir,
                                destFileDir,
                                destMdDir
                            });

                            webviewPanel.webview.postMessage({
                                type: 'pasteWithAssetCopyResult',
                                markdown: result.rewrittenMarkdown
                            });
                        }
                        break;
                    }

                    case 'insertImage': {
                        // 画像挿入 (サイドパネル用)
                        if (message.sidePanelFilePath) {
                            const pagesDir = this.getPagesDirPath(document);
                            const imagesDir = path.join(pagesDir, 'images');
                            if (!fs.existsSync(imagesDir)) {
                                fs.mkdirSync(imagesDir, { recursive: true });
                            }
                            const options: vscode.OpenDialogOptions = {
                                canSelectMany: false,
                                filters: { 'Images': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'] }
                            };
                            const fileUris = await vscode.window.showOpenDialog(options);
                            if (fileUris && fileUris[0]) {
                                const srcPath = fileUris[0].fsPath;
                                const imgFileName = path.basename(srcPath);
                                const destPath = path.join(imagesDir, imgFileName);
                                fs.copyFileSync(srcPath, destPath);
                                const spDir = path.dirname(message.sidePanelFilePath);
                                const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                                const displayUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                                webviewPanel.webview.postMessage({
                                    type: 'insertImageHtml',
                                    markdownPath: relPath,
                                    displayUri: displayUri
                                });
                            }
                        }
                        break;
                    }

                    case 'saveImageAndInsert': {
                        // ペースト/ドロップ画像の保存 (サイドパネル用)
                        if (message.sidePanelFilePath && message.dataUrl) {
                            const pagesDir = this.getPagesDirPath(document);
                            const imagesDir = path.join(pagesDir, 'images');
                            if (!fs.existsSync(imagesDir)) {
                                fs.mkdirSync(imagesDir, { recursive: true });
                            }
                            // Generate filename: use provided name or auto-generate from dataUrl
                            let imgFileName = message.fileName;
                            if (!imgFileName) {
                                const extMatch = message.dataUrl.match(/^data:image\/(\w+);/);
                                const ext = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'png';
                                imgFileName = `image_${Date.now()}.${ext}`;
                            }
                            const base64Data = message.dataUrl.replace(/^data:image\/\w+;base64,/, '');
                            const destPath = path.join(imagesDir, imgFileName);
                            fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
                            const spDir = path.dirname(message.sidePanelFilePath);
                            const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                            const displayUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                            webviewPanel.webview.postMessage({
                                type: 'insertImageHtml',
                                markdownPath: relPath,
                                displayUri: displayUri,
                                dataUri: message.dataUrl
                            });
                        }
                        break;
                    }

                    case 'readAndInsertImage': {
                        // ドロップされたローカルファイル画像の読み取り+挿入
                        if (message.sidePanelFilePath && message.filePath) {
                            const pagesDir = this.getPagesDirPath(document);
                            const imagesDir = path.join(pagesDir, 'images');
                            if (!fs.existsSync(imagesDir)) {
                                fs.mkdirSync(imagesDir, { recursive: true });
                            }
                            const srcPath = message.filePath;
                            const imgFileName = path.basename(srcPath);
                            const destPath = path.join(imagesDir, imgFileName);
                            try {
                                fs.copyFileSync(srcPath, destPath);
                                const spDir = path.dirname(message.sidePanelFilePath);
                                const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                                const displayUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();
                                webviewPanel.webview.postMessage({
                                    type: 'insertImageHtml',
                                    markdownPath: relPath,
                                    displayUri: displayUri
                                });
                            } catch (e) {
                                console.error('[Outliner] readAndInsertImage error:', e);
                            }
                        }
                        break;
                    }

                    case 'saveFileAndInsert': {
                        // ペースト/ドロップファイルの保存 (サイドパネル用: {pageDir}/files/ に保存)
                        if (message.sidePanelFilePath && message.dataUrl) {
                            const pagesDir = this.getPagesDirPath(document);
                            const filesDir = path.join(pagesDir, 'files');
                            if (!fs.existsSync(filesDir)) {
                                fs.mkdirSync(filesDir, { recursive: true });
                            }
                            const originalName = message.fileName || `file_${Date.now()}`;
                            // Collision suffix
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
                            const base64Data = message.dataUrl.replace(/^data:[^;]+;base64,/, '');
                            fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));
                            const spDir = path.dirname(message.sidePanelFilePath);
                            const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                            webviewPanel.webview.postMessage({
                                type: 'insertFileLink',
                                markdownPath: relPath,
                                fileName: destFileName
                            });
                        }
                        break;
                    }

                    case 'readAndInsertFile': {
                        // ドロップされたローカルファイルの読み取り+挿入 (サイドパネル用: {pageDir}/files/)
                        if (message.sidePanelFilePath && message.filePath) {
                            const pagesDir = this.getPagesDirPath(document);
                            const filesDir = path.join(pagesDir, 'files');
                            if (!fs.existsSync(filesDir)) {
                                fs.mkdirSync(filesDir, { recursive: true });
                            }
                            const srcPath = message.filePath;
                            const originalName = path.basename(srcPath);
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
                                fs.copyFileSync(srcPath, destPath);
                                const spDir = path.dirname(message.sidePanelFilePath);
                                const relPath = path.relative(spDir, destPath).replace(/\\/g, '/');
                                webviewPanel.webview.postMessage({
                                    type: 'insertFileLink',
                                    markdownPath: relPath,
                                    fileName: destFileName
                                });
                            } catch (e) {
                                console.error('[Outliner] readAndInsertFile error:', e);
                            }
                        }
                        break;
                    }

                    case 'setImageDir':
                        // outlinerページでは画像ディレクトリ変更不可 (要件PC-2)
                        break;

                    case 'saveOutlinerImage': {
                        // Outlinerノード用画像保存
                        if (message.nodeId && message.dataUrl) {
                            const imageDir = this.getOutlinerImageDirPath(document);
                            if (!fs.existsSync(imageDir)) {
                                fs.mkdirSync(imageDir, { recursive: true });
                            }
                            let imgFileName = message.fileName;
                            if (!imgFileName) {
                                const extMatch = message.dataUrl.match(/^data:image\/(\w+);/);
                                const ext = extMatch ? extMatch[1].replace('jpeg', 'jpg') : 'png';
                                imgFileName = `image_${Date.now()}.${ext}`;
                            }
                            const base64Data = message.dataUrl.replace(/^data:image\/\w+;base64,/, '');
                            const destPath = path.join(imageDir, imgFileName);
                            fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));

                            const outDir = path.dirname(document.uri.fsPath);
                            const relativePath = path.relative(outDir, destPath).replace(/\\/g, '/');
                            const displayUri = webviewPanel.webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

                            webviewPanel.webview.postMessage({
                                type: 'outlinerImageSaved',
                                nodeId: message.nodeId,
                                imagePath: relativePath,
                                displayUri: displayUri
                            });
                        }
                        break;
                    }

                    case 'setOutlinerImageDir': {
                        const currentImgDir = this.getOutlinerImageDirPath(document);
                        const outDir = path.dirname(document.uri.fsPath);
                        const relCurrent = path.relative(outDir, currentImgDir).replace(/\\/g, '/') || './images';
                        const input = await vscode.window.showInputBox({
                            prompt: 'Image directory path (relative to .out file or absolute)',
                            value: relCurrent
                        });
                        if (input !== undefined) {
                            webviewPanel.webview.postMessage({
                                type: 'outlinerImageDirChanged',
                                imageDir: input,
                                displayPath: input || './images',
                                source: 'file'
                            });
                        }
                        break;
                    }

                    case 'setOutlinerFileDir': {
                        const currentFileDir = this.getFileDirPath(document);
                        const outDirF = path.dirname(document.uri.fsPath);
                        const relCurrentF = path.relative(outDirF, currentFileDir).replace(/\\/g, '/') || './files';
                        const inputF = await vscode.window.showInputBox({
                            prompt: 'File directory path (relative to .out file or absolute)',
                            value: relCurrentF
                        });
                        if (inputF !== undefined) {
                            webviewPanel.webview.postMessage({
                                type: 'outlinerFileDirChanged',
                                fileDir: inputF,
                                displayPath: inputF || './files',
                                source: 'file'
                            });
                        }
                        break;
                    }

                    case 'getOutlinerImageDir': {
                        const imgDir = this.getOutlinerImageDirPath(document);
                        const outDir2 = path.dirname(document.uri.fsPath);
                        const displayPath = path.relative(outDir2, imgDir).replace(/\\/g, '/') || '.';
                        webviewPanel.webview.postMessage({
                            type: 'outlinerImageDirStatus',
                            displayPath: displayPath,
                            source: 'settings'
                        });
                        break;
                    }

                    case 'translateContent': {
                        const config = vscode.workspace.getConfiguration('fractal');
                        const accessKeyId = config.get<string>('transAccessKeyId', '');
                        const secretAccessKey = config.get<string>('transSecretAccessKey', '');
                        const region = config.get<string>('transRegion', 'us-east-1');
                        if (!accessKeyId || !secretAccessKey) {
                            webviewPanel.webview.postMessage({
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
                            webviewPanel.webview.postMessage({
                                type: 'translateResult',
                                translatedMarkdown: result.translatedText,
                                sourceLang: result.sourceLang,
                                targetLang: result.targetLang
                            });
                        } catch (err: any) {
                            const errMsg = err?.message || String(err);
                            const errStack = err?.stack || '';
                            console.error('[Translate] Error:', errMsg, errStack);
                            vscode.window.showErrorMessage(`Translate failed: ${errMsg}`);
                            webviewPanel.webview.postMessage({
                                type: 'translateError',
                                message: errMsg
                            });
                        }
                        break;
                    }

                    case 'translateSelectLang': {
                        const sourcePick = await vscode.window.showQuickPick(
                            TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                            { placeHolder: 'Source language' }
                        );
                        if (!sourcePick) break;
                        const targetPick = await vscode.window.showQuickPick(
                            TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                            { placeHolder: 'Target language' }
                        );
                        if (!targetPick) break;
                        webviewPanel.webview.postMessage({
                            type: 'translateLangSelected',
                            sourceLang: sourcePick.description,
                            targetLang: targetPick.description
                        });
                        break;
                    }
                }
            })
        );

        // --- 外部変更検知 ---
        disposables.push(
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() === document.uri.toString()) {
                    if (e.contentChanges.length === 0) return;
                    // 自己編集はスキップ (webviewに既に反映済み)
                    if (isApplyingOwnEdit) return;
                    // 外部変更時にwebviewを更新
                    if (e.contentChanges.length > 0) {
                        try {
                            const data = JSON.parse(document.getText());
                            webviewPanel.webview.postMessage({
                                type: 'updateData',
                                data: data,
                                outFileKey: document.uri.fsPath
                            });
                        } catch {
                            // JSON パースエラーは無視
                        }
                    }
                }
            })
        );

        // --- FileSystemWatcher（外部プロセスからの変更検知） ---
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
                vscode.Uri.joinPath(document.uri, '..'),
                path.basename(document.uri.fsPath)
            )
        );
        const fileChangeSubscription = fileWatcher.onDidChange(async (uri) => {
            if (uri.toString() === document.uri.toString()) {
                setTimeout(async () => {
                    try {
                        const fileContent = await vscode.workspace.fs.readFile(uri);
                        const newContent = new TextDecoder().decode(fileContent);
                        const currentContent = document.getText();

                        if (newContent !== currentContent) {
                            isApplyingOwnEdit = true;
                            const fullRange = new vscode.Range(
                                document.positionAt(0),
                                document.positionAt(currentContent.length)
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, fullRange, newContent);
                            await vscode.workspace.applyEdit(edit);
                            isApplyingOwnEdit = false;

                            await document.save();

                            try {
                                const data = JSON.parse(newContent);
                                webviewPanel.webview.postMessage({
                                    type: 'updateData',
                                    data: data,
                                    outFileKey: document.uri.fsPath
                                });
                            } catch { /* JSON parse error ignored */ }
                        }
                    } catch (error) {
                        isApplyingOwnEdit = false;
                        console.error('[Outliner] Error reading file after external change:', error);
                    }
                }, 100);
            }
        });
        disposables.push(fileWatcher);
        disposables.push(fileChangeSubscription);

        // --- 設定変更 ---
        disposables.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('fractal.language')) {
                    const langConfig = vscode.workspace.getConfiguration('fractal');
                    initLocale(langConfig.get<string>('language', 'default'), vscode.env.language);
                }
                if (e.affectsConfiguration('fractal.theme') ||
                    e.affectsConfiguration('fractal.fontSize') ||
                    e.affectsConfiguration('fractal.outlinerPageTitle') ||
                    e.affectsConfiguration('fractal.language')) {
                    updateWebview();
                }
                if (
                    e.affectsConfiguration('fractal.translateSourceLang') ||
                    e.affectsConfiguration('fractal.translateTargetLang')
                ) {
                    sendTranslateLangFromConfig();
                }
            })
        );

        // --- Cleanup ---
        webviewPanel.onDidDispose(() => {
            if (this.activeWebviewPanel === webviewPanel) {
                this.activeWebviewPanel = undefined;
            }
            sidePanel.disposeFileWatcher();
            disposables.forEach(d => d.dispose());
        });

        // Track active panel
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activeWebviewPanel = webviewPanel;
            }
        });
    }

    // --- Edit 適用 ---

    private async applyEdit(document: vscode.TextDocument, jsonString: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            jsonString
        );
        await vscode.workspace.applyEdit(edit);
    }

    // --- ページ管理 ---

    private getOutlinerImageDirPath(document: vscode.TextDocument): string {
        // 1. out JSON内のimageDirフィールドを優先
        try {
            const data = JSON.parse(document.getText());
            if (data.imageDir) {
                if (path.isAbsolute(data.imageDir)) {
                    return data.imageDir;
                }
                return path.resolve(path.dirname(document.uri.fsPath), data.imageDir);
            }
        } catch { /* ignore parse errors */ }

        // 2. VSCode設定
        const config = vscode.workspace.getConfiguration('fractal');
        const configDir = config.get<string>('outlinerImageDefaultDir', './images');
        if (!configDir) {
            return path.dirname(document.uri.fsPath);
        }
        if (path.isAbsolute(configDir)) {
            return configDir;
        }
        return path.resolve(path.dirname(document.uri.fsPath), configDir);
    }

    private getPagesDirPath(document: vscode.TextDocument): string {
        // 1. out JSON内のpageDirフィールドを優先
        try {
            const data = JSON.parse(document.getText());
            if (data.pageDir) {
                if (path.isAbsolute(data.pageDir)) {
                    return data.pageDir;
                }
                return path.resolve(path.dirname(document.uri.fsPath), data.pageDir);
            }
        } catch { /* ignore parse errors */ }

        // 2. VSCode設定
        const config = vscode.workspace.getConfiguration('fractal');
        const configDir = config.get<string>('outlinerPageDir', './pages');
        if (path.isAbsolute(configDir)) {
            return configDir;
        }
        return path.resolve(path.dirname(document.uri.fsPath), configDir);
    }

    private getFileDirPath(document: vscode.TextDocument): string {
        // 1. out JSON内のfileDirフィールドを優先
        try {
            const data = JSON.parse(document.getText());
            if (data.fileDir) {
                if (path.isAbsolute(data.fileDir)) {
                    return data.fileDir;
                }
                return path.resolve(path.dirname(document.uri.fsPath), data.fileDir);
            }
        } catch { /* ignore parse errors */ }

        // 2. VSCode設定
        const config = vscode.workspace.getConfiguration('fractal');
        const configDir = config.get<string>('outlinerFileDir', './files');
        if (path.isAbsolute(configDir)) {
            return configDir;
        }
        return path.resolve(path.dirname(document.uri.fsPath), configDir);
    }

    private getPageFilePath(document: vscode.TextDocument, pageId: string): string {
        return path.join(this.getPagesDirPath(document), `${pageId}.md`);
    }

    private async ensurePagesDir(document: vscode.TextDocument): Promise<void> {
        const pagesDir = this.getPagesDirPath(document);
        if (!fs.existsSync(pagesDir)) {
            fs.mkdirSync(pagesDir, { recursive: true });
        }
    }

    private async handleMakePage(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        message: { nodeId: string; pageId: string; title: string }
    ): Promise<void> {
        await this.ensurePagesDir(document);

        const filePath = this.getPageFilePath(document, message.pageId);
        const title = message.title || 'Untitled';
        const initialContent = `# ${title}\n\n`;

        fs.writeFileSync(filePath, initialContent, 'utf-8');

        webviewPanel.webview.postMessage({
            type: 'pageCreated',
            nodeId: message.nodeId,
            pageId: message.pageId
        });
    }

    private async handleRemovePage(
        document: vscode.TextDocument,
        sidePanel: SidePanelManager,
        message: { nodeId: string; pageId: string }
    ): Promise<void> {
        if (!message.pageId) { return; }
        const filePath = this.getPageFilePath(document, message.pageId);
        if (!fs.existsSync(filePath)) { return; }

        // サイドパネルで開いている場合は先に閉じる
        if (sidePanel.watchedPath === filePath) {
            sidePanel.handleClose();
        }

        // .md ファイルは削除しない (オーファンとして残す)
        // → cleanup コマンドで掃除する
    }

    private async handleOpenPage(
        document: vscode.TextDocument,
        _webviewPanel: vscode.WebviewPanel,
        message: { nodeId: string; pageId: string }
    ): Promise<void> {
        const filePath = this.getPageFilePath(document, message.pageId);

        if (!fs.existsSync(filePath)) {
            vscode.window.showWarningMessage(`Page file not found: ${filePath}`);
            return;
        }

        // outlinerページとして登録 (editorProviderで制約適用のため)
        const pagesDir = this.getPagesDirPath(document);
        OutlinerProvider.outlinerPagePaths.set(filePath, pagesDir);

        // fractal エディタでサイドに開く
        const fileUri = vscode.Uri.file(filePath);
        await vscode.commands.executeCommand(
            'vscode.openWith',
            fileUri,
            'fractal.editor',
            vscode.ViewColumn.Beside
        );
    }

}
