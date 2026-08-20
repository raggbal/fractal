/**
 * HostBridge — editor.js とホスト環境(VSCode / Electron / テスト)間の通信インターフェース
 *
 * editor.js は window.hostBridge を通じてホスト側と通信する。
 * 各ホスト環境が HostBridge を実装し、editor.js の前に <script> で注入する。
 */

/** md export bundle のオプション (FR-EX-02) */
export interface ExportBundleOptions {
    includeChildren: boolean;
    recurseChildren: boolean;
    includeLinks: boolean;
    recurseLinks: boolean;
}

/** editor.js → ホスト (送信) */
export interface HostBridge {
    // ドキュメント操作
    syncContent(markdown: string): void;
    save(): void;

    /** outliner node リスト paste の添付複製 (sprint 20260727-124904 / ADRL-0001)。
     *  nodes は検知/fallback 用 — ソース dir の真実は host の OutlinerClipboardStore。
     *  結果は pasteWithAssetCopyResult message で返る（destination 札を echo back — FR-PDB-01）。 */
    pasteOutlinerNodesWithAssets?(plainText: string, nodes: unknown[], sidePanelFilePath?: string, destination?: string): void;

    // フォーカス/編集状態
    reportEditingState(editing: boolean): void;
    reportFocus(): void;
    reportBlur(): void;

    // ホスト側 UI が必要な操作
    openLink(href: string): void;
    openLinkInTab(href: string): void;
    requestInsertLink(text: string): void;
    requestInsertImage(sidePanelFilePath?: string): void;
    saveImageAndInsert(dataUrl: string, fileName?: string, sidePanelFilePath?: string): void;
    readAndInsertImage(filePath: string, sidePanelFilePath?: string): void;
    saveFileAndInsert(dataUrl: string, fileName: string, sidePanelFilePath?: string): void;
    readAndInsertFile(filePath: string, sidePanelFilePath?: string): void;
    openInTextEditor(): void;
    copyFilePath(): void;
    sendToChat(startLine: number, endLine: number, selectedMarkdown: string, sidePanelFilePath?: string): void;
    saveSidePanelFile(filePath: string, content: string): void;
    sidePanelOpenLink(href: string, sidePanelFilePath: string): void;
    notifySidePanelClosed(): void;
    sidePanelOpenInTextEditor(sidePanelFilePath: string): void;
    getSidePanelImageDir(sidePanelFilePath: string): void;

    // ページ追加 (Action Panel)
    searchFiles(query: string): void;
    createPageAtPath(relativePath: string): void;
    createPageAuto(): void;
    updatePageH1(relativePath: string, h1Text: string): void;

    // リソースアクセス範囲設定 (FR-RR-06)
    openResourceRootsSettings(): void;

    // 保存先変更 (FR-MD-03, standalone md 限定)
    setSaveDir(kind: 'image' | 'file'): void;

    // md export bundle (FR-EX-01)
    exportBundle(options: ExportBundleOptions, sidePanelFilePath?: string): void;

    // ホストからのメッセージ受信
    onMessage(handler: (message: HostMessage) => void): void;
}

/** ホスト → editor.js (受信メッセージ型) */
export type HostMessage =
    | { type: 'update'; content: string }
    | { type: 'performUndo' }
    | { type: 'performRedo' }
    | { type: 'toggleSourceMode' }
    | { type: 'insertImageHtml'; markdownPath: string; displayUri: string; sidePanelFilePath?: string }
    | { type: 'insertLinkHtml'; url: string; text: string }
    | { type: 'externalChangeDetected'; message: string }
    | { type: 'scrollToAnchor'; anchor: string; headingIndex?: number }
    | { type: 'imageDirStatus'; displayPath: string; source: 'file' | 'settings' | 'default' }
    | { type: 'sidePanelImageDirStatus'; displayPath: string; source: 'file' | 'settings' | 'default' }
    | { type: 'insertFileLink'; markdownPath: string; fileName: string; sidePanelFilePath?: string }
    | { type: 'fileDirStatus'; displayPath: string; source: 'file' | 'settings' | 'default' }
    | { type: 'sidePanelFileDirStatus'; displayPath: string; source: 'file' | 'settings' | 'default' }
    | { type: 'openSidePanel'; content: string; filePath: string; fileName: string }
    | { type: 'fileSearchResults'; results: string[]; query: string }
    | { type: 'pageCreatedAtPath'; relativePath: string }
    | { type: 'resourceAccessStatus'; outOfRange: boolean; count: number; samplePath?: string };

/** window にグローバルとして注入される */
declare global {
    interface Window {
        hostBridge: HostBridge;
    }
}
