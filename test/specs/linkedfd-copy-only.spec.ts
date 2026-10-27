/**
 * spec 20261027-1556-linkedfd-copy-only — linkedfd と Fractal の間の転送は常にコピー（元を消さない）
 *
 * AC-1: 経路マトリクスの各セル（Fractal の各面 → linkedfd / linkedfd → Fractal の各面 / clipboard）で、
 *       転送後も元が残り内容が変わらず、先にコピーができる
 * AC-2: host は webview から移動の指示が来ても、境界をまたぐなら元を消さない（D2）
 * AC-3: linkedfd の中の移動と Fractal の中の移動は今までどおり移動
 *
 * host 側は tmp dir + vscode stub で本番の関数を直接呼ぶ（`trashDelete` は本番と同じく実際に消す）。
 * webview 側（D3 = dropEffect）は standalone-notes.html で real mouse drag する
 * （合成 DataTransfer では dropEffect が読めない — test/specs/folder-view-dnd.spec.ts TC-DCP-11 と同じ方法）。
 */
import { test, expect, Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── host 側の土台 ──

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
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
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => undefined },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

function sha(p: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** trashDelete は本番（vscode.workspace.fs.delete）と同じく実際に消す。 */
function makeDeps() {
    const calls: { trash: string[]; errors: string[] } = { trash: [], errors: [] };
    const deps = {
        showErrorMessage: (m: string) => { calls.errors.push(m); },
        t: (_k: string) => undefined as any,
        trashDelete: async (abs: string, recursive: boolean) => {
            calls.trash.push(abs);
            try { fs.rmSync(abs, { recursive, force: true }); } catch { /* best effort */ }
        },
        toDisplayUri: (abs: string) => 'vscode-resource://' + abs,
    };
    return { deps, calls };
}
function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => messages.push(m) }, messages };
}

interface Env {
    mh: any;
    m: any;
    id: string;
    noteDir: string;
    root: string;
    cleanup: () => void;
}

/** note + linkedfd（root）。linkedfd には資産持ちの md 一式と単体ファイルを置く。 */
function setup(): Env {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lcopy-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcopy-fd-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    // linkedfd 側
    fs.mkdirSync(path.join(root, 'images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(root, 'files', 'spec.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(root, 'subp.md'), '# Subp\n', 'utf8');
    fs.writeFileSync(path.join(root, 'main.md'),
        '# Main\n![i](images/pic.png)\n[📎 spec.pdf](files/spec.pdf)\n[[Subp]](subp.md)\n', 'utf8');
    fs.writeFileSync(path.join(root, 'photo.png'), 'PNG-2', 'utf8');
    fs.writeFileSync(path.join(root, 'r.pdf'), 'PDF-R', 'utf8');
    // note 側
    fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(noteDir, 'files', 'att.pdf'), 'ATT', 'utf8');
    fs.writeFileSync(path.join(noteDir, 'nsub.md'), '# NSub\n', 'utf8');
    fs.writeFileSync(path.join(noteDir, 'doc.md'), '# Doc\n[📎 att.pdf](files/att.pdf)\n[[NSub]](nsub.md)\n', 'utf8');
    const cleanup = () => {
        for (const d of [noteDir, root]) {
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    };
    return { mh, m, id, noteDir, root, cleanup };
}

/** 元のパス一式の sha を取り、あとで「全部残っていて内容も同じ」を確かめる。 */
function snapshot(paths: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of paths) { out[p] = sha(p); }
    return out;
}
function expectIntact(snap: Record<string, string>, label: string): void {
    for (const p of Object.keys(snap)) {
        expect(fs.existsSync(p), `${label}: 元 ${p} が消えた（移動になっている）`).toBe(true);
        expect(sha(p), `${label}: 元 ${p} の内容が変わった`).toBe(snap[p]);
    }
}
function linkedfdSources(e: Env): string[] {
    return ['main.md', 'subp.md', 'images/pic.png', 'files/spec.pdf', 'photo.png', 'r.pdf'].map((r) => path.join(e.root, r));
}
function noteSources(e: Env): string[] {
    return ['doc.md', 'nsub.md', 'files/att.pdf'].map((r) => path.join(e.noteDir, r));
}
function removeEchoes(messages: any[]): any[] {
    return messages.filter((x) => x.type === 'removeFileLink' || x.type === 'removeSubpageLink');
}
function noteMd(e: Env, name: string, body: string): string {
    const p = path.join(e.noteDir, name);
    fs.writeFileSync(p, body, 'utf8');
    return p;
}
/** note に .out を作り、file node / page node を持たせる（outliner 発のセル用）。 */
function makeOutWithNodes(e: Env): { outPath: string; outId: string } {
    const outPath = e.m.createFile('Plan');
    const outId = path.basename(outPath, '.out');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    fs.writeFileSync(path.join(e.noteDir, 'pagex.md'), '# PageX\n', 'utf8');
    data.nodes = data.nodes || {};
    data.rootIds = data.rootIds || [];
    data.nodes.nf = { id: 'nf', parentId: null, children: [], text: 'att.pdf', tags: [], isPage: false, pageId: null,
        collapsed: false, checked: null, subtext: '', images: [], filePath: 'files/att.pdf' };
    data.nodes.np = { id: 'np', parentId: null, children: [], text: 'PageX', tags: [], isPage: true, pageId: 'pagex',
        collapsed: false, checked: null, subtext: '', images: [], filePath: null };
    data.rootIds.push('nf', 'np');
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    return { outPath, outId };
}

// ═════════════════════════════════════════════════════════════════════
// AC-1: 境界をまたぐ全セルで、元が残り（内容不変）、先にコピーができる
// ═════════════════════════════════════════════════════════════════════

test.describe('AC-1 linkedfd → Fractal（host）', () => {
    test('AC-1 fv の md → note の md（sidepanel / main editor）: linkedfd の md と随伴資産が残り、note 側に複製', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const target = noteMd(e, 'target.md', '# Target\n');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'main.md', target, deps as any, sender as any)).toBe(true);
            expectIntact(snap, 'fv md → note md');
            expect(calls.trash, 'trash が呼ばれた').toEqual([]);
            const ins = messages.find((x) => x.type === 'insertSubpageLink');
            expect(ins, 'リンク挿入指示が無い').toBeTruthy();
            expect(fs.existsSync(path.join(e.noteDir, ins.markdownPath)), 'note 側に md の複製が無い').toBe(true);
            expect(fs.existsSync(path.join(e.noteDir, 'files', 'spec.pdf')), '随伴 📎 が note 側に無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 fv の画像 → note の md: 元画像が残り、note の images/ に複製', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const target = noteMd(e, 'target.md', '# Target\n');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'photo.png', target, deps as any, sender as any)).toBe(true);
            expectIntact(snap, 'fv 画像 → note md');
            expect(calls.trash).toEqual([]);
            const ins = messages.find((x) => x.type === 'insertImageHtml');
            expect(ins && fs.existsSync(path.join(e.noteDir, ins.markdownPath)), 'note 側に画像の複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 fv のファイル → note の md: 元ファイルが残り、note の files/ に複製', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const target = noteMd(e, 'target.md', '# Target\n');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'r.pdf', target, deps as any, sender as any)).toBe(true);
            expectIntact(snap, 'fv file → note md');
            expect(calls.trash).toEqual([]);
            const ins = messages.find((x) => x.type === 'insertFileLink');
            expect(ins && fs.existsSync(path.join(e.noteDir, ins.markdownPath)), 'note 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 fv のファイル → note ツリーの md 行（folderViewMoveIntoMdItem と同じ writeToDisk 経路）: 元が残る', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const mdId = e.m.registerMarkdownFile('# Item\n', 'Item', null, 0);
            const target = e.m.getMdFilePath(mdId);
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'r.pdf', target, deps as any, sender as any, { writeToDisk: true })).toBe(true);
            expectIntact(snap, 'fv file → tree md 行');
            expect(calls.trash).toEqual([]);
            expect(fs.readFileSync(target, 'utf8'), '対象 md にリンクが追記されていない').toContain('r.pdf');
            expect(fs.existsSync(path.join(e.noteDir, 'files', 'r.pdf')), 'note 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 fv の md → note ツリー（folderViewMoveToTree）: 元が残る（既に複製・回帰の番人）', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            expect(await e.mh.folderViewMoveToTree(e.m, e.id, 'main.md', null, 0, deps as any, sender as any)).toBe(true);
            expectIntact(snap, 'fv → tree');
            expect((Object.values(e.m.getStructure().items) as any[]).some((it) => it.ext === 'md'), 'tree に md が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 fv の dir → outliner（「Outliner に送る」= runSendToOutliner）: 元が残る（既に複製・回帰の番人）', async () => {
        const e = setup();
        try {
            const fi = requireWithVscodeStub('../../src/shared/folder-import');
            fs.writeFileSync(path.join(e.root, 'sub', 'x.md'), '# X\n', 'utf8');
            const snap = snapshot([...linkedfdSources(e), path.join(e.root, 'sub', 'x.md')]);
            const outcome = await fi.runSendToOutliner({
                roots: [path.join(e.root, 'sub'), path.join(e.root, 'r.pdf')],
                confirmLarge: () => true, notifyLimitExceeded: () => {}, notifySkipped: () => {},
                pageDir: e.noteDir, imageDir: path.join(e.noteDir, 'images'), fileDir: path.join(e.noteDir, 'files'), outDir: e.noteDir,
            });
            expect(outcome.status).toBe('imported');
            expectIntact(snap, 'fv → outliner');
            expect(fs.existsSync(path.join(e.noteDir, 'files', 'r.pdf')), 'outliner 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 sidepanel で開いた linkedfd の md の 📎 → note の md: linkedfd の md のリンクも実体も残る', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const target = noteMd(e, 'target.md', '# Target\n');
            e.mh.attachMdFileLinkToMd(e.m, sender as any, { href: 'files/spec.pdf', sourceMdPath: path.join(e.root, 'main.md') }, target);
            expectIntact(snap, 'linkedfd md 📎 → note md');
            expect(removeEchoes(messages), '元 md のリンク除去エコーが出た').toEqual([]);
            const ins = messages.find((x) => x.type === 'insertFileLink');
            expect(ins && fs.existsSync(path.resolve(e.noteDir, ins.markdownPath)), 'note 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 linkedfd の md の subpage → note の md: 元が残る', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            const target = noteMd(e, 'target.md', '# Target\n');
            e.mh.linkMdSubpageToMd(e.m, sender as any, { href: 'subp.md', sourceMdPath: path.join(e.root, 'main.md') }, target);
            expectIntact(snap, 'linkedfd md subpage → note md');
            expect(removeEchoes(messages)).toEqual([]);
            const ins = messages.find((x) => x.type === 'insertSubpageLink');
            expect(ins && fs.existsSync(path.join(e.noteDir, ins.markdownPath)), 'note 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 linkedfd の md の 📎 → note ツリー: 元が残り、note の files/ に複製して登録', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(linkedfdSources(e));
            e.mh.treeFileRegisterFromMdLink(e.m, sender as any, { href: 'files/spec.pdf', sourceMdPath: path.join(e.root, 'main.md') }, null, 0);
            expectIntact(snap, 'linkedfd md 📎 → tree');
            expect(removeEchoes(messages)).toEqual([]);
            const items = (Object.values(e.m.getStructure().items) as any[]).filter((it) => it.ext === 'file');
            expect(items.length, 'tree に file 項目が登録されていない').toBe(1);
            expect(fs.existsSync(e.m.getTreeFilePath(items[0].id)), '登録した項目の実体が note に無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 linkedfd の md の subpage → note ツリー（registerSubpageFromMdCore）: 元が残る', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const nep = requireWithVscodeStub('../../src/notesEditorProvider');
            const snap = snapshot(linkedfdSources(e));
            nep.registerSubpageFromMdCore(e.m, { href: 'subp.md', sourceMdPath: path.join(e.root, 'main.md') }, null, 0, sender);
            expectIntact(snap, 'linkedfd md subpage → tree');
            expect(removeEchoes(messages)).toEqual([]);
            expect((Object.values(e.m.getStructure().items) as any[]).some((it) => it.ext === 'md'), 'tree に md が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 linkedfd の md の 📎 / subpage → outliner（開いている .out・tree の .out 行）: 元が残る', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const { outPath, outId } = makeOutWithNodes(e);
            const snap = snapshot(linkedfdSources(e));
            const src = path.join(e.root, 'main.md');
            e.mh.importMdFileLinkIntoOut(e.m, sender as any, { href: 'files/spec.pdf', sourceMdPath: src }, outPath, null, null);
            e.mh.importMdSubpageIntoOut(e.m, sender as any, { href: 'subp.md', sourceMdPath: src }, outPath, null, null);
            expect(e.mh.importMdFileLinkIntoOutFile(e.m, sender as any, { href: 'files/spec.pdf', sourceMdPath: src }, outId)).toBe(true);
            expectIntact(snap, 'linkedfd md → outliner');
            expect(removeEchoes(messages)).toEqual([]);
            expect(messages.some((x) => x.type === 'dropFilesResult'), 'outliner への挿入指示が無い').toBe(true);
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect((Object.values(data.nodes) as any[]).some((n) => n.isPage && n.text === 'Subp'), 'page node が足されていない').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 linkedfd の md のリンク → note ツリーの md 行（linkMdLinkIntoMdItem）: 元が残る', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const mdId = e.m.registerMarkdownFile('# Item\n', 'Item', null, 0);
            const snap = snapshot(linkedfdSources(e));
            const src = path.join(e.root, 'main.md');
            expect(e.mh.linkMdLinkIntoMdItem(e.m, sender as any, { href: 'files/spec.pdf', sourceMdPath: src }, 'file', mdId)).toBe(true);
            expect(e.mh.linkMdLinkIntoMdItem(e.m, sender as any, { href: 'subp.md', sourceMdPath: src }, 'subpage', mdId)).toBe(true);
            expectIntact(snap, 'linkedfd md → tree md 行');
            expect(removeEchoes(messages)).toEqual([]);
        } finally { e.cleanup(); }
    });
});

test.describe('AC-1 Fractal → linkedfd（host）', () => {
    test('AC-1 note の md の 📎 → fv の dir（folderViewMoveFromMd）: note の md と実体が残り、linkedfd に複製', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(noteSources(e));
            const ok = await e.mh.folderViewMoveFromMd(e.m, e.id, 'sub',
                { href: 'files/att.pdf', sourceMdPath: path.join(e.noteDir, 'doc.md') }, deps as any, sender as any);
            expect(ok).toBe(true);
            expectIntact(snap, 'note md 📎 → fv');
            expect(calls.trash).toEqual([]);
            expect(removeEchoes(messages)).toEqual([]);
            expect(fs.existsSync(path.join(e.root, 'sub', 'att.pdf')), 'linkedfd に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 note の md の subpage → note ツリーの folder link 行（dst = root）: 元が残る', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot(noteSources(e));
            const ok = await e.mh.folderViewMoveFromMd(e.m, e.id, '',
                { href: 'nsub.md', sourceMdPath: path.join(e.noteDir, 'doc.md'), isSubpage: true }, deps as any, sender as any);
            expect(ok).toBe(true);
            expectIntact(snap, 'note md subpage → folder link 行');
            expect(calls.trash).toEqual([]);
            expect(removeEchoes(messages)).toEqual([]);
            expect(fs.existsSync(path.join(e.root, 'nsub.md')), 'linkedfd に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 note ツリーの md / file → fv・folder link 行（folderViewMoveIn）: 元が残る（既に複製・回帰の番人）', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            const mdId = e.m.registerMarkdownFile('# T\nbody\n', 'T', null, 0);
            const fileId = e.m.registerTreeFile('t.txt', 't.txt', null, 0, Buffer.from('TXT'));
            const mdAbs = e.m.getMdFilePath(mdId);
            const fileAbs = e.m.getTreeFilePath(fileId);
            const snap = snapshot([mdAbs, fileAbs]);
            expect(await e.mh.folderViewMoveIn(e.m, e.id, 'sub', 'md', mdId, deps as any, sender as any)).toBe(true);
            expect(await e.mh.folderViewMoveIn(e.m, e.id, '', 'file', fileId, deps as any, sender as any)).toBe(true);
            expectIntact(snap, 'tree → fv');
            expect(e.m.getStructure().items[mdId], 'tree の md 項目が消えた').toBeTruthy();
            expect(e.m.getStructure().items[fileId], 'tree の file 項目が消えた').toBeTruthy();
        } finally { e.cleanup(); }
    });

    test('AC-1 outliner の node → fv（「linkedfd に送る」= runSendNodesToFolderLink）: .out と page md が残る（既に複製・回帰の番人）', async () => {
        const e = setup();
        try {
            const feh = requireWithVscodeStub('../../src/shared/folder-export-host');
            const { outPath } = makeOutWithNodes(e);
            const snap = snapshot([outPath, path.join(e.noteDir, 'pagex.md'), path.join(e.noteDir, 'files', 'att.pdf')]);
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            const tree = e.mh.buildExportNodesFromOutData(data, ['nf', 'np']);
            const outcome = await feh.runSendNodesToFolderLink({
                tree, srcOutDir: e.noteDir, srcPagesDir: e.noteDir,
                srcFileDir: path.join(e.noteDir, 'files'), srcImageDir: path.join(e.noteDir, 'images'),
                destRoot: path.join(e.root, 'sub'),
            });
            expect(outcome.status).toBe('exported');
            expectIntact(snap, 'outliner → fv');
            expect(fs.readdirSync(path.join(e.root, 'sub')).length, 'linkedfd に何も書き出されていない').toBeGreaterThan(0);
        } finally { e.cleanup(); }
    });

    test('AC-1 note ツリーの md / file → sidepanel で開いた linkedfd の md: ツリー項目が残る', async () => {
        const e = setup();
        const { sender } = makeSender();
        try {
            const mdId = e.m.registerMarkdownFile('# T\nbody\n', 'T', null, 0);
            const fileId = e.m.registerTreeFile('t.txt', 't.txt', null, 0, Buffer.from('TXT'));
            const snap = snapshot([e.m.getMdFilePath(mdId), e.m.getTreeFilePath(fileId)]);
            const target = path.join(e.root, 'main.md');
            expect(e.mh.linkMdAsSubpageForSidePanelCore(e.m, sender as any, e.m.getMdFilePath(mdId), mdId, target)).toBe(true);
            expect(e.mh.treeFileAttachToMdEditor(e.m, sender as any, fileId, target)).toBe(true);
            expectIntact(snap, 'tree → linkedfd md');
            expect(e.m.getStructure().items[mdId], 'tree の md 項目が消えた').toBeTruthy();
            expect(e.m.getStructure().items[fileId], 'tree の file 項目が消えた').toBeTruthy();
            expect(fs.existsSync(path.join(e.root, 'files', 't.txt')), 'linkedfd 側に複製が無い').toBe(true);
        } finally { e.cleanup(); }
    });

    test('AC-1 outliner の file node / page node → sidepanel で開いた linkedfd の md: node と添付が残る', async () => {
        const e = setup();
        const { sender } = makeSender();
        try {
            const { outPath } = makeOutWithNodes(e);
            const snap = snapshot([outPath, path.join(e.noteDir, 'pagex.md'), path.join(e.noteDir, 'files', 'att.pdf')]);
            const target = path.join(e.root, 'main.md');
            e.mh.attachOutNodeFileToMd(e.m, sender as any, { outFileKey: outPath, nodeId: 'nf' }, target);
            e.mh.importOutPageNodeToMd(e.m, sender as any, { outFileKey: outPath, nodeId: 'np', pageId: 'pagex' }, target);
            expectIntact(snap, 'outliner → linkedfd md');
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(data.nodes.nf && data.nodes.nf.filePath, 'file node の添付が外れた').toBe('files/att.pdf');
            expect(data.nodes.np && data.nodes.np.isPage, 'page node の page が外れた').toBe(true);
        } finally { e.cleanup(); }
    });
});

test.describe('AC-1 clipboard cut → paste', () => {
    test('AC-1 linkedfd の cmd+x は何も消さない（cut の経路が無い = paste 先へは常に複製）', async ({ page }) => {
        await setupWebview(page);
        await page.click('.fv-row[data-rel="a.txt"]');
        await page.waitForTimeout(80);
        await page.locator('.fv-tree').press('Meta+x');
        await page.locator('.fv-tree').press('Control+x');
        await page.waitForTimeout(120);
        const del = await page.evaluate(() => (window as any).__dndCalls.filter((c: any) =>
            c.type === 'folderViewDelete' || c.type === 'folderViewMove' || c.type === 'folderViewMoveBatch'));
        expect(del, 'linkedfd の cmd+x が元を消す / 動かす経路に乗った').toEqual([]);
    });
});

// ═════════════════════════════════════════════════════════════════════
// AC-2: host は webview の「移動」指示を信じない（D2）
// ═════════════════════════════════════════════════════════════════════

test.describe('AC-2 host の境界ガード', () => {
    test('AC-2 handleNotesMessage 経由で move の字面（type / mode / dropEffect）が来ても、境界をまたぐなら元を消さない', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const snap = snapshot([...linkedfdSources(e), ...noteSources(e)]);
            const target = noteMd(e, 'target.md', '# Target\n');
            // provider と同じ配線（platform → 本番の関数）
            const platform: any = {
                folderViewMoveIntoMd: (id: string, rel: string, t: string, s: any) => e.mh.folderViewMoveIntoMd(e.m, id, rel, t, deps, s),
                folderViewMoveFromMd: (id: string, dst: string, p: any, s: any) => e.mh.folderViewMoveFromMd(e.m, id, dst, p, deps, s),
            };
            await e.mh.handleNotesMessage({ type: 'folderViewMoveIntoMd', id: e.id, relPath: 'main.md', targetMdPath: target, mode: 'move', dropEffect: 'move' }, e.m, sender, platform);
            await e.mh.handleNotesMessage({ type: 'folderViewMoveIntoMd', id: e.id, relPath: 'r.pdf', targetMdPath: target, mode: 'move', dropEffect: 'move' }, e.m, sender, platform);
            await e.mh.handleNotesMessage({ type: 'folderViewMoveFromMd', id: e.id, dstDirRelPath: 'sub', href: 'files/att.pdf', sourceMdPath: path.join(e.noteDir, 'doc.md'), isSubpage: false, mode: 'move' }, e.m, sender, platform);
            expectIntact(snap, 'handleNotesMessage 経由');
            expect(calls.trash, 'trash が呼ばれた').toEqual([]);
            expect(removeEchoes(messages), 'リンク除去エコーが出た').toEqual([]);
        } finally { e.cleanup(); }
    });

    test('AC-2 別の linkedfd の md 宛て・note の外の md 宛ても境界をまたぐ扱い（同じ linkedfd の中だけが移動）', async () => {
        const e = setup();
        const { deps, calls } = makeDeps();
        const { sender } = makeSender();
        const otherFd = fs.mkdtempSync(path.join(os.tmpdir(), 'lcopy-fd2-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lcopy-out-'));
        try {
            e.m.registerFolderLink(otherFd);
            const snap = snapshot(linkedfdSources(e));
            const t1 = path.join(otherFd, 'b.md');
            fs.writeFileSync(t1, '# B\n', 'utf8');
            const t2 = path.join(outside, 'c.md');
            fs.writeFileSync(t2, '# C\n', 'utf8');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'main.md', t1, deps as any, sender as any)).toBe(true);
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'r.pdf', t2, deps as any, sender as any)).toBe(true);
            expectIntact(snap, '別 linkedfd / note 外');
            expect(calls.trash).toEqual([]);
            expect(fs.existsSync(path.join(otherFd, 'main.md')), '別 linkedfd に複製が無い').toBe(true);
        } finally {
            e.cleanup();
            fs.rmSync(otherFd, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('AC-2 境界判定の純関数: 同じ側は false / 別の側・dst 不明は true', () => {
        const b = requireWithVscodeStub('../../src/shared/linkedfd-boundary');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lcopy-b-'));
        try {
            const roots = [root];
            expect(b.crossesLinkedfdBoundary(roots, path.join(root, 'a.md'), path.join(root, 'x', 'b.md'))).toBe(false);
            expect(b.crossesLinkedfdBoundary(roots, '/note/a.md', '/note/b.md')).toBe(false);
            expect(b.crossesLinkedfdBoundary(roots, path.join(root, 'a.md'), '/note/b.md')).toBe(true);
            expect(b.crossesLinkedfdBoundary(roots, '/note/a.md', path.join(root, 'b.md'))).toBe(true);
            expect(b.crossesLinkedfdBoundary(roots, path.join(root, 'a.md'), '')).toBe(true);
            // 前方一致の取り違え（/tmp/x と /tmp/x-2）をしない
            expect(b.linkedfdRootOf(roots, root + '-2/a.md')).toBe(null);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});

// ═════════════════════════════════════════════════════════════════════
// AC-3: linkedfd の中・Fractal の中の移動は今までどおり移動
// ═════════════════════════════════════════════════════════════════════

test.describe('AC-3 内側の移動は移動のまま', () => {
    test('AC-3 fv の md → 同じ linkedfd の中の md（sidepanel）: 元は消える（移動）', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            const target = path.join(e.root, 'sub', 't.md');
            fs.writeFileSync(target, '# T\n', 'utf8');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'main.md', target, deps as any, sender as any)).toBe(true);
            expect(fs.existsSync(path.join(e.root, 'sub', 'main.md')), '移動先に無い').toBe(true);
            expect(fs.existsSync(path.join(e.root, 'main.md')), 'linkedfd 内の移動が複製になった').toBe(false);
        } finally { e.cleanup(); }
    });

    test('AC-3 fv のファイル → 同じ linkedfd の中の md: 元は消える（移動）', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            const target = path.join(e.root, 'sub', 't.md');
            fs.writeFileSync(target, '# T\n', 'utf8');
            expect(await e.mh.folderViewMoveIntoMd(e.m, e.id, 'r.pdf', target, deps as any, sender as any)).toBe(true);
            expect(fs.existsSync(path.join(e.root, 'sub', 'files', 'r.pdf')), '移動先に無い').toBe(true);
            expect(fs.existsSync(path.join(e.root, 'r.pdf')), 'linkedfd 内の移動が複製になった').toBe(false);
        } finally { e.cleanup(); }
    });

    test('AC-3 linkedfd の md の 📎 → 同じ fv: リンク除去 + 元は消える（移動）', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender, messages } = makeSender();
        try {
            const ok = await e.mh.folderViewMoveFromMd(e.m, e.id, 'sub',
                { href: 'files/spec.pdf', sourceMdPath: path.join(e.root, 'main.md') }, deps as any, sender as any);
            expect(ok).toBe(true);
            expect(fs.existsSync(path.join(e.root, 'sub', 'spec.pdf')), '移動先に無い').toBe(true);
            expect(fs.existsSync(path.join(e.root, 'files', 'spec.pdf')), 'linkedfd 内の移動が複製になった').toBe(false);
            expect(fs.readFileSync(path.join(e.root, 'main.md'), 'utf8')).not.toContain('files/spec.pdf');
            expect(removeEchoes(messages).length, 'リンク除去エコーが無い').toBe(1);
        } finally { e.cleanup(); }
    });

    test('AC-3 fv 内のフォルダ間（folderViewMove）: 移動のまま', async () => {
        const e = setup();
        const { deps } = makeDeps();
        const { sender } = makeSender();
        try {
            fs.writeFileSync(path.join(e.root, 'lonely.md'), '# Lonely\n', 'utf8');
            expect(await e.mh.folderViewMove(e.m, e.id, 'lonely.md', 'sub', deps as any, sender as any, deps as any)).toBe(true);
            expect(fs.existsSync(path.join(e.root, 'sub', 'lonely.md'))).toBe(true);
            expect(fs.existsSync(path.join(e.root, 'lonely.md')), 'fv 内 D&D が複製になった').toBe(false);
        } finally { e.cleanup(); }
    });

    test('AC-3 Fractal の中（note md → note md / tree → note md / outliner → note md）: 元側の後処理は今までどおり', async () => {
        const e = setup();
        const { sender, messages } = makeSender();
        try {
            const target = noteMd(e, 'target.md', '# Target\n');
            // note md 📎 → note md = リンクの所有の移し替え（元 md からリンクを外す）
            e.mh.attachMdFileLinkToMd(e.m, sender as any, { href: 'files/att.pdf', sourceMdPath: path.join(e.noteDir, 'doc.md') }, target);
            expect(fs.readFileSync(path.join(e.noteDir, 'doc.md'), 'utf8'), 'Fractal 内の所有の移し替えが止まった').not.toContain('files/att.pdf');
            expect(removeEchoes(messages).length).toBe(1);
            // tree file → note md = tree 項目を外す
            const fileId = e.m.registerTreeFile('t.txt', 't.txt', null, 0, Buffer.from('TXT'));
            expect(e.mh.treeFileAttachToMdEditor(e.m, sender as any, fileId, target)).toBe(true);
            expect(e.m.getStructure().items[fileId], 'Fractal 内で tree 項目が残った（過剰適用）').toBeFalsy();
            // outliner file node → note md = node から添付を外す
            const { outPath } = makeOutWithNodes(e);
            e.mh.attachOutNodeFileToMd(e.m, sender as any, { outFileKey: outPath, nodeId: 'nf' }, target);
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            expect(data.nodes.nf, 'Fractal 内で node の添付が外れない（過剰適用）').toBeFalsy();
        } finally { e.cleanup(); }
    });
});

// ═════════════════════════════════════════════════════════════════════
// webview（D3）: fv への drag のカーソルは fv 内の entry 以外 copy
// ═════════════════════════════════════════════════════════════════════

const fileList = [
    { filePath: '/note/doc.md', title: 'Doc', id: 'mdDoc', kind: 'md' },
    { filePath: '', title: 'Docs Link', id: 'flTree', kind: 'folder', broken: false },
];
const structure = {
    version: 1,
    rootIds: ['mdDoc', 'flTree'],
    items: {
        mdDoc: { type: 'file', id: 'mdDoc', title: 'Doc', ext: 'md', filePath: '/note/doc.md' },
        flTree: { type: 'file', id: 'flTree', title: 'Docs Link', ext: 'folder' },
    },
};
const FV_ENTRIES = [
    { name: 'dirA', relPath: 'dirA', isDir: true },
    { name: 'a.txt', relPath: 'a.txt', isDir: false },
];

async function setupWebview(page: Page): Promise<void> {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).__folderViewDispatcher);
    await page.evaluate(({ fileList, structure }) => {
        const w = window as any;
        w.__testApi.initNotesPanel(fileList, null, structure);
        w.__dndCalls = [];
        ['folderViewList', 'folderViewSearch', 'folderViewOpen', 'folderViewMove', 'folderViewMoveBatch', 'folderViewDelete',
         'folderViewMoveIn', 'folderViewMoveToTree', 'folderViewMoveIntoMd', 'folderViewMoveFromMd',
         'sendOutNodesToFolderLinkFromDrop', 'notifyError'].forEach((k) => {
            w.notesHostBridge[k] = (...args: any[]) => { w.__dndCalls.push({ type: k, args }); };
        });
    }, { fileList, structure });
    await page.waitForTimeout(150);
    await page.evaluate((entries) => {
        (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
        window.postMessage({ type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '', entries }, '*');
    }, FV_ENTRIES);
    await page.waitForSelector('.fv-row[data-rel="a.txt"]', { timeout: 5000 });
}

async function makeDragSource(page: Page, mime: string, payload: any): Promise<void> {
    await page.evaluate(({ mime, payload }) => {
        const div = document.createElement('div');
        div.id = 'testDragSrc';
        div.textContent = 'src';
        div.draggable = true;
        div.style.cssText = 'position:fixed; top:4px; right:4px; z-index:9999; background:#fc0; padding:4px;';
        div.addEventListener('dragstart', (ev) => {
            ev.dataTransfer!.setData(mime, JSON.stringify(payload));
            ev.dataTransfer!.effectAllowed = 'copyMove';
        });
        document.body.appendChild(div);
    }, { mime, payload });
}

async function installRecorder(page: Page): Promise<void> {
    await page.evaluate(() => {
        const w = window as any;
        w.__dropEffects = [];
        document.addEventListener('dragover', (ev: any) => {
            if (!ev.dataTransfer) { return; }
            w.__dropEffects.push({ types: Array.from(ev.dataTransfer.types || []), dropEffect: ev.dataTransfer.dropEffect });
        }, false);
    });
}

async function realDragTo(page: Page, srcSel: string, dstSel: string): Promise<void> {
    const src = await page.locator(srcSel).boundingBox();
    const dst = await page.locator(dstSel).boundingBox();
    if (!src || !dst) { throw new Error(`boundingBox 不可: ${srcSel} → ${dstSel}`); }
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2 + 12, src.y + src.height / 2 + 4, { steps: 4 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2, { steps: 10 });
    await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(120);
}

async function lastEffectFor(page: Page, mime: string): Promise<string | null> {
    return page.evaluate((m) => {
        const list = ((window as any).__dropEffects || []).filter((r: any) => r.types.indexOf(m) !== -1);
        return list.length ? list[list.length - 1].dropEffect : null;
    }, mime);
}

test.describe('AC-1 D3 dropEffect（webview）', () => {
    for (const [label, mime, payload] of [
        ['md の 📎', 'application/x-fractal-md-filelink', { href: 'files/a.pdf', sourceMdPath: '/note/doc.md' }],
        ['md の subpage', 'application/x-fractal-md-subpage', { href: 'sub.md', sourceMdPath: '/note/doc.md' }],
        ['outliner の node', 'application/x-fractal-out-node-subtree', { outFileKey: '/note/a.out', nodeId: 'n1' }],
    ] as [string, string, any][]) {
        test(`AC-1 ${label} → fv の dir 行: カーソルは copy`, async ({ page }) => {
            await setupWebview(page);
            await installRecorder(page);
            await makeDragSource(page, mime, payload);
            await realDragTo(page, '#testDragSrc', '.fv-row[data-rel="dirA"]');
            const eff = await lastEffectFor(page, mime);
            expect(eff, 'fv 上の dragover が記録されていない').toBeTruthy();
            expect(eff, `${label} → linkedfd が copy でない（元が消えるように見える）`).toBe('copy');
        });
    }

    test('AC-3 fv 内の entry → fv の dir 行: カーソルは move のまま', async ({ page }) => {
        await setupWebview(page);
        await installRecorder(page);
        await realDragTo(page, '.fv-row[data-rel="a.txt"]', '.fv-row[data-rel="dirA"]');
        expect(await lastEffectFor(page, 'application/x-fractal-folderview-entry')).toBe('move');
    });
});
