/**
 * file-viewer.js — file viewer webview 本体（PDF レンダ + HTML sandbox 表示 + 読み込み失敗 UI）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-03（PDF）/ FR-FV-04（HTML）/ FR-FV-07（失敗 UI）
 * + FR-FV-10（既定でコピー可）/ FR-FV-11（script は明示オプトイン）。
 * ADRL-0064（HTML = iframe 方式 B・blob + base 注入）→ 一部 supersede: ADRL-0067（sandbox は既定
 * 'allow-scripts'、防御の実体は blob が継承する CSP script-src 'nonce-…' — 手動テスト⑤で
 * sandbox="" ではコピーすらできないと判明したため）/
 * ADRL-0065（PDF = pdfjs 4.10.38 browser バンドル + pdf_viewer.mjs）。
 *
 * md 実装（editor.js / EditorInstance / SidePanelHostBridge / notes-md-dispatcher）への
 * import / window 参照は禁止（NFR-FV-02 — TC-FV-31 が番人）。
 *
 * 設定は window.__viewerConfig（host の fileViewerContent.ts / テストハーネスが注入）:
 *   { pdfjsLibUri, workerUri, cMapUrl, standardFontDataUrl, kind?, fileUri?, nonce? }
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
            // pdfjs は .page の width/height を「内容領域 = scale × ページ寸法」として算出する
            // （pdf.mjs setLayerDimensions）。だが .page は 9px の透明 border を持つため、
            // ホスト webview の `* { box-sizing: border-box }`（src/webview/styles.css:17。note /
            // sidepanel 面はこれを読む）が効くと内容領域が縦横 18px 縮み、canvas（100%）と
            // textLayer（inset:0）だけが縮んで、% 配置の span と inline の絶対 font-size が
            // 食い違う → 選択・コピー用テキストが実描画とズレる（実機検収 2026-08-15）。
            // pdfjs の前提（content-box）を viewer 配下だけで復元する
            '.viewer-pdf-container .pdfViewer .page,',
            '.viewer-pdf-container .pdfViewer .page * { box-sizing: content-box; }',
            // textLayer span は継承で崩れうる字送り系だけリセット（font-size/font-family は
            // pdfjs が span ごとに inline 指定するのでここでは触らない）
            '.viewer-pdf-container .textLayer :is(span, br) { letter-spacing: normal;',
            '  word-spacing: normal; text-transform: none; font-weight: normal; font-style: normal;',
            '  padding: 0; margin: 0; }',
            '.viewer-error { padding: 20px; color: var(--fr-color-danger, var(--vscode-errorForeground, #c33));',
            '  font-family: var(--vscode-font-family, sans-serif); font-size: 13px; white-space: pre-wrap; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    /**
     * ツールバーのラベル（FR-FV-08 の i18n）。note / sidepanel 面は各 webviewContent が
     * window.__outlinerMessages（WebviewMessages）を注入済み。standalone 面（fileViewerContent.ts）は
     * 注入が無いので既定文言に落ちる。キー自身は messages.ts の interface + 7 locale に登録済み
     * （TC-FV-54 が番人 — フォールバックだけで済ませる silent i18n 債務を防ぐ）
     */
    function label(key, fallback) {
        const msgs = window.__outlinerMessages || {};
        return msgs[key] || fallback;
    }

    /**
     * standalone 面か（= host の fileViewerContent.ts が専用タブに開いた面）。
     * 判別は **live な** window.__viewerConfig の kind/fileUri 有無で行う（design §10 は
     * 「__viewerConfig が存在する面」と書くが、note/sidepanel 面のハーネスや他 webview も
     * __viewerConfig を持ちうるため、自動オープンの条件（下部 :388 と同一）を判別に使う）。
     */
    function isStandaloneFace() {
        const c = window.__viewerConfig;
        return !!(c && c.kind && c.fileUri);
    }

    /** ツールバーにボタンを 1 つ足す（click で msgFactory() の message を host へ送る） */
    function addAction(bar, className, text, msgFactory) {
        const btn = document.createElement('button');
        btn.className = className;
        btn.textContent = text;
        btn.title = text;
        btn.addEventListener('click', () => { postMessage(msgFactory()); });
        bar.appendChild(btn);
        return btn;
    }

    function buildToolbar(mount, fileUri, kind, filePath, state) {
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
        if (kind === 'html') {
            // FR-FV-11: script は既定で不実行（継承 CSP の nonce ゲート）。ここでユーザーが
            // 明示的にオプトインしたときだけ nonce を付けて再生成する（state は open 呼び出し
            // ローカル = 非永続。別ファイル / 再オープンで必ず静的から始まる）
            const scriptBtn = document.createElement('button');
            scriptBtn.className = 'viewer-script-toggle';
            scriptBtn.title = 'このファイルの <script> を実行する（このファイルを閉じるまで有効）';
            scriptBtn.textContent = 'スクリプトを許可';
            scriptBtn.setAttribute('aria-pressed', state && state.allowScripts ? 'true' : 'false');
            scriptBtn.addEventListener('click', () => {
                if (!state || typeof state.onToggleScripts !== 'function') { return; }
                state.onToggleScripts();
            });
            bar.appendChild(scriptBtn);
        }
        // FR-FV-08（ADRL-0068 / design §10）: 4 アクション。message 形は openExternalFallback と同形
        // `{type, fileUri, filePath: filePath || null}`（host 側 case は filePath を fs パスとして使う）
        const standalone = isStandaloneFace();
        // standalone 面（host が config.kind/fileUri で自動オープンした専用タブ）は既にタブなので出さない
        if (!standalone) {
            addAction(bar, 'viewer-open-in-new-tab', label('viewerOpenInNewTab', 'Open in new tab'),
                // host が viewType（fractal.fileViewer / fractal.fileViewerHtml）を選ぶために kind を送る
                () => ({ type: 'viewerOpenInNewTab', fileUri, filePath: filePath || null, kind }));
        }
        addAction(bar, 'viewer-copy-path', label('viewerCopyPath', 'Copy Path'),
            () => ({ type: 'viewerCopyPath', fileUri, filePath: filePath || null }));
        // filePath が無い面は folder/id 逆引きの起点が無いので非表示。standalone は host が
        // document.uri を持つので filePath 不要（逆引き不成立なら host が warning で no-op）
        if (filePath || standalone) {
            addAction(bar, 'viewer-copy-inapp-link', label('viewerCopyInAppLink', 'Copy In-App Link'),
                () => ({ type: 'viewerCopyInAppLink', fileUri, filePath: filePath || null }));
        }
        addAction(bar, 'viewer-export-file', label('viewerExportFile', 'Export'),
            () => ({ type: 'viewerExportFile', fileUri, filePath: filePath || null }));

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

    // ── HTML 面（FR-FV-04 — 方式 B: blob + <base> 注入 + sandbox='allow-scripts'） ──────
    // 実環境検収（2026-08-15）で方式 A（iframe src=vscode-resource 直指定）は vscode-webview scheme で
    // 不成立（真っ黒 — service worker が opaque origin iframe の navigation を serve しない）と判明。
    // ADRL-0064 が計画済みのフォールバック方式 B に切替: html テキストを fetch（connect-src で許可済み）→
    // <base href=親dir 絶対URL> を注入して Blob 化 → objectURL を src に。
    //
    // ADRL-0067（手動テスト⑤ — sandbox="" では cmd+c すら効かない）で sandbox は既定
    // 'allow-scripts' になった。**防御の実体は blob が継承する CSP の script-src 'nonce-…'**:
    // blob document は createObjectURL 時点の生成元の policy container を複製するため、
    // ホスト webview の CSP がそのまま効き、nonce を持たないユーザー script は実行されない
    // （FR-FV-10 = 自前注入した nonce 付き copy ヘルパーだけが動く / FR-FV-11 = 明示オプトイン時のみ
    // ユーザー script に同じ nonce を付ける）。allow-same-origin は**絶対に併記しない**
    // （allow-scripts と併記すると自前で sandbox 属性を外せる = 脱出。不変条件 6 / TC-FV-42 が番人）。
    function viewerNonce() {
        // standalone 面は fileViewerContent.ts が config.nonce を注入、
        // note/outliner 面は各 webviewContent が window.__webviewNonce を公開している
        return config.nonce || window.__webviewNonce || '';
    }

    /**
     * cmd+c / cmd+a を execCommand で処理するヘルパーを html に注入する（FR-FV-10）。
     * VS Code webview は nested iframe の native copy キーを殺すため（vscode#129178）、
     * これが無いと選択したテキストをコピーできない（手動テスト⑤で実機確認）。
     * 注入は常時（既定でコピー可）。cut / paste は扱わない（viewer は read-only）。
     */
    function injectCopyHelper(html, nonce) {
        if (!nonce) { return html; }
        const helper = `<script nonce="${nonce}">(function(){document.addEventListener('keydown',function(e){`
            + `if(!(e.metaKey||e.ctrlKey)||e.altKey){return;}`
            + `if(e.key==='c'){try{document.execCommand('copy');}catch(err){}e.preventDefault();}`
            + `else if(e.key==='a'){try{document.execCommand('selectAll');}catch(err){}e.preventDefault();}`
            + `});})();</` + `script>`;
        if (/<\/head\s*>/i.test(html)) { return html.replace(/<\/head\s*>/i, helper + '$&'); }
        // head が無い html は <base> 注入直後に置く（base は必ず先頭側にある）
        const baseIdx = html.search(/<base[^>]*>/i);
        if (baseIdx >= 0) {
            const end = html.indexOf('>', baseIdx) + 1;
            return html.slice(0, end) + helper + html.slice(end);
        }
        return helper + html;
    }

    /** オプトイン ON: ユーザー script に同じ nonce を与えて実行可能にする（FR-FV-11） */
    function allowUserScripts(html, nonce) {
        if (!nonce) { return html; }
        // 既に nonce 属性を持つタグには先勝ちで重複するが、対象は自前注入ヘルパーだけなので実害なし
        return html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
    }

    async function openHtml(mount, fileUri, state) {
        const body = mount.querySelector('.viewer-body') || buildBody(mount);
        const resp = await fetch(fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const raw = await resp.text();
        // 相対参照の基底 = html の親 dir の絶対 URL（blob iframe 内の相対 base は解決不能のため必ず絶対化）
        const absUrl = new URL(fileUri, (typeof location !== 'undefined' && location.href) || undefined).href;
        const baseHref = absUrl.replace(/[^/]*$/, '');
        const baseTag = `<base href="${baseHref}">`;
        const nonce = viewerNonce();
        const iframe = document.createElement('iframe');
        iframe.className = 'viewer-html-frame';
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        // リテラル固定（変数結合で allow-same-origin が混入する経路を作らない — 不変条件 6）
        iframe.setAttribute('sandbox', 'allow-scripts');

        let currentBlobUrl = null;
        /** 現在の state（allowScripts）で blob を作り直して src を差し替える */
        function render() {
            let html = raw;
            if (/<head[^>]*>/i.test(html)) {
                html = html.replace(/<head[^>]*>/i, (m) => m + baseTag);
            } else {
                html = baseTag + html;
            }
            // オプトインが ON のときだけユーザー script に nonce を与える。
            // 順序が重要: rewrite を先に済ませてから copy ヘルパーを注入する
            // （逆順だとヘルパーが二重 nonce になるうえ、ヘルパー自身が rewrite 対象になる）
            if (state && state.allowScripts) { html = allowUserScripts(html, nonce); }
            html = injectCopyHelper(html, nonce);
            const next = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
            const stale = currentBlobUrl;
            currentBlobUrl = next;
            iframe.src = next;
            // 差し替えた旧 objectURL は即 revoke（one-shot の set/clear 対 — リーク防止）
            if (stale) { try { URL.revokeObjectURL(stale); } catch { /* best-effort */ } }
        }
        render();
        if (state) { state.rerenderHtml = render; }
        body.appendChild(iframe);
        // 最後の objectURL は destroy 時に revoke（one-shot の set/clear 対）
        const prev = cleanupRegistry.get(mount);
        cleanupRegistry.set(mount, () => {
            if (prev) { prev(); }
            try { if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); } } catch { /* best-effort */ }
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

        // 5.x（ADRL-0070）: JPX/JBIG2/ICC デコーダの wasm と ICC プロファイル。
        // 供給 base は cMapUrl（`<base>/cmaps/`）と同一ディレクトリなので導出する
        // — 3 面の config 構築（fileViewerContent / notesWebviewContent / outlinerWebviewContent）
        // に個別配線しない（「N 経路の一部にだけ配線」クラスの回避。1 箇所導出）
        const assetBase = String(config.cMapUrl || '').replace(/cmaps\/?$/, '');
        const params = {
            data,
            cMapUrl: config.cMapUrl,
            cMapPacked: true,
            standardFontDataUrl: config.standardFontDataUrl,
            wasmUrl: assetBase ? `${assetBase}wasm/` : undefined,
            iccUrl: assetBase ? `${assetBase}iccs/` : undefined,
            isEvalSupported: false,     // CVE-2024-4367 defense-in-depth（ADRL-0065 決定 5）
        };
        window.__lastGetDocumentParams = {
            cMapUrl: params.cMapUrl,
            wasmUrl: params.wasmUrl,
            iccUrl: params.iccUrl,
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
        // script オプトインの state（FR-FV-11）は open 呼び出しローカル = 非永続。
        // 別ファイルを開く / 同じファイルを開き直すと必ず allowScripts:false から始まる
        const state = { allowScripts: false, rerenderHtml: null, onToggleScripts: null };
        state.onToggleScripts = () => {
            if (typeof state.rerenderHtml !== 'function') { return; }
            state.allowScripts = !state.allowScripts;
            state.rerenderHtml();
            const btn = mount.querySelector('.viewer-script-toggle');
            if (btn) { btn.setAttribute('aria-pressed', state.allowScripts ? 'true' : 'false'); }
        };
        buildToolbar(mount, fileUri, kind, filePath, state);
        buildBody(mount);
        try {
            if (kind === 'pdf') {
                const { pdf } = await openPdf(mount, fileUri);
                // TASK-10: destroy(mount) で pdfDocument（worker / ArrayBuffer）も解放する
                cleanupRegistry.set(mount, () => {
                    try { pdf.destroy(); window.__lastPdfDocDestroyed = true; } catch { /* best-effort */ }
                });
            } else if (kind === 'html') {
                await openHtml(mount, fileUri, state);
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
