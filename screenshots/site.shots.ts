/**
 * ホームページの画像（site/images/）をデスクトップアプリで撮る。
 *   desktop-light.png / desktop-dark.png — 一番上の大きな画像（空の note 4 つに、アウトラインを打ち込む）
 *   shot-<場面>.png — 画面の一覧（撮影用の note: screenshots/data/notes）
 *   npm run shots:site                              — 全部（先に electron/ で npm run compile）
 *   npx playwright test -c screenshots site -g mindmap   — 場面を選ぶ
 * 使い方・決まりは screenshots/README.md。
 */
import { expect, test, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { NotesFileManager } from '../src/shared/notes-file-manager';
import { nextPanelPage, sidebarPages } from '../test/e2e-electron-app/harness';
import { attachDashboard, copyDemoNotes, image, outputDir, sleep, workDir, writeRegistry } from './lib/demo';
import { launchDesktop, makeDesktopFixture, noteRow, setWindowSize, shootDesktopWindow } from './lib/desktop';
import { clickNodeIcon, closeSideToc, fitMindmapBesideSidePanel, openSubpage, openTreeItem, switchMode } from './lib/fractal-ui';

const WORK = path.join(workDir(), 'site');
const RAW = path.join(WORK, 'raw');

/** index.html の <img width height> と仕上がりの大きさが違えば知らせる（直すのは index.html） */
function checkHtmlSize(file: string): void {
    const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'index.html'), 'utf8');
    const name = path.basename(file);
    const m = html.match(new RegExp(`src="images/${name.replace(/[.]/g, '\\.')}"[^>]*width="(\\d+)" height="(\\d+)"`));
    const size = fs.readFileSync(file).subarray(16, 24); // PNG の IHDR: 幅・高さ
    const w = size.readUInt32BE(0);
    const h = size.readUInt32BE(4);
    if (m && (Number(m[1]) !== w || Number(m[2]) !== h)) {
        console.warn(`site/index.html says ${name} is ${m[1]} x ${m[2]}, the new image is ${w} x ${h} — fix the width / height there`);
    }
}

// ---- 一番上の画像: 1280 x 760 で撮り（2560 x 1520）、1600 x 950 に縮める

async function typeOutline(page: Page, lines: Array<[number, string]>): Promise<void> {
    const first = page.locator('.outliner-node .outliner-text').first();
    await expect(first).toBeVisible({ timeout: 30000 });
    await first.click();
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const [depth, text] = lines[i];
        if (i > 0) {
            await page.keyboard.press('Enter');
        }
        for (; level < depth; level++) {
            await page.keyboard.press('Tab');
        }
        for (; level > depth; level--) {
            await page.keyboard.press('Shift+Tab');
        }
        await page.keyboard.type(text, { delay: 5 });
    }
}

const HERO_NOTES = ['Product roadmap', 'Meeting notes', 'Research', 'Reading list'];

for (const theme of ['light', 'dark'] as const) {
    test(`site hero-${theme}`, async () => {
        const fx = makeDesktopFixture(path.join(WORK, `hero-${theme}`), theme);
        const dirs = HERO_NOTES.map((name) => {
            const dir = path.join(fx.home, 'notes', name);
            fs.mkdirSync(dir, { recursive: true });
            const fm = new NotesFileManager(dir);
            fm.loadStructure();
            fm.createFile(`${name} outline`);
            fm.dispose();
            return dir;
        });
        writeRegistry(path.join(fx.home, '.fractal', 'default.fractal'), dirs);
        const app = await launchDesktop(fx);
        try {
            const [sidebar] = await sidebarPages(app);
            await expect(sidebar.locator('.pane[data-view="notesExplorer"] .pane-header')).toBeVisible({ timeout: 30000 });
            const first = await nextPanelPage(app);
            await setWindowSize(app, 1280, 760);
            // もう 1 つ note を開いておき（● の印）、最初の note に戻る
            await noteRow(sidebar, 'Meeting notes').click();
            await nextPanelPage(app, [first]);
            await sleep(800);
            await noteRow(sidebar, 'Product roadmap').click();
            await sleep(800);
            await first.locator('.file-panel-item', { hasText: 'Product roadmap outline' }).first().click();
            await sleep(800);
            await typeOutline(first, [
                [0, 'Ship the desktop app for macOS #release'],
                [1, 'Build, test and publish on GitHub'],
                [1, 'Write the install guide'],
                [0, 'Design refresh #design'],
                [1, 'White body, soft purple panels'],
                [1, 'One accent color, rounded rows'],
                [0, 'Notes and files in one place'],
                [1, 'Full-text search inside PDF, Word, Excel and PowerPoint'],
                [0, 'Ideas'],
            ]);
            await first.keyboard.press('Escape');
            await first.mouse.click(900, 650);
            await sidebar.mouse.move(120, 700);
            await sleep(1500);
            const raw = path.join(RAW, `hero-${theme}.png`);
            await shootDesktopWindow(app, raw);
            const out = path.join(outputDir('site/images'), `desktop-${theme}.png`);
            image('fit', raw, out, '1600');
            checkHtmlSize(out);
        } finally {
            await app.close();
        }
    });
}

// ---- 画面の一覧: 1440 x 840 で撮り（2880 x 1680）、横 2000・256 色に（2000 x 1167）

const GALLERY = { w: 1440, h: 840 };

/** note: サイドバーの note の名前。run: その note のビューで画面を作る */
const SCENES: Record<string, { note: string; run(page: Page): Promise<void> }> = {
    // Outliner + サイドパネルのページ（md）
    'outliner-sidepanel': { note: 'Projects', async run(p) {
        await openTreeItem(p, 'Product Roadmap 2026');
        await clickNodeIcon(p, '.outliner-page-icon', 'Launch plan & pricing page');
        await sleep(2500);
        await closeSideToc(p);
    } },
    // Mindmap + サイドパネルのページ
    'mindmap-sidepanel': { note: 'Projects', async run(p) {
        await openTreeItem(p, 'Product Roadmap 2026');
        await switchMode(p, 'mindmap');
        await sleep(1000);
        await clickNodeIcon(p, '.mindmap-node-icon', 'Kickoff meeting notes');
        await sleep(2500);
        await closeSideToc(p);
        await fitMindmapBesideSidePanel(p);
    } },
    // Outliner + サイドパネルのファイル（HTML）
    'outliner-html': { note: 'Projects', async run(p) {
        await openTreeItem(p, 'Team Tasks');
        await clickNodeIcon(p, '.outliner-file-icon', 'Launch dashboard.html');
        await sleep(3500);
    } },
    // マークダウン（表・コード・Mermaid）
    markdown: { note: 'WebApp1 Dev Docs', async run(p) {
        await openTreeItem(p, 'Release Notes — v0.4.0');
        await sleep(3000);
        await p.mouse.move(900, 500);
        await p.mouse.wheel(0, 470);
        await sleep(2500);
    } },
    // マークダウン + サイドパネルのサブページ（md の中に md を埋め込む）
    'markdown-subpage': { note: 'WebApp1 Dev Docs', async run(p) {
        await openTreeItem(p, 'Developer Onboarding Guide');
        await sleep(1000);
        await openSubpage(p, 'Local environment setup');
        await sleep(1000);
        await closeSideToc(p);
    } },
    // Database + サイドパネルのページ
    'database-sidepanel': { note: 'WebApp1 Dev Docs', async run(p) {
        await openTreeItem(p, 'Architecture Notes');
        await sleep(1500);
        await clickNodeIcon(p, '.outliner-page-icon', 'REST API conventions');
        await sleep(2500);
        await closeSideToc(p);
    } },
};

for (const [name, sc] of Object.entries(SCENES)) {
    test(`site ${name}`, async () => {
        const fx = makeDesktopFixture(path.join(WORK, name), 'light');
        // note は HOME の下に（画像・添付を読んでよいフォルダの既定が HOME の下だけ）
        const notes = copyDemoNotes(path.join(fx.home, 'notes'));
        attachDashboard(notes.projects);
        writeRegistry(path.join(fx.home, '.fractal', 'default.fractal'), [notes.projects, notes.webapp1]);
        const app = await launchDesktop(fx);
        try {
            const [sidebar] = await sidebarPages(app);
            await expect(sidebar.locator('.pane[data-view="notesExplorer"] .pane-header')).toBeVisible({ timeout: 30000 });
            let page = await nextPanelPage(app);
            await setWindowSize(app, GALLERY.w, GALLERY.h);
            if (sc.note !== 'Projects') {
                await noteRow(sidebar, sc.note).click();
                page = await nextPanelPage(app, [page]);
            }
            await sleep(1200);
            await sidebar.locator('[aria-label^="Hide Sidebar"]').click(); // アプリのサイドバーを細い帯に畳む
            await sleep(1200);
            await sc.run(page);
            await page.mouse.move(5, GALLERY.h - 5);
            await sleep(800);
            const raw = path.join(RAW, `${name}.png`);
            await shootDesktopWindow(app, raw);
            const out = path.join(outputDir('site/images'), `shot-${name}.png`);
            image('fit', raw, out, '2000', '256');
            checkHtmlSize(out);
        } finally {
            await app.close();
        }
    });
}
