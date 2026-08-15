/**
 * fileViewerProvider.ts — fractal.fileViewer（standalone 面 / FR-FV-02）
 *
 * sprint 20260815-075428-file-viewer-3panes / ADRL-0066 決定 1。
 * 本リポ初の CustomReadonlyEditorProvider（既存 2 provider = CustomTextEditorProvider は
 * .pdf バイナリを TextDocument にできない）。undo/save なしの read-only viewer。
 *
 * viewType は 2 つ（priority が per-editor のため）:
 *   fractal.fileViewer     — *.pdf（priority: default — VS Code 標準では開けない形式）
 *   fractal.fileViewerHtml — *.html/*.htm（priority: option — 標準のテキスト編集を奪わない）
 * どちらも本 provider の同一インスタンスを登録する。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { isViewerTarget, VIEWER_SIZE_LIMIT } from './shared/viewer-target';
import { getFileViewerHtml } from './fileViewerContent';

class FileViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void { /* 保持リソースなし */ }
}

export class FileViewerProvider implements vscode.CustomReadonlyEditorProvider<FileViewerDocument> {
    constructor(private readonly context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): FileViewerDocument {
        return new FileViewerDocument(uri);
    }

    async resolveCustomEditor(document: FileViewerDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const kind = isViewerTarget(path.basename(document.uri.fsPath));
        // localResourceRoots は生成時に一括設定（対象ファイルは resolve 時点で確定 — 動的書き換え不要）
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'media'),
                vscode.Uri.joinPath(this.context.extensionUri, 'out'),
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
            ],
        };

        // 50MB 超はフォールバック（FR-FV-07）。viewer 対象外 kind（あり得ないが防御）も同様
        try {
            const stat = await vscode.workspace.fs.stat(document.uri);
            if (!kind || stat.size > VIEWER_SIZE_LIMIT) {
                await vscode.env.openExternal(document.uri);
                webviewPanel.webview.html = '<html><body>OS 既定アプリで開きました。</body></html>';
                return;
            }
        } catch { /* stat 失敗は viewer 側の読み込み失敗 UI に委ねる */ }

        webviewPanel.webview.html = getFileViewerHtml(
            webviewPanel.webview, this.context.extensionUri, document.uri, kind || 'html');

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message && message.type === 'openExternalFallback') {
                await vscode.env.openExternal(document.uri);
            }
        });
    }
}

export function registerFileViewer(context: vscode.ExtensionContext): void {
    const provider = new FileViewerProvider(context);
    const options = {
        webviewOptions: { retainContextWhenHidden: true },   // 既存 2 provider と同一
        supportsMultipleEditorsPerDocument: false,
    };
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider('fractal.fileViewer', provider, options),
        vscode.window.registerCustomEditorProvider('fractal.fileViewerHtml', provider, options),
    );
}
