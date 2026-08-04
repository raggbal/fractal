// shortcut-list.js — FR-B06b: cmd 長押しショートカット HUD の静的コンテンツ。
//
// README.md「⌨️ Key shortcuts」章 + 実コードのキーバインドを典拠に、
// md editor 用 / outliner 用の 2 リストを静的に定数化する（動的収集しない）。
// 一覧本文は英語ベース（NFR-B03: 本文の 7 locale 化はスコープ外）。カテゴリ見出しのみ i18n。
//
// キー表記は 'Cmd+B' 形式で保存し、HUD 表示時に formatKeys(keys, isMac) で mac/win の
// Cmd/Ctrl・Opt/Alt を出し分ける。
//
// UMD: CommonJS + window.ShortcutList（inline-color.js 末尾と同型）。

'use strict';

// カテゴリ描画順 + i18n キー + 英語 fallback（i18n 未注入の standalone では英語）。
var CATEGORIES = [
    { key: 'editing',    i18nKey: 'shortcutCatEditing',    fallback: 'Editing' },
    { key: 'navigation', i18nKey: 'shortcutCatNavigation', fallback: 'Navigation' },
    { key: 'search',     i18nKey: 'shortcutCatSearch',     fallback: 'Search' },
    { key: 'task',       i18nKey: 'shortcutCatTask',       fallback: 'Tasks' },
    { key: 'other',      i18nKey: 'shortcutCatOther',      fallback: 'Other' },
];

// md editor 用（standalone md / notes md / sidepanel md 共通）。
var SHORTCUTS_MD = [
    { category: 'editing', items: [
        { keys: 'Cmd+B', desc: 'Bold' },
        { keys: 'Cmd+I', desc: 'Italic' },
        { keys: 'Cmd+Shift+S', desc: 'Strikethrough' },
        { keys: 'Cmd+`', desc: 'Inline code' },
        { keys: 'Cmd+K', desc: 'Insert link' },
        { keys: 'Cmd+1…6', desc: 'Heading 1–6' },
        { keys: 'Cmd+0', desc: 'Paragraph' },
        { keys: 'Cmd+Shift+U', desc: 'Bullet list' },
        { keys: 'Cmd+Shift+O', desc: 'Numbered list' },
        { keys: 'Cmd+Shift+Q', desc: 'Quote' },
        { keys: 'Cmd+Shift+K', desc: 'Code block' },
        { keys: 'Cmd+T', desc: 'Insert table' },
        { keys: 'Cmd+Shift+I', desc: 'Insert image' },
        { keys: 'Cmd+Shift+-', desc: 'Horizontal rule' },
    ] },
    { category: 'navigation', items: [
        { keys: 'Cmd+N', desc: 'Add page (subpage + link)' },
        { keys: 'Cmd+.', desc: 'Toggle source mode' },
        { keys: 'Cmd+Shift+.', desc: 'Open in VS Code text editor' },
        { keys: 'Cmd+\\', desc: 'Toggle sidebar' },
        { keys: 'Tab / Shift+Tab', desc: 'Indent / outdent (lists); move cell (tables)' },
        { keys: 'Opt+← / Opt+→', desc: 'Side-panel back / forward' },
    ] },
    { category: 'search', items: [
        { keys: 'Cmd+F', desc: 'Find' },
        { keys: 'Cmd+H', desc: 'Replace' },
    ] },
    { category: 'task', items: [
        { keys: 'Cmd+Shift+X', desc: 'Task list / toggle checkbox' },
    ] },
    { category: 'other', items: [
        { keys: 'Cmd+/', desc: 'Action palette' },
        { keys: 'Cmd+L', desc: 'Send selection to AI chat' },
        { keys: 'Cmd+S', desc: 'Save' },
        { keys: 'Cmd+Z / Cmd+Shift+Z', desc: 'Undo / redo' },
    ] },
];

// outliner 用（standalone outliner / notes outliner 共通）。
var SHORTCUTS_OUTLINER = [
    { category: 'editing', items: [
        { keys: 'Cmd+B', desc: 'Bold' },
        { keys: 'Cmd+I', desc: 'Italic' },
        { keys: 'Cmd+E', desc: 'Inline code' },
        { keys: 'Cmd+Shift+S', desc: 'Strikethrough' },
        { keys: 'Enter', desc: 'New sibling node' },
        { keys: 'Option+Enter', desc: 'New child node' },
        { keys: 'Shift+Enter', desc: 'Open subtext (note)' },
        { keys: 'Tab / Shift+Tab', desc: 'Indent / outdent (multi-select)' },
        { keys: 'Cmd+Shift+↑/↓', desc: 'Move node up / down' },
        { keys: 'Backspace', desc: 'At line start: merge with previous / delete empty' },
        { keys: 'Cmd+C / Cmd+X / Cmd+V', desc: 'Copy / cut / paste nodes' },
        { keys: 'Cmd+N', desc: 'New node at the end' },
    ] },
    { category: 'navigation', items: [
        { keys: 'Cmd+Enter', desc: 'Open the page (creates if missing)' },
        { keys: '↑ / ↓', desc: 'Move between nodes' },
        { keys: 'Shift+↑/↓', desc: 'Extend multi-selection' },
        { keys: '← / →', desc: 'Collapse / expand (at line start / end)' },
        { keys: 'Cmd+.', desc: 'Toggle collapse for the node' },
        { keys: 'Cmd+]', desc: 'Scope in (zoom)' },
        { keys: 'Cmd+Shift+]', desc: 'Scope out' },
        { keys: 'Opt+← / Opt+→', desc: 'Navigation history back / forward' },
        { keys: 'Cmd+A', desc: 'Select all nodes' },
    ] },
    { category: 'search', items: [
        { keys: 'Cmd+F', desc: 'Text search' },
        { keys: 'Cmd+H', desc: 'Replace' },
        { keys: 'Cmd+Shift+F', desc: 'Filter' },
    ] },
    { category: 'task', items: [
        { keys: 'Cmd+Shift+X', desc: 'Toggle checkbox' },
        { keys: 'Cmd+Shift+Opt+X', desc: 'Remove checkbox' },
    ] },
    { category: 'other', items: [
        { keys: 'Cmd+Z / Cmd+Shift+Z', desc: 'Undo / redo' },
    ] },
];

// 'Cmd+Shift+B' 等の表記を mac/win 用に出し分ける。
// mac: そのまま（Cmd / Opt / Shift）。win/linux: Cmd→Ctrl, Opt→Alt, Option→Alt。
function formatKeys(keys, isMac) {
    if (typeof keys !== 'string') { return ''; }
    if (isMac) { return keys; }
    return keys
        .replace(/Cmd/g, 'Ctrl')
        .replace(/Option/g, 'Alt')
        .replace(/Opt/g, 'Alt');
}

// mode ('md' | 'outliner') に対応する静的リストを返す。
function getList(mode) {
    return mode === 'outliner' ? SHORTCUTS_OUTLINER : SHORTCUTS_MD;
}

// category key ('editing' 等) の見出しラベルを messages（i18n）から解決。
// 未注入 / キー欠落なら英語 fallback。
function categoryLabel(categoryKey, messages) {
    var i;
    for (i = 0; i < CATEGORIES.length; i++) {
        if (CATEGORIES[i].key === categoryKey) {
            var m = messages && messages[CATEGORIES[i].i18nKey];
            return (typeof m === 'string' && m) ? m : CATEGORIES[i].fallback;
        }
    }
    return categoryKey;
}

var _api = {
    CATEGORIES: CATEGORIES,
    SHORTCUTS_MD: SHORTCUTS_MD,
    SHORTCUTS_OUTLINER: SHORTCUTS_OUTLINER,
    formatKeys: formatKeys,
    getList: getList,
    categoryLabel: categoryLabel,
};

// CommonJS + global 両対応（webview では window.ShortcutList として使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.ShortcutList = _api;
}
