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
    /**
     * copy / cut の対象だった **`.out` ファイルそのもの**の絶対パス（ADRL-0121 rev1 / TASK-29）。
     *
     * `sourceOutDir` だけだと containment が**ディレクトリ単位**になり、同一フォルダ内の
     * 無関係な別 `.out` 文書まで読み出せてしまう（reviewer iteration 2 SEC-6）。
     * optional にしているのは既存呼び出し元（asset 解決系 4 本）が渡さなくても壊れないため。
     */
    sourceOutFilePath?: string;
}

export class OutlinerClipboardStore {
    private static data: ClipboardData | null = null;

    static save(data: ClipboardData): void {
        this.data = data;
    }

    /**
     * 引数を取らず「最新のコピー内容」をそのまま返す（ADRL-0121 / TASK-29）。
     *
     * 🔴 `get(plainText)` は末尾で**無条件に `this.data` を返す**ため引数に何を渡しても動くが、
     *    その性質は型シグネチャからは保証されない実装の偶然。`resolveTrustedOutPath` /
     *    `trustedSrcOutDir`（`notes-message-handler.ts`）は「plainText ではなくファイルパス」を
     *    渡していたため、将来 `get()` の一致判定が厳格化されると**常に null** を返して
     *    G-paste と D&D 送出の両方が無条件で無反応化する潜在トラップだった（reviewer iteration 2 DESIGN-5）。
     *    provenance 検査の用途はこの `peek()` を使う。
     */
    static peek(): ClipboardData | null {
        return this.data;
    }

    /**
     * ⚠️ 末尾の**無条件 `return this.data;`**（下記）を削除・厳格化する場合は、
     *    `src/shared/notes-message-handler.ts` の `resolveTrustedOutPath` / `trustedSrcOutDir` が
     *    `peek()` を使っていることを確認すること（かつては `get()` にファイルパスを渡していた）。
     */
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
