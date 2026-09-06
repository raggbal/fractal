// shortcut-hud.js — FR-B06b: ショートカット一覧 HUD。トリガーは **Cmd+Shift+/（Win: Ctrl+Shift+/）の表示トグル**
// （2026-09-04 ユーザー裁定。旧: cmd 単独長押し 800ms — cmd+click 複数選択と干渉するため廃止）。
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
// テスト seam: window.__shortcutHudDelayMs は旧長押し方式の遺物（現在は未使用・互換のため残置）。
//
// UMD: CommonJS + window.ShortcutHud。

'use strict';

var DEFAULT_DELAY_MS = 800;
var HUD_ID = 'fractal-shortcut-hud';

// FR-KH-01 (sprint 20260810-183054): Kiro 判定 seam。
// shared のこのファイルに置く理由: 3 面すべてで editor.js/outliner.js より前に注入されるため、
// editor.js 非ロードの outliner 面でも HUD の Kiro 分岐が単独で動く（editor.js に置くと届かない）。
// editor.js の Kiro paste 分岐は window.isKiroEnv() で消費する。
// テスト注入: window.__kiroEnvOverride (boolean) が最優先。
function isKiroEnv() {
    if (typeof window !== 'undefined' && typeof window.__kiroEnvOverride === 'boolean') {
        return window.__kiroEnvOverride;
    }
    return typeof navigator !== 'undefined' && !!navigator.userAgent && navigator.userAgent.includes('Kiro');
}

// FR-KH-01 検証 seam: window.__hudDebug = true で key/blur イベントを console 出力
//（Kiro 実機での keydown ログ採取用。既定 OFF・恒久 seam）。
function _hudDebugLog(kind, e) {
    if (typeof window === 'undefined' || window.__hudDebug !== true) { return; }
    try {
        if (e && typeof e.key !== 'undefined') {
            console.log('[hud-debug] ' + kind
                + ' key=' + e.key
                + ' metaKey=' + e.metaKey + ' ctrlKey=' + e.ctrlKey
                + ' shiftKey=' + e.shiftKey + ' altKey=' + e.altKey
                + ' repeat=' + e.repeat
                + ' isTrusted=' + e.isTrusted);
        } else {
            console.log('[hud-debug] ' + kind);
        }
    } catch (err) { /* debug logging must never break input handling */ }
}

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

    // US-6b: どのモード用の一覧か明示するタイトル（Markdown / Outliner / Mindmap / Table）
    var titleEl = doc.createElement('div');
    titleEl.className = 'fractal-shortcut-hud-title';
    titleEl.textContent = SL ? SL.modeTitle(mode, messages) : mode;
    panel.appendChild(titleEl);

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
        // US-6b: mode は表示時に動的解決する。ホスト面（notes 等）が実表示状態
        //（sidepanel md open / md main pane / mindmap / table）を知っているので、
        // window.__shortcutHudModeResolver があればそれを優先（返り値が不正なら init 時の mode）。
        var effectiveMode = mode;
        if (typeof window !== 'undefined' && typeof window.__shortcutHudModeResolver === 'function') {
            try {
                var resolved = window.__shortcutHudModeResolver();
                if (resolved === 'md' || resolved === 'outliner' || resolved === 'mindmap' || resolved === 'table') {
                    effectiveMode = resolved;
                }
            } catch (err) { /* resolver 失敗時は init 時の mode */ }
        }
        hudEl = _buildHudEl(doc, effectiveMode);
        (doc.body || doc.documentElement).appendChild(hudEl);
    }

    function hideHud() {
        clearTimer();
        if (hudEl) {
            if (hudEl.parentNode) { hudEl.parentNode.removeChild(hudEl); }
            hudEl = null;
        }
    }

    // 2026-09-04（ユーザー裁定）: トリガーを **Cmd+Shift+/（= Cmd+?。Win: Ctrl+Shift+/）の表示トグル**に変更。
    // 旧「cmd 単独長押し 800ms」は、cmd+click で複数選択（note tree / outliner / linkedfd）する間に cmd を押し続けると
    // HUD が出てしまうため廃止。`Cmd+/` は md editor のアクションパレットが使用中なので Shift 付きにする。
    // 消し方: もう一度同キー / Esc / 他のキー / どこかを click / window blur。
    function _isHudToggleCombo(e) {
        if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) { return false; }
        return e.key === '?' || e.key === '/' || e.code === 'Slash';
    }
    function _isPureModifierKey(key) {
        return key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt';
    }

    function onKeyDown(e) {
        _hudDebugLog('keydown', e);
        if (_isHudToggleCombo(e)) {
            if (composing) { return; }
            e.preventDefault();
            e.stopPropagation();
            if (hudEl) { hideHud(); } else { showHud(); }
            return;
        }
        // 表示中に修飾キー以外のキー（Esc・文字・cmd+C 等）が押されたら閉じる。修飾キー単独の押下では閉じない
        //（Shift を先に押してから / を押す操作で消えないように）。
        if (hudEl && !_isPureModifierKey(e.key)) { hideHud(); }
    }

    function onKeyUp(e) {
        _hudDebugLog('keyup', e);
        // 旧長押し方式の keyup 消去は廃止（トグル方式ではキーを離しても表示を保つ）
    }

    // どこかを click したら閉じる（capture。HUD 自体の click も閉じる = 明示的な dismiss）
    doc.addEventListener('mousedown', function () { if (hudEl) { hideHud(); } }, true);

    // keydown/keyup は capture phase で拾い、他リスナーの stopPropagation に負けないようにする。
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);

    // cmd+tab 等でアプリ切替すると keyup が来ない → blur / visibilitychange でクリア（one-shot の対クリア契機）。
    if (typeof window !== 'undefined') {
        window.addEventListener('blur', function () { _hudDebugLog('blur'); hideHud(); });
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
    isKiroEnv: isKiroEnv,
    // pure helper（テスト用に露出）
    _isSoleModifier: _isSoleModifier,   // 旧長押し方式の遺物（互換のため残置・未使用）
    _isTriggerKey: _isTriggerKey,       // 同上
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.ShortcutHud = _api;
    window.isKiroEnv = isKiroEnv;
}
