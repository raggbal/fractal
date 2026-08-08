/**
 * TC-XP-07 — outliner paste の md-origin 分岐（webview 層）
 * (sprint 20260808-000219 FR-XP-02)
 *
 * counterfactual: 分岐が無いと md リンク構文が pasteNodesFromText の行分割で
 * 生テキスト node になる（TC-XP-07cf は「従来経路のまま」を pin する裏面）。
 */
import { test, expect, Page } from '@playwright/test';

const SRC_CTX = {
    imageDir: '/tmp/noteA/images',
    fileDir: '/tmp/noteA/files',
    mdDir: '/tmp/noteA',
};

async function openOutliner(page: Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.waitForSelector('.outliner-node');
}

function pasteIntoFirstNode(page: Page, dataMap: Record<string, string>) {
    return page.evaluate(({ dataMap }) => {
        (window as any).__testApi.messages = [];
        const textEl = document.querySelector('.outliner-node .outliner-text') as HTMLElement;
        textEl.focus();
        const data = new DataTransfer();
        for (const [k, v] of Object.entries(dataMap)) data.setData(k, v as string);
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'clipboardData', { value: data });
        textEl.dispatchEvent(ev);
        return (window as any).__testApi.messages.filter((m: any) => m.type === 'pasteMdIntoOutliner');
    }, { dataMap });
}

test('TC-XP-07 md-origin paste: pasteMdIntoOutliner が source ctx / isCut 付きで飛ぶ', async ({ page }) => {
    await openOutliner(page);
    const md = '![p](images/pic.png)\n[📎 doc.pdf](files/doc.pdf)';
    const sent = await pasteIntoFirstNode(page, {
        'text/plain': md,
        'text/x-any-md': md,
        'text/x-any-md-context': JSON.stringify(SRC_CTX),
        'text/x-any-md-iscut': '1',
    });
    expect(sent.length).toBe(1);
    expect(sent[0].mdText).toContain('doc.pdf');
    expect(sent[0].sourceContext.imageDir).toBe(SRC_CTX.imageDir);
    expect(sent[0].isCut).toBe(true);
    expect(sent[0].targetNodeId).toBeTruthy();
});

test('TC-XP-07cf (counterfactual/回帰 pin) context なし外部テキストは従来の行分割経路', async ({ page }) => {
    await openOutliner(page);
    const before = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
    const sent = await pasteIntoFirstNode(page, {
        'text/plain': 'line-one\nline-two',
    });
    expect(sent.length).toBe(0); // pasteMdIntoOutliner は飛ばない
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => document.querySelectorAll('.outliner-node').length);
    expect(after).toBeGreaterThan(before); // 従来どおり行分割で node 追加（NFR-XP-03）
});

test('TC-XP-07b result 挿入: pasteMdIntoOutlinerResult の確定 node が添付付きで挿入される', async ({ page }) => {
    await openOutliner(page);
    const targetNodeId = await page.evaluate(() => {
        const textEl = document.querySelector('.outliner-node .outliner-text') as HTMLElement;
        return (textEl.closest('.outliner-node') as HTMLElement).dataset.id;
    });
    await page.evaluate(({ targetNodeId }) => {
        (window as any).__hostMessageHandler({
            type: 'pasteMdIntoOutlinerResult',
            targetNodeId,
            nodes: [
                { text: 'img-node', level: 0, images: ['images/copy-1-pic.png'] },
                { text: 'file-node', level: 0, filePath: 'files/doc.pdf' },
                { text: 'Sub', level: 1, isPage: true, pageId: 'sub1' },
                { text: 'plain', level: 0 },
            ],
        });
    }, { targetNodeId });
    await page.waitForTimeout(200);
    const state = await page.evaluate(() => {
        const api = (window as any).__testApi;
        const model = api.getModel ? api.getModel() : null;
        // model API が無ければ DOM から検証
        const texts = Array.from(document.querySelectorAll('.outliner-node .outliner-text'))
            .map(el => (el as HTMLElement).textContent || '');
        const lastSync = api.lastSyncData ? JSON.parse(api.lastSyncData) : null;
        return { texts: texts.join('|'), lastSync };
    });
    expect(state.texts).toContain('file-node');
    expect(state.texts).toContain('plain');
    // syncData に添付メタが乗る（filePath / images / isPage が model に入った証拠）
    // scheduleSyncToHost は 1000ms デバウンスなので flushSync で即時化
    const sync = await page.evaluate(() => {
        if ((window as any).Outliner?.flushSync) (window as any).Outliner.flushSync();
        return (window as any).__testApi.lastSyncData || '';
    });
    expect(sync).toContain('files/doc.pdf');
    expect(sync).toContain('copy-1-pic.png');
    expect(sync).toContain('sub1');
});
