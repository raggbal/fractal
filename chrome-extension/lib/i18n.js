/** Fractal Web Clipper — 軽量 i18n (sprint 20260727-065214 / ADRL-0001)。
 *  - デフォルト英語。言語は chrome.storage.local の 'language' キー ('en' | 'ja')。
 *  - chrome.i18n (_locales) は不採用: ブラウザ UI 言語固定でランタイム切替不可のため。
 *  - 辞書は lib/i18n-messages.js (global.FractalI18nMessages)。en → キー名 の 2 段フォールバック。
 *  - {name} 形式のプレースホルダ置換。
 *  - page (popup/options) は applyDom() で data-i18n 属性を一括適用。SW (background) は t() のみ使う。
 */
(function(global) {
    'use strict';

    var _lang = 'en';

    /** 言語を設定 ('ja' 以外はすべて 'en' に正規化 = デフォルト英語) */
    function init(lang) {
        _lang = (lang === 'ja') ? 'ja' : 'en';
    }

    function getLang() { return _lang; }

    /** key → 現在言語の文字列。無ければ en → キー名 (silent 空文字は返さない)。
     *  params: { name: 'x' } → 文字列中の {name} を置換。未定義 param はプレースホルダ残置。 */
    function t(key, params) {
        var dict = global.FractalI18nMessages || {};
        var msg = dict[_lang] && dict[_lang][key];
        if (msg == null) { msg = dict.en && dict.en[key]; }
        if (msg == null) { return key; }
        if (params) {
            msg = msg.replace(/\{(\w+)\}/g, function(m, p) {
                return (params[p] !== undefined) ? String(params[p]) : m;
            });
        }
        return msg;
    }

    /** data-i18n 系属性を持つ要素に一括適用 (page コンテキスト専用):
     *  - [data-i18n]             → textContent
     *  - [data-i18n-placeholder] → placeholder 属性
     *  - [data-i18n-title]      → title 属性
     *  <html lang> も現在言語に更新。 */
    function applyDom(doc) {
        doc = doc || (typeof document !== 'undefined' ? document : null);
        if (!doc) { return; }
        var els = doc.querySelectorAll('[data-i18n]');
        for (var i = 0; i < els.length; i++) {
            els[i].textContent = t(els[i].getAttribute('data-i18n'));
        }
        var phs = doc.querySelectorAll('[data-i18n-placeholder]');
        for (var j = 0; j < phs.length; j++) {
            phs[j].setAttribute('placeholder', t(phs[j].getAttribute('data-i18n-placeholder')));
        }
        var tls = doc.querySelectorAll('[data-i18n-title]');
        for (var k = 0; k < tls.length; k++) {
            tls[k].setAttribute('title', t(tls[k].getAttribute('data-i18n-title')));
        }
        if (doc.documentElement) { doc.documentElement.lang = _lang; }
    }

    global.FractalI18n = { init: init, t: t, getLang: getLang, applyDom: applyDom };

    // node（unit テスト）から require できるように
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.FractalI18n;
    }
})(typeof self !== 'undefined' ? self : globalThis);
