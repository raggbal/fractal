/**
 * W9 / W11（multi-file-dnd-clipboard-matrix・レビュー指摘）: outliner の cut を md・ツリーへ「移動」として貼ったあと、
 * host は Store の cut を消費し、outliner の webview へ `outlinerCutConsumed` を送る。
 * outliner へ戻って同じ clipboard を貼ったとき、cut のまま（同じ pageId のまま）復元してはいけない
 * （md・ツリーが持った page md を outliner の node も持つ = 2 か所の持ち主）。複製（新しい pageId）になる。
 *
 * TC-OCC-01 消費の知らせが無ければ従来どおり cut = 同じ pageId で戻る（対照）
 * TC-OCC-02 知らせの後は internal の clipboard でも複製（新しい pageId）
 * TC-OCC-03 知らせの後は OS clipboard の cut メタ（cross の経路・同じ copyId）でも複製
 * TC-OCC-04 別の clipboard（plainText が違う）の知らせでは解かない
 *
 * standalone-outliner.html で本物の cmd+x と paste イベントを流す（host の知らせは __hostMessageHandler へ入れる）。
 */
import { test, expect, Page } from '@playwright/test';

async function setupAndCut(page: Page): Promise<{ plainText: string; html: string }> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({
            version: 1,
            rootIds: ['n1', 'n2'],
            nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: 'Page node', tags: [], isPage: true, pageId: 'pg-cut' },
                n2: { id: 'n2', parentId: null, children: [], text: 'Target', tags: [] },
            },
        });
    });
    await page.locator('.outliner-node[data-id="n1"] .outliner-text').click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowUp');   // n1 の 1 行だけ選択
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(200);
    const plainText = await page.evaluate(() => {
        const m = (window as any).__testApi.messages.find((x: any) => x.type === 'saveOutlinerClipboard');
        return m ? m.plainText : '';
    });
    expect(plainText, 'cut が Store へ保存されない').toBeTruthy();
    // OS clipboard の text/html（cut メタ + copyId）
    const html = await page.evaluate(async () => {
        const items = await navigator.clipboard.read();
        for (const it of items) {
            if (it.types.includes('text/html')) { return await (await it.getType('text/html')).text(); }
        }
        return '';
    });
    expect(html, 'cut の HTML メタが OS clipboard に無い').toContain('data-outliner-clipboard');
    return { plainText, html };
}

async function pasteInto(page: Page, nodeId: string, plainText: string, html: string | null): Promise<void> {
    await page.locator(`.outliner-node[data-id="${nodeId}"] .outliner-text`).click();
    await page.evaluate(({ nodeId, plainText, html }) => {
        const el = document.querySelector(`.outliner-node[data-id="${nodeId}"] .outliner-text`) as HTMLElement;
        el.focus();
        const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
        ev.clipboardData!.setData('text/plain', plainText);
        if (html) { ev.clipboardData!.setData('text/html', html); }
        el.dispatchEvent(ev);
    }, { nodeId, plainText, html });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).Outliner.flushSync());
}

async function pastedPageId(page: Page): Promise<string | null> {
    const data = await page.evaluate(() => (window as any).__testApi.getSerializedData());
    const n = (Object.values(data.nodes) as any[]).find((x) => x.text === 'Page node' && x.isPage);
    return n ? n.pageId : null;
}

async function sendCutConsumed(page: Page, plainText: string): Promise<void> {
    await page.evaluate((pt) => { (window as any).__hostMessageHandler({ type: 'outlinerCutConsumed', plainText: pt }); }, plainText);
}

test.describe('outliner の cut が md・ツリーへの移動で消費されたら、outliner への貼り付けは複製', () => {
    test('TC-OCC-01 対照: 知らせが無ければ cut のまま（同じ pageId で戻る）', async ({ page }) => {
        const { plainText, html } = await setupAndCut(page);
        await pasteInto(page, 'n2', plainText, html);
        expect(await pastedPageId(page)).toBe('pg-cut');
    });

    test('TC-OCC-02 知らせの後: internal の clipboard でも複製（新しい pageId）', async ({ page }) => {
        const { plainText, html } = await setupAndCut(page);
        await sendCutConsumed(page, plainText);
        await pasteInto(page, 'n2', plainText, html);
        const id = await pastedPageId(page);
        expect(id, 'page node が貼られない').toBeTruthy();
        expect(id, 'md・ツリーへ移動済みの page md を cut のまま outliner に戻した（2 か所の持ち主）').not.toBe('pg-cut');
    });

    test('TC-OCC-03 知らせの後: OS clipboard の cut メタ（cross の経路）でも複製', async ({ page }) => {
        const { plainText, html } = await setupAndCut(page);
        await sendCutConsumed(page, plainText);
        // text/plain を変えて internal の高速路を外し、OS clipboard の cut メタ（同じ copyId）から貼る
        await pasteInto(page, 'n2', plainText + '\n', html);
        const id = await pastedPageId(page);
        expect(id, 'page node が貼られない').toBeTruthy();
        expect(id, 'cut メタの isCut を信じて同じ pageId で戻した').not.toBe('pg-cut');
    });

    test('TC-OCC-04 別の clipboard の知らせでは解かない', async ({ page }) => {
        const { plainText, html } = await setupAndCut(page);
        await sendCutConsumed(page, 'something else');
        await pasteInto(page, 'n2', plainText, html);
        expect(await pastedPageId(page)).toBe('pg-cut');
    });
});
