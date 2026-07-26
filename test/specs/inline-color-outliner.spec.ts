/**
 * TC-IC-09〜12 — outliner node text のインライン文字色（表示 + 右クリック + 編集モード fallback + offset 非回帰）。
 * standalone-outliner。OutlinerCell 純関数 + 実 DOM。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

test.describe('outliner インライン文字色 (FR-IC-03/04/06)', () => {
    // TC-IC-09: 表示 renderInlineText — 色 span が色付き描画・code 内は非着色 ★load-bearing
    test('TC-IC-09 renderInlineText が色 span を色付きに / code 内は非着色', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const html = OC.renderInlineText('foo <span style="color:#3b82f6">bar</span> baz');
            // code 内の色記法はテキストのまま（着色しない）
            const codeHtml = OC.renderInlineText('`<span style="color:#3b82f6">x</span>`');
            const div = document.createElement('div'); div.innerHTML = html;
            const span = div.querySelector('span[style*="color"]') as HTMLElement;
            const codeDiv = document.createElement('div'); codeDiv.innerHTML = codeHtml;
            return {
                hasColorSpan: !!span,
                spanText: span ? span.textContent : null,
                colorInCode: !!(codeDiv.querySelector('code span[style*="color"]')),
            };
        });
        expect(r.hasColorSpan).toBe(true);
        expect(r.spanText).toBe('bar');
        expect(r.colorInCode).toBe(false);   // ★ code 内は着色しない
    });

    // TC-IC-10: 編集モード fallback — renderEditingText は色タグを生のまま出す（offset 不変）★load-bearing
    test('TC-IC-10 renderEditingText は色 span を生タグ可視・textContent===source', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            const src = 'a <span style="color:#ef4444">red</span> b';
            const edited = OC.renderEditingText(src);
            const div = document.createElement('div'); div.innerHTML = edited;
            // 編集モードでは色 span は色付き描画されず、生タグがテキストとして見える
            const colorSpan = div.querySelector('span[style*="color"]');
            return {
                noColorSpanElement: !colorSpan,
                textContent: div.textContent,
                // ★ textContent が source と一致（offset 計算が既存ロジックで正しく動く）
                matchesSource: div.textContent === src,
            };
        });
        expect(r.noColorSpanElement).toBe(true);   // 編集モードで色 span 要素は作られない（生タグ可視）
        expect(r.matchesSource).toBe(true);        // ★ textContent===source（fallback の肝）
    });

    // TC-IC-12: offset 関数が色 span を含む source でも既存挙動（cursor 非回帰）★load-bearing・counterfactual
    test('TC-IC-12 renderedOffsetToSource は色 span 含む text でも既存挙動（bold と同様）', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(() => {
            const OC = (window as any).OutlinerCell;
            // 色 span は編集モードで生タグ = source そのまま。stripInlineMarkers は色 span を剥がさない
            // （renderEditingText と同じく生のまま）ので、bold '**' のみ剥がす既存挙動が保たれる。
            const src = '**bold** <span style="color:#ef4444">c</span>';
            const stripped = OC.stripInlineMarkers(src);
            // ** は剥がれる、色 span は生のまま残る（編集モードで可視）
            return {
                stripped: stripped,
                boldStripped: !stripped.includes('**'),
                colorSpanKept: stripped.includes('<span style="color:#ef4444">'),
            };
        });
        expect(r.boldStripped).toBe(true);        // 既存 marker（**）は従来どおり剥がれる
        expect(r.colorSpanKept).toBe(true);       // ★ 色 span は生のまま（offset 関数を触らない = 回帰ゼロ）
    });

    // TC-IC-11: 右クリック → Text Color → 適用 / None（実 DOM）E2E
    test('TC-IC-11 右クリックメニューから node text に色を適用・除去', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello world', tags: [] } }
            });
        });
        const textEl = page.locator('.outliner-node .outliner-text').first();
        await textEl.click();
        await page.waitForTimeout(50);
        // "world" を選択
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            const tn = el.firstChild!;
            const range = document.createRange();
            const idx = (tn.textContent || '').indexOf('world');
            range.setStart(tn, idx); range.setEnd(tn, idx + 5);
            const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range);
        });
        // 右クリック → picker → swatch
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
        });
        // Text Color 項目 click
        const applied = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
            const tc = items.find(i => (i.textContent || '').includes('Text Color') || (i.textContent || '').includes('文字色')) as HTMLElement;
            if (!tc) return { found: false, text: '' };
            tc.click();
            // picker swatch click
            const sw = document.querySelector('.inline-color-popover .file-panel-color-swatch') as HTMLElement;
            if (sw) sw.click();
            const model = (window as any).__testApi.getModel ? (window as any).__testApi.getModel() : null;
            const n1 = model ? model.getNode('n1') : null;
            return { found: true, text: n1 ? n1.text : (window as any).Outliner.getModel().getNode('n1').text };
        });
        expect(applied.found).toBe(true);
        expect(applied.text).toContain('<span style="color:#ef4444">world</span>');
    });

    // TC-IC-16: 選択なしで右クリック → node text 全体を着色（再オープン①）★load-bearing
    test('TC-IC-16 選択なし右クリックで Text Color が出て node 全体を着色', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'whole node', tags: [] } }
            });
        });
        // display mode（クリックせず）で選択なし右クリック
        const r = await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            window.getSelection()!.removeAllRanges();  // 選択なし
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 15, clientY: 15 }));
            const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
            const tc = items.find(i => (i.textContent || '').includes('Text Color') || (i.textContent || '').includes('文字色')) as HTMLElement;
            const found = !!tc;
            if (tc) {
                tc.click();
                const sw = document.querySelector('.inline-color-popover .file-panel-color-swatch') as HTMLElement;
                if (sw) sw.click();
            }
            const n1 = (window as any).Outliner.getModel().getNode('n1');
            return { found, text: n1.text };
        });
        expect(r.found).toBe(true);   // ★ 選択なしでも Text Color 項目が出る
        expect(r.text).toBe('<span style="color:#ef4444">whole node</span>');  // node 全体着色
    });

    // TC-IC-19: 部分選択の右クリック着色は選択部分だけ（node 全体にしない）★load-bearing・counterfactual
    // ★再オープン②(TASK-13): 数値 source-offset 捕捉により、picker→onPick の focus 再レンダーを跨いでも
    //   選択範囲が失われず部分着色される（旧: Range が detached → collapse → wholeText 昇格で全体着色=RED）。
    test('TC-IC-19 部分選択右クリックは選択部分だけ着色（全体にしない）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'hello world', tags: [] } }
            });
        });
        const textEl = page.locator('.outliner-text').first();
        await textEl.click();   // edit mode に入れる（textContent===source）
        await page.waitForTimeout(50);
        // "world"（offset 6-11）を選択
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            const tn = el.firstChild!;
            const idx = (tn.textContent || '').indexOf('world');
            const range = document.createRange();
            range.setStart(tn, idx); range.setEnd(tn, idx + 5);
            const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range);
        });
        // 実経路: contextmenu（offset 数値捕捉）→ Text Color → picker swatch。
        // picker 表示で focus が動いても数値 offset なので選択部分が保たれる。
        const text = await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 25, clientY: 25 }));
            const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
            const tc = items.find(i => (i.textContent || '').includes('Text Color') || (i.textContent || '').includes('文字色')) as HTMLElement;
            tc.click();
            const sw = document.querySelector('.inline-color-popover .file-panel-color-swatch') as HTMLElement;
            sw.click();
            return (window as any).Outliner.getModel().getNode('n1').text;
        });
        // ★ "world" だけ着色・"hello " は無色（全体着色でない）
        expect(text).toBe('hello <span style="color:#ef4444">world</span>');
        expect(text).not.toBe('<span style="color:#ef4444">hello world</span>');  // counterfactual: 全体着色は NG
    });

    // TC-IC-19b: marker を含む node text の部分選択でも offset がずれない（TASK-16 の番人）★load-bearing
    // ★ edit mode は textContent===source なので DOM offset=source offset。renderedOffsetToSource に通すと
    //   marker 長ぶん前方シフトして "world"→"d" だけ着色になっていた（reviewer 発見）。
    test('TC-IC-19b marker 付き node text の部分選択で正しい範囲を着色（offset シフトなし）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, children: [], text: '**hi** world', tags: [] } }
            });
        });
        const textEl = page.locator('.outliner-text').first();
        await textEl.click();   // edit mode（renderEditingText で `**hi**` が literal 表示・textContent===source）
        await page.waitForTimeout(50);
        // source "**hi** world" の中の "world"（source offset 7-12）を選択。
        // edit mode では textContent === source なので DOM offset も 7-12。
        await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            // textContent 全体から "world" の位置を探して range を張る（複数 text node の可能性に配慮）
            const full = el.textContent || '';
            const idx = full.indexOf('world');
            // 単純化: el 内の最初の text node が全 source を保持している前提（renderEditingText はタグのみ span 化）
            // TreeWalker で idx をカバーする text node/offset を求める
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let acc = 0; let sNode: Node | null = null; let sOff = 0; let eNode: Node | null = null; let eOff = 0; let n: Node | null;
            while ((n = walker.nextNode())) {
                const len = (n.textContent || '').length;
                if (sNode === null && acc + len >= idx) { sNode = n; sOff = idx - acc; }
                if (acc + len >= idx + 5) { eNode = n; eOff = idx + 5 - acc; break; }
                acc += len;
            }
            const range = document.createRange();
            range.setStart(sNode!, sOff); range.setEnd(eNode!, eOff);
            const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range);
        });
        const text = await page.evaluate(() => {
            const el = document.querySelector('.outliner-text') as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 25, clientY: 25 }));
            const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
            const tc = items.find(i => (i.textContent || '').includes('Text Color') || (i.textContent || '').includes('文字色')) as HTMLElement;
            tc.click();
            const sw = document.querySelector('.inline-color-popover .file-panel-color-swatch') as HTMLElement;
            sw.click();
            return (window as any).Outliner.getModel().getNode('n1').text;
        });
        // ★ marker を保ったまま "world" だけ着色（"d" だけ等のシフトがない）
        expect(text).toBe('**hi** <span style="color:#ef4444">world</span>');
    });
});
