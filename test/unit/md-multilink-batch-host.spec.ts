/**
 * W3（multi-file-dnd-clipboard-matrix）: md の 📎 / subpage リンクの複数ドラッグの host 側 batch。
 *
 * 1 回の drop = message 1 本。中では**既存の単一経路を 1 件ずつ**呼ぶ（移動 / 複製・cross-note・linkedfd の境界は
 * 1 件ごとに host が決める）。件数ゲート + 集計通知 1 回は runPlatformBatch / runBatchTransfer。
 *
 * TC-MLB-01 → md editor（同じ note）: 選択順に挿入指示（subpage は asBlock = 1 行 1 リンク）、元リンクを外す（移動）。間の文字は残る
 * TC-MLB-02 動かせない項目（note 外の href / 自分自身）は飛ばして残りを動かし、集計通知は 1 回。飛ばした分のリンクは残る
 * TC-MLB-03 → md editor（別 note）: 実体を複製して元リンクを外す（他 note = 複製 + 元リンク除去）
 * TC-MLB-04 linkedfd の中の md → note の md: 境界をまたぐので複製。webview の flag に関係なく元リンク・元実体とも残る
 * TC-MLB-05 → outliner の drop 位置: dropFilesResult 1 本（選択順）。.out は直書きしない
 * TC-MLB-05b linkedfd の中の md → outliner: 複製（元リンクを残す）
 * TC-MLB-06 → ツリーの .out 行: root 先頭に選択順で並ぶ（後ろから処理）
 * TC-MLB-07 → ツリーの md 行: 末尾へ 1 行ずつ選択順に追記
 * TC-MLB-08 → ツリー（registerMdLinksToTreeBatch）: 挿入位置を進めて選択順に登録、元リンクを外す
 * TC-MLB-09 note の md → linkedfd（folderViewMoveFromMdBatch）: 全件複製・元は残る・fv 一覧の再送は 1 回
 * TC-MLB-10 201 件で確認 → キャンセルなら 0 件処理
 * TC-MLB-11 handleNotesMessage が 6 種の batch message を platform へ渡す / provider が batch を配線している
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purge(): void { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } }
function req(m: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module'); const o = Module._load; purge();
    Module._load = function (r: string) {
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } }, Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try { return require(m); } finally { Module._load = o; purge(); }
}

function mkNote(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    return dir;
}
const SRC_MD = '# Src\n\n[[Alpha]](alpha.md) and [📎 x.pdf](files/x.pdf) then [[Beta]](beta.md) end\n';
function seedSource(dir: string): string {
    fs.writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'beta.md'), '# Beta\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'x.pdf'), 'PDF', 'utf8');
    const src = path.join(dir, 'src.md');
    fs.writeFileSync(src, SRC_MD, 'utf8');
    return src;
}
const ITEMS = [
    { kind: 'subpage', href: 'alpha.md', title: 'Alpha' },
    { kind: 'file', href: 'files/x.pdf' },
    { kind: 'subpage', href: 'beta.md', title: 'Beta' },
];

function setup() {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const dir = mkNote('mlb-note-');
    const fm = new NotesFileManager(dir); fm.loadStructure();
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    const seen: { confirm: number[]; outcome: any[] } = { confirm: [], outcome: [] };
    const deps = {
        confirmLarge: (n: number) => { seen.confirm.push(n); return false; },
        notifyLimitExceeded: () => { /* noop */ },
        notifyOutcome: (o: any) => { seen.outcome.push(o); },
    };
    const extra: string[] = [];
    const cleanup = () => { for (const d of [dir, ...extra]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } };
    return { mh, fm, NotesFileManager, dir, sender, messages, deps, seen, extra, cleanup };
}

test('TC-MLB-01 → md editor（同じ note）: 選択順に挿入、subpage は asBlock、元リンクだけ外れて文字は残る', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        const dst = path.join(s.dir, 'dst.md'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(dst);
        const r = await s.mh.attachMdLinksToMdBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, null, s.deps);
        expect(r.outcome).toMatchObject({ succeeded: 3, skipped: 0, failed: 0 });
        const ins = s.messages.filter((m) => /^insert/.test(m.type));
        expect(ins.map((m) => [m.type, m.markdownPath])).toEqual([
            ['insertSubpageLink', 'alpha.md'], ['insertFileLink', 'files/x.pdf'], ['insertSubpageLink', 'beta.md']]);
        expect(ins.filter((m) => m.type === 'insertSubpageLink').every((m) => m.asBlock === true), 'subpage が 1 行 1 リンクにならない').toBe(true);
        const left = fs.readFileSync(src, 'utf8');
        expect(left, '元リンクが残った（移動になっていない）').not.toMatch(/alpha\.md|x\.pdf|beta\.md/);
        expect(left, '間の文字まで消えた').toContain(' and ');
        expect(left).toContain(' then ');
        expect(s.seen.outcome, '全件成功なのに集計通知が出た').toEqual([]);
        expect(fs.existsSync(path.join(s.dir, 'alpha.md')), '同じ note の実体は動かない').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-MLB-02 動かせない項目は飛ばして残りを動かす。集計通知 1 回、飛ばしたリンクは元に残る', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        fs.writeFileSync(src, SRC_MD + '[[Out]](../outside.md) [[Dst]](dst.md)\n', 'utf8');
        const dst = path.join(s.dir, 'dst.md'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(dst);
        const items = [ITEMS[0], { kind: 'subpage', href: '../outside.md', title: 'Out' }, { kind: 'subpage', href: 'dst.md', title: 'Dst' }, ITEMS[1]];
        const r = await s.mh.attachMdLinksToMdBatch(s.fm, s.sender, { sourceMdPath: src, items }, null, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(r.outcome.skipped).toBe(2);
        expect(s.seen.outcome.length, '集計通知が 1 回でない').toBe(1);
        const left = fs.readFileSync(src, 'utf8');
        expect(left).toContain('(../outside.md)');
        expect(left, '自分自身へのリンクを外した').toContain('(dst.md)');
        expect(left).not.toContain('(alpha.md)');
        expect(left).not.toContain('(files/x.pdf)');
    } finally { s.cleanup(); }
});

test('TC-MLB-03 → md editor（別 note）: 実体を複製して元リンクを外す', async () => {
    const s = setup();
    const other = mkNote('mlb-other-');
    s.extra.push(other);
    try {
        const src = seedSource(other);
        const dst = path.join(s.dir, 'dst.md'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(dst);
        const r = await s.mh.attachMdLinksToMdBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, null, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.existsSync(path.join(s.dir, 'files', 'x.pdf')), '📎 の実体が dest note に複製されていない').toBe(true);
        expect(fs.existsSync(path.join(other, 'files', 'x.pdf')), '元の実体は残る').toBe(true);
        expect(fs.readdirSync(s.dir).filter((n) => /^alpha.*\.md$/.test(n)).length, 'subpage md が複製されていない').toBe(1);
        expect(fs.readFileSync(src, 'utf8')).not.toMatch(/alpha\.md|x\.pdf|beta\.md/);
    } finally { s.cleanup(); }
});

test('TC-MLB-04 linkedfd の中の md → note の md: 複製（元リンク・元実体とも残る）', async () => {
    const s = setup();
    const root = mkNote('mlb-fd-');
    s.extra.push(root);
    try {
        s.fm.registerFolderLink(root);
        const src = seedSource(root);
        const dst = path.join(s.dir, 'dst.md'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(dst);
        // webview が move を言ってきても host は境界で決める（payload に余計な flag を混ぜる）
        const r = await s.mh.attachMdLinksToMdBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS, mode: 'move', dropEffect: 'move' }, null, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.readFileSync(src, 'utf8'), 'linkedfd の md からリンクが外れた（移動になった）').toBe(SRC_MD);
        expect(s.messages.filter((m) => /^remove/.test(m.type)), '除去エコーが出た').toEqual([]);
        expect(fs.existsSync(path.join(root, 'files', 'x.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'alpha.md'))).toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'x.pdf')), 'note 側に複製が無い').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-MLB-05 → outliner: dropFilesResult 1 本に選択順でまとまり、.out は直書きしない', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        const outPath = path.join(s.dir, 'w.out');
        const outJson = JSON.stringify({ version: 1, rootIds: ['na'], nodes: { na: { id: 'na', text: 'A', children: [] } } });
        fs.writeFileSync(outPath, outJson, 'utf8');
        s.fm.openFile(outPath);
        const r = await s.mh.importMdLinksIntoOutBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, path.basename(outPath, '.out'), 'na', 'after', s.deps);
        expect(r.outcome.succeeded).toBe(3);
        const dfr = s.messages.filter((m) => m.type === 'dropFilesResult');
        expect(dfr.length, 'dropFilesResult が 1 本でない（N 本だと after が逆順になる）').toBe(1);
        expect(dfr[0].targetNodeId).toBe('na');
        expect(dfr[0].position).toBe('after');
        expect(dfr[0].results.map((x: any) => [x.kind, x.pageId || x.filePath])).toEqual([['md', 'alpha'], ['file', 'files/x.pdf'], ['md', 'beta']]);
        expect(s.messages.filter((m) => m.type === 'updateData'), '.out を直書きして updateData を出した').toEqual([]);
        expect(fs.readFileSync(outPath, 'utf8')).toBe(outJson);
        expect(fs.readFileSync(src, 'utf8')).not.toMatch(/alpha\.md|x\.pdf|beta\.md/);
    } finally { s.cleanup(); }
});

test('TC-MLB-05b linkedfd の中の md → outliner: 複製（元リンクは残る。subpage も 📎 も）', async () => {
    const s = setup();
    const root = mkNote('mlb-fd3-');
    s.extra.push(root);
    try {
        s.fm.registerFolderLink(root);
        const src = seedSource(root);
        const outPath = path.join(s.dir, 'w.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
        s.fm.openFile(outPath);
        const r = await s.mh.importMdLinksIntoOutBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, path.basename(outPath, '.out'), null, null, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.readFileSync(src, 'utf8'), 'linkedfd の md からリンクが外れた').toBe(SRC_MD);
        expect(s.messages.filter((m) => /^remove/.test(m.type))).toEqual([]);
        const dfr = s.messages.filter((m) => m.type === 'dropFilesResult');
        expect(dfr.length).toBe(1);
        expect(dfr[0].results.length).toBe(3);
        expect(fs.existsSync(path.join(root, 'alpha.md')), '元の subpage md が消えた').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-MLB-06 → ツリーの .out 行: root 先頭に選択順で並ぶ', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        const outPath = path.join(s.dir, 'w.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: ['na'], nodes: { na: { id: 'na', text: 'A', children: [] } } }), 'utf8');
        const r = await s.mh.importMdLinksIntoOutItemBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, outPath, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const heads = out.rootIds.slice(0, 3).map((id: string) => out.nodes[id].pageId || out.nodes[id].filePath);
        expect(heads, '選択順でない').toEqual(['alpha', 'files/x.pdf', 'beta']);
        expect(out.rootIds[3]).toBe('na');
    } finally { s.cleanup(); }
});

test('TC-MLB-07 → ツリーの md 行: 末尾へ 1 行ずつ選択順に追記', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        const dst = s.fm.createMarkdownFile('Dst'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        const r = await s.mh.linkMdLinksIntoMdItemBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, path.basename(dst, '.md'), s.deps);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.readFileSync(dst, 'utf8')).toBe('# Dst\n[[Alpha]](alpha.md)\n[📎 x.pdf](files/x.pdf)\n[[Beta]](beta.md)\n');
        expect(fs.readFileSync(src, 'utf8')).not.toMatch(/alpha\.md|x\.pdf|beta\.md/);
    } finally { s.cleanup(); }
});

test('TC-MLB-08 → ツリー: 挿入位置を進めて選択順に登録し、元リンクを外す', async () => {
    const s = setup();
    try {
        const prov = req('../../src/notesEditorProvider');
        const src = seedSource(s.dir);
        const keep = s.fm.createMarkdownFile('Keep');
        const keepId = path.basename(keep, '.md');
        const r = await prov.registerMdLinksToTreeBatch(s.fm, s.sender, { sourceMdPath: src, items: ITEMS }, null, 0, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        const st = s.fm.getStructure();
        const order = st.rootIds.map((id: string) => {
            const it = st.items[id];
            return it.ext === 'md' ? id : (it.filename || it.title);
        });
        expect(order.slice(0, 3), `選択順でない: ${JSON.stringify(order)}`).toEqual(['alpha', 'x.pdf', 'beta']);
        expect(order[3]).toBe(keepId);
        expect(fs.readFileSync(src, 'utf8')).not.toMatch(/alpha\.md|x\.pdf|beta\.md/);
    } finally { s.cleanup(); }
});

test('TC-MLB-09 note の md → linkedfd: 全件複製・元は残る・fv 一覧の再送は 1 回', async () => {
    const s = setup();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-fd2-'));
    s.extra.push(root);
    try {
        const id = s.fm.registerFolderLink(root);
        const src = seedSource(s.dir);
        const trash: string[] = [];
        const errors: string[] = [];
        const fvDeps = Object.assign({}, s.deps, {
            confirmLarge: () => true,
            showErrorMessage: (m: string) => { errors.push(m); },
            t: () => undefined,
            trashDelete: async (abs: string) => { trash.push(abs); },
            toDisplayUri: (abs: string) => abs,
        });
        const r = await s.mh.folderViewMoveFromMdBatch(s.fm, id, '', { sourceMdPath: src, items: ITEMS }, fvDeps, s.sender);
        expect(r.outcome.succeeded).toBe(3);
        expect(trash, 'note 側の実体を trash した').toEqual([]);
        expect(fs.readFileSync(src, 'utf8'), 'note の md からリンクが外れた').toBe(SRC_MD);
        expect(fs.existsSync(path.join(root, 'x.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'alpha.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'beta.md'))).toBe(true);
        expect(s.messages.filter((m) => m.type === 'folderViewListResult').length, '一覧の再送が 1 回でない').toBe(1);
        expect(errors).toEqual([]);
    } finally { s.cleanup(); }
});

test('TC-MLB-10 201 件で確認 → キャンセルなら 0 件処理', async () => {
    const s = setup();
    try {
        const src = seedSource(s.dir);
        const dst = path.join(s.dir, 'dst.md'); fs.writeFileSync(dst, '# Dst\n', 'utf8');
        s.fm.openFile(dst);
        const many = Array.from({ length: 201 }, () => ITEMS[1]);
        const r = await s.mh.attachMdLinksToMdBatch(s.fm, s.sender, { sourceMdPath: src, items: many }, null, s.deps);
        expect(s.seen.confirm).toEqual([201]);
        expect(r.verdict).not.toBe('ok');
        expect(r.outcome.succeeded).toBe(0);
        expect(s.messages, 'キャンセルしたのに処理した').toEqual([]);
        expect(fs.readFileSync(src, 'utf8')).toBe(SRC_MD);
    } finally { s.cleanup(); }
});

test('TC-MLB-11 handleNotesMessage が batch message を platform へ渡す / provider が配線している', async () => {
    const s = setup();
    try {
        const got: any[] = [];
        const platform: any = {};
        for (const k of ['attachMdLinksToMdBatch', 'importMdLinksIntoOutBatch', 'notesRegisterFromMdLinksBatch',
            'linkMdLinksIntoMdItemBatch', 'importMdLinksIntoOutItemBatch', 'folderViewMoveFromMdBatch']) {
            platform[k] = (...a: any[]) => { got.push([k, ...a.slice(0, -1)]); };
        }
        const p = { sourceMdPath: '/n/s.md', items: ITEMS };
        const send = (m: any) => s.mh.handleNotesMessage(m, s.fm, s.sender, platform);
        await send({ type: 'attachMdLinksToMdBatch', payload: p, sidePanelFilePath: '/n/sp.md' });
        await send({ type: 'importMdLinksIntoOutBatch', payload: p, outFileId: 'o1', targetNodeId: 'na', position: 'after' });
        await send({ type: 'notesRegisterFromMdLinksBatch', payload: p, parentId: 'dirA', index: 2 });
        await send({ type: 'linkMdLinksIntoMdItemBatch', payload: p, targetMdId: 'm2' });
        await send({ type: 'importMdLinksIntoOutItemBatch', payload: p, targetOutId: 'o2' });
        await send({ type: 'folderViewMoveFromMdBatch', id: 'fl1', dstDirRelPath: 'dirA', payload: p });
        expect(got).toEqual([
            ['attachMdLinksToMdBatch', p, '/n/sp.md'],
            ['importMdLinksIntoOutBatch', p, 'o1', 'na', 'after'],
            ['notesRegisterFromMdLinksBatch', p, 'dirA', 2],
            ['linkMdLinksIntoMdItemBatch', p, 'm2'],
            ['importMdLinksIntoOutItemBatch', p, 'o2'],
            ['folderViewMoveFromMdBatch', 'fl1', 'dirA', p],
        ]);
        // provider は 6 本とも batch 関数（= runPlatformBatch / runBatchTransfer + platformBatchDeps）へ渡す
        const provSrc = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
        for (const [k, fn] of [['attachMdLinksToMdBatch', 'attachMdLinksToMdBatch'], ['importMdLinksIntoOutBatch', 'importMdLinksIntoOutBatch'],
            ['notesRegisterFromMdLinksBatch', 'registerMdLinksToTreeBatch'], ['linkMdLinksIntoMdItemBatch', 'linkMdLinksIntoMdItemBatch'],
            ['importMdLinksIntoOutItemBatch', 'importMdLinksIntoOutItemBatch'], ['folderViewMoveFromMdBatch', 'folderViewMoveFromMdBatch']]) {
            const re = new RegExp(`${k}: async \\([^)]*\\) => \\{\\s*await ${fn}\\([^;]*platformBatchDeps`);
            expect(re.test(provSrc), `provider の ${k} が ${fn}(…, platformBatchDeps) を呼んでいない`).toBe(true);
        }
        // notes-host-bridge.js: md editor 宛ては 2 ブロック（outlinerHostBridge / notesMarkdownHostBridge）に対で
        const bridgeSrc = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
        expect((bridgeSrc.match(/attachMdLinksToMdBatch: function/g) || []).length).toBe(2);
    } finally { s.cleanup(); }
});
