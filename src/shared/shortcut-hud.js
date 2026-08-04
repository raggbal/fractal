// shortcut-hud.js — FR-B06b: cmd（mac meta / win ctrl）単独長押し 800ms でショートカット一覧 HUD を表示。
//
// editor.js / outliner.js の初期化から ShortcutHud.init(document, 'md' | 'outliner') で呼ぶ
// （両ファイルに同型ロジックをコピペしない）。
//
// 挙動:
//   - keydown で e.key === 'Meta'（mac）or 'Control'（win/linux）**単独**（他修飾なし・他キー未押下）
//     → 800ms タイマー開始。タイマー満了で HUD 表示。
//   - 他のキーが押されたら（cmd+C 等）タイマーをキャンセル & HUD を出さない / 表示中なら即消す。
//   - keyup（Meta/Control）で HUD 消去 + タイマーキャンセル。
//   - window blur / visibilitychange でも消す（cmd+tab で keyup が来ない対策。
//     one-shot state のクリア契機を対で置く — designer_failures 2026-08-02 の教訓）。
//   - IME composition 中は出さない（compositionstart/end フラグ）。
//
// Notes webview は editor.js + outliner.js の両方がロードされる → HUD は 1 個だけ
// （window.__shortcutHudInitialized フラグで 2 回目の init を no-op）。
//
// テスト seam: window.__shortcutHudDelayMs で 800ms を上書き可（実時間待ちを短縮）。
//
// UMD: CommonJS + window.ShortcutHud。

'use strict';

var DEFAULT_DELAY_MS = 800;
var HUD_ID = 'fractal-shortcut-hud';

// mode 判定: keydown 対象が Meta（mac）か Control（win/linux）か。
function _isTriggerKey(key) {
    return key === 'Meta' || key === 'Control';
}

// 修飾キー 1 個だけ押されている状態か（cmd 単独 = 他修飾なし）。
// Meta キー単独なら metaKey は true だが shift/alt/ctrl は false であることを要求。
// Control キー単独なら ctrlKey true, その他 false。
function _isSoleModifier(e) {
    if (e.key === 'Meta') {
        return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey;
    }
    if (e.key === 'Control') {
        return e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
    }
    return false;
}

function _getDelayMs() {
    if (typeof window !== 'undefined' && typeof window.__shortcutHudDelayMs === 'number') {
        return window.__shortcutHudDelayMs;
    }
    return DEFAULT_DELAY_MS;
}

// messages（i18n）を webview から取得。md editor は __I18N__ を editor.js が持つが、
// shared JS からは window 経由で取れる値を使う。未注入なら {}（英語 fallback）。
function _resolveMessages() {
    if (typeof window === 'undefined') { return {}; }
    return window.__outlinerMessages || window.__shortcutHudMessages || {};
}

// HUD の DOM を構築（category 別カラム）。mode = 'md' | 'outliner'。
function _buildHudEl(doc, mode) {
    var SL = (typeof window !== 'undefined' && window.ShortcutList) ? window.ShortcutList : null;
    var isMac = false;
    if (typeof navigator !== 'undefined' && navigator.platform) {
        isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    } else if (typeof navigator !== 'undefined' && navigator.userAgent) {
        isMac = /Mac/i.test(navigator.userAgent);
    }
    var messages = _resolveMessages();

    var overlay = doc.createElement('div');
    overlay.id = HUD_ID;
    overlay.className = 'fractal-shortcut-hud';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Keyboard shortcuts');

    var panel = doc.createElement('div');
    panel.className = 'fractal-shortcut-hud-panel';
    overlay.appendChild(panel);

    var grid = doc.createElement('div');
    grid.className = 'fractal-shortcut-hud-grid';
    panel.appendChild(grid);

    var list = SL ? SL.getList(mode) : [];
    var i, j;
    for (i = 0; i < list.length; i++) {
        var cat = list[i];
        if (!cat.items || !cat.items.length) { continue; }
        var col = doc.createElement('div');
        col.className = 'fractal-shortcut-hud-cat';

        var h = doc.createElement('div');
        h.className = 'fractal-shortcut-hud-cat-title';
        h.textContent = SL ? SL.categoryLabel(cat.category, messages) : cat.category;
        col.appendChild(h);

        for (j = 0; j < cat.items.length; j++) {
            var item = cat.items[j];
            var row = doc.createElement('div');
            row.className = 'fractal-shortcut-hud-row';

            var keysEl = doc.createElement('span');
            keysEl.className = 'fractal-shortcut-hud-keys';
            keysEl.textContent = SL ? SL.formatKeys(item.keys, isMac) : item.keys;
            row.appendChild(keysEl);

            var descEl = doc.createElement('span');
            descEl.className = 'fractal-shortcut-hud-desc';
            descEl.textContent = item.desc;
            row.appendChild(descEl);

            col.appendChild(row);
        }
        grid.appendChild(col);
    }
    return overlay;
}

// ShortcutHud.init(document, mode)。二重 init ガード（notes は editor.js + outliner.js 両ロード）。
function init(doc, mode) {
    if (typeof window !== 'undefined') {
        if (window.__shortcutHudInitialized) { return; }
        window.__shortcutHudInitialized = true;
    }
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) { return; }

    var timer = null;       // 長押しタイマー
    var hudEl = null;       // 表示中の HUD 要素（null = 非表示）
    var composing = false;  // IME composition 中フラグ

    function clearTimer() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    }

    function showHud() {
        if (hudEl) { return; }
        hudEl = _buildHudEl(doc, mode);
        (doc.body || doc.documentElement).appendChild(hudEl);
    }

    function hideHud() {
        clearTimer();
        if (hudEl) {
            if (hudEl.parentNode) { hudEl.parentNode.removeChild(hudEl); }
            hudEl = null;
        }
    }

    function onKeyDown(e) {
        // トリガーキー単独押下 → タイマー開始。
        if (_isTriggerKey(e.key)) {
            if (composing) { return; }
            if (!_isSoleModifier(e)) { return; }
            if (hudEl || timer !== null) { return; } // 既に表示中 or 計測中は多重発火しない
            timer = setTimeout(function () {
                timer = null;
                if (!composing) { showHud(); }
            }, _getDelayMs());
            return;
        }
        // トリガー以外のキーが押された（cmd+C 等）→ タイマーキャンセル & 表示中なら即消す。
        hideHud();
    }

    function onKeyUp(e) {
        // トリガーキーを離した → HUD 消去 + タイマーキャンセル。
        if (_isTriggerKey(e.key)) {
            hideHud();
        }
    }

    // keydown/keyup は capture phase で拾い、他リスナーの stopPropagation に負けないようにする。
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);

    // cmd+tab 等でアプリ切替すると keyup が来ない → blur / visibilitychange でクリア（one-shot の対クリア契機）。
    if (typeof window !== 'undefined') {
        window.addEventListener('blur', hideHud);
    }
    doc.addEventListener('visibilitychange', function () {
        if (doc.hidden) { hideHud(); }
    });

    // IME composition 中は HUD を出さない。
    doc.addEventListener('compositionstart', function () { composing = true; clearTimer(); });
    doc.addEventListener('compositionend', function () { composing = false; });

    // テスト/デバッグ用フック（standalone spec が状態を確認できるように）。
    if (typeof window !== 'undefined') {
        window.__shortcutHud = {
            show: showHud,
            hide: hideHud,
            isVisible: function () { return !!hudEl; },
        };
    }
}

var _api = {
    init: init,
    HUD_ID: HUD_ID,
    DEFAULT_DELAY_MS: DEFAULT_DELAY_MS,
    // pure helper（テスト用に露出）
    _isSoleModifier: _isSoleModifier,
    _isTriggerKey: _isTriggerKey,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.ShortcutHud = _api;
}
