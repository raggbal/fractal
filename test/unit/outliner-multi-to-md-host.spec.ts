/**
 * W8（multi-file-dnd-clipboard-matrix）: outliner の複数選択 / bullet → md editor の host 側 batch。
 *
 * 1 回の drop = message 1 本（attachOutNodeAssetsToMd）。中では添付 1 件ずつ、単一経路と同じ正典
 *（postOutPageLinkToMd / postOutNodeFileLinkToMd）で caret 位置への挿入指示を送る。移動 / 複製（linkedfd の境界）は
 * 添付 1 件ごとに host が決める。件数ゲート + 集計通知 1 回は runPlatformBatch。
 *
 * TC-OMD-01 同じ note: 選択順（payload.items の順）に 1 行 1 リンク（subpage は asBlock）、node から添付を外す
 *           （添付が全部外れた子なし node は消える / 子ありは残る）。.out の書き戻し + updateData は 1 回
 * TC-OMD-02 動かせない添付（開いている md 自身の page / 実体の無い file）は飛ばして残りを動かす。集計通知 1 回、
 *           飛ばした node は添付を持ったまま
 * TC-OMD-03 sidepanel で開いた linkedfd の md へ: 境界をまたぐので複製。node も .out も変わらない（payload に move の字面があっても）
 * TC-OMD-04 別 note の md へ: 実体を dest note へ複製し、元 node から添付を外す（単一経路と同じ source orphan 契約）
 * TC-OMD-05 assets が空の item（icon の単一 drag 形）は disk の node から添付を集める / payload の pageId は信じない
 * TC-OMD-06 201 件で確認 → キャンセルなら 0 件処理
 * TC-OMD-07 handleNotesMessage が platform へ渡す / provider が platformBatchDeps で配線 / bridge 両ブロック
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

function mkDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    return dir;
}
function nd(id: string, text: string, extra: any = {}): any {
    return Object.assign({ id, parentId: null, children: [], text, tags: [], isPage: false, pageId: null,
        collapsed: false, checked: null, subtext: '', images: [], filePath: null }, extra);
}

function setup() {
    const mh = req('../../src/shared/notes-message-handler');
    const { NotesFileManager } = req('../../src/shared/notes-file-manager');
    const dir = mkDir('omd-note-');
    const fm = new NotesFileManager(dir); fm.loadStructure();
    const outPath = fm.createFile('Plan');
    // pa = page / f1 = file（子なし）/ pb = page + 子あり / f2 = file / tx = 文字だけ
    fs.writeFileSync(path.join(dir, 'pagea.md'), '# PageA\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'pageb.md'), '# PageB\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'a.pdf'), 'A', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'b.txt'), 'B', 'utf8');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    data.nodes = {
        pa: nd('pa', 'PageA', { isPage: true, pageId: 'pagea' }),
        f1: nd('f1', 'a.pdf', { filePath: 'files/a.pdf' }),
        pb: nd('pb', 'PageB', { isPage: true, pageId: 'pageb', children: ['ch'] }),
        ch: nd('ch', 'child', { parentId: 'pb' }),
        f2: nd('f2', 'b.txt', { filePath: 'files/b.txt' }),
        tx: nd('tx', 'plain'),
    };
    data.rootIds = ['pa', 'f1', 'pb', 'f2', 'tx'];
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    fm.openFile(outPath);   // main pane = この outliner（updateData の宛先）
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
    const readOut = () => JSON.parse(fs.readFileSync(outPath, 'utf8'));
    return { mh, fm, NotesFileManager, dir, outPath, sender, messages, deps, seen, extra, cleanup, readOut };
}
function payloadOf(outPath: string, items: { nodeId: string; assets: any[] }[]): any {
    return { v: 1, outFileKey: outPath, nodeId: items[0].nodeId, assets: items[0].assets, items };
}
const PA = { nodeId: 'pa', assets: [{ kind: 'page', pageId: 'pagea' }] };
const F1 = { nodeId: 'f1', assets: [{ kind: 'file', filePath: 'files/a.pdf' }] };
const PB = { nodeId: 'pb', assets: [{ kind: 'page', pageId: 'pageb' }] };
const F2 = { nodeId: 'f2', assets: [{ kind: 'file', filePath: 'files/b.txt' }] };

test('TC-OMD-01 同じ note: 選択順に 1 行 1 リンク、node から添付を外す（.out の書き戻しは 1 回）', async () => {
    const s = setup();
    try {
        const sp = path.join(s.dir, 'sp.md'); fs.writeFileSync(sp, '# SP\n', 'utf8');
        // 選択順 = f2, pa, pb, f1（payload の items の順がそのまま挿入順になる）
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, payloadOf(s.outPath, [F2, PA, PB, F1]), sp, s.deps);
        expect(r.outcome).toMatchObject({ succeeded: 4, skipped: 0, failed: 0 });
        const ins = s.messages.filter((m) => /^insert/.test(m.type));
        expect(ins.map((m) => [m.type, m.markdownPath])).toEqual([
            ['insertFileLink', 'files/b.txt'], ['insertSubpageLink', 'pagea.md'],
            ['insertSubpageLink', 'pageb.md'], ['insertFileLink', 'files/a.pdf']]);
        expect(ins.every((m) => m.sidePanelFilePath === sp), 'sidepanel 宛てになっていない').toBe(true);
        expect(ins.filter((m) => m.type === 'insertSubpageLink').every((m) => m.asBlock === true), 'subpage が 1 行 1 リンクにならない').toBe(true);
        expect(ins.filter((m) => m.type === 'insertSubpageLink').map((m) => m.title)).toEqual(['PageA', 'PageB']);
        const d = s.readOut();
        expect(d.nodes.pa, '添付が外れた子なし page node が残った').toBeUndefined();
        expect(d.nodes.f1).toBeUndefined();
        expect(d.nodes.f2).toBeUndefined();
        expect(d.nodes.pb, '子ありの node まで消えた').toBeTruthy();
        expect(d.nodes.pb.isPage).toBe(false);
        expect(d.nodes.pb.pageId).toBe(null);
        expect(d.nodes.ch).toBeTruthy();
        expect(d.nodes.tx, '選択外の node が消えた').toBeTruthy();
        expect(d.rootIds).toEqual(['pb', 'tx']);
        expect(s.messages.filter((m) => m.type === 'updateData').length, 'updateData が 1 回でない').toBe(1);
        expect(s.seen.outcome, '全件成功なのに集計通知が出た').toEqual([]);
        expect(fs.existsSync(path.join(s.dir, 'pagea.md')), '同じ note の実体は動かない').toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'a.pdf'))).toBe(true);
    } finally { s.cleanup(); }
});

test('TC-OMD-02 動かせない添付は飛ばして残りを動かす。集計通知 1 回、飛ばした node は添付を持ったまま', async () => {
    const s = setup();
    try {
        fs.rmSync(path.join(s.dir, 'files', 'b.txt'));   // f2 の実体が無い
        const target = path.join(s.dir, 'pagea.md');      // 開いている md = pa の page 自身
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, payloadOf(s.outPath, [PA, F1, F2, PB]), target, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(r.outcome.skipped).toBe(2);
        expect(s.seen.outcome.length, '集計通知が 1 回でない').toBe(1);
        const ins = s.messages.filter((m) => /^insert/.test(m.type));
        expect(ins.map((m) => m.markdownPath), '自分自身へのリンク / 実体の無い file を入れた').toEqual(['files/a.pdf', 'pageb.md']);
        const d = s.readOut();
        expect(d.nodes.pa && d.nodes.pa.isPage, '飛ばした page node の page が外れた').toBe(true);
        expect(d.nodes.f2 && d.nodes.f2.filePath, '飛ばした file node の添付が外れた').toBe('files/b.txt');
        expect(d.nodes.f1).toBeUndefined();
    } finally { s.cleanup(); }
});

test('TC-OMD-03 linkedfd の md へ: 境界をまたぐので複製（node も .out も変わらない。move の字面があっても）', async () => {
    const s = setup();
    const root = mkDir('omd-fd-');
    s.extra.push(root);
    try {
        s.fm.registerFolderLink(root);
        const target = path.join(root, 'main.md'); fs.writeFileSync(target, '# Main\n', 'utf8');
        const before = fs.readFileSync(s.outPath, 'utf8');
        const p = Object.assign(payloadOf(s.outPath, [PA, F1]), { mode: 'move', dropEffect: 'move', isCut: true });
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, p, target, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(fs.readFileSync(s.outPath, 'utf8'), 'linkedfd への転送で .out が変わった（移動になった）').toBe(before);
        expect(s.messages.filter((m) => m.type === 'updateData')).toEqual([]);
        expect(fs.existsSync(path.join(root, 'files', 'a.pdf')), 'linkedfd 側に複製が無い').toBe(true);
        expect(fs.readdirSync(root).filter((n) => /^pagea.*\.md$/i.test(n) || /PageA/i.test(n)).length, 'page md が linkedfd 側に複製されていない').toBeGreaterThan(0);
        expect(fs.existsSync(path.join(s.dir, 'pagea.md'))).toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'a.pdf'))).toBe(true);
    } finally { s.cleanup(); }
});

test('TC-OMD-04 別 note の md へ: dest note へ複製し、元 node から添付を外す', async () => {
    const s = setup();
    const other = mkDir('omd-other-');
    s.extra.push(other);
    try {
        const target = path.join(other, 'dst.md'); fs.writeFileSync(target, '# Dst\n', 'utf8');
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, payloadOf(s.outPath, [F1, PA]), target, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(fs.existsSync(path.join(other, 'files', 'a.pdf')), '📎 の実体が dest note に複製されていない').toBe(true);
        expect(fs.readdirSync(other).filter((n) => /\.md$/.test(n) && n !== 'dst.md').length, 'page md が複製されていない').toBe(1);
        const ins = s.messages.filter((m) => /^insert/.test(m.type));
        expect(ins.every((m) => !String(m.markdownPath).startsWith('..')), '跨ぎ ../ リンクを書いた').toBe(true);
        const d = s.readOut();
        expect(d.nodes.f1).toBeUndefined();
        expect(d.nodes.pa).toBeUndefined();
        expect(fs.existsSync(path.join(s.dir, 'files', 'a.pdf')), '元の実体は残る（source orphan 契約）').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-OMD-05 assets が空の item は disk の node から集める / payload の pageId は信じない', async () => {
    const s = setup();
    try {
        const sp = path.join(s.dir, 'sp.md'); fs.writeFileSync(sp, '# SP\n', 'utf8');
        const p = { v: 1, outFileKey: s.outPath, nodeId: 'f1', assets: [],
            items: [{ nodeId: 'f1', assets: [] }, { nodeId: 'pb', assets: [{ kind: 'page', pageId: '../../evil' }] }] };
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, p, sp, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(s.messages.filter((m) => /^insert/.test(m.type)).map((m) => m.markdownPath)).toEqual(['files/a.pdf', 'pageb.md']);
    } finally { s.cleanup(); }
});

test('TC-OMD-06 201 件で確認 → キャンセルなら 0 件処理', async () => {
    const s = setup();
    try {
        const sp = path.join(s.dir, 'sp.md'); fs.writeFileSync(sp, '# SP\n', 'utf8');
        const d = s.readOut();
        const items: any[] = [];
        for (let i = 0; i < 201; i++) {
            d.nodes['m' + i] = nd('m' + i, 'a.pdf', { filePath: 'files/a.pdf' });
            d.rootIds.push('m' + i);
            items.push({ nodeId: 'm' + i, assets: [{ kind: 'file', filePath: 'files/a.pdf' }] });
        }
        fs.writeFileSync(s.outPath, JSON.stringify(d, null, 2), 'utf8');
        const before = fs.readFileSync(s.outPath, 'utf8');
        const r = await s.mh.attachOutNodeAssetsToMd(s.fm, s.sender, payloadOf(s.outPath, items), sp, s.deps);
        expect(s.seen.confirm).toEqual([201]);
        expect(r.verdict).not.toBe('ok');
        expect(s.messages, 'キャンセルしたのに処理した').toEqual([]);
        expect(fs.readFileSync(s.outPath, 'utf8')).toBe(before);
    } finally { s.cleanup(); }
});

test('TC-OMD-07 handleNotesMessage → platform / provider が platformBatchDeps で配線 / bridge 両ブロック', async () => {
    const s = setup();
    try {
        const got: any[] = [];
        const platform: any = { attachOutNodeAssetsToMd: (...a: any[]) => { got.push(a.slice(0, -1)); } };
        const p = payloadOf('/n/o1.out', [PA, F1]);
        await s.mh.handleNotesMessage({ type: 'attachOutNodeAssetsToMd', payload: p, sidePanelFilePath: '/n/sp.md' }, s.fm, s.sender, platform);
        await s.mh.handleNotesMessage({ type: 'attachOutNodeAssetsToMd', payload: p }, s.fm, s.sender, platform);
        expect(got).toEqual([[p, '/n/sp.md'], [p, null]]);
        const provSrc = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
        expect(/attachOutNodeAssetsToMd: async \([^)]*\) => \{\s*await attachOutNodeAssetsToMd\([^;]*platformBatchDeps/.test(provSrc),
            'provider が attachOutNodeAssetsToMd(…, platformBatchDeps) を呼んでいない').toBe(true);
        const bridgeSrc = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
        expect((bridgeSrc.match(/attachOutNodeAssetsToMd: function/g) || []).length, 'bridge の 2 ブロックに対で無い').toBe(2);
    } finally { s.cleanup(); }
});

test('TC-OMD-08 bridge: outliner の node → md の 3 経路は送る前に outliner の未同期分を flush する（両ブロック）', () => {
    // notes-host-bridge.js を本物のまま vm で実行し、postMessage の直前に Outliner.flushSync が呼ばれるかを見る
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm');
    const src = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
    const log: string[] = [];
    const win: any = {
        addEventListener: () => { /* noop */ },
        __createSidePanelBridgeMethods: () => ({}),
        Outliner: { flushSync: () => { log.push('flush'); } },
    };
    const ctx: any = { window: win, acquireVsCodeApi: () => ({ postMessage: (m: any) => { log.push('post:' + m.type); } }), console };
    vm.runInNewContext(src, ctx);
    for (const block of ['outlinerHostBridge', 'notesMarkdownHostBridge']) {
        for (const name of ['attachOutNodeAssetsToMd', 'attachOutNodeFileToMd', 'importOutPageNodeToMd']) {
            log.length = 0;
            win[block][name]({ outFileKey: '/n/a.out', nodeId: 'n1' }, null);
            expect(log, `${block}.${name} が flush せずに送った（host が 1 操作前の .out を読み、直前の編集を消す）`)
                .toEqual(['flush', 'post:' + name]);
        }
    }
});
