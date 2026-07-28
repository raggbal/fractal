/**
 * OutlinerClipboardStore — Cross-outliner clipboard singleton.
 *
 * 全 OutlinerProvider / NotesEditorProvider パネルから参照可能。
 * webview 側で copy/cut 時に saveOutlinerClipboard メッセージ経由で保存し、
 * paste 時に copyPageFileCross / copyImagesCross メッセージ経由でソースの絶対パスを取得する。
 */

export interface ClipboardNodeData {
    text: string;
    level: number;
    isPage: boolean;
    pageId: string | null;
    images: string[];
    filePath?: string | null;
}

interface ClipboardData {
    plainText: string;
    isCut: boolean;
    nodes: ClipboardNodeData[];
    sourcePagesDirPath: string;
    sourceImagesDirPath: string;
    sourceFileDirPath: string;
    sourceOutDir: string;  // .out ファイルのあるディレクトリ (絶対パス) — 画像パス解決の基準
}

export class OutlinerClipboardStore {
    private static data: ClipboardData | null = null;

    static save(data: ClipboardData): void {
        this.data = data;
    }

    static get(plainText: string): ClipboardData | null {
        if (!this.data) return null;
        // plainText の完全一致は OS クリップボード経由の改行正規化等で
        // 壊れやすいため、シングルトン保持の最新データをそのまま返す。
        // paste 側は先に HTML メタデータ (crossMeta) の存在を確認済みで、
        // このメソッドが呼ばれる時点で stored data は同一コピー操作のもの。
        // 念のため trim 後一致でも許容する。
        if (this.data.plainText === plainText) return this.data;
        if (this.data.plainText.trim() === (plainText || '').trim()) return this.data;
        return this.data;
    }

    /**
     * sprint 20260728-200503: 旧 consumeIfCut（cut の最初の cross message 処理後に Store を
     * null 化する one-shot 消費）は廃止。paste は node ごとに 1 message
     * （handlePageAssetsCross / copyImagesCross / handleFileAssetCross）を送るため、
     * 1 個目の処理でストアを消すと 2 個目以降の全 asset が store miss → silent no-op になり
     * 「複数 asset node の cut/copy→paste で 1 個目しか複製されない」データ整合バグを生んでいた。
     * cut の「元を消す」処理は webview 側 deleteSelectedNodes() が担っており、Store の消費は
     * 不要（次の copy/cut の save で自然に上書きされる）。
     */
}
