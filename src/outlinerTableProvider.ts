import * as vscode from 'vscode';
import { getOutlinerTableWebviewContent } from './outlinerTableWebviewContent';

/**
 * OutlinerTableProvider — fractal.outlinerTable view 用 Custom Text Editor Provider (stub)
 *
 * TASK-A7 (Phase A 完了): customEditors[] 登録 + 最低限の bridge。
 * 本実装 (列定義 load / save / cell render 等) は Phase B (TASK-B1〜B9) で実装する。
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

        // Phase A stub: minimum bridge for activation 確認のみ。
        // Phase B で実装される予定の handler (columns 編集, syncData, requestReopenAs 等)
        // はここに段階的に追加される。
        const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (!msg || typeof msg !== 'object') { return; }
            switch (msg.type) {
                case 'ready':
                    // Phase B 以降: 初期データ送信
                    webviewPanel.webview.postMessage({
                        type: 'init',
                        data: this.parseOutSafely(document.getText())
                    });
                    break;
                case 'syncData':
                    // Phase B 以降: applyEdit で .out を上書き
                    if (typeof msg.payload === 'string') {
                        await this.applyEditFromWebview(document, msg.payload);
                    }
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
                default:
                    // Phase B で他 message を扱う
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
}
