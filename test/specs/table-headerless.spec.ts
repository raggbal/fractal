import { test, expect } from '@playwright/test';

// Sprint 20260810-183054: headerless table (FR-TBL-01/02/03/05)
// rev2 (再オープン⑮, ADRL-0053 supersedes ADRL-0052):
//   headerless = th 不在の DOM が単一真実(CSS 非表示・data-headerless 属性は廃止)。
//   トグル = 構造変換(ON = 先頭 td 行を th 化 / OFF = th 行を td 化・内容は通常行に残る)。
//   md = マーカー + 空 placeholder header 行 + separator + 全行 body(GFM 互換)。
//   parse はマーカー時に th を作らず、空 placeholder は捨て、内容付き先頭行(旧 v1.1.28
//   形式・外部編集)は body に降格(データ喪失なし)。
// 旧意味論の TC は 許可: test_update(TASK-33)で本 rev2 に更新済み。

const MARKER = '<!-- fractal-headerless-table -->';

test.describe('Headerless table (FR-TBL rev2)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-TBL-03 rev2: headerless md の parse → serialize 往復。th ゼロ・マーカー維持・
    // placeholder 行が body に混入しない(2 往復 byte 安定)
    test('TC-TBL-03 headerless md roundtrip: no th, marker kept, placeholder dropped', async ({ page }) => {
        const md = MARKER + '\n|  |  |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            const out = (window as any).__testApi.getMarkdown();
            return {
                thCount: table?.querySelectorAll('th').length,
                rowCount: table?.querySelectorAll('tr').length,
                firstRowTexts: Array.from(table?.rows[0]?.cells || []).map(c => c.textContent?.trim()),
                out,
            };
        }, md);
        // th を一切作らない(counterfactual: 旧 CSS 非表示方式だと th が 2 個存在し RED)
        expect(result.thCount).toBe(0);
        // placeholder 空行は DOM に出ない → 実データ 2 行のみ
        expect(result.rowCount).toBe(2);
        expect(result.firstRowTexts).toEqual(['a1', 'b1']);
        // serialize がマーカー + placeholder を再 emit
        expect(result.out).toContain(MARKER);
        expect(result.out).toContain('| a1 | b1 |');
        expect(result.out).toContain('| a2 | b2 |');
        // 2 往復目 byte 安定(placeholder が行として増殖しない)
        const secondPass = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return {
                out: (window as any).__testApi.getMarkdown(),
                thCount: document.querySelectorAll('#editor table th').length,
                rowCount: document.querySelectorAll('#editor table tr').length,
            };
        }, result.out);
        expect(secondPass.out).toBe(result.out);
        expect(secondPass.thCount).toBe(0);
        expect(secondPass.rowCount).toBe(2);
    });

    // TC-TBL-24: 旧 v1.1.28 形式(マーカー + 内容付き header 行)→ 内容が先頭 body 行に
    // 降格(データ喪失なし・自然移行)
    test('TC-TBL-24 legacy marker md with header content demotes it to first body row', async ({ page }) => {
        const md = MARKER + '\n| A | B |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thCount: table?.querySelectorAll('th').length,
                rowTexts: Array.from(table?.querySelectorAll('tr') || []).map(
                    tr => Array.from(tr.cells).map(c => c.textContent?.trim()).join(',')),
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.thCount).toBe(0);
        // A/B は消えず先頭の通常行として残る
        expect(result.rowTexts).toEqual(['A,B', 'a1,b1']);
        expect(result.out).toContain('| A | B |');
        expect(result.out).toContain(MARKER);
    });

    // TC-TBL-04: マーカーなし空 header table(ユーザー意図)は headerless に化けない
    test('TC-TBL-04 empty-header table without marker stays a normal table', async ({ page }) => {
        const md = '|   |   |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thCount: table?.querySelectorAll('th').length,
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.thCount).toBe(2); // 空でも th は th(ユーザー意図の温存)
        expect(result.out).not.toContain(MARKER);
    });

    // TC-TBL-05: headerless + col-widths 併用の往復(両マーカー共存)
    test('TC-TBL-05 headerless and col-widths markers coexist across roundtrip', async ({ page }) => {
        const md = '<!-- fractal-col-widths: 120,180 -->\n' + MARKER
            + '\n|  |  |\n| --- | --- |\n| a1 | b1 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thCount: table?.querySelectorAll('th').length,
                colWidths: table?.getAttribute('data-col-widths'),
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.thCount).toBe(0);
        expect(result.colWidths).toBe('120,180');
        expect(result.out).toContain(MARKER);
        expect(result.out).toContain('fractal-col-widths: 120,180');
        // 逆順(headerless → col-widths)でも両方 parse される
        const swapped = await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown(
                '<!-- fractal-headerless-table -->\n<!-- fractal-col-widths: 120,180 -->'
                + '\n|  |  |\n| --- | --- |\n| a1 | b1 |');
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thCount: table?.querySelectorAll('th').length,
                colWidths: table?.getAttribute('data-col-widths'),
            };
        });
        expect(swapped.thCount).toBe(0);
        expect(swapped.colWidths).toBe('120,180');
    });

    // one-shot 対クリア: マーカー付き table の次の table に headerless が漏れない
    test('TC-TBL-03b marker applies to next table only (one-shot reset)', async ({ page }) => {
        const md = MARKER + '\n|  |  |\n| --- | --- |\n| a1 | b1 |\n\n'
            + '| H1 | H2 |\n| --- | --- |\n| c1 | c2 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const tables = document.querySelectorAll('#editor table');
            return Array.from(tables).map(t => t.querySelectorAll('th').length);
        }, md);
        expect(result[0]).toBe(0);
        expect(result[1]).toBe(2);
    });

    // TC-TBL-20 (rev2): トグル OFF = 構造変換。th 行が td 行になり内容は通常行として
    // 見える。syncMarkdown 発火・ON で 1 行目(= 元 header 内容)が th 化して戻る
    test('TC-TBL-20 toggle OFF converts th row to a normal td row (content stays visible)', async ({ page }) => {
        const md = '| A | B |\n| --- | --- |\n| a1 | b1 |';
        const afterToggle = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
            return {
                thCount: table.querySelectorAll('th').length,
                rowTexts: Array.from(table.querySelectorAll('tr')).map(
                    tr => Array.from(tr.cells).map(c => c.textContent?.trim()).join(',')),
                firstRowVisible: (table.rows[0].cells[0] as HTMLElement).offsetParent !== null,
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        // counterfactual: CSS 非表示方式だと th が残り thCount=2 で RED
        expect(afterToggle.thCount).toBe(0);
        expect(afterToggle.rowTexts).toEqual(['A,B', 'a1,b1']); // A/B は通常行として残る
        expect(afterToggle.firstRowVisible).toBe(true);          // 非表示ではない
        expect(afterToggle.out).toContain(MARKER);               // syncMarkdown 発火の証跡

        // ON に戻す → 1 行目(A/B)が th 化
        const afterRestore = await page.evaluate(async () => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
            return {
                thTexts: Array.from(table.querySelectorAll('th')).map(t => t.textContent?.trim()),
                rowCount: table.querySelectorAll('tr').length,
                out: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(afterRestore.thTexts).toEqual(['A', 'B']);
        expect(afterRestore.rowCount).toBe(2);
        expect(afterRestore.out).not.toContain(MARKER);
    });

    // TC-TBL-21 (rev2): headerless table で ON → 先頭 td 行が th 化
    test('TC-TBL-21 toggle ON promotes the first row to header', async ({ page }) => {
        const md = MARKER + '\n|  |  |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |';
        const result = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
            return {
                thTexts: Array.from(table.querySelectorAll('th')).map(t => t.textContent?.trim()),
                rowCount: table.querySelectorAll('tr').length,
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
        expect(result.thTexts).toEqual(['a1', 'b1']);
        expect(result.rowCount).toBe(2);
        expect(result.out).not.toContain(MARKER);
        expect(result.out).toContain('| a1 | b1 |');
    });

    // TC-TBL-26 (rev2): toolbar「H」ボタンの active 状態 = 実 header 有無
    test('TC-TBL-26 toolbar H button active state reflects real header presence', async ({ page }) => {
        const result = await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('| A | B |\n| --- | --- |\n| a1 | b1 |');
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            // table 内クリックで toolbar 表示
            const cell = table.querySelector('th')!;
            (cell as HTMLElement).click();
            await new Promise(r => setTimeout(r, 200));
            const btn = document.querySelector('.table-toolbar [data-action="toggle-header"]');
            const activeWithHeader = btn?.classList.contains('active');
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
            const activeAfterOff = btn?.classList.contains('active');
            return { activeWithHeader, activeAfterOff };
        });
        expect(result.activeWithHeader).toBe(true);
        expect(result.activeAfterOff).toBe(false);
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

    // ---- TASK-03 (FR-TBL-03): 外部 HTML table 貼り付けの headerless 判定 ----

    async function pasteHtml(page, html: string) {
        // 空段落にカーソルを置いてから paste(カーソル未設定だと paste ハンドラが no-op)
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<p><br></p>';
            const p = editor.querySelector('p')!;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.waitForTimeout(100);
        await page.evaluate((h: string) => {
            const editor = document.getElementById('editor')!;
            const clipboardData = {
                _data: { 'text/plain': '', 'text/html': h } as Record<string, string>,
                getData: function (type: string) { return this._data[type] || ''; },
                setData: function (type: string, value: string) { this._data[type] = value; },
                items: [],
            };
            const event = new ClipboardEvent('paste', {
                bubbles: true, cancelable: true, clipboardData: new DataTransfer(),
            });
            Object.defineProperty(event, 'clipboardData', {
                value: clipboardData, writable: false, configurable: true,
            });
            editor.dispatchEvent(event);
        }, html);
        await page.waitForTimeout(300);
    }

    // TC-TBL-25 (rev2): th なし HTML table → 真の headerless(th ゼロ)で貼付
    // counterfactual: 旧方式(空 thead 温存 + CSS 非表示)だと th が存在し RED
    test('TC-TBL-25 table without heading row pastes as truly headerless (no th)', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown(''); });
        await page.waitForTimeout(200);
        await pasteHtml(page,
            '<table><tr><td>a1</td><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></table>');
        const result = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                hasTable: !!table,
                thCount: table?.querySelectorAll('th').length,
                rowTexts: Array.from(table?.querySelectorAll('tr') || []).map(
                    tr => Array.from((tr as HTMLTableRowElement).cells).map(c => c.textContent?.trim()).join(',')),
                out: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(result.hasTable).toBe(true);
        expect(result.thCount).toBe(0);
        expect(result.rowTexts).toEqual(['a1,b1', 'a2,b2']); // 隠れ placeholder 行なし
        expect(result.out).toContain(MARKER);
    });

    // TC-TBL-07: thead/th あり HTML table → 従来どおり header あり
    test('TC-TBL-07 table with heading row pastes as normal table', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown(''); });
        await page.waitForTimeout(200);
        await pasteHtml(page,
            '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>'
            + '<tbody><tr><td>a1</td><td>b1</td></tr></tbody></table>');
        const result = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thTexts: Array.from(table?.querySelectorAll('th') || []).map(t => t.textContent?.trim()),
                out: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(result.thTexts).toEqual(['H1', 'H2']);
        expect(result.out).not.toContain(MARKER);
    });

    // TC-TBL-08: &nbsp; のみの th → header あり側(th 実在 = heading row)
    test('TC-TBL-08 table with nbsp-only th pastes as normal table', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown(''); });
        await page.waitForTimeout(200);
        await pasteHtml(page,
            '<table><tr><th>&nbsp;</th><th>&nbsp;</th></tr>'
            + '<tr><td>a1</td><td>b1</td></tr></table>');
        const result = await page.evaluate(() => {
            const table = document.querySelector('#editor table') as HTMLTableElement;
            return {
                thCount: table?.querySelectorAll('th').length,
                out: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(result.thCount).toBe(2);
        expect(result.out).not.toContain(MARKER);
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

// ---- undo(再オープン① TC-TBL-11 を rev2 意味論で維持) ----

test.describe('Header toggle undo (FR-TBL-01 rev2)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-TBL-11: トグルが undo スタックに乗る(Cmd+Z で th 復帰)
    // counterfactual: saveSnapshot なしだとトグル前の状態に戻れない = RED
    test('TC-TBL-11 header toggle is undoable', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('| A | B |\n| --- | --- |\n| a1 | b1 |');
            await new Promise(r => setTimeout(r, 300));
            const table = document.querySelector('#editor table') as HTMLTableElement;
            (window as any).__toggleTableHeaderForTest(table);
            await new Promise(r => setTimeout(r, 200));
        });
        const afterToggle = await page.evaluate(() =>
            document.querySelectorAll('#editor table th').length);
        expect(afterToggle).toBe(0); // OFF = th 消滅(構造変換)
        // Cmd+Z
        await page.evaluate(() => { (document.querySelector('#editor') as HTMLElement).focus(); });
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const afterUndo = await page.evaluate(() => ({
            thTexts: Array.from(document.querySelectorAll('#editor table th')).map(
                t => t.textContent?.trim()),
        }));
        expect(afterUndo.thTexts).toEqual(['A', 'B']); // トグル前(header あり)に戻る
    });
});
