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
}

interface ClipboardData {
    plainText: string;
    isCut: boolean;
    nodes: ClipboardNodeData[];
    sourcePagesDirPath: string;
    sourceImagesDirPath: string;
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

    static consumeIfCut(plainText: string): void {
        if (!this.data) return;
        if (
            this.data.plainText === plainText ||
            this.data.plainText.trim() === (plainText || '').trim()
        ) {
            if (this.data.isCut) this.data = null;
        }
    }
}
