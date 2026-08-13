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
            '<li><a href="files/a.docx" class="link-internal-md" data-is-file-attachment="true" data-markdown-path="files/a.docx" draggable="true" contenteditable="false">📎 SolutionSpace.docx</a></li>' +
            '<li><a href="files/b.docx" class="link-internal-md" data-is-file-attachment="true" data-markdown-path="files/b.docx" draggable="true" contenteditable="false">📎 追記_Solution.docx</a></li>' +
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
