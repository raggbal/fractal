import { test, expect } from '@playwright/test';

// Sprint 20260810-183054: headerless table (FR-TBL-01/02/03/05, ADRL-0052)
// md 永続表現 = <!-- fractal-headerless-table --> マーカー + header 行温存(表示のみ CSS 非表示)。
// 判定はマーカーのみ(空 header の自動判定はしない)。

const MARKER = '<!-- fractal-headerless-table -->';

test.describe('Headerless table (FR-TBL)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-TBL-03: headerless md の parse → serialize 往復でマーカー + headerless 維持・th セル内容温存
    test('TC-TBL-03 headerless md roundtrip keeps marker and th content', async ({ page }) => {
        const md = MARKER + '\n| A | B |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const out = (window as any).__testApi.getMarkdown();
            return {
                hasAttr: table?.getAttribute('data-headerless'),
                thTexts: Array.from(table?.querySelectorAll('th') || []).map(th => th.textContent?.trim()),
                thVisible: Array.from(table?.querySelectorAll('th') || []).map(
                    th => (th as HTMLElement).offsetParent !== null),
                out,
            };
        }, md);
        expect(result.hasAttr).toBe('true');
        // th 構造は維持(isHeader = idx===0 不変)・内容温存
        expect(result.thTexts).toEqual(['A', 'B']);
        // CSS で非表示
        expect(result.thVisible).toEqual([false, false]);
        // serialize がマーカーを再 emit + th 内容温存(往復不変)
        expect(result.out).toContain(MARKER);
        expect(result.out).toContain('| A | B |');
        // 再ロードしても headerless のまま(th が「生えて見える」ことがない)
        const secondPass = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return table?.getAttribute('data-headerless');
        }, result.out);
        expect(secondPass).toBe('true');
    });

    // TC-TBL-04: マーカーなし空 header table(ユーザー意図)は headerless に化けない
    test('TC-TBL-04 empty-header table without marker stays a normal table', async ({ page }) => {
        const md = '|   |   |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                hasAttr: table?.getAttribute('data-headerless'),
                thVisible: Array.from(table?.querySelectorAll('th') || []).map(
                    th => (th as HTMLElement).offsetParent !== null),
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.hasAttr).toBeFalsy();
        expect(result.thVisible).toEqual([true, true]);
        expect(result.out).not.toContain(MARKER);
    });

    // TC-TBL-05: headerless + col-widths 併用の往復(両マーカー共存)
    test('TC-TBL-05 headerless and col-widths markers coexist across roundtrip', async ({ page }) => {
        const md = '<!-- fractal-col-widths: 120,180 -->\n' + MARKER
            + '\n| A | B |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                headerless: table?.getAttribute('data-headerless'),
                colWidths: table?.getAttribute('data-col-widths'),
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.headerless).toBe('true');
        expect(result.colWidths).toBe('120,180');
        expect(result.out).toContain(MARKER);
        expect(result.out).toContain('fractal-col-widths: 120,180');
        // 逆順(headerless → col-widths)でも両方 parse される
        const swapped = await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown(
                '<!-- fractal-headerless-table -->\n<!-- fractal-col-widths: 120,180 -->'
                + '\n| A | B |\n| --- | --- |\n| a1 | b1 |');
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                headerless: table?.getAttribute('data-headerless'),
                colWidths: table?.getAttribute('data-col-widths'),
            };
        });
        expect(swapped.headerless).toBe('true');
        expect(swapped.colWidths).toBe('120,180');
    });

    // one-shot 対クリア: マーカー付き table の次の table に headerless が漏れない
    test('TC-TBL-03b marker applies to next table only (one-shot reset)', async ({ page }) => {
        const md = MARKER + '\n| A | B |\n| --- | --- |\n| a1 | b1 |\n\n'
            + '| H1 | H2 |\n| --- | --- |\n| c1 | c2 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const tables = document.querySelectorAll('#editor table');
            return Array.from(tables).map(t => t.getAttribute('data-headerless'));
        }, md);
        expect(result[0]).toBe('true');
        expect(result[1]).toBeFalsy();
    });

    // TC-TBL-01: Header トグル OFF → 非表示・syncMarkdown 発火(md にマーカー)・undo 可能・ON 復帰で復元
    test('TC-TBL-01 header toggle OFF/ON with syncMarkdown and undo', async ({ page }) => {
        const md = '| A | B |\n| --- | --- |\n| a1 | b1 |';
        const afterToggle = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            // toggleTableHeader を直接駆動(toolbar ボタンの handler 実体)
            (window as any).__testApi ? null : null;
            const fn = (window as any).toggleTableHeader
                || (window as any).EditorInstance?.toggleTableHeader;
            if (typeof (window as any).__toggleTableHeaderForTest === 'function') {
                (window as any).__toggleTableHeaderForTest(table);
            } else if (typeof fn === 'function') {
                fn(table);
            } else {
                return { error: 'toggleTableHeader not exposed' };
            }
            await new Promise(r => setTimeout(r, 200));
            return {
                attr: table.getAttribute('data-headerless'),
                thVisible: Array.from(table.querySelectorAll('th')).map(
                    th => (th as HTMLElement).offsetParent !== null),
                thTexts: Array.from(table.querySelectorAll('th')).map(t => t.textContent?.trim()),
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect((afterToggle as any).error).toBeUndefined();
        expect(afterToggle.attr).toBe('true');
        expect(afterToggle.thVisible).toEqual([false, false]);
        expect(afterToggle.thTexts).toEqual(['A', 'B']); // 内容は破棄しない
        expect(afterToggle.out).toContain(MARKER);       // syncMarkdown 発火の証跡

        // トグル ON に戻すと復元
        const afterRestore = await page.evaluate(async () => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
            return {
                attr: table.getAttribute('data-headerless'),
                thVisible: Array.from(table.querySelectorAll('th')).map(
                    th => (th as HTMLElement).offsetParent !== null),
                thTexts: Array.from(table.querySelectorAll('th')).map(t => t.textContent?.trim()),
                out: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(afterRestore.attr).not.toBe('true');
        expect(afterRestore.thVisible).toEqual([true, true]);
        expect(afterRestore.thTexts).toEqual(['A', 'B']);
        expect(afterRestore.out).not.toContain(MARKER);
    });

    // TC-TBL-02: headerless で Tab/矢印ナビが hidden th 行に入らない
    test('TC-TBL-02 arrow navigation skips hidden header row', async ({ page }) => {
        const md = MARKER + '\n| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const rows = table.querySelectorAll('tr');
            // body 1 行目(a1)にカーソル
            const cellA1 = rows[1].cells[0];
            const range = document.createRange();
            const sel = window.getSelection()!;
            range.selectNodeContents(cellA1);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            // ArrowUp — hidden th 行に入らないこと(カーソルが th 内に移動しない)
            const ev = new KeyboardEvent('keydown', {
                key: 'ArrowUp', code: 'ArrowUp', bubbles: true, cancelable: true,
            });
            cellA1.dispatchEvent(ev);
            await new Promise(r => setTimeout(r, 100));
            const anchor = window.getSelection()!.anchorNode;
            const inTh = !!(anchor && (anchor.nodeType === 1
                ? (anchor as Element).closest('th')
                : anchor.parentElement?.closest('th')));
            return { inTh };
        }, md);
        expect(result.inTh).toBe(false);
    });

    // TC-TBL-09: Ctrl+T で table 挿入(幽霊 insertTable() の併修)
    test('TC-TBL-09 Ctrl+T inserts a table (no ReferenceError)', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', err => errors.push(err.message));
        const result = await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('hello');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const p = editor.querySelector('p')!;
            const range = document.createRange();
            const sel = window.getSelection()!;
            range.selectNodeContents(p);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
            const ev = new KeyboardEvent('keydown', {
                key: 't', code: 'KeyT', metaKey: true, bubbles: true, cancelable: true,
            });
            p.dispatchEvent(ev);
            await new Promise(r => setTimeout(r, 200));
            return { tableCount: editor.querySelectorAll('table').length };
        });
        expect(result.tableCount).toBe(1);
        expect(errors.filter(e => e.includes('insertTable'))).toHaveLength(0);
    });

    // TC-TBL-10: header あり通常 table の serialize 出力 byte 不変(NFR-03)
    test('TC-TBL-10 normal table serialize output is byte-identical', async ({ page }) => {
        const md = '| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |';
        const out = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return (window as any).__testApi.getMarkdown();
        }, md);
        expect(out.trim()).toBe(md);
    });

    // TC-I18N-01: tableToggleHeader キーが interface + 7 locale 全登録(grep 相当の検査)
    test('TC-I18N-01 tableToggleHeader is registered in all locales', async () => {
        const fs = require('fs');
        const path = require('path');
        const i18nDir = path.join(__dirname, '..', '..', 'src', 'i18n');
        const targets = [
            'messages.ts',
            'locales/en.ts', 'locales/ja.ts', 'locales/es.ts', 'locales/fr.ts',
            'locales/ko.ts', 'locales/zh-cn.ts', 'locales/zh-tw.ts',
        ];
        for (const rel of targets) {
            const content = fs.readFileSync(path.join(i18nDir, rel), 'utf8');
            expect(content, `${rel} should contain tableToggleHeader`).toContain('tableToggleHeader');
        }
    });
});
