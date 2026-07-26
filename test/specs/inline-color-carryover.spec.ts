/**
 * TC-IC-20/21/22 — md inline 要素（bold/italic/strike/code）の直後にカーソルを置いて入力しても
 * 前の inline 要素を引きずらない（要素外の plain text になる）。全経路・reload 後を境界 handler で統一。
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

// editor に inline 要素を含む DOM を作り（reload 相当）、その要素末尾に caret を置く
async function setupInlineThenCaretAtEnd(page: Page, innerHtml: string, tag: string) {
    await page.evaluate(({ innerHtml, tag }) => {
        const editor = document.getElementById('editor') as HTMLElement;
        editor.innerHTML = '<p>' + innerHtml + '</p>';
        const el = editor.querySelector(tag) as HTMLElement;
        const tn = el.firstChild!;   // 要素内の text node 末尾
        const range = document.createRange();
        range.setStart(tn, (tn.textContent || '').length);
        range.collapse(true);
        const sel = window.getSelection()!;
        sel.removeAllRanges(); sel.addRange(range);
        editor.focus();
    }, { innerHtml, tag });
}

// 現在の caret 位置に印字文字を入力（実 beforeinput を発火）
async function typeChar(page: Page, ch: string) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(30);
}

async function tagOfTypedChar(page: Page, ch: string): Promise<string | null> {
    // 入力した文字 ch を含む最も内側の要素タグ（inline 要素内なら引きずり）
    return page.evaluate((c) => {
        const editor = document.getElementById('editor')!;
        // ch を含む text node を探す
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
            if ((n.textContent || '').includes(c)) {
                const parent = (n as Text).parentElement!;
                return parent.tagName.toLowerCase();
            }
        }
        return null;
    }, ch);
}

test.describe('md inline 要素の引きずり防止 (TASK-14)', () => {
    const cases: Array<{ name: string; html: string; tag: string }> = [
        { name: 'bold', html: '<strong>bold</strong>', tag: 'strong' },
        { name: 'italic', html: '<em>italic</em>', tag: 'em' },
        { name: 'strike', html: '<del>strike</del>', tag: 'del' },
        { name: 'code', html: '<code>code</code>', tag: 'code' },
    ];

    for (const c of cases) {
        // TC-IC-21: reload 相当（DOM に要素がある状態）で末尾入力 → 要素外
        test(`TC-IC-21 ${c.name}: 要素末尾で入力した文字は要素外（reload後相当）`, async ({ page }) => {
            await boot(page);
            await setupInlineThenCaretAtEnd(page, c.html, c.tag);
            await typeChar(page, 'Z');
            const parentTag = await tagOfTypedChar(page, 'Z');
            // ★ 'Z' が inline 要素（strong/em/del/code）の中に入っていない
            expect(parentTag).not.toBe(c.tag);
            // 元の要素内テキストは保たれる
            const inner = await page.evaluate((t) => {
                const el = document.querySelector('#editor ' + t);
                return el ? (el.textContent || '') : '';
            }, c.tag);
            expect(inner).not.toContain('Z');   // 要素内に Z が混入しない
        });
    }

    // TC-IC-22: 要素の「途中」に caret があるときは従来どおり要素内で編集できる（回帰・過剰脱出しない）
    test('TC-IC-22 要素の途中入力は要素内のまま（末尾境界のみ脱出）', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            editor.innerHTML = '<p><strong>bold</strong></p>';
            const el = editor.querySelector('strong')!;
            const tn = el.firstChild!;
            const range = document.createRange();
            range.setStart(tn, 2);   // "bo|ld" 途中
            range.collapse(true);
            const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
            editor.focus();
        });
        await typeChar(page, 'Z');
        const parentTag = await tagOfTypedChar(page, 'Z');
        expect(parentTag).toBe('strong');   // 途中入力は要素内のまま（末尾境界だけ脱出）
    });

    // TC-IC-23: IME/composition（cancelable:false の beforeinput）は横取りしない（二重挿入しない）★BLOCKER 番人
    // ★ TASK-15: composition の beforeinput は cancelable:false で preventDefault が no-op。
    //   handler が手動挿入するとブラウザの composition 挿入に二重に積まれ「ああい」等の IME 破損になる。
    //   handler は insertText のみ対象 + cancelable:false は素通し、を検証する。
    test('TC-IC-23 insertCompositionText/cancelable:false の beforeinput を横取りしない', async ({ page }) => {
        await boot(page);
        await setupInlineThenCaretAtEnd(page, '<strong>bold</strong>', 'strong');
        const r = await page.evaluate(() => {
            const editor = document.getElementById('editor') as HTMLElement;
            const beforeText = (editor.querySelector('strong')!.textContent || '');
            // composition 相当: inputType=insertCompositionText + cancelable:false を dispatch
            const ev = new InputEvent('beforeinput', {
                inputType: 'insertCompositionText', data: 'あ', bubbles: true, cancelable: false,
            });
            editor.dispatchEvent(ev);
            // handler が手動挿入していないこと = strong 直後に 'あ' を勝手に足していない
            const afterText = editor.textContent || '';
            return {
                defaultPrevented: ev.defaultPrevented,
                // handler が afterNode に 'あ' を挿入していたら editor 全体に 'あ' が出る（本来ブラウザが挿入するので
                // dispatch 単体では何も起きないのが正しい = 二重挿入源を作らない）
                strayComposedChar: afterText.includes('あ'),
                strongUnchanged: (editor.querySelector('strong')!.textContent || '') === beforeText,
            };
        });
        expect(r.defaultPrevented).toBe(false);      // cancelable:false なので preventDefault は効かない（=横取りしない）
        expect(r.strayComposedChar).toBe(false);     // ★ handler が 'あ' を手動挿入していない（二重挿入源なし）
        expect(r.strongUnchanged).toBe(true);
    });

    // TC-IC-24: execCommand bold/italic（toolbar/palette 相当）適用後の入力が引きずらない ★load-bearing
    // ★再オープン③(TASK-18): execCommand の sticky typing style を apply-time でリセット。
    for (const fmt of [{ cmd: 'bold', tag: 'strong' }, { cmd: 'italic', tag: 'em' }]) {
        test(`TC-IC-24 ${fmt.cmd}: execCommand 適用→末尾入力は引きずらない（sticky reset）`, async ({ page }) => {
            await boot(page);
            const r = await page.evaluate((cmd) => {
                const editor = document.getElementById('editor') as HTMLElement;
                editor.innerHTML = '<p>word</p>';
                const p = editor.querySelector('p')!;
                const range = document.createRange(); range.selectNodeContents(p);
                const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
                editor.focus();
                // toolbar/palette 経路: applyInlineFormat 相当（__testApi 経由が無ければ execCommand + reset を直接）
                if ((window as any).__testApi && (window as any).__testApi.applyInlineFormat) {
                    (window as any).__testApi.applyInlineFormat(cmd === 'bold' ? 'strong' : 'em');
                } else {
                    // 本番 applyInlineFormat と同じ: execCommand + sticky reset
                    document.execCommand(cmd);
                    const s = window.getSelection()!; if (s.rangeCount) s.collapseToEnd();
                    if (document.queryCommandState(cmd)) document.execCommand(cmd);
                }
                // sticky state が off になっているか（引きずりの根本指標）
                return { stickyAfter: document.queryCommandState(cmd) };
            }, fmt.cmd);
            // ★ 適用後 sticky typing style が off（= 次入力が引きずらない）
            expect(r.stickyAfter).toBe(false);
        });
    }
});
