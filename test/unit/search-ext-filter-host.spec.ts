/**
 * TC-SEF-02 / TC-SEF-04 / TC-SEF-05(host 分) — searchFilesStreaming の ext: 4 段ゲート
 * （sprint 20260822-203347 FR-SEF-02 / FR-SEF-04）
 *
 * ハーネス = doc-search-stage4.spec.ts 流儀（TS 直 import + mkdtemp + doc-search fixtures）。
 * host は parse を持たない（options.exts は webview/CLI が正典 parse で作る）— ここでは exts を直接渡す。
 * 共通 needle「吾輩は猫である」を全結果種（.out / note md / page md / docx / xlsx 添付）に配置し、
 * exts 指定で指定種だけが残ることを検証する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager, SearchResult, SearchOptions } from '../../src/shared/notes-file-manager';

const FIX = path.join(__dirname, '..', 'fixtures', 'doc-search');
const NEEDLE = '吾輩は猫である';

function mkFixture(withCacheDir?: string): { dir: string; fm: NotesFileManager } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sef-host-'));
    // 第 1 段: .out ノード + 第 3 段: pageId 持ちノード → pages/p1.md
    fs.writeFileSync(path.join(dir, 'o1.out'), JSON.stringify({
        title: 'アウトラインO',
        nodes: {
            n1: { text: `${NEEDLE} outline行` },
            n2: { text: 'ページ親', pageId: 'p1' },
        },
    }));
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pages', 'p1.md'), `# P1\n${NEEDLE} page本文\n`);
    // 第 2 段: note md（mdRoot = mainFolder 直下 + 台帳 items に type:file/ext:md が必要）
    fs.writeFileSync(path.join(dir, 'm1.md'), `# M1\n${NEEDLE} notemd本文\n`);
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        noteTitle: 'T', rootIds: ['m1'],
        items: { m1: { type: 'file', ext: 'md', title: 'M1メモ' } },
    }));
    // 第 4 段: files/ 添付（docx + xlsx = 双方 needle 入り fixture・noext = 拡張子なし）
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(filesDir, 'meeting.docx'));
    fs.copyFileSync(path.join(FIX, 'xlsx-openpyxl-inline.xlsx'), path.join(filesDir, 'sheet.xlsx'));
    fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(filesDir, 'noext'));
    const fm = new NotesFileManager(dir, withCacheDir ?? null);
    return { dir, fm };
}

async function search(fm: NotesFileManager, query: string, opts?: Partial<SearchOptions>): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    await fm.searchFilesStreaming(query,
        { caseSensitive: false, wholeWord: false, useRegex: false, ...(opts || {}) } as SearchOptions,
        (r) => results.push(r));
    return results;
}
const kinds = (rs: SearchResult[]) => rs.map((r) => `${r.fileType}:${r.fileId}`).sort();

test.describe('ext: host 4 段ゲート（FR-SEF-02）', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };
    test.afterEach(() => {
        for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
        dirs = [];
    });

    test('TC-SEF-02a exts=[docx] → 第 4 段の docx のみ（out/md/xlsx/noext ヒットなし）', async () => {
        const { dir, fm } = mkFixture();
        track(dir);
        const rs = await search(fm, NEEDLE, { exts: ['docx'] });
        expect(kinds(rs)).toEqual(['file:files/meeting.docx']);
    });

    test('TC-SEF-02b exts=[md] → 第 2+3 段のみ / exts=[out] → 第 1 段のみ', async () => {
        const { dir, fm } = mkFixture();
        track(dir);
        const mdOnly = await search(fm, NEEDLE, { exts: ['md'] });
        expect(mdOnly.every((r) => r.fileType === 'md')).toBe(true);
        expect(mdOnly.some((r) => r.fileId === 'm1.md'), 'note md（第 2 段）が出ない').toBe(true);
        expect(mdOnly.some((r) => r.fileId === 'p1.md'), 'page md（第 3 段）が出ない').toBe(true);
        const outOnly = await search(fm, NEEDLE, { exts: ['out'] });
        expect(kinds(outOnly)).toEqual(['out:o1']);
    });

    test('TC-SEF-02c 拡張子なしファイル（noext）はどの exts 指定でも出ない', async () => {
        const { dir, fm } = mkFixture();
        track(dir);
        const rs = await search(fm, NEEDLE, { exts: ['docx', 'xlsx', 'md', 'out'] });
        expect(rs.some((r) => String(r.fileId).includes('noext')), 'noext が結果に混入').toBe(false);
    });

    test('TC-SEF-02d exts なし（undefined / null）→ 従来と同一の結果集合（FR-SEF-04 pin）', async () => {
        const { dir, fm } = mkFixture();
        track(dir);
        const legacy = await search(fm, NEEDLE);                       // exts キー自体なし（旧 webview 相当）
        const nullExts = await search(fm, NEEDLE, { exts: null });
        expect(kinds(nullExts)).toEqual(kinds(legacy));
        // 全結果種が居る（out + md×2 + docx + xlsx。noext は従来から対象外拡張子扱い）
        expect(kinds(legacy)).toEqual([
            'file:files/meeting.docx', 'file:files/sheet.xlsx',
            'md:m1.md', 'md:p1.md', 'out:o1',
        ]);
    });

    test('TC-SEF-02e 抽出スキップ counterfactual: exts=[md] で第 4 段の抽出が走らない（キャッシュ不生成）', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sef-cache-'));
        const { dir, fm } = mkFixture(cacheDir);
        track(dir); track(cacheDir);
        await search(fm, NEEDLE, { exts: ['md'] });
        const after = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
        expect(after.length, 'exts=[md] なのに添付抽出キャッシュが生成された（ゲートが getOrExtract の後にある）').toBe(0);
        // 観測手段の健全性（ゲートを通すと同じキャッシュ dir にエントリが生える = 不生成 assert が本物）
        await search(fm, NEEDLE, { exts: ['docx'] });
        expect(fs.readdirSync(cacheDir).length).toBeGreaterThan(0);
    });

    test('TC-SEF-04 useRegex + exts 同時指定（body だけが regex 対象）', async () => {
        const { dir, fm } = mkFixture();
        track(dir);
        const rs = await search(fm, '^吾輩は猫', { exts: ['md'], useRegex: true });
        expect(rs.length).toBeGreaterThan(0);
        expect(rs.every((r) => r.fileType === 'md')).toBe(true);
    });
});

// ── TC-SEF-02f — handler exts の malformed 入力縮退（reviewer iteration 1 SEC-1 / FR-SEF-04） ──

function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
    const purge = () => {
        for (const key of Object.keys(require.cache)) {
            if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
        }
    };
    purge();   // 「掴まない」purge（先行 spec の別 stub cache を掴まない — generator_failures 2026-08-17）
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
    try { return require(modulePath); } finally { Module._load = origLoad; purge(); }
}

test('TC-SEF-02f handler exts の malformed 入力: 非配列 → フィルタなし / 混在配列 → 有効 string のみ（throw なし）', async () => {
    const { NotesFileManager: FM } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sef-mal-'));
    fs.writeFileSync(path.join(dir, 'o1.out'), JSON.stringify({
        title: 'O', nodes: { n1: { text: `${NEEDLE} 行` } },
    }));
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ noteTitle: 'T', rootIds: [], items: {} }));
    const m = new FM(dir);
    m.loadStructure();
    const run = async (exts: unknown) => {
        const messages: any[] = [];
        const sender = { postMessage: (x: any) => messages.push(x) };
        await mod.handleNotesMessage(
            { type: 'notesSearch', query: NEEDLE, caseSensitive: false, wholeWord: false, useRegex: false, exts },
            m as any, sender as any, {} as any);
        return messages.filter((x) => x.type === 'notesSearchPartial');
    };
    // (a) 非配列（文字列）→ Array.isArray false → null = フィルタなしで従来結果（out ヒットあり）
    const nonArray = await run('pdf');
    expect(nonArray.length).toBeGreaterThan(0);
    // (b) 混在配列 → 有効 string のみ（'out' が残り out ヒット / 数値・object・null は除去され throw しない）
    const mixed = await run(['out', 123, {}, null]);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.every((x) => x.result.fileType === 'out')).toBe(true);
    // (c) 有効 string が 1 つも無い混在配列 → exts=[] = 全結果種不一致（型検証は通り 0 件で完走）
    const invalidOnly = await run([123, {}, null]);
    expect(invalidOnly.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
});
