'use strict';
/**
 * Outliner clip-source selector (round-trip stale-clipboard 修正)
 *
 * paste 時にどのクリップボード源（webview 内部の internalClipboard か OS クリップボードの
 * crossMeta か）を採用するかを純粋に判定する。copyId(nonce) 照合で「同一コピー操作」の時だけ
 * internalClipboard を優先し、それ以外は「OS クリップボード = 最新の真実」として crossMeta を優先。
 *
 * これにより「別 webview で別ノードをコピー → OS クリップボードは最新だが貼り付け先の古い
 * internalClipboard が同一テキストでシャドウ」が起きなくなる。
 *
 * markdown-link-parser.js と同じ IIFE dual-load（CommonJS + global）。
 * 純関数なので webview 無しで unit test できる。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.OutlinerClipSelect = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    /**
     * selectClipSource(internalClip, crossMeta, clipText)
     *   internalClip: webview 保持の内部クリップボード
     *                 ({plainText, isCut, nodes, sourceOutFileKey, copyId} | null)
     *   crossMeta:    OS クリップボード HTML から抽出したメタ
     *                 ({nodes, isCut, sourceOutFileKey, copyId} | null)
     *   clipText:     OS クリップボードの text/plain
     * 戻り値: { source: 'internal'|'cross', nodes, isCut, sourceOutFileKey } | null
     *
     * 規則（優先順）:
     *   1. internalClip があり plainText===clipText、かつ
     *      (crossMeta が無い) または (両方 copyId を持ち一致) → internal を採用（同一コピー操作の高速路）。
     *      ★ copyId がどちらか一方でも欠けていれば「同一 op」とは見なさない
     *         （undefined===undefined を一致扱いしない）。
     *   2. crossMeta があり nodes を持つ → crossMeta を採用（別コピー操作 or 別 webview / stale 防止）。
     *   3. internalClip があり plainText===clipText → internal を採用（OS クリップボード API 失敗時 fallback）。
     *   4. どちらも無ければ null（貼り付け対象なし）。
     */
    function selectClipSource(internalClip, crossMeta, clipText) {
        var hasCross = !!(crossMeta && crossMeta.nodes);
        var intTextMatch = !!(internalClip && internalClip.plainText === clipText);

        // 1. 同一コピー操作の高速路: internal テキスト一致 かつ（crossMeta 無し or copyId 一致）
        if (intTextMatch) {
            if (!hasCross) {
                // crossMeta が無い（＝ OS クリップボードに outliner メタが無い）。
                // 但し規則 3 の fallback と同義なので、ここで internal を採用してよい。
                return {
                    source: 'internal',
                    nodes: internalClip.nodes,
                    isCut: !!internalClip.isCut,
                    sourceOutFileKey: internalClip.sourceOutFileKey || null
                };
            }
            // crossMeta あり: copyId が両方に存在して一致する時のみ「同一 op」= internal 優先。
            // 片方でも copyId 欠落 or 不一致なら「別 op」= crossMeta 優先（下の 2 へ落ちる）。
            var sameOp = internalClip.copyId != null &&
                         crossMeta.copyId != null &&
                         internalClip.copyId === crossMeta.copyId;
            if (sameOp) {
                return {
                    source: 'internal',
                    nodes: internalClip.nodes,
                    isCut: !!internalClip.isCut,
                    sourceOutFileKey: internalClip.sourceOutFileKey || null
                };
            }
        }

        // 2. crossMeta を採用（別コピー操作 / 別 webview / copyId 不明で stale 防止）
        if (hasCross) {
            return {
                source: 'cross',
                nodes: crossMeta.nodes,
                isCut: !!crossMeta.isCut,
                sourceOutFileKey: crossMeta.sourceOutFileKey || null
            };
        }

        // 3. crossMeta 無し・internal テキスト一致（規則 1 の crossMeta 無し分岐で既に return 済み）。
        //    ここに来るのは intTextMatch=false かつ crossMeta 無し → 貼り付け対象なし。

        // 4. 何も無い
        return null;
    }

    return {
        selectClipSource: selectClipSource
    };
}));
