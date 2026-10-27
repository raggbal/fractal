/**
 * recent-history-nav — Recent を厳密な履歴にし、Back / Forward を足す（spec 20261027-1142-recent-history-nav）
 *
 * AC-2: 記録の pane（main / side）— host（notes-message-handler + NotesFileManager の実コード）で検証。
 *       provider の closure 内の記録（onFileOpened 等）は vscode 依存で起動できないので、pane 引数を
 *       必須にした型（tsc）と source の契約チェックで守る。
 * AC-3: Back / Forward — webview（standalone-notes の実 notes-history-panel.js / notes-body-html.js）と、
 *       「移動は記録しない」の host 端（noHistory / historyOpenInSidePanel / SidePanelManager.openFile）。
 * AC-4: Recent の一覧から選ぶと side の entry もメインで開く（webview + host）。
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── host 側の stub require（test/unit/notes-recent-kinds.spec.ts と同じ形） ──
const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
function makeVscodeStub(): any {
    const uri = (p: string): any => ({ fsPath: p, path: p, with: (o: any) => ({ fsPath: o.path, path: o.path }) });
    return {
        workspace: {
            getConfiguration: () => ({ get: () => undefined }),
            fs: { delete: async () => {}, readFile: async (u: any) => fs.readFileSync(u.fsPath) },
        },
        Uri: { file: uri, joinPath: () => ({}), parse: (s: string) => ({ fsPath: s }) },
        commands: { executeCommand: () => {} },
        window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
        env: { openExternal: async () => {} }, ViewColumn: {}, EventEmitter: class {},
    };
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') { return makeVscodeStub(); }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

function setupHost(): any {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhn-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhn-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const folderId = m.registerFolderLink(root);
    const md = path.join(noteDir, 'a.md');
    fs.writeFileSync(md, '# A\n');
    const outPath = m.createFile('Out1', null);
    const pdf = path.join(noteDir, 'doc.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4');
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    // 履歴を空にしてから検証（createFile 等の副作用を除く）
    m.getStructure().history = [];
    return { mod, m, noteDir, root, folderId, md, outPath, pdf, messages, sender };
}
const hist = (m: any) => (m.getStructure().history || []) as any[];
const panes = (m: any) => hist(m).map((e: any) => e.kind + ':' + e.pane);

test.describe('AC-2 記録の pane（host）', () => {
    test('AC-2 メインで開いた md / out / folder / file は pane=main', async () => {
        const { mod, m, folderId, md, outPath, pdf, sender } = setupHost();
        const platform: any = { historyOpenFile: async () => {} };
        await mod.handleNotesMessage({ type: 'notesOpenFile', filePath: md }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'notesOpenFile', filePath: outPath }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'folderViewOpened', id: folderId }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'historyOpenFile', filePath: pdf }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'notesJumpToNode', fileId: path.basename(outPath, '.out'), nodeId: 'x' }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'notesOpenDailyNotes' }, m, sender, platform);
        expect(panes(m)).toEqual(['out:main', 'out:main', 'file:main', 'folder:main', 'out:main', 'note-md:main']);
        expect(hist(m)[0].id.endsWith('dailynotes.out')).toBe(true);
    });

    test('AC-2 sidepanel で開いた md / file は pane=side', async () => {
        const { mod, m, root, folderId, outPath, sender } = setupHost();
        // (1) 検索 → md page（notesJumpToMdPage）: page md を sidepanel に開く
        const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const rootNodeId = outData.rootIds && outData.rootIds[0];
        expect(rootNodeId, 'createFile の .out に root node がある').toBeTruthy();
        outData.nodes[rootNodeId].pageId = 'pg1';
        fs.writeFileSync(outPath, JSON.stringify(outData));
        const pagePath = m.getPageFilePath('pg1');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# Page\n');
        const opened: string[] = [];
        const platform: any = { openPageInSidePanel: (p: string) => { opened.push(p); } };
        await mod.handleNotesMessage({ type: 'notesJumpToMdPage', outFileId: path.basename(outPath, '.out'), pageId: 'pg1' }, m, sender, platform);
        expect(opened).toEqual([pagePath]);
        expect(hist(m)[0]).toMatchObject({ kind: 'note-md', id: pagePath, pane: 'side' });

        // (2) folder view から file（viewer sidepanel）
        fs.writeFileSync(path.join(root, 'x.pdf'), '%PDF-1.4');
        const deps: any = {
            showErrorMessage: () => {}, t: (k: string) => k, ensureResourceRoot: () => {},
            openMdInSidePanel: async () => {}, openViewerPanel: async () => {}, openExternal: async () => {},
        };
        expect(await mod.folderViewOpen(m, folderId, 'x.pdf', deps)).toBe(true);
        expect(hist(m)[0]).toMatchObject({ kind: 'file', id: path.join(root, 'x.pdf'), pane: 'side' });
    });

    test('AC-2 provider の記録点は pane を明示している（source 契約）', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
        // 記録の呼び出しは全て pane 付き（引数 1 個の呼び出しが無い）
        const calls = src.match(/record(File|ViewerFile)History\([^)]*\)/g) || [];
        expect(calls.length).toBeGreaterThanOrEqual(5);
        for (const c of calls) { expect(c, c).toMatch(/,\s*'(main|side)'\)$/); }
        // sidepanel md（onFileOpened）と md の 📎（viewer sidepanel）は side
        expect(src).toContain("fileManager.recordFileHistory(fp, 'side')");
        expect(src).toContain("fileManager.recordViewerFileHistory(resolvedUri.fsPath, 'side')");
    });
});

// ── webview（standalone-notes） ──
const H = [
    { kind: 'note-md', id: '/n/a.md', title: 'a', ts: 5, pane: 'main' },
    { kind: 'note-md', id: '/n/c.md', title: 'c', ts: 4, pane: 'side' },
    { kind: 'file', id: '/n/gone.pdf', title: 'gone.pdf', ts: 3, pane: 'main', missing: true },
    { kind: 'out', id: '/n/b.out', title: 'b', ts: 2, pane: 'main' },
    { kind: 'file', id: '/n/d.pdf', title: 'd.pdf', ts: 1, pane: 'side' },
];

async function setupPage(page: Page, history: any[] = H) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate((h) => { (window as any).__testApi.initHistoryPanel(h, null, false); }, history);
    await page.evaluate(() => { (window as any).__testApi.messages = []; (window as any).__testApi.notesMessages = []; });
}
async function state(page: Page) {
    return page.evaluate(() => {
        const back = document.getElementById('notesHistoryBack') as HTMLButtonElement;
        const fwd = document.getElementById('notesHistoryForward') as HTMLButtonElement;
        const items = Array.from(document.querySelectorAll('#sidePanelHistoryList .side-panel-history-item'));
        return {
            back: !back.disabled, fwd: !fwd.disabled,
            current: items.findIndex((el) => el.classList.contains('is-current')),
            currentCount: items.filter((el) => el.classList.contains('is-current')).length,
        };
    });
}
async function takeMsgs(page: Page) {
    return page.evaluate(() => {
        const t = (window as any).__testApi;
        const all = [...(t.messages || []), ...(t.notesMessages || [])];
        t.messages = []; t.notesMessages = [];
        return all.filter((x: any) => !/^notesSaveHistoryPanel/.test(x.type));
    });
}

test.describe('AC-3 Back / Forward（webview）', () => {
    test('AC-3 Back / Forward はパネル最上段の右端にある', async ({ page }) => {
        await setupPage(page);
        const r = await page.evaluate(() => {
            const header = document.querySelector('#notesFilePanel > .file-panel-header') as HTMLElement;
            const kids = Array.from(header.children);
            const back = document.getElementById('notesHistoryBack')!;
            const fwd = document.getElementById('notesHistoryForward')!;
            const hr = header.getBoundingClientRect();
            const br = back.getBoundingClientRect();
            const fr = fwd.getBoundingClientRect();
            const title = document.getElementById('notesTitleLabel')!.getBoundingClientRect();
            const firstRowOfPanel = header === document.querySelector('#notesFilePanel')!.firstElementChild;
            return {
                firstRowOfPanel,
                lastTwo: kids[kids.length - 2] === back && kids[kids.length - 1] === fwd,
                sameRow: Math.abs(br.top - fr.top) < 2 && br.top >= hr.top && br.bottom <= hr.bottom + 1,
                order: br.right <= fr.left + 1 && title.right <= br.left + 1,
                rightGap: hr.right - fr.right,
                visible: br.width > 0 && fr.width > 0,
            };
        });
        expect(r.firstRowOfPanel, 'ヘッダーはパネルの一番上の行').toBe(true);
        expect(r.lastTwo, 'ヘッダーの最後の 2 つ').toBe(true);
        expect(r.sameRow).toBe(true);
        expect(r.order, 'title → Back → Forward の順').toBe(true);
        expect(r.rightGap, '右端（padding 分だけ内側）').toBeLessThan(16);
        expect(r.visible).toBe(true);
    });

    test('AC-3 Back で前の entry をその pane で開き、Forward で戻る。端は disabled、記録しない', async ({ page }) => {
        await setupPage(page);
        expect(await state(page)).toEqual({ back: true, fwd: false, current: 0, currentCount: 1 });

        // Back → c（side md）は sidepanel で
        await page.locator('#notesHistoryBack').click();
        expect(await takeMsgs(page)).toEqual([{ type: 'historyOpenInSidePanel', filePath: '/n/c.md' }]);
        expect(await state(page)).toMatchObject({ back: true, fwd: true, current: 1 });

        // Back → gone.pdf（missing）は飛ばして b.out（main）をメインで・noHistory
        await page.locator('#notesHistoryBack').click();
        expect(await takeMsgs(page)).toEqual([{ type: 'notesOpenFile', filePath: '/n/b.out', noHistory: true }]);
        expect((await state(page)).current).toBe(3);

        // host の再描画（移動は記録されないので history は同じ）が来ても位置は保つ
        await page.evaluate((h) => { (window as any).__notesHistoryPanel.render(JSON.parse(JSON.stringify(h))); }, H);
        expect((await state(page)).current).toBe(3);

        // Back → d.pdf（side file）は sidepanel で。末尾なので Back は disabled
        await page.locator('#notesHistoryBack').click();
        expect(await takeMsgs(page)).toEqual([{ type: 'historyOpenInSidePanel', filePath: '/n/d.pdf' }]);
        expect(await state(page)).toMatchObject({ back: false, fwd: true, current: 4 });

        // Forward で戻る（Back → Forward で元の entry に戻る）
        await page.locator('#notesHistoryForward').click();
        expect(await takeMsgs(page)).toEqual([{ type: 'notesOpenFile', filePath: '/n/b.out', noHistory: true }]);
        expect((await state(page)).current).toBe(3);
        await page.locator('#notesHistoryForward').click();
        await page.locator('#notesHistoryForward').click();
        expect(await takeMsgs(page)).toEqual([
            { type: 'historyOpenInSidePanel', filePath: '/n/c.md' },
            { type: 'notesOpenFile', filePath: '/n/a.md', noHistory: true },
        ]);
        expect(await state(page)).toMatchObject({ back: true, fwd: false, current: 0 });
    });

    test('AC-3 新しく開くと先頭に足されて位置が先頭に戻る（先の履歴は消さない）', async ({ page }) => {
        await setupPage(page);
        await page.locator('#notesHistoryBack').click();
        await page.locator('#notesHistoryBack').click();
        expect((await state(page)).current).toBe(3);
        // host が新しい open を記録して再描画（先頭に e.md）
        const next = [{ kind: 'note-md', id: '/n/e.md', title: 'e', ts: 9, pane: 'main' }, ...H];
        await page.evaluate((h) => { (window as any).__notesHistoryPanel.render(h); }, next);
        expect(await state(page)).toEqual({ back: true, fwd: false, current: 0, currentCount: 1 });
        expect(await page.locator('#sidePanelHistoryList .side-panel-history-item').count()).toBe(6);
    });

    test('AC-3 folder の entry はメインの folder view で開き直し、記録しない（noHistory）', async ({ page }) => {
        const h = [
            { kind: 'note-md', id: '/n/a.md', title: 'a', ts: 2, pane: 'main' },
            { kind: 'folder', id: 'fl1', title: 'Linked', ts: 1, pane: 'main' },
        ];
        await setupPage(page, h);
        await page.locator('#notesHistoryBack').click();
        const msgs = await takeMsgs(page);
        expect(msgs.filter((x: any) => x.type === 'folderViewOpened')).toEqual([{ type: 'folderViewOpened', id: 'fl1', noHistory: true }]);
        // 一覧から選んだときは記録する（noHistory なし）
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-kind="folder"]').click();
        const msgs2 = await takeMsgs(page);
        expect(msgs2.filter((x: any) => x.type === 'folderViewOpened')).toEqual([{ type: 'folderViewOpened', id: 'fl1' }]);
    });

    test('AC-3 0 件 / 1 件では Back / Forward とも disabled', async ({ page }) => {
        await setupPage(page, []);
        expect(await state(page)).toMatchObject({ back: false, fwd: false });
        await page.evaluate(() => { (window as any).__notesHistoryPanel.render([{ kind: 'note-md', id: '/n/a.md', title: 'a', ts: 1, pane: 'main' }]); });
        expect(await state(page)).toMatchObject({ back: false, fwd: false, current: 0 });
    });
});

test.describe('AC-3 移動は記録しない（host）', () => {
    test('AC-3 noHistory の open（md / out / folder / file）は Recent に足さない', async () => {
        const { mod, m, folderId, md, outPath, pdf, sender } = setupHost();
        const platform: any = { historyOpenFile: async () => {} };
        await mod.handleNotesMessage({ type: 'notesOpenFile', filePath: md }, m, sender, platform);
        const before = JSON.stringify(hist(m));
        await mod.handleNotesMessage({ type: 'notesOpenFile', filePath: outPath, noHistory: true }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'folderViewOpened', id: folderId, noHistory: true }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'historyOpenFile', filePath: pdf, noHistory: true }, m, sender, platform);
        expect(JSON.stringify(hist(m)), 'history 配列は変わらない').toBe(before);
    });

    test('AC-3 historyOpenInSidePanel は history に side で載っている実在の md / file だけを開く', async () => {
        const { mod, m, md, pdf, noteDir, sender } = setupHost();
        const opened: string[] = [];
        const platform: any = { historyOpenInSidePanel: async (p: string) => { opened.push(p); } };
        m.recordFileHistory(md, 'side');
        m.recordViewerFileHistory(pdf, 'main');
        const before = JSON.stringify(hist(m));
        await mod.handleNotesMessage({ type: 'historyOpenInSidePanel', filePath: md }, m, sender, platform);
        await mod.handleNotesMessage({ type: 'historyOpenInSidePanel', filePath: pdf }, m, sender, platform); // main entry → 拒否
        await mod.handleNotesMessage({ type: 'historyOpenInSidePanel', filePath: path.join(noteDir, 'outline.note') }, m, sender, platform); // 履歴に無い → 拒否
        expect(opened).toEqual([md]);
        expect(JSON.stringify(hist(m))).toBe(before);
    });

    test('AC-3 SidePanelManager.openFile の noHistory は Recent 記録（onFileOpened）を呼ばない', async () => {
        const { SidePanelManager } = requireWithVscodeStub('../../src/shared/sidePanelManager');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhn-sp-'));
        const f = path.join(dir, 's.md');
        fs.writeFileSync(f, '# S\n');
        const recorded: string[] = [];
        const posted: any[] = [];
        const mgr = new SidePanelManager(
            { postMessage: (x: any) => posted.push(x), asWebviewUri: () => ({ toString: () => 'vscode-webview://x/' }) },
            { logPrefix: '[t]', onFileOpened: (fp: string) => recorded.push(fp) },
        );
        mgr.setupFileWatcher = async () => {}; // vscode の watcher は使わない
        await mgr.openFile(f, true, false, { noHistory: true });
        expect(posted.some((x) => x.type === 'openSidePanel' && x.filePath === f), 'sidepanel には開く').toBe(true);
        expect(recorded).toEqual([]);
        await mgr.openFile(f, true);
        expect(recorded, '通常の open は記録する').toEqual([f]);
    });

    test('AC-2 sidepanel の viewer で開いたファイル（outliner の 📎・sidepanel md 内リンク）は onViewerOpened で記録し、noHistory では記録しない', async () => {
        const { SidePanelManager } = requireWithVscodeStub('../../src/shared/sidePanelManager');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhn-vw-'));
        const pdf = path.join(dir, 'att.pdf');
        fs.writeFileSync(pdf, '%PDF-1.4\n');
        const recorded: string[] = [];
        const posted: any[] = [];
        const mgr = new SidePanelManager(
            { postMessage: (x: any) => posted.push(x), asWebviewUri: () => ({ toString: () => 'vscode-webview://x/' }) },
            { logPrefix: '[t]', onViewerOpened: (fp: string) => recorded.push(fp) },
        );
        expect(await mgr.tryOpenViewerPanel(pdf)).toBe(true);                       // outliner の 📎 / md の 📎
        expect(await mgr.tryOpenViewerPanel(pdf, { overlay: true })).toBe(true);    // sidepanel md 内リンク
        expect(recorded).toEqual([pdf, pdf]);
        expect(await mgr.tryOpenViewerPanel(pdf, { noHistory: true })).toBe(true);  // Back / Forward の開き直し
        expect(recorded, 'noHistory では記録しない').toEqual([pdf, pdf]);
        expect(posted.filter((x) => x.type === 'openViewerPanel').length).toBe(3);
        expect(await mgr.tryOpenViewerPanel(path.join(dir, 'missing.pdf')), '開けないものは記録しない').toBe(false);
        expect(recorded.length).toBe(2);

        // provider は onViewerOpened を pane=side で記録し、Back / Forward の開き直しは noHistory を渡す
        const provider = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
        expect(provider).toMatch(/onViewerOpened: \(fp: string\) => \{[\s\S]{0,80}recordViewerFileHistory\(fp, 'side'\)/);
        expect(provider).toMatch(/historyOpenInSidePanel:[\s\S]{0,500}tryOpenViewerPanel\(absPath, \{ noHistory: true \}\)/);
    });
});

test.describe('AC-4 一覧から選ぶと常にメイン', () => {
    test('AC-4 side で記録された md / file も一覧から選ぶとメインで開く（記録する）', async ({ page }) => {
        await setupPage(page);
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-id="/n/c.md"]').click();
        await page.locator('#sidePanelHistoryList .side-panel-history-item[data-id="/n/d.pdf"]').click();
        expect(await takeMsgs(page)).toEqual([
            { type: 'notesOpenFile', filePath: '/n/c.md' },
            { type: 'historyOpenFile', filePath: '/n/d.pdf' },
        ]);
    });

    test('AC-4 一覧からの file open は host で pane=main として記録される', async () => {
        const { mod, m, pdf, sender } = setupHost();
        m.recordViewerFileHistory(pdf, 'side');
        const opened: string[] = [];
        await mod.handleNotesMessage({ type: 'historyOpenFile', filePath: pdf }, m, sender, { historyOpenFile: async (p: string) => { opened.push(p); } } as any);
        expect(opened).toEqual([pdf]);
        expect(hist(m)[0]).toMatchObject({ kind: 'file', id: pdf, pane: 'main' });
    });
});

test.describe('本番 webview の配線（L-20260817-g03）', () => {
    test('AC-3 notesWebviewContent.ts は Back / Forward と side open を history パネルに渡している', () => {
        const src = fs.readFileSync(path.join(__dirname, '../../src/notesWebviewContent.ts'), 'utf8');
        expect(src).toContain("backEl: document.getElementById('notesHistoryBack')");
        expect(src).toContain("forwardEl: document.getElementById('notesHistoryForward')");
        expect(src).toContain('window.notesHostBridge.historyOpenInSidePanel(absPath)');
        expect(src).toContain('window.__notesTabManager.openInActiveTab(id, kind, opts)');
        const bridge = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
        expect(bridge).toContain("type: 'historyOpenInSidePanel'");
    });
});
