/**
 * TC-FAR-01..10 — ファイル系メニューの Reveal in Finder / sidepanel Copy Path のアイコン / overflow「…」メニューのテーマ
 *
 * (1) sidepanel の Copy file path が ✓ のまま戻らない:
 *     クリック後の ✓ 表示から戻すとき「押した時点の innerHTML」を元の見た目として覚えていたため、
 *     2 秒以内に 2 回押すと 2 回目が ✓ を覚え、✓ のまま固定されていた（editor.js / outliner.js の 2 実装 +
 *     outliner.js の copy-inapp-link も同型）。アイコンは md toolbar の Copy Path と同じ LUCIDE_ICONS.copyPath に一本化。
 * (2) overflow「…」メニューが light テーマでも黒い: --vscode-menu-* を見ていた（変数の無い面では fallback #252526）。
 *     Fractal のテーマ（--fr-*）に従わせた。
 * (3) Reveal in Finder を note ツリー右クリック（md / .out）・note md toolbar・note file / sidepanel file の viewer toolbar・
 *     sidepanel md header（+ overflow メニュー）に追加。host 経路は既存のものを再利用する:
 *     ツリー = revealTreeFileInOS(id)（file item と同じ）/ md・viewer = revealLinkTarget（md リンク右クリックと同じ）。
 */
import { test, expect, Page } from '@playwright/test';

const SP_MD = '/tmp/noteA/page1.md';

const FILE_LIST = [
    { filePath: '/Users/test/notes/noteA/foo.out', title: 'Foo Out', id: 'foo' },
    { filePath: '/Users/test/notes/noteA/bar.md', title: 'Bar', id: 'bar' },
    { filePath: '/Users/test/notes/noteA/files/doc.pdf', title: 'doc.pdf', id: 'tf1', kind: 'file' },
];
const STRUCTURE = {
    version: 1,
    rootIds: ['foo', 'bar', 'tf1'],
    items: {
        foo: { type: 'file', id: 'foo', title: 'Foo Out', ext: 'out' },
        bar: { type: 'file', id: 'bar', title: 'Bar', ext: 'md' },
        tf1: { type: 'file', id: 'tf1', title: 'doc.pdf', ext: 'file', filename: 'doc.pdf' },
    },
};
const REVEAL_RE = /Reveal in Finder|Finder で表示/;

async function openSidePanel(page: Page, harness: string) {
    await page.goto('/' + harness);
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((fp) => {
        (window as any).__hostMessageHandler({
            type: 'openSidePanel', markdown: '# Doc\n\nbody\n', filePath: fp,
            fileName: 'page1.md', toc: [], documentBaseUri: '',
        });
    }, SP_MD);
    await page.waitForTimeout(400);
}

async function sizePanel(page: Page, widthPx: number) {
    await page.evaluate((w) => {
        const sp = document.querySelector('.side-panel') as HTMLElement;
        sp.style.setProperty('width', w + 'px', 'important');
        sp.style.setProperty('min-width', w + 'px', 'important');
        sp.style.setProperty('max-width', w + 'px', 'important');
        const c = document.querySelector('.side-panel-editor-container') as HTMLElement;
        if (c) c.style.setProperty('width', w + 'px', 'important');
        (window as any).SidePanelOverflow.recalc();
    }, widthPx);
    await page.waitForTimeout(100);
}

function iconKind(page: Page, selector: string) {
    return page.evaluate((sel) => {
        const b = document.querySelector(sel) as HTMLElement;
        const html = b ? b.innerHTML : '';
        if (html.includes('20 6 9 17 4 12')) return 'CHECK';
        if (html.includes('<svg')) return 'ICON';
        return 'EMPTY';
    }, selector);
}

// ---- (1) sidepanel Copy Path のアイコン ----

test.describe('sidepanel Copy file path のアイコン', () => {
    test.beforeEach(async ({ context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    });

    test('TC-FAR-01: sidepanel の Copy file path は md toolbar の Copy Path と同じアイコン（正典を共有）', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        // main md ペイン（md toolbar 側の Copy Path）
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'updateData', kind: 'md', markdown: '# A\n', filePath: '/Users/test/notes/noteA/a.md', documentBaseUri: '',
            });
        });
        await page.waitForTimeout(300);
        await page.evaluate((fp) => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: '# Doc\n', filePath: fp, fileName: 'page1.md', toc: [], documentBaseUri: '',
            });
        }, SP_MD);
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
            const main = document.querySelector('.markdown-container [data-action="copyPath"]') as HTMLElement;
            const sp = document.querySelector('.side-panel-copy-path') as HTMLElement;
            return {
                main: main ? main.innerHTML.trim() : 'MISSING',
                sp: sp ? sp.innerHTML.trim() : 'MISSING',
                lucide: (() => { const t = document.createElement('div'); t.innerHTML = (window as any).__editorUtils.LUCIDE_ICONS.copyPath; return t.innerHTML; })(),
            };
        });
        expect(r.main).toBe(r.lucide);
        expect(r.sp, 'sidepanel の Copy file path が md toolbar と同じアイコン').toBe(r.main);
    });

    for (const harness of ['standalone-notes.html', 'standalone-outliner.html']) {
        test(`TC-FAR-02: 2 秒以内に 2 回押しても ✓ のまま残らず copy アイコンに戻る（${harness}）`, async ({ page }) => {
            await openSidePanel(page, harness);
            expect(await iconKind(page, '.side-panel-copy-path')).toBe('ICON');
            await page.evaluate(() => (document.querySelector('.side-panel-copy-path') as HTMLElement).click());
            await page.waitForTimeout(200);
            expect(await iconKind(page, '.side-panel-copy-path'), 'コピー直後は ✓').toBe('CHECK');
            await page.evaluate(() => (document.querySelector('.side-panel-copy-path') as HTMLElement).click());
            await page.waitForTimeout(2600);
            expect(await iconKind(page, '.side-panel-copy-path'), '2 秒後は copy アイコンへ戻る').toBe('ICON');
            const html = await page.evaluate(() => (document.querySelector('.side-panel-copy-path') as HTMLElement).innerHTML);
            const lucide = await page.evaluate(() => { const t = document.createElement('div'); t.innerHTML = (window as any).__editorUtils.LUCIDE_ICONS.copyPath; return t.innerHTML; });
            expect(html).toBe(lucide);
        });
    }

    test('TC-FAR-03: copy-inapp-link（Notes の page sidepanel）も連打で ✓ のまま残らない', async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate(({ fileList, structure }) => {
            (window as any).__testApi.initNotesPanel(fileList, '/Users/test/notes/noteA/foo.out', structure, null, 'noteA');
            const el = document.querySelector('.notes-layout') as HTMLElement | null;
            if (el) el.dataset.noteFolderName = 'noteA';
            (window as any).__testApi.initOutliner({
                version: 1, rootIds: ['n1'],
                nodes: { n1: { id: 'n1', parentId: null, text: 'paged node', children: [], isPage: true, pageId: 'pg-1' } },
            });
        }, { fileList: FILE_LIST, structure: STRUCTURE });
        await page.waitForSelector('.outliner-page-icon');
        // page node から開く（origin node = n1 → copy-inapp-link が page link を作れる）
        await page.evaluate((fp) => {
            (document.querySelector('.outliner-page-icon') as HTMLElement).click();
            (window as any).__hostMessageHandler({
                type: 'openSidePanel', markdown: '# Doc\n', filePath: fp, fileName: 'pg-1.md', toc: [], documentBaseUri: '',
            });
        }, SP_MD);
        await page.waitForTimeout(400);
        const sel = '.side-panel-copy-inapp-link';
        const before = await page.evaluate((s) => (document.querySelector(s) as HTMLElement).innerHTML, sel);
        expect(await iconKind(page, sel)).toBe('ICON');
        await page.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), sel);
        await page.waitForTimeout(200);
        expect(await iconKind(page, sel), 'コピー直後は ✓').toBe('CHECK');
        await page.evaluate((s) => (document.querySelector(s) as HTMLElement).click(), sel);
        await page.waitForTimeout(2600);
        const after = await page.evaluate((s) => (document.querySelector(s) as HTMLElement).innerHTML, sel);
        expect(after, '2 秒後は元の in-app link アイコンへ戻る').toBe(before);
    });
});

// ---- (2) overflow「…」メニューのテーマ ----

test.describe('sidepanel overflow「…」メニューはテーマに従う', () => {
    async function openOverflowMenu(page: Page, theme: 'light' | 'dark') {
        await openSidePanel(page, 'standalone-notes.html');
        await page.evaluate((t) => { document.documentElement.setAttribute('data-fr-theme', t); }, theme);
        await sizePanel(page, 340);
        await page.evaluate(() => (document.getElementById('sidePanelOverflowBtn') as HTMLElement).click());
        await page.waitForTimeout(100);
        return page.evaluate(() => {
            const menu = document.getElementById('sidePanelOverflowMenu') as HTMLElement;
            const probe = document.createElement('div');
            probe.style.background = 'var(--fr-color-bg-elevated)';
            probe.style.color = 'var(--fr-color-text-primary)';
            document.body.appendChild(probe);
            const want = getComputedStyle(probe);
            const got = getComputedStyle(menu);
            const res = {
                visible: menu.style.display !== 'none',
                bg: got.backgroundColor, wantBg: want.backgroundColor,
                fg: got.color, wantFg: want.color,
            };
            probe.remove();
            return res;
        });
    }
    const lum = (rgb: string) => {
        const m = rgb.match(/\d+(\.\d+)?/g)!.map(Number);
        return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    };

    test('TC-FAR-04: light テーマでは白系（--fr-color-bg-elevated）', async ({ page }) => {
        const r = await openOverflowMenu(page, 'light');
        expect(r.visible).toBe(true);
        expect(r.bg).toBe(r.wantBg);
        expect(r.fg).toBe(r.wantFg);
        expect(lum(r.bg), 'light で黒くない').toBeGreaterThan(200);
    });

    test('TC-FAR-05: dark テーマでは暗色（--fr-color-bg-elevated）', async ({ page }) => {
        const r = await openOverflowMenu(page, 'dark');
        expect(r.visible).toBe(true);
        expect(r.bg).toBe(r.wantBg);
        expect(lum(r.bg), 'dark では暗い').toBeLessThan(80);
    });
});

// ---- (3) Reveal in Finder ----


test.describe('Reveal in Finder', () => {
    for (const id of ['foo', 'bar', 'tf1']) {
        test(`TC-FAR-06: note ツリー右クリック（${id}）に Reveal in Finder → revealTreeFileInOS(id)`, async ({ page }) => {
            await page.goto('/standalone-notes.html');
            await page.waitForFunction(() => (window as any).__testApi?.ready);
            await page.evaluate(({ fileList, structure }) => {
                (window as any).__testApi.initNotesPanel(fileList, '/Users/test/notes/noteA/foo.out', structure, null, 'noteA');
            }, { fileList: FILE_LIST, structure: STRUCTURE });
            await page.waitForTimeout(150);
            await page.locator(`.file-panel-item[data-item-id="${id}"]`).click({ button: 'right' });
            await page.waitForTimeout(150);
            const item = page.locator('.file-panel-context-menu .file-panel-context-item').filter({ hasText: REVEAL_RE });
            await expect(item, 'Reveal in Finder 項目が 1 つ').toHaveCount(1);
            await page.evaluate(() => { (window as any).__testApi.notesMessages = []; });
            await item.click();
            const msgs = await page.evaluate(() => (window as any).__testApi.notesMessages);
            expect(msgs.filter((m: any) => m.type === 'revealTreeFileInOS')).toEqual([{ type: 'revealTreeFileInOS', id }]);
        });
    }

    test('TC-FAR-07: note md toolbar の Reveal in Finder → revealLinkTarget（自分の md）', async ({ page }) => {
        const fp = '/Users/test/notes/noteA/mypage.md';
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((p) => {
            (window as any).__hostMessageHandler({ type: 'updateData', kind: 'md', markdown: '# P\n', filePath: p, documentBaseUri: '' });
        }, fp);
        await page.waitForTimeout(300);
        const btn = page.locator('.markdown-container [data-action="revealInFinder"]');
        await expect(btn).toBeVisible();
        expect(await btn.innerHTML()).toBe(await page.evaluate(() => { const t = document.createElement('div'); t.innerHTML = (window as any).__editorUtils.LUCIDE_ICONS.revealInFinder; return t.innerHTML; }));
        await page.evaluate(() => { (window as any).__testApi.messages = []; });
        await btn.click();
        const msgs = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'revealLinkTarget'));
        expect(msgs).toEqual([{ type: 'revealLinkTarget', href: fp, kind: 'md', sidePanelFilePath: fp }]);
    });

    for (const harness of ['standalone-notes.html', 'standalone-outliner.html']) {
        test(`TC-FAR-08: sidepanel md header の Reveal in Finder（直接 / overflow メニュー）→ revealLinkTarget（${harness}）`, async ({ page }) => {
            await openSidePanel(page, harness);
            await sizePanel(page, 900); // 広幅: 格納なしで直接押せる
            const btn = page.locator('.side-panel-header [data-action="revealInFinder"]');
            await expect(btn).toBeVisible();
            await page.evaluate(() => { (window as any).__testApi.messages = []; });
            await btn.click();
            const msgs = await page.evaluate(() => (window as any).__testApi.messages.filter((m: any) => m.type === 'revealLinkTarget'));
            expect(msgs).toEqual([{ type: 'revealLinkTarget', href: SP_MD, kind: 'md', sidePanelFilePath: SP_MD }]);

            // 狭幅: overflow メニューに Reveal in Finder の item が出て、元ボタンの配線へ委譲される
            await sizePanel(page, 300);
            const r = await page.evaluate(() => {
                const api = (window as any).__testApi;
                api.messages = [];
                const reveal = document.querySelector('.side-panel-header [data-action="revealInFinder"]') as HTMLElement;
                (document.getElementById('sidePanelOverflowBtn') as HTMLElement).click();
                const items = Array.from(document.querySelectorAll('#sidePanelOverflowMenu .side-panel-overflow-item')) as HTMLElement[];
                const it = items.find((i) => /Reveal in Finder|Finder で表示/.test(i.textContent || ''));
                if (it) it.click();
                return {
                    overflowed: reveal.classList.contains('sp-overflowed'),
                    found: !!it,
                    msgs: api.messages.filter((m: any) => m.type === 'revealLinkTarget').length,
                };
            });
            expect(r.overflowed, '狭幅で Reveal in Finder も overflow に格納される').toBe(true);
            expect(r.found, 'overflow メニューに Reveal in Finder').toBe(true);
            expect(r.msgs).toBe(1);
        });
    }

    test('TC-FAR-09: viewer toolbar の Reveal in Finder → revealLinkTarget（自分のファイル）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/plain-text.html',
                document.getElementById('viewer-root'), '/tmp/plain-text.html');
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });
        await page.click('.viewer-reveal-in-finder');
        const posted: any[] = await page.evaluate(() => (window as any).__postedMessages);
        expect(posted.filter((m) => m && m.type === 'revealLinkTarget')).toEqual([
            { type: 'revealLinkTarget', href: '/tmp/plain-text.html', kind: 'md', sidePanelFilePath: '/tmp/plain-text.html' },
        ]);
    });

    test('TC-FAR-10: filePath の無い非 standalone viewer / standalone md editor には Reveal in Finder を出さない', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/plain-text.html', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });
        expect(await page.locator('.viewer-reveal-in-finder').count()).toBe(0);

        await page.goto('/standalone-editor.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await expect(page.locator('[data-action="revealInFinder"]')).toBeHidden();
    });
});
