/**
 * TC-ACC-10..14b — cross-note md D&D 6 経路の随伴（sprint 20260820-063902 FR-ACC-03）
 *
 * 旧挙動 = 本文 1 ファイルのみ複製（画像/📎/subpage がリンク切れ — 監査 CONFIRMED）。
 * 新挙動 = transferMdWithAssets（FR-ACC-01）で dest note 座標へ随伴。source は全温存（orphan 契約）。
 * 同一 note 分岐は byte 不変（既存 TC-CN 系が pin — 本 spec では cross のみ駆動）。
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
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

/** note A: 資産持ち page md 一式（main.md + images/pic,deep + files/a.pdf + sub.md + refdoc.md） */
function mkNoteA(): string {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'accA-'));
    fs.mkdirSync(path.join(a, 'images'), { recursive: true });
    fs.mkdirSync(path.join(a, 'files'), { recursive: true });
    fs.writeFileSync(path.join(a, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(a, 'images', 'deep.png'), 'DEEP', 'utf8');
    fs.writeFileSync(path.join(a, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(a, 'sub.md'), '# Sub\n![d](images/deep.png)\n', 'utf8');
    fs.writeFileSync(path.join(a, 'refdoc.md'), '# Ref\n', 'utf8');
    fs.writeFileSync(path.join(a, 'main.md'), '# Main Title\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n[[Sub]](sub.md)\n[ref](refdoc.md)\n', 'utf8');
    return a;
}
function mkNoteB(): { b: string; target: string } {
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'accB-'));
    const target = path.join(b, 'target.md');
    fs.writeFileSync(target, '# Target\n', 'utf8');
    return { b, target };
}
/** dest（target md の隣接座標 = dirname 直下）に随伴一式が揃いリンクが解決することを assert */
function assertAccompanied(destDir: string, mainName: string) {
    const body = fs.readFileSync(path.join(destDir, mainName), 'utf8');
    const imgs = fs.existsSync(path.join(destDir, 'images')) ? fs.readdirSync(path.join(destDir, 'images')) : [];
    const pic = imgs.find((n) => n.includes('pic.png'));
    expect(pic, '画像が随伴していない').toBeTruthy();
    expect(body).toContain(`images/${pic}`);
    expect(fs.existsSync(path.join(destDir, 'files', 'a.pdf')), '📎 が随伴していない').toBe(true);
    expect(fs.existsSync(path.join(destDir, 'sub.md')), 'subpage が随伴していない').toBe(true);
    const deep = imgs.find((n) => n.includes('deep.png'));
    expect(fs.readFileSync(path.join(destDir, 'sub.md'), 'utf8')).toContain(`images/${deep}`);
    // 参照リンクは非複製（isSubpage ゲート境界）
    expect(fs.existsSync(path.join(destDir, 'refdoc.md')), '参照リンクが複製された').toBe(false);
}
/** source A が全温存（orphan 契約）であることを assert */
function assertSourceIntact(a: string) {
    expect(fs.existsSync(path.join(a, 'main.md'))).toBe(true);
    expect(fs.existsSync(path.join(a, 'sub.md'))).toBe(true);
    expect(fs.readdirSync(path.join(a, 'images')).length).toBe(2);
    expect(fs.existsSync(path.join(a, 'files', 'a.pdf'))).toBe(true);
}

const FM = () => requireWithVscodeStub('../../src/shared/notes-file-manager').NotesFileManager;

test('TC-ACC-10 importOutPageNodeToMd cross-note（報告シナリオ）: 随伴 + source 温存 + page 属性クリア不変', () => {
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const a = mkNoteA();
    const { b, target } = mkNoteB();
    const outPath = path.join(a, 'x.out');
    fs.writeFileSync(outPath, JSON.stringify({
        version: 1, pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'Main Title', isPage: true, pageId: 'main', images: [] } },
    }), 'utf8');
    const fmB = new (FM())(b);
    fmB.getStructure();
    const msgs: any[] = [];
    mh.importOutPageNodeToMd(fmB, { postMessage: (m: any) => msgs.push(m) }, { outFileKey: outPath, nodeId: 'n1', pageId: 'main' }, target);

    const link = msgs.find((m) => m.type === 'insertSubpageLink');
    expect(link, 'insertSubpageLink が飛んでいない').toBeTruthy();
    expect(link.markdownPath).toBe('main.md');
    assertAccompanied(b, 'main.md');
    assertSourceIntact(a);
    // 元 node の page 属性クリア（既存契約不変）
    const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(outData.nodes.n1.isPage).toBeFalsy();
});

test('TC-ACC-11 linkMdSubpageToMd cross-note: 随伴 + アンカー除去 2 段（既存契約）不変', () => {
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const a = mkNoteA();
    const { b, target } = mkNoteB();
    const srcMd = path.join(a, 'source.md');
    fs.writeFileSync(srcMd, 'before\n[[Main]](main.md)\nafter\n', 'utf8');
    const fmB = new (FM())(b);
    fmB.getStructure();
    fmB.openFile(target);
    const msgs: any[] = [];
    mh.linkMdSubpageToMd(fmB, { postMessage: (m: any) => msgs.push(m) }, { href: 'main.md', sourceMdPath: srcMd }, target);

    expect(msgs.find((m) => m.type === 'insertSubpageLink')?.markdownPath).toBe('main.md');
    assertAccompanied(b, 'main.md');
    assertSourceIntact(a);
    // アンカー除去（既存 2 段契約の維持）
    expect(fs.readFileSync(srcMd, 'utf8')).not.toContain('(main.md)');
    expect(msgs.some((m) => m.type === 'removeSubpageLink')).toBe(true);
});

test('TC-ACC-12 importMdSubpageIntoOut cross-note: dest note フラット座標へ随伴 + page 化', () => {
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const a = mkNoteA();
    const { b } = mkNoteB();
    const outPath = path.join(b, 'dest.out');
    fs.writeFileSync(outPath, JSON.stringify({ version: 1, pageDir: '.', imageDir: './images', fileDir: './files', rootIds: [], nodes: {} }), 'utf8');
    const srcMd = path.join(a, 'source.md');
    fs.writeFileSync(srcMd, '[[Main]](main.md)\n', 'utf8');
    const fmB = new (FM())(b);
    fmB.getStructure();
    fmB.openFile(outPath);
    const msgs: any[] = [];
    mh.importMdSubpageIntoOut(fmB, { postMessage: (m: any) => msgs.push(m) }, { href: 'main.md', sourceMdPath: srcMd }, outPath, null, null);

    assertAccompanied(b, 'main.md'); // note B フラット（mainFolder 直下 + 共有 dir）
    assertSourceIntact(a);
    const outData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const node: any = Object.values(outData.nodes)[0];
    expect(node.isPage).toBe(true);
    expect(node.pageId).toBe('main');
});

test('TC-ACC-13 registerSubpageFromMdCore 非 flat 分岐: 随伴 + 台帳登録は新 md 1 件のみ（closure は台帳外）', () => {
    const nep = requireWithVscodeStub('../../src/notesEditorProvider');
    const a = mkNoteA();
    const { b } = mkNoteB();
    const srcMd = path.join(a, 'source.md');
    fs.writeFileSync(srcMd, '[[Main]](main.md)\n', 'utf8');
    const fmB = new (FM())(b);
    fmB.getStructure();
    const before = (Object.values(fmB.getStructure().items) as any[]).filter((it) => it.ext === 'md').length;
    const msgs: any[] = [];
    nep.registerSubpageFromMdCore(fmB, { href: 'main.md', sourceMdPath: srcMd }, null, 0, { postMessage: (m: any) => msgs.push(m) });

    assertAccompanied(b, 'main.md');
    assertSourceIntact(a);
    // 台帳 +1 のみ（sub.md は fs には随伴するが台帳外 = liveness は md-link closure）
    const after = (Object.values(fmB.getStructure().items) as any[]).filter((it) => it.ext === 'md').length;
    expect(after).toBe(before + 1);
});

test('TC-ACC-14a linkMdAsSubpageForSidePanelCore cross-note: 随伴 + tree 除去等の既存副作用不変', () => {
    // 現実の向き: source = 自 note（A の tree md item）/ target = 別 note B の md を sidepanel で開いている
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const a = mkNoteA();
    const { b, target } = mkNoteB();
    const fmA = new (FM())(a);
    fmA.getStructure();
    const msgs: any[] = [];
    mh.linkMdAsSubpageForSidePanelCore(fmA, { postMessage: (m: any) => msgs.push(m) }, path.join(a, 'main.md'), null, target);

    const link = msgs.find((m) => m.type === 'insertSubpageLink');
    expect(link?.markdownPath).toBe('main.md');
    expect(link?.title).toBe('Main Title');
    assertAccompanied(b, 'main.md');
    assertSourceIntact(a);
});

test('TC-ACC-14b linkMdAsSubpageForNotesMdCore（nep seam）cur 外部分岐: 随伴 + 既存副作用不変', () => {
    const nep = requireWithVscodeStub('../../src/notesEditorProvider');
    expect(typeof nep.linkMdAsSubpageForNotesMdCore, 'seam export 不在').toBe('function');
    const a = mkNoteA();  // fm の note（tree の持ち主）
    const { b, target } = mkNoteB(); // cur = 別 note の md
    const fmA = new (FM())(a);
    fmA.getStructure();
    fmA.openFile(target); // cur = mainFolder(A) 外 → cross 分岐
    const msgs: any[] = [];
    nep.linkMdAsSubpageForNotesMdCore(fmA, { postMessage: (m: any) => msgs.push(m) }, path.join(a, 'main.md'), null);

    const link = msgs.find((m) => m.type === 'insertSubpageLink');
    expect(link?.markdownPath).toBe('main.md');
    assertAccompanied(b, 'main.md');
    assertSourceIntact(a);
});
