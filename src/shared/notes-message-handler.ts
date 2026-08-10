import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { NotesFileManager } from './notes-file-manager';
import { resolveSubpageTitle, saveDroppedMdAsSubpage } from './md-subpage-utils';
import { importMdFiles } from './markdown-import';
import { OutlinerClipboardStore } from './outliner-clipboard-store';
import * as crypto from 'crypto';
import { handlePageAssets, handleImageAssets, handleFileAsset, copyImageAssets, moveImageAssets, resolveCrossPasteCut, runMdIntoOutlinerPaste, generateUniqueFileNamePreserving } from './paste-asset-handler';
import { safeResolveUnderDir } from './path-safety';
import { resolveFilesDirForMd, resolvePagesDir } from './flat-layout';
import { handleExportMindmap } from './mindmap-export-host';
import { translateText, TRANSLATE_LANGUAGES } from './aws-translate';
import { processDropFilesImport, processDropVscodeUrisImport, DropImportItem } from './drop-import';
import { setFirstH1, writeFileIfChanged, extractFirstH1 } from './md-h1-utils';
import { ExportOptions } from './md-export-core';

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
    /** FR-MG-03/05/07: 起動時移行ゲートで移行を実行（backup→validate→execute→成功で reopen / 失敗で通知） */
    runFlatMigration?(): void;

    // FR-EX-01/03: md export bundle。フォルダ選択ダイアログ + fs 書き出し（VS Code 依存）。
    exportBundle?(rootMdAbs: string, options: ExportOptions): void;
    // FR-PDF-08: md → PDF export。VS Code 依存（deps 生成 + panel 供給）は provider 実装側。
    // optional（exportBundle と同型）: 未実装 provider では case で no-op になり落ちない。
    exportPdf?(targetHint?: string): void;
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
    /** FR-B07: sidepanel md への .md D&D → subpage 登録 */
    saveMdAsSubpageForSidePanel?(dataUrl: string, fileName: string, sidePanelFilePath: string): void;
    readMdAsSubpageForSidePanel?(filePath: string, sidePanelFilePath: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/images/ に保存して挿入 */
    saveMdImageToDir?(dataUrl: string, fileName: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/images/ にコピーして挿入 */
    readAndInsertMdImage?(filePath: string): void;
    /** ADR-008: Notes 内 .md エディタ用 — _notes_md/files/ に保存して挿入 */
    saveMdFileToDir?(dataUrl: string, fileName: string): void;
    /** FR-B07: Notes md メインペインの .md D&D → subpage 登録（同階層コピー + insertSubpageLink 返信） */
    saveMdAsSubpageForNotesMd?(dataUrl: string, fileName: string): void;
    readMdAsSubpageForNotesMd?(filePath: string): void;
    /** FR-B09: ファイルツリー md → md editor D&D（コピーせず既存 md への subpage リンクを返信。
     *  US-09: mdFileId 指定時はツリーから md エントリを除去 = 真の subpage 化） */
    linkMdAsSubpageForNotesMd?(filePath: string, mdFileId?: string | null): void;
    /** TASK-17: ツリー md → sidepanel md D&D（同一 note = リンク+除去 / 別 note = 複製） */
    linkMdAsSubpageForSidePanel?(filePath: string, mdFileId: string | null, sidePanelFilePath: string): void;
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
    /** sprint 20260723-233506: タブ切替の flush（fileManager.flushSave）。NFR-TAB-03 */
    flushActiveForTab?(): void;
    /** sprint 20260723-233506: タブ復帰でサイドパネルを復元（sidePanel.openFile(fp,false,true)）。FR-TAB-06 */
    restoreSidePanelForTab?(filePath: string): void;
    /** sprint 20260723-233506: サイドパネル「Open in tab」等から .md を webview 内タブで開く（FR-TAB-02）。 */
    openFileInWebviewTab?(filePath: string): void;
    /** outliner node subtree の Export bundle（FR-EB）。dialog + 出力は export-bundle-host */
    exportOutlinerNodesBundle?(args: { nodeId: string; nodes: unknown[]; srcOutDir: string; srcPagesDir: string; srcFileDir: string }): void;
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
    /** .drawio.svg/.png を外部アプリで開く（mac: draw.io Desktop 優先 → OS デフォルト fallback） */
    openDrawioExternal?(absPath: string): void;
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
    pasteWithAssetCopy?(markdown: string, sourceContext: any, sidePanelFilePath: string, destination?: string): void;
    /** outliner node paste の添付複製 (sprint 20260727-124904)。nodes は Store が真実 (message.nodes は Store miss 時の fallback リスト用) */
    pasteOutlinerNodesWithAssets?(plainText: string, nodes: unknown[], sidePanelFilePath: string): void;
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
    notesImportMdIntoOut?(mdFileId: string, targetOutId: string, sender: NotesSender, targetNodeId?: string | null, position?: string | null): Promise<void> | void;
    /** TASK-19: md editor 内 subpage リンク → ツリー D&D（同一 note = 既存登録+アンカー除去 / 別 note = 複製登録） */
    notesRegisterSubpageFromMd?(payload: { href: string; sourceMdPath: string; title?: string }, parentId: string | null, index: number, sender: NotesSender): Promise<void> | void;
    /**
     * FR-T01 / FR-TF-01: Finder / VS Code Explorer から D&D。
     * kind:'md' = 各 md を新 id で複製登録 / kind:'file'（§4a）= bytes(base64) を files/ に tree file item 登録。
     */
    notesRegisterExternalMd?(
        items: { kind: string; name: string; content?: string; bytes?: string }[],
        parentId: string | null,
        index: number,
        sender: NotesSender
    ): Promise<void> | void;
    /** FR-TF-19 (§4m): outliner 📎 file node → md editor 添付（cross-note は §4l source orphan 契約） */
    attachOutNodeFileToMd?(payload: { outFileKey: string; nodeId: string }, sidePanelFilePath: string | null, sender: NotesSender): Promise<void> | void;
    /** FR-TF-19 (§4m): outliner page node → md editor subpage リンク */
    importOutPageNodeToMd?(payload: { outFileKey: string; nodeId: string; pageId: string; title?: string }, sidePanelFilePath: string | null, sender: NotesSender): Promise<void> | void;
    /** FR-TF-19 (§4m): md 📎 リンク → 別 md editor へ添付移動 */
    attachMdFileLinkToMd?(payload: { href: string; sourceMdPath: string }, sidePanelFilePath: string | null, sender: NotesSender): Promise<void> | void;
    /** FR-TF-19 (§4m): md subpage リンク → 別 md editor へ移動 */
    linkMdSubpageToMd?(payload: { href: string; sourceMdPath: string; title?: string }, sidePanelFilePath: string | null, sender: NotesSender): Promise<void> | void;
    /** FR-TF-17 (§4k): VS Code Explorer uri-list drop — uris[] を host fs 直読みで登録（50MB cap なし） */
    notesRegisterExternalUris?(
        uris: string[],
        parentId: string | null,
        index: number,
        sender: NotesSender
    ): Promise<void> | void;
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

    // ── FR-TF: tree file item（ext:'file'）D&D 経路（8 経路 + menu/click）——————————
    /** click: tree file を外部アプリで開く（getTreeFilePath → openExternal） */
    openTreeFileExternal?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-03 (§4b): tree file を .out item にドロップ → 当該 .out root 先頭に file node 追加 + tree 除去 */
    notesImportFileIntoOut?(dragItemId: string, targetOutId: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-04 (§4c): tree file を md item にドロップ → 対象 md 末尾に 📎 リンク追記 + tree 除去 */
    notesAttachFileIntoMd?(dragItemId: string, targetMdId: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-06a (§4f): tree file を開いている md editor（main=currentFile / sidepanel=sidePanelFilePath）へ添付 */
    attachTreeFileToMd?(id: string, sidePanelFilePath: string | null | undefined, sender: NotesSender): Promise<void> | void;
    /** FR-TF-05a (§4d): tree file を outliner の node 位置に D&D → dropFilesResult 互換 postback + tree 除去 */
    notesImportTreeFileAtPosition?(id: string, outFileId: string, targetNodeId: string | null, position: string | null, sender: NotesSender): Promise<void> | void;
    /** FR-TF-05b (§4e): outliner の file 添付 node をツリーへ D&D → files/ 登録（共有配下は無コピー）+ node.filePath null 化 */
    notesRegisterFileFromOutNode?(payload: { outFileKey: string; nodeId: string }, parentId: string | null, index: number, sender: NotesSender): Promise<void> | void;
    /** FR-TF-06b (§4g): md editor 内の 📎 file リンクをツリーへ D&D → files/ 登録 + 元 md からアンカー除去 */
    notesRegisterFileFromMdLink?(payload: { href: string; sourceMdPath: string }, parentId: string | null, index: number, sender: NotesSender): Promise<void> | void;
    /** FR-TF-10 menu: Reveal in Finder（getTreeFilePath → revealFileInOS command） */
    revealTreeFileInOS?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-10 menu: Copy Path（getTreeFilePath の絶対パスを OS clipboard へ） */
    copyTreeFilePath?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-10 menu: Delete（getTreeFilePath → workspace.fs.delete useTrash → structure 除去） */
    deleteTreeFile?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-TF-01 (§4a): 外部 D&D の 50MB 超 skip 等をユーザーに明示通知 */
    notifyError?(message: string): void;
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

        // FR-MG-03: 起動時移行ゲートの「移行する」ボタン。backup→validate→execute→成功で reopen。
        case 'runFlatMigration':
            platform.runFlatMigration?.();
            break;

        // FR-EX-01/03: md export bundle。root md 解決は
        //   sidepanel から開いた md = message.sidePanelFilePath / メインペイン = 現在の md。
        // dialog + fs 書き出しは VS Code 依存なので platform に委譲。
        case 'exportBundle': {
            const rootMd = (message.sidePanelFilePath as string) || fileManager.getCurrentFilePath();
            if (rootMd && message.options) {
                platform.exportBundle?.(rootMd, message.options as ExportOptions);
            }
            break;
        }

        // FR-PDF-08: md → PDF export。deps 生成 + 対象 panel の供給は VS Code 依存なので
        // platform に委譲（未実装 provider では no-op = 落ちない）。targetHint は
        // Notes md タブ='main-md' / .out タブ + sidepanel='sidepanel-md'（webview 側で付与）。
        case 'exportPdf': {
            platform.exportPdf?.(message.targetHint as string | undefined);
            break;
        }

        // FR-EB: outliner node subtree の Export bundle。src dir 解決は saveOutlinerClipboard と同一。
        // dialog + fs 書き出しは VS Code 依存なので platform に委譲。
        case 'exportOutlinerNodesBundle': {
            if (typeof message.nodeId !== 'string' || !message.nodeId || !Array.isArray(message.nodes)) break;
            const ebPagesDir = fileManager.getPagesDirPath();
            const ebCur = fileManager.getCurrentFilePath();
            platform.exportOutlinerNodesBundle?.({
                nodeId: message.nodeId,
                nodes: message.nodes as unknown[],
                srcOutDir: ebCur ? path.dirname(ebCur) : ebPagesDir,
                srcPagesDir: ebPagesDir,
                srcFileDir: fileManager.getFileDirPath(),
            });
            break;
        }

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
            // ★再オープン③ fix2: disk 書込を await してから title 再解決する（getHistoryWithFreshTitles は
            //   tree 外 md の title を disk から読むため、await しないと新 H1 が disk 反映前に読まれて stale
            //   になる = レース）。saveSidePanelFile:643 と同じ理由で await する。
            if (platform.mdMainSave) {
                try {
                    await platform.mdMainSave(cur, message.content);
                } catch (e) {
                    console.error('[NotesMessageHandler] mdMainSave error:', e);
                }
            } else {
                fileManager.saveCurrentFile(message.content);
            }
            // FR-TH-02: 先頭 H1 を tree title に反映（変化時のみ再描画）
            let mdNeedResend = fileManager.syncTitleFromH1(cur, message.content);
            // FR-TP-04（再オープン③）: tree 外 md（open-new-tab で開いた page md 等、items に無い md）は
            //   syncTitleFromH1 が false を返す（tree item 専用）。この場合でも現 md が Recent history に
            //   note-md（絶対パス）で存在するなら、H1 編集を Recent/tab に即反映するため再送する
            //   （saveSidePanelFile の history フォールバックと対称。これが無いと tree 外 md の H1 変更が
            //    別 md に移動するまで反映されない）。
            if (!mdNeedResend) {
                const fp = path.resolve(cur);
                const hasHistory = (fileManager.getHistory() || []).some(
                    (e) => e.kind === 'note-md' && path.resolve(e.id) === fp);
                if (hasHistory) { mdNeedResend = true; }
            }
            if (mdNeedResend) {
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
            // sprint 20260728-200503: stale cut メタ矯正（Store の isCut が真実）
            const pgCut = resolveCrossPasteCut(!!message.isCut, clipData.isCut);
            let effNewPageId = message.newPageId as string | null;
            if (pgCut.staleCutCorrected && !effNewPageId && message.pageId) {
                // webview は cut 分岐で旧 pageId を保持している → copy として新 id を発行し postback
                effNewPageId = crypto.randomUUID();
                console.warn('[NotesMessageHandler] stale cut meta corrected to copy (pageId re-issued):', message.pageId, '->', effNewPageId);
                sender.postMessage({
                    type: 'updateNodePageId',
                    nodeId: message.targetNodeId,
                    newPageId: effNewPageId
                });
            }
            const currentFilePath = fileManager.getCurrentFilePath();
            const destPagesDir = fileManager.getPagesDirPath();
            const result = handlePageAssets({
                srcOutDir: clipData.sourceOutDir,
                srcPagesDir: clipData.sourcePagesDirPath,
                destOutDir: currentFilePath ? path.dirname(currentFilePath) : destPagesDir,
                destPagesDir,
                pageId: message.pageId,
                newPageId: pgCut.effectiveIsCut ? null : effNewPageId,
                nodeImages: message.nodeImages || [],
                sameDirSkip: pgCut.effectiveIsCut
            });
            sender.postMessage({
                type: 'updateNodeImages',
                nodeId: message.targetNodeId,
                newImages: result.newNodeImages
            });
            break;
        }

        case 'copyImagesCross': {
            const imgClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
            if (!imgClipData || !message.images) break;
            const imgCut = resolveCrossPasteCut(!!message.isCut, imgClipData.isCut);
            if (imgCut.staleCutCorrected) console.warn('[NotesMessageHandler] stale cut meta corrected to copy (images)');
            const currentFilePath = fileManager.getCurrentFilePath();
            const destPagesDir = fileManager.getPagesDirPath();
            const result = imgCut.effectiveIsCut
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
            break;
        }

        case 'pasteMdIntoOutliner': {
            // FR-XP-02 (sprint 20260808-000219): md 範囲選択 copy → outliner paste。
            // sourceContext (text/x-any-md-context 由来) を使い、複製 + 行→node 変換を一括実行。
            if (!message.mdText || !message.sourceContext || !message.targetNodeId) break;
            const xpCurrentFile = fileManager.getCurrentFilePath();
            const xpDestPagesDir = fileManager.getPagesDirPath();
            const xpResult = runMdIntoOutlinerPaste({
                mdText: message.mdText,
                sourceContext: message.sourceContext,
                isCut: !!message.isCut,
                destOutDir: xpCurrentFile ? path.dirname(xpCurrentFile) : xpDestPagesDir,
                destPagesDir: xpDestPagesDir,
                destImagesDir: fileManager.getOutlinerImageDirPath(),
                destFilesDir: fileManager.getFileDirPath(),
            });
            sender.postMessage({
                type: 'pasteMdIntoOutlinerResult',
                targetNodeId: message.targetNodeId,
                nodes: xpResult.nodes,
            });
            break;
        }

        case 'handleFileAssetCross': {
            const fileClipData = OutlinerClipboardStore.get(message.clipboardPlainText);
            if (!fileClipData || !message.filePath) break;
            const faCut = resolveCrossPasteCut(!!message.isCut, fileClipData.isCut);
            if (faCut.staleCutCorrected) console.warn('[NotesMessageHandler] stale cut meta corrected to copy (file)');
            const currentFilePathFA = fileManager.getCurrentFilePath();
            const destFileDirFA = fileManager.getFileDirPath();
            const resultFA = handleFileAsset({
                srcOutDir: fileClipData.sourceOutDir,
                srcFileDir: fileClipData.sourceFileDirPath || path.join(fileClipData.sourceOutDir, 'files'),
                destOutDir: currentFilePathFA ? path.dirname(currentFilePathFA) : destFileDirFA,
                destFileDir: destFileDirFA,
                filePath: message.filePath,
                useCollisionSuffix: !faCut.effectiveIsCut,
                sameDirSkip: faCut.effectiveIsCut
            });
            sender.postMessage({
                type: 'updateNodeFilePath',
                nodeId: message.nodeId,
                newFilePath: resultFA.newFilePath
            });
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
                // FR-HP-08: 履歴記録は sidePanelManager.onFileOpened（sidepanel open の単一記録点）が担う。
                //   platform.openPageInSidePanel → sidePanel.openFile → onFileOpened で recordFileHistory される。
                //   ここで記録すると二重記録になるため呼ばない。
                platform.openPageInSidePanel(pagePath);
                sendFileListWithStructure(fileManager, sender);
            }
            break;
        }

        // FR-CT-03: page アイコン cmd+click → page md を webview 内タブで開く
        case 'openPageInTab': {
            const pagePath = fileManager.getPageFilePath(message.pageId);
            if (fs.existsSync(pagePath)) {
                if (platform.openFileInWebviewTab) {
                    platform.openFileInWebviewTab(pagePath);
                } else {
                    platform.openPageInSidePanel(pagePath); // タブ非対応環境フォールバック
                }
            }
            break;
        }

        // sprint 20260723-233506: webview 内マルチタブの host 協調
        case 'notesFlushActive':
            platform.flushActiveForTab?.();
            break;
        case 'notesRestoreSidePanel':
            if (typeof message.filePath === 'string' && message.filePath) {
                platform.restoreSidePanelForTab?.(message.filePath);
            }
            break;
        // sprint 20260724-063158 (FR-TP-06): タブ右クリック → standalone（VS Code 別タブ）で開く。
        case 'notesOpenInVscodeTab':
            if (typeof message.filePath === 'string' && message.filePath) {
                platform.openFileInEditor(message.filePath);  // 既存: vscode.openWith 'fractal.editor'
            }
            break;

        // sprint 20260725: 左ツリー右クリック「Open in new tab」→ webview 内タブ（md/.out 両対応・kind は host が拡張子で決定）
        case 'notesOpenFileInTab':
            if (typeof message.filePath === 'string' && message.filePath && platform.openFileInWebviewTab) {
                platform.openFileInWebviewTab(message.filePath);
            }
            break;

        // ★reopen 2026-07-23: openPageFromHistory は廃止（Recent の page md も note-md・絶対パスで記録し
        //   bridge.openFile → notesOpenFile でメインペインに開くため、sidepanel 専用の page 開き経路は不要）。

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
            // FR-HP（sidepanel で開いた md の Recent title 反映）: sidepanel で開いた md が
            // Recent 履歴に note-md（絶対パス）として存在するなら、その H1 編集を Recent に反映するため
            // history を再送する。syncTitleFromH1 は tree item（items）専用で items 外 md（page md / 他 note md）を
            // 拾わないため、これが無いと items 外 md の H1 変更が Recent に永久に反映されない（別ファイルを開いても
            // notesOpenFile を通らない sidepanel-only 操作では再送されない）。
            // ★reopen 2026-07-23: page-md kind 廃止に伴い、旧「basename=pageId が page-md 履歴」判定を
            //   「絶対パス一致の note-md 履歴」判定に置換（統一後 page md も note-md・絶対パスで記録される）。
            if (!needFileListResend) {
                const fp = path.resolve(message.filePath);
                const hasHistory = (fileManager.getHistory() || []).some(
                    (e) => e.kind === 'note-md' && path.resolve(e.id) === fp);
                if (hasHistory) { needFileListResend = true; }
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
                // FR-XP-01 (sprint 20260808-000219): destination は結果の宛先札（main-md /
                // sidepanel / 旧形式 undefined）。host は解釈せず echo back するだけ。
                platform.pasteWithAssetCopy(message.markdown, message.sourceContext, message.sidePanelFilePath, message.destination);
            }
            break;

        // outliner node リスト paste の添付複製 (sprint 20260727-124904 / ADRL-0001)。
        // 宛先 = sidepanel の md (sidePanelFilePath)。nodes の真実は OutlinerClipboardStore
        // (cmd+c 時に保存済み・ソース dir 込み) — message.nodes は検知用 (NFR-NP-03)。
        case 'pasteOutlinerNodesWithAssets':
            if (message.sidePanelFilePath && platform.pasteOutlinerNodesWithAssets) {
                platform.pasteOutlinerNodesWithAssets(message.plainText || '', message.nodes || [], message.sidePanelFilePath);
            } else {
                // TASK-B5 防御: 宛先 md が特定できない場合でも paste 自体は成立させる
                // (添付複製なしのリストのみ md を返す。silent no-op で「貼れない」にしない)
                const fallbackLines = ((message.nodes || []) as Array<{ text?: string; level?: number }>).map(
                    (n) => `${'  '.repeat(Math.max(0, n.level || 0))}- ${String(n.text || '').replace(/\n/g, ' ')}`);
                sender.postMessage({
                    type: 'pasteWithAssetCopyResult',
                    markdown: fallbackLines.join('\n') + '\n',
                });
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

        // FR-B07: Notes sidepanel md への .md D&D → subpage 登録（sidepanel md と同階層）
        case 'saveMdAsSubpage':
            if (message.sidePanelFilePath && message.dataUrl && platform.saveMdAsSubpageForSidePanel) {
                platform.saveMdAsSubpageForSidePanel(message.dataUrl, message.fileName, message.sidePanelFilePath);
            }
            break;

        case 'readAndInsertMdAsSubpage':
            if (message.sidePanelFilePath && message.filePath && platform.readMdAsSubpageForSidePanel) {
                platform.readMdAsSubpageForSidePanel(message.filePath, message.sidePanelFilePath);
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

        // FR-B07 (sprint 20260804-145603): Notes md メインペインの .md D&D → subpage 登録
        case 'notesMdSaveMdAsSubpage':
            if (message.dataUrl && platform.saveMdAsSubpageForNotesMd) {
                platform.saveMdAsSubpageForNotesMd(message.dataUrl, message.fileName);
            }
            break;

        case 'notesMdReadMdAsSubpage':
            if (message.filePath && platform.readMdAsSubpageForNotesMd) {
                platform.readMdAsSubpageForNotesMd(message.filePath);
            }
            break;

        // FR-B09 (TASK-08): ファイルツリー md → md editor D&D（コピーせず既存 md へ subpage リンク）
        case 'notesMdLinkMdAsSubpage':
            if (message.filePath && platform.linkMdAsSubpageForNotesMd) {
                platform.linkMdAsSubpageForNotesMd(message.filePath, message.mdFileId || null);
            }
            break;

        // TASK-17: ファイルツリー md → sidepanel md D&D（同一 note 判定は host 側）
        case 'linkMdAsSubpage':
            if (message.filePath && message.sidePanelFilePath && platform.linkMdAsSubpageForSidePanel) {
                platform.linkMdAsSubpageForSidePanel(message.filePath, message.mdFileId || null, message.sidePanelFilePath);
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
            // sprint 20260723-233506: Notes サイドパネル「Open in tab」（outliner.js の side-panel-open-tab）は
            // ここに落ちる（host=outlinerHostBridge → shared openLinkInTab → type:'openLinkInTab'）。
            // .md は VS Code 別タブでなく webview 内タブで開く（FR-TAB-02 / NFR-TAB-04）。
            if (message.href) {
                const lower = String(message.href).toLowerCase();
                if ((lower.endsWith('.md') || lower.endsWith('.markdown')) && platform.openFileInWebviewTab) {
                    platform.openFileInWebviewTab(message.href);
                } else {
                    platform.openFileInEditor(message.href);
                }
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

        case 'openDrawioExternal':
            if (message.absPath) {
                platform.openDrawioExternal?.(message.absPath);
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
                        // FR-TP-04: tab 名用 title（items 優先 → 先頭 H1 → basename）
                        title: fileManager.resolveTitleForPath(message.filePath, content),
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
                    sender.postMessage({ type: 'updateData', kind: 'out', data, fileChangeId: fileManager.getFileChangeId(), outFileKey: fileManager.getCurrentFilePath(), isDailyNotes, title: (typeof data.title === 'string' && data.title) ? data.title : fileManager.resolveTitleForPath(message.filePath, content) });
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
        // TASK-19: md editor 内 subpage リンク → ツリー D&D
        case 'notesRegisterSubpageFromMd':
            if (message.payload && platform.notesRegisterSubpageFromMd) {
                await platform.notesRegisterSubpageFromMd(message.payload, message.parentId ?? null, message.index ?? 0, sender);
            }
            break;

        // FR-T01: Finder / VS Code Explorer から .md をツリーに D&D → 各 md を新 id で複製登録
        case 'notesRegisterExternalMd':
            if (Array.isArray(message.items) && platform.notesRegisterExternalMd) {
                await platform.notesRegisterExternalMd(message.items, message.parentId ?? null, message.index ?? 0, sender);
            }
            break;

        // FR-TF-17 (§4k): VS Code Explorer uri-list drop → host fs 直読みで md/file 振り分け登録
        case 'notesRegisterExternalUris':
            if (Array.isArray(message.uris) && platform.notesRegisterExternalUris) {
                await platform.notesRegisterExternalUris(message.uris, message.parentId ?? null, message.index ?? 0, sender);
            }
            break;

        case 'notesImportMdIntoOut': {
            if (typeof platform.notesImportMdIntoOut === 'function') {
                // FR-TF-14: targetNodeId/position は任意（旧 webview からは undefined = 従来挙動）
                await platform.notesImportMdIntoOut(message.mdFileId, message.targetOutId, sender, message.targetNodeId ?? null, message.position ?? null);
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

        // ── FR-TF: tree file item（ext:'file'）D&D 経路 ──
        case 'openTreeFileExternal': {
            if (typeof platform.openTreeFileExternal === 'function') {
                await platform.openTreeFileExternal(message.id, sender);
            }
            break;
        }
        // FR-TF-03 (§4b)
        case 'notesImportFileIntoOut': {
            if (typeof platform.notesImportFileIntoOut === 'function') {
                await platform.notesImportFileIntoOut(message.dragItemId, message.targetOutId, sender);
            }
            break;
        }
        // FR-TF-04 (§4c)
        case 'notesAttachFileIntoMd': {
            if (typeof platform.notesAttachFileIntoMd === 'function') {
                await platform.notesAttachFileIntoMd(message.dragItemId, message.targetMdId, sender);
            }
            break;
        }
        // FR-TF-06a (§4f)
        case 'attachTreeFileToMd': {
            if (typeof platform.attachTreeFileToMd === 'function') {
                await platform.attachTreeFileToMd(message.id, message.sidePanelFilePath ?? null, sender);
            }
            break;
        }

        // FR-TF-19 (§4m): md editor drop 受け 4 経路（main = sidePanelFilePath null / sidepanel = 実パス）
        case 'attachOutNodeFileToMd': {
            if (typeof platform.attachOutNodeFileToMd === 'function') {
                await platform.attachOutNodeFileToMd(message.payload, message.sidePanelFilePath ?? null, sender);
            }
            break;
        }
        case 'importOutPageNodeToMd': {
            if (typeof platform.importOutPageNodeToMd === 'function') {
                await platform.importOutPageNodeToMd(message.payload, message.sidePanelFilePath ?? null, sender);
            }
            break;
        }
        case 'attachMdFileLinkToMd': {
            if (typeof platform.attachMdFileLinkToMd === 'function') {
                await platform.attachMdFileLinkToMd(message.payload, message.sidePanelFilePath ?? null, sender);
            }
            break;
        }
        case 'linkMdSubpageToMd': {
            if (typeof platform.linkMdSubpageToMd === 'function') {
                await platform.linkMdSubpageToMd(message.payload, message.sidePanelFilePath ?? null, sender);
            }
            break;
        }
        // FR-TF-05a (§4d)
        // FR-TF-20 (§4n): md リンク → outliner drop 位置に取込
        case 'importMdFileLinkIntoOut': {
            importMdFileLinkIntoOut(fileManager, sender, message.payload, message.outFileId, message.targetNodeId ?? null, message.position ?? null);
            break;
        }
        case 'importMdSubpageIntoOut': {
            importMdSubpageIntoOut(fileManager, sender, message.payload, message.outFileId, message.targetNodeId ?? null, message.position ?? null);
            break;
        }
        case 'notesImportTreeFileAtPosition': {
            if (typeof platform.notesImportTreeFileAtPosition === 'function') {
                await platform.notesImportTreeFileAtPosition(
                    message.id,
                    message.outFileId,
                    message.targetNodeId ?? null,
                    message.position ?? null,
                    sender
                );
            }
            break;
        }
        // FR-TF-05b (§4e)
        case 'notesRegisterFileFromOutNode': {
            if (typeof platform.notesRegisterFileFromOutNode === 'function') {
                await platform.notesRegisterFileFromOutNode(message.payload, message.parentId ?? null, message.index ?? 0, sender);
            }
            break;
        }
        // FR-TF-06b (§4g)
        case 'notesRegisterFileFromMdLink': {
            if (typeof platform.notesRegisterFileFromMdLink === 'function') {
                await platform.notesRegisterFileFromMdLink(message.payload, message.parentId ?? null, message.index ?? 0, sender);
            }
            break;
        }
        // FR-TF-10 menu
        case 'revealTreeFileInOS': {
            if (typeof platform.revealTreeFileInOS === 'function') {
                await platform.revealTreeFileInOS(message.id, sender);
            }
            break;
        }
        case 'copyTreeFilePath': {
            if (typeof platform.copyTreeFilePath === 'function') {
                await platform.copyTreeFilePath(message.id, sender);
            }
            break;
        }
        case 'deleteTreeFile': {
            if (typeof platform.deleteTreeFile === 'function') {
                await platform.deleteTreeFile(message.id, sender);
            }
            break;
        }
        // FR-TF-01 (§4a): 外部 D&D の明示通知
        case 'notifyError': {
            platform.notifyError?.(String(message.message ?? ''));
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
            // .out ではなく page md を履歴に記録する（下の openPageInSidePanel 箇所で recordFileHistory・note-md 絶対パス）。

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
                    fileManager.recordFileHistory(pagePath); // ★reopen 2026-07-23: page md も note-md（絶対パス）で統一記録
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
            // Node/out link — navigate to note + outliner (+ node if nodeId)
            fileManager.flushSave();
            const navFilePath = fileManager.getFilePathById(message.outFileId);
            if (!navFilePath) break;
            // FR-B11: md link は navigateToLink が mdFilePath 解決 → webview の notesOpenFile 経路で
            // 開くためここには来ない。万一 md id が流れても JSON.parse に落とさないガード
            if (navFilePath.endsWith('.md')) break;
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
                        message: 'AWS credentials not configured. Set fractal.transAccessKeyId and transSecretAccessKey in settings.',
                        // FR-TR-02 (sprint 20260803-013547): 要求元識別を透過エコーバック
                        // （sidepanel md 要求なら sidePanelFilePath 付き / main 要求なら undefined）。
                        sidePanelFilePath: message.sidePanelFilePath
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
                        targetLang: result.targetLang,
                        // FR-TR-02: 要求元識別を透過エコーバック。
                        sidePanelFilePath: message.sidePanelFilePath
                    });
                } catch (err: any) {
                    const errMsg = err?.message || String(err);
                    console.error('[Translate] Error:', errMsg, err?.stack || '');
                    sender.postMessage({
                        type: 'translateError',
                        message: errMsg,
                        // FR-TR-02: 要求元識別を透過エコーバック。
                        sidePanelFilePath: message.sidePanelFilePath
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

// ═══════════════════════════════════════════════════════════════════════════
// FR-TF: tree file item（ext:'file'）D&D の pure-fs seam 関数群
//
// notesEditorProvider.ts の platform ハンドラ（openNotesFolder() 内の巨大クロージャ）は
// provider+webviewPanel+document なしに直接 unit 起動できない（designer_failures 2026-08-07
// の seam 抽出方針）。ここに DI（fileManager / sender を引数）で pure-fs ロジックを export し、
// provider の薄い wrapper がこれを呼ぶ。unit（notetree-file-dnd-host.spec.ts）はこの seam を直接叩く。
//
// 契約（ADRL-B / 所有移し替え・§4y/§4z）:
//  - files/ 実体は「不動」が既定（.out import / md attach = リンク/相対パスで指すだけ・コピーしない）
//  - 衝突解決は必ず shared generateUniqueFileNamePreserving（§4z。local shadow / global replace 禁止）
//  - リンク生成時の title は `]`→`］`・改行→空白（§4y。filename 側は NotesFileManager.sanitizeTreeFileName）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * §4y: files/ 添付を markdown リンクにする際の書式生成。
 * title（alt スロット）の label 終端衝突文字 `]`→`］` + 改行→空白。`[` は parser 上無害なので保持。
 * relPath（url スロット）は呼び出し側で sanitize 済み filename から組んだ相対パスを渡す。
 */
export function buildFileLinkMarkdown(title: string, relPath: string): string {
    const safeTitle = String(title || '').replace(/\]/g, '］').replace(/[\r\n]+/g, ' ');
    return `[📎 ${safeTitle}](${relPath})`;
}

/** file item id → .out の絶対パス解決（id / path のどちらで渡されても解決する） */
function resolveOutPathRef(fileManager: NotesFileManager, ref: string): string | null {
    if (typeof ref === 'string' && ref.endsWith('.out') && fs.existsSync(ref)) { return ref; }
    try {
        const p = fileManager.getFilePathById(ref);
        if (p && p.endsWith('.out') && fs.existsSync(p)) { return p; }
    } catch { /* ignore */ }
    return null;
}

/**
 * raw structure insert（コピーなしで既存 files/ 実体を tree file item として登録する）。
 * NotesFileManager.registerTreeFile は必ず sanitize+uniquify+実体 write するため無コピー登録に使えない
 * （registerExistingMdFile :1742 と同型の raw insert precedent をミラー）。§4e branch A / §4g で使用。
 */
function rawInsertTreeFileEntry(
    fileManager: NotesFileManager,
    filename: string,
    title: string,
    parentId: string | null,
    index: number
): string {
    const id = NotesFileManager.generateOutlineId();
    const structure: any = fileManager.getStructure();
    structure.items[id] = { type: 'file', id, title: title || filename, ext: 'file', filename };
    const parent = parentId ? structure.items[parentId] : null;
    const siblings: string[] = parent && parent.type === 'folder' ? parent.childIds : structure.rootIds;
    const safeIndex = Math.max(0, Math.min(index, siblings.length));
    siblings.splice(safeIndex, 0, id);
    fileManager.saveStructure();
    return id;
}

/**
 * §4y: attach 時（§4c/§4f = リンク文法を通す経路）に、違反名の実体を sanitize 名へリネームする。
 * tree item は排他所有中なのでリネーム安全。sanitize で変化が無ければ何もしない。
 * @returns 安全化後の filename / null（item が file でない）
 */
function ensureSafeTreeFileName(fileManager: NotesFileManager, id: string): string | null {
    const item: any = fileManager.getStructure().items[id];
    if (!item || item.type !== 'file' || item.ext !== 'file' || !item.filename) { return null; }
    const safe = NotesFileManager.sanitizeTreeFileName(item.filename);
    if (safe === item.filename) { return item.filename; }
    const filesDir = fileManager.getMdFilesDirPath();
    const oldPath = fileManager.getTreeFilePath(id);
    const uniqueSafe = generateUniqueFileNamePreserving(filesDir, safe);
    const newPath = path.join(filesDir, uniqueSafe);
    if (oldPath && fs.existsSync(oldPath) && path.resolve(oldPath) !== path.resolve(newPath)) {
        try { fs.mkdirSync(filesDir, { recursive: true }); } catch { /* ignore */ }
        try { fs.renameSync(oldPath, newPath); } catch { /* ignore */ }
    }
    item.filename = uniqueSafe;
    fileManager.saveStructure();
    return uniqueSafe;
}

/**
 * FR-TF-03 (§4b): tree file を .out item にドロップ。
 * .out root 先頭に file node（filePath=outDir 相対）を unshift し、tree エントリを除去（実体不動）。
 */
export function treeFileImportIntoOut(
    fileManager: NotesFileManager,
    sender: NotesSender,
    dragItemId: string,
    targetOutId: string
): void {
    try {
        const item: any = fileManager.getStructure().items[dragItemId];
        if (!item || item.type !== 'file' || item.ext !== 'file') { return; }
        const title = String(item.title || item.filename || 'file');
        const outPath = resolveOutPathRef(fileManager, targetOutId);
        if (!outPath) { return; }
        const fileAbs = fileManager.getTreeFilePath(dragItemId);
        if (!fileAbs || !fs.existsSync(fileAbs)) { return; }
        const relPath = path.relative(path.dirname(outPath), fileAbs).replace(/\\/g, '/');

        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        outData.nodes = outData.nodes || {};
        outData.rootIds = outData.rootIds || [];
        const newNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        outData.nodes[newNodeId] = {
            id: newNodeId, parentId: null, children: [], text: title, tags: [],
            isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: relPath,
        };
        outData.rootIds.unshift(newNodeId);
        fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf8');

        if (fileManager.getCurrentFilePath() === outPath) {
            fileManager.openFile(outPath);
            sender.postMessage({ type: 'updateData', kind: 'out', data: outData, fileChangeId: fileManager.getFileChangeId(), outFileKey: outPath });
        }
        fileManager.unregisterTreeFileFromStructureOnly(dragItemId);
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileImportIntoOut error:', e);
    }
}

/**
 * FR-TF-04 (§4c): tree file を md item にドロップ。対象 md 末尾に 📎 リンクを追記し tree 除去（実体不動）。
 * 違反名実体は attach 前に sanitize 名へリネーム（§4y）。
 */
export function treeFileAttachIntoMd(
    fileManager: NotesFileManager,
    sender: NotesSender,
    dragItemId: string,
    targetMdId: string
): void {
    try {
        const safeName = ensureSafeTreeFileName(fileManager, dragItemId);
        if (!safeName) { return; }
        const fileAbs = fileManager.getTreeFilePath(dragItemId);
        if (!fileAbs || !fs.existsSync(fileAbs)) { return; }
        const mdPath = fileManager.getFilePathById(targetMdId);
        if (!mdPath || !mdPath.endsWith('.md') || !fs.existsSync(mdPath)) { return; }
        const item: any = fileManager.getStructure().items[dragItemId];
        const title = String((item && item.title) || safeName);
        const relPath = path.relative(path.dirname(mdPath), fileAbs).replace(/\\/g, '/');
        const link = buildFileLinkMarkdown(title, relPath);
        const cur = fs.readFileSync(mdPath, 'utf8');
        const newContent = cur + (cur.endsWith('\n') ? '' : '\n') + link + '\n';
        writeFileIfChanged(mdPath, newContent);
        fileManager.unregisterTreeFileFromStructureOnly(dragItemId);
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileAttachIntoMd error:', e);
    }
}

/**
 * FR-TF-06a (§4f): tree file を開いている md editor へ添付。
 * main=currentFile / sidepanel=sidePanelFilePath 宛て。insertFileLink（markdownPath 相対・fileName=title）
 * を送り、webview 既存ハンドラが 📎 アンカーを挿入。main は sidePanelFilePath を付けない（誤送出防止）。
 */
/**
 * FR-TF-18 (§4l): drop 先 md が drag 元 note（fileManager の mainFolder）の外か判定する。
 * cross-note なら「dest note へ実体コピー + dest 相対リンク + 元台帳除去 + 元実体温存」
 * （= cmd+x cross 貼りの source orphan 契約。ADRL-D）。跨ぎ ../ リンクは cleanup の
 * safeResolveUnderDir が棄却して実体を保護できないため絶対に書かない。
 */
export function isCrossNoteDrop(srcMainFolder: string, destMdAbsPath: string): boolean {
    const rel = path.relative(path.resolve(srcMainFolder), path.resolve(destMdAbsPath));
    return rel.startsWith('..') || path.isAbsolute(rel);
}

/**
 * FR-TF-18 (§4l): file 実体を dest md の note へ必要ならコピーし、dest md からの相対リンクパスを返す。
 * 同一 note なら実体不動で従来の相対化のみ（所有の移し替え）。
 * @returns insertFileLink に使う markdownPath（cross-note でコピー失敗なら null = 中断）
 */
function resolveAttachTargetPath(
    fileManager: NotesFileManager,
    fileAbs: string,
    destMdAbs: string
): string | null {
    if (!isCrossNoteDrop(fileManager.getMainFolderPath(), destMdAbs)) {
        return path.relative(path.dirname(destMdAbs), fileAbs).replace(/\\/g, '/');
    }
    // cross-note: dest note の files/ へコピー（§4y/§4z 合流 — copyTreeFileEntityTo）
    const destMainFolder = path.dirname(resolveFilesDirForMd(destMdAbs));
    const dstName = NotesFileManager.copyTreeFileEntityTo(fileAbs, destMainFolder);
    if (!dstName) { return null; }
    const dstAbs = path.join(resolveFilesDirForMd(destMdAbs), dstName);
    return path.relative(path.dirname(destMdAbs), dstAbs).replace(/\\/g, '/');
}

/**
 * FR-B09/TASK-17 + FR-TF-18 (§4l): tree md item → sidepanel md D&D の解決 seam（provider クロージャから抽出）。
 * 同一 note → コピーせず相対リンク + tree 除去（所有の移し替え）。
 * 別 note → sidepanel md の隣へ複製 + **tree 除去**（FR-TF-18 = cmd+x source orphan 契約。
 * 元 md 実体は温存 = orphan 化し元 note の Clean Notes が回収。旧挙動「元 tree item 温存」は再オープン⑤で変更）。
 */
export function linkMdAsSubpageForSidePanelCore(
    fileManager: NotesFileManager,
    sender: NotesSender,
    filePath: string,
    mdFileId: string | null,
    sidePanelFilePath: string
): void {
    if (!sidePanelFilePath || !sidePanelFilePath.endsWith('.md')) { return; }
    if (!fs.existsSync(filePath)) { return; }
    if (path.resolve(filePath) === path.resolve(sidePanelFilePath)) { return; }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const crossNote = isCrossNoteDrop(fileManager.getMainFolderPath(), sidePanelFilePath);
        let markdownPath: string;
        let title: string;
        if (crossNote) {
            const r = saveDroppedMdAsSubpage(sidePanelFilePath, content, path.basename(filePath));
            markdownPath = r.relPath;
            title = r.title;
        } else {
            markdownPath = path.relative(path.dirname(sidePanelFilePath), filePath).replace(/\\/g, '/');
            title = resolveSubpageTitle(content, path.basename(filePath));
        }
        sender.postMessage({ type: 'insertSubpageLink', markdownPath, title, sidePanelFilePath });
        // FR-TF-18: 同一 note / 別 note とも元 tree item を除去（別 note の md 実体は温存 = orphan）
        if (mdFileId) {
            fileManager.unregisterMdFromStructureOnly(mdFileId);
            sendFileListWithStructure(fileManager, sender);
        }
    } catch (e) {
        console.error('[Notes] linkMdAsSubpageForSidePanelCore error:', e);
    }
}

/**
 * FR-TF-19 (§4m): outliner 📎 file node → md editor 添付。
 * node.filePath を outDir 基準 clamp → dest md へ 📎 リンク挿入（cross-note は §4l = dest コピー）→
 * 元 node の後始末（FR-TF-05b 規約: 子なし削除 / 子あり filePath null 化）。元実体は温存（source orphan 契約）。
 */
export function attachOutNodeFileToMd(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { outFileKey: string; nodeId: string },
    sidePanelFilePath?: string | null
): void {
    try {
        if (!payload || !payload.outFileKey || !payload.nodeId) { return; }
        const target = sidePanelFilePath ? sidePanelFilePath : fileManager.getCurrentFilePath();
        if (!target || !target.endsWith('.md')) { return; }
        const outPath = resolveOutPathRef(fileManager, payload.outFileKey);
        if (!outPath) { return; }
        const outDir = path.dirname(outPath);
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const node = outData.nodes && outData.nodes[payload.nodeId];
        if (!node || !node.filePath) { return; }
        const fileAbs = safeResolveUnderDir(outDir, node.filePath);
        if (!fileAbs || !fs.existsSync(fileAbs)) { return; }
        const title = String(node.text || path.basename(fileAbs));
        const markdownPath = resolveAttachTargetPath(fileManager, fileAbs, target);
        if (markdownPath === null) { return; }
        const msg: Record<string, unknown> = { type: 'insertFileLink', markdownPath, fileName: title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        // 元 node の後始末（treeFileRegisterFromOutNode と同一規約）
        if (!node.children || node.children.length === 0) {
            delete outData.nodes[payload.nodeId];
            if (Array.isArray(outData.rootIds)) {
                outData.rootIds = outData.rootIds.filter((id: string) => id !== payload.nodeId);
            }
            const parentNode = node.parentId ? outData.nodes[node.parentId] : null;
            if (parentNode && Array.isArray(parentNode.children)) {
                parentNode.children = parentNode.children.filter((id: string) => id !== payload.nodeId);
            }
        } else {
            node.filePath = null;
        }
        fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf8');
        if (fileManager.getCurrentFilePath() === outPath) {
            fileManager.openFile(outPath);
            sender.postMessage({ type: 'updateData', kind: 'out', data: outData, fileChangeId: fileManager.getFileChangeId(), outFileKey: outPath });
        }
    } catch (e) {
        console.error('[Notes] attachOutNodeFileToMd error:', e);
    }
}

/**
 * FR-TF-19 (§4m): outliner page node → md editor に subpage リンク挿入。
 * page md を解決（resolvePagesDir + clamp）→ dest md へ insertSubpageLink（cross-note = dest 隣へ複製 = §4l。
 * 同一 note = 相対リンク）→ 元 page node は notesImportOutPageNodeAsMd と同じ「page 属性クリア・node 温存」。
 * 元 page md 実体は温存（source orphan 契約）。
 */
export function importOutPageNodeToMd(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { outFileKey: string; nodeId: string; pageId: string; title?: string },
    sidePanelFilePath?: string | null
): void {
    try {
        if (!payload || !payload.outFileKey || !payload.pageId || !payload.nodeId) { return; }
        const target = sidePanelFilePath ? sidePanelFilePath : fileManager.getCurrentFilePath();
        if (!target || !target.endsWith('.md')) { return; }
        const outPath = resolveOutPathRef(fileManager, payload.outFileKey);
        if (!outPath) { return; }
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const pagesDir = resolvePagesDir(outPath, fileManager.getMainFolderPath(), {
            pageDir: outData.pageDir, imageDir: outData.imageDir, fileDir: outData.fileDir,
        });
        const srcMdPath = safeResolveUnderDir(pagesDir, `${payload.pageId}.md`);
        if (!srcMdPath || !fs.existsSync(srcMdPath)) { return; }
        const content = fs.readFileSync(srcMdPath, 'utf8');
        const h1 = extractFirstH1(content); // CommonMark 準拠（inline 正規表現は `# C#` を切り捨てる既知バグクラス — extractFirstH1 が正典）
        const title = (h1 || payload.title || 'Untitled').trim();
        let markdownPath: string;
        if (isCrossNoteDrop(fileManager.getMainFolderPath(), target)) {
            const r = saveDroppedMdAsSubpage(target, content, path.basename(srcMdPath));
            markdownPath = r.relPath;
        } else {
            markdownPath = path.relative(path.dirname(target), srcMdPath).replace(/\\/g, '/');
        }
        const msg: Record<string, unknown> = { type: 'insertSubpageLink', markdownPath, title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        // 元 page node の後始末（notesImportOutPageNodeAsMd と同一: page 属性クリア・node/children 温存）
        const node = outData.nodes && outData.nodes[payload.nodeId];
        if (node) {
            node.isPage = false;
            node.pageId = null;
            node.text = '';
            node.images = [];
            fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf8');
            if (fileManager.getCurrentFilePath() === outPath) {
                fileManager.openFile(outPath);
                sender.postMessage({ type: 'updateData', kind: 'out', data: outData, fileChangeId: fileManager.getFileChangeId(), outFileKey: outPath });
            }
        }
    } catch (e) {
        console.error('[Notes] importOutPageNodeToMd error:', e);
    }
}

/**
 * FR-TF-19 (§4m): md 📎 file リンク → 別の md editor へ添付移動。
 * href を resolveFilesDirForMd(sourceMdPath) 基準 clamp → dest md へ 📎 リンク挿入
 * （cross-note = dest コピー §4l）→ 元 md からアンカー除去（removeFileLink）。元実体は温存。
 */
export function attachMdFileLinkToMd(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { href: string; sourceMdPath: string },
    sidePanelFilePath?: string | null
): void {
    try {
        if (!payload || !payload.href || !payload.sourceMdPath) { return; }
        const target = sidePanelFilePath ? sidePanelFilePath : fileManager.getCurrentFilePath();
        if (!target || !target.endsWith('.md')) { return; }
        if (path.resolve(payload.sourceMdPath) === path.resolve(target)) { return; } // self-drop 防御（webview と二重）
        const filesDir = resolveFilesDirForMd(payload.sourceMdPath);
        let decoded: string;
        try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
        const abs = path.resolve(path.dirname(payload.sourceMdPath), decoded);
        const rel = path.relative(filesDir, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return; }
        if (!fs.existsSync(abs)) { return; }
        const title = path.basename(abs);
        // cross-note 判定は source md の note 基準（fileManager は drag 元 note を持つとは限らないため
        // src md の位置から note を導出して比較する）
        const srcMainFolder = path.dirname(filesDir);
        let markdownPath: string;
        if (isCrossNoteDrop(srcMainFolder, target)) {
            const destMainFolder = path.dirname(resolveFilesDirForMd(target));
            const dstName = NotesFileManager.copyTreeFileEntityTo(abs, destMainFolder);
            if (!dstName) { return; }
            const dstAbs = path.join(resolveFilesDirForMd(target), dstName);
            markdownPath = path.relative(path.dirname(target), dstAbs).replace(/\\/g, '/');
        } else {
            markdownPath = path.relative(path.dirname(target), abs).replace(/\\/g, '/');
        }
        const msg: Record<string, unknown> = { type: 'insertFileLink', markdownPath, fileName: title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        sender.postMessage({ type: 'removeFileLink', href: payload.href, sourceMdPath: payload.sourceMdPath });
    } catch (e) {
        console.error('[Notes] attachMdFileLinkToMd error:', e);
    }
}

/**
 * FR-TF-19 (§4m): md subpage リンク → 別の md editor へ移動。
 * href を source md 基準で解決 → dest md へ insertSubpageLink（cross-note = dest 隣へ複製 §4l）→
 * 元 md からアンカー除去（removeSubpageLink）。元 md 実体は温存（source orphan 契約）。
 */
export function linkMdSubpageToMd(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { href: string; sourceMdPath: string; title?: string },
    sidePanelFilePath?: string | null
): void {
    try {
        if (!payload || !payload.href || !payload.sourceMdPath) { return; }
        const target = sidePanelFilePath ? sidePanelFilePath : fileManager.getCurrentFilePath();
        if (!target || !target.endsWith('.md')) { return; }
        if (path.resolve(payload.sourceMdPath) === path.resolve(target)) { return; }
        let decoded: string;
        try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
        // subpage md は source md の note 内に限る（note 外への相対 href は拒否）
        const srcMainFolder = path.dirname(resolveFilesDirForMd(payload.sourceMdPath));
        const abs = safeResolveUnderDir(srcMainFolder, path.relative(srcMainFolder, path.resolve(path.dirname(payload.sourceMdPath), decoded)));
        if (!abs || !abs.endsWith('.md') || !fs.existsSync(abs)) { return; }
        if (path.resolve(abs) === path.resolve(target)) { return; } // リンク先 = drop 先 md の自己参照防止
        const content = fs.readFileSync(abs, 'utf8');
        const h1 = extractFirstH1(content); // CommonMark 準拠（inline 正規表現は `# C#` を切り捨てる既知バグクラス — extractFirstH1 が正典）
        const title = (h1 || payload.title || path.basename(abs)).trim();
        let markdownPath: string;
        if (isCrossNoteDrop(srcMainFolder, target)) {
            const r = saveDroppedMdAsSubpage(target, content, path.basename(abs));
            markdownPath = r.relPath;
        } else {
            markdownPath = path.relative(path.dirname(target), abs).replace(/\\/g, '/');
        }
        const msg: Record<string, unknown> = { type: 'insertSubpageLink', markdownPath, title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        sender.postMessage({ type: 'removeSubpageLink', href: payload.href, sourceMdPath: payload.sourceMdPath });
    } catch (e) {
        console.error('[Notes] linkMdSubpageToMd error:', e);
    }
}

export function treeFileAttachToMdEditor(
    fileManager: NotesFileManager,
    sender: NotesSender,
    id: string,
    sidePanelFilePath?: string | null
): void {
    try {
        const safeName = ensureSafeTreeFileName(fileManager, id);
        if (!safeName) { return; }
        const fileAbs = fileManager.getTreeFilePath(id);
        if (!fileAbs || !fs.existsSync(fileAbs)) { return; }
        const target = sidePanelFilePath ? sidePanelFilePath : fileManager.getCurrentFilePath();
        if (!target) { return; }
        const item: any = fileManager.getStructure().items[id];
        const title = String((item && item.title) || safeName);
        // FR-TF-18: cross-note は dest note へ実体コピー（元実体は温存 = source orphan 契約）
        const markdownPath = resolveAttachTargetPath(fileManager, fileAbs, target);
        if (markdownPath === null) { return; } // コピー失敗 — 台帳を触らず中断
        const msg: Record<string, unknown> = { type: 'insertFileLink', markdownPath, fileName: title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        fileManager.unregisterTreeFileFromStructureOnly(id);
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileAttachToMdEditor error:', e);
    }
}

/**
 * FR-TF-05a (§4d): tree file を outliner の node 位置に D&D。
 * getTreeFilePath → outDir 相対化 → dropFilesResult 互換 shape を単一 postback（既存 file kind 処理が node 化）。
 * 挿入位置は webview が解決した targetNodeId/position をそのまま返す。tree エントリ除去（実体不動）。
 */
/**
 * FR-TF-14 (§4i(3) 2026-08-10): .out データへ新規 node を drop 位置（before/after/child）で挿入する
 * pure seam。targetNodeId が無い / position が不明なら従来どおり rootIds 先頭 unshift（後方互換）。
 * notesImportMdIntoOut（page node）が使用。node は呼び出し側が outData.nodes に登録済みであること。
 */
export function insertNodeAtDropPosition(
    outData: { nodes: Record<string, any>; rootIds: string[] },
    newNodeId: string,
    targetNodeId: string | null | undefined,
    position: string | null | undefined
): void {
    const newNode = outData.nodes[newNodeId];
    const target = targetNodeId ? outData.nodes[targetNodeId] : null;
    if (target && position === 'child') {
        newNode.parentId = target.id;
        target.children = target.children || [];
        target.children.unshift(newNodeId);
        return;
    }
    if (target && (position === 'before' || position === 'after')) {
        newNode.parentId = target.parentId || null;
        const siblings: string[] = target.parentId && outData.nodes[target.parentId]
            ? (outData.nodes[target.parentId].children = outData.nodes[target.parentId].children || [])
            : outData.rootIds;
        const ti = siblings.indexOf(targetNodeId as string);
        const at = ti === -1 ? siblings.length : (position === 'before' ? ti : ti + 1);
        siblings.splice(at, 0, newNodeId);
        return;
    }
    outData.rootIds.unshift(newNodeId);
}

export function treeFileImportAtPosition(
    fileManager: NotesFileManager,
    sender: NotesSender,
    id: string,
    outFileId: string,
    targetNodeId: string | null,
    position: string | null
): void {
    try {
        const item: any = fileManager.getStructure().items[id];
        if (!item || item.type !== 'file' || item.ext !== 'file') { return; }
        const title = String(item.title || item.filename || 'file');
        const fileAbs = fileManager.getTreeFilePath(id);
        if (!fileAbs || !fs.existsSync(fileAbs)) { return; }
        const outPath = resolveOutPathRef(fileManager, outFileId);
        const baseDir = outPath ? path.dirname(outPath) : fileManager.getMainFolderPath();
        const relPath = path.relative(baseDir, fileAbs).replace(/\\/g, '/');
        sender.postMessage({
            type: 'dropFilesResult',
            results: [{ kind: 'file', ok: true, title, filePath: relPath }],
            targetNodeId: targetNodeId ?? null,
            position: position ?? null,
        });
        fileManager.unregisterTreeFileFromStructureOnly(id);
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileImportAtPosition error:', e);
    }
}

/**
 * FR-TF-20 (§4n): md 📎 file リンク → outliner の drop 位置に file 添付 node として取込。
 * href を source md 基準 clamp → cross-note なら dest note（.out の note = fileManager）の files/ へコピー（§4l）→
 * dropFilesResult 互換 postback（webview 既存処理が node 化）→ 元 md からアンカー除去。元実体温存。
 */
export function importMdFileLinkIntoOut(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { href: string; sourceMdPath: string },
    outFileId: string,
    targetNodeId: string | null,
    position: string | null
): void {
    try {
        if (!payload || !payload.href || !payload.sourceMdPath) { return; }
        const filesDir = resolveFilesDirForMd(payload.sourceMdPath);
        let decoded: string;
        try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
        const abs = path.resolve(path.dirname(payload.sourceMdPath), decoded);
        const rel = path.relative(filesDir, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return; }
        if (!fs.existsSync(abs)) { return; }
        const srcMainFolder = path.dirname(filesDir);
        let entityAbs = abs;
        // isCrossNoteDrop の第 2 引数は「dest 側の note 内の任意パス」でよい（比較は note フォルダのみ・
        // ファイル名は不使用）。drop 先は .out で md パスが無いため mainFolder 直下のダミー名で判定する。
        if (isCrossNoteDrop(srcMainFolder, path.join(fileManager.getMainFolderPath(), '__dest__.md'))) {
            // drop 先 .out の note（= fileManager の note）が src md の note と別 → dest files/ へコピー
            const dstName = NotesFileManager.copyTreeFileEntityTo(abs, fileManager.getMainFolderPath());
            if (!dstName) { return; }
            entityAbs = path.join(fileManager.getMdFilesDirPath(), dstName);
        }
        const outPath = resolveOutPathRef(fileManager, outFileId);
        const baseDir = outPath ? path.dirname(outPath) : fileManager.getMainFolderPath();
        const relPath = path.relative(baseDir, entityAbs).replace(/\\/g, '/');
        sender.postMessage({
            type: 'dropFilesResult',
            results: [{ kind: 'file', ok: true, title: path.basename(entityAbs), filePath: relPath }],
            targetNodeId: targetNodeId ?? null,
            position: position ?? null,
        });
        sender.postMessage({ type: 'removeFileLink', href: payload.href, sourceMdPath: payload.sourceMdPath });
    } catch (e) {
        console.error('[Notes] importMdFileLinkIntoOut error:', e);
    }
}

/**
 * FR-TF-20 (§4n): md subpage リンク → outliner の drop 位置に page node として取込。
 * 取込は既存 notesImportMdIntoOut と同じ「md → page node」だが、対象 md は tree item でなく
 * source md からの相対 href で解決する。同一 note = md をそのまま page 化（コピーなし・md は
 * mainFolder 直下 flat 前提）/ cross-note = dest note へ複製してから page 化。元 md からアンカー除去。
 */
export function importMdSubpageIntoOut(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { href: string; sourceMdPath: string; title?: string },
    outFileId: string,
    targetNodeId: string | null,
    position: string | null
): void {
    try {
        if (!payload || !payload.href || !payload.sourceMdPath) { return; }
        let decoded: string;
        try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
        const srcMainFolder = path.dirname(resolveFilesDirForMd(payload.sourceMdPath));
        const abs = safeResolveUnderDir(srcMainFolder, path.relative(srcMainFolder, path.resolve(path.dirname(payload.sourceMdPath), decoded)));
        if (!abs || !abs.endsWith('.md') || !fs.existsSync(abs)) { return; }
        const outPath = resolveOutPathRef(fileManager, outFileId);
        if (!outPath) { return; }
        const content = fs.readFileSync(abs, 'utf8');
        const h1 = extractFirstH1(content); // CommonMark 準拠（inline 正規表現は `# C#` を切り捨てる既知バグクラス — extractFirstH1 が正典）
        const title = (h1 || payload.title || path.basename(abs, '.md')).trim();
        // page md を dest note に確定（同一 note = 既存 md をそのまま / cross-note = 複製）
        let pageMdAbs = abs;
        if (isCrossNoteDrop(srcMainFolder, outPath)) {
            const destDir = fileManager.getMainFolderPath();
            const unique = generateUniqueFileNamePreserving(destDir, path.basename(abs));
            pageMdAbs = path.join(destDir, unique);
            fs.copyFileSync(abs, pageMdAbs);
        }
        const pageId = path.basename(pageMdAbs, '.md');
        // .out へ page node 挿入（insertNodeAtDropPosition seam = FR-TF-14 と同じ）
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const newNodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        outData.nodes = outData.nodes || {};
        outData.nodes[newNodeId] = {
            id: newNodeId, parentId: null, children: [], text: title, tags: [],
            isPage: true, pageId, collapsed: false, checked: null, subtext: '', images: [], filePath: null,
        };
        insertNodeAtDropPosition(outData, newNodeId, targetNodeId, position);
        fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf8');
        if (fileManager.getCurrentFilePath() === outPath) {
            fileManager.openFile(outPath);
            sender.postMessage({ type: 'updateData', kind: 'out', data: outData, fileChangeId: fileManager.getFileChangeId(), outFileKey: outPath });
        }
        sender.postMessage({ type: 'removeSubpageLink', href: payload.href, sourceMdPath: payload.sourceMdPath });
    } catch (e) {
        console.error('[Notes] importMdSubpageIntoOut error:', e);
    }
}

/**
 * FR-TF-05b (§4e): outliner の file 添付 node をツリーへ D&D。
 * node.filePath を outDir 基準で clamp 解決 → 共有 files/ 配下なら無コピー登録（basename）/
 * legacy 配下なら files/ へ copy + §4z uniquify 登録 → 元 node.filePath を null 化（所有移し替え）。
 */
export function treeFileRegisterFromOutNode(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { outFileKey: string; nodeId: string },
    parentId: string | null,
    index: number
): void {
    try {
        if (!payload || !payload.outFileKey || !payload.nodeId) { return; }
        const outPath = resolveOutPathRef(fileManager, payload.outFileKey);
        if (!outPath) { return; }
        const outDir = path.dirname(outPath);
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const node = outData.nodes && outData.nodes[payload.nodeId];
        if (!node || !node.filePath) { return; }
        // node.filePath は outDir 基準の相対（or 絶対）→ traversal clamp（files/ 外 escape 防御）
        const abs = safeResolveUnderDir(outDir, node.filePath);
        if (!abs || !fs.existsSync(abs)) { return; }
        const filesDir = fileManager.getMdFilesDirPath();
        const relToFiles = path.relative(filesDir, abs);
        const underFiles = !!relToFiles && !relToFiles.startsWith('..') && !path.isAbsolute(relToFiles);
        let filename: string;
        if (underFiles) {
            // 既に共有 files/ 配下 → 無コピーでそのまま登録（1:1 所有を node → tree item へ移す）
            filename = path.basename(abs);
        } else {
            // legacy per-id dir 等 → files/ へ copy + §4z uniquify
            try { fs.mkdirSync(filesDir, { recursive: true }); } catch { /* ignore */ }
            const sanitized = NotesFileManager.sanitizeTreeFileName(path.basename(abs));
            filename = generateUniqueFileNamePreserving(filesDir, sanitized);
            fs.copyFileSync(abs, path.join(filesDir, filename));
        }
        const title = String(node.text || filename);
        rawInsertTreeFileEntry(fileManager, filename, title, parentId, index);

        // FR-TF-05b 改訂（2026-08-10）: 子なし node は node ごと削除（「添付が外れたファイル名テキスト node」の残留防止）。
        // 子を持つ node のみ filePath null 化で温存（子の喪失防止）。
        if (!node.children || node.children.length === 0) {
            delete outData.nodes[payload.nodeId];
            if (Array.isArray(outData.rootIds)) {
                outData.rootIds = outData.rootIds.filter((id: string) => id !== payload.nodeId);
            }
            const parentNode = node.parentId ? outData.nodes[node.parentId] : null;
            if (parentNode && Array.isArray(parentNode.children)) {
                parentNode.children = parentNode.children.filter((id: string) => id !== payload.nodeId);
            }
        } else {
            node.filePath = null;
        }
        fs.writeFileSync(outPath, JSON.stringify(outData, null, 2), 'utf8');
        if (fileManager.getCurrentFilePath() === outPath) {
            fileManager.openFile(outPath);
            sender.postMessage({ type: 'updateData', kind: 'out', data: outData, fileChangeId: fileManager.getFileChangeId(), outFileKey: outPath });
        }
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileRegisterFromOutNode error:', e);
    }
}

/**
 * FR-TF-06b (§4g): md editor 内の 📎 file リンクをツリーへ D&D。
 * href を resolveFilesDirForMd(sourceMdPath) 基準で clamp（traversal は登録も removeFileLink もせず中断）→
 * 無コピー登録 → 元 md の該当アンカー除去（removeFileLink）。
 */
export function treeFileRegisterFromMdLink(
    fileManager: NotesFileManager,
    sender: NotesSender,
    payload: { href: string; sourceMdPath: string },
    parentId: string | null,
    index: number
): void {
    try {
        if (!payload || !payload.href || !payload.sourceMdPath) { return; }
        const filesDir = resolveFilesDirForMd(payload.sourceMdPath);
        // href は md 隣 files/ への相対（`files/<name>`）。decode 後に clamp（%2F traversal を復号後に弾く）
        let decoded: string;
        try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
        const abs = path.resolve(path.dirname(payload.sourceMdPath), decoded);
        // filesDir 配下に収まるかを path.relative で判定（.. / 絶対化は拒否）
        const rel = path.relative(filesDir, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return; }
        if (!fs.existsSync(abs)) { return; }
        const filename = path.basename(abs);
        rawInsertTreeFileEntry(fileManager, filename, filename, parentId, index);
        sender.postMessage({ type: 'removeFileLink', href: payload.href, sourceMdPath: payload.sourceMdPath });
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileRegisterFromMdLink error:', e);
    }
}

/**
 * FR-TF-01 (§4a): 外部 D&D の 1 ファイルを tree file item として登録する。
 * bytes は base64。50MB 超は decode 前に長さから推定して skip + notify（巨大 Buffer alloc を避ける）。
 * kind!=='file' は従来 md 経路が扱うため null を返す。衝突解決は registerTreeFile 内の shared uniquify。
 * @returns 登録した item id / null（md・skip・不正）
 */
export function registerExternalDroppedFileItem(
    fileManager: NotesFileManager,
    item: { kind: string; name: string; bytes?: string },
    parentId: string | null,
    index: number,
    notify?: (name: string) => void
): string | null {
    if (!item || item.kind !== 'file') { return null; }
    const b64 = typeof item.bytes === 'string' ? item.bytes : '';
    const estimate = Math.floor(b64.length * 3 / 4);
    if (estimate > 50 * 1024 * 1024) {
        if (typeof notify === 'function') { notify(item.name); }
        return null;
    }
    const buf = Buffer.from(b64, 'base64');
    return fileManager.registerTreeFile(item.name, item.name, parentId, index, buf);
}

/**
 * FR-TF-17 (§4k): VS Code Explorer uri-list drop の uris[] を host fs 直読みで tree に登録する。
 * webview は URI を送るだけ（FileReader 非経由 → 50MB cap なし = ADRL-C Decision 2。
 * buffered 経路の cap は webview メモリ保護が根拠で、host 直読みには該当しない）。
 * - file: scheme のみ（vscode-remote:// 等は skip — outliner v12 = drop-import.ts と同じ規約）
 * - 不存在 / ディレクトリは skip
 * - `.md`（case-insensitive）→ registerMarkdownFile（title は H1 / stem = 既存 md 経路と同一）
 * - その他 → registerTreeFile（sanitize §4y + uniquify §4z は registerTreeFile 内蔵に合流）
 * - 挿入は uri 列挙順に index 連番（skip は index を消費しない）・postback は登録 ≥1 件で 1 回
 */
export function registerExternalDroppedUris(
    fileManager: NotesFileManager,
    uris: string[],
    parentId: string | null,
    index: number,
    sender: NotesSender
): void {
    if (!Array.isArray(uris) || uris.length === 0) { return; }
    let registered = 0;
    for (const uri of uris) {
        try {
            const parsed = new URL(uri);
            if (parsed.protocol !== 'file:') { continue; }
            const fsPath = url.fileURLToPath(uri);
            if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isFile()) { continue; }
            const name = path.basename(fsPath);
            if (/\.md$/i.test(name)) {
                const content = fs.readFileSync(fsPath, 'utf8');
                const title = resolveSubpageTitle(content, name);
                fileManager.registerMarkdownFile(content, title, parentId, index + registered);
                registered++;
            } else {
                const buf = fs.readFileSync(fsPath);
                fileManager.registerTreeFile(name, name, parentId, index + registered, buf);
                registered++;
            }
        } catch (e) {
            console.error('[Notes] registerExternalDroppedUris skip:', uri, e);
        }
    }
    if (registered > 0) {
        sendFileListWithStructure(fileManager, sender);
    }
}
