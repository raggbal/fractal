'use strict';

/**
 * inline-color-picker.js — インライン文字色の共通 swatch ピッカー（sprint 20260724-160000）
 *
 * md editor（toolbar / command palette）と outliner（右クリックメニュー）で共用する
 * 20色 swatch + None のポップオーバー。NOTES_COLOR_PALETTE の hex を使い、onPick に **hex**
 * （None は null）を渡す。file/folder アイコンの色ピッカー（notes-file-panel.js）は color **name**
 * を返すが、本機能は hex 直値を保存するため別関数として持つ（FR-IC-05）。
 *
 * showInlineColorPicker({ x, y, onPick }) → document.body に .inline-color-popover を出す。
 * onPick(hex|null) を呼んだら閉じる。外側クリック / Esc でも閉じる（キャンセル）。
 */

function _getPalette() {
    if (typeof NOTES_COLOR_PALETTE !== 'undefined') { return NOTES_COLOR_PALETTE; }
    if (typeof window !== 'undefined' && window.NOTES_COLOR_PALETTE) { return window.NOTES_COLOR_PALETTE; }
    return [];
}

var _openPopover = null;

function closeInlineColorPicker() {
    if (_openPopover) {
        if (_openPopover._cleanup) { _openPopover._cleanup(); }
        if (_openPopover.parentNode) { _openPopover.parentNode.removeChild(_openPopover); }
        _openPopover = null;
    }
}

function showInlineColorPicker(opts) {
    opts = opts || {};
    var onPick = typeof opts.onPick === 'function' ? opts.onPick : function () {};
    closeInlineColorPicker();

    var pop = document.createElement('div');
    pop.className = 'inline-color-popover file-panel-context-menu';
    pop.style.position = 'fixed';
    pop.style.zIndex = '99999';
    if (typeof opts.x === 'number') { pop.style.left = opts.x + 'px'; }
    if (typeof opts.y === 'number') { pop.style.top = opts.y + 'px'; }

    var grid = document.createElement('div');
    grid.className = 'file-panel-color-grid';
    _getPalette().forEach(function (c) {
        var sw = document.createElement('div');
        sw.className = 'file-panel-color-swatch';
        sw.style.backgroundColor = c.hex;
        sw.dataset.hex = c.hex;
        sw.title = c.name;
        sw.addEventListener('click', function (e) {
            e.stopPropagation();
            var hex = c.hex;
            closeInlineColorPicker();
            onPick(hex);
        });
        grid.appendChild(sw);
    });
    pop.appendChild(grid);

    var noneBtn = document.createElement('div');
    noneBtn.className = 'file-panel-color-none';
    noneBtn.textContent = (typeof opts.noneLabel === 'string') ? opts.noneLabel : 'None';
    noneBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeInlineColorPicker();
        onPick(null);
    });
    pop.appendChild(noneBtn);

    document.body.appendChild(pop);
    _openPopover = pop;

    // 外側クリック / Esc で閉じる（次 tick で登録して自身の click を拾わない）
    var outside = function (e) {
        if (_openPopover && !_openPopover.contains(e.target)) { closeInlineColorPicker(); }
    };
    var onKey = function (e) {
        if (e.key === 'Escape') { closeInlineColorPicker(); }
    };
    setTimeout(function () {
        document.addEventListener('mousedown', outside, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    pop._cleanup = function () {
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', onKey, true);
    };

    // viewport はみ出し補正（右/下端）
    var rect = pop.getBoundingClientRect();
    if (typeof opts.x === 'number' && rect.right > window.innerWidth) {
        pop.style.left = Math.max(0, window.innerWidth - rect.width - 4) + 'px';
    }
    if (typeof opts.y === 'number' && rect.bottom > window.innerHeight) {
        pop.style.top = Math.max(0, window.innerHeight - rect.height - 4) + 'px';
    }
    return pop;
}

var _pickerApi = {
    showInlineColorPicker: showInlineColorPicker,
    closeInlineColorPicker: closeInlineColorPicker,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = _pickerApi;
}
if (typeof window !== 'undefined') {
    window.showInlineColorPicker = showInlineColorPicker;
    window.closeInlineColorPicker = closeInlineColorPicker;
}
