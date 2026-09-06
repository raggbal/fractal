/**
 * TASK-26（webview 層）— linkedfd →「Outliner に送る」
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-SND-01/02 / §6-1）
 *
 * TC-SND-01（root 先頭・選択順）/ TC-SND-04（対象決定）/ TC-SND-05（snapshot 1 回・undo）。
 * host 層（closure 抑止・混在・上限）は `test/unit/send-to-outliner-host.spec.ts` が担う。
 *
 * 🔴 counterfactual: `addNodeAtStart` を N 回呼ぶ実装にすると**順序が反転**して TC-SND-01 が RED。
 */
import { test, expect, Page } from '@playwright/test';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/** 既存 root node 2 件（送った node が前に入り、これらが後ろにずれることを見る）。 */
const TREE = {
    version: 1,
    rootIds: ['old1', 'old2'],
    nodes: { old1: n('old1', 'existing-1'), old2: n('old2', 'existing-2') },
};

async function setupOutliner(page: Page): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, TREE);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

/** 可視 node の text を描画順で返す。 */
function visibleTexts(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node .outliner-text'))
            .map((el) => (el.textContent || '').trim()));
}

/** root 直下の node id を順で返す。 */
function rootIds(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as any).Outliner.getModel().rootIds.slice());
}

test.describe('TC-SND-01 root 先頭に選択順で挿入（FR-SND-01）', () => {
    test('3 件を送ると root 先頭に選択順で並び、既存 root が後ろにずれる', async ({ page }) => {
        await setupOutliner(page);
        const before = await rootIds(page);
        expect(before, '前提: 既存 root 2 件').toEqual(['old1', 'old2']);

        await page.evaluate(() => {
            (window as any).Outliner.applySendToOutlinerResult([
                { kind: 'file', name: 'a.pdf', filePath: 'files/a.pdf' },
                { kind: 'file', name: 'b.pdf', filePath: 'files/b.pdf' },
                { kind: 'file', name: 'c.pdf', filePath: 'files/c.pdf' },
            ]);
        });

        const texts = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            return m.rootIds.map((id: string) => m.getNode(id).text);
        });
        // ★ 選択順で先頭に並ぶ（addNodeAtStart を N 回呼ぶと c, b, a に反転する）
        expect(texts, `順序が違う: ${texts.join(',')}`).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'existing-1', 'existing-2']);
        // 既存 root は消えていない（同じ id のまま後ろにいる）
        const after = await rootIds(page);
        expect(after.slice(-2), '既存 root が消えた / 差し替わった').toEqual(before);
        expect(after.length).toBe(5);
    });

    test('file / md / dir が混在しても選択順が保たれ属性が正しく載る', async ({ page }) => {
        await setupOutliner(page);
        await page.evaluate(() => {
            (window as any).Outliner.applySendToOutlinerResult([
                { kind: 'dir', name: 'docs', children: [
                    { kind: 'md', name: 'inner.md', pageId: 'p-inner' },
                    { kind: 'file', name: 'inner.pdf', filePath: 'files/inner.pdf' },
                ] },
                { kind: 'md', name: 'memo.md', pageId: 'p-memo' },
                { kind: 'file', name: 'memo.txt', filePath: 'files/memo.txt' },
            ]);
        });
        const info = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            return m.rootIds.map((id: string) => {
                const x = m.getNode(id);
                return { text: x.text, isPage: !!x.isPage, pageId: x.pageId, filePath: x.filePath,
                    children: (x.children || []).map((c: string) => m.getNode(c).text) };
            });
        });
        expect(info.map((x: any) => x.text), '選択順が崩れた')
            .toEqual(['docs', 'memo', 'memo.txt', 'existing-1', 'existing-2']);
        // dir は子で構造を再現
        expect(info[0].children, 'dir の子が再現されていない').toEqual(['inner', 'inner.pdf']);
        // md は page 添付（`.md` は text から落ちる）+ filePath は相互排他で null
        expect(info[1].isPage, 'md が page 添付になっていない').toBe(true);
        expect(info[1].pageId).toBe('p-memo');
        expect(info[1].filePath, 'isPage と filePath が併存している（相互排他違反）').toBeNull();
        // file は filePath
        expect(info[2].filePath).toBe('files/memo.txt');
        expect(info[2].isPage).toBe(false);
    });

    test('1 件だけでも root 先頭に入る', async ({ page }) => {
        await setupOutliner(page);
        await page.evaluate(() => {
            (window as any).Outliner.applySendToOutlinerResult([{ kind: 'file', name: 'solo.pdf', filePath: 'files/solo.pdf' }]);
        });
        const texts = await page.evaluate(() => {
            const m = (window as any).Outliner.getModel();
            return m.rootIds.map((id: string) => m.getNode(id).text);
        });
        expect(texts[0], '先頭に入っていない').toBe('solo.pdf');
        expect(texts.length).toBe(3);
    });

    test('空配列は何もしない（空 node を作らない）', async ({ page }) => {
        await setupOutliner(page);
        await page.evaluate(() => { (window as any).Outliner.applySendToOutlinerResult([]); });
        expect(await rootIds(page), '空入力で node が増えた').toEqual(['old1', 'old2']);
    });
});

test.describe('TC-SND-05 undo 1 回で送った node 群がまとめて戻る（NFR-OIF-01）', () => {
    test('sendToOutlinerResult の受信は snapshot を 1 回だけ取り、undo で全部消える', async ({ page }) => {
        await setupOutliner(page);
        // host からの message として受信させる（本番と同じ経路 = snapshot も本番の位置で取られる）
        await page.evaluate(() => {
            // ハーネスは host message を __hostMessageHandler で受ける（既存 outliner spec の慣習）
            (window as any).__hostMessageHandler({
                type: 'sendToOutlinerResult',
                entries: [
                    { kind: 'file', name: 'a.pdf', filePath: 'files/a.pdf' },
                    { kind: 'file', name: 'b.pdf', filePath: 'files/b.pdf' },
                    { kind: 'file', name: 'c.pdf', filePath: 'files/c.pdf' },
                ],
            });
        });
        await page.waitForFunction(() =>
            (window as any).Outliner.getModel().rootIds.length === 5, undefined, { timeout: 5000 });

        // undo 1 回で 3 node すべてが消える（snapshot が 3 回なら 1 件ずつしか戻らない）
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        const after = await rootIds(page);
        expect(after, `undo 1 回で戻りきらない（snapshot が複数回取られている）: ${after.join(',')}`)
            .toEqual(['old1', 'old2']);
    });

    test('entries が空なら snapshot も取らない（undo が空振りしない）', async ({ page }) => {
        await setupOutliner(page);
        // 先に 1 つ編集して undo 対象を作る
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({ type: 'sendToOutlinerResult',
                entries: [{ kind: 'file', name: 'x.pdf', filePath: 'files/x.pdf' }] });
        });
        await page.waitForFunction(() => (window as any).Outliner.getModel().rootIds.length === 3, undefined, { timeout: 5000 });
        // 空の結果を受信（snapshot を取ってはいけない）
        await page.evaluate(() => { (window as any).__hostMessageHandler({ type: 'sendToOutlinerResult', entries: [] }); });
        await page.waitForTimeout(150);
        // undo 1 回で x.pdf が消える（空受信が snapshot を積んでいたら 1 回では戻らない）
        await page.keyboard.press('Meta+z');
        await page.waitForTimeout(200);
        expect(await rootIds(page), '空受信が snapshot を積んでいる').toEqual(['old1', 'old2']);
    });
});

test.describe('TC-SND-04 対象決定（FR-SND-02 / linkedfd 側）', () => {
    /** fv を単体マウントして「Outliner に送る」の bridge 呼び出しを見る。 */
    async function mountFv(page: Page): Promise<void> {
        const fs2 = require('fs') as typeof import('fs');
        const path2 = require('path') as typeof import('path');
        const read = (rel: string) => fs2.readFileSync(path2.join(__dirname, '../../src/shared', rel), 'utf8');
        await page.goto('about:blank');
        await page.setContent('<!DOCTYPE html><html><head><meta charset="utf-8"><style>.fv-row{min-height:20px}</style>'
            + '</head><body><div class="notes-main-wrapper" style="position:relative;height:600px;">'
            + '<div id="outlinerContainer">o</div><div id="markdownContainer" style="display:none">m</div>'
            + '</div></body></html>');
        await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            w.notesHostBridge = new Proxy({}, {
                get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
            });
            // FR-SND-02 rev2: 送り先サブメニューはツリーの .out 一覧（notesFilePanel.getOutFiles）から作る
            w.__outFiles = [{ id: 'oA', name: 'Plan A' }, { id: 'oB', name: 'Plan B' }];
            w.notesFilePanel = { getOutFiles: () => w.__outFiles.slice() };
        });
        await page.addScriptTag({ content: read('menu-placement.js') });
        await page.addScriptTag({ content: read('folder-view-dispatcher.js') });
        await page.addScriptTag({ content: read('notes-folder-view.js') });
        await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
        await page.evaluate(() => {
            const entries: any[] = [{ name: 'dirA', relPath: 'dirA', isDir: true }];
            for (let i = 1; i <= 5; i++) { entries.push({ name: `f${i}.txt`, relPath: `f${i}.txt`, isDir: false }); }
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
        });
        await page.waitForSelector('.fv-row', { timeout: 5000 });
    }

    async function clickRow(page: Page, rel: string, shift = false): Promise<void> {
        await page.evaluate(({ r, s }) => {
            (document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement)
                .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: s }));
        }, { r: rel, s: shift });
    }

    /**
     * 行を右クリック →「Outliner に送る ▶」→ サブメニューで送り先 `.out`（既定 oB）を押し、bridge 呼び出しを返す。
     * FR-SND-02 rev2（2026-09-04）: 送り先は開いている .out ではなくサブメニューで選ぶ。
     */
    async function sendVia(page: Page, rel: string, outId = 'oB'): Promise<{ folderLinkId: string; relPaths: string[]; outFileId: string } | null> {
        return page.evaluate(({ r, outId }) => {
            const w = window as any;
            w.__calls.length = 0;
            const row = document.querySelector(`.fv-row[data-rel="${r}"]`) as HTMLElement;
            const rect = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5,
            }));
            const items = Array.from(document.querySelectorAll('.fv-menu:not(.fv-submenu) > *')) as HTMLElement[];
            const hit = items.find((el) => /Send to Outliner|Outliner に送る/.test(el.textContent || ''));
            if (!hit) { return { error: 'メニュー項目が無い: ' + items.map((x) => x.textContent).join(' | ') } as any; }
            hit.click();
            // 直接 bridge を呼んではいけない（送り先未選択）
            if (w.__calls.some((c: any) => c.type === 'sendFolderViewToOutliner')) { return { error: 'サブメニュー無しで送られた' } as any; }
            const sub = document.querySelector('.fv-submenu') as HTMLElement | null;
            if (!sub) { return { error: 'サブメニューが出ない' } as any; }
            const target = Array.from(sub.querySelectorAll('.fv-menu-item')).find((el) => (el as HTMLElement).dataset.outId === outId) as HTMLElement | undefined;
            if (!target) { return { error: '送り先項目が無い: ' + Array.from(sub.children).map((x) => x.textContent).join(' | ') } as any; }
            target.click();
            const call = w.__calls.find((c: any) => c.type === 'sendFolderViewToOutliner');
            return call ? { folderLinkId: call.args[0], relPaths: call.args[1], outFileId: call.args[2] } : null;
        }, { r: rel, outId });
    }

    test('選択内の右クリック → 選択集合すべてが対象。送り先はサブメニューで選んだ .out（TC-SND-17）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f3.txt', true);   // f1, f2, f3
        const got = await sendVia(page, 'f2.txt');
        expect(got, '「Outliner に送る」が bridge を呼ばない: ' + JSON.stringify(got)).toBeTruthy();
        expect((got as any).error, (got as any).error).toBeUndefined();
        expect(got!.folderLinkId).toBe('fl1');
        expect(got!.relPaths, '選択集合が対象になっていない').toEqual(['f1.txt', 'f2.txt', 'f3.txt']);
        expect(got!.outFileId, 'サブメニューで選んだ送り先が渡っていない').toBe('oB');
        // サブメニューは登録順に全 .out を列挙する
        const other = await sendVia(page, 'f2.txt', 'oA');
        expect(other!.outFileId).toBe('oA');
    });

    test('TC-SND-17b: ツリーに .out が 0 件なら項目は disabled 表示 + click で通知 1 回（無反応にしない）', async ({ page }) => {
        await mountFv(page);
        await page.evaluate(() => { (window as any).__outFiles = []; });
        const r = await page.evaluate(() => {
            const w = window as any;
            w.__calls.length = 0;
            const row = document.querySelector('.fv-row[data-rel="f1.txt"]') as HTMLElement;
            const rect = row.getBoundingClientRect();
            row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 5, clientY: rect.top + 5 }));
            const hit = (Array.from(document.querySelectorAll('.fv-menu > *')) as HTMLElement[])
                .find((el) => /Send to Outliner|Outliner に送る/.test(el.textContent || ''))!;
            const disabled = hit.classList.contains('disabled');
            hit.click();
            return {
                disabled,
                submenu: !!document.querySelector('.fv-submenu'),
                notify: w.__calls.filter((c: any) => c.type === 'notifyError').length,
                sent: w.__calls.filter((c: any) => c.type === 'sendFolderViewToOutliner').length,
            };
        });
        expect(r.disabled).toBe(true);
        expect(r.submenu, '0 件でサブメニューが出た').toBe(false);
        expect(r.notify, '通知が 1 回でない').toBe(1);
        expect(r.sent).toBe(0);
    });

    test('選択外の右クリック → その行のみが対象（選択は変更しない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'f1.txt');
        await clickRow(page, 'f3.txt', true);
        const got = await sendVia(page, 'f5.txt');   // 選択外
        expect(got!.relPaths, '選択外の右クリックで選択集合が送られた').toEqual(['f5.txt']);
    });

    test('フォルダも対象になる（フォルダ構造を node で再現する経路）', async ({ page }) => {
        await mountFv(page);
        const got = await sendVia(page, 'dirA');
        expect(got!.relPaths, 'フォルダが対象から外された（FR-SND-01 はフォルダを受ける）').toEqual(['dirA']);
    });

    test('フォルダ + ファイルの混在選択も 1 回の呼び出しで送られる（TC-SND-14 の入口）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'dirA');
        await clickRow(page, 'f2.txt', true);   // dirA, f1, f2
        const got = await sendVia(page, 'f1.txt');
        expect(got!.relPaths, '混在選択が壊れている').toEqual(['dirA', 'f1.txt', 'f2.txt']);
    });
});
