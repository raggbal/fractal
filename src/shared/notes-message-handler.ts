import * as fs from 'fs';
import * as path from 'path';
import { NotesFileManager } from './notes-file-manager';
import { resolveSubpageTitle, saveDroppedMdAsSubpage } from './md-subpage-utils';
import { importMdFiles } from './markdown-import';
import { OutlinerClipboardStore } from './outliner-clipboard-store';
import * as crypto from 'crypto';
import { handlePageAssets, handleImageAssets, handleFileAsset, copyImageAssets, moveImageAssets, resolveCrossPasteCut, runMdIntoOutlinerPaste, generateUniqueFileNamePreserving, copyEntityWithUniquify, transferMdWithAssets, noteCoords, adjacentCoords, mdCoords, makeTransferCoords, TransferCoords, duplicateMdEntity } from './paste-asset-handler';
import { safeResolveUnderDir, safeResolveUnderFolderRoot } from './path-safety';
import { readFolderViewExpanded, saveFolderViewExpanded, readFolderViewShowHidden, saveFolderViewShowHidden } from './folderview-state';
import { isViewerTarget } from './viewer-target';
import { resolveFilesDir, resolveFilesDirForMd, resolveImagesDirForMd, resolvePagesDir } from './flat-layout';
import { handleExportMindmap } from './mindmap-export-host';
import { translateText, TRANSLATE_LANGUAGES } from './aws-translate';
import { processDropFilesImport, processDropVscodeUrisImport, DropImportItem, droppedUriToFsPath } from './drop-import';
import { setFirstH1, writeFileIfChanged, extractFirstH1 } from './md-h1-utils';
import { removeMdAnchorAndEcho } from './md-anchor-remove';
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
    /** FR-FV-07: viewer「OS で開く」フォールバック（fs パスを openExternal）— sprint 20260815-075428 */
    openViewerFallback?(filePath: string): void;
    // FR-FV-08: viewer ツールバー 4 アクション（sprint 20260815-075428 再オープン）。
    // 実 vscode API（openWith / clipboard / showSaveDialog）依存のため provider 側で実装する。
    /** 新しいタブで開く（kind → viewerViewType で customEditor を選択） */
    viewerOpenInNewTab?(filePath: string, kind?: string): void;
    /** ファイルの絶対パスをクリップボードへ */
    viewerCopyPath?(filePath: string): void;
    /** In-App link（fractal://note/{folder}/file/{id}）を md リンク形式でクリップボードへ */
    viewerCopyInAppLink?(filePath: string): void;
    /** 単品エクスポート（保存ダイアログ → コピー） */
    viewerExportFile?(filePath: string): void;
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
    /** FR-OCM-01 (sprint 20260818-183407): page/file 混在の統合パスコピー（entries = document order） */
    copyNodePaths?(entries: Array<{ kind: 'page'; pageId: string } | { kind: 'file'; nodeId: string }>, outFilePath: string, sender: NotesSender): void;
    /** FR-MDM-01 (sprint 20260818-183407): md リンクの Copy Path（normal=URL そのまま / md・file=絶対化 + clamp） */
    copyLinkPath?(href: string, kind: string, mdFilePath: string, sender: NotesSender): void;
    /** FR-MDM-03 (sprint 20260818-183407): md/subpage/file リンクだけフルパス化した md を clipboard へ */
    copyMdWithFullPaths?(markdown: string, mdFilePath: string, sender: NotesSender): void;
    /** FR-MDM-02 (sprint 20260818-183407): subpage/file リンクの実体複製（DuplicationCore）。結果は duplicateLinkEntityResult（destination echo back） */
    duplicateLinkEntity?(href: string, kind: string, mdFilePath: string, destination: string | undefined, sender: NotesSender): void;
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
    /** outliner node paste の添付複製 (sprint 20260727-124904)。nodes は Store が真実 (message.nodes は Store miss 時の fallback リスト用)。destination は結果の宛先札 (FR-PDB-01) */
    pasteOutlinerNodesWithAssets?(plainText: string, nodes: unknown[], sidePanelFilePath: string, destination?: string): void;
    /** HTML paste で MD に残った data:image/... を images/ に実体化し相対 path 化。destination は結果の宛先札 (FR-PDB-02) */
    extractDataUrlsInPastedMd?(markdown: string, sidePanelFilePath: string, destination?: string): void;
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
    /** FR-DS-05 rev.2: 検索 Files ヒット click — files/ 相対パスで外部起動（host 側 clamp 必須） */
    openNoteFilesExternal?(relPath: string, sender: NotesSender): Promise<void> | void;
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

    // ── FR-FLV: folder link CRUD（bridge 台帳 #1-5。実装本体は folderLink* export 関数） ──
    /** FR-FLV-01 (#1): showOpenDialog（フォルダ選択）→ ガード → 登録 */
    addFolderLink?(sender: NotesSender, parentId?: string | null): Promise<void> | void;
    /** FR-FTM-01 (sprint 20260818-183407): +file ボタン — showOpenDialog（複数・全拡張子）→ tree 登録 */
    addTreeFilesViaDialog?(sender: NotesSender): Promise<void> | void;
    /** FR-FTM-03 (sprint 20260818-183407): tree item（out/md/file）の Duplicate（DuplicationCore） */
    duplicateTreeItem?(itemId: string, sender: NotesSender): void;
    /** FR-FLV-04 (#2): リンク切れ再指定（showOpenDialog → ガード → folderPath 更新 → showFolderView 指示） */
    relinkFolderLink?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-06 (#3): Remove Link（台帳のみ除去・fs 一切非接触） */
    removeFolderLink?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-06 (#4): Rename（title のみ・実フォルダ名不変） */
    renameFolderLink?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-06 (#5a): Reveal in Finder（リンク先実フォルダ） */
    revealFolderLink?(id: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-06 (#5b): Copy Path（folderPath を OS clipboard へ — webview に返さない） */
    copyFolderLinkPath?(id: string, sender: NotesSender): Promise<void> | void;

    // ── FR-FLV: folder view fs 操作（bridge 台帳 #6-12。実装本体は folderView* export 関数） ──
    /** FR-FLV-11 (#6): 1 階層 list */
    folderViewList?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-12 (#7): 名前検索（cap + truncated） */
    folderViewSearch?(id: string, query: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-14/23 (#8): open 分岐（md/viewer/外部） */
    folderViewOpen?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;
    folderViewToggleHidden?(id: string, sender: NotesSender): Promise<void> | void;
    folderViewClosed?(id: string): void;
    /** FR-FLV-15 (#9): New Markdown / New Folder */
    folderViewCreate?(id: string, parentRelPath: string, kind: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-15 (#10): rename */
    folderViewRename?(id: string, relPath: string, newName: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-26 (#19): 開閉状態の保存（再オープン①） */
    folderViewStateSave?(id: string, expanded: string[], sender: NotesSender): Promise<void> | void;
    /** FR-FLV-15 (#11): delete（常に trash） */
    folderViewDelete?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;
    folderViewDuplicate?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-16 (#12): ビュー内移動（fs.rename） */
    folderViewMove?(id: string, srcRelPath: string, dstDirRelPath: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-15 (#17): エントリの Reveal in Finder */
    folderViewRevealEntry?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-15 (#18): エントリの Copy Path */
    folderViewCopyEntryPath?(id: string, relPath: string, sender: NotesSender): Promise<void> | void;

    // ── FR-FLV: 面間 D&D（bridge 台帳 #13-16。実装本体は folderViewMove* export 関数） ──
    /** FR-FLV-21 (#13): Note ツリー item → フォルダビュー移動 */
    folderViewMoveIn?(id: string, dstDirRelPath: string, srcKind: string, srcItemId: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-20 (#14): フォルダビュー → Note ツリー移動 */
    folderViewMoveToTree?(id: string, relPath: string, parentId: string | null, index: number, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-22 (#15): フォルダビュー → sidepanel md 移動 + リンク挿入 */
    folderViewMoveIntoMd?(id: string, relPath: string, targetMdPath: string, sender: NotesSender): Promise<void> | void;
    /** FR-FLV-24 (#16): sidepanel md アンカー → フォルダビュー移動 + リンク除去 */
    folderViewMoveFromMd?(id: string, dstDirRelPath: string, payload: { href: string; sourceMdPath: string; isSubpage?: boolean }, sender: NotesSender): Promise<void> | void;
}

/**
 * FR-FLV: folder link CRUD の VS Code 依存を注入する deps（unit テストは明示 recorder を渡す）。
 */
export interface FolderLinkDeps {
    showOpenDialog(options: any): Promise<Array<{ fsPath: string }> | undefined>;
    showInputBox(options: any): Promise<string | undefined>;
    showErrorMessage(message: string): void;
    showInformationMessage(message: string): void;
    executeCommand(command: string, arg: any): void;
    clipboardWriteText(text: string): void;
    uriFile(p: string): any;
    /** i18n 解決（未登録キーは undefined → 英語フォールバック） */
    t(key: string): string | undefined;
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

        // FR-MDM-01 (sprint 20260818-183407): md リンクの Copy Path
        case 'copyLinkPath': {
            if (message.sidePanelFilePath && message.href) {
                platform.copyLinkPath?.(message.href, message.kind || 'normal', message.sidePanelFilePath, sender);
            }
            break;
        }

        // FR-MDM-03 (sprint 20260818-183407): Copy (file link full path)
        case 'copyMdWithFullPaths': {
            if (message.sidePanelFilePath && message.markdown) {
                platform.copyMdWithFullPaths?.(message.markdown, message.sidePanelFilePath, sender);
            }
            break;
        }

        // FR-MDM-02 (sprint 20260818-183407): subpage/file リンクの Duplicate（実体複製）
        case 'duplicateLinkEntity': {
            if (message.sidePanelFilePath && message.href) {
                platform.duplicateLinkEntity?.(message.href, message.kind || 'md', message.sidePanelFilePath, message.destination, sender);
            }
            break;
        }

        // FR-OCM-01 (sprint 20260818-183407): page/file 混在の統合パスコピー
        case 'copyNodePaths': {
            const currentFilePath = fileManager.getCurrentFilePath();
            if (currentFilePath) {
                platform.copyNodePaths?.(message.entries || [], currentFilePath, sender);
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
                // FR-PDB-01 (sprint 20260818-183407): destination 札を platform（echo 側）へ貫通
                platform.pasteOutlinerNodesWithAssets(message.plainText || '', message.nodes || [], message.sidePanelFilePath, message.destination);
            } else {
                // TASK-B5 防御: 宛先 md が特定できない場合でも paste 自体は成立させる
                // (添付複製なしのリストのみ md を返す。silent no-op で「貼れない」にしない)
                const fallbackLines = ((message.nodes || []) as Array<{ text?: string; level?: number }>).map(
                    (n) => `${'  '.repeat(Math.max(0, n.level || 0))}- ${String(n.text || '').replace(/\n/g, ' ')}`);
                sender.postMessage({
                    type: 'pasteWithAssetCopyResult',
                    markdown: fallbackLines.join('\n') + '\n',
                    destination: message.destination,
                });
            }
            break;

        case 'extractDataUrlsInPastedMd':
            if (message.markdown && platform.extractDataUrlsInPastedMd) {
                // FR-PDB-02 (sprint 20260818-183407): destination 札を platform（echo 側）へ貫通
                platform.extractDataUrlsInPastedMd(message.markdown, message.sidePanelFilePath, message.destination);
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

        // FR-FV-07（sprint 20260815-075428 SEC-2）: viewer「OS で開く」フォールバック。
        // sidepanel/note 面の file-viewer.js が送る（standalone 面は fileViewerProvider が直接処理）
        case 'openExternalFallback':
            if (message.filePath && platform.openViewerFallback) {
                platform.openViewerFallback(String(message.filePath));
            }
            break;

        // FR-FV-08: viewer ツールバー 4 アクション → provider（platform）へ委譲。
        // optional メソッドなので未実装の面では no-op（openViewerFallback と同じ契約）。
        case 'viewerOpenInNewTab':
            if (message.filePath) {
                platform.viewerOpenInNewTab?.(String(message.filePath), message.kind ? String(message.kind) : undefined);
            }
            break;

        case 'viewerCopyPath':
            if (message.filePath) {
                platform.viewerCopyPath?.(String(message.filePath));
            }
            break;

        case 'viewerCopyInAppLink':
            if (message.filePath) {
                platform.viewerCopyInAppLink?.(String(message.filePath));
            }
            break;

        case 'viewerExportFile':
            if (message.filePath) {
                platform.viewerExportFile?.(String(message.filePath));
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
        // FR-DS-05 rev.2: 検索 Files ヒットの click（files/ 相対パス — 台帳未登録の添付も開ける）
        case 'openNoteFilesExternal': {
            if (typeof platform.openNoteFilesExternal === 'function') {
                await platform.openNoteFilesExternal(message.relPath, sender);
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
        // ── FR-FLV: folder link CRUD（bridge 台帳 #1-5） ──
        case 'addFolderLink': {
            // FR-FTM-02 (sprint 20260818-183407): メニュー起点はその場所へ登録（parentId 省略 = root）
            await platform.addFolderLink?.(sender, message.parentId || null);
            break;
        }
        // FR-FTM-01 (sprint 20260818-183407): +file ボタン
        case 'addTreeFilesViaDialog': {
            await platform.addTreeFilesViaDialog?.(sender);
            break;
        }
        // FR-FTM-03 (sprint 20260818-183407): tree item の Duplicate
        case 'duplicateTreeItem': {
            if (message.id) {
                platform.duplicateTreeItem?.(String(message.id), sender);
            }
            break;
        }
        case 'relinkFolderLink': {
            await platform.relinkFolderLink?.(String(message.id ?? ''), sender);
            break;
        }
        case 'removeFolderLink': {
            await platform.removeFolderLink?.(String(message.id ?? ''), sender);
            break;
        }
        case 'renameFolderLink': {
            await platform.renameFolderLink?.(String(message.id ?? ''), sender);
            break;
        }
        case 'revealFolderLink': {
            await platform.revealFolderLink?.(String(message.id ?? ''), sender);
            break;
        }
        case 'copyFolderLinkPath': {
            await platform.copyFolderLinkPath?.(String(message.id ?? ''), sender);
            break;
        }
        // ── FR-FLV: folder view fs 操作（bridge 台帳 #6-12） ──
        case 'folderViewList': {
            await platform.folderViewList?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        case 'folderViewSearch': {
            await platform.folderViewSearch?.(String(message.id ?? ''), String(message.query ?? ''), sender);
            break;
        }
        case 'folderViewToggleHidden': {
            await platform.folderViewToggleHidden?.(String(message.id ?? ''), sender);
            break;
        }
        case 'folderViewClosed': {
            platform.folderViewClosed?.(String(message.id ?? ''));
            break;
        }
        case 'folderViewOpen': {
            await platform.folderViewOpen?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        case 'folderViewCreate': {
            await platform.folderViewCreate?.(String(message.id ?? ''), String(message.parentRelPath ?? ''), String(message.kind ?? 'md'), sender);
            break;
        }
        case 'folderViewRename': {
            await platform.folderViewRename?.(String(message.id ?? ''), String(message.relPath ?? ''), String(message.newName ?? ''), sender);
            break;
        }
        case 'folderViewStateSave': {
            const exp = Array.isArray(message.expanded) ? message.expanded.map((v: unknown) => String(v)) : [];
            await platform.folderViewStateSave?.(String(message.id ?? ''), exp, sender);
            break;
        }
        case 'folderViewDuplicate': {
            await platform.folderViewDuplicate?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        case 'folderViewDelete': {
            await platform.folderViewDelete?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        case 'folderViewMove': {
            await platform.folderViewMove?.(String(message.id ?? ''), String(message.srcRelPath ?? ''), String(message.dstDirRelPath ?? ''), sender);
            break;
        }
        case 'folderViewRevealEntry': {
            await platform.folderViewRevealEntry?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        case 'folderViewCopyEntryPath': {
            await platform.folderViewCopyEntryPath?.(String(message.id ?? ''), String(message.relPath ?? ''), sender);
            break;
        }
        // ── FR-FLV: 面間 D&D（bridge 台帳 #13-16） ──
        case 'folderViewMoveIn': {
            await platform.folderViewMoveIn?.(String(message.id ?? ''), String(message.dstDirRelPath ?? ''), String(message.srcKind ?? ''), String(message.srcItemId ?? ''), sender);
            break;
        }
        case 'folderViewMoveToTree': {
            await platform.folderViewMoveToTree?.(String(message.id ?? ''), String(message.relPath ?? ''), message.parentId ?? null, Number(message.index ?? 0), sender);
            break;
        }
        case 'folderViewMoveIntoMd': {
            await platform.folderViewMoveIntoMd?.(String(message.id ?? ''), String(message.relPath ?? ''), String(message.targetMdPath ?? ''), sender);
            break;
        }
        case 'folderViewMoveFromMd': {
            await platform.folderViewMoveFromMd?.(String(message.id ?? ''), String(message.dstDirRelPath ?? ''), {
                href: String(message.href ?? ''),
                sourceMdPath: String(message.sourceMdPath ?? ''),
                isSubpage: !!message.isSubpage,
            }, sender);
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

                // Dest dirs (dailynotes.out) — 読み取り正典 flat-layout で解決する
                // (hint 最優先 → legacy 実在 → flat)。旧 `./${basename}` フォールバックは
                // hint 無し .out に対して旧 per-outliner レイアウトを新規に作ってしまい
                // 移行ゲートが再発する (sprint 20260812-171126)。本体が読む場所に書く。
                const destOutDir = path.dirname(archiveFilePath);
                const archiveHints = {
                    pageDir: archiveData.pageDir as string | undefined,
                    imageDir: archiveData.imageDir as string | undefined,
                    fileDir: archiveData.fileDir as string | undefined,
                };
                const destPagesDir = resolvePagesDir(archiveFilePath, destOutDir, archiveHints);
                const destFileDir = resolveFilesDir(archiveFilePath, destOutDir, archiveHints);

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

            // FR-DS-01: 添付中身検索（第 4 段）を含むため async。notesSearchEnd は完了後に送出
            // （Start→Partial*→End の順序契約 — design/system.md §8）。旧検索の中断は
            // fileManager 内の generation カウンタが行う（webview 側は既存 searchId フィルタ）。
            const fileHitIds: string[] = [];
            await fileManager.searchFilesStreaming(message.query, searchOpts, (partialResult) => {
                if (partialResult.fileType === 'file') { fileHitIds.push(partialResult.fileId); }
                sender.postMessage({
                    type: 'notesSearchPartial',
                    searchId,
                    result: partialResult,
                });
            });

            sender.postMessage({ type: 'notesSearchEnd', searchId });

            // FR-DS-10 / ADRL-0061: 逆参照は End 送出後に非同期で後追い配信（検索表示を遅くしない）。
            // setImmediate でイベントループに譲ってから解決（初回はフル走査・2 回目以降 mtime キャッシュ）
            if (fileHitIds.length > 0) {
                setImmediate(() => {
                    try {
                        const backlinks = fileManager.resolveFileBacklinks(fileHitIds);
                        for (const [fileId, refs] of backlinks) {
                            if (refs.length === 0) { continue; }   // 孤児 file は配信しない
                            sender.postMessage({ type: 'notesSearchBacklinks', searchId, fileId, backlinks: refs });
                        }
                    } catch { /* 逆参照の失敗は検索結果に影響させない */ }
                });
            }
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
/** 随伴転送の md 基準座標（source/dest とも resolve*ForMd 正典の隣接解決 — FR-ACC-01。
 *  flat note では note 共有 dir と一致し、legacy pages/ 配置でも正しく親共有 dir に解決される）。 */
function transferCoordsForMd(srcMdAbs: string, destMdAbs: string): TransferCoords {
    return makeTransferCoords(mdCoords(srcMdAbs), mdCoords(destMdAbs));
}

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
        // cross 判定は source md の note 基準（FR-ACC-03 — target/source どちらが外でも随伴転送に倒す）
        const crossNote = isCrossNoteDrop(path.dirname(resolveFilesDirForMd(filePath)), sidePanelFilePath);
        let markdownPath: string;
        let title: string;
        if (crossNote) {
            // 随伴転送（FR-ACC-03 — 画像/📎/subpage 再帰を dest note 座標へ。source は温存 = orphan 契約）
            const r = transferMdWithAssets(filePath, transferCoordsForMd(filePath, sidePanelFilePath));
            markdownPath = r.newName;
            title = resolveSubpageTitle(content, r.newName);
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
        detachOutNodeFileOwnership(outData, payload.nodeId);
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
        // cross 判定は source md の note 基準（従来の「target が note 外」判定では source が別 note の
        // ケースで跨ぎ ../ 相対リンクが挿入されていた = FR-TF-18 禁止形。FR-ACC-03 で是正）
        const srcNoteFolder = path.dirname(resolveFilesDirForMd(srcMdPath));
        if (isCrossNoteDrop(srcNoteFolder, target)) {
            // 随伴転送（FR-ACC-03）
            const r = transferMdWithAssets(srcMdPath, transferCoordsForMd(srcMdPath, target));
            markdownPath = r.newName;
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
        removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, 'file'); // fs 正典 + エコーの 2 段（TASK-03 集約）
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
            // 随伴転送（FR-ACC-03）
            const r = transferMdWithAssets(abs, transferCoordsForMd(abs, target));
            markdownPath = r.newName;
        } else {
            markdownPath = path.relative(path.dirname(target), abs).replace(/\\/g, '/');
        }
        const msg: Record<string, unknown> = { type: 'insertSubpageLink', markdownPath, title };
        if (sidePanelFilePath) { msg.sidePanelFilePath = sidePanelFilePath; }
        sender.postMessage(msg);
        removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, 'subpage'); // fs 正典 + エコーの 2 段（TASK-03 集約）
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
        removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, 'file'); // fs 正典 + エコーの 2 段（TASK-03 集約）
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
            // 随伴転送（FR-ACC-03 — dest note フラット座標。throw は外側 catch = 従来の診断ログ経路）
            const r = transferMdWithAssets(abs, makeTransferCoords(mdCoords(abs), noteCoords(fileManager.getMainFolderPath())));
            pageMdAbs = r.destMdPath;
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
        removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, 'subpage'); // fs 正典 + エコーの 2 段（TASK-03 集約）
    } catch (e) {
        console.error('[Notes] importMdSubpageIntoOut error:', e);
    }
}

/**
 * .out node の file 所有解除（sprint 20260819-210558 TASK-04 — 字面重複 2 サイトの集約）。
 * 子なし node = node ごと削除（rootIds / 親 children からも除去 — 「添付が外れたファイル名テキスト
 * node」の残留防止 = FR-TF-05b 改訂 2026-08-10）/ 子あり node = filePath null 化のみ（子の喪失防止）。
 * fs 書込は呼び出し側の責務（データ変異のみ — unit 直駆動可能な pure 関数）。
 */
export function detachOutNodeFileOwnership(
    outData: { rootIds?: string[]; nodes: Record<string, { parentId?: string | null; children?: string[]; filePath?: string | null } | undefined> },
    nodeId: string
): void {
    const node = outData.nodes ? outData.nodes[nodeId] : undefined;
    if (!node) { return; }
    if (!node.children || node.children.length === 0) {
        delete outData.nodes[nodeId];
        if (Array.isArray(outData.rootIds)) {
            outData.rootIds = outData.rootIds.filter((id: string) => id !== nodeId);
        }
        const parentNode = node.parentId ? outData.nodes[node.parentId] : null;
        if (parentNode && Array.isArray(parentNode.children)) {
            parentNode.children = parentNode.children.filter((id: string) => id !== nodeId);
        }
    } else {
        node.filePath = null;
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
        detachOutNodeFileOwnership(outData, payload.nodeId);
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
        removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, 'file'); // fs 正典 + エコーの 2 段（TASK-03 集約）
        sendFileListWithStructure(fileManager, sender);
    } catch (e) {
        console.error('[Notes] treeFileRegisterFromMdLink error:', e);
    }
}

// ── FR-FLV: 面間 D&D host 端のロジック本体（bridge 台帳 #13-16 — ADRL-0073 rev 2） ──

/** FR-FLV: 面間移動（複製成功 → 元 trash = INV-5）の VS Code 依存注入。 */
export interface FolderMoveDeps {
    showErrorMessage(message: string): void;
    t(key: string): string | undefined;
    /** trash 削除（workspace.fs.delete {useTrash:true}） */
    trashDelete(absPath: string, recursive: boolean): Promise<void>;
    /** 完全削除（useTrash:false）— FR-FLV-34: 移動系の trash 失敗フォールバック専用（純削除には使わない） */
    deleteFile?(absPath: string, recursive: boolean): Promise<void>;
    /** 画像 insert 用の表示 URI（asWebviewUri） */
    toDisplayUri(absPath: string): string;
}

const FOLDER_VIEW_IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;

/** 元実体を trash（best-effort — 失敗しても複製済みなのでデータ損失なし。ログのみ）。 */
/** relPath（'' = root）の親 dir 相対を返す（notes-folder-view.js の parentRelOf と同義の host 版） */
function parentRelOf(relPath: string): string {
    return relPath.indexOf('/') >= 0 ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
}

/** folder view fs 操作の失敗通知（例外は message のみ整形して埋め込む — 生 `${e}` を出さない） */
function notifyOperationFailed(
    deps: { showErrorMessage: (m: string) => void; t: (k: string) => string | undefined },
    e: unknown
): void {
    const detail = e instanceof Error ? e.message : String(e);
    deps.showErrorMessage(deps.t('folderViewOperationFailed') || `Operation failed: ${detail}`);
}

async function trashSourceBestEffort(deps: FolderMoveDeps, absPath: string): Promise<void> {
    try {
        await deps.trashDelete(absPath, false);
    } catch (e) {
        // FR-FLV-34 / ADRL-FVR-2（ユーザー裁定 2026-08-21 — W2 裁定の部分改訂）: 本関数の呼び出し面は
        // 制御フロー上すべて「dest への複製成功後」= 完全削除してもデータは dest に実在。trash 不能環境
        //（vscode server 等）で「移動が複製になる」縮退を解消する。純削除（Delete/Rename）は対象外。
        if (deps.deleteFile) {
            try {
                await deps.deleteFile(absPath, false);
                console.warn('[Notes] folder view move: trash unavailable — source removed permanently (copy verified at dest):', absPath);
                return; // 移動成立（通知不要）
            } catch (e2) {
                console.error('[Notes] folder view move: permanent-delete fallback also failed:', e2);
            }
        }
        // W2（2026-08-18）: silent 握り禁止 — 「コピーは作成済み・元の削除に失敗」を可視化して元は残す
        console.error('[Notes] folder view move: source trash failed (copy already done, no data loss):', e);
        try {
            deps.showErrorMessage(
                (deps.t('folderViewTrashFailed') || 'Moved copy created, but failed to move the original to Trash: ')
                + path.basename(absPath)
            );
        } catch { /* 通知自体の失敗は握る（本体は既に完了） */ }
    }
}

/**
 * FR-FLV-20 (#14): フォルダビュー → Note ツリー移動。
 * .md = registerMarkdownFile / 他 = registerTreeFile（sanitize+uniquify 合流）→ 登録成功後に元実体 trash。
 */
export async function folderViewMoveToTree(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    parentId: string | null,
    index: number,
    deps: FolderMoveDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const srcAbs = safeResolveUnderFolderRoot(root, relPath);
    if (!srcAbs || !fs.existsSync(srcAbs)) { return false; }
    if (fs.statSync(srcAbs).isDirectory()) {
        deps.showErrorMessage(deps.t('folderViewNoFolderDrop') || 'Folders cannot be dropped here.');
        return false;
    }
    const base = path.basename(srcAbs);
    try {
        if (/\.md$/i.test(base)) {
            const content = fs.readFileSync(srcAbs, 'utf8');
            const title = extractFirstH1(content) || base.replace(/\.md$/i, '');
            // 随伴転送（FR-ACC-02: fv 隣接座標 → note フラット座標へ変換）。台帳登録は新 md 1 件のみ
            //（closure md は台帳外 = liveness は md-link closure）。throw は外側 catch = 従来の失敗経路
            const r = transferMdWithAssets(srcAbs, makeTransferCoords(mdCoords(srcAbs), noteCoords(fileManager.getMainFolderPath())), undefined, { extraSourceRoots: [root] }); // NFR-ACC-02b rev2: linkedfd root 境界
            fileManager.registerExistingMdFile(path.basename(r.newName, '.md'), title, parentId, index);
        } else {
            const bytes = fs.readFileSync(srcAbs);
            fileManager.registerTreeFile(base, base, parentId, index, bytes);
        }
    } catch (e) {
        notifyOperationFailed(deps, e);
        return false; // 登録失敗 → 元不変（INV-5）
    }
    await trashSourceBestEffort(deps, srcAbs); // 移動 = 複製成功 → 元 trash
    sendFileListWithStructure(fileManager, sender);
    const parentRel = parentRelOf(relPath);
    sendFolderViewList(fileManager, folderLinkId, parentRel, sender);
    return true;
}

/**
 * FR-FLV-21 (#13): Note ツリー item → フォルダビュー移動。
 * note 実体を dst へ複製（uniquify）→ 成功後に台帳除去 + note 側実体 trash。失敗時は note 側不変。
 */
export async function folderViewMoveIn(
    fileManager: NotesFileManager,
    folderLinkId: string,
    dstDirRelPath: string,
    srcKind: string,
    srcItemId: string,
    deps: FolderMoveDeps,
    sender: NotesSender
): Promise<boolean> {
    if (srcKind !== 'md' && srcKind !== 'file') {
        // .out / folder item は受理しない（requirement D&D 表の × セル）
        deps.showErrorMessage(deps.t('folderViewMoveInUnsupported') || 'Only markdown and file items can be moved here.');
        return false;
    }
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const dstDirAbs = safeResolveUnderFolderRoot(root, dstDirRelPath);
    if (!dstDirAbs || !fs.existsSync(dstDirAbs) || !fs.statSync(dstDirAbs).isDirectory()) { return false; }
    const item: any = fileManager.getStructure().items[srcItemId];
    if (!item || item.type !== 'file') { return false; }

    let srcAbs: string | null = null;
    let preferredName = '';
    if (srcKind === 'md') {
        if (item.ext !== 'md') { return false; }
        srcAbs = fileManager.getMdFilePath(srcItemId);
        preferredName = `${NotesFileManager.sanitizeTreeFileName(String(item.title || srcItemId))}.md`;
    } else {
        if (item.ext !== 'file') { return false; }
        srcAbs = fileManager.getTreeFilePath(srcItemId);
        preferredName = item.filename || path.basename(String(srcAbs || 'file'));
    }
    if (!srcAbs || !fs.existsSync(srcAbs)) { return false; }

    let dstAbs: string | null = null;
    if (srcKind === 'md') {
        // 随伴転送（FR-ACC-02: note フラット → fv 隣接座標へ変換。images//files/ は資産がある時のみ作成）
        try {
            const r = transferMdWithAssets(srcAbs, makeTransferCoords(mdCoords(srcAbs), adjacentCoords(dstDirAbs)), preferredName);
            dstAbs = r.destMdPath;
        } catch (e) {
            console.error('[fractal] transferMdWithAssets failed (folderViewMoveIn):', e); // reviewer iter1 QUAL-2 — W2 規範
            dstAbs = null;
        }
    } else {
        dstAbs = copyEntityWithUniquify(srcAbs, dstDirAbs, preferredName);
    }
    if (!dstAbs) {
        deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
        return false; // 複製失敗 → note 側不変（INV-5）
    }
    // 複製成功 → 台帳除去 + note 側実体 trash
    if (srcKind === 'md') {
        fileManager.unregisterMdFromStructureOnly(srcItemId);
    } else {
        fileManager.unregisterTreeFileFromStructureOnly(srcItemId);
    }
    await trashSourceBestEffort(deps, srcAbs);
    sendFileListWithStructure(fileManager, sender);
    sendFolderViewList(fileManager, folderLinkId, dstDirRelPath, sender);
    return true;
}

/**
 * FR-FLV-22 (#15): フォルダビュー → sidepanel md 移動 + リンク挿入。
 * 種別分岐: md = 対象 md の dir へ + subpage リンク / 画像 = 保存先 images/ + 画像挿入 / 他 = files/ + 📎。
 * 保存先解決は flat-layout の正典（note md = note 共有 / note 外 md = md の隣 — FR-SD-03 合流）。
 * 順序 = 移動（複製成功 → 元 trash）→ リンク挿入指示（INV-3）。
 */
export async function folderViewMoveIntoMd(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    targetMdPath: string,
    deps: FolderMoveDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const srcAbs = safeResolveUnderFolderRoot(root, relPath);
    if (!srcAbs || !targetMdPath || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) { return false; }
    if (path.resolve(srcAbs) === path.resolve(targetMdPath)) { return false; } // 自分自身への drop = no-op
    const base = path.basename(srcAbs);
    const targetDir = path.dirname(targetMdPath);

    if (/\.md$/i.test(base)) {
        // md → 対象 md と同じフォルダへ移動 + subpage リンク。
        // 再オープン① W4（FR-FLV-22 / folder-view.md §6-7）: note md 宛ては cross-note 取り込みの正典
        // saveDroppedMdAsSubpage（linkMdSubpageToMd :2701-2706 と同一関数 — 隣接 uniquify 配置 +
        // resolveSubpageTitle。liveness は subpage リンクの md-link closure が担保 = TC-FLV-59 ③）に字面合流
        if (!isCrossNoteDrop(fileManager.getMainFolderPath(), targetMdPath)) {
            let content = '';
            try { content = fs.readFileSync(srcAbs, 'utf8'); } catch {
                deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
                return false;
            }
            // reviewer iter3 QUAL-1: saveDroppedMdAsSubpage は fs 失敗（EACCES/ENOSPC）で throw する契約 —
            // 同関数の他 3 分岐と同じ「失敗検知 → 通知 + false」パターンで囲む（unhandled rejection 禁止）
            let newName: string;
            try {
                // 随伴転送（FR-ACC-02: fv 隣接 → target md の座標〔note md = 共有 dir〕へ変換）
                const r = transferMdWithAssets(srcAbs, makeTransferCoords(mdCoords(srcAbs), mdCoords(targetMdPath)), base, { extraSourceRoots: [root] }); // NFR-ACC-02b rev2
                newName = r.newName;
            } catch (e) {
                notifyOperationFailed(deps, e);
                return false; // 配置失敗 → 元実体・md 本文とも不変（INV-3/INV-5）
            }
            await trashSourceBestEffort(deps, srcAbs);
            sender.postMessage({ type: 'insertSubpageLink', markdownPath: newName, title: resolveSubpageTitle(content, newName), sidePanelFilePath: targetMdPath });
        } else {
            // linked-folder md 宛て（folderRoot 内で完結）: 従来どおり（同一 dir なら移動なし・相対リンク）
            let dstAbs = srcAbs;
            const sameDir = path.resolve(path.dirname(srcAbs)) === path.resolve(targetDir);
            if (!sameDir) {
                // 随伴転送（FR-ACC-02 fv→fv 変種: source md 隣接 → target md 隣接座標）
                let copied: string | null = null;
                try {
                    const r = transferMdWithAssets(srcAbs, makeTransferCoords(mdCoords(srcAbs), adjacentCoords(targetDir)), base, { extraSourceRoots: [root] }); // NFR-ACC-02b rev2
                    copied = r.destMdPath;
                } catch (e) {
                    console.error('[fractal] transferMdWithAssets failed (folderViewMoveIntoMd fv):', e); // reviewer iter1 QUAL-2
                    copied = null;
                }
                if (!copied) {
                    deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
                    return false;
                }
                dstAbs = copied;
                await trashSourceBestEffort(deps, srcAbs);
            }
            let title = '';
            try { title = extractFirstH1(fs.readFileSync(dstAbs, 'utf8')) || ''; } catch { /* fallback */ }
            if (!title) { title = path.basename(dstAbs).replace(/\.md$/i, ''); }
            const markdownPath = path.relative(targetDir, dstAbs).replace(/\\/g, '/');
            sender.postMessage({ type: 'insertSubpageLink', markdownPath, title, sidePanelFilePath: targetMdPath });
        }
    } else if (FOLDER_VIEW_IMAGE_EXT.test(base)) {
        // 画像 → 対象 md の保存先 images/（正典 resolver — note md = 共有 / 外 md = 隣）
        const imagesDir = resolveImagesDirForMd(targetMdPath);
        try { fs.mkdirSync(imagesDir, { recursive: true }); } catch { /* ignore */ }
        const dstAbs = copyEntityWithUniquify(srcAbs, imagesDir, base);
        if (!dstAbs) {
            deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
            return false;
        }
        await trashSourceBestEffort(deps, srcAbs);
        const markdownPath = path.relative(targetDir, dstAbs).replace(/\\/g, '/');
        sender.postMessage({
            type: 'insertImageHtml',
            markdownPath,
            displayUri: deps.toDisplayUri(dstAbs),
            sidePanelFilePath: targetMdPath,
        });
    } else {
        // その他 → 保存先 files/ + 📎 リンク
        const filesDir = resolveFilesDirForMd(targetMdPath);
        try { fs.mkdirSync(filesDir, { recursive: true }); } catch { /* ignore */ }
        const dstAbs = copyEntityWithUniquify(srcAbs, filesDir, base);
        if (!dstAbs) {
            deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
            return false;
        }
        await trashSourceBestEffort(deps, srcAbs);
        const markdownPath = path.relative(targetDir, dstAbs).replace(/\\/g, '/');
        sender.postMessage({
            type: 'insertFileLink',
            markdownPath,
            fileName: path.basename(dstAbs),
            sidePanelFilePath: targetMdPath,
        });
    }
    const parentRel = parentRelOf(relPath);
    sendFolderViewList(fileManager, folderLinkId, parentRel, sender);
    return true;
}

/**
 * FR-FLV-24 (#16): sidepanel md の 📎/subpage アンカー → フォルダビュー移動 + リンク除去。
 * 実体解決は source md 基準（treeFileRegisterFromMdLink 同型の containment）。
 * 複製成功 → removeMdAnchorFromFile（fs 正典）+ webview エコー → 元実体 trash。
 */
export async function folderViewMoveFromMd(
    fileManager: NotesFileManager,
    folderLinkId: string,
    dstDirRelPath: string,
    payload: { href: string; sourceMdPath: string; isSubpage?: boolean },
    deps: FolderMoveDeps,
    sender: NotesSender
): Promise<boolean> {
    if (!payload || !payload.href || !payload.sourceMdPath) { return false; }
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const dstDirAbs = safeResolveUnderFolderRoot(root, dstDirRelPath);
    if (!dstDirAbs || !fs.existsSync(dstDirAbs) || !fs.statSync(dstDirAbs).isDirectory()) { return false; }
    // href → 実体解決。href はレンダラ無検証の非信頼入力（📎 ラベルだけで data-is-file-attachment が
    // 付く）ため、containment は precedent と字面 1:1 で揃える（reviewer iter1 SEC-1 / TC-FLV-51）:
    //   📎 filelink = resolveFilesDirForMd(sourceMd) 配下のみ（attachMdFileLinkToMd :2643-2648 同型 —
    //   treeFileRegisterFromMdLink も同パターン）
    //   subpage    = note 配下 clamp + .md 拡張子必須（linkMdSubpageToMd :2692-2695 同型）
    // dirname(md) 全体を base にすると files/ 外の任意兄弟が [📎 x](secret.txt) で exfiltrate+trash 可能
    let decoded: string;
    try { decoded = decodeURIComponent(payload.href); } catch { decoded = payload.href; }
    const resolvedFromMd = path.resolve(path.dirname(payload.sourceMdPath), decoded);
    let srcAbs: string | null = null;
    if (payload.isSubpage) {
        const srcMainFolder = path.dirname(resolveFilesDirForMd(payload.sourceMdPath));
        const abs = safeResolveUnderDir(srcMainFolder, path.relative(srcMainFolder, resolvedFromMd));
        srcAbs = abs && abs.endsWith('.md') ? abs : null; // case-sensitive（linkMdSubpageToMd :2695 と字面 1:1）
    } else {
        const filesDir = resolveFilesDirForMd(payload.sourceMdPath);
        const rel = path.relative(filesDir, resolvedFromMd);
        srcAbs = (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? null : resolvedFromMd;
    }
    if (!srcAbs || !fs.existsSync(srcAbs) || !fs.statSync(srcAbs).isFile()) {
        // 再オープン① W6（FR-FLV-24 / folder-view.md §6-8）: silent return 廃止 — 実体不在 /
        // containment 棄却 / 拡張子棄却は通知する（silent は self drop のみ）
        deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Cannot move: link target not found or not allowed.');
        return false;
    }
    if (path.resolve(path.dirname(srcAbs)) === path.resolve(dstDirAbs)) { return false; } // 実体の現在地への drop = no-op（唯一の silent）

    let dstAbs: string | null = null;
    if (payload.isSubpage) {
        // 随伴転送（FR-ACC-02: note 共有 → fv 隣接座標へ変換）
        try {
            const r = transferMdWithAssets(srcAbs, makeTransferCoords(mdCoords(srcAbs), adjacentCoords(dstDirAbs)));
            dstAbs = r.destMdPath;
        } catch (e) {
            console.error('[fractal] transferMdWithAssets failed (folderViewMoveFromMd):', e); // reviewer iter1 QUAL-2
            dstAbs = null;
        }
    } else {
        dstAbs = copyEntityWithUniquify(srcAbs, dstDirAbs, path.basename(srcAbs));
    }
    if (!dstAbs) {
        deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Move failed.');
        return false; // 複製失敗 → md 本文・元実体とも不変（INV-3/INV-5）
    }
    // fs 正典でリンク除去 + 表示同期エコー（エコーだけで済ませない — generator_failures 2026-08-14）
    removeMdAnchorAndEcho(payload.sourceMdPath, payload.href, sender, payload.isSubpage ? 'subpage' : 'file'); // fs 正典 + エコーの 2 段（TASK-03 集約）
    await trashSourceBestEffort(deps, srcAbs);
    sendFolderViewList(fileManager, folderLinkId, dstDirRelPath, sender);
    return true;
}

// ── FR-FLV: folder link CRUD のロジック本体（bridge 台帳 #1-5。provider は deps を注入して呼ぶ） ──

/** FR-FLV: notesFileListChanged を strip 済み payload（getStructureForWebview）で送る共通ヘルパ。 */
function broadcastFolderLinkChange(fileManager: NotesFileManager, sender: NotesSender): void {
    sender.postMessage({
        type: 'notesFileListChanged',
        fileList: fileManager.listFiles(),
        structure: fileManager.getStructureForWebview(),
    });
}

/** FR-FLV: guard reject 理由 → ユーザー通知（duplicate は info・他は error）。 */
function notifyGuardReject(
    deps: FolderLinkDeps,
    reason: 'invalid' | 'self' | 'ancestor' | 'descendant' | 'duplicate' | undefined
): void {
    if (reason === 'duplicate') {
        deps.showInformationMessage(deps.t('folderLinkDuplicate') || 'This folder is already linked.');
        return;
    }
    if (reason === 'self' || reason === 'ancestor' || reason === 'descendant') {
        deps.showErrorMessage(deps.t('folderLinkSelfReference')
            || 'Cannot link the note folder itself, its parent, or a folder inside it.');
        return;
    }
    deps.showErrorMessage(deps.t('folderLinkInvalid') || 'The selected folder cannot be linked.');
}

/**
 * FR-FLV-01 (#1): フォルダ選択ダイアログ → 自己参照/重複ガード（ADRL-0072）→ 登録 → broadcast。
 * @returns 登録した item id / null（キャンセル・ガード reject）
 */
export async function folderLinkAdd(
    fileManager: NotesFileManager,
    deps: FolderLinkDeps,
    sender: NotesSender,
    parentId?: string | null
): Promise<string | null> {
    const uris = await deps.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: deps.t('folderLinkAddLabel') || 'Link Folder',
    });
    if (!uris || !uris[0]) { return null; } // キャンセル = 副作用ゼロ
    const selected = uris[0].fsPath;
    const guard = fileManager.guardFolderSelection(selected);
    if (!guard.ok) {
        notifyGuardReject(deps, guard.reason);
        return null;
    }
    const id = fileManager.registerFolderLink(selected, parentId);
    broadcastFolderLinkChange(fileManager, sender);
    return id;
}

/**
 * FR-FTM-01 (sprint 20260818-183407): +file ボタン（showOpenDialog 確定）で選択したファイル群を
 * tree に登録する。振り分けは registerExternalDroppedUris と同一（.md = md item / 他 = file item）。
 * host fs 直読みのため 50MB cap なし（FR-TF-17 と同一裁定）。空配列（キャンセル）= 副作用ゼロ。
 */
export function addTreeFilesFromPaths(
    fileManager: NotesFileManager,
    fsPaths: string[],
    sender: NotesSender
): void {
    if (!Array.isArray(fsPaths) || fsPaths.length === 0) { return; }
    let registered = 0;
    for (const fsPath of fsPaths) {
        try {
            if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isFile()) { continue; }
            const name = path.basename(fsPath);
            if (/\.md$/i.test(name)) {
                const content = fs.readFileSync(fsPath, 'utf8');
                const title = resolveSubpageTitle(content, name);
                fileManager.registerMarkdownFile(content, title, null, registered);
                registered++;
            } else {
                const buf = fs.readFileSync(fsPath);
                fileManager.registerTreeFile(name, name, null, registered, buf);
                registered++;
            }
        } catch (e) {
            console.error('[Notes] addTreeFilesFromPaths skip:', fsPath, e);
        }
    }
    if (registered > 0) {
        sendFileListWithStructure(fileManager, sender);
    }
}

/**
 * FR-FLV-04 (#2): リンク先の再指定。成功時は folderPath 更新 + broadcast + showFolderView 指示
 * （payload は id/title のみ — 絶対パス不含）。
 */
export async function folderLinkRelink(
    fileManager: NotesFileManager,
    itemId: string,
    deps: FolderLinkDeps,
    sender: NotesSender
): Promise<boolean> {
    const item = fileManager.getStructure().items[itemId];
    if (!item || item.type !== 'file' || item.ext !== 'folder') { return false; }
    const defaultUri = item.folderPath ? deps.uriFile(path.dirname(item.folderPath)) : undefined;
    const uris = await deps.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        defaultUri,
        openLabel: deps.t('folderLinkRelinkLabel') || 'Re-link Folder',
    });
    if (!uris || !uris[0]) { return false; }
    const selected = uris[0].fsPath;
    const guard = fileManager.guardFolderSelection(selected, itemId);
    if (!guard.ok) {
        notifyGuardReject(deps, guard.reason);
        return false;
    }
    fileManager.setFolderLinkPath(itemId, selected);
    broadcastFolderLinkChange(fileManager, sender);
    sender.postMessage({ type: 'showFolderView', folderLinkId: itemId, title: item.title });
    return true;
}

/** FR-FLV-06 (#3): Remove Link — 台帳のみ除去（fs 一切非接触 — TC-FLV-49 counterfactual）。 */
export function folderLinkRemove(
    fileManager: NotesFileManager,
    itemId: string,
    sender: NotesSender
): boolean {
    const removed = fileManager.removeFolderLink(itemId);
    if (removed) { broadcastFolderLinkChange(fileManager, sender); }
    return removed;
}

/** FR-FLV-06 (#4): Rename — title のみ変更（folderPath・実フォルダ名は不変）。 */
export async function folderLinkRename(
    fileManager: NotesFileManager,
    itemId: string,
    deps: FolderLinkDeps,
    sender: NotesSender
): Promise<boolean> {
    const item = fileManager.getStructure().items[itemId];
    if (!item || item.type !== 'file' || item.ext !== 'folder') { return false; }
    const next = await deps.showInputBox({
        value: item.title,
        prompt: deps.t('folderLinkRenamePrompt') || 'Rename folder link (display name only)',
    });
    if (next === undefined || next === null || String(next).trim() === '') { return false; }
    fileManager.setFolderLinkTitle(itemId, String(next).trim());
    broadcastFolderLinkChange(fileManager, sender);
    return true;
}

/** FR-FLV-06 (#5a): Reveal in Finder — リンク先実フォルダ。broken はエラー通知。 */
export function folderLinkReveal(
    fileManager: NotesFileManager,
    itemId: string,
    deps: FolderLinkDeps
): void {
    const root = fileManager.resolveFolderRoot(itemId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return;
    }
    deps.executeCommand('revealFileInOS', deps.uriFile(root));
}

/** FR-FLV-06 (#5b): Copy Path — folderPath を OS clipboard へ（webview へは返さない = INV-4）。 */
export function folderLinkCopyPath(
    fileManager: NotesFileManager,
    itemId: string,
    deps: FolderLinkDeps
): void {
    const item = fileManager.getStructure().items[itemId];
    if (!item || item.type !== 'file' || item.ext !== 'folder' || !item.folderPath) { return; }
    deps.clipboardWriteText(item.folderPath);
}

// ── FR-FLV: folder view fs 操作のロジック本体（bridge 台帳 #6-12） ──

/**
 * FR-FLV: folder view fs 操作の VS Code 依存注入（unit テストは明示 recorder）。
 */
export interface FolderViewDeps {
    showInputBox(options: any): Promise<string | undefined>;
    showErrorMessage(message: string): void;
    t(key: string): string | undefined;
    /** trash 削除（workspace.fs.delete {useTrash:true, recursive} — 恒久削除 API は使わない） */
    trashDelete(absPath: string, recursive: boolean): Promise<void>;
    /** md → md sidepanel（SidePanelManager.openFile） */
    openMdInSidePanel(absPath: string): void | Promise<void>;
    /** pdf/html → viewer sidepanel（tryOpenViewerPanel） */
    openViewerPanel(absPath: string): void | Promise<void>;
    /** その他 → OS 既定アプリ */
    openExternal(absPath: string): void | Promise<void>;
    /** folderRoot を webview localResourceRoots へ union（ensureResourceRootForFile precedent） */
    ensureResourceRoot(rootAbs: string): void;
    /** fs.rename の注入 seam（unit で EXDEV 等を再現するため。provider は fs.renameSync を渡す） */
    renameFs(absSrc: string, absDst: string): void;
    /** FR-FLV-15 (#17): エントリを OS ファイラで表示（revealFileInOS） */
    revealInOS(absPath: string): void;
    /** FR-FLV-15 (#18): エントリ絶対パスを OS clipboard へ（webview に返さない） */
    clipboardWriteText(text: string): void;
}

const FOLDER_VIEW_SEARCH_VISIT_CAP = 10000;
const FOLDER_VIEW_SEARCH_HIT_CAP = 500;
const FOLDER_VIEW_SEARCH_CHUNK = 500;

interface FolderViewEntry { name: string; relPath: string; isDir: boolean; }

/** relPath は webview 向けに常に '/' 区切り。 */
function joinRel(parentRel: string, name: string): string {
    return parentRel ? `${parentRel}/${name}` : name;
}

/**
 * FR-FLV-11: 1 階層の readdir（lstat 意味論 = withFileTypes の dirent flags。symlink 非追従・隠し除外・
 * フォルダ先行名前昇順）。folderRoot 配下 clamp 済みの絶対 dir を受ける内部ヘルパ。
 */
function readFolderEntriesAt(absDir: string, parentRel: string, showHidden?: boolean): FolderViewEntry[] {
    const entries: FolderViewEntry[] = [];
    const dirents = fs.readdirSync(absDir, { withFileTypes: true });
    for (const d of dirents) {
        const name = String(d.name);
        if (!showHidden && name.startsWith('.')) { continue; } // 隠しエントリ非表示（FR-FLV-11 既定 / FR-FLV-31 トグルで opt-in）
        if (d.isSymbolicLink()) { continue; }                  // symlink 非追従（NFR-FLV-01）
        if (!d.isDirectory() && !d.isFile()) { continue; }     // socket/fifo 等は対象外
        entries.push({ name, relPath: joinRel(parentRel, name), isDir: d.isDirectory() });
    }
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir) { return a.isDir ? -1 : 1; }  // フォルダ先行
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
    });
    return entries;
}

/** 操作後のリフレッシュ用: 対象 dir の list 結果を送る（clamp 失敗・読めない場合は送らない）。 */
function sendFolderViewList(fileManager: NotesFileManager, folderLinkId: string, relPath: string, sender: NotesSender): void {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) { return; }
    const absDir = safeResolveUnderFolderRoot(root, relPath);
    if (!absDir) { return; }
    const showHidden = readFolderViewShowHidden(root);
    let entries: FolderViewEntry[] = [];
    try { entries = readFolderEntriesAt(absDir, relPath, showHidden); } catch { return; }
    sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries, showHidden });
}

/** FR-FLV-11 (#6): 1 階層 list。broken/clamp 違反は error 付き応答（entries 空）。 */
export async function folderViewList(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries: [], error: 'broken' });
        return false;
    }
    const absDir = safeResolveUnderFolderRoot(root, relPath);
    if (!absDir) {
        sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries: [], error: 'clamp' });
        return false;
    }
    const showHidden = readFolderViewShowHidden(root);
    let entries: FolderViewEntry[] = [];
    try {
        entries = readFolderEntriesAt(absDir, relPath, showHidden);
    } catch {
        sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries: [], error: 'read' });
        return false;
    }
    // FR-FLV-26 (#6 改訂): root の list に開閉状態を同梱（現状 fs 優先 — 実在する dir のみ。
    // 消滅分は sidecar からも prune 保存 = 「読み込んだときの食い違いは現状優先・無ければ隠しファイルからも削除」）
    if (relPath === '') {
        const saved = readFolderViewExpanded(root);
        const alive = saved.filter((rel) => {
            const abs = safeResolveUnderFolderRoot(root, rel);
            try { return !!abs && fs.existsSync(abs) && fs.statSync(abs).isDirectory(); } catch { return false; }
        });
        if (alive.length !== saved.length) { saveFolderViewExpanded(root, alive); }
        sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries, savedExpanded: alive, showHidden });
        return true;
    }
    sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath, entries, showHidden });
    return true;
}

/**
 * FR-FLV-12 (#7): 名前部分一致検索（case-insensitive）。非同期チャンク走査 +
 * 上限（累計 10,000 走査 or 500 ヒットで truncated 打ち切り — NFR-FLV-02）。
 */
export async function folderViewSearch(
    fileManager: NotesFileManager,
    folderLinkId: string,
    query: string,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        sender.postMessage({ type: 'folderViewSearchResult', folderLinkId, query, hits: [], truncated: false, error: 'broken' });
        return false;
    }
    const q = String(query || '').toLowerCase();
    const hits: FolderViewEntry[] = [];
    let visited = 0;
    let truncated = false;
    // BFS（root から）。symlink 非追従・隠し除外は readFolderEntriesAt と同一規律
    //（QUAL-2 = FR-FLV-31: dotfile 除外は showHidden トグルに追従 — list に見えるのに検索で見つからない非対称を作らない）。
    const showHidden = readFolderViewShowHidden(root);
    const queue: string[] = [''];
    outer: while (queue.length > 0) {
        const rel = queue.shift() as string;
        const absDir = safeResolveUnderFolderRoot(root, rel);
        if (!absDir) { continue; }
        let dirents: fs.Dirent[];
        try { dirents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { continue; }
        for (const d of dirents) {
            const name = String(d.name);
            if ((!showHidden && name.startsWith('.')) || d.isSymbolicLink()) { continue; }
            if (!d.isDirectory() && !d.isFile()) { continue; }
            visited++;
            if (q && name.toLowerCase().includes(q)) {
                hits.push({ name, relPath: joinRel(rel, name), isDir: d.isDirectory() });
                if (hits.length >= FOLDER_VIEW_SEARCH_HIT_CAP) { truncated = true; break outer; }
            }
            if (d.isDirectory()) { queue.push(joinRel(rel, name)); }
            if (visited >= FOLDER_VIEW_SEARCH_VISIT_CAP) { truncated = true; break outer; }
            if (visited % FOLDER_VIEW_SEARCH_CHUNK === 0) {
                await new Promise<void>((resolve) => setImmediate(resolve)); // UI ブロック禁止（非同期チャンク）
            }
        }
    }
    sender.postMessage({ type: 'folderViewSearchResult', folderLinkId, query, hits, truncated });
    return true;
}

/** FR-FLV-14/23 (#8): open 分岐 — md=sidepanel / viewer 対象=viewer sidepanel / 他=外部起動。 */
export async function folderViewOpen(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    deps: FolderViewDeps
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const abs = safeResolveUnderFolderRoot(root, relPath);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        deps.showErrorMessage(deps.t('folderViewOpenFailed') || 'Cannot open the selected file.');
        return false;
    }
    deps.ensureResourceRoot(root); // note 外パスの webview 到達（ensureResourceRootForFile precedent）
    const base = path.basename(abs);
    if (/\.md$/i.test(base)) {
        await deps.openMdInSidePanel(abs);
    } else if (isViewerTarget(base)) {
        await deps.openViewerPanel(abs);
    } else {
        await deps.openExternal(abs);
    }
    return true;
}

/** FR-FLV-31: 隠しファイル表示トグル（sidecar upsert → root list 再送。filter は list 生成の一点共有）。 */
export async function folderViewToggleHidden(
    fileManager: NotesFileManager,
    folderLinkId: string,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        sender.postMessage({ type: 'folderViewListResult', folderLinkId, relPath: '', entries: [], error: 'broken' });
        return false;
    }
    saveFolderViewShowHidden(root, !readFolderViewShowHidden(root));
    return folderViewList(fileManager, folderLinkId, '', sender);
}

/** FR-FLV-15 (#9): New Markdown / New Folder（showInputBox → 同名エラー中断）。 */
export async function folderViewCreate(
    fileManager: NotesFileManager,
    folderLinkId: string,
    parentRelPath: string,
    kind: 'md' | 'folder',
    deps: FolderViewDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const name = await deps.showInputBox({
        prompt: kind === 'md'
            ? (deps.t('folderViewNewMarkdownPrompt') || 'New Markdown file name')
            : (deps.t('folderViewNewFolderPrompt') || 'New folder name'),
    });
    if (name === undefined || name === null || String(name).trim() === '') { return false; } // キャンセル = 副作用ゼロ
    let entryName = String(name).trim();
    if (kind === 'md' && !/\.md$/i.test(entryName)) { entryName += '.md'; }
    const abs = safeResolveUnderFolderRoot(root, joinRel(parentRelPath, entryName));
    if (!abs) {
        deps.showErrorMessage(deps.t('folderViewInvalidName') || 'Invalid name.');
        return false;
    }
    if (fs.existsSync(abs)) {
        deps.showErrorMessage(deps.t('folderViewNameConflict') || 'An entry with the same name already exists.');
        return false;
    }
    try {
        if (kind === 'md') {
            // FR-FLV-15 再オープン①: 入力名を H1 として初期内容に書く（空ファイル禁止）。stem = .md strip 後
            const stem = entryName.replace(/\.md$/i, '');
            fs.writeFileSync(abs, `# ${stem}\n`);
        } else {
            fs.mkdirSync(abs);
        }
    } catch (e) {
        notifyOperationFailed(deps, e);
        return false;
    }
    sendFolderViewList(fileManager, folderLinkId, parentRelPath, sender);
    return true;
}

/** FR-FLV-15/28 (#10): rename（同名エラー中断・元名維持）。newName は webview インライン編集で確定済み
 *（FR-FLV-28 再オープン① — showInputBox 方式は廃止。空・不変は no-op）。 */
export async function folderViewRename(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    newName: string,
    deps: FolderViewDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const absSrc = safeResolveUnderFolderRoot(root, relPath);
    if (!absSrc || !fs.existsSync(absSrc)) { return false; }
    const next = newName;
    if (next === undefined || next === null || String(next).trim() === '') { return false; }
    if (String(next).trim() === path.basename(absSrc)) { return false; } // 不変 = no-op
    const parentRel = parentRelOf(relPath);
    const absDst = safeResolveUnderFolderRoot(root, joinRel(parentRel, String(next).trim()));
    if (!absDst) {
        deps.showErrorMessage(deps.t('folderViewInvalidName') || 'Invalid name.');
        return false;
    }
    if (fs.existsSync(absDst)) {
        deps.showErrorMessage(deps.t('folderViewNameConflict') || 'An entry with the same name already exists.');
        return false;
    }
    try {
        deps.renameFs(absSrc, absDst);
    } catch (e) {
        notifyOperationFailed(deps, e);
        return false;
    }
    sendFolderViewList(fileManager, folderLinkId, parentRel, sender);
    return true;
}

/** FR-FLV-26 (#19): 開閉状態の保存。相対パス検証のみ（絶対 / `..` 開始は除外）— fs 実在チェックは
 * 復元側（folderViewList('') — 同梱前フィルタ + prune）の一元責務。書込失敗は sidecar util が silent skip。 */
export async function folderViewStateSave(
    fileManager: NotesFileManager,
    folderLinkId: string,
    expanded: string[],
    _deps: FolderViewDeps,
    _sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) { return false; }
    const cleaned = (Array.isArray(expanded) ? expanded : [])
        .filter((v) => typeof v === 'string' && v.trim() !== '')
        .map((v) => String(v))
        .filter((v) => !path.isAbsolute(v) && !v.split(/[\\/]/).some((seg) => seg === '..'));
    saveFolderViewExpanded(root, cleaned);
    return true;
}

/** FR-FLV-15 (#11): delete = 常に trash（恒久削除 API 不使用 — TC-FLV-13 番人）。 */
export async function folderViewDelete(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    deps: FolderViewDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const abs = safeResolveUnderFolderRoot(root, relPath);
    if (!abs || abs === path.resolve(root)) { return false; } // ルート自身は削除不可
    let isDir = false;
    try { isDir = fs.lstatSync(abs).isDirectory(); } catch { return false; }
    try {
        await deps.trashDelete(abs, isDir);
    } catch (e) {
        notifyOperationFailed(deps, e);
        return false;
    }
    const parentRel = parentRelOf(relPath);
    sendFolderViewList(fileManager, folderLinkId, parentRel, sender);
    return true;
}

/** FR-ACC-04: エントリの Duplicate（md = 資産随伴の同 dir 複製〔duplicateMdEntity・boundary = folderRoot〕
 *  / file = 単体複製 / dir = 非対応通知。clamp 経由・folderRoot 外は不発 — ADRL-ACC-3）。 */
export async function folderViewDuplicate(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    deps: FolderViewDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const abs = safeResolveUnderFolderRoot(root, relPath);
    if (!abs || abs === path.resolve(root) || !fs.existsSync(abs)) { return false; }
    let isDir = false;
    try { isDir = fs.lstatSync(abs).isDirectory(); } catch { return false; }
    if (isDir) {
        deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Folders cannot be duplicated.');
        return false;
    }
    try {
        if (/\.md$/i.test(abs)) {
            duplicateMdEntity(abs, path.resolve(root)); // 同 dir 複製 + 隣接資産 + subpage 再帰（ADRL-0078 改訂版）
        } else {
            const copied = copyEntityWithUniquify(abs, path.dirname(abs), path.basename(abs));
            if (!copied) {
                deps.showErrorMessage(deps.t('folderViewOperationFailed') || 'Duplicate failed.');
                return false;
            }
        }
    } catch (e) {
        notifyOperationFailed(deps, e);
        return false;
    }
    sendFolderViewList(fileManager, folderLinkId, parentRelOf(relPath), sender);
    return true;
}

/** FR-FLV-15 (#17): エントリの Reveal in Finder（clamp 経由・folderRoot 外は不発）。 */
export function folderViewRevealEntry(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    deps: FolderViewDeps
): boolean {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) { return false; }
    const abs = safeResolveUnderFolderRoot(root, relPath);
    if (!abs || !fs.existsSync(abs)) { return false; }
    deps.revealInOS(abs);
    return true;
}

/** FR-FLV-15 (#18): エントリの Copy Path（host→OS clipboard 直 — webview 応答なし = INV-4）。 */
export function folderViewCopyEntryPath(
    fileManager: NotesFileManager,
    folderLinkId: string,
    relPath: string,
    deps: FolderViewDeps
): boolean {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) { return false; }
    const abs = safeResolveUnderFolderRoot(root, relPath);
    if (!abs) { return false; }
    deps.clipboardWriteText(abs);
    return true;
}

/** FR-FLV-16 (#12): ビュー内移動（fs.rename・同名/自己子孫/EXDEV はエラー中断 — 面間と違い copy 方式にしない）。 */
export async function folderViewMove(
    fileManager: NotesFileManager,
    folderLinkId: string,
    srcRelPath: string,
    dstDirRelPath: string,
    deps: FolderViewDeps,
    sender: NotesSender
): Promise<boolean> {
    const root = fileManager.resolveFolderRoot(folderLinkId);
    if (!root) {
        deps.showErrorMessage(deps.t('folderLinkBroken') || 'Linked folder not found. Re-link it first.');
        return false;
    }
    const absSrc = safeResolveUnderFolderRoot(root, srcRelPath);
    const absDstDir = safeResolveUnderFolderRoot(root, dstDirRelPath);
    if (!absSrc || !absDstDir || !fs.existsSync(absSrc)) { return false; }
    let dstIsDir = false;
    try { dstIsDir = fs.statSync(absDstDir).isDirectory(); } catch { return false; }
    if (!dstIsDir) { return false; }
    // フォルダを自分自身/自分の子孫へ → no-op エラー
    if (absDstDir === absSrc || absDstDir.startsWith(absSrc + path.sep)) {
        deps.showErrorMessage(deps.t('folderViewMoveIntoSelf') || 'Cannot move a folder into itself.');
        return false;
    }
    const absDst = path.join(absDstDir, path.basename(absSrc));
    if (absDst === absSrc) { return false; } // 同一位置 no-op
    if (fs.existsSync(absDst)) {
        deps.showErrorMessage(deps.t('folderViewNameConflict') || 'An entry with the same name already exists.');
        return false;
    }
    try {
        deps.renameFs(absSrc, absDst);
    } catch (e: any) {
        // EXDEV 含めエラー中断（copy+delete フォールバック禁止 — 受容事項 5）
        if (e && e.code === 'EXDEV') {
            deps.showErrorMessage(deps.t('folderViewMoveExdev') || 'Cannot move across devices.');
        } else {
            notifyOperationFailed(deps, e);
        }
        return false;
    }
    const srcParentRel = parentRelOf(srcRelPath);
    sendFolderViewList(fileManager, folderLinkId, srcParentRel, sender);
    if (dstDirRelPath !== srcParentRel) {
        sendFolderViewList(fileManager, folderLinkId, dstDirRelPath, sender);
    }
    return true;
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
 * - file: / vscode-remote: scheme を受理（droppedUriToFsPath 正典 — FR-RMT-01。他 scheme は silent skip）
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
            // URI → fs パス変換は正典 droppedUriToFsPath（file: / vscode-remote: 受理 — FR-RMT-01）。
            // null = その他 scheme → 従来どおり silent skip
            const fsPath = droppedUriToFsPath(uri);
            if (fsPath === null) { continue; }
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

/**
 * FR-FTM-03 (sprint 20260818-183407): tree item（out/md/file）の Duplicate。
 * 実体複製は DuplicationCore（paste-asset-handler の duplicate*Entity — ADRL-0078・uniquify 正典）。
 * 台帳は元 item の直後に新 item を挿入（title は uniquify サフィックス追従 — 名前の発明なし）。
 * 複製後の 2 item は資産を一切共有しない（1:1 所有維持）。folder link / 実フォルダは対象外
 * （メニュー非表示 — requirement の裁定）。
 */
export function duplicateTreeItemCore(
    fileManager: NotesFileManager,
    itemId: string,
    sender: NotesSender
): boolean {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dup = require('./paste-asset-handler');
    const structure = fileManager.getStructure();
    const item = structure.items[itemId];
    if (!item || item.type !== 'file') { return false; }
    const mainFolder = fileManager.getMainFolderPath();

    /** siblings 配列（root or 親 folder の childIds）の元 item 直後に newId を挿入 */
    const insertAfterOriginal = (newId: string): void => {
        let siblings = structure.rootIds;
        for (const id of Object.keys(structure.items)) {
            const it = structure.items[id];
            if (it?.type === 'folder' && (it as { childIds?: string[] }).childIds?.includes(itemId)) {
                siblings = (it as { childIds: string[] }).childIds;
                break;
            }
        }
        const idx = siblings.indexOf(itemId);
        siblings.splice(idx >= 0 ? idx + 1 : siblings.length, 0, newId);
    };
    /** uniquify で付いたサフィックス（'-1' 等）を title に追従させる */
    const titleWithSuffix = (oldStem: string, newStem: string, title: string): string => {
        if (newStem.startsWith(oldStem)) { return (title || newStem) + newStem.slice(oldStem.length); }
        return title || newStem;
    };

    try {
        const ext = (item as { ext?: string }).ext;
        if (ext === 'file') {
            const filename = (item as { filename?: string }).filename;
            if (!filename) { return false; }
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { resolveMdFilesDir } = require('./flat-layout');
            const filesDir = resolveMdFilesDir(mainFolder);
            const newName = dup.duplicateFileEntity(filesDir, filename);
            const newId = NotesFileManager.generateOutlineId();
            const oldStem = path.basename(filename, path.extname(filename));
            const newStem = path.basename(newName, path.extname(newName));
            structure.items[newId] = {
                type: 'file', id: newId,
                title: titleWithSuffix(oldStem, newStem, item.title),
                ext: 'file', filename: newName,
            } as typeof item;
            insertAfterOriginal(newId);
            fileManager.saveStructure();
        } else if (ext === 'md') {
            const mdPath = fileManager.getMdFilePath(itemId);
            if (!fs.existsSync(mdPath)) { return false; }
            const r = dup.duplicateMdEntity(mdPath, mainFolder);
            // 新 item id = 新 stem（getMdFilePath(id) = <note>/<id>.md の対応を保つ）
            structure.items[r.newStem] = {
                type: 'file', id: r.newStem,
                title: titleWithSuffix(itemId, r.newStem, item.title),
                ext: 'md',
            } as typeof item;
            insertAfterOriginal(r.newStem);
            fileManager.saveStructure();
        } else {
            // .out item（ext なし）
            const outPath = path.join(mainFolder, `${itemId}.out`);
            if (!fs.existsSync(outPath)) { return false; }
            const r = dup.duplicateOutEntity(outPath, mainFolder);
            structure.items[r.newOutId] = {
                type: 'file', id: r.newOutId,
                title: titleWithSuffix(itemId, r.newOutId, item.title),
            } as typeof item;
            insertAfterOriginal(r.newOutId);
            fileManager.saveStructure();
        }
    } catch (e) {
        console.error('[Notes] duplicateTreeItemCore failed:', itemId, e);
        return false;
    }
    sendFileListWithStructure(fileManager, sender);
    return true;
}
