/**
 * outliner node Export bundle — sprint 20260727-174934
 * TC-EB-01〜06 (unit: runOutlinerNodesExportBundle) + TC-EB-10/11 (E2E: menu + bridge 送出)
 * + TC-EB-12 (source-contract: キャンセル副作用ゼロ)
 *
 * unit は out/shared/paste-asset-handler.js を require（tsc 済み前提。
 * outliner-node-paste-assets.spec.ts と同 harness）。
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-eb-src-'));
    fs.mkdirSync(path.join(dir, 'images'));
    fs.mkdirSync(path.join(dir, 'files'));
    fs.writeFileSync(path.join(dir, 'p1.md'), '# Page One\n\n![](images/pic.png)\n');
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNGDATA');
    fs.writeFileSync(path.join(dir, 'files', 'doc.pdf'), 'PDFDATA');
    return dir;
}

function run(nodeId: string, nodes: any[], src: string, dest: string, genIds?: string[]) {
    let i = 0;
    return pah.runOutlinerNodesExportBundle({
        nodeId,
        nodes,
        srcOutDir: src,
        srcPagesDir: src,
        srcFileDir: path.join(src, 'files'),
        dest,
        generatePageId: genIds ? () => genIds[i++] : undefined,
    });
}

test.describe('runOutlinerNodesExportBundle (unit)', () => {
    let src: string, dest: string;
    test.beforeEach(() => {
        src = makeSrcFixture();
        dest = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-eb-dest-'));
    });
    test.afterEach(() => {
        fs.rmSync(src, { recursive: true, force: true });
        fs.rmSync(dest, { recursive: true, force: true });
    });

    test('TC-EB-01 ★load-bearing: <dest>/<nodeId>/<nodeId>.md + page md 直下複製 + files/ 複製', () => {
        const r = run('nAbc', [
            { text: 'root', level: 0 },
            { text: 'page child', level: 1, isPage: true, pageId: 'p1', images: [] },
            { text: 'file child', level: 1, filePath: 'files/doc.pdf' },
        ], src, dest, ['new-1']);
        expect(r.ok).toBe(true);
        const bundleDir = path.join(dest, 'nAbc');
        expect(r.bundleDir).toBe(bundleDir);
        // counterfactual: core 未実装なら全ファイル不在 = RED
        const md = fs.readFileSync(path.join(bundleDir, 'nAbc.md'), 'utf8');
        const lines = md.trimEnd().split('\n');
        expect(lines[0]).toBe('- root');
        expect(lines[1]).toBe('  - [[page child]](new-1.md)');
        expect(lines[2]).toMatch(/^ {2}- \[📎 file child\]\(files\/doc\.pdf\)$/);
        // page md 複製 = bundleDir 直下（FR-EB-03）
        expect(fs.existsSync(path.join(bundleDir, 'new-1.md'))).toBe(true);
        // file 添付 = files/（FR-EB-03）
        expect(fs.existsSync(path.join(bundleDir, 'files', 'doc.pdf'))).toBe(true);
        // 元は不変（1:1 所有 — 新実体）
        expect(fs.existsSync(path.join(src, 'p1.md'))).toBe(true);
    });

    test('TC-EB-02 ★番人: node 直付き画像は無視（md に画像行なし・images 複製なし = FR-EB-04）', () => {
        const r = run('nImg', [
            { text: 'pic node', level: 0, images: ['images/pic.png'] },
        ], src, dest);
        expect(r.ok).toBe(true);
        const md = fs.readFileSync(path.join(dest, 'nImg', 'nImg.md'), 'utf8');
        // counterfactual: core の images:[] 強制を外すと ![]( 行が出る = RED
        expect(md).not.toContain('![](');
        expect(md).toContain('- pic node');
        // node 直付き画像の複製もない（images/ は page 本文複製が無ければ不存在）
        expect(fs.existsSync(path.join(dest, 'nImg', 'images', 'pic.png'))).toBe(false);
    });

    test('TC-EB-03 page 本文参照画像は複製される（「無視」の境界 = node.images のみ）', () => {
        const r = run('nPg', [
            { text: 'My Page', level: 0, isPage: true, pageId: 'p1', images: ['images/pic.png'] },
        ], src, dest, ['new-3']);
        expect(r.ok).toBe(true);
        const bundleDir = path.join(dest, 'nPg');
        // 複製 page md の本文画像参照が bundleDir 基準で実在（handlePageAssets 経由）
        const body = fs.readFileSync(path.join(bundleDir, 'new-3.md'), 'utf8');
        const imgRef = body.match(/!\[\]\(([^)]+)\)/)?.[1];
        expect(imgRef).toBeTruthy();
        expect(fs.existsSync(path.resolve(bundleDir, imgRef!))).toBe(true);
        // bundle md 自体には node 直付き画像行が出ない
        const md = fs.readFileSync(path.join(bundleDir, 'nPg.md'), 'utf8');
        expect(md).not.toContain('![](');
    });

    test('TC-EB-04 衝突サフィックス: 既存 <nodeId>/ があれば <nodeId>-1/（FR-EB-05）', () => {
        fs.mkdirSync(path.join(dest, 'nDup'));
        const r = run('nDup', [{ text: 'x', level: 0 }], src, dest);
        expect(r.ok).toBe(true);
        expect(r.bundleDir).toBe(path.join(dest, 'nDup-1'));
        expect(fs.existsSync(path.join(dest, 'nDup-1', 'nDup.md'))).toBe(true);
    });

    test('TC-EB-05 単体 plain node: md のみ・files/ 未作成でも ok', () => {
        const r = run('nOne', [{ text: 'plain', level: 0 }], src, dest);
        expect(r.ok).toBe(true);
        expect(fs.readFileSync(path.join(dest, 'nOne', 'nOne.md'), 'utf8')).toBe('- plain\n');
        expect(fs.existsSync(path.join(dest, 'nOne', 'files'))).toBe(false);
    });

    test('TC-EB-07 ★番人: traversal nodeId は dest 外に書かれない（basename 化 + generic フォールバック）', () => {
        // nodeId は webview message 経由（.out から verbatim ロード）で信頼境界を越える。
        // counterfactual: sanitize（path.basename + 空/./.. フォールバック）を外すと
        // path.join(dest, '../../x') が dest 外に mkdir/write して RED。
        const outside = path.join(dest, '..', 'eb-escape-probe');
        expect(fs.existsSync(outside)).toBe(false);

        // (a) 相対 traversal → basename 化されて dest 配下 'x/' に落ちる
        const r1 = run('../../eb-escape-probe/x', [{ text: 'a', level: 0 }], src, dest);
        expect(r1.ok).toBe(true);
        expect(fs.existsSync(outside)).toBe(false);                    // dest 外に何も作られない
        expect(r1.bundleDir!.startsWith(dest + path.sep)).toBe(true);  // bundleDir は dest 配下
        expect(fs.existsSync(path.join(dest, 'x', 'x.md'))).toBe(true);

        // (b) '..' 単体 / (c) 空文字 → generic 'export' にフォールバック（無限ループも回避）
        const r2 = run('..', [{ text: 'b', level: 0 }], src, dest);
        expect(r2.ok).toBe(true);
        expect(r2.bundleDir).toBe(path.join(dest, 'export'));
        const r3 = run('', [{ text: 'c', level: 0 }], src, dest);
        expect(r3.ok).toBe(true);
        expect(r3.bundleDir).toBe(path.join(dest, 'export-1'));        // 衝突サフィックスも機能
    });

    test('TC-EB-06 title の `]` サニタイズ: 実 parser で isSubpage 解析可能', () => {
        const r = run('nSan', [
            { text: 'Weird ] Title', level: 0, isPage: true, pageId: 'p1', images: [] },
        ], src, dest, ['new-6']);
        expect(r.ok).toBe(true);
        const md = fs.readFileSync(path.join(dest, 'nSan', 'nSan.md'), 'utf8');
        const line = md.split('\n').find((l: string) => l.includes('new-6.md'))!;
        const links = linkParser.parseMarkdownLinks(line);
        const sub = links.find((l: any) => l.isSubpage);
        expect(sub).toBeTruthy();
        expect(sub.url).toBe('new-6.md');
        expect(sub.alt).not.toContain(']');
    });
});

// ============ E2E: menu + bridge 送出（TC-EB-10/11） ============

test.describe('Export bundle menu (E2E)', () => {
    async function initTree(page: import('@playwright/test').Page) {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.initOutliner !== undefined);
        await page.evaluate(() => {
            (window as any).__testApi.initOutliner({
                version: 1,
                rootIds: ['root'],
                nodes: {
                    root: { id: 'root', parentId: null, text: 'root node', children: ['child'] },
                    child: { id: 'child', parentId: 'root', text: 'child node', children: ['gc'] },
                    gc: { id: 'gc', parentId: 'child', text: 'grandchild', children: [] },
                },
            });
        });
        await page.waitForSelector('.outliner-node[data-id="root"]');
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
    }

    async function exportViaMenu(page: import('@playwright/test').Page, nodeId: string) {
        return page.evaluate((nodeId) => {
            (window as any).__testApi.messages.length = 0;
            const el = document.querySelector(`.outliner-node[data-id="${nodeId}"] .outliner-text`) as HTMLElement;
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 30 }));
            const items = Array.from(document.querySelectorAll('.outliner-context-menu-item'));
            const target = items.find((it) => (it.textContent || '').includes('Export bundle')) as HTMLElement;
            const found = !!target;
            if (target) target.click();
            return {
                found,
                msgs: JSON.parse(JSON.stringify((window as any).__testApi.messages)),
            };
        }, nodeId);
    }

    test('TC-EB-10 ★load-bearing: 右クリック → Export bundle → exportOutlinerNodesBundle 送出', async ({ page }) => {
        await initTree(page);
        const r = await exportViaMenu(page, 'root');
        // counterfactual: メニュー未実装なら項目不在 = RED
        expect(r.found).toBe(true);
        const hit = r.msgs.filter((m: any) => m.type === 'exportOutlinerNodesBundle');
        expect(hit.length).toBe(1);
        expect(hit[0].nodeId).toBe('root');
        // subtree 全体（root + child + gc）が DFS 順・相対 level で載る（FR-EB-06）
        expect(hit[0].nodes.map((n: any) => n.text)).toEqual(['root node', 'child node', 'grandchild']);
        expect(hit[0].nodes.map((n: any) => n.level)).toEqual([0, 1, 2]);
    });

    test('TC-EB-11 中間 node 起点: minDepth 相対で level 0 起点', async ({ page }) => {
        await initTree(page);
        const r = await exportViaMenu(page, 'child');
        const hit = r.msgs.filter((m: any) => m.type === 'exportOutlinerNodesBundle');
        expect(hit.length).toBe(1);
        expect(hit[0].nodes.map((n: any) => n.text)).toEqual(['child node', 'grandchild']);
        expect(hit[0].nodes.map((n: any) => n.level)).toEqual([0, 1]);
    });
});

// ============ source-contract（TC-EB-12） ============

test.describe('host dialog source-contract', () => {
    test('TC-EB-12 キャンセル分岐が core 呼び出しより前（副作用ゼロ = NFR-04）', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src/shared/export-bundle-host.ts'), 'utf-8');
        const fnIdx = src.indexOf('export async function runExportOutlinerNodesBundle');
        expect(fnIdx).toBeGreaterThan(-1);
        const block = src.slice(fnIdx);
        expect(block).toContain("openLabel: 'Export here'");
        const cancelIdx = block.indexOf('if (!picked || picked.length === 0) return');
        const coreIdx = block.indexOf('runOutlinerNodesExportBundle(');
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(coreIdx).toBeGreaterThan(-1);
        expect(cancelIdx).toBeLessThan(coreIdx); // キャンセル return が core より前
        // FR-EB-08: 成功/失敗の通知分岐が存在
        expect(block).toContain('showInformationMessage');
        expect(block).toContain('showErrorMessage');
    });
});
