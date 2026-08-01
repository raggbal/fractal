/**
 * md-dnd-anyext — md エディタへの任意拡張子 D&D（sprint 20260801-200307）
 *
 * FR-DDX-01: 素の .drawio を添付として受理（drawio-xml 棄却 = MD-46 の廃止 / ADRL-DDX-1）。
 * items チャネルにも file 添付 handler を追加（従来は非画像が素通り = designer_failures 2026-08-01）。
 * FR-DDX-02: md host の添付保存 basename/traversal sanitize。
 *
 * TC 定義: .harness/sprint/20260801-200307-export-multinode-dnd-anyext/testcases.md
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

// files チャネル（dataTransfer.files に File を入れて drop）で synthetic drop する。
// mindmap-file-drop.spec.ts の先例パターン（defineProperty で dataTransfer 差し込み）。
async function dropFileOnEditor(page: import('@playwright/test').Page, fileName: string, mime = 'application/octet-stream') {
    await page.evaluate(({ fileName, mime }) => {
        (window as any).__testApi.messages.length = 0;
        const editor = document.getElementById('editor')!;
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([60, 120, 62])], fileName, { type: mime });
        dt.items.add(file);
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        editor.dispatchEvent(ev);
    }, { fileName, mime });
    await page.waitForTimeout(300); // FileReader は async
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
}

// items チャネルのみ（dataTransfer.files を空にし items だけ持たせる）で drop する。
// DataTransfer の files は items 連動のため、files getter を空配列に上書きして items 経路を強制。
async function dropViaItemsOnly(page: import('@playwright/test').Page, fileName: string, mime = 'application/octet-stream') {
    await page.evaluate(({ fileName, mime }) => {
        (window as any).__testApi.messages.length = 0;
        const editor = document.getElementById('editor')!;
        const dt = new DataTransfer();
        const file = new File([new Uint8Array([60, 120, 62])], fileName, { type: mime });
        dt.items.add(file);
        Object.defineProperty(dt, 'files', { value: [], configurable: true }); // files 経路を封じる
        const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        editor.dispatchEvent(ev);
    }, { fileName, mime });
    await page.waitForTimeout(300);
    return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
}

test.describe('md エディタ任意拡張子 D&D', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.locator('#editor').click();
    });

    // TC-DDX-02 ★load-bearing: files チャネルの .drawio → 添付保存（saveFileAndInsert）+ ダイアログ非送出
    // counterfactual: drawio-xml 棄却分岐を戻すと notifyUnsupportedDrawioXml が飛び saveFile が飛ばず RED
    test('TC-DDX-02: files チャネルの .drawio drop → 添付として host 保存要求', async ({ page }) => {
        const msgs = await dropFileOnEditor(page, 'diagram.drawio', 'application/xml');
        const save = msgs.filter((m: any) => m.type === 'saveFileAndInsert' || m.type === 'saveFile');
        const reject = msgs.filter((m: any) => m.type === 'notifyUnsupportedDrawioXml');
        expect(save.length).toBe(1);
        expect(save[0].fileName || save[0].name).toBe('diagram.drawio');
        expect(reject.length).toBe(0);
    });

    // TC-DDX-03 ★load-bearing・counterfactual（design-review 指摘①の番人）:
    // items 経路の file handler が無い（旧実装）と非画像は素通りして save が飛ばず RED
    test('TC-DDX-03: items チャネルの非画像ファイル → file 添付として受理', async ({ page }) => {
        const msgsDrawio = await dropViaItemsOnly(page, 'diagram.drawio', 'application/xml');
        const saveDrawio = msgsDrawio.filter((m: any) => m.type === 'saveFileAndInsert' || m.type === 'saveFile');
        expect(saveDrawio.length).toBe(1);

        const msgsPdf = await dropViaItemsOnly(page, 'doc.pdf', 'application/pdf');
        const savePdf = msgsPdf.filter((m: any) => m.type === 'saveFileAndInsert' || m.type === 'saveFile');
        expect(savePdf.length).toBe(1);
        expect(savePdf[0].fileName || savePdf[0].name).toBe('doc.pdf');
    });

    // TC-DDX-05: 既存拡張子の非破壊（png=画像 / pdf=添付 / .drawio.svg=drawio 経路）
    test('TC-DDX-05: 既存分類の非破壊（png→画像 / pdf→添付 / drawio.svg→drawio）', async ({ page }) => {
        const msgsPng = await dropFileOnEditor(page, 'pic.png', 'image/png');
        const img = msgsPng.filter((m: any) => m.type === 'saveImageAndInsert' || m.type === 'saveImage' || (m.type || '').toLowerCase().includes('image'));
        expect(img.length).toBeGreaterThanOrEqual(1);

        const msgsPdf = await dropFileOnEditor(page, 'doc.pdf', 'application/pdf');
        const file = msgsPdf.filter((m: any) => m.type === 'saveFileAndInsert' || m.type === 'saveFile');
        expect(file.length).toBe(1);

        const msgsDrawioSvg = await dropFileOnEditor(page, 'diagram.drawio.svg', 'image/svg+xml');
        const drawio = msgsDrawioSvg.filter((m: any) => (m.type || '').toLowerCase().includes('drawio'));
        expect(drawio.length).toBeGreaterThanOrEqual(1);
    });
});

// TC-DDX-04: uri-list チャネル（source-contract: パス経路の分類 switch に drawio-xml 棄却が無い）
test.describe('uri-list チャネル（source-contract）', () => {
    test('TC-DDX-04: uri-list 分岐に drawio-xml 棄却が無く file 経路に落ちる', () => {
        const fs = require('fs');
        const src = fs.readFileSync(path.join(ROOT, 'src/webview/editor.js'), 'utf-8');
        // notifyUnsupportedDrawioXml の残骸が webview に無い（削除チェーン検証）
        expect(src.includes('notifyUnsupportedDrawioXml')).toBe(false);
        expect(src.includes("'drawio-xml'")).toBe(false);
        // uri-list 経路の file fallback（readAndInsertFile）は存続
        expect(src.includes('readAndInsertFile')).toBe(true);
    });
});

// TC-DDX-06: md host の添付ファイル名 sanitize（FR-DDX-02・source-contract）
// sprint 20260801-200307 (TASK-04, 許可: test_update): global `..` replace の廃止
// （正当名破壊バグ）に伴い、期待を「basename + 厳密名ガード・global replace 不在」へ更新。
test.describe('md host sanitize（TC-DDX-06）', () => {
    test('TC-DDX-06: local/shared 両版が basename + 厳密名ガードを持ち global .. replace が無い', () => {
        const fs = require('fs');
        for (const file of ['src/editorProvider.ts', 'src/shared/paste-asset-handler.ts']) {
            const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
            const fnIdx = src.indexOf('function generateUniqueFileNamePreserving');
            expect(fnIdx, file).toBeGreaterThan(-1);
            const block = src.slice(fnIdx, fnIdx + 900);
            expect(block, file).toContain('path.basename');
            expect(block, file).toContain("=== '..'"); // 厳密名ガード
            expect(block.includes("replace(/\\.\\./g"), file).toBe(false); // 正当名破壊の global replace 不在
        }
    });
});

// TC-DDX-07 ★load-bearing・counterfactual（TASK-04 test_add）:
// shared 版（Notes md 面の実使用実装）を直接 require した behavioral 番人。
// counterfactual: 厳密名ガードを旧 global /\.\./g replace に戻すと (a) が archivetar.gz になり RED
test.describe('shared sanitize behavioral（TC-DDX-07）', () => {
    test('TC-DDX-07: 連続ドット名保持・厳密名 .. フォールバック・正常名 no-op', () => {
        const fs = require('fs');
        const os = require('os');
        // shared 版は vscode 非依存で require 可（flat-pathbuilder.spec.ts の先例）
        const pah = require(path.join(ROOT, 'out/shared/paste-asset-handler.js'));
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-ddx07-'));
        try {
            // (a) 正当な連続ドット名は保持（global replace だと archivetar.gz に化けて RED）
            expect(pah.generateUniqueFileNamePreserving(tmpDir, 'archive..tar.gz')).toBe('archive..tar.gz');
            // (b) traversal / 厳密名は basename 化 + フォールバックで dir 外に書かれない
            expect(pah.generateUniqueFileNamePreserving(tmpDir, '../evil.drawio')).toBe('evil.drawio');
            expect(pah.generateUniqueFileNamePreserving(tmpDir, '..')).toBe('file');
            expect(pah.generateUniqueFileNamePreserving(tmpDir, 'a/b/c.pdf')).toBe('c.pdf');
            // (c) 正常名は no-op・collision 時は既存 suffix 挙動
            expect(pah.generateUniqueFileNamePreserving(tmpDir, 'report.pdf')).toBe('report.pdf');
            fs.writeFileSync(path.join(tmpDir, 'report.pdf'), 'x');
            expect(pah.generateUniqueFileNamePreserving(tmpDir, 'report.pdf')).toBe('report-1.pdf');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
