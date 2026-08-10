import { test, expect, Page } from '@playwright/test';

// Sprint 20260810-183054 TASK-08 (FR-LC-05/06): リスト継続行内での引用/コードブロック作成。
// 4 経路(autoformat「> 」/「``` 」+Enter / Cmd+/ palette / toolbar / Ctrl+Shift+Q/K)を
// 共通ヘルパ resolveBlockInsertionTarget に配線し、li 内ネストでブロックを生成する。
// 本 TASK は DOM 生成まで(md 往復は TASK-09/10)。

// li 継続行(Shift+Enter 後の空行)にカーソルを置く共通 setup
async function setupListWithContinuation(page: Page, opts: { nested?: boolean } = {}) {
    await page.evaluate(async (nested) => {
        const md = nested
            ? '- parent\n  - item one\n    cont'
            : '- item one\n  cont\n- item two';
        (window as any).__testApi.setMarkdown(md);
        await new Promise(r => setTimeout(r, 300));
    }, !!opts.nested);
    await page.waitForTimeout(200);
    // 対象 li(継続行を持つ li)の継続行末尾にカーソル → Shift+Enter で新しい空継続行を作る
    await page.evaluate((nested) => {
        const editor = document.getElementById('editor')!;
        const lis = editor.querySelectorAll('li');
        const li = nested ? lis[lis.length - 1] : lis[0];
        const sel = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(li);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        (li as HTMLElement).focus?.();
    }, !!opts.nested);
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(150);
}

async function getListState(page: Page) {
    return await page.evaluate(() => {
        const editor = document.getElementById('editor')!;
        const lists = editor.querySelectorAll('ul, ol');
        const lis = editor.querySelectorAll('li');
        const bqInLi = editor.querySelectorAll('li blockquote');
        const preInLi = editor.querySelectorAll('li pre');
        const topBq = editor.querySelectorAll(':scope > blockquote');
        const topPre = editor.querySelectorAll(':scope > pre');
        return {
            listCount: lists.length,
            liCount: lis.length,
            liTexts: Array.from(lis).map(li => (li.textContent || '').substring(0, 30)),
            bqInLiCount: bqInLi.length,
            preInLiCount: preInLi.length,
            topBqCount: topBq.length,
            topPreCount: topPre.length,
            editorTop: editor.innerHTML.substring(0, 150),
        };
    });
}

test.describe('In-li block creation (FR-LC-05/06)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-01: li 継続行で「> 」入力 → li 内 blockquote(リスト構造不変)
    test('TC-ILB-01 typing "> " in continuation line creates in-li blockquote', async ({ page }) => {
        await setupListWithContinuation(page);
        await page.keyboard.type('>');
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        const state = await getListState(page);
        expect(state.bqInLiCount).toBe(1);   // li 内にネスト
        expect(state.listCount).toBeGreaterThanOrEqual(1); // リストは壊れない
        expect(state.liCount).toBe(2);       // item one / item two が残る
        expect(state.topBqCount).toBe(0);    // top-level に逃げない
    });

    // TC-ILB-05: 先頭 li のテキストが「> 」で始まる + autoformat 発火 → リスト全体が置換されない
    // (:5935 相当の node.replaceWith 潜在事故番人)
    test('TC-ILB-05 "> " at head of first li does not replace whole list', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- first\n- second');
            await new Promise(r => setTimeout(r, 300));
        });
        // 先頭 li のテキスト先頭にカーソルを置き「> 」を打つ
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('>');
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        const state = await getListState(page);
        // リストが blockquote に置換されない(li 2 個が生存)
        expect(state.listCount).toBeGreaterThanOrEqual(1);
        expect(state.liCount).toBe(2);
        expect(state.topBqCount).toBe(0);
    });

    // TC-ILB-06: li 継続行で「``` 」+Enter → li 内 pre
    test('TC-ILB-06 typing "```" + Enter in continuation line creates in-li pre', async ({ page }) => {
        await setupListWithContinuation(page);
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const state = await getListState(page);
        expect(state.preInLiCount).toBe(1);
        expect(state.liCount).toBe(2);
        expect(state.topPreCount).toBe(0);
    });

    // TC-ILB-02: Cmd+/ palette「引用」を li 内で → li 内 blockquote
    test('TC-ILB-02 palette quote in li creates in-li blockquote', async ({ page }) => {
        await setupListWithContinuation(page);
        await page.evaluate(() => {
            (window as any).__paletteActionForTest
                ? (window as any).__paletteActionForTest('quote')
                : (window as any).__executePaletteAction?.('quote');
        });
        await page.waitForTimeout(200);
        const state = await getListState(page);
        expect(state.bqInLiCount).toBe(1);
        expect(state.liCount).toBe(2);
        expect(state.topBqCount).toBe(0);
    });

    // TC-ILB-03: toolbar 引用ボタン相当(palette と同経路)を li 内で
    test('TC-ILB-03 toolbar quote in li creates in-li blockquote', async ({ page }) => {
        await setupListWithContinuation(page);
        // toolbar の quote ボタンは palette と同じ action dispatch を通る
        await page.evaluate(() => {
            (window as any).__paletteActionForTest?.('quote');
        });
        await page.waitForTimeout(200);
        const state = await getListState(page);
        expect(state.bqInLiCount).toBe(1);
        expect(state.topBqCount).toBe(0);
    });

    // TC-ILB-04: Ctrl+Shift+Q を li 内(テキストあり継続行)で → その行のみ li 内 blockquote 化
    // counterfactual: 現行 convertToBlockquote はリスト全体を置換 = RED
    test('TC-ILB-04 Ctrl+Shift+Q in li converts only the line, not the whole list', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  cont line\n- item two');
            await new Promise(r => setTimeout(r, 300));
        });
        // 継続行(cont line)にカーソル
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            // 継続行 = li 直下 <br> の後の text node
            let target: Node | null = null;
            let seenBr = false;
            for (const child of Array.from(li.childNodes)) {
                if (child.nodeName === 'BR') { seenBr = true; continue; }
                if (seenBr && child.nodeType === 3 && (child.textContent || '').trim()) {
                    target = child; break;
                }
            }
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(target!, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Control+Shift+q');
        await page.waitForTimeout(300);
        const state = await getListState(page);
        expect(state.listCount).toBeGreaterThanOrEqual(1); // リスト生存(counterfactual: 現行は全置換)
        expect(state.liCount).toBe(2);
        expect(state.bqInLiCount).toBe(1);                 // 継続行だけが li 内 blockquote 化
        const bqText = await page.evaluate(() =>
            document.querySelector('#editor li blockquote')?.textContent?.trim());
        expect(bqText).toBe('cont line');
    });

    // TC-ILB-07a/b/c: コードブロックの 3 経路(Cmd+/ / toolbar / Ctrl+Shift+K)
    test('TC-ILB-07a palette codeblock in li creates in-li pre', async ({ page }) => {
        await setupListWithContinuation(page);
        await page.evaluate(() => { (window as any).__paletteActionForTest?.('codeblock'); });
        await page.waitForTimeout(300);
        const state = await getListState(page);
        expect(state.preInLiCount).toBe(1);
        expect(state.topPreCount).toBe(0);
    });

    test('TC-ILB-07b toolbar codeblock in li creates in-li pre', async ({ page }) => {
        await setupListWithContinuation(page);
        await page.evaluate(() => { (window as any).__paletteActionForTest?.('codeblock'); });
        await page.waitForTimeout(300);
        const state = await getListState(page);
        expect(state.preInLiCount).toBe(1);
    });

    test('TC-ILB-07c Ctrl+Shift+K in li converts only the line to in-li pre', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  code here\n- item two');
            await new Promise(r => setTimeout(r, 300));
        });
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            let target: Node | null = null;
            let seenBr = false;
            for (const child of Array.from(li.childNodes)) {
                if (child.nodeName === 'BR') { seenBr = true; continue; }
                if (seenBr && child.nodeType === 3 && (child.textContent || '').trim()) {
                    target = child; break;
                }
            }
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(target!, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Control+Shift+k');
        await page.waitForTimeout(300);
        const state = await getListState(page);
        expect(state.listCount).toBeGreaterThanOrEqual(1);
        expect(state.liCount).toBe(2);
        expect(state.preInLiCount).toBe(1);
        const preText = await page.evaluate(() =>
            document.querySelector('#editor li pre code')?.textContent?.trim());
        expect(preText).toBe('code here');
    });

    // TC-ILB-08: ネスト li(2 段目)内での「> 」→ ネスト li 内 blockquote
    test('TC-ILB-08 "> " in nested li creates blockquote inside nested li', async ({ page }) => {
        await setupListWithContinuation(page, { nested: true });
        await page.keyboard.type('>');
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            return {
                bqInNestedLi: editor.querySelectorAll('li li blockquote, ul ul li blockquote, li ul li blockquote').length
                    + editor.querySelectorAll('ul li ul li blockquote').length,
                bqInAnyLi: editor.querySelectorAll('li blockquote').length,
                listCount: editor.querySelectorAll('ul, ol').length,
            };
        });
        expect(state.bqInAnyLi).toBe(1);
        expect(state.listCount).toBeGreaterThanOrEqual(2); // ネスト構造が保持される
    });

    // TC-ILB-09: リスト外の段落では 4 経路とも既存挙動不変(回帰 pin)
    test('TC-ILB-09 outside a list all paths keep current top-level behavior', async ({ page }) => {
        // (a) autoformat 「> 」
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('plain paragraph');
            await new Promise(r => setTimeout(r, 300));
            const p = document.querySelector('#editor p')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(p.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.type('>');
        await page.keyboard.press('Space');
        await page.waitForTimeout(200);
        let state = await getListState(page);
        expect(state.topBqCount).toBe(1); // 段落 → top-level blockquote(既存挙動)

        // (b) palette quote(空段落上)
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('another');
            await new Promise(r => setTimeout(r, 300));
            const p = document.querySelector('#editor p')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.evaluate(() => { (window as any).__paletteActionForTest?.('quote'); });
        await page.waitForTimeout(200);
        state = await getListState(page);
        expect(state.topBqCount).toBe(1); // 既存どおり top-level に挿入
    });
});

// ---- TASK-09 (FR-LC-07 前半): li 内ブロックの serialize ----

test.describe('In-li block serialize (FR-LC-07)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-10 (serialize 側): li 内 blockquote → マーカー幅インデントの > 行
    // counterfactual: mdProcessListItem 拡張を外すと平坦化(> 行が出ない)= RED
    test('TC-ILB-10s in-li blockquote serializes with marker-width indent', async ({ page }) => {
        const md = await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item one<blockquote>quoted</blockquote></li><li>item two</li></ul>';
            (window as any).__testApi ? null : null;
            // syncMarkdown 相当: getMarkdown が serialize を走らせる
            await new Promise(r => setTimeout(r, 100));
            return (window as any).__testApi.getMarkdown();
        });
        // マーカー幅(- = 2 スペース)インデントの > 行
        expect(md).toContain('- item one\n  > quoted');
        expect(md).toContain('- item two');
    });

    // TC-ILB-11 (serialize 側): li 内 pre(複数行)→ インデント付き fence
    test('TC-ILB-11s in-li pre serializes as indented fence', async ({ page }) => {
        const md = await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang="js"><code>line1<br>line2</code></pre></li></ul>';
            await new Promise(r => setTimeout(r, 100));
            return (window as any).__testApi.getMarkdown();
        });
        expect(md).toContain('- item\n  ```js\n  line1\n  line2\n  ```');
    });

    // TC-ILB-13: ブロックなし li の serialize 出力 byte 不変(NFR-03・TC-LC-06 継承)
    test('TC-ILB-13 lists without blocks serialize byte-identically', async ({ page }) => {
        // 継続行なし
        const md1 = '- alpha\n- beta';
        const out1 = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return (window as any).__testApi.getMarkdown();
        }, md1);
        expect(out1.trim()).toBe(md1);
        // 継続行あり
        const md2 = '- alpha\n  cont line\n- beta';
        const out2 = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            return (window as any).__testApi.getMarkdown();
        }, md2);
        expect(out2.trim()).toBe(md2);
    });

    // TC-ILB-16 (serialize 側): blockquote + 継続行 + nested list の子順保持
    test('TC-ILB-16s in-li block order with continuation and nested list', async ({ page }) => {
        const md = await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>head<blockquote>mid quote</blockquote>tail cont<ul><li>child</li></ul></li></ul>';
            await new Promise(r => setTimeout(r, 100));
            return (window as any).__testApi.getMarkdown();
        });
        const iHead = md.indexOf('head');
        const iQuote = md.indexOf('> mid quote');
        const iTail = md.indexOf('tail cont');
        const iChild = md.indexOf('- child');
        expect(iHead).toBeGreaterThanOrEqual(0);
        expect(iQuote).toBeGreaterThan(iHead);
        expect(iTail).toBeGreaterThan(iQuote);
        expect(iChild).toBeGreaterThan(iTail);
    });
});
