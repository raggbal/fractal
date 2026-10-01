/**
 * 面間 clipboard 複写 F / G / H（FR-CBD-01..07 / DOM-ClipboardTransferContext）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove
 *
 * ## 実装の非対称（ブラウザのイベント発火条件に由来する正しい非対称）
 * - **copy は keydown 駆動**: linkedfd は `dropTextSelection()` でテキスト選択を毎回捨てるため
 *   selection が常に collapsed で、**`copy` イベントがブラウザから発火しない**
 *   （in-repo 前例の逐語コメント: `editor.js` の table select モード）
 * - **paste はイベント委譲**: collapsed selection でも `paste` は来る。ただし Chromium は
 *   clipboard event の target を selection 起点で決めるので `treeEl` には来ず **`document.body`** に落ちる
 *   → `document` レベルの listener で受ける（ADRL-0118 = 案 B）
 *
 * 🔴 copy 側の TC は**実キー押下**で検証する（合成 ClipboardEvent では「ブラウザが発火するか」を踏めない
 *    — `.harness/lessons/legacy/synth-path-green.md` の実害クラス）。
 */
import { test, expect, Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * 🔴 clipboard 系は **`about:blank` では検証できない**（不透明オリジンでは `navigator.clipboard` が
 *    そもそも存在しない — 実測で確認）。他の fv spec は `about:blank` + `setContent` で単体マウントしているが、
 *    本 spec は **実オリジン（`/standalone-notes.html`）**を使い、host bridge だけ Proxy に差し替える。
 */
async function mountFv(page: Page): Promise<void> {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => { /* noop */ });
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() =>
        !!(window as any).__folderViewDispatcher && !!(window as any).__folderView, undefined, { timeout: 8000 });
    await page.evaluate(() => {
        const w = window as any;
        w.__calls = [];
        // 既存のモック bridge を Proxy recorder に差し替える（呼び出しを全部記録する）
        w.notesHostBridge = new Proxy({}, {
            get: (_t, prop: string) => (...args: any[]) => { w.__calls.push({ type: prop, args }); },
        });
    });
    await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
    await page.evaluate(() => {
        const entries: any[] = [
            { name: 'docs', relPath: 'docs', isDir: true },
            { name: 'a.md', relPath: 'a.md', isDir: false },
            { name: 'b.pdf', relPath: 'b.pdf', isDir: false },
            { name: 'c.txt', relPath: 'c.txt', isDir: false },
        ];
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    });
    await page.waitForSelector('.fv-row', { timeout: 5000 });
    // treeEl に focus を置く（keydown は focus ベース）
    await page.locator('.fv-row[data-rel="a.md"]').click();
}

const clickRow = (page: Page, rel: string, mods: { shift?: boolean; meta?: boolean } = {}) =>
    page.locator(`.fv-row[data-rel="${rel}"]`).click({
        modifiers: [...(mods.shift ? ['Shift' as const] : []), ...(mods.meta ? ['Meta' as const] : [])],
    });

/** OS clipboard の text/html から `data-fractal-fv-clip` メタを取り出す */
async function fvClipMeta(page: Page): Promise<any> {
    return page.evaluate(async () => {
        try {
            const items = await navigator.clipboard.read();
            for (const it of items) {
                if (it.types.includes('text/html')) {
                    const html = await (await it.getType('text/html')).text();
                    const m = html.match(/data-fractal-fv-clip="([^"]*)"/);
                    if (m) { try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; } }
                }
            }
        } catch { /* 権限が無い環境 */ }
        return null;
    });
}
const clipPlain = (page: Page) => page.evaluate(() => navigator.clipboard.readText().catch(() => ''));

test.describe('FR-CBD-01 linkedfd の cmd+c（F の送り手・keydown 駆動）', () => {
    test('TC-CBD-01 選択全件（フォルダ含む）が表示順で clipboard に載る', async ({ page }) => {
        await mountFv(page);
        // 逆順に選ぶ → 描画順で載ることを見る
        await clickRow(page, 'c.txt');
        await clickRow(page, 'docs', { meta: true });
        await clickRow(page, 'a.md', { meta: true });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);

        const meta = await fvClipMeta(page);
        expect(meta, 'clipboard に data-fractal-fv-clip メタが無い（F の送り手が成立しない）').not.toBeNull();
        expect(meta.v, 'スキーマ版が無い').toBe(1);
        expect(meta.folderLinkId, 'folderLinkId が載っていない（host が root を解決できない）').toBe('fl1');
        expect(meta.relPaths, '選択全件が表示順で載っていない（フォルダも含める = clipboard は DataTransfer の制約を受けない）')
            .toEqual(['docs', 'a.md', 'c.txt']);
        expect(meta.copyId, 'copyId（nonce）が無い').toBeTruthy();
        // 実体（絶対パス）を載せない — host が disk から解決する
        expect(JSON.stringify(meta), 'payload に絶対パスが混入している').not.toMatch(/(^|")\//);
        expect(await clipPlain(page), 'text/plain に relPath が載っていない（外部アプリへの degrade）').toContain('a.md');
    });

    test('TC-CBD-02 フォルダのみの選択でも成立する（無反応にしない）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'docs');
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        const meta = await fvClipMeta(page);
        expect(meta, 'フォルダのみの選択で clipboard に何も載らない').not.toBeNull();
        expect(meta.relPaths, 'フォルダが除外された（D&D の制約を clipboard に持ち込んでいる）').toEqual(['docs']);
    });

    test('TC-CBD-03 選択 0 件の cmd+c は何もしない', async ({ page }) => {
        await mountFv(page);
        // 事前に別の内容を clipboard へ置いて、上書きされないことを見る
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL').catch(() => { /* noop */ }));
        await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
        await page.evaluate(() => {
            window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                { name: 'a.md', relPath: 'a.md', isDir: false },
            ] }, '*');
        });
        await page.waitForSelector('.fv-row');
        await page.evaluate(() => { (document.querySelector('.fv-row') as HTMLElement).parentElement!.focus(); });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(200);
        expect(await clipPlain(page), '選択 0 件で clipboard を上書きした').toBe('SENTINEL');
        expect(await fvClipMeta(page), '選択 0 件で fv メタを書いた').toBeNull();
    });
});

// ═══════════ F の受け手: outliner の node で cmd+v（FR-CBD-02 / DOM-OutlinerClipPaste） ═══════════

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}
const OUT_TREE = {
    version: 1, rootIds: ['a', 'b', 'c'],
    nodes: { a: n('a', 'alpha'), b: n('b', 'bravo'), c: n('c', 'charlie'), e: n('e', '') },
};

/** linkedfd で 2 件コピー → fv を隠して outliner を表示 → 対象 node に caret を置く */
async function copyInFvThenOpenOutliner(page: Page, rels: string[], tree: any = OUT_TREE) {
    await mountFv(page);
    // ⚠️ linkedfd の修飾なし click は **単一選択**（outliner の「クリア」とは意味が違う）。
    //    先頭を plain click し、残りだけ cmd+click で足す（先頭も cmd+click すると外れる）。
    await clickRow(page, rels[0]);
    for (const r of rels.slice(1)) { await clickRow(page, r, { meta: true }); }
    await page.keyboard.press(`${MOD}+c`);
    await page.waitForTimeout(250);
    expect((await fvClipMeta(page))?.relPaths, '前提: fv の cmd+c が payload を書いている').toEqual(rels);
    await page.evaluate(() => { (window as any).__folderViewDispatcher.hideFolderView(); });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, tree);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
}

/** OS clipboard の内容で paste イベントを合成して outliner の node へ送る（paste 側は委譲が正しい形） */
async function pasteIntoNode(page: Page, nodeId: string, opts: { click?: boolean } = {}) {
    // ⚠️ outliner の修飾なし click は **選択をクリアする**（出口経路）。選択モードを保ったまま
    //    paste したいケース（TC-CBD-08）では click しない。
    if (opts.click !== false) { await page.locator(`.outliner-node[data-id="${nodeId}"] .outliner-text`).click(); }
    await page.waitForFunction(() => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && ae.classList.contains('outliner-text');
    }, undefined, { timeout: 5000 }).catch(() => { /* noop */ });
    await page.evaluate(async (id) => {
        const el = document.querySelector(`.outliner-node[data-id="${id}"] .outliner-text`) as HTMLElement;
        el.focus();
        let html = ''; let plain = '';
        const items = await navigator.clipboard.read();
        for (const it of items) {
            if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            if (it.types.includes('text/plain')) { plain = await (await it.getType('text/plain')).text(); }
        }
        const dt = new DataTransfer();
        dt.setData('text/plain', plain);
        dt.setData('text/html', html);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        (window as any).__lastPastePrevented = ev.defaultPrevented;
    }, nodeId);
    await page.waitForTimeout(300);
}
const sentToOutliner = (page: Page) => page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.type === 'sendFolderViewToOutliner'));

test.describe('FR-CBD-02 F の受け手（outliner の cmd+v）', () => {
    test('TC-CBD-04 対象 node の直後の兄弟として全件が表示順で入る（position=after）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md', 'b.pdf']);
        await pasteIntoNode(page, 'b');
        const calls = await sentToOutliner(page);
        expect(calls.length, 'F 分岐が発火していない（host 入口 sendFolderViewToOutliner が呼ばれない）').toBe(1);
        // 引数契約: (linkId, relPaths, outFileId, targetNodeId, position)
        expect(calls[0].args[0], 'folderLinkId が渡っていない').toBe('fl1');
        expect(calls[0].args[1], '選択全件が表示順で渡っていない').toEqual(['a.md', 'b.pdf']);
        expect(calls[0].args[3], 'paste 対象 node が渡っていない').toBe('b');
        expect(calls[0].args[4], "挿入位置が 'after' 固定になっていない（D11）").toBe('after');
        expect(await page.evaluate(() => (window as any).__lastPastePrevented),
            'F 分岐が preventDefault していない（生テキストが node に流入する）').toBe(true);
    });

    test('TC-CBD-05 F は source を消さない（複製 / INV-3）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md', 'b.pdf']);
        await pasteIntoNode(page, 'b');
        const calls = await page.evaluate(() => (window as any).__calls.map((c: any) => c.type));
        // source 側を消す bridge（削除系）が 1 つも呼ばれていない
        for (const del of ['folderViewDelete', 'folderViewMove', 'folderViewMoveBatch']) {
            expect(calls.filter((t: string) => t === del).length, `${del} が呼ばれた（複製のはずが移動になっている）`).toBe(0);
        }
    });

    test('TC-CBD-07 fv payload なしの paste では 1 行も副作用を出さない（HM-3）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md']);
        // clipboard を素のテキストで上書き（fv メタなし）
        await page.evaluate(() => navigator.clipboard.writeText('plain text only'));
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteIntoNode(page, 'b');
        expect((await sentToOutliner(page)).length, 'fv payload が無いのに F 分岐が発火した').toBe(0);
        const texts = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.outliner-node .outliner-text')).map((x) => x.textContent));
        expect(texts.join('|'), '素テキストの paste が従来どおり処理されていない').toContain('plain text only');
    });

    test('TC-CBD-08 選択モードで F payload を cmd+v すると既存の選択置換が走る（SYS-4 の番人）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md']);
        // outliner で 2 node を選択（選択モード）
        await page.locator('.outliner-node[data-id="a"] .outliner-text').click();
        for (const id of ['a', 'b']) {
            await page.locator(`.outliner-node[data-id="${id}"] .outliner-text`).click({ modifiers: [MOD as any] });
        }
        expect(await page.locator('.outliner-node.is-selected').count(), '前提: 2 件選択').toBe(2);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteIntoNode(page, 'b', { click: false });   // click すると選択が消えて選択モードでなくなる
        expect((await sentToOutliner(page)).length,
            '選択モードなのに F 分岐が発火した（!isSelectMode() ガードが無い = FR-CBD-02 の受け入れ条件に反する）').toBe(0);
    });

    test('TC-CBD-06 画像 paste が最優先で維持される（分岐位置の番人 / HM-2）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md']);
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        await page.waitForTimeout(100);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        // 画像 + fv メタの両方を持つ paste（画像分岐が先に勝つべき）
        const r = await page.evaluate(async () => {
            const el = document.querySelector('.outliner-node[data-id="b"] .outliner-text') as HTMLElement;
            el.focus();
            let html = '';
            const items = await navigator.clipboard.read();
            for (const it of items) {
                if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            }
            const dt = new DataTransfer();
            dt.setData('text/html', html);           // fv メタ入り
            const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
            dt.items.add(new File([blob], 'x.png', { type: 'image/png' }));
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            el.dispatchEvent(ev);
            return { types: Array.from(dt.types) };
        });
        await page.waitForTimeout(300);
        expect(r.types, '前提: 画像を含む paste イベント').toContain('Files');
        expect((await sentToOutliner(page)).length,
            '画像 paste の前に F 分岐が割り込んだ（HM-2 の挿入位置違反 — 画像分岐は最優先で維持する）').toBe(0);
    });

    test('TC-CBD-10 フォルダを含む payload も成立する', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['docs', 'a.md']);
        await pasteIntoNode(page, 'b');
        const calls = await sentToOutliner(page);
        expect(calls.length, 'フォルダを含む payload で F 分岐が発火しない').toBe(1);
        expect(calls[0].args[1], 'フォルダの relPath が除外された（host は dir を構造ごと取り込める）')
            .toEqual(['docs', 'a.md']);
    });

    test('TC-CBD-09 空 leaf node でも経路は分岐しない（host に targetNodeId + after で委ねる）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md'], {
            version: 1, rootIds: ['e', 'b'],
            nodes: { e: n('e', ''), b: n('b', 'bravo') },
        });
        await pasteIntoNode(page, 'e');           // text が空の leaf
        const calls = await sentToOutliner(page);
        expect(calls.length, '空 leaf node で F 分岐が発火しない').toBe(1);
        // 🔴 F の node 挿入は **host 側**（既存 sendFolderViewToOutliner = 「Outliner に送る」/ D&D と同一経路）。
        //    outliner 内 paste の「空 leaf なら現ノードを削除して置換」（pasteNodesFromText の分岐）は
        //    この経路を通らないので、**空 leaf でも引数は同じ**（targetNodeId + 'after'）。
        //    = 「同じ cmd+v なのに中身で挙動が違う」二重規範を作らない（R-δ の趣旨をこの形で満たす）。
        expect(calls[0].args[3], '空 leaf で targetNodeId が変わった（経路が分岐している）').toBe('e');
        expect(calls[0].args[4], "空 leaf で position が 'after' から変わった").toBe('after');
    });

    test('TC-CBD-50 大量件数も 1 回の配列で host へ渡る（件数ゲートが効ける形）', async ({ page }) => {
        await mountFv(page);
        // 250 件の relPaths を持つ F payload を直接 clipboard に置く（fv 側の選択操作を 250 回しない）
        await page.evaluate(async () => {
            const rels: string[] = [];
            for (let i = 0; i < 250; i++) { rels.push(`bulk${i}.txt`); }
            const meta = { v: 1, folderLinkId: 'fl1', relPaths: rels, copyId: 'bulk' };
            const html = '<div data-fractal-fv-clip="' + encodeURIComponent(JSON.stringify(meta)) + '">bulk</div>';
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob([rels.join('\n')], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
            })]);
        });
        await page.evaluate(() => { (window as any).__folderViewDispatcher.hideFolderView(); });
        await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, OUT_TREE);
        await page.waitForSelector('.outliner-node');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteIntoNode(page, 'b');
        const calls = await sentToOutliner(page);
        expect(calls.length, '250 件で host 呼び出しが 1 回でない（N 回呼ぶと件数ゲートを構造的に迂回する）').toBe(1);
        expect(calls[0].args[1].length, '250 件が 1 回の配列で渡っていない').toBe(250);
        // ゲート本体（≤200 即実行 / 201-2000 確認 modal / >2000 中断）は host 側 checkBatchLimit が持ち、
        // 既存 folder-import の unit が番人。webview 側の責務は「1 回の配列で渡す」ことだけ。
    });

    test('TC-CBD-66 既存 paste 経路の非回帰（md → outliner / cross-note メタ付き）', async ({ page }) => {
        await copyInFvThenOpenOutliner(page, ['a.md']);
        // ① md → outliner（text/x-any-md）は F 分岐に奪われない
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await page.locator('.outliner-node[data-id="b"] .outliner-text').click();
        await page.waitForTimeout(100);
        const mdRes = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('text/plain', '- item1\n- item2');
            dt.setData('text/x-any-md', '- item1\n- item2');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(250);
        expect((await sentToOutliner(page)).length, 'md payload の paste で F 分岐が誤発火した').toBe(0);
        expect(mdRes, 'md paste が従来どおり処理されていない（preventDefault されない）').toBe(true);

        // ② outliner の cross-note メタ（data-outliner-clipboard）は F 分岐に奪われない
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        const outRes = await page.evaluate(() => {
            const el = document.activeElement as HTMLElement;
            const meta = { nodes: [{ text: 'x', level: 0 }], sourceOutFileKey: 'other', isCut: false, copyId: 'zz' };
            const dt = new DataTransfer();
            dt.setData('text/plain', 'x');
            dt.setData('text/html', '<ul data-outliner-clipboard="' + encodeURIComponent(JSON.stringify(meta)) + '"><li>x</li></ul>');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(250);
        expect((await sentToOutliner(page)).length, 'outliner の cross-note paste で F 分岐が誤発火した').toBe(0);
        expect(outRes, 'cross-note paste が従来どおり処理されていない').toBe(true);
    });
});

// ═══════ G / H の受け手: linkedfd の cmd+v（FR-CBD-04/07 / DOM-FvClipPaste / ADRL-0118） ═══════

/** outliner の clipboard payload（G）を直接 clipboard に置く */
async function putOutlinerClip(page: Page, nodeIds: string[], outFileKey = 'fileA') {
    await page.evaluate(async ({ ids, key }) => {
        const meta = { nodes: ids.map((i: string) => ({ text: i, level: 0 })), sourceOutFileKey: key, isCut: false, copyId: 'g1', nodeIds: ids };
        const html = '<ul data-outliner-clipboard="' + encodeURIComponent(JSON.stringify(meta)) + '">'
            + ids.map((i: string) => '<li>' + i + '</li>').join('') + '</ul>';
        await navigator.clipboard.write([new ClipboardItem({
            'text/plain': new Blob([ids.join('\n')], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' }),
        })]);
    }, { ids: nodeIds, key: outFileKey });
}

/** 実 Chromium の配送先を模倣して `document.body` に paste を送る（HM-5 / TC-CBD-63） */
async function pasteToBody(page: Page) {
    await page.evaluate(async () => {
        let html = ''; let plain = '';
        const items = await navigator.clipboard.read();
        for (const it of items) {
            if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            if (it.types.includes('text/plain')) { plain = await (await it.getType('text/plain')).text(); }
        }
        const dt = new DataTransfer();
        dt.setData('text/plain', plain);
        dt.setData('text/html', html);
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(250);
}
const calledG = (page: Page) => page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.type === 'sendOutNodesToFolderLinkFromDrop'));
const calledMove = (page: Page) => page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.type === 'folderViewMove' || c.type === 'folderViewMoveBatch'));

test.describe('FR-CBD-04 G の受け手（outliner → linkedfd）', () => {
    test('TC-CBD-23 フォルダ行で cmd+v = そのフォルダの中', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1', 'n2']);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const g = await calledG(page);
        expect(g.length, 'G 分岐が発火していない（document レベル listener が無い / guard に落ちている）').toBe(1);
        expect(g[0].args[2], 'フォルダ行なのに dstDirRelPath がそのフォルダになっていない').toBe('docs');
        expect(g[0].args[0].nodeIds, 'nodeIds が host payload に渡っていない').toEqual(['n1', 'n2']);
        expect(g[0].args[0].outFileKey, 'outFileKey が渡っていない（host が .out を解決できない）').toBe('fileA');
        expect(g[0].args[1], 'folderLinkId が渡っていない').toBe('fl1');
    });

    test('TC-CBD-24 ファイル行で cmd+v = その行の親（同階層）', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1']);
        await clickRow(page, 'a.md');           // root 直下 → 親は ''
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const g = await calledG(page);
        expect(g.length).toBe(1);
        expect(g[0].args[2], 'ファイル行なのに親ディレクトリになっていない（その行自身を dst にしている）').toBe('');
    });

    test('TC-CBD-25 選択 0 件で cmd+v = root / TC-CBD-26 複数選択でもターゲットは focus 行 1 つ', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1']);
        // 選択をクリア（Esc）
        await page.keyboard.press('Escape');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        let g = await calledG(page);
        expect(g.length, '選択 0 件で G が発火しない').toBe(1);
        expect(g[0].args[2], '選択 0 件のとき root にならない').toBe('');

        // 複数選択（focus は最後に cmd+click した行）
        await clickRow(page, 'a.md');
        await clickRow(page, 'docs', { meta: true });
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        g = await calledG(page);
        expect(g.length).toBe(1);
        expect(g[0].args[2], 'focus 行（docs）1 つから解決されていない（選択集合に配っている）').toBe('docs');
    });

    test('TC-CBD-27 G は outliner の node を消さない（複製 / INV-3）', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1', 'n2']);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const types = await page.evaluate(() => (window as any).__calls.map((c: any) => c.type));
        // 🔴 TASK-25 (DET-6): **正の assert を先に置く**。旧実装は削除呼び出しの「不在」しか見ていないため
        // G 分岐が丸ごと発火しなくても green だった（pre-sprint base = G が存在しない木でも PASS を実測）。
        // 「壊さないこと」を見る TC には、意図した送信が起きたことを同じ test で必ず併記する。
        expect(types.filter((t: string) => t === 'sendOutNodesToFolderLinkFromDrop').length,
            'G の送信が起きていない（この TC は削除の不在しか見ていないので、送信が死んでも通ってしまう）')
            .toBe(1);
        for (const del of ['folderViewDelete', 'deleteOutlinerNodes', 'notesDeleteItem']) {
            expect(types.filter((t: string) => t === del).length, `${del} が呼ばれた（複製のはずが移動になっている）`).toBe(0);
        }
    });
});

test.describe('FR-CBD-07 H の受け手（linkedfd 内 c→v = 複製）', () => {
    test('TC-CBD-40 同階層で cmd+v は copy モードで複製される', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        await clickRow(page, 'c.txt');          // 同階層のファイル行 → dst = ''（root）
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length, 'H 分岐が発火していない').toBe(1);
        expect(mv[0].type, '1 件なので単数 bridge を通るはず').toBe('folderViewMove');
        expect(mv[0].args[3], "mode が 'copy' で渡っていない（source が消える = INV-3 違反）").toBe('copy');
        expect(mv[0].args[1], 'コピー元の relPath が渡っていない').toBe('a.md');
        expect(mv[0].args[2], '同階層（root）が dst になっていない').toBe('');
    });

    test('TC-CBD-41 フォルダ行で cmd+v はそのフォルダの中に複製', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length).toBe(1);
        expect(mv[0].args[2], 'フォルダ行なのにその中に複製されない').toBe('docs');
        expect(mv[0].args[3]).toBe('copy');
    });

    test('TC-CBD-42 複数選択の H は batch 1 回（copy）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await clickRow(page, 'b.pdf', { meta: true });
        await clickRow(page, 'c.txt', { meta: true });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length, 'batch が 1 回で呼ばれていない').toBe(1);
        expect(mv[0].type).toBe('folderViewMoveBatch');
        expect(mv[0].args[1], '3 件すべてが 1 回の配列で渡っていない').toEqual(['a.md', 'b.pdf', 'c.txt']);
        expect(mv[0].args[3], "batch にも 'copy' が forward されていない（SYS-1）").toBe('copy');
    });

    test('TC-CBD-43 H はフォルダも複製対象に含める（ADRL-0124 — 旧「フォルダは skip」は v1.3.16 で撤回）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await clickRow(page, 'docs', { meta: true });     // フォルダを混ぜる
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        // clipboard にはフォルダも載り（FR-CBD-01）、H の複製対象にもそのまま含まれる（FR-CBD-07 rev2）
        expect((await fvClipMeta(page)).relPaths, '前提: clipboard にはフォルダも載る').toEqual(['docs', 'a.md']);
        await clickRow(page, 'c.txt');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        const mv = await calledMove(page);
        expect(mv.length).toBe(1);
        const rels = mv[0].type === 'folderViewMoveBatch' ? mv[0].args[1] : [mv[0].args[1]];
        expect([...rels].sort(), 'フォルダが複製対象から落ちた（v1.3.16 以降はフォルダも複製する）').toEqual(['a.md', 'docs']);
    });
});

test.describe('ADRL-0118 の番人（INV-5 / guard / listener 累積）', () => {
    test('TC-CBD-62 ★ clipboard の真実は OS clipboard 1 つ（案 A なら RED）', async ({ page }) => {
        await mountFv(page);
        // ① linkedfd で a.md を cmd+c
        await clickRow(page, 'a.md');
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        // ② outliner の payload で clipboard を上書き（= ユーザーが outliner で cmd+c した状態）
        await putOutlinerClip(page, ['n1', 'n2']);
        // ③ linkedfd で cmd+v
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);

        const g = await calledG(page);
        const mv = await calledMove(page);
        expect(g.length,
            '★ outliner の内容が書き出されない — clipboard の真実が 2 つに分裂している（案 A = window 変数受け渡しの症状）').toBe(1);
        expect(mv.length,
            '★ 古い fv payload（a.md）が複製された — OS clipboard を単一の真実にしていない（ADRL-0118 が案 A を却下した根拠）').toBe(0);
    });

    test('TC-CBD-63 treeEl ではなく document.body 配送でも受かる（HM-5）', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1']);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        // treeEl に送っても届くが（bubbling）、**body 直送でも届く**ことが本 TC の趣旨。
        // treeEl.addEventListener('paste') 実装だと body 直送では届かず RED になる。
        await pasteToBody(page);
        expect((await calledG(page)).length,
            'document.body 配送で受からない（treeEl に listener を張っている = Chromium は collapsed selection では body に配送する）').toBe(1);
    });

    test('TC-CBD-64 listener が累積しない（note 切替 3 回後も 1 件だけ）', async ({ page }) => {
        await mountFv(page);
        // destroy → open を 3 回（note 切替の代替）
        for (let i = 0; i < 3; i++) {
            await page.evaluate(() => { (window as any).__folderViewDispatcher.hideFolderView(); });
            await page.evaluate(() => { (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs'); });
            await page.evaluate(() => {
                window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries: [
                    { name: 'docs', relPath: 'docs', isDir: true },
                    { name: 'a.md', relPath: 'a.md', isDir: false },
                ] }, '*');
            });
            await page.waitForSelector('.fv-row');
        }
        await putOutlinerClip(page, ['n1']);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        expect((await calledG(page)).length,
            'listener が累積して同じ paste で N 回処理された（destroy が document listener を剥がさないため idempotent guard が必須）').toBe(1);
    });

    test('TC-CBD-65 rename 入力中の cmd+c / cmd+v はテキスト操作（guard 4 段の 1・2 段目）', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await page.keyboard.press('Enter');            // インライン rename 開始
        await page.waitForSelector('.fv-row input', { timeout: 3000 });
        await putOutlinerClip(page, ['n1']);
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        // rename input を target にした paste（実 Chromium はテキスト選択があるので input に配送する）
        await page.evaluate(async () => {
            const input = document.querySelector('.fv-row input') as HTMLInputElement;
            input.focus();
            let html = '';
            const items = await navigator.clipboard.read();
            for (const it of items) {
                if (it.types.includes('text/html')) { html = await (await it.getType('text/html')).text(); }
            }
            const dt = new DataTransfer();
            dt.setData('text/plain', 'n1');
            dt.setData('text/html', html);
            input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(200);
        expect((await calledG(page)).length,
            'rename 入力中に G が発火した（input のテキスト paste が奪われる）').toBe(0);
        // cmd+c も同様（fv メタを書かない）
        await page.evaluate(() => navigator.clipboard.writeText('SENTINEL2'));
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(200);
        expect(await fvClipMeta(page), 'rename 入力中の cmd+c が fv メタを書いた').toBeNull();
    });

    test('TC-CBD-60 1 操作 = 1 処理（二重発火なし / 無反応なし）', async ({ page }) => {
        await mountFv(page);
        await putOutlinerClip(page, ['n1']);
        await clickRow(page, 'docs');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await pasteToBody(page);
        expect((await calledG(page)).length, 'paste 1 回で処理が 1 回でない（0 = 無反応 / 2 以上 = 二重発火）').toBe(1);
        // cmd+c も 1 回
        await clickRow(page, 'a.md');
        await page.evaluate(() => { (window as any).__calls.length = 0; });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(250);
        const meta = await fvClipMeta(page);
        expect(meta && meta.relPaths, 'cmd+c 1 回で clipboard が書かれていない（無反応）').toEqual(['a.md']);
    });
});

/**
 * TC-CBD-74（TASK-27 / NFR-CBD-04 / NFR-CBD-01）: **汎用 cmd+v の挙動を 1 つも変えない**。
 *
 * G / H の受け口は `document` レベルの paste listener なので、Chrome でテキストをコピーして
 * linkedfd で cmd+v したときに横取りしないことを pin する（私的属性を持たない `text/html` は
 * G / H いずれの分岐にも入らず `preventDefault()` もしない = ブラウザ既定の paste が生きる）。
 */
test.describe('TC-CBD-74 私的属性の無い HTML は横取りしない（汎用 cmd+v 不変）', () => {
    test('Chrome のテキストコピー相当の text/html では分岐に入らず preventDefault もしない', async ({ page }) => {
        await mountFv(page);
        await clickRow(page, 'a.md');
        await page.evaluate(() => { (window as any).__calls.length = 0; });

        const prevented = await page.evaluate(() => {
            // 外部アプリのリッチテキストコピー相当（data-outliner-clipboard / data-fractal-fv-clip なし）
            const dt = new DataTransfer();
            dt.setData('text/plain', 'hello from chrome');
            dt.setData('text/html', '<meta charset="utf-8"><p style="color:red">hello <b>from</b> chrome</p>');
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            document.body.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
        await page.waitForTimeout(150);

        expect(prevented,
            '私的属性の無い HTML で preventDefault された（通常の paste を奪っている）').toBe(false);
        const calls = await page.evaluate(() => (window as any).__calls.map((c: any) => c.type));
        expect(calls.filter((t: string) => t === 'sendOutNodesToFolderLinkFromDrop').length,
            'G 分岐が発火した（外部 HTML を outliner clip と誤認している）').toBe(0);
        expect(calls.filter((t: string) => t === 'folderViewMove' || t === 'folderViewMoveBatch').length,
            'H 分岐が発火した').toBe(0);
    });
});
