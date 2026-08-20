/**
 * SidePanelManager — 共通サイドパネル管理
 *
 * editorProvider.ts と outlinerProvider.ts で完全に重複していた
 * ファイル監視・保存・リンク処理・TOC抽出ロジックを共通化。
 *
 * 画像ハンドラは含まない（ディレクトリ解決ロジックがモード間で根本的に異なるため）。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { extractToc, TocItem } from './toc-utils';
import { resolveResourceRoots, findOutOfRangeImages } from './resource-roots';
import { createHybridFileWatcher, DrawioFileWatcher } from './drawioWatcher';
import { isViewerTarget, VIEWER_SIZE_LIMIT } from './viewer-target';

/** Webview への通信インターフェース */
export interface SidePanelHost {
    postMessage(message: any): Thenable<boolean>;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
}

export interface SidePanelManagerConfig {
    /** ログ出力のプレフィックス (例: '[Fractal]', '[Outliner]') */
    logPrefix: string;
    /**
     * FR-HP-08: sidepanel で md を実際に開けた後に呼ばれる（任意）。
     * notes provider が Recent 履歴記録に使う。openFile 成功時のみ 1 回発火（存在しない/開けない場合は呼ばない）。
     * 未指定の provider（editor/outliner）には無影響。
     */
    onFileOpened?: (filePath: string) => void;
    /**
     * FR-FLV-29（再オープン① 2026-08-18）: 開いた md がフォルダリンク（folder link）配下なら
     * その folder link の title を返す（該当しなければ undefined）。notes provider が realpath 包含判定を注入。
     * webview へは表示用文字列のみ渡る（絶対パス不出 — INV-4）。未指定の provider（editor/outliner）には無影響。
     */
    resolveLinkedFolderTitle?: (filePath: string) => string | undefined;
}

// Re-export TocItem for backward compatibility
export type { TocItem } from './toc-utils';

export class SidePanelManager {
    // --- 内部状態 ---
    private _document: vscode.TextDocument | undefined;
    // FR-LR-01: FSW + fs.watchFile(polling) ハイブリッド。
    // sidepanel の TextDocument はタブなしバッファのため VS Code ネイティブの外部変更検知が効かず、
    // FSW 単独では workspace フォルダ外のファイルに fire しない（editorProvider.ts:792 / MD-48 と同じ既知制約）。
    private _hybridWatcher: DrawioFileWatcher | undefined;
    private _fileChangeSubscription: { dispose: () => void } | undefined;
    // FR-LV-03 (sprint 20260806-165116): atomic rename（Claude Code の保存方式）は FSW では
    // onDidCreate で上がるため、onDidChange に加えて onDidCreate も購読する
    private _createSubscription: { dispose: () => void } | undefined;
    private _docChangeSubscription: vscode.Disposable | undefined;
    private _watchedPath: string | undefined;
    private _isApplyingEdit = false;
    // FR-LV-02: deferred reconcile。_isApplyingEdit 中に届いた外部 FS イベントは捨てずに
    // ここへ保留し、_isApplyingEdit が false に戻る全地点で照合を 1 回実行する。
    // fs.watchFile はエッジトリガ（再配送なし）のため、捨てると次の disk 変化まで永久に
    // 反映されず、直後の auto-save が AI 編集を上書きする lost-update になる。
    // bool 1 個で足りる（照合はイベント内容でなく disk 現物を読むため、複数イベントの
    // 集約として正しい）。clear 契機 = 照合実行時 / disposeFileWatcher。
    private _pendingExternalCheck = false;
    // reconcile が既にスケジュール済みなら後続イベントを集約（drawioWatcher はポーリング発火を
    // onDidChange/onDidCreate 両 handler に配るため、1 イベントで onFsEvent が複数回呼ばれうる）
    private _reconcileScheduled = false;

    // v15+: side panel navigation history (back/forward stacks)
    // ユーザーが side panel 内で .md link click したときに pre-replace の filePath を push し
    // ← / → ボタンで navigate できる
    private _navBackStack: string[] = [];
    private _navForwardStack: string[] = [];

    private readonly host: SidePanelHost;
    private readonly config: SidePanelManagerConfig;

    constructor(host: SidePanelHost, config: SidePanelManagerConfig) {
        this.host = host;
        this.config = config;
    }

    // --- アクセサ (editorProvider の画像解決ヘルパーで使用) ---

    get watchedPath(): string | undefined {
        return this._watchedPath;
    }

    get document(): vscode.TextDocument | undefined {
        return this._document;
    }

    get isApplyingEdit(): boolean {
        return this._isApplyingEdit;
    }

    // --- ファイル監視 ---

    /**
     * サイドパネルファイルのファイル監視を設定する。
     * TextDocument バッファを開き、FileSystemWatcher + onDidChangeTextDocument で
     * 外部変更を検知してwebviewにリレーする。
     */
    async setupFileWatcher(filePath: string): Promise<void> {
        this.disposeFileWatcher();
        this._watchedPath = filePath;
        const fileUri = vscode.Uri.file(filePath);
        const prefix = this.config.logPrefix;

        // Open as TextDocument — creates an in-memory buffer (does not open a visible tab)
        this._document = await vscode.workspace.openTextDocument(fileUri);

        // Watch for external file changes → sync TextDocument
        // FR-LR-01: FSW 単独から createHybridFileWatcher（FSW + fs.watchFile 1s polling）に変更。
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
                void this._reconcileExternal(filePath, fileUri, prefix);
            }, 100);
        };
        this._fileChangeSubscription = this._hybridWatcher.onDidChange(onFsEvent);
        // FR-LV-03: atomic rename（Claude Code）は FSW では onDidCreate で上がる
        this._createSubscription = this._hybridWatcher.onDidCreate ? this._hybridWatcher.onDidCreate(onFsEvent) : undefined;

        // Watch TextDocument changes → relay to iframe
        this._docChangeSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (!this._document) return;
            if (this._watchedPath !== filePath) return;
            if (e.document.uri.toString() !== this._document.uri.toString()) return;
            if (e.document.uri.fsPath !== filePath) return;
            if (e.contentChanges.length === 0) return;
            if (this._isApplyingEdit) return;
            const content = e.document.getText();
            this.host.postMessage({
                type: 'sidePanelMessage',
                data: { type: 'update', content, filePath }
            });
        });
    }

    /**
     * FR-LV-02: 外部変更の照合ボディ（disk 読み → doc 比較 → 差分あれば反映）。
     * watcher イベントと pending flush の両方から呼ばれる。イベント内容でなく disk 現物を
     * 読むため、複数イベントが保留 bool 1 個に集約されても最終状態に収束する。
     * 自己保存由来の空振りは差分チェックで no-op（NFR-LR-02 維持）。
     */
    private async _reconcileExternal(filePath: string, fileUri: vscode.Uri, prefix: string): Promise<void> {
        try {
            // Race guard: navigation may have switched _document/_watchedPath
            // between the disk event and this call firing. Apply only
            // if we are still watching the same file the event is for.
            if (this._watchedPath !== filePath) return;
            const targetDoc = this._document;
            if (!targetDoc) return;
            if (targetDoc.uri.fsPath !== filePath) return;
            const liveDoc = targetDoc.isClosed
                ? await vscode.workspace.openTextDocument(fileUri)
                : targetDoc;
            // Re-check after await: navigation may have happened during openTextDocument
            if (this._watchedPath !== filePath) return;
            if (this._document !== liveDoc) {
                // Update the cached document only if we are still watching this file
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
                this._flushPendingExternalCheck(filePath, fileUri, prefix);
                // Final guard before save: confirm no navigation happened
                if (this._watchedPath !== filePath) return;
                if (liveDoc.isClosed) return;
                await liveDoc.save();
                if (this._watchedPath !== filePath) return;
                this.host.postMessage({
                    type: 'sidePanelMessage',
                    data: { type: 'update', content: newContent, filePath }
                });
            }
        } catch (error) {
            this._isApplyingEdit = false;
            this._flushPendingExternalCheck(filePath, fileUri, prefix);
            console.error(`${prefix}[SP-FSW] Error:`, error);
        }
    }

    /**
     * FR-LV-02: _isApplyingEdit=false 化直後に呼び、保留中の外部イベントがあれば照合を 1 回実行。
     * false 化 → flush の順（逆だと reconcile が再びガードに掛かる）。
     */
    private _flushPendingExternalCheck(filePath: string, fileUri: vscode.Uri, prefix: string): void {
        if (!this._pendingExternalCheck) return;
        this._pendingExternalCheck = false;
        setTimeout(() => this._reconcileExternal(filePath, fileUri, prefix), 100);
    }

    /**
     * ファイル監視リソースを全て破棄する。
     */
    disposeFileWatcher(): void {
        this._docChangeSubscription?.dispose();
        this._docChangeSubscription = undefined;
        this._fileChangeSubscription?.dispose();
        this._fileChangeSubscription = undefined;
        this._createSubscription?.dispose();
        this._createSubscription = undefined;
        // FR-LR-01: hybrid watcher の dispose（内部で fs.unwatchFile + FSW dispose）
        this._hybridWatcher?.dispose();
        this._hybridWatcher = undefined;
        this._document = undefined;
        this._watchedPath = undefined;
        // FR-LV-02: one-shot state の clear 契機（別ファイル open 後に stale 照合が走らない）
        this._pendingExternalCheck = false;
    }

    // --- メッセージハンドラ ---

    /**
     * 'saveSidePanelFile' メッセージの処理。
     * TextDocument バッファ経由で保存し、直接ファイル書き込みにフォールバック。
     */
    async handleSave(filePath: string, content: string): Promise<void> {
        const prefix = this.config.logPrefix;
        try {
            // Pin the target by URI once. Never trust this._document mid-save —
            // navigation can swap it during await applyEdit, which previously
            // could redirect _document.save() at a different file.
            const targetUri = vscode.Uri.file(filePath);
            const cached = this._document;
            const useBuffer = !!cached && cached.uri.fsPath === filePath;
            if (useBuffer) {
                let targetDoc = cached!.isClosed
                    ? await vscode.workspace.openTextDocument(targetUri)
                    : cached!;
                // Sanity-check we still target the same file
                if (targetDoc.uri.fsPath !== filePath) {
                    // Fall back to direct write — buffer no longer matches
                    await vscode.workspace.fs.writeFile(
                        targetUri,
                        Buffer.from(content, 'utf8')
                    );
                    return;
                }
                const normalize = (s: string) => s.replace(/\r\n/g, '\n');
                if (normalize(content) === normalize(targetDoc.getText())) return;

                this._isApplyingEdit = true;
                const spEdit = new vscode.WorkspaceEdit();
                spEdit.replace(
                    targetDoc.uri,
                    new vscode.Range(0, 0, targetDoc.lineCount, 0),
                    content
                );
                await vscode.workspace.applyEdit(spEdit);
                this._isApplyingEdit = false;
                // FR-LV-02: 保存窓中に届いて保留された外部イベントを照合（false 化 → flush の順）
                this._flushPendingExternalCheck(filePath, targetUri, prefix);
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
            this._flushPendingExternalCheck(filePath, vscode.Uri.file(filePath), prefix);
            console.error(`${prefix}[SP-Save] Error:`, e);
            vscode.window.showErrorMessage(
                `Failed to save: ${filePath} — ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }

    /**
     * 'sidePanelClosed' メッセージの処理。
     */
    handleClose(): void {
        this.disposeFileWatcher();
        this.clearNavigationHistory();
    }

    /**
     * サイドパネルでファイルを開く。
     * ファイル読み込み → TOC抽出 → openSidePanel メッセージ送信 → ファイル監視設定。
     *
     * @param filePath  開くファイルの絶対パス
     * @param freshOpen  true: navigation history を clear (= 新規 open)。default false (= navigation 経由)。
     *                    新規 open 時は webview の back/forward state を初期化するため必ず true で呼ぶ。
     */
    async openFile(filePath: string, freshOpen: boolean = false, restoreForTab: boolean = false): Promise<void> {
        if (freshOpen) {
            // 新規 open (outliner click 等) では history を clear → webview の back ボタン無効化
            this.clearNavigationHistory();
        }
        const fileUri = vscode.Uri.file(filePath);
        try {
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(fileContent).toString('utf8');
            const fileName = path.basename(filePath);
            const spBaseUri = this.host.asWebviewUri(
                fileUri.with({ path: fileUri.path.replace(/\/[^/]+$/, '/') })
            ).toString();
            this.host.postMessage({
                type: 'openSidePanel',
                markdown: text,
                filePath: filePath,
                fileName: fileName,
                toc: SidePanelManager.extractToc(text),
                documentBaseUri: spBaseUri,
                // sprint 20260723-233506: タブ復帰の復元経路（webview 側で scroll 同期復元 + auto-focus skip）
                restoreForTab: restoreForTab || undefined,
                // FR-FLV-29: リンクフォルダ内 md ならヘッダ表示用の folder link title（表示文字列のみ）
                linkedFolderTitle: this.config.resolveLinkedFolderTitle?.(filePath) || undefined,
            });
            // FR-RR-04: 開いた md の画像に許可範囲外があればフッター案内を送る
            this.sendResourceAccessStatus(text, path.dirname(filePath));
            await this.setupFileWatcher(filePath);
            // 常に nav state を送信 → webview の back/forward ボタン状態を extension と同期
            // (handleOpenLink で push 後、ここで canGoBack=true が webview に届く)
            this.sendNavStateUpdate();
            // FR-HP-08: 実際に開けた後にだけ通知（リンク/subpage 遷移・他 note / note 外を含む sidepanel open を
            // 単一 choke point で Recent 記録に載せる。read 失敗時は catch に落ちるのでここには来ない）。
            this.config.onFileOpened?.(filePath);
        } catch (e) {
            vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
        }
    }

    /**
     * FR-RR-04: sidepanel で開いた md 内の画像で許可範囲外のものを検知し、
     * フッター案内を webview に送る。範囲内のみなら outOfRange:false（帯クリア）。
     */
    private sendResourceAccessStatus(mdBody: string, mdDir: string): void {
        try {
            const cfg = vscode.workspace.getConfiguration('fractal');
            const roots = resolveResourceRoots(cfg.get<string[]>('resourceRoots', []));
            const outOfRange = findOutOfRangeImages(mdBody, mdDir, roots);
            this.host.postMessage({
                type: 'resourceAccessStatus',
                outOfRange: outOfRange.length > 0,
                count: outOfRange.length,
                samplePath: outOfRange[0]
            });
        } catch { /* best-effort。失敗しても本体表示を妨げない */ }
    }

    /**
     * 'sidePanelOpenLink' メッセージの処理。
     * サイドパネル内のリンククリック → 同じサイドパネル内で遷移 (back/forward stack push)。
     */
    async handleOpenLink(href: string, sidePanelFilePath: string): Promise<void> {
        if (href.startsWith('fractal://')) {
            vscode.commands.executeCommand('fractal.navigateInAppLink', href);
        } else if (href.startsWith('http')) {
            vscode.env.openExternal(vscode.Uri.parse(href));
        } else if (href.startsWith('#')) {
            this.host.postMessage({
                type: 'sidePanelMessage',
                data: { type: 'scrollToAnchor', anchor: href.substring(1) }
            });
        } else {
            const spBaseUri = vscode.Uri.file(sidePanelFilePath);
            const resolvedUri = path.isAbsolute(href)
                ? vscode.Uri.file(href)
                : vscode.Uri.joinPath(spBaseUri, '..', href);
            const resolvedPath = resolvedUri.fsPath.toLowerCase();
            if (resolvedPath.endsWith('.md') || resolvedPath.endsWith('.markdown')) {
                // v15+: push current side panel file to back stack, clear forward stack
                if (sidePanelFilePath && sidePanelFilePath !== resolvedUri.fsPath) {
                    this._navBackStack.push(sidePanelFilePath);
                    this._navForwardStack = [];
                }
                // navigation 経由なので freshOpen=false (history 維持)
                await this.openFile(resolvedUri.fsPath, false);
                // openFile 内で sendNavStateUpdate される
            } else {
                // FR-FV-01 sink #9（sprint 20260815-075428）: sidepanel md 内 📎 リンクの viewer 対象は
                // fractal 内 viewer で開く。判定・表示の例外は従来 openExternal に縮退（NFR-FV-01 防御）
                let handled = false;
                try {
                    handled = await this.tryOpenViewerPanel(resolvedUri.fsPath);
                } catch { handled = false; }
                if (!handled) {
                    vscode.env.openExternal(resolvedUri);
                }
            }
        }
    }

    /**
     * FR-FV-05 sink #9（sprint 20260815-075428）: viewer 対象（.html/.pdf）なら viewer サイドペインを
     * 開く message を送る。判定は shared isViewerTarget（唯一の判定点 — インライン複製禁止）。
     * 50MB 超はフォールバック（FR-FV-07）。viewer 実体は webview 側 viewer-side-panel.js。
     * @returns true = viewer で開いた（openExternal 不要）/ false = 対象外 or フォールバック
     */
    async tryOpenViewerPanel(filePath: string): Promise<boolean> {
        const kind = isViewerTarget(path.basename(filePath));
        if (!kind) { return false; }
        try {
            const stat = fs.statSync(filePath);
            if (stat.size > VIEWER_SIZE_LIMIT) { return false; }   // 50MB 超 → openExternal へ
        } catch { return false; }                                   // 実体なし → 従来経路の失敗表示に委ねる
        const fileWebviewUri = this.host.asWebviewUri(vscode.Uri.file(filePath)).toString();
        this.host.postMessage({
            type: 'openViewerPanel',
            kind,
            filePath,
            fileUri: fileWebviewUri,
        });
        return true;
    }

    /**
     * v15+: side panel navigation back — back stack から pop して openFile、現在 path は forward stack へ。
     */
    async navigateBack(currentSidePanelFilePath: string): Promise<void> {
        if (this._navBackStack.length === 0) return;
        const prev = this._navBackStack.pop()!;
        if (currentSidePanelFilePath && currentSidePanelFilePath !== prev) {
            this._navForwardStack.push(currentSidePanelFilePath);
        }
        await this.openFile(prev, false);
    }

    /**
     * v15+: side panel navigation forward。
     */
    async navigateForward(currentSidePanelFilePath: string): Promise<void> {
        if (this._navForwardStack.length === 0) return;
        const next = this._navForwardStack.pop()!;
        if (currentSidePanelFilePath && currentSidePanelFilePath !== next) {
            this._navBackStack.push(currentSidePanelFilePath);
        }
        await this.openFile(next, false);
    }

    /**
     * navigation stack 状態を webview に通知 (button enable/disable 用)。
     */
    sendNavStateUpdate(): void {
        this.host.postMessage({
            type: 'sidePanelMessage',
            data: {
                type: 'sidePanelNavStateUpdate',
                canGoBack: this._navBackStack.length > 0,
                canGoForward: this._navForwardStack.length > 0
            }
        });
    }

    /**
     * side panel close 時に history clear。
     */
    clearNavigationHistory(): void {
        this._navBackStack = [];
        this._navForwardStack = [];
    }

    // --- sendToChat (テキストエディタで開いて行選択) ---

    /**
     * サイドパネルの sendToChat を処理する。
     * 対象ファイルをテキストエディタで開き、該当行を選択状態にし、
     * 選択テキストをクリップボードにコピーする。
     */
    async handleSendToChat(
        sidePanelFilePath: string,
        startLine: number,
        endLine: number,
        selectedMarkdown: string
    ): Promise<void> {
        const uri = vscode.Uri.file(sidePanelFilePath);
        const textDoc = await vscode.workspace.openTextDocument(uri);
        const textEditor = await vscode.window.showTextDocument(textDoc, { preview: false });

        const maxLine = textDoc.lineCount - 1;
        const clampedStart = Math.max(0, Math.min(startLine, maxLine));
        const clampedEnd = Math.max(clampedStart, Math.min(endLine, maxLine));

        const startPos = new vscode.Position(clampedStart, 0);
        const endPos = textDoc.lineAt(clampedEnd).range.end;
        textEditor.selection = new vscode.Selection(startPos, endPos);
        textEditor.revealRange(
            new vscode.Range(startPos, endPos),
            vscode.TextEditorRevealType.InCenter
        );

        if (selectedMarkdown) {
            await vscode.env.clipboard.writeText(selectedMarkdown);
        }
    }

    // --- ユーティリティ ---

    /**
     * Markdown テキストから目次を抽出する (pure function)。
     * toc-utils.ts に移譲。
     */
    static extractToc(markdown: string): TocItem[] {
        return extractToc(markdown);
    }
}
