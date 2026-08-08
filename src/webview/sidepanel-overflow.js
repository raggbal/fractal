/**
 * Side panel header overflow menu — FR-SPM-01 (sprint 20260808-000219)
 *
 * 狭幅時に `.side-panel-header-scroll` 内の非固定ボタンが横スクロールに隠れて
 * 押せない問題への対策。溢れる分だけ右端のボタンから順に `sp-overflowed` クラス
 * （CSS display:none）を付け、「…」ボタンのプロキシメニューから発火できるようにする。
 *
 * 設計原則（ADRL-sidepanel-overflow-menu）:
 *  - ボタン DOM は一切動かさない（editor.js:16677 / outliner.js:8016 の 2 実装の
 *    cloneNode 配線・undo/redo disabled 直接操作・styles.css の祖先属性セレクタを断線させない）
 *  - メニュー item は開くたびに溢れボタンを走査して再生成するプロキシ
 *    （click は元ボタン element の .click() を委譲。disabled/title は開いた時点のスナップショット）
 *  - filename は格納対象外（従来の ellipsis 縮小のまま）
 *  - computed display:none の元ボタン（copy-inapp-link の Notes 限定 / translate 設定 OFF）は
 *    幅を消費しないため走査 skip（候補外）
 *  - 翻訳ビューの innerHTML 差し替え/復元直後は呼び出し側が recalc() を明示コール（決定論）
 *
 * 3 host（Notes / standalone outliner / standalone md）の webviewContent が共通ロードする。
 */
(function() {
    'use strict';

    var _wired = false;
    var _menuOpen = false;

    function header() { return document.querySelector('.side-panel .side-panel-header'); }
    function scrollEl() { return document.querySelector('.side-panel .side-panel-header-scroll'); }
    function overflowBtn() { return document.getElementById('sidePanelOverflowBtn'); }
    function menuEl() { return document.getElementById('sidePanelOverflowMenu'); }

    /** 格納候補: scroll 内の非固定ボタン（filename は対象外）。DOM 順で返す。 */
    function candidates() {
        var scroll = scrollEl();
        if (!scroll) return [];
        var list = [];
        var actions = scroll.querySelector('.side-panel-header-actions');
        if (actions) {
            var kids = actions.children;
            for (var i = 0; i < kids.length; i++) {
                if (kids[i].tagName === 'BUTTON') list.push(kids[i]);
            }
        }
        var copyPath = scroll.querySelector('.side-panel-copy-path');
        if (copyPath) list.push(copyPath);
        var inapp = scroll.querySelector('.side-panel-copy-inapp-link');
        if (inapp) list.push(inapp);
        return list;
    }

    /** 元々非表示（設定 OFF / Notes 限定）のボタンか。sp-overflowed 自身は除いて判定する。 */
    function isNativelyHidden(btn) {
        if (btn.classList.contains('sp-overflowed')) {
            // 一時的に外して computed を見る（restore は同期なので描画チラつきなし）
            btn.classList.remove('sp-overflowed');
            var hidden = getComputedStyle(btn).display === 'none';
            btn.classList.add('sp-overflowed');
            return hidden;
        }
        return getComputedStyle(btn).display === 'none';
    }

    /**
     * 幅再計算: 全候補を一旦表示に戻して自然幅を測り、収まらない分を右端から格納する。
     * 溢れ判定は「scroll 内コンテンツの必要幅 > scroll の利用可能幅」。
     */
    function recalc() {
        var scroll = scrollEl();
        var btn = overflowBtn();
        if (!scroll || !btn) return;

        // 翻訳ビュー中も通常時も同じ扱い: その時点で actions にあるボタン（翻訳ビューなら
        // Back/Save）を候補として幅判定する。差し替え/復元の直後は呼び出し側（outliner.js）が
        // recalc() を明示コールして stale 格納を掃除する（FR-SPM-01）
        var cands = candidates().filter(function(b) { return !isNativelyHidden(b); });

        // 一旦全部戻して自然幅を測る
        for (var i = 0; i < cands.length; i++) cands[i].classList.remove('sp-overflowed');
        btn.style.display = 'none';

        if (cands.length === 0) { closeMenu(); return; }

        // scrollWidth > clientWidth = 溢れ。右端から 1 個ずつ格納して再判定。
        var overflowed = [];
        var guard = cands.length;
        while (scroll.scrollWidth > scroll.clientWidth + 1 && guard-- > 0) {
            // 「…」ボタン自身の幅も必要になるので、1 個でも格納が始まったら表示して測り直す
            btn.style.display = '';
            var next = null;
            for (var k = cands.length - 1; k >= 0; k--) {
                if (!cands[k].classList.contains('sp-overflowed')) { next = cands[k]; break; }
            }
            if (!next) break;
            next.classList.add('sp-overflowed');
            overflowed.push(next);
        }

        btn.style.display = overflowed.length > 0 ? '' : 'none';
        if (overflowed.length === 0) closeMenu();
        else if (_menuOpen) buildMenu(); // 開いたまま幅が変わったら item を作り直す
    }

    /** メニュー item を溢れボタンから再生成（プロキシ方式）。 */
    function buildMenu() {
        var menu = menuEl();
        if (!menu) return;
        menu.innerHTML = '';
        var over = candidates().filter(function(b) {
            return b.classList.contains('sp-overflowed') && !isNativelyHidden(b);
        });
        for (var i = 0; i < over.length; i++) {
            (function(src) {
                var item = document.createElement('button');
                item.className = 'side-panel-overflow-item';
                item.type = 'button';
                item.disabled = !!src.disabled;
                // icon（svg）を複製 + title をラベルに
                var icon = src.querySelector('svg');
                if (icon) item.appendChild(icon.cloneNode(true));
                var label = document.createElement('span');
                label.textContent = src.title || src.getAttribute('data-action') || '';
                item.appendChild(label);
                item.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu();
                    src.click(); // 元ボタンの既存配線へ委譲（DOM 不動の要）
                });
                menu.appendChild(item);
            })(over[i]);
        }
    }

    function openMenu() {
        var menu = menuEl();
        var btn = overflowBtn();
        if (!menu || !btn) return;
        buildMenu();
        menu.style.display = 'block';
        _menuOpen = true;
        // 「…」ボタン直下に配置（header は position 文脈を持たないので fixed で viewport 基準）
        var r = btn.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
        menu.style.left = 'auto';
    }

    function closeMenu() {
        var menu = menuEl();
        if (menu) menu.style.display = 'none';
        _menuOpen = false;
    }

    /** 初期化（idempotent）。sidepanel open 時に editor.js / outliner.js から呼ばれる。 */
    function init() {
        var btn = overflowBtn();
        var hd = header();
        if (!btn || !hd) return;
        if (!_wired) {
            _wired = true;
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (_menuOpen) closeMenu(); else openMenu();
            });
            document.addEventListener('click', function(e) {
                if (!_menuOpen) return;
                var menu = menuEl();
                if (menu && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                    closeMenu();
                }
            });
            if (typeof ResizeObserver !== 'undefined' && !window.__disableSidePanelOverflowObserver) {
                var ro = new ResizeObserver(function() {
                    if (window.__disableSidePanelOverflowObserver) return; // テスト用 counterfactual フラグ
                    recalc();
                });
                ro.observe(hd);
            }
        }
        recalc();
    }

    window.SidePanelOverflow = {
        init: init,
        recalc: recalc,
        closeMenu: closeMenu,
    };
})();
