/**
 * README の画像（assets/images/）を VS Code で撮る。場面ごとにプロファイルと note のコピーを作り直して起動する。
 *   npm run shots:readme                       — 全部（今のソースから vsix を作って入れる）
 *   npx playwright test -c screenshots readme -g mindmap   — 場面を選ぶ（SHOTS_VSIX=<vsix> で作るのを省く）
 * 使い方・決まりは screenshots/README.md。
 */
import { test, type Frame, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { outputDir, workDir } from './lib/demo';
import { closeSideToc, collapseTree, openNodePage, openSideInTab, openSubpage, openTreeItem, scrollToHeading, switchMode } from './lib/fractal-ui';
import {
    buildVsix, installExtension, launchVsCode, openNote, park, quitVsCode, resetNotes, resetProfile, shootVsCodeWindow, shootWebview, vscodeProfile,
} from './lib/vscode';

// 高さは 14 インチの MacBook Pro（1512 x 982）の画面に Dock を出したまま入る大きさ
/** ウィンドウ全体の画像（3200 x 1720） */
const WIN = { w: 1600, h: 860 };
/** 機能の画像: このウィンドウで webview だけを切り出す（2364 x 1524） */
const CROP = { w: 1540, h: 860 };

interface Scene {
    size: { w: number; h: number };
    /** true = ウィンドウ全体、false = webview だけ */
    window: boolean;
    /** assets/images/ のファイル（README.md と README.ja.md で名前が違うものは両方） */
    out: string[];
    run(page: Page): Promise<Frame>;
}

const SCENES: Record<string, Scene> = {
    // 「Fractal Note in VS Code」: Fractal List と Notes、note のツリー・アウトライン・サイドパネルのページ
    overview: { size: WIN, window: true, out: ['vscode-overview.png'], async run(page) {
        const f = await openNote(page, 'projects');
        await openTreeItem(f, 'Team Tasks');
        await openNodePage(f, 'Write beta partner FAQ');
        await closeSideToc(f);
        return f;
    } },
    // 「Notes in VS Code: a note in Database mode」
    'notes-database': { size: WIN, window: true, out: ['1785087018130.png', '1785086976945.png'], async run(page) {
        const f = await openNote(page, 'webapp1');
        await openTreeItem(f, 'Sprint Board');
        return f;
    } },
    // 「Markdown editor with a subpage open in the side panel」
    'markdown-subpage-side': { size: CROP, window: false, out: ['1785072634683.png'], async run(page) {
        const f = await openNote(page, 'webapp1');
        await openTreeItem(f, 'Developer Onboarding Guide');
        await collapseTree(f);
        await openSubpage(f, 'Deploy & release workflow');
        await closeSideToc(f);
        return f;
    } },
    // 「Outliner with the note tree and a page in the side panel」
    'outliner-page-side': { size: CROP, window: false, out: ['1785071780563.png'], async run(page) {
        const f = await openNote(page, 'projects');
        await openTreeItem(f, 'Team Tasks');
        await openNodePage(f, 'Write beta partner FAQ');
        await closeSideToc(f);
        return f;
    } },
    // 「Markdown with a draw.io diagram, a Gantt chart and a table」
    'markdown-drawio': { size: CROP, window: false, out: ['1785071877602.png'], async run(page) {
        const f = await openNote(page, 'projects');
        await openTreeItem(f, 'Product Roadmap 2026');
        await openNodePage(f, 'Launch plan & pricing page');
        await openSideInTab(f);
        await collapseTree(f);
        await scrollToHeading(f, '.markdown-container', 'Launch plan & pricing page', 36); // 表の最後の行まで入れる
        return f;
    } },
    // 「Markdown with a Mermaid sequence diagram and a checklist」
    'markdown-mermaid': { size: CROP, window: false, out: ['1785072859352.png'], async run(page) {
        const f = await openNote(page, 'webapp1');
        await openTreeItem(f, 'Developer Onboarding Guide');
        await openSubpage(f, 'Deploy & release workflow');
        await openSideInTab(f);
        await collapseTree(f);
        await scrollToHeading(f, '.markdown-container', 'Blue/green promote');
        return f;
    } },
    // 「A markdown page and its subpage, with the subpage's outline, in the side panel」
    'markdown-subpages': { size: CROP, window: false, out: ['copy-1786518687773-1786518644715.png', '1786518644715.png'], async run(page) {
        const f = await openNote(page, 'webapp1');
        await openTreeItem(f, 'Developer Onboarding Guide');
        await collapseTree(f);
        await openSubpage(f, 'Local environment setup');
        return f;
    } },
    // 「Outliner mode」
    'outliner-mode': { size: CROP, window: false, out: ['1785071590698.png'], async run(page) {
        const f = await openNote(page, 'projects');
        await openTreeItem(f, 'Team Tasks');
        await collapseTree(f);
        await openNodePage(f, 'Write beta partner FAQ');
        await closeSideToc(f);
        return f;
    } },
    // 「Database mode with a page in the side panel」
    'database-mode': { size: CROP, window: false, out: ['1785071543294.png'], async run(page) {
        const f = await openNote(page, 'webapp1');
        await openTreeItem(f, 'Architecture Notes');
        await collapseTree(f);
        await openNodePage(f, 'REST API conventions');
        await closeSideToc(f);
        await scrollToHeading(f, '.side-panel', 'Status code decision tree');
        return f;
    } },
    // 「Mindmap mode」
    'mindmap-mode': { size: CROP, window: false, out: ['1785071464193.png'], async run(page) {
        const f = await openNote(page, 'projects');
        await openTreeItem(f, 'Team Tasks');
        await collapseTree(f);
        await switchMode(f, 'mindmap');
        await f.locator('[data-mm-action="fit"]').first().click();
        await new Promise((r) => setTimeout(r, 1200));
        return f;
    } },
};

const profile = vscodeProfile(path.join(workDir(), 'vscode'));
const RAW = path.join(profile.root, 'raw');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
    test.setTimeout(15 * 60000);
    installExtension(profile, process.env.SHOTS_VSIX ? path.resolve(process.env.SHOTS_VSIX) : buildVsix(profile.root));
});

for (const [name, sc] of Object.entries(SCENES)) {
    test(`readme ${name}`, async () => {
        resetNotes(profile);
        resetProfile(profile);
        const { app, page } = await launchVsCode(profile, sc.size);
        try {
            const f = await sc.run(page);
            await park(page, f);
            const raw = path.join(RAW, `${name}.png`);
            if (sc.window) {
                await shootVsCodeWindow(page, raw);
            } else {
                await shootWebview(page, f, raw);
            }
            const out = outputDir('assets/images');
            for (const file of sc.out) {
                fs.copyFileSync(raw, path.join(out, file));
            }
            console.log(`${name} → ${sc.out.join(', ')}`);
        } catch (e) {
            await page.screenshot({ path: path.join(RAW, `fail-${name}.png`) }).catch(() => undefined);
            throw e;
        } finally {
            await quitVsCode(profile, app);
        }
    });
}
