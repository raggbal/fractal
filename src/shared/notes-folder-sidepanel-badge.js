/**
 * notes-folder-sidepanel-badge.js — sidepanel md の「リンクフォルダ内 md」🔗 バッジ（FR-FLV-29）
 *
 * sprint 20260817-053313-notetree-local-folder-view 再オープ①（2026-08-18）。
 *
 * outliner.js（NFR-FLV-07: 変更 0）が管轄する Notes md sidepanel のヘッダに、host の
 * `openSidePanel` message が `linkedFolderTitle`（folder link 配下判定は host — 絶対パス不出 INV-4）を
 * 同梱してきたとき 🔗 + title のバッジを後付けする独立モジュール。
 *
 * - 独立した window 'message' listener（outliner.js の handler とは別登録）。バッジは
 *   `.side-panel-filename` の**兄弟 span** なので、outliner 側の `sidePanelFilename.textContent = ...`
 *   に消されない = listener 実行順に依存しない
 * - linkedFolderTitle 無しの openSidePanel では既存バッジを除去（stale を残さない — one-shot 対称）
 * - CSS はトークンのみ（NFR-FLV-08）
 */
(function () {
    'use strict';

    var STYLE_ID = 'folder-sidepanel-badge-style';
    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) { return; }
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = [
            '.side-panel-linkedfolder-badge { margin-left: 6px; font-size: 11px; opacity: 0.75;',
            '  color: var(--outliner-fg); white-space: nowrap; flex: 0 0 auto; }',
        ].join('\n');
        document.head.appendChild(style);
    }

    function removeBadge() {
        var old = document.querySelector('.side-panel-linkedfolder-badge');
        if (old && old.parentElement) { old.parentElement.removeChild(old); }
    }

    function applyBadge(title) {
        var nameEl = document.querySelector('.side-panel-filename');
        if (!nameEl || !nameEl.parentElement) { return; }
        ensureStyle();
        removeBadge();
        var badge = document.createElement('span');
        badge.className = 'side-panel-linkedfolder-badge';
        badge.textContent = '🔗 ' + title;
        badge.title = title;
        nameEl.parentElement.insertBefore(badge, nameEl.nextSibling);
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg || msg.type !== 'openSidePanel') { return; }
        if (msg.linkedFolderTitle) {
            applyBadge(String(msg.linkedFolderTitle));
        } else {
            removeBadge();
        }
    });
})();
