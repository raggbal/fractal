/**
 * NotesMdMainManager — Notes 内 .md メインペイン用の TextDocument + FileSystemWatcher 管理。
 *
 * sidePanelManager と同じパターン (openTextDocument + WorkspaceEdit + FileSystemWatcher) を
 * メインペインにも採用するためのクラス。
 *
 * - 同時に1ファイルだけ open する (md → md 切替で前のを dispose)
 * - 外部変更検知 → webview に `updateData kind:'md'` をリレー
 * - 保存は handleSave で TextDocument 経由 (WorkspaceEdit) → fallback で fs.writeFile
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { resolveResourceRoots, findOutOfRangeImages } from './resource-roots';

export interface NotesMdMainHost {
    postMessage(message: any): Thenable<boolean>;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

export class NotesMdMainManager {
    private _document: vscode.TextDocument | undefined;
    private _fileWatcher: vscode.FileSystemWatcher | undefined;
    private _fileChangeSubscription: vscode.Disposable | undefined;
    private _docChangeSubscription: vscode.Disposable | undefined;
    private _watchedPath: string | undefined;
    private _isApplyingEdit = false;

    private readonly host: NotesMdMainHost;

    constructor(host: NotesMdMainHost) {
        this.host = host;
    }

    get watchedPath(): string | undefined {
        return this._watchedPath;
    }

    get isApplyingEdit(): boolean {
        return this._isApplyingEdit;
    }

    /**
     * メインペインの .md を open し、TextDocument + FileSystemWatcher を起動する。
     * 既存 watch があれば dispose してから新規 watch する。
     */
    async setupFileWatcher(filePath: string): Promise<void> {
        if (this._watchedPath === filePath && this._document && !this._document.isClosed) {
            return; // 同じファイルなら何もしない
        }
        this.disposeFileWatcher();
        this._watchedPath = filePath;
        const fileUri = vscode.Uri.file(filePath);

        this._document = await vscode.workspace.openTextDocument(fileUri);

        this._fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(fileUri, '..'), path.basename(filePath))
        );
        this._fileChangeSubscription = this._fileWatcher.onDidChange(async (uri) => {
            if (uri.fsPath !== filePath) return;
            if (this._isApplyingEdit) return;
            setTimeout(async () => {
                try {
                    if (this._watchedPath !== filePath) return;
                    const targetDoc = this._document;
                    if (!targetDoc) return;
                    if (targetDoc.uri.fsPath !== filePath) return;
                    const liveDoc = targetDoc.isClosed
                        ? await vscode.workspace.openTextDocument(uri)
                        : targetDoc;
                    if (this._watchedPath !== filePath) return;
                    if (this._document !== liveDoc) {
                        this._document = liveDoc;
                    }
                    const fileContent = await vscode.workspace.fs.readFile(uri);
                    if (this._watchedPath !== filePath) return;
                    const newContent = new TextDecoder().decode(fileContent);
                    const currentContent = liveDoc.getText();
                    if (newContent !== currentContent) {
                        this._isApplyingEdit = true;
                        const fullRange = new vscode.Range(
                            liveDoc.positionAt(0),
                            liveDoc.positionAt(currentContent.length)
                        );
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(liveDoc.uri, fullRange, newContent);
                        await vscode.workspace.applyEdit(edit);
                        this._isApplyingEdit = false;
                        if (this._watchedPath !== filePath) return;
                        if (liveDoc.isClosed) return;
                        await liveDoc.save();
                        if (this._watchedPath !== filePath) return;
                        // 外部変更 → webview の md エディタに直接更新メッセージを送る
                        this.host.postMessage({
                            type: 'updateData',
                            kind: 'md',
                            markdown: newContent,
                            filePath,
                            documentBaseUri: this.host.asWebviewUri(
                                vscode.Uri.file(path.dirname(filePath))
                            ).toString(),
                            externalUpdate: true,
                        });
                        // FR-RR-04: 外部再レンダーでも範囲外画像を検知してフッター案内を更新する
                        this.sendResourceAccessStatus(newContent, filePath);
                    }
                } catch (error) {
                    this._isApplyingEdit = false;
                    console.error('[NotesMd-FSW] Error:', error);
                }
            }, 100);
        });

        // webview からの保存 (WorkspaceEdit) で document が変わった場合の relay は不要
        // (notesSaveCurrentMd → handleSave 経由で disk に書く一方通行)
        // ただし他の経路 (テキストエディタで開いて編集 → 保存) で TextDocument が変わるケースがあるので
        // sidePanel と同様に onDidChangeTextDocument を subscribe しておく。
        this._docChangeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (!this._document) return;
            if (this._watchedPath !== filePath) return;
            if (e.document.uri.toString() !== this._document.uri.toString()) return;
            if (e.document.uri.fsPath !== filePath) return;
            if (e.contentChanges.length === 0) return;
            if (this._isApplyingEdit) return;
            const content = e.document.getText();
            this.host.postMessage({
                type: 'updateData',
                kind: 'md',
                markdown: content,
                filePath,
                documentBaseUri: this.host.asWebviewUri(
                    vscode.Uri.file(path.dirname(filePath))
                ).toString(),
                externalUpdate: true,
            });
            // FR-RR-04: 外部再レンダーでも範囲外画像を検知してフッター案内を更新する
            this.sendResourceAccessStatus(content, filePath);
        });
    }

    /**
     * FR-RR-04: notes 本体 md の外部再レンダー時、その md の画像に許可範囲外があれば
     * フッター案内を webview に送る（範囲内のみなら outOfRange:false でクリア）。
     * 初回 open の検知（notesEditorProvider.sendResourceAccessStatus）と同じ純関数を再利用。
     */
    private sendResourceAccessStatus(mdBody: string, filePath: string): void {
        try {
            const cfg = vscode.workspace.getConfiguration('fractal');
            const roots = resolveResourceRoots(cfg.get<string[]>('resourceRoots', []));
            const outOfRange = findOutOfRangeImages(mdBody, path.dirname(filePath), roots);
            this.host.postMessage({
                type: 'resourceAccessStatus',
                outOfRange: outOfRange.length > 0,
                count: outOfRange.length,
                samplePath: outOfRange[0],
            });
        } catch { /* best-effort */ }
    }

    disposeFileWatcher(): void {
        this._docChangeSubscription?.dispose();
        this._docChangeSubscription = undefined;
        this._fileChangeSubscription?.dispose();
        this._fileChangeSubscription = undefined;
        this._fileWatcher?.dispose();
        this._fileWatcher = undefined;
        this._document = undefined;
        this._watchedPath = undefined;
    }

    /**
     * webview からの auto-save を TextDocument バッファ経由で書く。
     * バッファ経由が使えない場合は fs.writeFile に fallback。
     */
    async handleSave(filePath: string, content: string): Promise<void> {
        try {
            const targetUri = vscode.Uri.file(filePath);
            const cached = this._document;
            const useBuffer = !!cached && cached.uri.fsPath === filePath;
            if (useBuffer) {
                let targetDoc = cached!.isClosed
                    ? await vscode.workspace.openTextDocument(targetUri)
                    : cached!;
                if (targetDoc.uri.fsPath !== filePath) {
                    await vscode.workspace.fs.writeFile(
                        targetUri,
                        Buffer.from(content, 'utf8')
                    );
                    return;
                }
                const normalize = (s: string) => s.replace(/\r\n/g, '\n');
                if (normalize(content) === normalize(targetDoc.getText())) return;

                this._isApplyingEdit = true;
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    targetDoc.uri,
                    new vscode.Range(0, 0, targetDoc.lineCount, 0),
                    content
                );
                await vscode.workspace.applyEdit(edit);
                this._isApplyingEdit = false;
                if (targetDoc.isClosed) {
                    targetDoc = await vscode.workspace.openTextDocument(targetUri);
                }
                if (targetDoc.uri.fsPath !== filePath) return;
                await targetDoc.save();
            } else {
                await vscode.workspace.fs.writeFile(
                    targetUri,
                    Buffer.from(content, 'utf8')
                );
            }
        } catch (e) {
            this._isApplyingEdit = false;
            console.error('[NotesMd-Save] Error:', e);
            vscode.window.showErrorMessage(
                `Failed to save: ${filePath} — ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
}
