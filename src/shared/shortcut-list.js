// shortcut-list.js — FR-B06b: ショートカット HUD（Cmd+Shift+/ トグル）の静的コンテンツ。
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

// HUD タイトル（US-6b: どのモード用の一覧か明示）。i18n キー + 英語 fallback。
var MODE_TITLES = {
    md:       { i18nKey: 'shortcutHudTitleMd',      fallback: 'Markdown Shortcuts' },
    outliner: { i18nKey: 'shortcutHudTitleOutliner', fallback: 'Outliner Shortcuts' },
    mindmap:  { i18nKey: 'shortcutHudTitleMindmap',  fallback: 'Mindmap Shortcuts' },
    table:    { i18nKey: 'shortcutHudTitleTable',    fallback: 'Database (Table) Shortcuts' },
};

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
        { keys: 'Shift+Enter', desc: 'Lists: line break within the item' },
        { keys: 'Tab / Shift+Tab', desc: 'Indent / outdent (lists); move cell (tables)' },
        { keys: '↑↓←→', desc: 'Tables: move between cells (select mode)' },
        { keys: 'Shift+↑↓←→ / Shift+Click', desc: 'Tables: extend range selection' },
        { keys: 'Enter / F2 / type', desc: 'Tables: edit cell (typing replaces)' },
        { keys: 'Esc', desc: 'Tables: discard edit / leave select mode' },
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
        { keys: 'Cmd+Shift+/', desc: 'Show / hide this shortcut list' },
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
        { keys: 'Shift+Enter', desc: 'Line break within node text' },
        { keys: 'Cmd+Shift+Enter', desc: 'Open / close subtext (note)' },
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
        { keys: 'Cmd+Shift+/', desc: 'Show / hide this shortcut list' },
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

// mindmap ビュー用（README「Mindmap mode」章より）。
var SHORTCUTS_MINDMAP = [
    { category: 'editing', items: [
        { keys: 'Enter / Shift+Enter', desc: 'Add younger / elder sibling' },
        { keys: 'Tab', desc: 'Add child node' },
        { keys: 'Space / F2 / type', desc: 'Start editing (typing appends)' },
        { keys: 'Enter / Tab / Esc', desc: 'Commit edit' },
        { keys: 'Delete / Backspace', desc: 'Delete node (or group)' },
        { keys: 'Option+↑/↓', desc: 'Swap with sibling' },
        { keys: 'Cmd+C / Cmd+X / Cmd+V', desc: 'Copy / cut node with descendants / paste as children' },
        { keys: 'Cmd+V', desc: 'Paste image onto node' },
        { keys: 'Click image + Delete', desc: 'Select attached image and remove it' },
    ] },
    { category: 'navigation', items: [
        { keys: '↑↓←→', desc: 'Move between nodes (spatial)' },
        { keys: 'Cmd+Shift+L', desc: 'Cycle layout (radial → right → left → balanced)' },
        { keys: 'Cmd+Enter', desc: 'Open / create the page' },
        { keys: 'Cmd+Wheel', desc: 'Zoom (toolbar +/−/Fit too)' },
        { keys: 'Drag', desc: 'Blank: pan / node: reparent (top=elder, bottom=younger, middle=child)' },
    ] },
    { category: 'task', items: [
        { keys: 'Cmd+Shift+X', desc: 'Add / toggle checkbox' },
        { keys: 'Cmd+Shift+Option+X', desc: 'Remove checkbox' },
    ] },
    { category: 'other', items: [
        { keys: 'Cmd+A / Cmd+Z', desc: 'Select all / undo' },
        { keys: 'Cmd+Shift+/', desc: 'Show / hide this shortcut list' },
        { keys: 'Right-click', desc: 'Color, shape, group, relation line, checkbox' },
    ] },
];

// database (table) ビュー用（README「Database view」章より。outliner 列は outliner と同じ）。
var SHORTCUTS_TABLE = [
    { category: 'editing', items: [
        { keys: 'Cmd+B / Cmd+I / Cmd+E', desc: 'Inline format in text columns' },
        { keys: 'Enter / Space', desc: 'Open tag dropdown / date picker' },
        { keys: '↑↓ + Enter', desc: 'Choose in dropdown' },
    ] },
    { category: 'navigation', items: [
        { keys: 'Cmd+←/→/↑/↓', desc: 'Move between cells (all columns)' },
        { keys: 'Tab / Shift+Tab', desc: 'Next / previous cell (text columns)' },
    ] },
    { category: 'other', items: [
        { keys: '(Outliner column)', desc: 'All outliner shortcuts work as-is' },
        { keys: 'Cmd+Shift+/', desc: 'Show / hide this shortcut list' },
    ] },
];

// mode ('md' | 'outliner' | 'mindmap' | 'table') に対応する静的リストを返す。
function getList(mode) {
    if (mode === 'outliner') { return SHORTCUTS_OUTLINER; }
    if (mode === 'mindmap') { return SHORTCUTS_MINDMAP; }
    if (mode === 'table') { return SHORTCUTS_TABLE; }
    return SHORTCUTS_MD;
}

// mode の HUD タイトルを messages（i18n）から解決。未注入なら英語 fallback。
function modeTitle(mode, messages) {
    var t = MODE_TITLES[mode] || MODE_TITLES.md;
    var m = messages && messages[t.i18nKey];
    return (typeof m === 'string' && m) ? m : t.fallback;
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
    MODE_TITLES: MODE_TITLES,
    SHORTCUTS_MD: SHORTCUTS_MD,
    SHORTCUTS_OUTLINER: SHORTCUTS_OUTLINER,
    SHORTCUTS_MINDMAP: SHORTCUTS_MINDMAP,
    SHORTCUTS_TABLE: SHORTCUTS_TABLE,
    formatKeys: formatKeys,
    getList: getList,
    categoryLabel: categoryLabel,
    modeTitle: modeTitle,
};

// CommonJS + global 両対応（webview では window.ShortcutList として使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.ShortcutList = _api;
}
