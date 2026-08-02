/**
 * Notes ファイルパネル D&D — sprint 20260727-124904-filetree-dnd-and-node-paste-assets
 * TC-DD-01〜05 (testcases.md §A)
 *
 * FR-DD-01: md ドラッグ × .out ドロップ先の 3 ゾーン（上 25%=兄 / 中央 50%=取り込み /
 * 下 25%=弟）。従来は Feature A 分岐が ratio を見ず全域 import 扱い = 兄弟ドロップ不可バグ。
 *
 * 検証対象は zone 判定 → bridge 呼び分け（moveItem vs notesImportMdIntoOut）。
 * file tree は HTML 要素（draggable 有効）なので DataTransfer 付き drag イベント dispatch で
 * zone ロジックを駆動する（SVG の native drag 制約は非該当）。実 UI のドラッグ起動は
 * test-usecase.md US-DD で手動確認。
 */

import { test, expect } from '@playwright/test';

const fileList = [
    { filePath: '/test/note.md', title: 'Doc', id: 'mdDoc' },
    { filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' },
    { filePath: '/test/log.out', title: 'Log', id: 'outLog' },
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'outPlan', 'outLog'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
        outLog: { type: 'file', id: 'outLog', title: 'Log', ext: 'out' },
    },
};

test.describe('Notes ファイルパネル D&D (md → out 3 ゾーン)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, '/test/plan.out', structure);
        }, { fileList, structure });
        await page.waitForTimeout(150);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
    });

    /** dragItemId 状態を作ってから target の指定 ratio に dragover→drop を dispatch */
    async function dragTo(page: import('@playwright/test').Page, srcId: string, dstId: string, ratio: number) {
        await page.evaluate(({ srcId, dstId, ratio }) => {
            const src = document.querySelector(`[data-item-id="${srcId}"]`) as HTMLElement;
            const dst = document.querySelector(`[data-item-id="${dstId}"]`) as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = dst.getBoundingClientRect();
            const y = r.top + r.height * ratio;
            const x = r.left + r.width / 2;
            dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        }, { srcId, dstId, ratio });
        await page.waitForTimeout(100);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
    }

    test('TC-DD-01 ★バグ counterfactual: md を .out の上端 (ratio 0.1) → moveItem (兄) / import 非発火', async ({ page }) => {
        const msgs = await dragTo(page, 'mdDoc', 'outPlan', 0.1);
        const move = msgs.filter((m: any) => m.type === 'moveItem');
        const imp = msgs.filter((m: any) => m.type === 'notesImportMdIntoOut');
        // 修正前: 全域 import → moveItem 0 件 / import 1 件 = RED
        expect(imp.length).toBe(0);
        expect(move.length).toBe(1);
        expect(move[0].itemId).toBe('mdDoc');
        // 兄 = outPlan の位置 (rootIds 内 index 1)。mdDoc は index 0 から動くので調整後 index 0
        expect(move[0].index).toBe(0);
    });

    test('TC-DD-02 md を .out の下端 (ratio 0.9) → moveItem (弟)', async ({ page }) => {
        const msgs = await dragTo(page, 'mdDoc', 'outPlan', 0.9);
        const move = msgs.filter((m: any) => m.type === 'moveItem');
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOut').length).toBe(0);
        expect(move.length).toBe(1);
        // 弟 = outPlan の直後。mdDoc(0) が抜けて調整され index 1
        expect(move[0].index).toBe(1);
    });

    test('TC-DD-03 md を .out の中央 (ratio 0.5) → notesImportMdIntoOut (従来)', async ({ page }) => {
        const msgs = await dragTo(page, 'mdDoc', 'outPlan', 0.5);
        const imp = msgs.filter((m: any) => m.type === 'notesImportMdIntoOut');
        expect(msgs.filter((m: any) => m.type === 'moveItem').length).toBe(0);
        expect(imp.length).toBe(1);
        expect(imp[0].mdFileId).toBe('mdDoc');
        expect(imp[0].targetOutId).toBe('outPlan');
    });

    test('TC-DD-04 dragover 表示: 上端=before line / 中央=黄色 / 下端=after line (排他)', async ({ page }) => {
        const state = await page.evaluate(() => {
            const src = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const dst = document.querySelector('[data-item-id="outPlan"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = dst.getBoundingClientRect();
            const over = (ratio: number) => {
                dst.dispatchEvent(new DragEvent('dragover', {
                    bubbles: true, dataTransfer: dt,
                    clientX: r.left + r.width / 2, clientY: r.top + r.height * ratio,
                }));
                return {
                    yellow: dst.classList.contains('file-panel-drag-over-md-into-out'),
                    line: !!document.querySelector('.file-panel-drop-line, .file-panel-drop-indicator'),
                };
            };
            const top = over(0.1);
            const mid = over(0.5);   // 中央に移動 → 黄色・line 消える
            const bottom = over(0.9);
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return { top, mid, bottom };
        });
        expect(state.top.yellow).toBe(false);   // 上端は黄色でない（修正前は true = RED）
        expect(state.top.line).toBe(true);      // before インジケータ
        expect(state.mid.yellow).toBe(true);    // 中央は黄色
        expect(state.bottom.yellow).toBe(false);
        expect(state.bottom.line).toBe(true);
    });

    test('TC-DD-06 谷間フォールバック: 線表示後に item 間の隙間で drop しても線位置に挿入（TASK-A2）', async ({ page }) => {
        // 実機バグ再現: item 上で線が出た後、item 間の margin/線の谷間 (dragover target が
        // listEl になる) で drop → 旧実装は末尾移動 or 不発。修正後は直近の線位置に挿入。
        const msgs = await page.evaluate(() => {
            const src = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const dst = document.querySelector('[data-item-id="outPlan"]') as HTMLElement;
            const list = dst.parentElement as HTMLElement; // listEl (直接の親がリスト)
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = dst.getBoundingClientRect();
            // 1. item 上端で dragover → before 線が出る
            dst.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top + 2,
            }));
            // 2. 谷間へ移動 (target = listEl 直接。座標は item 間)
            list.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top - 1,
            }));
            // 3. そのまま listEl 上で drop（旧実装: ルート末尾移動 = index 2 / 修正後: before 線位置）
            list.dispatchEvent(new DragEvent('drop', {
                bubbles: true, dataTransfer: dt,
                clientX: r.left + r.width / 2, clientY: r.top - 1,
            }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
        });
        await page.waitForTimeout(100);
        const move = msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        // 線は outPlan の before → mdDoc(index0) が抜けて調整後 index 0（末尾 index 2 なら旧挙動 = RED）
        expect(move[0].index).toBe(0);
        expect(move[0].targetParentId).toBe(null);
    });

    test('TC-DD-07 ネスト末尾の after escalation: X 座標で「w の後ろ / df の後ろ」を選べる（改善1）', async ({ page }) => {
        // 再現構造: d > [ee(md), df > [ っっd, w(folder) ]] — w は df の最終子
        await page.evaluate(() => {
            const fileList = [
                { filePath: '/test/ee.md', title: 'ee', id: 'ee' },
                { filePath: '/test/ttd.out', title: 'っっd', id: 'ttd' },
            ];
            const structure = {
                version: 1,
                rootIds: ['d'],
                items: {
                    d: { type: 'folder', id: 'd', title: 'd', childIds: ['ee', 'df'], collapsed: false },
                    ee: { type: 'file', id: 'ee', title: 'ee', ext: 'md' },
                    df: { type: 'folder', id: 'df', title: 'd f', childIds: ['ttd', 'w'], collapsed: false },
                    ttd: { type: 'file', id: 'ttd', title: 'っっd', ext: 'out' },
                    w: { type: 'folder', id: 'w', title: 'w', childIds: [], collapsed: false },
                },
            };
            (window as any).__testApi.initNotesPanel(fileList, '/test/ttd.out', structure);
        });
        await page.waitForTimeout(150);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });

        const drag = async (deepX: boolean) => page.evaluate((useDeepX) => {
            (window as any).__testApi.notesMessages.length = 0;
            const src = document.querySelector('[data-item-id="ee"]') as HTMLElement;
            const wHeader = document.querySelector('[data-item-id="w"] .file-panel-folder-header') as HTMLElement;
            const wWrapper = document.querySelector('[data-item-id="w"]') as HTMLElement;
            const dfWrapper = document.querySelector('[data-item-id="df"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = wHeader.getBoundingClientRect();
            // 下端 (after ゾーン)。X: deep = w のインデント内 / shallow = df のインデント（w の左端より左）
            const x = useDeepX
                ? wWrapper.getBoundingClientRect().left + 40
                : dfWrapper.getBoundingClientRect().left + 2;
            const y = r.top + r.height * 0.9;
            wHeader.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            wHeader.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return JSON.parse(JSON.stringify((window as any).__testApi.notesMessages));
        }, deepX);

        // 深い X（w のインデント）→ w の後ろ = df の子として index 2（ee は df 外なので調整なし）
        let msgs = await drag(true);
        let move = msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].targetParentId).toBe('df');
        expect(move[0].index).toBe(2);
        // 浅い X（df のインデント）→ df の後ろ = d の子として（改善前は不可能だった位置）
        msgs = await drag(false);
        move = msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].targetParentId).toBe('d');
        expect(move[0].index).toBe(1); // ee(0) が抜けて df(元1→0) の後ろ = 1
    });

    test('TC-DD-08 インデント帯: 最終子 D の「左寄り」dragover で親 B の後ろの線 + drop（改善1 再検収）', async ({ page }) => {
        // 再現構造 (画像1): A(md), B(folder) > [C, D(md)]。E なしで「B の後ろ」を選べること。
        // 「D の左寄り」はカーソルが D item の左 = B children の padding 帯に出るため、
        // dragover target が children 要素になる → 谷間復元が X で escalation を再評価する必要がある。
        await page.evaluate(() => {
            const fileList = [
                { filePath: '/test/A.md', title: 'A', id: 'A' },
                { filePath: '/test/C.out', title: 'C', id: 'C' },
                { filePath: '/test/D.md', title: 'D', id: 'D' },
            ];
            const structure = {
                version: 1,
                rootIds: ['A', 'B'],
                items: {
                    A: { type: 'file', id: 'A', title: 'A', ext: 'md' },
                    B: { type: 'folder', id: 'B', title: 'B', childIds: ['C', 'D'], collapsed: false },
                    C: { type: 'file', id: 'C', title: 'C', ext: 'out' },
                    D: { type: 'file', id: 'D', title: 'D', ext: 'md' },
                },
            };
            (window as any).__testApi.initNotesPanel(fileList, '/test/C.out', structure);
        });
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
            (window as any).__testApi.notesMessages.length = 0;
            const src = document.querySelector('[data-item-id="A"]') as HTMLElement;
            const dEl = document.querySelector('[data-item-id="D"]') as HTMLElement;
            const bWrapper = document.querySelector('[data-item-id="B"]') as HTMLElement;
            const childrenEl = bWrapper.querySelector('.file-panel-folder-children') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const dr = dEl.getBoundingClientRect();
            // 1. D 上（深い X・下半分）→ 線 = D の後ろ（lastDropLine が積まれる）
            dEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, dataTransfer: dt,
                clientX: dr.left + 40, clientY: dr.top + dr.height * 0.9,
            }));
            // 2. 左寄り（B のインデント帯 = children padding 領域。target = children 要素）
            const bx = bWrapper.getBoundingClientRect().left + 2;
            childrenEl.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, dataTransfer: dt,
                clientX: bx, clientY: dr.top + dr.height * 0.9,
            }));
            // 線の幅 = B の階層（B wrapper の直後 = listEl レベル）に出ているか
            const line = document.querySelector('.file-panel-drop-line') as HTMLElement;
            const lineAtRootLevel = !!(line && line.previousElementSibling === bWrapper);
            // 3. その場で drop
            childrenEl.dispatchEvent(new DragEvent('drop', {
                bubbles: true, dataTransfer: dt,
                clientX: bx, clientY: dr.top + dr.height * 0.9,
            }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return {
                lineAtRootLevel,
                msgs: JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)),
            };
        });
        // 線が B の後ろ（root レベル）に表示されていた
        expect(result.lineAtRootLevel).toBe(true);
        // drop は「B の後ろ = root の兄弟」（旧挙動: D の後ろ = B の子、なら parentId='B' で RED）
        const move = result.msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].targetParentId).toBe(null);
        expect(move[0].index).toBe(1); // A(0) が抜けて B(元1→0) の後ろ = 1
    });

    test('TC-DD-09 ★TASK-06 counterfactual: フォルダ行の after 帯拡大（ratio 0.65）で after 線（旧実装は into-folder）', async ({ page }) => {
        // 真因: フォルダ行の after 帯（clientX escalation が効く帯）が旧 25%（ratio>0.75）と薄く、
        //   ratio 0.65 は into-folder（黄色扱いはないが drop=フォルダ内先頭）に落ちていた。
        //   TASK-06 で after 帯を下端 40%（ratio>0.60）に拡大 → 0.65 は after（兄弟挿入）になる。
        // counterfactual（実測）: しきい値を 0.75 に戻すと ratio 0.65 は into-folder となり
        //   dragover で after 線が出ず（file-panel-drag-over class）、drop が moveItem(folderId, 0) = RED。
        await page.evaluate(() => {
            const fileList = [
                { filePath: '/test/A.md', title: 'A', id: 'A' },
                { filePath: '/test/C.out', title: 'C', id: 'C' },
            ];
            const structure = {
                version: 1,
                rootIds: ['A', 'B'],
                items: {
                    A: { type: 'file', id: 'A', title: 'A', ext: 'md' },
                    // 空フォルダ B（子なし = resolveAfterEscalation は B 自身を返す → B の後ろ = root 兄弟）
                    B: { type: 'folder', id: 'B', title: 'B', childIds: [], collapsed: false },
                },
            };
            (window as any).__testApi.initNotesPanel(fileList, '/test/A.md', structure);
        });
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
            (window as any).__testApi.notesMessages.length = 0;
            const src = document.querySelector('[data-item-id="A"]') as HTMLElement;
            const bWrapper = document.querySelector('[data-item-id="B"]') as HTMLElement;
            const header = bWrapper.querySelector('.file-panel-folder-header') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = header.getBoundingClientRect();
            // ratio 0.65: 旧 0.75 帯の外（into-folder）・新 0.60 帯の内（after）
            const x = r.left + r.width / 2;
            const y = r.top + r.height * 0.65;
            header.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            // dragover 表示: after 線が出る（into-folder の黄色 highlight class ではない）
            const afterLine = !!document.querySelector('.file-panel-drop-line');
            const intoFolder = header.classList.contains('file-panel-drag-over') ||
                bWrapper.classList.contains('file-panel-drag-over');
            header.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return {
                afterLine, intoFolder,
                msgs: JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)),
            };
        });
        await page.waitForTimeout(100);
        // dragover: after 線が出て into-folder highlight ではない（旧 0.75 帯なら逆 = RED）
        expect(result.afterLine).toBe(true);
        expect(result.intoFolder).toBe(false);
        // drop: B の後ろ（root 兄弟）に挿入（旧挙動 = moveItem(B, 0) = フォルダ内先頭 なら RED）
        const move = result.msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].targetParentId).toBe(null); // root 兄弟（B の中ではない）
        // A(index0) が抜けて B(元1→0) の後ろ = 1
        expect(move[0].index).toBe(1);
    });

    test('TC-DD-10 ★TASK-06 回帰: フォルダ行中央（ratio 0.4）は依然 into-folder（帯縮小の番人）', async ({ page }) => {
        // 帯境界の移動で into-folder が 0.25–0.75 → 0.25–0.60 に縮むが、中央寄り 0.4 は依然 into-folder。
        await page.evaluate(() => {
            const fileList = [{ filePath: '/test/A.md', title: 'A', id: 'A' }];
            const structure = {
                version: 1,
                rootIds: ['A', 'B'],
                items: {
                    A: { type: 'file', id: 'A', title: 'A', ext: 'md' },
                    B: { type: 'folder', id: 'B', title: 'B', childIds: [], collapsed: false },
                },
            };
            (window as any).__testApi.initNotesPanel(fileList, '/test/A.md', structure);
        });
        await page.waitForTimeout(150);
        const result = await page.evaluate(() => {
            (window as any).__testApi.notesMessages.length = 0;
            const src = document.querySelector('[data-item-id="A"]') as HTMLElement;
            const bWrapper = document.querySelector('[data-item-id="B"]') as HTMLElement;
            const header = bWrapper.querySelector('.file-panel-folder-header') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const r = header.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height * 0.4; // 0.25–0.60 の into-folder 帯内
            header.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            const intoFolder = header.classList.contains('file-panel-drag-over') ||
                bWrapper.classList.contains('file-panel-drag-over');
            header.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: x, clientY: y }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return {
                intoFolder,
                msgs: JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)),
            };
        });
        await page.waitForTimeout(100);
        expect(result.intoFolder).toBe(true); // 中央帯は into-folder のまま
        const move = result.msgs.filter((m: any) => m.type === 'moveItem');
        expect(move.length).toBe(1);
        expect(move[0].targetParentId).toBe('B'); // フォルダ内（B の中）
        expect(move[0].index).toBe(0);
    });

    test('TC-DD-05 非回帰: md→md (0.5 境界 2 分割) / out→out / out→md が従来どおり兄弟可', async ({ page }) => {
        // md → md: 上半分 = before
        let msgs = await dragTo(page, 'mdDoc', 'outLog', 0.4); // out 相手中央寄り上… まず md→md
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        // out → out: 上半分 = before（import 系は発火しない）
        msgs = await dragTo(page, 'outLog', 'outPlan', 0.3);
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOut').length).toBe(0);
        expect(msgs.filter((m: any) => m.type === 'moveItem').length).toBe(1);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        // out → md: 下半分 = after
        msgs = await dragTo(page, 'outPlan', 'mdDoc', 0.7);
        expect(msgs.filter((m: any) => m.type === 'moveItem').length).toBe(1);
        expect(msgs.filter((m: any) => m.type === 'notesImportMdIntoOut').length).toBe(0);
        await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
        // md → md: 兄弟可（0.5 境界）
        msgs = await dragTo(page, 'outLog', 'mdDoc', 0.3); // out→md 上 = before で moveItem
        expect(msgs.filter((m: any) => m.type === 'moveItem').length).toBe(1);
    });
});
