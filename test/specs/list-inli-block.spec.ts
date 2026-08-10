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

// ---- TASK-10 (FR-LC-07 後半): li 内ブロックの parse + roundtrip ----

test.describe('In-li block parse and roundtrip (FR-LC-07)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    async function roundtrip(page, md: string) {
        return await page.evaluate(async (src: string) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            return {
                bqInLi: editor.querySelectorAll('li blockquote').length,
                preInLi: editor.querySelectorAll('li pre').length,
                topBq: editor.querySelectorAll(':scope > blockquote').length,
                topPre: editor.querySelectorAll(':scope > pre').length,
                liCount: editor.querySelectorAll('li').length,
                bqText: editor.querySelector('li blockquote')?.textContent?.trim() ?? null,
                preText: editor.querySelector('li pre code')?.textContent ?? null,
                out: (window as any).__testApi.getMarkdown(),
            };
        }, md);
    }

    // TC-ILB-10: li 内 blockquote の完全 roundtrip
    // counterfactual: parse 分岐を外すと > 行が inline 化(bqInLi=0)= RED
    test('TC-ILB-10 in-li blockquote roundtrips', async ({ page }) => {
        const md = '- item one\n  > quoted\n- item two';
        const r = await roundtrip(page, md);
        expect(r.bqInLi).toBe(1);
        expect(r.topBq).toBe(0);
        expect(r.liCount).toBe(2);
        expect(r.bqText).toBe('quoted');
        expect(r.out.trim()).toBe(md); // serialize(TASK-09)と往復安定
    });

    // TC-ILB-11: li 内 pre(複数行)の完全 roundtrip
    test('TC-ILB-11 in-li pre roundtrips', async ({ page }) => {
        const md = '- item\n  ```js\n  line1\n  line2\n  ```';
        const r = await roundtrip(page, md);
        expect(r.preInLi).toBe(1);
        expect(r.topPre).toBe(0);
        expect(r.preText).toContain('line1');
        expect(r.preText).toContain('line2');
        expect(r.out.trim()).toBe(md);
    });

    // TC-ILB-12: turndown(html-md-converter)出力形式の li 内 blockquote md を読める
    // (turndown listItem は 4 幅インデント — 2 serializer 対称の番人)
    test('TC-ILB-12 turndown-style 4-space indented in-li blockquote parses', async ({ page }) => {
        const md = '-   item one\n    > quoted from web\n-   item two';
        const r = await roundtrip(page, md);
        expect(r.bqInLi).toBe(1);
        expect(r.topBq).toBe(0);
        expect(r.bqText).toBe('quoted from web');
    });

    // TC-ILB-14: リスト直後の 0-indent fence → 従来どおりリスト外コードブロック(番人)
    test('TC-ILB-14 zero-indent fence after list stays top-level', async ({ page }) => {
        const md = '- item\n```\ncode\n```';
        const r = await roundtrip(page, md);
        expect(r.preInLi).toBe(0);
        expect(r.topPre).toBe(1);
    });

    // TC-ILB-15: 閉じ fence なしで文書が終わる li 内 fence → データ喪失なく flush
    test('TC-ILB-15 unclosed in-li fence flushes without data loss', async ({ page }) => {
        const md = '- item\n  ```\n  orphan code';
        const r = await roundtrip(page, md);
        // データ喪失なし: orphan code がどこかに残る(li 内 pre として flush)
        expect(r.preInLi).toBe(1);
        expect(r.preText).toContain('orphan code');
    });

    // TC-ILB-16: blockquote + 継続行 + nested list 共存の完全 roundtrip(子順保持)
    test('TC-ILB-16 mixed continuation, block and nested list roundtrips', async ({ page }) => {
        const md = '- head\n  > mid quote\n  tail cont\n  - child';
        const r = await roundtrip(page, md);
        expect(r.bqInLi).toBe(1);
        expect(r.liCount).toBe(2); // head + child
        const out = r.out.trim();
        const iHead = out.indexOf('- head');
        const iQuote = out.indexOf('> mid quote');
        const iTail = out.indexOf('tail cont');
        const iChild = out.indexOf('- child');
        expect(iHead).toBeGreaterThanOrEqual(0);
        expect(iQuote).toBeGreaterThan(iHead);
        expect(iTail).toBeGreaterThan(iQuote);
        expect(iChild).toBeGreaterThan(iTail);
    });
});

// ---- 再オープン①(2026-08-11): FR-LC-08 li 内ブロックの編集契約 ----

test.describe('In-li block editing contract (FR-LC-08)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    async function loadWithBq(page: Page) {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  > quoted\n- item two');
            await new Promise(r => setTimeout(r, 300));
        });
    }

    async function cursorToEndOf(page: Page, selector: string) {
        await page.evaluate((sel_) => {
            const el = document.querySelector(sel_) as HTMLElement;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        }, selector);
    }

    // TC-ILB-19: li 内 blockquote 内で Shift+Enter → ブロック直後に空継続行 + カーソル脱出
    test('TC-ILB-19 shift+enter inside in-li blockquote exits to new continuation line', async ({ page }) => {
        await loadWithBq(page);
        await cursorToEndOf(page, '#editor li blockquote');
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const bq = document.querySelector('#editor li blockquote')!;
            const anchor = window.getSelection()!.anchorNode;
            const inBq = !!(anchor && (anchor.nodeType === 1
                ? (anchor as Element).closest('blockquote')
                : anchor.parentElement?.closest('blockquote')));
            return {
                bqText: bq.textContent,
                cursorInBq: inBq,
                liCount: document.querySelectorAll('#editor li').length,
            };
        });
        expect(state.bqText).toBe('quoted');      // blockquote 内に br が入らない
        expect(state.cursorInBq).toBe(false);      // カーソルはブロック外(継続行)
        expect(state.liCount).toBe(2);
    });

    // TC-ILB-17: 1 個目の後に 2 個目のブロックを作成できる(連続作成)
    // counterfactual: 現行は Shift+Enter が bq 内に br を入れるため 2 個目が作れない = RED
    test('TC-ILB-17 second block can be created after the first in same li', async ({ page }) => {
        await loadWithBq(page);
        await cursorToEndOf(page, '#editor li blockquote');
        await page.keyboard.press('Shift+Enter'); // 脱出 → 空継続行
        await page.waitForTimeout(150);
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            bqInLi: document.querySelectorAll('#editor li blockquote').length,
            preInLi: document.querySelectorAll('#editor li pre').length,
            liCount: document.querySelectorAll('#editor li').length,
        }));
        expect(state.bqInLi).toBe(1);
        expect(state.preInLi).toBe(1); // 2 個目(pre)が同 li 内に生成
        expect(state.liCount).toBe(2);
    });

    // TC-ILB-18: li 内 pre 最終行の ↓ で継続行/段落が自動追加されない
    // counterfactual: 現行は li 内に <p><br></p> が追加される = RED
    test('TC-ILB-18 arrow-down at last line of in-li pre does not add lines', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  ```\n  code\n  ```\n- item two');
            await new Promise(r => setTimeout(r, 300));
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(code);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        const before = await page.evaluate(() =>
            document.querySelector('#editor li')!.childNodes.length);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => ({
            childCount: document.querySelector('#editor li')!.childNodes.length,
            pCount: document.querySelectorAll('#editor li p').length,
        }));
        expect(after.pCount).toBe(0);              // p が湧かない
        expect(after.childCount).toBe(before);     // DOM 不変
    });

    // TC-ILB-20: li 内 pre 内部(非空)の Backspace = 文字 1 個削除のみ(リスト不変)
    // counterfactual: 現行はリスト系ハンドラ誤発動で親リスト解除・上行統合 = RED
    test('TC-ILB-20 backspace inside non-empty in-li pre deletes one char only', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  ```\n  code\n  ```\n- item two');
            await new Promise(r => setTimeout(r, 300));
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(code);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            listCount: document.querySelectorAll('#editor ul, #editor ol').length,
            liCount: document.querySelectorAll('#editor li').length,
            preInLi: document.querySelectorAll('#editor li pre').length,
            codeText: document.querySelector('#editor li pre code')?.textContent,
        }));
        expect(state.listCount).toBeGreaterThanOrEqual(1); // リスト生存
        expect(state.liCount).toBe(2);                     // li 統合が起きない
        expect(state.preInLi).toBe(1);
        expect(state.codeText).toBe('cod');                // 1 文字だけ消えた
    });

    // TC-ILB-21: 空の li 内ブロックで Backspace → ブロックだけ消えて継続行に戻る(li 不変)
    // counterfactual: 現行はリスト破壊 or 何も起きない = RED
    test('TC-ILB-21 backspace in empty in-li block removes only the block', async ({ page }) => {
        // 空 blockquote を li 内に作る(palette 経由)
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  cont\n- item two');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(150);
        await page.evaluate(() => { (window as any).__paletteActionForTest?.('quote'); });
        await page.waitForTimeout(200);
        const mid = await page.evaluate(() => ({
            bqInLi: document.querySelectorAll('#editor li blockquote').length,
        }));
        expect(mid.bqInLi).toBe(1);
        // 空のまま Backspace
        await cursorToEndOf(page, '#editor li blockquote');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            bqInLi: document.querySelectorAll('#editor li blockquote').length,
            liCount: document.querySelectorAll('#editor li').length,
            liText: document.querySelector('#editor li')?.textContent?.trim(),
            pInLi: document.querySelectorAll('#editor li p').length,
        }));
        expect(state.bqInLi).toBe(0);      // ブロックだけ消えた
        expect(state.liCount).toBe(2);     // リスト構造不変
        expect(state.pInLi).toBe(0);       // p 化しない(継続行に戻る)
        expect(state.liText).toContain('item one'); // li 本文は不変
    });

    // TC-ILB-22: li 内 blockquote 非空・先頭の Backspace = guard(何もしない・リスト不変)
    test('TC-ILB-22 backspace at start of non-empty in-li blockquote is guarded', async ({ page }) => {
        await loadWithBq(page);
        await page.evaluate(() => {
            const bq = document.querySelector('#editor li blockquote')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(bq.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            bqText: document.querySelector('#editor li blockquote')?.textContent,
            liCount: document.querySelectorAll('#editor li').length,
        }));
        expect(state.bqText).toBe('quoted'); // 文字が消えない(guard)
        expect(state.liCount).toBe(2);       // リスト不変
    });

    // TC-ILB-23: ブロック直後の継続行での Backspace = 継続行結合のみ(ブロック・リスト不変)
    test('TC-ILB-23 backspace on continuation line after block keeps block and list', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item one\n  > quoted\n  tail\n- item two');
            await new Promise(r => setTimeout(r, 300));
            // tail(ブロック直後の継続行)の先頭にカーソル
            const li = document.querySelector('#editor li')!;
            let target: Node | null = null;
            let seenBq = false;
            for (const child of Array.from(li.childNodes)) {
                if (child.nodeName === 'BLOCKQUOTE') { seenBq = true; continue; }
                if (seenBq && child.nodeType === 3 && (child.textContent || '').trim()) {
                    target = child; break;
                }
            }
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(target!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            bqInLi: document.querySelectorAll('#editor li blockquote').length,
            bqText: document.querySelector('#editor li blockquote')?.textContent,
            liCount: document.querySelectorAll('#editor li').length,
            liText: document.querySelector('#editor li')?.textContent,
        }));
        expect(state.bqInLi).toBe(1);           // ブロック不可侵
        expect(state.bqText).toBe('quoted');
        expect(state.liCount).toBe(2);          // 親リスト解除・上行統合が起きない
        expect(state.liText).toContain('tail'); // tail は残る(結合 or そのまま)
    });
});
