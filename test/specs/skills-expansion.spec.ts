/**
 * ai_skills 拡張（sprint 20260726-042303）: fractal-modify / --create-md / fractal-doctor /
 * fractal-export / fractal-search --tag/--checked。
 *
 * spec 20261027-1700-mcp-full-ops で書き込みと doctor の mjs は mcp/src（src/shared の正典を呼ぶ TypeScript）へ
 * 置き換えた: A・B は bundle の MCP tool、C は mcp/src/doctor.ts を直接呼んで同じ観点を確かめる。
 * summary / search の mjs は main guard 付きなので直接 import できる。tmp fixture note を都度生成。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { McpTestClient } from '../utils/mcp-client';

const doctorTs = path.resolve(__dirname, '../../agent-capability/mcp/src/doctor.ts');
const summaryMjs = path.resolve(__dirname, '../../agent-capability/mcp/scripts/fractal-summary.mjs');
const searchMjs = path.resolve(__dirname, '../../agent-capability/mcp/scripts/fractal-search.mjs');

let tmpRoot: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-skills-exp-'));
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkdir(name: string): string {
    return fs.mkdtempSync(path.join(tmpRoot, name + '-'));
}

/** 標準 fixture .out データ（root: A(checked null) > B(child), C(#work checked=false), D(page) */
function fixtureOutData() {
    return {
        version: 1,
        title: 'Fixture',
        pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: ['nA', 'nC', 'nD'],
        nodes: {
            nA: { id: 'nA', parentId: null, children: ['nB'], text: '親ノード', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
            nB: { id: 'nB', parentId: 'nA', children: [], text: '子ノード', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
            nC: { id: 'nC', parentId: null, children: [], text: 'タスク #work', tags: ['#work'], isPage: false, pageId: null, collapsed: false, checked: false, subtext: '', images: [], filePath: null },
            nD: { id: 'nD', parentId: null, children: [], text: 'ページノード', tags: [], isPage: true, pageId: 'page-uuid-1', collapsed: false, checked: null, subtext: '', images: [], filePath: null },
        },
    };
}

function mkFixtureNote(name: string): { dir: string; outPath: string } {
    const dir = mkdir(name);
    const outPath = path.join(dir, 'fix.out');
    fs.writeFileSync(outPath, JSON.stringify(fixtureOutData(), null, 2));
    fs.writeFileSync(path.join(dir, 'page-uuid-1.md'), '# ページノード\n\n本文 ![img](images/pic.png)\n');
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNG');
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        version: 1, rootIds: ['fix'], items: { fix: { type: 'file', id: 'fix', title: 'Fixture' } },
    }, null, 2));
    return { dir, outPath };
}

// spec 20261027-1700-mcp-full-ops（D1 / ADR-0012）: 書き込み（旧 fractal-modify.mjs / fractal-md.mjs /
// fractal-attach.mjs）と doctor（旧 fractal-doctor.mjs）の mjs は、src/shared の正典を呼ぶ MCP の TypeScript
// （mcp/src）に置き換えた。A・B は bundle（mcp/dist/server.mjs）の tool で同じ観点を確かめる。
// 挙動を意図して変えたもの（監査 B-1〜B-12 の修正）は各テストのコメントに書く。

async function withClient<T>(fn: (c: McpTestClient) => Promise<T>): Promise<T> {
    const c = new McpTestClient({ FRACTAL_TRASH_DIR: path.join(tmpRoot, '_trash') });
    try {
        await c.init();
        return await fn(c);
    } finally {
        c.close();
    }
}
async function ok(c: McpTestClient, name: string, args: object): Promise<any> {
    const r = await c.call(name, args);
    expect(r.isError, `${name}: ${r.text}`).toBe(false);
    return r.json;
}

test.describe('A. fractal_modify（旧 fractal-modify.mjs）', () => {
    test('TC-EX-01 set-text: text 置換 + tags 再計算・他フィールド不変', async () => {
        const { outPath } = mkFixtureNote('mod-text');
        await withClient(async (c) => {
            const before = JSON.parse(fs.readFileSync(outPath, 'utf-8')).nodes.nD;
            await ok(c, 'fractal_modify', { note: outPath, target: 'nA', op: 'set-text', text: '新テキスト #tag1 @who' });
            await ok(c, 'fractal_modify', { note: outPath, target: 'nB', op: 'set-text', text: 'code `#not-tag` only' });
            const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
            expect(data.nodes.nA.text).toBe('新テキスト #tag1 @who');
            expect(data.nodes.nA.tags).toEqual(['#tag1', '@who']);
            expect(data.nodes.nB.tags).toEqual([]); // inline code 内タグは除外（正典 parseTags）
            expect(data.nodes.nD).toEqual(before);
            expect(data.nodes.nA.isPage).toBe(false);
        });
    });

    test('TC-EX-02 check/uncheck/clear-check の 3 値遷移', async () => {
        const { outPath } = mkFixtureNote('mod-check');
        await withClient(async (c) => {
            const read = () => JSON.parse(fs.readFileSync(outPath, 'utf-8')).nodes.nC.checked;
            await ok(c, 'fractal_modify', { note: outPath, target: 'nC', op: 'check' });
            expect(read()).toBe(true);
            await ok(c, 'fractal_modify', { note: outPath, target: 'nC', op: 'uncheck' });
            expect(read()).toBe(false);
            await ok(c, 'fractal_modify', { note: outPath, target: 'nC', op: 'clear-check' });
            expect(read()).toBe(null);
        });
    });

    test('TC-EX-03 delete: 子孫ごと構造除去・その node だけの page md は（消さずに）ゴミ箱へ', async () => {
        // 変更（spec 20261027-1700 AC-2）: 旧実装は page md を残して孤児にしていた（Cleanup が後で消す）。
        // 今は「その操作で孤児になった実体」をゴミ箱へ移す（完全削除はしない = ★安全番人は「消えずに退避」）。
        const { dir, outPath } = mkFixtureNote('mod-del');
        await withClient(async (c) => {
            const r = await ok(c, 'fractal_modify', { note: outPath, target: 'nD', op: 'delete' });
            const after = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
            expect(after.nodes.nD).toBeUndefined();
            expect(after.rootIds).not.toContain('nD');
            expect(fs.existsSync(path.join(dir, 'page-uuid-1.md'))).toBe(false);
            expect(r.trashed).toContain(path.join(dir, 'page-uuid-1.md'));
            expect(fs.readdirSync(path.join(tmpRoot, '_trash')).some((n) => n.endsWith('page-uuid-1.md'))).toBe(true);
            const r2 = await ok(c, 'fractal_modify', { note: outPath, target: 'nA', op: 'delete' });
            expect(r2.removedNodeIds.sort()).toEqual(['nA', 'nB']);
        });
    });

    test('TC-EX-04 move: child（子の末尾）/after + 子孫への move はエラー（.out 非破壊）', async () => {
        // 変更（監査 B-4）: child は「子の先頭」→ UI の addNode / moveNode と同じ「子の末尾」（先頭は position: first）
        const { outPath } = mkFixtureNote('mod-move');
        await withClient(async (c) => {
            await ok(c, 'fractal_modify', { note: outPath, target: 'nC', op: 'move', moveTo: 'nA', position: 'child' });
            let data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
            expect(data.nodes.nA.children).toEqual(['nB', 'nC']);
            expect(data.nodes.nC.parentId).toBe('nA');
            expect(data.rootIds).not.toContain('nC');
            await ok(c, 'fractal_modify', { note: outPath, target: 'nB', op: 'move', moveTo: 'nD', position: 'after' });
            data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
            expect(data.rootIds[data.rootIds.indexOf('nD') + 1]).toBe('nB');
            expect(data.nodes.nB.parentId).toBe(null);
            const snapshot = fs.readFileSync(outPath, 'utf-8');
            const bad = await c.call('fractal_modify', { note: outPath, target: 'nA', op: 'move', moveTo: 'nC', position: 'child' });
            expect(bad.isError).toBe(true);
            expect(bad.json.error.message).toContain('子孫');
            expect(fs.readFileSync(outPath, 'utf-8')).toBe(snapshot);
        });
    });

    test('TC-EX-05 target 解決: id / 完全一致・部分一致だけは NOT_FOUND（候補つき）', async () => {
        // 変更（監査 B-8）: 部分一致で黙って先頭を選んでいた → 既定は完全一致。部分一致は match: "contains"
        const { outPath } = mkFixtureNote('mod-resolve');
        await withClient(async (c) => {
            await ok(c, 'fractal_modify', { note: outPath, target: 'nB', op: 'check' });
            await ok(c, 'fractal_modify', { note: outPath, target: '親ノード', op: 'check' });
            const partial = await c.call('fractal_modify', { note: outPath, target: 'タスク', op: 'check' });
            expect(partial.json.error.code).toBe('NOT_FOUND');
            expect(partial.json.error.suggestions.map((x: any) => x.id)).toEqual(['nC']);
            await ok(c, 'fractal_modify', { note: outPath, target: 'タスク', op: 'check', match: 'contains' });
            const none = await c.call('fractal_modify', { note: outPath, target: '存在しない', op: 'check' });
            expect(none.json.error.code).toBe('NOT_FOUND');
        });
    });

    test('TC-EX-06 dry-run: .out バイト不変', async () => {
        const { outPath } = mkFixtureNote('mod-dry');
        const before = fs.readFileSync(outPath, 'utf-8');
        await withClient(async (c) => {
            const r = await ok(c, 'fractal_modify', { note: outPath, target: 'nA', op: 'delete', dryRun: true });
            expect(r.dryRun).toBe(true);
            expect(r.removedNodeIds.sort()).toEqual(['nA', 'nB']);
        });
        expect(fs.readFileSync(outPath, 'utf-8')).toBe(before);
    });
});

test.describe('B. fractal_add / fractal_attach（旧 fractal-md.mjs / fractal-attach.mjs）', () => {
    test('TC-EX-07 md item 作成 + outline.note 登録（ext:md・rootIds 先頭）', async () => {
        const dir = mkdir('create-md');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['x'], items: { x: { type: 'folder', id: 'x', title: 'X', childIds: [], collapsed: false } } }));
        await withClient(async (c) => {
            const r = await ok(c, 'fractal_add', { notesDir: dir, createMd: '会議メモ' });
            expect(fs.readFileSync(r.absPath, 'utf-8')).toBe('# 会議メモ\n');
            expect(path.dirname(r.absPath)).toBe(dir); // note 直下フラット
            const s = JSON.parse(fs.readFileSync(path.join(dir, 'outline.note'), 'utf-8'));
            expect(s.items[r.itemId]).toEqual({ type: 'file', id: r.itemId, title: '会議メモ', ext: 'md' });
            expect(s.rootIds[0]).toBe(r.itemId);
            expect(s.rootIds).toContain('x'); // 既存は保持
        });
    });

    test('TC-EX-08 outline.note の無いフォルダには作らない（Notes フォルダの外への書き込み拒否）', async () => {
        // 変更（spec 20261027-1700 D3 境界）: 旧実装は outline.note を新規作成していた
        const dir = mkdir('create-md-empty');
        await withClient(async (c) => {
            const r = await c.call('fractal_add', { notesDir: dir, createMd: 'First' });
            expect(r.json.error.code).toBe('OUTSIDE_NOTES');
        });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('TC-EX-08c targetMd: subpage md 作成 + 末尾リンク追記 + 画像コピー', async () => {
        const dir = mkdir('target-md');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['parent'], items: { parent: { type: 'file', id: 'parent', title: '親ページ', ext: 'md' } } }));
        const targetMd = path.join(dir, 'parent.md');
        fs.writeFileSync(targetMd, '# 親ページ\n\n本文\n');
        const srcDir = mkdir('target-md-src');
        fs.writeFileSync(path.join(srcDir, 'article.md'), '# 記事 [x]\n\n![p](photo.png)\n');
        fs.writeFileSync(path.join(srcDir, 'photo.png'), 'PNG');
        await withClient(async (c) => {
            const r = await ok(c, 'fractal_add', { targetMd, md: [path.join(srcDir, 'article.md')] });
            const sub = r.subpages[0];
            expect(path.dirname(sub.absPath)).toBe(dir);
            const after = fs.readFileSync(targetMd, 'utf-8');
            // ラベルは正典 sanitizeSubpageLabel（] [ は全角）
            expect(after).toContain(`[[記事 ［x］]](${path.basename(sub.absPath)})`);
            expect(after.startsWith('# 親ページ')).toBe(true);
            // 画像は正典 copyMdPasteAssets で target 隣の images/ に複製・書換（名前は copy-<ts>-<元名>）
            const newBody = fs.readFileSync(sub.absPath, 'utf-8');
            const m = newBody.match(/!\[p\]\(images\/(copy-\d+-photo\.png)\)/);
            expect(m).toBeTruthy();
            expect(fs.existsSync(path.join(dir, 'images', m![1]))).toBe(true);
            // text モード（source なし）: 空の subpage
            const r2 = await ok(c, 'fractal_add', { targetMd, text: 'メモ' });
            expect(fs.readFileSync(r2.subpages[0].absPath, 'utf-8')).toBe('# メモ\n');
            expect(fs.readFileSync(targetMd, 'utf-8')).toContain(`[[メモ]](${path.basename(r2.subpages[0].absPath)})`);
            const r3 = await ok(c, 'fractal_add', { targetMd, text: 'A]B[C' });
            expect(r3.subpages[0].link).toContain('[[A］B［C]]');
        });
    });

    test('TC-EX-08d attach targetMd: 画像/ファイルを md 隣にコピーして末尾リンク追記', async () => {
        // 変更（監査 B-6）: 添付のリンクは [name](files/..) → UI と同じ [📎 name](files/..)（Cleanup が添付として数える形）
        const dir = mkdir('attach-md');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['doc'], items: { doc: { type: 'file', id: 'doc', title: 'ドキュメント', ext: 'md' } } }));
        const targetMd = path.join(dir, 'doc.md');
        fs.writeFileSync(targetMd, '# ドキュメント\n\n本文\n');
        const srcDir = mkdir('attach-md-src');
        fs.writeFileSync(path.join(srcDir, 'shot.png'), 'PNG');
        fs.writeFileSync(path.join(srcDir, 'report.pdf'), 'PDF');
        await withClient(async (c) => {
            const ri = await ok(c, 'fractal_attach', { targetMd, images: [path.join(srcDir, 'shot.png')] });
            expect(ri.assets[0].rel).toMatch(/^images\/image_\d+_\w+\.png$/);
            expect(fs.existsSync(path.join(dir, ri.assets[0].rel))).toBe(true);
            const body = fs.readFileSync(targetMd, 'utf-8');
            expect(body.startsWith('# ドキュメント')).toBe(true);
            expect(body).toContain(`![](${ri.assets[0].rel})`);
            const rf = await ok(c, 'fractal_attach', { targetMd, files: [path.join(srcDir, 'report.pdf')] });
            expect(rf.assets[0].rel).toBe('files/report.pdf');
            expect(fs.readFileSync(targetMd, 'utf-8')).toContain('[📎 report.pdf](files/report.pdf)');
            const rf2 = await ok(c, 'fractal_attach', { targetMd, files: [path.join(srcDir, 'report.pdf')] });
            expect(rf2.assets[0].rel).toBe('files/report-1.pdf'); // 衝突 suffix = 本体規約
            const nope = await c.call('fractal_attach', { targetMd: path.join(dir, 'nope.md'), images: [path.join(srcDir, 'shot.png')] });
            expect(nope.json.error.code).toBe('NOT_FOUND');
        });
    });

    test('TC-EX-08b createOutliner がフラットヒント付き .out を作る（legacy サブフォルダを作らない）', async () => {
        const dir = mkdir('create-out-flat');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: [], items: {} }));
        await withClient(async (c) => {
            const r = await ok(c, 'fractal_add', { notesDir: dir, createOutliner: 'Flat New' });
            const data = JSON.parse(fs.readFileSync(r.absPath, 'utf-8'));
            // 正典 NotesFileManager.createFile（FLAT_OUT_HINTS）
            expect(data.pageDir).toBe('.');
            expect(data.imageDir).toBe('./images');
            expect(data.fileDir).toBe('./files');
            expect(fs.existsSync(path.join(dir, r.itemId))).toBe(false);
            const s = JSON.parse(fs.readFileSync(path.join(dir, 'outline.note'), 'utf-8'));
            expect(s.items[r.itemId].title).toBe('Flat New');
            expect(s.rootIds).toEqual([r.itemId]);
        });
    });
});

test.describe('C. fractal_doctor（mcp/src/doctor.ts。旧 fractal-doctor.mjs）', () => {
    // mcp/ は package.json の type: module なので TS を in-process で読まず、bundle の tool を通す
    const doctor = (dir: string) => withClient((c) => ok(c, 'fractal_doctor', { noteDir: dir }));
    const findings = async (dir: string) => (await doctor(dir)).findings;

    test('TC-EX-09 broken refs: images/filePath/pageId の実体不在 = ERROR', async () => {
        const { dir, outPath } = mkFixtureNote('doc-refs');
        expect((await findings(dir)).filter((f: any) => f.check === 'refs' && f.level === 'ERROR')).toEqual([]);
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        data.nodes.nA.images = ['images/missing.png'];
        data.nodes.nB.filePath = 'files/missing.pdf';
        data.nodes.nB.images = [];
        data.nodes.nC.pageId = 'no-such-page'; data.nodes.nC.isPage = true;
        fs.writeFileSync(outPath, JSON.stringify(data));
        const errs = (await findings(dir)).filter((f: any) => f.check === 'refs' && f.level === 'ERROR');
        expect(errs.length).toBe(3);
        const msgs = errs.map((e: any) => e.message).join('\n');
        expect(msgs).toMatch(/missing\.png/);
        expect(msgs).toMatch(/missing\.pdf/);
        expect(msgs).toMatch(/no-such-page\.md/);
    });

    test('TC-EX-10 orphan: 未参照 asset は INFO・参照されると消える（判定は UI の Cleanup と同じ cleanup-core）', async () => {
        const { dir } = mkFixtureNote('doc-orphan');
        fs.writeFileSync(path.join(dir, 'images', 'unused.png'), 'PNG');
        const orphans = (await findings(dir)).filter((f: any) => f.check === 'orphans');
        expect(orphans.some((f: any) => f.message.includes('unused.png'))).toBe(true);
        expect(orphans.some((f: any) => f.message.includes('pic.png'))).toBe(false);
    });

    test('TC-EX-11 structure: 実体不在 ERROR / 未登録 WARN / childIds 宙ぶらりん ERROR', async () => {
        const { dir } = mkFixtureNote('doc-struct');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
            version: 1, rootIds: ['fix', 'ghost', 'fol'],
            items: {
                fix: { type: 'file', id: 'fix', title: 'Fixture' },
                ghost: { type: 'file', id: 'ghost', title: 'Ghost' },
                gmd: { type: 'file', id: 'gmd', title: 'GhostMd', ext: 'md' },
                fol: { type: 'folder', id: 'fol', title: 'F', childIds: ['nope'], collapsed: false },
            },
        }));
        fs.writeFileSync(path.join(dir, 'stray.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} }));
        const fs2 = (await findings(dir)).filter((f: any) => f.check === 'structure');
        expect(fs2.filter((f: any) => f.level === 'ERROR').length).toBe(3);
        expect(fs2.some((f: any) => f.level === 'WARN' && f.message.includes('stray.out'))).toBe(true);
    });

    test('TC-EX-12 layout: ヒントなし + legacy dir = WARN / FLAT_OUT_HINTS 付きは出ない', async () => {
        const { dir } = mkFixtureNote('doc-flat');
        expect((await findings(dir)).filter((f: any) => f.check === 'layout' && f.level === 'WARN')).toEqual([]);
        const legacy = mkdir('doc-legacy');
        fs.writeFileSync(path.join(legacy, 'old.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} }));
        fs.mkdirSync(path.join(legacy, 'old'), { recursive: true });
        fs.writeFileSync(path.join(legacy, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['old'], items: { old: { type: 'file', id: 'old', title: 'Old' } } }));
        const warns = (await findings(legacy)).filter((f: any) => f.check === 'layout' && f.level === 'WARN');
        expect(warns.length).toBe(1);
        expect(warns[0].message).toMatch(/未移行/);
    });

    test('TC-EX-13 read-only（書込 API 0 grep）+ status 対応', async () => {
        const src = fs.readFileSync(doctorTs, 'utf-8');
        expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|rmdirSync|mkdirSync|renameSync|copyFileSync/);
        // 旧 exit code（0 / 1 / 2）は status（clean / info / warnings / errors）になった
        const { dir, outPath } = mkFixtureNote('doc-status');
        expect((await doctor(dir)).status).toBe('clean');
        fs.writeFileSync(path.join(dir, 'images', 'unused.png'), 'PNG');
        expect((await doctor(dir)).status).toBe('info');
        fs.writeFileSync(path.join(dir, 'stray.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} }));
        expect((await doctor(dir)).status).toBe('warnings');
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        data.nodes.nA.images = ['images/missing.png'];
        fs.writeFileSync(outPath, JSON.stringify(data));
        expect((await doctor(dir)).status).toBe('errors');
    });

    test('TC-EX-13b ownership: 同一 asset を複数 node が参照 = WARN', async () => {
        const { dir, outPath } = mkFixtureNote('doc-own');
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        data.nodes.nA.images = ['images/pic.png'];
        data.nodes.nB.images = ['images/pic.png'];
        fs.writeFileSync(outPath, JSON.stringify(data));
        const owns = (await findings(dir)).filter((f: any) => f.check === 'ownership');
        expect(owns.length).toBe(1);
        expect(owns[0].message).toContain('pic.png');
    });
});

test.describe('D. fractal-summary', () => {
    test('TC-EX-14 階層→ネスト箇条書き + checked → [x]/[ ]', async () => {
        const { summarizeOutline } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-tree');
        const data = fixtureOutData();
        data.nodes.nB.checked = true;
        const md = summarizeOutline(dir, data, {});
        expect(md).toContain('# Fixture');
        expect(md).toContain('- 親ノード');
        expect(md).toContain('  - [x] 子ノード');     // 2sp インデント + checked
        expect(md).toContain('- [ ] タスク #work');
    });

    test('TC-EX-15 Pages セクション + --node 部分木', async () => {
        const { summarizeOutline } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-pages');
        const data = fixtureOutData();
        const md = summarizeOutline(dir, data, {});
        expect(md).toContain('## Pages');
        expect(md).toContain('### ページノード');
        expect(md).toContain('本文'); // page md 本文 inline
        // 部分木: nA 配下のみ → nD の page は含まれない
        const sub = summarizeOutline(dir, data, { rootNodeId: 'nA' });
        expect(sub).toContain('- 親ノード');
        expect(sub).not.toContain('## Pages');
        expect(sub).not.toContain('タスク #work');
    });

    test('TC-EX-16 相対パス絶対化（URL 不変）', async () => {
        const { summarizeOutline, absolutizeLocalPaths } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-abs');
        const md = summarizeOutline(dir, fixtureOutData(), {});
        expect(md).toContain(`![img](${path.join(dir, 'images', 'pic.png')})`); // 絶対化
        expect(md).not.toContain('![img](images/pic.png)');
        // pure 関数: URL / anchor / 絶対は不変
        const body = '![a](https://x.com/i.png) [b](#sec) [c](/abs/p.md) ![d](images/rel.png)';
        const out = absolutizeLocalPaths(body, '/base');
        expect(out).toContain('(https://x.com/i.png)');
        expect(out).toContain('(#sec)');
        expect(out).toContain('(/abs/p.md)');
        expect(out).toContain(`(${path.resolve('/base', 'images/rel.png')})`);
    });

    test('TC-EX-16b md モード: subpage 再帰 + 循環打ち切り + 欠落注記', async () => {
        const { summarizeMd, extractSubpageLinks } = await import(summaryMjs);
        const dir = mkdir('sum-md');
        // root → sub1 → sub2、sub2 → root（循環）、root → ghost（欠落）
        fs.writeFileSync(path.join(dir, 'root.md'), '# ルート\n\n[[サブ1]](sub1.md)\n[[幽霊]](ghost.md)\n');
        fs.writeFileSync(path.join(dir, 'sub1.md'), '# サブ1\n\nサブ1本文 ![i](images/s1.png)\n\n[[サブ2]](sub2.md)\n');
        fs.writeFileSync(path.join(dir, 'sub2.md'), '# サブ2\n\n[[戻る]](root.md)\n');
        fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'images', 's1.png'), 'PNG');

        const md = summarizeMd(path.join(dir, 'root.md'));
        expect(md).toContain('# ルート');
        expect(md).toContain('## Subpages');
        expect(md).toContain('### サブ1');
        expect(md).toContain('### サブ2');       // 再帰で 2 階層目も展開
        expect(md).toContain('サブ1本文');
        // 循環: root は visited 済みなので Subpages に再展開されない（### 戻る が無い）
        expect(md).not.toContain('### 戻る');
        // 欠落 subpage は注記
        expect(md).toContain('*(subpage md not found');
        // subpage 本文の相対画像も絶対化
        expect(md).toContain(`![i](${path.join(dir, 'images', 's1.png')})`);
        // extractSubpageLinks: URL / anchor / 非 md は対象外
        expect(extractSubpageLinks('[[a]](x.md) [[b]](https://x.com/y.md) [[c]](#sec) [[d]](files/doc.pdf)'))
            .toEqual([{ label: 'a', url: 'x.md' }]);
    });
});

test.describe('E. fractal-search --tag/--checked', () => {
    test('TC-EX-17 --tag: parseTags ミラー + プレフィックス省略 + 複数 OR', async () => {
        const { parseTagsFromText, matchesTagFilter } = await import(searchMjs);
        expect(parseTagsFromText('タスク #work @alice')).toEqual(['#work', '@alice']);
        expect(parseTagsFromText('code `#nope` https://x.com/@user')).toEqual([]); // inline code / URL 除外
        expect(matchesTagFilter(['#work'], ['work'])).toBe(true);       // プレフィックス省略
        expect(matchesTagFilter(['@alice'], ['alice'])).toBe(true);
        expect(matchesTagFilter(['#work'], ['#work'])).toBe(true);
        expect(matchesTagFilter(['#work'], ['home', 'work'])).toBe(true); // OR
        expect(matchesTagFilter(['#work'], ['home'])).toBe(false);
        expect(matchesTagFilter([], [])).toBe(true);                     // フィルタなし = 素通し
    });

    test('TC-EX-18 --checked: true/false/none/any', async () => {
        const { matchesCheckedFilter } = await import(searchMjs);
        expect(matchesCheckedFilter(true, 'true')).toBe(true);
        expect(matchesCheckedFilter(false, 'true')).toBe(false);
        expect(matchesCheckedFilter(false, 'false')).toBe(true);
        expect(matchesCheckedFilter(null, 'none')).toBe(true);
        expect(matchesCheckedFilter(true, 'none')).toBe(false);
        expect(matchesCheckedFilter(true, 'any')).toBe(true);
        expect(matchesCheckedFilter(false, 'any')).toBe(true);
        expect(matchesCheckedFilter(null, 'any')).toBe(false);
        expect(matchesCheckedFilter(null, null)).toBe(true); // フィルタなし
    });

    test('TC-EX-19b --note-name/--exclude-note: noteTitle/フォルダ名で対象 note を絞る', async () => {
        const { filterFoldersByNoteName, matchesNoteName, resolveNoteLabelFromDisk } = await import(searchMjs);
        // noteTitle 付き note と、outline.note 無し（フォルダ名 fallback）の note
        const workDir = mkdir('nn-work');
        fs.writeFileSync(path.join(workDir, 'outline.note'), JSON.stringify({ version: 1, rootIds: [], items: {}, noteTitle: '仕事ノート' }));
        const plainDir = mkdir('nn-plain-inbox');
        expect(resolveNoteLabelFromDisk(workDir)).toBe('仕事ノート');
        expect(resolveNoteLabelFromDisk(plainDir)).toBe(path.basename(plainDir));

        const entries = [{ path: workDir, sources: [] }, { path: plainDir, sources: [] }];
        // include: noteTitle 部分一致（大小無視）
        expect(filterFoldersByNoteName(entries, ['仕事'], []).map((e: any) => e.path)).toEqual([workDir]);
        // include: フォルダ名でも当たる
        expect(filterFoldersByNoteName(entries, ['nn-plain'], []).map((e: any) => e.path)).toEqual([plainDir]);
        // exclude が include より優先
        expect(filterFoldersByNoteName(entries, ['仕事'], ['仕事'])).toEqual([]);
        // exclude のみ
        expect(filterFoldersByNoteName(entries, [], ['仕事']).map((e: any) => e.path)).toEqual([plainDir]);
        // フィルタなし = 全通し
        expect(filterFoldersByNoteName(entries, [], []).length).toBe(2);
        expect(matchesNoteName('My Note', 'folder', ['note'])).toBe(true); // 大小無視

        // CLI 統合: --folder 2 つ + --note-name で片方だけ検索される
        const { execFileSync } = await import('child_process');
        fs.writeFileSync(path.join(workDir, 'a.out'), JSON.stringify({ version: 1, title: 'A', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: '共通語', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } } }));
        fs.writeFileSync(path.join(plainDir, 'b.out'), JSON.stringify({ version: 1, title: 'B', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: '共通語', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } } }));
        const out = execFileSync('node', [searchMjs, '--query', '共通語', '--folder', workDir, '--folder', plainDir, '--note-name', '仕事', '--no-cache', '--json'], { encoding: 'utf-8' });
        const j = JSON.parse(out);
        expect(j.folders).toEqual([workDir]); // plainDir は除外
        expect(j.results.length).toBe(1);
    });

    test('TC-EX-19 CLI 統合: --tag のみで列挙 / --query と AND / CACHE_VERSION=6', async () => {
        const { dir } = mkFixtureNote('search-filter');
        const { execFileSync } = await import('child_process');
        // --tag のみ（--query なし）で列挙できる（FR-SRF-03。--no-cache で独立実行）
        const out = execFileSync('node', [searchMjs, '--tag', 'work', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        const j = JSON.parse(out);
        const nodeHits = j.results.filter((r: any) => r.kind === 'outline-node');
        expect(nodeHits.length).toBe(1);
        expect(nodeHits[0].nodeText).toBe('タスク #work');
        expect(nodeHits[0].checked).toBe(false);
        // --query と AND: query にマッチしないので 0 件
        const out2 = execFileSync('node', [searchMjs, '--query', '存在しない語', '--tag', 'work', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        expect(JSON.parse(out2).results.filter((r: any) => r.kind === 'outline-node')).toEqual([]);
        // --checked false のみ
        const out3 = execFileSync('node', [searchMjs, '--checked', 'false', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        expect(JSON.parse(out3).results.filter((r: any) => r.kind === 'outline-node').length).toBe(1);
        // CACHE_VERSION bump（ソース grep）
        expect(fs.readFileSync(searchMjs, 'utf-8')).toMatch(/CACHE_VERSION = 6/);
    });
});

test.describe('F. 配線', () => {
    test('TC-EX-20 fractal の scripts は fractal-mcp に集約され、mcp/install.sh は skill を配置しない', async () => {
        const installSh = fs.readFileSync(path.resolve(__dirname, '../../agent-capability/install.sh'), 'utf-8');
        expect(installSh).not.toMatch(/^SKILLS=/m);
        expect(fs.existsSync(doctorTs)).toBe(true);
        expect(fs.existsSync(summaryMjs)).toBe(true);
        // 書き込みと doctor の mjs ミラーは廃止（正典 src/shared を呼ぶ mcp/src に一本化。spec 20261027-1700 D1）
        for (const f of ['fractal-md.mjs', 'fractal-modify.mjs', 'fractal-attach.mjs', 'fractal-doctor.mjs']) {
            expect(fs.existsSync(path.resolve(__dirname, '../../agent-capability/mcp/scripts', f)), f).toBe(false);
        }
        expect(fs.existsSync(path.resolve(__dirname, '../../agent-capability/mcp/server.mjs'))).toBe(true);
    });
});
