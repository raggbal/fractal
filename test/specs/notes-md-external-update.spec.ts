/**
 * notes-md-external-update — notes メインペイン md の外部編集ライブ反映（FR-LR-03）E2E
 *
 * NotesMdMainManager が外部変更検知で送る `updateData{kind:'md', externalUpdate:true}` を、
 * dispatcher（shared/notes-md-dispatcher.js）が EditorInstance 破棄→再生成でなく
 * standalone md と同じ標準 `update` 経路（in-place・カーソル保持・編集中 queue）へ変換することを検証。
 *
 * 再生成の検出: mdInstance の editor DOM 要素に marker property を付けて生存確認
 * （再生成されると .editor が innerHTML 差し替えで作り直され marker が消える）。
 *
 * TC-LR-10 (load-bearing): externalUpdate → 内容更新 + 非再生成。
 *   counterfactual: externalUpdate なし（従来 loadMarkdown 経路）は marker が消える = in-place 分岐が load-bearing。
 * TC-LR-11: 編集中（isActivelyEditing）は queue され、idle（EDITING_IDLE_TIMEOUT=1500ms）後に反映。
 * TC-LR-12: filePath 不一致の externalUpdate は drop（内容不変・非再生成）。
 * TC-LR-13: externalUpdate なしの updateData{kind:'md'} は従来どおり loadMarkdown（再生成）。
 */
import { test, expect, Page } from '@playwright/test';

const MD_FILE = '/Users/test/notes/noteA/page-main.md';

async function setupMdPane(page: Page, initial: string) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    // dispatcher 経由で md pane を開く（externalUpdate なし = 通常 open = loadMarkdown）
    await page.evaluate(({ fp, md }) => {
        (window as any).__hostMessageHandler({
            type: 'updateData', kind: 'md', markdown: md, filePath: fp, documentBaseUri: '',
        });
    }, { fp: MD_FILE, md: initial });
    await page.waitForTimeout(300);
    // 再生成検出用 marker を editor DOM に付与
    await page.evaluate(() => {
        const ed: any = document.querySelector('.markdown-container .editor');
        if (ed) ed.__lrMarker = 'alive';
    });
}

function paneState(page: Page) {
    return page.evaluate(() => {
        const ed: any = document.querySelector('.markdown-container .editor');
        return {
            text: ed ? (ed.textContent || '') : null,
            markerAlive: !!(ed && ed.__lrMarker === 'alive'),
            bridgeFp: (window as any).notesMarkdownHostBridge?.filePath ?? null,
        };
    });
}

test.describe('notes md pane external update (FR-LR-03)', () => {
    test('TC-LR-10: externalUpdate は in-place 反映・EditorInstance 非再生成（load-bearing）', async ({ page }) => {
        await setupMdPane(page, '# hello\n');
        expect((await paneState(page)).bridgeFp, 'bridge.filePath が設定済み').toBe(MD_FILE);

        // 外部編集（AI 等）を模擬: NotesMdMainManager が送る externalUpdate
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# updated by AI\n', filePath: fp,
                documentBaseUri: '', externalUpdate: true,
            });
        }, { fp: MD_FILE });
        await page.waitForTimeout(300);

        const s = await paneState(page);
        expect(s.text, '外部編集が画面に反映される').toContain('updated by AI');
        expect(s.markerAlive, 'EditorInstance が再生成されていない（in-place）').toBe(true);

        // ★counterfactual: externalUpdate なし（従来の破棄→再生成 loadMarkdown 経路）だと marker が消える
        // = externalUpdate 分岐が無ければ再生成される（in-place 分岐が load-bearing）
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# recreated\n', filePath: fp, documentBaseUri: '',
            });
        }, { fp: MD_FILE });
        await page.waitForTimeout(300);
        const cf = await paneState(page);
        expect(cf.text).toContain('recreated');
        expect(cf.markerAlive, 'counterfactual: externalUpdate 無し経路は再生成される（marker 消滅）→ in-place 分岐が効いている証拠').toBe(false);
    });

    test('TC-LR-11: 編集中は queue され idle 後に反映（standalone と同じ挙動）', async ({ page }) => {
        await setupMdPane(page, '# base\n\ntyping here\n');
        // 実クリック→実キーで isActivelyEditing にする
        const editor = page.locator('.markdown-container .editor');
        await editor.click();
        await page.keyboard.type('abc');
        // 直後に外部更新
        await page.evaluate(({ fp }) => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# external while typing\n', filePath: fp,
                documentBaseUri: '', externalUpdate: true,
            });
        }, { fp: MD_FILE });
        await page.waitForTimeout(200);
        let s = await paneState(page);
        expect(s.text, '編集中は外部更新が即時適用されない（queue）').not.toContain('external while typing');
        expect(s.text, '入力が消えていない').toContain('abc');

        // EDITING_IDLE_TIMEOUT(1500ms) + マージン待ち → queue が flush される
        await page.waitForTimeout(2200);
        s = await paneState(page);
        expect(s.text, 'idle 後に外部更新が反映される').toContain('external while typing');
        expect(s.markerAlive, 'queue 適用も in-place（非再生成）').toBe(true);
    });

    test('TC-LR-12: filePath 不一致の externalUpdate は drop（stale 防御）', async ({ page }) => {
        await setupMdPane(page, '# original\n');
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# stale from other file\n',
                filePath: '/Users/test/notes/noteA/OTHER.md', documentBaseUri: '', externalUpdate: true,
            });
        });
        await page.waitForTimeout(300);
        const s = await paneState(page);
        expect(s.text, '不一致 externalUpdate は適用されない').toContain('original');
        expect(s.text).not.toContain('stale from other file');
        expect(s.markerAlive, '再生成もされない').toBe(true);
    });

    test('TC-LR-13: externalUpdate なしの updateData{kind:md} は従来どおり再生成 open（後方互換）', async ({ page }) => {
        await setupMdPane(page, '# first\n');
        // ユーザーがファイルパネルから別 md を開いた相当（externalUpdate なし）
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# second file\n',
                filePath: '/Users/test/notes/noteA/second.md', documentBaseUri: '',
            });
        });
        await page.waitForTimeout(300);
        const s = await paneState(page);
        expect(s.text, '新しい md が表示される').toContain('second file');
        expect(s.markerAlive, '通常 open は従来どおり再生成（marker 消滅）').toBe(false);
        expect(s.bridgeFp, 'bridge.filePath が新ファイルに更新される').toBe('/Users/test/notes/noteA/second.md');
    });
});
