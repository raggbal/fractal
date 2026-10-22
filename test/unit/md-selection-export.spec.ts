/**
 * md エディタの範囲選択 Export（md-selection-export / md-link-actions-host）と Reveal in Finder の host 側。
 *   - Export folder: 箇条書きの入れ子 = フォルダ木。リンク先 md は画像ごと、添付はリンク名で書き出す
 *   - Export bundle: 選択範囲を 1 本の md にし、選んだリンク先は種別（subpage / 参照）を問わず入れる
 *   - Reveal in Finder: copyLinkPath と同じ clamp で解決して revealFileInOS
 * 実 fs（tmp dir）で確かめる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
type Sink = { commands: any[][]; warnings: string[] };
function requireWithVscodeStub(modulePath: string, sink: Sink): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: (...args: any[]) => { sink.commands.push(args); } },
                window: { showWarningMessage: (m: string) => { sink.warnings.push(m); } },
                env: { clipboard: { writeText: () => {} } },
                ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

/** note: page.md / sub.md（画像つき）/ ref.md / files/report.xlsx */
function makeNote(): { root: string; md: string; resolvers: any } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsel-'));
    fs.mkdirSync(path.join(root, 'images'));
    fs.mkdirSync(path.join(root, 'files'));
    fs.writeFileSync(path.join(root, 'images', 'pic.png'), 'PNG');
    fs.writeFileSync(path.join(root, 'files', 'report.xlsx'), 'XLSX');
    fs.writeFileSync(path.join(root, 'sub.md'), '# Sub\n\n![](images/pic.png)\n');
    fs.writeFileSync(path.join(root, 'ref.md'), '# Ref\n');
    const md = path.join(root, 'page.md');
    fs.writeFileSync(md, '# Page\n');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveLinkTargetUnder } = require('../../src/shared/path-safety');
    const resolvers = {
        resolveMd: (u: string) => resolveLinkTargetUnder(root, md, u),
        resolveFile: (u: string) => resolveLinkTargetUnder(path.join(root, 'files'), md, u),
    };
    return { root, md, resolvers };
}

const SELECTION = [
    '- Group',
    '    - [[Sub Page]](sub.md)',
    '    - [📎 report.xlsx](files/report.xlsx)',
    '- [Ref doc](ref.md) [web](https://example.com)',
    '- [outside](../escape.md)',
    '- plain item',
].join('\n');

test('buildMdSelectionExportTree: 入れ子 = 木 / リンク無し行は配下にリンクがあるときだけ残す / 外部・clamp 外は対象外', () => {
    const { buildMdSelectionExportTree } = require('../../src/shared/md-selection-export');
    const { resolvers, root } = makeNote();
    const plan = buildMdSelectionExportTree(SELECTION, resolvers);
    expect(plan.linkCount).toBe(3);
    const shape = (ns: any[]): any[] => ns.map((n) => ({
        text: n.text, md: n.pageId != null ? plan.mdByKey.get(n.pageId) : undefined,
        file: n.filePath || undefined, children: shape(n.children || []),
    }));
    expect(shape(plan.tree)).toEqual([
        { text: 'Group', md: undefined, file: undefined, children: [
            { text: 'Sub Page', md: path.join(root, 'sub.md'), file: undefined, children: [] },
            { text: 'report.xlsx', md: undefined, file: path.join(root, 'files', 'report.xlsx'), children: [] },
        ] },
        { text: 'Ref doc', md: path.join(root, 'ref.md'), file: undefined, children: [] },
    ]);
});

test('Export folder（実 fs）: Group/ に Sub Page.md（画像も複製・リンク書換）と report.xlsx、直下に Ref doc.md', async () => {
    const sink: Sink = { commands: [], warnings: [] };
    const { buildMdSelectionExportTree, makeMdSelectionExportMd } = require('../../src/shared/md-selection-export');
    const { runFolderExport } = require('../../src/shared/folder-export');
    const { resolvers, root } = makeNote();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsel-dest-'));
    const plan = buildMdSelectionExportTree(SELECTION, resolvers);
    const out = await runFolderExport(plan.tree, {
        pickDestination: () => dest, confirmLarge: () => true, notifyDone: () => {},
        srcOutDir: '', srcPagesDir: '', srcFileDir: '', srcImageDir: '',
        exportMd: makeMdSelectionExportMd(plan.mdByKey),
    });
    expect(out.status).toBe('exported');
    expect(out.skipped).toBe(0);
    expect(fs.readFileSync(path.join(dest, 'Group', 'report.xlsx'), 'utf8')).toBe('XLSX');
    const sub = fs.readFileSync(path.join(dest, 'Group', 'Sub Page.md'), 'utf8');
    const img = /!\[\]\(([^)]+)\)/.exec(sub)![1];
    expect(fs.readFileSync(path.join(dest, 'Group', img), 'utf8')).toBe('PNG');
    expect(fs.readFileSync(path.join(dest, 'Ref doc.md'), 'utf8')).toBe('# Ref\n');
    // 元データは不変
    expect(fs.readFileSync(path.join(root, 'sub.md'), 'utf8')).toBe('# Sub\n\n![](images/pic.png)\n');
    expect(sink.warnings).toEqual([]);
});

test('Export bundle（rootBody）: 選択範囲が <md名>-selection.md になり、参照リンク先も includeLinks=off で入る', () => {
    const { exportBundle } = require('../../src/shared/md-export-core');
    const { selectionBundleRootPath } = require('../../src/shared/md-selection-export');
    const { md } = makeNote();
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsel-bundle-'));
    const r = exportBundle({
        rootMdAbs: selectionBundleRootPath(md), dest, rootBody: '- [[Sub Page]](sub.md)\n- [Ref doc](ref.md)\n',
        options: { includeChildren: true, recurseChildren: true, includeLinks: false, recurseLinks: false },
    });
    expect(r.ok).toBe(true);
    expect(path.basename(r.bundleDir)).toBe('page-selection');
    expect(r.mdCount).toBe(3);
    expect(r.imageCount).toBe(1);
    const rootOut = fs.readFileSync(path.join(r.bundleDir, 'page-selection.md'), 'utf8');
    expect(rootOut).toBe('- [Sub Page](sub.md)\n- [Ref doc](ref.md)\n');
    expect(fs.readFileSync(path.join(r.bundleDir, 'ref.md'), 'utf8')).toBe('# Ref\n');
    expect(fs.readFileSync(path.join(r.bundleDir, 'sub.md'), 'utf8')).toContain('](images/pic.png)');
    expect(fs.existsSync(path.join(r.bundleDir, 'images', 'pic.png'))).toBe(true);
});

test('Export bundle（rootBody なし）は従来どおり: 参照リンク先は includeLinks=off で入らない', () => {
    const { exportBundle } = require('../../src/shared/md-export-core');
    const { root } = makeNote();
    fs.writeFileSync(path.join(root, 'page.md'), '[[Sub Page]](sub.md)\n[Ref doc](ref.md)\n');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mdsel-bundle-'));
    const r = exportBundle({
        rootMdAbs: path.join(root, 'page.md'), dest,
        options: { includeChildren: true, recurseChildren: true, includeLinks: false, recurseLinks: false },
    });
    expect(r.ok).toBe(true);
    expect(r.mdCount).toBe(2);
    expect(fs.existsSync(path.join(r.bundleDir, 'ref.md'))).toBe(false);
});

test('revealMdLinkTarget: md / file は clamp 済みの絶対パスで revealFileInOS、clamp 外・実体なしは警告だけ', async () => {
    const sink: Sink = { commands: [], warnings: [] };
    const { revealMdLinkTarget } = requireWithVscodeStub('../../src/shared/md-link-actions-host', sink);
    const { resolvers, root } = makeNote();
    await revealMdLinkTarget('sub.md', 'md', resolvers);
    await revealMdLinkTarget('files/report.xlsx', 'file', resolvers);
    expect(sink.commands).toEqual([
        ['revealFileInOS', { fsPath: path.join(root, 'sub.md') }],
        ['revealFileInOS', { fsPath: path.join(root, 'files', 'report.xlsx') }],
    ]);
    await revealMdLinkTarget('../escape.md', 'md', resolvers);
    await revealMdLinkTarget('missing.md', 'md', resolvers);
    await revealMdLinkTarget('https://example.com', 'normal', resolvers);
    expect(sink.commands.length).toBe(2);
    expect(sink.warnings.length).toBe(3);
});

test('notes handler: revealLinkTarget / exportMdSelectionBundle / exportMdSelectionFolder を platform へ宛先 md 付きで渡す', async () => {
    const sink: Sink = { commands: [], warnings: [] };
    const { handleNotesMessage } = requireWithVscodeStub('../../src/shared/notes-message-handler', sink);
    const calls: any[] = [];
    const platform = {
        showInformationMessage: () => {}, showErrorMessage: () => {},
        revealLinkTarget: (...a: any[]) => calls.push(['reveal', ...a]),
        exportMdSelectionBundle: (...a: any[]) => calls.push(['bundle', ...a]),
        exportMdSelectionFolder: (...a: any[]) => calls.push(['folder', ...a]),
    } as any;
    const fm = { getCurrentFilePath: () => '/notes/A/x.out' } as any;
    const sender = { postMessage: () => {} } as any;
    const opts = { includeChildren: true, recurseChildren: false, includeLinks: true, recurseLinks: false };
    await handleNotesMessage({ type: 'revealLinkTarget', href: 's.md', kind: 'md', sidePanelFilePath: '/notes/A/p.md' }, fm, sender, platform);
    await handleNotesMessage({ type: 'exportMdSelectionBundle', markdown: '[a](s.md)', options: opts, sidePanelFilePath: '/notes/A/p.md' }, fm, sender, platform);
    await handleNotesMessage({ type: 'exportMdSelectionFolder', markdown: '[a](s.md)', sidePanelFilePath: '/notes/A/p.md' }, fm, sender, platform);
    expect(calls).toEqual([
        ['reveal', 's.md', 'md', '/notes/A/p.md'],
        ['bundle', '[a](s.md)', '/notes/A/p.md', opts],
        ['folder', '[a](s.md)', '/notes/A/p.md'],
    ]);
});

test('SidePanelHostBridge（手書きクラス）と notes md の override に 3 メソッドが個別実在（sidepanel だけ no-op の再発防止）', () => {
    const ed = fs.readFileSync(path.join(__dirname, '../../src/webview/editor.js'), 'utf8');
    const cls = ed.slice(ed.indexOf('class SidePanelHostBridge'), ed.indexOf('class SidePanelHostBridge') + 20000);
    const notes = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
    const factory = fs.readFileSync(path.join(__dirname, '../../src/shared/sidepanel-bridge-methods.js'), 'utf8');
    for (const m of ['revealLinkTarget', 'exportMdSelectionBundle', 'exportMdSelectionFolder']) {
        expect(cls.includes(m + '('), `SidePanelHostBridge.${m} 不在`).toBe(true);
        expect(notes.includes(m + ': function'), `notes-host-bridge.${m} 不在`).toBe(true);
        expect(factory.includes(m + ': function'), `sidepanel-bridge-methods.${m} 不在`).toBe(true);
    }
});
