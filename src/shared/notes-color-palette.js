'use strict';

/**
 * Notes ツリーアイテム用 固定 20 色パレット（Tailwind 500 レベル）
 * Notes 左パネルの file/folder アイコン stroke 着色に使用
 *
 * 参照元:
 *   - notes-file-panel.js: パレット UI 描画 + 色→CSS class マッピング
 *   - notes-body-html.js: CSS 生成（stroke 色 + opacity）
 *
 * 色名は英語のみ（i18n 対象外、tooltip として表示）
 *
 * 注意: この配列の順序と hex 値は変更禁止 — 既存 outline.note に保存された
 *       色名が不整合を起こす
 */

var NOTES_COLOR_PALETTE = [
    { name: 'red',      hex: '#ef4444' },
    { name: 'orange',   hex: '#f97316' },
    { name: 'amber',    hex: '#f59e0b' },
    { name: 'yellow',   hex: '#eab308' },
    { name: 'lime',     hex: '#84cc16' },
    { name: 'green',    hex: '#22c55e' },
    { name: 'emerald',  hex: '#10b981' },
    { name: 'teal',     hex: '#14b8a6' },
    { name: 'cyan',     hex: '#06b6d4' },
    { name: 'sky',      hex: '#0ea5e9' },
    { name: 'blue',     hex: '#3b82f6' },
    { name: 'indigo',   hex: '#6366f1' },
    { name: 'violet',   hex: '#8b5cf6' },
    { name: 'purple',   hex: '#a855f7' },
    { name: 'fuchsia',  hex: '#d946ef' },
    { name: 'pink',     hex: '#ec4899' },
    { name: 'rose',     hex: '#f43f5e' },
    { name: 'slate',    hex: '#64748b' },
    { name: 'gray',     hex: '#6b7280' },
    { name: 'zinc',     hex: '#71717a' },
];

// CommonJS + global 両対応（webview では window.NOTES_COLOR_PALETTE として使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { NOTES_COLOR_PALETTE: NOTES_COLOR_PALETTE };
}
if (typeof window !== 'undefined') {
    window.NOTES_COLOR_PALETTE = NOTES_COLOR_PALETTE;
}
