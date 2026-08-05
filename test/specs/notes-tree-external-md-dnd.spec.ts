/**
 * Notes ファイルツリーへの外部 markdown D&D — sprint 20260805-124854-tree-md-dnd-and-ol-lists
 * TASK-01 / FR-T01
 *
 * Finder / VS Code Explorer から .md をファイルツリーに drop → 新規 id で複製して note に登録。
 *
 * webview 側の責務（本 spec の検証範囲）:
 *   - 外部 files の dragover を preventDefault（既存 drop-line UX を出す）
 *   - drop で .md ファイルだけ FileReader で読み、bridge.notesRegisterExternalMd(items, parentId, index)
 *     を 1 回呼ぶ（items = 種別付き配列 [{kind:'md', name, content}]）
 *   - 挿入位置: item 上（ratio<0.5=前 / >=0.5=後）/ folder children=フォルダ内末尾 / root=ルート末尾
 *   - 非 md は黙ってスキップ・md 0 件なら bridge を呼ばない
 *   - 内部 tree D&D（dragItemId 非 null）中は外部分岐に入らない
 *
 * host 側の実登録（registerMarkdownFile 経由・新 id + md 実体 + H1 タイトル）は unit（末尾 describe）で
 * tmpdir 実測。実 UI のドラッグ起動は test-usecase.md で手動確認（synthetic DragEvent で zone 分岐を駆動）。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// host 側 unit 用: src から直接 import（Playwright の TS transform が src/shared の
// 手書き ./markdown-link-parser.js を解決する。out/shared require は copy-webview.js 未実行だと
// markdown-link-parser 欠落で collection abort するため避ける — generator_failures 2026-08-02）。
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { resolveSubpageTitle } from '../../src/shared/md-subpage-utils';

const fileList = [
    { filePath: '/test/note.md', title: 'Doc', id: 'mdDoc' },
    { filePath: '/test/plan.out', title: 'Plan', id: 'outPlan' },
];
// folder（fold1）+ その子 md（mdChild）を持つ構造。root は [mdDoc, outPlan, fold1]。
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'outPlan', 'fold1'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md' },
        outPlan: { type: 'file', id: 'outPlan', title: 'Plan', ext: 'out' },
        fold1: { type: 'folder', id: 'fold1', title: 'Folder One', childIds: ['mdChild'] },
        mdChild: { type: 'file', id: 'mdChild', title: 'Child', ext: 'md' },
    },
};
const fileListWithChild = [
    ...fileList,
    { filePath: '/test/child.md', title: 'Child', id: 'mdChild' },
];

async function bootNotes(page: import('@playwright/test').Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(({ fileList, structure }) => {
        (window as any).__testApi.initNotesPanel(fileList, '/test/plan.out', structure);
    }, { fileList: fileListWithChild, structure });
    await page.waitForTimeout(150);
    await page.evaluate(() => { (window as any).__testApi.notesMessages.length = 0; });
}

/**
 * 外部 md File を DataTransfer.items に載せて target 要素の指定 ratio に drop する。
 * md-dnd-anyext.spec.ts:20 の DataTransfer + File + defineProperty パターン。
 * synthetic DataTransfer は items.add(File) で types に 'Files' が乗り .files も連動する（実測済）。
 */
async function dropExternalFiles(
    page: import('@playwright/test').Page,
    dstSelector: string,
    files: { name: string; content: string; type?: string }[],
    ratio: number,
    opts: { targetIsRoot?: boolean } = {}
) {
    await page.evaluate(({ dstSelector, files, ratio, opts }) => {
        (window as any).__testApi.notesMessages.length = 0;
        const dst = document.querySelector(dstSelector) as HTMLElement;
        const dt = new DataTransfer();
        for (const f of files) {
            dt.items.add(new File([f.content], f.name, { type: f.type || 'text/markdown' }));
        }
        const r = dst.getBoundingClientRect();
        const y = r.top + r.height * ratio;
        const x = r.left + r.width / 2;
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(over, 'dataTransfer', { value: dt, configurable: true });
        dst.dispatchEvent(over);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(drop, 'dataTransfer', { value: dt, configurable: true });
        dst.dispatchEvent(drop);
    }, { dstSelector, files, ratio, opts });
    // FileReader は async → drop 後 waitForTimeout（先例に従う）
    await page.waitForTimeout(300);
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
}

test.describe('FR-T01: Note ファイルツリーへの外部 md D&D (webview)', () => {
    test.beforeEach(async ({ page }) => {
        await bootNotes(page);
    });

    // TC-T01-01: md item 上（ratio 0.3 = その item の前）に File mock drop
    test('TC-T01-01 md item 上（ratio 0.3）に外部 md drop → notesRegisterExternalMd 発火・content/name 正・その item の前', async ({ page }) => {
        const msgs = await dropExternalFiles(
            page, '[data-item-id="mdDoc"]',
            [{ name: 'external.md', content: '# External Title\n\nbody\n' }],
            0.3
        );
        const reg = msgs.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(1);
        expect(Array.isArray(reg[0].items)).toBe(true);
        expect(reg[0].items.length).toBe(1);
        expect(reg[0].items[0].kind).toBe('md');
        expect(reg[0].items[0].name).toBe('external.md');
        expect(reg[0].items[0].content).toContain('# External Title');
        // mdDoc は rootIds index 0 → その「前」= index 0
        expect(reg[0].parentId).toBe(null);
        expect(reg[0].index).toBe(0);
    });

    // TC-T01-01b: md item 上（ratio 0.8 = その item の後）に drop → index = その item の後
    test('TC-T01-01b md item 上（ratio 0.8）に外部 md drop → その item の後（index+1）', async ({ page }) => {
        const msgs = await dropExternalFiles(
            page, '[data-item-id="mdDoc"]',
            [{ name: 'external.md', content: '# X\n' }],
            0.8
        );
        const reg = msgs.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(1);
        expect(reg[0].parentId).toBe(null);
        // mdDoc は index 0 → その「後」= index 1
        expect(reg[0].index).toBe(1);
    });

    // TC-T01-02: root 空白 drop → parentId null・index = ルート末尾
    test('TC-T01-02 root 空白 drop → parentId null・index = ルート末尾', async ({ page }) => {
        const msgs = await dropExternalFiles(
            page, '#notesFileList',
            [{ name: 'root.md', content: '# Root\n' }],
            0.5, { targetIsRoot: true }
        );
        const reg = msgs.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(1);
        expect(reg[0].parentId).toBe(null);
        // rootIds = [mdDoc, outPlan, fold1] → 末尾 = 3
        expect(reg[0].index).toBe(3);
    });

    // TC-T01-03: folder children drop → parentId = フォルダ id・index = 末尾
    test('TC-T01-03 folder children drop → parentId = フォルダ id・index = フォルダ内末尾', async ({ page }) => {
        // folder children エリアは e.target === childrenEl のときのみハンドルされる。
        // fold1 の子は [mdChild]（1 件）→ 末尾 index = 1。
        const msgs = await page.evaluate(async () => {
            (window as any).__testApi.notesMessages.length = 0;
            const wrapper = document.querySelector('[data-folder-id="fold1"]') as HTMLElement;
            const children = wrapper.querySelector('.file-panel-folder-children') as HTMLElement;
            const dt = new DataTransfer();
            dt.items.add(new File(['# Into Folder\n'], 'infolder.md', { type: 'text/markdown' }));
            const r = children.getBoundingClientRect();
            const x = r.left + 5, y = r.top + Math.max(2, r.height - 2);
            const over = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y });
            Object.defineProperty(over, 'dataTransfer', { value: dt, configurable: true });
            Object.defineProperty(over, 'target', { value: children, configurable: true });
            children.dispatchEvent(over);
            const drop = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y });
            Object.defineProperty(drop, 'dataTransfer', { value: dt, configurable: true });
            Object.defineProperty(drop, 'target', { value: children, configurable: true });
            children.dispatchEvent(drop);
            return null;
        });
        await page.waitForTimeout(300);
        const all = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
        const reg = all.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(1);
        expect(reg[0].parentId).toBe('fold1');
        expect(reg[0].index).toBe(1); // 子 [mdChild] の末尾
        expect(reg[0].items[0].name).toBe('infolder.md');
    });

    // TC-T01-04: .md + .png 混在 drop → items に md のみ
    // counterfactual: 拡張子判定（/\.md$/i）を外すと png も入る = items.length 2 で RED
    test('TC-T01-04 ★counterfactual: .md + .png 混在 → items に md のみ（png はスキップ）', async ({ page }) => {
        const msgs = await dropExternalFiles(
            page, '[data-item-id="mdDoc"]',
            [
                { name: 'doc.md', content: '# Doc\n' },
                { name: 'pic.png', content: 'PNGDATA', type: 'image/png' },
                { name: 'note2.md', content: '# Note2\n' },
            ],
            0.3
        );
        const reg = msgs.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(1);
        // md のみ 2 件（png はスキップ）
        expect(reg[0].items.length).toBe(2);
        const names = reg[0].items.map((it: any) => it.name).sort();
        expect(names).toEqual(['doc.md', 'note2.md']);
        expect(reg[0].items.every((it: any) => it.kind === 'md')).toBe(true);
    });

    // TC-T01-04b: 非 md のみ（.png のみ）drop → bridge を呼ばない
    test('TC-T01-04b .png のみ drop → notesRegisterExternalMd 不発火（md 0 件は bridge を呼ばない）', async ({ page }) => {
        const msgs = await dropExternalFiles(
            page, '[data-item-id="mdDoc"]',
            [{ name: 'pic.png', content: 'PNGDATA', type: 'image/png' }],
            0.3
        );
        const reg = msgs.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(reg.length).toBe(0);
    });

    // TC-T01-05: 外部 files の dragover で preventDefault + 内部 drag 中は外部分岐に入らない
    test('TC-T01-05 外部 files の dragover で preventDefault + 内部 drag 中（dragstart 済）は外部分岐不発火', async ({ page }) => {
        const result = await page.evaluate(() => {
            const dst = document.querySelector('[data-item-id="mdDoc"]') as HTMLElement;
            const r = dst.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height * 0.3;

            // (A) 外部 files の dragover → defaultPrevented true
            const dtA = new DataTransfer();
            dtA.items.add(new File(['# A\n'], 'a.md', { type: 'text/markdown' }));
            const overA = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y });
            Object.defineProperty(overA, 'dataTransfer', { value: dtA, configurable: true });
            dst.dispatchEvent(overA);
            const externalPrevented = overA.defaultPrevented;

            // (B) 内部 tree D&D 開始（dragItemId 非 null）中に、外部 files を積んだ drop を撃つ →
            //     外部分岐に入らず notesRegisterExternalMd 不発火（内部 D&D 最優先）。
            (window as any).__testApi.notesMessages.length = 0;
            const src = document.querySelector('[data-item-id="outPlan"]') as HTMLElement; // .out を内部 drag 元に
            const dtB = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dtB }));
            // 内部 drag セッション中に「外部 files も積んだ」dt で mdDoc に drop
            dtB.items.add(new File(['# B\n'], 'b.md', { type: 'text/markdown' }));
            const dropB = new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y });
            Object.defineProperty(dropB, 'dataTransfer', { value: dtB, configurable: true });
            dst.dispatchEvent(dropB);
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dtB }));
            return { externalPrevented };
        });
        await page.waitForTimeout(300);
        const all = await page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.notesMessages)));
        const reg = all.filter((m: any) => m.type === 'notesRegisterExternalMd');
        expect(result.externalPrevented).toBe(true); // 外部 files の dragover は preventDefault
        expect(reg.length).toBe(0);                  // 内部 drag 中は外部分岐に入らない
    });
});

// ── host 側 unit: registerMarkdownFile 経由の登録を tmpdir 実測 ──
// NotesFileManager を src から直接 import（vscode 非依存経路。既存 notes-file-manager-*.spec.ts の先例）。
test.describe('FR-T01 unit: 外部 md 登録（NotesFileManager.registerMarkdownFile + resolveSubpageTitle）', () => {
    let tempDir: string;
    test.beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-ext-md-')); });
    test.afterEach(() => { if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true }); });

    // TC-T01-06: 外部 md content → 新 id で md 実体保存 + 構造登録 + H1 タイトル
    test('TC-T01-06 registerMarkdownFile: 新 id で md 実体 + structure 登録 + H1 由来タイトル', () => {
        const fm = new NotesFileManager(tempDir);
        const content = '# My External Doc\n\nbody text\n';
        const title = resolveSubpageTitle(content, 'external.md'); // H1 → 'My External Doc'
        expect(title).toBe('My External Doc');

        const newId = fm.registerMarkdownFile(content, title, null, 0);
        expect(typeof newId).toBe('string');
        expect(newId.length).toBeGreaterThan(0);

        // (a) md 実体が新 id で書かれている（note ルート直下 flat）
        const mdPath = fm.getMdFilePath(newId);
        expect(fs.existsSync(mdPath)).toBe(true);
        expect(fs.readFileSync(mdPath, 'utf8')).toContain('# My External Doc');

        // (b) structure に file item として登録され、rootIds 先頭
        const struct = fm.getStructureForWebview();
        expect(struct.items[newId]).toBeTruthy();
        expect(struct.items[newId].type).toBe('file');
        expect(struct.items[newId].ext).toBe('md');
        expect(struct.items[newId].title).toBe('My External Doc');
        expect(struct.rootIds[0]).toBe(newId);
    });

    // TC-T01-06b: H1 無し → ファイル名 stem がタイトル
    test('TC-T01-06b resolveSubpageTitle: H1 無しはファイル名 stem', () => {
        const title = resolveSubpageTitle('no heading here\n', 'plan-notes.md');
        expect(title).toBe('plan-notes');
    });
});
