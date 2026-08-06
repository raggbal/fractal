/**
 * sprint 20260806-035923 — リスト継続行（CommonMark continuation lines）
 *
 * FR-LC-01: parse — li 本文位置にインデントされた非リスト行を直前 li の項目内改行に
 * FR-LC-02: リスト内 Shift+Enter = 項目内改行（従来の新 li 作成を置換）
 * FR-LC-03: serialize — li 内 <br> を継続行（マーカー幅インデント）で出力・round-trip 安定
 */
import { test, expect } from '@playwright/test';

async function boot(page: import('@playwright/test').Page, md?: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    if (md) {
        await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md);
        await page.waitForTimeout(200);
    }
}
const getHtml = (page: any) => page.evaluate(() => document.getElementById('editor')!.innerHTML);
const getMd = (page: any) => page.evaluate(() => (window as any).__testApi.getMarkdown());

test.describe('リスト継続行 (FR-LC)', () => {
    test('TC-LC-01 Quip 断片: 継続行が li 内 2 行目・後続子リストのネスト維持', async ({ page }) => {
        await boot(page, '1. parent\n    1. child\n    2. Risk 説明\n        (補足を太字で)\n        1. **Low**: consult\n');
        const html = await getHtml(page);
        // counterfactual: 修正前は継続行が <p> でリスト分断 + 子リストが top に落ちて RED
        expect(html).toContain('<li>Risk 説明<br>(補足を太字で)<ol><li><strong>Low</strong>: consult</li></ol></li>');
        expect(html.replace(/<p><br><\/p>$/, '')).not.toContain('<p>'); // 末尾 \n 由来の空段落は除外
    });

    test('TC-LC-02 連続継続行 2 行も同一 li', async ({ page }) => {
        await boot(page, '- item\n  cont one\n  cont two\n');
        const html = await getHtml(page);
        expect(html).toContain('<li>item<br>cont one<br>cont two</li>');
    });

    test('TC-LC-03 リストより浅い行は従来どおり段落（リスト終了・回帰 pin）', async ({ page }) => {
        await boot(page, '- item\nplain paragraph\n');
        const html = await getHtml(page);
        expect(html).toContain('<ul><li>item</li></ul>');
        expect(html).toContain('<p>plain paragraph</p>');
    });

    test('TC-LC-04 リスト内 Shift+Enter → li 内改行・li 数不変', async ({ page }) => {
        await boot(page, '1. item one\n2. two');
        await page.evaluate(() => {
            const li = document.querySelector('#editor ol li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            sel.removeAllRanges(); sel.addRange(range);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('cont');
        await page.waitForTimeout(300);
        const liCount = await page.evaluate(() => document.querySelectorAll('#editor ol > li').length);
        // counterfactual: 旧挙動（新 li 作成）だと liCount=3 で RED
        expect(liCount).toBe(2);
        const html = await getHtml(page);
        expect(html).toContain('<li>item one<br>cont');
    });

    test('TC-LC-05 Shift+Enter → serialize → 再ロード round-trip 一致', async ({ page }) => {
        await boot(page, '1. item one');
        await page.evaluate(() => {
            const li = document.querySelector('#editor ol li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            sel.removeAllRanges(); sel.addRange(range);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('cont line');
        await page.waitForTimeout(300);
        const md1 = await getMd(page);
        expect(md1).toContain('1. item one\n   cont line');
        await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md1);
        await page.waitForTimeout(200);
        const md2 = await getMd(page);
        expect(md2).toBe(md1);
    });

    test('TC-LC-06 継続行なしリストの serialize は不変（既存互換 pin）', async ({ page }) => {
        await boot(page, '1. a\n2. b\n  - c\n');
        const md = await getMd(page);
        expect(md).toBe('1. a\n2. b\n  - c\n');
    });

    test('TC-LC-07 継続行持ち li で Enter → 新項目・継続行は元項目に残る', async ({ page }) => {
        await boot(page, '1. head\n   cont\n2. next\n');
        await page.evaluate(() => {
            // head li の末尾（cont の後）にカーソル
            const li = document.querySelector('#editor ol li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            sel.removeAllRanges(); sel.addRange(range);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Enter');
        await page.keyboard.type('new item');
        await page.waitForTimeout(300);
        const md = await getMd(page);
        expect(md).toContain('1. head\n   cont');
        expect(md).toContain('new item');
        const liCount = await page.evaluate(() => document.querySelectorAll('#editor ol > li').length);
        expect(liCount).toBe(3);
    });

    test('TC-LC-08 ユーザー提供 Quip リスト全文の round-trip 安定', async ({ page }) => {
        const quip = [
            '1. [Pythia](https://example.com/x) の Risk Classification を実施します。',
            '    1. Risk Classification では、リスクを判断します。',
            '        1. **Low**: Consult を実施',
            '        2. **Medium**: [APSM](https://example.com/a) をもとに Review を実施',
            '    2. Risk Classification の各項目の説明',
            '        (Medium 以下になる選択肢を太字で記載します)',
            '        1. **Does the prototype contain sensitive data?**',
            '            AWS 側で規制対象データを扱うかどうか',
            '            1. Yes: High risk',
            '            2. **No**: Low risk',
        ].join('\n') + '\n';
        await boot(page, quip);
        const md1 = await getMd(page);
        // 継続行 2 箇所が保全されている
        expect(md1).toContain('の各項目の説明\n');
        expect(md1).toContain('(Medium 以下になる選択肢を太字で記載します)');
        expect(md1).toContain('AWS 側で規制対象データを扱うかどうか');
        // 段落化していない（リスト分断なし・末尾 \n 由来の空段落は除外）
        const html = await getHtml(page);
        expect(html.replace(/<p><br><\/p>$/, '')).not.toContain('<p>');
        // round-trip 安定
        await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md1);
        await page.waitForTimeout(200);
        expect(await getMd(page)).toBe(md1);
    });
});

// 2026-08-06 手動テスト fail 反映
test.describe('継続行の Shift+Enter 途中改行 / コピー保全 (fix)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('TC-LC-09 文字途中の Shift+Enter は空白行を挟まない（br 1 個）', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown('- abcdef'); });
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 3); range.collapse(true);
            sel.removeAllRanges(); sel.addRange(range);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        // counterfactual: 無条件 double-br だと <br><br> で空白行 = RED
        expect(html).toContain('<li>abc<br>def</li>');
        expect(html).not.toContain('<br><br>');
    });

    test('TC-LC-10 末尾の Shift+Enter は視覚行を確保（br 2 個許容・タイプで 1 行に）', async ({ page }) => {
        await page.evaluate(() => { (window as any).__testApi.setMarkdown('- abc'); });
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const li = document.querySelector('#editor ul li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li); range.collapse(false);
            sel.removeAllRanges(); sel.addRange(range);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('xyz');
        await page.waitForTimeout(200);
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toContain('<li>abc<br>xyz');
        const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md).toContain('- abc\n  xyz');
    });

    test('TC-LC-11 継続行持ち li の選択コピーで改行が保たれる（bold 跨ぎ含む）', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('1. **Does data?\n    **AWS 側で扱うか\n    1. Yes: High\n');
        });
        await page.waitForTimeout(200);
        const copied = await page.evaluate(() => {
            const li = document.querySelector('#editor ol li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            sel.removeAllRanges(); sel.addRange(range);
            const dt = new DataTransfer();
            const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true } as any);
            document.getElementById('editor')!.dispatchEvent(ev);
            return dt.getData('text/plain');
        });
        // counterfactual: bare br → '' だと「?**AWS」に連結 = RED
        expect(copied).toContain('Does data?\n');
        expect(copied).not.toContain('?**AWS');
    });
});

// 2026-08-06 ユーザー要望: 複数行選択の cmd+c は先頭行の選択範囲がどうであれリストとしてコピー
test.describe('部分選択コピーのリスト保全 (TC-LC-12..14)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('1. Risk の説明\n   (補足を太字で)\n    1. **Does?\n        **AWS で扱うか\n    2. second\n2. next item\n');
        });
        await page.waitForTimeout(200);
    });

    async function copyRange(page: any, setup: string) {
        return page.evaluate((code: string) => {
            const sel = window.getSelection()!;
            const range = document.createRange();
            eval(code);
            sel.removeAllRanges(); sel.addRange(range);
            const dt = new DataTransfer();
            document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true } as any));
            return dt.getData('text/plain');
        }, setup);
    }

    test('TC-LC-12 先頭 li のテキスト途中から複数 li 選択 → ol としてコピー（counterfactual: 旧実装は先頭が bullet/段落化）', async ({ page }) => {
        const md = await copyRange(page, `
            const li0 = document.querySelector('#editor ol li');
            const topLis = document.querySelectorAll('#editor > ol > li');
            range.setStart(li0.firstChild, 5);
            range.setEndAfter(topLis[topLis.length - 1]);
        `);
        expect(md).toMatch(/^1\. /);        // 先頭行が ol の li（段落・bullet でない）
        expect(md).toContain('2. next item'); // 後続 li も連番
        expect(md).toContain('(補足を太字で)'); // 継続行維持
    });

    test('TC-LC-13 継続行の途中から選択でもリストとしてコピー', async ({ page }) => {
        const md = await copyRange(page, `
            const li0 = document.querySelector('#editor ol li');
            const cont = Array.from(li0.childNodes).filter(n => n.nodeType === 3)[1];
            const allLis = document.querySelectorAll('#editor li');
            range.setStart(cont, 2);
            range.setEndAfter(allLis[allLis.length - 1]);
        `);
        expect(md).toMatch(/^1\. /);
        expect(md).toContain('1. **Does?');
    });

    test('TC-LC-14 単一行の部分選択は従来どおりプレーンテキスト（回帰 pin）', async ({ page }) => {
        const md = await copyRange(page, `
            const li0 = document.querySelector('#editor ol li');
            range.setStart(li0.firstChild, 0);
            range.setEnd(li0.firstChild, 4);
        `);
        expect(md).not.toMatch(/^[-\d]/); // マーカー無しのプレーンテキスト
        expect(md).toContain('Risk');
    });
});
