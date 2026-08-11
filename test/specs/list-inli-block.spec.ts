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

    // TC-ILB-23(再オープン③で仕様改訂 = rc.3 バグ 7 のユーザー裁定): ブロック直付き行の
    // 行頭 Backspace = 自行テキストをブロック末尾へ統合 + カーソル移動(リスト構造は不変)。
    // 旧仕様(結合のみ・ブロック不可侵)は TC-ILB-34 と統一(test_update: 要件改訂追随)
    test('TC-ILB-23 backspace on line after block merges into block, list intact', async ({ page }) => {
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
        }));
        expect(state.bqInLi).toBe(1);
        expect(state.bqText).toBe('quotedtail'); // 自行テキストがブロック末尾へ統合
        expect(state.liCount).toBe(2);           // 親リスト解除・上行統合は起きない
    });
});

// ---- 再オープン②(2026-08-11 rc.2 手動テスト 4 バグ) ----

test.describe('Continuation line and in-li block navigation fixes (re-open 2)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-25 (バグ 1): 継続行先頭の Backspace = 行結合のみ(li が親 li に統合されない)
    // ブロック無関係の一般バグ。counterfactual: NONEMPTY_LI_START 誤発動で li 統合 = RED
    test('TC-ILB-25 backspace at continuation line start joins lines, not lis', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- parent\n  - child\n    cont');
            await new Promise(r => setTimeout(r, 300));
            // child li の継続行 cont の先頭にカーソル
            const lis = document.querySelectorAll('#editor li');
            const childLi = lis[1];
            let target: Node | null = null;
            let seenBr = false;
            for (const n of Array.from(childLi.childNodes)) {
                if (n.nodeName === 'BR') { seenBr = true; continue; }
                if (seenBr && n.nodeType === 3 && (n.textContent || '').trim()) { target = n; break; }
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
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            return {
                liCount: lis.length,
                childText: lis[1]?.textContent?.trim(),
                parentDirectText: Array.from(lis[0]?.childNodes || [])
                    .filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim(),
            };
        });
        expect(state.liCount).toBe(2);                    // li 統合が起きない
        expect(state.childText).toBe('childcont');        // 行結合(br 除去)
        expect(state.parentDirectText).toBe('parent');    // 親 li 不変
    });

    // TC-ILB-26 (バグ 2): li 内ブロックの隣接行から矢印で進入(素通りしない)
    test('TC-ILB-26 arrows enter in-li block from adjacent lines', async ({ page }) => {
        // ↓: ブロック直上の行から
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  line\n  ```\n  code\n  ```\n- two');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            // line 継続行(pre の直前の text node)にカーソル
            let target: Node | null = null;
            for (const n of Array.from(li.childNodes)) {
                if (n.nodeType === 3 && (n.textContent || '').includes('line')) { target = n; }
            }
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(target!, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        const down = await page.evaluate(() => {
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return { inPre: !!el?.closest('pre') };
        });
        expect(down.inPre).toBe(true); // 素通りせず pre に進入

        // ↑: ブロック直下の行から
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  ```\n  code\n  ```\n  after\n- two');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            let target: Node | null = null;
            for (const n of Array.from(li.childNodes)) {
                if (n.nodeType === 3 && (n.textContent || '').includes('after')) { target = n; }
            }
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(target!, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(300);
        const up = await page.evaluate(() => {
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return { inPre: !!el?.closest('pre') };
        });
        expect(up.inPre).toBe(true);
    });

    // TC-ILB-27 (バグ 3): li 内ブロック内の Shift+Enter は 1 行だけ追加
    // counterfactual: 現行は 2 個目の br で 2 行追加 = RED
    test('TC-ILB-27 shift+enter in in-li block adds exactly one line', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  > quoted\n- two');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li blockquote') as HTMLElement;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(bq);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            let brAfterBq = 0;
            let seenBq = false;
            for (const n of Array.from(li.childNodes)) {
                if (n.nodeName === 'BLOCKQUOTE') { seenBq = true; continue; }
                if (seenBq && n.nodeName === 'BR') brAfterBq++;
            }
            return { brAfterBq };
        });
        expect(state.brAfterBq).toBe(1); // 1 行だけ(2 行にならない)
    });

    // TC-ILB-28 (バグ 4): ブロック直下の空行先頭の Backspace = 行を消してブロック末尾へ
    // counterfactual: 現行は no-op = RED
    test('TC-ILB-28 backspace on line after block removes line and enters block end', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  > quoted\n- two');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li blockquote') as HTMLElement;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(bq);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter'); // 空行を作って脱出
        await page.waitForTimeout(200);
        await page.keyboard.press('Backspace');   // その空行の先頭で bk
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            let brAfterBq = 0;
            let seenBq = false;
            for (const n of Array.from(li.childNodes)) {
                if (n.nodeName === 'BLOCKQUOTE') { seenBq = true; continue; }
                if (seenBq && n.nodeName === 'BR') brAfterBq++;
            }
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return {
                brAfterBq,
                cursorInBq: !!el?.closest('blockquote'),
                bqText: document.querySelector('#editor li blockquote')?.textContent,
                liCount: document.querySelectorAll('#editor li').length,
            };
        });
        expect(state.brAfterBq).toBe(0);     // 空行が消えた
        expect(state.cursorInBq).toBe(true); // カーソルはブロック末尾
        expect(state.bqText).toBe('quoted'); // ブロック内容不変
        expect(state.liCount).toBe(2);
    });
});

// ---- 再オープン③(2026-08-11 rc.3 手動テスト 8 バグ) ----
// 行モデル(実測 2026-08-11): ブロック(pre/blockquote)の「前」の <br> は行を変えない(無害)が、
// 「後ろ」の <br> は空行を 1 個作る。空行のカーソル正規位置 = その <br> の直前。

test.describe('In-li block line-model fixes (re-open 3)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    async function caretLineTop(page: Page) {
        return await page.evaluate(() => {
            const sel = window.getSelection()!;
            const range = sel.getRangeAt(0).cloneRange();
            let rect = range.getBoundingClientRect();
            if (rect.height === 0) {
                const span = document.createElement('span');
                span.textContent = '​';
                range.insertNode(span);
                rect = span.getBoundingClientRect();
                span.remove();
            }
            return Math.round(rect.top);
        });
    }

    // (1) TC-ILB-29: fence 作成でブロック下に余計な空行が入らない
    test('TC-ILB-29 fence creation leaves no stray blank line below block', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  above\n  below');
            await new Promise(r => setTimeout(r, 300));
            // above 行の末尾にカーソル → Shift+Enter で間に空行 → ``` 入力
            const li = document.querySelector('#editor li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('above'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(150);
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            // pre の直後に BR が無い(= below 行の上に空行が無い)
            const pre = li.querySelector('pre')!;
            let n = pre.nextSibling;
            const afterKinds: string[] = [];
            while (n) { afterKinds.push(n.nodeType === 3 ? 'text:' + n.textContent!.trim().substring(0, 8) : n.nodeName); n = n.nextSibling; }
            return { afterKinds };
        });
        // pre の直後は below テキスト(BR が挟まらない)
        expect(state.afterKinds[0]).toBe('text:below');
    });

    // (5) TC-ILB-30: Shift+Enter 後のカーソルは空行(次の文字行ではない)
    test('TC-ILB-30 shift+enter caret lands on the blank line', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  ```\n  code\n  ```\n  after');
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
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const pre = li.querySelector('pre')!;
            const sel = window.getSelection()!;
            const r = sel.getRangeAt(0);
            // カーソルは li 直下・pre 直後の BR の「前」(= 空行)にある
            const idxBr = Array.from(li.childNodes).indexOf(pre) + 1;
            const brNode = li.childNodes[idxBr];
            return {
                brIsNext: brNode?.nodeName === 'BR',
                anchorIsLi: r.startContainer === li,
                offsetAtBr: r.startOffset === idxBr,
            };
        });
        expect(state.brIsNext).toBe(true);
        expect(state.anchorIsLi).toBe(true);
        expect(state.offsetAtBr).toBe(true); // br の前 = 空行(文字行頭ではない)
        // タイプすると空行に文字が入る(after 行に入らない)
        await page.keyboard.type('x');
        await page.waitForTimeout(150);
        const typed = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const pre = li.querySelector('pre')!;
            let n = pre.nextSibling;
            return n && n.nodeType === 3 ? n.textContent : String(n?.nodeName);
        });
        expect(typed).toBe('x');
    });

    // (4)+(2) TC-ILB-31: 空行を挟んだ行から ↑ は空行に止まる(ブロックに入らない)/
    // ブロック直付きの行からは進入する(安定)
    test('TC-ILB-31 arrow-up stops at blank line; enters block only when adjacent', async ({ page }) => {
        // 空行あり: pre + br(空行) + text → text から ↑ = 空行へ(pre に入らない)
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code>x</code></pre><br>after</li></ul>';
            const li = editor.querySelector('li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('after'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(200);
        const withBlank = await page.evaluate(() => {
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return { inPre: !!el?.closest('pre') };
        });
        expect(withBlank.inPre).toBe(false); // 空行に止まる(pre 進入しない)

        // 直付き: pre + text → text から ↑ = pre 末尾へ進入
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code>x</code></pre>after</li></ul>';
            const li = editor.querySelector('li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('after'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 2);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(200);
        const adjacent = await page.evaluate(() => {
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return { inPre: !!el?.closest('pre') };
        });
        expect(adjacent.inPre).toBe(true);
    });

    // (3) TC-ILB-32: ブロック内最終行から ↓ で必ず出られる(直後の行へ)
    test('TC-ILB-32 arrow-down always exits block to the next line', async ({ page }) => {
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang="" data-mode="edit"><code contenteditable="true">x</code></pre>after</li></ul>';
            const code = editor.querySelector('code') as HTMLElement;
            code.focus();
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(code);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return {
                inPre: !!el?.closest('pre'),
                text: anchor?.textContent?.substring(0, 8),
            };
        });
        expect(state.inPre).toBe(false); // 出られる
    });

    // (6) TC-ILB-33: 文字行頭・直前が空行(br)の bk = br 除去のみ・カーソルは文字行頭に留まる
    test('TC-ILB-33 backspace joins blank line, caret stays at text line start', async ({ page }) => {
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code>x</code></pre><br>after</li></ul>';
            const li = editor.querySelector('li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('after'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return {
                brCount: Array.from(li.childNodes).filter(n => n.nodeName === 'BR').length,
                inPre: !!el?.closest('pre'),
                anchorText: anchor?.textContent?.substring(0, 8),
                preAlive: !!li.querySelector('pre'),
            };
        });
        expect(state.brCount).toBe(0);          // 空行が消えた
        expect(state.preAlive).toBe(true);
        expect(state.inPre).toBe(false);        // ブロック末尾へ行かない
        expect(state.anchorText).toContain('after'); // カーソルは文字行頭のまま
    });

    // (7) TC-ILB-34: ブロック直付きの文字行頭の bk = 自行テキストをブロック末尾へ統合 + カーソル移動
    test('TC-ILB-34 backspace at line directly below block merges text into block', async ({ page }) => {
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code>x</code></pre>after</li><li>two</li></ul>';
            const li = editor.querySelector('li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('after'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const code = li.querySelector('pre code')!;
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return {
                codeText: code.textContent,
                inPre: !!el?.closest('pre'),
                liCount: document.querySelectorAll('#editor li').length,
                liDirectText: Array.from(li.childNodes).filter(n => n.nodeType === 3)
                    .map(n => n.textContent).join(''),
            };
        });
        expect(state.codeText).toContain('after'); // テキストがブロック末尾に統合
        expect(state.inPre).toBe(true);            // カーソルも移動
        expect(state.liCount).toBe(2);             // 親リスト統合が起きない
        expect(state.liDirectText).not.toContain('after'); // 元の行は消えた
    });

    // (8) TC-ILB-35: 空行(ブロック直後)での bk = 空行だけ消してブロック末尾へ(ブロックは消えない)
    test('TC-ILB-35 backspace on blank line after block removes line, keeps block', async ({ page }) => {
        await page.evaluate(async () => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code>xyz</code></pre><br>after</li></ul>';
            const li = editor.querySelector('li')!;
            // 空行 = pre 直後の br の「前」にカーソル
            const pre = li.querySelector('pre')!;
            const idxBr = Array.from(li.childNodes).indexOf(pre) + 1;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li, idxBr);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const anchor = window.getSelection()!.anchorNode;
            const el = anchor && (anchor.nodeType === 1 ? anchor as Element : anchor.parentElement);
            return {
                preAlive: !!li.querySelector('pre'),
                codeText: li.querySelector('pre code')?.textContent,
                brCount: Array.from(li.childNodes).filter(n => n.nodeName === 'BR').length,
                inPre: !!el?.closest('pre'),
            };
        });
        expect(state.preAlive).toBe(true);   // ブロックは消えない(counterfactual: default だと pre 削除)
        expect(state.codeText).toBe('xyz');
        expect(state.brCount).toBe(0);       // 空行は消えた
        expect(state.inPre).toBe(true);      // カーソルはブロック末尾へ
    });
});

// ---- 再オープン④(2026-08-11 rc.4 手動テスト 5 バグ) ----

test.describe('In-li block enter/arrow/cursor fixes (re-open 4)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // (3→再オープン⑤で仕様確定) TC-ILB-36: 後続なしのブロック内最終行で ↓ =
    // 空継続行を作って脱出(旧 no-op はユーザー期待に反した — rc.5 バグ 3)
    test('TC-ILB-36 arrow-down with nothing after creates blank line and exits', async ({ page }) => {
        await page.evaluate(() => {
            document.getElementById('editor')!.innerHTML =
                '<ul><li>item<pre data-lang="" data-mode="edit"><code contenteditable="true">x</code></pre></li></ul>';
            const code = document.querySelector('#editor code') as HTMLElement;
            code.focus();
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(code);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const li = document.querySelector('#editor li')!;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                lost: false,
                inPre: !!el?.closest('pre'),
                brAdded: Array.from(li.childNodes).some(n => n.nodeName === 'BR'),
                inLi: !!el?.closest('li'),
            };
        });
        expect(state.lost).toBe(false);
        expect(state.inPre).toBe(false);  // ブロックから出る
        expect(state.inLi).toBe(true);    // li 内の空継続行にいる(カーソル消失しない)
        expect(state.brAdded).toBe(true); // 空継続行が作られた
    });

    // (1) TC-ILB-37: 空白 text node が挟まっても隣接判定が働く(↓ でブロック進入)
    test('TC-ILB-37 arrow-down enters block across whitespace text nodes', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>sdsd<br>sdsdsa'
                + '<pre data-lang=""><code contenteditable="false">aadad</code></pre>ああ</li></ul>';
            // 実編集で生まれる空白 text node を意図的に挿入
            const li = editor.querySelector('li')!;
            const pre = li.querySelector('pre')!;
            li.insertBefore(document.createTextNode(''), pre);
            li.insertBefore(document.createTextNode(' '), pre);
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('sdsdsa'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 3);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const a = window.getSelection()!.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return { inPre: !!el?.closest('pre'), inLi: !!el?.closest('li') };
        });
        expect(state.inPre).toBe(true); // 素通り・document 末尾ジャンプしない
    });

    // (2) TC-ILB-38: 空白 text node が挟まってもブロック直下行の bk が正しく動く
    test('TC-ILB-38 backspace below block works across whitespace text nodes', async ({ page }) => {
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>item<pre data-lang=""><code contenteditable="false">xyz</code></pre>after</li><li>two</li></ul>';
            const li = editor.querySelector('li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('after'))!;
            // pre と after の間に空白 text node
            li.insertBefore(document.createTextNode(''), t);
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => ({
            codeText: document.querySelector('#editor pre code')?.textContent,
            liCount: document.querySelectorAll('#editor li').length,
        }));
        expect(state.codeText).toContain('after'); // ブロック末尾へ統合
        expect(state.liCount).toBe(2);             // リスト不変
    });

    // (4) TC-ILB-39: ブロック持ち li の 1 行目末尾で Enter → li 全体の後ろに新 li(分割しない)
    test('TC-ILB-39 enter on first line of block-bearing li appends new li after item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsd\n  sdsdsa\n  ```\n  aadad\n  ```\n  ああ');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            const t = li.firstChild!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            const li0 = lis[0];
            return {
                liCount: lis.length,
                li0HasPre: !!li0.querySelector('pre'),
                li0Text: li0.textContent?.substring(0, 30),
                li1Empty: lis[1] ? (lis[1].textContent || '').trim() === '' : null,
                li1HasPre: lis[1] ? !!lis[1].querySelector('pre') : null,
            };
        });
        expect(state.liCount).toBe(2);
        expect(state.li0HasPre).toBe(true);     // 元 li は分割されない(ブロックも継続行も残る)
        expect(state.li0Text).toContain('sdsd');
        expect(state.li1Empty).toBe(true);      // 新 li は空で li 全体の後ろ
        expect(state.li1HasPre).toBe(false);
    });

    // (5→再オープン⑤で仕様確定) TC-ILB-40: ブロック持ち li の継続行 Enter =
    // li 全体の後ろに空リスト行を追加(1 行目 Enter の TC-ILB-39 と同挙動に統一。
    // rc.5 バグ 1/2 のユーザー裁定 — 旧「項目末尾に空継続行」は誤解釈だった)
    test('TC-ILB-40 enter on continuation line of block-bearing li appends new li after item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsd\n  sdsdsa\n  ```\n  aadad\n  ```');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('sdsdsa'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            const li0 = lis[0];
            const sel = window.getSelection()!;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                liCount: lis.length,
                li0HasPre: !!li0.querySelector('pre'),
                li0Text: li0.textContent?.substring(0, 30),
                li1Empty: lis[1] ? (lis[1].textContent || '').trim() === '' : null,
                cursorInLi1: el?.closest('li') === lis[1],
            };
        });
        expect(state.liCount).toBe(2);          // li 全体の後ろに新リスト行
        expect(state.li0HasPre).toBe(true);     // 元 li は不可侵(ブロック・継続行とも)
        expect(state.li0Text).toContain('sdsdsa');
        expect(state.li1Empty).toBe(true);
        expect(state.cursorInLi1).toBe(true);   // カーソルは新 li
    });
});

// ---- 再オープン⑤(2026-08-11 rc.5 手動テスト 4 バグ) ----

test.describe('In-li block enter placement and arrow exit (re-open 5)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // (1)(2) TC-ILB-41: ブロックより「上」の継続行(2 行目)で Enter → li 全体の後ろに新リスト行
    // (ブロックの下に行が湧いたり、押した行のすぐ下に湧いたりしない)
    test('TC-ILB-41 enter on middle continuation line above block appends li after whole item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsds\n  dsdsdsds\n  sdsdds\n  ```\n  sdsdsd\n  ```\n  sdsd\n- next');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('dsdsdsds'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            const li0 = lis[0];
            const sel = window.getSelection()!;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                liCount: lis.length,
                li0Intact: !!li0.querySelector('pre') && (li0.textContent || '').includes('sdsd'),
                li1Empty: (lis[1].textContent || '').trim() === '',
                li1IsNew: !lis[1].querySelector('pre'),
                cursorInLi1: el?.closest('li') === lis[1],
            };
        });
        expect(state.liCount).toBe(3);       // 元 li + 新 li + next
        expect(state.li0Intact).toBe(true);  // 元 li 不可侵(ブロックも継続行も)
        expect(state.li1Empty).toBe(true);   // 新 li は li 全体の直後
        expect(state.li1IsNew).toBe(true);
        expect(state.cursorInLi1).toBe(true);
    });

    // (4) TC-ILB-42: ブロックの後に何も無い li で、次の li がある場合の ↓ = 次の li 先頭へ
    test('TC-ILB-42 arrow-down exits block to next li when block is last in item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  ```\n  code\n  ```\n- f');
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
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            const a = window.getSelection()!.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                inPre: !!el?.closest('pre'),
                inSecondLi: el?.closest('li') === lis[1],
            };
        });
        expect(state.inPre).toBe(false);     // 出られる
        expect(state.inSecondLi).toBe(true); // 次の li(f)へ
    });
});

// ---- 再オープン⑥(2026-08-11 rc.6 手動テスト 3 バグ) ----

test.describe('In-li block enter-below and cross-element arrows (re-open 6)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // (1) TC-ILB-43: ブロックより「後ろ」の継続行で Enter → li 全体の後ろに新リスト行
    // (押した行のすぐ下に湧かない — TC-ILB-41 のブロック後版)
    test('TC-ILB-43 enter on continuation line below block appends li after whole item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  ```\n  sdsd\n  ```\n  sddadas\n  sdsdsdsd\n- next');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            // ブロック後の 1 個目の継続行(sddadas)の末尾にカーソル
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('sddadas'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            const li0 = lis[0];
            const sel = window.getSelection()!;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                liCount: lis.length,
                li0Intact: !!li0.querySelector('pre')
                    && (li0.textContent || '').includes('sddadas')
                    && (li0.textContent || '').includes('sdsdsdsd'),
                li1Empty: (lis[1].textContent || '').trim() === '',
                cursorInLi1: el?.closest('li') === lis[1],
            };
        });
        expect(state.liCount).toBe(3);       // head(全部入り) + 新 li + next
        expect(state.li0Intact).toBe(true);  // 継続行が li0 に残る(すぐ下に分割されない)
        expect(state.li1Empty).toBe(true);
        expect(state.cursorInLi1).toBe(true);
    });

    // (2) TC-ILB-44: li 末尾ブロックから ↓・次の li なし・リストの後に要素あり → その要素へ
    // (空継続行を勝手に作らない)
    test('TC-ILB-44 arrow-down from last block exits to element after the list', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  ```\n  code\n  ```\n\nparagraph after');
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
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const a = window.getSelection()!.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                brAdded: Array.from(li.childNodes).some(n => n.nodeName === 'BR'),
                inParagraph: !!el?.closest('p'),
                text: el?.closest('p')?.textContent?.substring(0, 12),
            };
        });
        expect(state.brAdded).toBe(false);      // 空継続行を作らない
        expect(state.inParagraph).toBe(true);   // リスト後の(空)段落へ — md の空行由来の <p><br></p> が次の視覚行
    });

    // (3) TC-ILB-45: リスト末尾がブロックの li のとき、次の段落から ↑ → ブロック末尾へ進入
    // (カーソル消失しない)
    test('TC-ILB-45 arrow-up from paragraph enters trailing block of last li', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- item\n  cont\n  ```\n  code\n  ```\n\nparagraph');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const ps = editor.querySelectorAll(':scope > p');
            const p = ps[ps.length - 1];
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(p.firstChild!, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        // md 空行由来の空段落を挟むため ↑ 2 回(1 回目 = 空段落・2 回目 = リスト末尾ブロック)
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(200);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return {
                lost: false,
                inPre: !!el?.closest('pre'),
                inLi: !!el?.closest('li'),
            };
        });
        expect(state.lost).toBe(false);
        expect(state.inPre).toBe(true); // ブロックに入る(BR に落ちてカーソル迷子にならない)
        expect(state.inLi).toBe(true);
    });
});

// ---- 再オープン⑦(2026-08-11 rc.7): ↑/↓ × 隣接要素の全マトリクス ----
// 同一失敗クラス(矢印の隣接判定)の指摘が続いたため、点修正をやめマトリクスで固定する
// (designer_failures 2026-08-09「同一クラス 2 回でマトリクス展開」)。
// 軸: 方向(↑/↓) × 隣接(テキスト行 / 空行 / pre / blockquote) + ブロック組合せ(pre-pre / bq-bq / pre-bq / bq-pre)

test.describe('In-li block arrow matrix (re-open 7)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // ブロック(1 個目)にカーソルを置いて矢印を押し、着地点を返す共通ドライバ
    async function arrowFromBlock(page: Page, liHtml: string, opts: {
        blockIndex: number; dir: 'ArrowUp' | 'ArrowDown'; atLine: 'first' | 'last';
    }) {
        await page.evaluate(({ html, blockIndex }) => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<ul><li>' + html + '</li></ul>';
            const blocks = editor.querySelectorAll('li > pre, li > blockquote');
            const blk = blocks[blockIndex] as HTMLElement;
            const sel = window.getSelection()!;
            const range = document.createRange();
            if (blk.tagName === 'PRE') {
                blk.setAttribute('data-mode', 'edit');
                const code = blk.querySelector('code')!;
                code.setAttribute('contenteditable', 'true');
                (code as HTMLElement).focus();
                range.selectNodeContents(code);
            } else {
                range.selectNodeContents(blk);
            }
            range.collapse((window as any).__collapseToStart);
            sel.removeAllRanges();
            sel.addRange(range);
        }, { html: liHtml, blockIndex: opts.blockIndex });
        await page.evaluate((toStart) => { (window as any).__collapseToStart = toStart; }, opts.atLine === 'first');
        // collapse 適用(再セット)
        await page.evaluate(({ blockIndex, toStart }) => {
            const blocks = document.querySelectorAll('#editor li > pre, #editor li > blockquote');
            const blk = blocks[blockIndex] as HTMLElement;
            const sel = window.getSelection()!;
            const range = document.createRange();
            const target = blk.tagName === 'PRE' ? blk.querySelector('code')! : blk;
            range.selectNodeContents(target);
            range.collapse(toStart);
            sel.removeAllRanges();
            sel.addRange(range);
        }, { blockIndex: opts.blockIndex, toStart: opts.atLine === 'first' });
        await page.keyboard.press(opts.dir);
        await page.waitForTimeout(250);
        return await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            const pre = el?.closest('pre');
            const bq = el?.closest('blockquote');
            const blocks = Array.from(document.querySelectorAll('#editor li > pre, #editor li > blockquote'));
            return {
                lost: false,
                landing: pre ? 'pre' : bq ? 'blockquote' : 'line',
                blockIdx: pre ? blocks.indexOf(pre) : bq ? blocks.indexOf(bq) : -1,
                text: (a?.textContent || '').substring(0, 10),
            };
        });
    }

    const PRE = (t: string) => `<pre data-lang=""><code contenteditable="false">${t}</code></pre>`;
    const BQ = (t: string) => `<blockquote>${t}</blockquote>`;

    // TC-ILB-46: ↑ でブロック直上のテキスト継続行へ(rc.7 バグ 1 の主訴)
    test('TC-ILB-46 up from block first line goes to text line directly above', async ({ page }) => {
        const r = await arrowFromBlock(page, 'head<br>cont1<br>cont2' + PRE('code'), { blockIndex: 0, dir: 'ArrowUp', atLine: 'first' });
        expect(r.landing).toBe('line');
        expect(r.text).toContain('cont2'); // すぐ上の継続行(cont1 や head に飛ばない)
    });

    // TC-ILB-47: pre→pre 連続で ↑(下の pre から上の pre 末尾へ)
    test('TC-ILB-47 up from second pre enters first pre', async ({ page }) => {
        const r = await arrowFromBlock(page, 'head' + PRE('aaa') + PRE('bbb'), { blockIndex: 1, dir: 'ArrowUp', atLine: 'first' });
        expect(r.landing).toBe('pre');
        expect(r.blockIdx).toBe(0);
    });

    // TC-ILB-48: bq→bq 連続で ↓(上の bq から下の bq 先頭へ)
    test('TC-ILB-48 down from first bq enters second bq', async ({ page }) => {
        const r = await arrowFromBlock(page, 'head' + BQ('aaa') + BQ('bbb'), { blockIndex: 0, dir: 'ArrowDown', atLine: 'last' });
        expect(r.landing).toBe('blockquote');
        expect(r.blockIdx).toBe(1);
    });

    // TC-ILB-49: pre→bq 混在で ↓ / bq→pre 混在で ↑
    test('TC-ILB-49 mixed pre/bq adjacency works both directions', async ({ page }) => {
        const down = await arrowFromBlock(page, 'head' + PRE('aaa') + BQ('bbb'), { blockIndex: 0, dir: 'ArrowDown', atLine: 'last' });
        expect(down.landing).toBe('blockquote');
        const up = await arrowFromBlock(page, 'head' + BQ('aaa') + PRE('bbb'), { blockIndex: 1, dir: 'ArrowUp', atLine: 'first' });
        expect(up.landing).toBe('blockquote');
        expect(up.blockIdx).toBe(0);
    });

    // TC-ILB-50: 空行を挟む ↑/↓ は空行に止まる(素通りも進入もしない)
    test('TC-ILB-50 blank line between blocks stops the caret', async ({ page }) => {
        const down = await arrowFromBlock(page, 'head' + PRE('aaa') + '<br><br>tail', { blockIndex: 0, dir: 'ArrowDown', atLine: 'last' });
        expect(down.landing).toBe('line'); // 空行(li 直下)に止まる
        const up = await arrowFromBlock(page, 'head<br><br>' + PRE('aaa'), { blockIndex: 0, dir: 'ArrowUp', atLine: 'first' });
        expect(up.landing).toBe('line');
    });

    // TC-ILB-51: ↓ でブロック直下のテキスト継続行へ(46 の対称)
    test('TC-ILB-51 down from block last line goes to text line directly below', async ({ page }) => {
        const r = await arrowFromBlock(page, 'head' + PRE('code') + 'tail1<br>tail2', { blockIndex: 0, dir: 'ArrowDown', atLine: 'last' });
        expect(r.landing).toBe('line');
        expect(r.text).toContain('tail1');
    });
});

// ---- 再オープン⑧(2026-08-11 rc.8): 画像 × ブロックの矢印マトリクス ----
// 行モデルに「画像行」(IMG は atomic 視覚行・caret は li offset)を追加。

test.describe('In-li image and block arrow matrix (re-open 8)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    const IMG_LI = 'head<br>cont'
        + '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="a">'
        + '<pre data-lang=""><code contenteditable="false">code</code></pre>'
        + '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="b">'
        + '<br>tail';

    async function setup(page: Page) {
        await page.evaluate((html) => {
            document.getElementById('editor')!.innerHTML = '<ul><li>' + html + '</li></ul>';
        }, IMG_LI);
        await page.waitForTimeout(100);
    }

    function landing(page: Page) {
        return page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const r = sel.getRangeAt(0);
            const a = r.startContainer;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            const li = document.querySelector('#editor li')!;
            let atImage: string | null = null;
            if (a === li) {
                const before = r.startOffset > 0 ? li.childNodes[r.startOffset - 1] : null;
                const at = li.childNodes[r.startOffset] || null;
                if (before && before.nodeName === 'IMG') atImage = (before as HTMLElement).getAttribute('alt');
                else if (at && at.nodeName === 'IMG') atImage = (at as HTMLElement).getAttribute('alt');
            }
            return {
                lost: false,
                inPre: !!el?.closest('pre'),
                atImage,
                text: (a.textContent || '').substring(0, 8),
            };
        });
    }

    // (1a) TC-ILB-52: b 画像(ブロック直下)から ↑ → コードブロックに入る(a に飛ばない)
    test('TC-ILB-52 up from image below block enters the block', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const imgs = li.querySelectorAll('img');
            const b = imgs[1];
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(li, Array.prototype.indexOf.call(li.childNodes, b) + 1); // b の直後 = b 画像行
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(250);
        const r = await landing(page);
        expect(r.inPre).toBe(true);
    });

    // (1b) TC-ILB-53: a 画像(ブロック直上)から ↓ → コードブロックに入る(b に飛ばない)
    test('TC-ILB-53 down from image above block enters the block', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const imgs = li.querySelectorAll('img');
            const a = imgs[0];
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(li, Array.prototype.indexOf.call(li.childNodes, a)); // a の直前 = a 画像行
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        const r = await landing(page);
        expect(r.inPre).toBe(true);
    });

    // (2a) TC-ILB-54: ブロック内先頭で ↑ → a 画像行へ(リスト先頭に飛ばない)
    test('TC-ILB-54 up from block first line lands on image a', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(code);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(250);
        const r = await landing(page);
        expect(r.atImage).toBe('a'); // a 画像行に止まる
        expect(r.inPre).toBe(false);
    });

    // (2b) TC-ILB-55: ブロック内末尾で ↓ → b 画像行へ(次のリストに飛ばない)
    test('TC-ILB-55 down from block last line lands on image b', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => {
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(code);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        const r = await landing(page);
        expect(r.atImage).toBe('b');
        expect(r.inPre).toBe(false);
    });

    // blockquote 版: TC-ILB-56(画像 → bq 進入と bq → 画像着地)
    test('TC-ILB-56 blockquote variant of image adjacency', async ({ page }) => {
        await page.evaluate(() => {
            document.getElementById('editor')!.innerHTML = '<ul><li>head<br>cont'
                + '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="a">'
                + '<blockquote>quoted</blockquote>'
                + '<img src="data:image/png;base64,iVBORw0KGgoAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" alt="b">'
                + '<br>tail</li></ul>';
        });
        // a から ↓ → bq に入る
        await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const a = li.querySelectorAll('img')[0];
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(li, Array.prototype.indexOf.call(li.childNodes, a));
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        let state = await page.evaluate(() => {
            const a = window.getSelection()!.anchorNode;
            const el = a && (a.nodeType === 1 ? a as Element : a.parentElement);
            return { inBq: !!el?.closest('blockquote') };
        });
        expect(state.inBq).toBe(true);
        // bq 末尾から ↓ → b 画像行
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        const r2 = await landing(page);
        expect(r2.atImage).toBe('b');
    });
});

// ---- 再オープン⑨(2026-08-11 rc.9): 継続行付き単一 li のコピー&ペースト ----

test.describe('Single-li copy with continuation lines (re-open 9)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    async function copyLi(page: Page) {
        return await page.evaluate(() => {
            const li = document.querySelector('#editor li')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(li);
            sel.removeAllRanges();
            sel.addRange(range);
            const dt = new DataTransfer();
            const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true });
            document.getElementById('editor')!.dispatchEvent(ev);
            return { md: dt.getData('text/x-any-md'), html: dt.getData('text/html') };
        });
    }

    async function pasteIntoEmptyLi(page: Page, md: string, html: string) {
        await page.evaluate(async ({ md, html }) => {
            (window as any).__testApi.setMarkdown('- target\n- other');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            li.innerHTML = '<br>';
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(li, 0);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
            const clipboardData = {
                _data: { 'text/plain': md, 'text/html': html, 'text/x-any-md': md } as Record<string, string>,
                getData: function (t: string) { return this._data[t] || ''; },
                setData: function (t: string, v: string) { this._data[t] = v; },
                items: [],
            };
            const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
            Object.defineProperty(ev, 'clipboardData', { value: clipboardData, configurable: true });
            document.getElementById('editor')!.dispatchEvent(ev);
        }, { md, html });
        await page.waitForTimeout(400);
    }

    // (2) TC-ILB-57: テキスト継続行のみの単一 li 全選択コピー → md がリスト形(マーカー + インデント)
    test('TC-ILB-57 copying single li with text continuations serializes as one list item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsd\n  s d s d\n  sdsd2\n- next');
            await new Promise(r => setTimeout(r, 300));
        });
        const { md } = await copyLi(page);
        // 1 リスト項目 + 継続行 2 本(counterfactual: 旧実装は "sdsd\ns d s d\nsdsd2" のベタ 3 行)
        expect(md).toContain('- sdsd\n  s d s d\n  sdsd2');
    });

    // (2) TC-ILB-58: それを空 li に paste → 単一 li + 継続行として貼り付く(全行 li 化しない)
    test('TC-ILB-58 pasting keeps single li with continuations', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsd\n  s d s d\n  sdsd2\n- next');
            await new Promise(r => setTimeout(r, 300));
        });
        const { md, html } = await copyLi(page);
        await pasteIntoEmptyLi(page, md, html);
        const state = await page.evaluate(() => {
            const lis = document.querySelectorAll('#editor li');
            return {
                liCount: lis.length,
                li0Text: lis[0]?.textContent?.replace(/\s+/g, ' ').trim(),
                li0BrCount: Array.from(lis[0]?.childNodes || []).filter(n => n.nodeName === 'BR').length,
            };
        });
        expect(state.liCount).toBe(2);           // 貼り付け先 + other(行ごとに li 化しない)
        expect(state.li0Text).toContain('sdsd');
        expect(state.li0Text).toContain('s d s d');
        expect(state.li0BrCount).toBeGreaterThanOrEqual(2); // 継続行構造を保持
    });

    // (1) TC-ILB-59: ブロック入り単一 li の全選択コピー → リスト項目 + li 内ブロックの md
    test('TC-ILB-59 copying single li with in-li block serializes as list item with block', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  cont\n  ```\n  code\n  ```\n  tail\n- next');
            await new Promise(r => setTimeout(r, 300));
        });
        const { md } = await copyLi(page);
        expect(md).toContain('- head\n  cont');
        expect(md).toContain('  ```\n  code\n  ```'); // インデント付き fence(li 内ブロック形)
        expect(md).toContain('  tail');
    });

    // (1) TC-ILB-60: それを空 li に paste → li 内ブロック付き項目として貼り付く(段落化しない)
    test('TC-ILB-60 pasting keeps in-li block inside the list item', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  cont\n  ```\n  code\n  ```\n  tail\n- next');
            await new Promise(r => setTimeout(r, 300));
        });
        const { md, html } = await copyLi(page);
        await pasteIntoEmptyLi(page, md, html);
        const state = await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            return {
                liCount: editor.querySelectorAll('li').length,
                preInLi: editor.querySelectorAll('li pre').length,
                topPre: editor.querySelectorAll(':scope > pre').length,
                topP: Array.from(editor.querySelectorAll(':scope > p'))
                    .filter(p => (p.textContent || '').trim() !== '').length,
            };
        });
        expect(state.preInLi).toBe(1);  // ブロックは li 内(counterfactual: 旧実装は段落 + top-level pre)
        expect(state.topPre).toBe(0);
        expect(state.topP).toBe(0);     // 段落化しない
        expect(state.liCount).toBe(2);
    });
});

// ---- 再オープン⑩(2026-08-11 rc.10): undo と空継続行の roundtrip ----
// 機序: 空継続行の serialize 形「(インデントのみの行)」を parse が「空行 = リスト終了」と
// 解釈し roundtrip 不安定。undo は md 文字列 snapshot の再 render なので、この不安定が
// 「undo するとリストが段落に分解される」バグとして露出していた(undo 自体は正常)。

test.describe('Blank continuation roundtrip and undo (re-open 10)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-61: 空継続行(インデント付き空白行)の md が roundtrip 安定
    // counterfactual: 現行 parse は空白行でリストを閉じ、リストが段落分解 = RED
    test('TC-ILB-61 indented blank continuation line roundtrips stably', async ({ page }) => {
        const md = '- sdsds\n  > dada\n  \n  dsds\n- next\n';
        const r = await page.evaluate(async (src) => {
            (window as any).__testApi.setMarkdown(src);
            await new Promise(r_ => setTimeout(r_, 300));
            return {
                md: (window as any).__testApi.getMarkdown(),
                liCount: document.querySelectorAll('#editor li').length,
                topPNonEmpty: Array.from(document.querySelectorAll('#editor > p'))
                    .filter(p_ => (p_.textContent || '').trim() !== '').length,
                bqInLi: document.querySelectorAll('#editor li blockquote').length,
            };
        }, md);
        expect(r.liCount).toBe(2);   // リストが分解されない
        expect(r.bqInLi).toBe(1);    // bq は li 内のまま
        expect(r.topPNonEmpty).toBe(0); // 段落化しない(md 末尾 \n 由来の空 p は既存仕様)
        expect(r.md).toBe(md);       // byte 安定
    });

    // TC-ILB-62: Shift+Enter(空継続行)→ タイプ → Cmd+Z でバグらず直前状態に戻る
    test('TC-ILB-62 undo after typing on blank continuation restores structure', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsds\n  > dada\n  > sdsd\n  dsds\n- next');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li blockquote')!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.selectNodeContents(bq);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('aaa');
        await page.waitForTimeout(600);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            liCount: document.querySelectorAll('#editor li').length,
            bqInLi: document.querySelectorAll('#editor li blockquote').length,
            topP: Array.from(document.querySelectorAll('#editor > p'))
                .filter(p => (p.textContent || '').trim() !== '').length,
            md: (window as any).__testApi.getMarkdown(),
        }));
        expect(state.liCount).toBe(2);   // リスト構造が保たれる(段落分解しない)
        expect(state.bqInLi).toBe(1);    // bq が li 内のまま(「> sds」のテキスト化が起きない)
        expect(state.topP).toBe(0);
        expect(state.md).not.toContain('\n\n> '); // bq が li 外に出ていない
    });

    // TC-ILB-63: コードブロック版(同型)
    test('TC-ILB-63 undo after typing works with code block variant', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- sdsds\n  ```\n  dada\n  ```\n  dsds\n- next');
            await new Promise(r => setTimeout(r, 300));
            const li = document.querySelector('#editor li')!;
            const t = Array.from(li.childNodes).find(n => n.nodeType === 3 && n.textContent!.includes('dsds'))!;
            const sel = window.getSelection()!;
            const range = document.createRange();
            range.setStart(t, t.textContent!.length);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('bbb');
        await page.waitForTimeout(600);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const state = await page.evaluate(() => ({
            liCount: document.querySelectorAll('#editor li').length,
            preInLi: document.querySelectorAll('#editor li pre').length,
            topPre: document.querySelectorAll('#editor > pre').length,
        }));
        expect(state.liCount).toBe(2);
        expect(state.preInLi).toBe(1);  // pre が li 内のまま
        expect(state.topPre).toBe(0);
    });
});

// ---- 再オープン⑩続(2026-08-11): undo 後のカーソル位置 ----
// 機序: pre の UI ヘッダ(⤢ plaintext Copy = テキスト 15 文字)が saveCursorState の
// textOffset に混入。undo の再 render 直後はヘッダ未構築のため offset がずれ、
// カーソルが後方の別 li(next 等)へ飛ぶ/消える。UI テキストを保存・復元の両側で除外する。

test.describe('Cursor restore after undo (re-open 10b)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-64: ユーザーシナリオ = pre 内 Shift+Enter → text1 → Enter → text2 → Enter → Cmd+Z×3
    // 各 undo でカーソルが editor 内の編集文脈(元の li 付近)に留まる
    test('TC-ILB-64 cursor survives repeated undo after block+continuation editing', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  ```\n  code\n  ```\n- next');
            await new Promise(r => setTimeout(r, 300));
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(code); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('text1');
        await page.waitForTimeout(600);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('text2');
        await page.waitForTimeout(600);
        for (let i = 1; i <= 3; i++) {
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);
            const s = await page.evaluate(() => {
                const sel = window.getSelection()!;
                if (!sel.rangeCount) return { lost: true, inFirstLi: false };
                const a = sel.anchorNode!;
                const el = a.nodeType === 1 ? a as Element : a.parentElement;
                const li = el?.closest('li');
                const lis = document.querySelectorAll('#editor li');
                const idx = li ? Array.from(lis).indexOf(li) : -1;
                return {
                    lost: !el?.closest('#editor'),
                    // 編集文脈 = 元 li(0)か、Enter で作った空 li(1)。最後の li(next)に
                    // 飛んだらカーソル迷子(旧バグの症状)
                    inEditedContext: idx >= 0 && idx < lis.length - 1,
                };
            });
            expect(s.lost, `undo ${i}: cursor lost`).toBe(false);
            expect(s.inEditedContext, `undo ${i}: cursor jumped to unrelated li`).toBe(true);
        }
    });

    // TC-ILB-65: pre より後ろの継続行でタイプ → undo → カーソルが同じ行に戻る
    test('TC-ILB-65 cursor returns to same continuation line after undo', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  ```\n  code\n  ```\n  text1\n  text2\n- next');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) { if ((node.textContent || '').includes('text2')) break; }
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(node!, node!.textContent!.length);
            r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('XY');
        await page.waitForTimeout(600);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            return {
                lost: false,
                anchorText: (a.textContent || ''),
                nearText2: (a.textContent || '').includes('text2')
                    || ((a.nodeType === 1 ? a as Element : a.parentElement)?.textContent || '').includes('text2'),
            };
        });
        expect(s.lost).toBe(false);
        expect(s.nearText2, 'cursor should be at/near text2, got: ' + s.anchorText).toBe(true);
    });
});

// ---- 再オープン⑪(2026-08-11 rc.12): undo スナップショット会計とコードブロック内復元 ----
// 機序 3 点: (1) markdown 変数の rAF/setTimeout 遅延により snapshot が古い md を積み、
// undo で直前操作ごと巻き戻る(fence 消滅・カーソルが下の li へ) (2) 明示 saveSnapshot 後も
// typingTimer が生き残り直後のタイプの snapshot が欠落 (3) 空 code へのカーソル復元が
// textOffset 境界で pre 外に解決 → preInfo(pre 番号 + 内部 offset)を別立て保存。

test.describe('Undo snapshot accounting and in-pre cursor restore (re-open 11)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-66: ユーザーシナリオ(継続行 → fence 作成 → 中身タイプ → undo 連打)で
    // 各 undo が 1 操作ずつ戻り、カーソルが正しい文脈に着地する
    test('TC-ILB-66 undo chain steps back one edit at a time with correct cursor', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('3. A\n   dssdsd\n4. B');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) { if ((node.textContent || '') === 'dssdsd') break; }
            const sel = window.getSelection()!;
            const rg = document.createRange();
            rg.setStart(node!, 6); rg.collapse(true);
            sel.removeAllRanges(); sel.addRange(rg);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(150);
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.keyboard.type('aa');
        await page.waitForTimeout(600);

        const snap = async () => await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            const li = el?.closest('li');
            const lis = Array.from(document.querySelectorAll('#editor li'));
            return {
                lost: false,
                liIdx: li ? lis.indexOf(li) : -1,
                inPre: !!el?.closest('pre'),
                hasPre: !!document.querySelector('#editor li pre'),
                codeText: document.querySelector('#editor li pre code')?.textContent ?? null,
            };
        });

        // undo 1: aa が消える。カーソルは空の code 内(counterfactual: 旧実装は fence ごと消え
        // 下の li に飛んでいた = snapshot 欠落)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        let s = await snap();
        expect(s.lost).toBe(false);
        expect(s.hasPre).toBe(true);           // fence は残る(aa だけ戻る)
        expect(s.inPre).toBe(true);            // カーソルは code 内(「入らない」の解消)
        expect((s.codeText || '').replace(/\n/g, '')).toBe('');

        // undo 2: fence が消えて ``` テキスト行へ。編集中の li に留まる
        // (再オープン⑫: 未閉じ「```」はテキスト継続行として parse され pre 化しない —
        //  後続リストを食わないための仕様。hasPre=false が正)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        s = await snap();
        expect(s.lost).toBe(false);
        expect(s.liIdx).toBe(0);               // 下のリスト行(4. B)に飛ばない
        expect(s.hasPre).toBe(false);          // ``` はテキスト行(pre 化しない)

        // undo 3: 初期状態へ。カーソルは元の編集行(dssdsd)付近
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        s = await snap();
        expect(s.lost).toBe(false);
        expect(s.liIdx).toBe(0);
    });

    // TC-ILB-67: 継続行のタイプを undo → データが消えた行にカーソルが残る(下の li に行かない)
    test('TC-ILB-67 undo of continuation typing keeps caret on that line', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- QAWA\n  SSDSD\n  ```\n  sdsds\n  ```\n  aaa\n- EEWEW');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) { if ((node.textContent || '') === 'aaa') break; }
            const sel = window.getSelection()!;
            const rg = document.createRange();
            rg.setStart(node!, 3); rg.collapse(true);
            sel.removeAllRanges(); sel.addRange(rg);
        });
        await page.keyboard.type('XX');
        await page.waitForTimeout(600);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            return {
                lost: false,
                anchorText: (a.textContent || '').substring(0, 8),
                offset: sel.getRangeAt(0).startOffset,
            };
        });
        expect(s.lost).toBe(false);
        expect(s.anchorText).toBe('aaa');  // 同じ行に留まる(1 行下にずれない)
        expect(s.offset).toBe(3);          // 元のカーソル位置
    });

    // TC-ILB-68: code 内タイプの undo → code 内・編集モードで復元(display で「入れない」の遮断)
    test('TC-ILB-68 undo of typing inside code restores editable in-pre cursor', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- QAWA\n  ```\n  sdsds\n  ```\n- EEWEW');
            await new Promise(r => setTimeout(r, 300));
            const pre = document.querySelector('#editor li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(code); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('ZZ');
        await page.waitForTimeout(600);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            const pre = document.querySelector('#editor li pre');
            return {
                lost: false,
                inPre: !!el?.closest('pre'),
                preMode: pre?.getAttribute('data-mode'),
                codeText: pre?.querySelector('code')?.textContent,
            };
        });
        expect(s.lost).toBe(false);
        expect(s.inPre).toBe(true);
        expect(s.preMode).toBe('edit');     // 編集モード(キャレット可視・タイプ継続可)
        expect(s.codeText).toContain('sdsds');
    });
});

// ---- 再オープン⑫(2026-08-11 rc.13): 未閉じ li 内 fence がリスト郡を食う ----

test.describe('Unclosed in-li fence must not swallow following lists (re-open 12)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-69: タイプ途中の「```」テキストを含む md(undo snapshot 形)を parse しても
    // 後続リスト項目が code に食われない
    test('TC-ILB-69 unclosed fence text keeps following list items intact', async ({ page }) => {
        const r = await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  line1\n  ```\n- sdsd\n- fsfads');
            await new Promise(r_ => setTimeout(r_, 300));
            const code = document.querySelector('#editor li pre code');
            return {
                liCount: document.querySelectorAll('#editor li').length,
                codeText: code ? (code.textContent || '') : null,
                liTexts: Array.from(document.querySelectorAll('#editor li')).map(l => (l.textContent || '').substring(0, 12)),
            };
        });
        expect(r.liCount).toBe(3); // head / sdsd / fsfads が全部リストのまま
        expect(r.liTexts.join('|')).toContain('sdsd');
        expect(r.liTexts.join('|')).toContain('fsfads');
        // code に食われていない(counterfactual: 旧実装は codeText="- sdsd- fsfads")
        expect((r.codeText || '')).not.toContain('sdsd');
    });

    // TC-ILB-70: ユーザーシナリオの undo 連打でリスト郡が code に入らない(全段検査)
    test('TC-ILB-70 undo chain never swallows lists into code', async ({ page }) => {
        test.setTimeout(90000);
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- head\n  line1\n- sdsd\n- fsfads');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) { if ((node.textContent || '') === 'line1') break; }
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(node!, 5); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(150);
        await page.keyboard.type('```');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.keyboard.type('c1');
        await page.waitForTimeout(600);
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('after');
        await page.waitForTimeout(600);
        for (let i = 1; i <= 6; i++) {
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);
            const s = await page.evaluate(() => {
                const code = document.querySelector('#editor li pre code');
                return {
                    codeText: code ? (code.textContent || '') : '',
                    liCount: document.querySelectorAll('#editor li').length,
                };
            });
            // どの undo 段でも後続リストが code に食われない
            expect(s.codeText, `undo ${i}: lists swallowed into code`).not.toContain('sdsd');
            expect(s.liCount, `undo ${i}: list items lost`).toBeGreaterThanOrEqual(3);
        }
    });
});

// ---- 再オープン⑬(2026-08-11 rc.14): bq 境界の undo カーソル + pre/bq 対称の総点検 ----

test.describe('Undo cursor at blockquote boundaries (re-open 13)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-71: bq 直後の継続行タイプ → undo 連打の各段でカーソルが正しい文脈
    // (境界一致で bq 内に吸い込まれない / 下の li に飛ばない)
    test('TC-ILB-71 undo chain around bq keeps cursor in correct context', async ({ page }) => {
        test.setTimeout(90000);
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- っd\n  - aaaa\n    sdsdsds\n    > aaaaa\n    tail\n- sada');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li li blockquote')!;
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(bq); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('sdsds');
        await page.waitForTimeout(700);
        const snap = async () => await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            const li = el?.closest('li');
            const lis = Array.from(document.querySelectorAll('#editor li'));
            return {
                lost: false,
                liIdx: li ? lis.indexOf(li) : -1,
                inBq: !!el?.closest('blockquote'),
                lastLiIdx: lis.length - 1,
            };
        });
        // u1: sdsds が消える → カーソルは空継続行(bq の後・bq 内でも下の li でもない)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        let s = await snap();
        expect(s.lost).toBe(false);
        expect(s.inBq).toBe(false);                 // bq 内に吸い込まれない(境界バグの番人)
        expect(s.liIdx).toBe(1);                    // 編集中の li(下の sada に飛ばない)
        // u2: 空継続行が消える → カーソルは bq 内末尾
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        s = await snap();
        expect(s.lost).toBe(false);
        expect(s.inBq).toBe(true);                  // bq に正しく入る
        expect(s.liIdx).toBe(1);
    });

    // TC-ILB-72: pre 版の同型(境界一致で pre 内に吸い込まれない)
    test('TC-ILB-72 undo of typing after pre does not get sucked into pre', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- a\n  ```\n  code\n  ```\n  tail\n- b');
            await new Promise(r => setTimeout(r, 300));
            const editor = document.getElementById('editor')!;
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            let node: Node | null;
            while ((node = walker.nextNode())) { if ((node.textContent || '') === 'tail') break; }
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.setStart(node!, 0); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('XY');
        await page.waitForTimeout(700);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            return {
                lost: false,
                inPre: !!el?.closest('pre'),
                nearTail: (a.textContent || '').includes('tail'),
            };
        });
        expect(s.lost).toBe(false);
        expect(s.inPre).toBe(false);   // pre に吸い込まれない
        expect(s.nearTail).toBe(true); // tail 行に留まる
    });

    // TC-ILB-73: bq 内タイプの undo → bq 内に復元(pre の TC-ILB-68 の bq 版)
    test('TC-ILB-73 undo of typing inside bq restores in-bq cursor', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- a\n  > quoted\n  tail\n- b');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li blockquote')!;
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(bq); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('ZZ');
        await page.waitForTimeout(700);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            return {
                lost: false,
                inBq: !!el?.closest('blockquote'),
                text: (a.textContent || '').substring(0, 8),
            };
        });
        expect(s.lost).toBe(false);
        expect(s.inBq).toBe(true);
        expect(s.text).toBe('quoted');
    });

    // TC-ILB-74: TC-ILB-71 の pre 版(ユーザーシナリオ「コードブロックでも再現」の番人)
    test('TC-ILB-74 undo chain around pre keeps cursor in correct context', async ({ page }) => {
        test.setTimeout(90000);
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- っd\n  - aaaa\n    sdsdsds\n    ```\n    aaaaa\n    ```\n    tail\n- sada\n  - sdsdsd');
            await new Promise(r => setTimeout(r, 300));
            const pre = document.querySelector('#editor li li pre')!;
            const code = pre.querySelector('code')!;
            pre.setAttribute('data-mode', 'edit');
            code.setAttribute('contenteditable', 'true');
            (code as HTMLElement).focus();
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(code); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.press('Shift+Enter');
        await page.waitForTimeout(200);
        await page.keyboard.type('sdsds');
        await page.waitForTimeout(700);
        const snap = async () => await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            const li = el?.closest('li');
            const lis = Array.from(document.querySelectorAll('#editor li'));
            return {
                lost: false,
                liIdx: li ? lis.indexOf(li) : -1,
                inPre: !!el?.closest('pre'),
            };
        });
        // u1: タイプが消える → カーソルは空継続行(pre 内でも下の li でもない)
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        let s = await snap();
        expect(s.lost).toBe(false);
        expect(s.inPre).toBe(false);  // pre に吸い込まれない
        expect(s.liIdx).toBe(1);      // 編集中の li(下の sada に飛ばない)
        // u2: 空継続行が消える → pre 内末尾へ進入
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(300);
        s = await snap();
        expect(s.lost).toBe(false);
        expect(s.inPre).toBe(true);
        expect(s.liIdx).toBe(1);
    });
});

// ---- 再オープン⑭(2026-08-11 rc.15): IME 合成と focus 喪失下の undo ----

test.describe('Undo under IME composition and focus loss (re-open 14)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('http://localhost:3000/standalone-editor.html');
        await page.waitForSelector('#editor', { state: 'visible' });
    });

    // TC-ILB-75: IME 合成入力(っd)を undo → bq 内に正しく復元(合成途中状態に飛ばない)
    test('TC-ILB-75 undo of IME composition restores in-bq cursor', async ({ page }) => {
        test.setTimeout(90000);
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- asdada\n  - csds\n    asasa\n    > adada\n    sdsdsd\n  - asdasdfa');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li li blockquote')!;
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(bq); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'っ', selectionStart: 1, selectionEnd: 1 });
        await page.waitForTimeout(100);
        await client.send('Input.imeSetComposition', { text: 'っd', selectionStart: 2, selectionEnd: 2 });
        await page.waitForTimeout(100);
        await client.send('Input.insertText', { text: 'っd' });
        await page.waitForTimeout(700);
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(400);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            const li = el?.closest('li');
            const lis = Array.from(document.querySelectorAll('#editor li'));
            return {
                lost: false,
                inBq: !!el?.closest('blockquote'),
                liIdx: li ? lis.indexOf(li) : -1,
                bqText: document.querySelector('#editor li li blockquote')?.textContent,
            };
        });
        expect(s.lost).toBe(false);
        expect(s.bqText).toBe('adada');  // 合成分が消える
        expect(s.inBq).toBe(true);        // カーソルは bq 内(下の li に飛ばない)
    });

    // TC-ILB-76: focus が editor 外(toolbar クリック相当)でも undo でカーソルが editor 内に復元
    test('TC-ILB-76 undo with focus outside editor restores caret inside', async ({ page }) => {
        await page.evaluate(async () => {
            (window as any).__testApi.setMarkdown('- a\n  > q\n  tail\n- b');
            await new Promise(r => setTimeout(r, 300));
            const bq = document.querySelector('#editor li blockquote')!;
            const sel = window.getSelection()!;
            const r = document.createRange();
            r.selectNodeContents(bq); r.collapse(false);
            sel.removeAllRanges(); sel.addRange(r);
        });
        await page.keyboard.type('XY');
        await page.waitForTimeout(700);
        // focus を外部へ(toolbar ボタン相当)→ toolbar undo と同じ経路で undoManager を駆動
        await page.evaluate(() => {
            (document.activeElement as HTMLElement)?.blur?.();
            document.body.focus?.();
        });
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(400);
        const s = await page.evaluate(() => {
            const sel = window.getSelection()!;
            if (!sel.rangeCount) return { lost: true } as any;
            const a = sel.anchorNode!;
            const el = a.nodeType === 1 ? a as Element : a.parentElement;
            return {
                lost: false,
                inEditor: !!el?.closest('#editor'),
                inBq: !!el?.closest('blockquote'),
            };
        });
        expect(s.lost).toBe(false);
        expect(s.inEditor).toBe(true);
        expect(s.inBq).toBe(true); // XY タイプ前 = bq 内末尾へ
    });
});

// TC-ILB-77(再オープン⑭b 根本原因): ブロック直前 br はライブ DOM にのみ存在し
// 再レンダで消える → offset/blockText 非対称でカーソルが下の li に飛ぶ(実測再現)。
// counterfactual: isCursorBrBeforeBlock スキップを外すと undo1 で liIdx が変わり RED。
test('TC-ILB-77 undo after typing below in-li code block keeps cursor in same li', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async () => {
        (window as any).__testApi.setMarkdown('- wdsds\n  - dds\n    sdsds\n    dss\n- dds\n- adssd');
        await new Promise(r => setTimeout(r, 300));
        const li = document.querySelector('#editor li li')!;
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
        let target: Text | null = null; let n: Node | null;
        while ((n = walker.nextNode())) { if (n.textContent === 'dss') target = n as Text; }
        const sel = window.getSelection()!;
        const r = document.createRange();
        r.setStart(target!, 3); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await page.keyboard.type('ss');
    await page.waitForTimeout(700);
    await page.keyboard.type('dsds');
    await page.waitForTimeout(700);
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(400);
    await page.keyboard.type('ddd');
    await page.waitForTimeout(700);
    await page.keyboard.type('dd');
    await page.waitForTimeout(700);

    const snap = () => page.evaluate(() => {
        const sel = window.getSelection()!;
        if (!sel.rangeCount) return { lost: true } as any;
        const a = sel.anchorNode!;
        const el = a.nodeType === 1 ? (a as Element) : a.parentElement!;
        const li = el.closest('li');
        const lis = Array.from(document.querySelectorAll('#editor li'));
        return {
            lost: false,
            liIdx: li ? lis.indexOf(li) : -1,
            inPre: !!el.closest('pre'),
            text: a.nodeType === 3 ? a.textContent : null,
        } as any;
    });

    // undo1: dd 消滅 → カーソルは同じ li の "ddd" 末尾(下の li に飛ばない = 画像 #74 の症状)
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(600);
    let s = await snap();
    expect(s.lost).toBe(false);
    expect(s.liIdx).toBe(1);
    expect(s.text).toBe('ddd');
    // undo3〜5: code 内へ正しく入り続ける(liIdx 不変)
    for (let i = 2; i <= 5; i++) {
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(600);
        s = await snap();
        expect(s.lost).toBe(false);
        expect(s.liIdx).toBe(1);
        if (i >= 3) expect(s.inPre).toBe(true);
    }
});

// TC-ILB-78(再オープン⑭c): 空 bq まで undo した後さらに undo → bq が消えカーソルは
// 元テキスト行(同 li)へ。no-op undo(bare ">" 遷移スナップショット)でカーソルだけ
// 下の li に飛ぶ症状の番人。counterfactual: undo() の canonical no-op skip を外すと RED。
test('TC-ILB-78 undo past empty bq removes it and keeps cursor in same li', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async () => {
        (window as any).__testApi.setMarkdown('- aaa\n  - sdsd\n    - d\n      dssdsds\n      dsds\n- dsdsd');
        await new Promise(r => setTimeout(r, 300));
        const walker = document.createTreeWalker(document.querySelector('#editor')!, NodeFilter.SHOW_TEXT);
        let target: Text | null = null; let n: Node | null;
        while ((n = walker.nextNode())) { if (n.textContent === 'dsds') target = n as Text; }
        const sel = window.getSelection()!;
        const r = document.createRange();
        r.setStart(target!, 4); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('> ');
    await page.waitForTimeout(500);
    await page.keyboard.type('aaaa');
    await page.waitForTimeout(700);

    const snap = () => page.evaluate(() => {
        const sel = window.getSelection()!;
        const bq = document.querySelector('#editor blockquote');
        if (!sel.rangeCount) return { lost: true } as any;
        const a = sel.anchorNode!;
        const el = a.nodeType === 1 ? (a as Element) : a.parentElement!;
        const li = el.closest('li');
        const lis = Array.from(document.querySelectorAll('#editor li'));
        return { lost: false, bq: !!bq, liIdx: li ? lis.indexOf(li) : -1,
            inBq: !!el.closest('blockquote'), text: a.nodeType === 3 ? a.textContent : null } as any;
    });

    // undo1: aaaa 消滅 → 空 bq 内
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(600);
    let s = await snap();
    expect(s.lost).toBe(false);
    expect(s.bq).toBe(true);
    expect(s.inBq).toBe(true);
    // undo2: bq ごと消滅 + カーソルは dsds 行(同 li)— 「bq が消えず下の li へ」も
    // 「bq は消えるが下の li へ」もどちらも RED になる
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(600);
    s = await snap();
    expect(s.lost).toBe(false);
    expect(s.bq).toBe(false);
    expect(s.liIdx).toBe(2);
    expect(s.text).toBe('dsds');
});

// TC-ILB-78(再オープン⑭c): 空 bq からの undo 連打でカーソルが下の li に飛ばない。
// 根本原因 = 「> 」タイプ途中の literal ">"(スペース無し)を継続行パーサが empty bq に
// 化けさせ、snapshot 再レンダの blockText が保存時と不一致 → 別 li フォールバック。
// 修正 = bq 開始判定を「> 」(空白必須)にし top-level REGEX.quote と対称化。
// counterfactual: /^>\s?/ に戻すと U2 で liIdx=3 に飛び RED。
test('TC-ILB-78 undo through empty bq keeps cursor in same li', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('http://localhost:3000/standalone-editor.html');
    await page.waitForSelector('#editor', { state: 'visible' });
    await page.evaluate(async () => {
        (window as any).__testApi.setMarkdown('- aaa\n  - sdsd\n    - d\n      dssdsds\n      dsds\n- dsdsd');
        await new Promise(r => setTimeout(r, 300));
        const walker = document.createTreeWalker(document.querySelector('#editor')!, NodeFilter.SHOW_TEXT);
        let target: Text | null = null; let n: Node | null;
        while ((n = walker.nextNode())) { if (n.textContent === 'dsds') target = n as Text; }
        const sel = window.getSelection()!;
        const r = document.createRange();
        r.setStart(target!, 4); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Shift+Enter');
    await page.waitForTimeout(300);
    await page.keyboard.type('> ');
    await page.waitForTimeout(500);
    await page.keyboard.type('aaaa');
    await page.waitForTimeout(700);

    const snap = () => page.evaluate(() => {
        const sel = window.getSelection()!;
        if (!sel.rangeCount) return { lost: true } as any;
        const a = sel.anchorNode!;
        const el = a.nodeType === 1 ? (a as Element) : a.parentElement!;
        const li = el.closest('li');
        const lis = Array.from(document.querySelectorAll('#editor li'));
        return { lost: false, liIdx: li ? lis.indexOf(li) : -1 } as any;
    });
    // undo 5 連打: 空 bq(U1)→ literal ">"(U2)→ 元テキスト(U3)まで全て同じ li に留まる
    for (let i = 1; i <= 5; i++) {
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(600);
        const s = await snap();
        expect(s.lost).toBe(false);
        expect(s.liIdx).toBe(2);
    }
    // 最終状態 = bq が消えて元の md に戻っている
    const md = await page.evaluate(() => (window as any).__testApi.getMarkdown());
    expect(md).not.toContain('>');
    expect(md).toContain('dsds');
});
