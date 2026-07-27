/**
 * outliner node リスト → md editor paste の添付複製 — sprint 20260727-124904
 * TC-NP-01〜07 (unit: buildOutlinerNodesPasteMd) + TC-NP-10〜12 (E2E: editor.js 検知)
 *
 * unit は out/shared/paste-asset-handler.js を require（tsc 済み前提）。
 * E2E は standalone-editor.html で clipboard html を注入した実 paste イベント駆動。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pah = require(path.join(ROOT, 'out/shared/paste-asset-handler.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkParser = require(path.join(ROOT, 'src/shared/markdown-link-parser.js'));

/** src fixture: out dir（page md p1.md + images/pic.png + files/doc.pdf） */
function makeSrcFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-np-src-'));
    fs.mkdirSync(path.join(dir, 'images'));
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'p1.md'), '# Page One\n\n![](images/pic.png)\n');
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNGDATA');
    fs.writeFileSync(path.join(dir, 'files', 'doc.pdf'), 'PDFDATA');
    return dir;
}
function makeDest() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-np-dest-'));
    fs.writeFileSync(path.join(dir, 'target.md'), '# Target\n');
    return dir;
}

function build(nodes: any[], src: string, dest: string, genIds?: string[]) {
    let i = 0;
    return pah.buildOutlinerNodesPasteMd({
        nodes,
        srcOutDir: src, srcPagesDir: src, srcFileDir: path.join(src, 'files'),
        destMdPath: path.join(dest, 'target.md'),
        destFilesDir: path.join(dest, 'files'),
        destImagesDir: path.join(dest, 'images'),
        generatePageId: genIds ? () => genIds[i++] : undefined,
    });
}

test.describe('buildOutlinerNodesPasteMd (unit)', () => {
    let src: string, dest: string;
    test.beforeEach(() => { src = makeSrcFixture(); dest = makeDest(); });
    test.afterEach(() => {
        fs.rmSync(src, { recursive: true, force: true });
        fs.rmSync(dest, { recursive: true, force: true });
    });

    test('TC-NP-01 isPage node → 複製 + subpage リンク（参照画像も複製・newId ≠ 元 id）', () => {
        const r = build([{ text: 'My Page', level: 0, isPage: true, pageId: 'p1', images: [] }],
            src, dest, ['new-1']);
        // 改善2 (手動検収): 素の nodetext を繰り返さずリンクのみ
        expect(r.markdown).toContain('- [[My Page]](new-1.md)');
        expect(r.markdown).not.toContain('- My Page [[');
        // 複製 md が dest md と同 dir に存在（dirname(対象 md) 規約）
        expect(fs.existsSync(path.join(dest, 'new-1.md'))).toBe(true);
        // 元は不変（1:1 所有 — 新実体）
        expect(fs.existsSync(path.join(src, 'p1.md'))).toBe(true);
        // 複製 md の参照画像も dest 側に複製されている
        const body = fs.readFileSync(path.join(dest, 'new-1.md'), 'utf8');
        const imgRef = body.match(/!\[\]\(([^)]+)\)/)?.[1];
        expect(imgRef).toBeTruthy();
        expect(fs.existsSync(path.resolve(dest, imgRef!))).toBe(true);
    });

    test('TC-NP-02 title の `]` はサニタイズされ実 parser で isSubpage 解析可能', () => {
        const r = build([{ text: 'Weird ] Title [x]', level: 0, isPage: true, pageId: 'p1', images: [] }],
            src, dest, ['new-2']);
        const line = r.markdown.split('\n').find((l: string) => l.includes('new-2.md'))!;
        // 実 parser に通す（消費側制約の番人 — designer_failures 2026-07-26）
        const links = linkParser.parseMarkdownLinks(line);
        const sub = links.find((l: any) => l.isSubpage);
        expect(sub).toBeTruthy();
        expect(sub.url).toBe('new-2.md');
        expect(sub.alt).not.toContain(']'); // 半角 ] が残っていない
    });

    test('TC-NP-03 元 page md 不在 → 行は残りリンクなし・例外なし', () => {
        const r = build([{ text: 'Ghost', level: 0, isPage: true, pageId: 'no-such', images: [] }],
            src, dest, ['new-3']);
        expect(r.markdown).toContain('- Ghost');
        expect(r.markdown).not.toContain('new-3.md');
        expect(fs.existsSync(path.join(dest, 'new-3.md'))).toBe(false);
    });

    test('TC-NP-04 filePath node → files に複製 + 📎 リンク。衝突時 uniquify', () => {
        const r1 = build([{ text: 'Attach', level: 0, filePath: 'files/doc.pdf' }], src, dest);
        // 改善2: nodetext がリンクテキスト（素の text 繰り返しなし）
        expect(r1.markdown).toContain('- [📎 Attach](files/doc.pdf)');
        expect(r1.markdown).not.toContain('- Attach [📎');
        expect(fs.existsSync(path.join(dest, 'files', 'doc.pdf'))).toBe(true);
        // 2 回目 → uniquify（既存を上書きしない = 1:1）
        const r2 = build([{ text: 'Attach2', level: 0, filePath: 'files/doc.pdf' }], src, dest);
        const m = r2.markdown.match(/\]\((files\/[^)]+)\)/);
        expect(m![1]).not.toBe('files/doc.pdf'); // files/doc-1.pdf 等 (uniquify)
        expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    });

    test('TC-NP-05 images node（非 page）→ images に複製 + 画像行', () => {
        const r = build([{ text: 'Pic node', level: 1, images: ['images/pic.png'] }], src, dest);
        expect(r.markdown).toContain('  - Pic node');
        const m = r.markdown.match(/!\[\]\((images\/[^)]+)\)/);
        expect(m).toBeTruthy();
        expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    });

    test('TC-NP-06 混在リスト: インデント構造維持 + 添付なし行は不変', () => {
        const r = build([
            { text: 'root', level: 0 },
            { text: 'page child', level: 1, isPage: true, pageId: 'p1', images: [] },
            { text: 'file child', level: 1, filePath: 'files/doc.pdf' },
            { text: 'plain grandchild', level: 2 },
        ], src, dest, ['new-6']);
        const lines = r.markdown.trimEnd().split('\n');
        expect(lines[0]).toBe('- root');
        expect(lines[1]).toMatch(/^  - \[\[page child\]\]\(new-6\.md\)$/);
        expect(lines[2]).toMatch(/^  - \[📎 file child\]/);
        expect(lines[3]).toBe('    - plain grandchild');
    });

    test('TC-NP-07 同一 pageId × 2 node → 別 newId で 2 実体（dedup しない = 1:1 所有）', () => {
        const r = build([
            { text: 'A', level: 0, isPage: true, pageId: 'p1', images: [] },
            { text: 'B', level: 0, isPage: true, pageId: 'p1', images: [] },
        ], src, dest, ['id-a', 'id-b']);
        expect(r.markdown).toContain('(id-a.md)');
        expect(r.markdown).toContain('(id-b.md)');
        expect(fs.existsSync(path.join(dest, 'id-a.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'id-b.md'))).toBe(true);
    });
});

// ============ E2E: editor.js 検知（TC-NP-10〜12） ============

function outlinerClipboardHtml(nodes: any[]) {
    const meta = encodeURIComponent(JSON.stringify({ nodes, sourceOutFileKey: '/test/src.out', isCut: false, copyId: 'c1' }));
    const items = nodes.map((n: any) => `<li>${n.text}</li>`).join('');
    return `<ul data-outliner-clipboard="${meta}">${items}</ul>`;
}

test.describe('editor.js 検知 (E2E)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-editor.html');
        await page.waitForSelector('#editor');
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    });

    async function pasteHtml(page: import('@playwright/test').Page, html: string, plain: string) {
        await page.click('#editor');
        await page.evaluate(({ html, plain }) => {
            const editor = document.getElementById('editor')!;
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', plain);
            const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
            (document.activeElement || editor).dispatchEvent(ev);
        }, { html, plain });
        await page.waitForTimeout(200);
        return page.evaluate(() => JSON.parse(JSON.stringify((window as any).__testApi.messages)));
    }

    test('TC-NP-10 添付付き nodes → pasteOutlinerNodesWithAssets が発火（plainText/nodes を運ぶ）', async ({ page }) => {
        const nodes = [
            { text: 'plain', level: 0, isPage: false, pageId: null, images: [], filePath: null },
            { text: 'paged', level: 1, isPage: true, pageId: 'p1', images: [], filePath: null },
        ];
        const msgs = await pasteHtml(page, outlinerClipboardHtml(nodes), 'plain\n\tpaged');
        const hit = msgs.filter((m: any) => m.type === 'pasteOutlinerNodesWithAssets');
        expect(hit.length).toBe(1);
        expect(hit[0].plainText).toBe('plain\n\tpaged');
        expect(hit[0].nodes.length).toBe(2);
        expect(hit[0].nodes[1].pageId).toBe('p1');
    });

    test('TC-NP-11 counterfactual: 添付なし nodes → 新 message 非発火・従来リスト貼り付け', async ({ page }) => {
        const nodes = [
            { text: 'aaa', level: 0, isPage: false, pageId: null, images: [], filePath: null },
            { text: 'bbb', level: 1, isPage: false, pageId: null, images: [], filePath: null },
        ];
        const msgs = await pasteHtml(page, outlinerClipboardHtml(nodes), 'aaa\n\tbbb');
        expect(msgs.filter((m: any) => m.type === 'pasteOutlinerNodesWithAssets').length).toBe(0);
        // 従来経路でリストとして挿入されている
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        expect(html).toContain('aaa');
        expect(html).toContain('bbb');
        expect(html).toContain('<ul>');
    });

    test('TC-NP-13 caret snapshot: paste 発火位置に挿入される（先頭に飛ばない — TASK-B4/MED-2）', async ({ page }) => {
        // 既存本文を作り、末尾段落に caret を置いてから outliner paste → 結果受信
        await page.click('#editor');
        await page.evaluate(() => {
            const editor = document.getElementById('editor')!;
            editor.innerHTML = '<p>first para</p><p>second para</p>';
            // caret を second para 末尾へ
            const p2 = editor.querySelectorAll('p')[1];
            const r = document.createRange();
            r.selectNodeContents(p2);
            r.collapse(false);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(r);
        });
        // 添付付き nodes を paste（検知 → snapshot → host message）
        const nodes = [{ text: 'attached', level: 0, isPage: true, pageId: 'pX', images: [], filePath: null }];
        await page.evaluate(({ html, plain }) => {
            const dt = new DataTransfer();
            dt.setData('text/html', html);
            dt.setData('text/plain', plain);
            (document.activeElement || document.getElementById('editor'))!.dispatchEvent(
                new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, { html: outlinerClipboardHtml(nodes), plain: 'attached' });
        await page.waitForTimeout(100);
        // host 応答をシミュレート（standalone の実受信経路 = __hostMessageHandler）
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'pasteWithAssetCopyResult',
                markdown: '- attached [[attached]](pNew.md)',
            });
        });
        await page.waitForTimeout(300);
        const html = await page.evaluate(() => document.getElementById('editor')!.innerHTML);
        // 挿入位置: second para の後（= caret 位置）。先頭（first para より前）ではない
        const posFirst = html.indexOf('first para');
        const posSecond = html.indexOf('second para');
        const posPasted = html.indexOf('attached');
        expect(posPasted).toBeGreaterThan(posFirst);
        expect(posPasted).toBeGreaterThan(posSecond); // counterfactual: snapshot 無しだと先頭挿入で最小になる
    });

    test('TC-NP-14 note md ブリッジ: filePath を宛先として畳む override が存在（TASK-B5 — 修正前は undefined 送信で silent no-op = paste 不能）', async ({ page }) => {
        // notes-host-bridge.js の notesMarkdownHostBridge override を静的 + 構造検証。
        // (standalone-notes の md pane 実起動は heavy なため、override の存在 = message に
        //  filePath が畳まれることをソース contract として担保。実操作は US-NP-06 手動)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf-8');
        // notesMarkdownHostBridge ブロック内に override があり filePath を積む
        const idx = src.indexOf('window.notesMarkdownHostBridge = Object.assign');
        expect(idx).toBeGreaterThan(-1);
        const block = src.slice(idx, src.indexOf('window.notesHostBridge =', idx));
        expect(block).toContain('pasteOutlinerNodesWithAssets: function(plainText, nodes)');
        expect(block).toContain("sidePanelFilePath: window.notesMarkdownHostBridge.filePath || ''");
        // message-handler 側: sidePanelFilePath 空でも silent no-op にならず fallback を返す
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const handler = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/shared/notes-message-handler.ts'), 'utf-8');
        const caseIdx = handler.indexOf("case 'pasteOutlinerNodesWithAssets'");
        const caseBlock = handler.slice(caseIdx, caseIdx + 1200);
        expect(caseBlock).toContain('else {'); // fallback 分岐が存在
        expect(caseBlock).toContain('pasteWithAssetCopyResult');
    });

    test('TC-NP-12 pasteWithAssetCopyResult 受信で markdown が挿入される（既存受信経路の流用）', async ({ page }) => {
        await page.click('#editor');
        // standalone の host.onMessage は window.__hostMessageHandler に登録される
        // (test-host-bridge.js:58 — window.postMessage 経路ではない)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'pasteWithAssetCopyResult',
                markdown: '- pasted item [[T]](x.md)',
            });
        });
        await page.waitForTimeout(300);
        const text = await page.evaluate(() => document.getElementById('editor')!.textContent);
        expect(text).toContain('pasted item');
    });
});
