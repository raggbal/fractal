/**
 * リスト cmd+x の空マーカー残り + cut→paste 構造崩れ — sprint 20260728-135515
 *
 * 症状1: ネストリスト選択の cut 後、deleteContents の空 li 殻（•/○/▪）が残る
 *   → cut に Backspace 範囲選択と同型の掃除を追加（TC-CX-01/02）
 * 症状2: cut のシリアライズが copy の「先頭 text + nested list の li ラップ」を欠き、
 *   `text- child` 連結の壊れ md を clipboard に入れる → 空 li paste の Pattern 1 に
 *   到達せず構造崩壊 → serializeSelectionToMd 共通化で修正（TC-CX-03/04/05）
 *
 * 再現 fixture はユーザー報告の実データ形:
 *   - AWS investments
 *     - url1
 *     - サンプル
 *       - url2
 */

import { test, expect } from '@playwright/test';

const NESTED_LIST_HTML =
    '<ul>' +
    '<li>AWS investments' +
    '<ul>' +
    '<li><a href="https://example.com/dash">url1</a></li>' +
    '<li>サンプル<ul><li><a href="https://example.com/detail">url2</a></li></ul></li>' +
    '</ul>' +
    '</li>' +
    '<li>Prototyping Engagement の作成' +
    '<ul><li>Investments toolに</li><li><a href="https://example.com/how">how-to</a></li></ul>' +
    '</li>' +
    '</ul>';

// 「AWS investments のテキスト先頭 〜 孫 url2 の末尾」を選択（Image 1 の選択と同形）
async function selectFirstSubtree(page: import('@playwright/test').Page) {
    await page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        const topLi = editor.querySelector('li')!;             // AWS investments
        const url2 = editor.querySelectorAll('li a')[1]!;      // detail link (url2)
        const r = document.createRange();
        r.setStart(topLi.firstChild!, 0);                      // "AWS investments" テキスト先頭
        r.setEnd(url2.firstChild!, (url2.textContent || '').length); // url2 末尾
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(r);
    });
}

async function dispatchCut(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        const dt = new DataTransfer();
        const ev = new ClipboardEvent('cut', { clipboardData: dt, bubbles: true, cancelable: true });
        editor.dispatchEvent(ev);
        return {
            md: dt.getData('text/x-any-md'),
            html: editor.innerHTML,
        };
    });
}

test.describe('リスト cut: 空マーカー残り + シリアライズ（sprint 20260728-135515）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        await page.evaluate((html) => {
            document.getElementById('editor')!.innerHTML = html;
        }, NESTED_LIST_HTML);
    });

    test('TC-CX-01 ★バグ再現: ネスト 3 階層選択の cut 後、空 li 殻が残らない', async ({ page }) => {
        await selectFirstSubtree(page);
        const r = await dispatchCut(page);
        // counterfactual: 掃除なしだと <li><br?></li> 殻が 3 階層残る = RED
        const emptyLis = (r.html.match(/<li>(<br>)?<\/li>/g) || []).length;
        expect(emptyLis).toBe(0);
        // 空 ul 殻も残らない
        expect(r.html).not.toMatch(/<ul>\s*<\/ul>/);
        // 残す方のリスト（Prototyping）は不変
        expect(r.html).toContain('Prototyping Engagement');
        expect(r.html).toContain('how-to');
    });

    test('TC-CX-02 markdown 同期: cut 後の md に空 `- ` 行が出ない', async ({ page }) => {
        await selectFirstSubtree(page);
        await dispatchCut(page);
        await page.waitForTimeout(300); // syncMarkdown は rAF + debounce
        const md = await page.evaluate(() => {
            const api = (window as any).__testApi;
            return api.getMarkdown ? api.getMarkdown() : (window as any).__lastSyncedMarkdown || null;
        });
        if (md !== null) {
            // 空リスト行（"- " のみ / インデント付き "- " のみ）が無い
            expect(md).not.toMatch(/^\s*- *$/m);
        }
        // DOM 側でも空 li ゼロ（md API が無い harness でも番人成立）
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect((html.match(/<li>(<br>)?<\/li>/g) || []).length).toBe(0);
    });

    test('TC-CX-03 ★バグ再現: cut の clipboard md が li ラップ形（text- child 連結にならない）', async ({ page }) => {
        await selectFirstSubtree(page);
        const r = await dispatchCut(page);
        // counterfactual: 旧 cut（単純 mdProcessNode ループ）だと "AWS investments- [url1]..." 連結 = RED
        expect(r.md).not.toMatch(/AWS investments- /);
        const lines = r.md.split('\n').filter((l: string) => l.trim());
        // 1 行目 = li ラップされた先頭テキスト
        expect(lines[0]).toMatch(/^- AWS investments$/);
        // 子は 1 段インデント、孫は 2 段（相対ネスト維持）
        expect(lines[1]).toMatch(/^ {2}- \[url1\]\(https:\/\/example\.com\/dash\)$/);
        expect(lines[2]).toMatch(/^ {2}- サンプル$/);
        expect(lines[3]).toMatch(/^ {4}- \[url2\]\(https:\/\/example\.com\/detail\)$/);
    });

    test('TC-CX-04 ★E2E: cut → 空 li に paste で相対ネスト接ぎ木（Image 5 の期待形）', async ({ page }) => {
        await selectFirstSubtree(page);
        const cut = await dispatchCut(page);
        // paste 先: Prototyping リストの第 2 階層に空 li を作り caret を置く（Image 3 の状態）
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            const subUl = editor.querySelectorAll('ul ul')[0] as HTMLElement; // Prototyping の子 ul
            const emptyLi = document.createElement('li');
            emptyLi.innerHTML = '<br>';
            subUl.appendChild(emptyLi);
            const r = document.createRange();
            r.setStart(emptyLi, 0);
            r.collapse(true);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        // paste dispatch（internalMd = cut した md）
        await page.evaluate((md) => {
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            dt.setData('text/x-any-md', md);
            dt.setData('text/plain', md);
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            (document.activeElement || editor).dispatchEvent(ev);
        }, cut.md);
        await page.waitForTimeout(200);
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        // counterfactual: 旧 cut md だと "AWS investments- url1" がリスト外 <p> に落ちる = RED
        expect(html).not.toMatch(/<p>[^<]*AWS investments/);
        // AWS investments が paste 先リスト内の li に入り、サンプル→url2 が子孫として残る
        const struct = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            const li = Array.from(editor.querySelectorAll('li')).find(
                (el) => (el.firstChild?.textContent || '').startsWith('AWS investments'));
            if (!li) return null;
            return {
                inList: !!li.closest('ul'),
                // paste 先（Prototyping の子 ul）配下に居る
                underPrototyping: !!(li.closest('ul')!.closest('li') &&
                    (li.closest('ul')!.closest('li')!.textContent || '').includes('Prototyping')),
                hasChildSample: !!Array.from(li.querySelectorAll(':scope > ul > li')).find(
                    (c) => (c.textContent || '').includes('サンプル')),
                hasGrandchildUrl2: !!li.querySelector('ul ul a[href*="detail"]'),
            };
        });
        expect(struct).not.toBeNull();
        expect(struct!.inList).toBe(true);
        expect(struct!.underPrototyping).toBe(true);
        expect(struct!.hasChildSample).toBe(true);
        expect(struct!.hasGrandchildUrl2).toBe(true);
    });

    test('TC-CX-05 regression: copy のシリアライズが共通化後も従来出力（li ラップ + indent）', async ({ page }) => {
        await selectFirstSubtree(page);
        const r = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
            editor.dispatchEvent(ev);
            return { md: dt.getData('text/x-any-md'), html: editor.innerHTML };
        });
        const lines = r.md.split('\n').filter((l: string) => l.trim());
        expect(lines[0]).toMatch(/^- AWS investments$/);
        expect(lines[1]).toMatch(/^ {2}- \[url1\]/);
        // copy は削除しない（DOM 不変）
        expect(r.html).toContain('AWS investments');
    });

    test('TC-CX-07 ★asset 番人: 親 text cut で img-only / checkbox-only の nested 子 li が昇格生存（TASK-03）', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML =
                '<ul><li>parenttext' +
                '<ul><li><img src="images/pic.png"></li>' +
                '<li><input type="checkbox"></li>' +
                '<li>keepchild</li></ul>' +
                '</li><li>other</li></ul>';
            const li = editor.querySelector('li')!;
            const r = document.createRange();
            r.setStart(li.firstChild!, 0);
            r.setEnd(li.firstChild!, 'parenttext'.length);   // 親テキストのみ選択
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        const r = await dispatchCut(page);
        // counterfactual: 旧 textContent 条件昇格だと img/checkbox 子が破棄され RED
        expect(r.html).toContain('images/pic.png');
        expect(r.html).toContain('type="checkbox"');
        expect(r.html).toContain('keepchild');
        expect(r.html).toContain('other');
    });

    test('TC-CX-08 ★asset 番人: affected li 直下の img は cut 掃除後も生存（TASK-03）', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>bbb<img src="images/keep.png"></li><li>second</li></ul>';
            const li = editor.querySelector('li')!;
            const r = document.createRange();
            r.setStart(li.firstChild!, 0);
            r.setEnd(li.firstChild!, 3);   // "bbb" のみ選択（img は選択外）
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        const r = await dispatchCut(page);
        // counterfactual: img を content 扱いしない旧判定だと li ごと消え img 消失 = RED
        expect(r.html).toContain('images/keep.png');
        expect(r.html).toContain('second');
    });

    test('TC-CX-09 ★再オープン: task 行のテキスト全選択 cut → checkbox ごと行が消える', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML =
                '<ul><li>before</li>' +
                '<li><input type="checkbox">Welcome to the team guide text</li>' +
                '<li>after</li></ul>';
            const taskLi = editor.querySelectorAll('li')[1]!;
            const textNode = Array.from(taskLi.childNodes).find((n) => n.nodeType === 3)!;
            const r = document.createRange();
            r.setStart(textNode, 0);
            r.setEnd(textNode, (textNode.textContent || '').length);  // テキストのみ全選択（checkbox 選択外）
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        const r = await dispatchCut(page);
        // counterfactual: checkbox を content 扱いすると空タスク殻（checkbox だけの行）が残る = RED
        expect(r.html).not.toContain('type="checkbox"');
        expect(r.html).toContain('before');
        expect(r.html).toContain('after');
        // 部分 cut（テキストが残る task 行）は checkbox ごと残る（過剰削除しない）
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li><input type="checkbox">keep some text</li></ul>';
            const li = editor.querySelector('li')!;
            const textNode = Array.from(li.childNodes).find((n) => n.nodeType === 3)!;
            const rr = document.createRange();
            rr.setStart(textNode, 0);
            rr.setEnd(textNode, 4);   // "keep" のみ
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(rr);
        });
        const r2 = await dispatchCut(page);
        expect(r2.html).toContain('type="checkbox"');
        expect(r2.html).toContain('some text');
    });

    test('TC-CX-10 ★再オープン: cut 直後の undo で cut 前の状態（checkbox 込み）に戻る', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML =
                '<ul><li>before</li>' +
                '<li><input type="checkbox">Welcome text</li>' +
                '<li>after</li></ul>';
            // 実運用の「直前に編集していた」状態を模す: input を発火させ debounced snapshot を積む
            // （このとき capture される markdown 変数は rAF 未反映で stale になりうる = 50% バグの機序）
            editor.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForTimeout(50); // rAF 前後の中途半端なタイミングを許容
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            const taskLi = editor.querySelectorAll('li')[1]!;
            const textNode = Array.from(taskLi.childNodes).find((n) => n.nodeType === 3)!;
            const r = document.createRange();
            r.setStart(textNode, 0);
            r.setEnd(textNode, (textNode.textContent || '').length);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await dispatchCut(page);
        // cut で行ごと消えた
        let html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).not.toContain('type="checkbox"');
        // undo → cut 前（checkbox + テキスト）に戻る
        await page.evaluate(() => (window as any).__testApi.undo
            ? (window as any).__testApi.undo()
            : (window as any).__hostMessageHandler({ type: 'performUndo' }));
        await page.waitForTimeout(200);
        html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        // counterfactual: cut が snapshot を積まないと「cut 前」でなく古い状態に戻り checkbox 消失 = RED
        expect(html).toContain('type="checkbox"');
        expect(html).toContain('Welcome text');
        expect(html).toContain('before');
        expect(html).toContain('after');
    });

    test('TC-CX-06 regression: 単一 li 内の部分テキスト cut は従来どおり（li は残る・掃除は空 li のみ）', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>keep this text</li><li>second</li></ul>';
            const li = editor.querySelector('li')!;
            const r = document.createRange();
            r.setStart(li.firstChild!, 5);   // "keep " の後ろ
            r.setEnd(li.firstChild!, 9);     // "this" を選択
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        const r = await dispatchCut(page);
        expect(r.md.trim()).toBe('this');
        // li は残る（部分 cut で li が消えない）
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toContain('keep  text');
        expect(html).toContain('second');
    });
});
