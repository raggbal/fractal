/**
 * file-viewer.js — file viewer webview 本体（PDF レンダ + HTML sandbox 表示 + 読み込み失敗 UI）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-03（PDF）/ FR-FV-04（HTML）/ FR-FV-07（失敗 UI）。
 * ADRL-0064（HTML = iframe 方式 A・sandbox="" 完全静的 — TC-FV-90 スパイク実測で確定）/
 * ADRL-0065（PDF = pdfjs 4.10.38 browser バンドル + pdf_viewer.mjs）。
 *
 * md 実装（editor.js / EditorInstance / SidePanelHostBridge / notes-md-dispatcher）への
 * import / window 参照は禁止（NFR-FV-02 — TC-FV-31 が番人）。
 *
 * 設定は window.__viewerConfig（host の fileViewerContent.ts / テストハーネスが注入）:
 *   { pdfjsLibUri, workerUri, cMapUrl, standardFontDataUrl, kind?, fileUri? }
 * kind/fileUri があれば自動オープン（standalone 面）。sidepanel/note 面は
 * window.__fileViewer.open(kind, uri, mountEl) で任意の要素にマウントする（1 実装 3 マウント）。
 */
(function () {
    'use strict';

    // acquireVsCodeApi は webview につき 1 回しか呼べない — notes/outliner webview では
    // host-bridge が取得済みで 2 回目は throw する（SEC-2 修正で実測）。try/catch + 既存
    // bridge の post 関数（__pdfExportPost = notes/outliner 両 bridge が公開済み）に縮退する
    let vscode = null;
    try {
        vscode = typeof window.acquireVsCodeApi === 'function' ? window.acquireVsCodeApi() : null;
    } catch (e) { vscode = null; }
    const config = window.__viewerConfig || {};

    /** テスト観測用: 最後に getDocument へ渡した主要パラメータ（TC-FV-06） */
    window.__lastGetDocumentParams = null;

    function postMessage(msg) {
        if (vscode) { vscode.postMessage(msg); return; }
        if (typeof window.__pdfExportPost === 'function') { window.__pdfExportPost(msg); }
    }

    // mount → cleanup（pdfDocument.destroy 等）の対応（TASK-10 — destroy でリソースも解放）
    const cleanupRegistry = new WeakMap();

    // viewer の見た目は 3 面（standalone/sidepanel/note）どこでも同一になるよう自己完結で注入する。
    // 色は Fractal のテーマトークン（--fr-*）を第一に使い、無い面（standalone viewer webview）では
    // VS Code 変数 → ライト既定にフォールバック（実機検収 2026-08-15: --vscode-* 直参照だと
    // ダーク VS Code で viewer だけ真っ黒になり、ライト基調のアプリ UI と乖離した）
    function ensureViewerStyle() {
        if (document.getElementById('file-viewer-style')) { return; }
        const style = document.createElement('style');
        style.id = 'file-viewer-style';
        style.textContent = [
            ':root { --fv-bg-bar: var(--fr-color-bg-panel, var(--vscode-editorWidget-background, #f7f7f5));',
            '  --fv-bg-body: var(--fr-color-bg-app, var(--vscode-editor-background, #ececec));',
            '  --fv-border: var(--fr-color-border, var(--vscode-panel-border, #ddd));',
            '  --fv-text: var(--fr-color-text, var(--vscode-foreground, #333));',
            '  --fv-text-muted: var(--fr-color-text-muted, var(--vscode-descriptionForeground, #777));',
            '  --fv-btn-bg: var(--fr-color-bg-elevated, var(--vscode-button-secondaryBackground, #fff));',
            '  --fv-btn-hover: var(--fr-color-primary-soft, var(--vscode-button-secondaryHoverBackground, #e8f1fb)); }',
            '.viewer-toolbar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center;',
            '  padding: 6px 10px; border-bottom: 1px solid var(--fv-border);',
            '  background: var(--fv-bg-bar); color: var(--fv-text);',
            '  font-family: var(--vscode-font-family, -apple-system, sans-serif); }',
            '.viewer-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;',
            '  white-space: nowrap; font-size: 12px; color: var(--fv-text-muted); }',
            '.viewer-toolbar button { flex: 0 0 auto; padding: 3px 12px; cursor: pointer;',
            '  background: var(--fv-btn-bg); color: var(--fv-text);',
            '  border: 1px solid var(--fv-border); border-radius: 6px; font-size: 12px; line-height: 1.5; }',
            '.viewer-toolbar button:hover { background: var(--fv-btn-hover); }',
            '.viewer-zoom-in, .viewer-zoom-out { min-width: 30px; font-weight: 600; }',
            '.viewer-body { flex: 1 1 auto; position: relative; overflow: auto; min-height: 0;',
            '  background: var(--fv-bg-body); }',
            // html は「ブラウザで見た時」が正 — iframe は常に白ベース
            '.viewer-html-frame { width: 100%; height: 100%; border: none; background: #fff; }',
            // pdf はページ紙面が浮くニュートラル背景 + pdf_viewer.css の page 影を活かす
            '.viewer-pdf-container { background: var(--fv-bg-body); }',
            '.viewer-pdf-container .pdfViewer { padding: 12px 0; }',
            '.viewer-error { padding: 20px; color: var(--fr-color-danger, var(--vscode-errorForeground, #c33));',
            '  font-family: var(--vscode-font-family, sans-serif); font-size: 13px; white-space: pre-wrap; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function buildToolbar(mount, fileUri, kind, filePath) {
        const bar = document.createElement('div');
        bar.className = 'viewer-toolbar';
        // 左: ファイル名（何を見ているかの手掛かり）/ 右: 操作ボタン群
        const title = document.createElement('span');
        title.className = 'viewer-title';
        const name = String(filePath || fileUri || '').split(/[/\\]/).pop() || '';
        title.textContent = decodeURIComponentSafe(name);
        bar.appendChild(title);
        if (kind === 'pdf') {
            const zoomOut = document.createElement('button');
            zoomOut.className = 'viewer-zoom-out';
            zoomOut.title = 'Zoom out';
            zoomOut.textContent = '−';
            const zoomIn = document.createElement('button');
            zoomIn.className = 'viewer-zoom-in';
            zoomIn.title = 'Zoom in';
            zoomIn.textContent = '+';
            bar.appendChild(zoomOut);
            bar.appendChild(zoomIn);
        }
        const openBtn = document.createElement('button');
        openBtn.className = 'viewer-open-external';
        openBtn.textContent = 'OS で開く';
        openBtn.addEventListener('click', () => {
            // filePath（fs パス）は sidepanel/note 面の host 側 case が openExternal に使う（SEC-2）
            postMessage({ type: 'openExternalFallback', fileUri, filePath: filePath || null });
        });
        bar.appendChild(openBtn);
        mount.appendChild(bar);
        return bar;
    }

    function decodeURIComponentSafe(s) {
        try { return decodeURIComponent(s); } catch { return s; }
    }

    function showError(mount, fileUri, message) {
        const body = mount.querySelector('.viewer-body');
        if (body) { body.textContent = ''; }
        const err = document.createElement('div');
        err.className = 'viewer-error';
        err.textContent = message;
        (body || mount).appendChild(err);
    }

    function buildBody(mount) {
        const body = document.createElement('div');
        body.className = 'viewer-body';
        // 3 面のどのマウント先でも高さが立つよう最小スタイルを自己完結で持つ
        // （ホスト側 CSS への依存で iframe/canvas が 0 高さになる事故の防止 — 実環境検収 2026-08-15）
        body.style.flex = '1 1 auto';
        body.style.position = 'relative';
        body.style.overflow = 'auto';
        body.style.minHeight = '0';
        if (!mount.style.display) { mount.style.display = 'flex'; }
        if (!mount.style.flexDirection) { mount.style.flexDirection = 'column'; }
        mount.appendChild(body);
        return body;
    }

    // ── HTML 面（FR-FV-04 — 方式 B: blob + <base> 注入 + sandbox="" 全制限） ──────
    // 実環境検収（2026-08-15）で方式 A（iframe src=vscode-resource 直指定）は vscode-webview scheme で
    // 不成立（真っ黒 — service worker が opaque origin iframe の navigation を serve しない）と判明。
    // ADRL-0064 が計画済みのフォールバック方式 B に切替: html テキストを fetch（connect-src で許可済み）→
    // <base href=親dir 絶対URL> を注入して Blob 化 → objectURL を src に。sandbox="" と script 禁止は不変。
    async function openHtml(mount, fileUri) {
        const body = mount.querySelector('.viewer-body') || buildBody(mount);
        const resp = await fetch(fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        let html = await resp.text();
        // 相対参照の基底 = html の親 dir の絶対 URL（blob iframe 内の相対 base は解決不能のため必ず絶対化）
        const absUrl = new URL(fileUri, (typeof location !== 'undefined' && location.href) || undefined).href;
        const baseHref = absUrl.replace(/[^/]*$/, '');
        const baseTag = `<base href="${baseHref}">`;
        if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (m) => m + baseTag);
        } else {
            html = baseTag + html;
        }
        const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        const iframe = document.createElement('iframe');
        // sandbox="" = allow-* を 1 つも付けない（ADRL-0064 — script/form/popup/same-origin 全禁止。
        // allow-scripts を足すことは NFR-FV-03 違反 — TC-FV-01 counterfactual が番人）
        iframe.setAttribute('sandbox', '');
        iframe.className = 'viewer-html-frame';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.src = blobUrl;
        body.appendChild(iframe);
        // objectURL は destroy 時に revoke（one-shot の set/clear 対）
        const prev = cleanupRegistry.get(mount);
        cleanupRegistry.set(mount, () => {
            if (prev) { prev(); }
            try { URL.revokeObjectURL(blobUrl); } catch { /* best-effort */ }
        });
        return iframe;
    }

    // ── PDF 面（FR-FV-03 — pdfjs browser バンドル + PDFViewer） ───────────────
    let workerBlobUrl = null;   // 全 open で共有（worker スクリプトは不変）
    async function openPdf(mount, fileUri) {
        const body = mount.querySelector('.viewer-body') || buildBody(mount);
        const lib = await import(config.pdfjsLibUri);
        const pdfjsLib = lib.pdfjsLib;
        const pdfjsViewer = lib.pdfjsViewer;
        // 実機検収（2026-08-15）: vscode-resource URL は webview と別 origin のため
        // new Worker(url) が SecurityError になり getDocument が進まない（真っ黒）。
        // worker スクリプトを fetch → blob URL 化して same-origin worker にする
        // （CSP worker-src blob: は 3 面とも許可済み。pdf.worker.min.mjs は単一バンドル = 内部 import なし）
        if (!workerBlobUrl) {
            const wResp = await fetch(config.workerUri);
            if (!wResp.ok) { throw new Error(`worker fetch failed: ${wResp.status}`); }
            workerBlobUrl = URL.createObjectURL(new Blob([await wResp.text()], { type: 'text/javascript' }));
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerBlobUrl;

        // PDF 供給は URL fetch（postMessage ArrayBuffer は pdf.js が detach するため不可 — design §3）
        const resp = await fetch(fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const data = await resp.arrayBuffer();

        const params = {
            data,
            cMapUrl: config.cMapUrl,
            cMapPacked: true,
            standardFontDataUrl: config.standardFontDataUrl,
            isEvalSupported: false,     // CVE-2024-4367 defense-in-depth（ADRL-0065 決定 5）
        };
        window.__lastGetDocumentParams = {
            cMapUrl: params.cMapUrl,
            isEvalSupported: params.isEvalSupported,
        };
        const pdf = await pdfjsLib.getDocument(params).promise;

        // PDFViewer は container: position absolute + 内側 .pdfViewer を要求する
        const container = document.createElement('div');
        container.className = 'viewer-pdf-container';
        container.style.position = 'absolute';
        container.style.inset = '0';
        container.style.overflow = 'auto';
        const inner = document.createElement('div');
        inner.className = 'pdfViewer';
        container.appendChild(inner);
        body.style.position = 'relative';
        body.appendChild(container);

        const eventBus = new pdfjsViewer.EventBus();
        const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
        const viewer = new pdfjsViewer.PDFViewer({ container, eventBus, linkService });
        linkService.setViewer(viewer);
        eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
        linkService.setDocument(pdf, null);
        viewer.setDocument(pdf);

        const bar = mount.querySelector('.viewer-toolbar');
        if (bar) {
            const zi = bar.querySelector('.viewer-zoom-in');
            const zo = bar.querySelector('.viewer-zoom-out');
            if (zi) { zi.addEventListener('click', () => { viewer.currentScale = Math.min(viewer.currentScale * 1.25, 8); }); }
            if (zo) { zo.addEventListener('click', () => { viewer.currentScale = Math.max(viewer.currentScale / 1.25, 0.25); }); }
        }
        return { pdf, viewer };
    }

    /**
     * viewer を mountEl に開く（1 実装 3 マウント — standalone/sidepanel/note 共用）。
     * 失敗時は throw せず読み込み失敗 UI に落とす（FR-FV-07）。
     */
    async function open(kind, fileUri, mountEl, filePath) {
        const mount = mountEl || document.getElementById('viewer-root');
        if (!mount) { return; }
        ensureViewerStyle();               // 3 面共通の見た目を自己完結で保証
        destroy(mount);                    // 前回分のリソースを解放してから再構築
        buildToolbar(mount, fileUri, kind, filePath);
        buildBody(mount);
        try {
            if (kind === 'pdf') {
                const { pdf } = await openPdf(mount, fileUri);
                // TASK-10: destroy(mount) で pdfDocument（worker / ArrayBuffer）も解放する
                cleanupRegistry.set(mount, () => {
                    try { pdf.destroy(); window.__lastPdfDocDestroyed = true; } catch { /* best-effort */ }
                });
            } else if (kind === 'html') {
                await openHtml(mount, fileUri);
            } else {
                showError(mount, fileUri, `unsupported kind: ${kind}`);
            }
        } catch (e) {
            showError(mount, fileUri, `このファイルを表示できませんでした（${e && e.message ? e.message : e}）`);
        }
    }

    /** mount の viewer DOM とリソース（pdfDocument 等）を破棄する（note 面の stale 対策） */
    function destroy(mountEl) {
        const mount = mountEl || document.getElementById('viewer-root');
        if (!mount) { return; }
        const cleanup = cleanupRegistry.get(mount);
        if (cleanup) { cleanup(); cleanupRegistry.delete(mount); }
        mount.textContent = '';
    }

    window.__fileViewer = { open, destroy };

    // standalone 面: config に kind/fileUri が来ていれば自動オープン
    if (config.kind && config.fileUri) {
        open(config.kind, config.fileUri, document.getElementById('viewer-root'));
    }
})();
