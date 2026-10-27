/**
 * mcp-full-ops（spec 20261027-1700-mcp-full-ops）: MCP で Fractal を安全に操作できる（AC-1〜AC-5）。
 *
 * bundle（mcp/dist/server.mjs = npm run compile / node mcp/build.mjs）を子プロセスで起動し、
 * 改行区切りの JSON-RPC で実際に話す（クライアントと同じ経路）。fixture の note は tmp に都度作る。
 * 削除は FRACTAL_TRASH_DIR（tmp）へ退避させ、ユーザーのゴミ箱を汚さない。
 *
 * - AC-1: 監査のバグ B-1〜B-10 を 1 つずつ再現して、もう起きないことを確かめる
 * - AC-2: 書き込みのたびに fractal_doctor と UI の Cleanup（cleanup-core.scanSingleNoteCore）が一致して「孤児・壊れた参照 0」
 * - AC-3: 拡張機能が呼ぶ共有関数と MCP で同じ操作 → ファイルが id・時刻以外で一致
 * - AC-4: resolve / get / 書き込み系の JSON
 * - AC-5: expectedHash の CONFLICT / tmp + rename / Notes フォルダの外は拒否
 */
import { test, expect } from '@playwright/test';
import { spawn, ChildProcessWithoutNullStreams, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSingleNoteCore } from '../../src/shared/cleanup-core';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import {
    importMdItemIntoOutCore, importOutPageNodeAsMdCore, moveOutNodesIntoOtherOutCore, duplicateTreeItemEntity, createPageMdFile,
} from '../../src/shared/notes-ops-core';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkParser = require('../../src/shared/markdown-link-parser.js');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'agent-capability', 'mcp', 'dist', 'server.mjs');

let tmpRoot: string;
let trashDir: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-full-ops-'));
    trashDir = path.join(tmpRoot, '_trash');
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── fixture ─────────────────────────────────────────

type N = Record<string, unknown>;
const node = (id: string, text: string, extra: N = {}): N => ({
    id, parentId: null, children: [], text, tags: [], isPage: false, pageId: null,
    collapsed: false, checked: null, subtext: '', images: [], filePath: null, ...extra,
});

function writeOut(dir: string, id: string, title: string, nodes: N[], extra: N = {}): string {
    const map: Record<string, N> = {};
    for (const n of nodes) { map[n.id as string] = n; }
    const rootIds = nodes.filter((n) => !n.parentId).map((n) => n.id);
    const p = path.join(dir, `${id}.out`);
    fs.writeFileSync(p, JSON.stringify({ version: 1, title, pageDir: '.', imageDir: './images', fileDir: './files', rootIds, nodes: map, ...extra }, null, 2));
    return p;
}

function writeStructure(dir: string, items: N[], extra: N = {}) {
    const map: Record<string, N> = {};
    for (const it of items) { map[it.id as string] = it; }
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: items.map((i) => i.id), items: map, ...extra }, null, 2));
}

/** 基本の note: main.out（りんご > 子 / タスク #work）+ other.out + md item（doc.md）+ page node（pg1） */
function mkNote(name: string, noteTitle = name): { dir: string; out: string; other: string; md: string; pageMd: string } {
    const dir = fs.mkdtempSync(path.join(tmpRoot, name + '-'));
    const out = writeOut(dir, 'main', 'Main', [
        node('nA', 'りんご', { children: ['nA1'] }),
        node('nA1', '子ノード', { parentId: 'nA' }),
        node('nC', 'タスク #work', { tags: ['#work'], checked: false }),
        node('nP', 'ページ', { isPage: true, pageId: 'pg1' }),
    ]);
    const other = writeOut(dir, 'other', 'Other', [node('nO', '別の .out のノード')]);
    fs.writeFileSync(path.join(dir, 'pg1.md'), '# ページ\n\n本文\n');
    fs.writeFileSync(path.join(dir, 'doc.md'), '# ドキュメント\n\n## 背景\n\n背景の本文\n\n## 結論\n\n結論の本文\n');
    writeStructure(dir, [
        { type: 'file', id: 'main', title: 'Main' },
        { type: 'file', id: 'other', title: 'Other' },
        { type: 'file', id: 'doc', title: 'ドキュメント', ext: 'md' },
    ], { noteTitle });
    return { dir, out, other, md: path.join(dir, 'doc.md'), pageMd: path.join(dir, 'pg1.md') };
}

function srcFile(name: string, content: string | Buffer = 'X'): string {
    const d = path.join(tmpRoot, '_src');
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, name);
    fs.writeFileSync(p, content);
    return p;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ─── client ──────────────────────────────────────────

class Client {
    private proc: ChildProcessWithoutNullStreams;
    private buf = '';
    private nextId = 1;
    private waiting = new Map<number, (msg: any) => void>();
    constructor(env: NodeJS.ProcessEnv = {}) {
        this.proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FRACTAL_TRASH_DIR: trashDir, ...env } });
        this.proc.stdout.setEncoding('utf-8');
        this.proc.stdout.on('data', (chunk: string) => {
            this.buf += chunk;
            let nl: number;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl);
                this.buf = this.buf.slice(nl + 1);
                const msg = JSON.parse(line);
                const cb = this.waiting.get(msg.id);
                if (cb) { this.waiting.delete(msg.id); cb(msg); }
            }
        });
    }
    request(method: string, params?: object): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.waiting.set(id, resolve);
            this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
    }
    async init() {
        await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
        this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    }
    /** tools/call → { isError, json（JSON なら）, text } */
    async call(name: string, args: object = {}): Promise<{ isError: boolean; json: any; text: string }> {
        const r = await this.request('tools/call', { name, arguments: args });
        if (r.error) { return { isError: true, json: null, text: String(r.error.message) }; }
        const text = (r.result.content || []).map((c: any) => c.text).join('\n');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* text */ }
        return { isError: !!r.result.isError, json, text };
    }
    /** 成功を期待する呼び出し（失敗なら中身を出して落とす） */
    async ok(name: string, args: object = {}): Promise<any> {
        const r = await this.call(name, args);
        expect(r.isError, `${name} ${JSON.stringify(args)} → ${r.text}`).toBe(false);
        return r.json;
    }
    close() { this.proc.stdin.end(); this.proc.kill(); }
}

/** doctor（MCP）と UI の Cleanup（cleanup-core）が両方「孤児・壊れた参照 0」で一致する */
async function expectClean(c: Client, dir: string, label: string) {
    const doc = await c.ok('fractal_doctor', { noteDir: dir });
    const bad = doc.findings.filter((f: any) => f.level !== 'INFO' || f.check === 'orphans');
    expect(bad, `${label}: doctor findings ${JSON.stringify(doc.findings, null, 1)}`).toEqual([]);
    const ui = await scanSingleNoteCore(dir);
    expect(ui.map((x) => x.relPath), `${label}: cleanup-core orphans`).toEqual([]);
    expect(doc.cleanup.orphans.map((x: any) => x.relPath)).toEqual(ui.map((x) => x.relPath));
}

let c: Client;
test.beforeEach(async () => {
    expect(fs.existsSync(SERVER), 'mcp/dist/server.mjs が無い（npm run compile か node mcp/build.mjs）').toBe(true);
    c = new Client();
    await c.init();
});
test.afterEach(() => c.close());

// ═══════════════════════════════════════════════════════════════════════════
// AC-1: 監査のバグ B-1〜B-10
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC-1 監査のバグが再現しない', () => {
    test('AC-1 B-1 page ノードに添付を append してもページ（isPage / pageId / page md）は消えない', async () => {
        const f = mkNote('b1');
        const r = await c.call('fractal_attach', { note: f.out, files: [srcFile('spec.pdf', 'PDF')], target: 'nP', append: true });
        expect(r.isError).toBe(true);
        expect(r.json.error.code).toBe('INVALID');
        const data = readJson(f.out);
        expect(data.nodes.nP.isPage).toBe(true);
        expect(data.nodes.nP.pageId).toBe('pg1');
        expect(data.nodes.nP.filePath).toBeNull();
        expect(fs.existsSync(f.pageMd)).toBe(true);
        expect(fs.existsSync(path.join(f.dir, 'files'))).toBe(false); // 拒否する前に何もコピーしていない
        await expectClean(c, f.dir, 'B-1');
    });

    test('AC-1 B-2 page ノードの set-text で page md の H1 も同期する（UI の syncNodeTextToPageH1 と同じ）', async () => {
        const f = mkNote('b2');
        const r = await c.ok('fractal_modify', { note: f.out, target: 'nP', op: 'set-text', text: '新しい題\n2 行目' });
        expect(r.pageMdSynced).toBe(f.pageMd);
        expect(fs.readFileSync(f.pageMd, 'utf8')).toBe('# 新しい題\n\n本文\n');
        expect(readJson(f.out).nodes.nP.text).toBe('新しい題\n2 行目');
    });

    test('AC-1 B-3 add は本文の #tag / @tag から tags を作る（parseTags）', async () => {
        const f = mkNote('b3');
        const r = await c.ok('fractal_add', { note: f.out, text: '会議 #work @alice `#nottag`' });
        expect(readJson(f.out).nodes[r.nodeId].tags).toEqual(['#work', '@alice']);
        expect(r.tags).toEqual(['#work', '@alice']);
    });

    test('AC-1 B-4 position の既定 child は子の末尾（UI の addNode と同じ）・first は先頭・after は直後', async () => {
        const f = mkNote('b4');
        const end = await c.ok('fractal_add', { note: f.out, text: '末尾に', parent: 'nA' });
        const first = await c.ok('fractal_add', { note: f.out, text: '先頭に', parent: 'nA', position: 'first' });
        const rootEnd = await c.ok('fractal_add', { note: f.out, text: 'ルートの末尾' });
        const after = await c.ok('fractal_add', { note: f.out, text: 'りんごの直後', parent: 'nA', position: 'after' });
        const data = readJson(f.out);
        expect(data.nodes.nA.children).toEqual([first.nodeId, 'nA1', end.nodeId]);
        expect(data.rootIds[data.rootIds.length - 1]).toBe(rootEnd.nodeId);
        expect(data.rootIds[data.rootIds.indexOf('nA') + 1]).toBe(after.nodeId);
        // UI のモデルで同じ操作をした結果と同じ位置
        const m = new OutlinerModel(readJson(mkNote('b4m').out));
        const n = m.addNode('nA', null, 'x');
        expect(m.nodes.nA.children[m.nodes.nA.children.length - 1]).toBe(n.id);
        // move の既定も子の末尾
        await c.ok('fractal_modify', { note: f.out, target: 'nC', op: 'move', moveTo: 'nA' });
        const d2 = readJson(f.out);
        expect(d2.nodes.nA.children[d2.nodes.nA.children.length - 1]).toBe('nC');
        // tool の説明も同じことを言っている
        const list = await c.request('tools/list');
        const add = list.result.tools.find((t: any) => t.name === 'fractal_add');
        expect(add.inputSchema.properties.position.description).toContain('child（既定）= 基準ノードの子の末尾');
    });

    test('AC-1 B-5 taskMode の .out ではルートのノードに checkbox（false）が付く・子は null', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'b5-'));
        const out = writeOut(dir, 'tasks', 'Tasks', [node('t1', '親タスク', { checked: false })], { taskMode: true });
        writeStructure(dir, [{ type: 'file', id: 'tasks', title: 'Tasks' }]);
        const root = await c.ok('fractal_add', { note: out, text: '新しいタスク' });
        const child = await c.ok('fractal_add', { note: out, text: '子', parent: 't1' });
        const data = readJson(out);
        expect(data.nodes[root.nodeId].checked).toBe(false);
        expect(data.nodes[child.nodeId].checked).toBeNull();
        expect(data.taskMode).toBe(true);
    });

    test('AC-1 B-6 md への添付は [📎 名前](files/..) で、Cleanup に孤児と判定されない（md の取り込みのローカルリンクも）', async () => {
        const f = mkNote('b6');
        const r = await c.ok('fractal_attach', { targetMd: f.md, files: [srcFile('report.pdf', 'PDF')] });
        expect(r.links).toEqual(['[📎 report.pdf](files/report.pdf)']);
        expect(fs.readFileSync(f.md, 'utf8')).toContain('[📎 report.pdf](files/report.pdf)');
        // md の取り込み: プレーンなローカルファイルへのリンクは 📎 にして複製する
        const srcDir = fs.mkdtempSync(path.join(tmpRoot, 'b6src-'));
        fs.writeFileSync(path.join(srcDir, 'data.csv'), 'a,b\n');
        fs.writeFileSync(path.join(srcDir, 'pic.png'), PNG);
        fs.writeFileSync(path.join(srcDir, 'import.md'), '# 取り込み\n\n[データ](data.csv) と ![](pic.png)\n');
        const add = await c.ok('fractal_add', { note: f.out, md: [path.join(srcDir, 'import.md')] });
        const body = fs.readFileSync(add.pages[0].pageMdPath, 'utf8');
        expect(body).toContain('[📎 データ](files/data.csv)');
        expect(fs.existsSync(path.join(f.dir, 'files', 'data.csv'))).toBe(true);
        await expectClean(c, f.dir, 'B-6');
    });

    test('AC-1 B-7 空白・括弧・[] 入りのファイル名でも md のリンクが壊れない', async () => {
        const f = mkNote('b7');
        const r = await c.ok('fractal_attach', { targetMd: f.md, files: [srcFile('my file (draft).pdf'), srcFile('bad)name[1].pdf')], images: [srcFile('shot 1 (a).png', PNG)] });
        const body = fs.readFileSync(f.md, 'utf8');
        // 正典パーサで読むと、どのリンクも実在するファイルを指す
        const toks = linkParser.parseMarkdownLinks(body).filter((t: any) => t.url.startsWith('files/') || t.url.startsWith('images/'));
        expect(toks.length).toBe(3);
        for (const t of toks) { expect(fs.existsSync(path.join(f.dir, t.url)), t.url).toBe(true); }
        expect(r.links).toContain('[📎 my file (draft).pdf](files/my file (draft).pdf)');
        expect(r.links.join('\n')).toContain('bad_name_1_.pdf');
        await expectClean(c, f.dir, 'B-7');
    });

    test('AC-1 B-8 同じ本文のノードが複数あると黙って先頭を選ばず AMBIGUOUS（候補つき）・部分一致だけなら NOT_FOUND', async () => {
        const f = mkNote('b8');
        await c.ok('fractal_add', { note: f.out, text: '子ノード' }); // nA1 と同じ本文
        const before = fs.readFileSync(f.out, 'utf8');
        const r = await c.call('fractal_modify', { note: f.out, target: '子ノード', op: 'set-text', text: 'x' });
        expect(r.isError).toBe(true);
        expect(r.json.error.code).toBe('AMBIGUOUS');
        expect(r.json.error.candidates.length).toBe(2);
        expect(r.json.error.candidates.map((x: any) => x.breadcrumb)).toContain('りんご');
        const partial = await c.call('fractal_add', { note: f.out, text: 'y', parent: 'りん' });
        expect(partial.isError).toBe(true);
        expect(partial.json.error.code).toBe('NOT_FOUND');
        expect(partial.json.error.suggestions[0].id).toBe('nA');
        expect(fs.readFileSync(f.out, 'utf8')).toBe(before);
        // match: contains で 1 件に決まれば通る
        await c.ok('fractal_add', { note: f.out, text: 'y', parent: 'りん', match: 'contains' });
    });

    test('AC-1 B-9 fractal_list_notes は folders を渡したらそのフォルダだけ（登録済みを自動検出しない）', async () => {
        const a = mkNote('b9a');
        const b = mkNote('b9b');
        // 登録済み（globalState）に b を載せた HOME を作る
        const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
        const userDir = os.platform() === 'darwin'
            ? path.join(home, 'Library/Application Support/Code/User/globalStorage')
            : path.join(home, '.config/Code/User/globalStorage');
        fs.mkdirSync(userDir, { recursive: true });
        const state = JSON.stringify({ notesFolders: [b.dir] }).replace(/'/g, "''");
        execFileSync('sqlite3', [path.join(userDir, 'state.vscdb'),
            `CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable VALUES ('imaken.fractal', '${state}');`]);
        const c2 = new Client({ HOME: home, APPDATA: home });
        try {
            await c2.init();
            const r = await c2.ok('fractal_list_notes', { folders: [a.dir] });
            expect(r.autoDiscovered).toBe(false);
            expect(r.notes.map((n: any) => n.noteDir)).toEqual([a.dir]);
            expect(r.notes[0].items.map((i: any) => i.title).sort()).toEqual(['Main', 'Other', 'ドキュメント']);
            // folders 無しなら登録済みを見る
            const all = await c2.ok('fractal_list_notes', {});
            expect(all.notes.map((n: any) => n.noteDir)).toContain(b.dir);
        } finally {
            c2.close();
        }
    });

    test('AC-1 B-10 doctor は file item / folder link / md からの subpage / 空白入りのパスを誤検出せず、足りなかった検査を出す', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'b10-'));
        const linked = fs.mkdtempSync(path.join(tmpRoot, 'b10-linked-'));
        fs.mkdirSync(path.join(dir, 'files'));
        fs.mkdirSync(path.join(dir, 'images'));
        fs.writeFileSync(path.join(dir, 'files', 'tree.pdf'), 'PDF');
        fs.writeFileSync(path.join(dir, 'images', 'a b.png'), PNG);
        fs.writeFileSync(path.join(dir, 'files', 'x (1).pdf'), 'PDF');
        fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\n[[サブ]](sub-page.md)\n');
        fs.writeFileSync(path.join(dir, 'sub-page.md'), '# サブ\n\n![](images/a b.png)\n\n[📎 x (1).pdf](files/x (1).pdf)\n');
        writeOut(dir, 'o1', 'O1', [node('n1', 'a')]);
        writeStructure(dir, [
            { type: 'file', id: 'o1', title: 'O1' },
            { type: 'file', id: 'doc', title: 'Doc', ext: 'md' },
            { type: 'file', id: 'f1', title: 'tree.pdf', ext: 'file', filename: 'tree.pdf' },
            { type: 'file', id: 'l1', title: 'linked', ext: 'folder', folderPath: linked },
        ]);
        await expectClean(c, dir, 'B-10 誤検出なし');

        // 空白入りの名前の subpage は UI の Cleanup（cleanup-core の md リンク regex）が孤児と見てしまう → doctor は WARN で知らせる
        fs.writeFileSync(path.join(dir, 'sub space.md'), '# 空白\n');
        fs.appendFileSync(path.join(dir, 'doc.md'), '\n[[空白]](sub space.md)\n');
        const warn = await c.ok('fractal_doctor', { noteDir: dir });
        expect(warn.findings.filter((x: any) => x.level === 'WARN').map((x: any) => x.message).join('\n')).toContain('sub space.md is linked from a page / md but Fractal\'s Cleanup treats it as unreferenced');
        fs.unlinkSync(path.join(dir, 'sub space.md'));
        fs.writeFileSync(path.join(dir, 'doc.md'), '# Doc\n\n[[サブ]](sub-page.md)\n');

        // 足りなかった検査: 宙ぶらりんの child / rootIds、.out をまたぐ pageId の重複、outline.note の rootIds
        writeOut(dir, 'o2', 'O2', [node('m1', 'p', { isPage: true, pageId: 'dup', children: ['ghost'] })]);
        writeOut(dir, 'o3', 'O3', [node('k1', 'p', { isPage: true, pageId: 'dup' })]);
        fs.writeFileSync(path.join(dir, 'dup.md'), '# p\n');
        const st = readJson(path.join(dir, 'outline.note'));
        st.items.o2 = { type: 'file', id: 'o2', title: 'O2' };
        st.items.o3 = { type: 'file', id: 'o3', title: 'O3' };
        st.rootIds.push('o2', 'o3', 'nothing');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify(st, null, 2));
        const doc = await c.ok('fractal_doctor', { noteDir: dir });
        const msgs = doc.findings.filter((x: any) => x.level === 'ERROR').map((x: any) => x.message).join('\n');
        expect(msgs).toContain('references missing child ghost');
        expect(msgs).toContain('pageId dup is used by 2 nodes');
        expect(msgs).toContain('rootIds references missing item: nothing');
        expect(doc.status).toBe('errors');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-2: 書き込みのたびに doctor と Cleanup が「孤児・壊れた参照 0」で一致
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC-2 書き込みのたびに doctor と cleanup-core が一致して孤児 0', () => {
    test('AC-2 add / modify（ノード・ページ化・解除・変換）/ attach', async () => {
        const f = mkNote('ac2a');
        await expectClean(c, f.dir, '初期');
        const steps: [string, object][] = [
            ['fractal_add', { note: f.out, text: '追加 #x', parent: 'nA' }],
            ['fractal_add', { note: f.out, md: [srcFile('imp.md', '# 取り込み\n\n本文\n')] }],
            ['fractal_add', { notesDir: f.dir, createOutliner: '新しいアウトライン' }],
            ['fractal_add', { notesDir: f.dir, createMd: '新しい md' }],
            ['fractal_add', { targetMd: f.md, text: 'サブページ', heading: '背景' }],
            ['fractal_add', { targetMd: f.md, md: [srcFile('sub-src.md', '# 取り込みサブ\n')] }],
            ['fractal_modify', { note: f.out, target: 'nC', op: 'check' }],
            ['fractal_modify', { note: f.out, target: 'nA1', op: 'make-page' }],
            ['fractal_attach', { note: f.out, images: [srcFile('i1.png', PNG)], parent: 'nA' }],
            ['fractal_attach', { note: f.out, files: [srcFile('f1.pdf', 'PDF')], parent: 'nA' }],
            ['fractal_attach', { note: f.out, images: [srcFile('i2.png', PNG)], target: 'nA1', append: true }],
            ['fractal_attach', { targetMd: f.pageMd, images: [srcFile('i3.png', PNG)], files: [srcFile('f2.pdf', 'PDF')] }],
            ['fractal_modify', { note: f.out, target: 'nA1', op: 'unpage' }],
            ['fractal_modify', { note: f.out, target: 'nA', op: 'delete' }],
            ['fractal_modify', { note: f.out, target: 'nP', op: 'page-to-md' }],
            ['fractal_modify', { note: f.out, op: 'md-to-page', mdItem: 'ドキュメント', target: 'nC', position: 'after' }],
            ['fractal_modify', { note: f.out, target: 'nC', op: 'move', moveTo: 'root', position: 'first' }],
        ];
        for (const [tool, args] of steps) {
            await c.ok(tool, args);
            await expectClean(c, f.dir, `${tool} ${JSON.stringify(args)}`);
        }
    });

    test('AC-2 別の .out・別の note への move / tree（rename・delete・move・create-folder・duplicate・move-to-note）/ md への添付・subpage', async () => {
        const f = mkNote('ac2b');
        const g = mkNote('ac2b-dst');
        // page と画像・添付を持つノードを用意する
        await c.ok('fractal_attach', { targetMd: f.pageMd, images: [srcFile('m1.png', PNG)], files: [srcFile('m1.pdf', 'PDF')] });
        await c.ok('fractal_attach', { note: f.out, images: [srcFile('m2.png', PNG)], target: 'nP', append: true });
        await c.ok('fractal_attach', { note: f.out, files: [srcFile('m3.pdf', 'PDF')], parent: 'nA' });
        const steps: [string, object, string[]][] = [
            ['fractal_modify', { note: f.out, target: 'nA', op: 'move', toOut: f.other }, [f.dir]],
            ['fractal_modify', { note: f.out, target: 'nP', op: 'move', toOut: g.out }, [f.dir, g.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'create-folder', title: 'フォルダ' }, [f.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'move', item: 'Other', parentFolder: 'フォルダ' }, [f.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'rename', item: 'ドキュメント', title: '文書' }, [f.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'duplicate', item: 'Other' }, [f.dir]],
            // md の本文はエージェントが直接編集する（fractal_md_edit は廃止）。md への書き込みは添付・subpage を見出しの下へ
            ['fractal_attach', { targetMd: f.md, files: [srcFile('m4.pdf', 'PDF')], heading: '結論' }, [f.dir]],
            ['fractal_add', { targetMd: f.md, text: '背景の subpage', heading: '背景', mdPosition: 'start' }, [f.dir]],
            // H1 は md item なら fractal_tree rename で変える（ツリーの title と一緒に）
            ['fractal_tree', { noteDir: f.dir, op: 'rename', item: '文書', title: '文書 v2' }, [f.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'move-to-note', item: '文書 v2', toNoteDir: g.dir }, [f.dir, g.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'delete', item: 'Main' }, [f.dir]],
            ['fractal_tree', { noteDir: f.dir, op: 'delete', item: 'フォルダ' }, [f.dir]],
        ];
        const results: any[] = [];
        for (const [tool, args, dirs] of steps) {
            results.push(await c.ok(tool, args));
            for (const d of dirs) { await expectClean(c, d, `${tool} ${JSON.stringify(args)} @ ${path.basename(d)}`); }
            if (tool === 'fractal_tree' && (args as any).title === '文書 v2') {
                // rename で md の H1 とツリーの title が同期している（旧 md_edit set-h1 の観点）
                expect(fs.readFileSync(f.md, 'utf8').split('\n')[0]).toBe('# 文書 v2');
                expect(readJson(path.join(f.dir, 'outline.note')).items.doc.title).toBe('文書 v2');
                // 添付は「結論」の節、subpage は「背景」の直後に入っている
                const body = fs.readFileSync(f.md, 'utf8');
                expect(body.indexOf('[📎 m4.pdf](files/m4.pdf)')).toBeGreaterThan(body.indexOf('## 結論'));
                expect(body.indexOf('[[背景の subpage]]')).toBeGreaterThan(body.indexOf('## 背景'));
                expect(body.indexOf('[[背景の subpage]]')).toBeLessThan(body.indexOf('背景の本文'));
            }
        }
        // 別の note へ移した page は、画像・添付ごと移動先で生きている
        expect(results[1].crossNote).toBe(true);
        const gData = readJson(g.out);
        const moved: any = gData.nodes[results[1].nodeId];
        expect(gData.rootIds[0]).toBe(results[1].nodeId);
        expect(moved.isPage).toBe(true);
        expect(fs.readFileSync(path.join(g.dir, `${moved.pageId}.md`), 'utf8')).toContain('files/');
        expect(moved.images.length).toBe(1);
        expect(fs.existsSync(path.join(g.dir, moved.images[0]))).toBe(true);
        // 移し元の page md はゴミ箱へ（消えてはいない）
        expect(fs.existsSync(f.pageMd)).toBe(false);
        expect(fs.readdirSync(trashDir).some((n) => n.endsWith('pg1.md'))).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-3: 拡張機能の共有関数と MCP で同じ操作 → id・時刻以外で一致
// ═══════════════════════════════════════════════════════════════════════════

/** id・時刻を出てきた順の記号に置き換えて比べられる形にする */
function normalize(text: string): string {
    const ids = new Map<string, string>();
    const sub = (re: RegExp, tag: string) => (s: string) => s.replace(re, (m) => {
        if (!ids.has(m)) { ids.set(m, `<${tag}${ids.size}>`); }
        return ids.get(m)!;
    });
    let s = text;
    s = sub(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'uuid')(s);
    s = sub(/\bn[0-9a-z]{9,16}\b/g, 'node')(s);
    // outline id（NotesFileManager.generateOutlineId = Date.now() の 36 進 + 乱数 4 桁）
    const now36 = Date.now().toString(36).slice(0, 3);
    s = sub(new RegExp(`\\b${now36}[0-9a-z]{9,10}\\b`, 'g'), 'id')(s);
    return s;
}

function snapshotNote(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const abs = path.join(d, e.name);
            if (e.isDirectory()) { walk(abs); continue; }
            const rel = normalize(path.relative(dir, abs));
            let body = fs.readFileSync(abs, 'utf8');
            if (/\.(out|note)$/.test(abs)) {
                const j = JSON.parse(body);
                delete j.history; // Recent（UI だけが付ける）
                body = JSON.stringify(j, null, 2);
            }
            out[rel] = normalize(body);
        }
    };
    walk(dir);
    return out;
}

function twin(name: string) {
    const a = mkNote(name + '-ext', name);
    const b = mkNote(name + '-mcp', name);
    return { a, b };
}

/** 拡張機能と同じく outline.note を読み込み済みの NotesFileManager（パネルを開いた時点で読み込まれる） */
function openFm(dir: string): NotesFileManager {
    const fm = new NotesFileManager(dir);
    fm.getStructure();
    return fm;
}

/** 2 つの note のファイルを、フォルダ名・id・時刻を除いて比べる */
function expectSameNotes(a: string, b: string) {
    const sa = snapshotNote(a);
    const sb = snapshotNote(b);
    const fix = (o: Record<string, string>, dir: string) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.split(dir).join('<NOTE>').split(path.basename(dir)).join('<NOTEDIR>')]));
    expect(fix(sb, b)).toEqual(fix(sa, a));
}

test.describe('AC-3 拡張機能の共有関数と MCP の結果が一致', () => {
    test('AC-3 新しい .out / md item（NotesFileManager.createFile / createMarkdownFile）', async () => {
        const { a, b } = twin('ac3-create');
        const fm = openFm(a.dir);
        fm.createFile('新しいアウトライン', null, null);
        fm.createMarkdownFile('新しい md', null, null);
        await c.ok('fractal_add', { notesDir: b.dir, createOutliner: '新しいアウトライン' });
        await c.ok('fractal_add', { notesDir: b.dir, createMd: '新しい md' });
        expectSameNotes(a.dir, b.dir);
    });

    test('AC-3 md → page（importMdItemIntoOutCore）と page → md（importOutPageNodeAsMdCore）', async () => {
        const { a, b } = twin('ac3-conv');
        const fm = openFm(a.dir);
        importMdItemIntoOutCore(fm, 'doc', 'main', null, null);
        importOutPageNodeAsMdCore(fm, { outFileKey: a.out, nodeId: 'nP', pageId: 'pg1', title: 'ページ' }, null, 0, { clearSourceNode: true });
        await c.ok('fractal_modify', { note: b.out, op: 'md-to-page', mdItem: 'doc', position: 'first' });
        await c.ok('fractal_modify', { note: b.out, target: 'nP', op: 'page-to-md' });
        expectSameNotes(a.dir, b.dir);
    });

    test('AC-3 別の .out への move（moveOutNodesIntoOtherOutCore）と Duplicate（duplicateTreeItemEntity）', async () => {
        const { a, b } = twin('ac3-move');
        moveOutNodesIntoOtherOutCore(a.out, a.other, ['nA']);
        duplicateTreeItemEntity(openFm(a.dir), 'doc');
        await c.ok('fractal_modify', { note: b.out, target: 'nA', op: 'move', toOut: b.other });
        await c.ok('fractal_tree', { noteDir: b.dir, op: 'duplicate', item: 'doc' });
        expectSameNotes(a.dir, b.dir);
    });

    test('AC-3 rename（NotesFileManager.renameTitle = md の H1 とツリーの title）', async () => {
        const { a, b } = twin('ac3-rename');
        const fm = openFm(a.dir);
        fm.renameTitle(a.md, '改名した文書');
        fm.renameTitle(a.other, '改名した .out');
        await c.ok('fractal_tree', { noteDir: b.dir, op: 'rename', item: 'doc', title: '改名した文書' });
        await c.ok('fractal_tree', { noteDir: b.dir, op: 'rename', item: 'other', title: '改名した .out' });
        expectSameNotes(a.dir, b.dir);
    });

    test('AC-3 ノードの追加・ページ化（OutlinerModel.addNode / makePage + createPageMdFile）', async () => {
        const { a, b } = twin('ac3-node');
        // 拡張機能（webview の OutlinerModel + host の createPageMdFile）
        const data = readJson(a.out);
        const m = new OutlinerModel(data);
        m.addNode('nA', null, '追加 #tag');
        const pageId = m.makePage('nA1');
        createPageMdFile(a.dir, pageId, '子ノード');
        const ser = m.serialize();
        fs.writeFileSync(a.out, JSON.stringify({ ...ser, pageDir: '.', imageDir: './images', fileDir: './files' }, null, 2));
        // MCP
        await c.ok('fractal_add', { note: b.out, text: '追加 #tag', parent: 'nA' });
        await c.ok('fractal_modify', { note: b.out, target: 'nA1', op: 'make-page' });
        expectSameNotes(a.dir, b.dir);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-4: resolve / get / JSON の返り値
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC-4 resolve / get / 書き込みの JSON', () => {
    test('AC-4 fractal_resolve は完全一致を優先し、曖昧なら候補を返してエラー', async () => {
        const f = mkNote('ac4r');
        const fm = new NotesFileManager(f.dir);
        fm.createMarkdownFile('Plan', null, null);
        fm.createMarkdownFile('Plan B', null, null);
        const one = await c.ok('fractal_resolve', { query: 'Plan', kind: 'item', folders: [f.dir] });
        expect(one.result.title).toBe('Plan');
        expect(one.result.type).toBe('md');
        expect(fs.existsSync(one.result.absPath)).toBe(true);
        expect(one.result.contentHash).toMatch(/^[0-9a-f]{16}$/);
        const amb = await c.call('fractal_resolve', { query: 'Plan', kind: 'item', match: 'prefix', folders: [f.dir] });
        expect(amb.isError).toBe(true);
        expect(amb.json.error.code).toBe('AMBIGUOUS');
        expect(amb.json.error.candidates.map((x: any) => x.title).sort()).toEqual(['Plan', 'Plan B']);
        const none = await c.call('fractal_resolve', { query: 'Pla', kind: 'item', folders: [f.dir] });
        expect(none.json.error.code).toBe('NOT_FOUND');
        // page（node の本文）・note・md の見出し
        const page = await c.ok('fractal_resolve', { query: 'ページ', kind: 'page', folders: [f.dir] });
        expect(page.result.pageMdPath).toBe(f.pageMd);
        expect(page.result.nodeId).toBe('nP');
        const note = await c.ok('fractal_resolve', { query: 'ac4r', kind: 'note', folders: [f.dir] });
        expect(note.result.noteDir).toBe(f.dir);
        const h = await c.ok('fractal_resolve', { query: '結論', kind: 'heading', within: f.md });
        expect(h.result.line).toBe(7);
    });

    test('AC-4 fractal_get は .out のノード木（id 付き）・md の本文 / H1 / 見出し / subpage・contentHash を返す', async () => {
        const f = mkNote('ac4g');
        const out = await c.ok('fractal_get', { path: f.out });
        expect(out.kind).toBe('out');
        expect(out.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(out.nodes.map((n: any) => n.id)).toEqual(['nA', 'nC', 'nP']);
        expect(out.nodes[0].children[0]).toMatchObject({ id: 'nA1', text: '子ノード' });
        expect(out.nodes[2]).toMatchObject({ isPage: true, pageId: 'pg1', pageMdPath: f.pageMd });
        const sub = await c.ok('fractal_get', { path: f.out, node: 'りんご', depth: 0 });
        expect(sub.nodes).toEqual([{ id: 'nA', text: 'りんご', childCount: 1 }]);
        await c.ok('fractal_add', { targetMd: f.md, text: 'サブ' });
        const md = await c.ok('fractal_get', { path: f.md });
        expect(md.kind).toBe('md');
        expect(md.h1).toBe('ドキュメント');
        expect(md.headings.map((x: any) => x.path)).toEqual(['ドキュメント', 'ドキュメント > 背景', 'ドキュメント > 結論']);
        expect(md.subpages.length).toBe(1);
        expect(md.subpages[0].exists).toBe(true);
        expect(md.owner).toEqual({ kind: 'item', itemId: 'doc' });
        expect(md.body).toContain('背景の本文');
        const note = await c.ok('fractal_get', { path: f.dir });
        expect(note.tree.map((x: any) => x.title)).toEqual(['Main', 'Other', 'ドキュメント']);
    });

    test('AC-4 書き込み系の返り値は JSON（nodeId / pageId / absPath / contentHash）', async () => {
        const f = mkNote('ac4w');
        const add = await c.ok('fractal_add', { note: f.out, text: 'x' });
        expect(add).toMatchObject({ ok: true, op: 'add-node', absPath: f.out });
        expect(add.nodeId).toMatch(/^n/);
        expect(add.changed[0]).toEqual({ absPath: f.out, contentHash: (await c.ok('fractal_get', { path: f.out })).contentHash });
        const mp = await c.ok('fractal_modify', { note: f.out, target: add.nodeId, op: 'make-page' });
        expect(mp.pageId).toMatch(/^[0-9a-f-]{36}$/);
        expect(mp.created.map((x: any) => x.absPath)).toContain(mp.pageMdPath);
        const at = await c.ok('fractal_attach', { note: f.out, files: [srcFile('w.pdf')] });
        expect(fs.existsSync(at.files[0].fileAbsPath)).toBe(true);
        const tr = await c.ok('fractal_tree', { noteDir: f.dir, op: 'create-folder', title: 'F' });
        expect(tr.itemId).toBeTruthy();
        expect(tr.type).toBe('folder');
        const ed = await c.ok('fractal_attach', { targetMd: f.md, files: [srcFile('w2.pdf')] });
        expect(ed.op).toBe('attach-md');
        expect(ed.changed[0].absPath).toBe(f.md);
        expect(ed.changed[0].contentHash).toBe((await c.ok('fractal_get', { path: f.md })).contentHash);
        expect(ed.assets[0].absPath).toBe(path.join(f.dir, 'files', 'w2.pdf'));
        const sp = await c.ok('fractal_add', { targetMd: f.md, text: 'サブ' });
        expect(sp.op).toBe('add-subpage');
        expect(fs.existsSync(sp.subpages[0].absPath)).toBe(true);
        // 書く前に読んだ contentHash を付けなければ「ロック無し」と出る
        expect(ed.lock).toBe('none');
        const dry = await c.ok('fractal_modify', { note: f.out, target: 'nA', op: 'delete', dryRun: true });
        expect(dry.dryRun).toBe(true);
        expect(dry.changed.map((x: any) => x.absPath)).toEqual([f.out]);
        expect(readJson(f.out).nodes.nA).toBeTruthy();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-5: CONFLICT / tmp + rename / 境界
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC-5 競合・原子的な書き込み・境界', () => {
    test('AC-5 expectedHash が今の内容と違うと書かずに CONFLICT', async () => {
        const f = mkNote('ac5c');
        const got = await c.ok('fractal_get', { path: f.out });
        // Fractal 側で変わった（外部の編集）
        const d = readJson(f.out); d.nodes.nA.text = '画面で書き換えた'; fs.writeFileSync(f.out, JSON.stringify(d, null, 2));
        const changed = fs.readFileSync(f.out, 'utf8');
        for (const [tool, args] of [
            ['fractal_modify', { note: f.out, target: 'nC', op: 'check', expectedHash: got.contentHash }],
            ['fractal_add', { note: f.out, text: 'x', expectedHash: got.contentHash }],
            ['fractal_attach', { note: f.out, files: [srcFile('c.pdf')], expectedHash: got.contentHash }],
        ] as [string, object][]) {
            const r = await c.call(tool, args);
            expect(r.isError, tool).toBe(true);
            expect(r.json.error.code).toBe('CONFLICT');
            expect(r.json.error.currentHash).toMatch(/^[0-9a-f]{16}$/);
        }
        expect(fs.readFileSync(f.out, 'utf8')).toBe(changed);
        expect(fs.existsSync(path.join(f.dir, 'files'))).toBe(false);
        const md = await c.ok('fractal_get', { path: f.md });
        fs.appendFileSync(f.md, '\n外部の追記\n');
        const md2 = fs.readFileSync(f.md, 'utf8');
        const r = await c.call('fractal_attach', { targetMd: f.md, files: [srcFile('c2.pdf')], expectedHash: md.contentHash });
        expect(r.json.error.code).toBe('CONFLICT');
        const r1 = await c.call('fractal_add', { targetMd: f.md, text: 'x', expectedHash: md.contentHash });
        expect(r1.json.error.code).toBe('CONFLICT');
        expect(fs.readFileSync(f.md, 'utf8')).toBe(md2);
        expect(fs.existsSync(path.join(f.dir, 'files'))).toBe(false);
        const tree = await c.ok('fractal_get', { path: f.dir });
        await c.ok('fractal_tree', { noteDir: f.dir, op: 'create-folder', title: 'A', expectedHash: tree.contentHash });
        const r2 = await c.call('fractal_tree', { noteDir: f.dir, op: 'create-folder', title: 'B', expectedHash: tree.contentHash });
        expect(r2.json.error.code).toBe('CONFLICT');
        // 新しい hash なら通る
        const fresh = await c.ok('fractal_get', { path: f.out });
        const ok = await c.ok('fractal_modify', { note: f.out, target: 'nC', op: 'check', expectedHash: fresh.contentHash });
        expect(ok.lock).toBe('expectedHash');
    });

    test('AC-5 書き込みは tmp + rename（inode が変わる・tmp が残らない。正典の NotesFileManager の書き込みも）', async () => {
        const f = mkNote('ac5a');
        const ino = (p: string) => fs.statSync(p).ino;
        const outIno = ino(f.out);
        const mdIno = ino(f.md);
        const noteIno = ino(path.join(f.dir, 'outline.note'));
        await c.ok('fractal_add', { note: f.out, text: 'x' });
        await c.ok('fractal_add', { targetMd: f.md, text: 'y' }); // md への書き込み（subpage のリンク挿入）
        await c.ok('fractal_tree', { noteDir: f.dir, op: 'rename', item: 'Other', title: 'Other2' }); // NotesFileManager が書く
        expect(ino(f.out)).not.toBe(outIno);
        expect(ino(f.md)).not.toBe(mdIno);
        expect(ino(path.join(f.dir, 'outline.note'))).not.toBe(noteIno);
        expect(fs.readdirSync(f.dir).filter((n) => n.includes('fractal-tmp'))).toEqual([]);
        // 比較: 素の fs.writeFileSync は同じ inode に上書きする（この検査が意味を持つことの確認）
        const p = path.join(f.dir, 'probe.txt');
        fs.writeFileSync(p, 'a'); const i1 = ino(p); fs.writeFileSync(p, 'b');
        expect(ino(p)).toBe(i1);
    });

    test('AC-5 途中で失敗したら、その操作でコピーした画像・作った images/ を残さない（監査 B-12）', async () => {
        const f = mkNote('ac5r');
        const before = fs.readFileSync(f.out, 'utf8');
        // 画像をコピーした後で位置の指定（after に基準が無い）が不正と分かる → 失敗
        const r = await c.call('fractal_attach', { note: f.out, images: [srcFile('r1.png', PNG), srcFile('r2.png', PNG)], position: 'after' });
        expect(r.isError).toBe(true);
        expect(r.json.error.code).toBe('INVALID');
        expect(fs.existsSync(path.join(f.dir, 'images'))).toBe(false);
        expect(fs.readFileSync(f.out, 'utf8')).toBe(before);
        // 入力の不備（2 枚目が無い）は書き始める前に止める
        const r2 = await c.call('fractal_attach', { note: f.out, images: [srcFile('r3.png', PNG), path.join(tmpRoot, 'nope.png')] });
        expect(r2.json.error.code).toBe('NOT_FOUND');
        expect(fs.existsSync(path.join(f.dir, 'images'))).toBe(false);
        await expectClean(c, f.dir, 'B-12');
    });

    test('AC-5 Notes フォルダの外への書き込みは拒否（outline.note の無い場所・.out の imageDir が外・相対パス）', async () => {
        const f = mkNote('ac5b');
        const outside = fs.mkdtempSync(path.join(tmpRoot, 'outside-'));
        const loose = path.join(outside, 'loose.md');
        fs.writeFileSync(loose, '# loose\n');
        const r1 = await c.call('fractal_add', { targetMd: loose, text: 'x' });
        expect(r1.json.error.code).toBe('OUTSIDE_NOTES');
        expect(fs.readFileSync(loose, 'utf8')).toBe('# loose\n');
        const r2 = await c.call('fractal_attach', { targetMd: loose, files: [srcFile('o.pdf')] });
        expect(r2.json.error.code).toBe('OUTSIDE_NOTES');
        expect(fs.existsSync(path.join(outside, 'files'))).toBe(false);
        // .out の imageDir が Notes フォルダの外を指している
        const d = readJson(f.out); d.imageDir = path.relative(f.dir, path.join(outside, 'imgs')); fs.writeFileSync(f.out, JSON.stringify(d, null, 2));
        const r3 = await c.call('fractal_attach', { note: f.out, images: [srcFile('o.png', PNG)] });
        expect(r3.json.error.code).toBe('OUTSIDE_NOTES');
        expect(fs.existsSync(path.join(outside, 'imgs'))).toBe(false);
        // notesDir に outline.note が無い
        const r4 = await c.call('fractal_add', { notesDir: outside, createMd: 'x' });
        expect(r4.json.error.code).toBe('OUTSIDE_NOTES');
        expect(fs.readdirSync(outside).sort()).toEqual(['loose.md']);
        // 相対パスは拒否（cwd 依存で別の場所に書かない）
        const r5 = await c.call('fractal_modify', { note: 'main.out', target: 'nA', op: 'check' });
        expect(r5.json.error.code).toBe('INVALID');
    });
});
