/**
 * menu-placement — 右クリックメニューを viewport 内に収める共有配置ヘルパ
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-MFIT / ADRL-0109）
 *
 * 対象は 7 サイト（outliner node / outliner 列ヘッダ / md editor / note ツリー file /
 * note ツリー folder / linkedfd 行 / mindmap）。各面にコピーせず 1 実装を共有する
 * （clamp のある 2 面が同型の字面コピーで両方とも負値ガードを欠いていた実績があるため）。
 *
 * 3 段のアルゴリズム:
 *   (1) 測定  : visibility:hidden + position:fixed で挿入 → 同一 tick 内で同期 getBoundingClientRect()
 *   (2) 収まり: viewport 高を超えるなら max-height + overflow-y:auto を先に決める
 *              （高さが確定しないと (3) の flip 後 top が誤る）
 *   (3) 配置  : main 軸 flip（右端→左 / 下端→上）→ 残差を clamp（Math.max(gap, …) で負値を潰す）
 *
 * 絶対条項:
 *   - 衝突補正後に at.x / at.y（呼び出し元の clientX / clientY）を書き戻さない
 *     （書き戻すと次回以降の配置が壊れる）
 *   - CSS anchor positioning は使わない（Chromium 125+ 必須 vs Electron 28 = 120 / VS Code 1.85 = 114）
 *   - Popover API は使わない（z-index は design token --fr-z-popup で既に解決済み）
 *   - webview は iframe なので top layer でも webview 外へは出せず、
 *     window.innerWidth / innerHeight が正しい基準になる
 */
(function () {
    'use strict';

    var DEFAULT_GAP = 8;

    /**
     * メニューを viewport 内に収めて配置する。
     *
     * @param {HTMLElement} menu 既に DOM へ挿入済みの要素（position:fixed 前提。無ければ設定する）
     * @param {{x:number,y:number}} at カーソル位置（0 サイズの virtual element として扱う）
     * @param {{gap?:number}} [opt] 端からの最小余白（既定 8）
     */
    function place(menu, at, opt) {
        if (!menu || !at) { return; }
        var gap = (opt && typeof opt.gap === 'number') ? opt.gap : DEFAULT_GAP;
        var vw = window.innerWidth;
        var vh = window.innerHeight;

        // --- (1) 測定: 一度左上へ寄せて素の寸法を同期で測る --------------------
        var prevVisibility = menu.style.visibility;
        menu.style.position = 'fixed';
        menu.style.visibility = 'hidden';
        menu.style.maxHeight = '';
        menu.style.overflowY = '';
        menu.style.left = '0px';
        menu.style.top = '0px';

        var rect = menu.getBoundingClientRect();   // await を挟まない（同一 tick）
        var w = rect.width;
        var h = rect.height;

        // --- (2) 収まり: 入らない高さは max-height + scroll にしてから配置を決める --
        var maxH = vh - gap * 2;
        if (maxH > 0 && h > maxH) {
            menu.style.maxHeight = maxH + 'px';
            menu.style.overflowY = 'auto';
            h = maxH;
        }

        // --- (3) 配置: flip → clamp ------------------------------------------
        var left = at.x;
        var top = at.y;

        // main 軸 flip（カーソルを跨いで反対側へ）
        if (left + w > vw - gap) { left = at.x - w; }
        if (top + h > vh - gap) { top = at.y - h; }

        // 残差を clamp。Math.max(gap, …) が無いと tall menu で負値になり上端が画面外へ出る
        left = Math.min(Math.max(gap, left), Math.max(gap, vw - w - gap));
        top = Math.min(Math.max(gap, top), Math.max(gap, vh - h - gap));

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = prevVisibility || '';

        // at.x / at.y は書き戻さない（呼び出し元の clientX/clientY を汚さない）
    }

    window.__menuPlacement = { place: place };
})();
