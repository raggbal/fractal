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
import { recordSelfWrite, isRecentSelfWrite, clearSelfWrites } from './self-write-registry';

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
    // FR-LV-03 (sprint 20260806-165116): atomic rename（Claude Code の保存方式）は FSW では
    // onDidCreate で上がるため、onDidChange に加えて onDidCreate も購読する
    private _createSubscription: { dispose: () => void } | undefined;
    private _docChangeSubscription: vscode.Disposable | undefined;
    private _watchedPath: string | undefined;
    private _isApplyingEdit = false;
    // FR-LV-02: deferred reconcile。_isApplyingEdit 中に届いた外部 FS イベントは捨てずに
    // ここへ保留し、_isApplyingEdit が false に戻る全地点で照合を 1 回実行する
    // （fs.watchFile はエッジトリガ = 捨てると永久消失 + auto-save の lost-update）。
    // clear 契機 = 照合実行時 / disposeFileWatcher。
    private _pendingExternalCheck = false;
    // reconcile が既にスケジュール済みなら後続イベントを集約（drawioWatcher はポーリング発火を
    // onDidChange/onDidCreate 両 handler に配るため、1 イベントで onFsEvent が複数回呼ばれうる）
    private _reconcileScheduled = false;

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
        // FR-LV-02: _isApplyingEdit 中のイベントは捨てずに保留（deferred reconcile）。
        // 捨てると fs.watchFile（エッジトリガ・再配送なし）のイベントが永久消失し、
        // 直後の auto-save が AI 編集を上書きする lost-update になる。
        const onFsEvent = () => {
            if (this._isApplyingEdit) { this._pendingExternalCheck = true; return; }
            if (this._reconcileScheduled) return;  // 同一変更の多重検知を 1 回の照合に集約
            this._reconcileScheduled = true;
            setTimeout(() => {
                this._reconcileScheduled = false;
                void this._reconcileExternal(filePath, fileUri);
            }, 100);
        };
        this._fileChangeSubscription = this._hybridWatcher.onDidChange(onFsEvent);
        // FR-LV-03: atomic rename（Claude Code）は FSW では onDidCreate で上がる
        this._createSubscription = this._hybridWatcher.onDidCreate ? this._hybridWatcher.onDidCreate(onFsEvent) : undefined;

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
     * FR-LV-02: 外部変更の照合ボディ（disk 読み → doc 比較 → 差分あれば反映）。
     * watcher イベントと pending flush の両方から呼ばれる。イベント内容でなく disk 現物を
     * 読むため、複数イベントが保留 bool 1 個に集約されても最終状態に収束する。
     * 自己保存由来の空振りは差分チェックで no-op（NFR-LR-02 維持）。
     */
    private async _reconcileExternal(filePath: string, fileUri: vscode.Uri): Promise<void> {
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
            // FR-LV-06 (ADRL-0098): 自己保存の残響（自分が直近に書いた内容の遅延イベント）は no-op。
            // doc との差分チェックより先に判定する — 編集中は doc が disk より先行するため、
            // 差分チェックだけだと自己保存を外部編集と誤認して巻き戻す（lost-update）。
            if (isRecentSelfWrite(filePath, newContent)) { return; }
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
                // FR-LV-06: 適用に成功した外部内容は直後に自分が save する = 残響イベントも自己書き込み扱い。
                // applyEdit 成功「後」に記録する（throw 時に未適用内容が台帳に残ると、pending flush の
                // 再照合まで no-op になり外部編集が反映されない — TC-LV-06 のエラー経路）。
                recordSelfWrite(filePath, newContent);
                this._isApplyingEdit = false;
                this._flushPendingExternalCheck(filePath, fileUri);
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
            this._flushPendingExternalCheck(filePath, fileUri);
            console.error('[NotesMd-FSW] Error:', error);
        }
    }

    /**
     * FR-LV-02: _isApplyingEdit=false 化直後に呼び、保留中の外部イベントがあれば照合を 1 回実行。
     * false 化 → flush の順（逆だと reconcile が再びガードに掛かる）。
     */
    private _flushPendingExternalCheck(filePath: string, fileUri: vscode.Uri): void {
        if (!this._pendingExternalCheck) return;
        this._pendingExternalCheck = false;
        setTimeout(() => this._reconcileExternal(filePath, fileUri), 100);
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
        // FR-LV-06: 台帳のメモリ解放（再 open 時は空から — 初回イベントは差分チェックが吸収）
        if (this._watchedPath) { clearSelfWrites(this._watchedPath); }
        this._docChangeSubscription?.dispose();
        this._docChangeSubscription = undefined;
        this._fileChangeSubscription?.dispose();
        this._fileChangeSubscription = undefined;
        this._createSubscription?.dispose();
        this._createSubscription = undefined;
        // FR-LR-02: hybrid watcher の dispose（内部で fs.unwatchFile + FSW dispose）
        this._hybridWatcher?.dispose();
        this._hybridWatcher = undefined;
        this._document = undefined;
        this._watchedPath = undefined;
        // FR-LV-02: one-shot state の clear 契機（別ファイル open 後に stale 照合が走らない）
        this._pendingExternalCheck = false;
    }

    /**
     * webview からの auto-save を TextDocument バッファ経由で書く。
     * バッファ経由が使えない場合は fs.writeFile に fallback。
     */
    async handleSave(filePath: string, content: string): Promise<void> {
        try {
            // FR-LV-06: 自分が書く内容を台帳に記録（buffer 経路 / fs.writeFile fallback の両方に効く位置）
            recordSelfWrite(filePath, content);
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
                // FR-LV-02: 保存窓中に届いて保留された外部イベントを照合（false 化 → flush の順）
                this._flushPendingExternalCheck(filePath, targetUri);
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
            this._flushPendingExternalCheck(filePath, vscode.Uri.file(filePath));
            console.error('[NotesMd-Save] Error:', e);
            vscode.window.showErrorMessage(
                `Failed to save: ${filePath} — ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
}
