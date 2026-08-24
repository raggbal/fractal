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

    // ── 新 viewer kind（sprint 20260823-165314 / FR-FV-17 = ADRL-0092） ─────────────────
    // kind 別 ESM モジュールを初回 open 時に動的 import（pdfjs の import(config.pdfjsLibUri) precedent）。
    // Promise キャッシュで単一飛行（同 kind 連続 open で二重 import しない）。失敗はキャッシュしない。
    const VIEWER_MODULE_KINDS = ['text', 'image', 'docx', 'xlsx', 'pptx'];
    const viewerModulePromises = new Map();
    function loadViewerModule(kind) {
        const cached = viewerModulePromises.get(kind);
        if (cached) { return cached; }
        const uri = (config.viewerModuleUris || {})[kind];
        if (!uri) { return Promise.reject(new Error('viewer module uri not configured: ' + kind)); }
        const p = import(uri);
        viewerModulePromises.set(kind, p);
        p.catch(() => { viewerModulePromises.delete(kind); });
        return p;
    }

    /**
     * locHint（添付中身検索の位置ヒント）の kind 別 parse（FR-FV-22）。
     * 書式の正典 = doc-text-extract.ts（pdf=`p.N` / xlsx=`シート名!セル` / pptx=`slide N`。
     * docx/text は loc なし = null → findQuery のみで着地）。
     */
    function parseLocHint(kind, locHint) {
        if (!locHint) { return null; }
        const s = String(locHint);
        if (kind === 'pdf') {
            const m = /p\.?\s*(\d+)/.exec(s);
            return m ? { page: parseInt(m[1], 10) } : null;
        }
        if (kind === 'xlsx') {
            // シート名に '!' を含みうるため最後の '!' で分割
            const i = s.lastIndexOf('!');
            if (i > 0) {
                const cell = s.slice(i + 1);
                if (/^[A-Za-z]+[0-9]+$/.test(cell)) { return { sheet: s.slice(0, i), cell: cell.toUpperCase() }; }
            }
            return null;
        }
        if (kind === 'pptx') {
            const m = /slide\s*(\d+)/i.exec(s);
            return m ? { slide: parseInt(m[1], 10) } : null;
        }
        return null;
    }

    // viewer の見た目は 3 面（standalone/sidepanel/note）どこでも同一になるよう自己完結で注入する。
    // 色は Fractal のテーマトークン（--fr-*）を第一に使い、無い面（standalone viewer webview）では
    // VS Code 変数 → ライト既定にフォールバック（実機検収 2026-08-15: --vscode-* 直参照だと
    // ダーク VS Code で viewer だけ真っ黒になり、ライト基調のアプリ UI と乖離した）
    // TASK-12: 開いている viewer mount → find state（Cmd+F の一元先取り用。destroy で解除）
    const findRegistry = new Map();
    function activeFindState() {
        const ae = document.activeElement;
        // 優先 1: activeElement を含む mount（複数 viewer 共存時の一意化）
        for (const [mount, st] of findRegistry) {
            if (!mount.isConnected) { findRegistry.delete(mount); continue; }
            if (ae && mount.contains(ae)) { return st; }
        }
        // 優先 2: viewer 外の**可視の**入力/編集面にフォーカスがある時は奪わない（md editor 等）。
        // 注: note 面 viewer 表示中は隠れた md contenteditable に focus が残ることがある
        //（display:none でも activeElement のまま — ユーザー実測 2026-08-23）→ 不可視ならガードしない
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
            && ae.offsetParent !== null) { return null; }
        // 優先 3: 可視の mount（フォーカスが body 等 = 開いた直後の Cmd+F）
        for (const [mount, st] of findRegistry) {
            if (mount.isConnected && mount.offsetParent !== null) { return st; }
        }
        return null;
    }
    if (!window.__fvFindKeyHooked) {
        window.__fvFindKeyHooked = true;
        window.addEventListener('keydown', (e) => {
            if (!((e.metaKey || e.ctrlKey) && !e.altKey && String(e.key).toLowerCase() === 'f')) { return; }
            const st = activeFindState();
            if (!st || !st.findUi) { return; } // viewer 対象外 → 既存挙動（外部 find）に委ねる
            e.preventDefault();
            e.stopImmediatePropagation();
            st.findUi.open();
        }, true);
    }

    function ensureViewerStyle() {
        if (document.getElementById('file-viewer-style')) { return; }
        const style = document.createElement('style');
        style.id = 'file-viewer-style';
        style.textContent = [
            ':root { --fv-bg-bar: var(--fr-color-bg-panel, var(--vscode-editorWidget-background, #f7f7f5));',
            '  --fv-bg-body: var(--fr-color-bg-app, var(--vscode-editor-background, #ececec));',
            '  --fv-border: var(--fr-color-border, var(--vscode-panel-border, #ddd));',
            // 第 7 ラウンド①: 実在トークンは --fr-color-text-primary（tokens.css:40 = #1A1B1F —
            // md の --text-color の実体）。旧 --fr-color-text は存在せず --vscode-foreground
            // （UI 用薄グレー）へ落下して md より大幅に薄くなっていた（TC-FV-74 が実色を pin）
            '  --fv-text: var(--fr-color-text-primary, var(--vscode-editor-foreground, var(--vscode-foreground, #333)));',
            '  --fv-text-muted: var(--fr-color-text-muted, var(--vscode-descriptionForeground, #777));',
            '  --fv-btn-bg: var(--fr-color-bg-elevated, var(--vscode-button-secondaryBackground, #fff));',
            '  --fv-btn-hover: var(--fr-color-primary-soft, var(--vscode-button-secondaryHoverBackground, #e8f1fb)); }',
            // FR-FV-12（再オープン③）: ボタン chrome は md sidepanel の .side-panel-header-btn
            //（styles.css:1926-1950）の値を自己完結で複製（アイコンボタン化 — 枠付きテキストボタン廃止）
            '.viewer-toolbar { flex: 0 0 auto; display: flex; gap: 2px; align-items: center;',
            '  padding: 6px 10px; border-bottom: 1px solid var(--fv-border);',
            '  background: var(--fv-bg-bar); color: var(--fv-text);',
            '  font-family: var(--vscode-font-family, -apple-system, sans-serif); }',
            '.viewer-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;',
            '  white-space: nowrap; font-size: 12px; color: var(--fv-text-muted); margin-right: 6px; }',
            '.viewer-toolbar button { flex: 0 0 auto; background: none; border: none; color: var(--fv-text);',
            '  cursor: pointer; padding: 4px; border-radius: 4px; opacity: 0.6;',
            '  display: flex; align-items: center; font-size: 12px; line-height: 1; }',
            '.viewer-toolbar button:hover { opacity: 1; background: var(--hover-bg, rgba(128,128,128,0.15)); }',
            '.viewer-toolbar button svg { width: 14px; height: 14px; }',
            '.viewer-find-bar { flex: 0 0 auto; display: flex; gap: 4px; align-items: center; padding: 2px 6px;',
            '  background: var(--fv-bg, transparent); border-bottom: 1px solid var(--fv-border, rgba(128,128,128,0.25)); }',
            '.viewer-find-bar input { flex: 0 1 220px; min-width: 80px; font-size: 12px; padding: 2px 6px;',
            '  background: var(--vscode-input-background, #fff); color: var(--vscode-input-foreground, #333);',
            '  border: 1px solid var(--vscode-input-border, rgba(128,128,128,0.4)); border-radius: 3px; outline: none; }',
            '.viewer-find-count { font-size: 11px; opacity: 0.75; min-width: 40px; text-align: center; }',
            '.viewer-find-bar button { background: none; border: none; cursor: pointer; opacity: 0.7; padding: 2px 4px;',
            '  color: var(--fv-text); border-radius: 3px; }',
            '.viewer-find-bar button:hover { opacity: 1; background: var(--hover-bg, rgba(128,128,128,0.15)); }',
            '.viewer-script-toggle[aria-pressed="true"] { opacity: 1; background: var(--fv-btn-hover); }',
            '.viewer-zoom-in, .viewer-zoom-out { min-width: 24px; font-weight: 600; font-size: 13px;',
            '  justify-content: center; }',
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
     * ツールバーのグリフ（FR-FV-12 / 裁定 18 — 再オープン③）。
     * **md 正典からの verbatim 複製**（TC-FV-61 が字面一致を pin — 独自グリフの発明防止）:
     *   - export/copyPath/copyInAppLink/openInNewTab/expand = editor-body-html.js の
     *     md sidepanel テンプレ SVG（:186-:217）
     *   - openInStandalone/allowScripts = editor-utils.js の LUCIDE_ICONS
     *     （openInTextEditor = VS Code ロゴ / code = `</>`）
     *   - openExternal のみ md analog 不在の新規最小（lucide screen-share — openTab ↗ との識別性）
     * 自己完結コピーの理由: standalone 面は editor-utils.js を読み込まない + NFR-FV-02
     * （md グローバル window.__editorUtils への参照禁止）。表示サイズは CSS（svg 14×14）が正規化する。
     */
    const VIEWER_ICONS = {
        expand: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
        export: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
        copyPath: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        copyCheck: '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        copyInAppLink: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
        openInNewTab: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
        openInStandalone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>',
        allowScripts: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>',
        openExternal: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/><path d="M8 21h8"/><path d="M12 17v4"/><path d="m17 8 5-5"/><path d="M17 3h5v5"/></svg>',
        // image viewer 用（sprint 20260823-165314 / FR-FV-19。md analog 不在の新規最小 —
        // fit = lucide maximize / actualSize = 数字 1:1 の最小表現。TC-FV-61 が字面 pin）
        fit: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
        actualSize: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8v8"/><path d="M5 10l2-2"/><path d="M17 8v8"/><path d="M15 10l2-2"/><line x1="11" y1="10" x2="11" y2="10.01"/><line x1="11" y1="14" x2="11" y2="14.01"/></svg>',
    };

    /**
     * ツールバーのラベル（FR-FV-08 の i18n）。note / sidepanel 面は各 webviewContent が
     * window.__outlinerMessages（WebviewMessages）を注入済み。standalone 面（fileViewerContent.ts）は
     * 注入が無いので既定文言（英語）に落ちる。キー自身は messages.ts の interface + 7 locale に登録済み
     * （TC-FV-54 / TC-FV-54c が番人 — フォールバックだけで済ませる silent i18n 債務を防ぐ）
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

    /** ツールバーにアイコンボタンを 1 つ足す（click で msgFactory() の message を host へ送る） */
    function addAction(bar, className, iconSvg, labelText, msgFactory) {
        const btn = document.createElement('button');
        btn.className = className;
        btn.innerHTML = iconSvg;
        btn.title = labelText;
        btn.setAttribute('aria-label', labelText);
        btn.addEventListener('click', () => { postMessage(msgFactory()); });
        bar.appendChild(btn);
        return btn;
    }

    /**
     * FR-FV-12（再オープン③・裁定 19）: 並び順は requirement FR-FV-12 = design §13 の同一文字列で pin —
     * `[filename] [script 許可](html) [−][+](pdf) [OS で開く][Open in Standalone][Export]
     *  [Copy Path][Copy In-App Link][Open in new tab]`
     * md 正典順（openInTextEditor→export→copyPath→copyInAppLink→openTab→close）の鏡映:
     * OS で開く = アクション群左端 / Open in Standalone = openInTextEditor スロット /
     * Open in new tab = openTab スロット（最右端・sidepanel 面では × の直前）。TC-FV-62 が全順序を pin。
     */
    function buildToolbar(mount, fileUri, kind, filePath, state, opts) {
        const bar = document.createElement('div');
        bar.className = 'viewer-toolbar';
        // 左: ファイル名（何を見ているかの手掛かり）/ 右: 操作ボタン群
        const title = document.createElement('span');
        title.className = 'viewer-title';
        const name = String(filePath || fileUri || '').split(/[/\\]/).pop() || '';
        title.textContent = decodeURIComponentSafe(name);
        bar.appendChild(title);
        // FR-FV-14: sidepanel 面は ⤢ expand を actions 先頭に差し込む（md 正典: expand が
        // header-actions の先頭 = editor-body-html.js:185。呼び出し元が opts.onExpand を渡す）
        if (opts && typeof opts.onExpand === 'function') {
            const ex = document.createElement('button');
            ex.className = 'viewer-expand';
            const exLabel = label('viewerExpand', 'Expand');
            ex.title = exLabel;
            ex.setAttribute('aria-label', exLabel);
            ex.innerHTML = VIEWER_ICONS.expand;
            ex.addEventListener('click', () => { opts.onExpand(); });
            bar.appendChild(ex);
        }
        if (kind === 'html') {
            // FR-FV-11: script は既定で不実行（継承 CSP の nonce ゲート）。ここでユーザーが
            // 明示的にオプトインしたときだけ nonce を付けて再生成する（state は open 呼び出し
            // ローカル = 非永続。別ファイル / 再オープンで必ず静的から始まる）
            const scriptBtn = document.createElement('button');
            scriptBtn.className = 'viewer-script-toggle';
            const scriptLabel = label('viewerAllowScripts', 'Allow scripts (this file only)');
            scriptBtn.title = scriptLabel;
            scriptBtn.setAttribute('aria-label', scriptLabel);
            scriptBtn.innerHTML = VIEWER_ICONS.allowScripts;
            scriptBtn.setAttribute('aria-pressed', state && state.allowScripts ? 'true' : 'false');
            scriptBtn.addEventListener('click', () => {
                if (!state || typeof state.onToggleScripts !== 'function') { return; }
                state.onToggleScripts();
            });
            bar.appendChild(scriptBtn);
        }
        // FR-FV-19（sprint 20260823-165314）: [−][+] は pdf / image / pptx。docx は非表示
        //（SYS-1 裁定 = 縦スクロール + 狭幅自動 scale で足りる）。xlsx / text も非表示。
        // click 配線は kind 側（openPdf / 各 kind モジュール）が querySelector で行う（DOM 生成のみここ）
        if (kind === 'pdf' || kind === 'image' || kind === 'pptx') {
            const zoomOut = document.createElement('button');
            zoomOut.className = 'viewer-zoom-out';
            const zoomOutLabel = label('viewerZoomOut', 'Zoom out');
            zoomOut.title = zoomOutLabel;
            zoomOut.setAttribute('aria-label', zoomOutLabel);
            zoomOut.textContent = '−';
            const zoomIn = document.createElement('button');
            zoomIn.className = 'viewer-zoom-in';
            const zoomInLabel = label('viewerZoomIn', 'Zoom in');
            zoomIn.title = zoomInLabel;
            zoomIn.setAttribute('aria-label', zoomInLabel);
            zoomIn.textContent = '+';
            bar.appendChild(zoomOut);
            bar.appendChild(zoomIn);
        }
        // FR-FV-19: image のみ [フィット][等倍]（[+] の直後 — requirement 全順序表が正）
        if (kind === 'image') {
            const fit = document.createElement('button');
            fit.className = 'viewer-fit';
            const fitLabel = label('viewerFit', 'Fit');
            fit.title = fitLabel;
            fit.setAttribute('aria-label', fitLabel);
            fit.innerHTML = VIEWER_ICONS.fit;
            const actual = document.createElement('button');
            actual.className = 'viewer-actual-size';
            const actualLabel = label('viewerActualSize', 'Actual size');
            actual.title = actualLabel;
            actual.setAttribute('aria-label', actualLabel);
            actual.innerHTML = VIEWER_ICONS.actualSize;
            bar.appendChild(fit);
            bar.appendChild(actual);
        }
        // FR-FV-08（ADRL-0068 / design §10）: message 形は openExternalFallback と同形
        // `{type, fileUri, filePath: filePath || null}`（host 側 case は filePath を fs パスとして使う）
        const standalone = isStandaloneFace();
        // FR-FV-13（§14-6）: 面判別 — notes タブ strip の有無 × file タブ内か（loadTab 経由の表示）
        const hasTabStrip = !!window.__notesTabManager;
        const inTab = !!(opts && opts.inTab);

        // OS で開く（アクション群左端 — 裁定 19）
        addAction(bar, 'viewer-open-external', VIEWER_ICONS.openExternal,
            label('viewerOpenExternal', 'Open in OS default app'),
            // filePath（fs パス）は sidepanel/note 面の host 側 case が openExternal に使う（SEC-2）
            () => ({ type: 'openExternalFallback', fileUri, filePath: filePath || null }));

        // Open in Standalone（vscode タブ — ADRL-0069 決定 2: 既存 viewerOpenInNewTab case を流用・
        // 新 message type を発明しない）。standalone 面は自身 / タブ strip の無い面は
        // Open in new tab（従来どおり vscode タブ）と重複するため非表示
        if (!standalone && hasTabStrip) {
            addAction(bar, 'viewer-open-in-standalone', VIEWER_ICONS.openInStandalone,
                label('viewerOpenInStandalone', 'Open in Standalone'),
                () => ({ type: 'viewerOpenInNewTab', fileUri, filePath: filePath || null, kind }));
        }
        addAction(bar, 'viewer-export-file', VIEWER_ICONS.export, label('viewerExportFile', 'Export'),
            () => ({ type: 'viewerExportFile', fileUri, filePath: filePath || null }));
        const copyBtn = addAction(bar, 'viewer-copy-path', VIEWER_ICONS.copyPath,
            label('viewerCopyPath', 'Copy Path'),
            () => ({ type: 'viewerCopyPath', fileUri, filePath: filePath || null }));
        // クリック後 2 秒チェックマーク遷移（md sidepanel copy-path と同形 — outliner.js precedent）
        copyBtn.addEventListener('click', () => {
            copyBtn.innerHTML = VIEWER_ICONS.copyCheck;
            setTimeout(() => { copyBtn.innerHTML = VIEWER_ICONS.copyPath; }, 2000);
        });
        // filePath が無い面は folder/id 逆引きの起点が無いので非表示。standalone は host が
        // document.uri を持つので filePath 不要（逆引き不成立なら host が warning で no-op）
        if (filePath || standalone) {
            addAction(bar, 'viewer-copy-inapp-link', VIEWER_ICONS.copyInAppLink,
                label('viewerCopyInAppLink', 'Copy In-App Link'),
                () => ({ type: 'viewerCopyInAppLink', fileUri, filePath: filePath || null }));
        }
        // Open in new tab（openTab スロット = 最右端。standalone 面 / file タブ内は自身がタブなので出さない）
        if (!standalone && !inTab) {
            if (hasTabStrip) {
                // FR-FV-13 / ADRL-0069: notes 面は **fractal タブ**（notes タブ strip の kind='file'）で
                // 開く — host 往復ゼロの webview 完結（md sidepanel の openTab = fractal タブと同格）。
                // viewer 表示素材（kind/fileUri）は closure が持つので extra でタブ state に渡す
                const btn = document.createElement('button');
                btn.className = 'viewer-open-in-new-tab';
                const ontLabel = label('viewerOpenInNewTab', 'Open in new tab');
                btn.title = ontLabel;
                btn.setAttribute('aria-label', ontLabel);
                btn.innerHTML = VIEWER_ICONS.openInNewTab;
                btn.addEventListener('click', () => {
                    window.__notesTabManager.openInNewTab(
                        filePath || fileUri, 'file', decodeURIComponentSafe(name),
                        { viewerKind: kind, viewerFileUri: fileUri });
                    // sidepanel 発ならペインを閉じる（md precedent: openTab 後の closeSidePanelImmediate
                    // — outliner.js:7833。loadTab 側の close は「タブ切替時」の排他で、初回 open 時の
                    // 対はここ）※ loadTab too — 二重 close は no-op なので安全
                    if (opts && typeof opts.onClose === 'function') { opts.onClose(); }
                });
                bar.appendChild(btn);
            } else {
                // タブ strip の無い面（outliner 単独面）は従来どおり vscode タブ（standalone viewer）
                addAction(bar, 'viewer-open-in-new-tab', VIEWER_ICONS.openInNewTab,
                    label('viewerOpenInNewTab', 'Open in new tab'),
                    // host が viewType（fractal.fileViewer / fractal.fileViewerHtml）を選ぶために kind を送る
                    () => ({ type: 'viewerOpenInNewTab', fileUri, filePath: filePath || null, kind }));
            }
        }
        // FR-FV-14: sidepanel 面は × close を最右端に差し込む（md 正典: close が最右端 = :219。
        // className は既存 TC/排他経路が参照する viewer-side-panel-close を維持）
        if (opts && typeof opts.onClose === 'function') {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'viewer-side-panel-close';
            const closeLabel = label('viewerClose', 'Close');
            closeBtn.title = closeLabel;
            closeBtn.setAttribute('aria-label', closeLabel);
            closeBtn.textContent = '×';   // md 正典と同形（&times; のテキストボタン）
            closeBtn.addEventListener('click', () => { opts.onClose(); });
            bar.appendChild(closeBtn);
        }
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

    /** FR-VFB-03: 3 面共通 find bar（toolbar と body の間。既定非表示） */
    function buildFindBar(mount, state) {
        const bar = document.createElement('div');
        bar.className = 'viewer-find-bar';
        bar.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = label('viewerFind', 'Find');
        input.setAttribute('aria-label', label('viewerFind', 'Find'));
        const count = document.createElement('span');
        count.className = 'viewer-find-count';
        count.textContent = '0/0';
        const prev = document.createElement('button');
        prev.className = 'viewer-find-prev';
        prev.title = label('viewerFind', 'Find') + ' ↑';
        prev.textContent = '↑';
        const next = document.createElement('button');
        next.className = 'viewer-find-next';
        next.title = label('viewerFind', 'Find') + ' ↓';
        next.textContent = '↓';
        const close = document.createElement('button');
        close.className = 'viewer-find-close';
        close.textContent = '✕';
        bar.appendChild(input); bar.appendChild(count); bar.appendChild(prev); bar.appendChild(next); bar.appendChild(close);
        let debounce = null;
        input.addEventListener('input', () => {
            if (debounce) { clearTimeout(debounce); }
            debounce = setTimeout(() => { if (state.findExec) { state.findExec(input.value); } }, 200);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (state.findStep) { state.findStep(e.shiftKey ? -1 : 1); } }
        });
        // Escape は bar 全体で拾う（prev/next ボタンにフォーカスがある時も閉じる）
        bar.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); state.findUi.close(); }
        });
        prev.addEventListener('click', () => { if (state.findStep) { state.findStep(-1); } });
        next.addEventListener('click', () => { if (state.findStep) { state.findStep(1); } });
        close.addEventListener('click', () => { state.findUi.close(); });
        state.findUi = {
            open() { bar.style.display = 'flex'; try { input.focus(); input.select(); } catch (e) { /* noop */ } },
            openWith(q) { input.value = String(q || ''); this.open(); if (state.findExec) { state.findExec(input.value); } },
            close() {
                bar.style.display = 'none';
                count.textContent = '0/0';
                if (state.findClear) { state.findClear(); }
            },
            onCount(c, t) { count.textContent = String(c) + '/' + String(t); },
            query() { return input.value; },
        };
        mount.appendChild(bar);
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

    /**
     * FR-VFB-02: iframe 内検索ヘルパーの注入（injectCopyHelper 同型）。
     * 親との通信は MessageChannel（fvFindInit で port を受け取る）— iframe → 親 window の
     * postMessage は不変条件 7（origin 'null' capture 遮断）で届かないため、port 経由が唯一経路。
     * ハイライトは span ラップ方式（テキストノード単位・case-insensitive・上限 1,000）。
     */
    function injectFindHelper(html, nonce) {
        const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
        const helper = `<script${nonceAttr}>(function(){`
            + `var port=null,spans=[],cur=-1,LIMIT=1000;`
            + `function clearHl(){for(var i=0;i<spans.length;i++){var sp=spans[i];if(!sp.parentNode){continue;}var t=document.createTextNode(sp.textContent);sp.parentNode.replaceChild(t,sp);}spans=[];cur=-1;}`
            + `function rendered(el){try{return !!(el&&el.getClientRects&&el.getClientRects().length);}catch(e){return true;}}`
            + `function collect(){var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null);var n,out=[];while((n=w.nextNode())){var pt=n.parentNode;if(!pt){continue;}var tag=pt.nodeName;if(tag==='SCRIPT'||tag==='STYLE'||tag==='NOSCRIPT'){continue;}if(!rendered(pt)){continue;}out.push(n);}return out;}`
            + `function exec(q){clearHl();if(!q){send();return;}var lq=q.toLowerCase();var nodes=collect();`
            + `for(var i=0;i<nodes.length&&spans.length<LIMIT;i++){var node=nodes[i];`
            + `var idx=(node.nodeValue||'').toLowerCase().indexOf(lq);`
            + `while(idx>=0&&spans.length<LIMIT){var match=node.splitText(idx);node=match.splitText(q.length);`
            + `var sp=document.createElement('span');sp.setAttribute('data-fv-find','1');sp.style.backgroundColor='rgba(255,213,79,0.6)';`
            + `match.parentNode.replaceChild(sp,match);sp.appendChild(match);spans.push(sp);`
            + `idx=(node.nodeValue||'').toLowerCase().indexOf(lq);}}`
            + `if(spans.length>0){cur=0;mark();}send();}`
            + `function mark(){for(var i=0;i<spans.length;i++){spans[i].style.backgroundColor=(i===cur)?'rgba(255,150,50,0.95)':'rgba(255,213,79,0.6)';}`
            + `if(cur>=0&&spans[cur]){try{spans[cur].scrollIntoView({block:'center'});}catch(e){}}}`
            + `function step(dir){if(spans.length===0){send();return;}cur=(cur+dir+spans.length)%spans.length;mark();send();}`
            + `function send(){if(port){port.postMessage({current:spans.length?cur+1:0,total:spans.length});}}`
            + `function onCmd(e){var d=(e&&e.data)||{};if(d.type==='fvFind'){exec(String(d.query||''));}`
            + `else if(d.type==='fvFindStep'){step(d.dir===-1?-1:1);}else if(d.type==='fvFindClear'){clearHl();send();}}`
            + `window.addEventListener('message',function(e){var d=e.data||{};if(d.type==='fvFindInit'&&e.ports&&e.ports[0]){port=e.ports[0];port.onmessage=onCmd;}});`
            + `document.addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&!e.altKey&&String(e.key).toLowerCase()==='f'){e.preventDefault();if(port){port.postMessage({openFind:true});}}});`
            + `})();</` + `script>`;
        if (/<\/head\s*>/i.test(html)) { return html.replace(/<\/head\s*>/i, helper + '$&'); }
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
            html = injectFindHelper(html, nonce); // FR-VFB-02（rerender 時も再注入 — 状態は親側 find bar が保持）
            const next = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
            const stale = currentBlobUrl;
            currentBlobUrl = next;
            iframe.src = next;
            // 差し替えた旧 objectURL は即 revoke（one-shot の set/clear 対 — リーク防止）
            if (stale) { try { URL.revokeObjectURL(stale); } catch { /* best-effort */ } }
        }
        render();
        if (state) { state.rerenderHtml = render; }
        // FR-VFB-02: 親 ⇄ iframe の find チャネル（MessageChannel — origin 'null' 遮断と非干渉）。
        // rerender（src 差し替え）ごとに load で張り直す（one-shot の set/clear 対）
        let findPort = null;
        let pendingFindQuery = null; // チャネル init 前に findExec された query（one-shot — init 時に flush）
        function initFindChannel() {
            try {
                if (findPort) { try { findPort.close(); } catch (e) { /* best-effort */ } }
                const ch = new MessageChannel();
                findPort = ch.port1;
                findPort.onmessage = (ev) => {
                    const d = (ev && ev.data) || {};
                    if (d.openFind) { if (state && state.findUi) { state.findUi.open(); } return; }
                    if (state && state.findUi) { state.findUi.onCount(d.current || 0, d.total || 0); }
                };
                iframe.contentWindow.postMessage({ type: 'fvFindInit' }, '*', [ch.port2]);
                if (pendingFindQuery != null) {
                    findPort.postMessage({ type: 'fvFind', query: pendingFindQuery });
                    pendingFindQuery = null;
                }
            } catch (e) { /* 縮退: find 不能でも表示は継続 */ }
        }
        iframe.addEventListener('load', initFindChannel);
        if (state) {
            state.findExec = (q) => {
                const query = String(q || '');
                if (findPort) { findPort.postMessage({ type: 'fvFind', query }); } else { pendingFindQuery = query; }
            };
            state.findStep = (dir) => { if (findPort) { findPort.postMessage({ type: 'fvFindStep', dir: dir }); } };
            state.findClear = () => { if (findPort) { findPort.postMessage({ type: 'fvFindClear' }); } else { pendingFindQuery = null; } };
        }
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
    async function openPdf(mount, fileUri, state) {
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

        // NFR-FV-06（表示速度の絶対優先 — 第 7 ラウンド②の回帰の教訓）: wasmUrl/iccUrl は**配線しない**
        // + useWasm:false を明示する。配線すると pdfjs 5.x worker が ICC 色空間で
        // `fetchSync(qcms_bg.wasm)` を**同期実行**し、blob worker → vscode-resource の同期 fetch が
        // タイムアウト（実機 ≈30 秒の白画面）する。未配線なら "missing wasmUrl" warn で即 fallback =
        // 4.10 と同等の即時表示（ICC 色管理/JPX wasm は非対応 = 受容。選択品質 #19785/#20492 は
        // DOM/CSS 機構で wasm 非依存 — 影響なし）。TC-FV-72 が番人
        const params = {
            data,
            cMapUrl: config.cMapUrl,
            cMapPacked: true,
            standardFontDataUrl: config.standardFontDataUrl,
            useWasm: false,
            isEvalSupported: false,     // CVE-2024-4367 defense-in-depth（ADRL-0065 決定 5）
        };
        window.__lastGetDocumentParams = {
            cMapUrl: params.cMapUrl,
            useWasm: params.useWasm,
            wasmUrl: params.wasmUrl,    // undefined（不在の pin — TC-FV-72）
            iccUrl: params.iccUrl,      // undefined（同上）
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
        // FR-VFB-01: PDFFindController はバンドル済み（5.5.207 — 版更新なし = CVE pin 不変・配線のみ）
        const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
        const viewer = new pdfjsViewer.PDFViewer({ container, eventBus, linkService, findController });
        linkService.setViewer(viewer);
        eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'page-width'; });
        linkService.setDocument(pdf, null);
        viewer.setDocument(pdf);

        // 第 8 ラウンド①: cmd/ctrl+A を viewer 内の PDF テキストに限定する。
        // note/sidepanel 面はアプリ UI と同一 document のため、素の select-all だと outliner や
        // ツリーまで選択がはみ出す。container を focus 可能（tabindex=-1）にして viewer 内クリックで
        // focus を取り、cmd+A は .pdfViewer（全ページ textLayer）への selectNodeContents に置換する
        container.tabIndex = -1;
        container.style.outline = 'none';
        const focusViewer = () => { try { container.focus({ preventScroll: true }); } catch { /* noop */ } };
        container.addEventListener('mousedown', focusViewer);
        eventBus.on('pagesinit', focusViewer);   // 開いた直後の cmd+A も viewer に閉じる
        container.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'a') {
                e.preventDefault();
                e.stopPropagation();
                const sel = window.getSelection();
                if (!sel) { return; }
                const range = document.createRange();
                range.selectNodeContents(inner);
                sel.removeAllRanges();
                sel.addRange(range);
            }
        });

        // FR-VFB-01: find bar 連携（件数は pdfjs のイベント購読・実行は eventBus dispatch）
        if (state) {
            const onCount = (e) => {
                const m = (e && e.matchesCount) || {};
                if (state.findUi) { state.findUi.onCount(m.current || 0, m.total || 0); }
            };
            eventBus.on('updatefindmatchescount', onCount);
            eventBus.on('updatefindcontrolstate', onCount);
            state.findExec = (q) => {
                eventBus.dispatch('find', {
                    source: null, type: '', query: String(q || ''), caseSensitive: false,
                    entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false,
                });
            };
            state.findStep = (dir) => {
                eventBus.dispatch('find', {
                    source: null, type: 'again', query: state.findUi ? state.findUi.query() : '', caseSensitive: false,
                    entireWord: false, highlightAll: true, findPrevious: dir === -1, matchDiacritics: false,
                });
            };
            state.findClear = () => { try { eventBus.dispatch('findbarclose', { source: null }); } catch (e) { /* noop */ } };
            // FR-VFB-04 / TASK-12d: locHint（p.N）のページ移動 — pagesinit 前の指定は pending で保持。
            // PDFFindController は**現在ページから**検索を開始するため、ページ移動 → find の順序が本質
            //（find が先だと page 1 の最初のマッチに着地してヒントが無効化される — ユーザー報告）
            let pendingFindPage = null;
            let pagesReady = false;
            const pagesReadyQueue = [];
            state.findGotoPage = (n) => {
                pendingFindPage = n;
                // PDFViewer の setter は pages 初期化前だと **throw せず silent no-op** する（rc.7 の敗因）—
                // 設定後に実値を読み戻して成功を実測検証し、未達なら pagesinit まで pending を保持する
                try { viewer.currentPageNumber = n; } catch (e) { /* pagesinit 待ち */ }
                if (viewer.currentPageNumber === n) { pendingFindPage = null; }
            };
            state.runWhenPagesReady = (fn) => { if (pagesReady) { fn(); } else { pagesReadyQueue.push(fn); } };
            eventBus.on('pagesinit', () => {
                if (pendingFindPage != null) {
                    try { viewer.currentPageNumber = pendingFindPage; } catch (e) { /* noop */ }
                    pendingFindPage = null;
                }
                pagesReady = true;
                while (pagesReadyQueue.length) { try { pagesReadyQueue.shift()(); } catch (e) { /* noop */ } }
            });
        }

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
    async function open(kind, fileUri, mountEl, filePath, opts) {
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
        buildToolbar(mount, fileUri, kind, filePath, state, opts);
        // FR-VFB-03: ツールバー末尾に 🔍（find bar トグル）。image は find 対象外のため非表示（FR-FV-19/21）
        const tb = kind === 'image' ? null : mount.querySelector('.viewer-toolbar');
        if (tb) {
            const fbtn = document.createElement('button');
            fbtn.className = 'viewer-find-toggle';
            fbtn.title = label('viewerFind', 'Find');
            fbtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
            fbtn.setAttribute('aria-label', label('viewerFind', 'Find'));
            fbtn.addEventListener('click', () => { if (state.findUi) { state.findUi.open(); } });
            // 順序 contract（TC-FV-62 / FR-FV-12 改訂）: 表示系（script-toggle）の隣・アクション群（OS で開く〜）の前
            tb.insertBefore(fbtn, tb.querySelector('.viewer-open-external'));
        }
        buildFindBar(mount, state);
        buildBody(mount);
        // TASK-12（ユーザー報告 2026-08-23）: Cmd+F は window capture で一元先取り（下の
        // __fvFindKeyHook）— フォーカスが webview body にあっても外部 find（VS Code/ブラウザ）に
        // 奪われず当方の find bar が開く。mount は focus 可能にしておく（クリック後の操作性）
        findRegistry.set(mount, state);
        mount.tabIndex = -1;
        mount.style.outline = 'none';
        mount.addEventListener('mousedown', (e) => {
            const t = e.target;
            if (t && t.closest && (t.closest('.viewer-find-bar') || t.closest('input'))) { return; }
            try { mount.focus({ preventScroll: true }); } catch (err) { /* noop */ }
        });
        try {
            if (kind === 'pdf') {
                const { pdf } = await openPdf(mount, fileUri, state);
                // TASK-10: destroy(mount) で pdfDocument（worker / ArrayBuffer）も解放する
                cleanupRegistry.set(mount, () => {
                    try { pdf.destroy(); window.__lastPdfDocDestroyed = true; } catch { /* best-effort */ }
                });
            } else if (kind === 'html') {
                await openHtml(mount, fileUri, state);
            } else if (VIEWER_MODULE_KINDS.indexOf(kind) !== -1) {
                // sprint 20260823-165314 / FR-FV-17: kind 別 ESM モジュールへ委譲（汎用 mount 契約）。
                // locHint/findQuery はモジュールが one-shot 消費する（open() 側の :findQuery 自動 find
                // ブロックは pdf/html 専用のまま — 下の gate 参照）
                const body = mount.querySelector('.viewer-body');
                const loading = document.createElement('div');
                loading.className = 'viewer-loading';
                loading.textContent = '…';
                body.appendChild(loading);
                const mod = await loadViewerModule(kind);
                const instance = await mod.default.mount({
                    body, mount, state, config, postMessage, label,
                    fileUri, filePath,
                    locHint: parseLocHint(kind, opts && opts.locHint),
                    findQuery: (opts && opts.findQuery) ? String(opts.findQuery) : null,
                });
                try { loading.remove(); } catch (eRm) { /* モジュールが body を作り直した場合 */ }
                if (instance && typeof instance.destroy === 'function') {
                    const prevCleanup = cleanupRegistry.get(mount);
                    cleanupRegistry.set(mount, () => {
                        if (prevCleanup) { try { prevCleanup(); } catch (e3) { /* best-effort */ } }
                        try { instance.destroy(); } catch (e4) { /* best-effort */ }
                    });
                }
            } else {
                showError(mount, fileUri, `unsupported kind: ${kind}`);
            }
            // TASK-12: open 完了時に viewer へ focus（隠れた md editor に focus が残ったままだと
            // Cmd+F の対象が曖昧になる — 開いた直後の Cmd+F を viewer に確定させる）
            try { mount.focus({ preventScroll: true }); } catch (e2) { /* noop */ }
            // FR-VFB-04 / TASK-12d: 検索ヒット経由の open は自動 find。pdf はページ移動 **完了後** に
            // find を発行（FindController が現在ページ起点のため — ヒントページのマッチに着地する）
            // module kind（text/image/docx/xlsx/pptx）は mount ctx 経由でモジュール自身が消費するため除外
            if (opts && opts.findQuery && state.findUi && VIEWER_MODULE_KINDS.indexOf(kind) === -1) {
                const fq = String(opts.findQuery);
                const pd = (kind === 'pdf') ? parseLocHint('pdf', opts.locHint) : null;
                if (pd && state.findGotoPage && state.runWhenPagesReady) {
                    state.findGotoPage(pd.page);
                    state.runWhenPagesReady(() => { state.findUi.openWith(fq); });
                } else {
                    state.findUi.openWith(fq);
                }
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
        findRegistry.delete(mount); // TASK-12: Cmd+F 先取り対象から除外（one-shot 対配線）
        mount.textContent = '';
    }

    window.__fileViewer = { open, destroy, parseLocHint };

    // standalone 面: config に kind/fileUri が来ていれば自動オープン
    if (config.kind && config.fileUri) {
        open(config.kind, config.fileUri, document.getElementById('viewer-root'));
    }
})();
