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
        if (kind === 'pdf') {
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
