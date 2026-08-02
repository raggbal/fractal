'use strict';

/**
 * pdf-export-webview.js — md → PDF エクスポートの webview 側清書（sprint 20260802-075012-md-pdf-export）
 *
 * webview 内で editor.js / outliner.js と同居する独立した共有 JS。編集系スクリプトからは独立。
 * host（extension.ts の runExportMdToPdf）が panel.webview.postMessage({type:'requestPdfHtml', requestId})
 * を送ると、この listener が対象 md の DOM を回収 → 清書 HTML を postMessage({type:'pdfHtmlResult'}) で返す。
 *
 * 設計正典: design/system.md §2.1 / §3 + ADRL-0035（webview DOM 回収）
 *
 * 露出（E2E 駆動 seam・inline-color.js の window.InlineColor と同型）:
 *   window.PdfExport = { buildPdfExportHtml, resolvePdfTarget, cleanPdfImageSrc }
 *
 * 二重ロード安全: `if (window.PdfExport) return;` の先勝ちガード（editor.js + outliner.js 両ロードでも
 *   listener は 1 回登録・応答は __pdfExportHandledRequests Set で requestId 単位に 1 回に抑制）。
 */
(function () {
    // ── 先勝ちガード（二重ロード時は何もしない）──────────────────────────────
    if (typeof window !== 'undefined' && window.PdfExport) { return; }

    // ── §3-3 img src 逆変換（自己完結・cleanImageSrc は流用しない = ADRL-0035）──────
    // cleanImageSrc（editor-utils.js:190-196）は `data:` を '' に落とす副作用があるため流用禁止。
    // 規則:
    //   1. webview-resource URI（`file+`/`file%2B` 両変種）→ 接頭辞除去 + ?query/#fragment 除去 →
    //      絶対 fs パス（decodeURIComponent で %XX を戻す。デコード失敗時は raw を返す）
    //   2. `data:` → 無傷でそのまま（重要）
    //   3. `http(s):`（vscode-resource 以外）→ そのまま
    //   4. それ以外（相対・絶対パス）→ そのまま
    function cleanPdfImageSrc(src) {
        if (typeof src !== 'string' || src === '') { return src; }
        // data: は無傷（cleanImageSrc がここを '' に落とすため流用禁止とされた）
        if (src.indexOf('data:') === 0) { return src; }
        // webview-resource URI プレフィクス（`+` と `%2B` の両変種）
        var reResource = /^https:\/\/file(?:\+|%2B)\.vscode-resource\.vscode-cdn\.net/;
        if (reResource.test(src)) {
            var rest = src.replace(reResource, '');
            // ?query / #fragment を除去（先に現れる方から後ろを切る）
            var qIdx = rest.indexOf('?');
            if (qIdx !== -1) { rest = rest.slice(0, qIdx); }
            var hIdx = rest.indexOf('#');
            if (hIdx !== -1) { rest = rest.slice(0, hIdx); }
            // 絶対 fs パス（%20 等をデコード）。不正な % シーケンスで throw しうるので防御
            try { return decodeURIComponent(rest); } catch (_e) { return rest; }
        }
        // vscode-resource 以外の http(s): / 相対 / 絶対はそのまま保持（FR-PDF-06）
        return src;
    }

    // ── §3 清書純関数 buildPdfExportHtml（NFR-PDF-04: 元 DOM を一切変更しない）──────
    // 入力: editorEl（.editor 要素 = contenteditable な WYSIWYG コンテンツルート）
    // return: { html: <清書済み innerHTML> }
    function buildPdfExportHtml(editorEl) {
        if (!editorEl || typeof editorEl.cloneNode !== 'function') {
            return { html: '' };
        }
        // 1. clone（deep）。以降 clone のみを操作し元 DOM は read-only（NFR-PDF-04）
        var clone = editorEl.cloneNode(true);

        // 2. checkbox の checked property を clone 側の checked 属性へ焼き付け
        //    （cloneNode は property を保存しない → property の checked を属性に転写）
        //    対応付けは querySelectorAll の同一 index（元 editorEl / clone で DOM 構造が一致する前提）
        try {
            var srcChecks = editorEl.querySelectorAll('input[type=checkbox]');
            var dstChecks = clone.querySelectorAll('input[type=checkbox]');
            var nChk = Math.min(srcChecks.length, dstChecks.length);
            for (var ci = 0; ci < nChk; ci++) {
                if (srcChecks[ci].checked) {
                    dstChecks[ci].setAttribute('checked', '');
                } else {
                    dstChecks[ci].removeAttribute('checked');
                }
            }
        } catch (_c) { /* checkbox が無い/走査失敗でも清書は続行 */ }

        // 3. clone から contenteditable / spellcheck 属性を除去（要素は残し属性のみ）
        try {
            var editableEls = clone.querySelectorAll('[contenteditable]');
            for (var ei = 0; ei < editableEls.length; ei++) {
                editableEls[ei].removeAttribute('contenteditable');
            }
            var spellEls = clone.querySelectorAll('[spellcheck]');
            for (var si = 0; si < spellEls.length; si++) {
                spellEls[si].removeAttribute('spellcheck');
            }
            // clone ルート自身にも属性が付いていれば除去
            if (clone.removeAttribute) {
                clone.removeAttribute('contenteditable');
                clone.removeAttribute('spellcheck');
            }
        } catch (_a) { /* 属性除去失敗でも続行 */ }

        // 3b. 一時 UI クラスの除去（.drag-over 等・存在すれば class から除去）
        try {
            var TRANSIENT_CLASSES = ['drag-over', 'dragover', 'drop-target', 'drag-active'];
            for (var tc = 0; tc < TRANSIENT_CLASSES.length; tc++) {
                var withClass = clone.querySelectorAll('.' + TRANSIENT_CLASSES[tc]);
                for (var wi = 0; wi < withClass.length; wi++) {
                    withClass[wi].classList.remove(TRANSIENT_CLASSES[tc]);
                }
            }
        } catch (_t) { /* class 除去失敗でも続行 */ }

        // 3c. UI 補助要素の除去（drag handle / placeholder / カーソル系。存在すれば削除・無ければ何もしない）
        try {
            var UI_SELECTORS = [
                '.drag-handle', '.drag-handle-container',
                '.editor-placeholder', '.placeholder',
                '.fake-cursor', '.cursor-overlay', '.ime-helper', '.composition-helper'
            ];
            for (var us = 0; us < UI_SELECTORS.length; us++) {
                var junk = clone.querySelectorAll(UI_SELECTORS[us]);
                for (var ji = 0; ji < junk.length; ji++) {
                    if (junk[ji].parentNode) { junk[ji].parentNode.removeChild(junk[ji]); }
                }
            }
        } catch (_u) { /* 補助要素除去失敗でも続行 */ }

        // 4. clone 内の全 img[src] を src 逆変換（絶対 fs パス化・data:/http(s): は保持）
        try {
            var imgs = clone.querySelectorAll('img[src]');
            for (var ii = 0; ii < imgs.length; ii++) {
                var orig = imgs[ii].getAttribute('src');
                imgs[ii].setAttribute('src', cleanPdfImageSrc(orig));
            }
        } catch (_i) { /* img 走査失敗でも続行 */ }

        // 5. return（innerHTML）
        return { html: clone.innerHTML };
    }

    // ── §2.1 対象解決 resolvePdfTarget（解決順が仕様）──────────────────────────
    // return: { editorEl, filePath } | null
    // 解決順:
    //   (1) Notes アクティブタブの md instance（window.__pdfExportSources.mainMd）
    //       無ければ document 上の可視な main `.editor`（outliner モードでない場合）
    //   (2) sidePanelInstance（window.__pdfExportSources.sidePanel）
    //       無ければ `.side-panel .editor`
    //   (3) standalone の唯一 instance（document.querySelector('.editor')）
    //   (4) いずれも実要素なし / 空 → null
    // 実装は防御的に（存在しないグローバル参照で throw しない・optional chaining 徹底）。
    function resolvePdfTarget() {
        var sources = (typeof window !== 'undefined' && window.__pdfExportSources) || null;

        // ---- (1) Notes アクティブタブの md instance ----
        var t1 = _tryResolveSource(sources && sources.mainMd);
        if (t1) { return t1; }
        // fallback: document 上の main .editor（outliner モードでなく、実体があり空でない）
        if (!_isOutlinerMode()) {
            var mainEl = _queryMainEditor();
            if (_hasContent(mainEl)) {
                return { editorEl: mainEl, filePath: _resolveFilePath(null) };
            }
        }

        // ---- (2) sidePanelInstance ----
        var t2 = _tryResolveSource(sources && sources.sidePanel);
        if (t2) { return t2; }
        var spEl = _safeQuery('.side-panel .editor');
        if (_hasContent(spEl)) {
            return { editorEl: spEl, filePath: _resolveFilePath(null) };
        }

        // ---- (3) standalone の唯一 instance ----
        var soloEl = _safeQuery('.editor');
        if (_hasContent(soloEl)) {
            return { editorEl: soloEl, filePath: _resolveFilePath(null) };
        }

        // ---- (4) 該当なし ----
        return null;
    }

    // __pdfExportSources のエントリ（{getEditorEl, getFilePath} 形）を試して {editorEl, filePath}|null を返す
    function _tryResolveSource(entry) {
        if (!entry || typeof entry.getEditorEl !== 'function') { return null; }
        var el = null;
        try { el = entry.getEditorEl(); } catch (_e) { el = null; }
        if (!_hasContent(el)) { return null; }
        var fp = null;
        if (typeof entry.getFilePath === 'function') {
            try { fp = entry.getFilePath(); } catch (_f) { fp = null; }
        }
        return { editorEl: el, filePath: fp || _resolveFilePath(null) };
    }

    // outliner モード判定（.out タブ表示中。body の outliner-sync-locked ではなく構造で判定）
    function _isOutlinerMode() {
        try {
            // outliner の tree が実在し、main .editor が無い / 隠れている場合を outliner とみなす。
            // ここは「main .editor が可視な md ペインか」を主判定にするため、
            // outliner-tree があり main .editor に中身が無いケースを除外する目的で軽く判定する。
            var tree = _safeQuery('.outliner-tree');
            if (!tree) { return false; }
            // outliner-tree があっても、main .editor に中身があれば md ペイン優先（Notes md タブ）。
            var mainEl = _queryMainEditor();
            if (_hasContent(mainEl)) { return false; }
            return true;
        } catch (_e) { return false; }
    }

    // main の .editor 要素（side-panel 内の .editor は除外）
    function _queryMainEditor() {
        try {
            var all = document.querySelectorAll('.editor');
            for (var i = 0; i < all.length; i++) {
                if (!all[i].closest || !all[i].closest('.side-panel')) {
                    return all[i];
                }
            }
        } catch (_e) { /* noop */ }
        return null;
    }

    function _safeQuery(sel) {
        try { return document.querySelector(sel); } catch (_e) { return null; }
    }

    // 要素が実在し、内容が空でない（textContent trim or 子要素あり）
    function _hasContent(el) {
        if (!el) { return false; }
        try {
            if (el.children && el.children.length > 0) { return true; }
            var txt = (el.textContent || '').replace(/\s+/g, '');
            return txt.length > 0;
        } catch (_e) { return false; }
    }

    // filePath 解決: 既知グローバル（bridge の filePath）を防御的に探す。取れなければ null（host 側 fallback）
    function _resolveFilePath(explicit) {
        if (explicit) { return explicit; }
        try {
            if (window.notesMarkdownHostBridge && window.notesMarkdownHostBridge.filePath) {
                return window.notesMarkdownHostBridge.filePath;
            }
        } catch (_a) { /* noop */ }
        try {
            if (window.hostBridge && window.hostBridge.filePath) {
                return window.hostBridge.filePath;
            }
        } catch (_b) { /* noop */ }
        return null;
    }

    // ── ホスト送信関数の防御的取得（acquireVsCodeApi は 1 度しか呼べない → 再呼び出し禁止）──────
    // 既存の bridge IIFE（vscode-host-bridge.js / notes-host-bridge.js）は acquireVsCodeApi() を
    // closure 内 postFn に閉じ込めており、window 上に vscode api を露出していない。
    // よって「TASK-06 が配線する window.__pdfExportPost（host 送信関数）」を最優先で使う。
    // fallback として過去互換の window.__vscodeApi / window.vscodeApi があれば使う（無ければ postMessage しない）。
    function _getPost() {
        // (1) TASK-06 で配線される専用送信関数（推奨経路）
        try {
            if (typeof window.__pdfExportPost === 'function') {
                return function (msg) { window.__pdfExportPost(msg); };
            }
        } catch (_a) { /* noop */ }
        // (2) 既存グローバルに vscode api が保持されていれば使う（防御的・存在しなければ skip）
        try {
            if (window.__vscodeApi && typeof window.__vscodeApi.postMessage === 'function') {
                return function (msg) { window.__vscodeApi.postMessage(msg); };
            }
        } catch (_b) { /* noop */ }
        try {
            if (window.vscodeApi && typeof window.vscodeApi.postMessage === 'function') {
                return function (msg) { window.vscodeApi.postMessage(msg); };
            }
        } catch (_c) { /* noop */ }
        // (3) 見つからなければ null（postMessage しない = 副作用ゼロ）
        return null;
    }

    // ── §2.1 専用 message listener（type 不一致は即 return = 既存スクリプトへの副作用ゼロ）──────
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.__pdfExportHandledRequests = window.__pdfExportHandledRequests || new Set();
        window.addEventListener('message', function (e) {
            var m = e && e.data;
            if (!m || m.type !== 'requestPdfHtml') { return; }   // 他 message は即 return
            if (window.__pdfExportHandledRequests.has(m.requestId)) { return; } // requestId dedup
            window.__pdfExportHandledRequests.add(m.requestId);

            var post = _getPost();

            var target = null;
            try { target = resolvePdfTarget(); } catch (_e) { target = null; }

            if (!target) {
                if (post) { post({ type: 'pdfHtmlResult', requestId: m.requestId, error: 'no-target' }); }
                return;
            }

            var built;
            try {
                built = buildPdfExportHtml(target.editorEl);
            } catch (_b) {
                if (post) { post({ type: 'pdfHtmlResult', requestId: m.requestId, error: 'no-target' }); }
                return;
            }

            if (post) {
                post({
                    type: 'pdfHtmlResult',
                    requestId: m.requestId,
                    html: built.html,
                    filePath: target.filePath || null
                });
            }
        });
    }

    // ── §5 window 露出（E2E seam・必須）──────────────────────────────────────
    var _api = {
        buildPdfExportHtml: buildPdfExportHtml,
        resolvePdfTarget: resolvePdfTarget,
        cleanPdfImageSrc: cleanPdfImageSrc
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = _api;
    }
    if (typeof window !== 'undefined') {
        window.PdfExport = _api;
    }
})();
