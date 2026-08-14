/**
 * md-list-cut-nav.spec.ts — md editor リストの cut 残骸 / リンク行カーソル移動 / Enter 分割アイコン複製
 *
 * sprint 20260813-210323-md-list-cut-nav-fixes / TC 定義 = goal.md（実装レベル sprint）。
 * ハーネス: standalone-editor.html + 実キー操作（Meta+x / Arrow / Enter — 合成イベント禁止 =
 * generator_failures 2026-08-12。cut/copy は実キー + clipboard 権限）。
 */
import { test, expect, Page } from '@playwright/test';

async function setup(page: Page, html: string): Promise<void> {
    await page.goto('/standalone-editor.html');
    await page.waitForTimeout(300);
    await page.evaluate((h) => {
        const editor = document.getElementById('editor') as HTMLElement;
        editor.innerHTML = h;
    }, html);
}

/** editor 直下の「残骸」検査: 空 li（テキストも実コンテンツも無い）と空 list を数える */
async function countShellDebris(page: Page): Promise<{ emptyLis: number; emptyLists: number; anchorOnlyLis: number }> {
    return page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        let emptyLis = 0, emptyLists = 0, anchorOnlyLis = 0;
        for (const li of Array.from(editor.querySelectorAll('li'))) {
            const text = (li.textContent || '').trim();
            const hasReal = !!li.querySelector('img, input, table, pre, hr');
            const anchors = li.querySelectorAll(':scope > a');
            const nested = li.querySelector('ul, ol');
            if (!text && !hasReal && !nested) { emptyLis++; }
            // アンカーだけ残り、アンカー内テキストも空（アイコン装飾だけ見える）
            if (!text && anchors.length > 0) { anchorOnlyLis++; }
        }
        for (const l of Array.from(editor.querySelectorAll('ul, ol'))) {
            if (l.children.length === 0) { emptyLists++; }
        }
        return { emptyLis, emptyLists, anchorOnlyLis };
    });
}

test.describe('TASK-01: リスト cut の残骸一掃', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('TC-LX-01: 選択端点がリスト外（段落→階層リスト途中）の cut → 殻 li 残骸ゼロ', async ({ page }) => {
        // 実バグの再現形（sweep 実測 K/M）: 片端がリスト外だと affectedLis 収集が
        // startLi=null で間の li を列挙できず、テキストが消えた親 li が nested ul だけ
        // 抱えた殻（画面 = バレットだけの行）で残る。
        await setup(page,
            '<p>head paragraph</p>' +
            '<ul><li>parent1<ul><li>child1</li><li>child2</li><li>child3</li></ul></li><li>parent2</li></ul>' +
            '<p>tail paragraph</p>');
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const range = document.createRange();
            const p = editor.querySelector('p') as HTMLElement;
            const lis = editor.querySelectorAll('li');
            const child2 = Array.from(lis).find((l) => l.textContent === 'child2') as HTMLElement;
            range.setStart(p.firstChild as Node, 5);                          // "head |paragraph"
            range.setEnd(child2.firstChild as Node, 3);                        // "chi|ld2"
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
        });
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);

        const state = await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            // 「殻」= 直下テキストなし・img/input なし。nested list を持っていても直下が空なら殻
            //（nested の中身は昇格されるべき — 画面上バレットだけの行が残るのが残骸）
            const shellLis = Array.from(editor.querySelectorAll('li')).filter((li) => {
                const directText = Array.from(li.childNodes)
                    .filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join('').trim();
                const directReal = Array.from(li.children).some((c) => {
                    const t = c.tagName.toLowerCase();
                    if (t === 'ul' || t === 'ol' || t === 'br') { return false; }
                    return !!((c.textContent || '').trim() || c.querySelector('img, input'));
                });
                return !directText && !directReal;
            });
            return {
                shellLiCount: shellLis.length,
                emptyLists: Array.from(editor.querySelectorAll('ul,ol')).filter((l) => l.children.length === 0).length,
                text: editor.textContent || '',
            };
        });
        expect(state.shellLiCount).toBe(0);       // バレットだけの殻行（バグの主症状）
        expect(state.emptyLists).toBe(0);
        // 選択外は生存・選択内は消える
        expect(state.text).toContain('head ');
        expect(state.text).toContain('ld2');       // child2 の残り
        expect(state.text).toContain('child3');
        expect(state.text).toContain('parent2');
        expect(state.text).toContain('tail paragraph');
        expect(state.text).not.toContain('parent1');
        expect(state.text).not.toContain('child1');
    });

    test('TC-LX-02: 📎/md リンク行を含む範囲 cut → アイコン残骸行が残らない', async ({ page }) => {
        await setup(page,
            '<ul><li>参考' +
            '<ul>' +
            '<li><a href="files/a.docx" class="link-internal-md" data-is-file-attachment="true" data-markdown-path="files/a.docx" draggable="true">📎 SolutionSpace.docx</a></li>' +
            '<li><a href="files/b.docx" class="link-internal-md" data-is-file-attachment="true" data-markdown-path="files/b.docx" draggable="true">📎 追記_Solution.docx</a></li>' +
            '<li><a href="sub.md" class="link-internal-md link-subpage" data-subpage="true" draggable="true">sss</a></li>' +
            '</ul></li></ul>');
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const range = document.createRange();
            range.selectNodeContents(editor);   // 全選択（Meta+a 相当の全範囲）
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
        });
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);

        const debris = await countShellDebris(page);
        expect(debris.anchorOnlyLis).toBe(0);   // アイコンだけの残骸行（ユーザー報告の主症状）
        expect(debris.emptyLis).toBe(0);
        expect(debris.emptyLists).toBe(0);
    });

    test('TC-LX-03: 部分選択 cut — 選択外の行・img は生存（資産保持 regression 番人）', async ({ page }) => {
        await setup(page,
            '<ul><li>keep-before</li>' +
            '<li>cut-me-1<ul><li>cut-me-2</li><li><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" alt="keep-img"></li></ul></li>' +
            '<li>keep-after</li></ul>');
        // cut-me-1 の先頭から cut-me-2 の末尾までを選択（img の li は選択外）
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const lis = Array.from(editor.querySelectorAll('li'));
            const start = lis.find((l) => (l.firstChild as Text | null)?.textContent === 'cut-me-1') as HTMLElement;
            const end = lis.find((l) => l.textContent === 'cut-me-2') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const range = document.createRange();
            range.setStart(start.firstChild as Node, 0);
            range.setEnd(end.firstChild as Node, (end.firstChild as Text).length);
            sel.removeAllRanges();
            sel.addRange(range);
            editor.focus();
        });
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(200);

        const state = await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            return {
                text: editor.textContent || '',
                imgCount: editor.querySelectorAll('img').length,
            };
        });
        expect(state.text).toContain('keep-before');
        expect(state.text).toContain('keep-after');
        expect(state.imgCount).toBe(1);           // 選択外 img の生存（2026-07-28 教訓の番人）
        expect(state.text).not.toContain('cut-me-1');
        expect(state.text).not.toContain('cut-me-2');
        const debris = await countShellDebris(page);
        expect(debris.emptyLis).toBe(0);
    });
});

test.describe('TASK-02: 📎/md リンク行のカーソル移動', () => {

    /** caret の現在地を li テキストで返すヘルパ */
    async function caretLi(page: Page): Promise<string> {
        return page.evaluate(() => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return 'NO-SELECTION';
            const c = sel.getRangeAt(0).startContainer;
            const el = c.nodeType === 1 ? (c as Element) : (c.parentElement as Element);
            const li = el.closest('li');
            if (li) return 'li:' + (li.textContent || '').substring(0, 20);
            const block = el.closest('p, h1, h2, h3, pre, blockquote');
            return block ? block.tagName + ':' + (block.textContent || '').substring(0, 10) : 'editor';
        });
    }

    test('TC-LX-04: ↑↓ で 📎 リンク行に入れる（上→下→上の完全往復）', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown(
                '- 参考\n  - [📎 doc1.docx](files/a.docx)\n  - [📎 doc2.docx](files/b.docx)\n\ntail\n');
        });
        await page.waitForTimeout(400);
        await page.locator('#editor li').first().click({ position: { x: 8, y: 8 } });
        await page.keyboard.press('Meta+ArrowLeft');

        await page.keyboard.press('ArrowDown');
        expect(await caretLi(page)).toContain('doc1');        // counterfactual: 補助なしだと P:tail に飛ぶ
        await page.keyboard.press('ArrowDown');
        expect(await caretLi(page)).toContain('doc2');
        await page.keyboard.press('ArrowDown');
        expect(await caretLi(page)).not.toContain('doc');     // リストを抜けて tail 側へ
        await page.keyboard.press('ArrowUp');
        expect(await caretLi(page)).toContain('doc2');        // 逆方向も対称
        await page.keyboard.press('ArrowUp');
        expect(await caretLi(page)).toContain('doc1');
        await page.keyboard.press('ArrowUp');
        expect(await caretLi(page)).toContain('li:参考');
    });

    test('TC-LX-05: リスト末尾が 📎 行 — 下の段落から ↑ でカーソル消失しない', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown(
                '- head\n  - [📎 last.docx](files/z.docx)\n\ntail\n');
        });
        await page.waitForTimeout(400);
        // tail にキャレット → ↑↑
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const ps = editor.querySelectorAll('p');
            const tail = Array.from(ps).find((p) => (p.textContent || '').includes('tail')) as HTMLElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(tail.firstChild as Node, 2);
            r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        // tail → 空段落（md 空行 = <p><br></p>）→ 📎 行 → head と 3 回で到達
        await page.keyboard.press('ArrowUp');
        expect(await caretLi(page)).not.toBe('NO-SELECTION'); // カーソル消失（ユーザー報告）の番人
        await page.keyboard.press('ArrowUp');
        const atFile = await caretLi(page);
        expect(atFile).not.toBe('NO-SELECTION');
        expect(atFile).toContain('last');                      // 📎 行に入れる
        await page.keyboard.press('ArrowUp');
        const atHead = await caretLi(page);
        expect(atHead).not.toBe('NO-SELECTION');
        expect(atHead).toContain('head');                      // 📎 行から先頭行へ抜けられる
    });

    test('TC-LX-06: md/subpage リンクは ←→ でテキスト内にカーソルが入る（コピー可能）', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- [mdlink](other.md)\n- next\n');
        });
        await page.waitForTimeout(400);
        // リンク行の行頭（li offset 0）から → で anchor テキスト内に進む
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const li = editor.querySelector('li') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(li, 0); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        const inAnchor = await page.evaluate(() => {
            const sel = window.getSelection() as Selection;
            const c = sel.getRangeAt(0).startContainer;
            const el = c.nodeType === 1 ? (c as Element) : (c.parentElement as Element);
            return { inA: !!el.closest('a'), offset: sel.getRangeAt(0).startOffset };
        });
        expect(inAnchor.inA).toBe(true);                       // リンクテキスト内にキャレット
        // Shift+→ で選択して cmd+c（リンクテキストの部分コピー = ユーザーのユースケース）
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Meta+c');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip.length).toBeGreaterThan(0);
        expect('mdlink').toContain(clip.trim());               // リンクテキストの一部が取れている
    });

    test('TC-LX-09: dirty DOM（空白 text node 挟み）でも ↑↓ 補助が効く', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown(
                '- 参考\n  - [📎 doc1.docx](files/a.docx)\n\ntail\n');
        });
        await page.waitForTimeout(400);
        // 実編集で生じる空白 text node を意図的に挟む（generator_failures 2026-08-11）
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const fileLi = Array.from(editor.querySelectorAll('li'))
                .find((l) => l.querySelector('a[data-is-file-attachment]')) as HTMLElement;
            fileLi.insertBefore(document.createTextNode(''), fileLi.firstChild);
            fileLi.appendChild(document.createTextNode(' '));
        });
        await page.locator('#editor li').first().click({ position: { x: 8, y: 8 } });
        await page.keyboard.press('Meta+ArrowLeft');
        await page.keyboard.press('ArrowDown');
        const li = await caretLi(page);
        expect(li).toContain('doc1');                          // 空白 node 挟みでも入れる
    });
});

test.describe('TASK-03: Enter 分割での md アイコン複製防止', () => {

    async function setupMd(page: Page, md: string): Promise<void> {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md);
        await page.waitForTimeout(400);
    }

    /** アイコン付きアンカー（subpage/md）の数と各 li の状態 */
    async function anchorState(page: Page) {
        return page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const anchors = Array.from(editor.querySelectorAll('a[data-subpage], a.link-subpage'));
            return {
                anchorCount: anchors.length,
                emptyAnchors: anchors.filter((a) => !(a.textContent || '').trim()).length,
                liTexts: Array.from(editor.querySelectorAll('li')).map((l) => (l.textContent || '').trim()),
                md: (window as any).__testApi.getMarkdown ? (window as any).__testApi.getMarkdown() : null,
            };
        });
    }

    test('TC-LX-07: リンクとテキストの間で Enter → 新行にアイコンが複製されない', async ({ page }) => {
        await setupMd(page, '- [[sss]](sub.md)xx\n');
        // リンクテキスト末尾（anchor 内 offset 3 — ユーザーがタイプ直後に Enter する実位置）
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const a = editor.querySelector('a') as HTMLAnchorElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(a.firstChild as Node, 3);
            r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);

        const s = await anchorState(page);
        expect(s.anchorCount).toBe(1);              // アイコン付きアンカーは元行の 1 個だけ
        expect(s.emptyAnchors).toBe(0);             // 空アンカー（アイコンだけの残骸）なし
        expect(s.liTexts).toEqual(['sss', 'xx']);   // 分割自体は正しい
        expect(s.md).toContain('[[sss]](sub.md)');
        expect((s.md.match(/sub\.md/g) || []).length).toBe(1);   // md 上もリンク 1 個
    });

    test('TC-LX-08: 分割位置バリエーション — アイコンは常に元リンク保持行のみ', async ({ page }) => {
        // (a) アンカー直後（要素境界）
        await setupMd(page, '- [[sss]](sub.md)xx\n');
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const a = editor.querySelector('a') as HTMLAnchorElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStartAfter(a); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        let s = await anchorState(page);
        expect(s.anchorCount).toBe(1);
        expect(s.emptyAnchors).toBe(0);

        // (b) アンカー内テキスト途中（リンクは原子として元行に残る）
        await setupMd(page, '- [[sss]](sub.md)xx\n');
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const a = editor.querySelector('a') as HTMLAnchorElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(a.firstChild as Node, 2);    // "ss|s"
            r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        s = await anchorState(page);
        expect(s.anchorCount).toBe(1);              // counterfactual: 原子化なしだと 2 個に分裂
        expect(s.emptyAnchors).toBe(0);
        expect(s.liTexts[0]).toBe('sss');           // リンクテキストは分断されない

        // (c) 行頭（テキスト xx の前ではなくリンクの前）で Enter — アイコンは下行（元リンク行）に随伴
        await setupMd(page, '- [[sss]](sub.md)xx\n- next\n');
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const li = editor.querySelector('li') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(li, 0); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        s = await anchorState(page);
        expect(s.anchorCount).toBe(1);
        expect(s.emptyAnchors).toBe(0);
    });
});

test.describe('TASK-05: 📎 file リンクの subpage 方式統一（テキスト編集可能）', () => {

    test('TC-LX-11: file リンクテキストに ←→ で入れ、shift+矢印で選択コピーでき、BS で消せる', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- [📎 doc1.docx](files/a.docx)\n- next\n');
        });
        await page.waitForTimeout(400);

        // DOM 契約: ce=false が撤去され draggable は維持（counterfactual: ce=false 復活で
        // 以降の caret 進入・選択・BS が全部効かなくなる = RED）
        const attrs = await page.evaluate(() => {
            const a = document.querySelector('#editor a[data-is-file-attachment="true"]') as HTMLElement;
            return { ce: a.getAttribute('contenteditable'), draggable: a.getAttribute('draggable') };
        });
        expect(attrs.ce).not.toBe('false');
        expect(attrs.draggable).toBe('true');

        // (a) ←→ 進入: 行頭（li offset 0）から → でアンカーテキスト内にキャレットが入る
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const li = editor.querySelector('li') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(li, 0); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            editor.focus();
        });
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        const inAnchor = await page.evaluate(() => {
            const sel = window.getSelection() as Selection;
            const c = sel.getRangeAt(0).startContainer;
            const el = c.nodeType === 1 ? (c as Element) : (c.parentElement as Element);
            return !!el.closest('a[data-is-file-attachment="true"]');
        });
        expect(inAnchor).toBe(true);                           // 旧 ce=false ではアンカー全体を飛び越え false

        // (b) shift+矢印で選択して cmd+c（リンクテキストの部分コピー = ユーザー要求）
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Meta+c');
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        expect(clip.trim().length).toBeGreaterThan(0);
        expect('doc1.docx').toContain(clip.trim());            // アンカーテキストの一部が取れている

        // (c) BS 削除: アンカーテキスト末尾で Backspace → 1 文字消える
        //（先頭 child は 📎 grip span（ce=false）なので末尾の text node を掴む）
        await page.evaluate(() => {
            const a = document.querySelector('#editor a[data-is-file-attachment="true"]') as HTMLAnchorElement;
            const tn = a.lastChild as Text;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.setStart(tn, tn.length); r.collapse(true);
            sel.removeAllRanges(); sel.addRange(r);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
        const afterBs = await page.evaluate(() => {
            const a = document.querySelector('#editor a[data-is-file-attachment="true"]');
            return a ? (a.textContent || '') : 'ANCHOR-GONE';
        });
        expect(afterBs).toBe('doc1.doc');                      // 旧 ce=false では Backspace 無反応
    });

    test('TC-LX-12: drag は ::before アイコン起点のみ発火 — テキスト中央は選択操作（subpage 同一構造の対検証）', async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- [📎 report-with-long-name.pdf](files/report.pdf)\n- next\n');
            (window as any).__dragTypes = null;
            document.addEventListener('dragstart', (e: any) => {
                (window as any).__dragTypes = e.dataTransfer ? Array.from(e.dataTransfer.types || []) : [];
            }, false);
        });
        await page.waitForTimeout(400);
        const a = page.locator('#editor a[data-is-file-attachment="true"]');

        // DOM 契約（subpage と同一構造）: 📎 マーカーは DOM テキストに出ない・grip span も無い
        const dom = await page.evaluate(() => {
            const anchor = document.querySelector('#editor a[data-is-file-attachment="true"]') as HTMLElement;
            return { text: anchor.textContent, hasGripSpan: !!anchor.querySelector('span') };
        });
        expect(dom.text).toBe('report-with-long-name.pdf');
        expect(dom.hasGripSpan).toBe(false);

        // (a) テキスト中央からの mousedown → text selection が奪い element drag 不発
        //     （counterfactual: ce=false に戻すとここが発火してしまい RED）
        const box = (await a.boundingBox())!;
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6 + 80, box.y + 80, { steps: 5 });
        await page.mouse.up();
        expect(await page.evaluate(() => (window as any).__dragTypes)).toBeNull();

        // (b) 左端 ::before アイコン起点なら dragstart + MIME 発火 = D&D 要件 FR-TF-15 維持
        //（::before はテキストの前に張り出す装飾 = アンカー box の左端数 px はアイコン領域）
        await page.evaluate(() => { (window as any).__dragTypes = null; });
        const box2 = (await a.boundingBox())!;
        await page.mouse.move(box2.x + 5, box2.y + box2.height / 2);
        await page.mouse.down();
        await page.mouse.move(box2.x + 85, box2.y + 80, { steps: 5 });
        await page.mouse.up();
        const types = await page.evaluate(() => (window as any).__dragTypes);
        expect(types).not.toBeNull();
        expect(types).toContain('application/x-fractal-md-filelink');
    });

    test('TC-LX-13: テキスト全選択 cut → アンカー・アイコンごと消える（subpage と同一挙動）+ serialize 往復で [📎 name] 保持', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
        await page.evaluate(() => {
            (window as any).__testApi.setMarkdown('- [📎 report.pdf](files/report.pdf)\n- next\n');
        });
        await page.waitForTimeout(400);

        // serialize 往復: 📎 マーカーが md 上で保持される（DOM には出ないが serialize が復元）
        const md1 = await page.evaluate(() => (window as any).__testApi.getMarkdown());
        expect(md1).toContain('[📎 report.pdf](files/report.pdf)');

        // アンカーテキスト全選択 → cmd+x → アイコン残骸行にならない（ユーザー報告 2026-08-14 の番人。
        // 旧 grip span 方式では 📎 span が選択に含まれず殻アンカーが残った）
        await page.evaluate(() => {
            const anchor = document.querySelector('#editor a[data-is-file-attachment="true"]') as HTMLElement;
            const sel = window.getSelection() as Selection;
            const r = document.createRange();
            r.selectNodeContents(anchor);
            sel.removeAllRanges(); sel.addRange(r);
            (document.getElementById('editor') as HTMLElement).focus();
        });
        await page.keyboard.press('Meta+x');
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            return {
                anchorCount: editor.querySelectorAll('a[data-is-file-attachment="true"]').length,
                md: (window as any).__testApi.getMarkdown(),
            };
        });
        expect(after.anchorCount).toBe(0);              // アイコンだけの殻アンカーが残らない
        expect(after.md).not.toContain('files/report.pdf');
        expect(after.md).toContain('next');
    });
});
