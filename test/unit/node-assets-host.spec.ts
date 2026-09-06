/**
 * TASK-16 — node 添付の host 側着地（`files/` 複製 + `rawInsertTreeFileEntry`）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-NDA-01/03 / §2-5 分岐 B）
 *
 * TC-NDA-13（画像の着地点と登録関数）+ 併持 8 セルの host 側枚数対応。
 *
 * 番人は **入力の添付数 = 出力の tree item 数** の枚数対応で書く（design/tdd.md）。
 * webview 受け手側（bridge に届く payload）は TC-NDA-01..10 が担う。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
/** vscode を stub して src/shared/* を require する（既存 unit spec の慣習）。 */
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

function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => messages.push(m) }, messages };
}

interface Cell { cell: number; page: boolean; file: boolean; images: number }
/** 2³ = 8 セル（design/system.md §2-2 の分岐表）。 */
const CELLS: Cell[] = [
    { cell: 1, page: false, file: false, images: 0 },
    { cell: 2, page: false, file: false, images: 2 },
    { cell: 3, page: false, file: true, images: 0 },
    { cell: 4, page: false, file: true, images: 2 },
    { cell: 5, page: true, file: false, images: 0 },
    { cell: 6, page: true, file: false, images: 2 },
    { cell: 7, page: true, file: true, images: 0 },
    { cell: 8, page: true, file: true, images: 2 },
];

/**
 * フラット note を 1 つ作る（`<note>/work.out` + `images/` + `files/` + page md は note 直下）。
 *
 * flat レイアウトでは page md は **note 直下**（`resolvePagesDir` が note を返す）なので、
 * `registerExistingMdFile`（`<mainFolder>/<id>.md` を要求）が使える = 本番と同じ経路。
 */
function makeNote(c: Cell, opts?: { withChild?: boolean }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nda-host-'));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });

    const node: any = { id: 'n1', text: `cell-${c.cell}`, children: [] };
    const assets: any[] = [];
    if (c.page) {
        fs.writeFileSync(path.join(dir, `page-${c.cell}.md`), `# Page ${c.cell}\n\nbody\n`, 'utf8');
        node.isPage = true; node.pageId = `page-${c.cell}`;
        assets.push({ kind: 'page', pageId: `page-${c.cell}` });
    }
    if (c.file) {
        fs.writeFileSync(path.join(dir, 'files', `spec-${c.cell}.pdf`), `PDF-${c.cell}`, 'utf8');
        node.filePath = `files/spec-${c.cell}.pdf`;
        assets.push({ kind: 'file', filePath: `files/spec-${c.cell}.pdf` });
    }
    if (c.images > 0) {
        node.images = [];
        for (let i = 1; i <= c.images; i++) {
            const rel = `images/pic-${c.cell}-${i}.png`;
            fs.writeFileSync(path.join(dir, rel), `PNG-${c.cell}-${i}`, 'utf8');
            node.images.push(rel);
            assets.push({ kind: 'image', src: rel });
        }
    }
    if (opts?.withChild) {
        node.children = ['n1c'];
    }

    const nodes: any = { n1: node };
    if (opts?.withChild) {
        nodes.n1c = { id: 'n1c', parentId: 'n1', text: 'child', children: [] };
    }
    const outPath = path.join(dir, 'work.out');
    fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['n1'], nodes }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ rootIds: [], items: {} }), 'utf8');

    return { dir, outPath, assets, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/** 添付を転送して、登録後の structure / .out を返す。 */
function runTransfer(c: Cell, opts?: { withChild?: boolean }) {
    const nh = makeNote(c, opts);
    const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const fm = new NotesFileManager(nh.dir);
    fm.openFile(nh.outPath);
    const { sender, messages } = makeSender();
    // ⚠️ NotesFileManager は note 配下の `.out` を自動で tree item 化する（= 転送前でも items が空でない）。
    // 枚数対応は**絶対値ではなく転送前後の差分**で数える。
    const baseItemCount = Object.keys(fm.getStructure().items).length;
    const baseRootCount = fm.getStructure().rootIds.length;

    mh.treeNodeAssetsRegister(fm, sender,
        { v: 1, outFileKey: nh.outPath, nodeId: 'n1', assets: nh.assets }, null, 0);

    const structure = fm.getStructure();
    const outData = JSON.parse(fs.readFileSync(nh.outPath, 'utf8'));
    return { ...nh, fm, structure, outData, messages, baseItemCount, baseRootCount };
}

test.describe('TC-NDA-13 rev2 直付き画像は tree へ移さない（2026-09-04 R22 — 旧「files/ へ複製」は撤回）', () => {
    test('TC-NDA-13 画像だけの node: files/ に複製されず、node.images はそのまま、node も残る', () => {
        const r = runTransfer({ cell: 2, page: false, file: false, images: 2 });
        try {
            expect(fs.readdirSync(path.join(r.dir, 'files')), 'files/ に画像が複製された（旧 §2-5）').toEqual([]);
            for (const rel of ['images/pic-2-1.png', 'images/pic-2-2.png']) {
                expect(fs.existsSync(path.join(r.dir, rel)), `${rel} が消えた`).toBe(true);
            }
            expect(Object.keys(r.structure.items).length - r.baseItemCount, 'tree item が作られた').toBe(0);
            expect(r.outData.nodes.n1, '画像を持つ node が消えた').toBeTruthy();
            expect(r.outData.nodes.n1.images, 'node.images が外された').toEqual(['images/pic-2-1.png', 'images/pic-2-2.png']);
        } finally { r.cleanup(); }
    });

    test('TC-NDA-13b 旧 payload（v1 の image asset）が届いても無視する（files/ は不変）', () => {
        const nh = makeNote({ cell: 2, page: false, file: false, images: 2 });
        try {
            fs.writeFileSync(path.join(nh.dir, 'files', 'pic-2-1.png'), 'PRE-EXISTING', 'utf8');
            const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
            const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
            const fm = new NotesFileManager(nh.dir);
            fm.openFile(nh.outPath);
            mh.treeNodeAssetsRegister(fm, makeSender().sender,
                { v: 1, outFileKey: nh.outPath, nodeId: 'n1', assets: nh.assets }, null, 0);
            expect(fs.readdirSync(path.join(nh.dir, 'files')), 'files/ が変わった').toEqual(['pic-2-1.png']);
            expect(fs.readFileSync(path.join(nh.dir, 'files', 'pic-2-1.png'), 'utf8')).toBe('PRE-EXISTING');
        } finally { nh.cleanup(); }
    });
});

test.describe('併持 8 セルの host 側枚数対応（FR-NDA-01 / §2-2）', () => {
    for (const c of CELLS) {
        const expectedMd = c.page ? 1 : 0;
        const expectedFile = (c.file ? 1 : 0);   // 画像は対象外（R22）
        test(`cell ${c.cell} (page=${c.page} file=${c.file} img=${c.images}) → md ${expectedMd} + file ${expectedFile}`, () => {
            if (expectedMd + expectedFile === 0) {
                // cell 1: 添付ゼロ → payload 自体が積まれない（host も何もしない）
                const r = runTransfer(c);
                try {
                    expect(Object.keys(r.structure.items).length - r.baseItemCount,
                        '添付ゼロで item が作られた').toBe(0);
                    expect(r.outData.nodes.n1, '添付ゼロで node が消えた').toBeTruthy();
                } finally { r.cleanup(); }
                return;
            }
            const r = runTransfer(c);
            try {
                const items = Object.values(r.structure.items as any) as any[];
                const md = items.filter((it) => it.type === 'file' && it.ext === 'md').length;
                const file = items.filter((it) => it.type === 'file' && it.ext === 'file').length;
                expect(md, `cell ${c.cell}: md item 期待 ${expectedMd} / 実際 ${md} — ${JSON.stringify(items)}`).toBe(expectedMd);
                expect(file, `cell ${c.cell}: file item 期待 ${expectedFile} / 実際 ${file} — ${JSON.stringify(items)}`).toBe(expectedFile);
                // 全添付が外れた子なし node は削除される
                if (c.images > 0) {
                    // 画像は node に残る → node は消えない（R22）
                    expect(r.outData.nodes.n1, `cell ${c.cell}: 画像を持つ node が消えた`).toBeTruthy();
                    expect((r.outData.nodes.n1.images || []).length, `cell ${c.cell}: 画像が外された`).toBe(c.images);
                } else {
                    expect(r.outData.nodes.n1, `cell ${c.cell}: 添付が全部外れた子なし node が残っている`).toBeUndefined();
                }
                // ルート順序も追随している
                expect(r.structure.rootIds.length - r.baseRootCount,
                    `cell ${c.cell}: rootIds の増分`).toBe(expectedMd + expectedFile);
            } finally { r.cleanup(); }
        });
    }

    test('子を持つ node は温存され、添付だけが外れる（detachOutNodeFileOwnership と同一規約）', () => {
        const r = runTransfer({ cell: 8, page: true, file: true, images: 2 }, { withChild: true });
        try {
            const n1 = r.outData.nodes.n1;
            expect(n1, '子を持つ node が削除された（子の喪失）').toBeTruthy();
            expect(n1.filePath, 'file 添付が外れていない').toBeFalsy();
            expect(!!(n1.isPage && n1.pageId), 'page 添付が外れていない').toBe(false);
            expect((n1.images || []).length, '画像は転送対象外なので node に残る（R22）').toBe(2);
            expect(r.outData.nodes.n1c, '子 node が消えた').toBeTruthy();
        } finally { r.cleanup(); }
    });

    test('page 添付の元 md 実体は削除しない（source orphan 契約 = 既存 notesImportOutPageNodeAsMd と同型）', () => {
        const r = runTransfer({ cell: 5, page: true, file: false, images: 0 });
        try {
            expect(fs.existsSync(path.join(r.dir, 'page-5.md')), 'page md の実体が消えた').toBe(true);
            // flat note なので既存実体をそのまま md item に（複製されない）
            const mdItems = (Object.values(r.structure.items as any) as any[])
                .filter((it) => it.type === 'file' && it.ext === 'md');
            expect(mdItems.length).toBe(1);
            expect(mdItems[0].id, 'flat note で pageId 以外の id が振られた（不要な複製が起きている）').toBe('page-5');
        } finally { r.cleanup(); }
    });
});

test.describe('TC-NDA-15 items（複数選択）は全 node を順に転送し、.out 保存 / updateData は 1 回（2026-09-04）', () => {
    test('2 node（file + page）→ tree に 2 件・両 node の添付が外れる・updateData 1 回', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nda-multi-'));
        try {
            fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'files', 'a.pdf'), 'PDF-A', 'utf8');
            fs.writeFileSync(path.join(dir, 'page-b.md'), '# Page B\n\nbody\n', 'utf8');
            const nodes: any = {
                na: { id: 'na', text: 'A', children: [], filePath: 'files/a.pdf' },
                nb: { id: 'nb', text: 'B', children: [], isPage: true, pageId: 'page-b' },
                nc: { id: 'nc', text: 'C (no assets)', children: [] },
            };
            const outPath = path.join(dir, 'work.out');
            fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['na', 'nb', 'nc'], nodes }, null, 2), 'utf8');
            fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ rootIds: [], items: {} }), 'utf8');

            const mh = requireWithVscodeStub('../../src/shared/notes-message-handler');
            const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
            const fm = new NotesFileManager(dir);
            fm.openFile(outPath);
            const { sender, messages } = makeSender();
            const before = Object.keys(fm.getStructure().items).length;

            mh.treeNodeAssetsRegister(fm, sender, {
                v: 1, outFileKey: outPath, nodeId: 'na', assets: [{ kind: 'file', filePath: 'files/a.pdf' }],
                items: [
                    { nodeId: 'na', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] },
                    { nodeId: 'nb', assets: [{ kind: 'page', pageId: 'page-b' }] },
                ],
            }, null, 0);

            const st = fm.getStructure();
            expect(Object.keys(st.items).length - before, 'tree に 2 件登録されていない（旧: drag 元 1 node のみ）').toBe(2);
            // 表示順（items 順）で root 先頭に並ぶ: file A, page B
            const titles = st.rootIds.slice(0, 2).map((id: string) => (st.items[id] as any).title);
            expect(titles).toEqual(['A', 'Page B']);
            const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            // 添付を失った子なし node は削除（detachOutNodeAssetsOwnership 規約）
            expect(out.nodes.na, 'na が残っている').toBeUndefined();
            expect(out.nodes.nb, 'nb が残っている').toBeUndefined();
            expect(out.nodes.nc.text).toBe('C (no assets)');
            expect(messages.filter((m: any) => m.type === 'updateData').length, 'updateData が N 回').toBe(1);
        } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    });

    test('regression: items なし（旧 payload）は従来どおり 1 node', () => {
        const r = runTransfer({ cell: 3, page: false, file: true, images: 0 });
        try {
            expect(Object.keys(r.structure.items).length - r.baseItemCount).toBe(1);
            expect(r.outData.nodes.n1).toBeUndefined();
        } finally { r.cleanup(); }
    });
});
