/**
 * viewer-side-panel.js — file viewer の sidepanel 面（.viewer-side-panel ペイン管理）
 *
 * sprint 20260815-075428-file-viewer-3panes / FR-FV-05 / ADRL-0066 決定 2。
 * 既存 md の .side-panel とは別 DOM。**sidepanel md の中のリンクから開いたときだけ** md の上に重ねる
 * （sprint 20261009-130815 / ADRL-0138 — 2026-10-15 改訂。全 kind 共通）:
 *   - overlay（host の openViewerPanel に overlay: true — sidePanelManager.handleOpenLink のみが付ける）:
 *     md sidepanel は閉じない。viewer を前面（z-index 150 > md 100）に置き、幅を md の現在幅に合わせる。
 *     viewer を閉じれば md がそのまま見える
 *   - それ以外（outliner の file node・ノートツリー・フォルダビュー等）: 従来どおり md sidepanel を閉じて入れ替える
 *     （DOM class の直接除去はせず md 側の close ボタンの click を経由 — md 側コードへの直接参照ゼロ = NFR-FV-02）
 *   - Esc: 最前面の 1 枚だけを閉じる（下の keydown handler — window capture + target スコープ検査 + stopImmediatePropagation。
 *     script の読み込み順に依存しない — Notes 面は md editor の handler が先に登録される: 再オープン②）
 *   - md open 時の viewer close: md 側 open 処理の冒頭に window.__viewerSidePanel?.close() の
 *     1 行 hook（NFR-FV-02 許容 ② — 従来どおり）。md だけが閉じても viewer は閉じない
 *
 * 再オープン③（FR-FV-14 / design §15）: md .side-panel との**自己完結ミラー**パリティ —
 *   ジオメトリ（styles.css:1658-1694 と同値: position:absolute / top=タブバー変数 / width 50% /
 *   min 288px / max 70%）・⤢ expand（.expanded = 95%）・左端幅 D&D リサイズ
 *   （outliner.js setupSidePanelResize:7932-7991 と同値の clamp + 必須テク 5 点）。
 *   md の css/js への参照はゼロ（値の複製のみ）。幅の永続化はしない（md との差分受容 —
 *   generator-log 記録済み）。ヘッダは自前実装を廃し buildToolbar（file-viewer.js）に統合
 *   （opts.onExpand / opts.onClose — 1 実装 3 マウントの原則）。
 *
 * 表示実体は window.__fileViewer（file-viewer.js — 1 実装 3 マウント）。
 */
(function () {
    'use strict';

    let panelEl = null;
    // 第 8 ラウンド④: close 時の focus 復帰用（pdf 面は cmd+A スコープ用に viewer container が
    // focus を奪う — md sidepanel の「close で origin node へ focus を戻す」precedent と同等の挙動を
    // outliner 内部 API に触れず汎用に実現する。one-shot: open で set / close で consume+clear）。
    // caret は **文字オフセット**で保存する（Range の DOM 参照は outliner が blur/再レンダで
    // テキストノードを作り直すと isConnected=false になり「node 先頭に戻る」劣化を起こす — 第 8 R⑤）
    let prevFocusEl = null;
    let prevCaretOffset = null;

    // スタイルは自己完結で注入（md 側 css ファイルを触らない — NFR-FV-02。
    // 値は md .side-panel（styles.css:1658-1694）/ .side-panel-resize-handle（:1697-1713）の複製）
    function ensureStyle() {
        if (document.getElementById('viewer-side-panel-style')) { return; }
        const style = document.createElement('style');
        style.id = 'viewer-side-panel-style';
        style.textContent = [
            // ジオメトリ: md .side-panel と同値（タブバー下端に収める = タブ被り解消・FR-FV-14-1）
            '.viewer-side-panel { display: none; position: absolute;',
            '  top: var(--notes-tab-bar-height, 0px); right: 0; bottom: 0;',
            '  width: 50%; min-width: min(288px, 95vw); max-width: 70%;',
            '  background: var(--fr-color-bg-panel, var(--vscode-editorWidget-background, #f7f7f5));',
            '  border-left: 1px solid var(--fr-color-border, var(--vscode-panel-border, #ddd));',
            '  box-shadow: -4px 0 12px rgba(0,0,0,0.08);',
            // ADRL-0138: md .side-panel（z-index 100）の上に重ねる。既存 popup（200 以上）・lightbox（1000 以上）より下
            '  z-index: 150; flex-direction: column; }',
            '.viewer-side-panel.open { display: flex; }',
            // ⤢ expand（md .expanded :1692-1694 と同値）
            '.viewer-side-panel.expanded { width: 95%; max-width: 95%; }',
            // 左端リサイズハンドル（md .side-panel-resize-handle :1697-1713 と同値）
            '.viewer-side-panel-resize-handle { position: absolute; top: 0; left: -3px; width: 5px;',
            '  height: 100%; cursor: col-resize; z-index: 101; background: transparent; }',
            '.viewer-side-panel-resize-handle:hover, .viewer-side-panel-resize-handle.active {',
            '  background: var(--fr-color-primary, var(--vscode-focusBorder, #007acc));',
            '  width: 2px; left: -1px; }',
            '.viewer-side-panel-mount { flex: 1 1 auto; position: relative; overflow: auto;',
            '  display: flex; flex-direction: column; min-height: 0; }',
            '.viewer-side-panel-mount .viewer-body { flex: 1 1 auto; position: relative; overflow: auto; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    /** 幅 D&D リサイズ（outliner.js setupSidePanelResize と同値の自己完結ミラー — 必須テク 5 点） */
    function setupResize(panel, handle) {
        let startX = 0;
        let startWidth = 0;
        const frames = () => panel.querySelectorAll('iframe');
        function clampWidth(w) {
            const maxW = (panel.parentElement || document.body).offsetWidth * 0.95;
            return Math.max(320, Math.min(w, maxW));
        }
        function onMove(e) {
            const w = clampWidth(startWidth + (startX - e.clientX));
            panel.style.width = w + 'px';
            panel.style.maxWidth = w + 'px';
            delete panel.dataset.autoWidth; // ユーザーのリサイズ値 = md 合わせの印を外す（開き直しても保持）
        }
        function onUp() {
            // ③ 掃除は 4 点対（listener ×2 + body カーソル/選択 + iframe pointerEvents 復元）
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            handle.classList.remove('active');
            frames().forEach((f) => { f.style.pointerEvents = ''; });
        }
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            // ② resize 開始で最大化を解除（md と同挙動）
            panel.classList.remove('expanded');
            startX = e.clientX;
            startWidth = panel.offsetWidth;
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            handle.classList.add('active');
            // ① drag 中は viewer 内 iframe（html 面）に mousemove を食わせない（既知問題の回避）
            frames().forEach((f) => { f.style.pointerEvents = 'none'; });
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        // ⑤ window resize で表示中パネルを親 95% 内へ再クランプ（md の再クランプと同値。
        //    ResizeObserver は省略 — 差分受容・generator-log 記録）
        window.addEventListener('resize', () => {
            if (!panel.classList.contains('open') || panel.classList.contains('expanded')) { return; }
            const maxW = (panel.parentElement || document.body).offsetWidth * 0.95;
            if (panel.offsetWidth > maxW) {
                const w = Math.max(320, maxW);
                panel.style.width = w + 'px';
                panel.style.maxWidth = w + 'px';
            }
        });
    }

    function ensurePanel() {
        ensureStyle();
        if (panelEl && document.body.contains(panelEl)) { return panelEl; }
        panelEl = document.createElement('div');
        panelEl.className = 'viewer-side-panel';
        const handle = document.createElement('div');
        handle.className = 'viewer-side-panel-resize-handle';
        const mount = document.createElement('div');
        mount.className = 'viewer-side-panel-mount';
        panelEl.appendChild(handle);
        panelEl.appendChild(mount);
        // mount 先は md .side-panel と同じ containing block（notes 面 = .notes-main-wrapper。
        // outliner 単独面は従来どおり body — タブバー変数未定義 → top 0px で全高）
        const parent = document.querySelector('.notes-main-wrapper') || document.body;
        parent.appendChild(panelEl);
        setupResize(panelEl, handle);
        return panelEl;
    }

    /** ⤢ expand toggle（md .expanded と同値。inline 幅は expand 中は class が勝つよう退避） */
    function toggleExpand() {
        if (!panelEl) { return; }
        if (panelEl.classList.contains('expanded')) {
            panelEl.classList.remove('expanded');
            // 退避した手動リサイズ幅を復元
            if (panelEl.dataset.prevWidth) {
                panelEl.style.width = panelEl.dataset.prevWidth;
                panelEl.style.maxWidth = panelEl.dataset.prevWidth;
                delete panelEl.dataset.prevWidth;
            }
        } else {
            // inline width があると .expanded(95%) より優先されるため退避してクリア
            if (panelEl.style.width) {
                panelEl.dataset.prevWidth = panelEl.style.width;
                panelEl.style.width = '';
                panelEl.style.maxWidth = '';
            }
            panelEl.classList.add('expanded');
        }
    }

    /** viewer サイドペインを開く（md sidepanel が開いていても閉じずに前面へ重ね、幅を md に合わせる — ADRL-0138） */
    function open(kind, fileUri, fileName, filePath, openOpts) {
        const overlay = !!(openOpts && openOpts.overlay);
        // focus 復帰用の退避（viewer が focus を奪う前に。パネル自身からの再 open では上書きしない）
        try {
            const ae = document.activeElement;
            if (ae && ae !== document.body && !(panelEl && panelEl.contains(ae))) {
                prevFocusEl = ae;
                prevCaretOffset = null;
                const sel = window.getSelection();
                if (sel && sel.rangeCount > 0) {
                    const r = sel.getRangeAt(0);
                    if (ae.contains(r.startContainer)) {
                        // 要素先頭から caret までの文字数（DOM 参照非依存 — 再レンダ耐性）
                        const pre = document.createRange();
                        pre.selectNodeContents(ae);
                        pre.setEnd(r.startContainer, r.startOffset);
                        prevCaretOffset = pre.toString().length;
                    }
                }
            }
        } catch { /* noop */ }
        // overlay でなければ従来の排他: md sidepanel を閉じて入れ替える（md の close ボタンの click 経由）
        if (!overlay) {
            try {
                const mdCloseBtn = document.querySelector('.side-panel.open .side-panel-close');
                if (mdCloseBtn) { mdCloseBtn.click(); }
            } catch { /* md sidepanel 不在は正常 */ }
        }
        // ADRL-0138: overlay のときは md sidepanel を閉じずに上に重ね、幅を md に合わせる
        //（開いた後のリサイズ追従はしない — FR-VSO-03）。⤢ expanded は class が上書きする
        const panel = ensurePanel();
        // md に合わせた幅には印（dataset.autoWidth）を付け、md 不在で開くときは印付きの幅だけを既定（CSS 50%）へ戻す。
        // 手のリサイズ値は印が外れるので保持される（reviewer iter3 QUAL-3 / DC-2）
        try {
            const md = overlay ? document.querySelector('.side-panel.open') : null;
            const w = md ? md.getBoundingClientRect().width : 0;
            if (w > 0) {
                panel.style.width = Math.round(w) + 'px';
                panel.style.maxWidth = Math.round(w) + 'px'; // 過去のリサイズで残った max-width に縮められないように
                panel.dataset.autoWidth = '1';
            } else if (panel.dataset.autoWidth) {
                panel.style.width = '';
                panel.style.maxWidth = '';
                delete panel.dataset.autoWidth;
            }
        } catch { /* noop */ }
        panel.classList.add('open');
        const mount = panel.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) {
            // ヘッダは buildToolbar（file-viewer.js）が兼ねる: filename 表示 + ⤢ 先頭 + × 最右端
            //（md 正典順 — FR-FV-14-2。1 実装 3 マウントの原則で sidepanel 専用ヘッダを持たない）
            window.__fileViewer.open(kind, fileUri, mount, filePath, {
                onExpand: toggleExpand,
                onClose: close,
            });
        }
    }

    /** viewer サイドペインを閉じる（md 側 open 冒頭 hook からも呼ばれる） */
    function close() {
        if (!panelEl) { return; }
        panelEl.classList.remove('open');
        // ④ close 時に最大化をリセット（md と同挙動 — 次回 open は非 expand から）
        panelEl.classList.remove('expanded');
        delete panelEl.dataset.prevWidth;
        const mount = panelEl.querySelector('.viewer-side-panel-mount');
        if (window.__fileViewer && mount) { window.__fileViewer.destroy(mount); }
        // focus を開いた時の場所へ戻す（第 8 ラウンド④）。現 focus がパネル内 or body の時だけ —
        // ユーザーが既に他所（md editor 等）をクリックしていたら奪い返さない
        try {
            const ae = document.activeElement;
            const stole = !ae || ae === document.body || (panelEl && panelEl.contains(ae));
            if (stole && prevFocusEl && prevFocusEl.isConnected) {
                const el = prevFocusEl;
                const offset = prevCaretOffset;
                el.focus({ preventScroll: true });
                if (offset !== null) {
                    // 文字オフセット位置へ caret を置く（現在の DOM を歩いて再解決 — 再レンダ耐性）。
                    // focus 由来の再レンダ（outliner の editing モード切替）後にもう一度適用する
                    const place = () => {
                        try {
                            if (!el.isConnected) { return; }
                            let remaining = offset;
                            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                            let node = walker.nextNode();
                            let target = null;
                            let tOff = 0;
                            while (node) {
                                const len = (node.textContent || '').length;
                                if (remaining <= len) { target = node; tOff = remaining; break; }
                                remaining -= len;
                                node = walker.nextNode();
                            }
                            const sel = window.getSelection();
                            if (!sel) { return; }
                            const r = document.createRange();
                            if (target) { r.setStart(target, tOff); r.collapse(true); }
                            else { r.selectNodeContents(el); r.collapse(false); }
                            sel.removeAllRanges();
                            sel.addRange(r);
                        } catch { /* noop */ }
                    };
                    place();
                    requestAnimationFrame(place);
                }
            }
        } catch { /* noop */ }
        prevFocusEl = null;
        prevCaretOffset = null;
    }

    function isOpen() {
        return !!(panelEl && panelEl.classList.contains('open'));
    }

    // Esc で閉じる（第 8 ラウンド③ — md sidepanel の precedent と同型。lightbox が開いている間はそちらを優先）。
    // ADRL-0138: md sidepanel と重なっているとき、Esc 1 回で閉じるのは最前面の viewer だけ。
    //   - **window の capture 段階**で受ける: document の全 handler より先に走るので script の読み込み順に依存しない
    //     （Notes 面は md editor = editor.js の Esc handler が本ファイルより先に登録される — 再オープン② で実測）
    //   - target が viewer パネル内か body のときだけ閉じる（メインペインのダイアログ・入力欄・md 側で押した Esc は奪わない）
    //   - viewer の find bar 内の Esc は find bar 自身の handler（bubble）に任せる（capture で先に奪わない）
    //   - 閉じたら stopImmediatePropagation（以降の全 handler — md の Esc を含む — に届かない = 1 回で 1 枚）
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !panelEl || !panelEl.classList.contains('open')) { return; }
        if (document.querySelector('.outliner-image-overlay')) { return; }
        const t = e.target;
        if (!(t === document.body || (t && panelEl.contains(t)))) { return; }
        if (t && t.closest && t.closest('.viewer-find-bar')) { return; }
        close();
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    window.__viewerSidePanel = { open, close, isOpen };

    // host からの message（sidePanelManager.tryOpenViewerPanel が送る）
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'openViewerPanel') {
            open(msg.kind, msg.fileUri, msg.filePath ? msg.filePath.split('/').pop() : '', msg.filePath, { overlay: !!msg.overlay });
        } else if (msg && msg.type === 'closeViewerPanel') {
            close();
        }
    });
})();
