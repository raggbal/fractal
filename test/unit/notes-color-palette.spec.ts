/**
 * Notes Color Palette Unit Tests
 *
 * DOD-11-3-1: notes-color-palette.js が存在し NOTES_COLOR_PALETTE が 20 色の {name, hex} 配列として export されている
 * DOD-11-3-2: 20 色すべてに対応する CSS クラス `.notes-item-color-{name}` が notes-body-html.js の生成する HTML <style> に含まれる
 * DOD-11-2-2: .file-panel-folder-children の padding-left が 28px になっている
 */

import { test, expect } from '@playwright/test';
import * as assert from 'assert';

// Test palette module directly via Node.js require
test.describe('Notes Color Palette', () => {
    test('DOD-11-3-1: NOTES_COLOR_PALETTE は 20 色の {name, hex} 配列', async () => {
        // @ts-ignore - require JS module
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette');

        // 20 色が存在すること
        expect(NOTES_COLOR_PALETTE.length).toBe(20);

        // 各エントリが name と hex を持つこと
        for (const color of NOTES_COLOR_PALETTE) {
            expect(color).toHaveProperty('name');
            expect(color).toHaveProperty('hex');
            expect(typeof color.name).toBe('string');
            expect(color.hex).toMatch(/^#[0-9a-f]{6}$/i);
        }

        // Tailwind 500 の色名が正しいこと
        const expectedNames = [
            'red', 'orange', 'amber', 'yellow', 'lime',
            'green', 'emerald', 'teal', 'cyan', 'sky',
            'blue', 'indigo', 'violet', 'purple', 'fuchsia',
            'pink', 'rose', 'slate', 'gray', 'zinc'
        ];
        const actualNames = NOTES_COLOR_PALETTE.map((c: {name: string}) => c.name);
        expect(actualNames).toEqual(expectedNames);

        // design.md §3.2 の hex 値と一致すること
        const expectedHexes: Record<string, string> = {
            red: '#ef4444',
            orange: '#f97316',
            amber: '#f59e0b',
            yellow: '#eab308',
            lime: '#84cc16',
            green: '#22c55e',
            emerald: '#10b981',
            teal: '#14b8a6',
            cyan: '#06b6d4',
            sky: '#0ea5e9',
            blue: '#3b82f6',
            indigo: '#6366f1',
            violet: '#8b5cf6',
            purple: '#a855f7',
            fuchsia: '#d946ef',
            pink: '#ec4899',
            rose: '#f43f5e',
            slate: '#64748b',
            gray: '#6b7280',
            zinc: '#71717a',
        };
        for (const color of NOTES_COLOR_PALETTE) {
            expect(color.hex.toLowerCase()).toBe(expectedHexes[color.name].toLowerCase());
        }
    });

    test('DOD-11-3-2: notes-body-html.js の CSS に 20 色分の .notes-item-color-{name} ルールが含まれる', async () => {
        // @ts-ignore
        const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html');
        // @ts-ignore
        const { NOTES_COLOR_PALETTE } = require('../../src/shared/notes-color-palette');

        const { css } = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

        // 20 色すべてのルールが存在すること
        for (const color of NOTES_COLOR_PALETTE) {
            const className = `.notes-item-color-${color.name}`;
            expect(css).toContain(className);

            // stroke 値が hex と一致すること
            const strokePattern = new RegExp(
                `\\.notes-item-color-${color.name}[^{]*\\{[^}]*stroke:\\s*${color.hex.replace('#', '#')}`,
                'i'
            );
            expect(css).toMatch(strokePattern);
        }
    });

    test('DOD-11-2-2: .file-panel-folder-children の padding-left が 28px', async () => {
        // @ts-ignore
        const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html');

        const { css } = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

        // padding-left: 28px を含むこと
        const paddingPattern = /\.file-panel-folder-children\s*\{[^}]*padding-left:\s*28px/;
        expect(css).toMatch(paddingPattern);
    });

    test('CSS にパレット swatch grid スタイルが含まれる', async () => {
        // @ts-ignore
        const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html');

        const { css } = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

        // パレット UI のスタイルが存在すること
        expect(css).toContain('.file-panel-color-grid');
        expect(css).toContain('.file-panel-color-swatch');
        expect(css).toContain('.file-panel-color-back');
        expect(css).toContain('.file-panel-color-none');
    });
});
