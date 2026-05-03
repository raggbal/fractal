/**
 * Outliner Table Editor — i18n 7-language support (TASK-B9)
 *
 * design: design/system.md §10
 * testcases:
 *   - TC-1401: each of the 13 i18n keys is non-empty across 7 locales
 *   - TC-1402: UI strings switch when window.__outlinerMessages is replaced
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const KEYS = [
    'outlinerSwitchToTable',
    'outlinerSwitchToOutliner',
    'tableAddColumn',
    'tableRemoveColumn',
    'tableConfirmRemoveColumn',
    'tableSearchOrCreate',
    'tableCreateOption',
    'tableColumnNameLabel',
    'tableColumnTypeLabel',
    'tableColumnTypeText',
    'tableColumnTypeMultiselect',
    'tableColumnTypeOutliner',
    'tableSearchPlaceholder'
];

const LOCALES = ['en', 'ja', 'zh-cn', 'zh-tw', 'ko', 'es', 'fr'];

// ---------------------------------------------------------------------------
// TC-1401: every key is defined and non-empty in every locale .ts
// We grep the locale source files (they are simple TS object literals) rather
// than dynamically importing them — Playwright's TS hooks aren't guaranteed
// to handle arbitrary .ts files outside spec discovery, and grepping makes
// the assertion robust to module-system changes.
// ---------------------------------------------------------------------------
test('TC-1401 — all 13 i18n keys are defined for all 7 locales', () => {
    for (const loc of LOCALES) {
        const filePath = path.join(__dirname, '..', '..', 'src', 'i18n', 'locales', `${loc}.ts`);
        const source = fs.readFileSync(filePath, 'utf8');
        for (const key of KEYS) {
            // Look for a non-empty value following `<key>:`. Allow nested
            // quotes ({name} placeholders are commonly wrapped in quotes
            // inside translated strings, e.g. ko: '"{name}" 열을 삭제').
            // We match the property line and require at least one
            // non-whitespace, non-comma char before line end.
            const re = new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^\\n]+?)\\1\\s*,`, 'm');
            const m = source.match(re);
            expect(m, `${loc}.${key} should be defined`).toBeTruthy();
            expect((m && m[2] || '').trim().length,
                `${loc}.${key} should be a non-empty string literal`).toBeGreaterThan(0);
        }
    }
});

// ---------------------------------------------------------------------------
// TC-1402: UI strings reflect window.__outlinerMessages
// ---------------------------------------------------------------------------
async function setupTableWithLocale(page: Page, locale: 'en' | 'ja' | 'es'): Promise<void> {
    await page.goto('/standalone-outliner-table.html');
    await page.waitForFunction(() => (window as any).__testApi);
    // overwrite messages BEFORE init so ensureHeaderUi picks them up
    const messageBundle: Record<'en' | 'ja' | 'es', Record<string, string>> = {
        en: {
            outlinerSwitchToOutliner: 'Switch to Outliner view',
            tableSearchPlaceholder: 'Search...',
            tableAddColumn: 'Add column'
        },
        ja: {
            outlinerSwitchToOutliner: 'アウトライン表示に切替',
            tableSearchPlaceholder: '検索...',
            tableAddColumn: '列を追加'
        },
        es: {
            outlinerSwitchToOutliner: 'Cambiar a vista de esquema',
            tableSearchPlaceholder: 'Buscar...',
            tableAddColumn: 'Añadir columna'
        }
    };
    const bundle = messageBundle[locale];
    await page.evaluate((b) => { (window as any).__outlinerMessages = b; }, bundle);
    await page.evaluate(() => {
        (window as any).__testApi.initOutlinerTable({
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [] } }
        });
    });
    await page.waitForTimeout(50);
}

test('TC-1402 — Switch button title and search placeholder reflect locale (en/ja/es)', async ({ page }) => {
    // EN
    await setupTableWithLocale(page, 'en');
    let title = await page.evaluate(() => {
        const b = document.querySelector('.otable-switch-view') as HTMLElement | null;
        return b ? b.title : null;
    });
    expect(title).toBe('Switch to Outliner view');
    let placeholder = await page.evaluate(() => {
        const i = document.querySelector('.otable-search-input') as HTMLInputElement | null;
        return i ? i.placeholder : null;
    });
    expect(placeholder).toBe('Search...');

    // JA
    await setupTableWithLocale(page, 'ja');
    title = await page.evaluate(() => {
        const b = document.querySelector('.otable-switch-view') as HTMLElement | null;
        return b ? b.title : null;
    });
    expect(title).toBe('アウトライン表示に切替');
    placeholder = await page.evaluate(() => {
        const i = document.querySelector('.otable-search-input') as HTMLInputElement | null;
        return i ? i.placeholder : null;
    });
    expect(placeholder).toBe('検索...');

    // ES
    await setupTableWithLocale(page, 'es');
    title = await page.evaluate(() => {
        const b = document.querySelector('.otable-switch-view') as HTMLElement | null;
        return b ? b.title : null;
    });
    expect(title).toBe('Cambiar a vista de esquema');
});
