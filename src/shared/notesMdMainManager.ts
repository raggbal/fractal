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
import * as fs from 'fs';
import { resolveResourceRoots, findOutOfRangeImages } from './resource-roots';
import { createHybridFileWatcher, DrawioFileWatcher } from './drawioWatcher';

export interface NotesMdMainHost {
    postMessage(message: any): Thenable<boolean>;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

export class NotesMdMainManager {
    private _document: vscode.TextDocument | undefined;
    // FR-LR-02: FSW + fs.watchFile(polling) ハイブリッド。
    // メインペイン md の TextDocument もタブなしバッファのため、FSW 単独では
    // workspace フォルダ外のファイルに fire しない（editorProvider.ts:792 / MD-48 と同じ既知制約）。
    private _hybridWatcher: DrawioFileWatcher | undefined;
    private _fileChangeSubscription: { dispose: () => void } | undefined;
    private _docChangeSubscription: vscode.Disposable | undefined;
    private _watchedPath: string | undefined;
    private _isApplyingEdit = false;

    private readonly host: NotesMdMainHost;
    // FR-TH-02 (★MEDIUM-3): 外部編集で確定した content を上位（fileManager/webview 到達層）へ渡す。
    // このクラスは fileManager/sender を持たないため、tree title 反映は生成側のコールバックで行う。
    private readonly onExternalContent?: (filePath: string, content: string) => void;

    constructor(host: NotesMdMainHost, onExternalContent?: (filePath: string, content: string) => void) {
        this.host = host;
        this.onExternalContent = onExternalContent;
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

        // FR-LR-02: FSW 単独から createHybridFileWatcher（FSW + fs.watchFile 1s polling）に変更。
        // workspace 外の note でも外部編集（AI CLI 等）を検知してライブ反映する。
        // ポーリングが自己保存の後に発火しても下の newContent !== currentContent 差分チェックで no-op（NFR-LR-02）。
        this._hybridWatcher = createHybridFileWatcher(filePath, vscode, fs);
        this._fileChangeSubscription = this._hybridWatcher.onDidChange(() => {
            if (this._isApplyingEdit) return;
            setTimeout(async () => {
                try {
                    if (this._watchedPath !== filePath) return;
                    const targetDoc = this._document;
                    if (!targetDoc) return;
                    if (targetDoc.uri.fsPath !== filePath) return;
                    const liveDoc = targetDoc.isClosed
                        ? await vscode.workspace.openTextDocument(fileUri)
                        : targetDoc;
                    if (this._watchedPath !== filePath) return;
                    if (this._document !== liveDoc) {
                        this._document = liveDoc;
                    }
                    const fileContent = await vscode.workspace.fs.readFile(fileUri);
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
                        // FR-TH-02 (fire site 1: hybridWatcher): 外部編集の H1 を tree title に反映
                        this.onExternalContent?.(filePath, newContent);
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
            // FR-TH-02 (fire site 2: onDidChangeTextDocument): 外部編集の H1 を tree title に反映
            this.onExternalContent?.(filePath, content);
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
        // FR-LR-02: hybrid watcher の dispose（内部で fs.unwatchFile + FSW dispose）
        this._hybridWatcher?.dispose();
        this._hybridWatcher = undefined;
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
