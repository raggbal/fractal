import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getOutlinerTableWebviewContent } from './outlinerTableWebviewContent';
import { OutlinerClipboardStore } from './shared/outliner-clipboard-store';
import { safeResolveUnderDir } from './shared/path-safety';

/**
 * OutlinerTableProvider — fractal.outlinerTable view 用 Custom Text Editor Provider
 *
 * Phase A (TASK-A7): customEditors[] 登録 + 最低限の bridge。
 * Phase B (TASK-B2): Outliner cell 操作互換に必要な host bridge handler を追加。
 *
 * Bridge handler:
 *   - syncData / requestReopenAs / ready (Phase A)
 *   - copyPagePaths / openAttachedFile / openLink (page node / file node / link click)
 *   - saveOutlinerClipboard (cmd+x / cmd+c の clipboard 保存)
 *   - openMdPage (cmd+enter で sidepanel に page MD を開く)
 *   - attachFile / imagePaste (D&D / clipboard 由来の attach は Phase B2 では simple stub)
 *   - copyAttachedFilePath
 *
 * design: .harness/sprint/.../design/system.md §4.4
 */
export class OutlinerTableProvider implements vscode.CustomTextEditorProvider {
    private readonly context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                vscode.Uri.joinPath(document.uri, '..')
            ]
        };

        webviewPanel.webview.html = getOutlinerTableWebviewContent(
            webviewPanel.webview,
            this.context.extensionUri
        );

        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg !== 'object') { return; }
            switch (msg.type) {
                case 'ready':
                    webviewPanel.webview.postMessage({
                        type: 'init',
                        data: this.parseOutSafely(document.getText())
                    });
                    break;

                case 'syncData':
                    if (typeof msg.payload === 'string') {
                        await this.applyEditFromWebview(document, msg.payload);
                    } else if (typeof msg.content === 'string') {
                        await this.applyEditFromWebview(document, msg.content);
                    }
                    break;

                case 'save':
                    await document.save();
                    break;

                case 'requestReopenAs':
                    if (msg.viewType && typeof msg.viewType === 'string') {
                        await vscode.commands.executeCommand(
                            'vscode.openWith',
                            document.uri,
                            msg.viewType
                        );
                    }
                    break;

                case 'copyPagePaths': {
                    const pageIds: string[] = msg.pageIds || [];
                    const data = this.parseOutSafely(document.getText()) as { pageDir?: string };
                    const outDir = path.dirname(document.uri.fsPath);
                    const pageDir = data.pageDir
                        ? path.resolve(outDir, data.pageDir)
                        : outDir;
                    const paths = pageIds
                        .map((pid: string) => path.join(pageDir, `${pid}.md`))
                        .filter((p: string) => {
                            try { return fs.existsSync(p); } catch { return false; }
                        });
                    if (paths.length > 0) {
                        await vscode.env.clipboard.writeText(paths.join('\n'));
                    }
                    break;
                }

                case 'openAttachedFile': {
                    const data = this.parseOutSafely(document.getText()) as { nodes?: Record<string, { filePath?: string }> };
                    const node = data.nodes?.[msg.nodeId];
                    if (!node?.filePath) { break; }
                    const outDir = path.dirname(document.uri.fsPath);
                    const safeFilePath = safeResolveUnderDir(outDir, node.filePath);
                    if (!safeFilePath || !fs.existsSync(safeFilePath)) {
                        vscode.window.showErrorMessage('File not found or unsafe path');
                        break;
                    }
                    await vscode.env.openExternal(vscode.Uri.file(safeFilePath));
                    break;
                }

                case 'openLink':
                    if (typeof msg.href === 'string' && /^https?:/i.test(msg.href)) {
                        await vscode.env.openExternal(vscode.Uri.parse(msg.href));
                    }
                    break;

                case 'openMdPage': {
                    // Phase B2: open page in side panel — Phase B では既存 outlinerProvider と
                    // 同じ side panel 機構を使う想定だが、Table editor 単独 mode では未実装。
                    // とりあえず default editor で開く fallback。
                    const payload = msg.payload || {};
                    const pageId = payload.pageId;
                    if (!pageId) { break; }
                    const data = this.parseOutSafely(document.getText()) as { pageDir?: string };
                    const outDir = path.dirname(document.uri.fsPath);
                    const pageDir = data.pageDir
                        ? path.resolve(outDir, data.pageDir)
                        : outDir;
                    const mdPath = path.join(pageDir, `${pageId}.md`);
                    if (fs.existsSync(mdPath)) {
                        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(mdPath));
                    }
                    break;
                }

                case 'saveOutlinerClipboard': {
                    const clipImagesDir = this.getOutlinerImageDirPath(document);
                    const clipFileDir = this.getFileDirPath(document);
                    OutlinerClipboardStore.save({
                        plainText: msg.plainText,
                        isCut: msg.isCut,
                        nodes: msg.nodes,
                        sourcePagesDirPath: this.getPagesDirPath(document),
                        sourceImagesDirPath: clipImagesDir,
                        sourceFileDirPath: clipFileDir,
                        sourceOutDir: path.dirname(document.uri.fsPath)
                    });
                    break;
                }

                case 'attachFile':
                case 'imagePaste':
                    // Phase B2: stub — file attach D&D / image paste は Phase B 後半で
                    // 既存 outlinerProvider と同じ logic (importFiles / saveImageAndInsert)
                    // を delegate する予定。
                    // 現状は呼ばれたことを log するのみ。
                    console.log('[OutlinerTableProvider] message handler stub:', msg.type);
                    break;

                default:
                    break;
            }
        });

        const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                webviewPanel.webview.postMessage({
                    type: 'externalUpdate',
                    data: this.parseOutSafely(e.document.getText())
                });
            }
        });

        webviewPanel.onDidDispose(() => {
            messageSub.dispose();
            changeSub.dispose();
        });
    }

    private parseOutSafely(text: string): unknown {
        try {
            return JSON.parse(text || '{}');
        } catch {
            return { rootIds: [], nodes: {} };
        }
    }

    private async applyEditFromWebview(document: vscode.TextDocument, payload: string): Promise<void> {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(
            document.uri,
            new vscode.Range(0, 0, document.lineCount, 0),
            payload
        );
        await vscode.workspace.applyEdit(edit);
    }

    /** outlinerProvider と同じ pageDir 解決 */
    private getPagesDirPath(document: vscode.TextDocument): string {
        try {
            const data = JSON.parse(document.getText());
            const outDir = path.dirname(document.uri.fsPath);
            return data.pageDir ? path.resolve(outDir, data.pageDir) : outDir;
        } catch {
            return path.dirname(document.uri.fsPath);
        }
    }

    /** outlinerProvider と同じ imageDir 解決 */
    private getOutlinerImageDirPath(document: vscode.TextDocument): string {
        try {
            const data = JSON.parse(document.getText());
            const outDir = path.dirname(document.uri.fsPath);
            return data.imageDir ? path.resolve(outDir, data.imageDir) : outDir;
        } catch {
            return path.dirname(document.uri.fsPath);
        }
    }

    /** outlinerProvider と同じ fileDir 解決 */
    private getFileDirPath(document: vscode.TextDocument): string {
        try {
            const data = JSON.parse(document.getText());
            const outDir = path.dirname(document.uri.fsPath);
            return data.fileDir ? path.resolve(outDir, data.fileDir) : outDir;
        } catch {
            return path.dirname(document.uri.fsPath);
        }
    }
}
